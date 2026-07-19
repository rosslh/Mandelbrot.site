import * as L from "leaflet";
import throttle from "lodash/throttle";
import type MandelbrotMap from "./MandelbrotMap";
import { fittedRangeForRender } from "./TileCache";
import { coloringOptions } from "./config";
import type { ColoringOptions } from "./protocol";

// The thumbnail renders at its laid-out CSS size times the display's
// devicePixelRatio (like the tile layer's high-resolution mode), so it is
// pixel-sharp on high-DPI screens. This is the fallback CSS side length for
// the moment before the panel has a layout to measure.
const THUMBNAIL_FALLBACK_CSS_PX = 200;

// Upper bound on the backing-store side length, so an extreme
// devicePixelRatio cannot turn each cursor move into a heavyweight render on
// the worker pool the tile layer is also using.
const THUMBNAIL_MAX_DEVICE_PX = 800;

// Minimum spacing between Julia renders while the cursor moves. Each render is
// a small offscreen image on the worker pool; throttling bounds pool traffic
// while tiles are also rendering, but keeps the preview tracking the cursor
// live instead of waiting for it to stop.
const RENDER_THROTTLE_MS = 120;

// The complex-plane width of the thumbnail's fixed view — [-2, 2] on each
// axis, matching JULIA_VIEW_HALF_EXTENT in mandelbrot/src/lib.rs. One
// thumbnail pixel spans JULIA_VIEW_EXTENT / size of the `c`-plane.
const JULIA_VIEW_EXTENT = 4;

/** The Julia set panel below the controls (issue #12): a thumbnail of the
 * filled Julia set for the parameter `c` under the cursor, iterating
 * `z -> z^exponent + c`. It follows the cursor over the map; when the cursor
 * leaves the map it falls back to the center of the visible region, so the
 * panel always shows something meaningful. The thumbnail uses the map's current
 * palette and appearance settings so it matches the fractal on screen.
 *
 * Renders through the same worker pool as the tile layer (a dedicated wasm
 * entrypoint, `render_julia`), throttled so cursor movement does not flood the
 * pool — and skipped entirely when `c` did not move enough to change the
 * image, which is every cursor move once the view is deeply zoomed. The
 * thumbnail runs its own palette auto-adjust, refitting the window to its own
 * iteration range on every render (see thumbnailColoring): the map's window —
 * auto-fit or manual — describes the view's iteration counts, not the Julia
 * set's. */
class JuliaPanel {
  private map: MandelbrotMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private coordinatesElement: HTMLElement | null;
  // The cursor's latLng while it is over the map, or null when it is off the
  // map (in which case the view center stands in for `c`).
  private cursorLatLng: L.LatLng | null = null;
  // Increments per render so a stale in-flight result cannot paint over a
  // newer one that resolved first.
  private renderId = 0;
  // What the last painted thumbnail showed, so render() can skip work when
  // nothing perceptible changed. Zoomed in, the whole viewport spans a tiny
  // window of the `c`-plane, so cursor movement sweeps `c` across distances
  // far below what the thumbnail can resolve — without this, every cursor
  // move at depth cost a render for a pixel-identical image.
  private lastRender: {
    re: number;
    im: number;
    size: number;
    settingsKey: string;
  } | null = null;

  constructor(map: MandelbrotMap) {
    this.map = map;
    this.canvas = document.getElementById(
      "juliaSetCanvas",
    ) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d");
    this.coordinatesElement = document.getElementById("juliaSetCoordinates");

    // Follow the cursor over the map; leaving the map falls back to the view
    // center (the issue's requirement when the mouse is not in the window).
    map.on("mousemove", (event: L.LeafletMouseEvent) => {
      this.cursorLatLng = event.latlng;
      this.scheduleRender();
    });
    map.on("mouseout", () => {
      this.cursorLatLng = null;
      this.scheduleRender();
    });

    // A pan or zoom moves the fractal (and, while the cursor is off the map,
    // the center that stands in for `c`); an initial load and resize likewise
    // need a first render. All of these re-derive `c` and repaint.
    map.on("moveend zoomend viewreset load resize", () =>
      this.scheduleRender(),
    );

    // Re-rendering only when the panel is open avoids pool traffic for a
    // collapsed panel; opening it renders immediately.
    const panel = document.getElementById("juliaSet");
    panel?.addEventListener("toggle", () => this.scheduleRender());

    this.scheduleRender();
  }

  /** Re-renders the thumbnail with the current settings. Called after a
   * palette, color, or iteration change (which the panel reads at render time)
   * so the preview keeps matching the fractal on screen. */
  refresh() {
    this.scheduleRender();
  }

  /** The thumbnail's device-pixel side length: the laid-out CSS size scaled
   * by the display's devicePixelRatio (the same DPI detection the tile
   * layer's high-resolution mode uses), bounded above so extreme ratios stay
   * cheap. Falls back to a nominal size before the panel has a layout. */
  private thumbnailSize(): number {
    const dpr = window.devicePixelRatio || 1;
    const cssSize = this.canvas.clientWidth || THUMBNAIL_FALLBACK_CSS_PX;
    return Math.min(
      THUMBNAIL_MAX_DEVICE_PX,
      Math.max(1, Math.round(cssSize * dpr)),
    );
  }

  /** The parameter `c` to visualize: the cursor's complex coordinate while it
   * is over the map, or the center of the visible region otherwise. */
  private parameterC(): { re: number; im: number } {
    const latLng = this.cursorLatLng ?? this.map.getCenter();
    return this.map.complexAtLatLngFloat(latLng);
  }

  /** The coloring options the thumbnail's recolor pass uses: the map's
   * appearance settings, minus everything tied to the map's view. The palette
   * window is a placeholder — the thumbnail runs its own auto-adjust, fitting
   * the window to its own iteration range on every render (the map's window
   * describes the viewport's iteration counts, which at depth dwarf the Julia
   * set's shallow ones and would clamp the whole thumbnail to one end of the
   * gradient; that holds for the auto-fit and manual windows alike). The
   * normalized modes (distance-estimate, atom-domain) are view techniques the
   * escape-time thumbnail does not share, so their flags are dropped too. */
  private thumbnailColoring(): ColoringOptions {
    return {
      ...coloringOptions(this.map.config),
      paletteMinIter: 0,
      paletteMaxIter: 0,
      distanceEstimate: false,
      atomDomain: false,
    };
  }

  /** Fingerprint of every setting that affects the thumbnail's pixels, so
   * render() can tell a settings change from a cursor move. Built from
   * thumbnailColoring, so the settings the thumbnail ignores — above all the
   * palette window, which the tile layer refits on every pan and zoom at
   * depth — do not force renders that would repaint the same image. */
  private settingsKey(): string {
    const config = this.map.config;
    return JSON.stringify({
      coloring: this.thumbnailColoring(),
      iterations: config.iterations,
      exponent: config.exponent,
      smoothColoring: config.smoothColoring,
    });
  }

  /** Renders the Julia thumbnail unless the panel is collapsed. Throttled so
   * cursor movement updates the preview live without flooding the pool. */
  private scheduleRender = throttle(() => {
    void this.render();
  }, RENDER_THROTTLE_MS);

  private async render() {
    const panel = document.getElementById(
      "juliaSet",
    ) as HTMLDetailsElement | null;
    // Nothing to draw while the panel is collapsed; it renders on reopen.
    if (panel && !panel.open) {
      return;
    }
    if (!this.ctx) {
      return;
    }

    const { re, im } = this.parameterC();
    this.showCoordinates(re, im);

    const size = this.thumbnailSize();
    const settingsKey = this.settingsKey();
    // Skip the render when `c` moved less than 1/256 of a thumbnail pixel
    // and nothing else changed: no feature of the set can shift visibly for a
    // change that far below the pixel grid, so the image would be
    // indistinguishable. Deliberately ultra-conservative — the payoff is at
    // depth, where the whole viewport spans many orders of magnitude less
    // than even this, so cursor tracking stops costing renders entirely; it
    // also deduplicates the mousemove/moveend/zoomend triggers that land on
    // the same `c`.
    const last = this.lastRender;
    const cEpsilon = JULIA_VIEW_EXTENT / size / 256;
    if (
      last &&
      last.size === size &&
      last.settingsKey === settingsKey &&
      Math.hypot(re - last.re, im - last.im) < cEpsilon
    ) {
      return;
    }

    const id = ++this.renderId;
    try {
      const response = await this.map.regionRenderer.renderJulia(
        re,
        im,
        size,
        true,
      );
      // The thumbnail's own auto-adjust: fit the palette window to this
      // render's iteration range (the same center-weighted percentile fit
      // the tile layer applies to the view) and recolor to it. The fit can
      // only miss for an all-interior render, which a Julia thumbnail never
      // is (its [-2, 2] frame always includes escaping exterior); the plain
      // config-palette image is the nominal fallback.
      let image = response.image;
      const range = fittedRangeForRender(response, size, size);
      if (range && response.values) {
        image = await this.map.regionRenderer.recolor(response.values, {
          ...this.thumbnailColoring(),
          paletteMinIter: range.min,
          paletteMaxIter: range.max,
        });
      }
      // A newer render (or a pool re-creation that resolved out of order)
      // supersedes this one.
      if (id !== this.renderId || !this.ctx) {
        return;
      }
      // Size the backing store to the render (setting it also clears the
      // canvas, so only on change); CSS keeps the displayed size.
      if (this.canvas.width !== size || this.canvas.height !== size) {
        this.canvas.width = size;
        this.canvas.height = size;
      }
      const imageData = new ImageData(
        Uint8ClampedArray.from(image),
        size,
        size,
      );
      this.ctx.putImageData(imageData, 0, 0);
      this.lastRender = { re, im, size, settingsKey };
    } catch {
      // The pool was terminated by a re-render; the next scheduled render
      // retries against the fresh pool.
    }
  }

  /** Shows the parameter `c` beneath the thumbnail, e.g. "c = -0.4 + 0.6i". */
  private showCoordinates(re: number, im: number) {
    if (!this.coordinatesElement) {
      return;
    }
    const sign = im < 0 ? "−" : "+";
    const reText = re.toPrecision(4);
    const imText = Math.abs(im).toPrecision(4);
    this.coordinatesElement.textContent = `c = ${reText} ${sign} ${imText}i`;
  }
}

export default JuliaPanel;
