// CORRECTNESS GATE, not a benchmark: drives the actual built client (webpack
// bundle, real wasm, real Leaflet, real threads pool) in Chrome via puppeteer,
// loads a shareable URL for each corpus case, waits for every visible tile to
// finish, and then asserts on the rendered pixels. Where run-e2e.mjs answers
// "how fast", this answers "did every tile of this coordinate render, and does
// the result match the case's externally verified expectation".
//
// Default corpus is corpus/deep-coords.json: published deep-zoom coordinates
// (10^31 .. 10^275 magnification, up to 286-digit centers) whose iteration
// behavior was pinned with an arbitrary-precision reference; the Rust twins
// live in mandelbrot/src/perturbation_test.rs.
//
// Usage:
//   node src/verify-e2e.mjs
//     [--dist ../client/dist] [--corpus corpus/deep-coords.json]
//     [--filter <id-substring>] [--viewport 1200x800]
//
// Exits non-zero if any case times out, raises a page error, or fails its
// pixel expectation.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { validateCase } from "./normalize.mjs";
import { startServer } from "./server.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const QUIET_MS = 2500; // no new tile loads for this long = grid is done
const PASS_TIMEOUT_MS = 300000;

const EXPECTATIONS = ["structure", "escaped", "interior"];

function parseArgs(argv) {
  const opts = {
    dist: resolve(benchDir, "..", "client", "dist"),
    corpus: join(benchDir, "corpus", "deep-coords.json"),
    filter: null,
    viewport: { width: 1200, height: 800 },
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dist") opts.dist = resolve(argv[++i]);
    else if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--viewport") {
      const [w, h] = argv[++i].split("x").map(Number);
      opts.viewport = { width: w, height: h };
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

function caseUrl(port, benchCase) {
  const params = new URLSearchParams({
    re: benchCase.re,
    im: benchCase.im,
    z: String(benchCase.zoom),
    i: String(benchCase.iterations),
  });
  if (benchCase.exponent && benchCase.exponent !== 2) {
    params.set("e", String(benchCase.exponent));
  }
  return `http://127.0.0.1:${port}/?${params}`;
}

// Injected before every document: records tile progress inside the main map
// container (#leaflet) only, so overlays never count toward completion.
const TILE_TRACKER = `
  window.__tileGate = { total: 0, loaded: 0, lastLoadedAt: 0 };
  new MutationObserver(() => {
    const gate = window.__tileGate;
    const map = document.getElementById("leaflet");
    if (!map) return;
    const total = map.querySelectorAll(".leaflet-tile").length;
    const loaded = map.querySelectorAll(".leaflet-tile-loaded").length;
    if (loaded > gate.loaded) gate.lastLoadedAt = performance.now();
    gate.total = total;
    gate.loaded = loaded;
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
`;

async function waitForTiles(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PASS_TIMEOUT_MS });
  const deadline = Date.now() + PASS_TIMEOUT_MS;
  let last = { total: 0, loaded: 0, lastLoadedAt: 0 };
  let stableSince = Date.now();
  for (;;) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
    const stats = await page.evaluate(() => window.__tileGate);
    if (
      stats.total !== last.total ||
      stats.loaded !== last.loaded ||
      stats.lastLoadedAt !== last.lastLoadedAt
    ) {
      stableSince = Date.now();
      last = stats;
    }
    const complete = last.total > 0 && last.loaded >= last.total;
    if (complete && Date.now() - stableSince >= QUIET_MS) return last;
    if (Date.now() > deadline) {
      throw new Error(`Timed out: ${last.loaded}/${last.total} tiles loaded at ${url}`);
    }
  }
}

// Samples every loaded tile canvas in the main map (stride 7 within each
// canvas) and aggregates pixel statistics for the expectation checks.
function samplePixels() {
  const map = document.getElementById("leaflet");
  const tiles = [...map.querySelectorAll("canvas.leaflet-tile-loaded")];
  const distinct = new Set();
  let black = 0;
  let colored = 0;
  let transparent = 0;
  for (const tile of tiles) {
    const context = tile.getContext("2d");
    const { data } = context.getImageData(0, 0, tile.width, tile.height);
    for (let i = 0; i < data.length; i += 4 * 7) {
      const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a === 0) {
        transparent += 1;
        continue;
      }
      if (r === 0 && g === 0 && b === 0) black += 1;
      else colored += 1;
      if (distinct.size < 4096) distinct.add((r << 16) | (g << 8) | b);
    }
  }
  return { tiles: tiles.length, black, colored, transparent, distinct: distinct.size };
}

function checkExpectation(expect, pixels) {
  const problems = [];
  const sampled = pixels.black + pixels.colored;
  if (pixels.tiles === 0) problems.push("no loaded tile canvases found");
  if (sampled === 0) problems.push("no opaque pixels sampled");
  if (pixels.transparent > 0) {
    problems.push(`${pixels.transparent} transparent pixels (tile left unpainted)`);
  }
  if (expect === "structure") {
    if (pixels.black === 0) problems.push("expected a bounded (black) region, found none");
    if (pixels.colored === 0) problems.push("expected escaping (colored) pixels, found none");
    if (pixels.distinct < 16) {
      problems.push(`expected visible structure, got ${pixels.distinct} distinct colors`);
    }
  } else if (expect === "escaped") {
    if (pixels.black > 0) {
      problems.push(`expected every pixel to escape, found ${pixels.black} black pixels`);
    }
  } else if (expect === "interior") {
    if (pixels.colored > 0) {
      problems.push(`expected solid interior, found ${pixels.colored} colored pixels`);
    }
  }
  return problems;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(readFileSync(opts.corpus, "utf8"));
  let cases = corpus.cases;
  if (opts.filter) {
    cases = cases.filter((benchCase) => benchCase.id.includes(opts.filter));
    if (cases.length === 0) throw new Error(`--filter "${opts.filter}" matched no cases`);
  }
  for (const benchCase of cases) {
    const problems = validateCase(benchCase);
    if (!EXPECTATIONS.includes(benchCase.expect)) {
      problems.push(`bad expect: ${benchCase.expect}`);
    }
    if (problems.length > 0) {
      throw new Error(`Invalid case ${benchCase.id}: ${problems.join(", ")}`);
    }
  }

  const { server, port } = await startServer({
    root: opts.dist,
    crossOriginIsolate: false,
  });
  console.log(`Serving ${opts.dist} on port ${port}`);

  const browser = await puppeteer.launch({
    args: [
      // Fail DNS for everything except localhost: no telemetry, no external
      // fetches, no network noise (see run-e2e.mjs for why page-level
      // interception cannot do this).
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ ...opts.viewport, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(TILE_TRACKER);
  const pageErrors = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error("[page error]", error.message);
  });

  const failures = [];
  try {
    for (const benchCase of cases) {
      process.stdout.write(`${benchCase.id} (z=${benchCase.zoom}, i=${benchCase.iterations}) ... `);
      const errorsBefore = pageErrors.length;
      const started = Date.now();
      let problems = [];
      try {
        const tiles = await waitForTiles(page, caseUrl(port, benchCase));
        const pixels = await page.evaluate(samplePixels);
        problems = checkExpectation(benchCase.expect, pixels);
        console.log(
          `${problems.length === 0 ? "ok" : "FAIL"} — ${tiles.loaded}/${tiles.total} tiles, ` +
            `${pixels.black} black / ${pixels.colored} colored samples, ` +
            `${pixels.distinct} distinct colors, ${((Date.now() - started) / 1000).toFixed(1)}s`,
        );
      } catch (error) {
        problems = [error.message];
        console.log("FAIL");
      }
      if (pageErrors.length > errorsBefore) {
        problems.push(`page errors: ${pageErrors.slice(errorsBefore).join("; ")}`);
      }
      for (const problem of problems) {
        console.log(`    ${problem}`);
        failures.push(`${benchCase.id}: ${problem}`);
      }
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log(`\nAll ${cases.length} case(s) verified.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
