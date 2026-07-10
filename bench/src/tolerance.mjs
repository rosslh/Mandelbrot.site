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
//
// STATISTICAL-EQUIVALENCE TIER (user decision 2026-07-10, second policy
// entry; see LOG.md). Rounding-class changes (hardware FMA) re-roll chaotic
// boundary pixels rather than shifting them: on long-orbit views tens of
// percent of pixels differ, individual deltas are unbounded, and thousands
// of escaper<->interior flips appear - all while the picture stays
// statistically the same (band structure and value distributions
// preserved, flips direction-balanced). The strict budgets above cannot
// express that, so an experiment whose output change is claimed AND
// LOG-justified as rounding-class may opt into `--statistical` instead,
// which is still anchor-relative and judges these axes (budgets committed
// in anchor.json `statisticalBudgets`, calibrated 2026-07-10 against real
// FMA diffs to accept and speck/fill/shift/scale/band-shift classes to
// reject):
//   flip imbalance   |flipsToInterior - flipsToEscaper| <= max(floor,
//                    sigma*sqrt(flips)). Re-rolls are symmetric coin flips;
//                    structural fills are one-directional.
//   sign imbalance   same test on the sign of value deltas over common
//                    escapers. Catches uniform shifts / scales / band
//                    shifts that hide from distribution tests on
//                    high-iteration tiles.
//   flip blob        largest 4-connected flip component; fills are
//                    contiguous, re-roll flips are scattered.
//   calm violations  a flip or |delta| > 1.0 at a pixel whose anchor 3x3
//                    neighborhood has >= 6 finite values spanning < 1.0
//                    iteration: smooth gradients cannot excuse large
//                    change. (Interior-embedded pixels are exempt - orbits
//                    there are legitimately chaotic.)
//   quantile drift / tile KS / block KS   escaper-value distribution
//                    stability, tile-wide and per 16x16 block (band
//                    structure), skipped below minimum escaper counts.
//                    Quantiles are central-only (p25/p50/p75): tail
//                    quantiles are rank-fragile under re-roll membership
//                    churn (see QUANTILES).
//   interior delta   global and per-block interior-fraction change.
// A failing statistical run is an escalation exactly like the strict gate.

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

// --- statistical-equivalence tier ------------------------------------------

const BLOCK_SIZE = 16;
const MIN_TILE_ESCAPERS = 100; // below this, distribution axes are skipped
const MIN_BLOCK_ESCAPERS = 64;
const SUSPICIOUS_DELTA = 1.0; // |delta| above this needs a chaotic excuse
const CALM_RANGE = 1.0; // 3x3 anchor range below this = smooth gradient
const CALM_MIN_FINITE = 6; // fewer finite neighbors = interior-embedded, exempt
// Central quantiles only: the escaper distribution's tail is sparse and
// steep (long-orbit boundary pixels), so tail quantiles are rank-fragile
// under legitimate re-roll membership churn - a net handful of
// escaper<->interior flips moved a holdout z7 view's p95 by 5% while KS
// stayed at 0.0045. Tail integrity is covered by KS, sign balance, and the
// flip axes; the central quantiles catch symmetric spread changes those
// miss.
const QUANTILES = [0.25, 0.5, 0.75];

function quantile(sorted, q) {
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

// max CDF distance between two sorted arrays (two-sample KS statistic).
// Ties must be consumed on both sides before measuring - nosmooth tiles have
// integer values with huge tie groups, and advancing one side at a time
// reads a tie group as spurious CDF distance (identical arrays would score
// tieGroup/n instead of 0).
function ksStat(a, b) {
  let i = 0;
  let j = 0;
  let max = 0;
  while (i < a.length && j < b.length) {
    const value = Math.min(a[i], b[j]);
    while (i < a.length && a[i] === value) i++;
    while (j < b.length && b[j] === value) j++;
    const d = Math.abs(i / a.length - j / b.length);
    if (d > max) max = d;
  }
  return max;
}

// Statistical-equivalence gate for rounding-class changes (see header).
// Same calling convention as diffValues; budgets = anchor.json
// statisticalBudgets. Anchor is bufA - the calm/roughness classification
// reads the anchor's neighborhoods.
export function diffValuesStatistical(bufA, bufB, width, budgets) {
  if (bufA.length !== bufB.length) {
    return {
      pass: false,
      reasons: [`length mismatch ${bufA.length} vs ${bufB.length}`],
      diffCount: NaN,
    };
  }
  const a = new Float32Array(bufA.buffer, bufA.byteOffset, bufA.length / 4);
  const b = new Float32Array(bufB.buffer, bufB.byteOffset, bufB.length / 4);
  const total = a.length;
  const height = total / width;

  const anchorIsCalm = (x, y) => {
    let min = Infinity;
    let max = -Infinity;
    let finite = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const v = a[ny * width + nx];
        if (!Number.isFinite(v)) continue;
        finite++;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    return finite >= CALM_MIN_FINITE && max - min < CALM_RANGE;
  };

  let diffCount = 0;
  let maxAbsDelta = 0;
  let flipsToInterior = 0;
  let flipsToEscaper = 0;
  let interiorA = 0;
  let interiorB = 0;
  let signPos = 0;
  let signNeg = 0;
  let calmViolations = 0;
  const flipMask = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    const va = a[i];
    const vb = b[i];
    const aInterior = !Number.isFinite(va);
    const bInterior = !Number.isFinite(vb);
    if (aInterior) interiorA++;
    if (bInterior) interiorB++;
    if (aInterior && bInterior) continue;
    if (aInterior !== bInterior) {
      diffCount++;
      flipMask[i] = 1;
      if (bInterior) flipsToInterior++;
      else flipsToEscaper++;
      if (anchorIsCalm(i % width, Math.floor(i / width))) calmViolations++;
      continue;
    }
    if (va !== vb) {
      diffCount++;
      const delta = Math.abs(va - vb);
      if (delta > maxAbsDelta) maxAbsDelta = delta;
      if (vb > va) signPos++;
      else signNeg++;
      if (
        delta > SUSPICIOUS_DELTA &&
        anchorIsCalm(i % width, Math.floor(i / width))
      ) {
        calmViolations++;
      }
    }
  }
  const flips = flipsToInterior + flipsToEscaper;

  // largest 4-connected component of FLIP pixels (value-only diffs are
  // ubiquitous under rounding drift, so blobs are only meaningful on flips)
  let maxFlipBlob = 0;
  if (flips > 0) {
    const seen = new Uint8Array(total);
    const stack = [];
    for (let start = 0; start < total; start++) {
      if (!flipMask[start] || seen[start]) continue;
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
          if (flipMask[neighbor] && !seen[neighbor]) {
            seen[neighbor] = 1;
            stack.push(neighbor);
          }
        }
      }
      if (size > maxFlipBlob) maxFlipBlob = size;
    }
  }

  // escaper-value distribution stability: tile-wide quantiles + KS
  const finiteA = [];
  const finiteB = [];
  for (let i = 0; i < total; i++) {
    if (Number.isFinite(a[i])) finiteA.push(a[i]);
    if (Number.isFinite(b[i])) finiteB.push(b[i]);
  }
  finiteA.sort((x, y) => x - y);
  finiteB.sort((x, y) => x - y);
  let maxQuantileDrift = 0;
  let tileKs = 0;
  if (finiteA.length >= MIN_TILE_ESCAPERS && finiteB.length >= MIN_TILE_ESCAPERS) {
    for (const q of QUANTILES) {
      const qa = quantile(finiteA, q);
      const qb = quantile(finiteB, q);
      const drift = Math.abs(qb - qa) / Math.max(Math.abs(qa), 1);
      if (drift > maxQuantileDrift) maxQuantileDrift = drift;
    }
    tileKs = ksStat(finiteA, finiteB);
  }

  // per-block band structure: interior-fraction delta + block KS
  let maxBlockInteriorDelta = 0;
  let maxBlockKs = 0;
  for (let by = 0; by < height; by += BLOCK_SIZE) {
    for (let bx = 0; bx < width; bx += BLOCK_SIZE) {
      const blockA = [];
      const blockB = [];
      let blockInteriorA = 0;
      let blockInteriorB = 0;
      let count = 0;
      for (let y = by; y < Math.min(by + BLOCK_SIZE, height); y++) {
        for (let x = bx; x < Math.min(bx + BLOCK_SIZE, width); x++) {
          const i = y * width + x;
          count++;
          if (Number.isFinite(a[i])) blockA.push(a[i]);
          else blockInteriorA++;
          if (Number.isFinite(b[i])) blockB.push(b[i]);
          else blockInteriorB++;
        }
      }
      const interiorDelta = Math.abs(blockInteriorB - blockInteriorA) / count;
      if (interiorDelta > maxBlockInteriorDelta) {
        maxBlockInteriorDelta = interiorDelta;
      }
      if (
        blockA.length >= MIN_BLOCK_ESCAPERS &&
        blockB.length >= MIN_BLOCK_ESCAPERS
      ) {
        blockA.sort((x, y) => x - y);
        blockB.sort((x, y) => x - y);
        const ks = ksStat(blockA, blockB);
        if (ks > maxBlockKs) maxBlockKs = ks;
      }
    }
  }

  const flipImbalance = Math.abs(flipsToInterior - flipsToEscaper);
  const flipAllowance = Math.max(
    budgets.flipImbalanceFloor,
    budgets.flipImbalanceSigma * Math.sqrt(flips),
  );
  const signCount = signPos + signNeg;
  const signImbalance = Math.abs(signPos - signNeg);
  const signAllowance = Math.max(
    budgets.signImbalanceFloor,
    budgets.signImbalanceSigma * Math.sqrt(signCount),
  );
  const calmAllowance = Math.max(
    budgets.calmViolationFloor,
    budgets.calmViolationFraction * total,
  );
  const interiorDelta = Math.abs(interiorB - interiorA) / total;

  const reasons = [];
  if (flipImbalance > flipAllowance) {
    reasons.push(
      `flip imbalance ${flipsToInterior}->interior/${flipsToEscaper}->escaper ` +
        `(|Δ| ${flipImbalance} > ${flipAllowance.toFixed(0)}): one-directional, not a re-roll`,
    );
  }
  if (signImbalance > signAllowance) {
    reasons.push(
      `delta sign imbalance +${signPos}/-${signNeg} ` +
        `(|Δ| ${signImbalance} > ${signAllowance.toFixed(0)}): systematic shift, not rounding noise`,
    );
  }
  if (maxFlipBlob > budgets.maxFlipBlobPx) {
    reasons.push(
      `largest flip blob ${maxFlipBlob} px (budget ${budgets.maxFlipBlobPx}): contiguous fill`,
    );
  }
  if (calmViolations > calmAllowance) {
    reasons.push(
      `${calmViolations} large changes in smooth regions (budget ${calmAllowance.toFixed(0)})`,
    );
  }
  if (maxQuantileDrift > budgets.maxQuantileDrift) {
    reasons.push(
      `quantile drift ${(maxQuantileDrift * 100).toFixed(2)}% ` +
        `(budget ${budgets.maxQuantileDrift * 100}%)`,
    );
  }
  if (tileKs > budgets.maxTileKs) {
    reasons.push(`tile KS ${tileKs.toFixed(4)} (budget ${budgets.maxTileKs})`);
  }
  if (maxBlockKs > budgets.maxBlockKs) {
    reasons.push(`block KS ${maxBlockKs.toFixed(3)} (budget ${budgets.maxBlockKs})`);
  }
  if (interiorDelta > budgets.maxInteriorDelta) {
    reasons.push(
      `interior fraction Δ ${(interiorDelta * 100).toFixed(3)}% ` +
        `(budget ${budgets.maxInteriorDelta * 100}%)`,
    );
  }
  if (maxBlockInteriorDelta > budgets.maxBlockInteriorDelta) {
    reasons.push(
      `block interior Δ ${(maxBlockInteriorDelta * 100).toFixed(1)}% ` +
        `(budget ${budgets.maxBlockInteriorDelta * 100}%)`,
    );
  }

  return {
    pass: reasons.length === 0,
    reasons,
    diffCount,
    diffFraction: diffCount / total,
    maxAbsDelta,
    flips,
    flipsToInterior,
    flipsToEscaper,
    flipImbalance,
    signPos,
    signNeg,
    maxFlipBlob,
    calmViolations,
    maxQuantileDrift,
    tileKs,
    maxBlockKs,
    interiorDelta,
    maxBlockInteriorDelta,
  };
}

export function formatStatisticalResult(caseId, stats) {
  if (stats.diffCount === 0) return `${caseId}: identical to anchor`;
  const summary =
    `${stats.diffCount} px differ (${(stats.diffFraction * 100).toFixed(2)}%), ` +
    `flips ${stats.flipsToInterior}/${stats.flipsToEscaper}, ` +
    `flip blob ${stats.maxFlipBlob}, signs +${stats.signPos}/-${stats.signNeg}, ` +
    `calm ${stats.calmViolations}, qDrift ${(stats.maxQuantileDrift * 100).toFixed(2)}%, ` +
    `KS ${stats.tileKs.toFixed(4)}/blk ${stats.maxBlockKs.toFixed(3)}, ` +
    `intΔ ${(stats.interiorDelta * 100).toFixed(3)}%`;
  return stats.pass
    ? `${caseId}: statistically equivalent - ${summary}`
    : `${caseId}: NOT EQUIVALENT - ${summary} [${stats.reasons.join("; ")}]`;
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
