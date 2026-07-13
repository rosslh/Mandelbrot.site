import type MandelbrotMap from "./MandelbrotMap";
import { coloringOptions } from "./config";
import {
  CalculateRequest,
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
