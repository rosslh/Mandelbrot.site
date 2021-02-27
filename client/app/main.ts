import "./static";
import { stringify } from "./utils";
import * as debounce from "debounce";
import * as L from "leaflet";
import { saveAs } from "file-saver";
import domToImage from "dom-to-image";

interface WorkerContainer { worker: Worker, activeJobs: number, ready: boolean }
interface MandelbrotConfig { iterations: number, exponent: number, workers: number }
let workers: Array<WorkerContainer> = [];
const initNumWorkers = Math.min(navigator.hardwareConcurrency || 4, 64);
const config: MandelbrotConfig = { iterations: 200, exponent: 2, workers: initNumWorkers };
const mapId = "leaflet-map";

function createWorker() {
  const w: WorkerContainer = { worker: new Worker("./worker.js"), activeJobs: 0, ready: false };
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
  while (!workers.every(w => w.ready)) await new Promise(resolve => setTimeout(resolve, 300));
}

interface ResetView { (center: Array<number> | L.LatLng, zoom: number): void }
interface RefreshableMap extends L.Map { _resetView: ResetView }
async function refreshMap(map: RefreshableMap, resetView = false) {
  await resetWorkers();
  if (resetView) map._resetView([0, 0], 2);
  else map._resetView(map.getCenter(), map.getZoom());
}

interface Input {
  id: "iterations" | "exponent" | "workers";
  map: RefreshableMap;
  minValue: number;
  defaultValue: number;
  maxValue: number;
  resetView?: boolean;
}
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
  handleInput({ id: "exponent", map, minValue: 2, defaultValue: 2, maxValue: 1000000, resetView: true });
  handleInput({ id: "workers", map, minValue: 1, defaultValue: initNumWorkers, maxValue: 64 });
  document.getElementById("refresh").onclick = () => refreshMap(map);

  const fullScreenBtn = document.getElementById("full-screen");
  if (document.fullscreenEnabled) fullScreenBtn.onclick = toggleFullScreen;
  else fullScreenBtn.style.display = "none";

  const saveBtn = document.getElementById("save-image");
  try {
    if (new Blob) saveBtn.onclick = () => saveImage(map);
    else throw "FileSaver not supported";
  } catch (e) {
    saveBtn.style.display = "none";
  }
}

interface MessageFromWorker { data: { coords: string; pixels: Array<number> } }
interface Done { (error: null, tile: HTMLCanvasElement): void }
function createTile(coords: L.Coords, done: Done) {
  const tile = <HTMLCanvasElement>L.DomUtil.create("canvas", "leaflet-tile");
  const ctx = tile.getContext("2d");
  (tile.width = 256), (tile.height = 256);
  const coordsString = stringify(coords);
  const selectedWorker = workers.filter(w => w.ready).reduce((leastActive, worker) => (worker.activeJobs < leastActive.activeJobs ? worker : leastActive), workers[0]);
  selectedWorker.activeJobs += 1;
  const tileRetrievedHandler = ({ data }: MessageFromWorker) => {
    if (data.coords === coordsString) {
      selectedWorker.worker.removeEventListener("message", tileRetrievedHandler);
      selectedWorker.activeJobs = Math.max(selectedWorker.activeJobs - 1, 0);
      const imageData = new ImageData(Uint8ClampedArray.from(data.pixels), 256, 256);
      ctx.putImageData(imageData, 0, 0);
      done(null, tile);
    }
  };
  selectedWorker.worker.addEventListener("message", tileRetrievedHandler);
  selectedWorker.worker.postMessage({ coords, maxIterations: config.iterations, exponent: config.exponent });
  return tile;
}

function createMap() {
  const map: RefreshableMap = <RefreshableMap>L.map(mapId, { attributionControl: false, maxZoom: 32, zoomAnimationThreshold: 32 }).setView([0, 0], 2);
  const MandelbrotLayer = L.GridLayer.extend({ createTile });
  new MandelbrotLayer().addTo(map);
  handleInputs(map);
}

async function saveImage(map: RefreshableMap) {
  const zoomControl = map.zoomControl;
  const mapElement = document.getElementById(mapId);
  const width = mapElement.offsetWidth, height = mapElement.offsetHeight;
  map.removeControl(zoomControl);
  const blob = await domToImage.toBlob(mapElement, { width, height });
  map.addControl(zoomControl);
  saveAs(blob, `mandelbrot-${Date.now()}.png`);
}

function toggleFullScreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen();
}

document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById("full-screen");
  if (document.fullscreenElement) btn.innerText = "Exit Full Screen";
  else btn.innerText = "Full Screen";
});

// setInterval(() => console.log(workers.map((w) => w.activeJobs)), 1000);
resetWorkers().then(createMap);
