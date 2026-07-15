//! Deep-zoom rendering via perturbation theory.
//!
//! Once the pixel spacing falls to within a couple of ULPs of the f64
//! coordinates, adjacent pixels round to identical coordinates and the
//! direct escape-time algorithm produces blocky garbage.
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
#[cfg(target_arch = "wasm32")]
use crate::{f64x2_lane, f64x2_with_lane, i64x2_lane, i64x2_with_lane, IDLE_SLOT};
use crate::{PERIODICITY_CHECK_STRIDE, PERIODICITY_FIRST_SAVE};

#[cfg(test)]
#[path = "perturbation_test.rs"]
mod perturbation_test;

type BigFloat = FBig<Zero, 2>;

/// Minimum pixel spacing the direct f64 renderer is allowed to handle;
/// anything finer switches to perturbation. Coordinates reach magnitude 4 at
/// the edge of tile space, where the f64 ULP is 2^-51; two ULPs of headroom
/// keep adjacent pixel coordinates distinct and monotone after rounding. At
/// the standard 200-pixel tile size the switch lands at effective zoom 46;
/// high-DPI tiles (2-3x the pixels per tile) switch one or two levels
/// earlier.
pub const MIN_DIRECT_PIXEL_SPACING: f64 = 1.0 / (1u64 << 50) as f64;

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

/// Complex-plane distance between adjacent pixels of a render request that
/// maps `tile_max - tile_min` tile units onto `image_len` pixels. Underflows
/// to zero at extreme depths, which callers should treat as "finer than f64".
pub fn pixel_spacing(
    tile_min: f64,
    tile_max: f64,
    tile_zoom: i32,
    zoom_offset: u32,
    image_len: usize,
) -> f64 {
    ldexp(
        (tile_max - tile_min) * TILE_SPACE_SCALE / image_len as f64,
        -(tile_zoom as i64 - 2) - zoom_offset as i64,
    )
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
    /// For general exponents, the Horner terms `C(e,k) * Z_n^(e-k)` of the
    /// delta step depend only on the orbit index `n`, so they are precomputed
    /// here once per orbit instead of once per pixel-step: `exponent - 1`
    /// `[re, im]` entries per index in the loop's evaluation order, flattened
    /// index-major. Each entry is built by the exact operation sequence the
    /// per-step Horner loop performs, so consuming the table is bit-identical
    /// to recomputing the terms. Empty for exponent 2 (whose delta step has a
    /// closed form) and for orbits past `COEFF_TABLE_MAX_ENTRIES` (consumers
    /// fall back to the on-the-fly loop). Only the wasm32 SIMD kernels read
    /// it; the scalar loops keep recomputing terms (identical results).
    #[cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]
    coeff_table: Vec<[f64; 2]>,
}

/// Size cap for the precomputed Horner-term table, in `[f64; 2]` entries
/// (8 MiB). Real multibrot orbits are far smaller (a high exponent makes the
/// reference escape quickly); the cap only guards degenerate long-orbit,
/// high-exponent combinations from ballooning memory.
const COEFF_TABLE_MAX_ENTRIES: usize = 512 * 1024;

/// Builds the per-orbit-index Horner term table for `delta_step_f64`'s
/// general-exponent loop. Term `j` of row `n` is `coefficient * Z_n^(e-k)`
/// for `k = e-1-j`, computed with the same expressions (and therefore the
/// same IEEE roundings) as the in-loop code it replaces.
fn compute_coeff_table(values: &[(f64, f64)], exponent: u32) -> Vec<[f64; 2]> {
    let terms = (exponent - 1) as usize;
    if exponent == 2 || values.len().saturating_mul(terms) > COEFF_TABLE_MAX_ENTRIES {
        return Vec::new();
    }

    let mut table = Vec::with_capacity(values.len() * terms);
    for &(z_ref_re, z_ref_im) in values {
        let mut z_power = Complex64::new(1.0, 0.0);
        let mut coefficient = 1.0_f64;
        for k in (1..exponent).rev() {
            z_power *= Complex64::new(z_ref_re, z_ref_im);
            coefficient = coefficient * (k + 1) as f64 / (exponent - k) as f64;
            table.push([z_power.re * coefficient, z_power.im * coefficient]);
        }
    }
    table
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

    let coeff_table = compute_coeff_table(&values, exponent);
    ReferenceOrbit {
        values,
        escaped,
        coeff_table,
    }
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

    // Brent-style periodicity on the perturbation state. The step map is
    // deterministic in (dz, reference_index), so an exact recurrence of that
    // full state means the computed sequence cycles forever and can never
    // escape; reporting max_iterations then matches running out the budget
    // exactly (z is unused for interior pixels). Comparing reconstructed z
    // alone would not be sound: different states can reconstruct the same z.
    let mut saved_dz = dz;
    let mut saved_index = reference_index;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    let mut iterations = 0;
    while z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        advance(&mut reference_index, &mut dz, &mut z);
        iterations += 1;

        if iterations % PERIODICITY_CHECK_STRIDE == 0 {
            if dz == saved_dz && reference_index == saved_index {
                return (max_iterations, z);
            }
            if iterations == next_save {
                saved_dz = dz;
                saved_index = reference_index;
                next_save = next_save.saturating_mul(2);
            }
        }
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

/// `delta_step_f64` for both SIMD lanes at once: given per-lane reference
/// values and deltas, returns `(Z + dz)^e - Z^e` per lane. Lanes are
/// independent and every lane operation is the same IEEE arithmetic as the
/// scalar version (the Horner coefficients are lane-invariant scalars), so
/// each lane's result is bit-identical to `delta_step_f64`. `GENERAL` is a
/// compile-time switch so the quadratic instantiation keeps its branch-free
/// hot loop (a runtime exponent test here measurably slowed the e2 kernels).
#[cfg(target_arch = "wasm32")]
#[inline]
fn pair_delta_step<const GENERAL: bool>(
    z_ref_re: core::arch::wasm32::v128,
    z_ref_im: core::arch::wasm32::v128,
    dz_re: core::arch::wasm32::v128,
    dz_im: core::arch::wasm32::v128,
    exponent: u32,
) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;

    debug_assert!(GENERAL || exponent == 2);
    if !GENERAL {
        let doubled_re = f64x2_add(f64x2_mul(f64x2_splat(2.0), z_ref_re), dz_re);
        let doubled_im = f64x2_add(f64x2_mul(f64x2_splat(2.0), z_ref_im), dz_im);
        return (
            f64x2_sub(f64x2_mul(doubled_re, dz_re), f64x2_mul(doubled_im, dz_im)),
            f64x2_add(f64x2_mul(doubled_re, dz_im), f64x2_mul(doubled_im, dz_re)),
        );
    }

    // Horner evaluation of sum_{k=1..e} C(e,k) Z^(e-k) dz^k, lanewise.
    let mut sum_re = f64x2_splat(1.0);
    let mut sum_im = f64x2_splat(0.0);
    let mut z_power_re = f64x2_splat(1.0);
    let mut z_power_im = f64x2_splat(0.0);
    let mut coefficient = 1.0_f64;

    for k in (1..exponent).rev() {
        let next_power_re = f64x2_sub(
            f64x2_mul(z_power_re, z_ref_re),
            f64x2_mul(z_power_im, z_ref_im),
        );
        let next_power_im = f64x2_add(
            f64x2_mul(z_power_re, z_ref_im),
            f64x2_mul(z_power_im, z_ref_re),
        );
        z_power_re = next_power_re;
        z_power_im = next_power_im;
        coefficient = coefficient * (k + 1) as f64 / (exponent - k) as f64;
        let coefficient_lanes = f64x2_splat(coefficient);

        let next_sum_re = f64x2_add(
            f64x2_sub(f64x2_mul(sum_re, dz_re), f64x2_mul(sum_im, dz_im)),
            f64x2_mul(z_power_re, coefficient_lanes),
        );
        let next_sum_im = f64x2_add(
            f64x2_add(f64x2_mul(sum_re, dz_im), f64x2_mul(sum_im, dz_re)),
            f64x2_mul(z_power_im, coefficient_lanes),
        );
        sum_re = next_sum_re;
        sum_im = next_sum_im;
    }

    (
        f64x2_sub(f64x2_mul(sum_re, dz_re), f64x2_mul(sum_im, dz_im)),
        f64x2_add(f64x2_mul(sum_re, dz_im), f64x2_mul(sum_im, dz_re)),
    )
}

/// `pair_delta_step::<true>` with the per-index Horner terms read from the
/// precomputed table instead of recomputed per step. Each loaded entry is the
/// f64 pair the in-loop code would have produced (see `compute_coeff_table`),
/// and the surviving arithmetic is unchanged, so results stay bit-identical —
/// the win is dropping the serial `z_power` recurrence and the coefficient
/// scaling from every pixel-step.
#[cfg(target_arch = "wasm32")]
#[inline]
fn pair_delta_step_table(
    table: &[[f64; 2]],
    terms: usize,
    index_first: usize,
    index_second: usize,
    dz_re: core::arch::wasm32::v128,
    dz_im: core::arch::wasm32::v128,
) -> (core::arch::wasm32::v128, core::arch::wasm32::v128) {
    use core::arch::wasm32::*;

    let row_first = &table[index_first * terms..index_first * terms + terms];
    let row_second = &table[index_second * terms..index_second * terms + terms];

    let mut sum_re = f64x2_splat(1.0);
    let mut sum_im = f64x2_splat(0.0);

    for (entry_first, entry_second) in row_first.iter().zip(row_second) {
        // Each row entry is one [re, im] pair; shuffle two of them into the
        // lanewise (re, re) / (im, im) vectors the sum update consumes.
        let first = unsafe { v128_load(entry_first.as_ptr() as *const v128) };
        let second = unsafe { v128_load(entry_second.as_ptr() as *const v128) };
        let term_re = i64x2_shuffle::<0, 2>(first, second);
        let term_im = i64x2_shuffle::<1, 3>(first, second);

        let next_sum_re = f64x2_add(
            f64x2_sub(f64x2_mul(sum_re, dz_re), f64x2_mul(sum_im, dz_im)),
            term_re,
        );
        let next_sum_im = f64x2_add(
            f64x2_add(f64x2_mul(sum_re, dz_im), f64x2_mul(sum_im, dz_re)),
            term_im,
        );
        sum_re = next_sum_re;
        sum_im = next_sum_im;
    }

    (
        f64x2_sub(f64x2_mul(sum_re, dz_re), f64x2_mul(sum_im, dz_im)),
        f64x2_add(f64x2_mul(sum_re, dz_im), f64x2_mul(sum_im, dz_re)),
    )
}

/// One perturbation step for both lanes: advances the deltas, recombines with
/// the reference orbit, and rebases lanes whose delta stopped being small.
/// Escaped lanes keep stepping on garbage values (their output is frozen by
/// the caller); the rebase-at-orbit-end rule keeps their indices in bounds
/// regardless.
#[cfg(target_arch = "wasm32")]
fn pair_step<const GENERAL: bool>(
    orbit: &[(f64, f64)],
    coeff_table: &[[f64; 2]],
    dc_re: core::arch::wasm32::v128,
    dc_im: core::arch::wasm32::v128,
    last_index: usize,
    exponent: u32,
    state: &mut PairState,
) {
    use core::arch::wasm32::*;

    let (step_re, step_im) = if GENERAL && !coeff_table.is_empty() {
        pair_delta_step_table(
            coeff_table,
            (exponent - 1) as usize,
            state.index[0],
            state.index[1],
            state.dz_re,
            state.dz_im,
        )
    } else {
        let z_ref_first = orbit[state.index[0]];
        let z_ref_second = orbit[state.index[1]];
        pair_delta_step::<GENERAL>(
            f64x2(z_ref_first.0, z_ref_second.0),
            f64x2(z_ref_first.1, z_ref_second.1),
            state.dz_re,
            state.dz_im,
            exponent,
        )
    };
    pair_step_commit(orbit, dc_re, dc_im, last_index, state, step_re, step_im);
}

/// The tail of `pair_step` after the delta step: applies `+ dc`, recombines
/// with the reference orbit, and rebases lanes whose delta stopped being
/// small. Shared by the per-chain step and the fused general-exponent step.
#[cfg(target_arch = "wasm32")]
#[inline]
fn pair_step_commit(
    orbit: &[(f64, f64)],
    dc_re: core::arch::wasm32::v128,
    dc_im: core::arch::wasm32::v128,
    last_index: usize,
    state: &mut PairState,
    step_re: core::arch::wasm32::v128,
    step_im: core::arch::wasm32::v128,
) {
    use core::arch::wasm32::*;

    let new_dz_re = f64x2_add(step_re, dc_re);
    let new_dz_im = f64x2_add(step_im, dc_im);

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

/// Advances every chain by one general-exponent perturbation step with the
/// Horner terms from the coefficient table, running all chains' Horner
/// recurrences in one fused loop. Each chain's Horner sum is a serial
/// mul-add dependency chain; interleaving the chains gives the pipeline
/// `CHAINS` independent chains per term instead of one. Per-lane operations
/// and their order are identical to `pair_step`'s table path, so results are
/// bit-identical.
#[cfg(target_arch = "wasm32")]
#[inline]
fn fused_general_table_step<const CHAINS: usize>(
    orbit: &[(f64, f64)],
    coeff_table: &[[f64; 2]],
    terms: usize,
    dc_re: &[core::arch::wasm32::v128; CHAINS],
    dc_im: &[core::arch::wasm32::v128; CHAINS],
    last_index: usize,
    state: &mut [PairState; CHAINS],
) {
    use core::arch::wasm32::*;

    let mut sum_re = [f64x2_splat(1.0); CHAINS];
    let mut sum_im = [f64x2_splat(0.0); CHAINS];
    let mut offsets = [[0usize; 2]; CHAINS];
    for chain in 0..CHAINS {
        offsets[chain] = [state[chain].index[0] * terms, state[chain].index[1] * terms];
    }

    for j in 0..terms {
        for chain in 0..CHAINS {
            // In-bounds by construction: index <= last_index - 1 on entry
            // (the commit rebases any lane that reaches last_index) and the
            // table has a row of `terms` entries for every orbit index.
            let first = unsafe {
                v128_load(coeff_table.as_ptr().add(offsets[chain][0] + j) as *const v128)
            };
            let second = unsafe {
                v128_load(coeff_table.as_ptr().add(offsets[chain][1] + j) as *const v128)
            };
            let term_re = i64x2_shuffle::<0, 2>(first, second);
            let term_im = i64x2_shuffle::<1, 3>(first, second);

            let next_sum_re = f64x2_add(
                f64x2_sub(
                    f64x2_mul(sum_re[chain], state[chain].dz_re),
                    f64x2_mul(sum_im[chain], state[chain].dz_im),
                ),
                term_re,
            );
            let next_sum_im = f64x2_add(
                f64x2_add(
                    f64x2_mul(sum_re[chain], state[chain].dz_im),
                    f64x2_mul(sum_im[chain], state[chain].dz_re),
                ),
                term_im,
            );
            sum_re[chain] = next_sum_re;
            sum_im[chain] = next_sum_im;
        }
    }

    for chain in 0..CHAINS {
        let step_re = f64x2_sub(
            f64x2_mul(sum_re[chain], state[chain].dz_re),
            f64x2_mul(sum_im[chain], state[chain].dz_im),
        );
        let step_im = f64x2_add(
            f64x2_mul(sum_re[chain], state[chain].dz_im),
            f64x2_mul(sum_im[chain], state[chain].dz_re),
        );
        pair_step_commit(
            orbit,
            dc_re[chain],
            dc_im[chain],
            last_index,
            &mut state[chain],
            step_re,
            step_im,
        );
    }
}

/// Escape iterations for two pixels at once using f64 deltas with rebasing,
/// one pixel per 128-bit SIMD lane. Lane arithmetic is IEEE-identical to
/// `perturbed_escape_iterations_f64`, so results match it bit-for-bit; lanes
/// that escape are frozen while the other keeps iterating.
#[cfg(target_arch = "wasm32")]
fn perturbed_escape_iterations_f64_pair<const GENERAL: bool>(
    orbit: &[(f64, f64)],
    coeff_table: &[[f64; 2]],
    dc_first: Complex64,
    dc_second: Complex64,
    max_iterations: u32,
    exponent: u32,
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
    pair_step::<GENERAL>(
        orbit,
        coeff_table,
        dc_re,
        dc_im,
        last_index,
        exponent,
        &mut state,
    );

    let mut z_out_re = state.z_re;
    let mut z_out_im = state.z_im;
    // Alive lanes are all-ones, so subtracting the mask adds 1 per live lane.
    let mut alive = i64x2_splat(-1);
    let mut lane_iterations = i64x2_splat(0);
    let mut remaining = max_iterations;

    // Brent-style periodicity on the perturbation state (dz, index), per
    // lane; see perturbed_escape_iterations_f64. dz equality is checked in
    // SIMD, the scalar index only on the rare dz match.
    let mut saved_dz_re = state.dz_re;
    let mut saved_dz_im = state.dz_im;
    let mut saved_index = state.index;
    let mut steps_done = 0u32;
    let mut next_save = PERIODICITY_FIRST_SAVE;
    let mut periodic = [false, false];

    while remaining > 0 {
        let norm_sqr = f64x2_add(f64x2_mul(z_out_re, z_out_re), f64x2_mul(z_out_im, z_out_im));
        alive = v128_and(alive, f64x2_lt(norm_sqr, radius_squared));
        if !v128_any_true(alive) {
            break;
        }

        pair_step::<GENERAL>(
            orbit,
            coeff_table,
            dc_re,
            dc_im,
            last_index,
            exponent,
            &mut state,
        );
        z_out_re = v128_bitselect(state.z_re, z_out_re, alive);
        z_out_im = v128_bitselect(state.z_im, z_out_im, alive);
        lane_iterations = i64x2_sub(lane_iterations, alive);
        remaining -= 1;

        steps_done += 1;
        if steps_done % PERIODICITY_CHECK_STRIDE == 0 {
            let cycled = v128_and(
                v128_and(
                    f64x2_eq(state.dz_re, saved_dz_re),
                    f64x2_eq(state.dz_im, saved_dz_im),
                ),
                alive,
            );
            if v128_any_true(cycled) {
                let cycled_first =
                    i64x2_extract_lane::<0>(cycled) != 0 && state.index[0] == saved_index[0];
                let cycled_second =
                    i64x2_extract_lane::<1>(cycled) != 0 && state.index[1] == saved_index[1];
                if cycled_first || cycled_second {
                    periodic[0] |= cycled_first;
                    periodic[1] |= cycled_second;
                    alive = v128_andnot(
                        alive,
                        i64x2(-(cycled_first as i64), -(cycled_second as i64)),
                    );
                    if !v128_any_true(alive) {
                        break;
                    }
                }
            }
            if steps_done == next_save {
                saved_dz_re = state.dz_re;
                saved_dz_im = state.dz_im;
                saved_index = state.index;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    let lane_results = [
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
    ];

    [
        if periodic[0] {
            (max_iterations, lane_results[0].1)
        } else {
            lane_results[0]
        },
        if periodic[1] {
            (max_iterations, lane_results[1].1)
        } else {
            lane_results[1]
        },
    ]
}

// Number of f64x2 vectors the streaming perturbation kernel keeps in flight
// (2 pixels per vector); mirrors the direct pathway's STREAM_CHAINS.
#[cfg(target_arch = "wasm32")]
const PERTURB_STREAM_CHAINS: usize = 4;

// Iterations between bookkeeping passes (retire/refill, budget, periodicity)
// in the streaming perturbation kernel. Lanes are only loaded at bookkeeping
// boundaries, so per-lane iteration counts at a pass are multiples of the
// stride and the Brent save/check schedule stays guaranteed.
#[cfg(target_arch = "wasm32")]
const PERTURB_STREAM_STRIDE: u32 = 16;

/// Streaming lane-refill kernel for the f64-delta perturbation path (any
/// supported exponent): keeps `CHAINS` f64x2 vectors of pixels in flight via
/// `pair_step` and refills a lane as soon as its pixel escapes, is detected
/// periodic, or exhausts the budget — so no lane idles waiting for a slow
/// neighbor, unlike the fixed pair batching. Escaped lanes freeze their z and
/// iteration count exactly at the escape step via the alive mask (they keep
/// garbage-stepping until the next bookkeeping pass, as in the pair kernel),
/// so results are bit-identical to `perturbed_escape_iterations_f64`.
#[cfg(target_arch = "wasm32")]
fn stream_perturbed_escape_f64<const CHAINS: usize, const GENERAL: bool>(
    orbit: &[(f64, f64)],
    coeff_table: &[[f64; 2]],
    dc_of: impl Fn(usize) -> Complex64,
    pixel_count: usize,
    max_iterations: u32,
    exponent: u32,
    escape_radius_squared: f64,
    results: &mut [(u32, Complex64)],
) {
    use core::arch::wasm32::*;

    let last_index = orbit.len() - 1;
    let zero_f = f64x2_splat(0.0);
    let zero_i = i64x2_splat(0);

    let mut state: [PairState; CHAINS] = core::array::from_fn(|_| PairState {
        index: [0; 2],
        dz_re: zero_f,
        dz_im: zero_f,
        z_re: zero_f,
        z_im: zero_f,
    });
    let mut dc_re = [zero_f; CHAINS];
    let mut dc_im = [zero_f; CHAINS];
    let mut z_out_re = [zero_f; CHAINS];
    let mut z_out_im = [zero_f; CHAINS];
    // Alive lanes are all-ones and a subset of occupied; occupied lanes hold
    // a pixel that has not been retired yet.
    let mut alive = [zero_i; CHAINS];
    let mut occupied = [zero_i; CHAINS];
    let mut iters = [zero_i; CHAINS];
    // Brent-style periodicity state (dz, index) per lane; see
    // perturbed_escape_iterations_f64.
    let mut saved_dz_re = [zero_f; CHAINS];
    let mut saved_dz_im = [zero_f; CHAINS];
    let mut saved_index = [[0usize; 2]; CHAINS];
    let mut next_save = [zero_i; CHAINS];
    let mut slots = [[IDLE_SLOT; 2]; CHAINS];

    // Loads pixel `pixel` onto lane (chain, sub), applying the un-counted
    // pre-step that the per-pixel loops perform (afterwards z equals the
    // pixel's own c); the scalar arithmetic is IEEE-identical to a pair_step
    // from (dz = 0, index = 0).
    macro_rules! load_lane {
        ($chain:expr, $sub:expr, $pixel:expr) => {{
            let chain = $chain;
            let sub = $sub;
            let pixel = $pixel;
            let dc = dc_of(pixel);
            let z_ref = orbit[0];
            let mut dz = delta_step_f64(
                Complex64::new(z_ref.0, z_ref.1),
                Complex64::new(0.0, 0.0),
                exponent,
            ) + dc;
            let mut index = 1usize;
            let z = Complex64::new(orbit[index].0 + dz.re, orbit[index].1 + dz.im);
            if index == last_index || z.norm_sqr() < dz.norm_sqr() {
                dz = z;
                index = 0;
            }
            dc_re[chain] = f64x2_with_lane(dc_re[chain], sub, dc.re);
            dc_im[chain] = f64x2_with_lane(dc_im[chain], sub, dc.im);
            state[chain].dz_re = f64x2_with_lane(state[chain].dz_re, sub, dz.re);
            state[chain].dz_im = f64x2_with_lane(state[chain].dz_im, sub, dz.im);
            state[chain].z_re = f64x2_with_lane(state[chain].z_re, sub, z.re);
            state[chain].z_im = f64x2_with_lane(state[chain].z_im, sub, z.im);
            state[chain].index[sub] = index;
            z_out_re[chain] = f64x2_with_lane(z_out_re[chain], sub, z.re);
            z_out_im[chain] = f64x2_with_lane(z_out_im[chain], sub, z.im);
            alive[chain] = i64x2_with_lane(alive[chain], sub, -1);
            occupied[chain] = i64x2_with_lane(occupied[chain], sub, -1);
            iters[chain] = i64x2_with_lane(iters[chain], sub, 0);
            saved_dz_re[chain] = f64x2_with_lane(saved_dz_re[chain], sub, dz.re);
            saved_dz_im[chain] = f64x2_with_lane(saved_dz_im[chain], sub, dz.im);
            saved_index[chain][sub] = index;
            next_save[chain] =
                i64x2_with_lane(next_save[chain], sub, i64::from(PERIODICITY_FIRST_SAVE));
            slots[chain][sub] = pixel;
        }};
    }

    let mut next_pixel = 0usize;
    let mut live_lanes = 0usize;
    for chain in 0..CHAINS {
        for sub in 0..2 {
            if next_pixel < pixel_count {
                load_lane!(chain, sub, next_pixel);
                next_pixel += 1;
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
        for _ in 0..PERTURB_STREAM_STRIDE {
            if GENERAL && !coeff_table.is_empty() {
                // Escape checks first (they only read the frozen z_out), then
                // all chains' delta steps fused so their serial Horner
                // recurrences overlap, then the commits. Per-lane values are
                // identical to the per-chain order below.
                for chain in 0..CHAINS {
                    let norm_sqr = f64x2_add(
                        f64x2_mul(z_out_re[chain], z_out_re[chain]),
                        f64x2_mul(z_out_im[chain], z_out_im[chain]),
                    );
                    alive[chain] = v128_and(alive[chain], f64x2_lt(norm_sqr, radius_squared));
                }
                fused_general_table_step::<CHAINS>(
                    orbit,
                    coeff_table,
                    (exponent - 1) as usize,
                    &dc_re,
                    &dc_im,
                    last_index,
                    &mut state,
                );
                for chain in 0..CHAINS {
                    z_out_re[chain] =
                        v128_bitselect(state[chain].z_re, z_out_re[chain], alive[chain]);
                    z_out_im[chain] =
                        v128_bitselect(state[chain].z_im, z_out_im[chain], alive[chain]);
                    iters[chain] = i64x2_sub(iters[chain], alive[chain]);
                }
                continue;
            }
            for chain in 0..CHAINS {
                let norm_sqr = f64x2_add(
                    f64x2_mul(z_out_re[chain], z_out_re[chain]),
                    f64x2_mul(z_out_im[chain], z_out_im[chain]),
                );
                alive[chain] = v128_and(alive[chain], f64x2_lt(norm_sqr, radius_squared));
                pair_step::<GENERAL>(
                    orbit,
                    coeff_table,
                    dc_re[chain],
                    dc_im[chain],
                    last_index,
                    exponent,
                    &mut state[chain],
                );
                z_out_re[chain] = v128_bitselect(state[chain].z_re, z_out_re[chain], alive[chain]);
                z_out_im[chain] = v128_bitselect(state[chain].z_im, z_out_im[chain], alive[chain]);
                iters[chain] = i64x2_sub(iters[chain], alive[chain]);
            }
        }

        for chain in 0..CHAINS {
            // A lane is finished when it escaped (occupied but no longer
            // alive), ran out its budget, or is a periodicity candidate (dz
            // matches the save; the scalar index is confirmed at retirement).
            let out_of_budget = i64x2_gt(iters[chain], max_iterations_minus_one);
            let dz_match = v128_and(
                v128_and(
                    f64x2_eq(state[chain].dz_re, saved_dz_re[chain]),
                    f64x2_eq(state[chain].dz_im, saved_dz_im[chain]),
                ),
                alive[chain],
            );
            let finished = v128_or(
                v128_andnot(occupied[chain], alive[chain]),
                v128_and(alive[chain], v128_or(out_of_budget, dz_match)),
            );

            if v128_any_true(finished) {
                for sub in 0..2 {
                    if i64x2_lane(finished, sub) == 0 {
                        continue;
                    }
                    let lane_alive = i64x2_lane(alive[chain], sub) != 0;
                    if lane_alive {
                        let over_budget =
                            i64x2_lane(iters[chain], sub) > i64::from(max_iterations) - 1;
                        let cycled = i64x2_lane(dz_match, sub) != 0
                            && state[chain].index[sub] == saved_index[chain][sub];
                        if !over_budget && !cycled {
                            // dz matched at a different orbit index: not a
                            // state recurrence, keep iterating.
                            continue;
                        }
                    }
                    // Alive-but-finished lanes are periodic or out of budget:
                    // both report max_iterations (out-of-budget lanes may
                    // have overshot by masked steps, hence the min below).
                    let escape_iterations = if lane_alive {
                        max_iterations
                    } else {
                        (i64x2_lane(iters[chain], sub) as u32).min(max_iterations)
                    };
                    let z = Complex64::new(
                        f64x2_lane(z_out_re[chain], sub),
                        f64x2_lane(z_out_im[chain], sub),
                    );
                    results[slots[chain][sub]] = (escape_iterations, z);

                    if next_pixel < pixel_count {
                        load_lane!(chain, sub, next_pixel);
                        next_pixel += 1;
                    } else {
                        alive[chain] = i64x2_with_lane(alive[chain], sub, 0);
                        occupied[chain] = i64x2_with_lane(occupied[chain], sub, 0);
                        slots[chain][sub] = IDLE_SLOT;
                        live_lanes -= 1;
                    }
                }
            }

            // Periodicity saves land at per-lane iteration counts that are
            // multiples of the stride, keeping detection guaranteed as in
            // the scalar loop.
            let save_due = v128_andnot(alive[chain], i64x2_gt(next_save[chain], iters[chain]));
            if v128_any_true(save_due) {
                saved_dz_re[chain] =
                    v128_bitselect(state[chain].dz_re, saved_dz_re[chain], save_due);
                saved_dz_im[chain] =
                    v128_bitselect(state[chain].dz_im, saved_dz_im[chain], save_due);
                next_save[chain] =
                    v128_bitselect(i64x2_shl(next_save[chain], 1), next_save[chain], save_due);
                for sub in 0..2 {
                    if i64x2_lane(save_due, sub) != 0 {
                        saved_index[chain][sub] = state[chain].index[sub];
                    }
                }
            }
        }

        if live_lanes == 0 {
            break;
        }
    }
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
        self.dz_small =
            delta_step_float_exp(Complex64::new(z_ref.0, z_ref.1), self.dz_small, 2).add(&self.dc);
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

fn hybrid_initial_state(orbit: &[(f64, f64)], dc: ComplexExp) -> HybridState<'_> {
    let (dc_re, dc_im) = dc.to_f64s();
    HybridState {
        orbit,
        last_index: orbit.len() - 1,
        dc,
        dc_f64: Complex64::new(dc_re, dc_im),
        reference_index: 0,
        dz_small: ComplexExp::ZERO,
        dz_big: Complex64::new(0.0, 0.0),
        big: false,
        z: Complex64::new(0.0, 0.0),
    }
}

/// Runs a hybrid pixel from its current state until escape or budget
/// exhaustion. `iterations` counts the steps already taken (the un-counted
/// pre-step excluded).
fn run_hybrid_to_completion(
    state: &mut HybridState,
    start_iterations: u32,
    max_iterations: u32,
    escape_radius_squared: f64,
) -> (u32, Complex64) {
    let mut iterations = start_iterations;
    while state.z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        state.advance();
        iterations += 1;
    }
    (iterations, state.z)
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
    let mut state = hybrid_initial_state(orbit, dc);

    // Pre-step, mirroring the pure loops: afterwards z equals the pixel's c.
    state.advance();

    run_hybrid_to_completion(&mut state, 0, max_iterations, escape_radius_squared)
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
        return perturbed_escape_iterations_hybrid(
            orbit,
            dc,
            max_iterations,
            escape_radius_squared,
        );
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

/// Outcome of scalar-stepping a float-exp pixel until it is ready for the
/// SIMD stream kernel's f64 phase.
#[cfg(target_arch = "wasm32")]
enum HybridWarmIn<'a> {
    /// The pixel reached the big (plain-f64) phase with `iterations` counted
    /// steps taken; its state can be loaded onto a SIMD lane.
    Big {
        state: HybridState<'a>,
        iterations: u32,
    },
    Finished(u32, Complex64),
}

/// Scalar-steps one float-exp pixel until it enters the big phase, escapes,
/// or exhausts the budget. Pixels not eligible for the hybrid loop (dc zero
/// or too small for exact f64 conversion) run the pure float-exp loop to
/// completion. Arithmetic is exactly the scalar hybrid loop's, so a pixel
/// that never reaches a lane still gets bit-identical results.
#[cfg(target_arch = "wasm32")]
fn hybrid_warm_in(
    orbit: &[(f64, f64)],
    dc: ComplexExp,
    max_iterations: u32,
    escape_radius_squared: f64,
) -> HybridWarmIn<'_> {
    if dc.is_zero() || dc.exp < HYBRID_DC_MIN_EXP {
        let (iterations, z) = perturbed_escape_iterations_float_exp(
            orbit,
            dc,
            max_iterations,
            2,
            escape_radius_squared,
        );
        return HybridWarmIn::Finished(iterations, z);
    }

    let mut state = hybrid_initial_state(orbit, dc);
    // Pre-step, mirroring the per-pixel loops: afterwards z equals the
    // pixel's c.
    state.advance();

    let mut iterations = 0u32;
    while state.z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        if state.big {
            return HybridWarmIn::Big { state, iterations };
        }
        state.advance();
        iterations += 1;
    }
    HybridWarmIn::Finished(iterations, state.z)
}

/// Streaming lane-refill kernel for the hybrid float-exp path (quadratic
/// only). Lanes hold pixels in the hybrid loop's big (plain-f64) phase and
/// advance them exactly like `HybridState::advance`'s big branch, one pixel
/// per f64x2 lane with `CHAINS` vectors in flight; per-lane arithmetic is
/// IEEE-identical to the scalar loop, so results are bit-identical to
/// `perturbed_escape_iterations_hybrid`. The rare per-pixel events that
/// leave the f64 phase — a step dipping below `HYBRID_FLOOR_NORM_SQR`
/// (which the scalar loop redoes in ComplexExp) or a rebase landing below
/// the floor (demotion) — evict the pixel from its lane with its exact
/// scalar state; the pixel then finishes on the scalar hybrid loop and the
/// lane is refilled. Pixels start in the small phase, so each is
/// scalar-stepped until its first promotion before being loaded
/// (`hybrid_warm_in`). No periodicity checks, matching the scalar hybrid
/// loop.
#[cfg(target_arch = "wasm32")]
fn stream_hybrid_escape<const CHAINS: usize>(
    orbit: &[(f64, f64)],
    dc_of: impl Fn(usize) -> ComplexExp,
    pixel_count: usize,
    max_iterations: u32,
    escape_radius_squared: f64,
    results: &mut [(u32, Complex64)],
) {
    use core::arch::wasm32::*;

    let last_index = orbit.len() - 1;
    let zero_f = f64x2_splat(0.0);
    let zero_i = i64x2_splat(0);

    let mut state: [PairState; CHAINS] = core::array::from_fn(|_| PairState {
        index: [0; 2],
        dz_re: zero_f,
        dz_im: zero_f,
        z_re: zero_f,
        z_im: zero_f,
    });
    let mut dc_re = [zero_f; CHAINS];
    let mut dc_im = [zero_f; CHAINS];
    let mut z_out_re = [zero_f; CHAINS];
    let mut z_out_im = [zero_f; CHAINS];
    // Alive lanes are all-ones and a subset of occupied; occupied lanes hold
    // a pixel that has not been retired yet.
    let mut alive = [zero_i; CHAINS];
    let mut occupied = [zero_i; CHAINS];
    let mut iters = [zero_i; CHAINS];
    let mut slots = [[IDLE_SLOT; 2]; CHAINS];

    let mut next_pixel = 0usize;
    let mut live_lanes = 0usize;

    // Draws pixels from the queue until one reaches the big phase (loading
    // it onto lane (chain, sub)) or the queue runs out (marking the lane
    // idle); pixels that finish during warm-in get their results written
    // directly.
    macro_rules! refill_lane {
        ($chain:expr, $sub:expr) => {{
            let chain = $chain;
            let sub = $sub;
            let mut loaded = false;
            while next_pixel < pixel_count {
                let pixel = next_pixel;
                next_pixel += 1;
                match hybrid_warm_in(orbit, dc_of(pixel), max_iterations, escape_radius_squared) {
                    HybridWarmIn::Finished(iterations, z) => {
                        results[pixel] = (iterations, z);
                    }
                    HybridWarmIn::Big {
                        state: warm,
                        iterations,
                    } => {
                        dc_re[chain] = f64x2_with_lane(dc_re[chain], sub, warm.dc_f64.re);
                        dc_im[chain] = f64x2_with_lane(dc_im[chain], sub, warm.dc_f64.im);
                        state[chain].dz_re =
                            f64x2_with_lane(state[chain].dz_re, sub, warm.dz_big.re);
                        state[chain].dz_im =
                            f64x2_with_lane(state[chain].dz_im, sub, warm.dz_big.im);
                        state[chain].z_re = f64x2_with_lane(state[chain].z_re, sub, warm.z.re);
                        state[chain].z_im = f64x2_with_lane(state[chain].z_im, sub, warm.z.im);
                        state[chain].index[sub] = warm.reference_index;
                        z_out_re[chain] = f64x2_with_lane(z_out_re[chain], sub, warm.z.re);
                        z_out_im[chain] = f64x2_with_lane(z_out_im[chain], sub, warm.z.im);
                        alive[chain] = i64x2_with_lane(alive[chain], sub, -1);
                        occupied[chain] = i64x2_with_lane(occupied[chain], sub, -1);
                        iters[chain] = i64x2_with_lane(iters[chain], sub, i64::from(iterations));
                        slots[chain][sub] = pixel;
                        loaded = true;
                        break;
                    }
                }
            }
            if !loaded {
                alive[chain] = i64x2_with_lane(alive[chain], sub, 0);
                occupied[chain] = i64x2_with_lane(occupied[chain], sub, 0);
                slots[chain][sub] = IDLE_SLOT;
                live_lanes -= 1;
            }
        }};
    }

    // Evicts lane (chain, sub) into a scalar HybridState and finishes the
    // pixel on the scalar loop. `big`/`dz`/`index`/`z` describe the exact
    // scalar state at eviction; `start_iterations` is clamped so lanes that
    // garbage-stepped past the budget report exactly max_iterations.
    macro_rules! evict_lane {
        ($chain:expr, $sub:expr, $big:expr, $dz:expr, $index:expr, $z:expr) => {{
            let chain = $chain;
            let sub = $sub;
            let pixel = slots[chain][sub];
            let dc = dc_of(pixel);
            let mut scalar = hybrid_initial_state(orbit, dc);
            scalar.reference_index = $index;
            scalar.z = $z;
            if $big {
                scalar.dz_big = $dz;
                scalar.big = true;
            } else {
                scalar.dz_small = ComplexExp::from_f64s($dz.re, $dz.im);
                scalar.big = false;
            }
            let start = (i64x2_lane(iters[chain], sub) as u32).min(max_iterations);
            results[pixel] =
                run_hybrid_to_completion(&mut scalar, start, max_iterations, escape_radius_squared);
            refill_lane!(chain, sub);
        }};
    }

    for chain in 0..CHAINS {
        for sub in 0..2 {
            live_lanes += 1;
            refill_lane!(chain, sub);
        }
    }
    if live_lanes == 0 {
        return;
    }

    let radius_squared = f64x2_splat(escape_radius_squared);
    let floor_norm_sqr = f64x2_splat(HYBRID_FLOOR_NORM_SQR);
    let max_iterations_minus_one = i64x2_splat(i64::from(max_iterations) - 1);

    loop {
        for _ in 0..PERTURB_STREAM_STRIDE {
            for chain in 0..CHAINS {
                let norm_sqr = f64x2_add(
                    f64x2_mul(z_out_re[chain], z_out_re[chain]),
                    f64x2_mul(z_out_im[chain], z_out_im[chain]),
                );
                alive[chain] = v128_and(alive[chain], f64x2_lt(norm_sqr, radius_squared));

                // The step is computed in temporaries and only committed when
                // no live lane dipped below the hybrid floor, mirroring the
                // scalar loop's redo-in-ComplexExp rule: a dipped lane's
                // pre-step state must survive untouched for the eviction.
                let z_ref_first = orbit[state[chain].index[0]];
                let z_ref_second = orbit[state[chain].index[1]];
                let (step_re, step_im) = pair_delta_step::<false>(
                    f64x2(z_ref_first.0, z_ref_second.0),
                    f64x2(z_ref_first.1, z_ref_second.1),
                    state[chain].dz_re,
                    state[chain].dz_im,
                    2,
                );
                let new_dz_re = f64x2_add(step_re, dc_re[chain]);
                let new_dz_im = f64x2_add(step_im, dc_im[chain]);
                let dz_norm_sqr = f64x2_add(
                    f64x2_mul(new_dz_re, new_dz_re),
                    f64x2_mul(new_dz_im, new_dz_im),
                );

                let dipped = v128_and(f64x2_lt(dz_norm_sqr, floor_norm_sqr), alive[chain]);
                if v128_any_true(dipped) {
                    // Rare: evict dipped lanes with their pre-step state (the
                    // scalar loop redoes the step in ComplexExp) and skip the
                    // commit; surviving lanes recompute this step identically
                    // on the next pass.
                    for sub in 0..2 {
                        if i64x2_lane(dipped, sub) != 0 {
                            let dz = Complex64::new(
                                f64x2_lane(state[chain].dz_re, sub),
                                f64x2_lane(state[chain].dz_im, sub),
                            );
                            let z = Complex64::new(
                                f64x2_lane(z_out_re[chain], sub),
                                f64x2_lane(z_out_im[chain], sub),
                            );
                            let index = state[chain].index[sub];
                            evict_lane!(chain, sub, true, dz, index, z);
                        }
                    }
                    continue;
                }

                let index_first = state[chain].index[0] + 1;
                let index_second = state[chain].index[1] + 1;
                let z_next_first = orbit[index_first];
                let z_next_second = orbit[index_second];
                let new_z_re = f64x2_add(f64x2(z_next_first.0, z_next_second.0), new_dz_re);
                let new_z_im = f64x2_add(f64x2(z_next_first.1, z_next_second.1), new_dz_im);
                let z_norm_sqr =
                    f64x2_add(f64x2_mul(new_z_re, new_z_re), f64x2_mul(new_z_im, new_z_im));

                let at_orbit_end = i64x2(
                    -((index_first == last_index) as i64),
                    -((index_second == last_index) as i64),
                );
                let rebase = v128_or(at_orbit_end, f64x2_lt(z_norm_sqr, dz_norm_sqr));

                state[chain].dz_re = v128_bitselect(new_z_re, new_dz_re, rebase);
                state[chain].dz_im = v128_bitselect(new_z_im, new_dz_im, rebase);
                state[chain].index[0] = if i64x2_extract_lane::<0>(rebase) != 0 {
                    0
                } else {
                    index_first
                };
                state[chain].index[1] = if i64x2_extract_lane::<1>(rebase) != 0 {
                    0
                } else {
                    index_second
                };
                state[chain].z_re = new_z_re;
                state[chain].z_im = new_z_im;

                z_out_re[chain] = v128_bitselect(new_z_re, z_out_re[chain], alive[chain]);
                z_out_im[chain] = v128_bitselect(new_z_im, z_out_im[chain], alive[chain]);
                iters[chain] = i64x2_sub(iters[chain], alive[chain]);

                // A rebase landing below the floor demotes the pixel to the
                // ComplexExp phase (state already committed, step counted).
                let demoted = v128_and(
                    v128_and(rebase, f64x2_lt(z_norm_sqr, floor_norm_sqr)),
                    alive[chain],
                );
                if v128_any_true(demoted) {
                    for sub in 0..2 {
                        if i64x2_lane(demoted, sub) != 0 {
                            let z = Complex64::new(
                                f64x2_lane(new_z_re, sub),
                                f64x2_lane(new_z_im, sub),
                            );
                            evict_lane!(chain, sub, false, z, 0, z);
                        }
                    }
                }
            }
        }

        for chain in 0..CHAINS {
            // A lane is finished when it escaped (occupied but no longer
            // alive) or ran out its budget.
            let out_of_budget = i64x2_gt(iters[chain], max_iterations_minus_one);
            let finished = v128_or(
                v128_andnot(occupied[chain], alive[chain]),
                v128_and(alive[chain], out_of_budget),
            );

            if v128_any_true(finished) {
                for sub in 0..2 {
                    if i64x2_lane(finished, sub) == 0 {
                        continue;
                    }
                    // Out-of-budget lanes may have overshot by masked steps,
                    // hence the min below.
                    let escape_iterations =
                        (i64x2_lane(iters[chain], sub) as u32).min(max_iterations);
                    let z = Complex64::new(
                        f64x2_lane(z_out_re[chain], sub),
                        f64x2_lane(z_out_im[chain], sub),
                    );
                    results[slots[chain][sub]] = (escape_iterations, z);
                    refill_lane!(chain, sub);
                }
            }
        }

        if live_lanes == 0 {
            break;
        }
    }
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

    /// The pixel's perturbation delta from the reference point as a plain
    /// f64 (only meaningful on the f64-delta path).
    fn pixel_dc_f64(&self, column: usize, row: usize) -> Complex64 {
        let re_offset = self.first_column_offset + self.column_step * column as f64;
        let im_offset = self.first_row_offset + self.row_step * row as f64;
        Complex64::new(
            ldexp(re_offset, -self.zoom_offset),
            ldexp(im_offset, -self.zoom_offset),
        )
    }

    /// Escape results for every pixel in row-major order. The f64-delta path
    /// streams all pixels through the lane-refilling kernel on wasm32; the
    /// float-exp path falls back to the per-pixel loops in pairs.
    pub fn compute_all(&self, image_width: usize, image_height: usize) -> Vec<(u32, Complex64)> {
        let pixel_count = image_width * image_height;
        let mut results = vec![(0u32, Complex64::new(0.0, 0.0)); pixel_count];

        #[cfg(target_arch = "wasm32")]
        if self.use_float_exp && self.exponent == 2 {
            let dc_of = |pixel: usize| {
                let column = pixel % image_width;
                let row = pixel / image_width;
                let re_offset = self.first_column_offset + self.column_step * column as f64;
                let im_offset = self.first_row_offset + self.row_step * row as f64;
                ComplexExp::new(re_offset, im_offset, -self.zoom_offset)
            };
            stream_hybrid_escape::<PERTURB_STREAM_CHAINS>(
                &self.orbit.values,
                dc_of,
                pixel_count,
                self.max_iterations,
                self.escape_radius_squared,
                &mut results,
            );
            return results;
        }

        #[cfg(target_arch = "wasm32")]
        if !self.use_float_exp {
            if self.exponent == 2 {
                // Mariani–Silver subdivision over the stream kernel: interior
                // pixels at these depths never rebase, so periodicity can't
                // retire them and only the ring-fill saves their full budget.
                // Multibrot tiles stay on the plain stream call: the one real
                // multibrot pf64 view has scattered interior that never fills,
                // so it pays only the wave overhead.
                results.fill((crate::UNCOMPUTED, Complex64::new(0.0, 0.0)));
                crate::subdivide_tile_streamed(
                    image_width,
                    image_height,
                    self.max_iterations,
                    &mut results,
                    |pixels, wave_results| {
                        let dc_of = |position: usize| {
                            let pixel = pixels[position];
                            self.pixel_dc_f64(pixel % image_width, pixel / image_width)
                        };
                        stream_perturbed_escape_f64::<PERTURB_STREAM_CHAINS, false>(
                            &self.orbit.values,
                            &self.orbit.coeff_table,
                            dc_of,
                            pixels.len(),
                            self.max_iterations,
                            self.exponent,
                            self.escape_radius_squared,
                            wave_results,
                        );
                    },
                );
            } else {
                let dc_of =
                    |pixel: usize| self.pixel_dc_f64(pixel % image_width, pixel / image_width);
                stream_perturbed_escape_f64::<PERTURB_STREAM_CHAINS, true>(
                    &self.orbit.values,
                    &self.orbit.coeff_table,
                    dc_of,
                    pixel_count,
                    self.max_iterations,
                    self.exponent,
                    self.escape_radius_squared,
                    &mut results,
                );
            }
            return results;
        }

        for row in 0..image_height {
            let mut column = 0;
            while column < image_width {
                // Batch pairs of pixels into SIMD lanes where a batched
                // implementation exists; a trailing odd pixel is paired with
                // itself.
                let second_column = (column + 1).min(image_width - 1);
                let pair = self.escape_iterations_pair((column, row), (second_column, row));
                results[row * image_width + column] = pair[0];
                if second_column != column {
                    results[row * image_width + second_column] = pair[1];
                }
                column += 2;
            }
        }
        results
    }

    /// Escape iterations and final value for the pixel at (column, row).
    pub fn escape_iterations(&self, column: usize, row: usize) -> (u32, Complex64) {
        if self.use_float_exp {
            let re_offset = self.first_column_offset + self.column_step * column as f64;
            let im_offset = self.first_row_offset + self.row_step * row as f64;
            let dc = ComplexExp::new(re_offset, im_offset, -self.zoom_offset);
            perturbed_escape_iterations_float_exp(
                &self.orbit.values,
                dc,
                self.max_iterations,
                self.exponent,
                self.escape_radius_squared,
            )
        } else {
            let dc = self.pixel_dc_f64(column, row);
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
    /// lanes where a batched implementation exists (wasm32, f64 deltas).
    #[cfg(target_arch = "wasm32")]
    pub fn escape_iterations_pair(
        &self,
        first: (usize, usize),
        second: (usize, usize),
    ) -> [(u32, Complex64); 2] {
        if self.use_float_exp {
            return [
                self.escape_iterations(first.0, first.1),
                self.escape_iterations(second.0, second.1),
            ];
        }

        let dc_first = self.pixel_dc_f64(first.0, first.1);
        let dc_second = self.pixel_dc_f64(second.0, second.1);
        if self.exponent == 2 {
            perturbed_escape_iterations_f64_pair::<false>(
                &self.orbit.values,
                &self.orbit.coeff_table,
                dc_first,
                dc_second,
                self.max_iterations,
                self.exponent,
                self.escape_radius_squared,
            )
        } else {
            perturbed_escape_iterations_f64_pair::<true>(
                &self.orbit.values,
                &self.orbit.coeff_table,
                dc_first,
                dc_second,
                self.max_iterations,
                self.exponent,
                self.escape_radius_squared,
            )
        }
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
