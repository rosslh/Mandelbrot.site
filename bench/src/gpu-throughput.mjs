// GPU kernel throughput probe (backlog G2/G3 decision data, LOG 2026-11-15).
// Renders a view's full visible tile grid from one GPU owner (every tile in
// flight at once) with three kernels and reports iterations per second from
// each kernel's own escape counts, next to the wasm fast lane on a 7-worker
// pool over the same tiles:
//
//   df32         the shipped lane kernel (client/js/gpu.js SHADER);
//   f32-direct   the same loop in plain f32 (wrong past zoom ~12; speed only);
//   f32-perturb  G3's shape: plain-f32 deltas around a reference orbit read
//                from a storage buffer, with rebasing (orbit computed here in
//                f64 at the view centre; a throughput prototype, not a gate).
//
// The counts differ between kernels where precision differs, so compare
// Giter/s, not wall time, across kernels; compare wall time against wasm.
//
//   node src/gpu-throughput.mjs [--variant relaxed-now] [--rounds 5]
//     [--filter <s>] [--json out.json]

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHardwareWebGPU, probeGpu } from "./gpu-probe.mjs";
import { caseToWasmArgs } from "./normalize.mjs";
import { startSession } from "./session.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(benchDir, "..");

const CASES = [
  { id: "adhoc-z9-i20000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 9, iterations: 20000 },
  { id: "adhoc-z11-i20000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 11, iterations: 20000 },
  { id: "grid-z20-i1600", re: "0.25301945209503174", im: "-0.00028127431869506836", zoom: 20, iterations: 1600 },
  { id: "adhoc-z24-i5000", re: "-0.7436438870371587", im: "0.1318259042053119", zoom: 24, iterations: 5000 },
  { id: "grid-z28-i50000", re: "-0.6977273122174665", im: "-0.2589795459061861", zoom: 28, iterations: 50000 },
];

function parseArgs(argv) {
  const opts = { variant: "relaxed-now", rounds: 5, filter: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variant") opts.variant = argv[++i];
    else if (arg === "--rounds") opts.rounds = Number(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
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

const F32_DIRECT = (wg) => /* wgsl */ `
struct Params { width: u32, height: u32, maxIterations: u32, zero: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<storage, read> coords: array<vec2<f32>>;
@compute @workgroup_size(${wg}, ${wg})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let c = vec2<f32>(coords[id.x].x, coords[params.width + id.y].x);
  var z = c;
  var i = 0u;
  loop {
    let zr2 = z.x * z.x;
    let zi2 = z.y * z.y;
    if (zr2 + zi2 >= 9.0 || i >= params.maxIterations) { break; }
    z = vec2<f32>(zr2 - zi2 + c.x, 2.0 * z.x * z.y + c.y);
    i = i + 1u;
  }
  out[id.y * params.width + id.x] = i;
}`;

// dz' = (2Z + dz) dz + dc; z = Z[n] + dz; rebase to (dz = z, n = 0) when
// |z| < |dz| or the orbit ends (Zhuoran).
const F32_PERTURB = (wg) => /* wgsl */ `
struct Params { width: u32, height: u32, maxIterations: u32, orbitLen: u32,
  dcRe0: f32, dcIm0: f32, stepRe: f32, stepIm: f32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
@group(0) @binding(2) var<storage, read> orbit: array<vec2<f32>>;
@compute @workgroup_size(${wg}, ${wg})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let dc = vec2<f32>(params.dcRe0 + params.stepRe * f32(id.x), params.dcIm0 + params.stepIm * f32(id.y));
  var dz = vec2<f32>(0.0, 0.0);
  var n = 0u;
  var i = 0u;
  loop {
    if (i >= params.maxIterations) { break; }
    let Z = orbit[n];
    let t = 2.0 * Z + dz;
    dz = vec2<f32>(t.x * dz.x - t.y * dz.y + dc.x, t.x * dz.y + t.y * dz.x + dc.y);
    n = n + 1u;
    i = i + 1u;
    let z = orbit[n] + dz;
    let r = dot(z, z);
    if (r >= 9.0) { break; }
    if (r < dot(dz, dz) || n + 1u >= params.orbitLen) { dz = z; n = 0u; }
  }
  out[id.y * params.width + id.x] = i;
}`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let cases = CASES;
  if (opts.filter) cases = cases.filter((c) => c.id.includes(opts.filter));
  let gpuSource = readFileSync(join(repoDir, "client", "js", "gpu.js"), "utf8");
  gpuSource += "\nexport { SHADER, WORKGROUP, pixelCoordinates, tileOffset };\n";
  const session = await startSession([]);
  const out = { variant: opts.variant, cases: [] };
  try {
    const report = await probeGpu(session.browser);
    if (!isHardwareWebGPU(report)) throw new Error("No hardware WebGPU adapter");
    out.adapter = `${report.webgpu?.vendor} / ${report.webgpu?.architecture}`;
    console.log(`adapter: ${out.adapter}`);
    await session.page.evaluate(
      async (src, wasmPath, f32d, f32p) => {
        const gpu = await import(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
        const wasmUrl = new URL(wasmPath, location.href).href;
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        const device = await adapter.requestDevice();
        const pipe = async (code) =>
          device.createComputePipelineAsync({
            layout: "auto",
            compute: { module: device.createShaderModule({ code }), entryPoint: "main" },
          });
        const pipelines = {
          df32: await pipe(gpu.SHADER),
          "f32-direct": await pipe(f32d),
          "f32-perturb": await pipe(f32p),
        };
        const workerSource = `
          let wasm;
          self.onmessage = async (e) => {
            const m = e.data;
            if (m.type === 'init') { wasm = await import(m.url); await wasm.default(); wasm.init();
              for (let i = 0; i < 2; i++) wasm.render_tile(m.warm).free(); self.postMessage('ready'); }
            else { wasm.render_tile(m.payload).free(); self.postMessage('done'); }
          };`;
        const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
        const pool = [];
        const protoModule = await import("/bench/page/gpu-perturb.js");
        const proto = await protoModule.createGpuLane();
        window.protoStrides = {};
        for (const stride of [0, 32]) window.protoStrides[stride] = await protoModule.createGpuLane({ periodicity: stride });
        window.tp = { gpu, device, pipelines, pool, wasmUrl, workerUrl, proto };
        return true;
      },
      gpuSource,
      `/bench/artifacts/${opts.variant}/pkg/mandelbrot.js`,
      F32_DIRECT(8),
      F32_PERTURB(8),
    );

    await session.page.evaluate(async () => {
      const { pool, workerUrl, wasmUrl } = window.tp;
      const warm = {
        originRe: "-0.7436438870371587", originIm: "0.1318259042053119",
        bounds: { xMin: 655, xMax: 656, yMin: 655, yMax: 656, zoom: 10 }, zoomOffset: 0,
        maxIterations: 1000, power: 2, imageWidth: 64, imageHeight: 64, smoothColoring: true, includeValues: false,
        coloring: { palette: "turbo", colorDensity: 1, reverseColors: false, shiftHueAmount: 0, saturateAmount: 0, lightenAmount: 0, colorSpace: 2, paletteMinIter: 0, paletteMaxIter: 1000 },
      };
      for (let i = 0; i < 7; i++) {
        const w = new Worker(workerUrl, { type: "module" });
        await new Promise((res) => { w.onmessage = res; w.postMessage({ type: "init", url: wasmUrl, warm }); });
        pool.push(w);
      }
    });

    for (const c of cases) {
      const [base] = caseToWasmArgs(c, { exponent: 2, tileSize: 200, smoothColoring: true });
      const payloads = visibleTiles(base.bounds.zoom).map((t) => ({
        originRe: base.originRe, originIm: base.originIm,
        bounds: { xMin: t.x, xMax: t.x + 1, yMin: t.y, yMax: t.y + 1, zoom: base.bounds.zoom },
        zoomOffset: base.zoomOffset, maxIterations: c.iterations, power: 2,
        imageWidth: 200, imageHeight: 200, smoothColoring: true, includeValues: false,
        coloring: { palette: "turbo", colorDensity: 1, reverseColors: false, shiftHueAmount: 0, saturateAmount: 0, lightenAmount: 0, colorSpace: 2, paletteMinIter: 0, paletteMaxIter: c.iterations },
      }));
      const rounds = [];
      for (let r = 0; r < opts.rounds; r++) {
        rounds.push(
          await session.page.evaluate(async (payloads) => {
            const { gpu, device, pipelines, pool } = window.tp;
            const W = 200, H = 200, PX = W * H;
            // Reference orbit at the view origin, f64, stored as f32.
            const p0 = payloads[0];
            const cRe = Number.parseFloat(p0.originRe), cIm = Number.parseFloat(p0.originIm);
            const maxIt = p0.maxIterations;
            const orbit = new Float32Array(2 * (maxIt + 2));
            let zr = 0, zi = 0, len = 1;
            for (let n = 0; n <= maxIt; n++) {
              orbit[2 * n] = zr; orbit[2 * n + 1] = zi; len = n + 1;
              if (zr * zr + zi * zi > 1e6) break;
              const t = zr * zr - zi * zi + cRe; zi = 2 * zr * zi + cIm; zr = t;
            }
            const orbitBuf = device.createBuffer({ size: orbit.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            device.queue.writeBuffer(orbitBuf, 0, orbit);
            const result = { orbitLen: len };
            for (const [name, pipeline] of Object.entries(pipelines)) {
              const stride = name === "df32" ? 5 : 1;
              const sets = payloads.map((p) => {
                const b = p.bounds;
                const reMin = cRe + gpu.tileOffset(b.xMin, b.zoom, p.zoomOffset);
                const reMax = cRe + gpu.tileOffset(b.xMax, b.zoom, p.zoomOffset);
                const imMax = cIm - gpu.tileOffset(b.yMin, b.zoom, p.zoomOffset);
                const imMin = cIm - gpu.tileOffset(b.yMax, b.zoom, p.zoomOffset);
                const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                const outBuf = device.createBuffer({ size: PX * 4 * stride, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
                const readback = device.createBuffer({ size: PX * 4 * stride, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
                let third;
                if (name === "f32-perturb") {
                  const u = new ArrayBuffer(32);
                  new Uint32Array(u, 0, 4).set([W, H, maxIt, len]);
                  new Float32Array(u, 16, 4).set([reMin - cRe, imMax - cIm, (reMax - reMin) / (W - 1), (imMin - imMax) / (H - 1)]);
                  device.queue.writeBuffer(uniform, 0, u);
                  third = orbitBuf;
                } else {
                  device.queue.writeBuffer(uniform, 0, new Uint32Array([W, H, maxIt, 0, 0, 0, 0, 0]));
                  third = device.createBuffer({ size: (W + H) * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
                  device.queue.writeBuffer(third, 0, gpu.pixelCoordinates(reMin, reMax, imMax, imMin, W, H));
                }
                const bindGroup = device.createBindGroup({
                  layout: pipeline.getBindGroupLayout(0),
                  entries: [
                    { binding: 0, resource: { buffer: uniform } },
                    { binding: 1, resource: { buffer: outBuf } },
                    { binding: 2, resource: { buffer: third } },
                  ],
                });
                return { outBuf, readback, bindGroup, uniform, third };
              });
              await device.queue.onSubmittedWorkDone();
              const t0 = performance.now();
              for (const s of sets) {
                const enc = device.createCommandEncoder();
                const pass = enc.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, s.bindGroup);
                pass.dispatchWorkgroups(W / 8, H / 8);
                pass.end();
                enc.copyBufferToBuffer(s.outBuf, 0, s.readback, 0, PX * 4 * stride);
                device.queue.submit([enc.finish()]);
              }
              await Promise.all(sets.map((s) => s.readback.mapAsync(GPUMapMode.READ)));
              const ms = performance.now() - t0;
              let iterSum = 0, interior = 0;
              for (const s of sets) {
                const u = new Uint32Array(s.readback.getMappedRange());
                for (let p = 0; p < PX; p++) {
                  const it = u[p * stride];
                  iterSum += it;
                  if (it >= maxIt) interior++;
                }
                s.readback.unmap();
                s.outBuf.destroy(); s.readback.destroy(); s.uniform.destroy();
                if (s.third !== orbitBuf) s.third.destroy();
              }
              result[name] = { ms, iterSum, interior: interior / (PX * sets.length) };
            }
            orbitBuf.destroy();
            // The G3 prototype module (hi/lo orbit, f64 smoothing), every
            // tile in flight on its one device. The orbit is built once
            // per view (cached), outside the timed span.
            await window.tp.proto.renderValues({ ...payloads[0], imageWidth: 2, imageHeight: 2 });
            const tp0 = performance.now();
            await Promise.all(payloads.map((p) => window.tp.proto.renderValues(p)));
            result.proto = { ms: performance.now() - tp0 };
            for (const [stride, lane] of Object.entries(window.protoStrides)) {
              await lane.renderValues({ ...payloads[0], imageWidth: 2, imageHeight: 2 });
              const ts = performance.now();
              await Promise.all(payloads.map((p) => lane.renderValues(p)));
              result[`proto${stride}`] = { ms: performance.now() - ts };
            }
            // wasm fast lane, 7 workers, FIFO.
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
            result.wasm = { ms: performance.now() - t0 };
            return result;
          }, payloads),
        );
      }
      const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
      const row = { id: c.id, tiles: payloads.length, orbitLen: rounds[0].orbitLen, rounds };
      for (const k of ["df32", "f32-direct", "f32-perturb", "proto", "proto0", "proto32", "wasm"]) row[k] = med(rounds.map((r) => r[k].ms));
      for (const k of ["df32", "f32-direct", "f32-perturb"]) {
        row[`${k}Giter`] = rounds[0][k].iterSum / 1e9;
        row[`${k}Interior`] = rounds[0][k].interior;
      }
      out.cases.push(row);
      const gs = (k) => `${row[k].toFixed(0)} ms, ${(row[`${k}Giter`] / (row[k] / 1000)).toFixed(1)} Giter/s, ${(row[`${k}Giter`] * 1000).toFixed(0)}M iter, ${(row[`${k}Interior`] * 100).toFixed(1)}% interior`;
      console.log(
        `\n${c.id} (${row.tiles} tiles, orbit ${row.orbitLen}):\n` +
          `  wasm pool(7)  ${row.wasm.toFixed(0)} ms  (${(row.df32Giter / (row.wasm / 1000)).toFixed(1)} Giter/s at df32's count)\n` +
          `  df32          ${gs("df32")}\n  f32-direct    ${gs("f32-direct")}\n  f32-perturb   ${gs("f32-perturb")}\n  proto (G3 prototype defaults + smoothing, one owner), branchless per-iteration periodicity: ${row.proto.toFixed(0)} ms; off ${row.proto0.toFixed(0)}, stride 32 ${row.proto32.toFixed(0)} ms`,
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
