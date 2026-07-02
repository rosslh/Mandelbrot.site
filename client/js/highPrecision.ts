// Arbitrary-precision coordinate arithmetic for deep zooms.
//
// Beyond zoom level ~44, complex-plane coordinates need more precision than
// JavaScript numbers provide, so coordinates are tracked as decimal strings.
// The only arithmetic the client needs is "origin + offset * 2^-zoomOffset",
// computed here with decimal.js. The heavy rendering math happens in
// Rust/WASM, which parses the same decimal strings.

import Decimal from "decimal.js";

// Stricter than what decimal.js accepts: the Rust-side parser (and share
// URLs) only understand plain or scientific decimal notation.
const DECIMAL_PATTERN = /^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/;

export function isValidDecimalCoordinate(value: string): boolean {
  return DECIMAL_PATTERN.test(value.trim());
}

/** Decimal digits needed to address a pixel at the given effective zoom. */
export function decimalDigitsForZoom(effectiveZoom: number): number {
  // One bit is ~0.302 decimal digits; add headroom for sub-pixel accuracy.
  return Math.max(6, Math.ceil((Math.max(effectiveZoom, 0) + 32) * 0.30103));
}

/**
 * Computes `origin + offset * 2^-zoomOffset`, where `origin` is a decimal
 * string and `offset` is an ordinary float. Returns a plain (non-exponential)
 * decimal string rounded to `digits` fractional digits.
 */
export function offsetCoordinate(
  origin: string,
  offset: number,
  zoomOffset: number,
  digits: number,
): string {
  if (!Number.isFinite(offset)) {
    throw new Error(`Invalid coordinate offset: ${offset}`);
  }

  // A local constructor so precision can scale with zoom depth without
  // mutating global decimal.js configuration. The huge exponent bounds keep
  // toString() in plain notation for values of any magnitude.
  const HighPrecisionDecimal = Decimal.clone({
    precision: digits + 12,
    toExpNeg: -9e15,
    toExpPos: 9e15,
  });

  const scaledOffset = new HighPrecisionDecimal(offset).div(
    HighPrecisionDecimal.pow(2, zoomOffset),
  );
  const result = new HighPrecisionDecimal(origin)
    .plus(scaledOffset)
    .toDecimalPlaces(digits);

  return result.isZero() ? "0" : result.toString();
}
