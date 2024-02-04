import { stringify } from "./utils";
import("../../mandelbrot/pkg").then((wasm) => {
  wasm.init();
  self.addEventListener("message", (ev) => {
    try {
      const {
        coords,
        maxIterations,
        exponent,
        tileSize,
        colorScheme,
        reverseColors,
      } = ev.data;
      const data = wasm.get_tile(
        coords.re_min,
        coords.re_max,
        coords.im_min,
        coords.im_max,
        maxIterations,
        exponent,
        tileSize,
        colorScheme,
        reverseColors
      );
      self.postMessage({
        image: data,
        coords: stringify(coords),
      });
    } catch (err) {
      console.error(err);
    }
  });
  self.postMessage({ ready: true });
});
