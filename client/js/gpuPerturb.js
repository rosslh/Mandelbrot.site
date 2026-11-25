/* global GPUBufferUsage, GPUMapMode, GPUShaderStage */
// WebGPU perturbation kernel (backlog G3), the deep half of the GPU lane in
// gpu.js. Ported from the bench prototype bench/page/gpu-perturb.js with the
// options its verdicts were taken on (bench/LOG.md 2026-11-16..18): plain-f32
// pixel deltas around a reference orbit at each tile's centre, the `split`
// multiplier step, branchless Brent periodicity in the ring waves, and the
// shallow Mariani-Silver block tree (20 px rings, then one leaf wave).
//
// It follows perturbation.rs's perturbed_escape_iterations_f64: the reference
// orbit Z_n at the reference (BigInt fixed point here, rounded to f32 hi + lo
// pairs), dz' = (2Z + dz)dz + dc evaluated in the split form below, z =
// Z_{n+1} + dz (Z's hi part only), and the same rebase rule (restart at Z_0 with dz = z when the orbit runs out or
// |z| < |dz|). The first step is not counted, so counts match the direct
// renderer's. Smoothing is done on the CPU in f64.
//
// Output is judged by the truth tier against sampled BigInt truth (Ross,
// 2026-11-17), so coverage starts at the measured anchor/truth crossover
// (pixel spacing 2^-37.5, bench/truth.json) and ends at zoom 60 at 200 px,
// the deepest fixed-corpus views the gate has passed (2026-11-18); f32 deltas
// also run out of exponent range far below it. The lane is not on for any
// view yet: see bench/LOG.md for what must hold before it is.

const TILE_SPACE_SCALE = 200 / 128;
const ESCAPE_RADIUS = 3;
const MAX_ORBIT_LENGTH = 1 << 20;

// Pixel-spacing window the kernel covers (see the header). The coarse end is
// truth.json's crossoverSpacingLog2; the fine end is spacing at zoom 60 on
// 200 px tiles (2^-65) with half a step of margin.
export const PERTURB_MAX_PIXEL_SPACING = 2 ** -37.5;
export const PERTURB_MIN_PIXEL_SPACING = 2 ** -65.5;

// wasm's direct/perturbation switch (perturbation.rs MIN_DIRECT_PIXEL_SPACING),
// used only to report the same precision tier the wasm would have, for the
// diagnostics overlay.
const MIN_DIRECT_PIXEL_SPACING = 2 ** -50;

const BLOCK = 20;
const NONE = 0xffffffff;
const SPLIT = 2;
const TREE_CACHE_LIMIT = 4;

// One counted step: dz' = 2Z_hi dz + ((2Z_lo + dz) dz + dc), z = Z_{n+1} + dz
// (Z's hi part only), then rebase when the orbit runs out or |z| < |dz|.
// The split form keeps Z_lo, which a rounded multiplier t = 2Z + dz drops the
// same way for every pixel while dz is far below ulp(2Z): a coherent error
// the truth tier's sign axis flags (LOG 2026-11-18). The barriers pin the
// evaluation order: Metal compiles with fast math and would otherwise fold
// (b + dc) into (a + b) + dc.
//
// The escape test is |Z + dz|^2 - R^2 ~= m_n + dz.(2Z_n + dz) >= 0 (Z's hi part
// in 2Z_n, an error of about 2 Z_lo dz), with m_n = |Z_n|^2 - R^2 taken exact
// from the BigInt orbit, and it runs before the rebase. On the rounded z it is
// wrong whenever dz is below ulp(Z) at the escape step (low-iteration deep
// views, whose whole tile escapes alongside the reference): z then loses dz,
// and every pixel of the tile gets the same answer (bench/LOG.md 2026-11-20).
// Where dz outgrows Z (only at a rebase) the margin form cancels large terms,
// and the rounded z is the more precise test, so the rebase branch uses it.
const STEP = /* wgsl */ `
    let Z = orbit[n];
    let h = 2.0 * Z.xy;
    let u = opaque(2.0 * Z.zw + dz);
    let a = opaque(vec2<f32>(h.x * dz.x - h.y * dz.y, h.x * dz.y + h.y * dz.x));
    dz = a + opaque(vec2<f32>(u.x * dz.x - u.y * dz.y, u.x * dz.y + u.y * dz.x) + dc);
    n = n + 1u;
    let Zn = orbit[n].xy;
    z = Zn + dz;
    esc = margin[n] + dot(2.0 * Zn + dz, dz);
    if (n == last || dot(z, z) < dot(dz, dz)) {
      if (dot(dz, dz) > dot(Zn, Zn)) { esc = dot(z, z) - ${ESCAPE_RADIUS * ESCAPE_RADIUS}.0; }
      dz = z;
      n = 0u;
    }`;

// Ring waves: per-iteration Brent periodicity on the full state (dz, n), as in
// perturbed_escape_iterations_f64. Branchless (LOG 2026-11-16): the uncounted
// first step is peeled, the cycle test is in the loop's exit condition, and
// the save at each power-of-two i is a select.
const PERIODIC_BODY = /* wgsl */ `
  {${STEP}
  }
  var savedDz = dz;
  var savedN = n;
  var cycle = false;
  loop {
    if (esc >= 0.0 || i >= params.maxIterations || cycle) { break; }
    i = i + 1u;${STEP}
    cycle = n == savedN && all(dz == savedDz);
    let save = (i & (i - 1u)) == 0u;
    savedDz = select(savedDz, dz, save);
    savedN = select(savedN, n, save);
  }
  if (cycle) { i = params.maxIterations; }`;

// Leaf wave: no periodicity (interior blocks were already filled by the rings,
// LOG 2026-11-17).
const PLAIN_BODY = /* wgsl */ `
  {${STEP}
  }
  loop {
    if (esc >= 0.0 || i >= params.maxIterations) { break; }
    i = i + 1u;${STEP}
  }`;

// Output words per pixel: count + 1 (0 = not computed, i.e. inside a filled
// block = interior), then the final z as two f32s.
const shader = (periodic) => /* wgsl */ `
const NONE = ${NONE}u;
const SPLIT = ${SPLIT}u;
struct Params { width: u32, height: u32, maxIterations: u32, orbitLen: u32, zero: u32, _p0: u32, _p1: u32, _p2: u32 };
struct Level { taskStart: u32, taskCount: u32, rectStart: u32, rectCount: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
// Z_n as (hi.re, hi.im, lo.re, lo.im).
@group(0) @binding(2) var<storage, read> orbit: array<vec4<f32>>;
// Per-axis pixel deltas from the origin: width real parts, then height
// imaginary parts.
@group(0) @binding(3) var<storage, read> dcs: array<f32>;
// Block tree (static per tile shape, see blockTree): tasks are (pixel, rect),
// rects are (x0, y0, x1, y1) with parent indices, one state word per rect.
@group(0) @binding(4) var<storage, read> tasks: array<vec2<u32>>;
@group(0) @binding(5) var<storage, read> rects: array<vec4<u32>>;
@group(0) @binding(6) var<storage, read> parents: array<u32>;
@group(0) @binding(7) var<storage, read_write> state: array<u32>;
// m_n = |Z_n|^2 - R^2, one per orbit entry (see STEP).
@group(0) @binding(8) var<storage, read> margin: array<f32>;
@group(1) @binding(0) var<uniform> level: Level;

fn opaque(x: vec2<f32>) -> vec2<f32> { return bitcast<vec2<f32>>(bitcast<vec2<u32>>(x) ^ vec2<u32>(params.zero)); }

fn iterate(dc: vec2<f32>, base: u32) {
  let last = params.orbitLen - 1u;
  var n = 0u;
  var dz = vec2<f32>(0.0, 0.0);
  var z = vec2<f32>(0.0, 0.0);
  var esc = -1.0;
  var i = 0u;
  ${periodic ? PERIODIC_BODY : PLAIN_BODY}
  out[base] = i + 1u;
  out[base + 1u] = bitcast<u32>(z.x);
  out[base + 2u] = bitcast<u32>(z.y);
}

fn isActive(rect: u32) -> bool {
  let p = parents[rect];
  return p == NONE || state[p] == SPLIT;
}

// One wave: this level's scheduled pixels (ring, or every remaining pixel of a
// leaf) for rects whose parent split.
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
// stays 0 = interior); any other active rect splits.
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
}
`;

// The shallow block tree for one tile shape: level 0 partitions the tile into
// BLOCK px blocks (ragged at the edges) and computes their rings; level 1 is
// one leaf per block that computes every pixel the ring left. Each pixel is
// listed once, at the first level that schedules it.
function blockTree(width, height) {
  const rects = [];
  const parents = [];
  const levels = [];
  const tasks = [];
  const scheduled = new Uint8Array(width * height);
  const schedule = (pixel, id) => {
    if (scheduled[pixel]) return;
    scheduled[pixel] = 1;
    tasks.push(pixel, id);
  };
  let pending = [];
  for (let y0 = 0; y0 < height; y0 += BLOCK)
    for (let x0 = 0; x0 < width; x0 += BLOCK)
      pending.push({
        x0,
        y0,
        x1: Math.min(width, x0 + BLOCK),
        y1: Math.min(height, y0 + BLOCK),
        parent: NONE,
        depth: 0,
      });
  while (pending.length) {
    const rectStart = rects.length / 4;
    const taskStart = tasks.length / 2;
    const next = [];
    for (const r of pending) {
      const id = rects.length / 4;
      rects.push(r.x0, r.y0, r.x1, r.y1);
      parents.push(r.parent);
      const leaf = r.depth === 1 || r.x1 - r.x0 <= 2 || r.y1 - r.y0 <= 2;
      for (let y = r.y0; y < r.y1; y++) {
        if (leaf || y === r.y0 || y === r.y1 - 1) {
          for (let x = r.x0; x < r.x1; x++) schedule(y * width + x, id);
        } else {
          schedule(y * width + r.x0, id);
          if (r.x1 - r.x0 > 1) schedule(y * width + r.x1 - 1, id);
        }
      }
      if (!leaf) next.push({ ...r, parent: id, depth: 1 });
    }
    levels.push({
      taskStart,
      taskCount: tasks.length / 2 - taskStart,
      rectStart,
      rectCount: rects.length / 4 - rectStart,
    });
    pending = next;
  }
  return {
    tasks: Uint32Array.from(tasks),
    rects: Uint32Array.from(rects),
    parents: Uint32Array.from(parents),
    levels,
  };
}

// Decimal string -> BigInt fixed point with `bits` fraction bits. Throws on
// anything that is not a plain decimal (the tile then renders through wasm).
function toFixed(text, bits) {
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(
    String(text).trim(),
  );
  if (!match || (match[2] === "" && (match[3] ?? "") === "")) {
    throw new Error(`Unparseable origin: ${text}`);
  }
  const [, sign, whole, fraction = "", exp = "0"] = match;
  const digits = BigInt((whole || "0") + fraction);
  const scale = fraction.length - Number(exp);
  if (Math.abs(scale) > 10000) throw new Error(`Origin out of range: ${text}`);
  const value =
    scale >= 0
      ? (digits << BigInt(bits)) / 10n ** BigInt(scale)
      : (digits * 10n ** BigInt(-scale)) << BigInt(bits);
  return sign === "-" ? -value : value;
}

// Z_0 = 0, Z_1 = c (fixed point with `bits` fraction bits), ... until |Z|^2 > R^2 or `length` + 1 entries (the
// prototype's shape, which the gate runs were taken on), as f32
// (hi.re, hi.im, lo.re, lo.im) quadruples, and the escape margins |Z_n|^2 -
// R^2, exact in fixed point before the f32 rounding.
function referenceOrbit(cr, ci, bits, length) {
  const B = BigInt(bits);
  const shift = B - 60n;
  const toNumber = (x) =>
    Number(shift > 0n ? x >> shift : x << -shift) * 2 ** -60;
  const values = new Float32Array(4 * (length + 1));
  const margins = new Float32Array(length + 1);
  const radius2 = BigInt(ESCAPE_RADIUS * ESCAPE_RADIUS) << B;
  margins[0] = -(ESCAPE_RADIUS * ESCAPE_RADIUS);
  let count = 1;
  let zr = cr;
  let zi = ci;
  while (count <= length) {
    const r = toNumber(zr);
    const im = toNumber(zi);
    const hr = Math.fround(r);
    const hi = Math.fround(im);
    values.set([hr, hi, Math.fround(r - hr), Math.fround(im - hi)], 4 * count);
    const zr2 = (zr * zr) >> B;
    const zi2 = (zi * zi) >> B;
    margins[count] = toNumber(zr2 + zi2 - radius2);
    count++;
    if (r * r + im * im > ESCAPE_RADIUS * ESCAPE_RADIUS) break;
    const zri = (zr * zi) >> B;
    zr = zr2 - zi2 + cr;
    zi = 2n * zri + ci;
  }
  return {
    values: values.subarray(0, 4 * count),
    margins: margins.subarray(0, count),
  };
}

function tileCoordinateOffset(coordinate, tileZoom) {
  return coordinate * TILE_SPACE_SCALE * 2 ** -(tileZoom - 2) - 4;
}

// Whether a request's pixel spacing is in the kernel's window. The caller
// (gpu.js gpuCovers) checks exponent, coloring method and work caps.
export function perturbCoversSpacing(spacing) {
  return (
    spacing <= PERTURB_MAX_PIXEL_SPACING && spacing >= PERTURB_MIN_PIXEL_SPACING
  );
}

// Creates the kernel's pipelines on an existing device. Resolves to
// { renderValues(payload, spacing) -> { values, minIter, maxIter, tier } }.
// Where the reference orbit sits. referenceBlock 0 puts it at the view
// origin, which stays put while the user pans and zooms (MandelbrotMap.ts
// re-centres it only at a Leaflet zoom rebase), so a tile K tiles away keeps
// only about 24 - log2(K * 200) sub-pixel bits in its f32 deltas. Measured
// with gpu-check --far on the 2026-11-19 holdout (z33-z60, bench/LOG.md
// 2026-11-25): one tile away already drops it from 35/40 to 30/40, and
// exact pixels from 62.8% to 50.5%. referenceBlock B > 0 puts it at the
// centre of the B x B block of tiles (aligned in tile coordinates at the
// tile's zoom) that holds the tile. B = 1, a reference per tile, gives 34/40
// and 62.8% exact at every distance, the same output whatever the origin;
// B = 4 already costs accuracy (56.9% exact at K = 0). The block centre is
// an exact dyadic offset from the origin, so the reference is exact in fixed
// point, and the pixel offsets from it are computed in f64 as before.
export const DEFAULT_REFERENCE_BLOCK = 1;

function referenceCoordinate(min, max, block) {
  if (!block) return null;
  // Integer tile coordinates at the tile's own zoom; the block holding the
  // tile's centre.
  return (Math.floor((min + max) / 2 / block) + 0.5) * block;
}

// Tile coordinate (a multiple of 1/2) -> fixed point offset from the origin
// with `bits` fraction bits: (c * 25 * 2^-(tileZoom + 2) - 4) * 2^-zoomOffset,
// exact (bits exceeds tileZoom + zoomOffset + 3 at every covered depth).
function fixedOffset(coordinate, tileZoom, zoomOffset, bits) {
  const twice = BigInt(Math.round(coordinate * 2));
  const unitShift = bits - tileZoom - 3 - zoomOffset;
  const offsetShift = bits - zoomOffset;
  if (unitShift < 0 || offsetShift < 0) throw new Error("Offset precision");
  return ((twice * 25n) << BigInt(unitShift)) - (4n << BigInt(offsetShift));
}

export async function createPerturbKernel(
  device,
  { referenceBlock = DEFAULT_REFERENCE_BLOCK } = {},
) {
  const storage = (binding, type) => ({
    binding,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type },
  });
  const layout0 = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
      storage(1, "storage"),
      storage(2, "read-only-storage"),
      storage(3, "read-only-storage"),
      storage(4, "read-only-storage"),
      storage(5, "read-only-storage"),
      storage(6, "read-only-storage"),
      storage(7, "storage"),
      storage(8, "read-only-storage"),
    ],
  });
  const layout1 = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "uniform" },
      },
    ],
  });
  const layout = device.createPipelineLayout({
    bindGroupLayouts: [layout0, layout1],
  });

  device.pushErrorScope("validation");
  const ringModule = device.createShaderModule({
    code: shader(true),
  });
  const leafModule = device.createShaderModule({
    code: shader(false),
  });
  const [ring, classify, leaf, initError] = await Promise.allSettled([
    device.createComputePipelineAsync({
      layout,
      compute: { module: ringModule, entryPoint: "ring" },
    }),
    device.createComputePipelineAsync({
      layout,
      compute: { module: ringModule, entryPoint: "classify" },
    }),
    device.createComputePipelineAsync({
      layout,
      compute: { module: leafModule, entryPoint: "ring" },
    }),
    device.popErrorScope(),
  ]);
  if (initError.status === "fulfilled" && initError.value) {
    throw new Error(`GPU shader error: ${initError.value.message}`);
  }
  for (const result of [ring, classify, leaf]) {
    if (result.status === "rejected") throw result.reason;
  }
  const ringPipeline = ring.value;
  const classifyPipeline = classify.value;
  const leafPipeline = leaf.value;

  const uniform = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  // Block trees per tile shape, with their level uniforms and state buffer.
  // Few shapes occur (tile size x supersampling); the cap bounds what odd
  // shapes (image exports) can pin.
  const trees = new Map();
  const destroyTree = (tree) => {
    for (const buffer of tree.buffers) buffer.destroy();
  };
  const treeFor = (width, height) => {
    const key = `${width}x${height}`;
    const hit = trees.get(key);
    if (hit) {
      trees.delete(key);
      trees.set(key, hit);
      return hit;
    }
    const tree = blockTree(width, height);
    const buffers = [];
    const upload = (array, usage) => {
      const buffer = device.createBuffer({
        size: Math.max(16, array.byteLength),
        usage: usage | GPUBufferUsage.COPY_DST,
      });
      buffers.push(buffer);
      device.queue.writeBuffer(buffer, 0, array);
      return buffer;
    };
    const levels = tree.levels.map((l) => {
      const buffer = upload(
        new Uint32Array([l.taskStart, l.taskCount, l.rectStart, l.rectCount]),
        GPUBufferUsage.UNIFORM,
      );
      return {
        ...l,
        bindGroup: device.createBindGroup({
          layout: layout1,
          entries: [{ binding: 0, resource: { buffer } }],
        }),
      };
    });
    const state = device.createBuffer({
      size: Math.max(16, tree.parents.length * 4),
      usage: GPUBufferUsage.STORAGE,
    });
    buffers.push(state);
    const entry = {
      tasks: upload(tree.tasks, GPUBufferUsage.STORAGE),
      rects: upload(tree.rects, GPUBufferUsage.STORAGE),
      parents: upload(tree.parents, GPUBufferUsage.STORAGE),
      state,
      levels,
      buffers,
    };
    trees.set(key, entry);
    if (trees.size > TREE_CACHE_LIMIT) {
      const [oldestKey, oldest] = trees.entries().next().value;
      trees.delete(oldestKey);
      destroyTree(oldest);
    }
    return entry;
  };

  // Reference orbits (see referenceBlock), most recently used last. With the
  // view origin as the reference there is one per worker, like wasm's
  // thread-local orbit cache; with block references a worker sees a few
  // blocks at once, so it keeps a few.
  const ORBIT_CACHE_LIMIT = referenceBlock ? 4 : 1;
  const orbits = new Map();
  const destroyOrbit = (entry) => {
    entry.buffer.destroy();
    entry.marginBuffer.destroy();
  };
  const orbitFor = (payload) => {
    const { bounds, zoomOffset } = payload;
    const effectiveZoom = bounds.zoom + zoomOffset;
    const bits = Math.ceil((Math.max(0, effectiveZoom) + 64) / 32) * 32;
    const length = Math.min(payload.maxIterations, MAX_ORBIT_LENGTH) + 1;
    const refX = referenceCoordinate(bounds.xMin, bounds.xMax, referenceBlock);
    const refY = referenceCoordinate(bounds.yMin, bounds.yMax, referenceBlock);
    const key =
      `${payload.originRe}|${payload.originIm}|${bits}|${length}|` +
      `${refX}|${refY}|${bounds.zoom}|${zoomOffset}`;
    const cached = orbits.get(key);
    if (cached) {
      orbits.delete(key);
      orbits.set(key, cached);
      return cached;
    }
    let cr = toFixed(payload.originRe, bits);
    let ci = toFixed(payload.originIm, bits);
    if (refX !== null) {
      cr += fixedOffset(refX, bounds.zoom, zoomOffset, bits);
      ci -= fixedOffset(refY, bounds.zoom, zoomOffset, bits);
    }
    const { values, margins } = referenceOrbit(cr, ci, bits, length);
    while (orbits.size >= ORBIT_CACHE_LIMIT) {
      const [oldestKey, oldest] = orbits.entries().next().value;
      orbits.delete(oldestKey);
      destroyOrbit(oldest);
    }
    const buffer = device.createBuffer({
      size: values.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(buffer, 0, values);
    const marginBuffer = device.createBuffer({
      size: Math.max(16, margins.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(marginBuffer, 0, margins);
    const entry = {
      key,
      buffer,
      marginBuffer,
      length: values.length / 4,
      // The reference's offset from the origin in unscaled tile space (the
      // units of tileCoordinateOffset), 0 at the origin.
      offsetRe: refX === null ? 0 : tileCoordinateOffset(refX, bounds.zoom),
      offsetIm: refY === null ? 0 : -tileCoordinateOffset(refY, bounds.zoom),
    };
    orbits.set(key, entry);
    return entry;
  };

  // Output, readback and delta buffers, reused across tiles and regrown when a
  // larger tile arrives (one tile is in flight per worker at a time).
  let capacity = 0;
  let axisCapacity = 0;
  let outBuffer = null;
  let readback = null;
  let dcBuffer = null;
  const ensureCapacity = async (pixels, axisLength) => {
    if (pixels <= capacity && axisLength <= axisCapacity) return;
    pixels = Math.max(pixels, capacity);
    axisLength = Math.max(axisLength, axisCapacity);
    outBuffer?.destroy();
    readback?.destroy();
    dcBuffer?.destroy();
    capacity = 0;
    axisCapacity = 0;
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    outBuffer = device.createBuffer({
      size: pixels * 12,
      usage:
        GPUBufferUsage.STORAGE |
        GPUBufferUsage.COPY_SRC |
        GPUBufferUsage.COPY_DST,
    });
    readback = device.createBuffer({
      size: pixels * 12,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    dcBuffer = device.createBuffer({
      size: Math.max(16, axisLength * 4),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const validationError = await device.popErrorScope();
    const memoryError = await device.popErrorScope();
    const allocationError = validationError ?? memoryError;
    if (allocationError) {
      throw new Error(
        `GPU buffer allocation failed: ${allocationError.message}`,
      );
    }
    capacity = pixels;
    axisCapacity = axisLength;
  };

  const renderValues = async (payload, spacing) => {
    const {
      bounds,
      zoomOffset,
      imageWidth: width,
      imageHeight: height,
      maxIterations,
    } = payload;
    const reference = orbitFor(payload);
    // PerturbedFrame::new's offsets (linspace semantics), times 2^-zoomOffset.
    const scale = 2 ** -zoomOffset;
    const xMin = tileCoordinateOffset(bounds.xMin, bounds.zoom);
    const xMax = tileCoordinateOffset(bounds.xMax, bounds.zoom);
    const yMin = -tileCoordinateOffset(bounds.yMin, bounds.zoom);
    const yMax = -tileCoordinateOffset(bounds.yMax, bounds.zoom);
    const columnStep = (xMax - xMin) / (width - 1);
    const rowStep = (yMax - yMin) / (height - 1);
    const dcs = new Float32Array(width + height);
    for (let x = 0; x < width; x++)
      dcs[x] = (xMin + columnStep * x - reference.offsetRe) * scale;
    for (let y = 0; y < height; y++)
      dcs[width + y] = (yMin + rowStep * y - reference.offsetIm) * scale;

    const pixels = width * height;
    await ensureCapacity(pixels, width + height);
    const tree = treeFor(width, height);
    device.queue.writeBuffer(
      uniform,
      0,
      new Uint32Array([
        width,
        height,
        maxIterations,
        reference.length,
        0,
        0,
        0,
        0,
      ]),
    );
    device.queue.writeBuffer(dcBuffer, 0, dcs);

    device.pushErrorScope("validation");
    const bindGroup = device.createBindGroup({
      layout: layout0,
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: outBuffer, size: pixels * 12 } },
        { binding: 2, resource: { buffer: reference.buffer } },
        { binding: 3, resource: { buffer: dcBuffer } },
        { binding: 4, resource: { buffer: tree.tasks } },
        { binding: 5, resource: { buffer: tree.rects } },
        { binding: 6, resource: { buffer: tree.parents } },
        { binding: 7, resource: { buffer: tree.state } },
        { binding: 8, resource: { buffer: reference.marginBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    encoder.clearBuffer(outBuffer, 0, pixels * 12);
    const pass = encoder.beginComputePass();
    pass.setBindGroup(0, bindGroup);
    tree.levels.forEach((l, k) => {
      const isLeaf = k + 1 === tree.levels.length;
      pass.setBindGroup(1, l.bindGroup);
      pass.setPipeline(isLeaf ? leafPipeline : ringPipeline);
      pass.dispatchWorkgroups(Math.ceil(l.taskCount / 64));
      if (!isLeaf) {
        pass.setPipeline(classifyPipeline);
        pass.dispatchWorkgroups(Math.ceil(l.rectCount / 64));
      }
    });
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readback, 0, pixels * 12);
    device.queue.submit([encoder.finish()]);
    const submitError = device.popErrorScope().catch(() => null);

    await readback.mapAsync(GPUMapMode.READ, 0, pixels * 12);
    let words;
    try {
      const error = await submitError;
      if (error) throw new Error(`GPU dispatch error: ${error.message}`);
      words = new Uint32Array(readback.getMappedRange(0, pixels * 12).slice(0));
    } finally {
      readback.unmap();
    }
    const floats = new Float32Array(words.buffer);
    const values = new Float32Array(pixels);
    const lnR = Math.log(ESCAPE_RADIUS);
    let minIter = Infinity;
    let maxIter = -Infinity;
    for (let p = 0; p < pixels; p++) {
      // 0 = inside a filled block, else count + 1.
      const word = words[3 * p];
      const iterations = word - 1;
      if (word === 0 || iterations >= maxIterations) {
        values[p] = Infinity;
        continue;
      }
      if (iterations < minIter) minIter = iterations;
      if (iterations > maxIter) maxIter = iterations;
      values[p] = payload.smoothColoring
        ? iterations -
          Math.log(
            Math.log(Math.hypot(floats[3 * p + 1], floats[3 * p + 2])) / lnR,
          ) /
            Math.LN2
        : iterations;
    }
    const escaped = maxIter >= 0;
    return {
      values,
      minIter: escaped ? minIter : null,
      maxIter: escaped ? maxIter : null,
      tier: spacing < MIN_DIRECT_PIXEL_SPACING ? 1 : 0,
    };
  };

  return { renderValues };
}
