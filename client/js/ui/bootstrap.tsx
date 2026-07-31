import { render } from "preact";
import MandelbrotMap from "../MandelbrotMap";
import { defaultConfig, parseShareParams } from "../config";
import { createConfigStore } from "../state/configStore";
import { createUiState } from "../state/uiState";
import { App } from "./App";

const MAP_HTML_ID = "leaflet";
const SMALL_SCREEN_WIDTH_PX = 800;

/** Boots the fractal app: settings store (seeded from any share URL), map
 * engine, then the Preact UI. No-op on pages without the map container
 * (blog, privacy policy — the same app.js runs there). */
export async function bootstrapApp(): Promise<void> {
  const appRoot = document.getElementById("appRoot");
  if (!document.getElementById(MAP_HTML_ID) || !appRoot) {
    return;
  }

  const initialZoom = window.innerWidth <= SMALL_SCREEN_WIDTH_PX ? 2 : 3;
  const initialConfig = { ...defaultConfig, zoom: initialZoom };

  // Apply any share-URL parameters to the settings store, then strip them
  // from the address bar. This happens before the map is constructed — and
  // so before its worker pool spawns or any tile is requested — because the
  // spawn warmups are chosen by the view's depth and power, and the first
  // (and only) tile batch should be the target view.
  const overrides = parseShareParams(window.location.search);
  if (Object.keys(overrides).length > 0) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const store = createConfigStore(initialConfig, overrides);
  const ui = createUiState();
  const map = new MandelbrotMap({ htmlId: MAP_HTML_ID, store });

  // Mount the UI once the engine is fully initialized (pool spawned, layers
  // added, initial view set): every component can then assume a working map.
  await map.ready;
  render(<App map={map} store={store} ui={ui} />, appRoot);
}
