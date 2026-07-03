// Generates the service worker after webpack has emitted the full `dist`
// output. Running as a post-build step (rather than the webpack plugin) is
// deliberate: the app bundle and the web worker + WASM live in separate webpack
// compilations, so a plugin attached to one never sees the other's output. By
// globbing the finished `dist` we precache every asset the app needs to run --
// `app.js`, its lazy chunks, `worker.js`, the worker chunks, and every `.wasm`
// file -- as one self-consistent set. `cleanupOutdatedCaches` then swaps the
// whole set atomically on each deploy, so a returning user can never end up
// running an old bundle against a mismatched (network-served) worker/WASM.
const path = require("path");
const { generateSW } = require("workbox-build");

const dist = path.resolve(__dirname, "dist");

generateSW({
  globDirectory: dist,
  globPatterns: ["**/*.{js,css,html,wasm,png,ico,svg,webmanifest,xml}"],
  // Skip source maps and the service worker's own runtime output.
  globIgnores: ["service-worker.js", "workbox-*.js", "**/*.map"],
  swDest: path.join(dist, "service-worker.js"),
  clientsClaim: true,
  skipWaiting: true,
  cleanupOutdatedCaches: true,
  // WASM binaries exceed Workbox's 2 MiB default; keep them precached.
  maximumFileSizeToCacheInBytes: 8 * 1024 * 1024,
})
  .then(({ count, size, warnings }) => {
    for (const warning of warnings) console.warn(warning);
    // eslint-disable-next-line no-console
    console.log(
      `Service worker precaches ${count} files (${(size / (1024 * 1024)).toFixed(2)} MiB).`,
    );
  })
  .catch((err) => {
    console.error("Service worker generation failed:", err);
    process.exit(1);
  });
