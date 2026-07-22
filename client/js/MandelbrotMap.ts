import * as L from "leaflet";
import { Pool } from "threads";
import MandelbrotLayer from "./MandelbrotLayer";
import { QueuedTask } from "threads/dist/master/pool-types";
import MandelbrotControls from "./MandelbrotControls";
import ImageSaver from "./ImageSaver";
import ZoomAnimator from "./ZoomAnimator";
import PointTooltip from "./PointTooltip";
import NavigatorPanel from "./NavigatorPanel";
import RegionRenderer from "./RegionRenderer";
import TileCache, { buildPaletteCdf, CachedTile } from "./TileCache";
import {
  buildShareUrl,
  coloringOptions,
  isFixedPaletteMethod,
  MandelbrotConfig,
  parseShareParams,
} from "./config";
import {
  RecolorResponse,
  TaskThread,
  TileRect,
  WorkerRequest,
} from "./protocol";
import { decimalDigitsForZoom, offsetCoordinate } from "./highPrecision";
import { drawTierOverlay } from "./tierOverlay";

type QueuedTileTask = {
  id: string;
  position: L.Coords;
  task: QueuedTask<TaskThread, void>;
};

type MapWithResetView = L.Map & {
  _resetView: (center: L.LatLng | [number, number], zoom: number) => void;
};

export type TilePosition = {
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
// perturbation at the standard tile resolution (MIN_DIRECT_PIXEL_SPACING in
// mandelbrot/src/perturbation.rs; supersampled tiles switch a level or two
// earlier); used only to decide whether pool spawn should warm the
// perturbation kernel.
const DEEP_ZOOM_THRESHOLD = 46;
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
  // Worker count of the current pool, for consumers that size their own
  // concurrency to it (the zoom animator's frame pipeline).
  poolSize: number;
  // Resolves once every worker in the current pool has spawned and finished
  // its warmup renders; the tile layer holds the initial batch until then
  // (see queueTileGeneration).
  poolSpawned: Promise<void>;
  regionRenderer: RegionRenderer;
  imageSaver: ImageSaver;
  zoomAnimator: ZoomAnimator;
  pointTooltip: PointTooltip;
  navigatorPanel: NavigatorPanel;
  queuedTileTasks: QueuedTileTask[] = [];
  origin: { re: string; im: string };
  zoomOffset: number;
  tileCache = new TileCache();
  // The viewport-global equalization table for histogram coloring, or null
  // for the linear mapping. Built from the visible escape-value distribution
  // over the current palette window (rebuildPaletteCdf) and passed to every
  // tile render and recolor, so the two stay byte-identical and tiles share
  // one mapping (no seams).
  paletteCdf: Float32Array | null = null;
  // Increments whenever a recolor pass or full re-render starts, so stale
  // in-flight recolor results are dropped instead of painting mixed palettes.
  private recolorGeneration = 0;
  // Increments whenever the render parameters change (a refresh, an
  // iteration-cap edit): tiles requested under an older generation still
  // paint, but their escape data describes superseded settings and must not
  // enter the cache, where it would skew palette detection.
  renderGeneration = 0;
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
    this.mapId = htmlId;
    this.origin = { re: initialConfig.re, im: initialConfig.im };
    this.zoomOffset = 0;
    this.initialConfig = { ...initialConfig };
    this.config = { ...initialConfig };
    // Apply any share-URL parameters before the pool spawns or any tile is
    // requested: the spawn warmups are chosen by the view's depth and
    // power, and the first (and only) tile batch should be the target
    // view. The previous order spawned a pool against the default view, let
    // setView request throwaway default-view tiles, then terminated that
    // pool and spawned a second one once the URL was parsed — two full
    // spawn+warmup cycles serialized on every shared-link load.
    this.setConfigFromUrl();
    await this.createPool();
    this.regionRenderer = new RegionRenderer(this);
    this.mandelbrotLayer = new MandelbrotLayer().addTo(this);
    this.addLoadingSpinnerControl();
    this.controls = new MandelbrotControls(this);
    this.imageSaver = new ImageSaver(this);
    this.zoomAnimator = new ZoomAnimator(this);
    this.pointTooltip = new PointTooltip(this);
    this.navigatorPanel = new NavigatorPanel(this);

    // Anchor the world origin at the target coordinates (latLng (0, 0), the
    // center of Leaflet's tile universe) and set the initial view; for a
    // plain load this.config still holds the defaults.
    this.goToCoordinates(this.config.re, this.config.im, this.config.zoom);
    this.setupEventListeners();
    // The initial setView fired before the listeners above existed, so sync
    // the coordinate inputs (and the zoom scale caption) to the starting
    // view once.
    this.controls.throttleSetCoordinateInputValues();
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

    this.setupModifierCursor();
  }

  /** Shows a crosshair cursor while any shortcut modifier is held over the
   * map: shift (zoom box), alt/option (center point), and ctrl (inspect
   * point) all target an exact point or region. */
  private setupModifierCursor() {
    const update = (event: KeyboardEvent | MouseEvent) => {
      this.getContainer().classList.toggle(
        "crosshair-cursor",
        event.shiftKey || event.altKey || event.ctrlKey,
      );
    };
    this.on("mousemove", (event: L.LeafletMouseEvent) =>
      update(event.originalEvent),
    );
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    // Modifier state is no longer observable after a focus loss.
    window.addEventListener("blur", () =>
      this.getContainer().classList.remove("crosshair-cursor"),
    );
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

  /** The tile coordinate at `zoom` whose `tileCoordinateOffset` is the given
   * offset from the world origin — the inverse mapping, for callers that pin
   * a region in complex-plane units (like the minimap's fixed window) and
   * need its tile-space bounds. */
  tileCoordinateForOffset(offset: number, zoom: number): number {
    const scaleFactor = this.mandelbrotLayer.getTileSize().x / 128;
    return ((offset + 4) / scaleFactor) * 2 ** (zoom - 2);
  }

  latLngToTilePosition(latLng: L.LatLng, z: number): TilePosition {
    const point = this.project(latLng, z).unscaleBy(
      this.mandelbrotLayer.getTileSize(),
    );

    return { x: point.x, y: point.y };
  }

  /** The complex-plane coordinates of a map location as arbitrary-precision
   * decimal strings. */
  coordinatesAtLatLng(latLng: L.LatLng): { re: string; im: string } {
    const zoom = this.getZoom();
    const position = this.latLngToTilePosition(latLng, zoom);
    const digits = decimalDigitsForZoom(this.effectiveZoom);

    return {
      re: offsetCoordinate(
        this.origin.re,
        this.tileCoordinateOffset(position.x, zoom),
        this.zoomOffset,
        digits,
      ),
      im: offsetCoordinate(
        this.origin.im,
        -this.tileCoordinateOffset(position.y, zoom),
        this.zoomOffset,
        digits,
      ),
    };
  }

  /** The current view center as arbitrary-precision decimal strings. */
  currentCenterCoordinates(): { re: string; im: string } {
    return this.coordinatesAtLatLng(this.getCenter());
  }

  /** The complex-plane offset of a map location from the view center, as
   * ordinary floats. `tileCoordinateOffset` is affine, so the difference of
   * two offsets is exact in f64 even where the absolute coordinates need
   * arbitrary precision; the shared `2^-zoomOffset` deep-zoom scale is
   * returned separately (as `zoomOffset`) so a caller can render the tiny
   * value in scientific notation without underflowing f64. */
  offsetFromCenterAtLatLng(latLng: L.LatLng): {
    re: number;
    im: number;
    zoomOffset: number;
  } {
    const zoom = this.getZoom();
    const cursor = this.latLngToTilePosition(latLng, zoom);
    const center = this.latLngToTilePosition(this.getCenter(), zoom);

    return {
      re:
        this.tileCoordinateOffset(cursor.x, zoom) -
        this.tileCoordinateOffset(center.x, zoom),
      im:
        this.tileCoordinateOffset(center.y, zoom) -
        this.tileCoordinateOffset(cursor.y, zoom),
      zoomOffset: this.zoomOffset,
    };
  }

  /** The absolute complex coordinate of a map location as ordinary f64. Only
   * meaningful at shallow zoom (where `zoomOffset` is 0 and the origin fits in
   * f64); deep-zoom callers must use the arbitrary-precision
   * `coordinatesAtLatLng`. Used by the Julia panel, whose parameter `c` is an
   * f64 pair. */
  complexAtLatLngFloat(latLng: L.LatLng): { re: number; im: number } {
    const zoom = this.getZoom();
    const position = this.latLngToTilePosition(latLng, zoom);
    const scale = 2 ** -this.zoomOffset;
    return {
      re:
        Number(this.origin.re) +
        this.tileCoordinateOffset(position.x, zoom) * scale,
      im:
        Number(this.origin.im) -
        this.tileCoordinateOffset(position.y, zoom) * scale,
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

  /** Fits the palette mapping to the visible pixels: in auto palette mode
   * the window bounds (center-weighted detected range) are applied to the
   * config and inputs, and under histogram coloring the equalization CDF is
   * rebuilt over the (possibly updated) window in both auto and manual
   * window modes — a pan changes the visible distribution, and with it the
   * CDF, even when the bounds are the user's. Only fits from a settled view:
   * while tiles are still rendering the cache is a biased sample
   * (fast-escaping exterior tiles land first), so mid-load callers keep the
   * last settled fit and the load handler — which runs after the loading
   * flag clears — applies the complete one. Returns whether anything the
   * coloring depends on (bounds or CDF) changed, so callers know a recolor
   * is needed even when the bounds alone didn't move. */
  applyDetectedPaletteRange(): boolean {
    if (this.layerLoading) {
      return false;
    }

    let changed = false;

    if (this.config.paletteAutoFit) {
      const range = this.tileCache.detectedRange(this.mapBoundsInTileSpace);
      if (range) {
        changed =
          this.config.paletteMinIter !== range.min ||
          this.config.paletteMaxIter !== range.max;

        this.config.paletteMinIter = range.min;
        this.config.paletteMaxIter = range.max;
        if (changed) {
          // The histogram's bound markers track the config, so the fit
          // moving the bounds must repaint them. Optional-chained: the fit
          // can run before the controls (which own the histogram) are
          // constructed.
          this.controls?.refreshPaletteHistogram();
        }
      }
    }

    return this.rebuildPaletteCdf() || changed;
  }

  /** Rebuilds the viewport-global equalization CDF from the visible
   * histogram and the current palette window, blended toward the identity by
   * the color-mapping slider (histogramColoring); cleared at strength 0 (fully
   * linear) and in the fixed-palette render modes (which ignore the window).
   * With no visible histogram to build from (all tiles interior, or none
   * reporting — e.g. right after leaving a fixed-palette mode) the previous
   * table is kept as the provisional mapping, exactly like the window bounds
   * are. Returns whether the table changed, which requires a recolor even
   * when the window bounds didn't move. */
  private rebuildPaletteCdf(): boolean {
    if (
      this.config.histogramColoring <= 0 ||
      isFixedPaletteMethod(this.config)
    ) {
      const changed = this.paletteCdf !== null;
      this.paletteCdf = null;
      return changed;
    }

    const stats = this.tileCache.viewStats(this.mapBoundsInTileSpace);
    if (!stats) {
      return false;
    }

    const cdf = buildPaletteCdf(
      stats,
      {
        min: this.config.paletteMinIter,
        max: this.config.paletteMaxIter,
      },
      this.config.histogramColoring / 100,
    );

    const previous = this.paletteCdf;
    const unchanged =
      (cdf === null && previous === null) ||
      (cdf !== null &&
        previous !== null &&
        cdf.length === previous.length &&
        cdf.every((entry, index) => entry === previous[index]));

    this.paletteCdf = cdf;
    return !unchanged;
  }

  /** Draws the precision-tier diagnostics overlay (issue #50) on a tile
   * canvas, when the overlay toggle is on. A no-op otherwise, so it can be
   * called unconditionally after any tile paint. */
  private paintTierOverlay(canvas: HTMLCanvasElement, tier: number) {
    if (this.config.showTierOverlay) {
      drawTierOverlay(canvas, tier);
    }
  }

  /** Applies a toggle of the tier overlay to the on-screen tiles without
   * re-rendering: turning it on draws the overlay on each cached tile;
   * turning it off recolors the tiles from their cached escape values (an
   * in-place repaint that clears the overlay along with restoring the exact
   * pixels). Tiles still rendering pick up the new state when they land
   * (MandelbrotLayer reads the flag at paint time). */
  applyTierOverlayToggle() {
    if (this.config.showTierOverlay) {
      for (const tile of this.tileCache.tilesAtZoom(this.getZoom())) {
        drawTierOverlay(tile.canvas, tile.tier);
      }
    } else {
      // Recoloring repaints each tile from its escape values, overwriting the
      // overlay-tinted border and badge with clean pixels.
      this.recolorVisibleTiles();
    }
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
            coloring: coloringOptions(this.config, this.paletteCdf),
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
        const context = tile.canvas.getContext("2d");
        context?.putImageData(imageData, 0, 0);
        this.paintTierOverlay(tile.canvas, tile.tier);
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
      return [
        {
          context,
          imageData,
          oldPixels,
          newPixels,
          canvas: tile.canvas,
          tier: tile.tier,
        },
      ];
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
          // the worker's exact pixels, then redraw the diagnostics overlay
          // (issue #50) on top of the settled pixels.
          for (const fade of fades) {
            fade.context.putImageData(fade.imageData, 0, 0);
            this.paintTierOverlay(fade.canvas, fade.tier);
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
   * the old colors; the tile layer rewrites each of them with the live
   * settings when its escape values arrive. */
  applyColorSettings() {
    this.recolorVisibleTiles();
    // The Julia thumbnail uses the same palette; keep it in step.
    this.navigatorPanel?.refresh();
    // The histogram panel's palette strip shows these same colors.
    this.controls?.refreshPaletteHistogram();
  }

  /** Applies an explicit palette-window or color-mapping change (a marker
   * drag, the histogram-coloring slider) without re-rendering: rebuild the
   * equalization CDF for the new window — under histogram coloring it spans
   * exactly the window, so moving a bound reshapes the table — then repaint
   * in place. Unlike the settle-time fits this skips the mid-load guard: the
   * user is acting on the histogram they can see, so the rebuild uses the
   * same (possibly still-loading) data; the load handler's full fit follows
   * as usual. */
  applyPaletteWindowChange() {
    this.rebuildPaletteCdf();
    this.recolorVisibleTiles();
    // The Julia thumbnail follows the same color-mapping setting.
    this.navigatorPanel?.refresh();
    // The histogram panel's palette strip warps with the mapping.
    this.controls?.refreshPaletteHistogram();
  }

  /** Applies an explicit palette-range action (a reset, or enabling
   * auto-adjust) without re-rendering: in auto mode fit to the on-screen
   * tiles, then repaint in place. */
  refitPaletteAndRecolor() {
    this.applyDetectedPaletteRange();
    this.recolorVisibleTiles();
    // The refit moved the palette bounds; keep the histogram markers in step.
    this.controls?.refreshPaletteHistogram();
    // The Julia thumbnail maps its escape counts over the same palette range.
    this.navigatorPanel?.refresh();
  }

  /** Runs when every visible tile has finished rendering: fit the palette to
   * the complete view (auto mode) and repaint if the fit moved anything.
   * Mid-load color changes need no handling here — each arriving tile
   * rewrites itself with the live settings (see MandelbrotLayer). */
  private handleTilesLoaded() {
    if (this.applyDetectedPaletteRange()) {
      this.recolorVisibleTiles();
    }
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
    // Power-2 loads skip both entirely (see worker.js).
    const isMultibrot = Boolean(this.config?.power && this.config.power !== 2);
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
      !isMultibrot && !warmFloatExpKernel && initialZoom >= DEEP_ZOOM_THRESHOLD;
    const poolSize = renderPoolSize();
    this.poolSize = poolSize;
    let spawnedWorkers = 0;
    let signalPoolSpawned: () => void;
    this.poolSpawned = new Promise((resolve) => {
      signalPoolSpawned = resolve;
    });
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
      if (++spawnedWorkers === poolSize) {
        signalPoolSpawned();
      }
      return worker;
    }, poolSize);
  }

  async refresh(resetView = false) {
    this.applyDetectedPaletteRange();
    // Every tile re-renders below: cached escape data is stale (it may
    // describe a different iteration cap), and in-flight recolor results
    // must not paint over the fresh tiles.
    this.invalidateTileCache();
    this.recolorGeneration += 1;
    await this.createPool();
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
    return buildShareUrl(this.config);
  }

  /** Applies share-URL parameters to the config, then strips them from the
   * address bar. Runs before the controls exist (initializeMap creates them
   * right after); their constructor syncs every input from the config values
   * written here. */
  setConfigFromUrl() {
    const parsed = parseShareParams(window.location.search);
    if (Object.keys(parsed).length === 0) {
      return;
    }

    Object.assign(this.config, parsed);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

export default MandelbrotMap;
