import "./static";
import * as debounce from "debounce";
import * as L from "leaflet";

interface WorkerContainer { worker: Worker, activeJobs: Array<string>, ready: boolean }
let workers: Array<WorkerContainer> = [];
const initNumWorkers = Math.min(navigator.hardwareConcurrency || 4, 60);
let maxIterations = 200, isSmoothed = true, numWorkers = initNumWorkers;

function createWorker() {
  const w: WorkerContainer = { worker: new Worker("./worker.js"), activeJobs: [], ready: false };
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
  workers.forEach(({ worker }) => worker.terminate()); // terminate old workers/jobs
  workers = [...Array(numWorkers)].map(createWorker);
  while (!workers.some(w => w.ready)) {
    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

function refreshMap(map: any) {
  resetWorkers().then(() => {
    map._resetView(map.getCenter(), map.getZoom(), true);
  });
};

function handleInputs(map: L.Map) {
  const iterationsInput = <HTMLInputElement>document.getElementById("iterations");
  iterationsInput.value = String(maxIterations);
  iterationsInput.oninput = debounce(({ target }) => {
    let parsedValue = parseInt((<HTMLInputElement>target).value, 10);
    if (isNaN(parsedValue) || parsedValue < 1) {
      parsedValue = 200;
    }
    iterationsInput.value = String(parsedValue);
    maxIterations = parsedValue;
    refreshMap(map);
  }, 1000);

  const workersInput = <HTMLInputElement>document.getElementById("workers");
  workersInput.value = String(numWorkers);
  workersInput.oninput = debounce(({ target }) => {
    let parsedValue = parseInt((<HTMLInputElement>target).value, 10);
    if (isNaN(parsedValue) || parsedValue < 1) {
      parsedValue = initNumWorkers;
    } else if (parsedValue > 60) {
      parsedValue = 60;
    }
    workersInput.value = String(parsedValue);
    numWorkers = parsedValue;
    refreshMap(map);
  }, 1000);

  const smoothingInput = <HTMLInputElement>document.getElementById("smoothing");
  smoothingInput.checked = true;
  smoothingInput.onclick = ({ target }) => {
    isSmoothed = (<HTMLInputElement>target).checked;
    refreshMap(map);
  };
  document.getElementById("refresh").onclick = () => refreshMap(map);
}

interface MessageFromWorker {
  data: { coords: string, pixels: Array<number> }
}

function createTile(coords: L.Coords, done: Function) {
  const tile = <HTMLCanvasElement>L.DomUtil.create('canvas', 'leaflet-tile');
  const ctx = tile.getContext('2d');
  tile.width = 256, tile.height = 256;
  const coordsString = JSON.stringify(coords);
  const selectedWorker = workers.filter(w => w.ready).sort((a, b) => (a.activeJobs.length > b.activeJobs.length) ? 1 : -1)[0];
  selectedWorker.activeJobs.push(coordsString);
  const tileRetrievedHandler = ({ data }: MessageFromWorker) => {
    if (data.coords === coordsString) {
      const imageData = new ImageData(Uint8ClampedArray.from(data.pixels), 256, 256);
      ctx.putImageData(imageData, 0, 0);
      done(undefined, tile);
      selectedWorker.worker.removeEventListener("message", tileRetrievedHandler);
      selectedWorker.activeJobs = selectedWorker.activeJobs.filter((j: string) => j !== coordsString);
    }
  };
  selectedWorker.worker.addEventListener("message", tileRetrievedHandler);
  selectedWorker.worker.postMessage({ coords, maxIterations, isSmoothed });
  return tile;
}

function createMap() {
  const map: L.Map = L.map('leaflet-map', { attributionControl: false, maxZoom: 32, zoomAnimationThreshold: 32 }).setView([0, 0], 2);
  const MandelbrotLayer = L.GridLayer.extend({ createTile });
  new MandelbrotLayer().addTo(map);
  handleInputs(map);
}

resetWorkers().then(createMap);