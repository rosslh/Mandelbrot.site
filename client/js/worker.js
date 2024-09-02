import { expose } from "threads/worker";

import("../../mandelbrot/pkg").then((wasm) => {
  wasm.init();

  const getTile = (params) =>
    wasm.get_mandelbrot_set_image(
      params.bounds.reMin,
      params.bounds.reMax,
      params.bounds.imMin,
      params.bounds.imMax,
      params.iterations,
      params.exponent,
      params.imageWidth,
      params.imageHeight,
      params.colorScheme,
      params.reverseColors,
      params.shiftHueAmount,
      params.saturateAmount,
      params.lightenAmount,
      params.colorSpace,
      params.smoothColoring,
    );

  expose(getTile);
});
