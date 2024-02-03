import "./static";
import { stringify } from "./utils";
import * as debounce from "debounce";
import * as L from "leaflet";
import { saveAs } from "file-saver";
import domToImage from "dom-to-image";

interface WorkerContainer {
  worker: Worker;
  activeJobs: number;
  ready: boolean;
}
interface MandelbrotConfig {
  iterations: number;
  exponent: number;
}
interface Input {
  id: "iterations" | "exponent";
  map: MandelbrotMap;
  minValue: number;
  defaultValue: number;
  maxValue: number;
  resetView?: boolean;
}
interface MessageFromWorker {
  data: {
    image: Uint8ClampedArray;
    coords: string;
  };
}
interface Done {
  (error: null, tile: HTMLCanvasElement): void;
}

let workers: Array<WorkerContainer> = [];
const config: MandelbrotConfig = {
  iterations: 200,
  exponent: 2,
};

function createWorker() {
  const w: WorkerContainer = {
    worker: new Worker("./worker.js"),
    activeJobs: 0,
    ready: false,
  };
  const workerReadyHandler = (e: MessageEvent) => {
    if (e.data.ready) {
      w.ready = true;
      w.worker.removeEventListener("message", workerReadyHandler);
    }
  };
  w.worker.addEventListener("message", workerReadyHandler);
  return w;
}

async function resetWorkers() {
  for (const { worker } of workers) {
    worker.terminate();
  }
  const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 64);
  workers = [...new Array(numWorkers)].map(createWorker);
  while (!workers.every((w) => w.ready)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

function handleInput({
  id,
  map,
  defaultValue,
  minValue,
  maxValue,
  resetView,
}: Input) {
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

function handleInputs(map: MandelbrotMap) {
  handleInput({
    id: "iterations",
    map,
    minValue: 1,
    defaultValue: 200,
    maxValue: 10 ** 9,
  });
  handleInput({
    id: "exponent",
    map,
    minValue: 2,
    defaultValue: config.exponent,
    maxValue: 10 ** 9,
    resetView: true,
  });

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

class MandelbrotLayer extends L.GridLayer {
  tileSize: number;

  constructor(options?: L.GridLayerOptions) {
    super(options);
    this.tileSize = 200;
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
      const re = (x / d) * scaleFactor - 3.75;
      const im = (y / d) * scaleFactor - 3.25;
      return { re, im };
    };

    const { re: re_min, im: im_min } = mapCoordinates(
      coords.x,
      coords.y,
      coords.z,
      this.tileSize
    );

    const { re: re_max, im: im_max } = mapCoordinates(
      coords.x + 1,
      coords.y + 1,
      coords.z,
      this.tileSize
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
    const tile = <HTMLCanvasElement>L.DomUtil.create("canvas", "leaflet-tile");
    const context = tile.getContext("2d");

    tile.width = this.tileSize;
    tile.height = this.tileSize;

    const mappedCoords = this.getMappedCoords(coords);
    const coordsString = stringify(mappedCoords);

    Object.entries({ ...coords, ...mappedCoords }).forEach(([key, value]) => {
      tile.dataset[key] = String(value);
    });

    const selectedWorker = workers
      .filter((w) => w.ready)
      .reduce(
        (leastActive, worker) =>
          worker.activeJobs < leastActive.activeJobs ? worker : leastActive,
        workers[0]
      );

    selectedWorker.activeJobs += 1;
    const tileRetrievedHandler = ({ data }: MessageFromWorker) => {
      if (data.coords === coordsString) {
        selectedWorker.worker.removeEventListener(
          "message",
          tileRetrievedHandler
        );
        selectedWorker.activeJobs = Math.max(selectedWorker.activeJobs - 1, 0);
        const imageData = new ImageData(
          Uint8ClampedArray.from(data.image),
          this.tileSize,
          this.tileSize
        );
        context.putImageData(imageData, 0, 0);
        done(null, tile);
      }
    };

    selectedWorker.worker.addEventListener("message", tileRetrievedHandler);
    selectedWorker.worker.postMessage({
      coords: mappedCoords,
      maxIterations: config.iterations,
      exponent: config.exponent,
      tileSize: this.tileSize,
    });

    return tile;
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

  constructor(mapId: string) {
    super(mapId, {
      attributionControl: false,
      maxZoom: 32,
      zoomAnimationThreshold: 32,
    });

    this.mapId = mapId;
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.defaultPosition = [0, 0];
    this.defaultZoom = 2;
    this.setView(this.defaultPosition, this.defaultZoom);
    this.mandelbrotLayer.refresh();
  }

  async refresh(resetView = false) {
    await resetWorkers();
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

resetWorkers().then(() => {
  const map = new MandelbrotMap("leaflet-map");
  handleInputs(map);
});
