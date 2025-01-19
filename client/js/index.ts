import "./static";
import MandelbrotMap from "./MandelbrotMap";

const mapHtmlId = "leaflet";
const smallScreenWidthPx = 800;

window.addEventListener("load", () => {
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

        re: -0.5,
        im: 0,
        zoom: initialZoom,
      },
    });
  }
});
