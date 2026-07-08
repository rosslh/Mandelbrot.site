// Benchmarks tile generation in real Chrome across the corpus, interleaving
// variant measurements so thermal drift hits all sides equally.
//
// Usage:
//   node src/run.mjs --variants baseline[,candidate,...]
//     [--corpus corpus/corpus.json] [--filter <id-substring|pathway>]
//     [--samples 10] [--warmup 3] [--budget-ms 15000] [--out results/....json]
//
// Per case x variant: 1 recorded cold sample (includes reference-orbit
// computation for perturbation cases), then warmups, then measured samples
// taken in alternating batches. Warm output hashes must be identical.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname, cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseToWasmArgs, pathwayFor, validateCase, PATHWAYS } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";
import { median, mad } from "./stats.mjs";
import { formatComparison } from "./compare.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {
    variants: null,
    corpus: join(benchDir, "corpus", "corpus.json"),
    filter: null,
    samples: 10,
    warmup: 3,
    budgetMs: 15000,
    out: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--variants") opts.variants = argv[++i].split(",");
    else if (arg === "--corpus") opts.corpus = resolve(argv[++i]);
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--samples") opts.samples = Number(argv[++i]);
    else if (arg === "--warmup") opts.warmup = Number(argv[++i]);
    else if (arg === "--budget-ms") opts.budgetMs = Number(argv[++i]);
    else if (arg === "--out") opts.out = resolve(argv[++i]);
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.variants || opts.variants.length === 0) {
    throw new Error("Usage: node src/run.mjs --variants baseline[,candidate,...] [options]");
  }
  return opts;
}

function loadCases(corpusPath, filter) {
  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  let cases = corpus.cases.map((benchCase) => {
    const merged = { ...corpus.defaults, ...(benchCase.overrides ?? {}) };
    return {
      ...benchCase,
      pathway: pathwayFor(benchCase.zoom, merged.exponent),
      tileSize: merged.tileSize,
    };
  });
  for (const benchCase of cases) {
    const problems = validateCase(benchCase);
    if (problems.length > 0) {
      throw new Error(`Invalid corpus case ${benchCase.id}: ${problems.join(", ")}`);
    }
  }
  if (filter) {
    cases = cases.filter(
      (benchCase) =>
        benchCase.id.includes(filter) || benchCase.pathway.includes(filter),
    );
    if (cases.length === 0) throw new Error(`--filter "${filter}" matched no cases`);
  } else {
    const covered = new Set(cases.map((benchCase) => benchCase.pathway));
    for (const pathway of PATHWAYS) {
      if (!covered.has(pathway)) {
        throw new Error(`Corpus does not cover pathway "${pathway}"`);
      }
    }
  }
  return { defaults: corpus.defaults, cases };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { defaults, cases } = loadCases(opts.corpus, opts.filter);
  const variantMetas = Object.fromEntries(
    opts.variants.map((name) => [name, readVariantMeta(name)]),
  );

  const session = await startSession(opts.variants);
  const results = [];
  try {
    for (const benchCase of cases) {
      const [, args] = caseToWasmArgs(benchCase, defaults);
      const perVariant = new Map(
        opts.variants.map((name) => [name, { samplesMs: [], hashes: new Set(), coldMs: 0, bytes: 0 }]),
      );

      // Cold pass: first call per variant includes orbit computation.
      for (const [index, name] of opts.variants.entries()) {
        const cold = await session.page.evaluate(
          (variantIndex, wasmArgs) => window.runCase(variantIndex, wasmArgs),
          index,
          args,
        );
        const state = perVariant.get(name);
        state.coldMs = cold.ms;
        state.bytes = cold.bytes;
        state.hashes.add(cold.hash);
      }

      // Warmup passes (unrecorded).
      for (let i = 0; i < opts.warmup; i++) {
        for (const [index] of opts.variants.entries()) {
          await session.page.evaluate(
            (variantIndex, wasmArgs) => window.runCase(variantIndex, wasmArgs),
            index,
            args,
          );
        }
      }

      // Measured samples in two alternating batch rounds (A B A B) so slow
      // drift affects every variant equally.
      const batchSize = Math.ceil(opts.samples / 2);
      const elapsed = new Map(opts.variants.map((name) => [name, 0]));
      for (let round = 0; round < 2; round++) {
        for (const [index, name] of opts.variants.entries()) {
          const state = perVariant.get(name);
          while (
            state.samplesMs.length < Math.min(opts.samples, (round + 1) * batchSize) &&
            (state.samplesMs.length < 5 || elapsed.get(name) < opts.budgetMs)
          ) {
            const sample = await session.page.evaluate(
              (variantIndex, wasmArgs) => window.runCase(variantIndex, wasmArgs),
              index,
              args,
            );
            state.samplesMs.push(sample.ms);
            state.hashes.add(sample.hash);
            elapsed.set(name, elapsed.get(name) + sample.ms);
          }
        }
      }

      for (const name of opts.variants) {
        const state = perVariant.get(name);
        if (state.hashes.size !== 1) {
          throw new Error(
            `Non-deterministic output for ${benchCase.id} on variant ${name}: hashes ${[...state.hashes].join(", ")}`,
          );
        }
        const row = {
          caseId: benchCase.id,
          pathway: benchCase.pathway,
          variant: name,
          coldMs: state.coldMs,
          samplesMs: state.samplesMs,
          median: median(state.samplesMs),
          mad: mad(state.samplesMs),
          min: Math.min(...state.samplesMs),
          bytes: state.bytes,
          hash: [...state.hashes][0],
        };
        // Corpus rows carry probe stats (enrich.mjs): scale the probe's
        // iteration sum to this case's tileSize (per-pixel work is
        // size-invariant) for a machine-independent work proxy, and derive
        // ms per million iterations - the structural-slowness detector (a
        // case whose ms/Miter is far off its pathway's norm is slow for a
        // reason iteration counts don't explain).
        let miterNote = "";
        if (benchCase.stats?.iterSum) {
          const scale = (benchCase.tileSize / benchCase.stats.probeSize) ** 2;
          row.iterSum = Math.round(benchCase.stats.iterSum * scale);
          row.msPerMiter = row.median / (row.iterSum / 1e6);
          row.composition = {
            interior: benchCase.stats.interior,
            nearMax90: benchCase.stats.nearMax90,
          };
          miterNote = `, ${row.msPerMiter.toFixed(3)} ms/Miter`;
        }
        if (benchCase.weight) {
          row.userWeight = benchCase.weight.recency ?? benchCase.weight.sessions;
        }
        results.push(row);
        console.log(
          `${benchCase.id} [${name}] median ${row.median.toFixed(2)} ms ` +
            `(n=${state.samplesMs.length}, cold ${state.coldMs.toFixed(2)} ms${miterNote})`,
        );
      }
    }
  } finally {
    await session.close();
  }

  const output = {
    meta: {
      date: new Date().toISOString(),
      chromeVersion: session.chromeVersion,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      host: `${hostname()} ${platform()}/${arch()} ${cpus()[0]?.model ?? ""}`.trim(),
      samples: opts.samples,
      warmup: opts.warmup,
      filter: opts.filter,
      variantOrder: opts.variants,
      variants: variantMetas,
    },
    results,
  };

  const outPath =
    opts.out ??
    join(
      benchDir,
      "results",
      `${new Date().toISOString().replace(/[:.]/g, "-")}-${opts.variants.join("_")}.json`,
    );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nResults written to ${outPath}`);

  if (opts.variants.length >= 2) {
    console.log("\n" + formatComparison(output));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
