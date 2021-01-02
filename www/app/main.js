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
import debounce from "debounce";

let maxIterations = 200;
let isSmoothed = true;
const numWorkers = Math.min(navigator.hardwareConcurrency || 6, 10);
let workers = [];

function createWorker() {
  const w = {
    worker: new Worker("./worker.js"),
    activeJobs: [],
    ready: false
  };
  const workerReadyHandler = e => {
    if (e.data.ready) {
      w.worker.removeEventListener("message", workerReadyHandler); // collect garbage
      w.ready = true;
    }
  };
  w.worker.addEventListener("message", workerReadyHandler);
  return w;
}

async function resetWorkers() {
  workers.forEach(({ worker }) => worker.terminate()); // terminate old workers/jobs
  workers = [...Array(numWorkers)].map(createWorker);
  while (!workers.some(w => w.ready)) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

function createTile(coords, done) {
  const tile = L.DomUtil.create('canvas', 'leaflet-tile');
  const ctx = tile.getContext('2d');
  tile.width = 256;
  tile.height = 256;
  const coordsString = JSON.stringify(coords);
  const selectedWorker = workers.filter(w => w.ready).sort((a, b) => (a.activeJobs.length > b.activeJobs.length) ? 1 : -1)[0];
  if (!selectedWorker) {
    alert("Sorry! Something went wrong. Try refreshing your page.");
    return tile;
  }
  selectedWorker.activeJobs.push(coordsString);
  const tileRetrievedHandler = e => {
    if (e.data.coords === coordsString) {
      selectedWorker.worker.removeEventListener("message", tileRetrievedHandler); // collect garbage
      selectedWorker.activeJobs = selectedWorker.activeJobs.filter(j => j !== coordsString);
      const imageData = new ImageData(Uint8ClampedArray.from(e.data.pixels), 256, 256);
      ctx.putImageData(imageData, 0, 0);
      done(undefined, tile);
    }
  };
  selectedWorker.worker.addEventListener("message", tileRetrievedHandler);
  selectedWorker.worker.postMessage({ coords, maxIterations, isSmoothed });
  return tile;
}

function createMap() {
  const tiles = new L.GridLayer({ tileSize: 256 });
  tiles.createTile = createTile;
  const options = { attributionControl: false, noWrap: true, maxZoom: 32, zoomAnimationThreshold: 1000, scrollWheelZoom: true };
  const map = L.map('leaflet-map', options).setView([0, 0], 2);
  tiles.addTo(map);
  return map;
}

function refreshMap(map) {
  map._resetView(map.getCenter(), map.getZoom(), true);
};

function handleInputs(map) {
  const iterationsInput = document.getElementById("iterations");
  iterationsInput.value = maxIterations;
  iterationsInput.oninput = debounce(e => {
    let parsedValue = Number(e.target.value);
    if (isNaN(parsedValue) || parsedValue < 1) {
      parsedValue = 200;
    }
    iterationsInput.value = parsedValue;
    maxIterations = parsedValue;
    resetWorkers().then(() => {
      refreshMap(map);
    })
  }, 500);
  const smoothingInput = document.getElementById("smoothing");
  smoothingInput.checked = true;
  smoothingInput.onclick = e => {
    isSmoothed = e.target.checked;
    resetWorkers().then(() => {
      refreshMap(map);
    })
  };
}

resetWorkers().then(() => handleInputs(createMap()));