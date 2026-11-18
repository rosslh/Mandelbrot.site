// Sampled BigInt ground truth for a tile (the truth tier; Ross's 2026-11-17
// directive, LOG entry of that date). Past the depth where the f64-direct
// anchor stops being the more precise side, GPU output is judged against
// this instead of the anchor.
//
// sampleTruth(payload, { samples, seed }) picks `samples` pixels uniformly
// WITHOUT replacement over the whole tile (escapers and interior alike, so
// GPU-interior flips are caught; gpu-truth.mjs's escaper-only sampling
// missed them), iterates each in BigInt fixed point on the exact linspace
// grid the wasm and GPU lanes render (offsets are exact f64 values, the
// step is exact rational arithmetic), and returns [{ pixel, value }] with
// value = the smoothed escape value exactly as lib.rs smoothed_escape_value
// defines it (Infinity = never escaped within the budget).
//
// The iteration is exact w.r.t. a truncated fixed-point map with
// zoom + 160 fraction bits. Interior shortcuts used here are exact for that
// map: the closed-form main cardioid / period-2 bulb tests (such points
// never escape), and Brent cycle detection on exact state equality (a
// recurring state of a deterministic map recurs forever).
//
// The work fans out over worker threads, and results are cached under
// bench/results/truth-cache (machine-local, gitignored): truth depends only
// on the geometry, budget, smoothing flag, sample count and seed.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";

const here = fileURLToPath(import.meta.url);
const benchDir = resolve(dirname(here), "..");
const cacheDir = join(benchDir, "results", "truth-cache");
// Bump when the iteration, the interior shortcuts, the margins or the
// sampler change, so stale cache entries are not reused.
const TRUTH_VERSION = 2;
// The cache key includes EXTRA_BITS only when it differs from the default.
const EXTRA_BITS = Number(process.env.TRUTH_EXTRA_BITS ?? 160);

// Exact f64 -> BigInt fixed point with `bits` fraction bits (truncating
// toward zero only below 2^-bits, which the bit budget makes irrelevant).
function f64ToFixed(x, bits) {
  if (x === 0) return 0n;
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const sign = hi >>> 31 ? -1n : 1n;
  const exp = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e = exp - 1075;
  if (exp === 0) e = -1074;
  else mant |= 1n << 52n;
  const shift = BigInt(e + bits);
  return sign * (shift >= 0n ? mant << shift : mant >> -shift);
}

function decToFixed(text, bits) {
  let s = String(text).trim();
  let neg = false;
  if (s[0] === "-") {
    neg = true;
    s = s.slice(1);
  } else if (s[0] === "+") s = s.slice(1);
  let exp10 = 0;
  const e = s.search(/e/i);
  if (e >= 0) {
    exp10 = Number(s.slice(e + 1));
    s = s.slice(0, e);
  }
  const [w, f = ""] = s.split(".");
  const scale = f.length - exp10;
  const digits = BigInt((w || "0") + f);
  const v =
    scale >= 0
      ? (digits << BigInt(bits)) / 10n ** BigInt(scale)
      : (digits * 10n ** BigInt(-scale)) << BigInt(bits);
  return neg ? -v : v;
}

// Pixel geometry of a tile payload (normalize.mjs caseToWasmArgs shape),
// identical to wasm's PerturbedFrame / direct linspace.
export function frame(payload) {
  const zoom = payload.bounds.zoom + payload.zoomOffset;
  const bits = zoom + EXTRA_BITS;
  const tileOffset = (v, tz) => v * (200 / 128) * 2 ** -(tz - 2) - 4;
  const b = payload.bounds;
  return {
    bits,
    width: payload.imageWidth,
    height: payload.imageHeight,
    xMin: f64ToFixed(tileOffset(b.xMin, b.zoom), bits),
    xMax: f64ToFixed(tileOffset(b.xMax, b.zoom), bits),
    yMin: f64ToFixed(-tileOffset(b.yMin, b.zoom), bits),
    yMax: f64ToFixed(-tileOffset(b.yMax, b.zoom), bits),
    zoomOffset: BigInt(payload.zoomOffset),
    originRe: decToFixed(payload.originRe, bits),
    originIm: decToFixed(payload.originIm, bits),
    maxIterations: payload.iterations,
    smooth: payload.smoothColoring !== false,
  };
}

export function truthForPixel(f, pixel) {
  const B = BigInt(f.bits);
  const W = f.width;
  const H = f.height;
  const col = BigInt(pixel % W);
  const row = BigInt(Math.floor(pixel / W));
  const cr =
    f.originRe +
    ((f.xMin + ((f.xMax - f.xMin) * col) / BigInt(W - 1)) >> f.zoomOffset);
  const ci =
    f.originIm +
    ((f.yMin + ((f.yMax - f.yMin) * row) / BigInt(H - 1)) >> f.zoomOffset);
  const toNum = (x) => Number(x >> (B - 52n)) * 2 ** -52;

  // Closed-form interior: main cardioid and period-2 bulb. f64 decides these
  // only with an absolute margin far above its rounding error (~1e-16), so a
  // pixel near either boundary (cusp and needle views) iterates instead.
  {
    const x = toNum(cr);
    const y = toNum(ci);
    const q = (x - 0.25) * (x - 0.25) + y * y;
    if (q * (q + (x - 0.25)) < 0.25 * y * y - 1e-12) return Infinity;
    if ((x + 1) * (x + 1) + y * y < 0.0625 - 1e-12) return Infinity;
  }

  const nine = 9n << B;
  let zr = cr;
  let zi = ci;
  let i = 0;
  // Brent: compare against a saved state, re-saving at powers of two.
  let savedR = zr;
  let savedI = zi;
  let power = 1;
  let lam = 0;
  const maxIt = f.maxIterations;
  while (i < maxIt) {
    const zr2 = (zr * zr) >> B;
    const zi2 = (zi * zi) >> B;
    if (zr2 + zi2 >= nine) break;
    const zri = (zr * zi) >> B;
    zr = zr2 - zi2 + cr;
    zi = 2n * zri + ci;
    i++;
    if (zr === savedR && zi === savedI) return Infinity;
    if (++lam === power) {
      savedR = zr;
      savedI = zi;
      power *= 2;
      lam = 0;
    }
  }
  if (i >= maxIt) return Infinity;
  if (!f.smooth) return i;
  return (
    i -
    Math.log(Math.log(Math.hypot(toNum(zr), toNum(zi))) / Math.log(3)) /
      Math.LN2
  );
}

// Seeded uniform sample without replacement (partial Fisher-Yates).
function samplePixels(total, samples, seedText) {
  const hash = createHash("sha256").update(seedText).digest();
  let state = hash.readUInt32LE(0);
  const rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = Math.min(samples, total);
  const swapped = new Map();
  const picks = [];
  for (let k = 0; k < n; k++) {
    const j = k + Math.floor(rng() * (total - k));
    const vj = swapped.get(j) ?? j;
    const vk = swapped.get(k) ?? k;
    swapped.set(j, vk);
    picks.push(vj);
  }
  return picks.sort((a, b) => a - b);
}

function cacheKey(payload, samples, seed, extraBits = EXTRA_BITS) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: TRUTH_VERSION,
        re: payload.originRe,
        im: payload.originIm,
        bounds: payload.bounds,
        zo: payload.zoomOffset,
        it: payload.iterations,
        w: payload.imageWidth,
        h: payload.imageHeight,
        smooth: payload.smoothColoring !== false,
        samples,
        seed,
        ...(extraBits !== 160 ? { extraBits } : {}),
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export async function sampleTruth(
  payload,
  { samples = Infinity, seed = "truth" } = {},
) {
  if ((payload.exponent ?? 2) !== 2)
    throw new Error("truth tier: exponent 2 only");
  const total = payload.imageWidth * payload.imageHeight;
  // Whole tile ("all") or a positive integer sample; anything else (NaN, 0,
  // negative) would sample nothing and pass every axis.
  if (!(samples === Infinity || (Number.isInteger(samples) && samples > 0)))
    throw new Error(
      `truth tier: samples must be a positive integer or all, got ${samples}`,
    );
  samples = samples >= total ? "all" : samples;
  const key = cacheKey(payload, samples, seed);
  const path = join(cacheDir, `${key}.json`);
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, "utf8")).map(([pixel, value]) => ({
      pixel,
      value: value === null ? Infinity : value,
    }));
  }
  // The pick depends on the view, not the precision, so precision checks
  // compare the same pixels.
  const pixels = samplePixels(
    total,
    samples === "all" ? total : samples,
    `${seed}|${cacheKey(payload, samples, seed, 160)}`,
  );
  const threads = Math.max(1, availableParallelism() - 1);
  // Interleave so heavy and light pixels spread across threads.
  const chunks = Array.from({ length: threads }, () => []);
  pixels.forEach((p, k) => chunks[k % threads].push(p));
  const parts = await Promise.all(
    chunks
      .filter((c) => c.length > 0)
      .map(
        (chunk) =>
          new Promise((resolvePart, reject) => {
            const worker = new Worker(here, {
              workerData: { truthJob: true, payload, pixels: chunk },
            });
            let answered = false;
            worker.once("message", (rows) => {
              answered = true;
              resolvePart(rows);
            });
            worker.once("error", reject);
            // A worker that dies without answering (OOM, resource limit)
            // would otherwise leave the run hanging.
            worker.once("exit", (code) => {
              if (!answered)
                reject(
                  new Error(`truth worker exited (${code}) without a result`),
                );
            });
          }),
      ),
  );
  const rows = parts.flat().sort((a, b) => a.pixel - b.pixel);
  if (rows.length !== pixels.length)
    throw new Error(`truth: ${rows.length} rows for ${pixels.length} pixels`);
  mkdirSync(cacheDir, { recursive: true });
  // Write then rename, so an interrupted run never leaves a partial file.
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(
    temp,
    JSON.stringify(
      rows.map((r) => [r.pixel, Number.isFinite(r.value) ? r.value : null]),
    ),
  );
  renameSync(temp, path);
  return rows;
}

// Sample-based comparison of a values buffer (Float32, Infinity = interior)
// against truth rows. Values are compared after narrowing truth to f32, as
// tiles store them.
export function compareToTruth(values, truthRows) {
  let flipsToInterior = 0; // truth escapes, candidate interior
  let flipsToEscaper = 0; // truth interior, candidate escapes
  let truthInterior = 0;
  let candInterior = 0;
  let common = 0;
  let exact = 0;
  let pos = 0;
  let neg = 0;
  let countMoved = 0;
  const truthEsc = [];
  const candEsc = [];
  const absDeltas = [];
  for (const { pixel, value } of truthRows) {
    const c = values[pixel];
    const tInt = !Number.isFinite(value);
    const cInt = !Number.isFinite(c);
    if (tInt) truthInterior++;
    if (cInt) candInterior++;
    if (tInt && cInt) continue;
    if (tInt) {
      flipsToEscaper++;
      continue;
    }
    if (cInt) {
      flipsToInterior++;
      continue;
    }
    common++;
    const t = Math.fround(value);
    truthEsc.push(t);
    candEsc.push(c);
    const d = c - t;
    if (d === 0) exact++;
    else if (d > 0) pos++;
    else neg++;
    absDeltas.push(Math.abs(d));
    if (Math.floor(c) !== Math.floor(t)) countMoved++;
  }
  absDeltas.sort((a, b) => a - b);
  truthEsc.sort((a, b) => a - b);
  candEsc.sort((a, b) => a - b);
  const q = (arr, f) =>
    arr.length ? arr[Math.min(arr.length - 1, Math.floor(f * arr.length))] : 0;
  let quantileDrift = 0;
  for (const f of [0.25, 0.5, 0.75]) {
    const a = q(truthEsc, f);
    const b = q(candEsc, f);
    if (a > 0) quantileDrift = Math.max(quantileDrift, Math.abs(b - a) / a);
  }
  return {
    samples: truthRows.length,
    truthInterior,
    candInterior,
    flipsToInterior,
    flipsToEscaper,
    common,
    exact,
    pos,
    neg,
    countMoved,
    medianAbsDelta: q(absDeltas, 0.5),
    p90AbsDelta: q(absDeltas, 0.9),
    quantileDrift,
  };
}

// Sampled truth-tier verdict. Shared axes keep the anchor tier's budgets
// (anchor.json statisticalBudgets): flip imbalance, sign imbalance and
// central-quantile drift. extraBudgets (truth.json) add absolute bounds on
// counts moved and exact share; null fields are report-only. A whole-tile
// run is decided by the full statistical tier instead (gpu-check), with
// only extraReasons taken from here.
export function judgeTruth(stats, statisticalBudgets, extraBudgets) {
  const sharedReasons = [];
  const extraReasons = [];
  const flips = stats.flipsToInterior + stats.flipsToEscaper;
  const flipImbalance = Math.abs(stats.flipsToInterior - stats.flipsToEscaper);
  const flipAllowance = Math.max(
    statisticalBudgets.flipImbalanceFloor,
    statisticalBudgets.flipImbalanceSigma * Math.sqrt(flips),
  );
  if (flipImbalance > flipAllowance)
    sharedReasons.push(
      `flip imbalance ${flipImbalance} > ${flipAllowance.toFixed(0)}`,
    );
  const signCount = stats.pos + stats.neg;
  const signImbalance = Math.abs(stats.pos - stats.neg);
  const signAllowance = Math.max(
    statisticalBudgets.signImbalanceFloor,
    statisticalBudgets.signImbalanceSigma * Math.sqrt(signCount),
  );
  if (signImbalance > signAllowance)
    sharedReasons.push(
      `sign imbalance +${stats.pos}/-${stats.neg} > ${signAllowance.toFixed(0)}`,
    );
  if (
    stats.common >= 50 &&
    stats.quantileDrift > statisticalBudgets.maxQuantileDrift
  )
    sharedReasons.push(
      `quantile drift ${(stats.quantileDrift * 100).toFixed(2)}%`,
    );
  const escapers = stats.common + stats.flipsToInterior;
  const moved = escapers
    ? (stats.countMoved + stats.flipsToInterior) / escapers
    : 0;
  const exactShare = stats.common ? stats.exact / stats.common : 1;
  if (
    extraBudgets?.maxCountMovedFraction != null &&
    moved > extraBudgets.maxCountMovedFraction
  )
    extraReasons.push(
      `counts moved ${(moved * 100).toFixed(1)}% > ${(extraBudgets.maxCountMovedFraction * 100).toFixed(1)}%`,
    );
  if (
    extraBudgets?.minExactShare != null &&
    stats.common >= 50 &&
    exactShare < extraBudgets.minExactShare
  )
    extraReasons.push(
      `exact share ${(exactShare * 100).toFixed(1)}% < ${(extraBudgets.minExactShare * 100).toFixed(1)}%`,
    );
  const reasons = [...sharedReasons, ...extraReasons];
  return {
    pass: reasons.length === 0,
    reasons,
    sharedReasons,
    extraReasons,
    flipImbalance,
    signImbalance,
    moved,
    exactShare,
  };
}

function movedFraction(s) {
  const escapers = s.common + s.flipsToInterior;
  return escapers ? (s.countMoved + s.flipsToInterior) / escapers : 0;
}

export function formatTruthStats(label, s, verdict) {
  return (
    `${label}: ${s.common}/${s.samples} common esc, exact ${s.exact}, +${s.pos}/-${s.neg}, ` +
    `moved ${(movedFraction(s) * 100).toFixed(1)}%, flips →int ${s.flipsToInterior} →esc ${s.flipsToEscaper}, ` +
    `med|Δ| ${s.medianAbsDelta.toExponential(1)}, qdrift ${(s.quantileDrift * 100).toFixed(2)}%` +
    (verdict === null
      ? ""
      : verdict.reasons.length
        ? `  FAIL: ${verdict.reasons.join("; ")}`
        : "  ok")
  );
}

if (!isMainThread && workerData?.truthJob) {
  const f = frame(workerData.payload);
  parentPort.postMessage(
    workerData.pixels.map((pixel) => ({
      pixel,
      value: truthForPixel(f, pixel),
    })),
  );
}
