import "./static";
import MandelbrotMap from "./MandelbrotMap";
import { initRegionalAttribution } from "./regionalAttribution";

const mapHtmlId = "leaflet";
const smallScreenWidthPx = 800;

window.addEventListener("load", () => {
  initRegionalAttribution().catch((err: unknown) => {
    console.error("Regional attribution failed:", err);
  });

  if ("serviceWorker" in navigator) {
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
