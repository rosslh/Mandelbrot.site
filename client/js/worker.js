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

    // Warm the SIMD escape loops before accepting tiles. V8 runs wasm under
    // Liftoff until TurboFan tiers it up, and Liftoff executes the f64x2
    // pixel-pair loops several times slower than tiered code; without this,
    // every page load renders its first tiles at Liftoff speed in every
    // worker (measured +18% navigation-to-rendered at high iteration counts,
    // bench/LOG.md 2026-07-04). Two small boundary-rich renders consume the
    // tier-up budget during pool spawn instead. Must stay on the exponent-2
    // path (the paired loop) and avoid interior tiles (the rect_in_set
    // short-circuit would skip the escape loop).
    try {
      for (let i = 0; i < 2; i++) {
        wasm
          .get_mandelbrot_tile_precise(
            "-0.7436438870371587",
            "0.1318259042053119",
            655,
            656,
            655,
            656,
            10,
            0,
            1000,
            2,
            64,
            64,
            "turbo",
            false,
            0,
            0,
            0,
            2,
            true,
            0,
            1000,
            false,
          )
          .free();
      }
    } catch (warmupError) {
      console.warn("wasm warmup failed:", warmupError);
    }

    // The general-exponent perturbation kernel is a separate wasm function
    // (one instantiation shared by all exponents != 2), so the init warmup
    // above never tiers it up and deep multibrot tiles would run it at
    // Liftoff speed (measured: only -8% instead of -45% end-to-end on the
    // e52 view, bench/LOG.md 2026-07-08). The pool requests this extra
    // warmup at spawn only when the current view uses exponent != 2, so
    // ordinary loads pay nothing (the unconditional version cost every
    // light page load ~70 ms). Two tiny low-budget renders of a deep
    // exponent-52 boundary view (5% interior, escapers mean ~140
    // iterations, so the border check fails fast and every pixel streams
    // through the kernel) consume the tier-up budget.
    const warmupGeneralKernel = () => {
      try {
        for (let i = 0; i < 2; i++) {
          wasm
            .get_mandelbrot_tile_precise(
              "-0.561760682385648",
              "-0.7341970302369814",
              2621,
              2622,
              2621,
              2622,
              12,
              38,
              300,
              52,
              32,
              32,
              "turbo",
              false,
              0,
              0,
              0,
              2,
              true,
              0,
              300,
              false,
            )
            .free();
        }
      } catch (warmupError) {
        console.warn("wasm general-kernel warmup failed:", warmupError);
      }
    };

    const getTile = (params) => {
      const tile = wasm.get_mandelbrot_tile_precise(
        params.originRe,
        params.originIm,
        params.bounds.xMin,
        params.bounds.xMax,
        params.bounds.yMin,
        params.bounds.yMax,
        params.bounds.zoom,
        params.zoomOffset,
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
        params.includeValues,
      );

      // Copy the fields out and free the wasm-bindgen struct; it is not
      // garbage collected.
      const result = {
        image: tile.image,
        values: params.includeValues ? tile.values : null,
        minIter: tile.min_iter >= 0 ? tile.min_iter : null,
        maxIter: tile.max_iter >= 0 ? tile.max_iter : null,
      };
      tile.free();
      return result;
    };

    const recolorTile = (params) =>
      wasm.recolor_tile(
        params.values,
        params.colorScheme,
        params.reverseColors,
        params.shiftHueAmount,
        params.saturateAmount,
        params.lightenAmount,
        params.colorSpace,
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
        case "recolor":
          return recolorTile(request.payload);
        case "optimise":
          return await optimiseImage(request.payload);
        case "warmupGeneral":
          return warmupGeneralKernel();
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
