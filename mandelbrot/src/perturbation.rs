//! Deep-zoom rendering via perturbation theory.
//!
//! Past zoom level ~44 the f64 coordinates of adjacent pixels become
//! identical, so the direct escape-time algorithm produces blocky garbage.
//! Perturbation theory works around this: one *reference orbit* is iterated
//! with arbitrary-precision arithmetic, and every pixel then iterates only its
//! tiny delta from that orbit using fast hardware floats. Rebasing (Zhuoran's
//! method, as used in Fraktaler 3) restarts a pixel's delta against the start
//! of the reference orbit whenever the delta grows comparable to the orbit
//! value, which avoids the classic perturbation glitches.
//!
//! Coordinates arrive as an arbitrary-precision decimal-string origin plus
//! tile offsets, because callers (JavaScript) cannot represent deep-zoom
//! coordinates in ordinary floats.

use std::cell::RefCell;
use std::rc::Rc;

use dashu::float::round::mode::Zero;
use dashu::float::{DBig, FBig};
use num::complex::Complex64;

use crate::float_exp::{exp_value_less_than, ldexp, ComplexExp};

#[cfg(test)]
#[path = "perturbation_test.rs"]
mod perturbation_test;

type BigFloat = FBig<Zero, 2>;

/// Effective zoom level at which rendering switches to perturbation. One
/// level below the zoom cap of the pre-perturbation renderer: at zoom 47 the
/// pixel spacing (2^-52) drops below the f64 ULP of coordinates near
/// magnitude 2, so the direct renderer starts quantizing pixels.
pub const DEEP_ZOOM_THRESHOLD: i64 = 47;

/// Effective zoom level above which pixel deltas need an extended exponent
/// range. Below it, deltas and their squares stay clear of f64 underflow.
const FLOAT_EXP_THRESHOLD: i64 = 250;

/// Maximum stored reference orbit length. Pixels needing more iterations wrap
/// around via rebasing, which stays correct at any iteration count.
const MAX_ORBIT_LENGTH: usize = 1_000_000;

/// Highest exponent supported by the perturbation formula (the delta step is
/// O(exponent) per iteration, so huge exponents are impractical anyway).
pub const MAX_PERTURBED_EXPONENT: u32 = 64;

/// Matches the tile coordinate system of the Leaflet client: a tile position
/// `v` at zoom `z` maps to `(v / 2^(z-2)) * (tileSize / 128) - 4` with a tile
/// size of 200 pixels.
const TILE_SPACE_SCALE: f64 = 200.0 / 128.0;

/// Converts a fractional tile coordinate at `tile_zoom` to an offset from the
/// world origin, before the additional `2^-zoom_offset` deep-zoom scaling.
pub fn tile_coordinate_offset(tile_coordinate: f64, tile_zoom: i32) -> f64 {
    tile_coordinate * TILE_SPACE_SCALE * ldexp(1.0, -(tile_zoom as i64 - 2)) - 4.0
}

/// Parses an arbitrary-precision decimal string into a binary big float.
pub fn parse_decimal(text: &str, precision_bits: usize) -> Result<BigFloat, String> {
    let decimal: DBig = text
        .parse()
        .map_err(|error| format!("invalid coordinate: {error}"))?;
    let binary: BigFloat = decimal.to_binary().value().with_rounding();
    Ok(binary.with_precision(precision_bits).value())
}

fn complex_big_mul(a: &(BigFloat, BigFloat), b: &(BigFloat, BigFloat)) -> (BigFloat, BigFloat) {
    (&a.0 * &b.0 - &a.1 * &b.1, &a.0 * &b.1 + &a.1 * &b.0)
}

/// Complex power by binary exponentiation. Requires `exponent >= 1`.
fn complex_big_pow(base: &(BigFloat, BigFloat), exponent: u32) -> (BigFloat, BigFloat) {
    let mut remaining = exponent;
    let mut square = base.clone();
    let mut result: Option<(BigFloat, BigFloat)> = None;

    while remaining > 0 {
        if remaining & 1 == 1 {
            result = Some(match result {
                None => square.clone(),
                Some(accumulated) => complex_big_mul(&accumulated, &square),
            });
        }
        remaining >>= 1;
        if remaining > 0 {
            square = complex_big_mul(&square, &square);
        }
    }

    result.expect("exponent must be at least 1")
}

/// A reference orbit: `values[n]` is `Z_n` (with `Z_0 = 0`) rounded to f64.
/// `escaped` records whether the orbit left the escape radius, in which case
/// it is complete and no longer entries can ever be needed.
struct ReferenceOrbit {
    values: Vec<(f64, f64)>,
    escaped: bool,
}

fn compute_reference_orbit(
    center_re: &BigFloat,
    center_im: &BigFloat,
    exponent: u32,
    length: usize,
    escape_radius_squared: f64,
) -> ReferenceOrbit {
    let mut values = Vec::with_capacity(length.min(MAX_ORBIT_LENGTH) + 1);
    values.push((0.0, 0.0));

    let mut z = (center_re.clone(), center_im.clone());
    let mut escaped = false;

    while values.len() <= length {
        let z_f64 = (z.0.to_f64().value(), z.1.to_f64().value());
        values.push(z_f64);

        if z_f64.0 * z_f64.0 + z_f64.1 * z_f64.1 > escape_radius_squared {
            escaped = true;
            break;
        }

        z = if exponent == 2 {
            (
                &z.0 * &z.0 - &z.1 * &z.1 + center_re,
                (&z.0 * &z.1) * BigFloat::from(2) + center_im,
            )
        } else {
            let powered = complex_big_pow(&z, exponent);
            (powered.0 + center_re, powered.1 + center_im)
        };
    }

    ReferenceOrbit { values, escaped }
}

#[derive(PartialEq, Eq, Clone)]
struct OrbitCacheKey {
    origin_re: String,
    origin_im: String,
    exponent: u32,
    precision_bits: usize,
}

struct OrbitCacheEntry {
    key: OrbitCacheKey,
    orbit: Rc<ReferenceOrbit>,
}

thread_local! {
    // One cached orbit per worker thread. Tiles of the same view share the
    // same origin, so this makes the expensive high-precision computation a
    // once-per-view cost instead of once-per-tile.
    static ORBIT_CACHE: RefCell<Option<OrbitCacheEntry>> = const { RefCell::new(None) };
}

#[allow(clippy::too_many_arguments)]
fn get_reference_orbit(
    origin_re_text: &str,
    origin_im_text: &str,
    center_re: &BigFloat,
    center_im: &BigFloat,
    exponent: u32,
    precision_bits: usize,
    length: usize,
    escape_radius_squared: f64,
) -> Rc<ReferenceOrbit> {
    let key = OrbitCacheKey {
        origin_re: origin_re_text.to_string(),
        origin_im: origin_im_text.to_string(),
        exponent,
        precision_bits,
    };

    ORBIT_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();

        if let Some(entry) = cache.as_ref() {
            let orbit_is_sufficient = entry.orbit.escaped || entry.orbit.values.len() > length;
            if entry.key == key && orbit_is_sufficient {
                return Rc::clone(&entry.orbit);
            }
        }

        let orbit = Rc::new(compute_reference_orbit(
            center_re,
            center_im,
            exponent,
            length,
            escape_radius_squared,
        ));
        *cache = Some(OrbitCacheEntry {
            key,
            orbit: Rc::clone(&orbit),
        });
        orbit
    })
}

/// One perturbation step in plain f64: given the reference value `Z` and the
/// pixel's delta `dz`, returns `(Z + dz)^e - Z^e` expanded binomially (the
/// direct difference would cancel catastrophically).
fn delta_step_f64(z_ref: Complex64, dz: Complex64, exponent: u32) -> Complex64 {
    if exponent == 2 {
        return (z_ref * 2.0 + dz) * dz;
    }

    // Horner evaluation of sum_{k=1..e} C(e,k) Z^(e-k) dz^k.
    let mut sum = Complex64::new(1.0, 0.0);
    let mut z_power = Complex64::new(1.0, 0.0);
    let mut coefficient = 1.0_f64;

    for k in (1..exponent).rev() {
        z_power *= z_ref;
        coefficient = coefficient * (k + 1) as f64 / (exponent - k) as f64;
        sum = sum * dz + z_power * coefficient;
    }

    sum * dz
}

/// Same as `delta_step_f64` but with extended-exponent deltas.
fn delta_step_float_exp(z_ref: Complex64, dz: ComplexExp, exponent: u32) -> ComplexExp {
    if exponent == 2 {
        let doubled = ComplexExp::from_f64s(2.0 * z_ref.re, 2.0 * z_ref.im);
        return doubled.add(&dz).mul(&dz);
    }

    let mut sum = ComplexExp::from_f64s(1.0, 0.0);
    let mut z_power = Complex64::new(1.0, 0.0);
    let mut coefficient = 1.0_f64;

    for k in (1..exponent).rev() {
        z_power *= z_ref;
        coefficient = coefficient * (k + 1) as f64 / (exponent - k) as f64;
        let term = ComplexExp::from_f64s(z_power.re * coefficient, z_power.im * coefficient);
        sum = sum.mul(&dz).add(&term);
    }

    sum.mul(&dz)
}

/// Escape iterations for one pixel using f64 deltas with rebasing.
fn perturbed_escape_iterations_f64(
    orbit: &[(f64, f64)],
    dc: Complex64,
    max_iterations: u32,
    exponent: u32,
    escape_radius_squared: f64,
) -> (u32, Complex64) {
    let last_index = orbit.len() - 1;
    let mut reference_index: usize = 0;
    let mut dz = Complex64::new(0.0, 0.0);
    let mut z = Complex64::new(0.0, 0.0);

    let advance = |reference_index: &mut usize, dz: &mut Complex64, z: &mut Complex64| {
        let z_ref = orbit[*reference_index];
        *dz = delta_step_f64(Complex64::new(z_ref.0, z_ref.1), *dz, exponent) + dc;
        *reference_index += 1;

        let z_ref_next = orbit[*reference_index];
        *z = Complex64::new(z_ref_next.0 + dz.re, z_ref_next.1 + dz.im);

        // Rebase: restart against the orbit start when the reference runs out
        // or the delta stops being small relative to the full value.
        if *reference_index == last_index || z.norm_sqr() < dz.norm_sqr() {
            *dz = *z;
            *reference_index = 0;
        }
    };

    // After the first step, z equals the pixel's own c, matching the direct
    // algorithm which starts iterating from z = c.
    advance(&mut reference_index, &mut dz, &mut z);

    let mut iterations = 0;
    while z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        advance(&mut reference_index, &mut dz, &mut z);
        iterations += 1;
    }

    (iterations, z)
}

/// In-flight state of a two-pixel SIMD perturbation batch: pixel deltas and
/// full values live one pixel per f64x2 lane, while reference-orbit positions
/// stay scalar because rebasing lets them diverge between lanes.
#[cfg(target_arch = "wasm32")]
struct PairState {
    index: [usize; 2],
    dz_re: core::arch::wasm32::v128,
    dz_im: core::arch::wasm32::v128,
    z_re: core::arch::wasm32::v128,
    z_im: core::arch::wasm32::v128,
}

/// One perturbation step for both lanes (quadratic case): advances the deltas,
/// recombines with the reference orbit, and rebases lanes whose delta stopped
/// being small. Escaped lanes keep stepping on garbage values (their output is
/// frozen by the caller); the rebase-at-orbit-end rule keeps their indices in
/// bounds regardless.
#[cfg(target_arch = "wasm32")]
fn pair_step(
    orbit: &[(f64, f64)],
    dc_re: core::arch::wasm32::v128,
    dc_im: core::arch::wasm32::v128,
    last_index: usize,
    state: &mut PairState,
) {
    use core::arch::wasm32::*;

    let z_ref_first = orbit[state.index[0]];
    let z_ref_second = orbit[state.index[1]];
    let doubled_re = f64x2_add(
        f64x2_mul(f64x2_splat(2.0), f64x2(z_ref_first.0, z_ref_second.0)),
        state.dz_re,
    );
    let doubled_im = f64x2_add(
        f64x2_mul(f64x2_splat(2.0), f64x2(z_ref_first.1, z_ref_second.1)),
        state.dz_im,
    );

    let new_dz_re = f64x2_add(
        f64x2_sub(
            f64x2_mul(doubled_re, state.dz_re),
            f64x2_mul(doubled_im, state.dz_im),
        ),
        dc_re,
    );
    let new_dz_im = f64x2_add(
        f64x2_add(
            f64x2_mul(doubled_re, state.dz_im),
            f64x2_mul(doubled_im, state.dz_re),
        ),
        dc_im,
    );

    state.index[0] += 1;
    state.index[1] += 1;

    let z_next_first = orbit[state.index[0]];
    let z_next_second = orbit[state.index[1]];
    let new_z_re = f64x2_add(f64x2(z_next_first.0, z_next_second.0), new_dz_re);
    let new_z_im = f64x2_add(f64x2(z_next_first.1, z_next_second.1), new_dz_im);

    let z_norm_sqr = f64x2_add(f64x2_mul(new_z_re, new_z_re), f64x2_mul(new_z_im, new_z_im));
    let dz_norm_sqr = f64x2_add(
        f64x2_mul(new_dz_re, new_dz_re),
        f64x2_mul(new_dz_im, new_dz_im),
    );

    let at_orbit_end = i64x2(
        -((state.index[0] == last_index) as i64),
        -((state.index[1] == last_index) as i64),
    );
    let rebase = v128_or(at_orbit_end, f64x2_lt(z_norm_sqr, dz_norm_sqr));

    state.dz_re = v128_bitselect(new_z_re, new_dz_re, rebase);
    state.dz_im = v128_bitselect(new_z_im, new_dz_im, rebase);
    if i64x2_extract_lane::<0>(rebase) != 0 {
        state.index[0] = 0;
    }
    if i64x2_extract_lane::<1>(rebase) != 0 {
        state.index[1] = 0;
    }

    state.z_re = new_z_re;
    state.z_im = new_z_im;
}

/// Escape iterations for two pixels at once using f64 deltas with rebasing,
/// one pixel per 128-bit SIMD lane (quadratic case). Lane arithmetic is
/// IEEE-identical to `perturbed_escape_iterations_f64`, so results match it
/// bit-for-bit; lanes that escape are frozen while the other keeps iterating.
#[cfg(target_arch = "wasm32")]
fn perturbed_escape_iterations_f64_pair(
    orbit: &[(f64, f64)],
    dc_first: Complex64,
    dc_second: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
) -> [(u32, Complex64); 2] {
    use core::arch::wasm32::*;

    let last_index = orbit.len() - 1;
    let dc_re = f64x2(dc_first.re, dc_second.re);
    let dc_im = f64x2(dc_first.im, dc_second.im);
    let radius_squared = f64x2_splat(escape_radius_squared);

    let mut state = PairState {
        index: [0; 2],
        dz_re: f64x2_splat(0.0),
        dz_im: f64x2_splat(0.0),
        z_re: f64x2_splat(0.0),
        z_im: f64x2_splat(0.0),
    };

    // Pre-step, mirroring the scalar version: afterwards z equals each
    // pixel's own c.
    pair_step(orbit, dc_re, dc_im, last_index, &mut state);

    let mut z_out_re = state.z_re;
    let mut z_out_im = state.z_im;
    // Alive lanes are all-ones, so subtracting the mask adds 1 per live lane.
    let mut alive = i64x2_splat(-1);
    let mut lane_iterations = i64x2_splat(0);
    let mut remaining = max_iterations;

    while remaining > 0 {
        let norm_sqr = f64x2_add(f64x2_mul(z_out_re, z_out_re), f64x2_mul(z_out_im, z_out_im));
        alive = v128_and(alive, f64x2_lt(norm_sqr, radius_squared));
        if !v128_any_true(alive) {
            break;
        }

        pair_step(orbit, dc_re, dc_im, last_index, &mut state);
        z_out_re = v128_bitselect(state.z_re, z_out_re, alive);
        z_out_im = v128_bitselect(state.z_im, z_out_im, alive);
        lane_iterations = i64x2_sub(lane_iterations, alive);
        remaining -= 1;
    }

    [
        (
            i64x2_extract_lane::<0>(lane_iterations) as u32,
            Complex64::new(
                f64x2_extract_lane::<0>(z_out_re),
                f64x2_extract_lane::<0>(z_out_im),
            ),
        ),
        (
            i64x2_extract_lane::<1>(lane_iterations) as u32,
            Complex64::new(
                f64x2_extract_lane::<1>(z_out_re),
                f64x2_extract_lane::<1>(z_out_im),
            ),
        ),
    ]
}

/// Thresholds for the hybrid float-exp fast path. While every quantity stays
/// in f64's *normal* range, each ComplexExp operation rounds exactly like the
/// corresponding plain-f64 operation (it is the same mantissa arithmetic at a
/// power-of-two scale), so the delta step can run on plain f64 with
/// bit-identical results. The margins below keep all intermediates (mantissa
/// products, squared norms, the `+ dc` alignment window of 120 exponent bits)
/// clear of the subnormal zone where the two roundings diverge.
const HYBRID_PROMOTE_EXP: i64 = -380;
const HYBRID_DC_MIN_EXP: i64 = -800;
/// `2^-800`; a step whose `|dz|^2` lands below this is redone in ComplexExp.
const HYBRID_FLOOR_NORM_SQR: f64 = f64::from_bits((1023 - 800) << 52);

/// In-flight state of one pixel in the hybrid float-exp loop. The delta lives
/// in exactly one representation at a time: plain f64 (`big`) while it is
/// safely normal, ComplexExp otherwise.
struct HybridState<'a> {
    orbit: &'a [(f64, f64)],
    last_index: usize,
    dc: ComplexExp,
    dc_f64: Complex64,
    reference_index: usize,
    dz_small: ComplexExp,
    dz_big: Complex64,
    big: bool,
    z: Complex64,
}

impl HybridState<'_> {
    /// One ComplexExp perturbation step, identical to the pure float-exp
    /// loop's `advance` (quadratic case).
    fn small_step(&mut self) {
        let z_ref = self.orbit[self.reference_index];
        self.dz_small = delta_step_float_exp(Complex64::new(z_ref.0, z_ref.1), self.dz_small, 2)
            .add(&self.dc);
        self.reference_index += 1;

        let z_ref_next = self.orbit[self.reference_index];
        let (dz_re, dz_im) = self.dz_small.to_f64s();
        self.z = Complex64::new(z_ref_next.0 + dz_re, z_ref_next.1 + dz_im);

        if self.reference_index == self.last_index
            || exp_value_less_than((self.z.norm_sqr(), 0), self.dz_small.norm_sqr_exp())
        {
            self.dz_small = ComplexExp::from_f64s(self.z.re, self.z.im);
            self.reference_index = 0;
        }
    }

    fn advance(&mut self) {
        if !self.big {
            self.small_step();
            // Promote once the delta is comfortably normal; the conversion is
            // exact (normalized mantissa times an in-range power of two).
            if !self.dz_small.is_zero() && self.dz_small.exp >= HYBRID_PROMOTE_EXP {
                let (re, im) = self.dz_small.to_f64s();
                self.dz_big = Complex64::new(re, im);
                self.big = true;
            }
            return;
        }

        let saved_dz = self.dz_big;
        let saved_index = self.reference_index;
        let z_ref = self.orbit[self.reference_index];
        let new_dz = delta_step_f64(Complex64::new(z_ref.0, z_ref.1), saved_dz, 2) + self.dc_f64;

        if new_dz.norm_sqr() < HYBRID_FLOOR_NORM_SQR {
            // The delta dipped toward the subnormal zone; redo this step in
            // ComplexExp from the exact pre-step state so no f64 rounding of
            // the dip is ever observed.
            self.dz_small = ComplexExp::from_f64s(saved_dz.re, saved_dz.im);
            self.big = false;
            self.reference_index = saved_index;
            self.small_step();
            return;
        }

        self.reference_index += 1;
        let z_ref_next = self.orbit[self.reference_index];
        self.z = Complex64::new(z_ref_next.0 + new_dz.re, z_ref_next.1 + new_dz.im);
        self.dz_big = new_dz;

        if self.reference_index == self.last_index || self.z.norm_sqr() < self.dz_big.norm_sqr() {
            self.dz_big = self.z;
            self.reference_index = 0;
            if self.dz_big.norm_sqr() < HYBRID_FLOOR_NORM_SQR {
                self.dz_small = ComplexExp::from_f64s(self.dz_big.re, self.dz_big.im);
                self.big = false;
            }
        }
    }
}

/// Escape iterations for one pixel switching adaptively between plain-f64 and
/// extended-exponent deltas (quadratic case). Bit-identical to
/// `perturbed_escape_iterations_float_exp`: the f64 phase only runs where the
/// two arithmetics round identically.
fn perturbed_escape_iterations_hybrid(
    orbit: &[(f64, f64)],
    dc: ComplexExp,
    max_iterations: u32,
    escape_radius_squared: f64,
) -> (u32, Complex64) {
    let (dc_re, dc_im) = dc.to_f64s();
    let mut state = HybridState {
        orbit,
        last_index: orbit.len() - 1,
        dc,
        dc_f64: Complex64::new(dc_re, dc_im),
        reference_index: 0,
        dz_small: ComplexExp::ZERO,
        dz_big: Complex64::new(0.0, 0.0),
        big: false,
        z: Complex64::new(0.0, 0.0),
    };

    // Pre-step, mirroring the pure loops: afterwards z equals the pixel's c.
    state.advance();

    let mut iterations = 0;
    while state.z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        state.advance();
        iterations += 1;
    }

    (iterations, state.z)
}

/// Escape iterations for one pixel using extended-exponent deltas.
fn perturbed_escape_iterations_float_exp(
    orbit: &[(f64, f64)],
    dc: ComplexExp,
    max_iterations: u32,
    exponent: u32,
    escape_radius_squared: f64,
) -> (u32, Complex64) {
    // Most float-exp work happens at depths where the delta is representable
    // as a normal f64 nearly all the time; the hybrid loop runs those spans
    // at plain-f64 speed. `dc` must itself be a safely normal f64 so its
    // conversion and every `+ dc` round identically in both representations.
    if exponent == 2 && !dc.is_zero() && dc.exp >= HYBRID_DC_MIN_EXP {
        return perturbed_escape_iterations_hybrid(orbit, dc, max_iterations, escape_radius_squared);
    }

    let last_index = orbit.len() - 1;
    let mut reference_index: usize = 0;
    let mut dz = ComplexExp::ZERO;
    let mut z = Complex64::new(0.0, 0.0);

    let advance = |reference_index: &mut usize, dz: &mut ComplexExp, z: &mut Complex64| {
        let z_ref = orbit[*reference_index];
        *dz = delta_step_float_exp(Complex64::new(z_ref.0, z_ref.1), *dz, exponent).add(&dc);
        *reference_index += 1;

        let z_ref_next = orbit[*reference_index];
        let (dz_re, dz_im) = dz.to_f64s();
        *z = Complex64::new(z_ref_next.0 + dz_re, z_ref_next.1 + dz_im);

        if *reference_index == last_index
            || exp_value_less_than((z.norm_sqr(), 0), dz.norm_sqr_exp())
        {
            *dz = ComplexExp::from_f64s(z.re, z.im);
            *reference_index = 0;
        }
    };

    advance(&mut reference_index, &mut dz, &mut z);

    let mut iterations = 0;
    while z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        advance(&mut reference_index, &mut dz, &mut z);
        iterations += 1;
    }

    (iterations, z)
}

/// The geometry of a render target in tile space, plus everything needed to
/// turn pixel indices into perturbation deltas.
pub struct PerturbedFrame {
    orbit: Rc<ReferenceOrbit>,
    /// Offsets from the world origin (before deep-zoom scaling) of the first
    /// column/row, and the per-pixel steps, all at `tile_zoom` scale.
    first_column_offset: f64,
    first_row_offset: f64,
    column_step: f64,
    row_step: f64,
    /// The deep-zoom scaling: deltas are `offset * 2^-zoom_offset`.
    zoom_offset: i64,
    use_float_exp: bool,
    max_iterations: u32,
    exponent: u32,
    escape_radius_squared: f64,
}

impl PerturbedFrame {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        origin_re: &str,
        origin_im: &str,
        tile_x_min: f64,
        tile_x_max: f64,
        tile_y_min: f64,
        tile_y_max: f64,
        tile_zoom: i32,
        zoom_offset: u32,
        image_width: usize,
        image_height: usize,
        max_iterations: u32,
        exponent: u32,
        escape_radius: f64,
    ) -> Result<PerturbedFrame, String> {
        let effective_zoom = tile_zoom as i64 + zoom_offset as i64;

        // Enough precision for sub-pixel accuracy, with headroom.
        let precision_bits = (effective_zoom.max(0) as usize + 64).div_ceil(32) * 32;

        let center_re = parse_decimal(origin_re, precision_bits)?;
        let center_im = parse_decimal(origin_im, precision_bits)?;

        let escape_radius_squared = escape_radius * escape_radius;
        let orbit_length = (max_iterations as usize).min(MAX_ORBIT_LENGTH) + 1;
        let orbit = get_reference_orbit(
            origin_re,
            origin_im,
            &center_re,
            &center_im,
            exponent,
            precision_bits,
            orbit_length,
            escape_radius_squared,
        );

        // Match linspace semantics of the direct renderer: endpoints
        // inclusive, so the step divides by (count - 1).
        let x_min_offset = tile_coordinate_offset(tile_x_min, tile_zoom);
        let x_max_offset = tile_coordinate_offset(tile_x_max, tile_zoom);
        let y_min_offset = -tile_coordinate_offset(tile_y_min, tile_zoom);
        let y_max_offset = -tile_coordinate_offset(tile_y_max, tile_zoom);

        let column_step = if image_width > 1 {
            (x_max_offset - x_min_offset) / (image_width - 1) as f64
        } else {
            0.0
        };
        // Rows go top to bottom: from the maximum imaginary part downward.
        let row_step = if image_height > 1 {
            (y_max_offset - y_min_offset) / (image_height - 1) as f64
        } else {
            0.0
        };

        Ok(PerturbedFrame {
            orbit,
            first_column_offset: x_min_offset,
            first_row_offset: y_min_offset,
            column_step,
            row_step,
            zoom_offset: zoom_offset as i64,
            use_float_exp: effective_zoom >= FLOAT_EXP_THRESHOLD,
            max_iterations,
            exponent,
            escape_radius_squared,
        })
    }

    /// Escape iterations and final value for the pixel at (column, row).
    pub fn escape_iterations(&self, column: usize, row: usize) -> (u32, Complex64) {
        let re_offset = self.first_column_offset + self.column_step * column as f64;
        let im_offset = self.first_row_offset + self.row_step * row as f64;

        if self.use_float_exp {
            let dc = ComplexExp::new(re_offset, im_offset, -self.zoom_offset);
            perturbed_escape_iterations_float_exp(
                &self.orbit.values,
                dc,
                self.max_iterations,
                self.exponent,
                self.escape_radius_squared,
            )
        } else {
            let dc = Complex64::new(
                ldexp(re_offset, -self.zoom_offset),
                ldexp(im_offset, -self.zoom_offset),
            );
            perturbed_escape_iterations_f64(
                &self.orbit.values,
                dc,
                self.max_iterations,
                self.exponent,
                self.escape_radius_squared,
            )
        }
    }

    /// Escape iterations for two pixels sharing one call, batched into SIMD
    /// lanes where a batched implementation exists (wasm32, f64 deltas,
    /// exponent 2).
    #[cfg(target_arch = "wasm32")]
    pub fn escape_iterations_pair(
        &self,
        first: (usize, usize),
        second: (usize, usize),
    ) -> [(u32, Complex64); 2] {
        if self.use_float_exp || self.exponent != 2 {
            return [
                self.escape_iterations(first.0, first.1),
                self.escape_iterations(second.0, second.1),
            ];
        }

        let dc = |(column, row): (usize, usize)| {
            let re_offset = self.first_column_offset + self.column_step * column as f64;
            let im_offset = self.first_row_offset + self.row_step * row as f64;
            Complex64::new(
                ldexp(re_offset, -self.zoom_offset),
                ldexp(im_offset, -self.zoom_offset),
            )
        };

        perturbed_escape_iterations_f64_pair(
            &self.orbit.values,
            dc(first),
            dc(second),
            self.max_iterations,
            self.escape_radius_squared,
        )
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub fn escape_iterations_pair(
        &self,
        first: (usize, usize),
        second: (usize, usize),
    ) -> [(u32, Complex64); 2] {
        [
            self.escape_iterations(first.0, first.1),
            self.escape_iterations(second.0, second.1),
        ]
    }

    fn pixels_in_set_pair(&self, first: (usize, usize), second: (usize, usize)) -> bool {
        self.escape_iterations_pair(first, second)
            .iter()
            .all(|&(iterations, _)| iterations == self.max_iterations)
    }

    /// Whether every border pixel is inside the set. The set is simply
    /// connected, so a fully-interior border implies a fully-interior image.
    pub fn border_in_set(&self, image_width: usize, image_height: usize) -> bool {
        for column in 0..image_width {
            if !self.pixels_in_set_pair((column, 0), (column, image_height - 1)) {
                return false;
            }
        }
        for row in 0..image_height {
            if !self.pixels_in_set_pair((0, row), (image_width - 1, row)) {
                return false;
            }
        }
        true
    }
}
