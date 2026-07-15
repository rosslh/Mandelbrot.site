// Pure helpers shared by the runner, pixel-check, and ingest. Turns corpus
// cases into the exact 21-argument call the production worker makes
// (client/js/worker.js), replicating the client's zoom-rebase and tile math.

// Effective zoom thresholds from mandelbrot/src/perturbation.rs. The wasm
// picks direct vs perturbation from the actual pixel spacing
// (MIN_DIRECT_PIXEL_SPACING); at the corpus default tileSize of 200 that
// lands at effective zoom 46.
export const DEEP_ZOOM_THRESHOLD = 46;
export const FLOAT_EXP_THRESHOLD = 250;

// REBASED_LEAFLET_ZOOM in client/js/MandelbrotMap.ts: after a deep-zoom
// rebase the client keeps Leaflet at zoom 12 and accumulates the rest in
// zoomOffset.
const REBASED_LEAFLET_ZOOM = 12;

export const PATHWAYS = ["direct", "perturbation-f64", "float-exp"];

// Perturbation only supports exponents 2..=64 (MAX_PERTURBED_EXPONENT);
// outside that range deep views fall back to the direct f64 renderer.
export function pathwayFor(effectiveZoom, exponent = 2) {
  const perturbable = exponent >= 2 && exponent <= 64;
  if (effectiveZoom < DEEP_ZOOM_THRESHOLD || !perturbable) return "direct";
  if (effectiveZoom < FLOAT_EXP_THRESHOLD) return "perturbation-f64";
  return "float-exp";
}

// A tile coordinate v at tile_zoom maps to the complex offset
// ((v / 2^(tile_zoom - 2)) * (200 / 128) - 4) * 2^-zoom_offset from the
// origin (documented on get_mandelbrot_image_precise in mandelbrot/src/lib.rs),
// so the tile containing the origin has coordinate floor(0.64 * 2^tile_zoom).
function originTileCoordinate(tileZoom) {
  return Math.floor(0.64 * 2 ** tileZoom);
}

// Returns [payload, args]: the named payload (for debugging/results) and the
// positional argument array for get_mandelbrot_image_precise, in the order
// used by client/js/worker.js.
export function caseToWasmArgs(benchCase, defaults) {
  const merged = { ...defaults, ...(benchCase.overrides ?? {}) };
  const zoom = benchCase.zoom;
  const zoomOffset = Math.max(0, zoom - REBASED_LEAFLET_ZOOM);
  const tileZoom = zoom - zoomOffset;
  const v = originTileCoordinate(tileZoom);

  const payload = {
    originRe: benchCase.re,
    originIm: benchCase.im,
    bounds: { xMin: v, xMax: v + 1, yMin: v, yMax: v + 1, zoom: tileZoom },
    zoomOffset,
    iterations: benchCase.iterations,
    exponent: merged.exponent,
    imageWidth: merged.tileSize,
    imageHeight: merged.tileSize,
    colorScheme: merged.colorScheme,
    reverseColors: merged.reverseColors,
    shiftHueAmount: merged.shiftHueAmount,
    saturateAmount: merged.saturateAmount,
    lightenAmount: merged.lightenAmount,
    colorSpace: merged.colorSpace,
    smoothColoring: merged.smoothColoring,
    paletteMinIter: merged.paletteMinIter,
    // Production scales the palette with iterations (scaleWithIterations
    // defaults to true), so the palette max follows the iteration count.
    paletteMaxIter: merged.paletteMaxIter ?? benchCase.iterations,
  };

  const args = [
    payload.originRe,
    payload.originIm,
    payload.bounds.xMin,
    payload.bounds.xMax,
    payload.bounds.yMin,
    payload.bounds.yMax,
    payload.bounds.zoom,
    payload.zoomOffset,
    payload.iterations,
    payload.exponent,
    payload.imageWidth,
    payload.imageHeight,
    payload.colorScheme,
    payload.reverseColors,
    payload.shiftHueAmount,
    payload.saturateAmount,
    payload.lightenAmount,
    payload.colorSpace,
    payload.smoothColoring,
    payload.paletteMinIter,
    payload.paletteMaxIter,
  ];

  return [payload, args];
}

// Same DECIMAL_PATTERN the client applies (client/js/highPrecision.ts).
export function isValidCoordinate(value) {
  return (
    typeof value === "string" &&
    /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value.trim())
  );
}

export function validateCase(benchCase) {
  const problems = [];
  if (!benchCase.id) problems.push("missing id");
  if (!isValidCoordinate(benchCase.re)) problems.push(`bad re: ${benchCase.re}`);
  if (!isValidCoordinate(benchCase.im)) problems.push(`bad im: ${benchCase.im}`);
  if (!Number.isInteger(benchCase.zoom) || benchCase.zoom < 0) {
    problems.push(`bad zoom: ${benchCase.zoom}`);
  }
  if (!Number.isInteger(benchCase.iterations) || benchCase.iterations < 1) {
    problems.push(`bad iterations: ${benchCase.iterations}`);
  }
  return problems;
}
