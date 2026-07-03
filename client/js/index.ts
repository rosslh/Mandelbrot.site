import "./static";
import MandelbrotMap from "./MandelbrotMap";
import { initRegionalAttribution } from "./regionalAttribution";

const mapHtmlId = "leaflet";
const smallScreenWidthPx = 800;
const swReloadFlagKey = "mandelbrot-sw-reloaded";
const swReloadWindowMs = 10000;
const cacheRecoveryFlagKey = "mandelbrot-cache-recovered";

// A cached app bundle paired with a mismatched (network-served) worker/WASM
// chunk fails in recognizable ways: a code-split chunk won't load, or the
// worker/WASM can't initialize. Precaching everything together should prevent
// this, but a user already carrying a poisoned cache from a previous deploy
// can't recover on their own -- the broken assets are served on every reload.
// These signatures let us detect that case and self-heal.
function looksLikeStaleCacheFailure(reason: unknown): boolean {
  const message =
    reason instanceof Error
      ? `${reason.name} ${reason.message}`
      : String(reason ?? "");

  return (
    /ChunkLoadError|Loading chunk \S+ failed|Importing a module script failed/i.test(
      message,
    ) ||
    /Worker initialization failed|Unknown worker request type/i.test(message) ||
    /WebAssembly|wasm|magic word|importScripts/i.test(message)
  );
}

// Purge the service worker and every cache, then reload once for a clean,
// self-consistent set of assets straight from the network -- the equivalent of
// what a fresh private window gets. The session flag prevents a reload loop if
// the failure turns out not to be cache-related.
async function recoverFromStaleCache(): Promise<void> {
  if (sessionStorage.getItem(cacheRecoveryFlagKey) === "true") return;
  sessionStorage.setItem(cacheRecoveryFlagKey, "true");

  try {
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((r) => r.unregister()));
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } finally {
    window.location.reload();
  }
}

function watchForStaleCacheFailures() {
  window.addEventListener("unhandledrejection", (event) => {
    if (looksLikeStaleCacheFailure(event.reason)) {
      void recoverFromStaleCache();
    }
  });
  window.addEventListener("error", (event) => {
    if (looksLikeStaleCacheFailure(event.error ?? event.message)) {
      void recoverFromStaleCache();
    }
  });
}

// When a deploy updates the service worker, the first page load after it is
// still served from the old precache; the new worker (skipWaiting +
// clientsClaim) takes control moments later. Reload once so the user gets the
// new assets immediately instead of on their next visit. The time window and
// the session flag keep this from ever reloading mid-exploration or looping.
function reloadOnServiceWorkerUpdate() {
  const pageLoadedAt = Date.now();
  const wasControlledAtLoad = Boolean(navigator.serviceWorker.controller);

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    const withinReloadWindow = Date.now() - pageLoadedAt < swReloadWindowMs;
    const alreadyReloaded = sessionStorage.getItem(swReloadFlagKey) === "true";

    if (wasControlledAtLoad && withinReloadWindow && !alreadyReloaded) {
      sessionStorage.setItem(swReloadFlagKey, "true");
      window.location.reload();
    }
  });
}

window.addEventListener("load", () => {
  watchForStaleCacheFailures();

  initRegionalAttribution().catch((err: unknown) => {
    console.error("Regional attribution failed:", err);
  });

  if ("serviceWorker" in navigator) {
    reloadOnServiceWorkerUpdate();
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((err: unknown) => {
        console.error("Service worker registration failed:", err);
      });
  }

  if (document.getElementById(mapHtmlId)) {
    const initialZoom = window.innerWidth <= smallScreenWidthPx ? 2 : 3;

    new MandelbrotMap({
      htmlId: mapHtmlId,
      initialConfig: {
        iterations: 200,
        exponent: 2,
        colorScheme: "turbo",
        lightenAmount: 0,
        saturateAmount: 0,
        shiftHueAmount: 0,
        colorSpace: 2,
        reverseColors: false,
        highDpiTiles: false,
        smoothColoring: true,
        paletteMinIter: 0,
        paletteMaxIter: 200,
        scaleWithIterations: true,

        re: "-0.5",
        im: "0",
        zoom: initialZoom,
      },
    });
  }
});
