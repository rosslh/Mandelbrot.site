// Pure geometry for zoom-animation frames (issue #13). Given a target view (the
// tile-space rectangle currently on screen) and an animation spec, this
// produces one `TileRect` per frame — the per-frame viewport the region
// renderer rasterizes. It is deliberately free of any DOM or map coupling so
// the interpolation math can be exercised by a standalone harness.
//
// The zoom is exponential (linear in log-magnification): each frame multiplies
// the magnification by a constant factor, which is what reads as a smooth,
// constant-speed zoom. The set's tile geometry is self-similar per zoom level,
// so a frame at effective zoom `Zi` centered on the animation origin is the
// target rectangle's half-extents held fixed while the `zoom` field (and the
// center tile coordinate, which scales as `2^(zoom-2)`) sweep from the start
// zoom to the end zoom. Holding the tile-space half-extents constant keeps the
// complex-plane width scaling as `2^-Zi`, i.e. exponential zoom, and lets the
// wasm pick the precision tier appropriate to each frame's depth from the
// frame's `zoom` field and the shared `zoomOffset`.

import type { TileRect } from "./protocol";

export type AnimationKind = "in" | "out";

export type AnimationSpec = {
  kind: AnimationKind;
  width: number;
  height: number;
  durationSeconds: number;
  fps: number;
};

// The fully-zoomed-out end of every animation: the effective zoom at which the
// whole set frames the viewport (the app's initial desktop view). Zooming "in"
// starts here and ends at the target; zooming "out" is the reverse.
export const FULL_SET_EFFECTIVE_ZOOM = 3;

/** The number of frames an animation of this spec renders (at least one). */
export function frameCount(spec: AnimationSpec): number {
  return Math.max(1, Math.round(spec.durationSeconds * spec.fps));
}

/** Re-frames a tile-space rectangle to a requested output aspect ratio about
 * its own center, growing the shorter dimension so the target view stays fully
 * contained (matching the image export's letterboxing). Returns the center and
 * half-extents in tile coordinates at the rectangle's zoom. */
function targetFraming(
  target: TileRect,
  width: number,
  height: number,
): { centerX: number; centerY: number; halfX: number; halfY: number } {
  const centerX = (target.xMin + target.xMax) / 2;
  const centerY = (target.yMin + target.yMax) / 2;
  let halfX = (target.xMax - target.xMin) / 2;
  let halfY = (target.yMax - target.yMin) / 2;

  const outputAspect = width / height;
  const targetAspect = halfX / halfY;

  if (outputAspect > targetAspect) {
    // Output is wider than the target rectangle: widen to fit.
    halfX = halfY * outputAspect;
  } else if (outputAspect < targetAspect) {
    // Output is taller: heighten to fit.
    halfY = halfX / outputAspect;
  }

  return { centerX, centerY, halfX, halfY };
}

/** The `TileRect` for a single frame at effective zoom `frameZoom`, centered on
 * the animation origin. `targetZoom` is the effective zoom of the target view
 * the half-extents were captured at; `zoomOffset` is the map's fixed deep-zoom
 * offset for the whole animation. Interpolated frame zooms are fractional, but
 * the wasm's `TileBounds.zoom` is an integer, so each frame is re-anchored to
 * the nearest integer leaflet zoom: a tile coordinate `v` at zoom `z` describes
 * the same complex point as `v * 2^(n-z)` at zoom `n` (the mapping scales by
 * exactly `2^(zoom-2)`), so scaling the center and half-extents this way keeps
 * the frame's complex-plane rectangle — and thus the exponential zoom sweep —
 * exact while emitting an integer `zoom` field. */
export function frameBounds(
  framing: { centerX: number; centerY: number; halfX: number; halfY: number },
  targetZoom: number,
  zoomOffset: number,
  frameZoom: number,
): TileRect {
  const leafletTargetZoom = targetZoom - zoomOffset;
  const fractionalFrameZoom = frameZoom - zoomOffset;
  const leafletFrameZoom = Math.round(fractionalFrameZoom);

  // Re-anchor the captured center from the target's zoom and the constant
  // half-extents from the frame's fractional zoom to the integer frame zoom.
  const centerScale = 2 ** (leafletFrameZoom - leafletTargetZoom);
  const extentScale = 2 ** (leafletFrameZoom - fractionalFrameZoom);

  const centerX = framing.centerX * centerScale;
  const centerY = framing.centerY * centerScale;
  const halfX = framing.halfX * extentScale;
  const halfY = framing.halfY * extentScale;

  return {
    xMin: centerX - halfX,
    xMax: centerX + halfX,
    yMin: centerY - halfY,
    yMax: centerY + halfY,
    zoom: leafletFrameZoom,
  };
}

/** The per-frame effective zoom levels, exponentially interpolated (linear in
 * zoom level, i.e. log-magnification) between the fully-zoomed-out view and the
 * target. A "zoom in" runs from the full set to the target; a "zoom out" is the
 * reverse. A single-frame animation is just the target. */
export function frameZoomLevels(
  spec: AnimationSpec,
  targetZoom: number,
): number[] {
  const count = frameCount(spec);
  const start = spec.kind === "in" ? FULL_SET_EFFECTIVE_ZOOM : targetZoom;
  const end = spec.kind === "in" ? targetZoom : FULL_SET_EFFECTIVE_ZOOM;

  if (count === 1) {
    return [targetZoom];
  }

  const levels: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    levels.push(start + (end - start) * t);
  }
  return levels;
}

/** The complete sequence of frame rectangles for an animation: one `TileRect`
 * per frame, exponentially interpolated in zoom, all centered on the animation
 * origin and framed to the output aspect ratio. */
export function buildFrameRects(
  spec: AnimationSpec,
  target: TileRect,
  targetZoom: number,
  zoomOffset: number,
): TileRect[] {
  const framing = targetFraming(target, spec.width, spec.height);
  return frameZoomLevels(spec, targetZoom).map((frameZoom) =>
    frameBounds(framing, targetZoom, zoomOffset, frameZoom),
  );
}
