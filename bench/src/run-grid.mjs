// Benchmarks the wall-clock time to render the ENTIRE visible tile grid for
// a view, the way production does it: a pool of real Web Workers (sized like
// client/js/MandelbrotMap.ts renderPoolSize(), hardwareConcurrency - 1, and
// held CONSTANT across variants), each running the wasm module, with tiles
// dispatched FIFO center-out the way Leaflet queues them. Each corpus case
// (a shareable-URL-style view: point + zoom + iterations) is expanded into
// the full set of 200px Leaflet tiles covering the viewport, exactly as
// client/js/MandelbrotLayer.ts lays them out around the origin point.
//
// The recorded metric per grid pass is the makespan: first dispatch to last
// tile completed. The summed per-tile wasm time (CPU time) is reported as a
// secondary metric; it excludes scheduling and worker contention.
//
// Usage:
//   node src/run-grid.mjs --variants old,head
//     [--corpus corpus/grid-regression.json] [--filter <id-substring>]
//     [--viewport 1600x900] [--pool N] [--rounds 5] [--warmup 1]
//     [--out results/....json]
//
// Per case x variant: 1 cold grid pass (fresh region: includes per-worker
// wasm tiering and reference-orbit computation, like a real first render),
// warmup passes, then measured passes interleaved across variants
// round-by-round so thermal drift hits all sides equally. Tile output hashes
// must be identical across passes within a variant.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseToWasmArgs, pathwayFor, validateCase } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";
import { median, mad } from "./stats.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Leaflet CSS tile size (MandelbrotLayer: tileSize: 200).
const LAYOUT_TILE_PX = 200;

function parseArgs(argv) {
  const opts = {
    variants: null,
    corpus: join(benchDir, "corpus", "grid-regression.json"),
    filter: null,
    viewport: { width: 1600, height: 900 },
    pool: null, // null = production sizing, decided in the page
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
    } else if (arg === "--pool") opts.pool = Number(argv[++i]);
    else if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--warmup") opts.warmup = Number(argv[++i]);
    else if (arg === "--out") opts.out = resolve(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.variants || opts.variants.length === 0) {
    throw new Error("Usage: node src/run-grid.mjs --variants a[,b,...] [options]");
  }
  return opts;
}

// The view is centered on the origin point, whose fractional tile coordinate
// at tile_zoom is 0.64 * 2^tile_zoom on both axes (see normalize.mjs /
// get_mandelbrot_image_precise docs). Leaflet creates every tile whose 200px
// square intersects the viewport rectangle around that center, and queues
// them sorted by distance from the center — replicate that order, since it
// affects how tiles pack onto the pool.
function visibleTiles(tileZoom, viewport) {
  const center = 0.64 * 2 ** tileZoom;
  const halfX = viewport.width / (2 * LAYOUT_TILE_PX);
  const halfY = viewport.height / (2 * LAYOUT_TILE_PX);
  const tiles = [];
  for (let y = Math.floor(center - halfY); y <= Math.floor(center + halfY); y++) {
    for (let x = Math.floor(center - halfX); x <= Math.floor(center + halfX); x++) {
      tiles.push({ x, y });
    }
  }
  tiles.sort(
    (a, b) =>
      (a.x + 0.5 - center) ** 2 +
      (a.y + 0.5 - center) ** 2 -
      ((b.x + 0.5 - center) ** 2 + (b.y + 0.5 - center) ** 2),
  );
  return tiles;
}

// caseToWasmArgs builds the 21-arg call for the origin tile; per grid tile we
// only swap the tile-rect bounds (args[2..5] = xMin, xMax, yMin, yMax).
function tileArgs(baseArgs, tile) {
  const args = baseArgs.slice();
  args[2] = tile.x;
  args[3] = tile.x + 1;
  args[4] = tile.y;
  args[5] = tile.y + 1;
  return args;
}

async function gridPass(page, variantIndex, tileArgsList) {
  const pass = await page.evaluate(
    (index, argsList) => window.runGridParallel(index, argsList),
    variantIndex,
    tileArgsList,
  );
  return {
    wallMs: pass.wallMs,
    perTileMs: pass.tiles.map((tile) => tile.ms),
    hashes: pass.tiles.map((tile) => tile.hash),
    cpuMs: pass.tiles.reduce((total, tile) => total + tile.ms, 0),
  };
}

function deltaLine(name, base, values, baseValues) {
  const med = median(values);
  const baseMed = median(baseValues);
  const pct = ((med - baseMed) / baseMed) * 100;
  const threshold = Math.max(3, (200 * (mad(baseValues) + mad(values))) / baseMed);
  return `  ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% vs ${base}${Math.abs(pct) >= threshold ? " *" : ""}`;
}

function formatGridComparison(output) {
  const lines = [];
  const variants = output.meta.variantOrder;
  const base = variants[0];
  lines.push(
    `Wall-clock grid render (pool of ${output.meta.pool.poolSize} workers, ` +
      `${output.meta.pool.cores} logical cores), viewport ${output.meta.viewport.width}x${output.meta.viewport.height}:`,
  );
  for (const caseResult of output.results) {
    lines.push(
      `\n${caseResult.caseId} [${caseResult.pathway}] ` +
        `${caseResult.gridCols}x${caseResult.gridRows} = ${caseResult.tileCount} tiles`,
    );
    const baseline = caseResult.variants[base];
    for (const name of variants) {
      const v = caseResult.variants[name];
      const med = median(v.wallsMs);
      const spread = mad(v.wallsMs);
      let delta = "";
      if (name !== base) {
        delta = deltaLine(name, base, v.wallsMs, baseline.wallsMs);
        const coldPct = ((v.coldWallMs - baseline.coldWallMs) / baseline.coldWallMs) * 100;
        delta += `  (cold ${coldPct >= 0 ? "+" : ""}${coldPct.toFixed(1)}%, cpu ${(((median(v.cpusMs) - median(baseline.cpusMs)) / median(baseline.cpusMs)) * 100).toFixed(1)}%)`;
      }
      lines.push(
        `  ${name.padEnd(10)} wall median ${med.toFixed(0)} ms ` +
          `(±${spread.toFixed(0)}, n=${v.wallsMs.length}, cold ${v.coldWallMs.toFixed(0)} ms, cpu ${median(v.cpusMs).toFixed(0)} ms)${delta}`,
      );
    }
    // Per-tile medians: flag the worst tile-level movers vs the base variant.
    // Under pool contention these are noisier than the sequential runner's,
    // so treat them as a smoke check, not a verdict.
    for (const name of variants.slice(1)) {
      const v = caseResult.variants[name];
      const movers = caseResult.tiles
        .map((tile, i) => {
          const baseMed = median(baseline.perTileSamplesMs[i]);
          const med = median(v.perTileSamplesMs[i]);
          return { tile, baseMed, med, pct: ((med - baseMed) / baseMed) * 100 };
        })
        .filter((m) => m.baseMed >= 1)
        .sort((a, b) => b.pct - a.pct);
      const worst = movers.slice(0, 3);
      if (worst.length > 0) {
        lines.push(
          `  worst tiles ${name} vs ${base}: ` +
            worst
              .map(
                (m) =>
                  `(${m.tile.x},${m.tile.y}) ${m.baseMed.toFixed(0)}→${m.med.toFixed(0)}ms ${m.pct >= 0 ? "+" : ""}${m.pct.toFixed(0)}%`,
              )
              .join(", "),
        );
      }
    }
  }
  // Overall geomean of per-case wall-time ratios vs base.
  for (const name of variants.slice(1)) {
    const ratios = output.results.map((caseResult) => {
      const baseMed = median(caseResult.variants[base].wallsMs);
      const med = median(caseResult.variants[name].wallsMs);
      return med / baseMed;
    });
    const geomean = Math.exp(ratios.reduce((a, r) => a + Math.log(r), 0) / ratios.length);
    lines.push(
      `\n${name} vs ${base} overall wall-clock geomean: ${((geomean - 1) * 100).toFixed(1)}%`,
    );
  }
  const sizes = variants
    .map((name) => `${name} ${(output.meta.variants[name].wasmSize / 1024).toFixed(1)} KiB`)
    .join(", ");
  lines.push(`wasm sizes: ${sizes}`);
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
    opts.variants.map((name) => [name, readVariantMeta(name)]),
  );

  const session = await startSession(opts.variants);
  const results = [];
  let poolInfo;
  try {
    poolInfo = await session.page.evaluate(
      (urls, poolSize) => window.loadWorkerPools(urls, poolSize),
      opts.variants.map((name) => `/bench/artifacts/${name}/pkg/mandelbrot.js`),
      opts.pool,
    );
    console.log(
      `Worker pools ready: ${poolInfo.count} variants x ${poolInfo.poolSize} workers ` +
        `(${poolInfo.cores} logical cores)`,
    );

    for (const benchCase of cases) {
      const [payload, baseArgs] = caseToWasmArgs(benchCase, corpus.defaults);
      const tileZoom = payload.bounds.zoom;
      const tiles = visibleTiles(tileZoom, opts.viewport);
      const tileArgsList = tiles.map((tile) => tileArgs(baseArgs, tile));
      const xs = new Set(tiles.map((tile) => tile.x));
      const ys = new Set(tiles.map((tile) => tile.y));
      const pathway = pathwayFor(benchCase.zoom, payload.exponent);
      console.log(
        `\n${benchCase.id} [${pathway}]: ${xs.size}x${ys.size} = ${tiles.length} tiles ` +
          `(tileZoom ${tileZoom}, zoomOffset ${payload.zoomOffset}, i=${benchCase.iterations})`,
      );

      const perVariant = Object.fromEntries(
        opts.variants.map((name) => [
          name,
          {
            wallsMs: [],
            cpusMs: [],
            coldWallMs: 0,
            coldCpuMs: 0,
            perTileSamplesMs: tiles.map(() => []),
            hashes: null,
          },
        ]),
      );

      // Cold pass per variant: fresh region on live workers, like panning to
      // a new spot (first render also pays wasm tiering in each worker).
      for (const [index, name] of opts.variants.entries()) {
        const cold = await gridPass(session.page, index, tileArgsList);
        perVariant[name].coldWallMs = cold.wallMs;
        perVariant[name].coldCpuMs = cold.cpuMs;
        perVariant[name].hashes = cold.hashes;
        console.log(
          `  ${name.padEnd(10)} cold wall ${cold.wallMs.toFixed(0)} ms (cpu ${cold.cpuMs.toFixed(0)} ms)`,
        );
      }

      for (let i = 0; i < opts.warmup; i++) {
        for (const [index] of opts.variants.entries()) {
          await gridPass(session.page, index, tileArgsList);
        }
      }

      for (let round = 0; round < opts.rounds; round++) {
        for (const [index, name] of opts.variants.entries()) {
          const pass = await gridPass(session.page, index, tileArgsList);
          const state = perVariant[name];
          state.wallsMs.push(pass.wallMs);
          state.cpusMs.push(pass.cpuMs);
          pass.perTileMs.forEach((ms, i) => state.perTileSamplesMs[i].push(ms));
          pass.hashes.forEach((hash, i) => {
            if (hash !== state.hashes[i]) {
              throw new Error(
                `Non-deterministic tile (${tiles[i].x},${tiles[i].y}) in ${benchCase.id} [${name}]`,
              );
            }
          });
          console.log(
            `  round ${round + 1}/${opts.rounds} ${name.padEnd(10)} wall ${pass.wallMs.toFixed(0)} ms (cpu ${pass.cpuMs.toFixed(0)} ms)`,
          );
        }
      }

      results.push({
        caseId: benchCase.id,
        pathway,
        zoom: benchCase.zoom,
        iterations: benchCase.iterations,
        gridCols: xs.size,
        gridRows: ys.size,
        tileCount: tiles.length,
        tiles,
        variants: perVariant,
      });
    }
  } finally {
    await session.close();
  }

  const output = {
    meta: {
      date: new Date().toISOString(),
      kind: "grid-parallel",
      chromeVersion: session.chromeVersion,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      host: `${hostname()} ${platform()}/${arch()} ${cpus()[0]?.model ?? ""}`.trim(),
      viewport: opts.viewport,
      pool: poolInfo,
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
      `${new Date().toISOString().replace(/[:.]/g, "-")}-grid-${opts.variants.join("_")}.json`,
    );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults written to ${outPath}`);
  console.log("\n" + formatGridComparison(output));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
