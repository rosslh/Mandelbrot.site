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
//     [--module <url>] [--lane-options <json>] [--min-zoom Z] [--max-zoom Z]
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
// --min-zoom/--max-zoom bound the holdout's zoom range (default 0..31), and
// the corpus's when given without --holdout.
//
// --module swaps the lane module for another with the same interface
// (createGpuLane, gpuCovers), served from the repo root: a bench-only
// prototype kernel such as /bench/page/gpu-perturb.js (G3) is gated the
// same way the shipped lane is. --lane-options passes a JSON object to the
// module's createGpuLane (e.g. '{"mariani":[20],"leafPeriodicity":0}').
//
// --reference anchor|truth|auto picks what GPU output is judged against
// (Ross, 2026-11-17; LOG directives 2026-11-17 and 2026-11-18). `anchor`
// (default) is the statistical tier vs the pinned anchor. `truth` is the
// truth tier: BigInt truth (src/truth.mjs) for every pixel of the tile, and
// the same statistical tier and budgets with truth as the reference, plus
// truth.json's extraBudgets when set. --samples N judges a uniform sample
// of N pixels instead (escapers and interior alike), on the tier's
// non-spatial axes only (flip and sign balance, central-quantile drift);
// that mode is weaker and for exploration, not for gate runs. The anchor's
// own error against the same truth is printed beside the GPU's, which is
// how the crossover was measured. `auto` uses the anchor tier at pixel
// spacing above 2^crossoverSpacingLog2 (truth.json) and the truth tier at or
// below it.
//
// --far K moves each case's view origin K tiles left and up of the tile
// while the tile renders the same region (normalize.mjs shiftOrigin; exact,
// the shift is dyadic): the case of a tile panned or zoomed K tiles away
// from the origin the view was set at. Coverage is unchanged by the shift
// (the lane does not route by distance; it re-references instead).
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
import { caseToWasmArgs, payloadArgs, shiftOrigin } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";
import {
  compareToTruth,
  formatTruthStats,
  judgeTruth,
  sampleTruth,
} from "./truth.mjs";
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
    module: "/client/js/gpu.js",
    laneOptions: {},
    minZoom: 0,
    maxZoom: 31,
    reference: "anchor",
    samples: Infinity,
    far: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--force") opts.force = true;
    else if (arg === "--json") opts.json = resolve(argv[++i]);
    else if (arg === "--holdout") opts.holdout = Number(argv[++i]);
    else if (arg === "--seed") opts.seed = argv[++i];
    else if (arg === "--module") opts.module = argv[++i];
    else if (arg === "--lane-options") opts.laneOptions = JSON.parse(argv[++i]);
    else if (arg === "--min-zoom") {
      opts.minZoom = Number(argv[++i]);
      opts.minZoomSet = true;
    } else if (arg === "--max-zoom") {
      opts.maxZoom = Number(argv[++i]);
      opts.maxZoomSet = true;
    } else if (arg === "--reference") opts.reference = argv[++i];
    else if (arg === "--far") {
      opts.far = Number(argv[++i]);
      if (!Number.isInteger(opts.far) || opts.far < 0)
        throw new Error("--far must be a non-negative integer");
    } else if (arg === "--samples") {
      const v = argv[++i];
      opts.samples = v === "all" ? Infinity : Number(v);
      if (
        !(
          opts.samples === Infinity ||
          (Number.isInteger(opts.samples) && opts.samples > 0)
        )
      )
        throw new Error(
          `--samples must be a positive integer or all, got ${v}`,
        );
    } else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!["anchor", "truth", "auto"].includes(opts.reference))
    throw new Error(`--reference must be anchor, truth or auto`);
  return opts;
}

function readTruthConfig() {
  return JSON.parse(readFileSync(join(benchDir, "truth.json"), "utf8"));
}

// log2 of a tile's pixel spacing in the complex plane (200/128 * 4 / 2^z
// per tile width, as normalize.mjs lays tiles out).
function spacingLog2(payload) {
  const zoom = payload.bounds.zoom + payload.zoomOffset;
  return Math.log2((200 / 128) * 4) - zoom - Math.log2(payload.imageWidth - 1);
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
  // By default over-sample to effective zoom 31 (2^-36 at 200px tiles),
  // deeper than the lane covers today, so --force holdouts also probe past
  // the cutoff.
  const pool = candidates.filter(
    (c) =>
      c.exponent === 2 &&
      c.zoom >= opts.minZoom &&
      c.zoom <= opts.maxZoom &&
      !corpusKeys.has(c.key),
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
  else if (opts.minZoomSet || opts.maxZoomSet) {
    // The holdout's default max (31) does not apply to the corpus.
    const max = opts.maxZoomSet ? opts.maxZoom : Infinity;
    cases = cases.filter((c) => c.zoom >= opts.minZoom && c.zoom <= max);
  }
  if (opts.filter) cases = cases.filter((c) => c.id.includes(opts.filter));

  const anchor = readAnchorConfig();
  const truthConfig = readTruthConfig();
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
    await session.page.evaluate(
      async (moduleUrl, laneOptions) => {
        const module = await import(moduleUrl);
        window.gpuModule = module;
        window.gpuLane = await module.createGpuLane(laneOptions);
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
      },
      opts.module,
      opts.laneOptions,
    );

    console.log(
      `GPU lane vs ${opts.reference === "anchor" ? `anchor @${anchor.gitSha.slice(0, 7)} (statistical tier)` : opts.reference === "truth" ? "sampled BigInt truth (truth tier)" : `anchor above 2^${truthConfig.crossoverSpacingLog2}, truth at or below`}, ` +
        `${opts.force ? "all exponent-2 cases (--force)" : "covered cases only"}\n`,
    );
    for (const benchCase of cases) {
      let [payload, args] = caseToWasmArgs(benchCase, corpus.defaults);
      if (opts.far) {
        shiftOrigin(payload, opts.far);
        args = payloadArgs(payload);
      }
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
      const log2Spacing = spacingLog2(payload);
      const useTruth =
        opts.reference === "truth" ||
        (opts.reference === "auto" &&
          log2Spacing <= truthConfig.crossoverSpacingLog2);
      if (useTruth) {
        const truthRows = await sampleTruth(
          { ...payload, exponent: request.power },
          { samples: opts.samples, seed: truthConfig.seed },
        );
        const f32 = (buf) =>
          new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
        const gpuStats = compareToTruth(f32(first), truthRows);
        const anchorStats = compareToTruth(f32(anchorValues), truthRows);
        const verdict = judgeTruth(
          gpuStats,
          anchor.statisticalBudgets,
          truthConfig.extraBudgets,
        );
        const anchorVerdict = judgeTruth(
          anchorStats,
          anchor.statisticalBudgets,
          truthConfig.extraBudgets,
        );
        // Whole tile sampled: run the full statistical tier (every axis,
        // spatial ones included) with the truth buffer as the reference.
        let fullGpu = null;
        let fullAnchor = null;
        if (truthRows.length === payload.imageWidth * payload.imageHeight) {
          const truthValues = new Float32Array(truthRows.length);
          for (const { pixel, value } of truthRows) truthValues[pixel] = value;
          const truthBuf = Buffer.from(truthValues.buffer);
          fullGpu = diffValuesStatistical(
            truthBuf,
            first,
            payload.imageWidth,
            anchor.statisticalBudgets,
          );
          fullAnchor = diffValuesStatistical(
            truthBuf,
            anchorValues,
            payload.imageWidth,
            anchor.statisticalBudgets,
          );
        }
        // Whole tile: the full tier decides, plus any extra absolute bounds.
        // Sample: the sampled shared axes decide.
        const pass =
          (fullGpu
            ? fullGpu.pass && verdict.extraReasons.length === 0
            : verdict.pass) && deterministic;
        if (!pass && covered) failed++;
        console.log(
          `${benchCase.id} (spacing 2^${log2Spacing.toFixed(1)}, truth tier, ${truthRows.length} samples)` +
            `${deterministic ? "" : "  GPU A/A: NOT DETERMINISTIC"}` +
            `${covered ? "" : "  (outside coverage)"}`,
        );
        // Whole tile: the full-tier lines below decide, so these summary
        // lines carry no verdict of their own.
        console.log(
          `    ${formatTruthStats("gpu   ", gpuStats, fullGpu ? null : verdict)}`,
        );
        console.log(
          `    ${formatTruthStats("anchor", anchorStats, fullAnchor ? null : anchorVerdict)}`,
        );
        if (fullGpu) {
          console.log(
            `    ${formatStatisticalResult("gpu    vs truth", fullGpu, "truth")}`,
          );
          console.log(
            `    ${formatStatisticalResult("anchor vs truth", fullAnchor, "truth")}`,
          );
        }
        results.push({
          id: benchCase.id,
          re: benchCase.re,
          im: benchCase.im,
          zoom: benchCase.zoom,
          iterations: benchCase.iterations,
          log2Spacing,
          tier: "truth",
          covered,
          deterministic,
          pass,
          sampled: !fullGpu,
          gpu: {
            ...gpuStats,
            ...verdict,
            pass: fullGpu ? pass : verdict.pass,
            full: fullGpu,
          },
          anchor: {
            ...anchorStats,
            ...anchorVerdict,
            pass: fullAnchor
              ? fullAnchor.pass && anchorVerdict.extraReasons.length === 0
              : anchorVerdict.pass,
            full: fullAnchor,
          },
        });
        continue;
      }
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
        log2Spacing,
        tier: "anchor",
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
  // Sampled truth verdicts use floors calibrated on whole tiles, so they are
  // weaker than the gate (review 2026-11-18): never let them pass a run.
  if (results.some((r) => r.sampled)) {
    console.error(
      "NOTE: --samples runs are exploratory, not a gate run (exit 1); use the default whole-tile truth",
    );
    process.exit(1);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
