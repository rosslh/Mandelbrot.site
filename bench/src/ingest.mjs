// Turns a one-time Supabase `events` export (CSV or JSON with re, im, zoom,
// iterations columns) into corpus cases. Rows are validated, deduped,
// bucketed by pathway x iteration tercile, and sampled so the corpus stays
// small and covers the real usage distribution.
//
// Usage:
//   node src/ingest.mjs <export.csv|json> [--max-per-bucket 4] [--write]
//
// Prints the sampled cases; --write replaces all source:"user" cases in
// bench/corpus/corpus.json with the new set (synthetic cases are kept).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidCoordinate, pathwayFor, validateCase } from "./normalize.mjs";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpusPath = join(benchDir, "corpus", "corpus.json");

// Real exports contain pathological iteration values (up to 3e17). Rows
// beyond this are dropped: a single tile would run for minutes and swamp the
// suite without representing meaningful usage.
const MAX_ITERATIONS = 50000;

function parseArgs(argv) {
  const opts = { file: null, maxPerBucket: 4, write: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--max-per-bucket") opts.maxPerBucket = Number(argv[++i]);
    else if (arg === "--write") opts.write = true;
    else if (!arg.startsWith("--") && !opts.file) opts.file = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!opts.file || !Number.isInteger(opts.maxPerBucket)) {
    throw new Error(
      "Usage: node src/ingest.mjs <export.csv|json> [--max-per-bucket N] [--write]",
    );
  }
  return opts;
}

// Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines).
function parseCsv(text) {
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

function loadRows(file) {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".json") ? JSON.parse(text) : parseCsv(text);
}

function fnv1a(text) {
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

function tercileBoundaries(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  return [at(1 / 3), at(2 / 3)];
}

export function ingest(rows, maxPerBucket) {
  const seen = new Set();
  const candidates = [];
  let skipped = 0;

  for (const row of rows) {
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

    const digits = significantDigits(zoom);
    const dedupeKey = `${zoom}|${exponent}|${re.slice(0, digits + 3)}|${im.slice(0, digits + 3)}`;
    if (seen.has(dedupeKey)) {
      skipped++;
      continue;
    }
    seen.add(dedupeKey);
    candidates.push({ re, im, zoom, iterations, exponent });
  }

  if (candidates.length === 0) {
    return { cases: [], skipped, buckets: {} };
  }

  const [lowMax, midMax] = tercileBoundaries(
    candidates.map((candidate) => candidate.iterations),
  );
  const buckets = new Map();
  for (const candidate of candidates) {
    const tier =
      candidate.iterations <= lowMax
        ? "low"
        : candidate.iterations <= midMax
          ? "mid"
          : "high";
    const key = `${pathwayFor(candidate.zoom, candidate.exponent)}/${tier}-iter`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(candidate);
  }

  const cases = [];
  const bucketSummary = {};
  for (const [key, members] of buckets) {
    // Spread picks across the bucket's zoom range rather than taking the
    // first N.
    members.sort((a, b) => a.zoom - b.zoom);
    const picks = [];
    const count = Math.min(maxPerBucket, members.length);
    for (let i = 0; i < count; i++) {
      picks.push(members[Math.floor((i * (members.length - 1)) / Math.max(1, count - 1))]);
    }
    bucketSummary[key] = { total: members.length, sampled: picks.length };
    for (const pick of [...new Set(picks)]) {
      cases.push({
        id: `user-z${pick.zoom}-${fnv1a(`${pick.re}|${pick.im}|${pick.zoom}|${pick.iterations}|${pick.exponent}`)}`,
        source: "user",
        re: pick.re,
        im: pick.im,
        zoom: pick.zoom,
        iterations: pick.iterations,
        ...(pick.exponent !== 2 && { overrides: { exponent: pick.exponent } }),
        note: key,
      });
    }
  }

  cases.sort((a, b) => a.zoom - b.zoom || a.id.localeCompare(b.id));
  return { cases, skipped, buckets: bucketSummary };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const rows = loadRows(resolve(opts.file));
  const { cases, skipped, buckets } = ingest(rows, opts.maxPerBucket);

  for (const benchCase of cases) {
    const problems = validateCase(benchCase);
    if (problems.length > 0) {
      throw new Error(`Invalid case ${benchCase.id}: ${problems.join(", ")}`);
    }
    if (benchCase.iterations > 20000) {
      console.warn(
        `Warning: ${benchCase.id} has ${benchCase.iterations} iterations; expect slow samples`,
      );
    }
  }

  console.log(
    `Parsed ${rows.length} rows -> ${cases.length} cases (${skipped} skipped as invalid/duplicate)`,
  );
  console.log("Buckets:", JSON.stringify(buckets, null, 2));

  if (opts.write) {
    const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
    const synthetic = corpus.cases.filter(
      (benchCase) => benchCase.source !== "user",
    );
    corpus.cases = [...synthetic, ...cases];
    writeFileSync(corpusPath, JSON.stringify(corpus, null, 2) + "\n");
    console.log(
      `Wrote ${cases.length} user cases to ${corpusPath} (${synthetic.length} synthetic kept)`,
    );
  } else {
    console.log(JSON.stringify(cases, null, 2));
  }
}
