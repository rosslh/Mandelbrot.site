import throttle from "lodash/throttle";
import * as L from "leaflet";
import { saveAs } from "file-saver";
import domToImage from "dom-to-image";
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

    const { re: re_min, im: im_min } = this.tilePositionToComplexParts(
      sw.x,
      sw.y,
      this.getZoom()
    );
    const { re: re_max, im: im_max } = this.tilePositionToComplexParts(
      ne.x,
      ne.y,
      this.getZoom()
    );

    return { re_min, re_max, im_min, im_max };
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

  async saveImage() {
    const zoomControl = this.zoomControl;
    const mapElement = document.getElementById(this.mapId);
    const width = mapElement.offsetWidth;
    const height = mapElement.offsetHeight;
    this.removeControl(zoomControl);
    const blob = await domToImage.toBlob(mapElement, { width, height });
    this.addControl(zoomControl);
    saveAs(
      blob,
      `mandelbrot${Date.now()}r${config.re}im${config.im}z${config.zoom}.png`
    );
  }

  saveLargeImage() {
    const sideLength = Number(
      prompt("Enter the side length of the image in pixels")
    );
    if (!sideLength || Number.isNaN(sideLength)) {
      return;
    }

    const bounds = this.mapBoundsAsComplexParts;

    const diffRe = bounds.re_max - bounds.re_min;
    const diffIm = bounds.im_max - bounds.im_min;
    if (diffRe > diffIm) {
      bounds.im_min -= (diffRe - diffIm) / 2;
      bounds.im_max += (diffRe - diffIm) / 2;
    } else {
      bounds.re_min -= (diffIm - diffRe) / 2;
      bounds.re_max += (diffIm - diffRe) / 2;
    }

    this.mandelbrotLayer.getSingleImage(bounds, sideLength, (imageCanvas) => {
      imageCanvas.toBlob((blob) => {
        saveAs(
          blob,
          `mandelbrot${Date.now()}r${config.re}im${config.im}z${
            config.zoom
          }.png`
        );
      });
    });
  }
}

export default MandelbrotMap;
