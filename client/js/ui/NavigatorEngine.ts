import * as L from "leaflet";
import throttle from "lodash/throttle";
import type MandelbrotMap from "../MandelbrotMap";
import MinimapView, { thumbnailRenderSize } from "../MinimapView";
import { fittedCdfForRender, fittedRangeForRender } from "../TileCache";
import { renderSettingsFingerprint, standaloneColoring } from "../config";
import type { ColoringOptions } from "../protocol";
import type { NavigatorMode } from "../state/uiState";

// Minimum spacing between Julia renders while the cursor moves. Each render is
// a small offscreen image on the worker pool; throttling bounds pool traffic
// while tiles are also rendering, but keeps the preview tracking the cursor
// live instead of waiting for it to stop.
const RENDER_THROTTLE_MS = 120;

// The complex-plane width of the Julia thumbnail's fixed view — [-2, 2] on
// each axis, matching JULIA_VIEW_HALF_EXTENT in mandelbrot/src/lib.rs. One
// thumbnail pixel spans JULIA_VIEW_EXTENT / size of the `c`-plane.
const JULIA_VIEW_EXTENT = 4;

export const NAVIGATOR_HINTS: Record<NavigatorMode, string> = {
  julia: "The Julia set for the point under the cursor.",
  minimap: "Where the current view sits in the Mandelbrot set.",
};

export const NAVIGATOR_CANVAS_LABELS: Record<NavigatorMode, string> = {
  julia: "Julia set for the point under the cursor",
  minimap: "Minimap of the Mandelbrot set with the current view marked",
};

export type NavigatorEngineOptions = {
  canvas: HTMLCanvasElement;
  // The active view mode; owned by the NavigatorPanel component (persisted
  // via uiState), read at render time.
  getMode: () => NavigatorMode;
  // Whether the panel's <details> is open; nothing renders while it is
  // collapsed (the component calls renderCurrentMode on reopen).
  isPanelOpen: () => boolean;
  // Reports the Julia parameter readout ("c = …"), or "" in minimap mode.
  onCoordinates: (text: string) => void;
};

/** The engine behind the Navigator panel: one square canvas with two views.
 *
 * Julia mode (issue #12): a thumbnail of the filled Julia set for the
 * parameter `c` under the cursor, iterating `z -> z^power + c`. It follows
 * the cursor over the map; when the cursor leaves the map it falls back to
 * the center of the visible region, so the panel always shows something
 * meaningful. Renders through the same worker pool as the tile layer (a
 * dedicated wasm entrypoint, `render_julia`), throttled so cursor movement
 * does not flood the pool — and skipped entirely when `c` did not move enough
 * to change the image, which is every cursor move once the view is deeply
 * zoomed. The thumbnail runs its own palette auto-adjust, refitting the
 * window to its own iteration range on every render (see thumbnailColoring):
 * the map's window — auto-fit or manual — describes the view's iteration
 * counts, not the Julia set's.
 *
 * Minimap mode (the default): a fixed full-set view of the Mandelbrot set
 * with a marker for the current viewport (see MinimapView) — an orientation
 * aid that keeps a deep zoom anchored to where in the set it lives.
 *
 * The NavigatorPanel component owns the markup (mode select, hint,
 * coordinates line) and this engine's lifecycle; worker renders, cursor
 * tracking, and canvas painting live here. */
class NavigatorEngine {
  private map: MandelbrotMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private options: NavigatorEngineOptions;
  private minimap: MinimapView;
  // The cursor's latLng while it is over the map, or null when it is off the
  // map (in which case the view center stands in for `c`). Tracked in both
  // modes so switching back to Julia resumes from the cursor's position.
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

  constructor(map: MandelbrotMap, options: NavigatorEngineOptions) {
    this.map = map;
    this.canvas = options.canvas;
    this.ctx = this.canvas.getContext("2d");
    this.options = options;
    this.minimap = new MinimapView(map, this.canvas);

    // Follow the cursor over the map; leaving the map falls back to the view
    // center (the issue's requirement when the mouse is not in the window).
    // The minimap ignores the cursor, but the position is still recorded so
    // switching back to Julia resumes from it.
    map.on("mousemove", this.handleMouseMove);
    map.on("mouseout", this.handleMouseOut);

    // A pan or zoom moves the fractal: the Julia thumbnail re-derives `c`
    // (which, while the cursor is off the map, is the view center); the
    // minimap only repaints its marker — its image never depends on the
    // view's position, so no worker render is scheduled. An initial load or
    // a resize can change the canvas's laid-out size, so both modes may need
    // a fresh render there.
    map.on("moveend zoomend viewreset load resize", this.handleViewChange);

    // The panel may be constructed before the map's initial view exists, and
    // a Julia render reads the view center (the cursor's off-map fallback) —
    // getCenter() throws until the view exists. whenReady defers the first
    // render to the initial view; later renders are event-driven.
    map.whenReady(() => this.renderCurrentMode());
  }

  /** Detaches the map listeners (component unmount). */
  destroy() {
    this.map.off("mousemove", this.handleMouseMove);
    this.map.off("mouseout", this.handleMouseOut);
    this.map.off(
      "moveend zoomend viewreset load resize",
      this.handleViewChange,
    );
  }

  private handleMouseMove = (event: L.LeafletMouseEvent) => {
    this.cursorLatLng = event.latlng;
    if (this.mode === "julia") {
      this.scheduleRender();
    }
  };

  private handleMouseOut = () => {
    this.cursorLatLng = null;
    if (this.mode === "julia") {
      this.scheduleRender();
    }
  };

  private handleViewChange = () => {
    if (this.mode === "julia") {
      this.scheduleRender();
    } else if (this.options.isPanelOpen()) {
      this.minimap.refresh();
    }
  };

  private get mode(): NavigatorMode {
    return this.options.getMode();
  }

  /** Re-renders the active view with the current settings. Called after a
   * palette, color, or iteration change (which both views read at render
   * time) so the panel keeps matching the fractal on screen. The minimap
   * fingerprints its settings, so the palette-window refits the tile layer
   * performs on every pan at depth fall through as repaint-only no-ops. */
  refresh() {
    if (this.mode === "julia") {
      this.scheduleRender();
    } else if (this.options.isPanelOpen()) {
      this.minimap.refresh();
    }
  }

  /** Applies a view-mode switch: the next Julia render must repaint even if
   * `c` is unchanged (the minimap has drawn over the shared canvas in the
   * meantime), and the `c = …` readout is a Julia concept, cleared in
   * minimap mode (the line keeps its reserved height so the thumbnail
   * doesn't jump between modes). */
  handleModeChanged() {
    this.lastRender = null;
    if (this.mode === "minimap") {
      this.options.onCoordinates("");
    }
    this.renderCurrentMode();
  }

  /** Renders the active view, if the panel is open. */
  renderCurrentMode() {
    if (!this.options.isPanelOpen()) {
      return;
    }
    if (this.mode === "julia") {
      this.scheduleRender();
    } else {
      this.minimap.refresh();
    }
  }

  /** The parameter `c` to visualize: the cursor's complex coordinate while it
   * is over the map, or the center of the visible region otherwise. */
  private parameterC(): { re: number; im: number } {
    const latLng = this.cursorLatLng ?? this.map.getCenter();
    return this.map.complexAtLatLngFloat(latLng);
  }

  /** The coloring options the thumbnail's render and recolor use: the
   * standalone profile with the thumbnail's own fit (see standaloneColoring
   * in config.ts). The thumbnail runs its own auto-adjust, fitting the
   * window to its own iteration range on every render — the map's window
   * describes the viewport's iteration counts, which at depth dwarf the
   * Julia set's shallow ones. The normalized modes (distance-estimate,
   * atom-domain) are view techniques the escape-time thumbnail does not
   * share, so their flags are dropped. */
  private thumbnailColoring(
    paletteCdf: Float32Array | null = null,
    window?: { min: number; max: number },
  ): ColoringOptions {
    return standaloneColoring(this.map.config, { paletteCdf, window });
  }

  /** Fingerprint of every setting that affects the thumbnail's pixels, so
   * render() can tell a settings change from a cursor move. */
  private settingsKey(): string {
    return renderSettingsFingerprint(this.map.config, this.thumbnailColoring());
  }

  /** Renders the Julia thumbnail unless the panel is collapsed. Throttled so
   * cursor movement updates the preview live without flooding the pool. */
  private scheduleRender = throttle(() => {
    void this.render();
  }, RENDER_THROTTLE_MS);

  private async render() {
    if (this.mode !== "julia" || !this.options.isPanelOpen() || !this.ctx) {
      return;
    }

    const { re, im } = this.parameterC();
    this.showCoordinates(re, im);

    const size = thumbnailRenderSize(this.canvas);
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
      // config-palette image is the nominal fallback. At any nonzero
      // color-mapping strength the thumbnail likewise builds its own
      // equalization CDF from this render's values over the fitted window —
      // the map's viewport-global table describes the view's distribution,
      // not the Julia set's.
      let image = response.image;
      const range = fittedRangeForRender(response, size, size);
      if (range && response.values) {
        const cdf = fittedCdfForRender(
          response,
          size,
          size,
          range,
          this.map.config.histogramColoring / 100,
        );
        image = await this.map.regionRenderer.recolor(
          response.values,
          this.thumbnailColoring(cdf, range),
        );
      }
      // A newer render (or a pool re-creation that resolved out of order)
      // supersedes this one — as does a switch to the minimap, which now
      // owns the canvas.
      if (id !== this.renderId || this.mode !== "julia" || !this.ctx) {
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
    const sign = im < 0 ? "−" : "+";
    const reText = re.toPrecision(4);
    const imText = Math.abs(im).toPrecision(4);
    this.options.onCoordinates(`c = ${reText} ${sign} ${imText}i`);
  }
}

export default NavigatorEngine;
