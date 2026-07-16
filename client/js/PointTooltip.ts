import * as L from "leaflet";
import throttle from "lodash/throttle";
import type MandelbrotMap from "./MandelbrotMap";
import { displayDigitsForZoom } from "./highPrecision";

const LOG10_2 = Math.log10(2);

// Digits to superscript characters, for scientific-notation exponents.
const SUPERSCRIPTS: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "-": "⁻",
};

// Deep-zoom coordinates run to hundreds of digits, so displayed values are
// trimmed to the decimals the cursor can distinguish (displayDigitsForZoom)
// and then, when still long, shown head…tail. The head keeps the sign and
// magnitude; the tail keeps the digits that change as the cursor moves.
// The full-precision center coordinate remains in the coordinates panel.
const HEAD_CHARS = 8;
const TAIL_CHARS = 15;

// Gap between the cursor and the tooltip's nearest edge.
const CURSOR_GAP_PX = 12;

// Minimum spacing between escape-time queries while the cursor moves. Each
// query is a one-pixel render, so this mostly bounds worker-pool traffic
// while tiles are rendering.
const QUERY_THROTTLE_MS = 150;

function formatCoordinate(value: string, displayDigits: number): string {
  const dot = value.indexOf(".");
  const trimmed = dot === -1 ? value : value.slice(0, dot + 1 + displayDigits);
  return trimmed.length > HEAD_CHARS + TAIL_CHARS + 1
    ? trimmed.slice(0, HEAD_CHARS) + "…" + trimmed.slice(-TAIL_CHARS)
    : trimmed;
}

function formatIterations(count: number): string {
  return `${count.toLocaleString()} iteration${count === 1 ? "" : "s"}`;
}

/** Formats `value × 2^-zoomOffset` in scientific notation with a superscript
 * exponent, e.g. "+3.2×10⁻⁴⁵". The deep-zoom scale is folded into the base-10
 * exponent in log space, so tiny values that would underflow f64 (zoomOffset
 * of hundreds) still render exactly. */
function formatScaledOffset(value: number, zoomOffset: number): string {
  const sign = value < 0 ? "−" : "+";
  if (value === 0) {
    return `${sign}0`;
  }

  const log10 = Math.log10(Math.abs(value)) - zoomOffset * LOG10_2;
  let exponent = Math.floor(log10);
  let mantissa = Number((10 ** (log10 - exponent)).toPrecision(2));
  if (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }

  const superscript = String(exponent)
    .split("")
    .map((char) => SUPERSCRIPTS[char])
    .join("");
  return `${sign}${mantissa}×10${superscript}`;
}

/** A cursor-following readout shown while ctrl is held over the fractal:
 * the complex-plane coordinates under the cursor, and the point's escape
 * time computed as a one-pixel render on the worker pool. Covers the hover
 * inspection asks of issues #11 (coordinates) and #38 (escape time). */
class PointTooltip {
  private map: MandelbrotMap;
  private element: HTMLDivElement;
  private reElement: HTMLDivElement;
  private imElement: HTMLDivElement;
  private offsetElement: HTMLDivElement;
  private escapeTimeElement: HTMLDivElement;
  // The most recent mouse position over the map, so pressing ctrl shows the
  // tooltip without waiting for the next mousemove. Null while the cursor
  // is off the map.
  private lastMouse: { containerPoint: L.Point; latLng: L.LatLng } | null =
    null;
  // Increments per escape-time query so stale in-flight results are dropped.
  private queryId = 0;

  constructor(map: MandelbrotMap) {
    this.map = map;

    this.element = document.createElement("div");
    this.element.className = "overlay point-tooltip";
    this.element.hidden = true;
    this.reElement = document.createElement("div");
    this.imElement = document.createElement("div");
    this.offsetElement = document.createElement("div");
    this.offsetElement.className = "point-tooltip-offset";
    this.escapeTimeElement = document.createElement("div");
    this.element.append(
      this.reElement,
      this.imElement,
      this.offsetElement,
      this.escapeTimeElement,
    );
    map.getContainer().appendChild(this.element);

    map.on("mousemove", (event: L.LeafletMouseEvent) => {
      this.lastMouse = {
        containerPoint: event.containerPoint,
        latLng: event.latlng,
      };
      if (event.originalEvent.ctrlKey) {
        this.show(event.containerPoint, event.latlng);
      } else {
        this.hide();
      }
    });
    map.on("mouseout", () => {
      this.lastMouse = null;
      this.hide();
    });
    // The view geometry under the cursor is about to change; the next
    // mousemove re-shows the tooltip with fresh values.
    map.on("movestart zoomstart", () => this.hide());

    window.addEventListener("keydown", (event) => {
      if (event.key === "Control" && !event.repeat && this.lastMouse) {
        this.show(this.lastMouse.containerPoint, this.lastMouse.latLng);
      }
    });
    window.addEventListener("keyup", (event) => {
      if (event.key === "Control") {
        this.hide();
      }
    });
    // Ctrl is no longer observable after a focus loss (e.g. cmd/alt-tab).
    window.addEventListener("blur", () => this.hide());
  }

  private show(containerPoint: L.Point, latLng: L.LatLng) {
    const { re, im } = this.map.coordinatesAtLatLng(latLng);
    const displayDigits = displayDigitsForZoom(this.map.effectiveZoom);
    this.reElement.textContent = `Re: ${formatCoordinate(re, displayDigits)}`;
    this.imElement.textContent = `Im: ${formatCoordinate(im, displayDigits)}`;
    this.showOffsetFromCenter(latLng, displayDigits);

    // On reveal, blank the escape time until the first result lands; while
    // already visible the previous value stays up (results arrive within a
    // throttle interval, and a steady value beats flicker).
    if (this.element.hidden) {
      this.escapeTimeElement.textContent = "Escape time: …";
      this.element.hidden = false;
    }

    this.positionAt(containerPoint);
    this.throttledQueryEscapeTime(latLng);
  }

  /** The cursor's offset from the view center, in scientific notation. It is
   * a genuinely tiny number where scientific notation is honest and compact,
   * and it changes with every pixel of movement — but only once it drops
   * below what the head…tail absolute display resolves (deep zoom), where it
   * complements the absolute coordinates rather than duplicating them. */
  private showOffsetFromCenter(latLng: L.LatLng, displayDigits: number) {
    const offset = this.map.offsetFromCenterAtLatLng(latLng);

    // The absolute coordinates resolve down to 10^-displayDigits; only show
    // the offset once it is smaller than that (and so no longer visible in
    // the absolute readout). The offset's base-10 exponent is dominated by
    // the shared 2^-zoomOffset scale.
    const largest = Math.max(Math.abs(offset.re), Math.abs(offset.im));
    const exponent =
      largest === 0
        ? -Infinity
        : Math.floor(Math.log10(largest) - offset.zoomOffset * LOG10_2);
    if (exponent >= -displayDigits) {
      this.offsetElement.hidden = true;
      return;
    }

    const re = formatScaledOffset(offset.re, offset.zoomOffset);
    const im = formatScaledOffset(offset.im, offset.zoomOffset);
    this.offsetElement.textContent = `Δ from center: ${re}, ${im}`;
    this.offsetElement.hidden = false;
  }

  private hide() {
    if (this.element.hidden) {
      return;
    }
    this.element.hidden = true;
    this.throttledQueryEscapeTime.cancel();
    // Drop any in-flight result so it cannot repaint a future reveal.
    this.queryId += 1;
  }

  /** Places the tooltip above the cursor, flipping below it near the top
   * edge and clamping horizontally to the map container. */
  private positionAt(containerPoint: L.Point) {
    const containerSize = this.map.getSize();
    const halfWidth = this.element.offsetWidth / 2;
    const left = Math.min(
      Math.max(containerPoint.x, halfWidth + CURSOR_GAP_PX / 2),
      containerSize.x - halfWidth - CURSOR_GAP_PX / 2,
    );
    const fitsAbove =
      containerPoint.y - this.element.offsetHeight - CURSOR_GAP_PX >= 0;

    this.element.style.left = `${left}px`;
    this.element.style.top = `${containerPoint.y + (fitsAbove ? -CURSOR_GAP_PX : CURSOR_GAP_PX)}px`;
    this.element.style.transform = fitsAbove
      ? "translate(-50%, -100%)"
      : "translate(-50%, 0)";
  }

  private throttledQueryEscapeTime = throttle((latLng: L.LatLng) => {
    const id = ++this.queryId;
    const zoom = this.map.getZoom();
    const position = this.map.latLngToTilePosition(latLng, zoom);

    this.map.regionRenderer
      .escapeIterationsAtPoint(position, zoom)
      .then((iterations) => {
        if (id !== this.queryId || this.element.hidden) {
          return;
        }
        this.escapeTimeElement.textContent =
          iterations === null
            ? `In set (>${formatIterations(this.map.config.iterations)})`
            : `Escape time: ${formatIterations(iterations)}`;
      })
      .catch(() => {
        // The pool was terminated by a re-render; the next hover retries.
      });
  }, QUERY_THROTTLE_MS);
}

export default PointTooltip;
