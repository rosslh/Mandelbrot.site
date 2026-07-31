import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignalEffect } from "@preact/signals";
import { CheckboxSpec, SelectSpec, SliderSpec } from "../../config";
import { resetSpec, settingSpec } from "../../state/settingsController";
import { useApp } from "../AppContext";
import PaletteHistogramRenderer from "../PaletteHistogramRenderer";
import { SettingCheckbox, SettingSelect, SettingSliderInput } from "../inputs";
import { Panel, ResetButton } from "./Panel";

/** The palette-range histogram (issue #49). The markup lives here; the
 * canvas painting, throttled pixel scans, and pointer-capture marker
 * dragging stay imperative in PaletteHistogramRenderer, wired up through
 * refs. */
function PaletteHistogramPanel(): JSX.Element {
  const { map, ui } = useApp();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasWrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spinnerRef = useRef<HTMLDivElement>(null);
  const statsListRef = useRef<HTMLDListElement>(null);
  const minStatRef = useRef<HTMLElement>(null);
  const maxStatRef = useRef<HTMLElement>(null);
  const medianStatRef = useRef<HTMLElement>(null);
  const interiorStatRef = useRef<HTMLElement>(null);
  const rendererRef = useRef<PaletteHistogramRenderer | null>(null);

  useEffect(() => {
    const renderer = new PaletteHistogramRenderer(map, {
      container: containerRef.current!,
      canvas: canvasRef.current!,
      canvasWrap: canvasWrapRef.current!,
      spinner: spinnerRef.current!,
      statsList: statsListRef.current!,
      minStat: minStatRef.current!,
      maxStat: maxStatRef.current!,
      medianStat: medianStatRef.current!,
      interiorStat: interiorStatRef.current!,
    });
    rendererRef.current = renderer;
    map.paletteHistogram = renderer;
    return () => {
      if (map.paletteHistogram === renderer) {
        map.paletteHistogram = null;
      }
      renderer.destroy();
      rendererRef.current = null;
    };
  }, [map]);

  // Repaint when anything the histogram displays changes: its bound markers
  // track the palette window, an iteration-cap change resets the palette
  // ceiling, and a coloring-method change blanks the panel entirely. The
  // renderer's own fingerprints keep redundant repaints cheap.
  useSignalEffect(() => {
    const { signals } = map.store;
    void signals.paletteMinIter.value;
    void signals.paletteMaxIter.value;
    void signals.paletteAutoFit.value;
    void signals.coloringMethod.value;
    void signals.maxIterations.value;
    rendererRef.current?.update();
  });

  // The panel expanding is a chance to catch up on a size that was 0 while
  // collapsed.
  useSignalEffect(() => {
    if (ui.detailsOpen.value["paletteRange"]) {
      rendererRef.current?.update();
    }
  });

  return (
    <div id="paletteHistogram" ref={containerRef}>
      <div id="paletteHistogramCanvasWrap" ref={canvasWrapRef}>
        <canvas
          id="paletteHistogramCanvas"
          ref={canvasRef}
          title="Distribution of escape times in view, with each bar inside the palette range tinted by the color it maps to. Drag the red markers to set the palette range."
          aria-label="Histogram of escape times in the current view, with bars tinted by their mapped palette color"
        ></canvas>
        <div
          id="paletteHistogramSpinner"
          class="histogram-spinner"
          ref={spinnerRef}
          hidden
        ></div>
      </div>
      <dl id="paletteHistogramStats" ref={statsListRef}>
        <div>
          <dt>Min</dt>
          <dd id="paletteStatMin" ref={minStatRef}>
            –
          </dd>
        </div>
        <div>
          <dt>Max</dt>
          <dd id="paletteStatMax" ref={maxStatRef}>
            –
          </dd>
        </div>
        <div>
          <dt>Median</dt>
          <dd id="paletteStatMedian" ref={medianStatRef}>
            –
          </dd>
        </div>
        <div>
          <dt title="Fraction of visible pixels inside the set">Interior</dt>
          <dd id="paletteStatInterior" ref={interiorStatRef}>
            –
          </dd>
        </div>
      </dl>
    </div>
  );
}

// The details id keeps its historical paletteRange name: the open/closed
// persistence is keyed by it, and the section's range controls still live
// here.
export function ColorMappingPanel(): JSX.Element {
  const { map } = useApp();
  // The palette range only applies to escape-time coloring; the fixed-range
  // methods (distance estimate, atom domains) ignore it, so hide the panel's
  // color-mapping slider and auto-fit checkbox while one is active (the
  // histogram itself blanks out; see PaletteHistogramRenderer). The
  // coloring-method select stays enabled so the user can switch back.
  const mappingHidden = map.store.signals.coloringMethod.value !== "standard";

  return (
    <Panel
      id="paletteRange"
      class="mobile-hidden"
      summary={
        <>
          <span>Color mapping</span>
          <ResetButton
            spec={resetSpec("resetColorMapping")}
            title="Reset color mapping"
          />
        </>
      }
    >
      <div class="input-wrapper">
        <label
          for="coloringMethod"
          title="How pixels are colored. Standard: escape time. Distance estimate: distance to the set boundary, for a crisp image. Atom domains: the period of the pixel's atom domain on a categorical palette. The non-standard modes are available at shallow zoom (direct f64) only."
        >
          Coloring method
        </label>
        <SettingSelect
          spec={settingSpec<SelectSpec>("coloringMethod")}
          required
        >
          <option value="standard">Standard</option>
          <option value="distanceEstimate">Distance estimate</option>
          <option value="atomDomain">Atom domains</option>
        </SettingSelect>
      </div>
      <div class="checkbox-wrapper">
        <SettingCheckbox spec={settingSpec<CheckboxSpec>("smoothColoring")} />
        <label for="smoothColoring">Smooth coloring</label>
      </div>
      <div class="input-wrapper" hidden={mappingHidden}>
        <label
          for="histogramColoring"
          title="How strongly colors are equalized to the view: at zero, colors spread evenly across the iteration range (the classic linear mapping); at full, each color covers a similar share of the visible pixels — histogram coloring, like Equalize in image editors. In-between positions blend the two."
        >
          Histogram coloring
        </label>
        <SettingSliderInput
          spec={settingSpec<SliderSpec>("histogramColoring")}
          min="0"
          max="100"
          step="1"
          class="full-width"
        />
      </div>
      <div class="checkbox-wrapper" hidden={mappingHidden}>
        <SettingCheckbox spec={settingSpec<CheckboxSpec>("paletteAutoFit")} />
        <label
          for="paletteAutoFit"
          title="Fit the palette range to the escape times visible in the current view as you pan and zoom. Dragging the histogram markers sets the range by hand and turns this off."
        >
          Auto-fit range
        </label>
      </div>
      <PaletteHistogramPanel />
    </Panel>
  );
}
