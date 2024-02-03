import { stringify } from "./utils";
import("../../mandelbrot/pkg").then((wasm) => {
  wasm.init();
  self.addEventListener("message", (ev) => {
    try {
      const { coords, maxIterations, exponent, tileSize } = ev.data;
      const data = wasm.get_tile_js(
        coords.re_min,
        coords.re_max,
        coords.im_min,
        coords.im_max,
        maxIterations,
        exponent,
        tileSize
      );
      self.postMessage({
        ...data,
        coords: stringify(coords),
      });
    } catch (err) {
      console.error(err);
    }
  });
  self.postMessage({ ready: true });
});
