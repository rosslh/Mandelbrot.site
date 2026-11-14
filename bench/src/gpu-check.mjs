// GPU-lane correctness gate (backlog G1): renders corpus cases through the
// WebGPU lane's kernel (client/js/gpu.js, loaded straight into the bench
// page) and judges the escape values against the pinned output ANCHOR with
// the statistical-equivalence tier (src/tolerance.mjs, anchor.json
// statisticalBudgets), exactly as `pixel-check --statistical` judges a wasm
// variant. Also runs a GPU A/A check: two renders of each case must be
// byte-identical on this machine, or the gate cannot tell a kernel change
// from GPU nondeterminism.
//
//   node src/gpu-check.mjs [--corpus corpus/corpus.json] [--filter <s>]
//     [--force] [--json <out.json>] [--holdout N [--seed S]]
//
// By default only cases the lane covers (gpuCovers) are judged; the rest are
// listed as skipped. --force renders every exponent-2 case regardless of the
// precision cutoff, which is how the cutoff itself is measured: the deepest
// passing zoom bounds where the lane may be turned on.
//
// --holdout N replaces the corpus with a fresh sample of N real views from
// the events export (events_rows.csv at the repo root) that the lane covers
// and the corpus does not contain: the anti-overfitting gate for the lane's
// cutoff. The seed defaults to today's date, like validate.mjs.
//
// Exit 1 when a judged case fails, or when no hardware adapter is present.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isHardwareWebGPU, probeGpu } from "./gpu-probe.mjs";
import {
  candidateKeyFor,
  extractCandidates,
  fnv1a,
  loadRows,
} from "./ingest.mjs";
import { caseToWasmArgs } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";
import {
  diffValuesStatistical,
  formatStatisticalResult,
  readAnchorConfig,
} from "./tolerance.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {
    corpus: join(benchDir, "corpus", "corpus.json"),
    filter: null,
    force: false,
    json: null,
    holdout: 0,
    seed: new Date().toISOString().slice(0, 10),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--force") opts.force = true;
    else if (arg === "--json") opts.json = resolve(argv[++i]);
    else if (arg === "--holdout") opts.holdout = Number(argv[++i]);
    else if (arg === "--seed") opts.seed = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  return opts;
}

// Size of the per-pixel differences on pixels both renders call escapers:
// quantiles of |Δ| and the share within 4 f32 ulps of the anchor value
// (pure narrowing/rounding noise, as opposed to a moved escape count).
function deltaMagnitudes(anchorBytes, candidateBytes) {
  const a = new Float32Array(
    anchorBytes.buffer,
    anchorBytes.byteOffset,
    anchorBytes.length / 4,
  );
  const b = new Float32Array(
    candidateBytes.buffer,
    candidateBytes.byteOffset,
    candidateBytes.length / 4,
  );
  const deltas = [];
  let withinUlps = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i]) || a[i] === b[i])
      continue;
    const delta = Math.abs(a[i] - b[i]);
    deltas.push(delta);
    if (delta <= 4 * Math.abs(a[i]) * 2 ** -23) withinUlps++;
  }
  deltas.sort((x, y) => x - y);
  const q = (f) =>
    deltas.length
      ? deltas[Math.min(deltas.length - 1, Math.floor(f * deltas.length))]
      : 0;
  return {
    count: deltas.length,
    p50: q(0.5),
    p90: q(0.9),
    p99: q(0.99),
    max: deltas.length ? deltas[deltas.length - 1] : 0,
    ulpFraction: deltas.length ? withinUlps / deltas.length : 0,
  };
}

// Seeded shuffle (mulberry32 over an FNV-hashed seed) of the export's
// exponent-2 views; the lane's coverage check happens per case later, so
// this over-samples shallow-enough views and keeps the first N.
function holdoutCases(opts, corpusCases) {
  const repoDir = resolve(benchDir, "..");
  const { candidates } = extractCandidates(
    loadRows(join(repoDir, "events_rows.csv")),
  );
  const corpusKeys = new Set(
    corpusCases.map((row) =>
      candidateKeyFor({ ...row, exponent: row.overrides?.exponent ?? 2 }),
    ),
  );
  // Over-sample to effective zoom 31 (2^-36 at 200px tiles), deeper than
  // the lane covers today, so --force holdouts also probe past the cutoff.
  const pool = candidates.filter(
    (c) => c.exponent === 2 && c.zoom <= 31 && !corpusKeys.has(c.key),
  );
  let state = parseInt(fnv1a(`gpu-${opts.seed}`), 16) >>> 0;
  const rng = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  console.log(
    `Holdout: ${opts.holdout} of ${pool.length} uncovered-by-corpus export views (seed "${opts.seed}")`,
  );
  return pool
    .slice(0, opts.holdout)
    .map((pick) => ({
      id: `hold-z${pick.zoom}-${fnv1a(pick.key)}`,
      re: pick.re,
      im: pick.im,
      zoom: pick.zoom,
      iterations: pick.iterations,
    }))
    .sort((a, b) => a.zoom - b.zoom || a.id.localeCompare(b.id));
}

// The worker's tile payload for a corpus case (the shape gpu.js reads).
function gpuPayload(payload) {
  return {
    originRe: payload.originRe,
    originIm: payload.originIm,
    bounds: payload.bounds,
    zoomOffset: payload.zoomOffset,
    maxIterations: payload.iterations,
    power: payload.exponent,
    imageWidth: payload.imageWidth,
    imageHeight: payload.imageHeight,
    smoothColoring: payload.smoothColoring,
    coloring: {},
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(readFileSync(opts.corpus, "utf8"));
  let cases = corpus.cases;
  if (opts.holdout > 0) cases = holdoutCases(opts, corpus.cases);
  if (opts.filter) cases = cases.filter((c) => c.id.includes(opts.filter));

  const anchor = readAnchorConfig();
  const anchorMeta = readVariantMeta(anchor.variant);
  if (!anchorMeta.gitSha.startsWith(anchor.gitSha)) {
    throw new Error(
      `Anchor artifact was built from ${anchorMeta.gitSha}, but anchor.json pins ` +
        `${anchor.gitSha}; rebuild: node src/build.mjs ${anchor.variant} --ref ${anchor.gitSha}`,
    );
  }

  const session = await startSession([anchor.variant]);
  const results = [];
  let failed = 0;
  try {
    const report = await probeGpu(session.browser);
    if (!isHardwareWebGPU(report)) {
      throw new Error("No hardware WebGPU adapter; see node src/gpu-probe.mjs");
    }
    await session.page.evaluate(async () => {
      const module = await import("/client/js/gpu.js");
      window.gpuModule = module;
      window.gpuLane = await module.createGpuLane();
      const toBase64 = (values) => {
        const bytes = new Uint8Array(
          values.buffer,
          values.byteOffset,
          values.byteLength,
        );
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        return btoa(binary);
      };
      window.getGpuValues = async (payload) =>
        toBase64((await window.gpuLane.renderValues(payload)).values);
    });

    console.log(
      `GPU lane vs anchor @${anchor.gitSha.slice(0, 7)} (statistical tier), ` +
        `${opts.force ? "all exponent-2 cases (--force)" : "covered cases only"}\n`,
    );
    for (const benchCase of cases) {
      const [payload, args] = caseToWasmArgs(benchCase, corpus.defaults);
      const request = gpuPayload(payload);
      const covered = await session.page.evaluate(
        (p) => window.gpuModule.gpuCovers(p),
        request,
      );
      if (!covered && !(opts.force && request.power === 2)) {
        console.log(`${benchCase.id}: skipped (not covered)`);
        results.push({
          id: benchCase.id,
          zoom: benchCase.zoom,
          covered,
          skipped: true,
        });
        continue;
      }
      const anchorValues = Buffer.from(
        await session.page.evaluate((a) => window.getValues(0, a), args),
        "base64",
      );
      const first = Buffer.from(
        await session.page.evaluate((p) => window.getGpuValues(p), request),
        "base64",
      );
      const second = Buffer.from(
        await session.page.evaluate((p) => window.getGpuValues(p), request),
        "base64",
      );
      const deterministic = first.equals(second);
      const stats = diffValuesStatistical(
        anchorValues,
        first,
        payload.imageWidth,
        anchor.statisticalBudgets,
      );
      const pass = stats.pass && deterministic;
      const magnitude = deltaMagnitudes(anchorValues, first);
      if (!pass && covered) failed++;
      console.log(
        `${formatStatisticalResult(benchCase.id, stats)}` +
          `${deterministic ? "" : "  GPU A/A: NOT DETERMINISTIC"}` +
          `${covered ? "" : "  (outside coverage)"}`,
      );
      console.log(
        `    escaper |Δ| (both finite, ${magnitude.count} px): p50 ${magnitude.p50.toExponential(1)}, ` +
          `p90 ${magnitude.p90.toExponential(1)}, p99 ${magnitude.p99.toExponential(1)}, ` +
          `max ${magnitude.max.toExponential(1)}; ≤ 4 f32 ulp: ${(magnitude.ulpFraction * 100).toFixed(1)}%`,
      );
      results.push({
        id: benchCase.id,
        zoom: benchCase.zoom,
        iterations: benchCase.iterations,
        covered,
        deterministic,
        pass,
        stats,
        magnitude,
      });
    }
  } finally {
    await session.close();
  }

  if (opts.json)
    writeFileSync(
      opts.json,
      JSON.stringify({ anchor: anchor.gitSha, results }, null, 2),
    );
  const judged = results.filter((r) => r.covered);
  console.log(
    `\n${judged.length - failed}/${judged.length} covered cases pass` +
      (opts.force
        ? `; outside coverage: ${results.filter((r) => !r.covered && !r.skipped && r.pass).length}/` +
          `${results.filter((r) => !r.covered && !r.skipped).length} pass`
        : ""),
  );
  if (judged.length === 0) {
    console.error(
      "FAIL: no covered case was judged (filter, holdout or cutoff left nothing)",
    );
    process.exit(1);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
