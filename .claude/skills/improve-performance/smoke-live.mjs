#!/usr/bin/env node
// Post-deploy smoke test for /improve-performance: loads the live site in headless Chrome (the
// bench harness's Puppeteer) and checks that the map renders tiles without page errors.
// Every other host fails to resolve (the same --host-resolver-rules approach as run-e2e, which
// also covers workers; request interception is avoided because it stalls this client's worker
// spawns), so the visit sends no analytics and stays out of the real-view data the benchmark
// corpus is built from.
//
//   node .claude/skills/improve-performance/smoke-live.mjs [--no-gpu] [--expect-lane gpu|wasm] [url]
//     (default url https://mandelbrot.site/)
//
// The summary counts loaded tiles by the lane that rendered them (the tile canvas's data-lane
// marker: "gpu" or "wasm"; "none" on builds that predate the marker). --expect-lane fails the run
// unless every loaded tile came from that lane: use it on a view the GPU lane covers, to confirm
// the deployed lane is actually serving tiles.
//
// --no-gpu launches Chrome with --disable-gpu: navigator.gpu still exists but requestAdapter()
// returns null, the "no usable GPU" case, so the run exercises the wasm fallback lane. Without
// it, headless Chrome on this machine gets the hardware WebGPU adapter (bench/src/gpu-probe.mjs).
//
// Exit 0 with a JSON summary when at least MIN_TILES tiles finished and no page error fired;
// exit 1 otherwise.

import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../bench/package.json', import.meta.url));
const puppeteer = require('puppeteer');

const args = process.argv.slice(2);
const noGpu = args.includes('--no-gpu');
const expectLaneIndex = args.indexOf('--expect-lane');
const expectLane = expectLaneIndex >= 0 ? args[expectLaneIndex + 1] : null;
const url =
  args.find((arg, index) => !arg.startsWith('--') && index !== expectLaneIndex + 1) ?? 'https://mandelbrot.site/';
const host = new URL(url).hostname;
const MIN_TILES = 8;
const QUIET_MS = 2500; // the same "grid is done" rule as bench/src/run-e2e.mjs
const TIMEOUT_MS = 90_000;

const browser = await puppeteer.launch({
  headless: true,
  args: [
    `--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}, EXCLUDE www.mandelbrot.site, EXCLUDE mandelbrot.site`,
    ...(noGpu ? ['--disable-gpu'] : []),
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));

const started = Date.now();
await page.goto(url, { waitUntil: 'load', timeout: TIMEOUT_MS });
let tiles = 0;
let lastChange = Date.now();
while (Date.now() - started < TIMEOUT_MS) {
  const count = await page.evaluate(() => document.querySelectorAll('.leaflet-tile-loaded').length);
  if (count !== tiles) {
    tiles = count;
    lastChange = Date.now();
  } else if (tiles >= MIN_TILES && Date.now() - lastChange >= QUIET_MS) {
    break;
  }
  await new Promise((r) => setTimeout(r, 250));
}
const elapsedMs = Date.now() - started;
const lanes = await page.evaluate(() => {
  const counts = {};
  for (const tile of document.querySelectorAll('.leaflet-tile-loaded')) {
    const lane = tile.dataset.lane ?? 'none';
    counts[lane] = (counts[lane] ?? 0) + 1;
  }
  return counts;
});
await browser.close();

const laneOk = !expectLane || (Object.keys(lanes).length === 1 && lanes[expectLane] > 0);
const ok = tiles >= MIN_TILES && pageErrors.length === 0 && laneOk;
console.log(
  JSON.stringify(
    { ok, url, gpu: !noGpu, tiles_loaded: tiles, lanes, elapsed_ms: elapsedMs, page_errors: pageErrors },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
