// The protocol between the main thread and the render worker (worker.js),
// plus the tile-space geometry type both sides speak. The payload shapes
// mirror the serde structs in mandelbrot/src/lib.rs (`TileRenderOptions`,
// `ColoringOptions`); field names must stay in sync with those structs'
// camelCase renames.

import type { FunctionThread } from "threads";

// A rectangle in Leaflet tile coordinates. A tile coordinate `v` at `zoom`
// maps to the complex offset ((v / 2^(zoom - 2)) * (tileSize / 128) - 4)
// * 2^-zoomOffset from the world origin.
export type TileRect = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zoom: number;
};

// Color and palette settings shared by tile rendering and in-place
// recoloring. None of these affect escape values, so any change to them can
// be applied by recoloring cached tiles instead of re-rendering.
export type ColoringOptions = {
  colorScheme: string;
  reverseColors: boolean;
  shiftHueAmount: number;
  saturateAmount: number;
  lightenAmount: number;
  colorSpace: number;
  paletteMinIter: number;
  paletteMaxIter: number;
  // How many times the palette repeats across the palette range; cyclical
  // palettes wrap, others boomerang (alternate direction) to stay seamless.
  colorCycles: number;
  // Distance-estimate rendering mode (issue #46): the cached values are a
  // palette-independent brightness in [0, 1] rather than iteration counts, so
  // the palette maps them over the fixed 0..1 range and the min/max iteration
  // thresholds are ignored.
  distanceEstimate: boolean;
};

// Everything a tile render needs, as one object handed through the worker
// to the wasm `render_tile` entrypoint.
export type TileRenderPayload = {
  originRe: string;
  originIm: string;
  bounds: TileRect;
  zoomOffset: number;
  iterations: number;
  exponent: number;
  imageWidth: number;
  imageHeight: number;
  // Baked into the returned escape values (unlike `coloring`, which only
  // affects the RGBA bytes), so changing it requires a re-render.
  smoothColoring: boolean;
  // Whether to return the per-pixel escape values used for recoloring; the
  // offscreen image-export path skips them to avoid the extra transfer.
  includeValues: boolean;
  coloring: ColoringOptions;
};

export type CalculateRequest = {
  type: "calculate";
  payload: TileRenderPayload;
};

// A Julia thumbnail render (issue #12). Unlike a Mandelbrot tile the view is
// fixed (the whole set is framed), so only the parameter `c` under the cursor
// plus the shared appearance settings ride along — no origin or tile geometry.
// Mirrors the serde `JuliaRenderOptions` struct in mandelbrot/src/lib.rs.
export type JuliaRenderPayload = {
  cRe: number;
  cIm: number;
  iterations: number;
  exponent: number;
  imageWidth: number;
  imageHeight: number;
  smoothColoring: boolean;
  coloring: ColoringOptions;
};
export type JuliaRequest = {
  type: "julia";
  payload: JuliaRenderPayload;
};

// A single point in the complex plane, described exactly like a tile render
// (world origin plus a fractional Leaflet tile coordinate). Mirrors the serde
// `PointQueryOptions` struct in mandelbrot/src/lib.rs.
export type PointQueryPayload = {
  originRe: string;
  originIm: string;
  tileX: number;
  tileY: number;
  tileZoom: number;
  zoomOffset: number;
  iterations: number;
  exponent: number;
};
// Requests the exterior distance estimate from a point to the set boundary.
export type DistanceEstimateRequest = {
  type: "distanceEstimate";
  payload: PointQueryPayload;
};
// Requests the period of the attracting cycle at a point (in-set points only).
export type PeriodRequest = {
  type: "period";
  payload: PointQueryPayload;
};
export type RecolorPayload = {
  // Per-pixel smoothed escape values captured when the tile was rendered.
  values: Float32Array;
  coloring: ColoringOptions;
};
export type RecolorRequest = { type: "recolor"; payload: RecolorPayload };
export type OptimisePayload = { buffer: ArrayBuffer };
export type OptimiseRequest = { type: "optimise"; payload: OptimisePayload };
// Tier-up warmup for the deep general-exponent (multibrot) perturbation
// kernel; returns nothing. Sent once per worker at pool spawn when the
// view's exponent != 2 and it is already at deep-zoom depth.
export type WarmupGeneralRequest = { type: "warmupGeneral" };
// Tier-up warmup for the direct-tier general-exponent stream kernel;
// returns nothing. Sent once per worker at pool spawn when the view's
// exponent != 2 at direct depth (effective zoom < DEEP_ZOOM_THRESHOLD).
export type WarmupGeneralDirectRequest = { type: "warmupGeneralDirect" };
// Tier-up warmup for the perturbation-f64 stream kernel; returns nothing.
// Sent once per worker at pool spawn when the view is already at deep-zoom
// depth (exponent 2, effective zoom >= DEEP_ZOOM_THRESHOLD).
export type WarmupDeepRequest = { type: "warmupDeep" };
// Tier-up warmup for the hybrid float-exp stream kernel; returns nothing.
// Sent once per worker at pool spawn when the view is already at float-exp
// depth (exponent 2, effective zoom >= FLOAT_EXP_THRESHOLD).
export type WarmupFloatExpRequest = { type: "warmupFloatExp" };
export type WorkerRequest =
  | CalculateRequest
  | JuliaRequest
  | DistanceEstimateRequest
  | PeriodRequest
  | OptimiseRequest
  | RecolorRequest
  | WarmupGeneralRequest
  | WarmupGeneralDirectRequest
  | WarmupDeepRequest
  | WarmupFloatExpRequest;

export type MandelbrotResponse = {
  image: Uint8Array;
  // Per-pixel smoothed escape values for recoloring; null when the request
  // did not ask for them (offscreen image export).
  values: Float32Array | null;
  // Escaped-pixel iteration range of the tile; null when the tile is
  // entirely inside the set.
  minIter: number | null;
  maxIter: number | null;
  // Which precision path rendered the tile, as a `RenderTier` discriminant
  // (see tierOverlay.ts / the Rust `RenderTier` enum). Drives the diagnostics
  // overlay (issue #50).
  tier: number;
};
export type OptimiseResponse = ArrayBuffer;
export type RecolorResponse = Uint8Array;
// Exterior distance estimate in complex-plane units, or negative when the
// point is inside the set (no exterior distance).
export type DistanceEstimateResponse = number;
// Period of the attracting cycle, or 0 when the point is not in the set (or no
// cycle was resolved).
export type PeriodResponse = number;
export type WorkerResponse =
  | MandelbrotResponse
  | DistanceEstimateResponse
  | PeriodResponse
  | OptimiseResponse
  | RecolorResponse;

export type TaskThread = FunctionThread<[WorkerRequest], WorkerResponse>;
