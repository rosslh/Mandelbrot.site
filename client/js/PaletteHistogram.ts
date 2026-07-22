import throttle from "lodash/throttle";
import type MandelbrotMap from "./MandelbrotMap";
import type { ViewHistogram } from "./TileCache";
import {
  coloringOptions,
  isFixedPaletteMode,
  syncInputToConfig,
} from "./config";

// The histogram redraw scans every visible pixel (via TileCache.viewStats),
// so it is throttled to keep view moves and tile loads cheap; the memoized
// stats make repeat calls within an interval nearly free anyway.
const UPDATE_THROTTLE_MS = 150;

// Canvas backing-store height; the width is measured from the laid-out
// element so the bars fill the panel. Kept small — this is a thumbnail.
const CANVAS_HEIGHT = 64;

// Bars are drawn on a square-root vertical scale: the escape-value
// distribution is dominated by the fast-escaping exterior, so a linear scale
// would flatten the boundary/filament tail into invisibility. sqrt lifts the
// small buckets enough to read while keeping the ordering honest.
function barHeight(mass: number, peak: number): number {
  if (peak <= 0) {
    return 0;
  }
  return Math.sqrt(mass / peak) * CANVAS_HEIGHT;
}

/** Formats a weighted mass fraction as a percentage, e.g. "12%". */
function formatPercent(fraction: number): string {
  const percent = fraction * 100;
  if (percent > 0 && percent < 1) {
    return "<1%";
  }
  if (percent < 100 && percent > 99) {
    return ">99%";
  }
  return `${Math.round(percent)}%`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString();
}

/** The levels-style iteration histogram in the palette-range panel (issue
 * #49): the center-weighted distribution of visible escape values that palette
 * auto-fit fits over, with the current palette min/max bounds overlaid as
 * draggable markers, plus a compact readout of the view's min/max/median escape
 * time and interior-pixel fraction.
 *
 * The distribution comes from TileCache.viewStats — the same scan auto-fit
 * uses — so drawing it makes the fit's behavior visible. Dragging a marker
 * sets that palette bound manually (leaving auto-adjust, since the user is
 * overriding the fit) and recolors in place.
 *
 * Bars inside the palette window are tinted with the palette color their
 * bucket maps to (bars clipped outside stay gray), so the panel shows how
 * the palette is spent on the visible mass: under linear mapping the colors
 * spread evenly between the markers, and raising the color-mapping slider
 * visibly stretches them across the dense mass. The tints come from the
 * worker's recolor path with the live coloring options (window, equalization
 * table, cycles, reversal, adjustments), so they can never drift from the
 * colors on screen. */
class PaletteHistogram {
  private map: MandelbrotMap;
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private canvasWrap: HTMLElement;
  private spinner: HTMLElement;
  private ctx: CanvasRenderingContext2D | null;
  private statsList: HTMLElement;
  private minStat: HTMLElement;
  private maxStat: HTMLElement;
  private medianStat: HTMLElement;
  private interiorStat: HTMLElement;
  // The last computed distribution, so a marker drag can repaint the bounds
  // (and map a pointer x to an iteration value) without rescanning pixels.
  private lastStats: ViewHistogram | null = null;
  // The bound currently being dragged, or null.
  private dragging: "min" | "max" | null = null;
  // Per-bucket palette tints (RGBA, one pixel per bucket) with the
  // settings+domain fingerprint they were sampled for, plus the fingerprint
  // of the fetch in flight — so a redraw neither refetches unchanged colors
  // nor stacks duplicate fetches. Stale tints keep drawing until the fresh
  // ones land; a repaint follows.
  private barColors: Uint8Array | null = null;
  private barColorsKey: string | null = null;
  private barColorsFetchKey: string | null = null;

  constructor(map: MandelbrotMap) {
    this.map = map;

    this.container = document.getElementById("paletteHistogram") as HTMLElement;
    this.canvas = document.getElementById(
      "paletteHistogramCanvas",
    ) as HTMLCanvasElement;
    this.canvasWrap = document.getElementById(
      "paletteHistogramCanvasWrap",
    ) as HTMLElement;
    this.spinner = document.getElementById(
      "paletteHistogramSpinner",
    ) as HTMLElement;
    this.ctx = this.canvas.getContext("2d");
    this.statsList = document.getElementById(
      "paletteHistogramStats",
    ) as HTMLElement;
    this.minStat = document.getElementById("paletteStatMin") as HTMLElement;
    this.maxStat = document.getElementById("paletteStatMax") as HTMLElement;
    this.medianStat = document.getElementById(
      "paletteStatMedian",
    ) as HTMLElement;
    this.interiorStat = document.getElementById(
      "paletteStatInterior",
    ) as HTMLElement;
    this.setupDragging();

    // Redraw as tiles settle, the view moves, and the palette is re-fitted;
    // the panel expanding is also a chance to catch up on a size that was 0
    // while collapsed.
    map.on("moveend zoomend viewreset load resize", this.update);
    map.mandelbrotLayer?.on("load", this.update);
    const panel = document.getElementById("paletteRange");
    panel?.addEventListener("toggle", () => this.update());

    // The map may not have a view yet (the controls are constructed before
    // the initial goToCoordinates), and getBounds() throws until it does;
    // whenReady defers the first paint to the initial view when needed.
    map.whenReady(() => this.update());
  }

  /** Recomputes and redraws from the current view, throttled. */
  update = throttle(() => {
    // The fixed-palette rendering modes ignore the palette range and report
    // no iteration stats, so blank the panel instead of waiting forever on
    // data that will never arrive. Clearing lastStats also disables marker
    // drags.
    if (isFixedPaletteMode(this.map.config)) {
      this.lastStats = null;
      this.hideHistogram();
      return;
    }

    const stats = this.map.tileCache.viewStats(this.map.mapBoundsInTileSpace);
    this.lastStats = stats;
    this.render(stats);
  }, UPDATE_THROTTLE_MS);

  /** Blanks the histogram and stats (the fixed-palette rendering modes,
   * where the panel does not apply). */
  private hideHistogram() {
    this.canvasWrap.hidden = true;
    this.statsList.hidden = true;
    this.spinner.hidden = true;
    this.container.classList.remove("loading");
  }

  /** The current view has no scanned pixels yet (its tiles are still
   * rendering): keep the last-drawn histogram up, dimmed beneath a loading
   * spinner, rather than blanking the panel. The stats are hidden outright —
   * stale numbers read as current more easily than stale bars do. */
  private showLoading() {
    this.canvasWrap.hidden = false;
    this.statsList.hidden = true;
    this.spinner.hidden = false;
    this.container.classList.add("loading");
  }

  private render(stats: ViewHistogram | null) {
    const hasData = stats !== null && stats.escapedMass > 0;
    if (!stats || !hasData) {
      this.showLoading();
      return;
    }
    this.canvasWrap.hidden = false;
    this.statsList.hidden = false;
    this.spinner.hidden = true;
    this.container.classList.remove("loading");

    this.renderStats(stats);
    this.renderCanvas(stats);
  }

  private renderStats(stats: ViewHistogram) {
    // The palette floor and ceiling clip the raw [min, max] domain; report the
    // domain itself as the view's escape-time extent.
    this.minStat.textContent = formatCount(stats.min);
    this.maxStat.textContent = formatCount(stats.max);
    this.medianStat.textContent = formatCount(stats.median);
    const totalMass = stats.escapedMass + stats.interiorMass;
    this.interiorStat.textContent =
      totalMass > 0 ? formatPercent(stats.interiorMass / totalMass) : "0%";
  }

  private renderCanvas(stats: ViewHistogram) {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    // Size the backing store to the laid-out width so the bars stay crisp.
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = this.canvas.clientWidth || this.canvas.width / dpr;
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.round(CANVAS_HEIGHT * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    ctx.clearRect(0, 0, width, height);

    const styles = getComputedStyle(document.documentElement);
    const barColor = styles.getPropertyValue("--gray-300").trim() || "#d4d4d4";
    const dimColor = styles.getPropertyValue("--gray-600").trim() || "#525252";
    const markerColor =
      styles.getPropertyValue("--red-500").trim() || "#ef4444";

    const buckets = stats.buckets;
    const n = buckets.length;
    const minFrac = this.valueToFraction(this.map.config.paletteMinIter, stats);
    const maxFrac = this.valueToFraction(this.map.config.paletteMaxIter, stats);
    // Palette tints for the in-window bars, fetched asynchronously; until
    // they land (or while a settings change refreshes them) the last set
    // keeps drawing, falling back to the plain bright gray on first paint.
    const tints =
      this.barColors && this.barColors.length === n * 4 ? this.barColors : null;
    this.ensureBarColors(stats);

    for (let i = 0; i < n; i++) {
      const h = barHeight(buckets[i], stats.peak);
      if (h <= 0) {
        continue;
      }
      const x0 = Math.floor((i / n) * width);
      const x1 = Math.ceil(((i + 1) / n) * width);
      // The bucket's center in [0, 1] of the domain; bars inside the palette
      // range are tinted with the palette color they map to, those clipped
      // outside it dimmed.
      const center = (i + 0.5) / n;
      if (center >= minFrac && center <= maxFrac) {
        ctx.fillStyle = tints
          ? `rgb(${tints[i * 4]}, ${tints[i * 4 + 1]}, ${tints[i * 4 + 2]})`
          : barColor;
      } else {
        ctx.fillStyle = dimColor;
      }
      ctx.fillRect(x0, height - h, Math.max(1, x1 - x0), h);
    }

    // Overlay the palette min/max as vertical marker lines.
    ctx.fillStyle = markerColor;
    const markerWidth = Math.max(1, Math.round(dpr));
    for (const frac of [minFrac, maxFrac]) {
      const x = Math.round(frac * width);
      ctx.fillRect(
        Math.min(width - markerWidth, Math.max(0, x)),
        0,
        markerWidth,
        height,
      );
    }
  }

  /** Fingerprint of everything the bar tints depend on: the full coloring
   * options — including the equalization table, so a CDF rebuild (pan,
   * slider, marker drag) refreshes the tints — plus the histogram domain the
   * buckets span. */
  private barColorsFingerprint(stats: ViewHistogram): string {
    return JSON.stringify({
      coloring: coloringOptions(this.map.config, this.map.paletteCdf),
      min: stats.min,
      max: stats.max,
      buckets: stats.buckets.length,
    });
  }

  /** Fetches the per-bucket palette tints through the worker's recolor path —
   * one sample at each bucket's center value, colored by the same code the
   * tiles use — and repaints when they land. No-op while the cached tints (or
   * a fetch already in flight) match the current settings. */
  private ensureBarColors(stats: ViewHistogram) {
    const key = this.barColorsFingerprint(stats);
    if (key === this.barColorsKey || key === this.barColorsFetchKey) {
      return;
    }
    this.barColorsFetchKey = key;

    const n = stats.buckets.length;
    const values = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      values[i] = stats.min + ((i + 0.5) * (stats.max - stats.min)) / n;
    }

    this.map.regionRenderer
      .recolor(values, coloringOptions(this.map.config, this.map.paletteCdf))
      .then((image) => {
        // A newer fetch supersedes this one.
        if (this.barColorsFetchKey !== key) {
          return;
        }
        this.barColorsFetchKey = null;
        this.barColors = Uint8Array.from(image);
        this.barColorsKey = key;
        if (this.lastStats) {
          this.render(this.lastStats);
        }
      })
      .catch(() => {
        // The pool was terminated by a re-render; the next redraw retries.
        this.barColorsFetchKey = null;
      });
  }

  /** Maps an iteration value to its horizontal position in [0, 1] across the
   * histogram domain, clamped to the ends. */
  private valueToFraction(value: number, stats: ViewHistogram): number {
    const { min, max } = stats;
    if (max <= min) {
      return 0;
    }
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
  }

  /** Maps a horizontal position in [0, 1] to an iteration value in the domain,
   * rounded to a whole iteration. */
  private fractionToValue(fraction: number, stats: ViewHistogram): number {
    const { min, max } = stats;
    return Math.round(min + fraction * (max - min));
  }

  private setupDragging() {
    const pointerFraction = (event: PointerEvent): number => {
      const rect = this.canvas.getBoundingClientRect();
      if (rect.width === 0) {
        return 0;
      }
      return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    };

    this.canvas.addEventListener("pointerdown", (event) => {
      const stats = this.lastStats;
      if (!stats || stats.escapedMass <= 0) {
        return;
      }
      const frac = pointerFraction(event);
      const minFrac = this.valueToFraction(
        this.map.config.paletteMinIter,
        stats,
      );
      const maxFrac = this.valueToFraction(
        this.map.config.paletteMaxIter,
        stats,
      );
      // Grab the nearer marker.
      this.dragging =
        Math.abs(frac - minFrac) <= Math.abs(frac - maxFrac) ? "min" : "max";
      this.canvas.setPointerCapture(event.pointerId);
      this.applyDrag(frac, stats);
      event.preventDefault();
    });

    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.dragging || !this.lastStats) {
        return;
      }
      this.applyDrag(pointerFraction(event), this.lastStats);
    });

    const endDrag = (event: PointerEvent) => {
      if (!this.dragging) {
        return;
      }
      this.dragging = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
    };
    this.canvas.addEventListener("pointerup", endDrag);
    this.canvas.addEventListener("pointercancel", endDrag);
  }

  /** Commits a marker drag: sets the dragged palette bound to the iteration
   * value under the pointer (keeping min < max), leaves auto-adjust so the
   * override sticks, and recolors the visible tiles in place. */
  private applyDrag(fraction: number, stats: ViewHistogram) {
    if (!this.dragging) {
      return;
    }
    const value = this.fractionToValue(fraction, stats);
    const config = this.map.config;

    if (this.dragging === "min") {
      config.paletteMinIter = Math.min(value, config.paletteMaxIter - 1);
    } else {
      config.paletteMaxIter = Math.max(value, config.paletteMinIter + 1);
    }

    // A manual bound overrides the fit: drop auto-adjust so a later settle
    // does not snap the marker back.
    if (config.paletteAutoAdjust) {
      config.paletteAutoAdjust = false;
      syncInputToConfig(config, "paletteAutoAdjust");
    }

    this.map.controls.notifyPaletteBoundsChanged();
    // The window moved, so histogram coloring's CDF must rebuild before
    // the repaint (it spans exactly the window).
    this.map.applyPaletteWindowChange();
    // Repaint the markers immediately; the recolor lands asynchronously.
    this.render(stats);
  }
}

export default PaletteHistogram;
