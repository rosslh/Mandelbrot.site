import type { JSX } from "preact";
import { AppContext, AppContextValue } from "./AppContext";
import { ButtonBar } from "./ButtonBar";
import { AdjustColorsPanel } from "./panels/AdjustColorsPanel";
import { ColorMappingPanel } from "./panels/ColorMappingPanel";
import { ColorPalettePanel } from "./panels/ColorPalettePanel";
import { LocationPanel } from "./panels/LocationPanel";
import { NavigatorPanel } from "./panels/NavigatorPanel";
import { PinnedLocationsPanel } from "./panels/PinnedLocationsPanel";
import { RenderSettingsPanel } from "./panels/RenderSettingsPanel";
import { ShortcutsPanel } from "./panels/ShortcutsPanel";
import { AnimateModal, ChangePowerModal, SaveImageModal } from "./modals";

function Sidebar(): JSX.Element {
  return (
    <div id="inputsWrapper" class="overlay">
      <ShortcutsPanel />
      <RenderSettingsPanel />
      <ColorPalettePanel />
      <ColorMappingPanel />
      <AdjustColorsPanel />
      <NavigatorPanel />
      <PinnedLocationsPanel />
      <LocationPanel />
      <ButtonBar />
    </div>
  );
}

/** The app's UI shell: the sidebar and the modals. The Leaflet map engine
 * lives outside this tree (in #leaflet) and is provided through context; the
 * static nav and attribution stay plain HTML. */
export function App(context: AppContextValue): JSX.Element {
  return (
    <AppContext.Provider value={context}>
      <Sidebar />
      <SaveImageModal />
      <AnimateModal />
      <ChangePowerModal />
    </AppContext.Provider>
  );
}
