import { saveAs } from "file-saver";
import { FunctionThread, Pool } from "threads";
import type MandelbrotMap from "./MandelbrotMap";
import type MandelbrotLayer from "./MandelbrotLayer";
import {
  OptimiseRequest,
  OptimiseResponse,
  TileRect,
  WorkerRequest,
  WorkerResponse,
} from "./MandelbrotMap";

type TaskThread = FunctionThread<[WorkerRequest], WorkerResponse>;

class ImageSaver {
  private map: MandelbrotMap;
  private pool: Pool<TaskThread>;
  private mandelbrotLayer: MandelbrotLayer;

  constructor(
    map: MandelbrotMap,
    pool: Pool<TaskThread>,
    mandelbrotLayer: MandelbrotLayer,
  ) {
    this.map = map;
    this.pool = pool;
    this.mandelbrotLayer = mandelbrotLayer;
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

  private async generateImageColumns(
    bounds: TileRect,
    totalWidth: number,
    totalHeight: number,
  ): Promise<HTMLCanvasElement[]> {
    const numColumns = 24;
    const columnWidth = Math.ceil(totalWidth / numColumns);
    const xDiff = bounds.xMax - bounds.xMin;
    const xDiffPerColumn = xDiff * (columnWidth / totalWidth);

    const imagePromises: Promise<HTMLCanvasElement>[] = [];
    for (let i = 0; i < numColumns; i++) {
      const subBounds = {
        ...bounds,
        xMin: bounds.xMin + xDiffPerColumn * i,
        xMax: bounds.xMin + xDiffPerColumn * (i + 1),
      };
      imagePromises.push(
        this.mandelbrotLayer.getImage(subBounds, columnWidth, totalHeight),
      );
    }

    return Promise.all(imagePromises);
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
    const rawPngBuffer = await response.arrayBuffer();

    let finalBuffer = rawPngBuffer;

    if (optimize) {
      onStartOptimizing?.();
      const optimiseRequest: OptimiseRequest = {
        type: "optimise",
        payload: { buffer: rawPngBuffer },
      };
      finalBuffer = (await this.pool.queue((worker) =>
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
