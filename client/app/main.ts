import "./static";
import { stringify } from "./utils";
import * as debounce from "debounce";
import * as L from "leaflet";

interface WorkerContainer { worker: Worker, activeJobs: Array<string>, ready: boolean }
let workers: Array<WorkerContainer> = [];
const initNumWorkers = Math.min(navigator.hardwareConcurrency || 4, 64);
interface MandelbrotConfig { iterations: number, exponent: number, workers: number }
const config: MandelbrotConfig = { iterations: 200, exponent: 2, workers: initNumWorkers };

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
  workers = [...Array(config.workers)].map(createWorker);
  while (!workers.some(w => w.ready)) await new Promise(resolve => setTimeout(resolve, 300));
}

interface ResetView { (center: Array<number>|L.LatLng, zoom: number): void; }
interface RefreshableMap extends L.Map { _resetView: ResetView }
async function refreshMap(map: RefreshableMap, resetView=false) {
  await resetWorkers();
  if (resetView) map._resetView([0, 0], 2);
  else map._resetView(map.getCenter(), map.getZoom());
}

type InputId = "iterations" | "exponent" | "workers";
interface Input { id: InputId; map: RefreshableMap; minValue: number; defaultValue: number; maxValue: number; resetView?: boolean }
function handleInput({ id, map, defaultValue, minValue, maxValue, resetView }: Input) {
  const input = <HTMLInputElement>document.getElementById(id);
  input.value = String(config[id]);
  input.oninput = debounce(({ target }) => {
    let parsedValue = parseInt((<HTMLInputElement>target).value, 10);
    if (isNaN(parsedValue) || parsedValue < minValue || parsedValue > maxValue)
      parsedValue = defaultValue;
    input.value = String(parsedValue);
    config[id] = parsedValue;
    refreshMap(map, resetView);
  }, 1000);
}

function handleInputs(map: RefreshableMap) {
  handleInput({ id: "iterations", map, minValue: 1, defaultValue: 200, maxValue: Math.pow(10, 9) });
  handleInput({ id: "exponent", map, minValue: 2, defaultValue: 1, maxValue: 1000000, resetView: true });
  handleInput({ id: "workers", map, minValue: 1, defaultValue: initNumWorkers, maxValue: 64 });
  document.getElementById("refresh").onclick = () => refreshMap(map);
}

interface MessageFromWorker { data: { coords: string, pixels: Array<number> } }
interface Done { (error: null, tile: HTMLCanvasElement): void; }
function createTile(coords: L.Coords, done: Done) {
  const tile = <HTMLCanvasElement>L.DomUtil.create('canvas', 'leaflet-tile');
  const ctx = tile.getContext('2d');
  tile.width = 256, tile.height = 256;
  const coordsString = stringify(coords);
  const selectedWorker = workers.filter(w => w.ready).sort((a, b) => (a.activeJobs.length > b.activeJobs.length) ? 1 : -1)[0];
  selectedWorker.activeJobs.push(coordsString);
  const tileRetrievedHandler = ({ data }: MessageFromWorker) => {
    if (data.coords === coordsString) {
      const imageData = new ImageData(Uint8ClampedArray.from(data.pixels), 256, 256);
      ctx.putImageData(imageData, 0, 0);
      done(null, tile);
      selectedWorker.worker.removeEventListener("message", tileRetrievedHandler);
      selectedWorker.activeJobs = selectedWorker.activeJobs.filter((j: string) => j !== coordsString);
    }
  };
  selectedWorker.worker.addEventListener("message", tileRetrievedHandler);
  selectedWorker.worker.postMessage({ coords, maxIterations: config.iterations, exponent: config.exponent });
  return tile;
}

function createMap() {
  const map: RefreshableMap = <RefreshableMap>L.map('leaflet-map', { attributionControl: false, maxZoom: 32, zoomAnimationThreshold: 32 }).setView([0, 0], 2);
  const MandelbrotLayer = L.GridLayer.extend({ createTile });
  new MandelbrotLayer().addTo(map);
  handleInputs(map);
}

resetWorkers().then(createMap);
