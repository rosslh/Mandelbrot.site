import * as L from "leaflet";
import throttle from "lodash/throttle";
import type MandelbrotMap from "./MandelbrotMap";
import MinimapView, { thumbnailRenderSize } from "./MinimapView";
import { fittedRangeForRender } from "./TileCache";
import { coloringOptions } from "./config";
import type { ColoringOptions } from "./protocol";

// Minimum spacing between Julia renders while the cursor moves. Each render is
// a small offscreen image on the worker pool; throttling bounds pool traffic
// while tiles are also rendering, but keeps the preview tracking the cursor
// live instead of waiting for it to stop.
const RENDER_THROTTLE_MS = 120;

// The complex-plane width of the Julia thumbnail's fixed view — [-2, 2] on
// each axis, matching JULIA_VIEW_HALF_EXTENT in mandelbrot/src/lib.rs. One
// thumbnail pixel spans JULIA_VIEW_EXTENT / size of the `c`-plane.
const JULIA_VIEW_EXTENT = 4;

// The panel's view-mode choice persists across sessions, like the
// "mandelbrot-details-state" open/closed state; it is a UI preference, so it
// stays out of share URLs.
const MODE_STORAGE_KEY = "mandelbrot-julia-panel-mode";

type PanelMode = "julia" | "minimap";

const HINTS: Record<PanelMode, string> = {
  julia: "The Julia set for the point under the cursor.",
  minimap: "Where the current view sits in the Mandelbrot set.",
};

const CANVAS_LABELS: Record<PanelMode, string> = {
  julia: "Julia set for the point under the cursor",
  minimap: "Minimap of the Mandelbrot set with the current view marked",
};

/** The Navigator panel below the controls: one square canvas with two views,
 * chosen by a persisted toggle.
 *
 * Julia mode (issue #12): a thumbnail of the filled Julia set for the
 * parameter `c` under the cursor, iterating `z -> z^exponent + c`. It follows
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
 * Minimap mode: a fixed full-set view of the Mandelbrot set with a marker
 * for the current viewport (see MinimapView) — an orientation aid that keeps
 * a deep zoom anchored to where in the set it lives. */
class NavigatorPanel {
  private map: MandelbrotMap;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private coordinatesElement: HTMLElement | null;
  private hintElement: HTMLElement | null;
  private modeSelect: HTMLSelectElement | null;
  private minimap: MinimapView;
  private mode: PanelMode;
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

  constructor(map: MandelbrotMap) {
    this.map = map;
    // The DOM keeps its historical juliaSet* ids: the details-state
    // persistence is keyed by the <details> id, so renaming would drop the
    // panel's saved open/closed state.
    this.canvas = document.getElementById(
      "juliaSetCanvas",
    ) as HTMLCanvasElement;
    this.ctx = this.canvas.getContext("2d");
    this.coordinatesElement = document.getElementById("juliaSetCoordinates");
    this.hintElement = document.getElementById("juliaSetHint");
    this.minimap = new MinimapView(map, this.canvas);
    this.mode = this.loadMode();

    this.modeSelect = document.getElementById(
      "juliaPanelMode",
    ) as HTMLSelectElement | null;
    this.modeSelect?.addEventListener("change", () =>
      this.setMode(this.modeSelect?.value === "minimap" ? "minimap" : "julia"),
    );

    // Follow the cursor over the map; leaving the map falls back to the view
    // center (the issue's requirement when the mouse is not in the window).
    // The minimap ignores the cursor, but the position is still recorded so
    // switching back to Julia resumes from it.
    map.on("mousemove", (event: L.LeafletMouseEvent) => {
      this.cursorLatLng = event.latlng;
      if (this.mode === "julia") {
        this.scheduleRender();
      }
    });
    map.on("mouseout", () => {
      this.cursorLatLng = null;
      if (this.mode === "julia") {
        this.scheduleRender();
      }
    });

    // A pan or zoom moves the fractal: the Julia thumbnail re-derives `c`
    // (which, while the cursor is off the map, is the view center); the
    // minimap only repaints its marker — its image never depends on the
    // view's position, so no worker render is scheduled.
    map.on("moveend zoomend viewreset", () => {
      if (this.mode === "julia") {
        this.scheduleRender();
      } else if (this.panelOpen()) {
        this.minimap.updateMarker();
      }
    });

    // An initial load or a resize can change the canvas's laid-out size, so
    // both modes may need a fresh render.
    map.on("load resize", () => {
      if (this.mode === "julia") {
        this.scheduleRender();
      } else if (this.panelOpen()) {
        this.minimap.refresh();
      }
    });

    // Rendering only when the panel is open avoids pool traffic for a
    // collapsed panel; opening it renders immediately.
    const panel = document.getElementById("juliaSet");
    panel?.addEventListener("toggle", () => this.renderCurrentMode());

    this.applyModeUi();
    this.renderCurrentMode();
  }

  /** Re-renders the active view with the current settings. Called after a
   * palette, color, or iteration change (which both views read at render
   * time) so the panel keeps matching the fractal on screen. The minimap
   * fingerprints its settings, so the palette-window refits the tile layer
   * performs on every pan at depth fall through as repaint-only no-ops. */
  refresh() {
    if (this.mode === "julia") {
      this.scheduleRender();
    } else if (this.panelOpen()) {
      this.minimap.refresh();
    }
  }

  private loadMode(): PanelMode {
    return localStorage.getItem(MODE_STORAGE_KEY) === "minimap"
      ? "minimap"
      : "julia";
  }

  private setMode(mode: PanelMode) {
    if (mode === this.mode) {
      return;
    }
    this.mode = mode;
    localStorage.setItem(MODE_STORAGE_KEY, mode);
    // The next Julia render must repaint even if `c` is unchanged: the
    // minimap has drawn over the shared canvas in the meantime.
    this.lastRender = null;
    this.applyModeUi();
    this.renderCurrentMode();
  }

  /** Reflects the active mode in the view select, hint, coordinates
   * readout, and canvas label. */
  private applyModeUi() {
    if (this.modeSelect) {
      this.modeSelect.value = this.mode;
    }
    if (this.hintElement) {
      this.hintElement.textContent = HINTS[this.mode];
    }
    this.canvas.setAttribute("aria-label", CANVAS_LABELS[this.mode]);
    if (this.mode === "minimap" && this.coordinatesElement) {
      // The `c = …` readout is a Julia concept; the line keeps its reserved
      // height (see styles) so the thumbnail doesn't jump between modes.
      this.coordinatesElement.textContent = "";
    }
  }

  /** Renders the active view, if the panel is open. */
  private renderCurrentMode() {
    if (!this.panelOpen()) {
      return;
    }
    if (this.mode === "julia") {
      this.scheduleRender();
    } else {
      this.minimap.activate();
    }
  }

  /** Whether the panel's <details> is open; nothing renders while it is
   * collapsed (it renders on reopen). */
  private panelOpen(): boolean {
    const panel = document.getElementById(
      "juliaSet",
    ) as HTMLDetailsElement | null;
    return !panel || panel.open;
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
    if (this.mode !== "julia" || !this.panelOpen() || !this.ctx) {
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
    if (!this.coordinatesElement) {
      return;
    }
    const sign = im < 0 ? "−" : "+";
    const reText = re.toPrecision(4);
    const imText = Math.abs(im).toPrecision(4);
    this.coordinatesElement.textContent = `c = ${reText} ${sign} ${imText}i`;
  }
}

export default NavigatorPanel;
