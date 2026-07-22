import type MandelbrotMap from "./MandelbrotMap";
import type { RenderFrame } from "./RegionRenderer";
import { fittedCdfForRender, fittedRangeForRender } from "./TileCache";
import { coloringOptions } from "./config";
import type { ColoringOptions, TileRect } from "./protocol";
import { FULL_SET_ZOOM } from "./magnification";

// The panel canvas renders at its laid-out CSS size times the display's
// devicePixelRatio, so it is pixel-sharp on high-DPI screens. It deliberately
// ignores the tile layer's supersampling setting — display resolution is all
// a small decorative panel needs. This is the fallback CSS side length for
// the moment before the panel has a layout to measure.
const THUMBNAIL_FALLBACK_CSS_PX = 200;

// Upper bound on the backing-store side length, so an extreme
// devicePixelRatio cannot turn a render into a heavyweight job on the worker
// pool the tile layer is also using.
const THUMBNAIL_MAX_DEVICE_PX = 800;

/** The device-pixel side length for a render into the panel's square canvas:
 * the laid-out CSS size scaled by the display's devicePixelRatio (never the
 * tile layer's supersampling factor), bounded above so extreme ratios stay
 * cheap. Falls back to a nominal size before the panel has a layout. Shared
 * by the Julia thumbnail and the minimap, which draw into the same canvas. */
export function thumbnailRenderSize(canvas: HTMLCanvasElement): number {
  const dpr = window.devicePixelRatio || 1;
  const cssSize = canvas.clientWidth || THUMBNAIL_FALLBACK_CSS_PX;
  return Math.min(
    THUMBNAIL_MAX_DEVICE_PX,
    Math.max(1, Math.round(cssSize * dpr)),
  );
}

// The minimap's fixed window: the classic full-set framing, a square of
// half-extent 1.5 centered on (-0.75, 0) — re in [-2.25, 0.75], im in
// [-1.5, 1.5], which holds the whole set (re in [-2, 0.25], |im| <= ~1.12)
// with a margin.
const MINIMAP_CENTER_RE = -0.75;
const MINIMAP_CENTER_IM = 0;
const MINIMAP_HALF_EXTENT = 1.5;

// The frame the minimap renders in: the absolute complex plane. Rendering
// relative to the map's wandering origin would scale the fixed window by the
// view's 2^-zoomOffset deep-zoom factor, overflowing f64 at depth; pinning
// the origin at zero with no offset keeps the region's tile coordinates
// small, exact, and independent of where the view is.
const MINIMAP_FRAME: RenderFrame = {
  originRe: "0",
  originIm: "0",
  zoomOffset: 0,
};

// Below this on-screen size, the viewport rectangle is illegibly small and
// the marker degrades to a crosshair at the viewport center.
const MARKER_MIN_RECT_CSS_PX = 4;

// Crosshair geometry: arm length either side of the center, plus a center
// dot, in CSS pixels.
const CROSSHAIR_ARM_CSS_PX = 5;
const CROSSHAIR_DOT_RADIUS_CSS_PX = 2;

// The marker strokes twice — a dark underlay beneath a light line — so it
// stays legible over both the set's dark interior and bright palette bands.
const MARKER_UNDERLAY_WIDTH_CSS_PX = 3;
const MARKER_LINE_WIDTH_CSS_PX = 1.5;

/** The Mandelbrot minimap: a fixed full-set view with a "you are here"
 * marker for the current viewport, so a deep zoom stays anchored to where in
 * the set it lives. The fractal image depends only on the appearance
 * settings and canvas size — never on the view's position — so it renders
 * once through the worker pool and is cached as an ImageBitmap; pan and zoom
 * only redraw the cached image plus the marker on the main thread. Past
 * shallow zoom the marker stops moving visibly (the viewport sweeps
 * distances far below a minimap pixel), which is the point: it remembers
 * where you are. */
class MinimapView {
  private map: MandelbrotMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  // Increments per render so a stale in-flight result cannot replace a newer
  // one that resolved first.
  private renderId = 0;
  private cached: {
    bitmap: ImageBitmap;
    size: number;
    settingsKey: string;
  } | null = null;

  constructor(map: MandelbrotMap, canvas: HTMLCanvasElement) {
    this.map = map;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
  }

  /** Shows the minimap after a mode switch or panel reopen: repaints from
   * the cache, rendering first if the cache is missing or stale. */
  activate() {
    void this.ensureImageAndDraw();
  }

  /** Re-renders after a settings change. Renders only when a setting the
   * minimap's pixels depend on actually changed — the settings fingerprint
   * excludes the map's palette window (see minimapColoring), so the tile
   * layer's per-pan window refits at depth are repaint-only no-ops here. */
  refresh() {
    void this.ensureImageAndDraw();
  }

  /** Repaints the marker after a pan or zoom: cached image plus marker, no
   * worker traffic. */
  updateMarker() {
    if (!this.cached) {
      void this.ensureImageAndDraw();
      return;
    }
    this.draw();
  }

  /** The fixed window's bounds in tile space at the minimap's frame. In tile
   * space the y axis points down: the top of the image (yMin) is the highest
   * imaginary coordinate. */
  private tileRect(): TileRect {
    const zoom = FULL_SET_ZOOM;
    return {
      xMin: this.map.tileCoordinateForOffset(
        MINIMAP_CENTER_RE - MINIMAP_HALF_EXTENT,
        zoom,
      ),
      xMax: this.map.tileCoordinateForOffset(
        MINIMAP_CENTER_RE + MINIMAP_HALF_EXTENT,
        zoom,
      ),
      yMin: this.map.tileCoordinateForOffset(
        -(MINIMAP_CENTER_IM + MINIMAP_HALF_EXTENT),
        zoom,
      ),
      yMax: this.map.tileCoordinateForOffset(
        -(MINIMAP_CENTER_IM - MINIMAP_HALF_EXTENT),
        zoom,
      ),
      zoom,
    };
  }

  /** The coloring options for the minimap's render and recolor: the map's
   * appearance settings with the palette window zeroed. In standard mode the
   * minimap fits its own window to its own iteration range (the map's window
   * — auto-fit or manual — describes the deep view's iteration counts, which
   * would clamp this shallow render to one end of the gradient); the
   * normalized modes (distance-estimate, atom-domain) color from fixed [0, 1]
   * values and ignore the window entirely (see ColoringOptions in
   * mandelbrot/src/lib.rs), and unlike the Julia thumbnail the minimap keeps
   * their flags — it is a view of the Mandelbrot set itself, so it should
   * match the on-screen rendering mode. Zeroing the window in all modes also
   * keeps it out of the settings fingerprint, which is what makes the tile
   * layer's per-pan window refits free for the minimap. */
  private minimapColoring(
    paletteCdf: Float32Array | null = null,
  ): ColoringOptions {
    return {
      ...coloringOptions(this.map.config, paletteCdf),
      paletteMinIter: 0,
      paletteMaxIter: 0,
    };
  }

  /** Fingerprint of every setting that affects the minimap's pixels, so a
   * refresh can tell a real settings change from a palette-window refit. The
   * color-mapping strength rides separately: like the window, the
   * equalization table is private to the minimap (built from its own render,
   * not the map's viewport table), but moving the slider changes its
   * pixels. */
  private settingsKey(): string {
    const config = this.map.config;
    return JSON.stringify({
      coloring: this.minimapColoring(),
      histogramColoring: config.histogramColoring,
      iterations: config.iterations,
      exponent: config.exponent,
      smoothColoring: config.smoothColoring,
    });
  }

  private async ensureImageAndDraw() {
    if (!this.ctx) {
      return;
    }
    const size = thumbnailRenderSize(this.canvas);
    const settingsKey = this.settingsKey();
    if (
      this.cached &&
      this.cached.size === size &&
      this.cached.settingsKey === settingsKey
    ) {
      this.draw();
      return;
    }

    const id = ++this.renderId;
    try {
      // The escape values are only needed for the standard-mode palette fit;
      // the normalized modes use the rendered image as-is.
      const standardMode = this.map.config.renderMode === "standard";
      const response = await this.map.regionRenderer.renderRegion(
        this.tileRect(),
        size,
        size,
        standardMode,
        MINIMAP_FRAME,
      );

      // The minimap's own palette fit: the same center-weighted percentile
      // window the tile layer fits to the view, over the minimap's pixels.
      // It can only miss for an all-interior render, which the full-set
      // framing never is; the plain config-palette image is the nominal
      // fallback. At any nonzero color-mapping strength the minimap likewise
      // builds its own equalization CDF from this render over the fitted
      // window — the map's viewport-global table describes the view's
      // distribution, not the full set's.
      let image = response.image;
      if (standardMode && response.values) {
        const range = fittedRangeForRender(response, size, size);
        if (range) {
          const cdf = fittedCdfForRender(
            response,
            size,
            size,
            range,
            this.map.config.histogramColoring / 100,
          );
          image = await this.map.regionRenderer.recolor(response.values, {
            ...this.minimapColoring(cdf),
            paletteMinIter: range.min,
            paletteMaxIter: range.max,
          });
        }
      }
      const bitmap = await createImageBitmap(
        new ImageData(Uint8ClampedArray.from(image), size, size),
      );
      // A newer render (or a pool re-creation that resolved out of order)
      // supersedes this one.
      if (id !== this.renderId) {
        bitmap.close();
        return;
      }
      this.cached?.bitmap.close();
      this.cached = { bitmap, size, settingsKey };
      this.draw();
    } catch {
      // The pool was terminated by a re-render; the next refresh retries
      // against the fresh pool.
    }
  }

  private draw() {
    const cached = this.cached;
    if (!this.ctx || !cached) {
      return;
    }
    // Size the backing store to the render (setting it also clears the
    // canvas, so only on change); CSS keeps the displayed size.
    if (
      this.canvas.width !== cached.size ||
      this.canvas.height !== cached.size
    ) {
      this.canvas.width = cached.size;
      this.canvas.height = cached.size;
    }
    this.ctx.drawImage(cached.bitmap, 0, 0);
    this.drawMarker(cached.size);
  }

  /** The minimap pixel of an absolute complex coordinate (f64 corners are
   * fine at any depth: past shallow zoom their error is the origin string's
   * f64 rounding, ~1e-16 complex units against a minimap pixel of ~4e-3). */
  private toPixel(
    re: number,
    im: number,
    size: number,
  ): { x: number; y: number } {
    const pxPerUnit = size / (2 * MINIMAP_HALF_EXTENT);
    return {
      x: (re - (MINIMAP_CENTER_RE - MINIMAP_HALF_EXTENT)) * pxPerUnit,
      y: (MINIMAP_CENTER_IM + MINIMAP_HALF_EXTENT - im) * pxPerUnit,
    };
  }

  /** Draws the "you are here" marker: the viewport as a rectangle while it
   * is legibly large on the minimap, degrading to a crosshair at the
   * viewport center once the view is too deep for the rectangle to resolve. */
  private drawMarker(size: number) {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    // Device pixels per CSS pixel at the rendered size, so the marker's
    // stroke widths stay constant on screen across DPIs.
    const scale = size / (this.canvas.clientWidth || THUMBNAIL_FALLBACK_CSS_PX);

    const bounds = this.map.getBounds();
    const southWest = this.map.complexAtLatLngFloat(bounds.getSouthWest());
    const northEast = this.map.complexAtLatLngFloat(bounds.getNorthEast());
    const topLeft = this.toPixel(southWest.re, northEast.im, size);
    const bottomRight = this.toPixel(northEast.re, southWest.im, size);

    const width = bottomRight.x - topLeft.x;
    const height = bottomRight.y - topLeft.y;
    const minRect = MARKER_MIN_RECT_CSS_PX * scale;

    ctx.save();
    ctx.lineCap = "round";
    if (width >= minRect && height >= minRect) {
      // At the shallowest zooms the viewport can exceed the minimap's
      // window; clamping keeps the visible edges on the canvas.
      const x0 = Math.max(0, topLeft.x);
      const y0 = Math.max(0, topLeft.y);
      const x1 = Math.min(size, bottomRight.x);
      const y1 = Math.min(size, bottomRight.y);
      this.strokeTwoPass(ctx, scale, () =>
        ctx.strokeRect(x0, y0, x1 - x0, y1 - y0),
      );
    } else {
      const center = this.map.complexAtLatLngFloat(this.map.getCenter());
      const pixel = this.toPixel(center.re, center.im, size);
      // A center panned outside the window pins the crosshair to the nearest
      // edge, pointing at where the view went.
      const x = Math.min(size, Math.max(0, pixel.x));
      const y = Math.min(size, Math.max(0, pixel.y));
      const arm = CROSSHAIR_ARM_CSS_PX * scale;
      this.strokeTwoPass(ctx, scale, () => {
        ctx.beginPath();
        ctx.moveTo(x - arm, y);
        ctx.lineTo(x + arm, y);
        ctx.moveTo(x, y - arm);
        ctx.lineTo(x, y + arm);
        ctx.stroke();
      });
      const dot = CROSSHAIR_DOT_RADIUS_CSS_PX * scale;
      ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
      ctx.beginPath();
      ctx.arc(
        x,
        y,
        dot + (MARKER_UNDERLAY_WIDTH_CSS_PX / 4) * scale,
        0,
        2 * Math.PI,
      );
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(x, y, dot, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
  }

  /** Strokes the same path twice — a wider dark underlay, then the light
   * line — so the marker reads over any palette. */
  private strokeTwoPass(
    ctx: CanvasRenderingContext2D,
    scale: number,
    stroke: () => void,
  ) {
    ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
    ctx.lineWidth = MARKER_UNDERLAY_WIDTH_CSS_PX * scale;
    stroke();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = MARKER_LINE_WIDTH_CSS_PX * scale;
    stroke();
  }
}

export default MinimapView;
