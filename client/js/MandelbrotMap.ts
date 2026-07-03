import * as L from "leaflet";
import { FunctionThread, Pool } from "threads";
import MandelbrotLayer from "./MandelbrotLayer";
import { QueuedTask } from "threads/dist/master/pool-types";
import MandelbrotControls from "./MandelbrotControls";
import ImageSaver from "./ImageSaver";
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
  scaleWithIterations: boolean;

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
export type WorkerRequest = MandelbrotRequest | OptimiseRequest;

export type MandelbrotResponse = Uint8Array;
export type OptimiseResponse = ArrayBuffer;
export type WorkerResponse = MandelbrotResponse | OptimiseResponse;

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

  private setupEventListeners() {
    this.on("drag", () => this.mandelbrotLayer.debounceTileGeneration.flush());
    this.on("click", this.handleMapClick);
    this.on(
      "load moveend zoomend viewreset resize",
      this.controls.throttleSetCoordinateInputValues,
    );
    this.on("move", this.controls.throttleSetCoordinateInputValues);
    this.on("zoomend", () => {
      this.cancelTileTasksOnWrongZoom();
      this.rebaseOriginIfNeeded();
      this.controls.throttleSetCoordinateInputValues();
    });
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

  private async createPool() {
    if (this.pool) {
      await this.pool.terminate(true);
    }
    const { Worker, spawn } = await import("threads");
    this.pool = Pool(() => spawn(new Worker("./worker.js")), renderPoolSize());
  }

  async refresh(resetView = false) {
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
    } = this.config;

    const url = new URL(window.location.origin);

    Object.entries({ re, im, z, i, e, c, r, h, s, l, cs, pmin, pmax }).forEach(
      ([key, value]) => {
        url.searchParams.set(key, String(value));
      },
    );

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

      window.history.replaceState({}, document.title, window.location.pathname);
      this.refresh();
    }
  }
}

export default MandelbrotMap;
