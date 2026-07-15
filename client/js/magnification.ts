// Converts between the map's internal zoom unit and the magnification shown
// in the coordinates panel. Internally (share URLs, worker protocol, bench
// corpora) the view depth stays a Leaflet-style effective zoom level;
// magnification is presentation only, following the convention of fractal
// explorers like Ultra Fractal and Kalles Fraktaler: 1x at the initial
// full-set view, doubling per zoom level, scientific notation once large.
//
// Effective zoom is unbounded (up to 10^6 via the input), so the
// magnification 2^(zoom - FULL_SET_ZOOM) can far exceed f64 range and the
// conversions work in log space.

// The whole set fits the viewport at the initial desktop zoom.
export const FULL_SET_ZOOM = 3;

const LOG10_2 = Math.log10(2);

// Magnifications below this are shown exactly; from here up, scientific
// notation is more readable than a long run of digits.
const SCIENTIFIC_NOTATION_MIN_LOG10 = 6;

/** The magnification of the given effective zoom as a display string, e.g.
 * "1", "524288", "1.05e6", "5.63e14". */
export function formatMagnification(effectiveZoom: number): string {
  const doublings = effectiveZoom - FULL_SET_ZOOM;
  const log10 = doublings * LOG10_2;

  if (log10 < SCIENTIFIC_NOTATION_MIN_LOG10) {
    // Exact for integer zooms (a power of two well within f64); fractional
    // zooms, possible via hand-edited share URLs, get a rounded value.
    const value = 2 ** doublings;
    return Number.isInteger(value)
      ? String(value)
      : String(Number(value.toPrecision(4)));
  }

  let exponent = Math.floor(log10);
  // Three significant digits keep the string short while still parsing back
  // to the same zoom level (a level is ~30% in magnification; the rounding
  // error here is under 1%).
  let mantissa = Number((10 ** (log10 - exponent)).toPrecision(3));
  if (mantissa >= 10) {
    mantissa /= 10;
    exponent += 1;
  }
  return `${mantissa}e${exponent}`;
}

/** Parses a magnification entered in the panel ("32", "0.5", "1,024",
 * "5.63e14", "2e2077") into the nearest effective zoom level, or null when
 * the text isn't a positive number. Exponents beyond f64 range are fine:
 * the value is never materialized, only its logarithm. */
export function zoomFromMagnification(raw: string): number | null {
  const cleaned = raw
    .trim()
    .replace(/,/g, "")
    .replace(/\s*[x×]$/i, "");
  const match = /^(\d+(?:\.\d+)?|\.\d+)(?:[eE]([+-]?\d+))?$/.exec(cleaned);
  if (!match) {
    return null;
  }

  const mantissa = Number.parseFloat(match[1]);
  if (!Number.isFinite(mantissa) || mantissa <= 0) {
    return null;
  }
  const exponent = match[2] ? Number.parseInt(match[2], 10) : 0;

  const doublings = (Math.log10(mantissa) + exponent) / LOG10_2;
  // The map renders whole zoom levels; snap to the nearest one. The panel
  // then redisplays the exact magnification of the level actually shown.
  return Math.round(FULL_SET_ZOOM + doublings);
}
