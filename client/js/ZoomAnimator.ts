import { saveAs } from "file-saver";
import type MandelbrotMap from "./MandelbrotMap";
import TileCache from "./TileCache";
import { AnimationSpec, buildFrameRects, frameCount } from "./animationFrames";
import { coloringOptions } from "./config";
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

    const targetZoom = this.map.effectiveZoom;
    const rects = buildFrameRects(
      spec,
      this.map.mapBoundsInTileSpace,
      targetZoom,
      this.map.zoomOffset,
    );
    const total = frameCount(spec);

    // Palette refitting: the config's palette range is auto-fit to the deep
    // target view, whose iteration counts dwarf a shallow frame's — rendering
    // every frame with it clamps most of the sweep to a single color. In auto
    // palette mode the palette is instead refit per frame to the iteration
    // range at that depth, matching what the live view shows there. Manual
    // palette mode keeps the user's fixed range, also matching the live view;
    // the distance-estimate and atom-domain modes normalize their values to a
    // fixed 0..1 domain, so there is nothing to refit.
    const coloring = coloringOptions(this.map.config);
    const refitPalette =
      this.map.config.paletteAutoAdjust &&
      !coloring.distanceEstimate &&
      !coloring.atomDomain;

    // Fitting each frame independently makes the palette window jump every
    // frame — partly the genuine deepening trend, partly percentile-clip
    // jitter — which reads as flashing. Instead sample the fitted range at a
    // few anchor frames spread across the zoom and log-interpolate the window
    // for the rest, so the colors drift smoothly with depth. Null entries
    // (all-interior frames) fall back to the plain config-palette render.
    const frameRanges = refitPalette
      ? await this.buildFrameRanges(rects, spec, total)
      : null;
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
      saveAs(blob, this.buildFilename(extension));
    } finally {
      for (const frame of frames) {
        frame?.close();
      }
    }
  }

  /** Renders one animation frame to an ImageBitmap. When `range` is given (auto
   * palette mode), the frame is rendered for its escape values and recolored to
   * that precomputed window — the smoothed per-frame range from
   * buildFrameRanges rather than this frame's own fit, so the palette drifts
   * smoothly across the sweep. A null `range` (manual palette, the normalized
   * modes, or an all-interior frame) takes the plain render straight from the
   * config palette. */
  private async renderFrame(
    rect: TileRect,
    spec: AnimationSpec,
    range: PaletteRange | null,
  ): Promise<ImageBitmap> {
    const renderer = this.map.regionRenderer;
    if (range === null) {
      const canvas = await renderer.renderToCanvas(
        rect,
        spec.width,
        spec.height,
      );
      return createImageBitmap(canvas);
    }

    const response = await renderer.renderRegion(
      rect,
      spec.width,
      spec.height,
      true,
    );

    let image = response.image;
    if (response.values) {
      image = await renderer.recolor(response.values, {
        ...coloringOptions(this.map.config),
        paletteMinIter: range.min,
        paletteMaxIter: range.max,
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

  /** Renders `rect` for its escape values and returns the auto-palette range
   * fit to them, or null when the frame has no escaped pixels. A frame-local
   * throwaway TileCache holds the frame as the single tile spanning
   * [0,1) x [0,1) at zoom 0, so the unit viewport reproduces the map's
   * on-screen fit exactly (center-weighted, neighbor-capped percentile clip).
   * The cache is not shared across frames — that fit must depend only on this
   * frame's values. */
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
    if (
      !response.values ||
      response.minIter === null ||
      response.maxIter === null
    ) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = spec.width;
    canvas.height = spec.height;
    const fitCache = new TileCache();
    fitCache.record(
      { x: 0, y: 0, z: 0 },
      response.minIter,
      response.maxIter,
      canvas,
      response.values,
      response.tier,
    );
    return fitCache.detectedRange({
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
      zoom: 0,
    });
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

  private buildFilename(extension: string): string {
    // Deep-zoom coordinates can be hundreds of digits; keep filenames sane,
    // matching the image export's truncation.
    const truncate = (value: string) =>
      value.length > 24 ? value.slice(0, 24) : value;
    const { re, im, zoom } = this.map.config;
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
