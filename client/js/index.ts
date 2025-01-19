import "./static";
import MandelbrotMap from "./MandelbrotMap";

window.addEventListener("load", () => {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((err: unknown) => {
        console.error("Service worker registration failed:", err);
      });
  }

  if (document.getElementById("leaflet")) {
    new MandelbrotMap({
      htmlId: "leaflet",
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
        zoom: 3,
      },
    });
  }
});
