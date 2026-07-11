// Turns an effective zoom level into a human-scale comparison, e.g. "If the
// set were the size of Earth, your view would be the size of a coin."
//
// Each zoom level halves the view, so if the full set were scaled to an
// anchor object, the view spans anchorMeters / 2^(zoom - FULL_SET_ZOOM).
// Effective zoom is unbounded (up to 10^6 via the input), so all comparisons
// are done in log space to avoid overflowing f64.

// The whole set fits the viewport at the initial desktop zoom.
const FULL_SET_ZOOM = 3;

type ScaleObject = { name: string; meters: number };

// Anchors, smallest first. An anchor is used until the view under it drops
// below an atom, then the next one takes over — so the everyday rungs repeat
// under each anchor and only the final anchor descends into the subatomic.
const ANCHORS: ScaleObject[] = [
  { name: "Earth", meters: 1.27e7 },
  { name: "the Milky Way", meters: 9.5e20 },
  { name: "the observable universe", meters: 8.8e26 },
];

const TARGETS: ScaleObject[] = [
  { name: "a continent", meters: 5e6 },
  { name: "a country", meters: 1e6 },
  { name: "a city", meters: 3e4 },
  { name: "a neighborhood", meters: 2e3 },
  { name: "a football field", meters: 1e2 },
  { name: "a house", meters: 1e1 },
  { name: "a car", meters: 4 },
  { name: "a person", meters: 1.7 },
  { name: "a cat", meters: 0.45 },
  { name: "a coin", meters: 2e-2 },
  { name: "an ant", meters: 4e-3 },
  { name: "a grain of sand", meters: 5e-4 },
  { name: "a grain of pollen", meters: 3e-5 },
  { name: "a red blood cell", meters: 8e-6 },
  { name: "a bacterium", meters: 2e-6 },
  { name: "a virus", meters: 1e-7 },
  { name: "a DNA strand", meters: 2e-9 },
  { name: "an atom", meters: 1e-10 },
  { name: "a gamma ray's wavelength", meters: 1e-12 },
  { name: "an atomic nucleus", meters: 1e-14 },
  { name: "a proton", meters: 1.7e-15 },
  // Quark and neutrino "sizes" are experimental upper bounds / pop-science
  // convention (both are point-like in the Standard Model), matching the
  // rungs used by well-known scale-of-the-universe visualizations.
  { name: "a quark", meters: 1e-19 },
  { name: "a neutrino", meters: 1e-24 },
  { name: "a Planck length", meters: 1.6e-35 },
];

const PLANCK_METERS = 1.6e-35;
const ANCHOR_SWITCH_METERS = 1e-10; // an atom

/** Returns the scale comparison for the given effective zoom, or null when
 * the whole set is in view and there is nothing to compare. */
export function describeZoomScale(effectiveZoom: number): string | null {
  const doublings = effectiveZoom - FULL_SET_ZOOM;
  if (doublings < 1) {
    return null;
  }

  const anchor =
    ANCHORS.find(
      (candidate) =>
        Math.log2(candidate.meters) - doublings >=
        Math.log2(ANCHOR_SWITCH_METERS),
    ) ?? ANCHORS[ANCHORS.length - 1];
  const viewLog2 = Math.log2(anchor.meters) - doublings;

  // Deeper than a Planck length even at the largest anchor: no physical
  // object is left to compare against, so switch to the numeric fallback
  // immediately rather than lingering on the Planck target.
  if (viewLog2 < Math.log2(PLANCK_METERS)) {
    const powersOfTenBelowPlanck = Math.round(
      (Math.log2(PLANCK_METERS) - viewLog2) * Math.log10(2),
    );
    if (powersOfTenBelowPlanck < 1) {
      return `If the set were the size of ${anchor.name}, your view would be smaller than a Planck length.`;
    }
    return `If the set were the size of ${anchor.name}, your view would be 10^${powersOfTenBelowPlanck} times smaller than a Planck length.`;
  }

  let target = TARGETS[0];
  for (const candidate of TARGETS) {
    if (
      Math.abs(Math.log2(candidate.meters) - viewLog2) <
      Math.abs(Math.log2(target.meters) - viewLog2)
    ) {
      target = candidate;
    }
  }

  return `If the set were the size of ${anchor.name}, your view would be the size of ${target.name}.`;
}
