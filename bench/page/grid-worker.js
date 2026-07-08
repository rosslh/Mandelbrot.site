// Tile-render worker for run-grid.mjs. Mirrors the production worker
// (client/js/worker.js): loads the wasm module once, then renders one tile
// per request and posts the pixel data back via structured clone (the same
// copy the `threads` library pays). The wasm call is timed in the worker;
// wall-clock grid time is measured on the main thread.

let wasmModule = null;

function fnv1a(data) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      const module = await import(message.url);
      await module.default(); // wasm-bindgen init: fetch + instantiate
      module.init(); // crate init: panic hook
      // Same tier-up warmup as production (client/js/worker.js): two small
      // boundary-rich exponent-2 renders at spawn so cold-pass numbers model
      // real page loads, where TurboFan replaces Liftoff during pool init.
      try {
        for (let i = 0; i < 2; i++) {
          module
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
      wasmModule = module;
      self.postMessage({ type: "ready" });
    } else if (message.type === "run") {
      const start = performance.now();
      const data = wasmModule.get_mandelbrot_image_precise(...message.args);
      const ms = performance.now() - start;
      self.postMessage({
        type: "result",
        ms,
        hash: fnv1a(data),
        bytes: data.length,
        data,
      });
    } else {
      throw new Error(`Unknown message type: ${message.type}`);
    }
  } catch (error) {
    self.postMessage({ type: "error", message: String(error?.stack ?? error) });
  }
};
