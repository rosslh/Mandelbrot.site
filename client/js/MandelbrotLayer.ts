import debounce from "lodash/debounce";
import * as L from "leaflet";
import type MandelbrotMap from "./MandelbrotMap";
import { MandelbrotResponse, TileRect, WorkerRequest } from "./protocol";

type Done = (error: null, tile: HTMLCanvasElement) => void;

// Idle time between the worker pool coming up (spawned + warmup renders done)
// and the initial tile batch dispatching, so the TurboFan compiles the
// warmups trigger can land before real tiles occupy every core (see
// queueTileGeneration).
const TIER_UP_GRACE_MS = 100;

// Fired (once per page load) when the first map tile finishes rendering.
// index.ts listens for this as proof that the served asset set is healthy and
// its one-shot cache-recovery guards can be re-armed.
export const firstTileRenderedEvent = "mandelbrot:first-tile-rendered";

let firstTileRendered = false;

function announceFirstTileRendered() {
  if (firstTileRendered) return;
  firstTileRendered = true;
  window.dispatchEvent(new Event(firstTileRenderedEvent));
}

type TileGenerationTask = {
  position: L.Coords;
  canvas: HTMLCanvasElement;
  done: Done;
};

class MandelbrotLayer extends L.GridLayer {
  tileSize: number;
  _map: MandelbrotMap;
  tilesToGenerate: TileGenerationTask[] = [];
  private initialBatchFlushScheduled = false;

  constructor() {
    super({
      noWrap: true,
      tileSize: 200,
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
    // The initial page-load burst is requested in a single tick, but the
    // trailing debounce would leave the worker pool idle for most of its wait
    // (~330 ms of pure latency on every load; workers are spawned and warmed
    // by ~140 ms — bench/LOG.md 2026-07-10). Flush shortly after the pool is
    // fully ready — not immediately: the spawn warmups only *trigger* the
    // wasm tier-up, and dispatching before that TurboFan compile lands makes
    // every worker's first heavy tile run its in-flight kernel call at
    // Liftoff speed while the busy workers starve the compile threads
    // (measured: intermittent +9..+20% on the heaviest direct grid). The
    // grace gives the compile a quiet machine to finish on. Later batches
    // (pan/zoom flurries, setting changes) keep the debounce.
    if (!this.initialBatchFlushScheduled) {
      this.initialBatchFlushScheduled = true;
      void this._map.poolSpawned.then(() => {
        setTimeout(() => this.debounceTileGeneration.flush(), TIER_UP_GRACE_MS);
      });
    }
  }

  refresh() {
    let currentMap: MandelbrotMap | null = null;
    if (this._map) {
      currentMap = this._map as MandelbrotMap;
      this.removeFrom(this._map);
    }
    this.addTo(currentMap);
  }

  private getTileRect(tilePosition: L.Coords): TileRect {
    return {
      xMin: tilePosition.x,
      xMax: tilePosition.x + 1,
      yMin: tilePosition.y,
      yMax: tilePosition.y + 1,
      zoom: tilePosition.z,
    };
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

    const bounds = this.getTileRect(tilePosition);

    const id =
      typeof crypto !== "undefined" && crypto
        ? crypto.randomUUID()
        : Date.now().toString();

    const tileTask = this._map.pool.queue(async (workerTask) => {
      // The render parameters are read here, when a worker picks the task
      // up, so remember which generation they belong to.
      const generation = this._map.renderGeneration;
      const request: WorkerRequest = {
        type: "calculate" as const,
        payload: this._map.regionRenderer.buildPayload(
          bounds,
          scaledTileSize,
          scaledTileSize,
          true,
        ),
      };
      const response = (await workerTask(request)) as MandelbrotResponse;

      const imageData = new ImageData(
        Uint8ClampedArray.from(response.image),
        scaledTileSize,
        scaledTileSize,
      );
      context.putImageData(imageData, 0, 0);
      // A generation bump mid-flight means this tile's escape data describes
      // superseded render parameters: still paint it (its neighbors look the
      // same), but keep it out of the cache.
      if (response.values && generation === this._map.renderGeneration) {
        this._map.tileCache.record(
          tilePosition,
          response.minIter,
          response.maxIter,
          canvas,
          response.values,
        );
      }
      announceFirstTileRendered();
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
