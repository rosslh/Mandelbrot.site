// GPU periodicity-check variants for the G3 prototype (bench/page/gpu-perturb.js),
// LOG 2026-11-16. Renders each view's full visible grid (45 tiles of 200 px)
// from one GPU owner with every tile in flight, once per periodicity config,
// and reports median wall time next to the wasm fast lane on 7 workers.
// Output check: every config's values must equal the periodicity-off
// config's with the same zLo bit for bit (an exact state recurrence is a true
// cycle, so the check may only retire pixels that would have run out their
// budget); configs with a different zLo are counted against off-zlo.
//
//   node src/gpu-periodicity.mjs [--variant relaxed-now] [--rounds 5]
//     [--filter <s>] [--configs a,b] [--pool N] [--deep] [--json out.json]
//
// --deep adds grid-regression's z36-z48 views (G3's deeper targets).
//
// --pool N: time each config on N devices, each rendering one tile at a time
// (production's shape: one device per worker, 7 workers), instead of one
// device with every tile in flight.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isHardwareWebGPU, probeGpu } from "./gpu-probe.mjs";
import { caseToWasmArgs } from "./normalize.mjs";
import { startSession } from "./session.mjs";

const CASES = [
  { id: "adhoc-z9-i20000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 9, iterations: 20000 },
  { id: "adhoc-z11-i20000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 11, iterations: 20000 },
  { id: "grid-z20-i1600", re: "0.25301945209503174", im: "-0.00028127431869506836", zoom: 20, iterations: 1600 },
  { id: "adhoc-z24-i5000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 24, iterations: 5000 },
  { id: "grid-z28-i50000", re: "-0.6977273122174665", im: "-0.2589795459061861", zoom: 28, iterations: 50000 },
  // G3's deeper targets (grid-regression), timed only with --deep: precision
  // past ~z32 is gated separately (LOG 2026-11-15, held for Ross).
  { id: "grid-z36-i51200", re: "0.271743159228663032475", im: "-0.004861827620970871336", zoom: 36, iterations: 51200, deep: true },
  { id: "grid-z45-i6400", re: "-0.6173597732160516", im: "-0.4045964293189659", zoom: 45, iterations: 6400, deep: true },
  { id: "grid-z48-i48000", re: "0.2500612710671293", im: "-7.752127428872768e-7", zoom: 48, iterations: 48000, deep: true },
  { id: "grid-z47-i50000", re: "-1.7723767931915395", im: "0.00439357468238466", zoom: 47, iterations: 50000, deep: true },
];

const CONFIGS = {
  off: { periodicity: 0, mariani: false },
  branchless: { periodicity: 1, mariani: false },
  stride4: { periodicity: 4, mariani: false },
  stride32: { periodicity: 32, mariani: false },
  "off-zlo": { periodicity: 0, zLo: true, mariani: false },
  "branchless-zlo": { periodicity: 1, zLo: true, mariani: false },
  // GPU port of wasm's Mariani-Silver subdivision (LOG 2026-11-17). Fills
  // change output (by design, as in wasm), so its diff vs off counts flips.
  mariani: { periodicity: 1, leafPeriodicity: 1, mariani: true },
  "mariani-off": { periodicity: 0, leafPeriodicity: 0, mariani: true },
  // Shallow trees (LOG 2026-11-17): block-ring waves of these sizes, then
  // one leaf wave; leafPeriodicity 0 = no check in the leaf wave.
  "blocks25": { periodicity: 1, leafPeriodicity: 1, mariani: [25] },
  "blocks20": { periodicity: 1, leafPeriodicity: 1, mariani: [20] },
  blocks12: { periodicity: 1, leafPeriodicity: 1, mariani: [12] },
  "blocks40-20": { periodicity: 1, leafPeriodicity: 1, mariani: [40, 20] },
  "blocks20-off": { periodicity: 0, leafPeriodicity: 0, mariani: [20] },
  "blocks20-ringp": { periodicity: 1, leafPeriodicity: 0, mariani: [20] },
  "blocks12-ringp": { periodicity: 1, leafPeriodicity: 0, mariani: [12] },
};

function parseArgs(argv) {
  const opts = { variant: "relaxed-now", rounds: 5, filter: null, json: null, configs: null, pool: 1, deep: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variant") opts.variant = argv[++i];
    else if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--configs") opts.configs = argv[++i].split(",");
    else if (arg === "--pool") opts.pool = Number(argv[++i]);
    else if (arg === "--deep") opts.deep = true;
    else if (arg === "--json") opts.json = resolve(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

function visibleTiles(tileZoom) {
  const center = 0.64 * 2 ** tileZoom;
  const tiles = [];
  for (let y = Math.floor(center - 2.25); y <= Math.floor(center + 2.25); y++)
    for (let x = Math.floor(center - 4); x <= Math.floor(center + 4); x++) tiles.push({ x, y });
  return tiles;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = CASES.filter((c) => (opts.filter ? c.id.includes(opts.filter) : opts.deep || !c.deep));
  const configs = Object.fromEntries(
    Object.entries(CONFIGS).filter(([k]) => k === "off" || k === "off-zlo" || !opts.configs || opts.configs.includes(k)),
  );
  const session = await startSession([]);
  const out = { variant: opts.variant, configs, cases: [] };
  try {
    const report = await probeGpu(session.browser);
    if (!isHardwareWebGPU(report)) throw new Error("No hardware WebGPU adapter");
    out.adapter = `${report.webgpu?.vendor} / ${report.webgpu?.architecture}`;
    console.log(`adapter: ${out.adapter}`);
    await session.page.evaluate(
      async (configs, wasmPath, poolSize) => {
        const mod = await import("/bench/page/gpu-perturb.js");
        const lanes = {};
        const gpuPools = {};
        for (const [k, cfg] of Object.entries(configs)) {
          gpuPools[k] = [];
          for (let i = 0; i < poolSize; i++) gpuPools[k].push(await mod.createGpuLane(cfg));
          lanes[k] = gpuPools[k][0];
        }
        const workerSource = `
          let wasm;
          self.onmessage = async (e) => {
            const m = e.data;
            if (m.type === 'init') { wasm = await import(m.url); await wasm.default(); wasm.init();
              for (let i = 0; i < 2; i++) wasm.render_tile(m.warm).free(); self.postMessage('ready'); }
            else { wasm.render_tile(m.payload).free(); self.postMessage('done'); }
          };`;
        const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        const warm = {
          originRe: "-0.7436438870371587", originIm: "0.1318259042053119",
          bounds: { xMin: 655, xMax: 656, yMin: 655, yMax: 656, zoom: 10 }, zoomOffset: 0,
          maxIterations: 1000, power: 2, imageWidth: 64, imageHeight: 64, smoothColoring: true, includeValues: false,
          coloring: { palette: "turbo", colorDensity: 1, reverseColors: false, shiftHueAmount: 0, saturateAmount: 0, lightenAmount: 0, colorSpace: 2, paletteMinIter: 0, paletteMaxIter: 1000 },
        };
        const pool = [];
        for (let i = 0; i < 7; i++) {
          const w = new Worker(workerUrl, { type: "module" });
          await new Promise((res) => { w.onmessage = res; w.postMessage({ type: "init", url: new URL(wasmPath, location.href).href, warm }); });
          pool.push(w);
        }
        window.pp = { lanes, pool, gpuPools };
      },
      configs,
      `/bench/artifacts/${opts.variant}/pkg/mandelbrot.js`,
      opts.pool,
    );

    for (const c of cases) {
      const [base] = caseToWasmArgs(c, { exponent: 2, tileSize: 200, smoothColoring: true });
      const payloads = visibleTiles(base.bounds.zoom).map((t) => ({
        originRe: base.originRe, originIm: base.originIm,
        bounds: { xMin: t.x, xMax: t.x + 1, yMin: t.y, yMax: t.y + 1, zoom: base.bounds.zoom },
        zoomOffset: base.zoomOffset, maxIterations: c.iterations, power: 2,
        imageWidth: 200, imageHeight: 200, smoothColoring: true, includeValues: false,
        coloring: { palette: "turbo", colorDensity: 1, reverseColors: false, shiftHueAmount: 0, saturateAmount: 0, lightenAmount: 0, colorSpace: 2, paletteMinIter: 0, paletteMaxIter: c.iterations },
      }));
      // Output check, once per case, outside the timed rounds.
      const check = await session.page.evaluate(async (payloads, configs) => {
        const { lanes } = window.pp;
        const refs = {};
        for (const k of ["off", "off-zlo"])
          if (lanes[k]) refs[k] = await Promise.all(payloads.map((p) => lanes[k].renderValues(p)));
        const result = {};
        let interior = 0, total = 0;
        for (const r of refs.off) for (const v of r.values) { total++; if (v === Infinity) interior++; }
        result.interior = interior / total;
        for (const [k, lane] of Object.entries(lanes)) {
          if (k in refs) continue;
          const ref = configs[k].zLo ? refs["off-zlo"] : refs.off;
          if (!ref) continue;
          const got = await Promise.all(payloads.map((p) => lane.renderValues(p)));
          let diff = 0;
          got.forEach((g, t) => {
            const a = new Uint32Array(ref[t].values.buffer), b = new Uint32Array(g.values.buffer);
            for (let p = 0; p < a.length; p++) if (a[p] !== b[p]) diff++;
          });
          result[k] = diff;
        }
        return result;
      }, payloads, configs);
      const rounds = [];
      for (let r = 0; r < opts.rounds; r++) {
        rounds.push(
          await session.page.evaluate(async (payloads, poolSize) => {
            const { lanes, pool, gpuPools } = window.pp;
            const result = {};
            for (const [k, lane] of Object.entries(lanes)) {
              if (poolSize > 1) {
                const devices = gpuPools[k];
                await Promise.all(devices.map((d) => d.renderValues({ ...payloads[0], imageWidth: 2, imageHeight: 2 })));
                const t0 = performance.now();
                let next = 0;
                await Promise.all(devices.map(async (d) => {
                  while (next < payloads.length) await d.renderValues(payloads[next++]);
                }));
                result[k] = performance.now() - t0;
                continue;
              }
              await lane.renderValues({ ...payloads[0], imageWidth: 2, imageHeight: 2 });
              const t0 = performance.now();
              await Promise.all(payloads.map((p) => lane.renderValues(p)));
              result[k] = performance.now() - t0;
            }
            const t0 = performance.now();
            await new Promise((resolve) => {
              let next = 0, done = 0;
              const assign = (w) => {
                if (next >= payloads.length) return;
                const index = next++;
                w.onmessage = () => (++done === payloads.length ? resolve() : assign(w));
                w.postMessage({ type: "run", payload: payloads[index] });
              };
              pool.forEach(assign);
            });
            result.wasm = performance.now() - t0;
            return result;
          }, payloads, opts.pool),
        );
      }
      const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const row = { id: c.id, interior: check.interior, diffs: check, rounds, median: {} };
      for (const k of [...Object.keys(configs), "wasm"]) row.median[k] = med(rounds.map((r) => r[k]));
      out.cases.push(row);
      console.log(`\n${c.id} (interior ${(check.interior * 100).toFixed(1)}%)`);
      for (const [k, ms] of Object.entries(row.median)) {
        const d = k in check ? `  diff px vs off: ${check[k]}` : "";
        console.log(`  ${k.padEnd(12)} ${ms.toFixed(0).padStart(6)} ms${d}`);
      }
    }
  } finally {
    await session.close();
  }
  if (opts.json) writeFileSync(opts.json, JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
