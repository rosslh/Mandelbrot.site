import { saveAs } from "file-saver";
import { FunctionThread, Pool } from "threads";
import type MandelbrotMap from "./MandelbrotMap";
import type MandelbrotLayer from "./MandelbrotLayer";
import {
  ComplexBounds,
  OptimiseRequest,
  OptimiseResponse,
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
      this.map.mapBoundsAsComplexParts,
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
    bounds: ComplexBounds,
    totalWidth: number,
    totalHeight: number,
  ): ComplexBounds {
    const imageAspectRatio = totalWidth / totalHeight;
    const complexAspectRatio =
      (bounds.reMax - bounds.reMin) / (bounds.imMax - bounds.imMin);

    const adjustedBounds = { ...bounds };

    if (imageAspectRatio < complexAspectRatio) {
      const newImHeight = (bounds.reMax - bounds.reMin) / imageAspectRatio;
      const imCenter = (bounds.imMin + bounds.imMax) / 2;
      adjustedBounds.imMin = imCenter - newImHeight / 2;
      adjustedBounds.imMax = imCenter + newImHeight / 2;
    } else if (imageAspectRatio > complexAspectRatio) {
      const newReWidth = (bounds.imMax - bounds.imMin) * imageAspectRatio;
      const reCenter = (bounds.reMin + bounds.reMax) / 2;
      adjustedBounds.reMin = reCenter - newReWidth / 2;
      adjustedBounds.reMax = reCenter + newReWidth / 2;
    }

    return adjustedBounds;
  }

  private async generateImageColumns(
    bounds: ComplexBounds,
    totalWidth: number,
    totalHeight: number,
  ): Promise<HTMLCanvasElement[]> {
    const numColumns = 24;
    const columnWidth = Math.ceil(totalWidth / numColumns);
    const reDiff = bounds.reMax - bounds.reMin;
    const reDiffPerColumn = reDiff * (columnWidth / totalWidth);

    const imagePromises: Promise<HTMLCanvasElement>[] = [];
    for (let i = 0; i < numColumns; i++) {
      const subBounds = {
        ...bounds,
        reMin: bounds.reMin + reDiffPerColumn * i,
        reMax: bounds.reMin + reDiffPerColumn * (i + 1),
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

    saveAs(
      blob,
      `mandelbrot${Date.now()}_r${this.map.config.re}_im${
        this.map.config.im
      }_z${this.map.config.zoom}.png`,
    );
  }
}

export default ImageSaver;
