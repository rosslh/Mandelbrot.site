const numWorkers = 6; // TODO: use multiple workers
const workers = [...Array(numWorkers)].map((_, id) => ({
  id,
  worker: new Worker("./worker.js"),
  activeJobs: []
}));

function main() {
  const tiles = new L.GridLayer({ tileSize: 256 });
  tiles.createTile = function (coords, done) {
    const tile = L.DomUtil.create('canvas', 'leaflet-tile');
    const ctx = tile.getContext('2d');
    tile.width = 256;
    tile.height = 256;

    const coordsString = JSON.stringify(coords);
    const selectedWorker = workers.sort((a, b) => (a.activeJobs.length > b.activeJobs.length) ? 1 : -1)[0];
    selectedWorker.activeJobs.push(coordsString);

    selectedWorker.worker.addEventListener("message", e => {
      if (e.data.coords === coordsString) {
        selectedWorker.worker.removeEventListener("message", arguments.callee); // collect garbage
        selectedWorker.activeJobs = selectedWorker.activeJobs.filter(j => j !== coordsString);
        const imageData = new ImageData(Uint8ClampedArray.from(e.data.pixels), 256, 256);
        ctx.putImageData(imageData, 0, 0);
        done(undefined, tile);
      }
    });

    selectedWorker.worker.postMessage(coords);

    return tile;
  }
  const options = { noWrap: true, maxZoom: 1000, zoomAnimationThreshold: 1000, scrollWheelZoom: true };
  const myMap = L.map('mapid', options).setView([0, 0], 2);
  tiles.addTo(myMap);
}

setTimeout(main, 1000); // wait for worker to be ready