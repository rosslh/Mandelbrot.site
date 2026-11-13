/* global GPUBufferUsage, GPUMapMode */
// WebGPU rendering lane (bench/LOG.md 2026-11-12 directive; backlog G2).
//
// Renders a tile's escape values with a WebGPU compute shader and returns
// them to worker.js, which colors them through the wasm recolor path (so a
// GPU tile and a wasm tile with the same values color identically). Loaded
// as its own lazy chunk, only when the lane is switched on for this worker,
// so loads that never use the GPU pay nothing for it.
//
// Arithmetic: double-single ("df32", a value as an unevaluated sum hi + lo
// of two f32s, ~48 significant bits), because plain f32 failed the
// statistical tier even at zoom 2: its rounding is structured on a regular
// pixel grid, so sub-ulp deltas came out one-directional (bench/LOG.md
// 2026-11-13). Coverage (see `gpuCovers`): exponent 2, escape-time coloring,
// and pixel spacing coarse enough for df32. Everything else goes to wasm.
// The output can never be byte-exact against the f64 wasm lanes; it is
// judged by the statistical-equivalence tier against the pinned anchor, and
// the cutoff below must be measured against that anchor before the lane
// covers real views.
//
// The Metal backend compiles shaders with fast math: it reassociates float
// expressions, which silently turns the error-free transformations df32 is
// built on into zero (measured: a two-sum's error term came back 0). Every
// intermediate of those transformations therefore passes through
// `opaque()`, an XOR with a zero the compiler cannot see, which pins it to
// an f32 value in program order. fma() is a true fused operation there, so
// two-product uses it.
//
// Failure policy: a GPU failure must never cost the user a tile. Every error
// (device creation, shader compile, device loss, a rejected readback) is
// thrown to worker.js, which renders that tile through wasm and stops
// offering this worker's tiles to the GPU once the device is gone.

// Tile-space scale shared with the wasm renderer (perturbation.rs
// TILE_SPACE_SCALE): 200 / 128.
const TILE_SPACE_SCALE = 200 / 128;
const ESCAPE_RADIUS = 3;

// Finest pixel spacing the df32 kernel covers, measured against the anchor
// with the statistical tier (bench/src/gpu-check.mjs, bench/LOG.md
// 2026-11-13). Pixel spacing at 200px tiles is 2^-(zoom + 5). Across four
// 80-view holdout seeds and the corpus, every view at zoom <= 24 passes;
// from z25 to z29 a few views per seed fail (mostly a one-directional
// sub-ulp delta-sign imbalance with no flips) while most pass, and z32+
// fails outright. 2^-29 is zoom 24. Moving it deeper needs that z25-z29
// bias explained first.
export const GPU_MIN_PIXEL_SPACING = 2 ** -29;

// Largest iteration budget and worst-case work (pixels x budget) the lane
// accepts per tile. Long-running dispatches risk the GPU watchdog, and a
// GPU-process reset can take every worker's device and the page's canvases
// with it, so until dispatches are split into bounded chunks, heavy tiles
// stay on wasm. The kernel has no periodicity check or rect_in_set shortcut,
// so a fully interior tile costs its whole budget per pixel: 2^32 steps is
// about a second on an M1 Pro (the probe runs ~5G steps/s). The pixel cap
// keeps image exports (tall columns) and buffer sizes on wasm too.
const GPU_MAX_ITERATIONS = 100000;
const GPU_MAX_WORK = 2 ** 32;
const GPU_MAX_PIXELS = 512 * 512;

const WORKGROUP = 8;

// z starts at c and iterates while |z|^2 < R^2 and i < max, exactly like the
// scalar wasm loop (calculate_escape_iterations_quadratic), so escape counts
// agree wherever df32 rounding does not move them. The main cardioid and
// period-2 bulb are interior by test, as in wasm (evaluated in df32: an f32
// test misclassifies pixels hugging the cardioid, which are interior-vs-
// escaper flips). Each pixel writes five words: the escape count (u32 bits;
// maxIterations marks interior) and the final z as two df32 pairs.
// Smoothing happens on the CPU in f64 (`smoothValues`), not in the shader:
// GPU log/length are fast-math approximations.
const SHADER = /* wgsl */ `
struct Params {
  width: u32,
  height: u32,
  maxIterations: u32,
  zero: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
// Pixel coordinates as df32 pairs: width real parts, then height imaginary
// parts (see pixelCoordinates).
@group(0) @binding(2) var<storage, read> coords: array<vec2<f32>>;

fn opaque(x: f32) -> f32 { return bitcast<f32>(bitcast<u32>(x) ^ params.zero); }

fn twoSum(a: f32, b: f32) -> vec2<f32> {
  let s = opaque(a + b);
  let bb = opaque(s - a);
  return vec2<f32>(s, opaque(a - opaque(s - bb)) + opaque(b - bb));
}

fn quickTwoSum(a: f32, b: f32) -> vec2<f32> {
  let s = opaque(a + b);
  return vec2<f32>(s, opaque(b - opaque(s - a)));
}

fn dfAdd(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let s = twoSum(a.x, b.x);
  let t = twoSum(a.y, b.y);
  let u = quickTwoSum(s.x, opaque(s.y + t.x));
  return quickTwoSum(u.x, opaque(u.y + t.y));
}

fn dfNeg(a: vec2<f32>) -> vec2<f32> { return -a; }

fn dfMul(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  let p = opaque(a.x * b.x);
  let e = fma(a.x, b.x, -p);
  let e1 = fma(a.x, b.y, e);
  let e2 = fma(a.y, b.x, e1);
  return quickTwoSum(p, e2);
}

fn df(x: f32) -> vec2<f32> { return vec2<f32>(x, 0.0); }

// Cardioid / period-2 bulb test (in_main_cardioid_or_bulb) in df32.
fn inCardioidOrBulb(cr: vec2<f32>, ci: vec2<f32>) -> bool {
  let ci2 = dfMul(ci, ci);
  let x = dfAdd(cr, df(-0.25));
  let q = dfAdd(dfMul(x, x), ci2);
  let lhs = dfMul(q, dfAdd(q, x));
  let cardioid = dfAdd(lhs, dfNeg(dfMul(df(0.25), ci2)));
  if (cardioid.x + cardioid.y <= 0.0) { return true; }
  let x1 = dfAdd(cr, df(1.0));
  let bulb = dfAdd(dfAdd(dfMul(x1, x1), ci2), df(-0.0625));
  return bulb.x + bulb.y <= 0.0;
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let cr = coords[id.x];
  let ci = coords[params.width + id.y];
  let base = 5u * (id.y * params.width + id.x);
  var zr = cr;
  var zi = ci;
  var i = 0u;
  if (inCardioidOrBulb(cr, ci)) {
    i = params.maxIterations;
  } else {
    loop {
      let zr2 = dfMul(zr, zr);
      let zi2 = dfMul(zi, zi);
      if (zr2.x + zi2.x >= ${ESCAPE_RADIUS * ESCAPE_RADIUS}.0 || i >= params.maxIterations) { break; }
      let zri = dfMul(zr, zi);
      zr = dfAdd(dfAdd(zr2, dfNeg(zi2)), cr);
      zi = dfAdd(zri * 2.0, ci);
      i = i + 1u;
    }
  }
  out[base] = bitcast<f32>(i);
  out[base + 1u] = zr.x;
  out[base + 2u] = zr.y;
  out[base + 3u] = zi.x;
  out[base + 4u] = zi.y;
}
`;

// The tile's pixel coordinates exactly as the wasm direct path computes
// them in f64 (itertools-num linspace: start + step * i, inclusive ends),
// each stored as the nearest df32 pair (hi = nearest f32, lo = the f32
// nearest the rest). Computing them in the shader with df32 arithmetic
// instead left a structured coordinate error that came out as a one-
// directional sub-ulp shift on z26-z29 holdout views (bench/LOG.md
// 2026-11-13).
function pixelCoordinates(reMin, reMax, imMax, imMin, width, height) {
  const coords = new Float32Array(2 * (width + height));
  const put = (index, value) => {
    const hi = Math.fround(value);
    coords[2 * index] = hi;
    coords[2 * index + 1] = Math.fround(value - hi);
  };
  const reStep = (reMax - reMin) / (width - 1);
  for (let x = 0; x < width; x++) put(x, reMin + reStep * x);
  const imStep = (imMin - imMax) / (height - 1);
  for (let y = 0; y < height; y++) put(width + y, imMax + imStep * y);
  return coords;
}

const LN_ESCAPE_RADIUS = Math.log(ESCAPE_RADIUS);

// Turns the kernel's (count, z) triples into the tile's f32 values buffer
// and iteration stats, with smoothed_escape_value's f64 formula (exponent
// 2): +Inf for interior pixels, `i - ln(ln|z| / ln R) / ln 2` (or the plain
// count) for escapers; min/max over escaped counts, null when none escaped
// (TileIterationStats).
function smoothValues(raw, pixels, maxIterations, smoothColoring) {
  const counts = new Uint32Array(raw.buffer, raw.byteOffset, pixels * 5);
  const values = new Float32Array(pixels);
  let minIter = Infinity;
  let maxIter = -Infinity;
  for (let p = 0; p < pixels; p++) {
    const iterations = counts[5 * p];
    if (iterations >= maxIterations) {
      values[p] = Infinity;
      continue;
    }
    if (iterations < minIter) minIter = iterations;
    if (iterations > maxIter) maxIter = iterations;
    if (smoothColoring) {
      const norm = Math.hypot(
        raw[5 * p + 1] + raw[5 * p + 2],
        raw[5 * p + 3] + raw[5 * p + 4],
      );
      values[p] =
        iterations - Math.log(Math.log(norm) / LN_ESCAPE_RADIUS) / Math.LN2;
    } else {
      values[p] = iterations;
    }
  }
  const escaped = maxIter >= 0;
  return {
    values,
    minIter: escaped ? minIter : null,
    maxIter: escaped ? maxIter : null,
  };
}

// Mirrors perturbation::pixel_spacing: the finer of the two axes.
function pixelSpacing(payload) {
  const { bounds, zoomOffset, imageWidth, imageHeight } = payload;
  const scale = 2 ** (-(bounds.zoom - 2) - zoomOffset);
  return Math.min(
    (((bounds.xMax - bounds.xMin) * TILE_SPACE_SCALE) / imageWidth) * scale,
    (((bounds.yMax - bounds.yMin) * TILE_SPACE_SCALE) / imageHeight) * scale,
  );
}

// perturbation::tile_coordinate_offset scaled by 2^-zoomOffset.
function tileOffset(coordinate, zoom, zoomOffset) {
  return (
    (coordinate * TILE_SPACE_SCALE * 2 ** -(zoom - 2) - 4) * 2 ** -zoomOffset
  );
}

// Whether the f32 kernel can render this request. Anything it cannot goes
// to wasm unchanged.
export function gpuCovers(payload) {
  const coloring = payload.coloring ?? {};
  return (
    payload.power === 2 &&
    !coloring.distanceEstimate &&
    !coloring.atomDomain &&
    payload.maxIterations <= GPU_MAX_ITERATIONS &&
    payload.imageWidth * payload.imageHeight <= GPU_MAX_PIXELS &&
    payload.imageWidth * payload.imageHeight * payload.maxIterations <=
      GPU_MAX_WORK &&
    payload.imageWidth > 1 &&
    payload.imageHeight > 1 &&
    pixelSpacing(payload) >= GPU_MIN_PIXEL_SPACING
  );
}

// Creates the device and pipeline. `inject` is a test-only failure mode
// ("shader": invalid WGSL, so initialization fails; "lost": the device is
// destroyed right after initialization, so every tile hits a lost device;
// "tile": every render after the first throws while the device stays up, so
// each tile exercises worker.js's per-tile wasm fallback).
// Resolves to a lane object, or throws when no usable GPU exists.
export async function createGpuLane({ inject = null } = {}) {
  if (!("gpu" in navigator) || !navigator.gpu) {
    throw new Error("WebGPU unavailable");
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: "high-performance",
  });
  if (!adapter) throw new Error("No WebGPU adapter");
  if (adapter.info?.isFallbackAdapter || adapter.isFallbackAdapter) {
    throw new Error("Fallback WebGPU adapter");
  }
  const device = await adapter.requestDevice();
  let lost = false;
  device.lost.then(() => {
    lost = true;
  });

  let pipeline;
  try {
    device.pushErrorScope("validation");
    const module = device.createShaderModule({
      code: inject === "shader" ? `${SHADER}\n this is not wgsl` : SHADER,
    });
    const [pipelineResult, initError] = await Promise.allSettled([
      device.createComputePipelineAsync({
        layout: "auto",
        compute: { module, entryPoint: "main" },
      }),
      device.popErrorScope(),
    ]);
    if (initError.status === "fulfilled" && initError.value) {
      throw new Error(`GPU shader error: ${initError.value.message}`);
    }
    if (pipelineResult.status === "rejected") throw pipelineResult.reason;
    pipeline = pipelineResult.value;
  } catch (error) {
    device.destroy();
    throw error;
  }

  const uniform = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  // Value and readback buffers are reused across tiles and regrown when a
  // larger tile arrives; one tile is in flight per worker at a time (the
  // threads pool runs one task per worker). Capacity is recorded only once
  // the buffers allocated cleanly, so a failed allocation is retried rather
  // than reused.
  let capacity = 0;
  let axisCapacity = 0;
  let coordsBuffer = null;
  let valuesBuffer = null;
  let readback = null;
  let bindGroup = null;
  const ensureCapacity = async (pixels, axisLength) => {
    if (pixels <= capacity && axisLength <= axisCapacity) return;
    pixels = Math.max(pixels, capacity);
    axisLength = Math.max(axisLength, axisCapacity);
    valuesBuffer?.destroy();
    readback?.destroy();
    coordsBuffer?.destroy();
    capacity = 0;
    axisCapacity = 0;
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    valuesBuffer = device.createBuffer({
      size: pixels * 20,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readback = device.createBuffer({
      size: pixels * 20,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    coordsBuffer = device.createBuffer({
      size: axisLength * 8,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: valuesBuffer } },
        { binding: 2, resource: { buffer: coordsBuffer } },
      ],
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

  if (inject === "lost") device.destroy();

  // Renders the escape values of one covered tile. Resolves to
  // { values: Float32Array, minIter, maxIter } (iteration stats null for a
  // fully interior tile, as wasm reports them).
  let renders = 0;
  const renderValues = async (payload) => {
    if (lost) throw new Error("GPU device lost");
    if (inject === "tile" && renders++ > 0) {
      throw new Error("Injected GPU tile failure");
    }
    const {
      bounds,
      zoomOffset,
      imageWidth: width,
      imageHeight: height,
    } = payload;
    const originRe = Number.parseFloat(payload.originRe) || 0;
    const originIm = Number.parseFloat(payload.originIm) || 0;
    const reMin = originRe + tileOffset(bounds.xMin, bounds.zoom, zoomOffset);
    const reMax = originRe + tileOffset(bounds.xMax, bounds.zoom, zoomOffset);
    const imMax = originIm - tileOffset(bounds.yMin, bounds.zoom, zoomOffset);
    const imMin = originIm - tileOffset(bounds.yMax, bounds.zoom, zoomOffset);
    const pixels = width * height;
    await ensureCapacity(pixels, width + height);

    device.queue.writeBuffer(
      uniform,
      0,
      new Uint32Array([width, height, payload.maxIterations, 0]),
    );
    device.queue.writeBuffer(
      coordsBuffer,
      0,
      pixelCoordinates(reMin, reMax, imMax, imMin, width, height),
    );

    device.pushErrorScope("validation");
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(
      Math.ceil(width / WORKGROUP),
      Math.ceil(height / WORKGROUP),
    );
    pass.end();
    encoder.copyBufferToBuffer(valuesBuffer, 0, readback, 0, pixels * 20);
    device.queue.submit([encoder.finish()]);
    const submitError = device.popErrorScope().catch(() => null);

    await readback.mapAsync(GPUMapMode.READ, 0, pixels * 20);
    try {
      const error = await submitError;
      if (error) throw new Error(`GPU dispatch error: ${error.message}`);
      const raw = new Float32Array(readback.getMappedRange(0, pixels * 20));
      return smoothValues(
        raw,
        pixels,
        payload.maxIterations,
        payload.smoothColoring,
      );
    } finally {
      readback.unmap();
    }
  };

  return {
    renderValues,
    get usable() {
      return !lost;
    },
  };
}
