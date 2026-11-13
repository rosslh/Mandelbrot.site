/* global GPUBufferUsage, GPUMapMode */
// WebGPU rendering lane (bench/LOG.md 2026-11-12 directive; backlog G2).
//
// Renders a tile's escape values with a WebGPU compute shader and returns
// them to worker.js, which colors them through the wasm recolor path (so a
// GPU tile and a wasm tile with the same values color identically). Loaded
// as its own lazy chunk, only when the lane is switched on for this worker,
// so loads that never use the GPU pay nothing for it.
//
// Coverage (see `gpuCovers`): exponent 2, escape-time coloring, and pixel
// spacing coarse enough for plain f32 arithmetic. Everything else goes to
// wasm. The output can never be byte-exact against the f64 wasm lanes; it is
// judged by the statistical-equivalence tier against the pinned anchor, and
// the f32 cutoff below must be measured against that anchor before the lane
// covers real views.
//
// Failure policy: a GPU failure must never cost the user a tile. Every error
// (device creation, shader compile, device loss, a rejected readback) is
// thrown to worker.js, which renders that tile through wasm and stops
// offering this worker's tiles to the GPU once the device is gone.

// Tile-space scale shared with the wasm renderer (perturbation.rs
// TILE_SPACE_SCALE): 200 / 128.
const TILE_SPACE_SCALE = 200 / 128;
const ESCAPE_RADIUS = 3;

// Finest pixel spacing the f32 kernel covers. Provisional: plain f32 has a
// 24-bit mantissa, so pixel coordinates with |c| < 2 resolve to ~2^-23 or
// better: 2^-18 leaves ~5-6 bits of sub-pixel resolution there (about 4 for
// |re| in [2, 4)); about zoom 11 at 200px tiles. To be replaced by a cutoff
// measured against the anchor.
export const GPU_F32_MIN_PIXEL_SPACING = 2 ** -18;

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
// agree wherever f32 rounding does not move them. The main cardioid and
// period-2 bulb are interior by test, as in wasm. Writes the smoothed escape
// value (or the plain count), +Inf for interior pixels, and folds escaped
// counts into a global min/max for the tile's iteration stats.
const SHADER = /* wgsl */ `
struct Params {
  reMin: f32,
  imMax: f32,
  reStep: f32,
  imStep: f32,
  width: u32,
  height: u32,
  maxIterations: u32,
  smoothColoring: u32,
  // +Inf's bit pattern, passed in because WGSL rejects a constant
  // expression that evaluates to infinity.
  infBits: u32,
};

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> values: array<f32>;
@group(0) @binding(2) var<storage, read_write> stats: array<atomic<u32>, 2>;

fn inCardioidOrBulb(c: vec2<f32>) -> bool {
  let x = c.x - 0.25;
  let q = x * x + c.y * c.y;
  if (q * (q + x) <= 0.25 * c.y * c.y) { return true; }
  let x1 = c.x + 1.0;
  return x1 * x1 + c.y * c.y <= 0.0625;
}

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let c = vec2<f32>(
    params.reMin + f32(id.x) * params.reStep,
    params.imMax - f32(id.y) * params.imStep,
  );
  let index = id.y * params.width + id.x;
  let interior = bitcast<f32>(params.infBits);
  if (inCardioidOrBulb(c)) {
    values[index] = interior;
    return;
  }
  var z = c;
  var i = 0u;
  loop {
    if (dot(z, z) >= ${ESCAPE_RADIUS * ESCAPE_RADIUS}.0 || i >= params.maxIterations) { break; }
    z = vec2<f32>(z.x * z.x - z.y * z.y + c.x, 2.0 * z.x * z.y + c.y);
    i = i + 1u;
  }
  if (i >= params.maxIterations) {
    values[index] = interior;
    return;
  }
  atomicMin(&stats[0], i);
  atomicMax(&stats[1], i);
  if (params.smoothColoring != 0u) {
    let lnR = log(${ESCAPE_RADIUS}.0);
    values[index] = f32(i) - log(log(length(z)) / lnR) / log(2.0);
  } else {
    values[index] = f32(i);
  }
}
`;

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
    pixelSpacing(payload) >= GPU_F32_MIN_PIXEL_SPACING
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
    size: 48,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const statsBuffer = device.createBuffer({
    size: 8,
    usage:
      GPUBufferUsage.STORAGE |
      GPUBufferUsage.COPY_SRC |
      GPUBufferUsage.COPY_DST,
  });
  // Value and readback buffers are reused across tiles and regrown when a
  // larger tile arrives; one tile is in flight per worker at a time (the
  // threads pool runs one task per worker). Capacity is recorded only once
  // the buffers allocated cleanly, so a failed allocation is retried rather
  // than reused.
  let capacity = 0;
  let valuesBuffer = null;
  let readback = null;
  let bindGroup = null;
  const ensureCapacity = async (pixels) => {
    if (pixels <= capacity) return;
    valuesBuffer?.destroy();
    readback?.destroy();
    capacity = 0;
    device.pushErrorScope("out-of-memory");
    device.pushErrorScope("validation");
    valuesBuffer = device.createBuffer({
      size: pixels * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });
    readback = device.createBuffer({
      size: pixels * 4 + 8,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: valuesBuffer } },
        { binding: 2, resource: { buffer: statsBuffer } },
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
    await ensureCapacity(pixels);

    const paramBytes = new ArrayBuffer(48);
    const floats = new Float32Array(paramBytes, 0, 4);
    const ints = new Uint32Array(paramBytes, 16, 5);
    floats.set([
      reMin,
      imMax,
      (reMax - reMin) / (width - 1),
      (imMax - imMin) / (height - 1),
    ]);
    ints.set([
      width,
      height,
      payload.maxIterations,
      payload.smoothColoring ? 1 : 0,
      0x7f800000,
    ]);
    device.queue.writeBuffer(uniform, 0, paramBytes);
    device.queue.writeBuffer(statsBuffer, 0, new Uint32Array([0xffffffff, 0]));

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
    encoder.copyBufferToBuffer(valuesBuffer, 0, readback, 0, pixels * 4);
    encoder.copyBufferToBuffer(statsBuffer, 0, readback, pixels * 4, 8);
    device.queue.submit([encoder.finish()]);
    const submitError = device.popErrorScope().catch(() => null);

    await readback.mapAsync(GPUMapMode.READ, 0, pixels * 4 + 8);
    try {
      const error = await submitError;
      if (error) throw new Error(`GPU dispatch error: ${error.message}`);
      const mapped = readback.getMappedRange(0, pixels * 4 + 8);
      const values = new Float32Array(mapped.slice(0, pixels * 4));
      const [minIter, maxIter] = new Uint32Array(mapped.slice(pixels * 4));
      const escaped = minIter !== 0xffffffff;
      return {
        values,
        minIter: escaped ? minIter : null,
        maxIter: escaped ? maxIter : null,
      };
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
