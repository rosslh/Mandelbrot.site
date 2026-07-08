// THE STANDARD PERFORMANCE TEST: drives the actual built client (webpack
// bundle, real wasm, real Leaflet, real threads pool, real service worker) in
// Chrome via puppeteer, loads a shareable URL for each corpus case, and
// measures wall-clock time from navigation start to the last visible tile's
// done callback (Leaflet adds .leaflet-tile-loaded when a tile finishes).
// This includes everything a user experiences: bundle parse, worker spawn,
// wasm fetch/compile/tier-up, pool scheduling, canvas putImageData, and the
// tile-generation debounce.
//
// NOTE: variants here are COMPLETE CLIENT BUILDS (see build-dist.mjs), so a
// comparison includes every shipped difference between the two trees — client
// JS (e.g. pool sizing), service worker behavior, and wasm. To isolate a
// wasm-only change, build both dists from trees that differ only in that
// change, or corroborate with the wasm-level runners (run.mjs, run-grid.mjs).
//
// Usage:
//   node src/run-e2e.mjs --variants old,head
//     [--corpus corpus/grid-regression.json] [--filter <id-substring>]
//     [--viewport 1600x900] [--rounds 5] [--warmup 1] [--out results/....json]
//
// Per case x variant: 1 cold pass (first visit on a fresh origin: service
// worker install, uncached wasm compile), warmup passes, then measured passes
// interleaved across variants round-by-round. Each variant's dist is served
// on its own port (= its own origin, so caches and service workers never
// cross-contaminate). Off-localhost requests are blocked.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer";
import { validateCase } from "./normalize.mjs";
import { startServer } from "./server.mjs";
import { median, mad } from "./stats.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const QUIET_MS = 2500; // no new tile loads for this long = grid is done
const PASS_TIMEOUT_MS = 180000;

function parseArgs(argv) {
  const opts = {
    variants: null,
    corpus: join(benchDir, "corpus", "grid-regression.json"),
    filter: null,
    viewport: { width: 1600, height: 900 },
    rounds: 5,
    warmup: 1,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variants") opts.variants = argv[++i].split(",");
    else if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--viewport") {
      const [w, h] = argv[++i].split("x").map(Number);
      opts.viewport = { width: w, height: h };
    } else if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--warmup") opts.warmup = Number(argv[++i]);
    else if (arg === "--out") opts.out = resolve(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.variants || opts.variants.length === 0) {
    throw new Error("Usage: node src/run-e2e.mjs --variants a[,b,...] [options]");
  }
  return opts;
}

function readDistMeta(name) {
  const dir = join(benchDir, "artifacts", name);
  if (!existsSync(join(dir, "dist", "index.html"))) {
    throw new Error(
      `Variant "${name}" has no built dist; run: node src/build-dist.mjs ${name} [--ref <git-ref>]`,
    );
  }
  return JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
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

// Injected before every document: records performance.now() each time a
// Leaflet tile gains the leaflet-tile-loaded class (i.e. its done callback
// ran and the canvas holds pixels).
const TILE_TRACKER = `
  window.__tileBench = { total: 0, loaded: 0, lastLoadedAt: 0 };
  new MutationObserver(() => {
    const bench = window.__tileBench;
    const total = document.querySelectorAll(".leaflet-tile").length;
    const loaded = document.querySelectorAll(".leaflet-tile-loaded").length;
    if (loaded > bench.loaded) bench.lastLoadedAt = performance.now();
    bench.total = total;
    bench.loaded = loaded;
  }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
`;

async function measurePass(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PASS_TIMEOUT_MS });
  const deadline = Date.now() + PASS_TIMEOUT_MS;
  let last = { total: 0, loaded: 0, lastLoadedAt: 0 };
  let stableSince = Date.now();
  for (;;) {
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 250));
    const stats = await page.evaluate(() => window.__tileBench);
    if (
      stats.total !== last.total ||
      stats.loaded !== last.loaded ||
      stats.lastLoadedAt !== last.lastLoadedAt
    ) {
      stableSince = Date.now();
      last = stats;
    }
    const complete = last.total > 0 && last.loaded >= last.total;
    if (complete && Date.now() - stableSince >= QUIET_MS) {
      return { ms: last.lastLoadedAt, tileCount: last.total };
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Pass timed out: ${last.loaded}/${last.total} tiles loaded at ${url}`,
      );
    }
  }
}

function formatComparison(output) {
  const lines = [];
  const variants = output.meta.variantOrder;
  const base = variants[0];
  lines.push(
    `End-to-end: navigation → last tile done, real client dist in Chrome, ` +
      `viewport ${output.meta.viewport.width}x${output.meta.viewport.height} ` +
      `(complete-build comparison: includes client JS and service worker differences)`,
  );
  for (const caseResult of output.results) {
    lines.push(`\n${caseResult.caseId} (${caseResult.tileCount} tiles)`);
    const baseline = caseResult.variants[base];
    for (const name of variants) {
      const v = caseResult.variants[name];
      const med = median(v.samplesMs);
      const spread = mad(v.samplesMs);
      let delta = "";
      if (name !== base) {
        const baseMed = median(baseline.samplesMs);
        const pct = ((med - baseMed) / baseMed) * 100;
        const threshold = Math.max(3, (200 * (mad(baseline.samplesMs) + spread)) / baseMed);
        delta = `  ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs ${base}${Math.abs(pct) >= threshold ? " *" : ""}`;
        const coldPct = ((v.coldMs - baseline.coldMs) / baseline.coldMs) * 100;
        delta += `  (cold ${coldPct >= 0 ? "+" : ""}${coldPct.toFixed(1)}%)`;
      }
      lines.push(
        `  ${name.padEnd(10)} median ${med.toFixed(0)} ms ` +
          `(±${spread.toFixed(0)}, n=${v.samplesMs.length}, cold ${v.coldMs.toFixed(0)} ms)${delta}`,
      );
    }
  }
  for (const name of variants.slice(1)) {
    const ratios = output.results.map((caseResult) => {
      const baseMed = median(caseResult.variants[base].samplesMs);
      return median(caseResult.variants[name].samplesMs) / baseMed;
    });
    const geomean = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
    lines.push(
      `\n${name} vs ${base} overall geomean (nav → grid rendered): ${((geomean - 1) * 100).toFixed(1)}%`,
    );
  }
  const sizes = variants
    .map((name) => `${name} wasm ${(output.meta.variants[name].wasmSize / 1024).toFixed(1)} KiB`)
    .join(", ");
  lines.push(sizes);
  return lines.join("\n");
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
    if (problems.length > 0) {
      throw new Error(`Invalid case ${benchCase.id}: ${problems.join(", ")}`);
    }
  }

  const variantMetas = Object.fromEntries(
    opts.variants.map((name) => [name, readDistMeta(name)]),
  );
  const servers = {};
  for (const name of opts.variants) {
    servers[name] = await startServer({
      root: join(benchDir, "artifacts", name, "dist"),
      crossOriginIsolate: false,
    });
    console.log(`${name}: serving dist on port ${servers[name].port}`);
  }

  const browser = await puppeteer.launch({
    args: [
      // Fail DNS for everything except localhost: no telemetry, no external
      // fetches (ipapi.co, github buttons), no network noise. Page-level
      // request interception can't do this — it never sees requests made
      // inside dedicated workers and stalls them instead.
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      ...(process.env.CI ? ["--no-sandbox"] : []),
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ ...opts.viewport, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument(TILE_TRACKER);
  page.on("pageerror", (error) => console.error("[page error]", error.message));

  const chromeVersion = await browser.version();
  const results = [];
  try {
    for (const benchCase of cases) {
      console.log(`\n${benchCase.id} (z=${benchCase.zoom}, i=${benchCase.iterations})`);
      const perVariant = Object.fromEntries(
        opts.variants.map((name) => [name, { samplesMs: [], coldMs: 0, tileCounts: new Set() }]),
      );

      // Cold pass: first visit to this origin for perturbation regions the
      // orbit is fresh; for the very first case it is also SW install + first
      // wasm compile.
      for (const name of opts.variants) {
        const cold = await measurePass(page, caseUrl(servers[name].port, benchCase));
        perVariant[name].coldMs = cold.ms;
        perVariant[name].tileCounts.add(cold.tileCount);
        console.log(`  ${name.padEnd(10)} cold ${cold.ms.toFixed(0)} ms (${cold.tileCount} tiles)`);
      }

      for (let i = 0; i < opts.warmup; i++) {
        for (const name of opts.variants) {
          await measurePass(page, caseUrl(servers[name].port, benchCase));
        }
      }

      for (let round = 0; round < opts.rounds; round++) {
        for (const name of opts.variants) {
          const pass = await measurePass(page, caseUrl(servers[name].port, benchCase));
          perVariant[name].samplesMs.push(pass.ms);
          perVariant[name].tileCounts.add(pass.tileCount);
          console.log(
            `  round ${round + 1}/${opts.rounds} ${name.padEnd(10)} ${pass.ms.toFixed(0)} ms`,
          );
        }
      }

      const tileCounts = new Set(
        opts.variants.flatMap((name) => [...perVariant[name].tileCounts]),
      );
      if (tileCounts.size !== 1) {
        console.warn(
          `  WARNING: tile counts differ across passes/variants: ${[...tileCounts].join(", ")}`,
        );
      }

      results.push({
        caseId: benchCase.id,
        zoom: benchCase.zoom,
        iterations: benchCase.iterations,
        tileCount: [...tileCounts][0],
        variants: Object.fromEntries(
          opts.variants.map((name) => [
            name,
            {
              coldMs: perVariant[name].coldMs,
              samplesMs: perVariant[name].samplesMs,
              median: median(perVariant[name].samplesMs),
              mad: mad(perVariant[name].samplesMs),
            },
          ]),
        ),
      });
    }
  } finally {
    await browser.close();
    for (const name of opts.variants) servers[name].server.close();
  }

  const output = {
    meta: {
      date: new Date().toISOString(),
      kind: "e2e",
      chromeVersion,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      host: `${hostname()} ${platform()}/${arch()} ${cpus()[0]?.model ?? ""}`.trim(),
      cores: cpus().length,
      viewport: opts.viewport,
      rounds: opts.rounds,
      warmup: opts.warmup,
      filter: opts.filter,
      variantOrder: opts.variants,
      variants: variantMetas,
    },
    results,
  };

  const outPath =
    opts.out ??
    join(
      benchDir,
      "results",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-e2e-${opts.variants.join("_")}.json`,
    );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults written to ${outPath}`);
  console.log("\n" + formatComparison(output));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
