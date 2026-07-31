import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type MandelbrotMap from "../MandelbrotMap";
import type { ConfigStore } from "../state/configStore";
import type { UiState } from "../state/uiState";

export type AppContextValue = {
  map: MandelbrotMap;
  store: ConfigStore;
  ui: UiState;
};

export const AppContext = createContext<AppContextValue | null>(null);

/** The app singletons (map engine, settings store, UI state). Components
 * mount only under <App/>, which provides them. */
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error("useApp called outside the AppContext provider");
  }
  return value;
}
