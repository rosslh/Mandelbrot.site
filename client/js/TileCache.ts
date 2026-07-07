import type * as L from "leaflet";

type TileIterationRange = { min: number; max: number };

export type CachedTile = {
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
};

// A handful of pixels can escape at far higher iteration counts than the
// rest of the view (e.g. filaments grazing the set near the iteration cap).
// Fitting the palette ceiling to the raw maximum lets those few pixels
// compress everything else into the bottom of the gradient, so the ceiling
// is instead the value below which this fraction of escaped pixels falls.
// The fraction must stay in true-outlier territory: escaped-pixel counts are
// weighted by area, and on wide views the fast-escaping exterior dominates —
// at 99% the full-set view fits its ceiling to ~21 of 199 detected
// iterations, crushing the boundary glow. Thin filament views cut the other
// way: their high-iteration pixels hug a nearly one-dimensional curve, so
// even a 0.01% tail (99.99%) clips real structure and flattens the filament
// glow. 99.999% (~14 px on a full screen) only removes isolated specks.
const CEILING_PERCENTILE = 0.99999;
// Symmetric guard for the floor: a few stray fast-escaping pixels would
// otherwise pin the range bottom and waste the low end of the gradient. The
// low side is far less skewed than the high side (the exterior mass sits
// just above the true minimum), so a much larger fraction is safe here.
const FLOOR_PERCENTILE = 0.005;
// Buckets for the percentile histogram over [min, max]; at a typical detected
// spread of a few thousand iterations this resolves to a few iterations.
const HISTOGRAM_BUCKETS = 1024;

/** Caches each on-screen tile's escape data as it renders: the iteration
 * range feeds palette auto-fitting, and the per-pixel values + canvas let a
 * new palette range be applied by recoloring instead of re-rendering. */
class TileCache {
  private tiles = new Map<string, CachedTile>();
  // detectedRange scans every cached pixel for the percentile ceiling, so
  // its result is memoized until the cache contents change.
  private version = 0;
  private lastDetection: {
    version: number;
    zoom: number;
    result: TileIterationRange | null;
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
  ) {
    this.tiles.set(this.key(position), {
      zoom: position.z,
      range:
        minIter !== null && maxIter !== null
          ? { min: minIter, max: maxIter }
          : null,
      canvas,
      values,
      width: canvas.width,
      height: canvas.height,
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

  /** The iteration range across cached tiles at the given zoom, or null when
   * no tile has reported one. The floor is the raw minimum; the ceiling is
   * percentile-clipped so a few unusually deep pixels cannot stretch the
   * palette. Guarantees max > min. */
  detectedRange(zoom: number): TileIterationRange | null {
    if (
      this.lastDetection &&
      this.lastDetection.version === this.version &&
      this.lastDetection.zoom === zoom
    ) {
      return this.lastDetection.result;
    }

    let result: TileIterationRange | null = null;

    for (const tile of this.tiles.values()) {
      if (tile.zoom !== zoom || tile.range === null) {
        continue;
      }
      if (result === null) {
        result = { min: tile.range.min, max: tile.range.max };
      } else {
        result.min = Math.min(result.min, tile.range.min);
        result.max = Math.max(result.max, tile.range.max);
      }
    }

    if (result !== null) {
      result = this.percentileClip(zoom, result);
      result.max = Math.max(result.max, result.min + 1);
    }

    this.lastDetection = { version: this.version, zoom, result };
    return result;
  }

  /** Clips the raw range to the [FLOOR_PERCENTILE, CEILING_PERCENTILE]
   * span of the escaped pixels at the given zoom, computed from a histogram
   * of the cached per-pixel values over [min, max]. */
  private percentileClip(
    zoom: number,
    { min, max }: TileIterationRange,
  ): TileIterationRange {
    if (max - min < 2) {
      return { min, max };
    }

    const buckets = new Uint32Array(HISTOGRAM_BUCKETS);
    const scale = HISTOGRAM_BUCKETS / (max - min);
    let total = 0;

    for (const tile of this.tiles.values()) {
      if (tile.zoom !== zoom || tile.range === null) {
        continue;
      }
      const values = tile.values;
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        // Interior pixels are +Infinity; smoothing can also nudge a value
        // slightly outside the integer iteration bounds, so clamp.
        if (!Number.isFinite(value)) {
          continue;
        }
        const bucket = Math.min(
          HISTOGRAM_BUCKETS - 1,
          Math.max(0, Math.floor((value - min) * scale)),
        );
        buckets[bucket] += 1;
        total += 1;
      }
    }

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

  /** All cached tiles at the given zoom. */
  tilesAtZoom(zoom: number): CachedTile[] {
    return [...this.tiles.values()].filter((tile) => tile.zoom === zoom);
  }
}

export default TileCache;
