// Lane check for the WebGPU lane (backlog G1/G2): loads a built dist with the
// localhost-only forced-lane switch and reports which lane rendered each
// visible tile (the tile canvas's data-lane marker), plus page errors.
// Used by the GPU ship gates: GPU-on, forced-wasm, no-adapter and injected-
// failure runs must all render every tile with no page error.
//
// Usage: node src/lane-check.mjs <dist-variant> [--lane gpu|wasm]
//          [--gpu-fail shader|lost|tile] [--no-gpu] [--z 5] [--re -0.75]
//          [--im 0] [--i 500] [--expect gpu|wasm|mixed]
// Exits 1 when a tile is missing, a page error fired, or --expect fails.

import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { startServer } from "./server.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const variant = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const noGpu = argv.includes("--no-gpu");
const lane = opt("lane", "gpu");
const gpuFail = opt("gpu-fail", null);
const expect = opt("expect", null);
if (!variant)
  throw new Error("Usage: node src/lane-check.mjs <dist-variant> [options]");

const server = await startServer({
  root: join(benchDir, "artifacts", variant, "dist"),
  crossOriginIsolate: false,
});
const browser = await puppeteer.launch({
  args: [
    "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    ...(process.env.CI ? ["--no-sandbox"] : []),
    ...(noGpu ? ["--disable-gpu"] : []),
  ],
});
const pageErrors = [];
// Worker exceptions and unhandled rejections never reach "pageerror"; Chrome
// reports them as error-level console messages, which count as errors here
// (except blocked off-localhost fetches, which every run makes).
const consoleErrors = [];
const warnings = [];
let summary;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (error) => pageErrors.push(String(error).slice(0, 300)));
  page.on("console", (message) => {
    const text = message.text().slice(0, 300);
    if (message.type() === "error" && !text.includes("ERR_NAME_NOT_RESOLVED")) {
      consoleErrors.push(text);
    } else if (message.type() === "warn" || message.type() === "warning") {
      warnings.push(text);
    }
  });
  const params = new URLSearchParams({
    re: opt("re", "-0.75"),
    im: opt("im", "0"),
    z: opt("z", "5"),
    i: opt("i", "500"),
    lane,
  });
  if (gpuFail) params.set("gpuFail", gpuFail);
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${server.port}/?${params}`, {
    waitUntil: "load",
  });
  let last = null;
  let stableSince = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 250));
    const state = await page.evaluate(() => {
      const tiles = [...document.querySelectorAll(".leaflet-tile")];
      const loaded = tiles.filter((t) =>
        t.classList.contains("leaflet-tile-loaded"),
      );
      const lanes = {};
      for (const t of loaded)
        lanes[t.dataset.lane ?? "none"] =
          (lanes[t.dataset.lane ?? "none"] ?? 0) + 1;
      return { total: tiles.length, loaded: loaded.length, lanes };
    });
    if (JSON.stringify(state) !== JSON.stringify(last)) {
      last = state;
      stableSince = Date.now();
    }
    if (
      last.total > 0 &&
      last.loaded >= last.total &&
      Date.now() - stableSince > 2000
    )
      break;
    if (Date.now() - started > 120000) break;
  }
  summary = {
    variant,
    lane,
    gpuFail,
    noGpu,
    ...last,
    elapsedMs: Date.now() - started,
  };
} finally {
  await browser.close();
  server.server.close();
}

const lanes = Object.keys(summary.lanes);
let ok =
  summary.total > 0 &&
  summary.loaded === summary.total &&
  // Leaflet marks errored tiles loaded too; they carry no data-lane.
  !summary.lanes.none &&
  pageErrors.length === 0 &&
  consoleErrors.length === 0;
if (expect === "gpu" || expect === "wasm")
  ok &&= lanes.length === 1 && lanes[0] === expect;
if (expect === "mixed") ok &&= lanes.includes("gpu") && lanes.includes("wasm");
console.log(
  JSON.stringify(
    {
      ok,
      ...summary,
      pageErrors,
      consoleErrors,
      warnings: [...new Set(warnings)].slice(0, 5),
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
