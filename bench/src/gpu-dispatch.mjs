// Worst-case GPU dispatch time for the WebGPU lane's perturbation kernel
// (G3 must-fix 2, bench/LOG.md 2026-11-19): the lane's work cap
// (gpu.js GPU_MAX_WORK = pixels x budget <= 2^32) was sized for df32, so this
// times single tiles at the cap's edge through the client lane itself
// (/client/js/gpu.js), alone and with N lanes (one device each, production's
// one-device-per-worker shape) rendering at once. A tile's wall time bounds
// its command buffer's GPU time, which is what a GPU watchdog cuts off.
//
//   node src/gpu-dispatch.mjs [--rounds 3] [--pool 7] [--filter <s>]
//
// Not a verdict run: it measures a bound, so a busy CPU only makes it
// pessimistic. It still refuses to run without a hardware adapter.

import { isHardwareWebGPU, probeGpu } from "./gpu-probe.mjs";
import { caseToWasmArgs } from "./normalize.mjs";
import { startSession } from "./session.mjs";

// Covered by the perturbation window (2^-65.5..2^-37.5 at these sizes) and
// at or near GPU_MAX_WORK. The cusp views put every pixel next to the
// parabolic point 0.25, where exterior pixels escape after ~pi / sqrt(eps)
// steps (far past the budget) and interior ones converge slowly, so few
// retire early; the pf64 grids are the heaviest real views.
const CASES = [
  { id: "cusp-z40-i100000", re: "0.25", im: "0", zoom: 40, iterations: 100000 },
  {
    id: "cusp-z40-i100000-off",
    re: "0.2500000000005",
    im: "0.0000000000003",
    zoom: 40,
    iterations: 100000,
  },
  { id: "cusp-z50-i100000", re: "0.25", im: "0", zoom: 50, iterations: 100000 },
  {
    id: "z47-i100000",
    re: "-1.7723767931915395",
    im: "0.00439357468238466",
    zoom: 47,
    iterations: 100000,
  },
  {
    id: "z48-i100000",
    re: "0.2500612710671293",
    im: "-7.752127428872768e-7",
    zoom: 48,
    iterations: 100000,
  },
  {
    id: "cusp-z40-512px-i16384",
    re: "0.25",
    im: "0",
    zoom: 40,
    iterations: 16384,
    tileSize: 512,
  },
];

function parseArgs(argv) {
  const opts = { rounds: 3, pool: 7, filter: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--pool") opts.pool = Number(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

function request(benchCase) {
  const [payload] = caseToWasmArgs(benchCase, {
    exponent: 2,
    tileSize: benchCase.tileSize ?? 200,
    smoothColoring: true,
  });
  return {
    originRe: payload.originRe,
    originIm: payload.originIm,
    bounds: payload.bounds,
    zoomOffset: payload.zoomOffset,
    maxIterations: payload.iterations,
    power: 2,
    imageWidth: payload.imageWidth,
    imageHeight: payload.imageHeight,
    smoothColoring: true,
    coloring: {},
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cases = CASES.filter((c) => !opts.filter || c.id.includes(opts.filter));
  const session = await startSession([]);
  try {
    const report = await probeGpu(session.browser);
    if (!isHardwareWebGPU(report))
      throw new Error("No hardware WebGPU adapter");
    console.log(
      `Adapter: ${report.adapter?.vendor ?? "?"} / ${report.adapter?.architecture ?? "?"}`,
    );
    await session.page.evaluate(async (pool) => {
      const module = await import("/client/js/gpu.js");
      window.gpuModule = module;
      window.lanes = [];
      for (let i = 0; i < pool; i++)
        window.lanes.push(await module.createGpuLane());
      // Renders `payload` on `count` lanes at once; per-lane wall times (ms)
      // and the steps the first lane's escapers counted.
      window.timeRender = async (payload, count) => {
        const times = await Promise.all(
          window.lanes.slice(0, count).map(async (lane) => {
            const start = performance.now();
            const result = await lane.renderValues(payload);
            const ms = performance.now() - start;
            let escaped = 0;
            let interior = 0;
            let steps = 0;
            for (const v of result.values) {
              if (Number.isFinite(v)) {
                escaped++;
                steps += Math.max(0, v);
              } else interior++;
            }
            return { ms, escaped, interior, steps };
          }),
        );
        return times;
      };
    }, opts.pool);

    for (const benchCase of cases) {
      const payload = request(benchCase);
      const covered = await session.page.evaluate(
        (p) => window.gpuModule.gpuCovers(p),
        payload,
      );
      const work =
        payload.imageWidth * payload.imageHeight * payload.maxIterations;
      if (!covered) {
        console.log(
          `${benchCase.id}: not covered (work 2^${Math.log2(work).toFixed(2)})`,
        );
        continue;
      }
      // First render builds the orbit and warms the pipelines.
      await session.page.evaluate((p) => window.timeRender(p, 1), payload);
      const solo = [];
      const pooled = [];
      let shape = null;
      for (let r = 0; r < opts.rounds; r++) {
        const [one] = await session.page.evaluate(
          (p) => window.timeRender(p, 1),
          payload,
        );
        solo.push(one.ms);
        shape = one;
        const many = await session.page.evaluate(
          (p, n) => window.timeRender(p, n),
          payload,
          opts.pool,
        );
        pooled.push(Math.max(...many.map((m) => m.ms)));
      }
      const max = (xs) => Math.max(...xs).toFixed(0);
      console.log(
        `${benchCase.id}: work 2^${Math.log2(work).toFixed(2)}, ` +
          `${shape.escaped} escapers / ${shape.interior} interior, ` +
          `escaper steps 2^${Math.log2(Math.max(1, shape.steps)).toFixed(2)} ` +
          `(>= ${(shape.steps / Math.min(...solo) / 1e6).toFixed(1)} Gstep/s solo); ` +
          `solo max ${max(solo)} ms, ${opts.pool} at once max ${max(pooled)} ms`,
      );
    }
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
