// Holdout validation: the anti-overfitting ship gate for algorithmic
// winners (see the perf-experiment skill). The fixed corpus is the fast
// iteration target and therefore easy to overfit; this runner draws a FRESH
// stratified sample from the user-events export (excluding views already in
// the corpus), runs two variants a/b like run.mjs does, and reports per-tier
// geomeans, the worst movers, and a time-weighted delta. Use a fresh seed
// per experiment (the default derives from today's date) so the holdout
// never becomes a second training set.
//
// Usage:
//   node src/validate.mjs --variants a,b [--events ../events_rows.csv]
//     [--per-tier 40] [--seed S] [--samples 3] [--warmup 1]
//     [--budget-ms 8000] [--tile-size 100] [--pixel-check] [--out ...]
//
// --pixel-check renders each holdout view once per variant and byte-compares
// the output instead of timing; run it whenever the change under test has
// any accepted pixel diff (artifact classes can hide on view shapes the
// fixed corpus lacks). With --tolerance it instead compares the CANDIDATE
// (second variant) against the pinned output anchor (bench/anchor.json)
// under the committed budgets - the anchor is a pinned build, so fresh
// holdout views get their reference values generated on demand and drift
// stays bounded on views the fixed corpus has never seen. --statistical is
// the same anchor-relative flow judged by the statistical-equivalence
// budgets instead (rounding-class changes only; see src/tolerance.mjs).
// Holdout tiles render at --tile-size (default 100):
// per-pixel cost is size-invariant, so relative deltas are preserved while
// heavyweight real views stay inside the budget. Holdout results are
// machine-local (bench/results/); never copy session ids or share URLs out
// of them - the sampled rows carry only coordinates/zoom/iterations.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { candidateKeyFor, extractCandidates, fnv1a, loadRows } from "./ingest.mjs";
import { caseToWasmArgs, PATHWAYS } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";
import { median, mad, geomean, isSignificant } from "./stats.mjs";
import {
  diffValues,
  diffValuesStatistical,
  formatStatisticalResult,
  formatToleranceResult,
  readAnchorConfig,
} from "./tolerance.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {
    variants: null,
    events: join(benchDir, "..", "events_rows.csv"),
    corpus: join(benchDir, "corpus", "corpus.json"),
    perTier: 40,
    seed: null,
    samples: 3,
    warmup: 1,
    budgetMs: 8000,
    tileSize: 100,
    pixelCheck: false,
    tolerance: false,
    statistical: false,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variants") opts.variants = argv[++i].split(",");
    else if (arg === "--events") opts.events = resolve(argv[++i]);
    else if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--per-tier") opts.perTier = Number(argv[++i]);
    else if (arg === "--seed") opts.seed = argv[++i];
    else if (arg === "--samples") opts.samples = Number(argv[++i]);
    else if (arg === "--warmup") opts.warmup = Number(argv[++i]);
    else if (arg === "--budget-ms") opts.budgetMs = Number(argv[++i]);
    else if (arg === "--tile-size") opts.tileSize = Number(argv[++i]);
    else if (arg === "--pixel-check") opts.pixelCheck = true;
    else if (arg === "--tolerance") opts.tolerance = true;
    else if (arg === "--statistical") opts.statistical = true;
    else if (arg === "--out") opts.out = resolve(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.variants || opts.variants.length !== 2) {
    throw new Error(
      "Usage: node src/validate.mjs --variants a,b [--events <csv>] [--per-tier N] " +
        "[--seed S] [--samples N] [--budget-ms N] [--tile-size N] [--pixel-check]",
    );
  }
  // Fresh seed per experiment by default: derived from the date, so a rerun
  // on the same day reproduces, but tomorrow's experiment gets a new sample.
  if (opts.seed === null) opts.seed = new Date().toISOString().slice(0, 10);
  return opts;
}

// mulberry32 over an FNV-hashed string seed: tiny, deterministic,
// good enough for stratified sampling.
function seededRng(seed) {
  let state = parseInt(fnv1a(String(seed)), 16) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(array, rng) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function sampleHoldout({ candidates, corpusCases, perTier, seed, tileSize }) {
  const corpusKeys = new Set(
    corpusCases.map((row) =>
      candidateKeyFor({ ...row, exponent: row.overrides?.exponent ?? 2 }),
    ),
  );
  const rng = seededRng(seed);
  const cases = [];
  const tierCounts = {};
  for (const pathway of PATHWAYS) {
    const pool = candidates.filter(
      (candidate) =>
        candidate.pathway === pathway && !corpusKeys.has(candidate.key),
    );
    const picks = shuffle(pool, rng).slice(0, perTier);
    tierCounts[pathway] = { pool: pool.length, sampled: picks.length };
    for (const pick of picks) {
      cases.push({
        id: `hold-z${pick.zoom}-${fnv1a(pick.key)}`,
        re: pick.re,
        im: pick.im,
        zoom: pick.zoom,
        iterations: pick.iterations,
        pathway,
        weight: { sessions: pick.sessions, recency: pick.recency },
        overrides: {
          ...(pick.exponent !== 2 && { exponent: pick.exponent }),
          tileSize,
        },
      });
    }
  }
  cases.sort((a, b) => a.zoom - b.zoom || a.id.localeCompare(b.id));
  return { cases, tierCounts };
}

function formatDelta(ratio) {
  const percent = (ratio - 1) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

async function runPixelCheck(session, opts, cases, defaults) {
  const differing = [];
  for (const benchCase of cases) {
    const [, args] = caseToWasmArgs(benchCase, defaults);
    const [tileA, tileB] = await Promise.all(
      [0, 1].map((index) =>
        session.page
          .evaluate(
            (variantIndex, wasmArgs) => window.getTile(variantIndex, wasmArgs),
            index,
            args,
          )
          .then((base64) => Buffer.from(base64, "base64")),
      ),
    );
    if (tileA.equals(tileB)) {
      console.log(`${benchCase.id}: identical`);
    } else {
      let pixelsDiff = 0;
      for (let i = 0; i < Math.min(tileA.length, tileB.length); i += 4) {
        for (let channel = 0; channel < 4; channel++) {
          if (tileA[i + channel] !== tileB[i + channel]) {
            pixelsDiff++;
            break;
          }
        }
      }
      console.log(
        `${benchCase.id}: DIFFERS - ${pixelsDiff}/${tileA.length / 4} pixels ` +
          `(z${benchCase.zoom} i${benchCase.iterations} e${benchCase.overrides?.exponent ?? 2})`,
      );
      differing.push(benchCase.id);
    }
  }
  if (differing.length > 0) {
    console.log(
      `\n${differing.length}/${cases.length} holdout views differ between ` +
        `${opts.variants[0]} and ${opts.variants[1]}: ${differing.join(", ")}`,
    );
    process.exit(1);
  }
  console.log(`\nAll ${cases.length} holdout views byte-identical.`);
}

// Anchor-relative gate on the holdout sample: the candidate's values vs
// references generated on demand by the pinned anchor build, judged by the
// strict tolerance budgets or (--statistical) the statistical-equivalence
// budgets.
async function runToleranceHoldout(session, opts, cases, defaults, anchor) {
  const failing = [];
  for (const benchCase of cases) {
    const [payload, args] = caseToWasmArgs(benchCase, defaults);
    const [valuesAnchor, valuesCandidate] = await Promise.all(
      [0, 1].map((index) =>
        session.page
          .evaluate(
            (variantIndex, wasmArgs) => window.getValues(variantIndex, wasmArgs),
            index,
            args,
          )
          .then((base64) => Buffer.from(base64, "base64")),
      ),
    );
    const stats = opts.statistical
      ? diffValuesStatistical(
          valuesAnchor,
          valuesCandidate,
          payload.imageWidth,
          anchor.statisticalBudgets,
        )
      : diffValues(valuesAnchor, valuesCandidate, payload.imageWidth, anchor.budgets);
    console.log(
      opts.statistical
        ? formatStatisticalResult(benchCase.id, stats)
        : formatToleranceResult(benchCase.id, stats),
    );
    if (!stats.pass) failing.push(benchCase.id);
  }
  const gateName = opts.statistical ? "statistical-equivalence" : "tolerance";
  if (failing.length > 0) {
    console.log(
      `\n${failing.length}/${cases.length} holdout views exceed the anchor ` +
        `${gateName} budget: ${failing.join(", ")}\n` +
        `This is an escalation, not an acceptance path: either the change is ` +
        `wrong, or it needs an explicit re-anchor decision (LOG.md entry + ` +
        `re-pin bench/anchor.json).`,
    );
    process.exit(1);
  }
  console.log(
    `\nAll ${cases.length} holdout views within the anchor ${gateName} budget.`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [baseline, candidate] = opts.variants;
  const variantMetas = Object.fromEntries(
    opts.variants.map((name) => [name, readVariantMeta(name)]),
  );

  if (opts.tolerance && opts.statistical) {
    throw new Error("--tolerance and --statistical are mutually exclusive");
  }
  if ((opts.tolerance || opts.statistical) && !opts.pixelCheck) {
    throw new Error("--tolerance/--statistical require --pixel-check");
  }
  let anchor = null;
  if (opts.tolerance || opts.statistical) {
    anchor = readAnchorConfig();
    const anchorMeta = readVariantMeta(anchor.variant);
    if (!anchorMeta.gitSha.startsWith(anchor.gitSha)) {
      throw new Error(
        `Anchor artifact "${anchor.variant}" was built from ${anchorMeta.gitSha}, ` +
          `but anchor.json pins ${anchor.gitSha}; rebuild it: ` +
          `node src/build.mjs ${anchor.variant} --ref ${anchor.gitSha}`,
      );
    }
    if (opts.statistical && !anchor.statisticalBudgets) {
      throw new Error("anchor.json has no statisticalBudgets");
    }
    console.log(
      opts.statistical
        ? `Statistical-equivalence gate: ${candidate} vs anchor ` +
            `@${anchor.gitSha.slice(0, 7)} (budgets in anchor.json ` +
            `statisticalBudgets; semantics in src/tolerance.mjs)`
        : `Tolerance gate: ${candidate} vs anchor @${anchor.gitSha.slice(0, 7)} ` +
            `(budgets: |Δ| ≤ ${anchor.budgets.maxAbsDelta}, ` +
            `diff ≤ ${anchor.budgets.maxDiffFraction * 100}%, ` +
            `blob ≤ ${anchor.budgets.maxBlobPx} px, flips ≤ ${anchor.budgets.maxFlips})`,
    );
  }

  const corpus = JSON.parse(readFileSync(opts.corpus, "utf8"));
  const rows = loadRows(opts.events);
  const { candidates, skipped } = extractCandidates(rows);
  const { cases, tierCounts } = sampleHoldout({
    candidates,
    corpusCases: corpus.cases,
    perTier: opts.perTier,
    seed: opts.seed,
    tileSize: opts.tileSize,
  });
  console.log(
    `Holdout sample (seed "${opts.seed}", tileSize ${opts.tileSize}): ` +
      Object.entries(tierCounts)
        .map(([tier, c]) => `${tier} ${c.sampled}/${c.pool}`)
        .join(", ") +
      ` (${rows.length} rows, ${skipped} skipped, corpus views excluded)`,
  );

  const session = await startSession(
    anchor ? [anchor.variant, candidate] : opts.variants,
  );
  const results = [];
  try {
    if (opts.pixelCheck) {
      if (anchor) {
        await runToleranceHoldout(session, opts, cases, corpus.defaults, anchor);
      } else {
        await runPixelCheck(session, opts, cases, corpus.defaults);
      }
      return;
    }

    for (const benchCase of cases) {
      const [, args] = caseToWasmArgs(benchCase, corpus.defaults);
      const perVariant = new Map(
        opts.variants.map((name) => [name, { samplesMs: [], coldMs: 0 }]),
      );

      for (const [index, name] of opts.variants.entries()) {
        const cold = await session.page.evaluate(
          (variantIndex, wasmArgs) => window.runCase(variantIndex, wasmArgs),
          index,
          args,
        );
        perVariant.get(name).coldMs = cold.ms;
      }
      for (let i = 0; i < opts.warmup; i++) {
        for (const [index] of opts.variants.entries()) {
          await session.page.evaluate(
            (variantIndex, wasmArgs) => window.runCase(variantIndex, wasmArgs),
            index,
            args,
          );
        }
      }

      // Alternating batches like run.mjs, but with a min of 1 sample before
      // the budget check: heavyweight holdout views get one sample rather
      // than blowing the run time.
      const batchSize = Math.ceil(opts.samples / 2);
      const elapsed = new Map(opts.variants.map((name) => [name, 0]));
      for (let round = 0; round < 2; round++) {
        for (const [index, name] of opts.variants.entries()) {
          const state = perVariant.get(name);
          while (
            state.samplesMs.length < Math.min(opts.samples, (round + 1) * batchSize) &&
            (state.samplesMs.length < 1 || elapsed.get(name) < opts.budgetMs)
          ) {
            const sample = await session.page.evaluate(
              (variantIndex, wasmArgs) => window.runCase(variantIndex, wasmArgs),
              index,
              args,
            );
            state.samplesMs.push(sample.ms);
            elapsed.set(name, elapsed.get(name) + sample.ms);
          }
        }
      }

      for (const name of opts.variants) {
        const state = perVariant.get(name);
        results.push({
          caseId: benchCase.id,
          pathway: benchCase.pathway,
          variant: name,
          coldMs: state.coldMs,
          samplesMs: state.samplesMs,
          median: median(state.samplesMs),
          mad: mad(state.samplesMs),
        });
      }
      const base = results[results.length - 2];
      const cand = results[results.length - 1];
      console.log(
        `${benchCase.id} [${benchCase.pathway}] ${base.median.toFixed(1)} -> ` +
          `${cand.median.toFixed(1)} ms (${formatDelta(cand.median / base.median)})`,
      );
    }
  } finally {
    await session.close();
  }

  // Report: per-tier geomeans, worst movers, time-weighted delta.
  const byCase = new Map();
  for (const row of results) {
    if (!byCase.has(row.caseId)) byCase.set(row.caseId, {});
    byCase.get(row.caseId)[row.variant] = row;
  }
  const perTier = new Map();
  const movers = [];
  let totalBase = 0;
  let totalCand = 0;
  let weightedLogSum = 0;
  let weightSum = 0;
  for (const [caseId, variants] of byCase) {
    const base = variants[baseline];
    const cand = variants[candidate];
    const ratio = cand.median / base.median;
    if (!perTier.has(base.pathway)) perTier.set(base.pathway, []);
    perTier.get(base.pathway).push(ratio);
    totalBase += base.median;
    totalCand += cand.median;
    weightedLogSum += base.median * Math.log(ratio);
    weightSum += base.median;
    movers.push({
      caseId,
      pathway: base.pathway,
      baseMs: base.median,
      candMs: cand.median,
      ratio,
      significant: isSignificant(base.median, base.mad, cand.median, cand.mad),
    });
  }

  console.log(`\n## Holdout: ${candidate} vs ${baseline} (seed "${opts.seed}")`);
  const allRatios = [];
  for (const [pathway, ratios] of perTier) {
    console.log(
      `${pathway.padEnd(18)} geomean ${formatDelta(geomean(ratios))} (${ratios.length} views)`,
    );
    allRatios.push(...ratios);
  }
  console.log(`${"overall".padEnd(18)} geomean ${formatDelta(geomean(allRatios))}`);
  console.log(
    `time-weighted delta (by ${baseline} median ms): ` +
      `${formatDelta(Math.exp(weightedLogSum / weightSum))}; ` +
      `total median time ${totalBase.toFixed(0)} -> ${totalCand.toFixed(0)} ms ` +
      `(${formatDelta(totalCand / totalBase)})`,
  );

  movers.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
  console.log("\nWorst movers:");
  for (const mover of movers.slice(0, 10)) {
    console.log(
      `  ${mover.caseId.padEnd(24)} ${mover.pathway.padEnd(18)} ` +
        `${mover.baseMs.toFixed(1).padStart(9)} -> ${mover.candMs.toFixed(1).padStart(9)} ms ` +
        `${formatDelta(mover.ratio).padStart(7)}${mover.significant ? " *" : ""}`,
    );
  }

  const output = {
    meta: {
      date: new Date().toISOString(),
      kind: "holdout",
      seed: opts.seed,
      perTier: opts.perTier,
      tileSize: opts.tileSize,
      samples: opts.samples,
      budgetMs: opts.budgetMs,
      tierCounts,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      host: `${hostname()} ${platform()}/${arch()} ${cpus()[0]?.model ?? ""}`.trim(),
      variantOrder: opts.variants,
      variants: variantMetas,
    },
    cases: cases.map(({ weight, ...rest }) => rest),
    results,
  };
  const outPath =
    opts.out ??
    join(
      benchDir,
      "results",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-holdout-${opts.variants.join("_")}.json`,
    );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults written to ${outPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
