// Composition probe for corpus rows and ingest candidates: renders each view
// at a small probe size (PROBE_SIZE^2) through the wasm exactly like run.mjs
// does (same caseToWasmArgs, same Chrome session) via
// get_mandelbrot_tile_precise(include_values=true), and reduces the values
// buffer to a compact stats block.
//
// The stats are variant-invariant by construction (escape counts are the
// correctness invariant), so they are safe to commit into corpus rows; wall
// times from the probe are machine-dependent and used only for advisory
// output and tileSize-override suggestions. `valuesHash` is the blessed
// FNV-1a hash of the probe's values buffer, used for output-drift detection.
//
// Standalone CLI (stats backfill + drift check):
//   node src/enrich.mjs [--corpus corpus/corpus.json] [--artifact <name>]
//     [--budget-ms 15000] [--write]
//       Probes every corpus row and backfills/refreshes its `stats` block
//       (notes, overrides, and row order are untouched; unchanged stats keep
//       their original date/sha so re-running is idempotent). --write saves.
//
//   node src/enrich.mjs --check <variant> [--filter <s>] [--bless]
//       Drift detector: re-probes every corpus row with <variant> and
//       compares against the blessed stats.valuesHash. Exits 1 on drift.
//       Re-bless flow for INTENTIONAL output changes: verify the diff is
//       understood (pixel-check + cargo insta), then re-run with --bless to
//       rewrite the stats blocks from this variant, and say why in LOG.md.
//
// If no --artifact is given a `probe` artifact is built (production flags)
// when missing; stats provenance records the artifact's git sha.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVariant, PRODUCTION_DEFAULTS } from "./build.mjs";
import { caseToWasmArgs } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cachePath = join(benchDir, "results", "probe-cache.json");

export const PROBE_SIZE = 64;
export const GENERATOR = "enrich-v1";
export const DEFAULT_PROBE_BUDGET_MS = 15000;

// Everything that changes the values buffer participates in the identity:
// coordinates, zoom, iterations, exponent, and smoothColoring (palette
// settings do not affect values).
export function probeKey(benchCase, defaults) {
  const merged = { ...defaults, ...(benchCase.overrides ?? {}) };
  return [
    GENERATOR,
    `p${PROBE_SIZE}`,
    benchCase.re,
    benchCase.im,
    `z${benchCase.zoom}`,
    `i${benchCase.iterations}`,
    `e${merged.exponent}`,
    `s${merged.smoothColoring ? 1 : 0}`,
  ].join("|");
}

// The committed stats block: variant-invariant composition numbers plus
// provenance. Probe wall time is deliberately excluded (machine-dependent).
export function statsBlock(probeResult, artifactSha) {
  return {
    generator: GENERATOR,
    date: new Date().toISOString().slice(0, 10),
    sha: artifactSha.slice(0, 8),
    probeSize: PROBE_SIZE,
    interior: probeResult.interior,
    nearMax50: probeResult.nearMax50,
    nearMax90: probeResult.nearMax90,
    escMean: probeResult.escMean,
    escP50: probeResult.escP50,
    escP90: probeResult.escP90,
    escP99: probeResult.escP99,
    iterSum: probeResult.iterSum,
    valuesHash: probeResult.valuesHash,
  };
}

const INVARIANT_FIELDS = [
  "probeSize",
  "interior",
  "nearMax50",
  "nearMax90",
  "escMean",
  "escP50",
  "escP90",
  "escP99",
  "iterSum",
  "valuesHash",
];

// Stats are generated, never hand-edited; keep the original provenance when
// nothing measurable changed so re-running the pipeline is a no-op diff.
export function mergeStats(oldStats, newStats) {
  if (
    oldStats &&
    INVARIANT_FIELDS.every((field) => oldStats[field] === newStats[field])
  ) {
    return oldStats;
  }
  return newStats;
}

function loadCache() {
  try {
    return JSON.parse(readFileSync(cachePath, "utf8"));
  } catch {
    return {};
  }
}

function saveCache(cache) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache) + "\n");
}

export function resolveProbeArtifact(name) {
  if (name) {
    return { name, meta: readVariantMeta(name) };
  }
  const probeMeta = join(benchDir, "artifacts", "probe", "meta.json");
  if (!existsSync(probeMeta)) {
    console.log("No --artifact given; building `probe` with production flags...");
    buildVariant({ ...PRODUCTION_DEFAULTS, name: "probe" });
  }
  return { name: "probe", meta: readVariantMeta("probe") };
}

// A prober owns one Chrome session for a single artifact. Probes that exceed
// the budget are aborted by tearing the session down (a running wasm call
// cannot be preempted) and reported as { skipped: true }.
export async function createProber({ artifact, budgetMs, useCache = true }) {
  const { name, meta } = resolveProbeArtifact(artifact);
  const budget = budgetMs ?? DEFAULT_PROBE_BUDGET_MS;
  const cache = useCache ? loadCache() : {};
  let session = await startSession([name]);
  let dirty = 0;

  return {
    artifactName: name,
    artifactSha: meta.gitSha,

    // benchCase: corpus-style row ({re, im, zoom, iterations, overrides?}).
    // Returns the in-page probe result, { skipped: true, reason } on budget
    // overrun, and caches by view identity (stats are variant-invariant).
    async probe(benchCase, defaults) {
      const key = probeKey(benchCase, defaults);
      if (useCache && cache[key] && !cache[key].skipped) return cache[key];

      const probeCase = {
        ...benchCase,
        overrides: { ...(benchCase.overrides ?? {}), tileSize: PROBE_SIZE },
      };
      const [, args] = caseToWasmArgs(probeCase, defaults);

      const evaluation = session.page
        .evaluate((index, wasmArgs) => window.probeCase(index, wasmArgs), 0, args)
        .catch((error) => ({ error: String(error) }));
      const result = await Promise.race([
        evaluation,
        new Promise((r) => setTimeout(r, budget, { timedOut: true })),
      ]);

      if (result?.timedOut) {
        // The wasm call is still running; the only way out is a fresh session.
        await session.close().catch(() => {});
        session = await startSession([name]);
        const skipped = { skipped: true, reason: `probe exceeded ${budget} ms` };
        cache[key] = skipped;
        dirty++;
        return skipped;
      }
      if (result?.error) throw new Error(`probe failed: ${result.error}`);

      cache[key] = result;
      if (useCache && ++dirty % 500 === 0) saveCache(cache);
      return result;
    },

    async close() {
      if (useCache && dirty > 0) saveCache(cache);
      await session.close();
    },
  };
}

function parseArgs(argv) {
  const opts = {
    corpus: join(benchDir, "corpus", "corpus.json"),
    artifact: null,
    budgetMs: DEFAULT_PROBE_BUDGET_MS,
    write: false,
    check: null,
    bless: false,
    filter: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--artifact") opts.artifact = argv[++i];
    else if (arg === "--budget-ms") opts.budgetMs = Number(argv[++i]);
    else if (arg === "--write") opts.write = true;
    else if (arg === "--check") opts.check = argv[++i];
    else if (arg === "--bless") opts.bless = true;
    else if (arg === "--filter") opts.filter = argv[++i];
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (opts.bless && !opts.check) {
    throw new Error("--bless only makes sense with --check <variant>");
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const corpus = JSON.parse(readFileSync(opts.corpus, "utf8"));
  let cases = corpus.cases;
  if (opts.filter) {
    cases = cases.filter((benchCase) => benchCase.id.includes(opts.filter));
  }

  const prober = await createProber({
    artifact: opts.check ?? opts.artifact,
    budgetMs: opts.budgetMs,
    // A drift check must re-render with the variant under test, not reuse
    // cached invariant stats.
    useCache: !opts.check,
  });

  let changed = 0;
  let drifted = 0;
  let skipped = 0;
  try {
    for (const benchCase of cases) {
      const result = await prober.probe(benchCase, corpus.defaults);
      if (result.skipped) {
        console.log(`${benchCase.id}: SKIPPED (${result.reason})`);
        skipped++;
        continue;
      }

      if (opts.check) {
        const blessed = benchCase.stats?.valuesHash;
        if (!blessed) {
          console.log(`${benchCase.id}: no blessed hash (run enrich --write first)`);
        } else if (blessed !== result.valuesHash) {
          console.log(
            `${benchCase.id}: DRIFT - blessed ${blessed}, ${prober.artifactName} produced ${result.valuesHash}`,
          );
          drifted++;
        } else {
          console.log(`${benchCase.id}: ok`);
        }
        if (!opts.bless) continue;
      }

      const merged = mergeStats(
        benchCase.stats,
        statsBlock(result, prober.artifactSha),
      );
      if (merged !== benchCase.stats) {
        benchCase.stats = merged;
        changed++;
        if (!opts.check) {
          console.log(
            `${benchCase.id}: stats updated -` +
              ` interior ${(result.interior * 100).toFixed(1)}%` +
              ` nearMax90 ${(result.nearMax90 * 100).toFixed(1)}%` +
              ` iterSum ${result.iterSum} (probe ${result.ms.toFixed(0)} ms)`,
          );
        }
      } else if (!opts.check) {
        console.log(`${benchCase.id}: stats unchanged`);
      }
    }
  } finally {
    await prober.close();
  }

  if (opts.check && !opts.bless) {
    if (drifted > 0) {
      console.log(
        `\n${drifted}/${cases.length} cases drifted from blessed hashes.` +
          " If intentional, re-run with --bless and justify in LOG.md.",
      );
      process.exit(1);
    }
    console.log(`\nAll ${cases.length} probed cases match blessed hashes.`);
    return;
  }

  console.log(
    `\n${changed} of ${cases.length} stats blocks ${opts.bless ? "re-blessed" : "changed"}` +
      (skipped > 0 ? ` (${skipped} skipped over budget)` : ""),
  );
  if ((opts.write || opts.bless) && changed > 0) {
    writeFileSync(opts.corpus, JSON.stringify(corpus, null, 2) + "\n");
    console.log(`Wrote ${opts.corpus}`);
  } else if (changed > 0) {
    console.log("Dry run; pass --write to save.");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
