import { expose } from "threads/worker";

import("../../mandelbrot/pkg").then((wasm) => {
  wasm.init();

  const workerApi = {
    getTile: ({
      bounds,
      maxIterations,
      exponent,
      tileSize,
      colorScheme,
      reverseColors,
    }) => {
      return wasm.get_mandelbrot_image(
        bounds.re_min,
        bounds.re_max,
        bounds.im_min,
        bounds.im_max,
        maxIterations,
        exponent,
        tileSize,
        colorScheme,
        reverseColors
      );
    },
  };

  expose(workerApi);
});
