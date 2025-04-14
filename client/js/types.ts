import * as L from "leaflet";
import { QueuedTask } from "threads/dist/master/pool-types";
import { FunctionThread } from "threads";

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

export type WasmRequestPayload = Omit<
  MandelbrotConfig,
  "zoom" | "highDpiTiles" | "re" | "im" | "scaleWithIterations"
> & {
  bounds: ComplexBounds;
  imageWidth: number;
  imageHeight: number;
};

export type NumberInput = {
  id:
    | "iterations"
    | "exponent"
    | "re"
    | "im"
    | "zoom"
    | "paletteMinIter"
    | "paletteMaxIter";
  minValue: number;
  maxValue: number;
  resetView?: boolean;
  allowFraction?: boolean;
};

export type SelectInput = {
  id: "colorScheme" | "colorSpace";
};

export type CheckboxInput = {
  id:
    | "reverseColors"
    | "highDpiTiles"
    | "smoothColoring"
    | "scaleWithIterations";
};

export type SliderInput = {
  id: "lightenAmount" | "saturateAmount" | "shiftHueAmount";
};

export type TileGenerationTask = {
  position: L.Coords;
  canvas: HTMLCanvasElement;
  done: (error: null, tile: HTMLCanvasElement) => void;
};

export type QueuedTileTask = {
  id: string;
  position: L.Coords;
  task: QueuedTask<MandelbrotThread, void>;
};

export type MandelbrotThread = FunctionThread<[WasmRequestPayload], Uint8Array>;

export type MapWithResetView = L.Map & {
  _resetView: (center: L.LatLng | [number, number], zoom: number) => void;
};

export type ComplexBounds = {
  reMin: number;
  reMax: number;
  imMin: number;
  imMax: number;
};

export type TilePosition = {
  x: number;
  y: number;
};

export type ComplexParts = {
  re: number;
  im: number;
};
