/* global GPUBufferUsage, GPUMapMode, GPUShaderStage */
// G3 precision prototype (bench only, never shipped): quadratic perturbation
// with plain-f32 pixel deltas around a reference orbit at the view origin,
// on WebGPU. Same module interface as client/js/gpu.js (createGpuLane,
// gpuCovers, renderValues), so bench/src/gpu-check.mjs can gate it against
// the pinned anchor with `--module /bench/page/gpu-perturb.js`.
//
// It mirrors perturbation.rs's perturbed_escape_iterations_f64 step for step:
// the reference orbit Z_n at the origin (here in BigInt fixed point, rounded
// to f32), dz' = (2Z + dz)dz + dc, z = Z_{n+1} + dz, and the same rebase rule
// (restart at Z_0 with dz = z when the orbit runs out or |z| < |dz|). The
// first step is not counted, so counts match the direct renderer's. Brent
// periodicity on (dz, n) retires interior pixels early. Smoothing is done on
// the CPU in f64. By default tiles render through a shallow GPU Mariani-Silver
// tree (marianiTree): rings of 20 px blocks first, then the pixels of every
// block whose ring is not all interior (LOG 2026-11-17).

const TILE_SPACE_SCALE = 200 / 128;
const ESCAPE_RADIUS = 3;
const MAX_ORBIT_LENGTH = 1 << 20;
const WORKGROUP = 8;

// One counted step: dz' = (2Z + dz)dz + dc, z = Z_{n+1} + dz, then rebase
// when the orbit runs out or |z| < |dz|.
const STEP = /* wgsl */ `
    let Z = orbit[n];
    let t = 2.0 * Z.xy + opaque(2.0 * Z.zw + dz);
    dz = vec2<f32>(t.x * dz.x - t.y * dz.y, t.x * dz.y + t.y * dz.x) + dc;
    n = n + 1u;
    let Zn = orbit[n];
    z = select(Zn.xy + dz, Zn.xy + opaque(Zn.zw + dz), Z_LO);
    if (n == last || dot(z, z) < dot(dz, dz)) { dz = z; n = 0u; }`;

// Per-iteration Brent periodicity on the full state (dz, n), as in
// perturbed_escape_iterations_f64: an exact recurrence of the computed state
// means this arithmetic cycles forever, so the pixel is interior (z is unused
// for interior pixels). Branchless (LOG 2026-11-16): the uncounted first step
// is peeled out of the loop, the cycle test is part of the loop's exit
// condition, and the save at each power-of-two i is a select. On grid-z28
// this costs ~+19% over no check, against +65% for a branch-and-break check.
const branchlessBody = /* wgsl */ `
  {${STEP}
  }
  var savedDz = dz;
  var savedN = n;
  var cycle = false;
  loop {
    if (dot(z, z) >= ${ESCAPE_RADIUS * ESCAPE_RADIUS}.0 || i >= params.maxIterations || cycle) { break; }
    i = i + 1u;${STEP}
    cycle = n == savedN && all(dz == savedDz);
    let save = (i & (i - 1u)) == 0u;
    savedDz = select(savedDz, dz, save);
    savedN = select(savedN, n, save);
  }
  if (cycle) { i = params.maxIterations; }`;

// No check (STRIDE 0) or a check every STRIDE iterations, saving at 2^k *
// STRIDE. Kept for measurement: strided checks cost about as much as the
// per-iteration one on the GPU and detect less (LOG 2026-11-16).
const stridedBody = /* wgsl */ `
  var first = true;
  var savedDz = vec2<f32>(0.0, 0.0);
  var savedN = 0u;
  var nextSave = 2u * STRIDE;
  loop {
    if (!first) {
      if (dot(z, z) >= ${ESCAPE_RADIUS * ESCAPE_RADIUS}.0 || i >= params.maxIterations) { break; }
      i = i + 1u;
    }${STEP}
    if (STRIDE > 0u) {
      if (first) {
        savedDz = dz; savedN = n;
      } else if (i % max(STRIDE, 1u) == 0u) {
        if (all(dz == savedDz) && n == savedN) { i = params.maxIterations; break; }
        if (i == nextSave) { savedDz = dz; savedN = n; nextSave = nextSave * 2u; }
      }
    }
    first = false;
  }`;

const NONE = 0xffffffff;
const SPLIT = 2;

const shader = (periodicity, zLo, mariani) => /* wgsl */ `
const STRIDE = ${periodicity}u;
// false: z = Z + dz adds Z's hi part only (the lo part stays in 2Z + dz).
const Z_LO = ${zLo};
// Mariani mode stores count + 1, so a cleared (0) slot means "not computed".
const COUNT_OFFSET = ${mariani ? 1 : 0}u;
const NONE = ${NONE}u;
const SPLIT = ${SPLIT}u;
struct Params { width: u32, height: u32, maxIterations: u32, orbitLen: u32, zero: u32, _p0: u32, _p1: u32, _p2: u32 };
struct Level { taskStart: u32, taskCount: u32, rectStart: u32, rectCount: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
// Z_n as (hi.re, hi.im, lo.re, lo.im): hi the nearest f32, lo the f32
// nearest the rest. The f32 rounding of Z is the same for every pixel, so
// dropping lo shifts the whole tile one way. Measured 2026-11-16: the lo part
// that matters is the one in the multiplier 2Z + dz (dropping it there
// reproduces the hi-only z38 imbalance, +2077/-921); dropping it from
// z = Z + dz (Z_LO false) leaves every fixed-corpus verdict unchanged.
@group(0) @binding(2) var<storage, read> orbit: array<vec4<f32>>;
// Per-axis pixel deltas from the origin: width real parts, then height
// imaginary parts.
@group(0) @binding(3) var<storage, read> dcs: array<f32>;
${mariani ? `
// Mariani-Silver wave tree (static per tile shape, see marianiTree): each
// task is (pixel, rect); rects are (x0, y0, x1, y1) with parent indices; one
// state word per rect per tile.
@group(0) @binding(4) var<storage, read> tasks: array<vec2<u32>>;
@group(0) @binding(5) var<storage, read> rects: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read> parents: array<u32>;
@group(0) @binding(7) var<storage, read_write> state: array<u32>;
@group(1) @binding(0) var<uniform> level: Level;` : ""}

// Opaque to the compiler (Metal compiles with fast math and would fold
// hi + (lo + dz) into (hi + lo) + dz = hi + dz).
fn opaque(x: vec2<f32>) -> vec2<f32> { return bitcast<vec2<f32>>(bitcast<vec2<u32>>(x) ^ vec2<u32>(params.zero)); }

fn iterate(dc: vec2<f32>, base: u32) -> u32 {
  let last = params.orbitLen - 1u;
  var n = 0u;
  var dz = vec2<f32>(0.0, 0.0);
  var z = vec2<f32>(0.0, 0.0);
  var i = 0u;
  ${periodicity === 1 ? branchlessBody : stridedBody}
  out[base] = i + COUNT_OFFSET;
  out[base + 1u] = bitcast<u32>(z.x);
  out[base + 2u] = bitcast<u32>(z.y);
  return i;
}

fn iteratePixel(x: u32, y: u32) -> u32 {
  return iterate(vec2<f32>(dcs[x], dcs[params.width + y]), 3u * (y * params.width + x));
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  iteratePixel(id.x, id.y);
}

${mariani ? `
fn isActive(rect: u32) -> bool {
  let p = parents[rect];
  return p == NONE || state[p] == SPLIT;
}

// One wave: compute this level's scheduled pixels (ring, or every pixel of a
// leaf) for rects whose parent split, skipping pixels already computed.
@compute @workgroup_size(64)
fn ring(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= level.taskCount) { return; }
  let task = tasks[level.taskStart + id.x];
  if (!isActive(task.y)) { return; }
  let base = 3u * task.x;
  if (out[base] != 0u) { return; }
  iterate(vec2<f32>(dcs[task.x % params.width], dcs[params.width + task.x / params.width]), base);
}

fn interiorAt(x: u32, y: u32) -> bool { return out[3u * (y * params.width + x)] == params.maxIterations + 1u; }

// After a wave: a rect whose whole ring is at the budget fills (its inside
// stays 0 = interior), any other active rect splits into its children.
@compute @workgroup_size(64)
fn classify(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= level.rectCount) { return; }
  let r = level.rectStart + id.x;
  if (!isActive(r)) { state[r] = 0u; return; }
  let b = rects[r];
  var all = true;
  for (var x = b.x; x < b.z && all; x++) { all = interiorAt(x, b.y) && interiorAt(x, b.w - 1u); }
  for (var y = b.y + 1u; y + 1u < b.w && all; y++) { all = interiorAt(b.x, y) && interiorAt(b.z - 1u, y); }
  state[r] = select(SPLIT, 1u, all);
}` : ""}
`;

const MARIANI_LEAF = 8;
const trees = new Map();

// The static Mariani-Silver rect tree of subdivide_tile_streamed (lib.rs)
// for one tile shape: midpoint quadrant splits, rects at or below
// MARIANI_LEAF in either dimension compute every pixel. Each level lists its
// rects and its tasks (pixel, rect): ring pixels, or all pixels for a leaf.
//
// `blocks` (an array of block sizes, e.g. [25]) builds a shallow tree
// instead, with fewer and fatter waves: level 0 partitions the tile into
// blocks of blocks[0] px (ragged at the edges), each later size partitions
// its parent the same way, and the last level is one leaf per block that
// computes every pixel the rings above it left. A GPU wave costs its slowest
// pixel's latency, so the depth of wasm's tree costs more than its fills
// save on the GPU (LOG 2026-11-17).
function marianiTree(width, height, blocks = null) {
  const key = `${width}x${height}:${blocks ?? "wasm"}`;
  if (trees.has(key)) return trees.get(key);
  const rects = [];
  const parents = [];
  const levels = [];
  const partition = (r, size) => {
    const out = [];
    for (let y0 = r.y0; y0 < r.y1; y0 += size)
      for (let x0 = r.x0; x0 < r.x1; x0 += size)
        out.push({ x0, y0, x1: Math.min(r.x1, x0 + size), y1: Math.min(r.y1, y0 + size) });
    return out;
  };
  let pending = blocks
    ? partition({ x0: 0, y0: 0, x1: width, y1: height }, blocks[0]).map((r) => ({ ...r, parent: NONE, depth: 0 }))
    : [{ x0: 0, y0: 0, x1: width, y1: height, parent: NONE }];
  const tasks = [];
  // Every ancestor of an active rect was active, so a pixel on an earlier
  // level's ring is always computed before this level runs: list each pixel
  // once, at the first level that schedules it (no idle lanes on re-listed
  // pixels).
  const scheduled = new Uint8Array(width * height);
  const schedule = (pixel, id) => {
    if (scheduled[pixel]) return;
    scheduled[pixel] = 1;
    tasks.push(pixel, id);
  };
  while (pending.length) {
    const rectStart = rects.length;
    const taskStart = tasks.length / 2;
    const next = [];
    for (const r of pending) {
      const id = rects.length / 4;
      rects.push(r.x0, r.y0, r.x1, r.y1);
      parents.push(r.parent);
      const leaf = blocks
        ? r.depth === blocks.length || r.x1 - r.x0 <= 2 || r.y1 - r.y0 <= 2
        : r.x1 - r.x0 <= MARIANI_LEAF || r.y1 - r.y0 <= MARIANI_LEAF;
      for (let y = r.y0; y < r.y1; y++) {
        if (leaf || y === r.y0 || y === r.y1 - 1) for (let x = r.x0; x < r.x1; x++) schedule(y * width + x, id);
        else {
          schedule(y * width + r.x0, id);
          if (r.x1 - r.x0 > 1) schedule(y * width + r.x1 - 1, id);
        }
      }
      if (leaf) continue;
      if (blocks) {
        const children = r.depth + 1 < blocks.length ? partition(r, blocks[r.depth + 1]) : [{ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 }];
        for (const c of children) next.push({ ...c, parent: id, depth: r.depth + 1 });
      } else {
        const xm = (r.x0 + r.x1) >> 1;
        const ym = (r.y0 + r.y1) >> 1;
        next.push(
          { x0: r.x0, y0: r.y0, x1: xm, y1: ym, parent: id },
          { x0: xm, y0: r.y0, x1: r.x1, y1: ym, parent: id },
          { x0: r.x0, y0: ym, x1: xm, y1: r.y1, parent: id },
          { x0: xm, y0: ym, x1: r.x1, y1: r.y1, parent: id },
        );
      }
    }
    levels.push({ taskStart, taskCount: tasks.length / 2 - taskStart, rectStart: rectStart / 4, rectCount: rects.length / 4 - rectStart / 4 });
    pending = next;
  }
  const tree = { tasks: Uint32Array.from(tasks), rects: Uint32Array.from(rects), parents: Uint32Array.from(parents), levels };
  trees.set(key, tree);
  return tree;
}

// Decimal string -> BigInt fixed point with `bits` fraction bits.
function toFixed(text, bits) {
  let s = text.trim();
  let negative = false;
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);
  let exponent = 0;
  const e = s.search(/e/i);
  if (e >= 0) {
    exponent = Number(s.slice(e + 1));
    s = s.slice(0, e);
  }
  const [whole, fraction = ""] = s.split(".");
  let digits = BigInt((whole || "0") + fraction);
  let scale = fraction.length - exponent;
  let value;
  if (scale >= 0) value = (digits << BigInt(bits)) / 10n ** BigInt(scale);
  else value = (digits * 10n ** BigInt(-scale)) << BigInt(bits);
  return negative ? -value : value;
}

// Z_0 = 0, Z_1 = c, ... until |Z|^2 > R^2 or `length` entries, rounded to
// f32 pairs (compute_reference_orbit's shape).
function referenceOrbit(originRe, originIm, bits, length) {
  const B = BigInt(bits);
  const cr = toFixed(originRe, bits);
  const ci = toFixed(originIm, bits);
  const toNumber = (x) => {
    const shift = B - 60n;
    return Number(shift > 0n ? x >> shift : x << -shift) * 2 ** -60;
  };
  const values = [0, 0, 0, 0];
  let zr = cr;
  let zi = ci;
  while (values.length / 4 <= length) {
    const r = toNumber(zr);
    const im = toNumber(zi);
    values.push(Math.fround(r), Math.fround(im), Math.fround(r - Math.fround(r)), Math.fround(im - Math.fround(im)));
    if (r * r + im * im > ESCAPE_RADIUS * ESCAPE_RADIUS) break;
    const zr2 = (zr * zr) >> B;
    const zi2 = (zi * zi) >> B;
    const zri = (zr * zi) >> B;
    zr = zr2 - zi2 + cr;
    zi = 2n * zri + ci;
  }
  return Float32Array.from(values);
}

function tileCoordinateOffset(coordinate, tileZoom) {
  return coordinate * TILE_SPACE_SCALE * 2 ** -(tileZoom - 2) - 4;
}

export function gpuCovers(payload) {
  const coloring = payload.coloring ?? {};
  return (
    payload.power === 2 &&
    !coloring.distanceEstimate &&
    !coloring.atomDomain &&
    payload.imageWidth > 1 &&
    payload.imageHeight > 1 &&
    payload.bounds.zoom + payload.zoomOffset >= 13 &&
    payload.bounds.zoom + payload.zoomOffset <= 45
  );
}

// periodicity: 1 = per-iteration branchless check (default), 0 = none, N > 1
// = a check every N iterations. zLo: add Z's lo part in z = Z + dz too.
// mariani: true renders through the GPU port of wasm's Mariani-Silver
// subdivision (one ring dispatch and one classify dispatch per wave, all in
// one pass); an array of block sizes uses marianiTree's shallow tree.
// leafPeriodicity: periodicity for the last (leaf) wave (mariani mode only).
// Defaults (LOG 2026-11-17): 20 px block rings with periodicity, then a leaf
// wave without it (fills already retire interior blocks). Pass
// `mariani: false` for brute force.
export async function createGpuLane({ periodicity = 1, zLo = false, mariani = [20], leafPeriodicity = 0 } = {}) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: shader(periodicity, zLo, mariani) });
  const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === "error");
  if (errors.length) throw new Error(errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join("\n"));
  const storage = (binding, type) => ({ binding, visibility: GPUShaderStage.COMPUTE, buffer: { type } });
  let pipeline, ringPipeline, leafPipeline, classifyPipeline, layout0, layout1;
  if (mariani) {
    layout0 = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        storage(1, "storage"),
        storage(2, "read-only-storage"),
        storage(3, "read-only-storage"),
        storage(4, "read-only-storage"),
        storage(5, "read-only-storage"),
        storage(6, "read-only-storage"),
        storage(7, "storage"),
      ],
    });
    layout1 = device.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } }] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [layout0, layout1] });
    [ringPipeline, classifyPipeline] = await Promise.all(
      ["ring", "classify"].map((entryPoint) => device.createComputePipelineAsync({ layout, compute: { module, entryPoint } })),
    );
    leafPipeline = ringPipeline;
    if (leafPeriodicity !== null && leafPeriodicity !== periodicity) {
      const leafModule = device.createShaderModule({ code: shader(leafPeriodicity, zLo, mariani) });
      leafPipeline = await device.createComputePipelineAsync({ layout, compute: { module: leafModule, entryPoint: "ring" } });
    }
  } else {
    pipeline = await device.createComputePipelineAsync({ layout: "auto", compute: { module, entryPoint: "main" } });
  }
  const treeBuffers = new Map();
  const gpuTree = (width, height) => {
    const key = `${width}x${height}`;
    const blocks = Array.isArray(mariani) ? mariani : null;
    if (treeBuffers.has(key)) return treeBuffers.get(key);
    const tree = marianiTree(width, height, blocks);
    const upload = (array) => {
      const buffer = device.createBuffer({ size: Math.max(16, array.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, array);
      return buffer;
    };
    const levels = tree.levels.map((l) => {
      const buffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, new Uint32Array([l.taskStart, l.taskCount, l.rectStart, l.rectCount]));
      return { ...l, bindGroup: device.createBindGroup({ layout: layout1, entries: [{ binding: 0, resource: { buffer } }] }) };
    });
    const result = { tasks: upload(tree.tasks), rects: upload(tree.rects), parents: upload(tree.parents), rectCount: tree.parents.length, levels };
    treeBuffers.set(key, result);
    return result;
  };
  let cached = null;

  const renderValues = async (payload) => {
    const { bounds, zoomOffset, imageWidth: width, imageHeight: height, maxIterations } = payload;
    const effectiveZoom = bounds.zoom + zoomOffset;
    const bits = Math.ceil((Math.max(0, effectiveZoom) + 64) / 32) * 32;
    const length = Math.min(maxIterations, MAX_ORBIT_LENGTH) + 1;
    const key = `${payload.originRe}|${payload.originIm}|${bits}|${length}`;
    if (!cached || cached.key !== key) {
      cached?.buffer.destroy();
      const orbit = referenceOrbit(payload.originRe, payload.originIm, bits, length);
      const buffer = device.createBuffer({ size: orbit.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buffer, 0, orbit);
      cached = { key, buffer, length: orbit.length / 4 };
    }
    // PerturbedFrame::new's offsets (linspace semantics), times 2^-zoomOffset.
    const scale = 2 ** -zoomOffset;
    const xMin = tileCoordinateOffset(bounds.xMin, bounds.zoom);
    const xMax = tileCoordinateOffset(bounds.xMax, bounds.zoom);
    const yMin = -tileCoordinateOffset(bounds.yMin, bounds.zoom);
    const yMax = -tileCoordinateOffset(bounds.yMax, bounds.zoom);
    const columnStep = (xMax - xMin) / (width - 1);
    const rowStep = (yMax - yMin) / (height - 1);
    const dcs = new Float32Array(width + height);
    for (let x = 0; x < width; x++) dcs[x] = (xMin + columnStep * x) * scale;
    for (let y = 0; y < height; y++) dcs[width + y] = (yMin + rowStep * y) * scale;

    const pixels = width * height;
    const uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const outBuffer = device.createBuffer({ size: pixels * 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const readback = device.createBuffer({ size: pixels * 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const dcBuffer = device.createBuffer({ size: dcs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Uint32Array([width, height, maxIterations, cached.length, 0, 0, 0, 0]));
    device.queue.writeBuffer(dcBuffer, 0, dcs);
    const entries = [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: { buffer: outBuffer } },
      { binding: 2, resource: { buffer: cached.buffer } },
      { binding: 3, resource: { buffer: dcBuffer } },
    ];
    const encoder = device.createCommandEncoder();
    let stateBuffer = null;
    if (mariani) {
      const tree = gpuTree(width, height);
      stateBuffer = device.createBuffer({ size: tree.rectCount * 4, usage: GPUBufferUsage.STORAGE });
      entries.push(
        { binding: 4, resource: { buffer: tree.tasks } },
        { binding: 5, resource: { buffer: tree.rects } },
        { binding: 6, resource: { buffer: tree.parents } },
        { binding: 7, resource: { buffer: stateBuffer } },
      );
      const bindGroup = device.createBindGroup({ layout: layout0, entries });
      encoder.clearBuffer(outBuffer);
      const pass = encoder.beginComputePass();
      pass.setBindGroup(0, bindGroup);
      tree.levels.forEach((l, k) => {
        pass.setBindGroup(1, l.bindGroup);
        pass.setPipeline(k + 1 < tree.levels.length ? ringPipeline : leafPipeline);
        pass.dispatchWorkgroups(Math.ceil(l.taskCount / 64));
        if (k + 1 < tree.levels.length) {
          pass.setPipeline(classifyPipeline);
          pass.dispatchWorkgroups(Math.ceil(l.rectCount / 64));
        }
      });
      pass.end();
    } else {
      const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries });
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
      pass.end();
    }
    encoder.copyBufferToBuffer(outBuffer, 0, readback, 0, pixels * 12);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    for (const b of [uniform, outBuffer, readback, dcBuffer, stateBuffer]) b?.destroy();
    const floats = new Float32Array(words.buffer);
    const values = new Float32Array(pixels);
    const lnR = Math.log(ESCAPE_RADIUS);
    let minIter = Infinity;
    let maxIter = -Infinity;
    for (let p = 0; p < pixels; p++) {
      // Mariani mode: 0 = inside a filled rect, else count + 1.
      const it = mariani ? words[3 * p] - 1 : words[3 * p];
      if (mariani ? words[3 * p] === 0 || it >= maxIterations : it >= maxIterations) {
        values[p] = Infinity;
        continue;
      }
      if (it < minIter) minIter = it;
      if (it > maxIter) maxIter = it;
      values[p] = payload.smoothColoring
        ? it - Math.log(Math.log(Math.hypot(floats[3 * p + 1], floats[3 * p + 2])) / lnR) / Math.LN2
        : it;
    }
    const escaped = maxIter >= 0;
    return { values, minIter: escaped ? minIter : null, maxIter: escaped ? maxIter : null };
  };
  return { renderValues, usable: true };
}
