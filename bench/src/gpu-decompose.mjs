// GPU-lane time decomposition (backlog G2, LOG 2026-11-13 "next run" item 2).
// Measures where a WebGPU lane tile's time goes, and whether one GPU owner
// beats per-worker devices, on the full visible tile grid of a view:
//
//   - lane start-up: requestAdapter, requestDevice, pipeline creation;
//   - per tile on one device, one tile at a time: CPU prep (coordinates +
//     writeBuffer + encode + submit), wait (kernel + copy + mapAsync
//     resolve), smoothing on the CPU, and wasm recolor;
//   - the fixed round trip: a 1-iteration tile (kernel ~0);
//   - grid wall time four ways: wasm on a 7-worker pool (the fast-lane
//     artifact, the baseline the lane must beat), GPU with one device per
//     worker (7 workers, what gpu.js does today), GPU from one owner with
//     every tile in flight at once (one device, one submit per tile), and
//     GPU from one owner with all tiles in one submit.
//
//   node src/gpu-decompose.mjs [--variant relaxed-now] [--filter <s>]
//     [--rounds 5] [--viewport 1600x900] [--json out.json]
//
// It loads client/js/gpu.js from the tree, instrumented in memory (string
// patches checked below; the client file is not changed), so the kernel is
// exactly the shipped one. Requires a hardware adapter (gpu-probe).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHardwareWebGPU, probeGpu } from "./gpu-probe.mjs";
import { caseToWasmArgs } from "./normalize.mjs";
import { startSession } from "./session.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(benchDir, "..");
const LAYOUT_TILE_PX = 200;

const ADHOC = [
  { id: "adhoc-z5-i500", re: "-0.75", im: "0.1", zoom: 5, iterations: 500 },
  { id: "adhoc-z9-i2000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 9, iterations: 2000 },
  { id: "adhoc-z11-i20000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 11, iterations: 20000 },
  { id: "grid-z20-i1600", re: "0.25301945209503174", im: "-0.00028127431869506836", zoom: 20, iterations: 1600 },
  { id: "adhoc-z24-i5000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 24, iterations: 5000 },
];

function parseArgs(argv) {
  const opts = { variant: "relaxed-now", filter: null, rounds: 5, viewport: { width: 1600, height: 900 }, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variant") opts.variant = argv[++i];
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--viewport") {
      const [w, h] = argv[++i].split("x").map(Number);
      opts.viewport = { width: w, height: h };
    } else if (arg === "--json") opts.json = resolve(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

function visibleTiles(tileZoom, viewport) {
  const center = 0.64 * 2 ** tileZoom;
  const halfX = viewport.width / (2 * LAYOUT_TILE_PX);
  const halfY = viewport.height / (2 * LAYOUT_TILE_PX);
  const tiles = [];
  for (let y = Math.floor(center - halfY); y <= Math.floor(center + halfY); y++)
    for (let x = Math.floor(center - halfX); x <= Math.floor(center + halfX); x++) tiles.push({ x, y });
  return tiles;
}

// gpu.js with timing marks spliced in. Each patch must match exactly once,
// so a change to gpu.js fails loudly here instead of timing the wrong span.
function instrumentedGpuSource() {
  let source = readFileSync(join(repoDir, "client", "js", "gpu.js"), "utf8");
  const patch = (from, to) => {
    const count = source.split(from).length - 1;
    if (count !== 1) throw new Error(`gpu.js patch point found ${count}x: ${from}`);
    source = source.replace(from, to);
  };
  const mark = "(globalThis.__gpuMarks ??= [])";
  patch(
    "  const adapter = await navigator.gpu.requestAdapter({",
    "  const __s0 = performance.now();\n  const adapter = await navigator.gpu.requestAdapter({",
  );
  patch(
    "  const device = await adapter.requestDevice();",
    "  const __s1 = performance.now();\n  const device = await adapter.requestDevice();\n  const __s2 = performance.now();",
  );
  patch(
    "  const uniform = device.createBuffer({",
    `  ${mark}.push({ kind: "init", adapter: __s1 - __s0, device: __s2 - __s1, pipeline: performance.now() - __s2 });\n  const uniform = device.createBuffer({`,
  );
  patch(
    "    const pixels = width * height;\n    await ensureCapacity(",
    "    const __t0 = performance.now();\n    const pixels = width * height;\n    await ensureCapacity(",
  );
  patch(
    "    await readback.mapAsync(GPUMapMode.READ, 0, pixels * 20);",
    "    const __t1 = performance.now();\n    await readback.mapAsync(GPUMapMode.READ, 0, pixels * 20);\n    const __t2 = performance.now();",
  );
  patch(
    "      return smoothValues(\n        raw,\n        pixels,\n        payload.maxIterations,\n        payload.smoothColoring,\n      );",
    `      const __r = smoothValues(raw, pixels, payload.maxIterations, payload.smoothColoring);\n      ${mark}.push({ kind: "tile", prep: __t1 - __t0, wait: __t2 - __t1, smooth: performance.now() - __t2 });\n      return __r;`,
  );
  source += "\nexport { SHADER, WORKGROUP, pixelCoordinates, smoothValues, tileOffset };\n";
  return source;
}

// Everything that runs in the page. Installed once; returns helpers on window.
async function installPage(page, gpuSource, wasmUrl) {
  await page.evaluate(
    async (src, wasmPath) => {
      const wasmUrl = new URL(wasmPath, location.href).href;
      const gpuUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      const gpu = await import(gpuUrl);
      const wasm = await import(wasmUrl);
      await wasm.default();
      wasm.init();
      window.dc = { gpu, wasm, gpuUrl, wasmUrl };

      const median = (xs) => {
        const s = [...xs].sort((a, b) => a - b);
        return s.length ? s[Math.floor(s.length / 2)] : NaN;
      };
      const sum = (xs) => xs.reduce((a, b) => a + b, 0);

      // Worker pool. kind "wasm": render_tile on the variant (production's
      // computeTile). kind "gpu": a gpu.js lane per worker, plus recolor.
      const workerSource = `
        let lane = null, wasm = null;
        self.onmessage = async (e) => {
          const m = e.data;
          try {
            if (m.type === 'init') {
              wasm = await import(m.wasmUrl); await wasm.default(); wasm.init();
              if (m.kind === 'gpu') {
                const gpu = await import(m.gpuUrl);
                lane = await gpu.createGpuLane();
                await lane.renderValues(m.warm);
              } else {
                for (let i = 0; i < 2; i++) wasm.render_tile(m.warmWasm).free();
              }
              self.postMessage({ type: 'ready', marks: globalThis.__gpuMarks ?? [] });
            } else if (m.type === 'run') {
              const t0 = performance.now();
              if (lane) {
                const { values } = await lane.renderValues(m.payload);
                const t1 = performance.now();
                wasm.recolor_tile(values, m.payload.coloring);
                self.postMessage({ type: 'result', ms: performance.now() - t0, recolor: performance.now() - t1 });
              } else {
                wasm.render_tile(m.payload).free();
                self.postMessage({ type: 'result', ms: performance.now() - t0, recolor: 0 });
              }
            }
          } catch (err) { self.postMessage({ type: 'error', message: String(err) }); }
        };`;
      const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
      window.dc.makePool = async (kind, size, warm, warmWasm) => {
        const t0 = performance.now();
        const workers = await Promise.all(
          Array.from({ length: size }, async () => {
            const w = new Worker(workerUrl, { type: "module" });
            const marks = await new Promise((res, rej) => {
              w.onmessage = (e) => (e.data.type === "ready" ? res(e.data.marks) : rej(new Error(e.data.message)));
              w.postMessage({ type: "init", kind, wasmUrl, gpuUrl, warm, warmWasm });
            });
            return { w, marks };
          }),
        );
        return { workers: workers.map((x) => x.w), initMarks: workers.flatMap((x) => x.marks), spawnMs: performance.now() - t0 };
      };
      window.dc.runPool = (pool, payloads) =>
        new Promise((resolve, reject) => {
          let next = 0, done = 0;
          const tiles = [];
          const start = performance.now();
          const assign = (w) => {
            if (next >= payloads.length) return;
            const index = next++;
            w.onmessage = (e) => {
              if (e.data.type !== "result") return reject(new Error(e.data.message));
              tiles[index] = e.data;
              if (++done === payloads.length) resolve({ wallMs: performance.now() - start, tiles });
              else assign(w);
            };
            w.postMessage({ type: "run", payload: payloads[index] });
          };
          pool.workers.forEach(assign);
        });

      // One GPU owner on the main thread: its own device, one buffer set per
      // tile, every tile's dispatch in flight at once. `oneSubmit` encodes
      // all tiles into a single command buffer.
      window.dc.makeOwner = async () => {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        const device = await adapter.requestDevice();
        const module = device.createShaderModule({ code: gpu.SHADER });
        const pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
        return { device, pipeline, sets: [] };
      };
      const TSS = 200 / 128;
      const tileBounds = (p) => {
        const oRe = Number.parseFloat(p.originRe) || 0;
        const oIm = Number.parseFloat(p.originIm) || 0;
        const b = p.bounds;
        return [
          oRe + gpu.tileOffset(b.xMin, b.zoom, p.zoomOffset),
          oRe + gpu.tileOffset(b.xMax, b.zoom, p.zoomOffset),
          oIm - gpu.tileOffset(b.yMin, b.zoom, p.zoomOffset),
          oIm - gpu.tileOffset(b.yMax, b.zoom, p.zoomOffset),
        ];
      };
      void TSS;
      window.dc.runOwner = async (owner, payloads, oneSubmit) => {
        const { device, pipeline } = owner;
        while (owner.sets.length < payloads.length) {
          const p = payloads[0];
          const px = p.imageWidth * p.imageHeight;
          const uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
          const values = device.createBuffer({ size: px * 20, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
          const readback = device.createBuffer({ size: px * 20, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
          const coords = device.createBuffer({ size: (p.imageWidth + p.imageHeight) * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
          const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: values } },
              { binding: 2, resource: { buffer: coords } },
            ],
          });
          owner.sets.push({ uniform, values, readback, coords, bindGroup });
        }
        const start = performance.now();
        const encoders = [];
        payloads.forEach((p, i) => {
          const s = owner.sets[i];
          const [reMin, reMax, imMax, imMin] = tileBounds(p);
          device.queue.writeBuffer(s.uniform, 0, new Uint32Array([p.imageWidth, p.imageHeight, p.maxIterations, 0]));
          device.queue.writeBuffer(s.coords, 0, gpu.pixelCoordinates(reMin, reMax, imMax, imMin, p.imageWidth, p.imageHeight));
          const enc = oneSubmit && encoders.length ? encoders[0] : device.createCommandEncoder();
          const pass = enc.beginComputePass();
          pass.setPipeline(pipeline);
          pass.setBindGroup(0, s.bindGroup);
          pass.dispatchWorkgroups(Math.ceil(p.imageWidth / gpu.WORKGROUP), Math.ceil(p.imageHeight / gpu.WORKGROUP));
          pass.end();
          enc.copyBufferToBuffer(s.values, 0, s.readback, 0, p.imageWidth * p.imageHeight * 20);
          if (!oneSubmit) device.queue.submit([enc.finish()]);
          else if (!encoders.length) encoders.push(enc);
        });
        if (oneSubmit) device.queue.submit([encoders[0].finish()]);
        const submitted = performance.now() - start;
        let firstDone = null;
        const cpu = [];
        await Promise.all(
          payloads.map(async (p, i) => {
            const s = owner.sets[i];
            const px = p.imageWidth * p.imageHeight;
            await s.readback.mapAsync(GPUMapMode.READ, 0, px * 20);
            firstDone ??= performance.now() - start;
            const c0 = performance.now();
            const raw = new Float32Array(s.readback.getMappedRange(0, px * 20));
            const { values } = gpu.smoothValues(raw, px, p.maxIterations, p.smoothColoring);
            s.readback.unmap();
            wasm.recolor_tile(values, p.coloring);
            cpu.push(performance.now() - c0);
          }),
        );
        return { wallMs: performance.now() - start, submitMs: submitted, firstDoneMs: firstDone, cpuMs: sum(cpu) };
      };

      // One device, one tile at a time: the instrumented gpu.js marks.
      window.dc.makeLane = async () => {
        globalThis.__gpuMarks = [];
        const lane = await gpu.createGpuLane();
        return { lane, init: globalThis.__gpuMarks[0] };
      };
      window.dc.runSequential = async (lane, payloads) => {
        globalThis.__gpuMarks = [];
        const recolor = [];
        const start = performance.now();
        for (const p of payloads) {
          const { values } = await lane.renderValues(p);
          const r0 = performance.now();
          wasm.recolor_tile(values, p.coloring);
          recolor.push(performance.now() - r0);
        }
        const marks = globalThis.__gpuMarks.filter((m) => m.kind === "tile");
        return {
          wallMs: performance.now() - start,
          prep: median(marks.map((m) => m.prep)),
          wait: median(marks.map((m) => m.wait)),
          waitSum: sum(marks.map((m) => m.wait)),
          smooth: median(marks.map((m) => m.smooth)),
          recolor: median(recolor),
        };
      };
      window.dc.wasmSequential = (payloads) => {
        const ms = [];
        for (const p of payloads) {
          const t0 = performance.now();
          wasm.render_tile(p).free();
          ms.push(performance.now() - t0);
        }
        return { median: median(ms), sum: sum(ms) };
      };
      return true;
    },
    gpuSource,
    wasmUrl,
  );
}

// The worker payload for one grid tile (render_tile's TileRenderOptions,
// which is also what gpu.js reads).
function tilePayload(base, tile, iterations) {
  return {
    originRe: base.originRe,
    originIm: base.originIm,
    bounds: { xMin: tile.x, xMax: tile.x + 1, yMin: tile.y, yMax: tile.y + 1, zoom: base.bounds.zoom },
    zoomOffset: base.zoomOffset,
    maxIterations: iterations,
    power: 2,
    imageWidth: 200,
    imageHeight: 200,
    smoothColoring: true,
    includeValues: false,
    coloring: {
      palette: "turbo",
      colorDensity: 1,
      reverseColors: false,
      shiftHueAmount: 0,
      saturateAmount: 0,
      lightenAmount: 0,
      colorSpace: 2,
      paletteMinIter: 0,
      paletteMaxIter: iterations,
    },
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const f = (x) => (x == null || Number.isNaN(x) ? "-" : x >= 100 ? x.toFixed(0) : x.toFixed(1));

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cases = ADHOC;
  if (opts.filter) cases = cases.filter((c) => c.id.includes(opts.filter));
  const session = await startSession([]);
  const out = { variant: opts.variant, cases: [] };
  try {
    const report = await probeGpu(session.browser);
    if (!isHardwareWebGPU(report)) throw new Error("No hardware WebGPU adapter");
    out.adapter = report.adapter ?? report;
    console.log(`adapter: ${JSON.stringify(out.adapter)}`);
    await installPage(session.page, instrumentedGpuSource(), `/bench/artifacts/${opts.variant}/pkg/mandelbrot.js`);

    const warmCase = tilePayload(
      { originRe: "-0.75", originIm: "0", bounds: { zoom: 2 }, zoomOffset: 0 },
      { x: 2.5, y: 2.4 },
      200,
    );
    warmCase.bounds = { xMin: 2.5, xMax: 3, yMin: 2.4, yMax: 2.9, zoom: 2 };
    const warmWasm = tilePayload(
      { originRe: "-0.7436438870371587", originIm: "0.1318259042053119", bounds: { zoom: 10 }, zoomOffset: 0 },
      { x: 655, y: 655 },
      1000,
    );
    warmWasm.imageWidth = warmWasm.imageHeight = 64;

    const poolSize = 7;
    const startup = await session.page.evaluate(async (warm, warmWasm, size) => {
      const lane = await window.dc.makeLane();
      const t0 = performance.now();
      const owner = await window.dc.makeOwner();
      const ownerMs = performance.now() - t0;
      await window.dc.runSequential(lane.lane, [warm]);
      const wasmPool = await window.dc.makePool("wasm", size, warm, warmWasm);
      const gpuPool = await window.dc.makePool("gpu", size, warm, warmWasm);
      window.state = { lane: lane.lane, owner, wasmPool, gpuPool };
      return {
        laneInit: lane.init,
        ownerInitMs: ownerMs,
        wasmPoolSpawnMs: wasmPool.spawnMs,
        gpuPoolSpawnMs: gpuPool.spawnMs,
        gpuPoolInit: gpuPool.initMarks.filter((m) => m.kind === "init"),
      };
    }, warmCase, warmWasm, poolSize);
    out.startup = startup;
    const initMed = (key) => median(startup.gpuPoolInit.map((m) => m[key]));
    console.log(
      `start-up: main-thread lane adapter ${f(startup.laneInit.adapter)} / device ${f(startup.laneInit.device)} / pipeline ${f(startup.laneInit.pipeline)} ms; ` +
        `7-worker pools spawn+warm: wasm ${f(startup.wasmPoolSpawnMs)} ms, gpu ${f(startup.gpuPoolSpawnMs)} ms ` +
        `(per worker median adapter ${f(initMed("adapter"))} / device ${f(initMed("device"))} / pipeline ${f(initMed("pipeline"))} ms)`,
    );

    for (const c of cases) {
      const [base] = caseToWasmArgs(c, { exponent: 2, tileSize: 200, smoothColoring: true });
      const tiles = visibleTiles(base.bounds.zoom, opts.viewport);
      const payloads = tiles.map((t) => tilePayload(base, t, c.iterations));
      const trivial = payloads.map((p) => ({ ...p, maxIterations: 1 }));
      const rounds = [];
      for (let r = 0; r < opts.rounds; r++) {
        rounds.push(
          await session.page.evaluate(async (payloads, trivial) => {
            const s = window.state;
            const seq = await window.dc.runSequential(s.lane, payloads);
            const fixed = await window.dc.runSequential(s.lane, trivial);
            const wasmSeq = window.dc.wasmSequential(payloads);
            const wasmPool = await window.dc.runPool(s.wasmPool, payloads);
            const gpuPool = await window.dc.runPool(s.gpuPool, payloads);
            const ownerMany = await window.dc.runOwner(s.owner, payloads, false);
            const ownerOne = await window.dc.runOwner(s.owner, payloads, true);
            return {
              seq,
              fixed,
              wasmSeq,
              wasmPoolMs: wasmPool.wallMs,
              gpuPoolMs: gpuPool.wallMs,
              gpuPoolTileMs: gpuPool.tiles.map((t) => t.ms),
              ownerMany,
              ownerOne,
            };
          }, payloads, trivial),
        );
      }
      const m = (fn) => median(rounds.map(fn));
      const row = {
        id: c.id,
        tiles: payloads.length,
        seqPrep: m((r) => r.seq.prep),
        seqWait: m((r) => r.seq.wait),
        seqSmooth: m((r) => r.seq.smooth),
        seqRecolor: m((r) => r.seq.recolor),
        seqWallMs: m((r) => r.seq.wallMs),
        fixedWait: m((r) => r.fixed.wait),
        wasmTileMs: m((r) => r.wasmSeq.median),
        wasmSeqSumMs: m((r) => r.wasmSeq.sum),
        wasmPoolMs: m((r) => r.wasmPoolMs),
        gpuPoolMs: m((r) => r.gpuPoolMs),
        gpuPoolTileMs: m((r) => median(r.gpuPoolTileMs)),
        ownerManyMs: m((r) => r.ownerMany.wallMs),
        ownerManyFirstMs: m((r) => r.ownerMany.firstDoneMs),
        ownerManySubmitMs: m((r) => r.ownerMany.submitMs),
        ownerManyCpuMs: m((r) => r.ownerMany.cpuMs),
        ownerOneMs: m((r) => r.ownerOne.wallMs),
        rounds,
      };
      out.cases.push(row);
      console.log(
        `\n${c.id}: ${row.tiles} tiles, ${opts.rounds} rounds (medians)\n` +
          `  one device, one tile at a time, per tile: prep ${f(row.seqPrep)} | wait (kernel+readback) ${f(row.seqWait)} | smooth ${f(row.seqSmooth)} | recolor ${f(row.seqRecolor)} ms; ` +
          `fixed round trip (1 iteration) ${f(row.fixedWait)} ms; grid ${f(row.seqWallMs)} ms\n` +
          `  wasm per tile ${f(row.wasmTileMs)} ms (single thread; sum ${f(row.wasmSeqSumMs)} ms)\n` +
          `  grid wall: wasm pool(7) ${f(row.wasmPoolMs)} | gpu per-worker(7) ${f(row.gpuPoolMs)} (tile ${f(row.gpuPoolTileMs)}) | ` +
          `one owner, all in flight ${f(row.ownerManyMs)} (first ${f(row.ownerManyFirstMs)}, encode+submit ${f(row.ownerManySubmitMs)}, cpu ${f(row.ownerManyCpuMs)}) | one owner, one submit ${f(row.ownerOneMs)} ms`,
      );
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
