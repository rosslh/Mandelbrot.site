import type { JSX } from "preact";
import { SelectNumberSpec, SliderSpec } from "../../config";
import { resetSpec, settingSpec } from "../../state/settingsController";
import { SettingSelect, SettingSliderInput } from "../inputs";
import { Panel, ResetButton } from "./Panel";

export function AdjustColorsPanel(): JSX.Element {
  return (
    <Panel
      id="adjustColors"
      class="mobile-hidden"
      summary={
        <>
          <span>Adjust colors</span>
          <ResetButton
            spec={resetSpec("resetAdjustColors")}
            title="Reset color adjustments"
          />
        </>
      }
    >
      <datalist id="defaultSliderPosition">
        <option value="0"></option>
      </datalist>
      <div class="input-wrapper">
        <label for="shiftHueAmount">Hue</label>
        <SettingSliderInput
          spec={settingSpec<SliderSpec>("shiftHueAmount")}
          min="-180"
          max="180"
          list="defaultSliderPosition"
        />
      </div>
      <div class="input-wrapper">
        <label for="saturateAmount">Saturation</label>
        <SettingSliderInput
          spec={settingSpec<SliderSpec>("saturateAmount")}
          min="-1"
          max="1"
          step="0.01"
          list="defaultSliderPosition"
        />
      </div>
      <div class="input-wrapper">
        <label for="lightenAmount">Lightness</label>
        <SettingSliderInput
          spec={settingSpec<SliderSpec>("lightenAmount")}
          min="-1"
          max="1"
          step="0.01"
          list="defaultSliderPosition"
        />
      </div>
      <div class="input-wrapper">
        <label for="colorSpace">Color space</label>
        <SettingSelect
          spec={settingSpec<SelectNumberSpec>("colorSpace")}
          required
        >
          <option value="0">HSL</option>
          <option value="1">HSLuv</option>
          <option value="2">LCh</option>
          <option value="3">Okhsl</option>
        </SettingSelect>
      </div>
    </Panel>
  );
}
