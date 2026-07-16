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
  iterations: number;
  exponent: number;
  colorScheme: string;
  // How many times the palette repeats across the palette range; cyclical
  // palettes wrap, others boomerang (alternate direction) to stay seamless.
  colorCycles: number;
  lightenAmount: number;
  saturateAmount: number;
  shiftHueAmount: number;
  colorSpace: number;
  reverseColors: boolean;
  highDpiTiles: boolean;
  // Diagnostics: tint each tile by the precision tier (direct f64 /
  // perturbation f64 / hybrid float-exp) that rendered it (issue #50).
  showTierOverlay: boolean;
  smoothColoring: boolean;
  paletteMinIter: number;
  paletteMaxIter: number;
  // When enabled the palette range fits itself to the on-screen tiles and
  // the min/max inputs become read-only displays; when disabled they are
  // the user's to edit.
  paletteAutoAdjust: boolean;

  // Coordinates are decimal strings because deep zooms exceed f64 precision.
  re: string;
  im: string;
  zoom: number;
};

export const defaultConfig: MandelbrotConfig = {
  iterations: 200,
  exponent: 2,
  colorScheme: "turbo",
  colorCycles: 1,
  lightenAmount: 0,
  saturateAmount: 0,
  shiftHueAmount: 0,
  colorSpace: 2,
  reverseColors: false,
  highDpiTiles: false,
  showTierOverlay: false,
  smoothColoring: true,
  paletteMinIter: 0,
  paletteMaxIter: 200,
  paletteAutoAdjust: true,

  re: "-0.5",
  im: "0",
  zoom: 3,
};

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
//   visual effect explicitly (paletteAutoAdjust refits only when enabled).
export type SettingEffect = "recolor" | "rerender" | "none";

type BaseSpec = {
  // Also the id of the setting's input element in index.html.
  key: keyof MandelbrotConfig;
  // Query parameter in share URLs; settings without one (highDpiTiles) are
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
  // exponent picks a different fractal, so the old position is meaningless).
  resetView?: boolean;
};
export type SliderSpec = BaseSpec & {
  key: NumericConfigKey;
  control: "slider";
};
export type SelectSpec = BaseSpec & { key: "colorScheme"; control: "select" };
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
    key: "iterations",
    control: "number",
    urlParam: "i",
    effect: "rerender",
    min: 1,
    max: 10 ** 9,
  },
  {
    key: "exponent",
    control: "number",
    urlParam: "e",
    effect: "rerender",
    min: 2,
    max: 10 ** 9,
    resetView: true,
  },
  { key: "highDpiTiles", control: "checkbox", effect: "rerender" },
  // Diagnostics overlay: toggling it only draws/clears a cosmetic overlay on
  // the already-rendered tiles, so its effect is "none" and the wiring
  // repaints the on-screen tiles explicitly (see wireCheckboxInput).
  { key: "showTierOverlay", control: "checkbox", effect: "none" },
  // Color scheme
  { key: "colorScheme", control: "select", urlParam: "c", effect: "recolor" },
  {
    key: "colorCycles",
    control: "number",
    urlParam: "cc",
    effect: "recolor",
    min: 1,
    max: 100,
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
  // boolean; see buildShareUrl/parseShareParams)
  {
    key: "paletteMinIter",
    control: "number",
    urlParam: "pmin",
    effect: "recolor",
    min: -(10 ** 9),
    max: 10 ** 9,
  },
  {
    key: "paletteMaxIter",
    control: "number",
    urlParam: "pmax",
    effect: "recolor",
    min: -(10 ** 9),
    max: 10 ** 9,
  },
  {
    key: "paletteAutoAdjust",
    control: "checkbox",
    urlParam: "pm",
    effect: "none",
  },
];

/** The subset of the config the wasm coloring code consumes, in the shape
 * the worker protocol (and the Rust `ColoringOptions` struct) expects. */
export function coloringOptions(config: MandelbrotConfig): ColoringOptions {
  return {
    colorScheme: config.colorScheme,
    reverseColors: config.reverseColors,
    shiftHueAmount: config.shiftHueAmount,
    saturateAmount: config.saturateAmount,
    lightenAmount: config.lightenAmount,
    colorSpace: config.colorSpace,
    paletteMinIter: config.paletteMinIter,
    paletteMaxIter: config.paletteMaxIter,
    colorCycles: config.colorCycles,
  };
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
      spec.key === "paletteAutoAdjust"
        ? config.paletteAutoAdjust
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
      spec.key === "paletteAutoAdjust"
    ) {
      continue;
    }
    const raw = params.get(spec.urlParam);
    if (!raw) {
      continue;
    }

    switch (spec.control) {
      case "number": {
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
    parsed.paletteAutoAdjust = paletteMode === "auto";
  } else if (params.get("pmin") || params.get("pmax")) {
    // Legacy share URLs predate auto-adjust; explicit palette values imply
    // the sender tuned them by hand, so preserve that appearance.
    parsed.paletteAutoAdjust = false;
  }

  return parsed;
}

/** Writes a setting's current config value into its sidebar input. */
export function syncInputToConfig(
  config: MandelbrotConfig,
  key: keyof MandelbrotConfig,
) {
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
