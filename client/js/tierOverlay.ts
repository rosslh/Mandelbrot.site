// The diagnostics overlay that tints each tile by the precision tier the
// renderer picked for it (issue #50). The wasm reports a tier per tile (see
// `MandelbrotTile::tier` in mandelbrot/src/lib.rs); when the overlay toggle is
// on, each tile's canvas gets a tinted border and a small corner badge drawn
// on top of its rendered pixels, with a legend keying the colors.

// Numeric tier discriminants, mirroring the Rust `RenderTier` enum. Must stay
// in sync with mandelbrot/src/lib.rs.
export const RenderTier = {
  Direct: 0,
  Perturbation: 1,
  FloatExp: 2,
} as const;

export type RenderTierValue = (typeof RenderTier)[keyof typeof RenderTier];

type TierStyle = {
  label: string;
  // Short badge text; the full name lives in the legend.
  badge: string;
  color: string;
};

// One entry per tier, indexed by the numeric discriminant. Colors are chosen
// to read clearly over any palette (bright, saturated, distinct hues) and
// match the legend in index.html.
const TIER_STYLES: Record<number, TierStyle> = {
  [RenderTier.Direct]: {
    label: "Direct f64",
    badge: "f64",
    color: "#4ade80",
  },
  [RenderTier.Perturbation]: {
    label: "Perturbation f64",
    badge: "pf64",
    color: "#facc15",
  },
  [RenderTier.FloatExp]: {
    label: "Hybrid float-exp",
    badge: "fexp",
    color: "#f472b6",
  },
};

/** The tiers in overlay order, for building the legend. */
export function tierLegendEntries(): Array<{ label: string; color: string }> {
  return [RenderTier.Direct, RenderTier.Perturbation, RenderTier.FloatExp].map(
    (tier) => ({
      label: TIER_STYLES[tier].label,
      color: TIER_STYLES[tier].color,
    }),
  );
}

/** Draws the tier's tinted border and corner badge onto a tile canvas, over
 * the already-painted pixels. A no-op for an unknown tier so a future tier
 * never throws. Border/badge sizes scale with the canvas so supersampled
 * tiles (up to 8x the edge length) get a proportionate, not hairline,
 * overlay. */
export function drawTierOverlay(canvas: HTMLCanvasElement, tier: number): void {
  const style = TIER_STYLES[tier];
  if (!style) {
    return;
  }
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const size = Math.min(canvas.width, canvas.height);
  const borderWidth = Math.max(2, Math.round(size / 40));

  context.save();

  // Tinted inset border.
  context.strokeStyle = style.color;
  context.lineWidth = borderWidth;
  context.strokeRect(
    borderWidth / 2,
    borderWidth / 2,
    canvas.width - borderWidth,
    canvas.height - borderWidth,
  );

  // Corner badge: a filled chip with the short tier label.
  const fontSize = Math.max(9, Math.round(size / 14));
  context.font = `600 ${fontSize}px system-ui, sans-serif`;
  context.textBaseline = "top";
  const paddingX = Math.round(fontSize * 0.5);
  const paddingY = Math.round(fontSize * 0.3);
  const textWidth = context.measureText(style.badge).width;
  const chipWidth = textWidth + paddingX * 2;
  const chipHeight = fontSize + paddingY * 2;
  const chipX = borderWidth;
  const chipY = borderWidth;

  context.fillStyle = "rgba(0, 0, 0, 0.65)";
  context.fillRect(chipX, chipY, chipWidth, chipHeight);
  context.fillStyle = style.color;
  context.fillText(style.badge, chipX + paddingX, chipY + paddingY);

  context.restore();
}
