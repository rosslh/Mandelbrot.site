import "./static";
import MandelbrotMap from "./MandelbrotMap";
import { initRegionalAttribution } from "./regionalAttribution";

const mapHtmlId = "leaflet";
const smallScreenWidthPx = 800;
const swReloadFlagKey = "mandelbrot-sw-reloaded";
const swReloadWindowMs = 10000;

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
