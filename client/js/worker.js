import { expose } from "threads/worker";

import("../../mandelbrot/pkg").then((wasm) => {
  wasm.init();

  const workerApi = {
    getTile: ({
      bounds,
      maxIterations,
      exponent,
      imageWidth,
      imageHeight,
      colorScheme,
      reverseColors,
    }) => {
      return wasm.get_mandelbrot_image(
        bounds.reMin,
        bounds.reMax,
        bounds.imMin,
        bounds.imMax,
        maxIterations,
        exponent,
        imageWidth,
        imageHeight,
        colorScheme,
        reverseColors,
      );
    },
  };

  expose(workerApi);
});
