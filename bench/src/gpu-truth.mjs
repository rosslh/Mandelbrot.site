// Ground-truth arbiter for a GPU-vs-anchor disagreement (LOG 2026-11-15).
// When the statistical tier flags a one-directional shift between a GPU
// kernel and the pinned anchor, either side can be the biased one: the
// anchor is f64 direct, whose sub-pixel precision runs out with depth
// (53 - log2(1/spacing) bits). This renders one corpus or ad-hoc case with
// both, then iterates a sample of pixels in BigInt fixed point (exact pixel
// coordinates of the same linspace grid, ample precision) and reports each
// side's signed error against that truth on pixels all three call escapers.
//
//   node src/gpu-truth.mjs --module /bench/page/gpu-perturb.js
//     (--case <corpus id> | --view re,im,zoom,iterations) [--samples 400]

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseToWasmArgs } from "./normalize.mjs";
import { startSession } from "./session.mjs";
import { readAnchorConfig } from "./tolerance.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { module: "/client/js/gpu.js", case: null, view: null, samples: 400 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--module") opts.module = argv[++i];
    else if (arg === "--case") opts.case = argv[++i];
    else if (arg === "--view") opts.view = argv[++i];
    else if (arg === "--samples") opts.samples = Number(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(readFileSync(join(benchDir, "corpus", "corpus.json"), "utf8"));
  let benchCase;
  if (opts.case) benchCase = corpus.cases.find((c) => c.id === opts.case);
  else {
    const [re, im, zoom, iterations] = opts.view.split(",");
    benchCase = { id: "view", re, im, zoom: Number(zoom), iterations: Number(iterations) };
  }
  if (!benchCase) throw new Error("case not found");
  const [payload, args] = caseToWasmArgs(benchCase, corpus.defaults);
  const anchor = readAnchorConfig();
  const session = await startSession([anchor.variant]);
  try {
    const result = await session.page.evaluate(
      async (moduleUrl, args, payload, samples) => {
        const module = await import(moduleUrl);
        const lane = await module.createGpuLane();
        const fromB64 = (s) => {
          const bin = atob(s);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Float32Array(bytes.buffer);
        };
        const anchorValues = fromB64(window.getValues(0, args));
        const { values: gpuValues } = await lane.renderValues({
          originRe: payload.originRe,
          originIm: payload.originIm,
          bounds: payload.bounds,
          zoomOffset: payload.zoomOffset,
          maxIterations: payload.iterations,
          power: 2,
          imageWidth: payload.imageWidth,
          imageHeight: payload.imageHeight,
          smoothColoring: payload.smoothColoring,
          coloring: {},
        });

        // Exact f64 -> BigInt fixed point with `bits` fraction bits.
        const f64ToFixed = (x, bits) => {
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
        };
        const decToFixed = (text, bits) => {
          let s = text.trim();
          let neg = false;
          if (s[0] === "-") { neg = true; s = s.slice(1); }
          let exp10 = 0;
          const e = s.search(/e/i);
          if (e >= 0) { exp10 = Number(s.slice(e + 1)); s = s.slice(0, e); }
          const [w, f = ""] = s.split(".");
          const scale = f.length - exp10;
          const digits = BigInt((w || "0") + f);
          const v = scale >= 0
            ? (digits << BigInt(bits)) / 10n ** BigInt(scale)
            : (digits * 10n ** BigInt(-scale)) << BigInt(bits);
          return neg ? -v : v;
        };
        const W = payload.imageWidth;
        const H = payload.imageHeight;
        const zoom = payload.bounds.zoom + payload.zoomOffset;
        const bits = zoom + 160;
        const B = BigInt(bits);
        const tileOffset = (v, tz) => v * (200 / 128) * 2 ** -(tz - 2) - 4;
        const b = payload.bounds;
        // Offsets are exact f64 values; the linspace step is applied in
        // exact rational arithmetic (truth = the ideal grid).
        const xMin = f64ToFixed(tileOffset(b.xMin, b.zoom), bits);
        const xMax = f64ToFixed(tileOffset(b.xMax, b.zoom), bits);
        const yMin = f64ToFixed(-tileOffset(b.yMin, b.zoom), bits);
        const yMax = f64ToFixed(-tileOffset(b.yMax, b.zoom), bits);
        const zo = BigInt(payload.zoomOffset);
        const oRe = decToFixed(payload.originRe, bits);
        const oIm = decToFixed(payload.originIm, bits);
        const maxIt = payload.iterations;
        const nine = 9n << B;
        const lnR = Math.log(3);
        const toNum = (x) => Number(x >> (B - 52n)) * 2 ** -52;

        // Deterministic sample of anchor escapers.
        const candidates = [];
        for (let p = 0; p < W * H; p++) if (Number.isFinite(anchorValues[p])) candidates.push(p);
        let state = 12345;
        const rng = () => ((state = (Math.imul(state, 1103515245) + 12345) >>> 0) / 4294967296);
        const picks = [];
        while (picks.length < Math.min(samples, candidates.length)) {
          picks.push(candidates[Math.floor(rng() * candidates.length)]);
        }
        const rows = [];
        for (const p of picks) {
          const col = BigInt(p % W);
          const row = BigInt(Math.floor(p / W));
          const cr = oRe + ((xMin + ((xMax - xMin) * col) / BigInt(W - 1)) >> zo);
          const ci = oIm + ((yMin + ((yMax - yMin) * row) / BigInt(H - 1)) >> zo);
          let zr = cr;
          let zi = ci;
          let i = 0;
          while (i < maxIt) {
            const zr2 = (zr * zr) >> B;
            const zi2 = (zi * zi) >> B;
            if (zr2 + zi2 >= nine) break;
            const zri = (zr * zi) >> B;
            zr = zr2 - zi2 + cr;
            zi = 2n * zri + ci;
            i++;
          }
          if (i >= maxIt) continue;
          const truth = i - Math.log(Math.log(Math.hypot(toNum(zr), toNum(zi))) / lnR) / Math.LN2;
          rows.push({ truth, anchor: anchorValues[p], gpu: gpuValues[p] });
        }
        return rows;
      },
      opts.module,
      args,
      payload,
      opts.samples,
    );
    const summarize = (key) => {
      const both = result.filter((r) => Number.isFinite(r[key]));
      const d = both.map((r) => r[key] - Math.fround(r.truth));
      const pos = d.filter((x) => x > 0).length;
      const neg = d.filter((x) => x < 0).length;
      const abs = d.map(Math.abs).sort((a, b) => a - b);
      const countMoved = both.filter((r) => Math.floor(r[key]) !== Math.floor(r.truth)).length;
      return `${key}: ${both.length} px, exact ${both.length - pos - neg}, +${pos}/-${neg}, median |Δ| ${abs[Math.floor(abs.length / 2)]?.toExponential(1)}, p90 ${abs[Math.floor(abs.length * 0.9)]?.toExponential(1)}, count moved ${countMoved}`;
    };
    console.log(`${benchCase.id}: ${result.length} sampled escapers vs BigInt truth`);
    console.log(`  ${summarize("anchor")}`);
    console.log(`  ${summarize("gpu")}`);
  } finally {
    await session.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
