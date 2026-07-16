import * as L from "leaflet";
import debounce from "lodash/debounce";
import type MandelbrotMap from "./MandelbrotMap";

// Side length of the square Julia thumbnail, in device pixels. Small enough to
// render on the worker pool between tiles without contending with the visible
// layer, large enough to read the set's shape. The <canvas> is sized to this
// and scaled to fit the sidebar column by CSS.
const THUMBNAIL_SIZE = 200;

// Minimum spacing between Julia renders while the cursor moves. Each render is
// a small offscreen image on the worker pool; this bounds pool traffic while
// tiles are also rendering, and reads a steady preview rather than one that
// churns on every pixel of cursor movement.
const RENDER_DEBOUNCE_MS = 120;

/** The Julia set panel below the controls (issue #12): a thumbnail of the
 * filled Julia set for the parameter `c` under the cursor, iterating
 * `z -> z^exponent + c`. It follows the cursor over the map; when the cursor
 * leaves the map it falls back to the center of the visible region, so the
 * panel always shows something meaningful. The thumbnail uses the map's current
 * palette and appearance settings so it matches the fractal on screen.
 *
 * Renders through the same worker pool as the tile layer (a dedicated wasm
 * entrypoint, `render_julia`), debounced so cursor movement does not flood the
 * pool. */
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

  constructor(map: MandelbrotMap) {
    this.map = map;
    this.canvas = document.getElementById(
      "juliaSetCanvas",
    ) as HTMLCanvasElement;
    this.canvas.width = THUMBNAIL_SIZE;
    this.canvas.height = THUMBNAIL_SIZE;
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

  /** The parameter `c` to visualize: the cursor's complex coordinate while it
   * is over the map, or the center of the visible region otherwise. */
  private parameterC(): { re: number; im: number } {
    const latLng = this.cursorLatLng ?? this.map.getCenter();
    return this.map.complexAtLatLngFloat(latLng);
  }

  /** Renders the Julia thumbnail unless the panel is collapsed. Debounced so
   * cursor movement (and rapid view changes) coalesce into one render. */
  private scheduleRender = debounce(() => {
    void this.render();
  }, RENDER_DEBOUNCE_MS);

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

    const id = ++this.renderId;
    try {
      const image = await this.map.regionRenderer.renderJulia(
        re,
        im,
        THUMBNAIL_SIZE,
      );
      // A newer render (or a pool re-creation that resolved out of order)
      // supersedes this one.
      if (id !== this.renderId || !this.ctx) {
        return;
      }
      const imageData = new ImageData(
        Uint8ClampedArray.from(image),
        THUMBNAIL_SIZE,
        THUMBNAIL_SIZE,
      );
      this.ctx.putImageData(imageData, 0, 0);
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
