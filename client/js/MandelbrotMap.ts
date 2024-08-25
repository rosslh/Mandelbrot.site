import * as L from "leaflet";
import { saveAs } from "file-saver";
import { FunctionThread, Pool, Worker, spawn } from "threads";
import MandelbrotLayer from "./MandelbrotLayer";
import { QueuedTask } from "threads/dist/master/pool-types";
import MandelbrotControls from "./MandelbrotControls";
import type { ValidColorSpace } from "../../mandelbrot/pkg";

type MapWithResetView = MandelbrotMap & {
  _resetView: (center: L.LatLng | [number, number], zoom: number) => void;
};

type MandelbrotConfig = {
  iterations: number;
  exponent: number;

  colorScheme: string;
  reverseColors: boolean;
  lightenAmount: number;
  saturateAmount: number;
  shiftHueAmount: number;
  colorSpace: ValidColorSpace;

  highDpiTiles: boolean;

  re: number;
  im: number;
  zoom: number;
};

type WasmRequestPayload = Omit<
  MandelbrotConfig,
  "re" | "im" | "zoom" | "highDpiTiles"
> & {
  bounds: { reMin: number; reMax: number; imMin: number; imMax: number };
  imageWidth: number;
  imageHeight: number;
};

type MandelbrotThread = FunctionThread<[WasmRequestPayload], Uint8Array>;

class MandelbrotMap extends L.Map {
  mandelbrotLayer: MandelbrotLayer;
  mapId: string;
  controls: MandelbrotControls;
  initialConfig: MandelbrotConfig;
  config: MandelbrotConfig;
  pool: Pool<MandelbrotThread>;
  queuedTileTasks: {
    id: string;
    position: L.Coords;
    task: QueuedTask<MandelbrotThread, void>;
  }[] = [];

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

    this.createPool();
    this.mapId = htmlId;
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.initialConfig = { ...initialConfig };
    this.config = { ...initialConfig };
    this.controls = new MandelbrotControls(this);

    this.setView(
      [this.initialConfig.re, this.initialConfig.im],
      this.initialConfig.zoom,
    );

    this.setConfigFromUrl();

    this.on("drag", () => {
      this.mandelbrotLayer.debounceTileGeneration.flush();
    });
    this.on("click", this.handleMapClick);

    this.on("load", this.controls.throttleSetInputValues);
    this.on("move", this.controls.throttleSetInputValues);
    this.on("moveend", this.controls.throttleSetInputValues);
    this.on("zoomend", () => {
      this.cancelTileTasksOnWrongZoom();
      this.controls.throttleSetInputValues();
    });
    this.on("viewreset", this.controls.throttleSetInputValues);
    this.on("resize", this.controls.throttleSetInputValues);
  }

  tilePositionToComplexParts(
    x: number,
    y: number,
    z: number,
  ): { re: number; im: number } {
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

  private complexPartsToTilePosition(re: number, im: number, z: number) {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    const d = 2 ** (z - 2);
    const x = ((re + 4 - this.initialConfig.re) * d) / scaleFactor;
    const y = ((im + 4 - this.initialConfig.im) * d) / scaleFactor;
    return { x, y };
  }

  private latLngToTilePosition(latLng: L.LatLng, z: number) {
    const point = this.project(latLng, z).unscaleBy(
      this.mandelbrotLayer.getTileSize(),
    );

    return { x: point.x, y: point.y };
  }

  private get mapBoundsAsComplexParts() {
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

  private complexPartsToLatLng(re: number, im: number, z: number) {
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
      this.pool.terminate(true);
    }

    this.pool = Pool(() => spawn(new Worker("./worker.js")));
  }

  async refresh(resetView = false) {
    await this.createPool();
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._resetView(pointToCenter, this.config.zoom);
    }
  }

  async saveVisibleImage(totalWidth: number, totalHeight: number) {
    const numColumns = 24;
    const columnWidth = Math.ceil(totalWidth / numColumns);
    const bounds = this.mapBoundsAsComplexParts;

    const imageAspectRatio = totalWidth / totalHeight;
    const complexAspectRatio =
      (bounds.reMax - bounds.reMin) / (bounds.imMax - bounds.imMin);

    if (imageAspectRatio < complexAspectRatio) {
      const newImHeight = (bounds.reMax - bounds.reMin) / imageAspectRatio;
      const imCenter = (bounds.imMin + bounds.imMax) / 2;
      bounds.imMin = imCenter - newImHeight / 2;
      bounds.imMax = imCenter + newImHeight / 2;
    } else if (imageAspectRatio > complexAspectRatio) {
      const newReWidth = (bounds.imMax - bounds.imMin) * imageAspectRatio;
      const reCenter = (bounds.reMin + bounds.reMax) / 2;
      bounds.reMin = reCenter - newReWidth / 2;
      bounds.reMax = reCenter + newReWidth / 2;
    }

    const reDiff = bounds.reMax - bounds.reMin;
    const reDiffPerColumn = reDiff * (columnWidth / totalWidth);

    const imagePromises = [];
    for (let i = 0; i < numColumns; i++) {
      const subBounds = {
        ...bounds,
        reMin: bounds.reMin + reDiffPerColumn * i,
        reMax: bounds.reMin + reDiffPerColumn * (i + 1),
      };
      imagePromises.push(
        this.mandelbrotLayer.getImage(subBounds, columnWidth, totalHeight),
      );
    }

    const imageCanvases = await Promise.all(imagePromises);

    const finalCanvas = document.createElement("canvas");
    finalCanvas.width = totalWidth;
    finalCanvas.height = totalHeight;
    const ctx = finalCanvas.getContext("2d");

    let xOffset = 0;
    imageCanvases.forEach((canvas) => {
      ctx.drawImage(canvas, xOffset, 0);
      xOffset += canvas.width;
    });

    finalCanvas.toBlob((blob) => {
      saveAs(
        blob,
        `mandelbrot${Date.now()}_r${this.config.re}_im${this.config.im}_z${
          this.config.zoom
        }.png`,
      );
    });
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

      window.history.replaceState({}, document.title, window.location.pathname);
      this.refresh();
    }
  }
}

export default MandelbrotMap;
