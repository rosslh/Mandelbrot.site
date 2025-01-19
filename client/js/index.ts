import "./static";
import MandelbrotMap from "./MandelbrotMap";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then(() => {
        console.log("Service worker registered.");
      })
      .catch((err: unknown) => {
        console.error("Service worker registration failed:", err);
      });
  });
}

window.addEventListener("load", () => {
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
});
