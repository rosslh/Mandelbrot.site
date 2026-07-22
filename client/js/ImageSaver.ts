import { saveAs } from "file-saver";
import type MandelbrotMap from "./MandelbrotMap";
import { buildShareParams } from "./config";
import { embedTextChunks } from "./pngMetadata";
import { buildZip, encodeNpyFloat32 } from "./dataExport";
import { OptimiseRequest, OptimiseResponse, TileRect } from "./protocol";

class ImageSaver {
  private map: MandelbrotMap;

  constructor(map: MandelbrotMap) {
    this.map = map;
  }

  async saveVisibleImage(
    totalWidth: number,
    totalHeight: number,
    optimize: boolean,
    onStartOptimizing?: () => void,
  ) {
    const bounds = this.adjustBoundsForAspectRatio(
      this.map.mapBoundsInTileSpace,
      totalWidth,
      totalHeight,
    );
    const imageCanvases = await this.generateImageColumns(
      bounds,
      totalWidth,
      totalHeight,
    );
    const finalCanvas = this.combineImageColumns(
      imageCanvases,
      totalWidth,
      totalHeight,
    );
    await this.saveCanvasAsImage(finalCanvas, optimize, onStartOptimizing);
  }

  /** Exports the current view's per-pixel escape values (issue #47) as a ZIP
   * bundling a NumPy `.npy` float32 array and a JSON sidecar of the view
   * parameters, so researchers get the raw numbers alongside the rasterized
   * PNG. The value at row `y`, column `x` is the smoothed escape value used
   * for coloring (or the raw iteration count when smooth coloring is off);
   * interior pixels are `Infinity`. Reuses the image export's column layout
   * and bounds handling so the data matches what a PNG of the same view would
   * show. */
  async saveVisibleData(totalWidth: number, totalHeight: number) {
    const bounds = this.adjustBoundsForAspectRatio(
      this.map.mapBoundsInTileSpace,
      totalWidth,
      totalHeight,
    );

    const columns = this.columnLayout(bounds, totalWidth);
    const columnValues = await Promise.all(
      columns.map((column) =>
        this.map.regionRenderer.renderValues(
          column.subBounds,
          column.width,
          totalHeight,
        ),
      ),
    );

    // Stitch the per-column row-major buffers into one row-major
    // `totalHeight x totalWidth` array.
    const values = new Float32Array(totalWidth * totalHeight);
    columns.forEach((column, i) => {
      const columnBuffer = columnValues[i];
      for (let y = 0; y < totalHeight; y++) {
        const source = columnBuffer.subarray(
          y * column.width,
          (y + 1) * column.width,
        );
        values.set(source, y * totalWidth + column.xOffset);
      }
    });

    const npy = encodeNpyFloat32(values, totalHeight, totalWidth);
    const metadata = {
      software: "Mandelbrot.site",
      url: this.map.getShareUrl(),
      params: buildShareParams(this.map.config),
      width: totalWidth,
      height: totalHeight,
      smoothColoring: this.map.config.smoothColoring,
      // What each value means, so the file is self-describing without the app.
      valueDescription: this.map.config.smoothColoring
        ? "Smoothed escape value (fractional iteration count); Infinity for interior pixels."
        : "Raw escape iteration count; Infinity for interior pixels.",
      layout: "Row-major float32, shape (height, width), indexed as [y][x].",
    };
    const metadataBytes = new TextEncoder().encode(
      JSON.stringify(metadata, null, 2),
    );

    const zip = buildZip([
      { name: "data.npy", data: npy },
      { name: "metadata.json", data: metadataBytes },
    ]);

    const blob = new Blob([zip], { type: "application/zip" });

    // Deep-zoom coordinates can be hundreds of digits; keep filenames sane.
    const truncate = (value: string) =>
      value.length > 24 ? value.slice(0, 24) : value;

    saveAs(
      blob,
      `mandelbrot${Date.now()}_r${truncate(this.map.config.re)}_im${truncate(
        this.map.config.im,
      )}_z${this.map.config.zoom}_data.zip`,
    );
  }

  private adjustBoundsForAspectRatio(
    bounds: TileRect,
    totalWidth: number,
    totalHeight: number,
  ): TileRect {
    const imageAspectRatio = totalWidth / totalHeight;
    const boundsAspectRatio =
      (bounds.xMax - bounds.xMin) / (bounds.yMax - bounds.yMin);

    const adjustedBounds = { ...bounds };

    if (imageAspectRatio < boundsAspectRatio) {
      const newHeight = (bounds.xMax - bounds.xMin) / imageAspectRatio;
      const yCenter = (bounds.yMin + bounds.yMax) / 2;
      adjustedBounds.yMin = yCenter - newHeight / 2;
      adjustedBounds.yMax = yCenter + newHeight / 2;
    } else if (imageAspectRatio > boundsAspectRatio) {
      const newWidth = (bounds.yMax - bounds.yMin) * imageAspectRatio;
      const xCenter = (bounds.xMin + bounds.xMax) / 2;
      adjustedBounds.xMin = xCenter - newWidth / 2;
      adjustedBounds.xMax = xCenter + newWidth / 2;
    }

    return adjustedBounds;
  }

  /** Splits the render into 24 vertical columns for parallelism across the
   * worker pool. Every column is `columnWidth` wide except the last, which is
   * clamped so the columns tile the full width exactly (`ceil` can otherwise
   * overshoot `totalWidth`). Shared by the image and raw-data exports so both
   * carve up the view identically. */
  private columnLayout(
    bounds: TileRect,
    totalWidth: number,
  ): { subBounds: TileRect; width: number; xOffset: number }[] {
    const numColumns = 24;
    const columnWidth = Math.ceil(totalWidth / numColumns);
    const xDiff = bounds.xMax - bounds.xMin;

    const columns: { subBounds: TileRect; width: number; xOffset: number }[] =
      [];
    for (let i = 0; i < numColumns; i++) {
      const xOffset = columnWidth * i;
      if (xOffset >= totalWidth) {
        break;
      }
      const width = Math.min(columnWidth, totalWidth - xOffset);
      columns.push({
        subBounds: {
          ...bounds,
          xMin: bounds.xMin + xDiff * (xOffset / totalWidth),
          xMax: bounds.xMin + xDiff * ((xOffset + width) / totalWidth),
        },
        width,
        xOffset,
      });
    }

    return columns;
  }

  private async generateImageColumns(
    bounds: TileRect,
    totalWidth: number,
    totalHeight: number,
  ): Promise<HTMLCanvasElement[]> {
    return Promise.all(
      this.columnLayout(bounds, totalWidth).map((column) =>
        this.map.regionRenderer.renderToCanvas(
          column.subBounds,
          column.width,
          totalHeight,
        ),
      ),
    );
  }

  private combineImageColumns(
    imageCanvases: HTMLCanvasElement[],
    totalWidth: number,
    totalHeight: number,
  ): HTMLCanvasElement {
    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = totalWidth;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext("2d");

    if (!ctx) {
      throw new Error("Could not get canvas context for combining columns");
    }

    let xOffset = 0;
    imageCanvases.forEach((canvas) => {
      ctx.drawImage(canvas, xOffset, 0);
      xOffset += canvas.width;
    });

    return finalCanvas;
  }

  /** Embeds the full, untruncated view parameters into the PNG as tEXt chunks
   * so a saved image stays exactly regenerable even after it is renamed. The
   * share URL and the JSON blob are both derived from `buildShareParams`, the
   * same serialization the share button uses, so they never drift. Runs before
   * the optional oxipng pass, which preserves text chunks. */
  private embedViewMetadata(pngBuffer: ArrayBuffer): ArrayBuffer {
    const params = buildShareParams(this.map.config);
    const shareUrl = this.map.getShareUrl();
    return embedTextChunks(pngBuffer, [
      { keyword: "Software", text: "Mandelbrot.site" },
      { keyword: "mandelbrot:url", text: shareUrl },
      { keyword: "mandelbrot:params", text: JSON.stringify(params) },
    ]);
  }

  private async saveCanvasAsImage(
    canvas: HTMLCanvasElement,
    optimize: boolean,
    onStartOptimizing?: () => void,
  ): Promise<void> {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      console.error("Could not get canvas context for saving image");
      return;
    }
    const dataUrl = canvas.toDataURL("image/png");
    const response = await fetch(dataUrl);
    const rawPngBuffer = this.embedViewMetadata(await response.arrayBuffer());

    let finalBuffer = rawPngBuffer;

    if (optimize) {
      onStartOptimizing?.();
      const optimiseRequest: OptimiseRequest = {
        type: "optimise",
        payload: { buffer: rawPngBuffer },
      };
      finalBuffer = (await this.map.pool.queue((worker) =>
        worker(optimiseRequest),
      )) as OptimiseResponse;
    }

    const blob = new Blob([finalBuffer], { type: "image/png" });

    // Deep-zoom coordinates can be hundreds of digits; keep filenames sane.
    const truncate = (value: string) =>
      value.length > 24 ? value.slice(0, 24) : value;

    saveAs(
      blob,
      `mandelbrot${Date.now()}_r${truncate(this.map.config.re)}_im${truncate(
        this.map.config.im,
      )}_z${this.map.config.zoom}.png`,
    );
  }
}

export default ImageSaver;
