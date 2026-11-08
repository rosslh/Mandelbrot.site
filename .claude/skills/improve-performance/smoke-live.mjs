#!/usr/bin/env node
// Post-deploy smoke test for /improve-performance: loads the live site in headless Chrome (the
// bench harness's Puppeteer) and checks that the map renders tiles without page errors.
// Every other host fails to resolve (the same --host-resolver-rules approach as run-e2e, which
// also covers workers; request interception is avoided because it stalls this client's worker
// spawns), so the visit sends no analytics and stays out of the real-view data the benchmark
// corpus is built from.
//
//   node .claude/skills/improve-performance/smoke-live.mjs [url]   (default https://mandelbrot.site/)
//
// Exit 0 with a JSON summary when at least MIN_TILES tiles finished and no page error fired;
// exit 1 otherwise.

import { createRequire } from 'node:module';

const require = createRequire(new URL('../../../bench/package.json', import.meta.url));
const puppeteer = require('puppeteer');

const url = process.argv[2] ?? 'https://mandelbrot.site/';
const host = new URL(url).hostname;
const MIN_TILES = 8;
const QUIET_MS = 2500; // the same "grid is done" rule as bench/src/run-e2e.mjs
const TIMEOUT_MS = 90_000;

const browser = await puppeteer.launch({
  headless: true,
  args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE ${host}, EXCLUDE www.mandelbrot.site, EXCLUDE mandelbrot.site`],
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
await browser.close();

const ok = tiles >= MIN_TILES && pageErrors.length === 0;
console.log(JSON.stringify({ ok, url, tiles_loaded: tiles, elapsed_ms: elapsedMs, page_errors: pageErrors }, null, 2));
process.exit(ok ? 0 : 1);
