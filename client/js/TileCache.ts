import type * as L from "leaflet";
import type { TileRect } from "./protocol";

type TileIterationRange = { min: number; max: number };

/** The center-weighted escape-value distribution of the visible pixels, plus
 * the aggregates that fall out of the same pass. `buckets` spans [min, max]
 * with the same 1024 buckets, neighbor-capping, and center weighting the
 * palette auto-fit uses, so drawing it makes the fit's behavior visible.
 * Weights are fractional (center weighting), so the counts are weighted
 * masses rather than pixel counts; the interior/escaped split and the mean
 * are computed over the same weighting. */
export type ViewHistogram = {
  // The histogram domain — the raw escaped-iteration range across visible
  // tiles, before percentile clipping.
  min: number;
  max: number;
  // Center-weighted mass per bucket over [min, max].
  buckets: Float64Array;
  // The tallest bucket's mass, so callers can normalize the bars.
  peak: number;
  // Weighted escaped mass (the sum over buckets) and weighted interior mass
  // (+Infinity pixels, skipped by the buckets). Their sum is the total
  // visible mass; interiorMass / (escapedMass + interiorMass) is the interior
  // fraction.
  escapedMass: number;
  interiorMass: number;
  // Weighted mean escape value across escaped pixels.
  mean: number;
};

// Inclusive pixel-index bounds of a tile's on-screen portion.
type PixelRect = { x0: number; x1: number; y0: number; y1: number };

export type CachedTile = {
  // Leaflet tile coordinates: the tile spans [x, x+1) × [y, y+1) in tile
  // space at its zoom.
  x: number;
  y: number;
  zoom: number;
  // Escaped-pixel iteration range; null when the tile is entirely inside
  // the set.
  range: TileIterationRange | null;
  // The on-screen canvas the tile is drawn to, plus the per-pixel smoothed
  // escape values that produced it, so the tile can be recolored in place
  // without recomputing escape times.
  canvas: HTMLCanvasElement;
  values: Float32Array;
  width: number;
  height: number;
  // Precision tier that rendered the tile (see tierOverlay.ts), so the
  // diagnostics overlay can be redrawn on toggle without re-rendering.
  tier: number;
};

// A handful of pixels can escape at far higher iteration counts than the
// rest of the view (e.g. filaments grazing the set near the iteration cap).
// Fitting the palette ceiling to the raw maximum lets those few pixels
// compress everything else into the bottom of the gradient, so the ceiling
// is instead the value below which this fraction of the escaped-pixel mass
// falls. The fraction must stay in true-outlier territory: escaped-pixel
// mass is weighted by area, and on wide views the fast-escaping exterior
// dominates — at 99% the full-set view fits its ceiling to ~21 of 199
// detected iterations, crushing the boundary glow. Thin filament views cut
// the other way: their high-iteration pixels hug a nearly one-dimensional
// curve, so even a 0.01% tail (99.99%) clips real structure and flattens the
// filament glow. A percentile alone also cannot tell an isolated speck from
// a filament, so each pixel additionally enters the histogram capped at the
// brightest of its 8 neighbors: a lone bright pixel collapses to its
// surroundings and stops propping up the ceiling, while connected structure
// — filaments, and the glow along the set boundary (interior neighbors are
// +Infinity) — always has a bright neighbor and keeps its value. With the
// speck-count burden handled spatially, the percentile can stay gentle:
// 99.999% (~14 px on a full screen) trims only the residual tail.
const CEILING_PERCENTILE = 0.99999;
// Symmetric guard for the floor: a few stray fast-escaping pixels would
// otherwise pin the range bottom and waste the low end of the gradient. The
// low side is far less skewed than the high side (the exterior mass sits
// just above the true minimum), so a much larger fraction is safe here.
const FLOOR_PERCENTILE = 0.005;
// Buckets for the percentile histogram over [min, max]; at a typical detected
// spread of a few thousand iterations this resolves to a few iterations.
const HISTOGRAM_BUCKETS = 1024;

/** Caches each loaded tile's escape data as it renders: the iteration range
 * feeds palette auto-fitting, and the per-pixel values + canvas let a new
 * palette range be applied by recoloring instead of re-rendering.
 *
 * The fit only sees what the user sees: pixels outside the viewport (whole
 * buffer-ring tiles, and the off-screen part of tiles straddling the edge)
 * carry weight 0, and each visible pixel's histogram mass falls off with its
 * distance from the view center — weight 1 / (1 + r²), with r normalized to
 * 1 at the viewport's mid-edges (weight ~1/3 at the corners) — so the
 * structure being looked at dominates the fit and edge content only nudges
 * it. */
class TileCache {
  private tiles = new Map<string, CachedTile>();
  // detectedRange scans every visible pixel for the percentile ceiling, so
  // its result is memoized until the cache contents or the viewport change.
  private version = 0;
  private lastDetection: {
    version: number;
    bounds: TileRect;
    result: TileIterationRange | null;
  } | null = null;
  // viewStats runs the same full-pixel scan as detectedRange, so it is
  // memoized against the same version/bounds key. It stays independent of
  // lastDetection because the panel that consumes it may not be open on every
  // fit, and a fit does not always compute stats.
  private lastStats: {
    version: number;
    bounds: TileRect;
    result: ViewHistogram | null;
  } | null = null;

  private key(position: L.Coords): string {
    return `${position.x}:${position.y}:${position.z}`;
  }

  record(
    position: L.Coords,
    minIter: number | null,
    maxIter: number | null,
    canvas: HTMLCanvasElement,
    values: Float32Array,
    tier: number,
  ) {
    this.tiles.set(this.key(position), {
      x: position.x,
      y: position.y,
      zoom: position.z,
      range:
        minIter !== null && maxIter !== null
          ? { min: minIter, max: maxIter }
          : null,
      canvas,
      values,
      width: canvas.width,
      height: canvas.height,
      tier,
    });
    this.version += 1;
  }

  remove(position: L.Coords) {
    if (this.tiles.delete(this.key(position))) {
      this.version += 1;
    }
  }

  clear() {
    this.tiles.clear();
    this.version += 1;
  }

  /** The iteration range across the on-screen pixels of cached tiles within
   * the given viewport (in tile space), or null when no visible tile has
   * reported one. The floor and ceiling are center-weighted-percentile
   * clipped so a few unusually deep or shallow pixels cannot stretch the
   * palette. Guarantees max > min. */
  detectedRange(bounds: TileRect): TileIterationRange | null {
    const last = this.lastDetection;
    if (
      last &&
      last.version === this.version &&
      last.bounds.zoom === bounds.zoom &&
      last.bounds.xMin === bounds.xMin &&
      last.bounds.xMax === bounds.xMax &&
      last.bounds.yMin === bounds.yMin &&
      last.bounds.yMax === bounds.yMax
    ) {
      return last.result;
    }

    let result: TileIterationRange | null = null;

    for (const tile of this.tiles.values()) {
      if (
        tile.zoom !== bounds.zoom ||
        tile.range === null ||
        this.visiblePixels(tile, bounds) === null
      ) {
        continue;
      }
      // A partially visible tile's range covers its off-screen pixels too,
      // but it only sets the histogram domain here; percentileClip reads
      // exactly the visible pixels.
      if (result === null) {
        result = { min: tile.range.min, max: tile.range.max };
      } else {
        result.min = Math.min(result.min, tile.range.min);
        result.max = Math.max(result.max, tile.range.max);
      }
    }

    if (result !== null) {
      result = this.percentileClip(bounds, result);
      result.max = Math.max(result.max, result.min + 1);
    }

    this.lastDetection = { version: this.version, bounds, result };
    return result;
  }

  /** Clips the raw range to the [FLOOR_PERCENTILE, CEILING_PERCENTILE] span
   * of the visible escaped pixels, computed from a center-weighted histogram
   * of the cached per-pixel values over [min, max]. Each pixel enters the
   * histogram capped at its brightest 8-neighbor, so single-pixel bright
   * outliers cannot hold the ceiling up (see CEILING_PERCENTILE). */
  private percentileClip(
    bounds: TileRect,
    range: TileIterationRange,
  ): TileIterationRange {
    const { min, max } = range;
    if (max - min < 2) {
      return { min, max };
    }

    const { buckets, escapedMass: total } = this.buildHistogram(bounds, range);

    if (total === 0) {
      return { min, max };
    }

    const floorThreshold = total * FLOOR_PERCENTILE;
    const ceilingThreshold = total * CEILING_PERCENTILE;
    let floor = min;
    let ceiling = max;
    let floorFound = false;
    let cumulative = 0;

    for (let bucket = 0; bucket < HISTOGRAM_BUCKETS; bucket++) {
      cumulative += buckets[bucket];
      if (!floorFound && cumulative >= floorThreshold) {
        // The lower edge of the bucket, rounded down to a whole iteration.
        floor = Math.floor(min + (bucket * (max - min)) / HISTOGRAM_BUCKETS);
        floorFound = true;
      }
      if (cumulative >= ceilingThreshold) {
        // The upper edge of the bucket, rounded up to a whole iteration.
        ceiling = Math.ceil(
          min + ((bucket + 1) * (max - min)) / HISTOGRAM_BUCKETS,
        );
        break;
      }
    }

    return { min: floor, max: ceiling };
  }

  /** The center-weighted escape-value distribution of the visible pixels,
   * for the palette-range panel's levels-style histogram. Runs the same scan
   * as detectedRange (same domain, neighbor-capping, and center weighting),
   * memoized against version/bounds so an open panel does not double the
   * per-frame cost. Returns null when no visible tile has reported a range. */
  viewStats(bounds: TileRect): ViewHistogram | null {
    const last = this.lastStats;
    if (
      last &&
      last.version === this.version &&
      last.bounds.zoom === bounds.zoom &&
      last.bounds.xMin === bounds.xMin &&
      last.bounds.xMax === bounds.xMax &&
      last.bounds.yMin === bounds.yMin &&
      last.bounds.yMax === bounds.yMax
    ) {
      return last.result;
    }

    let range: TileIterationRange | null = null;
    for (const tile of this.tiles.values()) {
      if (
        tile.zoom !== bounds.zoom ||
        tile.range === null ||
        this.visiblePixels(tile, bounds) === null
      ) {
        continue;
      }
      if (range === null) {
        range = { min: tile.range.min, max: tile.range.max };
      } else {
        range.min = Math.min(range.min, tile.range.min);
        range.max = Math.max(range.max, tile.range.max);
      }
    }

    let result: ViewHistogram | null = null;
    if (range !== null) {
      // A single-value domain still yields useful aggregates (mean, interior
      // fraction); widen it by one so the buckets have somewhere to land.
      const max = Math.max(range.max, range.min + 1);
      result = this.buildHistogram(bounds, { min: range.min, max });
    }

    this.lastStats = { version: this.version, bounds, result };
    return result;
  }

  /** Scans the visible pixels once, filling a center-weighted, neighbor-capped
   * histogram over [min, max] plus the aggregates that fall out of the same
   * pass. Shared by percentileClip (which reads the buckets) and viewStats
   * (which reads everything). */
  private buildHistogram(
    bounds: TileRect,
    { min, max }: TileIterationRange,
  ): ViewHistogram {
    // Center weighting makes the counts fractional.
    const buckets = new Float64Array(HISTOGRAM_BUCKETS);
    const scale = HISTOGRAM_BUCKETS / (max - min);
    const centerX = (bounds.xMin + bounds.xMax) / 2;
    const centerY = (bounds.yMin + bounds.yMax) / 2;
    const halfWidth = (bounds.xMax - bounds.xMin) / 2 || 1;
    const halfHeight = (bounds.yMax - bounds.yMin) / 2 || 1;
    let escapedMass = 0;
    let interiorMass = 0;
    // Weighted sum of the raw (uncapped) escape values, for the mean.
    let valueSum = 0;

    for (const tile of this.tiles.values()) {
      if (tile.zoom !== bounds.zoom || tile.range === null) {
        continue;
      }
      const visible = this.visiblePixels(tile, bounds);
      if (visible === null) {
        continue;
      }
      const { values, width, height } = tile;
      const { x0, x1, y0, y1 } = visible;

      // Squared normalized distance from the view center, per visible
      // column; the row's term is added in the pixel loop.
      const xDistSq = new Float64Array(x1 - x0 + 1);
      for (let x = x0; x <= x1; x++) {
        const nx = (tile.x + (x + 0.5) / width - centerX) / halfWidth;
        xDistSq[x - x0] = nx * nx;
      }

      // Rolling 3-row window maxima: windowRows[y % 3] holds row y's
      // 3-wide horizontal maxima, so each row is scanned once and the
      // 8-neighbor maximum needs only the rows above and below plus the
      // two lateral pixels. Neighbor rows and columns extend past the
      // visible rect into the rest of the tile — visibility limits which
      // pixels are counted, not which neighbors they see. Only neighbors
      // outside the tile are absent; a filament crossing a tile seam still
      // has in-tile neighbors.
      const windowRows = [
        new Float32Array(width),
        new Float32Array(width),
        new Float32Array(width),
      ];
      if (y0 > 0) {
        this.rowWindowMax(
          values,
          (y0 - 1) * width,
          width,
          windowRows[(y0 - 1) % 3],
        );
      }
      this.rowWindowMax(values, y0 * width, width, windowRows[y0 % 3]);

      for (let y = y0; y <= y1; y++) {
        const above = y > 0 ? windowRows[(y - 1) % 3] : null;
        const below =
          y + 1 < height
            ? this.rowWindowMax(
                values,
                (y + 1) * width,
                width,
                windowRows[(y + 1) % 3],
              )
            : null;
        const ny = (tile.y + (y + 0.5) / height - centerY) / halfHeight;
        const rowWeightTerm = 1 + ny * ny;
        const rowStart = y * width;

        for (let x = x0; x <= x1; x++) {
          const weight = 1 / (rowWeightTerm + xDistSq[x - x0]);
          const value = values[rowStart + x];
          // Interior pixels are +Infinity; smoothing can also nudge a value
          // slightly outside the integer iteration bounds, so clamp.
          if (!Number.isFinite(value)) {
            interiorMass += weight;
            continue;
          }
          // Only a strict local maximum gets capped, so bail out on the
          // first neighbor that matches or beats the pixel — for the vast
          // majority of pixels the first row-window comparison settles it.
          let capped = value;
          if (
            (above === null || value > above[x]) &&
            (below === null || value > below[x])
          ) {
            let neighborMax = above === null ? -Infinity : above[x];
            if (below !== null) {
              neighborMax = Math.max(neighborMax, below[x]);
            }
            if (x > 0) {
              neighborMax = Math.max(neighborMax, values[rowStart + x - 1]);
            }
            if (x + 1 < width) {
              neighborMax = Math.max(neighborMax, values[rowStart + x + 1]);
            }
            capped = Math.min(value, neighborMax);
          }
          const bucket = Math.min(
            HISTOGRAM_BUCKETS - 1,
            Math.max(0, Math.floor((capped - min) * scale)),
          );
          buckets[bucket] += weight;
          escapedMass += weight;
          valueSum += weight * value;
        }
      }
    }

    let peak = 0;
    for (let bucket = 0; bucket < HISTOGRAM_BUCKETS; bucket++) {
      if (buckets[bucket] > peak) {
        peak = buckets[bucket];
      }
    }

    return {
      min,
      max,
      buckets,
      peak,
      escapedMass,
      interiorMass,
      mean: escapedMass > 0 ? valueSum / escapedMass : min,
    };
  }

  /** The inclusive pixel-index rect of the tile's on-screen portion — a
   * pixel counts as visible when its center is inside the viewport — or
   * null when the tile is entirely off screen. */
  private visiblePixels(tile: CachedTile, bounds: TileRect): PixelRect | null {
    const { width, height } = tile;
    const x0 = Math.max(0, Math.ceil((bounds.xMin - tile.x) * width - 0.5));
    const x1 = Math.min(
      width - 1,
      Math.floor((bounds.xMax - tile.x) * width - 0.5),
    );
    const y0 = Math.max(0, Math.ceil((bounds.yMin - tile.y) * height - 0.5));
    const y1 = Math.min(
      height - 1,
      Math.floor((bounds.yMax - tile.y) * height - 0.5),
    );

    return x0 <= x1 && y0 <= y1 ? { x0, x1, y0, y1 } : null;
  }

  /** Fills `out[x]` with the maximum of the row's values at x-1, x, x+1
   * (clamped to the row), for the row starting at `rowStart`. */
  private rowWindowMax(
    values: Float32Array,
    rowStart: number,
    width: number,
    out: Float32Array,
  ): Float32Array {
    for (let x = 0; x < width; x++) {
      let windowMax = values[rowStart + x];
      if (x > 0) {
        windowMax = Math.max(windowMax, values[rowStart + x - 1]);
      }
      if (x + 1 < width) {
        windowMax = Math.max(windowMax, values[rowStart + x + 1]);
      }
      out[x] = windowMax;
    }
    return out;
  }

  /** All cached tiles at the given zoom. */
  tilesAtZoom(zoom: number): CachedTile[] {
    return [...this.tiles.values()].filter((tile) => tile.zoom === zoom);
  }
}

export default TileCache;
