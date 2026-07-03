export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Median absolute deviation: robust spread estimate for noisy timings.
export function mad(values) {
  const center = median(values);
  return median(values.map((value) => Math.abs(value - center)));
}

export function geomean(values) {
  return Math.exp(
    values.reduce((sum, value) => sum + Math.log(value), 0) / values.length,
  );
}

// A difference is real when it clears both an absolute floor (3%) and the
// combined measurement noise of the two sides.
export function isSignificant(baselineMedian, baselineMad, candidateMedian, candidateMad) {
  const relativeChange = Math.abs(candidateMedian / baselineMedian - 1);
  const noiseFloor = (2 * (baselineMad + candidateMad)) / baselineMedian;
  return relativeChange > Math.max(0.03, noiseFloor);
}
