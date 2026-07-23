// Single source of truth for the app's settings: their types, defaults,
// share-URL parameters, sidebar inputs, and how a change takes effect.
// Input wiring (MandelbrotControls), share-URL serialization and parsing,
// and reset handling are all derived from the schema below, so adding a
// setting is one schema entry plus its HTML input — not a hand-edit of each
// of those code paths.

import type { ColoringOptions } from "./protocol";
import { isValidDecimalCoordinate } from "./highPrecision";
import { formatMagnification } from "./magnification";

export type MandelbrotConfig = {
  maxIterations: number;
  power: number;
  palette: string;
  // How many times the palette repeats across the palette range; cyclical
  // palettes wrap, others boomerang (alternate direction) to stay seamless.
  colorDensity: number;
  // Slides the palette along the range, as a 0–100 slider spanning one
  // palette length. With a color density of two or more (or a cyclical
  // palette)
  // the band pattern phase-shifts and glides seamlessly; a single pass has
  // no whole pattern to slide, so it rotates instead (modulo 1), keeping
  // every color in use at the cost of a seam where the palette's ends meet
  // — the honest trade, since the seamless alternative would truncate part
  // of the palette. Like colorDensity it applies in every coloring method.
  paletteOffset: number;
  lightenAmount: number;
  saturateAmount: number;
  shiftHueAmount: number;
  colorSpace: number;
  reverseColors: boolean;
  // Tile render resolution: "layout" (the tile's CSS layout size, upscaled
  // on high-density displays), "native" (the display's devicePixelRatio,
  // pixel-for-pixel), or "2"/"4" (multiples of native, downscaled by the
  // browser for anti-aliasing). See supersamplingFactor for how the values
  // resolve.
  supersampling: string;
  // Diagnostics: tint each tile by the precision tier (direct f64 /
  // perturbation f64 / hybrid float-exp) that rendered it (issue #50).
  showTierOverlay: boolean;
  smoothColoring: boolean;
  // What each pixel's color encodes — one of COLORING_METHODS:
  // - "standard": escape time (the classic coloring).
  // - "distanceEstimate" (issue #46): distance to the set boundary, for
  //   crisp boundary images.
  // - "atomDomain" (issue #45): the detected period of the pixel's atom
  //   domain (the iteration index of the orbit's nearest approach to the
  //   origin) on a categorical palette, visualizing where the set's
  //   components of each period live.
  // The non-standard methods render on the direct f64 path only; deeper
  // (zoomed) tiles fall back to escape-time coloring. They also fix the
  // palette domain, ignoring the palette range.
  coloringMethod: string;
  // How the palette is distributed inside the palette window, as a 0–100
  // slider blending between the two classic mappings:
  // - 0 ("Linear"): colors spread evenly across the iteration range.
  // - 100 ("Histogram"): histogram coloring — the fractal-renderer name for
  //   histogram equalization (image editors call it "Equalize"). The
  //   normalized position is remapped through a CDF of the visible
  //   escape-value distribution, so each palette color covers roughly equal
  //   visible pixel mass (and color cycles become mass-uniform).
  // Intermediate values interpolate the two (the equalization table is
  // blended toward the identity client-side; see buildPaletteCdf). Defaults
  // to 0 — the app's historical linear behavior. The window itself
  // (paletteMinIter/paletteMaxIter) keeps its meaning at every strength:
  // values below the min clamp to the palette start, above the max to the
  // palette end.
  histogramColoring: number;
  paletteMinIter: number;
  paletteMaxIter: number;
  // When enabled the palette range fits itself to the on-screen tiles and
  // the min/max inputs become read-only displays; when disabled they are
  // the user's to edit.
  paletteAutoFit: boolean;

  // Coordinates are decimal strings because deep zooms exceed f64 precision.
  re: string;
  im: string;
  zoom: number;
};

export const defaultConfig: MandelbrotConfig = {
  maxIterations: 200,
  power: 2,
  palette: "turbo",
  colorDensity: 1,
  paletteOffset: 0,
  lightenAmount: 0,
  saturateAmount: 0,
  shiftHueAmount: 0,
  colorSpace: 2,
  reverseColors: false,
  supersampling: "layout",
  showTierOverlay: false,
  smoothColoring: true,
  coloringMethod: "standard",
  histogramColoring: 0,
  paletteMinIter: 0,
  paletteMaxIter: 200,
  paletteAutoFit: true,

  re: "-0.5",
  im: "0",
  zoom: 3,
};

export const COLORING_METHODS = [
  "standard",
  "distanceEstimate",
  "atomDomain",
] as const;

/** Whether the config's coloring method fixes the palette domain (the
 * distance-estimate and atom-domain methods), making the palette range
 * inapplicable. */
export function isFixedPaletteMethod(config: MandelbrotConfig): boolean {
  return config.coloringMethod !== "standard";
}

// Ceiling on the tile-resolution multiplier: a dpr-3 phone at "4" would
// otherwise render 2400px tiles (~5.8M pixels each). 8x of the 200px tile
// size caps the worst case at 1600px tiles.
const MAX_SUPERSAMPLING_FACTOR = 8;

/** The tile-resolution multiplier for a supersampling setting value.
 * "layout" is 1 (the CSS layout size — the browser upscales it on
 * high-density displays); "native" is the devicePixelRatio, matching the
 * screen pixel-for-pixel; the numeric values are multiples of native, so
 * the browser's downscale back to the screen is always a whole number of
 * samples per device pixel — true anti-aliasing with no interpolation
 * artifacts, on fractional ratios too. Anything malformed falls back to
 * "layout". */
export function supersamplingFactorForSetting(setting: string): number {
  if (setting === "layout") {
    return 1;
  }
  const dpr = window.devicePixelRatio || 1;
  if (setting === "native") {
    return Math.min(dpr, MAX_SUPERSAMPLING_FACTOR);
  }
  const multiple = Number(setting);
  if (!Number.isFinite(multiple) || multiple <= 0) {
    return 1;
  }
  return Math.min(multiple * dpr, MAX_SUPERSAMPLING_FACTOR);
}

/** The tile-resolution multiplier for the config's supersampling setting. */
export function supersamplingFactor(config: MandelbrotConfig): number {
  return supersamplingFactorForSetting(config.supersampling);
}

type NumericConfigKey = {
  [K in keyof MandelbrotConfig]: MandelbrotConfig[K] extends number ? K : never;
}[keyof MandelbrotConfig];
type BooleanConfigKey = {
  [K in keyof MandelbrotConfig]: MandelbrotConfig[K] extends boolean
    ? K
    : never;
}[keyof MandelbrotConfig];

// How a settings change takes effect:
// - "recolor": only affects how cached escape values map to colors, so the
//   on-screen tiles are repainted in place — no re-render.
// - "rerender": affects the escape values (or the tiles' pixel density), so
//   every tile re-renders.
// - "none": the change itself repaints nothing; its wiring applies any
//   visual effect explicitly (paletteAutoFit refits only when enabled).
export type SettingEffect = "recolor" | "rerender" | "none";

type BaseSpec = {
  // Also the id of the setting's input element in index.html.
  key: keyof MandelbrotConfig;
  // Query parameter in share URLs; settings without one (supersampling) are
  // device-specific and deliberately not shared.
  urlParam?: string;
  effect: SettingEffect;
};

export type NumberSpec = BaseSpec & {
  key: NumericConfigKey;
  control: "number";
  min: number;
  max: number;
  allowFraction?: boolean;
  // Changing this setting moves the map back to the initial view (the
  // power picks a different fractal, so the old position is meaningless).
  resetView?: boolean;
};
// A numeric setting with no sidebar input: it is set programmatically (the
// palette bounds, via the histogram markers or the auto fit) but still rides
// share URLs and participates in resets.
export type VirtualNumberSpec = BaseSpec & {
  key: NumericConfigKey;
  control: "virtualNumber";
  min: number;
  max: number;
};
export type SliderSpec = BaseSpec & {
  key: NumericConfigKey;
  control: "slider";
};
export type SelectSpec = BaseSpec & {
  key: "palette" | "coloringMethod" | "supersampling";
  control: "select";
};
export type SelectNumberSpec = BaseSpec & {
  key: NumericConfigKey;
  control: "selectNumber";
};
export type CheckboxSpec = BaseSpec & {
  key: BooleanConfigKey;
  control: "checkbox";
};
// Arbitrary-precision decimal strings (re, im); only their approximate
// magnitude is range-checked.
export type CoordinateSpec = BaseSpec & {
  key: "re" | "im";
  control: "coordinate";
  min: number;
  max: number;
};
// The zoom setting: stored (and shared via URL) as the effective zoom level,
// but displayed and edited as a magnification factor (see magnification.ts).
// min/max bound the underlying zoom level, not the magnification.
export type MagnificationSpec = BaseSpec & {
  key: "zoom";
  control: "magnification";
  min: number;
  max: number;
};

export type SettingSpec =
  | NumberSpec
  | VirtualNumberSpec
  | SliderSpec
  | SelectSpec
  | SelectNumberSpec
  | CheckboxSpec
  | CoordinateSpec
  | MagnificationSpec;

export const settingsSchema: SettingSpec[] = [
  // View
  {
    key: "re",
    control: "coordinate",
    urlParam: "re",
    effect: "rerender",
    min: -2,
    max: 2,
  },
  {
    key: "im",
    control: "coordinate",
    urlParam: "im",
    effect: "rerender",
    min: -2,
    max: 2,
  },
  {
    key: "zoom",
    control: "magnification",
    urlParam: "z",
    effect: "rerender",
    min: 0,
    max: 10 ** 6,
  },
  // Render settings
  {
    key: "maxIterations",
    control: "number",
    urlParam: "i",
    effect: "rerender",
    min: 1,
    max: 10 ** 9,
  },
  {
    key: "power",
    control: "number",
    urlParam: "e",
    effect: "rerender",
    min: 2,
    max: 10 ** 9,
    resetView: true,
  },
  // Coloring method: what the cached per-pixel values encode (escape time,
  // boundary distance, or atom-domain period), so switching re-renders.
  // Legacy share URLs carried the methods as the "de"/"ad" boolean params;
  // parseShareParams still honors those.
  {
    key: "coloringMethod",
    control: "select",
    urlParam: "m",
    effect: "rerender",
  },
  { key: "supersampling", control: "select", effect: "rerender" },
  // Diagnostics overlay: toggling it only draws/clears a cosmetic overlay on
  // the already-rendered tiles, so its effect is "none" and the wiring
  // repaints the on-screen tiles explicitly (see wireCheckboxInput).
  { key: "showTierOverlay", control: "checkbox", effect: "none" },
  // Color scheme
  { key: "palette", control: "select", urlParam: "c", effect: "recolor" },
  {
    key: "colorDensity",
    control: "number",
    urlParam: "cc",
    effect: "recolor",
    min: 1,
    max: 100,
  },
  // Palette offset: a phase shift of the palette along the range (0–100% of
  // one palette length). Recolor-only, like the other palette-application
  // settings; parseShareParams clamps its "po" parameter below.
  {
    key: "paletteOffset",
    control: "slider",
    urlParam: "po",
    effect: "recolor",
  },
  {
    key: "reverseColors",
    control: "checkbox",
    urlParam: "r",
    effect: "recolor",
  },
  {
    key: "smoothColoring",
    control: "checkbox",
    urlParam: "sc",
    effect: "rerender",
  },
  // Adjust colors
  {
    key: "shiftHueAmount",
    control: "slider",
    urlParam: "h",
    effect: "recolor",
  },
  {
    key: "saturateAmount",
    control: "slider",
    urlParam: "s",
    effect: "recolor",
  },
  { key: "lightenAmount", control: "slider", urlParam: "l", effect: "recolor" },
  {
    key: "colorSpace",
    control: "selectNumber",
    urlParam: "cs",
    effect: "recolor",
  },
  // Palette range ("pm" is serialized as auto/manual rather than the raw
  // boolean; see buildShareUrl/parseShareParams). The bounds have no sidebar
  // inputs — they are set by dragging the histogram markers or by the auto
  // fit — but keep their share-URL parameters.
  //
  // Color mapping: how strongly the palette is equalized to the visible
  // distribution inside the window (0 linear .. 100 histogram coloring).
  // Effect "none": a change reshapes the equalization table, which the
  // wiring applies via an explicit CDF rebuild + recolor
  // (applyPaletteWindowChange), not a plain recolor. Share URLs that predate
  // the parameter omit it and keep the linear default, so old links render
  // unchanged.
  {
    key: "histogramColoring",
    control: "slider",
    urlParam: "pmap",
    effect: "none",
  },
  {
    key: "paletteMinIter",
    control: "virtualNumber",
    urlParam: "pmin",
    effect: "recolor",
    min: -(10 ** 9),
    max: 10 ** 9,
  },
  {
    key: "paletteMaxIter",
    control: "virtualNumber",
    urlParam: "pmax",
    effect: "recolor",
    min: -(10 ** 9),
    max: 10 ** 9,
  },
  {
    key: "paletteAutoFit",
    control: "checkbox",
    urlParam: "pm",
    effect: "none",
  },
];

/** The subset of the config the wasm coloring code consumes, in the shape
 * the worker protocol (and the Rust `ColoringOptions` struct) expects.
 *
 * `paletteCdf` is the equalization table for histogram coloring — viewport
 * state rather than a config value, so callers that own one (the map's
 * viewport-global table, a thumbnail's private fit) pass it explicitly;
 * omitting it yields the linear mapping. */
export function coloringOptions(
  config: MandelbrotConfig,
  paletteCdf?: Float32Array | null,
): ColoringOptions {
  const options: ColoringOptions = {
    palette: config.palette,
    reverseColors: config.reverseColors,
    shiftHueAmount: config.shiftHueAmount,
    saturateAmount: config.saturateAmount,
    lightenAmount: config.lightenAmount,
    colorSpace: config.colorSpace,
    paletteMinIter: config.paletteMinIter,
    paletteMaxIter: config.paletteMaxIter,
    colorDensity: config.colorDensity,
    // The config stores the offset as a 0–100 percentage of one palette
    // length; the wasm consumes it as 0..1.
    paletteOffset: config.paletteOffset / 100,
    // The worker protocol (and the Rust struct behind it) carries the two
    // methods as independent flags; the single-select method guarantees at
    // most one is set.
    distanceEstimate: config.coloringMethod === "distanceEstimate",
    atomDomain: config.coloringMethod === "atomDomain",
  };

  if (paletteCdf && paletteCdf.length > 0) {
    // A plain array (not the Float32Array itself) so the payload stays a
    // simple JSON-shaped object for the worker's serde deserialization.
    options.paletteCdf = Array.from(paletteCdf);
  }

  return options;
}

/** The shared parameters for the given config as a plain object keyed by URL
 * parameter name, e.g. `{ re, im, z, i, e, c, ... }`. Single source of truth
 * for both the share URL and the PNG metadata blob, so the two never drift. */
export function buildShareParams(
  config: MandelbrotConfig,
): Record<string, string> {
  const params: Record<string, string> = {};

  for (const spec of settingsSchema) {
    if (!spec.urlParam) {
      continue;
    }
    params[spec.urlParam] =
      spec.key === "paletteAutoFit"
        ? config.paletteAutoFit
          ? "auto"
          : "manual"
        : String(config[spec.key]);
  }

  return params;
}

/** The share URL encoding the given config, one query parameter per
 * schema entry that has one. */
export function buildShareUrl(config: MandelbrotConfig): string {
  const url = new URL(window.location.origin);

  for (const [param, value] of Object.entries(buildShareParams(config))) {
    url.searchParams.set(param, value);
  }

  return url.toString();
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

/** Parses share-URL parameters into config overrides. A share URL is only
 * honored when it carries a complete, valid view (re, im, z); otherwise
 * nothing is applied. Malformed or out-of-range values fall back to the
 * current defaults by being omitted. */
export function parseShareParams(search: string): Partial<MandelbrotConfig> {
  const params = new URLSearchParams(search);

  const re = params.get("re");
  const im = params.get("im");
  const zoom = params.get("z");
  if (
    !re ||
    !im ||
    !zoom ||
    !isValidDecimalCoordinate(re) ||
    !isValidDecimalCoordinate(im)
  ) {
    return {};
  }

  // Partial<MandelbrotConfig> can't be assigned through a union-typed key,
  // so the writes below go through this loosened view of the same object.
  const parsed: Partial<MandelbrotConfig> = {};
  const assign = parsed as Record<string, string | number | boolean>;
  parsed.re = re;
  parsed.im = im;
  parsed.zoom = Number(zoom);

  for (const spec of settingsSchema) {
    if (
      !spec.urlParam ||
      spec.key === "re" ||
      spec.key === "im" ||
      spec.key === "zoom" ||
      spec.key === "paletteAutoFit"
    ) {
      continue;
    }
    const raw = params.get(spec.urlParam);
    if (!raw) {
      continue;
    }

    switch (spec.control) {
      case "number":
      case "virtualNumber": {
        const value = Number(raw);
        if (!Number.isNaN(value)) {
          assign[spec.key] = clamp(value, spec.min, spec.max);
        }
        break;
      }
      case "slider":
      case "selectNumber": {
        const value = Number(raw);
        if (!Number.isNaN(value)) {
          assign[spec.key] = value;
        }
        break;
      }
      case "select":
        assign[spec.key] = raw;
        break;
      case "checkbox":
        assign[spec.key] = raw === "true";
        break;
    }
  }

  const paletteMode = params.get("pm");
  if (paletteMode === "auto" || paletteMode === "manual") {
    parsed.paletteAutoFit = paletteMode === "auto";
  } else if (params.get("pmin") || params.get("pmax")) {
    // Legacy share URLs predate the auto-fit setting; explicit palette values
    // imply the sender tuned them by hand, so preserve that appearance.
    parsed.paletteAutoFit = false;
  }

  // An unknown method value falls back to the default by omission.
  if (
    parsed.coloringMethod !== undefined &&
    !(COLORING_METHODS as readonly string[]).includes(parsed.coloringMethod)
  ) {
    delete parsed.coloringMethod;
  }

  // The generic slider parse above has no range metadata, so clamp "pmap"
  // to the slider's range here; malformed or absent values fall back to the
  // linear default by omission.
  if (typeof parsed.histogramColoring === "number") {
    parsed.histogramColoring = clamp(
      Math.round(parsed.histogramColoring),
      0,
      100,
    );
  }
  // The palette offset ("po") is likewise a slider with no range metadata.
  if (typeof parsed.paletteOffset === "number") {
    parsed.paletteOffset = clamp(Math.round(parsed.paletteOffset), 0, 100);
  }
  // Legacy share URLs carried the coloring methods as two boolean params.
  // Distance estimate wins when both are set, matching the renderer's
  // precedence back then.
  if (parsed.coloringMethod === undefined) {
    if (params.get("de") === "true") {
      parsed.coloringMethod = "distanceEstimate";
    } else if (params.get("ad") === "true") {
      parsed.coloringMethod = "atomDomain";
    }
  }

  return parsed;
}

// Settings that exist only in the config (no sidebar input element);
// syncInputToConfig skips them rather than warning about a missing element.
const virtualKeys = new Set<keyof MandelbrotConfig>(
  settingsSchema
    .filter((spec) => spec.control === "virtualNumber")
    .map((spec) => spec.key),
);

/** Writes a setting's current config value into its sidebar input. */
export function syncInputToConfig(
  config: MandelbrotConfig,
  key: keyof MandelbrotConfig,
) {
  if (virtualKeys.has(key)) {
    return;
  }
  const element = document.getElementById(key);
  if (!element) {
    console.warn(`Could not find input element for setting: ${key}`);
    return;
  }

  if (element instanceof HTMLInputElement && element.type === "checkbox") {
    element.checked = Boolean(config[key]);
  } else if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement
  ) {
    // Zoom is stored as an effective zoom level but displayed as a
    // magnification factor.
    element.value =
      key === "zoom" ? formatMagnification(config.zoom) : String(config[key]);
  }
}

/** Writes every setting's config value into its input, e.g. after the
 * share-URL parameters have been applied. */
export function syncAllInputsToConfig(config: MandelbrotConfig) {
  for (const spec of settingsSchema) {
    syncInputToConfig(config, spec.key);
  }
}
