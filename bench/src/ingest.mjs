// Turns a Supabase `events` export (CSV or JSON with re, im, zoom,
// iterations, share_url, created_at, session_id columns) into corpus cases.
// Rows are validated and deduped, every surviving candidate is probed at
// PROBE_SIZE^2 through the wasm (see enrich.mjs), and selection buckets by
// pathway tier x composition/cost: within each tier it prefers the heaviest
// views (largest iteration sum) and border-heavy views (high near-max
// escaper fraction), keeps at least one case per distinctive composition,
// and folds in a user-frequency pick. This replaced the old pathway x
// iteration-tercile bucketing (the raw `iterations` parameter is a poor work
// proxy: a 50k-iteration view of empty exterior is cheap, a 1k-iteration
// trapped channel is not).
//
// Usage:
//   node src/ingest.mjs <export.csv|json> [--artifact <name>]
//     [--budget-ms 15000] [--write]
//
// Prints the old vs new user-case selection side by side (with probe stats)
// for review; --write replaces the source:"user" cases in
// bench/corpus/corpus.json with the new set, backfills `stats` blocks on
// every row (synthetic included), and preserves hand-maintained notes,
// overrides, and pinned rows. Never copies session_ids or share URLs into
// corpus rows. Re-running on the same export + artifact is idempotent.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProber, mergeStats, statsBlock } from "./enrich.mjs";
import { isValidCoordinate, pathwayFor, validateCase, PATHWAYS } from "./normalize.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(benchDir, "corpus", "corpus.json");

// Real exports contain pathological iteration values (up to 3e17). Rows
// beyond this are dropped: a single tile would run for minutes and swamp the
// suite without representing meaningful usage.
export const MAX_ITERATIONS = 50000;

// User-frequency recency weighting: a session's visit to a view is worth
// 2^(-age/half-life), aged against the newest event in the export (not the
// wall clock, so weights are stable across re-runs of the same export).
export const RECENCY_HALF_LIFE_DAYS = 365;

// Hand-expanded on 2026-07-08 (see LOG.md): treated as already-selected.
// After the first --write these rows carry `"pinned": true` in the corpus
// and this bootstrap list is redundant; pin future hand additions by setting
// that field directly.
const PINNED_IDS = new Set([
  "user-z47-fb5f0315",
  "user-z48-0a309fb2",
  "user-z48-f36112fd",
  "user-z47-da3d5543",
  "user-z48-58cd3904",
  "user-z48-6481040a",
  "user-z48-0611aae8",
]);

// User cases per pathway tier (pinned rows count against the tier budget;
// composition-coverage picks may exceed it by design).
const TIER_BUDGETS = {
  direct: 8,
  "perturbation-f64": 12,
  "float-exp": 4,
};

const COVERAGE_CLASSES = [
  "in-set",
  "interior",
  "trapped",
  "border",
  "multibrot",
  "low-iter",
];

// Keep a two-variant full-corpus run in the minutes range: pick the largest
// conventional tileSize whose estimated per-sample time (scaled from the
// probe by pixel count; per-pixel cost is size-invariant) fits the per-case
// budget with a handful of samples.
const SAMPLE_TARGET_MS = 3500;

function parseArgs(argv) {
  const opts = { file: null, artifact: null, budgetMs: undefined, write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact") opts.artifact = argv[++i];
    else if (arg === "--budget-ms") opts.budgetMs = Number(argv[++i]);
    else if (arg === "--write") opts.write = true;
    else if (!arg.startsWith("--") && !opts.file) opts.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.file) {
    throw new Error(
      "Usage: node src/ingest.mjs <export.csv|json> [--artifact <name>] [--budget-ms N] [--write]",
    );
  }
  return opts;
}

// Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
    }
  }
  row.push(field);
  if (row.some((value) => value !== "")) rows.push(row);

  const [header, ...body] = rows;
  return body.map((values) =>
    Object.fromEntries(header.map((key, i) => [key, values[i] ?? ""])),
  );
}

export function loadRows(file) {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(text) : parseCsv(text);
}

export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Matches decimalDigitsForZoom in client/js/highPrecision.ts: digits needed
// to distinguish points at this zoom (used for dedupe granularity).
function significantDigits(zoom) {
  return Math.max(6, Math.ceil((Math.max(zoom, 0) + 32) * 0.30103));
}

// View identity for dedupe, corpus-exclusion, and incumbent matching:
// coordinates truncated to zoom-relevant precision, plus zoom and exponent
// (iterations vary across events for the same view and are aggregated).
export function candidateKeyFor({ re, im, zoom, exponent = 2 }) {
  const digits = significantDigits(zoom);
  return `${zoom}|${exponent}|${String(re).slice(0, digits + 3)}|${String(im).slice(0, digits + 3)}`;
}

// Supabase timestamps look like "2024-08-25 21:36:54.115795+00"; normalize
// for Date.parse.
function parseCreatedAt(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const normalized = text
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/\+00$/, "Z");
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

// Validates and dedupes export rows into candidate views, aggregating a
// user-frequency weight per view: distinct sessions, plus a recency-decayed
// session sum. Session ids never leave this function.
export function extractCandidates(rows) {
  const byKey = new Map();
  let skipped = 0;
  let referenceMs = 0;

  const parsed = [];
  for (const [index, row] of rows.entries()) {
    const re = String(row.re ?? "").trim();
    const im = String(row.im ?? "").trim();
    const zoom = Math.round(Number(row.zoom));
    const iterations = Math.round(Number(row.iterations));
    // The exponent is only recorded inside the share URL (e= param).
    let exponent = 2;
    try {
      const fromUrl = new URL(String(row.share_url)).searchParams.get("e");
      if (fromUrl !== null) exponent = Math.round(Number(fromUrl));
    } catch {
      // Missing or malformed share_url: assume the default exponent.
    }

    if (
      !isValidCoordinate(re) ||
      !isValidCoordinate(im) ||
      !Number.isInteger(zoom) ||
      zoom < 0 ||
      !Number.isInteger(iterations) ||
      iterations < 1 ||
      iterations > MAX_ITERATIONS ||
      !Number.isInteger(exponent) ||
      exponent < 2 ||
      exponent > 64
    ) {
      skipped++;
      continue;
    }

    const createdMs = parseCreatedAt(row.created_at);
    if (createdMs !== null && createdMs > referenceMs) referenceMs = createdMs;
    parsed.push({
      re,
      im,
      zoom,
      iterations,
      exponent,
      key: candidateKeyFor({ re, im, zoom, exponent }),
      session: String(row.session_id ?? "").trim() || `row-${index}`,
      createdMs,
    });
  }

  for (const event of parsed) {
    let candidate = byKey.get(event.key);
    if (!candidate) {
      candidate = {
        re: event.re,
        im: event.im,
        zoom: event.zoom,
        iterations: event.iterations,
        exponent: event.exponent,
        key: event.key,
        sessionLastSeen: new Map(),
      };
      byKey.set(event.key, candidate);
    }
    // The heaviest iteration count any user actually rendered at this view.
    candidate.iterations = Math.max(candidate.iterations, event.iterations);
    const previous = candidate.sessionLastSeen.get(event.session) ?? -Infinity;
    if ((event.createdMs ?? 0) > previous) {
      candidate.sessionLastSeen.set(event.session, event.createdMs ?? 0);
    }
  }

  const halfLifeMs = RECENCY_HALF_LIFE_DAYS * 86400e3;
  const candidates = [...byKey.values()];
  for (const candidate of candidates) {
    let recency = 0;
    for (const lastSeenMs of candidate.sessionLastSeen.values()) {
      recency += 2 ** (-(referenceMs - lastSeenMs) / halfLifeMs);
    }
    candidate.sessions = candidate.sessionLastSeen.size;
    candidate.recency = Number(recency.toFixed(3));
    candidate.pathway = pathwayFor(candidate.zoom, candidate.exponent);
    delete candidate.sessionLastSeen;
  }

  return {
    candidates,
    skipped,
    referenceDate: referenceMs
      ? new Date(referenceMs).toISOString().slice(0, 10)
      : null,
  };
}

// Composition class from probe stats; each view gets exactly one, checked in
// precedence order. Thresholds are heuristic labels for coverage bookkeeping,
// not measurement.
export function classify(candidate, stats) {
  if (candidate.exponent !== 2) return "multibrot";
  if (stats.interior >= 0.97) return "in-set";
  if (stats.interior < 1 && stats.escMean >= 0.9 * candidate.iterations) {
    return "trapped";
  }
  if (stats.nearMax50 >= 0.1) return "border";
  if (stats.interior >= 0.5) return "interior";
  if (candidate.iterations < 1000) return "low-iter";
  return "mixed";
}

function toBenchCase(candidate) {
  return {
    re: candidate.re,
    im: candidate.im,
    zoom: candidate.zoom,
    iterations: candidate.iterations,
    ...(candidate.exponent !== 2 && {
      overrides: { exponent: candidate.exponent },
    }),
  };
}

function tileSizeFor(probeMs, probeSize, defaultTileSize) {
  for (const size of [defaultTileSize, 100, 64]) {
    if (probeMs * (size / probeSize) ** 2 <= SAMPLE_TARGET_MS) {
      return size === defaultTileSize ? undefined : size;
    }
  }
  return 64;
}

// Composition/cost-aware selection within one pathway tier. `pinned` rows
// are already selected; remaining slots go to the heaviest views (iteration
// sum), border-heavy views (near-max escaper fraction), and the
// most-frequented view, then coverage picks fill any composition class the
// tier would otherwise lose.
export function selectTier(tier, tierCandidates, pinnedInfos, budget) {
  const selected = [];
  const selectedKeys = new Set(pinnedInfos.map((info) => info.key));
  const coveredClasses = new Set(
    pinnedInfos.map((info) => info.class).filter(Boolean),
  );

  const usable = tierCandidates.filter((candidate) => candidate.stats);
  const take = (ordered, count, reason) => {
    let taken = 0;
    for (const candidate of ordered) {
      if (taken >= count) break;
      if (selectedKeys.has(candidate.key)) continue;
      selectedKeys.add(candidate.key);
      coveredClasses.add(candidate.class);
      selected.push({ candidate, reason });
      taken++;
    }
  };

  const byIterSum = [...usable].sort(
    (a, b) =>
      b.stats.iterSum - a.stats.iterSum ||
      b.recency - a.recency ||
      a.key.localeCompare(b.key),
  );
  // In-set views carry the largest NOMINAL iteration sum (every pixel at
  // max_iterations) but render through rect_in_set/border shortcuts, so
  // they'd hijack the heavy slots while costing nothing. They get their own
  // coverage slot instead.
  const byIterSumWorking = byIterSum.filter(
    (candidate) => candidate.class !== "in-set",
  );
  const byBorder = usable
    .filter((candidate) => candidate.stats.nearMax50 >= 0.02)
    .sort(
      (a, b) =>
        b.stats.nearMax50 - a.stats.nearMax50 ||
        b.stats.iterSum - a.stats.iterSum ||
        a.key.localeCompare(b.key),
    );
  const byFrequency = [...usable].sort(
    (a, b) =>
      b.recency - a.recency ||
      b.stats.iterSum - a.stats.iterSum ||
      a.key.localeCompare(b.key),
  );

  const slots = Math.max(0, budget - pinnedInfos.length);
  const heavyCount = Math.ceil(slots * 0.5);
  const borderCount = Math.ceil(slots * 0.3);
  const frequencyCount = Math.max(0, slots - heavyCount - borderCount);

  take(byIterSumWorking, heavyCount, "heaviest");
  take(byBorder, borderCount, "border-heavy");
  take(byFrequency, frequencyCount, "most-frequented");

  for (const compositionClass of COVERAGE_CLASSES) {
    if (coveredClasses.has(compositionClass)) continue;
    const best = byIterSum.find(
      (candidate) =>
        candidate.class === compositionClass && !selectedKeys.has(candidate.key),
    );
    if (best) take([best], 1, `coverage:${compositionClass}`);
  }

  // Perturbation tiers: reference-orbit length and dashu precision scale
  // with zoom, an axis the composition classes don't capture - keep the
  // tier's deepest real view (cold-time coverage; usually a light case).
  if (tier !== "direct" && usable.length > 0) {
    const deepest = [...usable].sort(
      (a, b) =>
        b.zoom - a.zoom ||
        b.stats.iterSum - a.stats.iterSum ||
        a.key.localeCompare(b.key),
    )[0];
    if (!selectedKeys.has(deepest.key)) take([deepest], 1, "coverage:zoom-max");
  }

  return selected;
}

function formatRow(columns) {
  return columns
    .map((cell, i) => String(cell)[i <= 2 ? "padEnd" : "padStart"]([28, 8, 10, 6, 4, 5, 5, 6, 6, 8, 9, 5, 8, 9][i] ?? 8))
    .join(" ");
}

function describeCase(status, id, candidate, stats, tileSize, probeMs, weight) {
  return formatRow([
    id,
    status,
    candidate.class ?? "?",
    candidate.iterations,
    candidate.exponent ?? 2,
    tileSize ?? "",
    stats ? `${(stats.interior * 100).toFixed(0)}%` : "?",
    stats ? `${(stats.nearMax50 * 100).toFixed(0)}%` : "?",
    stats ? `${(stats.nearMax90 * 100).toFixed(0)}%` : "?",
    stats ? Math.round(stats.escMean) : "?",
    stats ? `${(stats.iterSum / 1e6).toFixed(1)}M` : "?",
    weight?.sessions ?? "",
    weight?.recency?.toFixed(2) ?? "",
    probeMs !== undefined ? `${probeMs.toFixed(0)}ms@64` : "",
  ]);
}

const REPORT_HEADER = formatRow([
  "case",
  "status",
  "class",
  "iter",
  "e",
  "tile",
  "int",
  "nm50",
  "nm90",
  "escMean",
  "iterSum",
  "sess",
  "recency",
  "probe",
]);

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = loadRows(resolve(opts.file));
  const { candidates, skipped, referenceDate } = extractCandidates(rows);
  console.log(
    `Parsed ${rows.length} rows -> ${candidates.length} candidate views ` +
      `(${skipped} rows skipped as invalid; recency reference ${referenceDate})`,
  );

  const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
  const incumbents = corpus.cases.filter((c) => c.source === "user");
  const synthetic = corpus.cases.filter((c) => c.source !== "user");
  const incumbentByKey = new Map(
    incumbents.map((row) => [
      candidateKeyFor({ ...row, exponent: row.overrides?.exponent ?? 2 }),
      row,
    ]),
  );

  // Probe everything: candidates (cheapest first so progress is visible),
  // plus corpus rows so synthetic stats are backfilled and dropped
  // incumbents appear in the report with numbers.
  const prober = await createProber({
    artifact: opts.artifact,
    budgetMs: opts.budgetMs,
  });
  console.log(
    `Probing with artifact ${prober.artifactName} (${prober.artifactSha.slice(0, 8)})...`,
  );

  const probeResults = new Map(); // candidate.key -> probe result
  let probed = 0;
  let overBudget = 0;
  const started = Date.now();
  try {
    const ordered = [...candidates].sort(
      (a, b) => a.iterations - b.iterations || a.key.localeCompare(b.key),
    );
    for (const candidate of ordered) {
      let result;
      try {
        result = await prober.probe(toBenchCase(candidate), corpus.defaults);
      } catch (error) {
        result = { skipped: true, reason: String(error) };
      }
      probeResults.set(candidate.key, result);
      if (result.skipped) {
        overBudget++;
        console.log(`  probe skipped ${candidate.key}: ${result.reason}`);
      } else {
        candidate.stats = result;
        candidate.class = classify(candidate, result);
      }
      if (++probed % 1000 === 0) {
        const elapsed = (Date.now() - started) / 1000;
        console.log(
          `  probed ${probed}/${candidates.length} (${elapsed.toFixed(0)} s elapsed)`,
        );
      }
    }

    for (const row of [...synthetic, ...incumbents]) {
      const result = await prober.probe(row, corpus.defaults);
      if (!result.skipped) {
        row.probeResult = result;
      }
    }
  } finally {
    await prober.close();
  }
  console.log(
    `Probed ${probed} candidates in ${((Date.now() - started) / 1000).toFixed(0)} s` +
      (overBudget > 0 ? ` (${overBudget} skipped over budget)` : ""),
  );

  // Selection per pathway tier. Pinned incumbents are pre-selected; other
  // incumbents compete like any candidate (kept if re-selected, reported as
  // dropped otherwise).
  const candidateByKey = new Map(candidates.map((c) => [c.key, c]));
  const selectionByTier = new Map();
  for (const pathway of PATHWAYS) {
    const pinnedRows = incumbents.filter((row) => {
      const exponent = row.overrides?.exponent ?? 2;
      return (
        (row.pinned === true || PINNED_IDS.has(row.id)) &&
        pathwayFor(row.zoom, exponent) === pathway
      );
    });
    const pinnedInfos = pinnedRows.map((row) => {
      const key = candidateKeyFor({
        ...row,
        exponent: row.overrides?.exponent ?? 2,
      });
      const stats = row.probeResult;
      return {
        row,
        key,
        class: stats
          ? classify(
              {
                exponent: row.overrides?.exponent ?? 2,
                iterations: row.iterations,
              },
              stats,
            )
          : null,
      };
    });
    const tierCandidates = candidates.filter(
      (candidate) => candidate.pathway === pathway,
    );
    selectionByTier.set(pathway, {
      pinnedInfos,
      picks: selectTier(pathway, tierCandidates, pinnedInfos, TIER_BUDGETS[pathway] ?? 6),
    });
  }

  // Build the new user-case rows and the review report.
  const newUserRows = [];
  console.log("\n=== Selection (old vs new) ===");
  for (const pathway of PATHWAYS) {
    const { pinnedInfos, picks } = selectionByTier.get(pathway);
    console.log(`\n--- ${pathway} ---`);
    console.log(REPORT_HEADER);

    const selectedKeys = new Set();
    for (const info of pinnedInfos) {
      selectedKeys.add(info.key);
      const row = info.row;
      const candidate = candidateByKey.get(info.key);
      const stats = row.probeResult;
      console.log(
        describeCase(
          "PINNED",
          row.id,
          {
            class: info.class,
            iterations: row.iterations,
            exponent: row.overrides?.exponent ?? 2,
          },
          stats,
          row.overrides?.tileSize,
          stats?.ms,
          candidate
            ? { sessions: candidate.sessions, recency: candidate.recency }
            : undefined,
        ),
      );
      newUserRows.push({
        row: {
          ...stripWorkingFields(row),
          pinned: true,
          ...(candidate && {
            weight: { sessions: candidate.sessions, recency: candidate.recency },
          }),
          ...(stats && {
            stats: mergeStats(row.stats, statsBlock(stats, prober.artifactSha)),
          }),
        },
      });
    }

    for (const { candidate, reason } of picks) {
      selectedKeys.add(candidate.key);
      const incumbent = incumbentByKey.get(candidate.key);
      const status = incumbent ? "KEPT" : "NEW";
      const stats = candidate.stats;
      const defaultTile = corpus.defaults.tileSize;
      const tileSize = incumbent
        ? incumbent.overrides?.tileSize
        : tileSizeFor(stats.ms, stats.pixels ** 0.5, defaultTile);
      const newId = `user-z${candidate.zoom}-${fnv1a(`${candidate.re}|${candidate.im}|${candidate.zoom}|${candidate.iterations}|${candidate.exponent}`)}`;
      console.log(
        describeCase(status, incumbent?.id ?? newId, candidate, stats, tileSize, stats.ms, candidate) +
          `  <- ${reason}`,
      );

      const overrides = {
        ...(incumbent?.overrides ?? {}),
        ...(candidate.exponent !== 2 && { exponent: candidate.exponent }),
        ...(!incumbent && tileSize && { tileSize }),
      };
      const row = incumbent
        ? {
            ...stripWorkingFields(incumbent),
            weight: { sessions: candidate.sessions, recency: candidate.recency },
            stats: mergeStats(incumbent.stats, statsBlock(stats, prober.artifactSha)),
          }
        : {
            id: newId,
            source: "user",
            re: candidate.re,
            im: candidate.im,
            zoom: candidate.zoom,
            iterations: candidate.iterations,
            ...(Object.keys(overrides).length > 0 && { overrides }),
            note: `${pathway}/${candidate.class}; auto-selected (${reason})`,
            weight: { sessions: candidate.sessions, recency: candidate.recency },
            stats: statsBlock(stats, prober.artifactSha),
          };
      newUserRows.push({ row });
    }

    for (const incumbent of incumbents) {
      const exponent = incumbent.overrides?.exponent ?? 2;
      if (pathwayFor(incumbent.zoom, exponent) !== pathway) continue;
      const key = candidateKeyFor({ ...incumbent, exponent });
      if (selectedKeys.has(key)) continue;
      const stats = incumbent.probeResult;
      const candidate = candidateByKey.get(key);
      console.log(
        describeCase(
          "DROPPED",
          incumbent.id,
          {
            class: stats
              ? classify({ exponent, iterations: incumbent.iterations }, stats)
              : null,
            iterations: incumbent.iterations,
            exponent,
          },
          stats,
          incumbent.overrides?.tileSize,
          stats?.ms,
          candidate
            ? { sessions: candidate.sessions, recency: candidate.recency }
            : undefined,
        ),
      );
    }
  }

  // Backfill synthetic stats.
  for (const row of synthetic) {
    if (row.probeResult) {
      row.stats = mergeStats(row.stats, statsBlock(row.probeResult, prober.artifactSha));
    }
  }

  const userRows = newUserRows
    .map(({ row }) => row)
    .sort((a, b) => a.zoom - b.zoom || a.id.localeCompare(b.id));
  for (const row of userRows) {
    const problems = validateCase(row);
    if (problems.length > 0) {
      throw new Error(`Invalid case ${row.id}: ${problems.join(", ")}`);
    }
  }

  console.log(
    `\nUser cases: ${incumbents.length} old -> ${userRows.length} new ` +
      `(corpus total ${synthetic.length + userRows.length})`,
  );
  console.log(
    "Note: the e2e corpus (corpus/grid-regression.json) is NOT touched by this tool; " +
      "if the selection surfaces a heavyweight tier with no e2e coverage, flag it in " +
      "LOG.md and decide deliberately (e2e cases roughly cost their page-load time per round).",
  );

  if (opts.write) {
    corpus.cases = [...synthetic.map(stripWorkingFields), ...userRows];
    writeFileSync(corpusPath, JSON.stringify(corpus, null, 2) + "\n");
    console.log(`Wrote ${corpusPath}`);
  } else {
    console.log("Dry run; pass --write to apply the selection above.");
  }
}

// Working fields used during selection must never reach the corpus file.
function stripWorkingFields(row) {
  const { probeResult, ...rest } = row;
  return rest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
