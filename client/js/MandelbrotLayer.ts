import debounce from "lodash/debounce";
import * as L from "leaflet";
import type MandelbrotMap from "./MandelbrotMap";

type Done = (error: null, tile: HTMLCanvasElement) => void;

class MandelbrotLayer extends L.GridLayer {
  tileSize: number;
  _map: MandelbrotMap;
  tilesToGenerate: Array<{
    position: L.Coords;
    canvas: HTMLCanvasElement;
    done: Done;
  }> = [];

  constructor() {
    super({
      noWrap: true,
      tileSize: 200,
    });
  }

  getImage(
    bounds: { reMin: number; reMax: number; imMin: number; imMax: number },
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

      this._map.pool.queue(async (getTile) => {
        try {
          const data = await getTile({
            bounds,
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
          });

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

  private getComplexBoundsOfTile(tilePosition: L.Coords) {
    const { re: reMin, im: imMin } = this._map.tilePositionToComplexParts(
      tilePosition.x,
      tilePosition.y,
      tilePosition.z,
    );

    const { re: reMax, im: imMax } = this._map.tilePositionToComplexParts(
      tilePosition.x + 1,
      tilePosition.y + 1,
      tilePosition.z,
    );

    const bounds = {
      reMin,
      reMax,
      imMin,
      imMax,
    };

    return bounds;
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

    const bounds = this.getComplexBoundsOfTile(tilePosition);

    const id =
      typeof crypto !== "undefined" && crypto
        ? crypto.randomUUID()
        : Date.now().toString();

    const tileTask = this._map.pool.queue(async (getTile) => {
      const data = await getTile({
        bounds,
        iterations: this._map.config.iterations,
        exponent: this._map.config.exponent,
        imageWidth: scaledTileSize,
        imageHeight: scaledTileSize,
        colorScheme: this._map.config.colorScheme,
        reverseColors: this._map.config.reverseColors,
        lightenAmount: this._map.config.lightenAmount,
        saturateAmount: this._map.config.saturateAmount,
        shiftHueAmount: this._map.config.shiftHueAmount,
        colorSpace: this._map.config.colorSpace,
        smoothColoring: this._map.config.smoothColoring,
        paletteMinIter: this._map.config.paletteMinIter,
        paletteMaxIter: this._map.config.paletteMaxIter,
      });

      const imageData = new ImageData(
        Uint8ClampedArray.from(data),
        scaledTileSize,
        scaledTileSize,
      );
      context.putImageData(imageData, 0, 0);
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
