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
