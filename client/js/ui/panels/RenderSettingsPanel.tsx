import type { JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import {
  CheckboxSpec,
  NumberSpec,
  SelectSpec,
  supersamplingFactorForSetting,
} from "../../config";
import {
  adjustIterations,
  commitSelectSetting,
  resetSpec,
  settingSpec,
} from "../../state/settingsController";
import { tierLegendEntries } from "../../tierOverlay";
import { useApp } from "../AppContext";
import { SettingCheckbox, SettingNumberInput } from "../inputs";
import { Panel, ResetButton } from "./Panel";

// Ceiling on the supersampling rungs offered in the sidebar, as a multiple
// of the tile's layout size (the engine's own cap is higher; this is a cost
// choice, keeping the deepest offered rung at 800px tiles).
const MAX_SUPERSAMPLING_OPTION_FACTOR = 4;

// The full set of supersampling rungs, in the order the HTML always listed
// them; visibility and labels are derived per devicePixelRatio below.
const SUPERSAMPLING_VALUES = ["layout", "native", "2", "4"];

/** Presents the supersampling options as resolved multiples of the tile's
 * layout size, tagging the one that matches the display pixel-for-pixel as
 * native. The option values keep their native-multiple semantics (so
 * downscales stay a whole number of samples per device pixel); only the
 * labels and visibility are derived here: rungs costlier than
 * MAX_SUPERSAMPLING_OPTION_FACTOR or duplicating a cheaper rung are withheld
 * (except native, and whichever rung is selected). */
function supersamplingOptions(
  selected: string,
): { value: string; label: string }[] {
  const nativeFactor = supersamplingFactorForSetting("native");
  const shown: { value: string; factor: number }[] = [];
  for (const value of SUPERSAMPLING_VALUES) {
    const factor = supersamplingFactorForSetting(value);
    const isDuplicate = shown.some((entry) => entry.factor === factor);
    const withinCap =
      value === "native" || factor <= MAX_SUPERSAMPLING_OPTION_FACTOR;
    if (value === selected || (withinCap && !isDuplicate)) {
      shown.push({ value, factor });
    }
  }
  const hasNativeRow = shown.some((entry) => entry.value === "native");
  return shown.map(({ value, factor }) => {
    const isNative =
      value === "native" || (!hasNativeRow && factor === nativeFactor);
    const multiplier = Math.round(factor * 10) / 10;
    return { value, label: `${multiplier}×${isNative ? " (native)" : ""}` };
  });
}

/** The supersampling select, re-derived whenever the devicePixelRatio
 * changes (browser zoom, monitor moves). */
function SupersamplingSelect(): JSX.Element {
  const { map } = useApp();
  const spec = settingSpec<SelectSpec>("supersampling");
  const [, setDprVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const watchDprChange = () => {
      const query = window.matchMedia(
        `(resolution: ${window.devicePixelRatio || 1}dppx)`,
      );
      query.addEventListener(
        "change",
        () => {
          if (cancelled) {
            return;
          }
          setDprVersion((version) => version + 1);
          watchDprChange();
        },
        { once: true },
      );
    };
    watchDprChange();
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = String(map.store.signals.supersampling.value);

  return (
    <select
      id="supersampling"
      name="supersampling"
      required
      value={selected}
      onChange={(event) =>
        commitSelectSetting(map, spec, event.currentTarget.value)
      }
    >
      {supersamplingOptions(selected).map(({ value, label }) => (
        <option key={value} value={value}>
          {label}
        </option>
      ))}
    </select>
  );
}

/** The precision-tier legend, shown only while the tier overlay is enabled,
 * so the tinted borders/badges on the tiles have a key. */
function TierLegend(): JSX.Element {
  const { map } = useApp();
  const visible = Boolean(map.store.signals.showTierOverlay.value);

  return (
    <ul id="tierLegend" class="tier-legend" hidden={!visible}>
      {tierLegendEntries().map(({ label, color }) => (
        <li key={label}>
          <span class="tier-legend-swatch" style={{ backgroundColor: color }} />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

export function RenderSettingsPanel(): JSX.Element {
  const { map } = useApp();
  const maxIterationsSpec = settingSpec<NumberSpec>("maxIterations");
  const powerSpec = settingSpec<NumberSpec>("power");
  // The precision-tier overlay is a rendering diagnostic; only expose its
  // control in dev builds. The config default is off and the setting has no
  // share-URL parameter, so omitting the checkbox removes the feature.
  const showTierOverlayControl = process.env.NODE_ENV !== "production";

  return (
    <Panel
      id="renderSettings"
      summaryClass="mobile-hidden"
      summary={
        <>
          <span>Render settings</span>
          <ResetButton
            spec={resetSpec("resetRender")}
            title="Reset render settings"
          />
        </>
      }
    >
      <div class="input-wrapper align-start">
        <label for="maxIterations" class="label-with-subtitle">
          <span>Max iterations</span>
          <span class="secondary">Detail level</span>
        </label>
        <SettingNumberInput spec={maxIterationsSpec} />
      </div>
      <div class="iteration-buttons">
        <button
          type="button"
          id="maxIterationsMul2"
          class="underline-button"
          onClick={() => adjustIterations(map, 2)}
        >
          ×2
        </button>
        <button
          type="button"
          id="maxIterationsDiv2"
          class="underline-button"
          onClick={() => adjustIterations(map, 0.5)}
        >
          ÷2
        </button>
      </div>
      <div class="input-wrapper mobile-hidden">
        <label for="power" class="label-with-subtitle">
          <span>Power</span>
          <span class="secondary">Multibrot order</span>
        </label>
        <SettingNumberInput spec={powerSpec} />
      </div>
      <div class="input-wrapper mobile-hidden">
        <label
          for="supersampling"
          title="Tile render resolution, as a multiple of the tile's on-screen size. 1× renders at exactly that size; the option marked native matches the display pixel-for-pixel; higher options render beyond native resolution and downscale, anti-aliasing the image at a cost that grows with the square of the factor."
        >
          Supersampling
        </label>
        <SupersamplingSelect />
      </div>
      {showTierOverlayControl && (
        <div class="checkbox-wrapper mobile-hidden">
          <SettingCheckbox
            spec={settingSpec<CheckboxSpec>("showTierOverlay")}
          />
          <label
            for="showTierOverlay"
            title="Tint each tile by the numeric precision path (direct f64, perturbation, or hybrid float-exp) the renderer picked for it."
          >
            Precision overlay <span class="secondary">(Diagnostic)</span>
          </label>
        </div>
      )}
      <TierLegend />
    </Panel>
  );
}
