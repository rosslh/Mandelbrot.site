import type MandelbrotMap from "./MandelbrotMap";
import type { TilePosition } from "./MandelbrotMap";
import { coloringOptions } from "./config";
import {
  CalculateRequest,
  DistanceEstimateRequest,
  DistanceEstimateResponse,
  MandelbrotResponse,
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
    const request: CalculateRequest = {
      type: "calculate",
      payload: this.buildPayload(bounds, imageWidth, imageHeight, true),
    };

    const response = (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as MandelbrotResponse;

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

    const request: CalculateRequest = {
      type: "calculate",
      payload: this.buildPayload(bounds, imageWidth, imageHeight, false),
    };

    const response = (await this.map.pool.queue((workerTask) =>
      workerTask(request),
    )) as MandelbrotResponse;

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
