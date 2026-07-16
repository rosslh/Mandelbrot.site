import { saveAs } from "file-saver";
import type MandelbrotMap from "./MandelbrotMap";
import { AnimationSpec, buildFrameRects, frameCount } from "./animationFrames";

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
 * browser-native `MediaRecorder` fed by a canvas `captureStream`. The expensive
 * per-pixel work happens on the worker pool, off the main thread; the recorder
 * encodes on its own browser thread. Progress is reported per frame and the run
 * can be cancelled between frames. */
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

    // Phase 1: render every frame off-screen. Kept as ImageBitmaps so the
    // paced playback phase can blit them into the recorder at exact timing
    // regardless of how long each (variably expensive) render took.
    const frames: ImageBitmap[] = [];
    try {
      for (let i = 0; i < rects.length; i++) {
        this.throwIfCancelled();
        const canvas = await this.map.regionRenderer.renderToCanvas(
          rects[i],
          spec.width,
          spec.height,
        );
        frames.push(await createImageBitmap(canvas));
        onProgress({
          phase: "rendering",
          // Rendering is the bulk of the work; give it 90% of the bar.
          fraction: ((i + 1) / total) * 0.9,
          frame: i + 1,
          totalFrames: total,
        });
      }

      this.throwIfCancelled();

      // Phase 2: play the rendered frames into the recorder at the target fps.
      const blob = await this.encodeFrames(spec, mime, frames, (frame) =>
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
        frame.close();
      }
    }
  }

  /** Blits the pre-rendered frames onto a canvas that a `MediaRecorder` is
   * capturing, one frame every `1000 / fps` ms so the recording plays at the
   * requested rate. `captureStream(0)` gives a manual track: each frame is
   * captured by an explicit `requestFrame`, so no frames are dropped or
   * duplicated even when the main thread is busy. */
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

    const stream = canvas.captureStream(0);
    const [track] = stream.getVideoTracks() as (MediaStreamTrack & {
      requestFrame?: () => void;
    })[];
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
        // A manual capture stream exposes requestFrame; guard for the spec's
        // optional typing.
        track.requestFrame?.();
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

export default ZoomAnimator;
