/* global GPUBufferUsage, GPUMapMode */
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
// periodicity on (dz, n) retires interior pixels early (createGpuLane's
// `periodicity` is the check stride in iterations; 0 turns it off). Smoothing is done on the
// CPU in f64.

const TILE_SPACE_SCALE = 200 / 128;
const ESCAPE_RADIUS = 3;
const MAX_ORBIT_LENGTH = 1 << 20;
const WORKGROUP = 8;

const shader = (periodicity) => /* wgsl */ `
const PERIODICITY = ${periodicity > 0};
const STRIDE = ${Math.max(1, periodicity)}u;
struct Params { width: u32, height: u32, maxIterations: u32, orbitLen: u32, zero: u32, _p0: u32, _p1: u32, _p2: u32 };
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> out: array<u32>;
// Z_n as (hi.re, hi.im, lo.re, lo.im): hi the nearest f32, lo the f32
// nearest the rest. The lo part matters only where Z is added to dz: the
// f32 rounding of Z is the same for every pixel, so dropping it shifts the
// whole tile one way (measured: a one-directional sign imbalance at z38/z44).
@group(0) @binding(2) var<storage, read> orbit: array<vec4<f32>>;
// Per-axis pixel deltas from the origin: width real parts, then height
// imaginary parts.
@group(0) @binding(3) var<storage, read> dcs: array<f32>;

// Opaque to the compiler (Metal compiles with fast math and would fold
// hi + (lo + dz) into (hi + lo) + dz = hi + dz).
fn opaque(x: vec2<f32>) -> vec2<f32> { return bitcast<vec2<f32>>(bitcast<vec2<u32>>(x) ^ vec2<u32>(params.zero)); }

@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= params.width || id.y >= params.height) { return; }
  let dc = vec2<f32>(dcs[id.x], dcs[params.width + id.y]);
  let last = params.orbitLen - 1u;
  var n = 0u;
  var dz = vec2<f32>(0.0, 0.0);
  var z = vec2<f32>(0.0, 0.0);
  var i = 0u;
  var first = true;
  var savedDz = vec2<f32>(0.0, 0.0);
  var savedN = 0u;
  var nextSave = 2u * STRIDE;
  loop {
    if (!first) {
      if (dot(z, z) >= ${ESCAPE_RADIUS * ESCAPE_RADIUS}.0 || i >= params.maxIterations) { break; }
      i = i + 1u;
    }
    let Z = orbit[n];
    let t = 2.0 * Z.xy + opaque(2.0 * Z.zw + dz);
    dz = vec2<f32>(t.x * dz.x - t.y * dz.y, t.x * dz.y + t.y * dz.x) + dc;
    n = n + 1u;
    let Zn = orbit[n];
    z = Zn.xy + opaque(Zn.zw + dz);
    if (n == last || dot(z, z) < dot(dz, dz)) { dz = z; n = 0u; }
    // Brent periodicity on the full state (dz, n), as in
    // perturbed_escape_iterations_f64: an exact recurrence of the computed
    // state means this arithmetic cycles forever, so the pixel is interior
    // (z is unused for interior pixels).
    if (PERIODICITY) {
      if (!first && i % STRIDE == 0u) {
        if (all(dz == savedDz) && n == savedN) { i = params.maxIterations; break; }
        if (i == nextSave) { savedDz = dz; savedN = n; nextSave = nextSave * 2u; }
      } else { savedDz = dz; savedN = n; }
    }
    first = false;
  }
  let base = 3u * (id.y * params.width + id.x);
  out[base] = i;
  out[base + 1u] = bitcast<u32>(z.x);
  out[base + 2u] = bitcast<u32>(z.y);
}
`;

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

export async function createGpuLane({ periodicity = 32 } = {}) {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("No WebGPU adapter");
  const device = await adapter.requestDevice();
  const pipeline = await device.createComputePipelineAsync({
    layout: "auto",
    compute: { module: device.createShaderModule({ code: shader(periodicity) }), entryPoint: "main" },
  });
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
    const outBuffer = device.createBuffer({ size: pixels * 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readback = device.createBuffer({ size: pixels * 12, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const dcBuffer = device.createBuffer({ size: dcs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(uniform, 0, new Uint32Array([width, height, maxIterations, cached.length, 0, 0, 0, 0]));
    device.queue.writeBuffer(dcBuffer, 0, dcs);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: outBuffer } },
        { binding: 2, resource: { buffer: cached.buffer } },
        { binding: 3, resource: { buffer: dcBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(width / WORKGROUP), Math.ceil(height / WORKGROUP));
    pass.end();
    encoder.copyBufferToBuffer(outBuffer, 0, readback, 0, pixels * 12);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const words = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    for (const b of [uniform, outBuffer, readback, dcBuffer]) b.destroy();
    const floats = new Float32Array(words.buffer);
    const values = new Float32Array(pixels);
    const lnR = Math.log(ESCAPE_RADIUS);
    let minIter = Infinity;
    let maxIter = -Infinity;
    for (let p = 0; p < pixels; p++) {
      const it = words[3 * p];
      if (it >= maxIterations) {
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
