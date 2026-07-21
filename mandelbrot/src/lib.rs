#![allow(clippy::too_many_arguments)]

mod float_exp;
mod perturbation;
mod utils;

use once_cell::sync::Lazy;
use std::collections::HashMap;

#[cfg(test)]
#[path = "lib_test.rs"]
mod lib_test;

use itertools_num::linspace;
use num::complex::Complex64;
use palette::{FromColor, Hsl, Hsluv, IntoColor, Lch, Lighten, Okhsl, Saturate, ShiftHue, Srgb};
use serde::Deserialize;
use wasm_bindgen::prelude::*;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

const ESCAPE_RADIUS: f64 = 3.0;
type RgbColor = [u8; 3];

// First Brent-periodicity save point; the save interval doubles from here.
const PERIODICITY_FIRST_SAVE: u32 = 8;

// Periodicity is only checked every stride-th iteration to keep the check off
// the hot path. Saves happen at multiples of the stride (8, 16, 32, ...), so
// once the orbit sits exactly on a cycle of period p, some later iteration
// n = save + k*p is divisible by the stride and detection stays guaranteed.
const PERIODICITY_CHECK_STRIDE: u32 = 4;

// Number of f64x2 vectors the streaming escape kernels keep in flight
// (2 pixels per vector). Each vector is an independent FP dependency chain.
// With deferred escape checks both kernels' per-step loops are light enough
// that 6 chains fit without spills (each re-swept 4/6/8 after its deferral
// ship: 6 fastest, 8 in between). The general kernel keeps 6 in BOTH lanes:
// re-swept 4/6/8 x stride 32/64/128 after the relaxed-FMA fused-c step
// (2026-07-10) — powu's per-chain temporaries make 8 spill (+9% on the e6
// heavy) and 4 starve the pipeline (+44%).
#[cfg(target_arch = "wasm32")]
const STREAM_CHAINS: usize = 6;
// The relaxed-simd FMA step has a shorter critical path (2 vs 3), so the
// quadratic kernel needs more chains in flight to fill the pipeline:
// re-swept 4/6/8/10 x stride 16/32/64 after the FMA ship (2026-07-10).
// 8 chains x 4 v128 state vectors exactly fills a 32-register file - 10
// spills (+10%). Stride 64 gains another -10..-13% on the heavies, paid by
// low-escape-count views (seahorse class +23%, +1.6 ms) - accepted on
// absolute-time grounds. The simd128 fallback build keeps its own measured
// optimum, 6/32; stride and chains never affect output (the boundary
// replay recovers exact escape steps at any stride).
#[cfg(all(target_arch = "wasm32", target_feature = "relaxed-simd"))]
const QUADRATIC_STREAM_CHAINS: usize = 8;
#[cfg(all(target_arch = "wasm32", not(target_feature = "relaxed-simd")))]
const QUADRATIC_STREAM_CHAINS: usize = 6;

// Iterations between bookkeeping passes (escape detection, retire/refill,
// budget, periodicity) in the streaming kernels. Saves land at per-lane
// multiples of the stride, so cycle detection stays guaranteed as with
// PERIODICITY_CHECK_STRIDE. Both kernels defer all checks to the boundary,
// making the per-step loops cheap enough that stride 32 pays (each swept
// 16/32/64: 64 punishes low-iteration escapers via free-run waste).
// The relaxed-simd FMA fused-c powu step is cheaper per iteration, moving
// the general kernel's stride optimum to 64 (re-swept 2026-07-10 after the
// general-kernel FMA ship: s64 75.3 ms vs s32 77.8 ms on the e6 heavy;
// s128 only another -1%, not worth doubling the free-run/replay tax on
// fast-escaping views). The simd128 fallback keeps its measured 32.
#[cfg(all(target_arch = "wasm32", target_feature = "relaxed-simd"))]
const STREAM_STRIDE: u32 = 64;
#[cfg(all(target_arch = "wasm32", not(target_feature = "relaxed-simd")))]
const STREAM_STRIDE: u32 = 32;
#[cfg(all(target_arch = "wasm32", target_feature = "relaxed-simd"))]
const QUADRATIC_STREAM_STRIDE: u32 = 64;
#[cfg(all(target_arch = "wasm32", not(target_feature = "relaxed-simd")))]
const QUADRATIC_STREAM_STRIDE: u32 = 32;

// Mariani–Silver subdivision: rects whose width or height is at or below
// this compute all their pixels directly instead of testing their border.
#[cfg(target_arch = "wasm32")]
const MARIANI_LEAF: usize = 8;

// Sentinel iteration count for pixels not yet computed during subdivision.
#[cfg(target_arch = "wasm32")]
pub(crate) const UNCOMPUTED: u32 = u32::MAX;

/// True when `c = re + im*i` lies inside (or on) the main cardioid or the
/// period-2 bulb. Closed-form membership: such points never escape, so the
/// escape loop would run out its full iteration budget on them.
fn in_main_cardioid_or_bulb(re: f64, im: f64) -> bool {
    let re_offset = re - 0.25;
    let im_sq = im * im;
    let q = re_offset * re_offset + im_sq;
    if q * (q + re_offset) <= 0.25 * im_sq {
        return true;
    }
    let re_plus_one = re + 1.0;
    re_plus_one * re_plus_one + im_sq <= 0.0625
}

/// Which numeric precision path produced a tile. Reported alongside every
/// render so the client's diagnostics overlay can tint each tile by the tier
/// the renderer picked for it (issue #50). The `u8` discriminants are the
/// wire values the client reads back (see `MandelbrotTile::tier`).
#[derive(Clone, Copy)]
pub(crate) enum RenderTier {
    /// Direct f64 escape iteration (shallow views, or exponents the
    /// perturbation path does not support).
    Direct = 0,
    /// Perturbation theory with f64 deltas from an arbitrary-precision
    /// reference orbit.
    Perturbation = 1,
    /// Hybrid float-exp perturbation: deltas carry a separate exponent so
    /// they survive underflow at extreme zoom depth.
    FloatExp = 2,
}

/// Running min/max of the escaped-pixel iteration counts observed while
/// rendering a tile. Interior pixels are rendered black regardless of the
/// palette, so they are not tracked; `range` stays `None` for tiles entirely
/// inside the set.
#[derive(Clone, Copy, Default)]
struct TileIterationStats {
    range: Option<(u32, u32)>,
}

impl TileIterationStats {
    fn record(&mut self, escape_iterations: u32, max_iterations: u32) {
        if escape_iterations < max_iterations {
            self.range = Some(match self.range {
                Some((min, max)) => (min.min(escape_iterations), max.max(escape_iterations)),
                None => (escape_iterations, escape_iterations),
            });
        }
    }
}

/// A rendered tile: RGBA bytes, the per-pixel smoothed escape values that
/// produced them (f32, `INFINITY` for interior pixels), and the iteration
/// stats observed while rendering. The values buffer is what the client
/// caches to recolor the tile later without recomputing escape times.
struct RenderedTile {
    image: Vec<u8>,
    values: Vec<f32>,
    stats: TileIterationStats,
    /// The precision path that produced this tile (for the client's
    /// diagnostics overlay, issue #50).
    tier: RenderTier,
}

impl RenderedTile {
    /// A solid black tile, as produced for views entirely inside the set. The
    /// tier is still reported so the overlay reflects the path the renderer
    /// would have taken (a border-in-set perturbation tile stays on the
    /// perturbation/float-exp tier).
    fn solid_black(image_width: usize, image_height: usize, tier: RenderTier) -> RenderedTile {
        RenderedTile {
            image: create_solid_black_image(image_width, image_height),
            values: vec![f32::INFINITY; image_width * image_height],
            stats: TileIterationStats::default(),
            tier,
        }
    }
}

const NUM_COLOR_CHANNELS: usize = 4;

/// Number of colors sampled into a contrast-stretched palette's lookup
/// table. Matches the 256-sample resolution of colorous's own schemes, so
/// linear interpolation between entries stays visually seamless.
const PALETTE_LUT_SIZE: usize = 256;

/// Okhsl lightness bounds for contrast-stretched palettes, chosen to
/// approximate the palettes that render fractal detail well (inferno,
/// magma): near-black at one end, near-white at the other.
const STRETCHED_LIGHTNESS_MIN: f32 = 0.05;
const STRETCHED_LIGHTNESS_MAX: f32 = 0.97;

/// Gentler lightness bounds for the cyclical palettes. Their identity is a
/// hue carousel at steady lightness, so the full stretch would make each
/// cycle pulse through a near-black band that reads as a seam; these bounds
/// add shading depth while keeping the carousel feel.
const CYCLIC_LIGHTNESS_MIN: f32 = 0.2;
const CYCLIC_LIGHTNESS_MAX: f32 = 0.9;

/// A color palette the renderer can sample continuously: either a colorous
/// gradient used as-is, or a lookup table built by `stretch_palette_contrast`
/// or `palette_from_fn`.
enum Palette {
    Original(colorous::Gradient),
    Lut(Vec<colorous::Color>),
}

impl Palette {
    /// Returns the color at position `t` in [0, 1], like
    /// `colorous::Gradient::eval_continuous`.
    fn eval_continuous(&self, t: f64) -> colorous::Color {
        match self {
            Palette::Original(gradient) => gradient.eval_continuous(t),
            Palette::Lut(lut) => {
                let position = t.clamp(0.0, 1.0) * (lut.len() - 1) as f64;
                let index = position as usize;
                let next_index = (index + 1).min(lut.len() - 1);
                let fraction = position - index as f64;
                let lerp = |a: u8, b: u8| {
                    (f64::from(a) + (f64::from(b) - f64::from(a)) * fraction).round() as u8
                };
                let (from, to) = (lut[index], lut[next_index]);
                colorous::Color {
                    r: lerp(from.r, to.r),
                    g: lerp(from.g, to.g),
                    b: lerp(from.b, to.b),
                }
            }
        }
    }
}

/// Rebuilds a colorous gradient with its Okhsl lightness range linearly
/// stretched to [`STRETCHED_LIGHTNESS_MIN`, `STRETCHED_LIGHTNESS_MAX`],
/// keeping hue and saturation.
///
/// Most of the d3 palettes were designed for choropleth maps and span too
/// narrow a lightness range for fractal shading — filigree detail gets lost
/// as pale-on-pale — so this remap gives them the same near-black-to-near-
/// white contrast as inferno or magma while preserving each palette's color
/// identity.
fn stretch_palette_contrast(gradient: colorous::Gradient) -> Palette {
    stretch_palette_lightness(gradient, STRETCHED_LIGHTNESS_MIN, STRETCHED_LIGHTNESS_MAX)
}

/// Like `stretch_palette_contrast`, but with the gentler
/// [`CYCLIC_LIGHTNESS_MIN`, `CYCLIC_LIGHTNESS_MAX`] bounds for cyclical
/// palettes.
fn stretch_cyclic_palette_contrast(gradient: colorous::Gradient) -> Palette {
    stretch_palette_lightness(gradient, CYCLIC_LIGHTNESS_MIN, CYCLIC_LIGHTNESS_MAX)
}

/// Linearly remaps a gradient's Okhsl lightness range onto
/// [`target_min`, `target_max`]. Because the remap is a pointwise function
/// of color, palettes whose endpoints match (rainbow, sinebow) stay
/// seamlessly cyclical.
fn stretch_palette_lightness(
    gradient: colorous::Gradient,
    target_min: f32,
    target_max: f32,
) -> Palette {
    let samples: Vec<Okhsl> = (0..PALETTE_LUT_SIZE)
        .map(|i| {
            let color = gradient.eval_continuous(i as f64 / (PALETTE_LUT_SIZE - 1) as f64);
            Okhsl::from_color(Srgb::new(
                f32::from(color.r) / 255.0,
                f32::from(color.g) / 255.0,
                f32::from(color.b) / 255.0,
            ))
        })
        .collect();

    let (min_lightness, max_lightness) = samples
        .iter()
        .fold((f32::INFINITY, f32::NEG_INFINITY), |(min, max), color| {
            (min.min(color.lightness), max.max(color.lightness))
        });
    let native_range = (max_lightness - min_lightness).max(f32::EPSILON);
    let target_range = target_max - target_min;

    let lut = samples
        .into_iter()
        .map(|mut okhsl| {
            okhsl.lightness =
                target_min + (okhsl.lightness - min_lightness) / native_range * target_range;
            let rgb: Srgb = okhsl.into_color();
            colorous::Color {
                r: (rgb.red * 255.0).round() as u8,
                g: (rgb.green * 255.0).round() as u8,
                b: (rgb.blue * 255.0).round() as u8,
            }
        })
        .collect();

    Palette::Lut(lut)
}

/// Builds a palette lookup table by sampling an RGB function of `t` in
/// [0, 1]. Channel values outside [0, 1] are clamped.
fn palette_from_fn(rgb_at: impl Fn(f64) -> [f64; 3]) -> Palette {
    let channel = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
    let lut = (0..PALETTE_LUT_SIZE)
        .map(|i| {
            let rgb = rgb_at(i as f64 / (PALETTE_LUT_SIZE - 1) as f64);
            colorous::Color {
                r: channel(rgb[0]),
                g: channel(rgb[1]),
                b: channel(rgb[2]),
            }
        })
        .collect();
    Palette::Lut(lut)
}

/// MATLAB's classic "jet" colormap: dark blue -> cyan -> yellow -> dark
/// red. The palette turbo was designed to replace; kept here for its vivid,
/// high-local-contrast fractal look.
fn jet_color(t: f64) -> [f64; 3] {
    [
        1.5 - (4.0 * t - 3.0).abs(),
        1.5 - (4.0 * t - 2.0).abs(),
        1.5 - (4.0 * t - 1.0).abs(),
    ]
}

/// gnuplot's default pm3d palette: black -> blue -> violet -> red ->
/// yellow. True black at one end with a full rainbow-like sweep, unlike
/// anything in colorous.
fn gnuplot_color(t: f64) -> [f64; 3] {
    [t.sqrt(), t * t * t, (2.0 * std::f64::consts::PI * t).sin()]
}

/// matplotlib's "nipy_spectral" colormap (BSD-licensed control points):
/// black -> violet -> blue -> green -> yellow -> red -> grey. Spans nearly
/// the full lightness range with the strongest local contrast of any
/// palette here — filigree detail renders especially crisply.
fn nipy_spectral_color(t: f64) -> [f64; 3] {
    const POINTS: &[(f64, [f64; 3])] = &[
        (0.00, [0.0, 0.0, 0.0]),
        (0.05, [0.4667, 0.0, 0.5333]),
        (0.10, [0.5333, 0.0, 0.6]),
        (0.15, [0.0, 0.0, 0.6667]),
        (0.20, [0.0, 0.0, 0.8667]),
        (0.25, [0.0, 0.4667, 0.8667]),
        (0.30, [0.0, 0.6, 0.8667]),
        (0.35, [0.0, 0.6667, 0.6667]),
        (0.40, [0.0, 0.6667, 0.5333]),
        (0.45, [0.0, 0.6, 0.0]),
        (0.50, [0.0, 0.7333, 0.0]),
        (0.55, [0.0, 0.8667, 0.0]),
        (0.60, [0.0, 1.0, 0.0]),
        (0.65, [0.7333, 1.0, 0.0]),
        (0.70, [0.9333, 0.9333, 0.0]),
        (0.75, [1.0, 0.8, 0.0]),
        (0.80, [1.0, 0.6, 0.0]),
        (0.85, [1.0, 0.0, 0.0]),
        (0.90, [0.8667, 0.0, 0.0]),
        (0.95, [0.8, 0.0, 0.0]),
        (1.00, [0.8, 0.8, 0.8]),
    ];

    let t = t.clamp(0.0, 1.0);
    let next = POINTS
        .partition_point(|&(x, _)| x <= t)
        .min(POINTS.len() - 1);
    if next == 0 {
        return POINTS[0].1;
    }
    let (x0, from) = POINTS[next - 1];
    let (x1, to) = POINTS[next];
    let fraction = if x1 > x0 { (t - x0) / (x1 - x0) } else { 0.0 };
    [
        from[0] + (to[0] - from[0]) * fraction,
        from[1] + (to[1] - from[1]) * fraction,
        from[2] + (to[2] - from[2]) * fraction,
    ]
}

// In both palette maps below, palettes that already span (nearly) the full
// lightness range — the scientific colormaps plus greys — keep their
// canonical colors; the rest are contrast-stretched (see
// `stretch_palette_contrast`).
static COLOR_PALETTES: Lazy<HashMap<String, Palette>> = Lazy::new(|| {
    use Palette::Original;
    let mut map = HashMap::new();
    map.insert("cividis".to_string(), Original(colorous::CIVIDIS));
    map.insert("cubehelix".to_string(), Original(colorous::CUBEHELIX));
    map.insert("inferno".to_string(), Original(colorous::INFERNO));
    map.insert("magma".to_string(), Original(colorous::MAGMA));
    map.insert("plasma".to_string(), Original(colorous::PLASMA));
    map.insert("turbo".to_string(), Original(colorous::TURBO));
    map.insert("viridis".to_string(), Original(colorous::VIRIDIS));

    map.insert("jet".to_string(), palette_from_fn(jet_color));
    map.insert("gnuplot".to_string(), palette_from_fn(gnuplot_color));
    map.insert(
        "nipySpectral".to_string(),
        palette_from_fn(nipy_spectral_color),
    );

    map.insert(
        "brownGreen".to_string(),
        stretch_palette_contrast(colorous::BROWN_GREEN),
    );
    map.insert("cool".to_string(), stretch_palette_contrast(colorous::COOL));
    map.insert(
        "purpleGreen".to_string(),
        stretch_palette_contrast(colorous::PURPLE_GREEN),
    );
    map.insert(
        "purpleOrange".to_string(),
        stretch_palette_contrast(colorous::PURPLE_ORANGE),
    );
    map.insert(
        "rainbow".to_string(),
        stretch_cyclic_palette_contrast(colorous::RAINBOW),
    );
    map.insert(
        "redBlue".to_string(),
        stretch_palette_contrast(colorous::RED_BLUE),
    );
    map.insert(
        "redGrey".to_string(),
        stretch_palette_contrast(colorous::RED_GREY),
    );
    map.insert(
        "redYellowBlue".to_string(),
        stretch_palette_contrast(colorous::RED_YELLOW_BLUE),
    );
    map.insert(
        "redYellowGreen".to_string(),
        stretch_palette_contrast(colorous::RED_YELLOW_GREEN),
    );
    map.insert(
        "sinebow".to_string(),
        stretch_cyclic_palette_contrast(colorous::SINEBOW),
    );
    map.insert(
        "spectral".to_string(),
        stretch_palette_contrast(colorous::SPECTRAL),
    );
    map.insert("warm".to_string(), stretch_palette_contrast(colorous::WARM));
    map.insert(
        "yellowOrangeBrown".to_string(),
        stretch_palette_contrast(colorous::YELLOW_ORANGE_BROWN),
    );
    map
});

static REVERSE_COLOR_PALETTES: Lazy<HashMap<String, Palette>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert("greys".to_string(), Palette::Original(colorous::GREYS));

    map.insert(
        "blues".to_string(),
        stretch_palette_contrast(colorous::BLUES),
    );
    map.insert(
        "greenBlue".to_string(),
        stretch_palette_contrast(colorous::GREEN_BLUE),
    );
    map.insert(
        "greens".to_string(),
        stretch_palette_contrast(colorous::GREENS),
    );
    map.insert(
        "orangeRed".to_string(),
        stretch_palette_contrast(colorous::ORANGE_RED),
    );
    map.insert(
        "oranges".to_string(),
        stretch_palette_contrast(colorous::ORANGES),
    );
    map.insert(
        "pinkGreen".to_string(),
        stretch_palette_contrast(colorous::PINK_GREEN),
    );
    map.insert(
        "purpleBlueGreen".to_string(),
        stretch_palette_contrast(colorous::PURPLE_BLUE_GREEN),
    );
    map.insert(
        "purpleRed".to_string(),
        stretch_palette_contrast(colorous::PURPLE_RED),
    );
    map.insert(
        "purples".to_string(),
        stretch_palette_contrast(colorous::PURPLES),
    );
    map.insert(
        "redPurple".to_string(),
        stretch_palette_contrast(colorous::RED_PURPLE),
    );
    map.insert("reds".to_string(), stretch_palette_contrast(colorous::REDS));
    map.insert(
        "yellowGreen".to_string(),
        stretch_palette_contrast(colorous::YELLOW_GREEN),
    );
    map.insert(
        "yellowGreenBlue".to_string(),
        stretch_palette_contrast(colorous::YELLOW_GREEN_BLUE),
    );
    map.insert(
        "yellowOrangeRed".to_string(),
        stretch_palette_contrast(colorous::YELLOW_ORANGE_RED),
    );

    map
});

/// Performs the escape time algorithm for the quadratic Mandelbrot set (exponent = 2).
///
/// # Parameters
/// - `c`: The complex number to iterate on.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `escape_radius_squared`: The square of the escape radius.
///
/// # Returns
/// A tuple containing the number of iterations and the final complex value.
fn calculate_escape_iterations_quadratic(
    c: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
) -> (u32, Complex64) {
    if in_main_cardioid_or_bulb(c.re, c.im) {
        return (max_iterations, c);
    }

    let mut z = c;
    let mut iter = 0;

    // Brent-style periodicity: if z exactly revisits a saved value, the orbit
    // is numerically periodic and can never escape.
    let mut saved = z;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    while z.norm_sqr() < escape_radius_squared && iter < max_iterations {
        z = z * z + c;
        iter += 1;

        if iter % PERIODICITY_CHECK_STRIDE == 0 {
            if z == saved {
                return (max_iterations, z);
            }
            if iter == next_save {
                saved = z;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    (iter, z)
}

/// Performs the escape time algorithm for the general Mandelbrot set (exponent > 2).
///
/// # Parameters
/// - `c`: The complex number to iterate on.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `escape_radius_squared`: The square of the escape radius.
/// - `exponent`: The exponent used in the iteration formula.
///
/// # Returns
/// A tuple containing the number of iterations and the final complex value.
fn calculate_escape_iterations_general(
    c: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
    exponent: u32,
) -> (u32, Complex64) {
    let mut z = c;
    let mut iter = 0;

    // Brent-style periodicity, as in the quadratic loop. There is no
    // closed-form interior test for general exponents.
    let mut saved = z;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    while z.norm_sqr() < escape_radius_squared && iter < max_iterations {
        z = z.powu(exponent) + c;
        iter += 1;

        if iter % PERIODICITY_CHECK_STRIDE == 0 {
            if z == saved {
                return (max_iterations, z);
            }
            if iter == next_save {
                saved = z;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    (iter, z)
}

/// Escape-time iteration for a Julia set: unlike the Mandelbrot iteration
/// (where `z` starts at 0 and `c` is the pixel), here `c` is a fixed parameter
/// for the whole image and `z` starts at the pixel coordinate `z0`. Iterates
/// `z -> z^exponent + c` and returns the escape iteration count plus the final
/// `z`, matching the tuple the Mandelbrot escape functions return so the shared
/// coloring pipeline consumes it identically.
///
/// The same Brent-style periodicity check as the Mandelbrot loops catches
/// non-escaping (interior) orbits early. There is no closed-form interior test
/// for a Julia set (its shape depends on `c`), so periodicity is the only
/// shortcut.
fn calculate_julia_escape_iterations(
    z0: Complex64,
    c: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
    exponent: u32,
) -> (u32, Complex64) {
    let mut z = z0;
    let mut iter = 0;

    let mut saved = z;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    while z.norm_sqr() < escape_radius_squared && iter < max_iterations {
        z = if exponent == 2 {
            z * z + c
        } else {
            z.powu(exponent) + c
        };
        iter += 1;

        if iter % PERIODICITY_CHECK_STRIDE == 0 {
            if z == saved {
                return (max_iterations, z);
            }
            if iter == next_save {
                saved = z;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    (iter, z)
}

/// Exterior distance estimate for a single point `c`, in the same units as the
/// complex plane. Iterates the orbit `z` alongside its derivative `dz = dz/dc`,
/// whose step for `f(z) = z^exponent + c` is
/// `dz' = exponent*z^(exponent-1)*dz + 1` (seeded `z0 = 0`, `dz0 = 0`). When
/// the orbit escapes, the Koebe/Milnor
/// exterior estimate `d = 2*|z|*ln|z| / |dz|` gives the approximate distance
/// from `c` to the boundary of the set. It is a first-order estimate, accurate
/// to within a small constant factor near the boundary, not an exact distance.
///
/// Returns `None` for points that do not escape within `max_iterations` (they
/// are inside the set, so no exterior distance applies) and for the degenerate
/// case of a vanishing derivative. A dedicated scalar loop rather than reusing
/// the escape kernels, because tracking the derivative doubles the per-step
/// work — cheap for a single hover query, but not worth adding to the tile
/// kernels (issue #42).
fn distance_estimate_at_c(
    c: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
    exponent: u32,
) -> Option<f64> {
    // Interior shortcut for the quadratic set: cardioid/bulb points never
    // escape, so there is no exterior distance to report.
    if exponent == 2 && in_main_cardioid_or_bulb(c.re, c.im) {
        return None;
    }

    let mut z = c;
    // dz/dc after the first step (z1 = c): d/dc[z^e + c] at z0 = 0 is 1.
    let mut dz = Complex64::new(1.0, 0.0);
    let mut iter = 1u32;

    while z.norm_sqr() < escape_radius_squared && iter < max_iterations {
        // dz' = exponent * z^(exponent-1) * dz + 1, evaluated before z steps.
        dz = Complex64::new(f64::from(exponent), 0.0) * z.powu(exponent - 1) * dz
            + Complex64::new(1.0, 0.0);
        z = z.powu(exponent) + c;
        iter += 1;
    }

    // Did not escape: inside the set (or hit the iteration cap), no exterior
    // distance.
    if z.norm_sqr() < escape_radius_squared {
        return None;
    }

    let z_norm = z.norm();
    let dz_norm = dz.norm();
    // A zero (or non-finite) derivative would divide to a meaningless value;
    // treat it as "no estimate" rather than emit inf/NaN.
    if !dz_norm.is_finite() || dz_norm == 0.0 || !z_norm.is_finite() {
        return None;
    }

    let distance = 2.0 * z_norm * z_norm.ln() / dz_norm;
    distance.is_finite().then_some(distance.max(0.0))
}

/// Maps an exterior distance estimate (`distance_estimate_at_c`) to a
/// palette-independent brightness in `[0, 1]` for the distance-estimate
/// rendering mode (issue #46). The estimate is measured relative to the
/// pixel spacing so the boundary keeps a uniform visual weight at every zoom
/// depth: pixels a fraction of a pixel from the boundary map to ~0 (dark),
/// pixels several pixels out map toward 1 (bright). `tanh` gives a smooth,
/// bounded ramp with no hard clip.
///
/// Returns `f64::INFINITY` for interior points (no exterior distance), which
/// the color mapping renders black exactly as it does for interior escape
/// values, so DE tiles cache and recolor through the same `values` pipeline.
fn distance_estimate_brightness(distance: Option<f64>, pixel_spacing: f64) -> f64 {
    match distance {
        // A non-positive pixel spacing would divide to a meaningless value;
        // fall back to the raw distance so the tile is never degenerate.
        Some(distance) if pixel_spacing > 0.0 => (distance / pixel_spacing).tanh(),
        Some(distance) => distance.tanh(),
        None => f64::INFINITY,
    }
}

/// The iteration index at which the orbit of `c` (from `z = 0`) comes closest
/// to the origin within the iteration budget — the "atom domain" of `c`
/// (issue #45).
///
/// For a point inside a period-`p` hyperbolic component the orbit settles onto
/// a `p`-cycle, and the cycle point nearest the origin recurs every `p` steps;
/// the *first* step at which the running minimum of `|z_n|` is attained is
/// therefore the smallest index of that nearest cycle point, and neighboring
/// pixels that share the same period share the same nearest-approach index —
/// so coloring by this index paints each period's atom domain a flat region.
/// Exterior points get the index at which their (escaping) orbit dips closest
/// to the origin before diverging, which likewise clusters by the component
/// they orbit near, giving the boundary its filamentary period structure.
///
/// Iterating from `z = 0`, the index `0` reference point is never the minimum
/// (`|z_0| = 0` would trivially win), so the search starts from the first
/// mapped point `z_1 = c`; the returned index is at least `1`. Escaped orbits
/// stop early (their minimum is always attained before escape), so the budget
/// bounds the work. Only meaningful for exponent 2, matching the quadratic set.
fn atom_domain_index_at_c(c: Complex64, max_iterations: u32, escape_radius_squared: f64) -> u32 {
    let mut z = c;
    let mut min_norm_sqr = z.norm_sqr();
    let mut min_index: u32 = 1;

    for index in 2..=max_iterations {
        if z.norm_sqr() >= escape_radius_squared {
            break;
        }
        z = z * z + c;
        let norm_sqr = z.norm_sqr();
        if norm_sqr < min_norm_sqr {
            min_norm_sqr = norm_sqr;
            min_index = index;
        }
    }

    min_index
}

/// Maps an atom-domain index (`atom_domain_index_at_c`) to a palette-independent
/// value in `[0, 1)` for the atom-domain rendering mode (issue #45). Coloring
/// by period wants a *categorical* palette — adjacent periods should read as
/// clearly distinct bands rather than a smooth ramp — so instead of normalizing
/// the raw index (which would crush the low periods that dominate most views
/// into a sliver at the dark end), each integer index is scattered across the
/// palette by the fractional part of `index * φ⁻¹`. The golden-ratio conjugate
/// gives a low-discrepancy sequence: successive indices land far apart on the
/// color wheel, so consecutive periods contrast maximally while the mapping
/// stays deterministic and palette-agnostic (it recolors through the same fixed
/// `0..1` pipeline distance-estimate tiles use).
fn atom_domain_value(index: u32) -> f64 {
    // φ⁻¹ = (√5 − 1) / 2, the golden-ratio conjugate.
    const GOLDEN_RATIO_CONJUGATE: f64 = 0.618_033_988_749_894_9;
    (f64::from(index) * GOLDEN_RATIO_CONJUGATE).fract()
}

// Iterations spent settling the orbit onto its attracting cycle before the
// period search begins. A superattracting cycle (the center of a bulb, e.g.
// c = 0 or c = -1) locks on almost immediately, but points near the edge of a
// component converge geometrically and need a long transient to get within
// PERIOD_TOLERANCE of the cycle.
const PERIOD_SETTLE_ITERATIONS: u32 = 4096;

// How close two orbit points must be (in complex-plane distance) to count as
// the same cycle point. Loose enough to survive the residual transient after
// PERIOD_SETTLE_ITERATIONS, tight enough not to alias distinct points of a
// low-period cycle together.
const PERIOD_TOLERANCE: f64 = 1e-6;

// Longest cycle the search will report. Beyond this a point is treated as
// aperiodic-within-tolerance (returns None); the tooltip then shows nothing,
// which is the honest answer for a point whose period exceeds what a settled
// f64 orbit can resolve.
const PERIOD_MAX: u32 = 1024;

/// Period of the attracting cycle for a point `c` inside the set, or `None`
/// when the point escapes (no attracting cycle), when no cycle is found within
/// `PERIOD_MAX`, or when the orbit has not settled enough to resolve one.
///
/// The main cardioid is period 1, the period-2 bulb period 2, the two large
/// period-3 bulbs period 3, and a minibrot's cardioid its own (higher) period —
/// useful orientation for deep-zoom exploration (issue #39).
///
/// Method: iterate `PERIOD_SETTLE_ITERATIONS` steps to settle the orbit onto
/// its attracting cycle, checking along the way that it has not escaped. Then
/// take the settled point as a reference and iterate up to `PERIOD_MAX` more
/// steps, returning the first step count at which the orbit returns within
/// `PERIOD_TOLERANCE` of the reference — the cycle length. Only meaningful for
/// exponent 2 (matching the quadratic set), which is all the tooltip queries.
fn period_at_c(c: Complex64, max_iterations: u32, escape_radius_squared: f64) -> Option<u32> {
    let mut z = c;

    // Settle onto the attracting cycle, bailing out the moment the orbit
    // escapes: an escaping point has no attracting cycle to report.
    let settle = PERIOD_SETTLE_ITERATIONS.min(max_iterations);
    for _ in 0..settle {
        z = z * z + c;
        if z.norm_sqr() >= escape_radius_squared {
            return None;
        }
    }

    // The settled orbit point stands in for the cycle; find the smallest number
    // of further steps that returns near it.
    let reference = z;
    for period in 1..=PERIOD_MAX {
        z = z * z + c;
        if z.norm_sqr() >= escape_radius_squared {
            return None;
        }
        if (z - reference).norm() < PERIOD_TOLERANCE {
            return Some(period);
        }
    }

    None
}

/// Escape-time iteration for two pixels at once, one per 128-bit SIMD lane
/// (quadratic case). Escaped lanes are frozen with a mask while the other lane
/// keeps iterating. The lane arithmetic is IEEE-identical to the scalar loop
/// (`a*b + b*a` rounds to exactly `2*(a*b)`), so results match
/// `calculate_escape_iterations_quadratic` bit-for-bit.
#[cfg(target_arch = "wasm32")]
fn calculate_escape_iterations_quadratic_pair(
    c_first: Complex64,
    c_second: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
) -> [(u32, Complex64); 2] {
    use core::arch::wasm32::*;

    let interior = [
        in_main_cardioid_or_bulb(c_first.re, c_first.im),
        in_main_cardioid_or_bulb(c_second.re, c_second.im),
    ];
    if interior[0] && interior[1] {
        return [(max_iterations, c_first), (max_iterations, c_second)];
    }

    let c_re = f64x2(c_first.re, c_second.re);
    let c_im = f64x2(c_first.im, c_second.im);
    let radius_squared = f64x2_splat(escape_radius_squared);

    let mut z_re = c_re;
    let mut z_im = c_im;
    // Alive lanes are all-ones, so subtracting the mask adds 1 per live lane.
    let mut alive = i64x2(
        if interior[0] { 0 } else { -1 },
        if interior[1] { 0 } else { -1 },
    );
    let mut lane_iterations = i64x2_splat(0);
    let mut remaining = max_iterations;

    // Brent-style periodicity state (see calculate_escape_iterations_quadratic).
    let mut saved_re = z_re;
    let mut saved_im = z_im;
    let mut steps_done = 0u32;
    let mut next_save = PERIODICITY_FIRST_SAVE;
    let mut periodic = [false, false];

    while remaining > 0 {
        let norm_sqr = f64x2_add(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im));
        alive = v128_and(alive, f64x2_lt(norm_sqr, radius_squared));
        if !v128_any_true(alive) {
            break;
        }

        let next_re = f64x2_add(
            f64x2_sub(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im)),
            c_re,
        );
        let next_im = f64x2_add(f64x2_mul(f64x2_splat(2.0), f64x2_mul(z_re, z_im)), c_im);
        z_re = v128_bitselect(next_re, z_re, alive);
        z_im = v128_bitselect(next_im, z_im, alive);
        lane_iterations = i64x2_sub(lane_iterations, alive);
        remaining -= 1;

        steps_done += 1;
        if steps_done % PERIODICITY_CHECK_STRIDE == 0 {
            let cycled = v128_and(
                v128_and(f64x2_eq(z_re, saved_re), f64x2_eq(z_im, saved_im)),
                alive,
            );
            if v128_any_true(cycled) {
                if i64x2_extract_lane::<0>(cycled) != 0 {
                    periodic[0] = true;
                }
                if i64x2_extract_lane::<1>(cycled) != 0 {
                    periodic[1] = true;
                }
                alive = v128_andnot(alive, cycled);
                if !v128_any_true(alive) {
                    break;
                }
            }
            if steps_done == next_save {
                saved_re = z_re;
                saved_im = z_im;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    let lane_results = [
        (
            i64x2_extract_lane::<0>(lane_iterations) as u32,
            Complex64::new(f64x2_extract_lane::<0>(z_re), f64x2_extract_lane::<0>(z_im)),
        ),
        (
            i64x2_extract_lane::<1>(lane_iterations) as u32,
            Complex64::new(f64x2_extract_lane::<1>(z_re), f64x2_extract_lane::<1>(z_im)),
        ),
    ];

    [
        if interior[0] || periodic[0] {
            (max_iterations, lane_results[0].1)
        } else {
            lane_results[0]
        },
        if interior[1] || periodic[1] {
            (max_iterations, lane_results[1].1)
        } else {
            lane_results[1]
        },
    ]
}

/// Escape-time iteration for four pixels at once across two f64x2 vectors,
/// giving the CPU two independent dependency chains per step to overlap
/// (quadratic case). Lane arithmetic is IEEE-identical to the scalar loop,
/// as in the pair kernel.
#[cfg(target_arch = "wasm32")]
fn calculate_escape_iterations_quadratic_quad(
    c: [Complex64; 4],
    max_iterations: u32,
    escape_radius_squared: f64,
) -> [(u32, Complex64); 4] {
    use core::arch::wasm32::*;

    let interior = [
        in_main_cardioid_or_bulb(c[0].re, c[0].im),
        in_main_cardioid_or_bulb(c[1].re, c[1].im),
        in_main_cardioid_or_bulb(c[2].re, c[2].im),
        in_main_cardioid_or_bulb(c[3].re, c[3].im),
    ];
    if interior.iter().all(|&lane| lane) {
        return [
            (max_iterations, c[0]),
            (max_iterations, c[1]),
            (max_iterations, c[2]),
            (max_iterations, c[3]),
        ];
    }

    let c_re_a = f64x2(c[0].re, c[1].re);
    let c_im_a = f64x2(c[0].im, c[1].im);
    let c_re_b = f64x2(c[2].re, c[3].re);
    let c_im_b = f64x2(c[2].im, c[3].im);
    let radius_squared = f64x2_splat(escape_radius_squared);
    let two = f64x2_splat(2.0);

    let mut z_re_a = c_re_a;
    let mut z_im_a = c_im_a;
    let mut z_re_b = c_re_b;
    let mut z_im_b = c_im_b;
    let dead_or_alive = |is_interior: bool| if is_interior { 0i64 } else { -1i64 };
    let mut alive_a = i64x2(dead_or_alive(interior[0]), dead_or_alive(interior[1]));
    let mut alive_b = i64x2(dead_or_alive(interior[2]), dead_or_alive(interior[3]));
    let mut lane_iterations_a = i64x2_splat(0);
    let mut lane_iterations_b = i64x2_splat(0);
    let mut remaining = max_iterations;

    // Brent-style periodicity state (see calculate_escape_iterations_quadratic).
    let mut saved_re_a = z_re_a;
    let mut saved_im_a = z_im_a;
    let mut saved_re_b = z_re_b;
    let mut saved_im_b = z_im_b;
    let mut steps_done = 0u32;
    let mut next_save = PERIODICITY_FIRST_SAVE;
    let mut periodic = [false; 4];

    while remaining > 0 {
        let norm_sqr_a = f64x2_add(f64x2_mul(z_re_a, z_re_a), f64x2_mul(z_im_a, z_im_a));
        let norm_sqr_b = f64x2_add(f64x2_mul(z_re_b, z_re_b), f64x2_mul(z_im_b, z_im_b));
        alive_a = v128_and(alive_a, f64x2_lt(norm_sqr_a, radius_squared));
        alive_b = v128_and(alive_b, f64x2_lt(norm_sqr_b, radius_squared));
        if !v128_any_true(v128_or(alive_a, alive_b)) {
            break;
        }

        let next_re_a = f64x2_add(
            f64x2_sub(f64x2_mul(z_re_a, z_re_a), f64x2_mul(z_im_a, z_im_a)),
            c_re_a,
        );
        let next_im_a = f64x2_add(f64x2_mul(two, f64x2_mul(z_re_a, z_im_a)), c_im_a);
        let next_re_b = f64x2_add(
            f64x2_sub(f64x2_mul(z_re_b, z_re_b), f64x2_mul(z_im_b, z_im_b)),
            c_re_b,
        );
        let next_im_b = f64x2_add(f64x2_mul(two, f64x2_mul(z_re_b, z_im_b)), c_im_b);
        z_re_a = v128_bitselect(next_re_a, z_re_a, alive_a);
        z_im_a = v128_bitselect(next_im_a, z_im_a, alive_a);
        z_re_b = v128_bitselect(next_re_b, z_re_b, alive_b);
        z_im_b = v128_bitselect(next_im_b, z_im_b, alive_b);
        lane_iterations_a = i64x2_sub(lane_iterations_a, alive_a);
        lane_iterations_b = i64x2_sub(lane_iterations_b, alive_b);
        remaining -= 1;

        steps_done += 1;
        if steps_done % PERIODICITY_CHECK_STRIDE == 0 {
            let cycled_a = v128_and(
                v128_and(f64x2_eq(z_re_a, saved_re_a), f64x2_eq(z_im_a, saved_im_a)),
                alive_a,
            );
            let cycled_b = v128_and(
                v128_and(f64x2_eq(z_re_b, saved_re_b), f64x2_eq(z_im_b, saved_im_b)),
                alive_b,
            );
            if v128_any_true(v128_or(cycled_a, cycled_b)) {
                if i64x2_extract_lane::<0>(cycled_a) != 0 {
                    periodic[0] = true;
                }
                if i64x2_extract_lane::<1>(cycled_a) != 0 {
                    periodic[1] = true;
                }
                if i64x2_extract_lane::<0>(cycled_b) != 0 {
                    periodic[2] = true;
                }
                if i64x2_extract_lane::<1>(cycled_b) != 0 {
                    periodic[3] = true;
                }
                alive_a = v128_andnot(alive_a, cycled_a);
                alive_b = v128_andnot(alive_b, cycled_b);
                if !v128_any_true(v128_or(alive_a, alive_b)) {
                    break;
                }
            }
            if steps_done == next_save {
                saved_re_a = z_re_a;
                saved_im_a = z_im_a;
                saved_re_b = z_re_b;
                saved_im_b = z_im_b;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    let lane_results = [
        (
            i64x2_extract_lane::<0>(lane_iterations_a) as u32,
            Complex64::new(
                f64x2_extract_lane::<0>(z_re_a),
                f64x2_extract_lane::<0>(z_im_a),
            ),
        ),
        (
            i64x2_extract_lane::<1>(lane_iterations_a) as u32,
            Complex64::new(
                f64x2_extract_lane::<1>(z_re_a),
                f64x2_extract_lane::<1>(z_im_a),
            ),
        ),
        (
            i64x2_extract_lane::<0>(lane_iterations_b) as u32,
            Complex64::new(
                f64x2_extract_lane::<0>(z_re_b),
                f64x2_extract_lane::<0>(z_im_b),
            ),
        ),
        (
            i64x2_extract_lane::<1>(lane_iterations_b) as u32,
            Complex64::new(
                f64x2_extract_lane::<1>(z_re_b),
                f64x2_extract_lane::<1>(z_im_b),
            ),
        ),
    ];

    let mut results = lane_results;
    for lane in 0..4 {
        if interior[lane] || periodic[lane] {
            results[lane] = (max_iterations, lane_results[lane].1);
        }
    }
    results
}

/// Lane state for the streaming escape kernel: `CHAINS` f64x2 vectors
/// (2 pixels each), plus per-lane bookkeeping. `slots` maps each lane to the
/// pixel index it is iterating, or `IDLE_SLOT` when the point queue is
/// exhausted.
#[cfg(target_arch = "wasm32")]
struct StreamLanes<const CHAINS: usize> {
    z_re: [core::arch::wasm32::v128; CHAINS],
    z_im: [core::arch::wasm32::v128; CHAINS],
    c_re: [core::arch::wasm32::v128; CHAINS],
    c_im: [core::arch::wasm32::v128; CHAINS],
    /// All-ones for lanes still iterating; alive is a subset of occupied.
    alive: [core::arch::wasm32::v128; CHAINS],
    /// All-ones for lanes holding a pixel that has not been retired yet.
    occupied: [core::arch::wasm32::v128; CHAINS],
    /// Per-lane iteration counts (i64 lanes, incremented while alive).
    iters: [core::arch::wasm32::v128; CHAINS],
    // Brent-style periodicity state, per lane (see
    // calculate_escape_iterations_quadratic).
    saved_re: [core::arch::wasm32::v128; CHAINS],
    saved_im: [core::arch::wasm32::v128; CHAINS],
    next_save: [core::arch::wasm32::v128; CHAINS],
    slots: [[usize; 2]; CHAINS],
}

#[cfg(target_arch = "wasm32")]
const IDLE_SLOT: usize = usize::MAX;

#[cfg(target_arch = "wasm32")]
fn f64x2_with_lane(v: core::arch::wasm32::v128, sub: usize, x: f64) -> core::arch::wasm32::v128 {
    use core::arch::wasm32::*;
    if sub == 0 {
        f64x2_replace_lane::<0>(v, x)
    } else {
        f64x2_replace_lane::<1>(v, x)
    }
}

#[cfg(target_arch = "wasm32")]
fn f64x2_lane(v: core::arch::wasm32::v128, sub: usize) -> f64 {
    use core::arch::wasm32::*;
    if sub == 0 {
        f64x2_extract_lane::<0>(v)
    } else {
        f64x2_extract_lane::<1>(v)
    }
}

#[cfg(target_arch = "wasm32")]
fn i64x2_with_lane(v: core::arch::wasm32::v128, sub: usize, x: i64) -> core::arch::wasm32::v128 {
    use core::arch::wasm32::*;
    if sub == 0 {
        i64x2_replace_lane::<0>(v, x)
    } else {
        i64x2_replace_lane::<1>(v, x)
    }
}

#[cfg(target_arch = "wasm32")]
fn i64x2_lane(v: core::arch::wasm32::v128, sub: usize) -> i64 {
    use core::arch::wasm32::*;
    if sub == 0 {
        i64x2_extract_lane::<0>(v)
    } else {
        i64x2_extract_lane::<1>(v)
    }
}

#[cfg(target_arch = "wasm32")]
impl<const CHAINS: usize> StreamLanes<CHAINS> {
    fn new() -> Self {
        use core::arch::wasm32::*;
        let zero_f = f64x2_splat(0.0);
        let zero_i = i64x2_splat(0);
        StreamLanes {
            z_re: [zero_f; CHAINS],
            z_im: [zero_f; CHAINS],
            c_re: [zero_f; CHAINS],
            c_im: [zero_f; CHAINS],
            alive: [zero_i; CHAINS],
            occupied: [zero_i; CHAINS],
            iters: [zero_i; CHAINS],
            saved_re: [zero_f; CHAINS],
            saved_im: [zero_f; CHAINS],
            next_save: [zero_i; CHAINS],
            slots: [[IDLE_SLOT; 2]; CHAINS],
        }
    }

    /// Starts iterating `point` (pixel `index`) on the given lane.
    fn load(&mut self, chain: usize, sub: usize, index: usize, point: (f64, f64)) {
        let (re, im) = point;
        self.c_re[chain] = f64x2_with_lane(self.c_re[chain], sub, re);
        self.c_im[chain] = f64x2_with_lane(self.c_im[chain], sub, im);
        self.z_re[chain] = f64x2_with_lane(self.z_re[chain], sub, re);
        self.z_im[chain] = f64x2_with_lane(self.z_im[chain], sub, im);
        self.saved_re[chain] = f64x2_with_lane(self.saved_re[chain], sub, re);
        self.saved_im[chain] = f64x2_with_lane(self.saved_im[chain], sub, im);
        self.alive[chain] = i64x2_with_lane(self.alive[chain], sub, -1);
        self.occupied[chain] = i64x2_with_lane(self.occupied[chain], sub, -1);
        self.iters[chain] = i64x2_with_lane(self.iters[chain], sub, 0);
        self.next_save[chain] = i64x2_with_lane(
            self.next_save[chain],
            sub,
            i64::from(PERIODICITY_FIRST_SAVE),
        );
        self.slots[chain][sub] = index;
    }

    /// Marks a lane idle once the point queue is exhausted.
    fn clear(&mut self, chain: usize, sub: usize) {
        self.alive[chain] = i64x2_with_lane(self.alive[chain], sub, 0);
        self.occupied[chain] = i64x2_with_lane(self.occupied[chain], sub, 0);
        self.slots[chain][sub] = IDLE_SLOT;
    }
}

/// Pulls the next point that actually needs iterating; points inside the main
/// cardioid or period-2 bulb are resolved to `max_iterations` on the spot.
#[cfg(target_arch = "wasm32")]
fn next_streamable_point(
    points: &[(f64, f64)],
    results: &mut [(u32, Complex64)],
    next_point: &mut usize,
    max_iterations: u32,
) -> Option<usize> {
    while *next_point < points.len() {
        let index = *next_point;
        *next_point += 1;
        let (re, im) = points[index];
        if in_main_cardioid_or_bulb(re, im) {
            results[index] = (max_iterations, Complex64::new(re, im));
        } else {
            return Some(index);
        }
    }
    None
}

/// Streaming escape-time kernel (quadratic case): keeps `CHAINS` f64x2
/// vectors of pixels in flight and refills a lane as soon as its pixel
/// escapes, is detected periodic, or exhausts the iteration budget — so no
/// lane idles waiting for a slow neighbor, unlike the fixed-batch kernels.
/// All bookkeeping — escape detection, retirement, budget, periodicity —
/// runs only every `QUADRATIC_STREAM_STRIDE` iterations, so the per-step loop is the
/// bare z² + c recurrence. Escaped lanes free-run past the radius between
/// boundaries (|z| grows monotonically once past it, and inf/NaN blow-ups
/// fail the boundary `lt` the same way); the exact escape step and frozen z
/// are recovered by replaying at most `QUADRATIC_STREAM_STRIDE` scalar steps from the
/// previous boundary's checkpoint with the same IEEE op order, so results
/// are bit-identical to the scalar loop.
///
/// When compiled with `relaxed-simd` (the dual-build fast artifact; the
/// simd128-only artifact keeps the exact step), the recurrence uses relaxed
/// fused multiply-adds — hardware FMA on every relaxed-simd browser — and
/// the scalar replay switches to `f64::mul_add` (correctly rounded fused
/// fma) so replayed trajectories match the vector lanes wherever the
/// engine's relaxed madd is fused (all known relaxed-simd implementations
/// on FMA-capable hardware). The output is then rounding-class different
/// from the exact kernel: gated by the statistical-equivalence tier, not
/// byte-exactness (LOG.md 2026-07-10).
#[cfg(target_arch = "wasm32")]
fn stream_escape_quadratic<const CHAINS: usize>(
    points: &[(f64, f64)],
    max_iterations: u32,
    escape_radius_squared: f64,
    results: &mut [(u32, Complex64)],
) {
    use core::arch::wasm32::*;

    let mut lanes = StreamLanes::<CHAINS>::new();
    let mut next_point = 0usize;
    let mut live_lanes = 0usize;

    for chain in 0..CHAINS {
        for sub in 0..2 {
            if let Some(index) =
                next_streamable_point(points, results, &mut next_point, max_iterations)
            {
                lanes.load(chain, sub, index, points[index]);
                live_lanes += 1;
            }
        }
    }
    if live_lanes == 0 {
        return;
    }

    let radius_squared = f64x2_splat(escape_radius_squared);
    #[cfg(not(target_feature = "relaxed-simd"))]
    let two = f64x2_splat(2.0);
    let max_iterations_minus_one = i64x2_splat(i64::from(max_iterations) - 1);
    let stride_iters = i64x2_splat(i64::from(QUADRATIC_STREAM_STRIDE));

    // z at the previous boundary, per lane: the replay start point for exact
    // escape recovery. Fresh loads land exactly on boundaries, so a
    // checkpoint is always a true orbit value with an exact `iters`.
    let mut checkpoint_re = lanes.z_re;
    let mut checkpoint_im = lanes.z_im;

    loop {
        for _ in 0..QUADRATIC_STREAM_STRIDE {
            for chain in 0..CHAINS {
                let z_re = lanes.z_re[chain];
                let z_im = lanes.z_im[chain];
                // zr' = fma(zr, zr, cr - zi*zi), zi' = fma(2*zr, zi, ci):
                // 7 ops -> 4, critical path 3 -> 2.
                #[cfg(target_feature = "relaxed-simd")]
                {
                    lanes.z_re[chain] = f64x2_relaxed_madd(
                        z_re,
                        z_re,
                        f64x2_relaxed_nmadd(z_im, z_im, lanes.c_re[chain]),
                    );
                    lanes.z_im[chain] =
                        f64x2_relaxed_madd(f64x2_add(z_re, z_re), z_im, lanes.c_im[chain]);
                }
                #[cfg(not(target_feature = "relaxed-simd"))]
                {
                    lanes.z_re[chain] = f64x2_add(
                        f64x2_sub(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im)),
                        lanes.c_re[chain],
                    );
                    lanes.z_im[chain] =
                        f64x2_add(f64x2_mul(two, f64x2_mul(z_re, z_im)), lanes.c_im[chain]);
                }
            }
        }

        for chain in 0..CHAINS {
            let z_re = lanes.z_re[chain];
            let z_im = lanes.z_im[chain];
            // Deferred escape detection: an occupied lane whose boundary z is
            // at or past the radius (or NaN, which fails the lt) escaped at
            // some step in the stride just run; the replay below finds which.
            let norm_sqr = f64x2_add(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im));
            let within = f64x2_lt(norm_sqr, radius_squared);
            let alive = v128_and(lanes.occupied[chain], within);
            let escaped = v128_andnot(lanes.occupied[chain], within);
            // Lanes still within the radius ran the full stride; escaped
            // lanes keep their previous-boundary count, which is exactly the
            // replay's starting iteration.
            lanes.iters[chain] = i64x2_add(lanes.iters[chain], v128_and(stride_iters, alive));
            lanes.alive[chain] = alive;

            // A lane is finished when it escaped, ran out its budget, or
            // exactly revisited a saved z.
            let out_of_budget = i64x2_gt(lanes.iters[chain], max_iterations_minus_one);
            let cycled = v128_and(
                v128_and(
                    f64x2_eq(z_re, lanes.saved_re[chain]),
                    f64x2_eq(z_im, lanes.saved_im[chain]),
                ),
                alive,
            );
            let finished = v128_or(escaped, v128_and(alive, v128_or(out_of_budget, cycled)));

            if v128_any_true(finished) {
                for sub in 0..2 {
                    if i64x2_lane(finished, sub) == 0 {
                        continue;
                    }
                    let index = lanes.slots[chain][sub];
                    let (escape_iterations, z) = if i64x2_lane(escaped, sub) != 0 {
                        // Replay from the previous boundary's checkpoint with
                        // the kernel's exact op order to recover the escape
                        // step and the frozen z. The boundary z failed the
                        // radius check after QUADRATIC_STREAM_STRIDE steps, so the loop
                        // bound is also the correctness bound: if every check
                        // passes, the escape happened on the final step and
                        // the loop exits holding exactly that z and count.
                        let c_re = f64x2_lane(lanes.c_re[chain], sub);
                        let c_im = f64x2_lane(lanes.c_im[chain], sub);
                        let mut re = f64x2_lane(checkpoint_re[chain], sub);
                        let mut im = f64x2_lane(checkpoint_im[chain], sub);
                        let mut iterations = i64x2_lane(lanes.iters[chain], sub);
                        // Replay arithmetic must match the kernel step. In
                        // relaxed-simd builds that means replaying THROUGH
                        // the same relaxed madd instructions (value in lane
                        // 0), which reproduces the vector trajectory exactly
                        // on any engine, fused or not - and costs hardware
                        // FMA, not a libm fma call (~3x slowdown measured on
                        // low-escape-count seahorse views with the scalar
                        // f64::mul_add form).
                        #[cfg(target_feature = "relaxed-simd")]
                        {
                            let c_re_v = f64x2_splat(c_re);
                            let c_im_v = f64x2_splat(c_im);
                            let mut z_re_v = f64x2_splat(re);
                            let mut z_im_v = f64x2_splat(im);
                            for _ in 0..QUADRATIC_STREAM_STRIDE {
                                re = f64x2_extract_lane::<0>(z_re_v);
                                im = f64x2_extract_lane::<0>(z_im_v);
                                // Not `>=`: a NaN norm must read as escaped,
                                // the same way it fails the kernel's
                                // f64x2_lt.
                                #[allow(clippy::neg_cmp_op_on_partial_ord)]
                                if !(re * re + im * im < escape_radius_squared) {
                                    break;
                                }
                                let next_re = f64x2_relaxed_madd(
                                    z_re_v,
                                    z_re_v,
                                    f64x2_relaxed_nmadd(z_im_v, z_im_v, c_re_v),
                                );
                                z_im_v =
                                    f64x2_relaxed_madd(f64x2_add(z_re_v, z_re_v), z_im_v, c_im_v);
                                z_re_v = next_re;
                                iterations += 1;
                            }
                            // On break the vector is unchanged since the
                            // extraction, so this is a no-op; on a full-
                            // stride run it picks up the final step's z
                            // (the boundary value that escaped).
                            re = f64x2_extract_lane::<0>(z_re_v);
                            im = f64x2_extract_lane::<0>(z_im_v);
                        }
                        #[cfg(not(target_feature = "relaxed-simd"))]
                        for _ in 0..QUADRATIC_STREAM_STRIDE {
                            // Not `>=`: a NaN norm must read as escaped, the
                            // same way it fails the kernel's f64x2_lt.
                            #[allow(clippy::neg_cmp_op_on_partial_ord)]
                            if !(re * re + im * im < escape_radius_squared) {
                                break;
                            }
                            let next_re = re * re - im * im + c_re;
                            im = 2.0 * (re * im) + c_im;
                            re = next_re;
                            iterations += 1;
                        }
                        (
                            (iterations as u32).min(max_iterations),
                            Complex64::new(re, im),
                        )
                    } else {
                        // Periodic or out of budget: both report
                        // max_iterations (out-of-budget lanes may have
                        // overshot by up to stride-1 steps, hence the min).
                        (
                            max_iterations,
                            Complex64::new(f64x2_lane(z_re, sub), f64x2_lane(z_im, sub)),
                        )
                    };
                    results[index] = (escape_iterations, z);

                    match next_streamable_point(points, results, &mut next_point, max_iterations) {
                        Some(next_index) => lanes.load(chain, sub, next_index, points[next_index]),
                        None => {
                            lanes.clear(chain, sub);
                            live_lanes -= 1;
                        }
                    }
                }
            }

            // Periodicity saves land at per-lane iteration counts that are
            // multiples of the stride (8, 16, 32, ... plus masked-step skew of
            // 0), keeping detection guaranteed as in the scalar loop.
            let save_due = v128_andnot(
                lanes.alive[chain],
                i64x2_gt(lanes.next_save[chain], lanes.iters[chain]),
            );
            lanes.saved_re[chain] =
                v128_bitselect(lanes.z_re[chain], lanes.saved_re[chain], save_due);
            lanes.saved_im[chain] =
                v128_bitselect(lanes.z_im[chain], lanes.saved_im[chain], save_due);
            lanes.next_save[chain] = v128_bitselect(
                i64x2_shl(lanes.next_save[chain], 1),
                lanes.next_save[chain],
                save_due,
            );

            // Refilled lanes just loaded their z1 = c with iters 0, and
            // continuing lanes sit on an exact boundary orbit value — either
            // way this is a valid replay start for the next stride.
            checkpoint_re[chain] = lanes.z_re[chain];
            checkpoint_im[chain] = lanes.z_im[chain];
        }

        if live_lanes == 0 {
            break;
        }
    }
}

/// Multiplies two complex numbers held as (re, im) f64x2 lane pairs, with
/// num-complex's operation order per lane so lane arithmetic is
/// IEEE-identical to `Complex64` multiplication.
///
/// In relaxed-simd builds (the dual-build fast artifact) each component's
/// second multiply fuses into the combining add/sub — hardware FMA, 6 ops
/// -> 4 per complex multiply. The result is then rounding-class different
/// from `Complex64` multiplication; every caller trajectory is judged by
/// the statistical-equivalence tier, and any scalar recovery path must
/// replay through these same instructions (see `stream_escape_general`).
/// The simd128-only artifact keeps the exact form.
#[cfg(target_arch = "wasm32")]
#[inline]
fn complex_mul_lanes(
    a_re: core::arch::wasm32::v128,
    a_im: core::arch::wasm32::v128,
    b_re: core::arch::wasm32::v128,
    b_im: core::arch::wasm32::v128,
) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;
    #[cfg(target_feature = "relaxed-simd")]
    {
        (
            f64x2_relaxed_nmadd(a_im, b_im, f64x2_mul(a_re, b_re)),
            f64x2_relaxed_madd(a_im, b_re, f64x2_mul(a_re, b_im)),
        )
    }
    #[cfg(not(target_feature = "relaxed-simd"))]
    {
        (
            f64x2_sub(f64x2_mul(a_re, b_re), f64x2_mul(a_im, b_im)),
            f64x2_add(f64x2_mul(a_re, b_im), f64x2_mul(a_im, b_re)),
        )
    }
}

/// Raises every chain's z lanes to `exponent`, replicating num-complex's
/// square-and-multiply sequence (`powu`) so per-lane results are
/// bit-identical to `z.powu(exponent)`. Each squaring/multiply is a serial
/// step in the chain's dependency chain, so all chains advance through each
/// step together to keep `CHAINS` independent chains in the pipeline (the
/// same latency-hiding structure as the perturbation fused general step).
#[cfg(all(target_arch = "wasm32", not(target_feature = "relaxed-simd")))]
#[inline]
fn fused_powu_lanes<const CHAINS: usize>(
    z_re: &[core::arch::wasm32::v128; CHAINS],
    z_im: &[core::arch::wasm32::v128; CHAINS],
    exponent: u32,
) -> (
    [core::arch::wasm32::v128; CHAINS],
    [core::arch::wasm32::v128; CHAINS],
) {
    use core::arch::wasm32::*;

    if exponent == 0 {
        return ([f64x2_splat(1.0); CHAINS], [f64x2_splat(0.0); CHAINS]);
    }

    let mut exp = exponent;
    let mut base_re = *z_re;
    let mut base_im = *z_im;

    while exp & 1 == 0 {
        for chain in 0..CHAINS {
            let (re, im) = complex_mul_lanes(
                base_re[chain],
                base_im[chain],
                base_re[chain],
                base_im[chain],
            );
            base_re[chain] = re;
            base_im[chain] = im;
        }
        exp >>= 1;
    }

    if exp == 1 {
        return (base_re, base_im);
    }

    let mut acc_re = base_re;
    let mut acc_im = base_im;
    while exp > 1 {
        exp >>= 1;
        for chain in 0..CHAINS {
            let (re, im) = complex_mul_lanes(
                base_re[chain],
                base_im[chain],
                base_re[chain],
                base_im[chain],
            );
            base_re[chain] = re;
            base_im[chain] = im;
        }
        if exp & 1 == 1 {
            for chain in 0..CHAINS {
                let (re, im) =
                    complex_mul_lanes(acc_re[chain], acc_im[chain], base_re[chain], base_im[chain]);
                acc_re[chain] = re;
                acc_im[chain] = im;
            }
        }
    }
    (acc_re, acc_im)
}

/// Complex multiply-add for (re, im) f64x2 lane pairs in relaxed-simd
/// builds: `a * b + addend` with both the inner cross terms and the addend
/// fused (4 FMA-class ops, one shorter dependency chain than multiply then
/// add). Used to fold the escape step's `+ c` into the final multiply of
/// the powu chain; rounding-class output, judged like `complex_mul_lanes`.
#[cfg(all(target_arch = "wasm32", target_feature = "relaxed-simd"))]
#[inline]
fn complex_mul_add_lanes(
    a_re: core::arch::wasm32::v128,
    a_im: core::arch::wasm32::v128,
    b_re: core::arch::wasm32::v128,
    b_im: core::arch::wasm32::v128,
    add_re: core::arch::wasm32::v128,
    add_im: core::arch::wasm32::v128,
) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;
    (
        f64x2_relaxed_madd(a_re, b_re, f64x2_relaxed_nmadd(a_im, b_im, add_re)),
        f64x2_relaxed_madd(a_re, b_im, f64x2_relaxed_madd(a_im, b_re, add_im)),
    )
}

/// The general kernel's full escape step in relaxed-simd builds:
/// `z = z.powu(exponent) + c` with num-complex's square-and-multiply
/// structure, every complex multiply on hardware FMA, and `c` fused into
/// the chain's final multiply (the last even-loop squaring when `exponent`
/// is a power of two, the last accumulator multiply otherwise — the final
/// `exp == 1` is odd, so that multiply always runs last).
#[cfg(all(target_arch = "wasm32", target_feature = "relaxed-simd"))]
#[inline]
fn fused_powu_add_c_lanes<const CHAINS: usize>(
    z_re: &[core::arch::wasm32::v128; CHAINS],
    z_im: &[core::arch::wasm32::v128; CHAINS],
    c_re: &[core::arch::wasm32::v128; CHAINS],
    c_im: &[core::arch::wasm32::v128; CHAINS],
    exponent: u32,
) -> (
    [core::arch::wasm32::v128; CHAINS],
    [core::arch::wasm32::v128; CHAINS],
) {
    use core::arch::wasm32::*;

    let mut base_re = *z_re;
    let mut base_im = *z_im;

    if exponent <= 1 {
        // Degenerate exponents (the client clamps to >= 2): plain adds.
        if exponent == 0 {
            base_re = [f64x2_splat(1.0); CHAINS];
            base_im = [f64x2_splat(0.0); CHAINS];
        }
        for chain in 0..CHAINS {
            base_re[chain] = f64x2_add(base_re[chain], c_re[chain]);
            base_im[chain] = f64x2_add(base_im[chain], c_im[chain]);
        }
        return (base_re, base_im);
    }

    let trailing = exponent.trailing_zeros();
    let is_power_of_two = exponent >> trailing == 1;

    for squaring in 0..trailing {
        let fuse_c = is_power_of_two && squaring == trailing - 1;
        for chain in 0..CHAINS {
            let (re, im) = if fuse_c {
                complex_mul_add_lanes(
                    base_re[chain],
                    base_im[chain],
                    base_re[chain],
                    base_im[chain],
                    c_re[chain],
                    c_im[chain],
                )
            } else {
                complex_mul_lanes(
                    base_re[chain],
                    base_im[chain],
                    base_re[chain],
                    base_im[chain],
                )
            };
            base_re[chain] = re;
            base_im[chain] = im;
        }
    }
    if is_power_of_two {
        return (base_re, base_im);
    }

    let mut exp = exponent >> trailing;
    let mut acc_re = base_re;
    let mut acc_im = base_im;
    while exp > 1 {
        exp >>= 1;
        for chain in 0..CHAINS {
            let (re, im) = complex_mul_lanes(
                base_re[chain],
                base_im[chain],
                base_re[chain],
                base_im[chain],
            );
            base_re[chain] = re;
            base_im[chain] = im;
        }
        if exp & 1 == 1 {
            let fuse_c = exp == 1;
            for chain in 0..CHAINS {
                let (re, im) = if fuse_c {
                    complex_mul_add_lanes(
                        acc_re[chain],
                        acc_im[chain],
                        base_re[chain],
                        base_im[chain],
                        c_re[chain],
                        c_im[chain],
                    )
                } else {
                    complex_mul_lanes(acc_re[chain], acc_im[chain], base_re[chain], base_im[chain])
                };
                acc_re[chain] = re;
                acc_im[chain] = im;
            }
        }
    }
    (acc_re, acc_im)
}

/// Streaming escape-time kernel for general exponents: the lane-refilling
/// structure of `stream_escape_quadratic` with the iteration step
/// `z = z.powu(exponent) + c` via `fused_powu_lanes`. In simd128-only
/// builds results are bit-identical to
/// `calculate_escape_iterations_general`; in relaxed-simd builds the step
/// is `fused_powu_add_c_lanes` — the powu chain's complex multiplies on
/// hardware FMA with `c` folded into the final multiply — the escape
/// replay runs through the same fused instructions in lane 0, and the
/// output is rounding-class different — gated by the
/// statistical-equivalence tier, not byte-exactness (LOG.md 2026-07-10).
/// There is no closed-form interior test for general exponents, so points
/// stream in unfiltered.
///
/// As in the quadratic kernel, all bookkeeping is deferred to
/// `STREAM_STRIDE` boundaries, leaving the per-step loop as the bare fused
/// powu + c. The escaped-lane free-run is safe for every exponent d >= 2
/// (the client clamps to >= 2): once |z| >= R = 3 and |z| >= |c|,
/// |z^d + c| >= |z|^d - |z| >= 2|z|, so growth past the radius is monotone
/// (and inf/NaN blow-ups fail the boundary `lt` the same way). The exact
/// escape step and frozen z are recovered by replaying at most
/// `STREAM_STRIDE` steps from the previous boundary's checkpoint with the
/// kernel's own step arithmetic (scalar `powu` in exact builds, lane-0
/// `fused_powu_lanes` in relaxed builds), so the replay is bit-identical
/// to the lane arithmetic either way.
#[cfg(target_arch = "wasm32")]
fn stream_escape_general<const CHAINS: usize>(
    points: &[(f64, f64)],
    max_iterations: u32,
    escape_radius_squared: f64,
    exponent: u32,
    results: &mut [(u32, Complex64)],
) {
    use core::arch::wasm32::*;

    let mut lanes = StreamLanes::<CHAINS>::new();
    let mut next_point = 0usize;
    let mut live_lanes = 0usize;

    for chain in 0..CHAINS {
        for sub in 0..2 {
            if next_point < points.len() {
                lanes.load(chain, sub, next_point, points[next_point]);
                next_point += 1;
                live_lanes += 1;
            }
        }
    }
    if live_lanes == 0 {
        return;
    }

    let radius_squared = f64x2_splat(escape_radius_squared);
    let max_iterations_minus_one = i64x2_splat(i64::from(max_iterations) - 1);
    let stride_iters = i64x2_splat(i64::from(STREAM_STRIDE));

    // z at the previous boundary, per lane: the replay start point for exact
    // escape recovery (see stream_escape_quadratic).
    let mut checkpoint_re = lanes.z_re;
    let mut checkpoint_im = lanes.z_im;

    loop {
        for _ in 0..STREAM_STRIDE {
            #[cfg(target_feature = "relaxed-simd")]
            {
                let (next_re, next_im) = fused_powu_add_c_lanes::<CHAINS>(
                    &lanes.z_re,
                    &lanes.z_im,
                    &lanes.c_re,
                    &lanes.c_im,
                    exponent,
                );
                lanes.z_re = next_re;
                lanes.z_im = next_im;
            }
            #[cfg(not(target_feature = "relaxed-simd"))]
            {
                let (pow_re, pow_im) =
                    fused_powu_lanes::<CHAINS>(&lanes.z_re, &lanes.z_im, exponent);
                for chain in 0..CHAINS {
                    lanes.z_re[chain] = f64x2_add(pow_re[chain], lanes.c_re[chain]);
                    lanes.z_im[chain] = f64x2_add(pow_im[chain], lanes.c_im[chain]);
                }
            }
        }

        for chain in 0..CHAINS {
            let z_re = lanes.z_re[chain];
            let z_im = lanes.z_im[chain];
            // Deferred escape detection: an occupied lane whose boundary z is
            // at or past the radius (or NaN, which fails the lt) escaped at
            // some step in the stride just run; the replay below finds which.
            let norm_sqr = f64x2_add(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im));
            let within = f64x2_lt(norm_sqr, radius_squared);
            let alive = v128_and(lanes.occupied[chain], within);
            let escaped = v128_andnot(lanes.occupied[chain], within);
            // Lanes still within the radius ran the full stride; escaped
            // lanes keep their previous-boundary count, which is exactly the
            // replay's starting iteration.
            lanes.iters[chain] = i64x2_add(lanes.iters[chain], v128_and(stride_iters, alive));
            lanes.alive[chain] = alive;

            // A lane is finished when it escaped, ran out its budget, or
            // exactly revisited a saved z.
            let out_of_budget = i64x2_gt(lanes.iters[chain], max_iterations_minus_one);
            let cycled = v128_and(
                v128_and(
                    f64x2_eq(z_re, lanes.saved_re[chain]),
                    f64x2_eq(z_im, lanes.saved_im[chain]),
                ),
                alive,
            );
            let finished = v128_or(escaped, v128_and(alive, v128_or(out_of_budget, cycled)));

            if v128_any_true(finished) {
                for sub in 0..2 {
                    if i64x2_lane(finished, sub) == 0 {
                        continue;
                    }
                    let index = lanes.slots[chain][sub];
                    let (escape_iterations, z) = if i64x2_lane(escaped, sub) != 0 {
                        // Replay from the previous boundary's checkpoint with
                        // the kernel's exact op order to recover the escape
                        // step and the frozen z; the loop bound doubles as
                        // the correctness bound as in the quadratic kernel.
                        let mut iterations = i64x2_lane(lanes.iters[chain], sub);
                        // Replay arithmetic must match the kernel step. In
                        // relaxed-simd builds that means replaying THROUGH
                        // the same fused powu (value in lane 0) — see the
                        // quadratic kernel's replay for why f64::mul_add is
                        // not an option here.
                        #[cfg(target_feature = "relaxed-simd")]
                        let z = {
                            let c_re_v = f64x2_splat(f64x2_lane(lanes.c_re[chain], sub));
                            let c_im_v = f64x2_splat(f64x2_lane(lanes.c_im[chain], sub));
                            let mut z_re_v = [f64x2_splat(f64x2_lane(checkpoint_re[chain], sub))];
                            let mut z_im_v = [f64x2_splat(f64x2_lane(checkpoint_im[chain], sub))];
                            for _ in 0..STREAM_STRIDE {
                                let re = f64x2_extract_lane::<0>(z_re_v[0]);
                                let im = f64x2_extract_lane::<0>(z_im_v[0]);
                                // Not `>=`: a NaN norm must read as escaped,
                                // the same way it fails the kernel's
                                // f64x2_lt.
                                #[allow(clippy::neg_cmp_op_on_partial_ord)]
                                if !(re * re + im * im < escape_radius_squared) {
                                    break;
                                }
                                let (next_re, next_im) = fused_powu_add_c_lanes::<1>(
                                    &z_re_v,
                                    &z_im_v,
                                    &[c_re_v],
                                    &[c_im_v],
                                    exponent,
                                );
                                z_re_v = next_re;
                                z_im_v = next_im;
                                iterations += 1;
                            }
                            Complex64::new(
                                f64x2_extract_lane::<0>(z_re_v[0]),
                                f64x2_extract_lane::<0>(z_im_v[0]),
                            )
                        };
                        #[cfg(not(target_feature = "relaxed-simd"))]
                        let z = {
                            let c = Complex64::new(
                                f64x2_lane(lanes.c_re[chain], sub),
                                f64x2_lane(lanes.c_im[chain], sub),
                            );
                            let mut z = Complex64::new(
                                f64x2_lane(checkpoint_re[chain], sub),
                                f64x2_lane(checkpoint_im[chain], sub),
                            );
                            for _ in 0..STREAM_STRIDE {
                                // Not `>=`: a NaN norm must read as escaped,
                                // the same way it fails the kernel's
                                // f64x2_lt.
                                #[allow(clippy::neg_cmp_op_on_partial_ord)]
                                if !(z.norm_sqr() < escape_radius_squared) {
                                    break;
                                }
                                z = z.powu(exponent) + c;
                                iterations += 1;
                            }
                            z
                        };
                        ((iterations as u32).min(max_iterations), z)
                    } else {
                        // Periodic or out of budget: both report
                        // max_iterations (out-of-budget lanes may have
                        // overshot by up to stride-1 steps, hence no exact
                        // count to report).
                        (
                            max_iterations,
                            Complex64::new(f64x2_lane(z_re, sub), f64x2_lane(z_im, sub)),
                        )
                    };
                    results[index] = (escape_iterations, z);

                    if next_point < points.len() {
                        lanes.load(chain, sub, next_point, points[next_point]);
                        next_point += 1;
                    } else {
                        lanes.clear(chain, sub);
                        live_lanes -= 1;
                    }
                }
            }

            // Periodicity saves land at per-lane iteration counts that are
            // multiples of the stride (8, 16, 32, ... plus masked-step skew of
            // 0), keeping detection guaranteed as in the scalar loop.
            let save_due = v128_andnot(
                lanes.alive[chain],
                i64x2_gt(lanes.next_save[chain], lanes.iters[chain]),
            );
            lanes.saved_re[chain] =
                v128_bitselect(lanes.z_re[chain], lanes.saved_re[chain], save_due);
            lanes.saved_im[chain] =
                v128_bitselect(lanes.z_im[chain], lanes.saved_im[chain], save_due);
            lanes.next_save[chain] = v128_bitselect(
                i64x2_shl(lanes.next_save[chain], 1),
                lanes.next_save[chain],
                save_due,
            );

            // Refilled lanes just loaded their z1 = c with iters 0, and
            // continuing lanes sit on an exact boundary orbit value — either
            // way this is a valid replay start for the next stride.
            checkpoint_re[chain] = lanes.z_re[chain];
            checkpoint_im[chain] = lanes.z_im[chain];
        }

        if live_lanes == 0 {
            break;
        }
    }
}

/// Renders the full pixel grid via Mariani–Silver subdivision. Each wave
/// streams the pending rects' uncomputed border-ring pixels through the
/// lane-refilling kernel in one call; a rect whose entire ring reports
/// `max_iterations` fills its inside as interior without computing it, and
/// any other rect splits into quadrants for the next wave. Rects at or below
/// `MARIANI_LEAF` compute all their pixels directly. Every pixel is computed
/// at most once, so escaper-only tiles pay only bookkeeping.
///
/// The fill assumes a ring of max-iteration pixels never encloses a pixel
/// that escapes within budget — exact in the continuum (maximum principle on
/// the Green's function, which holds for every multibrot degree), and
/// breakable only by sub-pixel exterior channels: the same assumption
/// `rect_in_set` already makes at tile level for every exponent.
#[cfg(target_arch = "wasm32")]
fn stream_tile_subdivided(
    re_values: &[f64],
    im_values: &[f64],
    max_iterations: u32,
    exponent: u32,
    results: &mut [(u32, Complex64)],
) {
    let width = re_values.len();
    let mut points: Vec<(f64, f64)> = Vec::new();
    subdivide_tile_streamed(
        width,
        im_values.len(),
        max_iterations,
        results,
        |pixels, wave_results| {
            points.clear();
            points.extend(
                pixels
                    .iter()
                    .map(|&pixel| (re_values[pixel % width], im_values[pixel / width])),
            );
            if exponent == 2 {
                stream_escape_quadratic::<QUADRATIC_STREAM_CHAINS>(
                    &points,
                    max_iterations,
                    ESCAPE_RADIUS.powi(2),
                    wave_results,
                );
            } else {
                stream_escape_general::<STREAM_CHAINS>(
                    &points,
                    max_iterations,
                    ESCAPE_RADIUS.powi(2),
                    exponent,
                    wave_results,
                );
            }
        },
    );
}

/// The Mariani–Silver wave/worklist machinery, generic over the streaming
/// kernel: each wave hands `compute_wave` the pending rects' uncomputed
/// pixel indices (row-major) to resolve into the matching slots of the
/// output slice in one kernel call. `results` must arrive filled with
/// `UNCOMPUTED`.
#[cfg(target_arch = "wasm32")]
pub(crate) fn subdivide_tile_streamed(
    width: usize,
    height: usize,
    max_iterations: u32,
    results: &mut [(u32, Complex64)],
    mut compute_wave: impl FnMut(&[usize], &mut [(u32, Complex64)]),
) {
    #[derive(Clone, Copy)]
    struct Rect {
        x0: usize,
        y0: usize,
        x1: usize, // exclusive
        y1: usize, // exclusive
    }

    fn is_leaf(rect: &Rect) -> bool {
        rect.x1 - rect.x0 <= MARIANI_LEAF || rect.y1 - rect.y0 <= MARIANI_LEAF
    }

    let mut pending = vec![Rect {
        x0: 0,
        y0: 0,
        x1: width,
        y1: height,
    }];
    let mut wave_pixels: Vec<usize> = Vec::new();
    let mut wave_results: Vec<(u32, Complex64)> = Vec::new();

    while !pending.is_empty() {
        wave_pixels.clear();

        {
            let mut schedule = |x: usize, y: usize| {
                let pixel_index = y * width + x;
                if results[pixel_index].0 == UNCOMPUTED {
                    wave_pixels.push(pixel_index);
                }
            };

            for rect in &pending {
                let leaf = is_leaf(rect);
                for y in rect.y0..rect.y1 {
                    if leaf || y == rect.y0 || y == rect.y1 - 1 {
                        for x in rect.x0..rect.x1 {
                            schedule(x, y);
                        }
                    } else {
                        schedule(rect.x0, y);
                        if rect.x1 - rect.x0 > 1 {
                            schedule(rect.x1 - 1, y);
                        }
                    }
                }
            }
        }

        wave_results.clear();
        wave_results.resize(wave_pixels.len(), (0, Complex64::new(0.0, 0.0)));
        compute_wave(&wave_pixels, &mut wave_results);
        for (position, &pixel_index) in wave_pixels.iter().enumerate() {
            results[pixel_index] = wave_results[position];
        }

        let mut next: Vec<Rect> = Vec::new();
        for rect in &pending {
            if is_leaf(rect) {
                continue;
            }

            let mut ring_interior = true;
            'ring: for y in rect.y0..rect.y1 {
                if y == rect.y0 || y == rect.y1 - 1 {
                    for x in rect.x0..rect.x1 {
                        if results[y * width + x].0 != max_iterations {
                            ring_interior = false;
                            break 'ring;
                        }
                    }
                } else if results[y * width + rect.x0].0 != max_iterations
                    || results[y * width + rect.x1 - 1].0 != max_iterations
                {
                    ring_interior = false;
                    break;
                }
            }

            if ring_interior {
                for y in (rect.y0 + 1)..(rect.y1 - 1) {
                    for x in (rect.x0 + 1)..(rect.x1 - 1) {
                        let pixel_index = y * width + x;
                        if results[pixel_index].0 == UNCOMPUTED {
                            results[pixel_index] = (max_iterations, Complex64::new(0.0, 0.0));
                        }
                    }
                }
            } else {
                let x_mid = (rect.x0 + rect.x1) / 2;
                let y_mid = (rect.y0 + rect.y1) / 2;
                next.push(Rect {
                    x0: rect.x0,
                    y0: rect.y0,
                    x1: x_mid,
                    y1: y_mid,
                });
                next.push(Rect {
                    x0: x_mid,
                    y0: rect.y0,
                    x1: rect.x1,
                    y1: y_mid,
                });
                next.push(Rect {
                    x0: rect.x0,
                    y0: y_mid,
                    x1: x_mid,
                    y1: rect.y1,
                });
                next.push(Rect {
                    x0: x_mid,
                    y0: y_mid,
                    x1: rect.x1,
                    y1: rect.y1,
                });
            }
        }
        pending = next;
    }
}

/// Escape iterations for a pair of pixels sharing one call, batched into SIMD
/// lanes where a batched implementation exists (wasm32, exponent 2).
#[cfg(target_arch = "wasm32")]
fn calculate_escape_iterations_pair(
    first: (f64, f64),
    second: (f64, f64),
    max_iterations: u32,
    exponent: u32,
) -> [(u32, Complex64); 2] {
    if exponent == 2 {
        calculate_escape_iterations_quadratic_pair(
            Complex64::new(first.0, first.1),
            Complex64::new(second.0, second.1),
            max_iterations,
            ESCAPE_RADIUS.powi(2),
        )
    } else {
        [
            calculate_escape_iterations(first.0, first.1, max_iterations, exponent),
            calculate_escape_iterations(second.0, second.1, max_iterations, exponent),
        ]
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn calculate_escape_iterations_pair(
    first: (f64, f64),
    second: (f64, f64),
    max_iterations: u32,
    exponent: u32,
) -> [(u32, Complex64); 2] {
    [
        calculate_escape_iterations(first.0, first.1, max_iterations, exponent),
        calculate_escape_iterations(second.0, second.1, max_iterations, exponent),
    ]
}

/// Escape iterations for four pixels sharing one call, batched across two
/// f64x2 vectors where a batched implementation exists (wasm32, exponent 2).
#[cfg(target_arch = "wasm32")]
fn calculate_escape_iterations_quad(
    points: [(f64, f64); 4],
    max_iterations: u32,
    exponent: u32,
) -> [(u32, Complex64); 4] {
    if exponent == 2 {
        calculate_escape_iterations_quadratic_quad(
            [
                Complex64::new(points[0].0, points[0].1),
                Complex64::new(points[1].0, points[1].1),
                Complex64::new(points[2].0, points[2].1),
                Complex64::new(points[3].0, points[3].1),
            ],
            max_iterations,
            ESCAPE_RADIUS.powi(2),
        )
    } else {
        let first =
            calculate_escape_iterations_pair(points[0], points[1], max_iterations, exponent);
        let second =
            calculate_escape_iterations_pair(points[2], points[3], max_iterations, exponent);
        [first[0], first[1], second[0], second[1]]
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn calculate_escape_iterations_quad(
    points: [(f64, f64); 4],
    max_iterations: u32,
    exponent: u32,
) -> [(u32, Complex64); 4] {
    let first = calculate_escape_iterations_pair(points[0], points[1], max_iterations, exponent);
    let second = calculate_escape_iterations_pair(points[2], points[3], max_iterations, exponent);
    [first[0], first[1], second[0], second[1]]
}

/// Calculates the number of iterations it takes for a complex number to escape the set,
/// based on the given coordinates, maximum iterations, escape radius, and exponent.
///
/// # Parameters
/// - `x`: The real part of the complex number.
/// - `y`: The imaginary part of the complex number.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `exponent`: The exponent used in the escape time algorithm.
///
/// # Returns
/// A tuple containing the number of iterations it took to escape and the final value of the complex number.
fn calculate_escape_iterations(
    x: f64,
    y: f64,
    max_iterations: u32,
    exponent: u32,
) -> (u32, Complex64) {
    let c = Complex64::new(x, y);

    if exponent == 2 {
        calculate_escape_iterations_quadratic(c, max_iterations, ESCAPE_RADIUS.powi(2))
    } else {
        calculate_escape_iterations_general(c, max_iterations, ESCAPE_RADIUS.powi(2), exponent)
    }
}

/// Checks if a point is within the Mandelbrot set. Production code goes
/// through `points_in_set_pair` instead to use the SIMD-batched loop.
#[cfg(test)]
fn point_in_set(re: f64, im: f64, max_iterations: u32, exponent: u32) -> bool {
    calculate_escape_iterations(re, im, max_iterations, exponent).0 == max_iterations
}

/// Checks whether both of two points are within the Mandelbrot set, batching
/// them into SIMD lanes where a batched implementation exists.
fn points_in_set_pair(
    first: (f64, f64),
    second: (f64, f64),
    max_iterations: u32,
    exponent: u32,
) -> bool {
    calculate_escape_iterations_pair(first, second, max_iterations, exponent)
        .iter()
        .all(|&(iterations, _)| iterations == max_iterations)
}

/// Checks whether all four points are within the Mandelbrot set, batching
/// them across two f64x2 vectors where a batched implementation exists.
fn points_in_set_quad(points: [(f64, f64); 4], max_iterations: u32, exponent: u32) -> bool {
    calculate_escape_iterations_quad(points, max_iterations, exponent)
        .iter()
        .all(|&(iterations, _)| iterations == max_iterations)
}

/// Checks if a rectangle, defined by ranges of real and imaginary values, is completely within the Mandelbrot set.
/// This is determined using a specified maximum number of iterations, escape radius, and exponent for the escape time
/// algorithm. The Mandelbrot set is simply connected, meaning if the rectangle's border is in the set, the entire
/// rectangle is guaranteed to be in the set as well.
///
/// # Parameters
/// - `re_range`: A range of real values to check.
/// - `im_range`: A range of imaginary values to check.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `exponent`: The exponent used in the escape time algorithm.
///
/// # Returns
/// `true` if the entire rectangle is within the Mandelbrot set, `false` otherwise.
fn rect_in_set(
    re_range: itertools_num::Linspace<f64>,
    im_range: itertools_num::Linspace<f64>,
    max_iterations: u32,
    exponent: u32,
) -> bool {
    let (re_min, re_max) = (
        re_range.clone().next().unwrap(),
        re_range.clone().next_back().unwrap(),
    );
    let (im_min, im_max) = (
        im_range.clone().next().unwrap(),
        im_range.clone().next_back().unwrap(),
    );

    // If any corner is not in the set, the rectangle is not entirely in the set
    if !points_in_set_quad(
        [
            (re_min, im_min),
            (re_min, im_max),
            (re_max, im_min),
            (re_max, im_max),
        ],
        max_iterations,
        exponent,
    ) {
        return false;
    }

    // Check the borders of the rectangle, two border-crossing point pairs per
    // batched call.
    let border_in_set = |values: itertools_num::Linspace<f64>,
                         point_pair_at: &dyn Fn(f64) -> [(f64, f64); 2]|
     -> bool {
        let values: Vec<f64> = values.collect();
        let mut index = 0;
        while index + 1 < values.len() {
            let first = point_pair_at(values[index]);
            let second = point_pair_at(values[index + 1]);
            if !points_in_set_quad(
                [first[0], first[1], second[0], second[1]],
                max_iterations,
                exponent,
            ) {
                return false;
            }
            index += 2;
        }
        while index < values.len() {
            let pair = point_pair_at(values[index]);
            if !points_in_set_pair(pair[0], pair[1], max_iterations, exponent) {
                return false;
            }
            index += 1;
        }
        true
    };

    if !border_in_set(re_range, &|re| [(re, im_min), (re, im_max)]) {
        return false;
    }

    if !border_in_set(im_range, &|im| [(re_min, im), (re_max, im)]) {
        return false;
    }

    true
}

/// Represents a valid color space that can be used to transform colors.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug)]
pub enum ValidColorSpace {
    Hsl,
    Hsluv,
    Lch,
    Okhsl,
}

/// Transforms a color using the specified color space and transformation amounts.
///
/// # Parameters
/// - `color`: The color to transform.
/// - `color_space`: The color space to use for the transformation.
/// - `shift_hue_amount`: The amount to shift the hue by.
/// - `saturate_amount`: The amount to saturate the color by.
/// - `lighten_amount`: The amount to lighten the color by.
///
/// # Returns
/// The transformed color.
pub fn transform_color(
    color: colorous::Color,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
) -> colorous::Color {
    let mut transformed_color = color;

    if shift_hue_amount != 0.0 || saturate_amount != 0.0 || lighten_amount != 0.0 {
        let srgb_color = Srgb::new(
            color.r as f32 / 255.0,
            color.g as f32 / 255.0,
            color.b as f32 / 255.0,
        );

        let modified_color: Srgb = match color_space {
            ValidColorSpace::Hsl => {
                let hsl_color = Hsl::from_color(srgb_color);
                hsl_color
                    .shift_hue(shift_hue_amount)
                    .saturate(saturate_amount)
                    .lighten(lighten_amount)
                    .into_color()
            }
            ValidColorSpace::Hsluv => {
                let hsluv_color = Hsluv::from_color(srgb_color);
                hsluv_color
                    .shift_hue(shift_hue_amount)
                    .saturate(saturate_amount)
                    .lighten(lighten_amount)
                    .into_color()
            }
            ValidColorSpace::Lch => {
                let lch_color = Lch::from_color(srgb_color);
                lch_color
                    .shift_hue(shift_hue_amount)
                    .saturate(saturate_amount)
                    .lighten(lighten_amount)
                    .into_color()
            }
            ValidColorSpace::Okhsl => {
                let okhsl_color = Okhsl::from_color(srgb_color);
                okhsl_color
                    .shift_hue(shift_hue_amount)
                    .saturate(saturate_amount)
                    .lighten(lighten_amount)
                    .into_color()
            }
        };

        let rgb_color: Srgb = modified_color.into_color();

        transformed_color = colorous::Color {
            r: (rgb_color.red * 255.0) as u8,
            g: (rgb_color.green * 255.0) as u8,
            b: (rgb_color.blue * 255.0) as u8,
        };
    }

    transformed_color
}

/// Determines the color palette to use based on the given color scheme and reverse colors option.
///
/// # Parameters
/// - `color_scheme`: The name of the color scheme to use.
/// - `reverse_colors`: Whether to reverse the colors of the color scheme.
///
/// # Returns
/// A tuple containing the selected color palette, whether the colors should
/// be reversed, and whether the palette is cyclical (starts and ends on the
/// same color, so repeats of it tile seamlessly).
fn get_color_palette(color_scheme: &str, reverse_colors: bool) -> (&'static Palette, bool, bool) {
    static FALLBACK_PALETTE: Lazy<Palette> = Lazy::new(|| Palette::Original(colorous::TURBO));

    let palette = COLOR_PALETTES
        .get(color_scheme)
        .or_else(|| REVERSE_COLOR_PALETTES.get(color_scheme))
        .unwrap_or_else(|| &FALLBACK_PALETTE);

    let should_reverse_colors = if REVERSE_COLOR_PALETTES.contains_key(color_scheme) {
        !reverse_colors
    } else {
        reverse_colors
    };

    let is_cyclic = matches!(color_scheme, "rainbow" | "sinebow");

    (palette, should_reverse_colors, is_cyclic)
}

/// Remaps a normalized palette position through a histogram-equalization
/// lookup table (a monotone CDF over the palette window, sampled uniformly
/// across [0, 1]) with linear interpolation between entries. The client
/// builds one table per viewport from the visible escape-value distribution,
/// so equal palette spans cover equal visible pixel mass (histogram
/// coloring). Runs after the linear min/max normalization and before
/// `apply_color_cycles`, so the palette window keeps its clamping meaning and
/// color cycles become mass-uniform. Tables with fewer than two entries
/// cannot be interpolated and fall back to the identity (linear) mapping.
fn apply_palette_cdf(norm: f64, cdf: &[f32]) -> f64 {
    if cdf.len() < 2 {
        return norm;
    }

    let position = norm.clamp(0.0, 1.0) * (cdf.len() - 1) as f64;
    let index = (position as usize).min(cdf.len() - 2);
    let fraction = position - index as f64;
    let start = f64::from(cdf[index]);
    let end = f64::from(cdf[index + 1]);

    (start + (end - start) * fraction).clamp(0.0, 1.0)
}

/// Remaps a normalized gradient position so the palette repeats
/// `color_cycles` times across the [0, 1] range. Cyclical palettes wrap
/// (their endpoints already match); non-cyclical ones boomerang, alternating
/// forward and backward passes so consecutive repetitions join without a
/// seam.
fn apply_color_cycles(norm: f64, color_cycles: u32, palette_is_cyclic: bool) -> f64 {
    if color_cycles <= 1 {
        return norm;
    }

    let scaled = norm * f64::from(color_cycles);
    if palette_is_cyclic {
        scaled.fract()
    } else {
        let phase = scaled % 2.0;
        if phase <= 1.0 {
            phase
        } else {
            2.0 - phase
        }
    }
}

/// Calculates the color for a given point in the Mandelbrot set.
///
/// # Parameters
/// - `re`: The real part of the complex number.
/// - `im`: The imaginary part of the complex number.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `exponent`: The exponent used in the escape time algorithm.
/// - `palette`: The color palette to use.
/// - `should_reverse_colors`: Whether to reverse the colors of the color scheme.
/// - `color_space`: The color space to use for color transformations.
/// - `shift_hue_amount`: The amount to shift the hue by.
/// - `saturate_amount`: The amount to saturate the color by.
/// - `lighten_amount`: The amount to lighten the color by.
/// - `smooth_coloring`: Whether to use smooth coloring.
/// - `min_iterations_threshold`: The minimum threshold for color palette mapping.
/// - `max_iterations_threshold`: The maximum threshold for color palette mapping.
///
/// # Returns
/// An array of 3 u8 values representing the RGB color.
/// Production code goes through `calculate_escape_iterations_pair` plus
/// `color_from_escape_result` instead so it can also track iteration stats.
#[cfg(test)]
fn compute_pixel_color(
    re: f64,
    im: f64,
    max_iterations: u32,
    exponent: u32,
    palette: &Palette,
    should_reverse_colors: bool,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    smooth_coloring: bool,
    min_iterations_threshold: f64,
    max_iterations_threshold: f64,
) -> RgbColor {
    let (escape_iterations, z) = calculate_escape_iterations(re, im, max_iterations, exponent);

    color_from_escape_result(
        escape_iterations,
        z,
        max_iterations,
        exponent,
        palette,
        should_reverse_colors,
        color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        smooth_coloring,
        min_iterations_threshold,
        max_iterations_threshold,
    )
}

/// The (optionally smoothed) escape value for a pixel, or `f64::INFINITY`
/// when the pixel never escaped. This is the palette-independent quantity
/// the color mapping consumes, and — narrowed to f32 — what tiles cache
/// client-side so they can be recolored without recomputing escape times.
fn smoothed_escape_value(
    escape_iterations: u32,
    z: Complex64,
    max_iterations: u32,
    exponent: u32,
    smooth_coloring: bool,
) -> f64 {
    if escape_iterations == max_iterations {
        return f64::INFINITY;
    }

    if smooth_coloring {
        static ESCAPE_RADIUS_LN: once_cell::sync::Lazy<f64> =
            once_cell::sync::Lazy::new(|| ESCAPE_RADIUS.ln());

        let exponent_ln = f64::from(exponent).ln();

        // See: https://iquilezles.org/articles/msetsmooth/
        f64::from(escape_iterations) - ((z.norm().ln() / *ESCAPE_RADIUS_LN).ln() / exponent_ln)
    } else {
        f64::from(escape_iterations)
    }
}

/// Maps a smoothed escape value (see `smoothed_escape_value`) to a color.
/// Non-finite values mark interior pixels and map to black.
fn color_from_smoothed_value(
    smoothed_value: f64,
    palette: &Palette,
    should_reverse_colors: bool,
    palette_is_cyclic: bool,
    color_cycles: u32,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    min_iterations_threshold: f64,
    max_iterations_threshold: f64,
    palette_cdf: Option<&[f32]>,
) -> RgbColor {
    if !smoothed_value.is_finite() {
        return [0, 0, 0];
    }

    // Normalize the value between min and max thresholds to get 0.0 to 1.0
    let mut norm = if smoothed_value <= min_iterations_threshold {
        0.0
    } else if smoothed_value >= max_iterations_threshold {
        1.0
    } else {
        (smoothed_value - min_iterations_threshold)
            / (max_iterations_threshold - min_iterations_threshold)
    };

    // Histogram coloring (histogram equalization): remap the position
    // within the palette window so equal palette spans cover equal visible
    // pixel mass. Absent (None) means the linear mapping above stands.
    if let Some(cdf) = palette_cdf {
        norm = apply_palette_cdf(norm, cdf);
    }

    norm = apply_color_cycles(norm, color_cycles, palette_is_cyclic);

    if should_reverse_colors {
        norm = 1.0 - norm;
    }

    let color = palette.eval_continuous(norm);

    transform_color(
        color,
        color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
    )
    .as_array()
}

/// Maps an escape-time result to a color. Production code composes
/// `smoothed_escape_value` + `color_from_smoothed_value` directly so it can
/// also cache the value; this convenience wrapper remains for tests.
#[cfg(test)]
fn color_from_escape_result(
    escape_iterations: u32,
    z: Complex64,
    max_iterations: u32,
    exponent: u32,
    palette: &Palette,
    should_reverse_colors: bool,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    smooth_coloring: bool,
    min_iterations_threshold: f64,
    max_iterations_threshold: f64,
) -> RgbColor {
    color_from_smoothed_value(
        smoothed_escape_value(
            escape_iterations,
            z,
            max_iterations,
            exponent,
            smooth_coloring,
        ),
        palette,
        should_reverse_colors,
        false,
        1,
        color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        min_iterations_threshold,
        max_iterations_threshold,
        None,
    )
}

/// Generates the Mandelbrot set image data.
///
/// # Parameters
/// - `re_range`: The range of real values.
/// - `im_range`: The range of imaginary values.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `exponent`: The exponent used in the escape time algorithm.
/// - `image_width`: The width of the image, in pixels.
/// - `image_height`: The height of the image, in pixels.
/// - `palette`: The color palette to use.
/// - `should_reverse_colors`: Whether to reverse the colors of the color scheme.
/// - `palette_is_cyclic`: Whether the palette's endpoints match (see `apply_color_cycles`).
/// - `color_cycles`: How many times the palette repeats across the palette range.
/// - `color_space`: The color space to use for color transformations.
/// - `shift_hue_amount`: The amount to shift the hue by.
/// - `saturate_amount`: The amount to saturate the color by.
/// - `lighten_amount`: The amount to lighten the color by.
/// - `smooth_coloring`: Whether to use smooth coloring.
/// - `palette_min_iter`: The minimum iteration count for the color palette range.
/// - `palette_max_iter`: The maximum iteration count for the color palette range.
/// - `palette_cdf`: Optional histogram-equalization lookup table (see
///   `apply_palette_cdf`); `None` keeps the linear mapping.
///
/// # Returns
/// The rendered tile: RGBA bytes, per-pixel smoothed escape values, and the
/// iteration stats observed while rendering.
fn render_mandelbrot_set(
    re_range: itertools_num::Linspace<f64>,
    im_range: itertools_num::Linspace<f64>,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    palette: &Palette,
    should_reverse_colors: bool,
    palette_is_cyclic: bool,
    color_cycles: u32,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
    palette_cdf: Option<&[f32]>,
) -> RenderedTile {
    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];
    let mut values: Vec<f32> = vec![f32::INFINITY; image_width * image_height];
    let mut stats = TileIterationStats::default();

    // Pre-fill the alpha channel with 255 for the entire image
    for alpha_idx in (3..output_size).step_by(NUM_COLOR_CHANNELS) {
        img[alpha_idx] = 255;
    }

    let min_iterations_threshold = f64::from(palette_min_iter);
    let max_iterations_threshold =
        f64::from(palette_max_iter).max(min_iterations_threshold + f64::EPSILON);

    let re_values: Vec<f64> = re_range.collect();

    let mut write_pixel = |pixel_index: usize, escape_iterations: u32, z: Complex64| {
        stats.record(escape_iterations, max_iterations);

        let smoothed_value = smoothed_escape_value(
            escape_iterations,
            z,
            max_iterations,
            exponent,
            smooth_coloring,
        );
        values[pixel_index] = smoothed_value as f32;

        let pixel = color_from_smoothed_value(
            smoothed_value,
            palette,
            should_reverse_colors,
            palette_is_cyclic,
            color_cycles,
            color_space,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            min_iterations_threshold,
            max_iterations_threshold,
            palette_cdf,
        );

        let index = pixel_index * NUM_COLOR_CHANNELS;
        img[index] = pixel[0];
        img[index + 1] = pixel[1];
        img[index + 2] = pixel[2];
    };

    // Tiles render via Mariani–Silver subdivision over the lane-refilling
    // stream kernel matching the exponent (quadratic or general); non-wasm
    // builds use the fixed-batch loop instead.
    #[cfg(target_arch = "wasm32")]
    {
        let im_values: Vec<f64> = im_range.collect();
        let mut results =
            vec![(UNCOMPUTED, Complex64::new(0.0, 0.0)); re_values.len() * im_values.len()];
        stream_tile_subdivided(
            &re_values,
            &im_values,
            max_iterations,
            exponent,
            &mut results,
        );

        for (pixel_index, &(escape_iterations, z)) in results.iter().enumerate() {
            write_pixel(pixel_index, escape_iterations, z);
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    for (x, im) in im_range.enumerate() {
        let mut y = 0;
        while y + 3 < re_values.len() {
            let results = calculate_escape_iterations_quad(
                [
                    (re_values[y], im),
                    (re_values[y + 1], im),
                    (re_values[y + 2], im),
                    (re_values[y + 3], im),
                ],
                max_iterations,
                exponent,
            );

            for (lane, &(escape_iterations, z)) in results.iter().enumerate() {
                write_pixel(x * image_width + y + lane, escape_iterations, z);
            }

            y += 4;
        }
        while y + 1 < re_values.len() {
            let results = calculate_escape_iterations_pair(
                (re_values[y], im),
                (re_values[y + 1], im),
                max_iterations,
                exponent,
            );

            for (lane, &(escape_iterations, z)) in results.iter().enumerate() {
                write_pixel(x * image_width + y + lane, escape_iterations, z);
            }

            y += 2;
        }

        if y < re_values.len() {
            let (escape_iterations, z) =
                calculate_escape_iterations(re_values[y], im, max_iterations, exponent);
            write_pixel(x * image_width + y, escape_iterations, z);
        }
    }

    // Both callers of this loop are the direct f64 path.
    RenderedTile {
        image: img,
        values,
        stats,
        tier: RenderTier::Direct,
    }
}

/// Creates a solid black image
fn create_solid_black_image(image_width: usize, image_height: usize) -> Vec<u8> {
    vec![0, 0, 0, 255]
        .into_iter()
        .cycle()
        .take(image_width * image_height * NUM_COLOR_CHANNELS)
        .collect()
}

/// Renders a Mandelbrot set image over an f64 view rectangle, returning the
/// RGBA bytes, per-pixel smoothed escape values, and iteration stats.
fn generate_mandelbrot_set_image(
    re_min: f64,
    re_max: f64,
    im_min: f64,
    im_max: f64,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: &str,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
    color_cycles: u32,
    palette_cdf: Option<&[f32]>,
) -> RenderedTile {
    let (palette, should_reverse_colors, palette_is_cyclic) =
        get_color_palette(color_scheme, reverse_colors);

    let re_range = linspace(re_min, re_max, image_width);
    let im_range = linspace(im_max, im_min, image_height);

    if rect_in_set(re_range.clone(), im_range.clone(), max_iterations, exponent) {
        return RenderedTile::solid_black(image_width, image_height, RenderTier::Direct);
    }

    render_mandelbrot_set(
        re_range,
        im_range,
        max_iterations,
        exponent,
        image_width,
        image_height,
        palette,
        should_reverse_colors,
        palette_is_cyclic,
        color_cycles,
        &color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        smooth_coloring,
        palette_min_iter,
        palette_max_iter,
        palette_cdf,
    )
}

/// Renders a tile in distance-estimate mode (issue #46) over an f64 view
/// rectangle. Each exterior pixel's brightness derives from its distance to
/// the set boundary (`distance_estimate_at_c` / `distance_estimate_brightness`)
/// rather than its escape time, so the boundary renders at a uniform visual
/// weight regardless of iteration count — the standard way to produce crisp
/// boundary images. Interior pixels stay black.
///
/// A dedicated scalar loop rather than the tuned streaming escape kernels:
/// tracking the derivative doubles the per-step work, so per the issue it is a
/// separate kernel variant selected by mode, not a branch in the hot loops.
///
/// The per-pixel `[0, 1]` brightness is stored in the cached `values` (interior
/// pixels keep the `INFINITY` sentinel), and the palette is applied over the
/// fixed `0..1` range — so DE tiles recolor through the same `recolor_tile`
/// pipeline as escape-time tiles (`ColoringOptions::distance_estimate` selects
/// the fixed range there). Iteration stats stay `None`: the palette range is
/// fixed, so there is nothing to auto-fit.
fn generate_distance_estimate_image(
    re_min: f64,
    re_max: f64,
    im_min: f64,
    im_max: f64,
    pixel_spacing: f64,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: &str,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    color_cycles: u32,
) -> RenderedTile {
    let (palette, should_reverse_colors, palette_is_cyclic) =
        get_color_palette(color_scheme, reverse_colors);

    let re_range = linspace(re_min, re_max, image_width);
    let im_range = linspace(im_max, im_min, image_height);

    if rect_in_set(re_range.clone(), im_range.clone(), max_iterations, exponent) {
        return RenderedTile::solid_black(image_width, image_height, RenderTier::Direct);
    }

    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];
    let mut values: Vec<f32> = vec![f32::INFINITY; image_width * image_height];
    for alpha_idx in (3..output_size).step_by(NUM_COLOR_CHANNELS) {
        img[alpha_idx] = 255;
    }

    let escape_radius_squared = ESCAPE_RADIUS * ESCAPE_RADIUS;
    let re_values: Vec<f64> = re_range.collect();

    for (row, im) in im_range.enumerate() {
        for (col, &re) in re_values.iter().enumerate() {
            let distance = distance_estimate_at_c(
                Complex64::new(re, im),
                max_iterations,
                escape_radius_squared,
                exponent,
            );
            let brightness = distance_estimate_brightness(distance, pixel_spacing);

            let pixel_index = row * image_width + col;
            // Narrow to f32 before coloring so the tile matches a later
            // `recolor_tile` of these same cached values bit-for-bit (recolor
            // only has the f32 values to work from).
            let brightness = f64::from(brightness as f32);
            values[pixel_index] = brightness as f32;

            // DE brightness is already normalized to [0, 1]; the palette maps
            // it over that fixed range (interior/INFINITY renders black).
            // Fixed-palette mode: histogram equalization does not apply.
            let pixel = color_from_smoothed_value(
                brightness,
                palette,
                should_reverse_colors,
                palette_is_cyclic,
                color_cycles,
                &color_space,
                shift_hue_amount,
                saturate_amount,
                lighten_amount,
                0.0,
                1.0,
                None,
            );

            let index = pixel_index * NUM_COLOR_CHANNELS;
            img[index] = pixel[0];
            img[index + 1] = pixel[1];
            img[index + 2] = pixel[2];
        }
    }

    RenderedTile {
        image: img,
        values,
        // The palette range is fixed at 0..1 in DE mode, so there is no
        // iteration range to auto-fit.
        stats: TileIterationStats::default(),
        tier: RenderTier::Direct,
    }
}

/// Renders a tile in atom-domain mode (issue #45) over an f64 view rectangle.
/// Each pixel is colored by the iteration index at which its orbit came closest
/// to the origin (`atom_domain_index_at_c`), scattered across the palette by
/// `atom_domain_value` so each detected period reads as a distinct categorical
/// band — visualizing where the components of each period live rather than the
/// escape-time gradient.
///
/// Unlike escape-time or distance-estimate mode, *every* pixel (interior and
/// exterior alike) has a nearest-approach index, so there is no interior black
/// sentinel: an interior tile is a meaningful flat atom domain, not a void. A
/// dedicated scalar loop rather than the tuned streaming escape kernels, for
/// the same reason distance-estimate mode uses one — this is a separate kernel
/// variant selected by mode, not a branch in the hot loops.
///
/// The per-pixel `[0, 1)` value is stored in the cached `values` and the
/// palette is applied over the fixed `0..1` range, so atom-domain tiles recolor
/// through the same `recolor_tile` pipeline as escape-time tiles
/// (`ColoringOptions::atom_domain` selects the fixed range there). Iteration
/// stats stay `None`: the palette range is fixed, so there is nothing to
/// auto-fit.
#[allow(clippy::too_many_arguments)]
fn generate_atom_domain_image(
    re_min: f64,
    re_max: f64,
    im_min: f64,
    im_max: f64,
    max_iterations: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: &str,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    color_cycles: u32,
) -> RenderedTile {
    let (palette, should_reverse_colors, palette_is_cyclic) =
        get_color_palette(color_scheme, reverse_colors);

    let re_range = linspace(re_min, re_max, image_width);
    let im_range = linspace(im_max, im_min, image_height);

    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];
    // Every pixel has an atom-domain value, so none stays at the interior
    // Infinity sentinel — but initialize to it anyway (harmless, and matches
    // the escape/DE buffers) before overwriting every entry below.
    let mut values: Vec<f32> = vec![f32::INFINITY; image_width * image_height];
    for alpha_idx in (3..output_size).step_by(NUM_COLOR_CHANNELS) {
        img[alpha_idx] = 255;
    }

    let escape_radius_squared = ESCAPE_RADIUS * ESCAPE_RADIUS;
    let re_values: Vec<f64> = re_range.collect();

    for (row, im) in im_range.enumerate() {
        for (col, &re) in re_values.iter().enumerate() {
            let index = atom_domain_index_at_c(
                Complex64::new(re, im),
                max_iterations,
                escape_radius_squared,
            );
            let value = atom_domain_value(index);

            let pixel_index = row * image_width + col;
            // Narrow to f32 before coloring so the tile matches a later
            // `recolor_tile` of these same cached values bit-for-bit (recolor
            // only has the f32 values to work from).
            let value = f64::from(value as f32);
            values[pixel_index] = value as f32;

            // The atom-domain value is already in [0, 1); the palette maps it
            // over that fixed range. Fixed-palette mode: histogram
            // equalization does not apply.
            let pixel = color_from_smoothed_value(
                value,
                palette,
                should_reverse_colors,
                palette_is_cyclic,
                color_cycles,
                &color_space,
                shift_hue_amount,
                saturate_amount,
                lighten_amount,
                0.0,
                1.0,
                None,
            );

            let index = pixel_index * NUM_COLOR_CHANNELS;
            img[index] = pixel[0];
            img[index + 1] = pixel[1];
            img[index + 2] = pixel[2];
        }
    }

    RenderedTile {
        image: img,
        values,
        // The palette range is fixed at 0..1 in atom-domain mode, so there is
        // no iteration range to auto-fit.
        stats: TileIterationStats::default(),
        tier: RenderTier::Direct,
    }
}

/// Half-width of the fixed complex-plane window a Julia thumbnail spans, in
/// each direction from the origin. A filled Julia set for `z^2 + c` lives
/// entirely within `|z| <= 2` (the escape radius of the quadratic map), so a
/// square view of `[-2, 2] x [-2, 2]` always frames the whole set regardless
/// of the parameter `c`. Higher exponents stay within their (smaller) escape
/// radius too, so the same window frames them.
const JULIA_VIEW_HALF_EXTENT: f64 = 2.0;

/// Renders a Julia set thumbnail for the fixed parameter `c = (c_re, c_im)`.
///
/// Where the Mandelbrot renderer sweeps `c` across the pixels (iterating from
/// `z = 0`), a Julia render fixes `c` for the whole image and sweeps the
/// starting point `z0` across the pixels of a fixed `[-2, 2] x [-2, 2]` window
/// (see `JULIA_VIEW_HALF_EXTENT`), iterating `z -> z^exponent + c`. The escape
/// counts feed the same smoothing and coloring pipeline as a Mandelbrot tile,
/// so the thumbnail honors the map's palette and appearance settings.
///
/// A plain scalar loop (as the distance-estimate renderer uses): the thumbnail
/// is small and computed only when the cursor pauses, so it never touches the
/// tuned streaming escape kernels.
#[allow(clippy::too_many_arguments)]
fn generate_julia_image(
    c_re: f64,
    c_im: f64,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: &str,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
    color_cycles: u32,
    palette_cdf: Option<&[f32]>,
) -> RenderedTile {
    let (palette, should_reverse_colors, palette_is_cyclic) =
        get_color_palette(color_scheme, reverse_colors);

    // The starting point z0 sweeps the fixed window; im runs top-to-bottom so
    // the thumbnail's orientation matches the map (increasing im upward).
    let re_range = linspace(-JULIA_VIEW_HALF_EXTENT, JULIA_VIEW_HALF_EXTENT, image_width);
    let im_range = linspace(
        JULIA_VIEW_HALF_EXTENT,
        -JULIA_VIEW_HALF_EXTENT,
        image_height,
    );

    let c = Complex64::new(c_re, c_im);
    let escape_radius_squared = ESCAPE_RADIUS * ESCAPE_RADIUS;

    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];
    let mut values: Vec<f32> = vec![f32::INFINITY; image_width * image_height];
    let mut stats = TileIterationStats::default();
    for alpha_idx in (3..output_size).step_by(NUM_COLOR_CHANNELS) {
        img[alpha_idx] = 255;
    }

    let min_iterations_threshold = f64::from(palette_min_iter);
    let max_iterations_threshold =
        f64::from(palette_max_iter).max(min_iterations_threshold + f64::EPSILON);

    let re_values: Vec<f64> = re_range.collect();

    for (row, im) in im_range.enumerate() {
        for (col, &re) in re_values.iter().enumerate() {
            let (escape_iterations, z) = calculate_julia_escape_iterations(
                Complex64::new(re, im),
                c,
                max_iterations,
                escape_radius_squared,
                exponent,
            );
            stats.record(escape_iterations, max_iterations);

            let smoothed_value = smoothed_escape_value(
                escape_iterations,
                z,
                max_iterations,
                exponent,
                smooth_coloring,
            );

            let pixel_index = row * image_width + col;
            values[pixel_index] = smoothed_value as f32;

            let pixel = color_from_smoothed_value(
                smoothed_value,
                palette,
                should_reverse_colors,
                palette_is_cyclic,
                color_cycles,
                &color_space,
                shift_hue_amount,
                saturate_amount,
                lighten_amount,
                min_iterations_threshold,
                max_iterations_threshold,
                palette_cdf,
            );

            let index = pixel_index * NUM_COLOR_CHANNELS;
            img[index] = pixel[0];
            img[index + 1] = pixel[1];
            img[index + 2] = pixel[2];
        }
    }

    RenderedTile {
        image: img,
        values,
        stats,
        tier: RenderTier::Direct,
    }
}

#[wasm_bindgen]
pub fn get_mandelbrot_set_image(
    re_min: f64,
    re_max: f64,
    im_min: f64,
    im_max: f64,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: String,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
) -> Vec<u8> {
    generate_mandelbrot_set_image(
        re_min,
        re_max,
        im_min,
        im_max,
        max_iterations,
        exponent,
        image_width,
        image_height,
        &color_scheme,
        reverse_colors,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        color_space,
        smooth_coloring,
        palette_min_iter,
        palette_max_iter,
        // Signature predates the color-cycles control; a single palette pass
        // matches its historical output.
        1,
        // Frozen signature: no histogram equalization, linear mapping.
        None,
    )
    .image
}

/// Renders a Mandelbrot set image at any zoom depth, returning the RGBA
/// bytes plus the iteration stats observed while rendering.
///
/// The view is described by an arbitrary-precision world origin (decimal
/// strings) plus a rectangle in Leaflet tile coordinates. A tile coordinate
/// `v` at `tile_zoom` maps to the complex offset
/// `((v / 2^(tile_zoom - 2)) * (200 / 128) - 4) * 2^-zoom_offset` from the
/// origin. Views whose pixel spacing leaves f64 coordinates enough headroom
/// use the direct f64 renderer; finer views use perturbation theory with an
/// arbitrary-precision reference orbit, so zoom depth is not limited by f64
/// precision.
fn render_tile_precise(
    origin_re: &str,
    origin_im: &str,
    tile_x_min: f64,
    tile_x_max: f64,
    tile_y_min: f64,
    tile_y_max: f64,
    tile_zoom: i32,
    zoom_offset: u32,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: &str,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
    color_cycles: u32,
    // Distance-estimate rendering mode (issue #46). Only the direct f64 path
    // honors it; deeper (perturbation/float-exp) tiles fall back to escape-time
    // coloring gracefully — see the `distance_estimate` handling below and the
    // client gating that keeps DE mode on shallow views.
    distance_estimate: bool,
    // Atom-domain rendering mode (issue #45): color each pixel by the iteration
    // index of its orbit's nearest approach to the origin, visualizing the
    // set's period structure. Like distance-estimate mode it is direct-f64 only
    // and gated to shallow views by the client; deeper tiles fall back to
    // escape-time coloring.
    atom_domain: bool,
    // Optional histogram-equalization lookup table over the palette window
    // (see `apply_palette_cdf`); `None` keeps the linear mapping. Only the
    // escape-time paths consume it — the fixed-palette modes (distance
    // estimate, atom domains) ignore it.
    palette_cdf: Option<&[f32]>,
) -> RenderedTile {
    let pixel_spacing =
        perturbation::pixel_spacing(tile_x_min, tile_x_max, tile_zoom, zoom_offset, image_width)
            .min(perturbation::pixel_spacing(
                tile_y_min,
                tile_y_max,
                tile_zoom,
                zoom_offset,
                image_height,
            ));

    let use_perturbation = pixel_spacing < perturbation::MIN_DIRECT_PIXEL_SPACING
        && (2..=perturbation::MAX_PERTURBED_EXPONENT).contains(&exponent);

    if !use_perturbation {
        // Shallow view (or unsupported exponent): f64 has enough precision to
        // compute the bounds directly.
        let origin_re_f64: f64 = origin_re.parse().unwrap_or(0.0);
        let origin_im_f64: f64 = origin_im.parse().unwrap_or(0.0);

        let scaled_offset = |tile_coordinate: f64| {
            float_exp::ldexp(
                perturbation::tile_coordinate_offset(tile_coordinate, tile_zoom),
                -(zoom_offset as i64),
            )
        };

        let re_min = origin_re_f64 + scaled_offset(tile_x_min);
        let re_max = origin_re_f64 + scaled_offset(tile_x_max);
        let im_max = origin_im_f64 - scaled_offset(tile_y_min);
        let im_min = origin_im_f64 - scaled_offset(tile_y_max);

        if distance_estimate {
            return generate_distance_estimate_image(
                re_min,
                re_max,
                im_min,
                im_max,
                pixel_spacing,
                max_iterations,
                exponent,
                image_width,
                image_height,
                color_scheme,
                reverse_colors,
                shift_hue_amount,
                saturate_amount,
                lighten_amount,
                color_space,
                color_cycles,
            );
        }

        if atom_domain {
            return generate_atom_domain_image(
                re_min,
                re_max,
                im_min,
                im_max,
                max_iterations,
                image_width,
                image_height,
                color_scheme,
                reverse_colors,
                shift_hue_amount,
                saturate_amount,
                lighten_amount,
                color_space,
                color_cycles,
            );
        }

        return generate_mandelbrot_set_image(
            re_min,
            re_max,
            im_min,
            im_max,
            max_iterations,
            exponent,
            image_width,
            image_height,
            color_scheme,
            reverse_colors,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            color_space,
            smooth_coloring,
            palette_min_iter,
            palette_max_iter,
            color_cycles,
            palette_cdf,
        );
    }

    // Distance-estimate and atom-domain modes are only implemented on the
    // direct f64 path (each ships direct-first). A deep-zoom tile reaching here
    // in either mode falls through to the escape-time perturbation renderer
    // below — a graceful, if unstyled, image. The client keeps both modes gated
    // to shallow views, so this fallback is a safety net rather than a normal
    // path.
    let _ = distance_estimate;
    let _ = atom_domain;

    // Which perturbation tier this view falls into, computed independently of
    // frame construction so a failed frame (below) still reports the right
    // tier to the diagnostics overlay.
    let effective_zoom = tile_zoom as i64 + zoom_offset as i64;
    let perturbation_tier = if perturbation::uses_float_exp(effective_zoom, exponent) {
        RenderTier::FloatExp
    } else {
        RenderTier::Perturbation
    };

    let frame = match perturbation::PerturbedFrame::new(
        origin_re,
        origin_im,
        tile_x_min,
        tile_x_max,
        tile_y_min,
        tile_y_max,
        tile_zoom,
        zoom_offset,
        image_width,
        image_height,
        max_iterations,
        exponent,
        ESCAPE_RADIUS,
    ) {
        Ok(frame) => frame,
        Err(_) => return RenderedTile::solid_black(image_width, image_height, perturbation_tier),
    };

    if frame.border_in_set(image_width, image_height) {
        return RenderedTile::solid_black(image_width, image_height, perturbation_tier);
    }

    let (palette, should_reverse_colors, palette_is_cyclic) =
        get_color_palette(color_scheme, reverse_colors);

    let min_iterations_threshold = f64::from(palette_min_iter);
    let max_iterations_threshold =
        f64::from(palette_max_iter).max(min_iterations_threshold + f64::EPSILON);

    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];
    let mut values: Vec<f32> = vec![f32::INFINITY; image_width * image_height];
    let mut stats = TileIterationStats::default();

    let escape_results = frame.compute_all(image_width, image_height);
    for (pixel_index, &(escape_iterations, z)) in escape_results.iter().enumerate() {
        stats.record(escape_iterations, max_iterations);

        let smoothed_value = smoothed_escape_value(
            escape_iterations,
            z,
            max_iterations,
            exponent,
            smooth_coloring,
        );
        values[pixel_index] = smoothed_value as f32;

        let pixel = color_from_smoothed_value(
            smoothed_value,
            palette,
            should_reverse_colors,
            palette_is_cyclic,
            color_cycles,
            &color_space,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            min_iterations_threshold,
            max_iterations_threshold,
            palette_cdf,
        );

        let index = pixel_index * NUM_COLOR_CHANNELS;
        img[index] = pixel[0];
        img[index + 1] = pixel[1];
        img[index + 2] = pixel[2];
        img[index + 3] = 255;
    }

    RenderedTile {
        image: img,
        values,
        stats,
        // Authoritative tier from the frame that actually ran, matching the
        // `perturbation_tier` computed above.
        tier: if frame.uses_float_exp() {
            RenderTier::FloatExp
        } else {
            RenderTier::Perturbation
        },
    }
}

/// Renders a Mandelbrot set image at any zoom depth. See
/// `render_tile_precise` for the view geometry.
///
/// Kept with this exact signature and return type for the bench harness,
/// which compares the current build against archived wasm builds; the app
/// worker uses `get_mandelbrot_tile_precise` instead.
#[wasm_bindgen]
pub fn get_mandelbrot_image_precise(
    origin_re: String,
    origin_im: String,
    tile_x_min: f64,
    tile_x_max: f64,
    tile_y_min: f64,
    tile_y_max: f64,
    tile_zoom: i32,
    zoom_offset: u32,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: String,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
) -> Vec<u8> {
    render_tile_precise(
        &origin_re,
        &origin_im,
        tile_x_min,
        tile_x_max,
        tile_y_min,
        tile_y_max,
        tile_zoom,
        zoom_offset,
        max_iterations,
        exponent,
        image_width,
        image_height,
        &color_scheme,
        reverse_colors,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        color_space,
        smooth_coloring,
        palette_min_iter,
        palette_max_iter,
        // Frozen signature (bench harness): predates the color-cycles
        // control, so it renders a single palette pass.
        1,
        // The bench harness only measures escape-time rendering.
        false,
        false,
        // Frozen signature: no histogram equalization, linear mapping.
        None,
    )
    .image
}

/// A rendered tile plus the data the client needs to auto-fit and reapply
/// the palette range without re-rendering: the escaped-pixel iteration
/// range, and (optionally) the per-pixel smoothed escape values that
/// `recolor_tile` consumes.
#[wasm_bindgen]
pub struct MandelbrotTile {
    /// RGBA bytes of the rendered tile.
    #[wasm_bindgen(getter_with_clone)]
    pub image: Vec<u8>,
    /// Per-pixel smoothed escape values (`Infinity` for interior pixels),
    /// or empty when not requested.
    #[wasm_bindgen(getter_with_clone)]
    pub values: Vec<f32>,
    /// Lowest escaped-pixel iteration count, or -1 if no pixel escaped.
    pub min_iter: i32,
    /// Highest escaped-pixel iteration count, or -1 if no pixel escaped.
    pub max_iter: i32,
    /// The precision path that produced this tile, as a `RenderTier`
    /// discriminant (0 direct, 1 perturbation, 2 float-exp). Drives the
    /// client's diagnostics overlay (issue #50).
    pub tier: u8,
}

impl MandelbrotTile {
    fn from_rendered(rendered: RenderedTile, include_values: bool) -> Self {
        let (min_iter, max_iter) = match rendered.stats.range {
            Some((min, max)) => (min as i32, max as i32),
            None => (-1, -1),
        };

        MandelbrotTile {
            image: rendered.image,
            values: if include_values {
                rendered.values
            } else {
                Vec::new()
            },
            min_iter,
            max_iter,
            tier: rendered.tier as u8,
        }
    }
}

/// A rectangle in Leaflet tile coordinates (see `render_tile_precise` for
/// how it maps to the complex plane).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileBounds {
    x_min: f64,
    x_max: f64,
    y_min: f64,
    y_max: f64,
    zoom: i32,
}

/// Color and palette settings shared by rendering (`render_tile`) and
/// recoloring (`recolor_tile`). Field names mirror the client's camelCase
/// payload.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColoringOptions {
    pub color_scheme: String,
    pub reverse_colors: bool,
    pub shift_hue_amount: f32,
    pub saturate_amount: f32,
    pub lighten_amount: f32,
    /// `ValidColorSpace` discriminant, as the client's `<select>` sends it.
    pub color_space: u8,
    pub palette_min_iter: i32,
    pub palette_max_iter: i32,
    pub color_cycles: u32,
    /// Distance-estimate rendering mode (issue #46): the cached `values` are a
    /// palette-independent brightness in `[0, 1]` (see
    /// `distance_estimate_brightness`), not iteration counts, so the palette
    /// range is fixed at `0..1` and the min/max thresholds are ignored.
    /// Defaults to false so escape-time payloads that omit it still parse.
    #[serde(default)]
    pub distance_estimate: bool,
    /// Atom-domain rendering mode (issue #45): the cached `values` are a
    /// palette-independent, period-scattered value in `[0, 1)` (see
    /// `atom_domain_value`), not iteration counts, so the palette range is
    /// fixed at `0..1` and the min/max thresholds are ignored. Defaults to
    /// false so escape-time payloads that omit it still parse.
    #[serde(default)]
    pub atom_domain: bool,
    /// Optional histogram-coloring equalization lookup table: a monotone CDF
    /// over the palette window, sampled uniformly
    /// across [0, 1] (see `apply_palette_cdf`). The client builds one per
    /// viewport from the visible escape-value distribution and sends the same
    /// table to renders and recolors, so the two stay byte-identical and
    /// tiles share one viewport-global mapping (no seams). Defaults to `None`
    /// — the exact linear mapping this option predates.
    #[serde(default)]
    pub palette_cdf: Option<Vec<f32>>,
}

impl ColoringOptions {
    /// The palette-normalization domain: the user's iteration thresholds in
    /// escape-time mode, or the fixed `0..1` range in the palette-independent
    /// modes (distance-estimate and atom-domain), whose cached `values` are
    /// already normalized.
    fn palette_thresholds(&self) -> (f64, f64) {
        if self.distance_estimate || self.atom_domain {
            (0.0, 1.0)
        } else {
            let min = f64::from(self.palette_min_iter);
            (
                min,
                f64::from(self.palette_max_iter).max(min + f64::EPSILON),
            )
        }
    }

    fn color_space(&self) -> ValidColorSpace {
        match self.color_space {
            0 => ValidColorSpace::Hsl,
            1 => ValidColorSpace::Hsluv,
            3 => ValidColorSpace::Okhsl,
            // 2 is the client default; unknown values fall back to it.
            _ => ValidColorSpace::Lch,
        }
    }

    /// The histogram-equalization table to color with, or `None` for the
    /// linear mapping. The fixed-palette modes (distance estimate, atom
    /// domains) always map linearly over their fixed `0..1` domain, so a
    /// stray table is ignored there.
    fn effective_palette_cdf(&self) -> Option<&[f32]> {
        if self.distance_estimate || self.atom_domain {
            None
        } else {
            self.palette_cdf.as_deref()
        }
    }
}

/// Everything a tile render needs, as one deserializable object so new
/// settings are a field addition here and in the client payload — not a new
/// positional argument threaded through every caller.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TileRenderOptions {
    origin_re: String,
    origin_im: String,
    bounds: TileBounds,
    zoom_offset: u32,
    iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    /// Baked into the returned escape values (unlike `coloring`, which only
    /// affects the RGBA bytes), so changing it requires a re-render.
    smooth_coloring: bool,
    include_values: bool,
    coloring: ColoringOptions,
}

impl TileRenderOptions {
    /// Whether this render uses distance-estimate mode (issue #46). The flag
    /// rides on `coloring` so it reaches `recolor_tile` too, but a render also
    /// needs it directly to pick the DE kernel and bake brightness into the
    /// cached `values`.
    fn distance_estimate(&self) -> bool {
        self.coloring.distance_estimate
    }

    /// Whether this render uses atom-domain mode (issue #45). Like
    /// `distance_estimate`, the flag rides on `coloring` so it reaches
    /// `recolor_tile` too, but a render needs it directly to pick the
    /// atom-domain kernel and bake the period value into the cached `values`.
    fn atom_domain(&self) -> bool {
        self.coloring.atom_domain
    }
}

/// Renders a Mandelbrot tile from a single options object (the production
/// client's entrypoint; see `TileRenderOptions`). Behaves exactly like
/// `get_mandelbrot_tile_precise`, which is kept positional only because the
/// bench harness replays recorded positional argument lists against current
/// and archived builds.
#[wasm_bindgen]
pub fn render_tile(options: JsValue) -> Result<MandelbrotTile, JsValue> {
    let options: TileRenderOptions =
        serde_wasm_bindgen::from_value(options).map_err(JsValue::from)?;

    let rendered = render_tile_precise(
        &options.origin_re,
        &options.origin_im,
        options.bounds.x_min,
        options.bounds.x_max,
        options.bounds.y_min,
        options.bounds.y_max,
        options.bounds.zoom,
        options.zoom_offset,
        options.iterations,
        options.exponent,
        options.image_width,
        options.image_height,
        &options.coloring.color_scheme,
        options.coloring.reverse_colors,
        options.coloring.shift_hue_amount,
        options.coloring.saturate_amount,
        options.coloring.lighten_amount,
        options.coloring.color_space(),
        options.smooth_coloring,
        options.coloring.palette_min_iter,
        options.coloring.palette_max_iter,
        options.coloring.color_cycles.max(1),
        options.distance_estimate(),
        options.atom_domain(),
        options.coloring.effective_palette_cdf(),
    );

    Ok(MandelbrotTile::from_rendered(
        rendered,
        options.include_values,
    ))
}

/// Everything a Julia thumbnail render needs (issue #12), as one deserializable
/// object mirroring the client's camelCase payload. Unlike a Mandelbrot tile,
/// the view is fixed (`generate_julia_image` frames the whole set), so this
/// carries only the parameter `c` under the cursor plus the shared appearance
/// settings — no arbitrary-precision origin or tile geometry. `c` is an f64:
/// Julia sets live within `|c| < 2`, well inside f64 precision, and the
/// thumbnail is a coarse preview, so the cursor's deep-zoom sub-pixel precision
/// is not needed here.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JuliaRenderOptions {
    /// The parameter `c` under the cursor, in the complex plane.
    c_re: f64,
    c_im: f64,
    iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    smooth_coloring: bool,
    /// Whether to return the per-pixel escape values alongside the image, so
    /// the panel can refit the palette to the thumbnail's own iteration range
    /// and recolor (auto palette mode); skipped otherwise to avoid the
    /// transfer, as a tile render does.
    include_values: bool,
    coloring: ColoringOptions,
}

/// Renders a Julia set thumbnail for the parameter `c` under the cursor
/// (issue #12). The panel below the controls shows the filled Julia set for
/// `z -> z^exponent + c`, framed to the fixed `[-2, 2] x [-2, 2]` window that
/// contains every such set, colored with the map's current palette and
/// appearance settings. Distance-estimate mode does not apply (it is a
/// Mandelbrot-boundary technique), so the flag is ignored and escape-time
/// coloring is always used. Returns the RGBA bytes plus iteration stats, like a
/// tile render; `include_values` additionally returns the per-pixel escape
/// values for a recoloring pass.
#[wasm_bindgen]
pub fn render_julia(options: JsValue) -> Result<MandelbrotTile, JsValue> {
    let options: JuliaRenderOptions =
        serde_wasm_bindgen::from_value(options).map_err(JsValue::from)?;

    let rendered = generate_julia_image(
        options.c_re,
        options.c_im,
        options.iterations,
        options.exponent,
        options.image_width,
        options.image_height,
        &options.coloring.color_scheme,
        options.coloring.reverse_colors,
        options.coloring.shift_hue_amount,
        options.coloring.saturate_amount,
        options.coloring.lighten_amount,
        options.coloring.color_space(),
        options.smooth_coloring,
        options.coloring.palette_min_iter,
        options.coloring.palette_max_iter,
        options.coloring.color_cycles.max(1),
        options.coloring.effective_palette_cdf(),
    );

    Ok(MandelbrotTile::from_rendered(
        rendered,
        options.include_values,
    ))
}

/// Renders a Mandelbrot tile at any zoom depth (see `render_tile_precise`
/// for the view geometry) and reports the tile's escaped-pixel iteration
/// range alongside the image. When `include_values` is set, the per-pixel
/// smoothed escape values are returned too so the tile can later be
/// recolored via `recolor_tile`; large offscreen renders (image export)
/// skip them to avoid the extra transfer.
///
/// Frozen positional signature: the bench harness replays recorded
/// positional argument lists against current and archived builds. The
/// production client goes through `render_tile` instead.
#[wasm_bindgen]
pub fn get_mandelbrot_tile_precise(
    origin_re: String,
    origin_im: String,
    tile_x_min: f64,
    tile_x_max: f64,
    tile_y_min: f64,
    tile_y_max: f64,
    tile_zoom: i32,
    zoom_offset: u32,
    max_iterations: u32,
    exponent: u32,
    image_width: usize,
    image_height: usize,
    color_scheme: String,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
    include_values: bool,
    // Trailing and optional so the bench harness, which spreads recorded
    // positional args and appends `include_values`, keeps working against
    // both this build and archived ones. Omitted or 0 means a single pass.
    color_cycles: Option<u32>,
) -> MandelbrotTile {
    let rendered = render_tile_precise(
        &origin_re,
        &origin_im,
        tile_x_min,
        tile_x_max,
        tile_y_min,
        tile_y_max,
        tile_zoom,
        zoom_offset,
        max_iterations,
        exponent,
        image_width,
        image_height,
        &color_scheme,
        reverse_colors,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        color_space,
        smooth_coloring,
        palette_min_iter,
        palette_max_iter,
        color_cycles.unwrap_or(1).max(1),
        // Frozen positional signature (bench harness): escape-time only.
        false,
        false,
        // Frozen positional signature: no histogram equalization.
        None,
    );

    MandelbrotTile::from_rendered(rendered, include_values)
}

/// A single point's coordinates, described exactly like a tile render (see
/// `render_tile_precise`): an arbitrary-precision world origin plus a
/// fractional position in Leaflet tile coordinates. Field names mirror the
/// client's camelCase payload.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PointQueryOptions {
    origin_re: String,
    origin_im: String,
    /// Fractional tile x/y of the point (the tile renderer's `x_min`/`y_min`
    /// for a one-pixel span).
    tile_x: f64,
    tile_y: f64,
    tile_zoom: i32,
    zoom_offset: u32,
    iterations: u32,
    exponent: u32,
}

impl PointQueryOptions {
    /// The complex point `c` this query addresses, in f64. Deep-zoom views
    /// whose absolute coordinate exceeds f64 precision lose the sub-pixel
    /// part of the origin here, but the exterior distance estimate is itself
    /// approximate and the orbit diverges from `c` within a few steps, so the
    /// escape-orbit derivative it depends on is unaffected.
    fn c(&self) -> Complex64 {
        let origin_re: f64 = self.origin_re.parse().unwrap_or(0.0);
        let origin_im: f64 = self.origin_im.parse().unwrap_or(0.0);
        let scaled_offset = |tile_coordinate: f64| {
            float_exp::ldexp(
                perturbation::tile_coordinate_offset(tile_coordinate, self.tile_zoom),
                -(self.zoom_offset as i64),
            )
        };
        Complex64::new(
            origin_re + scaled_offset(self.tile_x),
            origin_im - scaled_offset(self.tile_y),
        )
    }
}

/// Exterior distance estimate from a single point to the boundary of the set,
/// in complex-plane units (see `distance_estimate_at_c`). Returns a negative
/// value when the point is inside the set (or the estimate is unavailable), so
/// the client can distinguish "no distance" from a genuine tiny distance
/// without a nullable boundary crossing. Powers the ctrl+hover tooltip's
/// distance-to-boundary readout (issue #42).
#[wasm_bindgen]
pub fn distance_estimate_at_point(options: JsValue) -> Result<f64, JsValue> {
    let options: PointQueryOptions =
        serde_wasm_bindgen::from_value(options).map_err(JsValue::from)?;

    let escape_radius_squared = ESCAPE_RADIUS * ESCAPE_RADIUS;
    Ok(distance_estimate_at_c(
        options.c(),
        options.iterations,
        escape_radius_squared,
        options.exponent,
    )
    .unwrap_or(-1.0))
}

/// Period of the attracting cycle at a single point (see `period_at_c`), for
/// the ctrl+hover tooltip. Returns 0 when the point is not in the set or no
/// cycle is resolved, so the client can treat "no period" without a nullable
/// crossing. Only the quadratic set (exponent 2) has the tooltip's periodicity
/// readout; other exponents report 0. Powers the period readout (issue #39).
#[wasm_bindgen]
pub fn period_at_point(options: JsValue) -> Result<u32, JsValue> {
    let options: PointQueryOptions =
        serde_wasm_bindgen::from_value(options).map_err(JsValue::from)?;

    if options.exponent != 2 {
        return Ok(0);
    }

    let escape_radius_squared = ESCAPE_RADIUS * ESCAPE_RADIUS;
    Ok(period_at_c(options.c(), options.iterations, escape_radius_squared).unwrap_or(0))
}

/// Recolors a tile from its cached per-pixel smoothed escape values (as
/// returned by a tile render), producing the RGBA bytes the full renderer
/// would produce for the same color settings — without recomputing escape
/// times. Anything that changes the escape values themselves (iterations,
/// exponent, smooth coloring) still requires a re-render. The values stay a
/// positional typed-array argument (wasm-bindgen's zero-copy view); only the
/// scalar settings ride in the options object.
#[wasm_bindgen]
pub fn recolor_tile(values: &[f32], options: JsValue) -> Result<Vec<u8>, JsValue> {
    let options: ColoringOptions =
        serde_wasm_bindgen::from_value(options).map_err(JsValue::from)?;
    Ok(recolor_values(values, &options))
}

/// Typed core of `recolor_tile`, callable from native tests and examples
/// (which cannot build a `JsValue`).
pub fn recolor_values(values: &[f32], options: &ColoringOptions) -> Vec<u8> {
    let (palette, should_reverse_colors, palette_is_cyclic) =
        get_color_palette(&options.color_scheme, options.reverse_colors);
    let color_cycles = options.color_cycles.max(1);
    let color_space = options.color_space();

    let (min_iterations_threshold, max_iterations_threshold) = options.palette_thresholds();
    let palette_cdf = options.effective_palette_cdf();

    let mut img: Vec<u8> = vec![0; values.len() * NUM_COLOR_CHANNELS];

    for (pixel_index, &value) in values.iter().enumerate() {
        let pixel = color_from_smoothed_value(
            f64::from(value),
            palette,
            should_reverse_colors,
            palette_is_cyclic,
            color_cycles,
            &color_space,
            options.shift_hue_amount,
            options.saturate_amount,
            options.lighten_amount,
            min_iterations_threshold,
            max_iterations_threshold,
            palette_cdf,
        );

        let index = pixel_index * NUM_COLOR_CHANNELS;
        img[index] = pixel[0];
        img[index + 1] = pixel[1];
        img[index + 2] = pixel[2];
        img[index + 3] = 255;
    }

    img
}

/// Initializes the module. This function is specifically designed to be called
/// from WebAssembly to perform necessary initializations.
#[wasm_bindgen]
pub fn init() {
    utils::init();
}
