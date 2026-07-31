// Routes settings changes to the cheapest way of making them visible, and
// implements the per-panel reset strategies. Extracted from the old
// MandelbrotControls class: the mapping from "key changed" to "visual
// effect" is deliberately imperative — an iteration-cap change must
// invalidate the tile cache and reset the palette ceiling *before* the
// refresh, a power change discards the view, the color-mapping slider needs
// a CDF rebuild rather than a plain recolor — so it stays explicit routing
// here instead of reactive effects on the config signals (which would also
// loop: the palette auto-fit writes bounds from inside the render path).

import { batch } from "@preact/signals";
import debounce from "lodash/debounce";
import type MandelbrotMap from "../MandelbrotMap";
import {
  CheckboxSpec,
  CoordinateSpec,
  MagnificationSpec,
  MandelbrotConfig,
  NumberSpec,
  SelectNumberSpec,
  SelectSpec,
  SettingSpec,
  settingsSchema,
  SliderSpec,
} from "../config";
import { isValidDecimalCoordinate } from "../highPrecision";
import { zoomFromMagnification } from "../magnification";

export type ResetSpec = {
  buttonId: string;
  configKeys: Array<keyof MandelbrotConfig>;
  specialHandling?: (map: MandelbrotMap) => void;
  checkDiff?: (map: MandelbrotMap) => boolean;
  // Applies the reset visually. Defaults to a full re-render; sections whose
  // settings only affect coloring repaint the tiles in place instead.
  // Receives the keys that actually differed before the reset.
  apply?: (
    map: MandelbrotMap,
    changedKeys: Array<keyof MandelbrotConfig>,
  ) => void;
};

const specByKey = new Map(settingsSchema.map((spec) => [spec.key, spec]));

/** The schema entry for a setting, narrowed to the caller's control kind. */
export function settingSpec<S extends SettingSpec = SettingSpec>(
  key: keyof MandelbrotConfig,
): S {
  return specByKey.get(key) as S;
}

/** The reset behavior wired to the given summary reset button. */
export function resetSpec(buttonId: string): ResetSpec {
  const spec = RESET_SPECS.find((reset) => reset.buttonId === buttonId);
  if (!spec) {
    throw new Error(`Unknown reset button: ${buttonId}`);
  }
  return spec;
}

/** Routes a settings change to the cheapest way of making it visible:
 * color-only settings repaint the cached tiles in place, anything baked
 * into the escape values re-renders. */
export function applySettingEffect(map: MandelbrotMap, spec: SettingSpec) {
  if (spec.effect === "recolor") {
    map.applyColorSettings();
  } else if (spec.effect === "rerender") {
    const resetView = spec.control === "number" && Boolean(spec.resetView);
    map.refresh(resetView);
  }
}

/** In auto mode, changing the iteration cap resets the palette upper bound
 * to the new cap as a provisional range (the lower bound is kept, clamped
 * under the new ceiling): re-rendering with the old fit would clamp
 * everything above it into a maxed-out band around the set until the
 * re-fit, so the stale detection is dropped and the proper range is fitted
 * once all tiles finish rendering. A user-set range is untouched. */
export function resetPaletteCeilingToMaxIterations(
  map: MandelbrotMap,
  newIterations: number,
) {
  if (!map.config.paletteAutoFit) {
    return;
  }

  // Invalidating (not just clearing) also keeps old-cap tiles that are
  // still rendering from repopulating the cache before the debounced
  // refresh runs, which would overwrite this provisional ceiling with a
  // fit to the previous iteration cap.
  map.invalidateTileCache();

  map.store.patch({
    paletteMaxIter: newIterations,
    paletteMinIter: Math.min(map.config.paletteMinIter, newIterations),
  });
}

/** Parses a number input's raw text against its spec; malformed or
 * out-of-range values fall back to the value currently in the config. */
export function parseNumberValue(
  map: MandelbrotMap,
  spec: NumberSpec,
  raw: string,
): number {
  const parsedValue = spec.allowFraction
    ? Number.parseFloat(raw)
    : Number.parseInt(raw, 10);
  if (isNaN(parsedValue) || parsedValue < spec.min || parsedValue > spec.max) {
    return map.config[spec.key];
  }
  return parsedValue;
}

/** Commits a validated number input to the config and applies its effect.
 * View-resetting settings (the power) must be confirmed before calling this
 * (see ChangePowerModal); a confirmed change also resets the iteration cap —
 * changing the power picks a different fractal, so iteration tuning for the
 * old one doesn't carry over. */
export function applyNumberSetting(
  map: MandelbrotMap,
  spec: NumberSpec,
  value: number,
) {
  if (spec.key === "maxIterations") {
    resetPaletteCeilingToMaxIterations(map, value);
  }

  batch(() => {
    map.config[spec.key] = value;
    if (spec.resetView) {
      map.config.maxIterations = map.initialConfig.maxIterations;
    }
  });

  applySettingEffect(map, spec);
}

/** Commits a coordinate input. Coordinates are kept as decimal strings so
 * deep-zoom precision survives; only their approximate magnitude is range
 * checked. Invalid input reverts to the config's current value. */
export function commitCoordinateSetting(
  map: MandelbrotMap,
  spec: CoordinateSpec,
  raw: string,
) {
  const rawValue = raw.trim();
  const approximateValue = Number.parseFloat(rawValue);
  const isValid =
    isValidDecimalCoordinate(rawValue) &&
    approximateValue >= spec.min &&
    approximateValue <= spec.max;

  map.config[spec.key] = isValid ? rawValue : map.config[spec.key];
  map.refresh();
}

/** Commits a magnification input: the input holds a magnification factor;
 * the config stores the effective zoom level it snaps to (spec.min/max bound
 * the zoom). Entered magnifications snap to a zoom level, so an edit can
 * resolve to the current view; re-rendering would be a no-op then. */
export function commitMagnificationSetting(
  map: MandelbrotMap,
  spec: MagnificationSpec,
  raw: string,
) {
  const zoom = zoomFromMagnification(raw);
  const isValid = zoom !== null && zoom >= spec.min && zoom <= spec.max;
  const changed = isValid && zoom !== map.config.zoom;

  if (changed) {
    map.config.zoom = zoom;
    applySettingEffect(map, spec);
  }
}

export function commitSelectSetting(
  map: MandelbrotMap,
  spec: SelectSpec | SelectNumberSpec,
  raw: string,
) {
  if (spec.control === "select") {
    map.config[spec.key] = raw;
  } else {
    map.config[spec.key] = Number(raw);
  }
  applySettingEffect(map, spec);
}

export function commitCheckboxSetting(
  map: MandelbrotMap,
  spec: CheckboxSpec,
  checked: boolean,
) {
  map.config[spec.key] = checked;
  if (spec.key === "paletteAutoFit") {
    // Disabling keeps the current values (edited by dragging the histogram
    // markers); enabling fits to the visible tiles via an in-place recolor,
    // no re-render.
    if (map.config.paletteAutoFit) {
      map.refitPaletteAndRecolor();
    }
    return;
  }
  if (spec.key === "showTierOverlay") {
    // Cosmetic overlay on already-rendered tiles: draw or clear it on the
    // on-screen tiles instead of re-rendering (effect "none").
    map.applyTierOverlayToggle();
    return;
  }
  applySettingEffect(map, spec);
}

export function commitSliderSetting(
  map: MandelbrotMap,
  spec: SliderSpec,
  value: number,
) {
  map.config[spec.key] = value;
  // The color-mapping strength reshapes the equalization table, which needs
  // a CDF rebuild before the repaint — not a plain recolor (the setting's
  // effect is "none").
  if (spec.key === "histogramColoring") {
    map.applyPaletteWindowChange();
    return;
  }
  applySettingEffect(map, spec);
}

/** Multiplies or halves the iteration cap. The refresh is debounced by the
 * caller-shared function below so rapid clicks re-render once. */
export function adjustIterations(map: MandelbrotMap, factor: 2 | 0.5) {
  const newIterations =
    factor === 2
      ? map.config.maxIterations * 2
      : Math.ceil(map.config.maxIterations / 2);
  map.config.maxIterations = newIterations;
  resetPaletteCeilingToMaxIterations(map, newIterations);
  debouncedIterationRefresh(map);
}

const debouncedIterationRefresh = debounce((map: MandelbrotMap) => {
  void map.refresh();
}, 500);

/** Whether the view is effectively the initial one, so the location reset
 * button can hide. At shallow zoom the comparison uses a small tolerance:
 * settling near home never reproduces the initial view's exact decimals,
 * and an exact comparison would keep the button visible forever. At depth
 * (a nonzero zoom offset) any drift is a genuinely different view, so the
 * comparison is exact. Reads the config signals reactively, so computeds
 * built on it track view changes. */
export function isAtInitialView(map: MandelbrotMap): boolean {
  const { signals } = map.store;
  const initial = map.initialConfig;
  const re = signals.re.value;
  const im = signals.im.value;
  const zoom = signals.zoom.value;

  if (map.zoomOffsetSignal.value !== 0) {
    return re === initial.re && im === initial.im && zoom === initial.zoom;
  }

  const tolerance = 0.02;
  return (
    Math.abs(Number.parseFloat(re) - Number.parseFloat(initial.re)) <=
      tolerance &&
    Math.abs(Number.parseFloat(im) - Number.parseFloat(initial.im)) <=
      tolerance &&
    Math.abs(zoom - initial.zoom) <= tolerance
  );
}

export const RESET_SPECS: ResetSpec[] = [
  {
    buttonId: "resetRender",
    configKeys: ["maxIterations", "power", "supersampling", "showTierOverlay"],
    specialHandling: (map) => {
      resetPaletteCeilingToMaxIterations(map, map.config.maxIterations);
    },
    apply: (map, changedKeys) => {
      // The tier overlay is cosmetic, so a reset that only toggles it off
      // repaints in place; anything else re-renders.
      const needsRerender = changedKeys.some(
        (key) => key !== "showTierOverlay",
      );
      if (needsRerender) {
        map.refresh();
      } else {
        map.applyTierOverlayToggle();
      }
    },
  },
  {
    buttonId: "resetColorPalette",
    configKeys: ["palette", "colorDensity", "paletteOffset", "reverseColors"],
    // All color-only settings: repaint in place, no re-render.
    apply: (map) => map.applyColorSettings(),
  },
  {
    buttonId: "resetColorMapping",
    configKeys: [
      "coloringMethod",
      "smoothColoring",
      "paletteMinIter",
      "paletteAutoFit",
      "histogramColoring",
    ],
    specialHandling: (map) => {
      // Reset paletteMaxIter based on the current iteration cap
      map.config.paletteMaxIter = map.config.maxIterations;
    },
    apply: (map, changedKeys) => {
      // The coloring method and smooth coloring are baked into the cached
      // escape values, so resetting either needs a full re-render (which
      // re-fits the range once the tiles load).
      if (
        changedKeys.includes("coloringMethod") ||
        changedKeys.includes("smoothColoring")
      ) {
        map.refresh();
        return;
      }
      // The remaining keys only affect coloring: fit (auto) or apply the
      // reset values (manual) via an in-place repaint. The fit also rebuilds
      // the equalization CDF, so a restored mapping strength takes effect.
      map.refitPaletteAndRecolor();
    },
    checkDiff: (map) => {
      const { signals } = map.store;
      const initial = map.initialConfig;
      if (
        signals.coloringMethod.value !== initial.coloringMethod ||
        signals.smoothColoring.value !== initial.smoothColoring ||
        signals.paletteAutoFit.value !== initial.paletteAutoFit ||
        signals.histogramColoring.value !== initial.histogramColoring
      ) {
        return true;
      }
      if (signals.paletteAutoFit.value) {
        // Auto-applied values are machine-set, not user divergence.
        return false;
      }
      return (
        signals.paletteMinIter.value !== initial.paletteMinIter ||
        signals.paletteMaxIter.value !== signals.maxIterations.value
      );
    },
  },
  {
    buttonId: "resetAdjustColors",
    configKeys: [
      "colorSpace",
      "shiftHueAmount",
      "saturateAmount",
      "lightenAmount",
    ],
    // All color-only settings: repaint in place, no re-render.
    apply: (map) => map.applyColorSettings(),
  },
  {
    buttonId: "resetLocation",
    configKeys: ["re", "im", "zoom"],
    apply: (map) => {
      map.refresh(true);
      map.publishViewState();
    },
    checkDiff: (map) => !isAtInitialView(map),
  },
];

/** Whether a panel's reset button should show: its settings have diverged
 * from the initial config. Reads the config signals reactively for use in
 * computeds. */
export function isResetVisible(map: MandelbrotMap, reset: ResetSpec): boolean {
  if (reset.checkDiff) {
    return reset.checkDiff(map);
  }
  return reset.configKeys.some(
    (key) => map.store.signals[key].value !== map.initialConfig[key],
  );
}

/** Applies a panel's reset: restores its keys to the initial config, runs
 * its special handling, and applies the visual effect. */
export function resetPanel(map: MandelbrotMap, reset: ResetSpec) {
  const changedKeys = reset.configKeys.filter(
    (key) => map.config[key] !== map.initialConfig[key],
  );

  batch(() => {
    for (const key of reset.configKeys) {
      // TypeScript cannot infer that the initial value matches the type of
      // config[key] in this dynamic assignment pattern
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (map.config as any)[key] = map.initialConfig[key];
    }
    reset.specialHandling?.(map);
  });

  if (reset.apply) {
    reset.apply(map, changedKeys);
  } else {
    map.refresh();
  }
}
