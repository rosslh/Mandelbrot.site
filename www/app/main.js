import "../css/styles.css";
import "../css/normalize.css";
import "../static/site-image.png";
import "../static/apple-touch-icon.png";
import "../static/android-chrome-144x144.png";
import "../static/favicon-32x32.png";
import "../static/favicon-16x16.png";
import "../static/site.webmanifest";
import "../static/safari-pinned-tab.svg";
import "../static/browserconfig.xml";
import "../static/favicon.ico";
import "../static/mstile-150x150.png";
import "../node_modules/leaflet/dist/leaflet.css";
import debounce from "debounce";
import L from "leaflet";

let maxIterations = 200;
let isSmoothed = true;
const initNumWorkers = Math.min(navigator.hardwareConcurrency || 4, 20);
let numWorkers = initNumWorkers;
let workers = [];

function createWorker() {
  const w = {
    worker: new Worker("./worker.js"),
    activeJobs: []
  };
  const workerReadyHandler = e => {
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

function createTile(coords, done) {
  const tile = L.DomUtil.create('canvas', 'leaflet-tile');
  const ctx = tile.getContext('2d');
  tile.width = 256;
  tile.height = 256;
  const coordsString = JSON.stringify(coords);
  const selectedWorker = workers.filter(w => w.ready).sort((a, b) => (a.activeJobs.length > b.activeJobs.length) ? 1 : -1)[0];
  selectedWorker.activeJobs.push(coordsString);
  const tileRetrievedHandler = e => {
    if (e.data.coords === coordsString) {
      const imageData = new ImageData(Uint8ClampedArray.from(e.data.pixels), 256, 256);
      ctx.putImageData(imageData, 0, 0);
      done(undefined, tile);
      selectedWorker.worker.removeEventListener("message", tileRetrievedHandler);
      selectedWorker.activeJobs = selectedWorker.activeJobs.filter(j => j !== coordsString);
    }
  };
  selectedWorker.worker.addEventListener("message", tileRetrievedHandler);
  selectedWorker.worker.postMessage({ coords, maxIterations, isSmoothed });
  return tile;
}

function refreshMap(map) {
  resetWorkers().then(() => {
    map._resetView(map.getCenter(), map.getZoom(), true);
  });
};

function handleInputs(map) {
  const iterationsInput = document.getElementById("iterations");
  iterationsInput.value = maxIterations;
  iterationsInput.oninput = debounce(e => {
    let parsedValue = parseInt(e.target.value, 10);
    if (isNaN(parsedValue) || parsedValue < 1) {
      parsedValue = 200;
    }
    iterationsInput.value = parsedValue;
    maxIterations = parsedValue;
    refreshMap(map);
  }, 1000);
  const workersInput = document.getElementById("workers");
  workersInput.value = numWorkers;
  workersInput.oninput = debounce(e => {
    let parsedValue = parseInt(e.target.value, 10);
    if (isNaN(parsedValue) || parsedValue < 1) {
      parsedValue = initNumWorkers;
    } else if (parsedValue > 20) {
      parsedValue = 20;
    }
    workersInput.value = parsedValue;
    numWorkers = parsedValue;
    refreshMap(map);
  }, 1000);
  const smoothingInput = document.getElementById("smoothing");
  smoothingInput.checked = true;
  smoothingInput.onclick = e => {
    isSmoothed = e.target.checked;
    refreshMap(map);
  };
  document.getElementById("refresh").onclick = () => refreshMap(map);
}

function createMap() {
  const map = L.map('leaflet-map', { attributionControl: false, maxZoom: 32, zoomAnimationThreshold: 32 }).setView([0, 0], 2);
  const tiles = new L.GridLayer({ tileSize: 256 });
  tiles.createTile = createTile;
  tiles.addTo(map);
  handleInputs(map);
}

resetWorkers().then(createMap);