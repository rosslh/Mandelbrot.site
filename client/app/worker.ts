import { exposeApi } from "threads-es/worker";
import("../../mandelbrot/pkg").then((wasm) => {
  wasm.init();

  const workerApi = {
    getTile: ({
      coords,
      maxIterations,
      exponent,
      tileSize,
      colorScheme,
      reverseColors,
    }: {
      coords: {
        re_min: number;
        re_max: number;
        im_min: number;
        im_max: number;
      };
      maxIterations: number;
      exponent: number;
      tileSize: number;
      colorScheme: string;
      reverseColors: boolean;
    }) => {
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
      return data;
    },
  };

  exposeApi(workerApi);
});
