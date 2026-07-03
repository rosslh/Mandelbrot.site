// Compares benchmark results between variants: per-case table, per-pathway
// and overall geometric means, wasm size delta, and cold (reference-orbit)
// times. Used by run.mjs after multi-variant runs and as a standalone CLI:
//
//   node src/compare.mjs <results.json> [--baseline <variant>]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { geomean, isSignificant } from "./stats.mjs";

function formatDelta(ratio) {
  const percent = (ratio - 1) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function table(rows) {
  const widths = rows[0].map((_, column) =>
    Math.max(...rows.map((row) => String(row[column]).length)),
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) =>
          String(cell)[column === 0 ? "padEnd" : "padStart"](widths[column]),
        )
        .join("  "),
    )
    .join("\n");
}

export function formatComparison(output, baselineName) {
  const variantOrder = output.meta.variantOrder;
  const baseline = baselineName ?? variantOrder[0];
  const candidates = variantOrder.filter((name) => name !== baseline);
  if (!variantOrder.includes(baseline)) {
    throw new Error(`Baseline variant "${baseline}" not in results`);
  }

  const byCase = new Map();
  for (const row of output.results) {
    if (!byCase.has(row.caseId)) byCase.set(row.caseId, {});
    byCase.get(row.caseId)[row.variant] = row;
  }

  const sections = [];

  for (const candidate of candidates) {
    const rows = [["case", "pathway", `${baseline} ms`, `${candidate} ms`, "delta", "sig"]];
    const ratiosByPathway = new Map();
    const coldRows = [["case", `${baseline} cold ms`, `${candidate} cold ms`, "delta"]];

    for (const [caseId, variants] of byCase) {
      const base = variants[baseline];
      const cand = variants[candidate];
      if (!base || !cand) continue;
      const ratio = cand.median / base.median;
      const significant = isSignificant(base.median, base.mad, cand.median, cand.mad);
      rows.push([
        caseId,
        base.pathway,
        base.median.toFixed(2),
        cand.median.toFixed(2),
        formatDelta(ratio),
        significant ? "*" : "",
      ]);
      if (!ratiosByPathway.has(base.pathway)) ratiosByPathway.set(base.pathway, []);
      ratiosByPathway.get(base.pathway).push(ratio);
      if (base.pathway !== "direct") {
        coldRows.push([
          caseId,
          base.coldMs.toFixed(2),
          cand.coldMs.toFixed(2),
          formatDelta(cand.coldMs / base.coldMs),
        ]);
      }
    }

    const summaryRows = [["pathway", "geomean delta", "cases"]];
    const allRatios = [];
    for (const [pathway, ratios] of ratiosByPathway) {
      summaryRows.push([pathway, formatDelta(geomean(ratios)), ratios.length]);
      allRatios.push(...ratios);
    }
    summaryRows.push(["overall", formatDelta(geomean(allRatios)), allRatios.length]);

    const baseSize = output.meta.variants[baseline]?.wasmSize;
    const candSize = output.meta.variants[candidate]?.wasmSize;
    const sizeLine =
      baseSize && candSize
        ? `wasm size: ${(baseSize / 1024).toFixed(1)} KiB -> ${(candSize / 1024).toFixed(1)} KiB (${formatDelta(candSize / baseSize)})`
        : "wasm size: unknown (missing meta)";

    sections.push(
      [
        `## ${candidate} vs ${baseline}`,
        "",
        table(rows),
        "",
        "Negative delta = candidate is faster. * = significant (clears max(3%, 2*(MAD_a+MAD_b)/median_a)).",
        "",
        table(summaryRows),
        "",
        sizeLine,
        "",
        "Cold samples (first call per case; includes reference-orbit computation):",
        table(coldRows),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let file = null;
  let baseline = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--baseline") baseline = argv[++i];
    else if (!argv[i].startsWith("--") && !file) file = argv[i];
    else throw new Error(`Unexpected argument: ${argv[i]}`);
  }
  if (!file) throw new Error("Usage: node src/compare.mjs <results.json> [--baseline <variant>]");
  const output = JSON.parse(readFileSync(resolve(file), "utf8"));
  console.log(formatComparison(output, baseline ?? undefined));
}
