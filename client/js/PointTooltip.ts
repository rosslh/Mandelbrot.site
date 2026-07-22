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
// The full-precision center coordinate remains in the Location panel.
const HEAD_CHARS = 8;
const TAIL_CHARS = 15;

// Gap between the cursor and the tooltip's nearest edge.
const CURSOR_GAP_PX = 12;

// Octicon copy-16 (https://icon-sets.iconify.design/octicon/), matching the
// copy button in the pinned-locations sidebar.
const COPY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"/><path fill="currentColor" d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>`;

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

/** Formats a positive distance in scientific notation with a superscript
 * exponent, e.g. "3.2×10⁻¹²". Distances span many orders of magnitude — from
 * order-1 far from the set to vanishingly small near the boundary at deep
 * zoom — so scientific notation is both honest and compact. */
function formatDistance(value: number): string {
  let exponent = Math.floor(Math.log10(value));
  let mantissa = Number((value / 10 ** exponent).toPrecision(2));
  if (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }

  const superscript = String(exponent)
    .split("")
    .map((char) => SUPERSCRIPTS[char])
    .join("");
  return `${mantissa}×10${superscript}`;
}

/** A cursor-following readout shown while ctrl is held over the fractal:
 * the complex-plane coordinates under the cursor, and the point's escape
 * time computed as a one-pixel render on the worker pool. Covers the hover
 * inspection asks of issues #11 (coordinates) and #38 (escape time).
 *
 * Clicking while inspecting pins the tooltip in place (issue #40): the pinned
 * copy stops following the cursor, swaps in the full-precision coordinates
 * (the hovering readout trims sub-pixel guard digits for legibility), and
 * exposes a copy button. Escape or a click elsewhere dismisses it. */
class PointTooltip {
  private map: MandelbrotMap;
  private element: HTMLDivElement;
  private reElement: HTMLDivElement;
  private imElement: HTMLDivElement;
  private offsetElement: HTMLDivElement;
  private escapeTimeElement: HTMLDivElement;
  private distanceElement: HTMLDivElement;
  private periodElement: HTMLDivElement;
  private copyButton: HTMLButtonElement;
  // The most recent mouse position over the map, so pressing ctrl shows the
  // tooltip without waiting for the next mousemove. Null while the cursor
  // is off the map.
  private lastMouse: { containerPoint: L.Point; latLng: L.LatLng } | null =
    null;
  // Increments per escape-time query so stale in-flight results are dropped.
  private queryId = 0;
  // Set once the tooltip is pinned: it stays put and stops tracking the
  // cursor until dismissed. Holds the full-precision coordinates that the
  // copy button writes to the clipboard.
  private pinned: { re: string; im: string } | null = null;

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
    this.distanceElement = document.createElement("div");
    this.periodElement = document.createElement("div");
    this.copyButton = document.createElement("button");
    this.copyButton.type = "button";
    this.copyButton.className = "point-tooltip-copy";
    this.copyButton.title = "Copy coordinates";
    this.copyButton.setAttribute("aria-label", "Copy coordinates");
    this.copyButton.innerHTML = COPY_ICON;
    this.copyButton.hidden = true;
    this.copyButton.onclick = (event) => {
      // Keep this click from reaching the map's click handler, which would
      // otherwise unpin the tooltip we're copying from.
      event.stopPropagation();
      this.copyPinnedCoordinates();
    };

    this.element.append(
      this.copyButton,
      this.reElement,
      this.imElement,
      this.offsetElement,
      this.escapeTimeElement,
      this.distanceElement,
      this.periodElement,
    );
    map.getContainer().appendChild(this.element);

    map.on("mousemove", (event: L.LeafletMouseEvent) => {
      this.lastMouse = {
        containerPoint: event.containerPoint,
        latLng: event.latlng,
      };
      if (this.pinned) {
        return;
      }
      if (event.originalEvent.ctrlKey) {
        this.show(event.containerPoint, event.latlng);
      } else {
        this.hide();
      }
    });
    map.on("mouseout", () => {
      this.lastMouse = null;
      if (!this.pinned) {
        this.hide();
      }
    });
    // Clicking while inspecting (ctrl held, tooltip up) pins the tooltip;
    // clicking anywhere else — an ordinary map interaction — dismisses a
    // pinned one. The map's own click handler only recenters on alt-click,
    // so a ctrl pin-click never collides with it.
    map.on("click", (event: L.LeafletMouseEvent) => {
      if (this.pinned) {
        this.unpin();
        this.hide();
      } else if (event.originalEvent.ctrlKey && !this.element.hidden) {
        this.pin(event.containerPoint, event.latlng);
      }
    });
    // The view geometry under the cursor is about to change; the next
    // mousemove re-shows the tooltip with fresh values. A pan or zoom also
    // strands a pinned tooltip on the wrong point, so drop it.
    map.on("movestart zoomstart", () => {
      this.unpin();
      this.hide();
    });

    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.pinned) {
        this.unpin();
        this.hide();
        return;
      }
      if (
        event.key === "Control" &&
        !event.repeat &&
        this.lastMouse &&
        !this.pinned
      ) {
        this.show(this.lastMouse.containerPoint, this.lastMouse.latLng);
      }
    });
    window.addEventListener("keyup", (event) => {
      // Releasing ctrl dismisses the hovering readout but leaves a pinned one
      // up — pinning is exactly what lets its values outlive the modifier.
      if (event.key === "Control" && !this.pinned) {
        this.hide();
      }
    });
    // Ctrl is no longer observable after a focus loss (e.g. cmd/alt-tab); a
    // pinned tooltip is deliberate and survives.
    window.addEventListener("blur", () => {
      if (!this.pinned) {
        this.hide();
      }
    });
  }

  /** Pins the tooltip at the clicked point: it stops following the cursor,
   * swaps the trimmed hover coordinates for the full-precision values, and
   * reveals the copy button. */
  private pin(containerPoint: L.Point, latLng: L.LatLng) {
    const { re, im } = this.map.coordinatesAtLatLng(latLng);
    this.pinned = { re, im };
    this.reElement.textContent = `Re: ${re}`;
    this.imElement.textContent = `Im: ${im}`;
    this.copyButton.hidden = false;
    this.element.classList.add("pinned");
    // Pinned values are selectable and the copy button clickable, unlike the
    // pointer-transparent hovering readout.
    this.element.style.pointerEvents = "auto";
    this.positionAt(containerPoint);
  }

  private unpin() {
    if (!this.pinned) {
      return;
    }
    this.pinned = null;
    this.copyButton.hidden = true;
    this.copyButton.title = "Copy coordinates";
    this.element.classList.remove("pinned");
    this.element.style.pointerEvents = "";
  }

  private copyPinnedCoordinates() {
    if (!this.pinned) {
      return;
    }
    navigator.clipboard
      .writeText(`${this.pinned.re}, ${this.pinned.im}`)
      .then(() => {
        this.copyButton.title = "Copied!";
      })
      .catch(() => {
        // Clipboard access can be denied; leave the button as-is.
      });
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
      this.distanceElement.textContent = "Distance: …";
      this.distanceElement.hidden = false;
      // Period applies only to in-set points; stay hidden until a result for
      // an in-set point arrives, rather than flash a placeholder that most
      // (exterior) hovers would immediately clear.
      this.periodElement.hidden = true;
      this.element.hidden = false;
    }

    this.positionAt(containerPoint);
    this.throttledQueryPointData(latLng);
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
    this.throttledQueryPointData.cancel();
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

  private throttledQueryPointData = throttle((latLng: L.LatLng) => {
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

    // The exterior distance estimate (#42): a scalar wasm loop with derivative
    // tracking, a separate query from the escape-time one-pixel render. Hidden
    // for in-set points, which have no exterior distance.
    this.map.regionRenderer
      .distanceToBoundaryAtPoint(position, zoom)
      .then((distance) => {
        if (id !== this.queryId || this.element.hidden) {
          return;
        }
        if (distance === null) {
          this.distanceElement.hidden = true;
          return;
        }
        this.distanceElement.textContent = `Distance: ≈${formatDistance(distance)}`;
        this.distanceElement.hidden = false;
      })
      .catch(() => {
        // The pool was terminated by a re-render; the next hover retries.
      });

    // The attracting-cycle period (#39): a scalar wasm loop that settles the
    // orbit then measures its cycle length. Only in-set points have a cycle,
    // so the row stays hidden for exterior points (and other exponents, which
    // the wasm reports as no period).
    this.map.regionRenderer
      .periodAtPoint(position, zoom)
      .then((period) => {
        if (id !== this.queryId || this.element.hidden) {
          return;
        }
        if (period === null) {
          this.periodElement.hidden = true;
          return;
        }
        this.periodElement.textContent = `Period: ${period.toLocaleString()}`;
        this.periodElement.hidden = false;
      })
      .catch(() => {
        // The pool was terminated by a re-render; the next hover retries.
      });
  }, QUERY_THROTTLE_MS);
}

export default PointTooltip;
