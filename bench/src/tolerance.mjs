// The anchor-relative output-tolerance gate (policy decided 2026-07-10; see
// LOG.md and the skill's correctness-gates section).
//
// Byte-exactness remains the default correctness bar. An experiment may
// instead opt into this gate, which bounds how far its output may drift from
// a PINNED ANCHOR build (bench/anchor.json) - never from the experiment's
// own predecessor. Anchor-relative comparison is what prevents slow drift:
// N tolerance-accepted ships can never accumulate more deviation than the
// one fixed budget, and a candidate that would exceed it fails loudly,
// turning "we've spent the drift budget" into an explicit re-anchor decision
// instead of a silent ratchet.
//
// The diff runs on the smoothed escape-values buffer (Float32; Infinity =
// interior), not on RGBA pixels, so it measures semantics rather than
// palette. Budget dimensions:
//   maxAbsDelta     largest |candidate - anchor| over escaper pixels, in
//                   smoothed iterations (FMA/reassociation-class changes sit
//                   well under 1.0; anything above is not "float noise").
//   maxDiffFraction share of pixels that differ at all.
//   maxBlobPx       largest 4-connected component of differing pixels -
//                   isolated boundary speckle passes, contiguous artifact
//                   regions (the multiplier-interior failure mode) do not.
//   maxFlips        escaper <-> interior flips; the default 0 means any flip
//                   escalates to a human, because a flip's delta is
//                   unbounded by construction.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function readAnchorConfig() {
  const anchorPath = join(benchDir, "anchor.json");
  const config = JSON.parse(readFileSync(anchorPath, "utf8"));
  for (const key of ["variant", "gitSha", "budgets"]) {
    if (!config[key]) throw new Error(`anchor.json is missing "${key}"`);
  }
  return config;
}

// bufA/bufB: Node Buffers holding the raw Float32Array bytes from
// window.getValues. width: tile width in pixels (buffers are width*height
// floats, row-major). Returns per-case stats plus pass/fail against budgets.
export function diffValues(bufA, bufB, width, budgets) {
  if (bufA.length !== bufB.length) {
    return {
      pass: false,
      reasons: [`length mismatch ${bufA.length} vs ${bufB.length}`],
      diffCount: NaN,
      diffFraction: NaN,
      maxAbsDelta: NaN,
      flips: NaN,
      maxBlobPx: NaN,
    };
  }
  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.length / 4);
  const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.length / 4);
  const total = a.length;
  const height = total / width;

  const differs = new Uint8Array(total);
  let diffCount = 0;
  let maxAbsDelta = 0;
  let flips = 0;
  for (let i = 0; i < total; i++) {
    const va = a[i];
    const vb = b[i];
    const aInterior = !Number.isFinite(va);
    const bInterior = !Number.isFinite(vb);
    if (aInterior && bInterior) continue; // both interior: equal
    if (aInterior !== bInterior) {
      differs[i] = 1;
      diffCount++;
      flips++;
      continue;
    }
    if (va !== vb) {
      differs[i] = 1;
      diffCount++;
      const delta = Math.abs(va - vb);
      if (delta > maxAbsDelta) maxAbsDelta = delta;
    }
  }

  // Largest 4-connected component of differing pixels (iterative flood fill).
  let maxBlobPx = 0;
  if (diffCount > 0) {
    const seen = new Uint8Array(total);
    const stack = [];
    for (let start = 0; start < total; start++) {
      if (!differs[start] || seen[start]) continue;
      let size = 0;
      stack.push(start);
      seen[start] = 1;
      while (stack.length > 0) {
        const index = stack.pop();
        size++;
        const x = index % width;
        const y = (index - x) / width;
        for (const [nx, ny] of [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ]) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const neighbor = ny * width + nx;
          if (differs[neighbor] && !seen[neighbor]) {
            seen[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
      if (size > maxBlobPx) maxBlobPx = size;
    }
  }

  const diffFraction = diffCount / total;
  const reasons = [];
  if (flips > budgets.maxFlips) {
    reasons.push(`${flips} escaper<->interior flips (budget ${budgets.maxFlips})`);
  }
  if (maxAbsDelta > budgets.maxAbsDelta) {
    reasons.push(
      `max |Δ| ${maxAbsDelta.toFixed(3)} iterations (budget ${budgets.maxAbsDelta})`,
    );
  }
  if (diffFraction > budgets.maxDiffFraction) {
    reasons.push(
      `${(diffFraction * 100).toFixed(3)}% of pixels differ (budget ${
        budgets.maxDiffFraction * 100
      }%)`,
    );
  }
  if (maxBlobPx > budgets.maxBlobPx) {
    reasons.push(`largest diff blob ${maxBlobPx} px (budget ${budgets.maxBlobPx})`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    diffCount,
    diffFraction,
    maxAbsDelta,
    flips,
    maxBlobPx,
  };
}

export function formatToleranceResult(caseId, stats) {
  if (stats.diffCount === 0) return `${caseId}: identical to anchor`;
  const summary =
    `${stats.diffCount} px differ (${(stats.diffFraction * 100).toFixed(3)}%), ` +
    `max |Δ| ${stats.maxAbsDelta.toFixed(3)}, flips ${stats.flips}, ` +
    `max blob ${stats.maxBlobPx} px`;
  return stats.pass
    ? `${caseId}: within budget - ${summary}`
    : `${caseId}: OVER BUDGET - ${summary} [${stats.reasons.join("; ")}]`;
}
