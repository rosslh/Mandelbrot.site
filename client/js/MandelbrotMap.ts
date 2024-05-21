import throttle from "lodash/throttle";
import * as L from "leaflet";
import { saveAs } from "file-saver";
import { Pool, Worker, spawn } from "threads";
import { MandelbrotLayer } from "./MandelbrotLayer";
import { config } from "./main";

class MandelbrotMap extends L.Map {
  mandelbrotLayer: MandelbrotLayer;
  mapId: string;
  defaultPosition: [number, number];
  defaultZoom: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pool: Pool<any>;

  constructor({ htmlId: mapId }: { htmlId: string }) {
    super(mapId, {
      attributionControl: false,
      maxZoom: 48,
      zoomAnimationThreshold: 48,
    });

    this.createPool();
    this.mapId = mapId;
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.defaultPosition = [0, 0];
    this.defaultZoom = 3;
    this.setView(this.defaultPosition, this.defaultZoom);

    this.on("drag", function () {
      this.mandelbrotLayer.debounceTileGeneration.flush();
    });
    this.on("click", this.handleMapClick);

    this.on("load", this.throttleSetDomElementValues);
    this.on("move", this.throttleSetDomElementValues);
    this.on("moveend", this.throttleSetDomElementValues);
    this.on("zoomend", this.throttleSetDomElementValues);
    this.on("viewreset", this.throttleSetDomElementValues);
    this.on("resize", this.throttleSetDomElementValues);
  }

  handleMapClick = (e: L.LeafletMouseEvent) => {
    if (e.originalEvent.altKey) {
      this.setView(e.latlng, this.getZoom());
    }
  };

  tilePositionToComplexParts(
    x: number,
    y: number,
    z: number
  ): { re: number; im: number } {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    const d = 2 ** (z - 2);
    const re = (x / d) * scaleFactor - 4;
    const im = (y / d) * scaleFactor - 4;
    return { re, im };
  }

  complexPartsToTilePosition(re: number, im: number, z: number) {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    const d = 2 ** (z - 2);
    const x = ((re + 4) * d) / scaleFactor;
    const y = ((im + 4) * d) / scaleFactor;
    return { x, y };
  }

  latLngToTilePosition(latLng: L.LatLng, z: number) {
    const point = this.project(latLng, z).unscaleBy(
      this.mandelbrotLayer.getTileSize()
    );

    return { x: point.x, y: point.y };
  }

  get mapBoundsAsComplexParts() {
    const bounds = this.getBounds();
    const sw = this.latLngToTilePosition(bounds.getSouthWest(), this.getZoom());
    const ne = this.latLngToTilePosition(bounds.getNorthEast(), this.getZoom());

    const { re: reMin, im: imMax } = this.tilePositionToComplexParts(
      sw.x,
      sw.y,
      this.getZoom()
    );
    const { re: reMax, im: imMin } = this.tilePositionToComplexParts(
      ne.x,
      ne.y,
      this.getZoom()
    );

    return { reMin, reMax, imMin, imMax };
  }

  private setDomElementValues = () => {
    const tileSize = [
      this.mandelbrotLayer.getTileSize().x,
      this.mandelbrotLayer.getTileSize().y,
    ];
    const point = this.project(this.getCenter(), this.getZoom()).unscaleBy(
      new L.Point(tileSize[0], tileSize[1])
    );

    const position = { ...point, z: this.getZoom() };

    const { re, im } = this.tilePositionToComplexParts(
      position.x,
      position.y,
      position.z
    );

    config.re = re;
    (<HTMLInputElement>document.getElementById("re")).value = String(re);

    config.im = im;
    (<HTMLInputElement>document.getElementById("im")).value = String(im);

    config.zoom = position.z;
    (<HTMLInputElement>document.getElementById("zoom")).value = String(
      position.z
    );

    (<HTMLAnchorElement>(
      document.getElementById("shareLink")
    )).href = `?re=${re}&im=${im}&z=${position.z}&i=${config.iterations}&e=${config.exponent}&c=${config.colorScheme}&r=${config.reverseColors}&sharing=true`;
  };

  private complexPartsToLatLng(re: number, im: number, z: number) {
    const tileSize = [
      this.mandelbrotLayer.getTileSize().x,
      this.mandelbrotLayer.getTileSize().y,
    ];

    const { x, y } = this.complexPartsToTilePosition(re, im, z);

    const latLng = this.unproject(
      L.point(x, y).scaleBy(new L.Point(tileSize[0], tileSize[1])),
      z
    );

    return latLng;
  }

  throttleSetDomElementValues = throttle(this.setDomElementValues, 200);

  async createPool() {
    if (this.pool) {
      this.pool.terminate(true);
    }

    this.pool = Pool(() => spawn(new Worker("./worker.js")));
  }

  async refresh(resetView = false) {
    await this.createPool();
    if (resetView) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._resetView(this.defaultPosition, this.defaultZoom);
    } else {
      const pointToCenter = this.complexPartsToLatLng(
        config.re,
        config.im,
        config.zoom
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (this as any)._resetView(pointToCenter, config.zoom);
    }
  }

  async saveVisibleImage(totalWidth: number, totalHeight: number) {
    const numColumns = 16;
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
        this.mandelbrotLayer.getSingleImage(subBounds, columnWidth, totalHeight)
      );
    }

    try {
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
          `mandelbrot${Date.now()}_r${config.re}_im${config.im}_z${
            config.zoom
          }.png`
        );
      });
    } catch (error) {
      alert(
        "Something went wrong generating your image. Please try again with a smaller image size."
      );
    }
  }
}

export default MandelbrotMap;
