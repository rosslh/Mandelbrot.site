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

    // The single place that spells out get_mandelbrot_tile_precise's
    // positional argument order; every caller passes named fields.
    const computeTile = (params) =>
      wasm.get_mandelbrot_tile_precise(
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

    // Renders a throwaway view twice to consume V8's wasm tier-up budget;
    // warmups differ only in view geometry, so appearance fields are fixed
    // here (the palette range spans the full budget, matching real tiles).
    const warmupRender = (label, view) => {
      try {
        for (let i = 0; i < 2; i++) {
          computeTile({
            colorScheme: "turbo",
            reverseColors: false,
            shiftHueAmount: 0,
            saturateAmount: 0,
            lightenAmount: 0,
            colorSpace: 2,
            smoothColoring: true,
            paletteMinIter: 0,
            paletteMaxIter: view.iterations,
            includeValues: false,
            ...view,
          }).free();
        }
      } catch (warmupError) {
        console.warn(`wasm ${label} warmup failed:`, warmupError);
      }
    };

    // Warm the SIMD escape loops before accepting tiles. V8 runs wasm under
    // Liftoff until TurboFan tiers it up, and Liftoff executes the f64x2
    // pixel-pair loops several times slower than tiered code; without this,
    // every page load renders its first tiles at Liftoff speed in every
    // worker (measured +18% navigation-to-rendered at high iteration counts,
    // bench/LOG.md 2026-07-04). Two small boundary-rich renders consume the
    // tier-up budget during pool spawn instead. Must stay on the exponent-2
    // path (the paired loop) and avoid interior tiles (the rect_in_set
    // short-circuit would skip the escape loop).
    warmupRender("init", {
      originRe: "-0.7436438870371587",
      originIm: "0.1318259042053119",
      bounds: { xMin: 655, xMax: 656, yMin: 655, yMax: 656, zoom: 10 },
      zoomOffset: 0,
      iterations: 1000,
      exponent: 2,
      imageWidth: 64,
      imageHeight: 64,
    });

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
    const warmupGeneralKernel = () =>
      warmupRender("general-kernel", {
        originRe: "-0.561760682385648",
        originIm: "-0.7341970302369814",
        bounds: { xMin: 2621, xMax: 2622, yMin: 2621, yMax: 2622, zoom: 12 },
        zoomOffset: 38,
        iterations: 300,
        exponent: 52,
        imageWidth: 32,
        imageHeight: 32,
      });

    // The direct-tier general-exponent stream kernel (exponent != 2,
    // effective zoom < 47) is yet another separate wasm function — distinct
    // from both the quadratic kernel the init warmup tiers and the deep
    // general perturbation kernel above — so direct multibrot first tiles
    // would render at Liftoff speed for their entire duration (the stream
    // kernel is one call per wave). The pool requests this warmup at spawn
    // only when the current view uses exponent != 2 at direct depth.
    // Boundary-rich view just past the degree-6 multibrot cusp (~82%
    // escapers at ~27 iterations mean, probed 2026-07-10), 128px for
    // execution volume; the kernel instantiation is shared by all
    // exponents != 2, so warming with exponent 6 covers every multibrot.
    const warmupGeneralDirectKernel = () =>
      warmupRender("direct-general kernel", {
        originRe: "0.5975",
        originIm: "0",
        bounds: { xMin: 655, xMax: 656, yMin: 655, yMax: 656, zoom: 10 },
        zoomOffset: 0,
        iterations: 2000,
        exponent: 6,
        imageWidth: 128,
        imageHeight: 128,
      });

    // The perturbation-f64 stream kernel (exponent 2, effective zoom >= 47)
    // is also a separate wasm function from the direct loop the init warmup
    // exercises, so deep-zoom first tiles run it at Liftoff speed: an
    // execution-volume probe measured heavy pf64 loads 10-16% slower end to
    // end without extra spawn warmup (bench/LOG.md 2026-07-08). The pool
    // requests this warmup at spawn only when the initial view is already at
    // deep-zoom depth, so shallow loads pay nothing. Boundary-rich dendrite
    // tile (0% interior, escapers mean ~40 iterations, so nothing
    // short-circuits and lanes refill constantly); 256px at ~2.6M iterations
    // per render gives the kernel enough execution volume to tier up, and
    // the 2000-step arbitrary-precision reference orbit warms the dashu code
    // that deep views run cold per worker. ~30/~16 ms per render
    // (Liftoff/tiered), only on loads that take seconds anyway.
    const warmupDeepKernel = () =>
      warmupRender("deep-zoom kernel", {
        originRe: "0",
        originIm: "1",
        bounds: { xMin: 2621, xMax: 2622, yMin: 2621, yMax: 2622, zoom: 12 },
        zoomOffset: 36,
        iterations: 2000,
        exponent: 2,
        imageWidth: 256,
        imageHeight: 256,
      });

    // The hybrid float-exp stream kernel (exponent 2, effective zoom >= 250)
    // is yet another separate wasm function, so float-exp first tiles would
    // run it at Liftoff speed (the stream kernel is one call per tile, so
    // tier-up never lands mid-tile; see bench/LOG.md 2026-07-08 on the
    // general kernel). The pool requests this warmup at spawn only when the
    // initial view is already at float-exp depth. Same boundary-rich
    // dendrite tile as the deep-zoom warmup but at effective zoom 260, where
    // pixel deltas promote to the kernel's f64 phase immediately; the
    // reference orbit also warms the higher-precision dashu path float-exp
    // views pay per worker.
    const warmupFloatExpKernel = () =>
      warmupRender("float-exp kernel", {
        originRe: "0",
        originIm: "1",
        bounds: { xMin: 2621, xMax: 2622, yMin: 2621, yMax: 2622, zoom: 12 },
        zoomOffset: 248,
        iterations: 1500,
        exponent: 2,
        imageWidth: 128,
        imageHeight: 128,
      });

    const getTile = (params) => {
      const tile = computeTile(params);

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
        case "warmupGeneralDirect":
          return warmupGeneralDirectKernel();
        case "warmupDeep":
          return warmupDeepKernel();
        case "warmupFloatExp":
          return warmupFloatExpKernel();
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
