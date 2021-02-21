import("../../crate-wasm/pkg").then(wasm => {
  wasm.init();
  self.addEventListener("message", ev => {
    try {
      const { coords, maxIterations, isSmoothed, exponent } = ev.data;
      const data = wasm.get_tile(coords.x, coords.y, coords.z, maxIterations, isSmoothed, exponent);
      self.postMessage({ coords: JSON.stringify(coords), pixels: data });
    } catch (err) {
      console.log(err);
    }
  });
  self.postMessage({ ready: true });
});
