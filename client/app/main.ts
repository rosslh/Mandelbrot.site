import "./static";
import * as debounce from "debounce";
import * as L from "leaflet";
import { saveAs } from "file-saver";
import domToImage from "dom-to-image";
import { EsThreadPool, EsThread } from "threads-es/controller";

interface MandelbrotConfig {
  [key: string]: number | string | boolean;
}

interface NumberInput {
  id: "iterations" | "exponent";
  map: MandelbrotMap;
  minValue: number;
  defaultValue: number;
  maxValue: number;
  resetView?: boolean;
}

interface SelectInput {
  id: "colorScheme";
  map: MandelbrotMap;
}

interface CheckboxInput {
  id: "reverseColors";
  map: MandelbrotMap;
}

interface Done {
  (error: null, tile: HTMLCanvasElement): void;
}

const config: MandelbrotConfig = {
  iterations: 200,
  exponent: 2,
  colorScheme: "turbo",
  reverseColors: false,
};
class MandelbrotLayer extends L.GridLayer {
  tileSize: number;
  _map: MandelbrotMap;

  constructor() {
    super({
      noWrap: true,
      tileSize: 200,
    });
  }

  private getMappedCoords(coords: L.Coords) {
    const mapCoordinates = (
      x: number,
      y: number,
      z: number,
      tileSize: number
    ): { re: number; im: number } => {
      const scaleFactor = tileSize / 128.5;
      const d = 2 ** (z - 2);
      const re = (x / d) * scaleFactor - 4;
      const im = (y / d) * scaleFactor - 4;
      return { re, im };
    };

    const { re: re_min, im: im_min } = mapCoordinates(
      coords.x,
      coords.y,
      coords.z,
      this.getTileSize().x
    );

    const { re: re_max, im: im_max } = mapCoordinates(
      coords.x + 1,
      coords.y + 1,
      coords.z,
      this.getTileSize().x
    );

    const mappedCoords = {
      re_min,
      re_max,
      im_min,
      im_max,
    };

    return mappedCoords;
  }

  createTile(coords: L.Coords, done: Done) {
    const canvas = L.DomUtil.create(
      "canvas",
      "leaflet-tile"
    ) as HTMLCanvasElement;

    const context = canvas.getContext("2d");

    canvas.width = this.getTileSize().x;
    canvas.height = this.getTileSize().y;

    const mappedCoords = this.getMappedCoords(coords);

    Object.entries({ ...coords, ...mappedCoords }).forEach(([key, value]) => {
      canvas.dataset[key] = String(value);
    });

    this._map.pool
      ?.queue((thread) =>
        thread.methods.getTile({
          coords: mappedCoords,
          maxIterations: config.iterations,
          exponent: config.exponent,
          tileSize: this.getTileSize().x,
          colorScheme: config.colorScheme,
          reverseColors: config.reverseColors,
        })
      )
      .then((result) => {
        const imageData = new ImageData(
          Uint8ClampedArray.from(result),
          this.getTileSize().x,
          this.getTileSize().y
        );
        context.putImageData(imageData, 0, 0);
        done(null, canvas);
      });

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

class MandelbrotMap extends L.Map {
  mandelbrotLayer: MandelbrotLayer;
  mapId: string;
  defaultPosition: [number, number];
  defaultZoom: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: EsThreadPool<any>;

  constructor({ htmlId: mapId }: { htmlId: string }) {
    super(mapId, {
      attributionControl: false,
      maxZoom: 32,
      zoomAnimationThreshold: 32,
    });

    this.createPool().then(() => {
      this.refresh(false);
      this.mandelbrotLayer.refresh();
    });
    this.mapId = mapId;
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.defaultPosition = [0, 0];
    this.defaultZoom = 3;
    this.setView(this.defaultPosition, this.defaultZoom);
    this.mandelbrotLayer.refresh();
  }

  async createPool() {
    if (this.pool) {
      await this.pool.terminate();
    }

    this.pool = await EsThreadPool.Spawn(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        EsThread.Spawn<any>(
          new Worker(new URL("./worker.ts", import.meta.url), {
            type: "module",
          })
        ),
      {
        size: navigator.hardwareConcurrency || 4,
      }
    );
  }

  async refresh(resetView = false) {
    await this.createPool();
    if (resetView) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._resetView(this.defaultPosition, this.defaultZoom);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._resetView(this.getCenter(), this.getZoom());
    }
  }

  async saveImage() {
    const zoomControl = this.zoomControl;
    const mapElement = document.getElementById(this.mapId);
    const width = mapElement.offsetWidth;
    const height = mapElement.offsetHeight;
    this.removeControl(zoomControl);
    const blob = await domToImage.toBlob(mapElement, { width, height });
    this.addControl(zoomControl);
    saveAs(blob, `mandelbrot-${Date.now()}.png`);
  }
}

function handleNumberInput({
  id,
  map,
  defaultValue,
  minValue,
  maxValue,
  resetView,
}: NumberInput) {
  const input = <HTMLInputElement>document.getElementById(id);
  input.value = String(config[id]);
  input.oninput = debounce(({ target }) => {
    let parsedValue = Number.parseInt((<HTMLInputElement>target).value, 10);
    if (
      isNaN(parsedValue) ||
      parsedValue < minValue ||
      parsedValue > maxValue
    ) {
      parsedValue = defaultValue;
    }
    input.value = String(parsedValue);
    config[id] = parsedValue;
    map.refresh(resetView);
  }, 1000);
}

function handleSelectInput({ id, map }: SelectInput) {
  const select = <HTMLSelectElement>document.getElementById(id);
  select.value = String(config[id]);
  select.onchange = ({ target }) => {
    config[id] = (<HTMLSelectElement>target).value;
    map.refresh();
  };
}

function handleCheckboxInput({ id, map }: CheckboxInput) {
  const checkbox = <HTMLInputElement>document.getElementById(id);
  checkbox.checked = Boolean(config[id]);
  checkbox.onchange = ({ target }) => {
    config[id] = (<HTMLInputElement>target).checked;
    map.refresh();
  };
}

function handleInputs(map: MandelbrotMap) {
  handleNumberInput({
    id: "iterations",
    map,
    minValue: 1,
    defaultValue: 200,
    maxValue: 10 ** 9,
  });
  handleNumberInput({
    id: "exponent",
    map,
    minValue: 2,
    defaultValue: Number(config.exponent),
    maxValue: 10 ** 9,
    resetView: true,
  });
  handleSelectInput({ id: "colorScheme", map });
  handleCheckboxInput({ id: "reverseColors", map });

  const refreshButton: HTMLButtonElement = document.querySelector("#refresh");
  refreshButton.onclick = () => map.refresh();

  const fullScreenButton: HTMLButtonElement =
    document.querySelector("#full-screen");
  if (document.fullscreenEnabled) {
    fullScreenButton.onclick = toggleFullScreen;
  } else {
    fullScreenButton.style.display = "none";
  }

  const saveButton: HTMLButtonElement = document.querySelector("#save-image");
  try {
    // eslint-disable-next-line no-constant-condition
    if (new Blob()) {
      saveButton.onclick = () => map.saveImage();
    } else {
      throw "FileSaver not supported";
    }
  } catch {
    saveButton.style.display = "none";
  }

  function toggleFullScreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      document.body.requestFullscreen();
    }
  }

  document.addEventListener("fullscreenchange", () => {
    const button: HTMLButtonElement = document.querySelector("#full-screen");
    button.innerText = document.fullscreenElement
      ? "Exit Full Screen"
      : "Full Screen";
  });
}

const map = new MandelbrotMap({
  htmlId: "leaflet-map",
});
handleInputs(map);
