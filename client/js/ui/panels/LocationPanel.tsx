import type { JSX } from "preact";
import { CoordinateSpec, MagnificationSpec } from "../../config";
import { resetSpec, settingSpec } from "../../state/settingsController";
import { describeZoomScale } from "../../zoomScale";
import { useApp } from "../AppContext";
import { CoordinateInput, MagnificationInput } from "../inputs";
import { Panel, ResetButton } from "./Panel";

// The details id keeps its historical coordinates name: the open/closed
// persistence is keyed by it, and the input ids (re, im, zoom) match the
// config schema keys.
export function LocationPanel(): JSX.Element {
  const { map } = useApp();
  const description = describeZoomScale(map.store.signals.zoom.value);

  return (
    <Panel
      id="coordinates"
      class="mobile-hidden"
      summary={
        <>
          <span>Location</span>
          <ResetButton
            spec={resetSpec("resetLocation")}
            title="Reset location"
          />
        </>
      }
    >
      <div class="input-wrapper">
        <label for="re">Center (Re)</label>
        <CoordinateInput spec={settingSpec<CoordinateSpec>("re")} />
      </div>
      <div class="input-wrapper">
        <label for="im">Center (Im)</label>
        <CoordinateInput spec={settingSpec<CoordinateSpec>("im")} />
      </div>
      <div class="input-wrapper">
        <label for="zoom">Magnification</label>
        <MagnificationInput spec={settingSpec<MagnificationSpec>("zoom")} />
      </div>
      <p class="secondary" id="zoomScaleCaption" hidden={description === null}>
        {description ?? ""}
      </p>
    </Panel>
  );
}
