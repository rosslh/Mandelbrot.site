// Correctness gate for build-flag experiments: renders every corpus case
// once per variant in the same Chrome page and byte-compares the output.
// Exit code 1 on any difference unless --allow-diff (which prints the diff
// summary for a human call instead).
//
//   node src/pixel-check.mjs --a baseline --b <variant> [--filter <s>] [--allow-diff]
//
// Tolerance mode (opt-in per experiment, LOG justification required):
//
//   node src/pixel-check.mjs --b <variant> --tolerance [--filter <s>]
//
// compares the candidate's smoothed escape VALUES against the pinned output
// ANCHOR (bench/anchor.json; --a is ignored) under the committed budgets -
// anchor-relative so tolerance-accepted ships can never compound drift. See
// src/tolerance.mjs for the policy and budget semantics.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { caseToWasmArgs, pathwayFor } from "./normalize.mjs";
import { readVariantMeta, startSession } from "./session.mjs";
import {
  diffValues,
  formatToleranceResult,
  readAnchorConfig,
} from "./tolerance.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const opts = {
    a: null,
    b: null,
    filter: null,
    allowDiff: false,
    tolerance: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--a") opts.a = argv[++i];
    else if (arg === "--b") opts.b = argv[++i];
    else if (arg === "--filter") opts.filter = argv[++i];
    else if (arg === "--allow-diff") opts.allowDiff = true;
    else if (arg === "--tolerance") opts.tolerance = true;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (opts.tolerance ? !opts.b : !opts.a || !opts.b) {
    throw new Error(
      "Usage: node src/pixel-check.mjs --a baseline --b <variant> [--filter <s>] [--allow-diff]\n" +
        "       node src/pixel-check.mjs --b <variant> --tolerance [--filter <s>]",
    );
  }
  return opts;
}

// Anchor-relative tolerance gate: candidate values vs the pinned anchor's
// values on every corpus case, judged against the committed budgets.
async function runToleranceCheck(opts, cases, corpusDefaults) {
  const anchor = readAnchorConfig();
  const anchorMeta = readVariantMeta(anchor.variant);
  if (!anchorMeta.gitSha.startsWith(anchor.gitSha)) {
    throw new Error(
      `Anchor artifact "${anchor.variant}" was built from ${anchorMeta.gitSha}, ` +
        `but anchor.json pins ${anchor.gitSha}; rebuild it: ` +
        `node src/build.mjs ${anchor.variant} --ref ${anchor.gitSha}`,
    );
  }
  readVariantMeta(opts.b);
  console.log(
    `Tolerance gate: ${opts.b} vs anchor @${anchor.gitSha.slice(0, 7)} ` +
      `(budgets: |Δ| ≤ ${anchor.budgets.maxAbsDelta}, ` +
      `diff ≤ ${anchor.budgets.maxDiffFraction * 100}%, ` +
      `blob ≤ ${anchor.budgets.maxBlobPx} px, flips ≤ ${anchor.budgets.maxFlips})\n`,
  );

  const session = await startSession([anchor.variant, opts.b]);
  const failing = [];
  try {
    for (const benchCase of cases) {
      const [payload, args] = caseToWasmArgs(benchCase, corpusDefaults);
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
      const stats = diffValues(
        valuesAnchor,
        valuesCandidate,
        payload.imageWidth,
        anchor.budgets,
      );
      console.log(formatToleranceResult(benchCase.id, stats));
      if (!stats.pass) failing.push(benchCase.id);
    }
  } finally {
    await session.close();
  }

  if (failing.length > 0) {
    console.log(
      `\n${failing.length}/${cases.length} cases exceed the anchor tolerance ` +
        `budget: ${failing.join(", ")}\n` +
        `This is an escalation, not an acceptance path: either the change is ` +
        `wrong, or it needs an explicit re-anchor decision (LOG.md entry + ` +
        `re-pin bench/anchor.json).`,
    );
    process.exit(1);
  }
  console.log(
    `\nAll ${cases.length} cases within the anchor tolerance budget.`,
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const corpus = JSON.parse(
    readFileSync(join(benchDir, "corpus", "corpus.json"), "utf8"),
  );
  let cases = corpus.cases;
  if (opts.filter) {
    cases = cases.filter(
      (benchCase) =>
        benchCase.id.includes(opts.filter) ||
        pathwayFor(benchCase.zoom).includes(opts.filter),
    );
  }

  if (opts.tolerance) {
    await runToleranceCheck(opts, cases, corpus.defaults);
    return;
  }

  readVariantMeta(opts.a);
  readVariantMeta(opts.b);

  const session = await startSession([opts.a, opts.b]);
  let differingCases = 0;
  try {
    for (const benchCase of cases) {
      const [, args] = caseToWasmArgs(benchCase, corpus.defaults);
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
        continue;
      }

      differingCases++;
      let pixelsDiff = 0;
      let maxChannelDiff = 0;
      const length = Math.min(tileA.length, tileB.length);
      for (let i = 0; i < length; i += 4) {
        let pixelDiffers = false;
        for (let channel = 0; channel < 4; channel++) {
          const diff = Math.abs(tileA[i + channel] - tileB[i + channel]);
          if (diff > 0) pixelDiffers = true;
          if (diff > maxChannelDiff) maxChannelDiff = diff;
        }
        if (pixelDiffers) pixelsDiff++;
      }
      const lengthNote =
        tileA.length === tileB.length ? "" : ` (LENGTH MISMATCH ${tileA.length} vs ${tileB.length})`;
      console.log(
        `${benchCase.id}: DIFFERS - ${pixelsDiff}/${length / 4} pixels, max channel diff ${maxChannelDiff}${lengthNote}`,
      );
    }
  } finally {
    await session.close();
  }

  if (differingCases > 0) {
    console.log(`\n${differingCases}/${cases.length} cases differ between ${opts.a} and ${opts.b}`);
    if (!opts.allowDiff) process.exit(1);
  } else {
    console.log(`\nAll ${cases.length} cases byte-identical between ${opts.a} and ${opts.b}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
