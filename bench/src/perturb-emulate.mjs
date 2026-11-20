// CPU emulation of perturbation arithmetic, judged against BigInt truth
// (LOG 2026-11-18). It replays the G3 prototype's step (bench/page/
// gpu-perturb.js: reference orbit at the view origin, dz' = (2Z + dz)dz + dc,
// z = Z_{n+1} + dz, rebase when the orbit runs out or |z| < |dz|) on every
// pixel of a tile, choosing per operation whether it is rounded to f32 or
// kept in f64, and reports the sign balance and exact share against
// src/truth.mjs. This isolates which rounding causes a systematic shift,
// without a GPU and without the shader compiler's reassociation.
//
//   node src/perturb-emulate.mjs (--case <corpus id> | --view re,im,zoom,iterations) <mode>
//
// Modes (comma-separated flags):
//   f64     every operation in f64 (the perturbation algorithm in double
//           precision, i.e. what the wasm pf64 lane computes in principle)
//   f32     every operation rounded to f32, the orbit kept in f64
//   gpu     the prototype's default kernel exactly: orbit as f32 hi + lo,
//           t = 2Z_hi + (2Z_lo + dz), z = Z_hi + dz
//   split   the prototype's split kernel: dz' = 2Z_hi dz + ((2Z_lo + dz) dz + dc)
//   split,abfirst   the same with (a + b) + dc, the order Metal reassociates to
//   margin  (with gpu or split) the escape test as m_n + dz.(2Z_n + dz) >= 0,
//           m_n = |Z_n|^2 - R^2 from the BigInt orbit, taken before the rebase,
//           instead of |Z_n + dz|^2 >= R^2 on the rounded z (LOG 2026-11-20)
//   With f32, any of t64 (multiplier), mul64 (products), dz64 (the dz sum),
//   dc64 (pixel offsets) or z64 (z = Z + dz) keeps that operation in f64.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseToWasmArgs } from "./normalize.mjs";
import { frame, sampleTruth } from "./truth.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = { case: null, view: null, mode: "f64" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--case") opts.case = argv[++i];
    else if (arg === "--view") opts.view = argv[++i];
    else opts.mode = arg;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(
    readFileSync(join(benchDir, "corpus", "corpus.json"), "utf8"),
  );
  let benchCase = opts.case
    ? corpus.cases.find((c) => c.id === opts.case)
    : null;
  if (!benchCase && opts.view) {
    const [re, im, zoom, iterations] = opts.view.split(",");
    benchCase = {
      id: "view",
      re,
      im,
      zoom: Number(zoom),
      iterations: Number(iterations),
    };
  }
  if (!benchCase)
    throw new Error("pass --case <id> or --view re,im,zoom,iterations");
  const flags = new Set(opts.mode.split(","));
  const F = Math.fround;
  const I = (x) => x;
  const R = flags.has("f64") ? I : F;
  const Rdc = flags.has("dc64") ? I : R;
  const Rz = flags.has("z64") ? I : R;
  const Rm = flags.has("mul64") ? I : R;
  const Rt = flags.has("t64") ? I : R;
  const Rd = flags.has("dz64") ? I : R;

  const [payload] = caseToWasmArgs(benchCase, corpus.defaults);
  const f = frame(payload);
  const B = BigInt(f.bits);
  const toNumber = (x) => Number(x >> (B - 60n)) * 2 ** -60;
  // Reference orbit at the origin, Z_0 = 0, until it escapes.
  const orbit = [[0, 0]];
  // |Z_n|^2 - R^2 per orbit entry, from the BigInt orbit (the `margin` flag).
  const margins = [-9];
  {
    let zr = f.originRe;
    let zi = f.originIm;
    for (;;) {
      const r = toNumber(zr);
      const i = toNumber(zi);
      orbit.push([r, i]);
      const a = (zr * zr) >> B;
      const b = (zi * zi) >> B;
      margins.push(toNumber(a + b - (9n << B)));
      if (r * r + i * i > 9 || orbit.length > payload.iterations + 2) break;
      const ab = (zr * zi) >> B;
      zr = a - b + f.originRe;
      zi = 2n * ab + f.originIm;
    }
  }
  const last = orbit.length - 1;
  const W = payload.imageWidth;
  const scale = 2 ** -payload.zoomOffset;
  const tileOffset = (v, tz) => v * (200 / 128) * 2 ** -(tz - 2) - 4;
  const bounds = payload.bounds;
  const xMin = tileOffset(bounds.xMin, bounds.zoom);
  const xMax = tileOffset(bounds.xMax, bounds.zoom);
  const yMin = -tileOffset(bounds.yMin, bounds.zoom);
  const yMax = -tileOffset(bounds.yMax, bounds.zoom);
  const columnStep = (xMax - xMin) / (W - 1);
  const rowStep = (yMax - yMin) / (payload.imageHeight - 1);
  const kernel = flags.has("gpu")
    ? "gpu"
    : flags.has("split")
      ? "split"
      : "generic";

  const render = (pixel) => {
    const dcr = Rdc((xMin + columnStep * (pixel % W)) * scale);
    const dci = Rdc((yMin + rowStep * Math.floor(pixel / W)) * scale);
    let n = 0;
    let dr = 0;
    let di = 0;
    let zr = 0;
    let zi = 0;
    let i = 0;
    let escaped = false;
    const margin = flags.has("margin");
    const step = () => {
      const [Zr, Zi] = orbit[n];
      const hr = F(Zr);
      const hi = F(Zi);
      const lr = F(Zr - hr);
      const li = F(Zi - hi);
      let nr;
      let ni;
      if (kernel === "gpu") {
        const tr = F(2 * hr + F(2 * lr + dr));
        const ti = F(2 * hi + F(2 * li + di));
        nr = F(F(F(tr * dr) - F(ti * di)) + dcr);
        ni = F(F(F(tr * di) + F(ti * dr)) + dci);
      } else if (kernel === "split") {
        const ur = F(2 * lr + dr);
        const ui = F(2 * li + di);
        const ar = F(F(2 * hr * dr) - F(2 * hi * di));
        const ai = F(F(2 * hr * di) + F(2 * hi * dr));
        const br = F(F(ur * dr) - F(ui * di));
        const bi = F(F(ur * di) + F(ui * dr));
        if (flags.has("abfirst")) {
          nr = F(F(ar + br) + dcr);
          ni = F(F(ai + bi) + dci);
        } else {
          nr = F(ar + F(br + dcr));
          ni = F(ai + F(bi + dci));
        }
      } else {
        const tr = Rt(2 * Zr + dr);
        const ti = Rt(2 * Zi + di);
        nr = Rd(Rm(Rm(tr * dr) - Rm(ti * di)) + dcr);
        ni = Rd(Rm(Rm(tr * di) + Rm(ti * dr)) + dci);
      }
      dr = nr;
      di = ni;
      n++;
      const [Yr, Yi] = orbit[n];
      if (kernel === "generic") {
        zr = Rz(Yr + dr);
        zi = Rz(Yi + di);
      } else {
        zr = F(F(Yr) + dr);
        zi = F(F(Yi) + di);
      }
      escaped = margin
        ? F(
            F(margins[n] + F(F(F(2 * F(Yr)) + dr) * dr)) +
              F(F(F(2 * F(Yi)) + di) * di),
          ) >= 0
        : zr * zr + zi * zi >= 9;
      if (n === last || zr * zr + zi * zi < dr * dr + di * di) {
        dr = zr;
        di = zi;
        n = 0;
      }
    };
    step(); // the uncounted first step (z = c)
    while (!escaped && i < payload.iterations) {
      i++;
      step();
    }
    if (i >= payload.iterations) return Infinity;
    if (!payload.smoothColoring) return i;
    return i - Math.log(Math.log(Math.hypot(zr, zi)) / Math.log(3)) / Math.LN2;
  };

  const truthConfig = JSON.parse(
    readFileSync(join(benchDir, "truth.json"), "utf8"),
  );
  const rows = await sampleTruth(payload, {
    samples: Infinity,
    seed: truthConfig.seed,
  });
  let pos = 0;
  let neg = 0;
  let exact = 0;
  let moved = 0;
  let common = 0;
  let toInterior = 0;
  let toEscaper = 0;
  for (const row of rows) {
    const v = Math.fround(render(row.pixel));
    if (!Number.isFinite(row.value)) {
      if (Number.isFinite(v)) toEscaper++;
      continue;
    }
    if (!Number.isFinite(v)) {
      toInterior++;
      continue;
    }
    const t = Math.fround(row.value);
    common++;
    if (v === t) exact++;
    else if (v > t) pos++;
    else neg++;
    if (Math.floor(v) !== Math.floor(t)) moved++;
  }
  console.log(
    `${benchCase.id} [${opts.mode}]: ${common} common escapers, exact ${exact}, ` +
      `signs +${pos}/-${neg}, counts moved ${moved}, ` +
      `flips →int ${toInterior} →esc ${toEscaper} (orbit length ${orbit.length})`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
