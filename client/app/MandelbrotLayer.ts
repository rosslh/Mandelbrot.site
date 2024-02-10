import debounce from "lodash/debounce";
import * as L from "leaflet";
import MandelbrotMap from "./MandelbrotMap";
import { config } from "./main";

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

  private getComplexBoundsOfTile(tilePosition: L.Coords) {
    const { re: re_min, im: im_min } = this._map.tilePositionToComplexParts(
      tilePosition.x,
      tilePosition.y,
      tilePosition.z
    );

    const { re: re_max, im: im_max } = this._map.tilePositionToComplexParts(
      tilePosition.x + 1,
      tilePosition.y + 1,
      tilePosition.z
    );

    const bounds = {
      re_min,
      re_max,
      im_min,
      im_max,
    };

    return bounds;
  }

  private generateTile(
    canvas: HTMLCanvasElement,
    tilePosition: L.Coords,
    done: Done
  ) {
    const context = canvas.getContext("2d");

    const scaledTileSize = config.highDpiTiles
      ? this.getTileSize().x * Math.max(window.devicePixelRatio || 2, 2)
      : this.getTileSize().x;

    canvas.width = scaledTileSize;
    canvas.height = scaledTileSize;

    const bounds = this.getComplexBoundsOfTile(tilePosition);

    this._map.pool.queue(async ({ getTile }) => {
      getTile({
        bounds,
        maxIterations: config.iterations,
        exponent: config.exponent,
        tileSize: scaledTileSize,
        colorScheme: config.colorScheme,
        reverseColors: config.reverseColors,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }).then((data: any) => {
        const imageData = new ImageData(
          Uint8ClampedArray.from(data),
          scaledTileSize,
          scaledTileSize
        );
        context.putImageData(imageData, 0, 0);
        done(null, canvas);
      });
    });

    return canvas;
  }

  private generateTiles() {
    const tilesToGenerate = this.tilesToGenerate.splice(
      0,
      this.tilesToGenerate.length
    );

    const mapZoom = this._map.getZoom();

    const relevantTasks = tilesToGenerate.filter(
      (task) => task.position.z === mapZoom
    );

    relevantTasks.forEach((task) => {
      this.generateTile(task.canvas, task.position, task.done);
    });
  }

  debounceTileGeneration = debounce(this.generateTiles, 350);

  createTile(tilePosition: L.Coords, done: Done) {
    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-tile"
    ) as HTMLCanvasElement;
    this.tilesToGenerate.push({ position: tilePosition, canvas, done });
    this.debounceTileGeneration();
    return canvas;
  }

  refresh() {
    let currentMap: MandelbrotMap | null = null;
    if (this._map) {
      currentMap = this._map as MandelbrotMap;
      this.removeFrom(this._map);
    }
    this.addTo(currentMap);
  }
}

export { MandelbrotLayer };
