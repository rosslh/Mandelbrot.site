// Non-config UI state: panel open/closed persistence, pinned locations, the
// navigator's view mode, the save-image optimize preference, and ephemeral
// flags (fullscreen, the pending power-change confirmation). Persisted
// signals keep the exact localStorage keys and JSON shapes of the classes
// they replace, so state saved before the Preact migration survives it.

import { effect, Signal, signal } from "@preact/signals";
import throttle from "lodash/throttle";
import type { NumberSpec } from "../config";

const DETAILS_STATE_STORAGE_KEY = "mandelbrot-details-state";
const PINNED_LOCATIONS_STORAGE_KEY = "mandelbrot-pinned-locations";
const NAVIGATOR_MODE_STORAGE_KEY = "mandelbrot-julia-panel-mode";
const OPTIMIZE_IMAGE_STORAGE_KEY = "mandelbrot-optimize-image";
const SMALL_SCREEN_WIDTH_PX = 800;

// The sidebar's <details> panels and whether each starts open, matching the
// `open` attributes the panels historically carried in index.html. Panel ids
// keep their historical names (paletteRange, juliaSet, coordinates) because
// the persisted open/closed state is keyed by them.
export const PANEL_DEFAULT_OPEN: Record<string, boolean> = {
  shortcuts: true,
  renderSettings: true,
  colorPalette: false,
  paletteRange: false,
  adjustColors: false,
  juliaSet: false,
  pinnedLocations: false,
  coordinates: false,
};

export type PinnedLocation = {
  // The full share URL for the saved view.
  url: string;
  // Creation timestamp (epoch milliseconds), shown as a human-readable date.
  createdAt: number;
  // Optional user-given name; rows without one are labeled by their date.
  name?: string;
};

export type NavigatorMode = "minimap" | "julia";

// A power (or other view-resetting) change awaiting the user's confirmation:
// the parsed value to apply if they confirm.
export type ChangePowerRequest = {
  spec: NumberSpec;
  value: number;
};

export type UiState = {
  // Open/closed state of every sidebar panel, persisted.
  detailsOpen: Signal<Record<string, boolean>>;
  pinnedLocations: Signal<PinnedLocation[]>;
  navigatorMode: Signal<NavigatorMode>;
  optimizeImage: Signal<boolean>;
  isFullscreen: Signal<boolean>;
  changePowerRequest: Signal<ChangePowerRequest | null>;
  saveImageModalOpen: Signal<boolean>;
  animateModalOpen: Signal<boolean>;
  setPanelOpen(id: string, open: boolean): void;
  /** Saves a share URL to the top of the pinned list (unless already
   * pinned). */
  pinLocation(url: string): void;
  removePinnedLocation(url: string): void;
  /** Sets (or, given a blank name, clears) a location's user-given name. A
   * cleared name falls back to the date label. */
  renamePinnedLocation(url: string, rawName: string): void;
};

function loadDetailsState(): Record<string, boolean> {
  const state = { ...PANEL_DEFAULT_OPEN };
  if (!window.localStorage) {
    return state;
  }

  try {
    const saved = localStorage.getItem(DETAILS_STATE_STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Record<string, boolean>;
      for (const id of Object.keys(state)) {
        if (typeof parsed[id] === "boolean") {
          state[id] = parsed[id];
        }
      }
    }
  } catch (e) {
    console.error("Error loading details state from localStorage", e);
  }

  return state;
}

function loadPinnedLocations(): PinnedLocation[] {
  if (!window.localStorage) {
    return [];
  }

  try {
    const raw = localStorage.getItem(PINNED_LOCATIONS_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is PinnedLocation =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PinnedLocation).url === "string" &&
        typeof (entry as PinnedLocation).createdAt === "number" &&
        ["undefined", "string"].includes(typeof (entry as PinnedLocation).name),
    );
  } catch (e) {
    console.error("Error loading pinned locations from localStorage", e);
    return [];
  }
}

function persist(key: string, value: string) {
  if (!window.localStorage) {
    return;
  }
  localStorage.setItem(key, value);
}

export function createUiState(): UiState {
  const detailsOpen = signal(loadDetailsState());
  const pinnedLocations = signal(loadPinnedLocations());
  const navigatorMode = signal<NavigatorMode>(
    // The minimap is the panel's default view; only an explicitly stored
    // Julia preference overrides it.
    localStorage.getItem(NAVIGATOR_MODE_STORAGE_KEY) === "julia"
      ? "julia"
      : "minimap",
  );
  const optimizeImage = signal(
    localStorage.getItem(OPTIMIZE_IMAGE_STORAGE_KEY) === "true",
  );
  const isFullscreen = signal(Boolean(document.fullscreenElement));
  const changePowerRequest = signal<ChangePowerRequest | null>(null);
  const saveImageModalOpen = signal(false);
  const animateModalOpen = signal(false);

  effect(() =>
    persist(DETAILS_STATE_STORAGE_KEY, JSON.stringify(detailsOpen.value)),
  );
  effect(() =>
    persist(
      PINNED_LOCATIONS_STORAGE_KEY,
      JSON.stringify(pinnedLocations.value),
    ),
  );
  effect(() => persist(NAVIGATOR_MODE_STORAGE_KEY, navigatorMode.value));
  effect(() =>
    persist(OPTIMIZE_IMAGE_STORAGE_KEY, JSON.stringify(optimizeImage.value)),
  );

  document.addEventListener("fullscreenchange", () => {
    isFullscreen.value = Boolean(document.fullscreenElement);
  });

  const setPanelOpen = (id: string, open: boolean) => {
    if (detailsOpen.value[id] === open) {
      return;
    }
    detailsOpen.value = { ...detailsOpen.value, [id]: open };
  };

  // Sidebar space is tight on small screens, so the render settings panel —
  // the one with the controls that matter most — is forced open there, on
  // load and whenever a resize crosses the breakpoint.
  const forceRenderSettingsOpenOnSmallScreens = () => {
    if (window.innerWidth <= SMALL_SCREEN_WIDTH_PX) {
      setPanelOpen("renderSettings", true);
    }
  };
  forceRenderSettingsOpenOnSmallScreens();
  window.addEventListener(
    "resize",
    throttle(forceRenderSettingsOpenOnSmallScreens, 250),
  );

  return {
    detailsOpen,
    pinnedLocations,
    navigatorMode,
    optimizeImage,
    isFullscreen,
    changePowerRequest,
    saveImageModalOpen,
    animateModalOpen,
    setPanelOpen,
    pinLocation: (url) => {
      if (pinnedLocations.value.some((location) => location.url === url)) {
        return;
      }
      pinnedLocations.value = [
        { url, createdAt: Date.now() },
        ...pinnedLocations.value,
      ];
    },
    removePinnedLocation: (url) => {
      pinnedLocations.value = pinnedLocations.value.filter(
        (location) => location.url !== url,
      );
    },
    renamePinnedLocation: (url, rawName) => {
      const name = rawName.trim();
      pinnedLocations.value = pinnedLocations.value.map((location) => {
        if (location.url !== url) {
          return location;
        }
        const renamed: PinnedLocation = {
          url: location.url,
          createdAt: location.createdAt,
        };
        if (name) {
          renamed.name = name;
        }
        return renamed;
      });
    },
  };
}
