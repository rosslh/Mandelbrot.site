import { saveAs } from "file-saver";
import type MandelbrotMap from "./MandelbrotMap";
import { fittedCdfForRender, fittedRangeForRender } from "./TileCache";
import { AnimationSpec, buildFrameRects, frameCount } from "./animationFrames";
import { coloringOptions, MandelbrotConfig } from "./config";
import type { TileRect } from "./protocol";

// Candidate container/codec strings in preference order. Safari records H.264
// MP4 natively; Chrome and Firefox fall back to WebM (VP9, then VP8). The
// issue asks for MP4, but MP4 recording is unavailable in the majority of
// browsers, so we pick the best format each browser can actually produce
// rather than fail — see the report notes.
const RECORDER_MIME_CANDIDATES = [
  "video/mp4;codecs=avc1",
  "video/mp4",
  "video/webm;codecs=vp9",
  "video/webm;codecs=vp8",
  "video/webm",
];

// Bits per second for the recorder. High enough that the fractal's fine
// boundary detail survives compression at 1080p-ish resolutions.
const VIDEO_BITS_PER_SECOND = 16_000_000;

// Roughly how many frames each palette anchor covers when refitting the
// auto-palette range across a zoom (see buildFrameRanges). Anchors are spaced
// far enough apart that per-frame percentile-clip jitter averages out, yet
// dense enough to track the genuine growth of the iteration range with depth.
const FRAMES_PER_PALETTE_ANCHOR = 12;

/** A palette's escaped-iteration window; structurally the same as TileCache's
 * internal detected range. */
type PaletteRange = { min: number; max: number };

export type AnimationProgress = {
  // Which phase the run is in, for the modal's status label.
  phase: "rendering" | "encoding";
  // 0..1 completion within the whole run (rendering then encoding).
  fraction: number;
  frame: number;
  totalFrames: number;
};

/** Thrown when the user cancels an in-progress animation. Callers treat it as
 * a benign abort rather than an error. */
export class AnimationCancelledError extends Error {
  constructor() {
    super("Animation cancelled");
    this.name = "AnimationCancelledError";
  }
}

/** True when the browser can record video from a canvas at all — the animation
 * feature is hidden otherwise. */
export function canRecordAnimation(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    pickRecorderMime() !== null
  );
}

/** The best supported recorder MIME string, or null when none is. */
function pickRecorderMime(): string | null {
  if (typeof MediaRecorder === "undefined") {
    return null;
  }
  for (const mime of RECORDER_MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return null;
}

/** Generates a zoom animation (issue #13) as a downloadable video. Renders one
 * frame per output frame off-screen through the shared worker pool — reusing
 * the exact tile pipeline (and thus its perturbation/precision handling at
 * deep zoom) via `RegionRenderer` — then encodes the sequence with the
 * browser-native `MediaRecorder` fed by a canvas `captureStream`. Frames
 * render concurrently, enough in flight to keep every pool worker busy; the
 * expensive per-pixel work happens on the worker pool, off the main thread,
 * and the recorder encodes on its own browser thread. Progress is reported
 * per frame and the run can be cancelled between frames. */
class ZoomAnimator {
  private map: MandelbrotMap;
  private cancelled = false;

  constructor(map: MandelbrotMap) {
    this.map = map;
  }

  /** Requests cancellation of the in-progress run; it aborts at the next frame
   * boundary and rejects with `AnimationCancelledError`. */
  cancel() {
    this.cancelled = true;
  }

  private throwIfCancelled() {
    if (this.cancelled) {
      throw new AnimationCancelledError();
    }
  }

  /** Renders and downloads the animation for `spec`. The current view is the
   * animation's target (the deepest frame); the fixed origin and zoom offset
   * come from the map at call time, so deep-zoom precision matches the tiles on
   * screen. Reports progress via `onProgress`. */
  async generate(
    spec: AnimationSpec,
    onProgress: (progress: AnimationProgress) => void,
  ): Promise<void> {
    this.cancelled = false;
    const mime = pickRecorderMime();
    if (!mime) {
      throw new Error("This browser cannot record video.");
    }

    // Every frame is colored and labeled from this point-in-time copy: the
    // run keeps renders in flight for its whole duration while the live
    // config is rewritten under it (the auto palette fit as visible tiles
    // settle, navigation on moveend), and a frame that read the config late
    // would color differently than one that read it early.
    const config = this.map.configSnapshot();

    const targetZoom = this.map.effectiveZoom;
    const rects = buildFrameRects(
      spec,
      this.map.mapBoundsInTileSpace,
      targetZoom,
      this.map.zoomOffset,
    );
    const total = frameCount(spec);

    const coloring = coloringOptions(config);
    const standardPalette = !coloring.distanceEstimate && !coloring.atomDomain;

    // Histogram coloring (the color-mapping slider): each standard-mode frame
    // is equalized against its own escape-value distribution over its
    // effective window (the per-frame window derived below) — exactly as the
    // live view rebuilds its CDF for whatever it currently shows at that
    // depth (it does so per moveend in manual-window mode too, not just when
    // auto-fitting). The strength (0 linear .. 1 fully equalized) blends the
    // per-frame table toward the identity; the fixed-palette modes normalize
    // to a fixed 0..1 domain and are never equalized. A per-frame table
    // rather than an anchor-interpolated one is correct here and does not
    // flash: the anchoring that smooths the window fit guards against the
    // percentile clip snapping to bucket edges frame to frame, but the CDF is
    // a smooth cumulative integral of the whole distribution with sub-bucket
    // interpolation and no such threshold, so near-identical adjacent frames
    // yield near-identical tables — and the one input that did jitter, the
    // window, is still supplied by the smoothed anchor fit. It also needs no
    // extra renders: the frame is already rendered for its values to recolor
    // to its window.
    const equalizeStrength =
      standardPalette && config.histogramColoring > 0
        ? config.histogramColoring / 100
        : 0;

    // Palette windows: the config's window describes the deep target view's
    // iteration counts, which dwarf a shallow frame's — held fixed across the
    // sweep it clamps most frames to one end of the palette (a zoom-in would
    // open nearly flat). So every multi-frame standard-palette animation
    // measures the smoothed fitted range across the sweep (buildFrameRanges)
    // and colors each frame to a window derived from it: the fitted range
    // itself in auto palette mode (what the live view would fit at that
    // depth), or in manual mode the user's window re-expressed as the same
    // slice of each frame's range (relativeManualRanges). The fixed-palette
    // modes normalize to 0..1 and need no windows. A single-frame animation
    // is the target view itself: auto mode still measures its own fit, while
    // the manual window already applies exactly as configured.
    const measureRanges =
      standardPalette && (config.paletteAutoFit || total > 1);
    const fittedRanges = measureRanges
      ? await this.buildFrameRanges(rects, spec, total)
      : null;
    const frameRanges =
      fittedRanges === null
        ? null
        : config.paletteAutoFit
          ? fittedRanges
          : this.relativeManualRanges(
              fittedRanges,
              config,
              spec.kind === "in" ? total - 1 : 0,
            );
    this.throwIfCancelled();

    // Phase 1: render every frame off-screen, concurrently across the worker
    // pool (a frame is a single worker task, so sequential rendering would
    // leave all but one worker idle). Slots are pre-allocated and each frame
    // lands at its own index, so animation order survives out-of-order
    // completion. Kept as ImageBitmaps so the paced playback phase can blit
    // them into the recorder at exact timing regardless of how long each
    // (variably expensive) render took.
    const frames: (ImageBitmap | null)[] = new Array(total).fill(null);
    try {
      // One runner per pool worker plus one spare: an in-flight frame
      // occupies at most one worker at a time (its render, then its recolor),
      // and the spare covers the main-thread gaps between a frame's tasks
      // (palette fit, bitmap creation) so the pool never idles.
      const concurrency = Math.min(total, this.map.poolSize + 1);
      let nextIndex = 0;
      let completed = 0;
      let failure: unknown = null;
      const runner = async () => {
        while (failure === null && !this.cancelled && nextIndex < total) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            frames[index] = await this.renderFrame(
              rects[index],
              spec,
              frameRanges ? frameRanges[index] : null,
              equalizeStrength,
              config,
            );
          } catch (error) {
            failure ??= error;
            return;
          }
          completed += 1;
          onProgress({
            phase: "rendering",
            // Rendering is the bulk of the work; give it 90% of the bar.
            // Frames finish out of order, but `completed` only grows, so the
            // reported progress stays monotonic.
            fraction: (completed / total) * 0.9,
            frame: completed,
            totalFrames: total,
          });
        }
      };
      // The runners trap their own errors, so this waits for every in-flight
      // frame to settle — the finally below must not close bitmaps while a
      // renderFrame could still assign one.
      await Promise.all(Array.from({ length: concurrency }, runner));
      this.throwIfCancelled();
      if (failure !== null) {
        throw failure;
      }

      // Phase 2: play the rendered frames into the recorder at the target fps.
      const blob = await this.encodeFrames(
        spec,
        mime,
        frames as ImageBitmap[],
        (frame) =>
          onProgress({
            phase: "encoding",
            fraction: 0.9 + (frame / total) * 0.1,
            frame,
            totalFrames: total,
          }),
      );

      const extension = mime.startsWith("video/mp4") ? "mp4" : "webm";
      saveAs(blob, this.buildFilename(extension, config));
    } finally {
      for (const frame of frames) {
        frame?.close();
      }
    }
  }

  /** Renders one animation frame to an ImageBitmap, coloring it from the
   * run's config snapshot.
   *
   * A frame with no per-frame window that also doesn't equalize (a
   * single-frame manual-palette animation at linear strength, a frame whose
   * range measurement found no escaped pixels, or a normalized fixed-palette
   * mode) takes the plain render straight from the config palette. The
   * coloring is passed explicitly rather than inherited so the frame never
   * picks up the map's viewport-global equalization table: that table is fit
   * to the on-screen target view and would miscolor every shallower frame.
   *
   * Otherwise the frame is rendered for its escape values and recolored over
   * its effective window: the per-frame `range` from generate (the smoothed
   * fitted range in auto palette mode, the relative manual slice otherwise)
   * or, when that is null, the user's fixed window. When `strength` is above
   * 0 the recolor also carries a histogram-equalization table built from
   * this frame's own values over that window, so recorded frames equalize
   * per depth exactly like the live view — see `equalizeStrength` in
   * generate for why a per-frame table is used. */
  private async renderFrame(
    rect: TileRect,
    spec: AnimationSpec,
    range: PaletteRange | null,
    strength: number,
    config: MandelbrotConfig,
  ): Promise<ImageBitmap> {
    const renderer = this.map.regionRenderer;
    const equalize = strength > 0;

    if (range === null && !equalize) {
      const canvas = await renderer.renderToCanvas(
        rect,
        spec.width,
        spec.height,
        coloringOptions(config),
      );
      return createImageBitmap(canvas);
    }

    // Render for escape values so the frame can be recolored to its own
    // window and distribution. The render's provisional coloring is passed
    // explicitly (config palette, no viewport table) so that even if a render
    // somehow returns no values, the fallback image below never inherits the
    // map's table.
    const response = await renderer.renderRegion(
      rect,
      spec.width,
      spec.height,
      true,
      undefined,
      coloringOptions(config),
    );

    let image = response.image;
    if (response.values) {
      // The window this frame colors over: the per-frame derived window
      // (smoothed auto fit or relative manual slice), else the user's fixed
      // window.
      const window = range ?? {
        min: config.paletteMinIter,
        max: config.paletteMaxIter,
      };
      // Histogram coloring: equalize against this frame's own escape-value
      // distribution over that window, blended toward linear by `strength`
      // (see fittedCdfForRender / buildPaletteCdf). Null (linear, no table) at
      // strength 0 or when the frame has no escaped mass in the window.
      const cdf = equalize
        ? fittedCdfForRender(
            response,
            spec.width,
            spec.height,
            window,
            strength,
          )
        : null;
      image = await renderer.recolor(response.values, {
        ...coloringOptions(config, cdf),
        paletteMinIter: window.min,
        paletteMaxIter: window.max,
      });
    }

    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not get canvas context.");
    }
    context.putImageData(
      new ImageData(Uint8ClampedArray.from(image), spec.width, spec.height),
      0,
      0,
    );
    return createImageBitmap(canvas);
  }

  /** The smoothed auto-palette range for every frame. The fitted iteration
   * range grows with zoom depth but a per-frame fit also jitters (the
   * percentile clip lands in different histogram buckets frame to frame),
   * which is what flashes. So the range is measured only at anchor frames
   * spread across the sweep — far enough apart that jitter averages out — and
   * log-interpolated between them (iteration counts grow geometrically with
   * depth, so the window is smooth in log space). Frames are evenly spaced in
   * log-magnification, so the frame index is a faithful interpolation axis.
   * Entries are null where no anchor escaped (all-interior); renderFrame then
   * falls back to the config palette, which is moot for a solid interior. */
  private async buildFrameRanges(
    rects: TileRect[],
    spec: AnimationSpec,
    total: number,
  ): Promise<(PaletteRange | null)[]> {
    const anchorIndices = anchorFrameIndices(total);
    const anchors = await Promise.all(
      anchorIndices.map(async (index) => ({
        index,
        range: await this.detectFrameRange(rects[index], spec),
      })),
    );

    // Drop anchors with no escaped pixels; interpolate across what remains.
    const fitted = anchors.filter(
      (anchor): anchor is { index: number; range: PaletteRange } =>
        anchor.range !== null,
    );
    const ranges: (PaletteRange | null)[] = new Array(total).fill(null);
    if (fitted.length === 0) {
      return ranges;
    }
    for (let index = 0; index < total; index++) {
      ranges[index] = interpolatePaletteRange(fitted, index);
    }
    return ranges;
  }

  /** Re-expresses the user's manual palette window for every frame as the
   * same slice of that frame's fitted iteration range. The window's absolute
   * bounds describe the target view's iteration counts; at shallower depths
   * the escaped values live orders of magnitude lower, so applying the
   * absolute bounds across the sweep would clamp most frames to one end of
   * the palette. What travels instead is the window's intent — which slice
   * of the distribution to color: the bounds become fractions of the target
   * frame's fitted range, and those fractions are applied to every frame's
   * (anchor-smoothed) range. At the target frame the fractions reproduce the
   * user's window exactly, so the animation meets the live view; fractions
   * outside [0, 1] (a window wider than the fitted range) carry through
   * linearly. Frames with no fitted range — and every frame, when the target
   * frame's own range is missing or degenerate — fall back to null, i.e. the
   * absolute window (renderFrame's fallback). */
  private relativeManualRanges(
    fittedRanges: (PaletteRange | null)[],
    config: MandelbrotConfig,
    targetIndex: number,
  ): (PaletteRange | null)[] {
    const target = fittedRanges[targetIndex];
    if (!target || target.max <= target.min) {
      return fittedRanges.map((): PaletteRange | null => null);
    }

    const span = target.max - target.min;
    const low = (config.paletteMinIter - target.min) / span;
    const high = (config.paletteMaxIter - target.min) / span;

    return fittedRanges.map((range) => {
      if (!range) {
        return null;
      }
      const frameSpan = range.max - range.min;
      const min = Math.round(range.min + low * frameSpan);
      const max = Math.round(range.min + high * frameSpan);
      return { min, max: Math.max(max, min + 1) };
    });
  }

  /** Renders `rect` for its escape values and returns the auto-palette range
   * fit to them (see fittedRangeForRender), or null when the frame has no
   * escaped pixels. */
  private async detectFrameRange(
    rect: TileRect,
    spec: AnimationSpec,
  ): Promise<PaletteRange | null> {
    const response = await this.map.regionRenderer.renderRegion(
      rect,
      spec.width,
      spec.height,
      true,
    );
    return fittedRangeForRender(response, spec.width, spec.height);
  }

  /** Blits the pre-rendered frames onto a canvas that a `MediaRecorder` is
   * capturing, one frame every `1000 / fps` ms so the recording plays at the
   * requested rate. Preferred mode is a manual capture stream
   * (`captureStream(0)`): each frame is captured by an explicit
   * `requestFrame`, so no frames are dropped or duplicated even when the main
   * thread is busy. Where the manual API lives varies by engine — Chromium
   * puts `requestFrame` on the video track, Firefox on the stream — and
   * engines with neither (older WebKit) fall back to an auto-capturing stream
   * at the target rate, which records whenever the canvas is repainted;
   * pacing the repaints below then still yields the right timing. Calling
   * `requestFrame` on a static canvas is the only capture in manual mode, so
   * a missed detection here shows up as a frozen single-frame video — which
   * is why the fallback chain is explicit rather than optional-chained. */
  private encodeFrames(
    spec: AnimationSpec,
    mime: string,
    frames: ImageBitmap[],
    onFrame: (frame: number) => void,
  ): Promise<Blob> {
    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const context = canvas.getContext("2d");
    if (!context) {
      return Promise.reject(new Error("Could not get canvas context."));
    }

    let stream = canvas.captureStream(0) as MediaStream & {
      requestFrame?: () => void;
    };
    let [track] = stream.getVideoTracks() as (MediaStreamTrack & {
      requestFrame?: () => void;
    })[];
    let requestFrame: (() => void) | null = null;
    if (typeof track.requestFrame === "function") {
      requestFrame = () => track.requestFrame();
    } else if (typeof stream.requestFrame === "function") {
      requestFrame = () => stream.requestFrame();
    } else {
      // No manual capture available: replace the never-capturing manual
      // stream with an auto-capturing one before hooking up the recorder.
      track.stop();
      stream = canvas.captureStream(spec.fps);
      [track] = stream.getVideoTracks();
    }

    const recorder = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    const frameIntervalMs = 1000 / spec.fps;

    return new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        track.stop();
        resolve(new Blob(chunks, { type: mime }));
      };
      recorder.onerror = () => reject(new Error("Recording failed."));

      recorder.start();

      let index = 0;
      const drawNext = () => {
        if (this.cancelled) {
          recorder.stop();
          reject(new AnimationCancelledError());
          return;
        }
        if (index >= frames.length) {
          // Give the last frame its full on-screen duration before stopping,
          // otherwise the recorder can truncate it to near-zero length.
          setTimeout(() => recorder.stop(), frameIntervalMs);
          return;
        }
        context.drawImage(frames[index], 0, 0);
        // Manual capture mode; in the auto fallback the repaint itself
        // triggers the capture.
        requestFrame?.();
        index += 1;
        onFrame(index);
        setTimeout(drawNext, frameIntervalMs);
      };
      drawNext();
    });
  }

  private buildFilename(extension: string, config: MandelbrotConfig): string {
    // Deep-zoom coordinates can be hundreds of digits; keep filenames sane,
    // matching the image export's truncation.
    const truncate = (value: string) =>
      value.length > 24 ? value.slice(0, 24) : value;
    const { re, im, zoom } = config;
    return `mandelbrot${Date.now()}_r${truncate(re)}_im${truncate(
      im,
    )}_z${zoom}_zoom.${extension}`;
  }
}

/** Evenly spaced frame indices to measure the palette range at, always
 * including the first and last frame. The count scales with the frame total
 * (about one anchor per FRAMES_PER_PALETTE_ANCHOR frames), floored at two so a
 * multi-frame sweep always interpolates between endpoints. Rounding can
 * collapse neighbours on short animations, so duplicates are dropped. */
function anchorFrameIndices(total: number): number[] {
  if (total <= 1) {
    return [0];
  }
  const anchorCount = Math.min(
    total,
    Math.max(2, Math.round(total / FRAMES_PER_PALETTE_ANCHOR) + 1),
  );
  const indices: number[] = [];
  for (let anchor = 0; anchor < anchorCount; anchor++) {
    const index = Math.round((anchor * (total - 1)) / (anchorCount - 1));
    if (indices[indices.length - 1] !== index) {
      indices.push(index);
    }
  }
  return indices;
}

/** The palette range for `index`, log-interpolated between the surrounding
 * anchors (sorted ascending by frame index, at least one). Indices outside the
 * anchored span clamp to the nearest anchor. Interpolating the log of the
 * window matches how iteration counts grow geometrically with depth; the
 * bounds are rounded back to whole iterations with max kept above min. */
function interpolatePaletteRange(
  anchors: { index: number; range: PaletteRange }[],
  index: number,
): PaletteRange {
  if (index <= anchors[0].index) {
    return { ...anchors[0].range };
  }
  const last = anchors[anchors.length - 1];
  if (index >= last.index) {
    return { ...last.range };
  }

  let upper = 1;
  while (anchors[upper].index < index) {
    upper++;
  }
  const lower = anchors[upper - 1];
  const higher = anchors[upper];
  const t = (index - lower.index) / (higher.index - lower.index);

  const min = Math.round(logLerp(lower.range.min, higher.range.min, t));
  const max = Math.round(logLerp(lower.range.max, higher.range.max, t));
  return { min, max: Math.max(max, min + 1) };
}

/** Interpolates between two positive-ish iteration counts in log space. Values
 * are floored at 1 before the log so a zero floor stays finite. */
function logLerp(a: number, b: number, t: number): number {
  const logA = Math.log(Math.max(a, 1));
  const logB = Math.log(Math.max(b, 1));
  return Math.exp(logA + (logB - logA) * t);
}

export default ZoomAnimator;
