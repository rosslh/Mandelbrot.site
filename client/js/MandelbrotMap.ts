import * as L from "leaflet";
import { FunctionThread, Pool } from "threads";
import MandelbrotLayer from "./MandelbrotLayer";
import { QueuedTask } from "threads/dist/master/pool-types";
import MandelbrotControls from "./MandelbrotControls";
import ImageSaver from "./ImageSaver";

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
  re: number;
  im: number;
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

export type ComplexBounds = {
  reMin: number;
  reMax: number;
  imMin: number;
  imMax: number;
};

type TilePosition = {
  x: number;
  y: number;
};

type ComplexParts = {
  re: number;
  im: number;
};

class MandelbrotMap extends L.Map {
  mandelbrotLayer: MandelbrotLayer;
  mapId: string;
  controls: MandelbrotControls;
  initialConfig: MandelbrotConfig;
  config: MandelbrotConfig;
  pool: Pool<TaskThread>;
  imageSaver: ImageSaver;
  queuedTileTasks: QueuedTileTask[] = [];

  constructor({
    htmlId,
    initialConfig,
  }: {
    htmlId: string;
    initialConfig: MandelbrotConfig;
  }) {
    super(htmlId, {
      attributionControl: false,
      maxZoom: 48,
      zoomAnimationThreshold: 48,
      center: [initialConfig.re, initialConfig.im],
    });

    this.initializeMap(htmlId, initialConfig);
  }

  private async initializeMap(htmlId: string, initialConfig: MandelbrotConfig) {
    await this.createPool();
    this.mapId = htmlId;
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.initialConfig = { ...initialConfig };
    this.config = { ...initialConfig };
    this.controls = new MandelbrotControls(this);
    this.imageSaver = new ImageSaver(this, this.pool, this.mandelbrotLayer);

    this.setView(
      [this.initialConfig.re, this.initialConfig.im],
      this.initialConfig.zoom,
    );
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
      this.controls.throttleSetCoordinateInputValues();
    });
  }

  tilePositionToComplexParts(x: number, y: number, z: number): ComplexParts {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    const d = 2 ** (z - 2);
    const re = (x / d) * scaleFactor - 4 + this.initialConfig.re;
    const im = (y / d) * scaleFactor - 4 + this.initialConfig.im;
    return { re, im };
  }

  private handleMapClick = (e: L.LeafletMouseEvent) => {
    if (e.originalEvent.altKey) {
      this.setView(e.latlng, this.getZoom());
    }
  };

  private complexPartsToTilePosition(
    re: number,
    im: number,
    z: number,
  ): TilePosition {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    const d = 2 ** (z - 2);
    const x = ((re + 4 - this.initialConfig.re) * d) / scaleFactor;
    const y = ((im + 4 - this.initialConfig.im) * d) / scaleFactor;
    return { x, y };
  }

  private latLngToTilePosition(latLng: L.LatLng, z: number): TilePosition {
    const point = this.project(latLng, z).unscaleBy(
      this.mandelbrotLayer.getTileSize(),
    );

    return { x: point.x, y: point.y };
  }

  public get mapBoundsAsComplexParts(): ComplexBounds {
    const bounds = this.getBounds();
    const sw = this.latLngToTilePosition(bounds.getSouthWest(), this.getZoom());
    const ne = this.latLngToTilePosition(bounds.getNorthEast(), this.getZoom());

    const { re: reMin, im: imMax } = this.tilePositionToComplexParts(
      sw.x,
      sw.y,
      this.getZoom(),
    );
    const { re: reMax, im: imMin } = this.tilePositionToComplexParts(
      ne.x,
      ne.y,
      this.getZoom(),
    );

    return { reMin, reMax, imMin, imMax };
  }

  private complexPartsToLatLng(re: number, im: number, z: number): L.LatLng {
    const tileSize = [
      this.mandelbrotLayer.getTileSize().x,
      this.mandelbrotLayer.getTileSize().y,
    ];

    const { x, y } = this.complexPartsToTilePosition(re, im, z);

    const latLng = this.unproject(
      L.point(x, y).scaleBy(new L.Point(tileSize[0], tileSize[1])),
      z,
    );

    return latLng;
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
    this.pool = Pool(() => spawn(new Worker("./worker.js")));
  }

  async refresh(resetView = false) {
    await this.createPool();
    this.imageSaver = new ImageSaver(this, this.pool, this.mandelbrotLayer);
    const mapWithResetView = this as unknown as MapWithResetView;
    if (resetView) {
      mapWithResetView._resetView(
        [this.initialConfig.re, this.initialConfig.im],
        this.initialConfig.zoom,
      );
    } else {
      const pointToCenter = this.complexPartsToLatLng(
        this.config.re,
        this.config.im,
        this.config.zoom,
      );
      mapWithResetView._resetView(pointToCenter, this.config.zoom);
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

    if (re && im && zoom) {
      this.config.re = Number(re);
      this.config.im = Number(im);
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
