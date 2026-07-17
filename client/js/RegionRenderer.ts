import type MandelbrotMap from "./MandelbrotMap";
import type { TilePosition } from "./MandelbrotMap";
import { coloringOptions } from "./config";
import {
  CalculateRequest,
  ColoringOptions,
  DistanceEstimateRequest,
  DistanceEstimateResponse,
  JuliaRequest,
  MandelbrotResponse,
  PeriodRequest,
  PeriodResponse,
  RecolorRequest,
  RecolorResponse,
  TileRect,
  TileRenderPayload,
} from "./protocol";

/** Renders regions of the current view through the worker pool — the shared
 * engine behind the visible tile layer and offscreen work (image export;
 * eventually zoom-animation frames and Julia previews). It reads the origin,
 * zoom offset, config, and pool from the map at call time, so it stays valid
 * across pool re-creation. */
class RegionRenderer {
  private map: MandelbrotMap;

  constructor(map: MandelbrotMap) {
    this.map = map;
  }

  /** Snapshots the current render parameters for the given region. Taken at
   * build time rather than when the pool gets to the task: auto palette
   * adjustment mutates the config as background tiles finish, and an export
   * whose columns straddle such a refit comes out with two different color
   * mappings. */
  buildPayload(
    bounds: TileRect,
    imageWidth: number,
    imageHeight: number,
    includeValues: boolean,
  ): TileRenderPayload {
    return {
      includeValues,
      originRe: this.map.origin.re,
      originIm: this.map.origin.im,
      bounds,
      zoomOffset: this.map.zoomOffset,
      iterations: this.map.config.iterations,
      exponent: this.map.config.exponent,
      imageWidth,
      imageHeight,
      smoothColoring: this.map.config.smoothColoring,
      coloring: coloringOptions(this.map.config),
    };
  }

  /** The escape iteration count at a single point, computed as a one-pixel
   * render (so it uses the same kernels — and matches the same pixels — as
   * the visible tiles at any zoom depth). Returns null when the point does
   * not escape within the current iteration cap. The bounds span one screen
   * pixel so the direct/perturbation tier choice matches the tile layer's. */
  async escapeIterationsAtPoint(
    position: TilePosition,
    zoom: number,
  ): Promise<number | null> {
    const pixelSpan = 1 / this.map.mandelbrotLayer.getTileSize().x;
    const bounds: TileRect = {
      xMin: position.x,
      xMax: position.x + pixelSpan,
      yMin: position.y,
      yMax: position.y + pixelSpan,
      zoom,
    };

    const request: CalculateRequest = {
      type: "calculate",
      payload: this.buildPayload(bounds, 1, 1, false),
    };

    const response = (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as MandelbrotResponse;

    return response.maxIter;
  }

  /** The exterior distance estimate from a single point to the boundary of
   * the set, in complex-plane units, via a dedicated scalar wasm loop that
   * tracks the orbit derivative (issue #42). Returns null when the point is
   * inside the set (or the estimate is otherwise unavailable), which the wasm
   * signals with a negative value. Reads the same origin, zoom offset, and
   * config as a tile render, so its point matches the tile layer's pixels. */
  async distanceToBoundaryAtPoint(
    position: TilePosition,
    zoom: number,
  ): Promise<number | null> {
    const request: DistanceEstimateRequest = {
      type: "distanceEstimate",
      payload: {
        originRe: this.map.origin.re,
        originIm: this.map.origin.im,
        tileX: position.x,
        tileY: position.y,
        tileZoom: zoom,
        zoomOffset: this.map.zoomOffset,
        iterations: this.map.config.iterations,
        exponent: this.map.config.exponent,
      },
    };

    const distance = (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as DistanceEstimateResponse;

    return distance < 0 ? null : distance;
  }

  /** The period of the attracting cycle at a single point, via a dedicated
   * scalar wasm loop that settles the orbit onto its cycle and measures the
   * cycle length (issue #39). Returns null when the point is not in the set
   * (or no cycle could be resolved), which the wasm signals with 0. The main
   * cardioid is period 1, the period-2 bulb period 2, a minibrot's cardioid
   * its own higher period. Only the quadratic set has a period readout, so the
   * wasm reports 0 for other exponents. Reads the same origin, zoom offset, and
   * config as a tile render, so its point matches the tile layer's pixels. */
  async periodAtPoint(
    position: TilePosition,
    zoom: number,
  ): Promise<number | null> {
    const request: PeriodRequest = {
      type: "period",
      payload: {
        originRe: this.map.origin.re,
        originIm: this.map.origin.im,
        tileX: position.x,
        tileY: position.y,
        tileZoom: zoom,
        zoomOffset: this.map.zoomOffset,
        iterations: this.map.config.iterations,
        exponent: this.map.config.exponent,
      },
    };

    const period = (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as PeriodResponse;

    return period > 0 ? period : null;
  }

  /** Renders a Julia set thumbnail for the parameter `c = (cRe, cIm)` under
   * the cursor (issue #12), as RGBA bytes for a `size x size` image. Uses the
   * map's current palette, iteration cap, exponent, and appearance settings —
   * read at call time, like the tile renderer — so the preview matches the
   * fractal on screen. `c` is an ordinary f64: Julia sets live within `|c| < 2`,
   * far inside f64 precision, so the cursor's deep-zoom sub-pixel precision is
   * not needed for the parameter. */
  async renderJulia(
    cRe: number,
    cIm: number,
    size: number,
  ): Promise<Uint8Array> {
    const request: JuliaRequest = {
      type: "julia",
      payload: {
        cRe,
        cIm,
        iterations: this.map.config.iterations,
        exponent: this.map.config.exponent,
        imageWidth: size,
        imageHeight: size,
        smoothColoring: this.map.config.smoothColoring,
        coloring: coloringOptions(this.map.config),
      },
    };

    const response = (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as MandelbrotResponse;

    return response.image;
  }

  /** Renders the region and returns the full worker response: the RGBA
   * image, the escaped-pixel iteration range, the precision tier, and (when
   * `includeValues` is set) the per-pixel smoothed escape values that
   * recoloring consumes. */
  async renderRegion(
    bounds: TileRect,
    imageWidth: number,
    imageHeight: number,
    includeValues: boolean,
  ): Promise<MandelbrotResponse> {
    const request: CalculateRequest = {
      type: "calculate",
      payload: this.buildPayload(
        bounds,
        imageWidth,
        imageHeight,
        includeValues,
      ),
    };

    return (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as MandelbrotResponse;
  }

  /** Re-applies a palette to previously rendered escape values, returning the
   * new RGBA bytes — the same worker path the tile layer uses to recolor
   * cached tiles without re-rendering. */
  async recolor(
    values: Float32Array,
    coloring: ColoringOptions,
  ): Promise<Uint8Array> {
    const request: RecolorRequest = {
      type: "recolor",
      payload: { values, coloring },
    };

    return (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as RecolorResponse;
  }

  /** Renders the region and returns only its per-pixel smoothed escape values
   * (row-major, `imageHeight * imageWidth` floats; `Infinity` for interior
   * pixels), skipping the colorized image. Used by the raw-data export, which
   * needs the numbers the tile layer normally caches for recoloring rather
   * than the RGBA bytes. */
  async renderValues(
    bounds: TileRect,
    imageWidth: number,
    imageHeight: number,
  ): Promise<Float32Array> {
    const response = await this.renderRegion(
      bounds,
      imageWidth,
      imageHeight,
      true,
    );

    if (!response.values) {
      throw new Error("Render did not return escape values");
    }

    return response.values;
  }

  /** Renders the region to an offscreen canvas (no escape values, no tile
   * cache entry — pure pixels for export-style consumers). */
  async renderToCanvas(
    bounds: TileRect,
    imageWidth: number,
    imageHeight: number,
  ): Promise<HTMLCanvasElement> {
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");

    if (!context) {
      throw new Error("Failed to get canvas context");
    }

    canvas.width = imageWidth;
    canvas.height = imageHeight;

    const response = await this.renderRegion(
      bounds,
      imageWidth,
      imageHeight,
      false,
    );

    const imageData = new ImageData(
      Uint8ClampedArray.from(response.image),
      imageWidth,
      imageHeight,
    );
    context.putImageData(imageData, 0, 0);

    return canvas;
  }
}

export default RegionRenderer;
