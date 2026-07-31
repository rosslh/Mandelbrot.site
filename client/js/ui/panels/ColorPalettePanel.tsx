import type { JSX } from "preact";
import { CheckboxSpec, NumberSpec, SelectSpec, SliderSpec } from "../../config";
import { resetSpec, settingSpec } from "../../state/settingsController";
import {
  SettingCheckbox,
  SettingNumberInput,
  SettingSelect,
  SettingSliderInput,
} from "../inputs";
import { Panel, ResetButton } from "./Panel";

export function ColorPalettePanel(): JSX.Element {
  return (
    <Panel
      id="colorPalette"
      class="mobile-hidden"
      summary={
        <>
          <label for="palette">Color palette</label>
          <ResetButton
            spec={resetSpec("resetColorPalette")}
            title="Reset color palette"
          />
        </>
      }
    >
      <div class="input-wrapper">
        <SettingSelect
          spec={settingSpec<SelectSpec>("palette")}
          required
          class="full-width"
        >
          <optgroup label="Sequential (Multi-Hue)">
            <option value="cividis">Cividis</option>
            <option value="cool">Cool</option>
            <option value="cubehelix">Cubehelix</option>
            <option value="gnuplot">Gnuplot</option>
            <option value="inferno">Inferno</option>
            <option value="jet">Jet</option>
            <option value="magma">Magma</option>
            <option value="nipySpectral">Nipy Spectral</option>
            <option value="plasma">Plasma</option>
            <option value="turbo">Turbo</option>
            <option value="viridis">Viridis</option>
            <option value="warm">Warm</option>
            <option value="yellowGreenBlue">Blue Green Yellow</option>
            <option value="greenBlue">Blue Green</option>
            <option value="purpleBlueGreen">Green Blue Purple</option>
            <option value="yellowGreen">Green Yellow</option>
            <option value="redPurple">Purple Red</option>
            <option value="yellowOrangeRed">Red Orange Yellow</option>
            <option value="orangeRed">Red Orange</option>
            <option value="purpleRed">Red Purple</option>
          </optgroup>
          <optgroup label="Sequential (Single-Hue)">
            <option value="blues">Blues</option>
            <option value="greens">Greens</option>
            <option value="greys">Greys</option>
            <option value="oranges">Oranges</option>
            <option value="purples">Purples</option>
            <option value="reds">Reds</option>
          </optgroup>
          <optgroup label="Diverging">
            <option value="spectral">Spectral</option>
            <option value="brownGreen">Brown Green</option>
            <option value="pinkGreen">Green Pink</option>
            <option value="purpleGreen">Purple Green</option>
            <option value="purpleOrange">Purple Orange</option>
            <option value="redBlue">Red Blue</option>
            <option value="redGrey">Red Grey</option>
            <option value="redYellowBlue">Red Yellow Blue</option>
            <option value="redYellowGreen">Red Yellow Green</option>
          </optgroup>
          <optgroup label="Cyclical">
            <option value="rainbow">Rainbow</option>
            <option value="sinebow">Sinebow</option>
          </optgroup>
        </SettingSelect>
      </div>
      <div class="input-wrapper">
        <label
          for="colorDensity"
          title="How many times the palette repeats across the palette range. Non-cyclical palettes alternate direction on each repeat so the colors stay seamless."
        >
          Color density
        </label>
        <SettingNumberInput
          spec={settingSpec<NumberSpec>("colorDensity")}
          min="1"
          max="100"
          step="1"
        />
      </div>
      <div class="input-wrapper">
        <label
          for="paletteOffset"
          title="Slides the palette along the range, choosing which color the range starts on. With a color density of two or more (or a cyclical palette) the pattern glides seamlessly; a single pass wraps instead, showing a seam where the palette's ends meet. Every color stays in use either way."
        >
          Palette offset
        </label>
        <SettingSliderInput
          spec={settingSpec<SliderSpec>("paletteOffset")}
          min="0"
          max="100"
          step="1"
          class="full-width"
        />
      </div>
      <div class="checkbox-wrapper">
        <SettingCheckbox spec={settingSpec<CheckboxSpec>("reverseColors")} />
        <label for="reverseColors">Reverse colors</label>
      </div>
    </Panel>
  );
}
