import debounce from "lodash/debounce";
import * as L from "leaflet";
import type MandelbrotMap from "./MandelbrotMap";
import { TileRect, WorkerRequest } from "./MandelbrotMap";

type Done = (error: null, tile: HTMLCanvasElement) => void;

// Fired (once per page load) when the first map tile finishes rendering.
// index.ts listens for this as proof that the served asset set is healthy and
// its one-shot cache-recovery guards can be re-armed.
export const firstTileRenderedEvent = "mandelbrot:first-tile-rendered";

let firstTileRendered = false;

function announceFirstTileRendered() {
  if (firstTileRendered) return;
  firstTileRendered = true;
  window.dispatchEvent(new Event(firstTileRenderedEvent));
}

export type WasmRequestPayload = {
  originRe: string;
  originIm: string;
  bounds: TileRect;
  zoomOffset: number;
  iterations: number;
  exponent: number;
  imageWidth: number;
  imageHeight: number;
  colorScheme: string;
  reverseColors: boolean;
  lightenAmount: number;
  saturateAmount: number;
  shiftHueAmount: number;
  colorSpace: number;
  smoothColoring: boolean;
  paletteMinIter: number;
  paletteMaxIter: number;
};

type TileGenerationTask = {
  position: L.Coords;
  canvas: HTMLCanvasElement;
  done: Done;
};

class MandelbrotLayer extends L.GridLayer {
  tileSize: number;
  _map: MandelbrotMap;
  tilesToGenerate: TileGenerationTask[] = [];

  constructor() {
    super({
      noWrap: true,
      tileSize: 200,
    });
  }

  private buildRequestPayload(
    bounds: TileRect,
    imageWidth: number,
    imageHeight: number,
  ): WasmRequestPayload {
    return {
      originRe: this._map.origin.re,
      originIm: this._map.origin.im,
      bounds,
      zoomOffset: this._map.zoomOffset,
      iterations: this._map.config.iterations,
      exponent: this._map.config.exponent,
      imageWidth,
      imageHeight,
      colorScheme: this._map.config.colorScheme,
      reverseColors: this._map.config.reverseColors,
      lightenAmount: this._map.config.lightenAmount,
      saturateAmount: this._map.config.saturateAmount,
      shiftHueAmount: this._map.config.shiftHueAmount,
      colorSpace: this._map.config.colorSpace,
      smoothColoring: this._map.config.smoothColoring,
      paletteMinIter: this._map.config.paletteMinIter,
      paletteMaxIter: this._map.config.paletteMaxIter,
    };
  }

  getImage(
    bounds: TileRect,
    imageWidth: number,
    imageHeight: number,
  ): Promise<HTMLCanvasElement> {
    return new Promise<HTMLCanvasElement>((resolve, reject) => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      canvas.width = imageWidth;
      canvas.height = imageHeight;

      this._map.pool.queue(async (workerTask) => {
        try {
          const request: WorkerRequest = {
            type: "calculate" as const,
            payload: this.buildRequestPayload(bounds, imageWidth, imageHeight),
          };
          const data = (await workerTask(request)) as Uint8Array;

          const imageData = new ImageData(
            Uint8ClampedArray.from(data),
            imageWidth,
            imageHeight,
          );
          context.putImageData(imageData, 0, 0);
          resolve(canvas);
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  debounceTileGeneration = debounce(this.generateTiles, 350);

  createTile(tilePosition: L.Coords, done: Done) {
    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-tile",
    ) as HTMLCanvasElement;
    this.shouldImmediatelyGenerateTile()
      ? this.generateTile(canvas, tilePosition, done)
      : this.queueTileGeneration(canvas, tilePosition, done);
    return canvas;
  }

  private shouldImmediatelyGenerateTile(): boolean {
    return (
      this._map.config.iterations <= 500 ||
      L.Browser.mobile ||
      L.Browser.android
    );
  }

  private queueTileGeneration(
    canvas: HTMLCanvasElement,
    tilePosition: L.Coords,
    done: Done,
  ) {
    this.tilesToGenerate.push({ position: tilePosition, canvas, done });
    this.debounceTileGeneration();
  }

  refresh() {
    let currentMap: MandelbrotMap | null = null;
    if (this._map) {
      currentMap = this._map as MandelbrotMap;
      this.removeFrom(this._map);
    }
    this.addTo(currentMap);
  }

  private getTileRect(tilePosition: L.Coords): TileRect {
    return {
      xMin: tilePosition.x,
      xMax: tilePosition.x + 1,
      yMin: tilePosition.y,
      yMax: tilePosition.y + 1,
      zoom: tilePosition.z,
    };
  }

  private generateTile(
    canvas: HTMLCanvasElement,
    tilePosition: L.Coords,
    done: Done,
  ) {
    const context = canvas.getContext("2d");

    const scaledTileSize = this._map.config.highDpiTiles
      ? this.getTileSize().x * Math.max(window.devicePixelRatio || 2, 2)
      : this.getTileSize().x;

    canvas.width = scaledTileSize;
    canvas.height = scaledTileSize;

    const bounds = this.getTileRect(tilePosition);

    const id =
      typeof crypto !== "undefined" && crypto
        ? crypto.randomUUID()
        : Date.now().toString();

    const tileTask = this._map.pool.queue(async (workerTask) => {
      const request: WorkerRequest = {
        type: "calculate" as const,
        payload: this.buildRequestPayload(
          bounds,
          scaledTileSize,
          scaledTileSize,
        ),
      };
      const data = (await workerTask(request)) as Uint8Array;

      const imageData = new ImageData(
        Uint8ClampedArray.from(data),
        scaledTileSize,
        scaledTileSize,
      );
      context.putImageData(imageData, 0, 0);
      announceFirstTileRendered();
      this._map.queuedTileTasks = this._map.queuedTileTasks.filter(
        (task) => task.id !== id,
      );
      done(null, canvas);
    });

    this._map.queuedTileTasks.push({
      id,
      task: tileTask,
      position: tilePosition,
    });

    return canvas;
  }

  private generateTiles() {
    const tilesToGenerate = this.tilesToGenerate.splice(
      0,
      this.tilesToGenerate.length,
    );

    const mapZoom = this._map.getZoom();

    const relevantTasks = tilesToGenerate.filter(
      (task) => task.position.z === mapZoom,
    );

    relevantTasks.forEach((task) => {
      this.generateTile(task.canvas, task.position, task.done);
    });
  }
}

export default MandelbrotLayer;
