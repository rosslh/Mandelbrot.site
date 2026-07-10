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

// Number of f64x2 vectors the streaming escape kernel keeps in flight
// (2 pixels per vector). Each vector is an independent FP dependency chain.
#[cfg(target_arch = "wasm32")]
const STREAM_CHAINS: usize = 4;

// Iterations between bookkeeping passes (retire/refill, budget, periodicity)
// in the streaming kernel. Saves land at per-lane multiples of the stride, so
// cycle detection stays guaranteed as with PERIODICITY_CHECK_STRIDE.
#[cfg(target_arch = "wasm32")]
const STREAM_STRIDE: u32 = 16;

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
}

impl RenderedTile {
    /// A solid black tile, as produced for views entirely inside the set.
    fn solid_black(image_width: usize, image_height: usize) -> RenderedTile {
        RenderedTile {
            image: create_solid_black_image(image_width, image_height),
            values: vec![f32::INFINITY; image_width * image_height],
            stats: TileIterationStats::default(),
        }
    }
}

const NUM_COLOR_CHANNELS: usize = 4;

static COLOR_PALETTES: Lazy<HashMap<String, colorous::Gradient>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert("brownGreen".to_string(), colorous::BROWN_GREEN);
    map.insert("cividis".to_string(), colorous::CIVIDIS);
    map.insert("cool".to_string(), colorous::COOL);
    map.insert("cubehelix".to_string(), colorous::CUBEHELIX);
    map.insert("inferno".to_string(), colorous::INFERNO);
    map.insert("magma".to_string(), colorous::MAGMA);
    map.insert("plasma".to_string(), colorous::PLASMA);
    map.insert("purpleGreen".to_string(), colorous::PURPLE_GREEN);
    map.insert("purpleOrange".to_string(), colorous::PURPLE_ORANGE);
    map.insert("rainbow".to_string(), colorous::RAINBOW);
    map.insert("redBlue".to_string(), colorous::RED_BLUE);
    map.insert("redGrey".to_string(), colorous::RED_GREY);
    map.insert("redYellowBlue".to_string(), colorous::RED_YELLOW_BLUE);
    map.insert("redYellowGreen".to_string(), colorous::RED_YELLOW_GREEN);
    map.insert("sinebow".to_string(), colorous::SINEBOW);
    map.insert("spectral".to_string(), colorous::SPECTRAL);
    map.insert("turbo".to_string(), colorous::TURBO);
    map.insert("viridis".to_string(), colorous::VIRIDIS);
    map.insert("warm".to_string(), colorous::WARM);
    map.insert(
        "yellowOrangeBrown".to_string(),
        colorous::YELLOW_ORANGE_BROWN,
    );
    map
});

static REVERSE_COLOR_PALETTES: Lazy<HashMap<String, colorous::Gradient>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert("blues".to_string(), colorous::BLUES);
    map.insert("greenBlue".to_string(), colorous::GREEN_BLUE);
    map.insert("greens".to_string(), colorous::GREENS);
    map.insert("greys".to_string(), colorous::GREYS);
    map.insert("orangeRed".to_string(), colorous::ORANGE_RED);
    map.insert("oranges".to_string(), colorous::ORANGES);
    map.insert("pinkGreen".to_string(), colorous::PINK_GREEN);
    map.insert("purpleBlueGreen".to_string(), colorous::PURPLE_BLUE_GREEN);
    map.insert("purpleRed".to_string(), colorous::PURPLE_RED);
    map.insert("purples".to_string(), colorous::PURPLES);
    map.insert("redPurple".to_string(), colorous::RED_PURPLE);
    map.insert("reds".to_string(), colorous::REDS);
    map.insert("yellowGreen".to_string(), colorous::YELLOW_GREEN);
    map.insert("yellowGreenBlue".to_string(), colorous::YELLOW_GREEN_BLUE);
    map.insert("yellowOrangeRed".to_string(), colorous::YELLOW_ORANGE_RED);

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
/// Retirement, budget, and periodicity bookkeeping run only every
/// `PERIODICITY_CHECK_STRIDE` iterations; escaped lanes freeze their z and
/// iteration count exactly at the escape step via the alive mask, so results
/// are bit-identical to the scalar loop.
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
    let two = f64x2_splat(2.0);
    let max_iterations_minus_one = i64x2_splat(i64::from(max_iterations) - 1);

    loop {
        for _ in 0..STREAM_STRIDE {
            for chain in 0..CHAINS {
                let z_re = lanes.z_re[chain];
                let z_im = lanes.z_im[chain];
                let norm_sqr = f64x2_add(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im));
                let alive = v128_and(lanes.alive[chain], f64x2_lt(norm_sqr, radius_squared));
                let next_re = f64x2_add(
                    f64x2_sub(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im)),
                    lanes.c_re[chain],
                );
                let next_im = f64x2_add(f64x2_mul(two, f64x2_mul(z_re, z_im)), lanes.c_im[chain]);
                lanes.z_re[chain] = v128_bitselect(next_re, z_re, alive);
                lanes.z_im[chain] = v128_bitselect(next_im, z_im, alive);
                lanes.iters[chain] = i64x2_sub(lanes.iters[chain], alive);
                lanes.alive[chain] = alive;
            }
        }

        for chain in 0..CHAINS {
            // A lane is finished when it escaped (occupied but no longer
            // alive), ran out its budget, or exactly revisited a saved z.
            let out_of_budget = i64x2_gt(lanes.iters[chain], max_iterations_minus_one);
            let cycled = v128_and(
                v128_and(
                    f64x2_eq(lanes.z_re[chain], lanes.saved_re[chain]),
                    f64x2_eq(lanes.z_im[chain], lanes.saved_im[chain]),
                ),
                lanes.alive[chain],
            );
            let finished = v128_or(
                v128_andnot(lanes.occupied[chain], lanes.alive[chain]),
                v128_and(lanes.alive[chain], v128_or(out_of_budget, cycled)),
            );

            if v128_any_true(finished) {
                for sub in 0..2 {
                    if i64x2_lane(finished, sub) == 0 {
                        continue;
                    }
                    let index = lanes.slots[chain][sub];
                    let escaped = i64x2_lane(lanes.alive[chain], sub) == 0;
                    // Alive-but-finished lanes are periodic or out of budget:
                    // both report max_iterations (out-of-budget lanes may have
                    // overshot by up to stride-1 masked steps, hence the min).
                    let escape_iterations = if escaped {
                        (i64x2_lane(lanes.iters[chain], sub) as u32).min(max_iterations)
                    } else {
                        max_iterations
                    };
                    let z = Complex64::new(
                        f64x2_lane(lanes.z_re[chain], sub),
                        f64x2_lane(lanes.z_im[chain], sub),
                    );
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
        }

        if live_lanes == 0 {
            break;
        }
    }
}

/// Multiplies two complex numbers held as (re, im) f64x2 lane pairs, with
/// num-complex's operation order per lane so lane arithmetic is
/// IEEE-identical to `Complex64` multiplication.
#[cfg(target_arch = "wasm32")]
#[inline]
fn complex_mul_lanes(
    a_re: core::arch::wasm32::v128,
    a_im: core::arch::wasm32::v128,
    b_re: core::arch::wasm32::v128,
    b_im: core::arch::wasm32::v128,
) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;
    (
        f64x2_sub(f64x2_mul(a_re, b_re), f64x2_mul(a_im, b_im)),
        f64x2_add(f64x2_mul(a_re, b_im), f64x2_mul(a_im, b_re)),
    )
}

/// Raises every chain's z lanes to `exponent`, replicating num-complex's
/// square-and-multiply sequence (`powu`) so per-lane results are
/// bit-identical to `z.powu(exponent)`. Each squaring/multiply is a serial
/// step in the chain's dependency chain, so all chains advance through each
/// step together to keep `CHAINS` independent chains in the pipeline (the
/// same latency-hiding structure as the perturbation fused general step).
#[cfg(target_arch = "wasm32")]
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

/// Streaming escape-time kernel for general exponents: the lane-refilling
/// structure of `stream_escape_quadratic` with the iteration step
/// `z = z.powu(exponent) + c` via `fused_powu_lanes`, so results are
/// bit-identical to `calculate_escape_iterations_general`. There is no
/// closed-form interior test for general exponents, so points stream in
/// unfiltered.
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

    loop {
        for _ in 0..STREAM_STRIDE {
            // Escape test on the current z, then one masked powu step; the
            // alive masks are computed for every chain up front so the powu
            // steps stay a pure fused sequence.
            let mut alive = [i64x2_splat(0); CHAINS];
            for (chain, lane_alive) in alive.iter_mut().enumerate() {
                let z_re = lanes.z_re[chain];
                let z_im = lanes.z_im[chain];
                let norm_sqr = f64x2_add(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im));
                *lane_alive = v128_and(lanes.alive[chain], f64x2_lt(norm_sqr, radius_squared));
            }

            let (pow_re, pow_im) = fused_powu_lanes::<CHAINS>(&lanes.z_re, &lanes.z_im, exponent);

            for chain in 0..CHAINS {
                let next_re = f64x2_add(pow_re[chain], lanes.c_re[chain]);
                let next_im = f64x2_add(pow_im[chain], lanes.c_im[chain]);
                lanes.z_re[chain] = v128_bitselect(next_re, lanes.z_re[chain], alive[chain]);
                lanes.z_im[chain] = v128_bitselect(next_im, lanes.z_im[chain], alive[chain]);
                lanes.iters[chain] = i64x2_sub(lanes.iters[chain], alive[chain]);
                lanes.alive[chain] = alive[chain];
            }
        }

        for chain in 0..CHAINS {
            // A lane is finished when it escaped (occupied but no longer
            // alive), ran out its budget, or exactly revisited a saved z.
            let out_of_budget = i64x2_gt(lanes.iters[chain], max_iterations_minus_one);
            let cycled = v128_and(
                v128_and(
                    f64x2_eq(lanes.z_re[chain], lanes.saved_re[chain]),
                    f64x2_eq(lanes.z_im[chain], lanes.saved_im[chain]),
                ),
                lanes.alive[chain],
            );
            let finished = v128_or(
                v128_andnot(lanes.occupied[chain], lanes.alive[chain]),
                v128_and(lanes.alive[chain], v128_or(out_of_budget, cycled)),
            );

            if v128_any_true(finished) {
                for sub in 0..2 {
                    if i64x2_lane(finished, sub) == 0 {
                        continue;
                    }
                    let index = lanes.slots[chain][sub];
                    let escaped = i64x2_lane(lanes.alive[chain], sub) == 0;
                    // Alive-but-finished lanes are periodic or out of budget:
                    // both report max_iterations (out-of-budget lanes may have
                    // overshot by up to stride-1 masked steps, hence the min).
                    let escape_iterations = if escaped {
                        (i64x2_lane(lanes.iters[chain], sub) as u32).min(max_iterations)
                    } else {
                        max_iterations
                    };
                    let z = Complex64::new(
                        f64x2_lane(lanes.z_re[chain], sub),
                        f64x2_lane(lanes.z_im[chain], sub),
                    );
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
                stream_escape_quadratic::<STREAM_CHAINS>(
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
/// A tuple containing the selected color palette and whether the colors should be reversed.
fn get_color_palette(
    color_scheme: &str,
    reverse_colors: bool,
) -> (&'static colorous::Gradient, bool) {
    let palette = COLOR_PALETTES
        .get(color_scheme)
        .or_else(|| REVERSE_COLOR_PALETTES.get(color_scheme))
        .unwrap_or(&colorous::TURBO);

    let should_reverse_colors = if REVERSE_COLOR_PALETTES.contains_key(color_scheme) {
        !reverse_colors
    } else {
        reverse_colors
    };

    (palette, should_reverse_colors)
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
    palette: &colorous::Gradient,
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
    palette: &colorous::Gradient,
    should_reverse_colors: bool,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    min_iterations_threshold: f64,
    max_iterations_threshold: f64,
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
    palette: &colorous::Gradient,
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
        color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        min_iterations_threshold,
        max_iterations_threshold,
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
/// - `color_space`: The color space to use for color transformations.
/// - `shift_hue_amount`: The amount to shift the hue by.
/// - `saturate_amount`: The amount to saturate the color by.
/// - `lighten_amount`: The amount to lighten the color by.
/// - `smooth_coloring`: Whether to use smooth coloring.
/// - `palette_min_iter`: The minimum iteration count for the color palette range.
/// - `palette_max_iter`: The maximum iteration count for the color palette range.
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
    palette: &colorous::Gradient,
    should_reverse_colors: bool,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    smooth_coloring: bool,
    palette_min_iter: i32,
    palette_max_iter: i32,
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
            color_space,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            min_iterations_threshold,
            max_iterations_threshold,
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

    RenderedTile {
        image: img,
        values,
        stats,
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
) -> RenderedTile {
    let (palette, should_reverse_colors) = get_color_palette(color_scheme, reverse_colors);

    let re_range = linspace(re_min, re_max, image_width);
    let im_range = linspace(im_max, im_min, image_height);

    if rect_in_set(re_range.clone(), im_range.clone(), max_iterations, exponent) {
        return RenderedTile::solid_black(image_width, image_height);
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
        &color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        smooth_coloring,
        palette_min_iter,
        palette_max_iter,
    )
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
/// origin. Shallow views use the direct f64 renderer; deep views use
/// perturbation theory with an arbitrary-precision reference orbit, so zoom
/// depth is not limited by f64 precision.
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
) -> RenderedTile {
    let effective_zoom = tile_zoom as i64 + zoom_offset as i64;

    let use_perturbation = effective_zoom >= perturbation::DEEP_ZOOM_THRESHOLD
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
        );
    }

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
        Err(_) => return RenderedTile::solid_black(image_width, image_height),
    };

    if frame.border_in_set(image_width, image_height) {
        return RenderedTile::solid_black(image_width, image_height);
    }

    let (palette, should_reverse_colors) = get_color_palette(color_scheme, reverse_colors);

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
            &color_space,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            min_iterations_threshold,
            max_iterations_threshold,
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
}

/// Renders a Mandelbrot tile at any zoom depth (see `render_tile_precise`
/// for the view geometry) and reports the tile's escaped-pixel iteration
/// range alongside the image. When `include_values` is set, the per-pixel
/// smoothed escape values are returned too so the tile can later be
/// recolored via `recolor_tile`; large offscreen renders (image export)
/// skip them to avoid the extra transfer.
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
    );

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
    }
}

/// Recolors a tile from its cached per-pixel smoothed escape values (as
/// returned by `get_mandelbrot_tile_precise`), producing the RGBA bytes the
/// full renderer would produce for the same color settings — without
/// recomputing escape times. Anything that changes the escape values
/// themselves (iterations, exponent, smooth coloring) still requires a
/// re-render.
#[wasm_bindgen]
pub fn recolor_tile(
    values: &[f32],
    color_scheme: String,
    reverse_colors: bool,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    color_space: ValidColorSpace,
    palette_min_iter: i32,
    palette_max_iter: i32,
) -> Vec<u8> {
    let (palette, should_reverse_colors) = get_color_palette(&color_scheme, reverse_colors);

    let min_iterations_threshold = f64::from(palette_min_iter);
    let max_iterations_threshold =
        f64::from(palette_max_iter).max(min_iterations_threshold + f64::EPSILON);

    let mut img: Vec<u8> = vec![0; values.len() * NUM_COLOR_CHANNELS];

    for (pixel_index, &value) in values.iter().enumerate() {
        let pixel = color_from_smoothed_value(
            f64::from(value),
            palette,
            should_reverse_colors,
            &color_space,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            min_iterations_threshold,
            max_iterations_threshold,
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
