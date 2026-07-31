import type { JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useSignal, useSignalEffect } from "@preact/signals";
import { useApp } from "../AppContext";
import NavigatorEngine, {
  NAVIGATOR_CANVAS_LABELS,
  NAVIGATOR_HINTS,
} from "../NavigatorEngine";
import { Panel } from "./Panel";

// The details id keeps its historical juliaSet name: the open/closed
// persistence is keyed by it. The elements inside use navigator* ids
// matching the panel's title.
export function NavigatorPanel(): JSX.Element {
  const { map, ui } = useApp();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<NavigatorEngine | null>(null);
  // The Julia parameter readout ("c = …"); reported by the engine, cleared
  // in minimap mode.
  const coordinates = useSignal("");
  const mode = ui.navigatorMode.value;

  useEffect(() => {
    const engine = new NavigatorEngine(map, {
      canvas: canvasRef.current!,
      getMode: () => ui.navigatorMode.peek(),
      isPanelOpen: () => ui.detailsOpen.peek()["juliaSet"] !== false,
      onCoordinates: (text) => {
        coordinates.value = text;
      },
    });
    engineRef.current = engine;
    // The map's recolor/re-render appliers notify the panel through this
    // registration, exactly as they notified the old NavigatorPanel class.
    map.navigatorPanel = engine;
    return () => {
      if (map.navigatorPanel === engine) {
        map.navigatorPanel = null;
      }
      engine.destroy();
      engineRef.current = null;
    };
  }, [map]);

  // A mode switch invalidates the shared canvas and clears the readout.
  useSignalEffect(() => {
    void ui.navigatorMode.value;
    engineRef.current?.handleModeChanged();
  });

  // Rendering only when the panel is open avoids pool traffic for a
  // collapsed panel; opening it renders immediately.
  useSignalEffect(() => {
    if (ui.detailsOpen.value["juliaSet"]) {
      engineRef.current?.renderCurrentMode();
    }
  });

  return (
    <Panel id="juliaSet" class="mobile-hidden" summary={<span>Navigator</span>}>
      <div class="input-wrapper">
        <select
          id="navigatorViewMode"
          name="navigatorViewMode"
          aria-label="Navigator view"
          class="full-width"
          value={mode}
          onChange={(event) => {
            ui.navigatorMode.value =
              event.currentTarget.value === "julia" ? "julia" : "minimap";
          }}
        >
          <option value="minimap">Minimap</option>
          <option value="julia">Julia set</option>
        </select>
      </div>
      <p class="secondary" id="navigatorHint">
        {NAVIGATOR_HINTS[mode]}
      </p>
      <div id="navigatorThumbnail">
        <canvas
          id="navigatorCanvas"
          ref={canvasRef}
          aria-label={NAVIGATOR_CANVAS_LABELS[mode]}
        ></canvas>
      </div>
      <p class="secondary" id="navigatorCoordinates">
        {coordinates}
      </p>
    </Panel>
  );
}
