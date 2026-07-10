import * as L from "leaflet";
import { FunctionThread, Pool } from "threads";
import MandelbrotLayer from "./MandelbrotLayer";
import { QueuedTask } from "threads/dist/master/pool-types";
import MandelbrotControls from "./MandelbrotControls";
import ImageSaver from "./ImageSaver";
import TileCache, { CachedTile } from "./TileCache";
import {
  decimalDigitsForZoom,
  isValidDecimalCoordinate,
  offsetCoordinate,
} from "./highPrecision";

export type MandelbrotConfig = {
  iterations: number;
  exponent: number;
  colorScheme: string;
  lightenAmount: number;
  saturateAmount: number;
  shiftHueAmount: number;
  colorSpace: number;
  reverseColors: boolean;
  highDpiTiles: boolean;
  smoothColoring: boolean;
  paletteMinIter: number;
  paletteMaxIter: number;
  // When enabled the palette range fits itself to the on-screen tiles and
  // the min/max inputs become read-only displays; when disabled they are
  // the user's to edit.
  paletteAutoAdjust: boolean;

  // Coordinates are decimal strings because deep zooms exceed f64 precision.
  re: string;
  im: string;
  zoom: number;
};

// Worker Request/Response Types
export type MandelbrotRequest = {
  type: "calculate";
  payload: import("./MandelbrotLayer").WasmRequestPayload; // Use import type for circular dependency
};
export type OptimisePayload = { buffer: ArrayBuffer };
export type OptimiseRequest = { type: "optimise"; payload: OptimisePayload };
export type RecolorPayload = {
  // Per-pixel smoothed escape values captured when the tile was rendered.
  values: Float32Array;
  colorScheme: string;
  reverseColors: boolean;
  shiftHueAmount: number;
  saturateAmount: number;
  lightenAmount: number;
  colorSpace: number;
  paletteMinIter: number;
  paletteMaxIter: number;
};
export type RecolorRequest = { type: "recolor"; payload: RecolorPayload };
// Tier-up warmup for the deep general-exponent (multibrot) perturbation
// kernel; returns nothing. Sent once per worker at pool spawn when the
// view's exponent != 2 and it is already at deep-zoom depth.
export type WarmupGeneralRequest = { type: "warmupGeneral" };
// Tier-up warmup for the direct-tier general-exponent stream kernel;
// returns nothing. Sent once per worker at pool spawn when the view's
// exponent != 2 at direct depth (effective zoom < DEEP_ZOOM_THRESHOLD).
export type WarmupGeneralDirectRequest = { type: "warmupGeneralDirect" };
// Tier-up warmup for the perturbation-f64 stream kernel; returns nothing.
// Sent once per worker at pool spawn when the view is already at deep-zoom
// depth (exponent 2, effective zoom >= DEEP_ZOOM_THRESHOLD).
export type WarmupDeepRequest = { type: "warmupDeep" };
// Tier-up warmup for the hybrid float-exp stream kernel; returns nothing.
// Sent once per worker at pool spawn when the view is already at float-exp
// depth (exponent 2, effective zoom >= FLOAT_EXP_THRESHOLD).
export type WarmupFloatExpRequest = { type: "warmupFloatExp" };
export type WorkerRequest =
  | MandelbrotRequest
  | OptimiseRequest
  | RecolorRequest
  | WarmupGeneralRequest
  | WarmupGeneralDirectRequest
  | WarmupDeepRequest
  | WarmupFloatExpRequest;

export type MandelbrotResponse = {
  image: Uint8Array;
  // Per-pixel smoothed escape values for recoloring; null when the request
  // did not ask for them (offscreen image export).
  values: Float32Array | null;
  // Escaped-pixel iteration range of the tile; null when the tile is
  // entirely inside the set.
  minIter: number | null;
  maxIter: number | null;
};
export type OptimiseResponse = ArrayBuffer;
export type RecolorResponse = Uint8Array;
export type WorkerResponse =
  | MandelbrotResponse
  | OptimiseResponse
  | RecolorResponse;

type TaskThread = FunctionThread<[WorkerRequest], WorkerResponse>;

type QueuedTileTask = {
  id: string;
  position: L.Coords;
  task: QueuedTask<TaskThread, void>;
};

type MapWithResetView = L.Map & {
  _resetView: (center: L.LatLng | [number, number], zoom: number) => void;
};

// A rectangle in Leaflet tile coordinates. A tile coordinate `v` at `zoom`
// maps to the complex offset ((v / 2^(zoom - 2)) * (tileSize / 128) - 4)
// * 2^-zoomOffset from the world origin.
export type TileRect = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zoom: number;
};

type TilePosition = {
  x: number;
  y: number;
};

// Leaflet's internal math is f64, which runs out of precision around zoom 30.
// To zoom deeper, the world origin is periodically re-anchored to the current
// view center (tracked as an arbitrary-precision decimal string) and Leaflet's
// own zoom is reset to a small value; `zoomOffset` accumulates the difference.
// The effective zoom is `leafletZoom + zoomOffset` and is unbounded.
const MAX_LEAFLET_ZOOM = 26;
// Effective zoom where the wasm switches from the direct f64 loop to
// perturbation (DEEP_ZOOM_THRESHOLD in mandelbrot/src/perturbation.rs); used
// only to decide whether pool spawn should warm the perturbation kernel.
const DEEP_ZOOM_THRESHOLD = 47;
// Effective zoom where perturbation switches from f64 deltas to the hybrid
// float-exp kernel (FLOAT_EXP_THRESHOLD in mandelbrot/src/perturbation.rs);
// used only to pick the right spawn warmup.
const FLOAT_EXP_THRESHOLD = 250;
const MIN_LEAFLET_ZOOM_WITH_OFFSET = 8;
const REBASED_LEAFLET_ZOOM = 12;

// Size the tile-render pool to leave one logical core free. An unsized
// `threads` Pool defaults to `navigator.hardwareConcurrency` and pins every
// core at 100% while rendering, starving the rest of the system (video decode
// in other tabs stutters, fans spin up). Reserving a core keeps the OS
// scheduler able to service other work at a negligible cost to render latency.
function renderPoolSize(): number {
  const cores = navigator.hardwareConcurrency || 4;
  return Math.max(1, cores - 1);
}

// Duration of the opacity crossfade that eases freshly recolored tiles in
// over the old palette instead of swapping them abruptly.
const RECOLOR_FADE_MS = 220;

// A tile's freshly computed pixels, ready to be faded in over its canvas.
type TileRepaint = { tile: CachedTile; imageData: ImageData };

class MandelbrotMap extends L.Map {
  mandelbrotLayer: MandelbrotLayer;
  mapId: string;
  controls: MandelbrotControls;
  initialConfig: MandelbrotConfig;
  config: MandelbrotConfig;
  pool: Pool<TaskThread>;
  imageSaver: ImageSaver;
  queuedTileTasks: QueuedTileTask[] = [];
  origin: { re: string; im: string };
  zoomOffset: number;
  tileCache = new TileCache();
  // Increments whenever a recolor pass or full re-render starts, so stale
  // in-flight recolor results are dropped instead of painting mixed palettes.
  private recolorGeneration = 0;
  // Increments whenever the render parameters change (a refresh, an
  // iteration-cap edit): tiles requested under an older generation still
  // paint, but their escape data describes superseded settings and must not
  // enter the cache, where it would skew palette detection.
  renderGeneration = 0;
  // Set when a color setting changes while tiles are still rendering: those
  // tiles were requested with the old colors, so repaint once they all land.
  private recolorPendingOnLoad = false;
  // Drives the loading spinner beneath the zoom control: visible while the
  // layer is rendering tiles or any recolor pass is repainting them.
  private loadingSpinner: HTMLElement | null = null;
  private layerLoading = false;
  private activeRecolorPasses = 0;

  constructor({
    htmlId,
    initialConfig,
  }: {
    htmlId: string;
    initialConfig: MandelbrotConfig;
  }) {
    super(htmlId, {
      attributionControl: false,
      maxZoom: 60,
      zoomAnimationThreshold: 60,
      center: [0, 0],
    });

    this.initializeMap(htmlId, initialConfig);
  }

  private async initializeMap(htmlId: string, initialConfig: MandelbrotConfig) {
    await this.createPool();
    this.mapId = htmlId;
    this.origin = { re: initialConfig.re, im: initialConfig.im };
    this.zoomOffset = 0;
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.addLoadingSpinnerControl();
    this.initialConfig = { ...initialConfig };
    this.config = { ...initialConfig };
    this.controls = new MandelbrotControls(this);
    this.imageSaver = new ImageSaver(this, this.pool, this.mandelbrotLayer);

    // The world origin corresponds to latLng (0, 0), the center of Leaflet's
    // tile universe.
    this.setView([0, 0], this.initialConfig.zoom);
    this.setConfigFromUrl();
    this.setupEventListeners();
  }

  /** Adds the spinner to the same corner as the zoom control (after it, so
   * it stacks beneath) and hides/shows it with the loading state. */
  private addLoadingSpinnerControl() {
    const SpinnerControl = L.Control.extend({
      onAdd: () => L.DomUtil.create("div", "tile-loading-spinner"),
    });
    const control = new SpinnerControl({ position: "topleft" }).addTo(this);
    this.loadingSpinner = control.getContainer() ?? null;
  }

  private updateLoadingSpinner() {
    this.loadingSpinner?.classList.toggle(
      "visible",
      this.layerLoading || this.activeRecolorPasses > 0,
    );
  }

  private setupEventListeners() {
    this.on("drag", () => this.mandelbrotLayer.debounceTileGeneration.flush());
    this.on("click", this.handleMapClick);
    this.on(
      "load moveend zoomend viewreset resize",
      this.controls.throttleSetCoordinateInputValues,
    );
    this.on("move", this.controls.throttleSetCoordinateInputValues);
    // Apply the auto-fitted palette range at zoom boundaries: the new zoom's
    // tiles all render from scratch anyway, so the update costs nothing.
    this.on("zoomstart", () => {
      // A recolor pass fitted to the outgoing zoom must not keep painting
      // the retained tiles shown during the transition.
      this.recolorGeneration += 1;
      this.applyDetectedPaletteRange();
    });
    this.on("zoomend", () => {
      this.cancelTileTasksOnWrongZoom();
      this.rebaseOriginIfNeeded();
      this.controls.throttleSetCoordinateInputValues();
    });
    // The fit follows the viewport, so a pan settle can shift the detected
    // range even when no tile loads or unloads. Pans that do load tiles are
    // skipped here (applyDetectedPaletteRange refuses mid-load fits) and
    // handled by the layer's load handler instead.
    this.on("moveend", () => {
      if (this.applyDetectedPaletteRange()) {
        this.recolorVisibleTiles();
      }
    });
    // Keep the cache to Leaflet's loaded tile set; palette detection
    // further clips it to the pixels actually on screen.
    this.mandelbrotLayer.on("tileunload", (event: L.TileEvent) => {
      this.tileCache.remove(event.coords);
    });
    this.mandelbrotLayer.on("loading", () => {
      this.layerLoading = true;
      this.updateLoadingSpinner();
    });
    // Fires once every visible tile has finished rendering: fit the palette
    // to the complete view in one step.
    this.mandelbrotLayer.on("load", () => {
      this.layerLoading = false;
      // May start a recolor pass, which keeps the spinner up until the
      // repaint lands.
      this.handleTilesLoaded();
      this.updateLoadingSpinner();
    });
    // The initial render kicks off before these listeners attach, so its
    // "loading" event has already fired; seed the state instead.
    this.layerLoading = this.mandelbrotLayer.isLoading();
    this.updateLoadingSpinner();
  }

  get effectiveZoom(): number {
    return this.getZoom() + this.zoomOffset;
  }

  /** The offset of a tile coordinate from the world origin, before the
   * additional 2^-zoomOffset deep-zoom scaling. */
  tileCoordinateOffset(value: number, zoom: number): number {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    return (value / 2 ** (zoom - 2)) * scaleFactor - 4;
  }

  private latLngToTilePosition(latLng: L.LatLng, z: number): TilePosition {
    const point = this.project(latLng, z).unscaleBy(
      this.mandelbrotLayer.getTileSize(),
    );

    return { x: point.x, y: point.y };
  }

  /** The current view center as arbitrary-precision decimal strings. */
  currentCenterCoordinates(): { re: string; im: string } {
    const zoom = this.getZoom();
    const center = this.latLngToTilePosition(this.getCenter(), zoom);
    const digits = decimalDigitsForZoom(this.effectiveZoom);

    return {
      re: offsetCoordinate(
        this.origin.re,
        this.tileCoordinateOffset(center.x, zoom),
        this.zoomOffset,
        digits,
      ),
      im: offsetCoordinate(
        this.origin.im,
        -this.tileCoordinateOffset(center.y, zoom),
        this.zoomOffset,
        digits,
      ),
    };
  }

  public get mapBoundsInTileSpace(): TileRect {
    const zoom = this.getZoom();
    const bounds = this.getBounds();
    const southWest = this.latLngToTilePosition(bounds.getSouthWest(), zoom);
    const northEast = this.latLngToTilePosition(bounds.getNorthEast(), zoom);

    return {
      xMin: southWest.x,
      xMax: northEast.x,
      yMin: northEast.y,
      yMax: southWest.y,
      zoom,
    };
  }

  /** In auto palette mode, applies the iteration range detected from the
   * visible pixels (center-weighted) to the config and inputs, so the next
   * render or recolor uses it. Only fits from a settled view: while tiles
   * are still rendering the cache is a biased sample (fast-escaping exterior
   * tiles land first), so mid-load callers keep the last settled fit and the
   * load handler — which runs after the loading flag clears — applies the
   * complete one. Returns whether the applied values changed. */
  applyDetectedPaletteRange(): boolean {
    if (!this.config.paletteAutoAdjust || this.layerLoading) {
      return false;
    }

    const range = this.tileCache.detectedRange(this.mapBoundsInTileSpace);
    if (!range) {
      return false;
    }

    const changed =
      this.config.paletteMinIter !== range.min ||
      this.config.paletteMaxIter !== range.max;

    this.config.paletteMinIter = range.min;
    this.config.paletteMaxIter = range.max;
    (document.getElementById("paletteMinIter") as HTMLInputElement).value =
      String(range.min);
    (document.getElementById("paletteMaxIter") as HTMLInputElement).value =
      String(range.max);

    return changed;
  }

  /** Recolors every cached on-screen tile in place with the current color
   * and palette settings — an O(pixels) pass over the cached escape values,
   * with no escape-time recomputation. */
  private async recolorVisibleTiles(): Promise<void> {
    const generation = ++this.recolorGeneration;
    const tiles = this.tileCache.tilesAtZoom(this.getZoom());

    this.activeRecolorPasses += 1;
    this.updateLoadingSpinner();
    try {
      await this.recolorTiles(tiles, generation);
    } finally {
      this.activeRecolorPasses -= 1;
      this.updateLoadingSpinner();
    }
  }

  private async recolorTiles(
    tiles: CachedTile[],
    generation: number,
  ): Promise<void> {
    // Compute every tile's new pixels before painting anything, so all tiles
    // fade to the new palette in one synchronized pass instead of popping
    // one by one as their worker results land.
    const repaints = await Promise.all(
      tiles.map(async (tile): Promise<TileRepaint | null> => {
        const request: WorkerRequest = {
          type: "recolor",
          payload: {
            values: tile.values,
            colorScheme: this.config.colorScheme,
            reverseColors: this.config.reverseColors,
            shiftHueAmount: this.config.shiftHueAmount,
            saturateAmount: this.config.saturateAmount,
            lightenAmount: this.config.lightenAmount,
            colorSpace: this.config.colorSpace,
            paletteMinIter: this.config.paletteMinIter,
            paletteMaxIter: this.config.paletteMaxIter,
          },
        };

        try {
          const image = (await this.pool.queue((worker) =>
            worker(request),
          )) as RecolorResponse;

          return {
            tile,
            imageData: new ImageData(
              Uint8ClampedArray.from(image),
              tile.width,
              tile.height,
            ),
          };
        } catch {
          // The pool was terminated by a full re-render, which repaints
          // every tile anyway.
          return null;
        }
      }),
    );

    // A newer recolor pass or a full re-render supersedes this result.
    if (generation !== this.recolorGeneration) {
      return;
    }

    await this.crossfadeTiles(
      repaints.filter((repaint): repaint is TileRepaint => repaint !== null),
      generation,
    );
  }

  /** Paints the new tile images with a short opacity crossfade, all tiles in
   * lockstep: each frame redraws the snapshotted old pixels and blends the
   * new image on top at rising alpha, then lands on an exact putImageData.
   * Bails out mid-fade when a newer recolor pass or a full re-render bumps
   * the generation, since that pass repaints every tile itself. */
  private crossfadeTiles(
    repaints: TileRepaint[],
    generation: number,
  ): Promise<void> {
    if (
      repaints.length === 0 ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      for (const { tile, imageData } of repaints) {
        tile.canvas.getContext("2d")?.putImageData(imageData, 0, 0);
      }
      return Promise.resolve();
    }

    const fades = repaints.flatMap(({ tile, imageData }) => {
      const context = tile.canvas.getContext("2d");
      if (!context) {
        return [];
      }
      // Snapshot the currently displayed pixels (possibly themselves
      // mid-fade toward a superseded palette) and stage the new image on a
      // canvas of its own: putImageData ignores alpha compositing, so the
      // blend has to go through drawImage.
      const oldPixels = document.createElement("canvas");
      oldPixels.width = tile.width;
      oldPixels.height = tile.height;
      oldPixels.getContext("2d")?.drawImage(tile.canvas, 0, 0);
      const newPixels = document.createElement("canvas");
      newPixels.width = tile.width;
      newPixels.height = tile.height;
      newPixels.getContext("2d")?.putImageData(imageData, 0, 0);
      return [{ context, imageData, oldPixels, newPixels }];
    });

    return new Promise((resolve) => {
      // Anchored to the first frame's own timestamp: rAF timestamps are
      // vsync-aligned and can precede a performance.now() taken when the
      // fade is scheduled, and a negative progress would be silently
      // ignored by the globalAlpha setter, painting the new image at full
      // opacity for one frame.
      let start: number | null = null;
      const frame = (now: number) => {
        if (generation !== this.recolorGeneration) {
          resolve();
          return;
        }
        start ??= now;
        const progress = Math.min(1, (now - start) / RECOLOR_FADE_MS);
        if (progress === 1) {
          // The blended frames are compositing approximations; finish with
          // the worker's exact pixels.
          for (const fade of fades) {
            fade.context.putImageData(fade.imageData, 0, 0);
          }
          resolve();
          return;
        }
        for (const fade of fades) {
          fade.context.globalAlpha = 1;
          fade.context.drawImage(fade.oldPixels, 0, 0);
          fade.context.globalAlpha = progress;
          fade.context.drawImage(fade.newPixels, 0, 0);
          fade.context.globalAlpha = 1;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  /** Applies a color-only settings change (scheme, reversal, hue/saturation/
   * lightness sliders, color space) by recoloring the on-screen tiles in
   * place — these settings don't affect escape values, so no re-render is
   * needed in either palette mode. Tiles still rendering were requested with
   * the old colors; they are repainted when the layer finishes loading. */
  applyColorSettings() {
    if (this.mandelbrotLayer.isLoading()) {
      this.recolorPendingOnLoad = true;
    }
    this.recolorVisibleTiles();
  }

  /** Applies an explicit palette-range action (a reset, or enabling
   * auto-adjust) without re-rendering: in auto mode fit to the on-screen
   * tiles, then repaint in place. */
  refitPaletteAndRecolor() {
    if (this.mandelbrotLayer.isLoading()) {
      this.recolorPendingOnLoad = true;
    }
    this.applyDetectedPaletteRange();
    this.recolorVisibleTiles();
  }

  /** Runs when every visible tile has finished rendering: fit the palette to
   * the complete view (auto mode), and repaint tiles that landed with
   * out-of-date colors after a mid-load color change. */
  private handleTilesLoaded() {
    const rangeChanged = this.applyDetectedPaletteRange();
    if (rangeChanged || this.recolorPendingOnLoad) {
      this.recolorVisibleTiles();
    }
    this.recolorPendingOnLoad = false;
  }

  private handleMapClick = (e: L.LeafletMouseEvent) => {
    if (e.originalEvent.altKey) {
      this.setView(e.latlng, this.getZoom());
    }
  };

  /** Moves the world origin to the current view center so Leaflet's own zoom
   * and pixel coordinates stay well within f64 precision. */
  private rebaseOriginIfNeeded() {
    const leafletZoom = this.getZoom();
    const needsRebase =
      leafletZoom > MAX_LEAFLET_ZOOM ||
      (this.zoomOffset > 0 && leafletZoom < MIN_LEAFLET_ZOOM_WITH_OFFSET);

    if (!needsRebase) {
      return;
    }

    const effectiveZoom = Math.round(this.effectiveZoom);
    this.origin = this.currentCenterCoordinates();
    this.zoomOffset = Math.max(0, effectiveZoom - REBASED_LEAFLET_ZOOM);

    const mapWithResetView = this as unknown as MapWithResetView;
    mapWithResetView._resetView([0, 0], effectiveZoom - this.zoomOffset);
  }

  /** Navigates to the given coordinates by re-anchoring the world origin
   * there, so the target is exact at any zoom depth. */
  goToCoordinates(re: string, im: string, zoom: number) {
    this.origin = { re, im };
    this.zoomOffset =
      zoom > MAX_LEAFLET_ZOOM
        ? Math.max(0, Math.round(zoom) - REBASED_LEAFLET_ZOOM)
        : 0;

    const mapWithResetView = this as unknown as MapWithResetView;
    mapWithResetView._resetView([0, 0], zoom - this.zoomOffset);
  }

  private async cancelTileTasksOnWrongZoom() {
    this.queuedTileTasks = this.queuedTileTasks.filter(({ task, position }) => {
      if (position.z !== this.getZoom()) {
        task.cancel();
        return false;
      }
      return true;
    });
  }

  /** Drops the cached escape data and marks in-flight tile renders stale:
   * their results still paint, but no longer record into the cache, so tiles
   * computed under the superseded render parameters cannot repopulate it and
   * feed palette detection. */
  invalidateTileCache() {
    this.renderGeneration += 1;
    this.tileCache.clear();
  }

  private async createPool() {
    if (this.pool) {
      await this.pool.terminate(true);
    }
    const { Worker, spawn } = await import("threads");
    // Multibrot views run separate wasm kernels that the worker's init
    // warmup does not tier up; warm the one matching the view's depth during
    // spawn (before the pool hands the worker any tile) so multibrot tiles
    // never render under Liftoff. Direct-depth multibrot views render every
    // tile through the direct general stream kernel and deep ones through
    // the general perturbation kernel, so the two warmups are exclusive.
    // Exponent-2 loads skip both entirely (see worker.js).
    const isMultibrot = Boolean(
      this.config?.exponent && this.config.exponent !== 2,
    );
    const initialZoom = this.config?.zoom ?? 0;
    const warmGeneralKernel = isMultibrot && initialZoom >= DEEP_ZOOM_THRESHOLD;
    const warmGeneralDirectKernel =
      isMultibrot && initialZoom < DEEP_ZOOM_THRESHOLD;
    // Likewise for the exponent-2 perturbation kernels: only views already
    // at depth need one warm, and shallow views that later zoom past a
    // threshold tier it up naturally over their first few tiles. Views at
    // float-exp depth render every tile through the hybrid float-exp kernel,
    // not the perturbation-f64 one, so the two warmups are exclusive.
    const warmFloatExpKernel =
      !isMultibrot && initialZoom >= FLOAT_EXP_THRESHOLD;
    const warmDeepKernel =
      !isMultibrot &&
      !warmFloatExpKernel &&
      initialZoom >= DEEP_ZOOM_THRESHOLD;
    this.pool = Pool(async () => {
      const worker = await spawn(new Worker("./worker.js"));
      if (warmGeneralKernel) {
        await worker({ type: "warmupGeneral" });
      }
      if (warmGeneralDirectKernel) {
        await worker({ type: "warmupGeneralDirect" });
      }
      if (warmFloatExpKernel) {
        await worker({ type: "warmupFloatExp" });
      }
      if (warmDeepKernel) {
        await worker({ type: "warmupDeep" });
      }
      return worker;
    }, renderPoolSize());
  }

  async refresh(resetView = false) {
    this.applyDetectedPaletteRange();
    // Every tile re-renders below: cached escape data is stale (it may
    // describe a different iteration cap), and in-flight recolor results
    // must not paint over the fresh tiles.
    this.invalidateTileCache();
    this.recolorGeneration += 1;
    this.recolorPendingOnLoad = false;
    await this.createPool();
    this.imageSaver = new ImageSaver(this, this.pool, this.mandelbrotLayer);
    if (resetView) {
      this.goToCoordinates(
        this.initialConfig.re,
        this.initialConfig.im,
        this.initialConfig.zoom,
      );
    } else {
      this.goToCoordinates(this.config.re, this.config.im, this.config.zoom);
    }
  }

  getShareUrl() {
    const {
      re,
      im,
      zoom: z,
      iterations: i,
      exponent: e,
      colorScheme: c,
      reverseColors: r,
      shiftHueAmount: h,
      saturateAmount: s,
      lightenAmount: l,
      colorSpace: cs,
      paletteMinIter: pmin,
      paletteMaxIter: pmax,
      paletteAutoAdjust,
    } = this.config;

    const url = new URL(window.location.origin);

    Object.entries({
      re,
      im,
      z,
      i,
      e,
      c,
      r,
      h,
      s,
      l,
      cs,
      pmin,
      pmax,
      pm: paletteAutoAdjust ? "auto" : "manual",
    }).forEach(([key, value]) => {
      url.searchParams.set(key, String(value));
    });

    return url.toString();
  }

  setConfigFromUrl() {
    const queryParams = new URLSearchParams(window.location.search);
    const re = queryParams.get("re");
    const im = queryParams.get("im");
    const zoom = queryParams.get("z");
    const iterations = queryParams.get("i");
    const exponent = queryParams.get("e");
    const colorScheme = queryParams.get("c");
    const reverseColors = queryParams.get("r");
    const shiftHueAmount = queryParams.get("h");
    const saturateAmount = queryParams.get("s");
    const lightenAmount = queryParams.get("l");
    const colorSpace = queryParams.get("cs");
    const smoothColoring = queryParams.get("sc");
    const paletteMinIter = queryParams.get("pmin");
    const paletteMaxIter = queryParams.get("pmax");
    const paletteMode = queryParams.get("pm");

    if (
      re &&
      im &&
      zoom &&
      isValidDecimalCoordinate(re) &&
      isValidDecimalCoordinate(im)
    ) {
      this.config.re = re;
      this.config.im = im;
      this.config.zoom = Number(zoom);

      if (iterations) {
        this.config.iterations = Number(iterations);
        (document.getElementById("iterations") as HTMLInputElement).value =
          iterations;
      }
      if (exponent) {
        this.config.exponent = Number(exponent);
        (document.getElementById("exponent") as HTMLInputElement).value =
          exponent;
      }
      if (colorScheme) {
        this.config.colorScheme = colorScheme;
        (document.getElementById("colorScheme") as HTMLSelectElement).value =
          colorScheme;
      }
      if (reverseColors) {
        this.config.reverseColors = reverseColors === "true";
        (document.getElementById("reverseColors") as HTMLInputElement).checked =
          this.config.reverseColors;
      }
      if (shiftHueAmount) {
        this.config.shiftHueAmount = Number(shiftHueAmount);
        (document.getElementById("shiftHueAmount") as HTMLInputElement).value =
          shiftHueAmount;
      }
      if (saturateAmount) {
        this.config.saturateAmount = Number(saturateAmount);
        (document.getElementById("saturateAmount") as HTMLInputElement).value =
          saturateAmount;
      }
      if (lightenAmount) {
        this.config.lightenAmount = Number(lightenAmount);
        (document.getElementById("lightenAmount") as HTMLInputElement).value =
          lightenAmount;
      }
      if (colorSpace) {
        this.config.colorSpace = Number(colorSpace);
        (document.getElementById("colorSpace") as HTMLSelectElement).value =
          String(colorSpace);
      }
      if (smoothColoring) {
        this.config.smoothColoring = smoothColoring === "true";
        (
          document.getElementById("smoothColoring") as HTMLInputElement
        ).checked = this.config.smoothColoring;
      }
      if (paletteMinIter) {
        this.config.paletteMinIter = Number(paletteMinIter);
        (document.getElementById("paletteMinIter") as HTMLInputElement).value =
          paletteMinIter;
      }
      if (paletteMaxIter) {
        this.config.paletteMaxIter = Number(paletteMaxIter);
        (document.getElementById("paletteMaxIter") as HTMLInputElement).value =
          paletteMaxIter;
      }
      if (paletteMode === "auto" || paletteMode === "manual") {
        this.config.paletteAutoAdjust = paletteMode === "auto";
      } else if (paletteMinIter || paletteMaxIter) {
        // Legacy share URLs predate auto-adjust; explicit palette values
        // imply the sender tuned them by hand, so preserve that appearance.
        this.config.paletteAutoAdjust = false;
      }
      (
        document.getElementById("paletteAutoAdjust") as HTMLInputElement
      ).checked = this.config.paletteAutoAdjust;
      this.controls.syncAutoAdjustUi();

      window.history.replaceState({}, document.title, window.location.pathname);
      this.refresh();
    }
  }
}

export default MandelbrotMap;
