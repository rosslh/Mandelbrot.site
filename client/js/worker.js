import { expose } from "threads/worker";
import initOxipngST, {
  optimise as optimiseST,
} from "../node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng.js";

let oxipngInitialized = false;

async function ensureOxipngInitialized() {
  if (!oxipngInitialized) {
    await initOxipngST();
    oxipngInitialized = true;
  }
}

import("../../mandelbrot/pkg")
  .then(async (wasm) => {
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
        params.paletteMinIter,
        params.paletteMaxIter,
      );

    const optimiseImage = async (payload) => {
      await ensureOxipngInitialized();
      const result = optimiseST(
        new Uint8Array(payload.buffer),
        2,
        false,
        false,
      );
      return result.buffer;
    };

    expose(async (request) => {
      switch (request.type) {
        case "calculate":
          return getTile(request.payload);
        case "optimise":
          return await optimiseImage(request.payload);
        default:
          throw new Error(`Unknown worker request type: ${request.type}`);
      }
    });
  })
  .catch((err) => {
    console.error("Error loading WASM module in worker:", err);
    expose(() => {
      throw new Error("Worker initialization failed");
    });
  });
