// Runs inside Chrome. Loads one wasm module instance per variant (separate
// URLs give independent instances, so orbit caches never cross-contaminate)
// and exposes single-call primitives; all sequencing lives in the Node
// runner so a hung case can't wedge the page silently.

const variants = [];

window.benchReady = (async () => {
  window.loadVariants = async (urls) => {
    variants.length = 0;
    for (const url of urls) {
      const module = await import(url);
      await module.default(); // wasm-bindgen init: fetch + instantiate
      module.init(); // crate init: panic hook
      variants.push(module);
    }
    return {
      crossOriginIsolated: window.crossOriginIsolated,
      count: variants.length,
    };
  };

  window.runCase = (variantIndex, args) => {
    if (window.gc) window.gc();
    const start = performance.now();
    const data = variants[variantIndex].get_mandelbrot_image_precise(...args);
    const ms = performance.now() - start;

    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return {
      ms,
      bytes: data.length,
      hash: (hash >>> 0).toString(16).padStart(8, "0"),
    };
  };

  // Worker pools for run-grid.mjs: one pool per variant, sized like the
  // production render pool. Workers stay alive across grid passes (as in
  // production, where they live for the page session).
  const pools = [];

  window.loadWorkerPools = async (urls, poolSize) => {
    for (const pool of pools) for (const worker of pool) worker.terminate();
    pools.length = 0;
    const size = poolSize ?? Math.max(1, navigator.hardwareConcurrency - 1);
    for (const url of urls) {
      const pool = await Promise.all(
        Array.from({ length: size }, async () => {
          const worker = new Worker("./grid-worker.js", { type: "module" });
          await new Promise((resolve, reject) => {
            worker.onmessage = (event) =>
              event.data.type === "ready"
                ? resolve()
                : reject(new Error(event.data.message));
            worker.postMessage({ type: "init", url });
          });
          worker.onmessage = null;
          return worker;
        }),
      );
      pools.push(pool);
    }
    return {
      crossOriginIsolated: window.crossOriginIsolated,
      cores: navigator.hardwareConcurrency,
      poolSize: size,
      count: pools.length,
    };
  };

  // Renders every tile once on the variant's pool, FIFO like threads' Pool:
  // each idle worker takes the next queued tile. Resolves with the wall time
  // from first dispatch to last tile completed, plus per-tile wasm times.
  window.runGridParallel = (variantIndex, tileArgsList) =>
    new Promise((resolve, reject) => {
      const pool = pools[variantIndex];
      const results = new Array(tileArgsList.length);
      let next = 0;
      let done = 0;
      const start = performance.now();
      const assign = (worker) => {
        if (next >= tileArgsList.length) return;
        const index = next++;
        worker.onmessage = (event) => {
          const message = event.data;
          if (message.type !== "result") {
            reject(new Error(message.message ?? "worker error"));
            return;
          }
          results[index] = {
            ms: message.ms,
            hash: message.hash,
            bytes: message.bytes,
          };
          done++;
          if (done === tileArgsList.length) {
            resolve({ wallMs: performance.now() - start, tiles: results });
          } else {
            assign(worker);
          }
        };
        worker.postMessage({ type: "run", args: tileArgsList[index] });
      };
      pool.forEach(assign);
    });

  window.getTile = (variantIndex, args) => {
    const data = variants[variantIndex].get_mandelbrot_image_precise(...args);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < data.length; i += chunkSize) {
      binary += String.fromCharCode(...data.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  return true;
})();
