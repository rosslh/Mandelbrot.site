use super::*;
use dashu::integer::IBig;
use std::convert::TryFrom;

/// A point in the seahorse valley with enough (arbitrary) extra digits to be
/// meaningful far beyond f64 precision.
const DEEP_RE: &str =
    "-0.74364388703715870475219150611477412528901234567890123456789012345678901234567890123456789012345678901234567890";
const DEEP_IM: &str =
    "0.13182590420531197049313205638513898765432109876543210987654321098765432109876543210987654321098765432109876543";

const ESCAPE_RADIUS_SQUARED: f64 = 9.0;

/// Escape iterations computed the slow, indisputable way: full
/// arbitrary-precision iteration of z = z^2 + c.
fn direct_escape_iterations_big(c_re: &BigFloat, c_im: &BigFloat, max_iterations: u32) -> u32 {
    let mut z = (c_re.clone(), c_im.clone());
    let mut iterations = 0;

    loop {
        let re = z.0.to_f64().value();
        let im = z.1.to_f64().value();
        if re * re + im * im >= ESCAPE_RADIUS_SQUARED || iterations >= max_iterations {
            return iterations;
        }
        z = (
            &z.0 * &z.0 - &z.1 * &z.1 + c_re,
            (&z.0 * &z.1) * BigFloat::from(2) + c_im,
        );
        iterations += 1;
    }
}

/// The tile coordinate whose offset from the world origin is zero.
fn centered_tile_coordinate(tile_zoom: i32) -> f64 {
    2.56 * f64::powi(2.0, tile_zoom - 2)
}

fn make_frame(
    origin_re: &str,
    origin_im: &str,
    tile_zoom: i32,
    zoom_offset: u32,
    image_size: usize,
    max_iterations: u32,
) -> PerturbedFrame {
    let center = centered_tile_coordinate(tile_zoom).floor();
    PerturbedFrame::new(
        origin_re,
        origin_im,
        center,
        center + 1.0,
        center,
        center + 1.0,
        tile_zoom,
        zoom_offset,
        image_size,
        image_size,
        max_iterations,
        2,
        3.0,
    )
    .unwrap()
}

#[test]
fn perturbed_matches_direct_f64_at_moderate_zoom() {
    let image_size = 50;
    let max_iterations = 800;
    let tile_zoom = 33;
    let zoom_offset = 2;

    let frame = make_frame(
        DEEP_RE,
        DEEP_IM,
        tile_zoom,
        zoom_offset,
        image_size,
        max_iterations,
    );

    let origin_re: f64 = DEEP_RE.parse().unwrap();
    let origin_im: f64 = DEEP_IM.parse().unwrap();
    let center = centered_tile_coordinate(tile_zoom).floor();

    let mut matching = 0;
    let mut total = 0;
    for row in 0..image_size {
        for column in 0..image_size {
            let x = center + column as f64 / (image_size - 1) as f64;
            let y = center + row as f64 / (image_size - 1) as f64;
            let re = origin_re
                + crate::float_exp::ldexp(
                    tile_coordinate_offset(x, tile_zoom),
                    -(zoom_offset as i64),
                );
            let im = origin_im
                - crate::float_exp::ldexp(
                    tile_coordinate_offset(y, tile_zoom),
                    -(zoom_offset as i64),
                );

            let (direct_iterations, _) =
                crate::calculate_escape_iterations(re, im, max_iterations, 2);
            let (perturbed_iterations, _) = frame.escape_iterations(column, row);

            let difference = direct_iterations.abs_diff(perturbed_iterations);
            assert!(
                difference <= 5,
                "pixel ({column}, {row}): direct {direct_iterations} vs perturbed {perturbed_iterations}"
            );
            if difference == 0 {
                matching += 1;
            }
            total += 1;
        }
    }

    assert!(
        matching as f64 / total as f64 > 0.98,
        "only {matching}/{total} pixels matched exactly"
    );
}

#[test]
fn perturbed_matches_full_precision_direct() {
    // One depth on the f64-delta path and one on the extended-exponent path.
    for (tile_zoom, zoom_offset) in [(10, 140), (10, 290)] {
        let image_size = 16;
        let max_iterations = 1200;
        let frame = make_frame(
            DEEP_RE,
            DEEP_IM,
            tile_zoom,
            zoom_offset,
            image_size,
            max_iterations,
        );

        let effective_zoom = tile_zoom as i64 + zoom_offset as i64;
        let precision_bits = (effective_zoom as usize + 64).div_ceil(32) * 32;
        let origin_re = parse_decimal(DEEP_RE, precision_bits).unwrap();
        let origin_im = parse_decimal(DEEP_IM, precision_bits).unwrap();
        let center = centered_tile_coordinate(tile_zoom).floor();

        let scale = BigFloat::from_parts(IBig::from(1), -(zoom_offset as isize))
            .with_precision(precision_bits)
            .value();

        let mut exact_matches = 0;
        let samples = [
            (0, 0),
            (image_size - 1, 0),
            (0, image_size - 1),
            (7, 9),
            (12, 3),
        ];
        for &(column, row) in &samples {
            let x = center + column as f64 / (image_size - 1) as f64;
            let y = center + row as f64 / (image_size - 1) as f64;

            let re_offset = BigFloat::try_from(tile_coordinate_offset(x, tile_zoom))
                .unwrap()
                .with_precision(precision_bits)
                .value();
            let im_offset = BigFloat::try_from(tile_coordinate_offset(y, tile_zoom))
                .unwrap()
                .with_precision(precision_bits)
                .value();

            let c_re = &origin_re + re_offset * &scale;
            let c_im = &origin_im - im_offset * &scale;

            let direct_iterations = direct_escape_iterations_big(&c_re, &c_im, max_iterations);
            let (perturbed_iterations, _) = frame.escape_iterations(column, row);

            assert!(
                direct_iterations.abs_diff(perturbed_iterations) <= 5,
                "zoom offset {zoom_offset}, pixel ({column}, {row}): \
                 direct {direct_iterations} vs perturbed {perturbed_iterations}"
            );
            if direct_iterations == perturbed_iterations {
                exact_matches += 1;
            }
        }

        assert!(
            exact_matches >= samples.len() - 1,
            "zoom offset {zoom_offset}: only {exact_matches}/{} samples matched exactly",
            samples.len()
        );
    }
}

#[test]
fn perturbed_image_consistent_across_origin_shift() {
    // The same complex-plane region expressed relative to two different
    // origins must render the same image. The second origin is shifted by
    // exactly one tile width: 25 * 2^-(effective_zoom + 2).
    for (tile_zoom, zoom_offset) in [(10_i32, 140_u32), (10, 290)] {
        let effective_zoom = tile_zoom as i64 + zoom_offset as i64;
        let precision_bits = (effective_zoom as usize + 96).div_ceil(32) * 32;

        let origin_re = parse_decimal(DEEP_RE, precision_bits).unwrap();
        let tile_width = BigFloat::from_parts(IBig::from(25), -(effective_zoom + 2) as isize)
            .with_precision(precision_bits)
            .value();
        let shifted_re = (origin_re + tile_width).to_decimal().value().to_string();

        let center = centered_tile_coordinate(tile_zoom).floor();
        let image_size = 32;

        let render = |origin_re: &str, x_min: f64| {
            crate::get_mandelbrot_image_precise(
                origin_re.to_string(),
                DEEP_IM.to_string(),
                x_min,
                x_min + 1.0,
                center,
                center + 1.0,
                tile_zoom,
                zoom_offset,
                1000,
                2,
                image_size,
                image_size,
                "turbo".to_string(),
                false,
                0.0,
                0.0,
                0.0,
                crate::ValidColorSpace::Hsl,
                true,
                0,
                1000,
            )
        };

        let image_a = render(DEEP_RE, center);
        let image_b = render(&shifted_re, center - 1.0);

        assert_eq!(image_a.len(), image_b.len());
        let pixel_count = image_a.len() / 4;
        let matching_pixels = (0..pixel_count)
            .filter(|&i| image_a[i * 4..i * 4 + 4] == image_b[i * 4..i * 4 + 4])
            .count();

        assert!(
            matching_pixels as f64 / pixel_count as f64 > 0.99,
            "zoom offset {zoom_offset}: only {matching_pixels}/{pixel_count} pixels matched"
        );
    }
}

#[test]
fn deep_interior_renders_solid_black() {
    // c = 0 is deep inside the main cardioid, so a 2^-100-sized neighborhood
    // is entirely interior and must render black via the border shortcut.
    let center = centered_tile_coordinate(10).floor();
    let image = crate::get_mandelbrot_image_precise(
        "0".to_string(),
        "0".to_string(),
        center,
        center + 1.0,
        center,
        center + 1.0,
        10,
        90,
        400,
        2,
        16,
        16,
        "turbo".to_string(),
        false,
        0.0,
        0.0,
        0.0,
        crate::ValidColorSpace::Hsl,
        true,
        0,
        400,
    );

    for pixel in image.chunks(4) {
        assert_eq!(pixel, [0, 0, 0, 255]);
    }
}

#[test]
fn shallow_path_matches_legacy_renderer() {
    let tile_zoom = 5;
    let (x, y) = (12.0, 10.0);

    let precise = crate::get_mandelbrot_image_precise(
        "-0.5".to_string(),
        "0".to_string(),
        x,
        x + 1.0,
        y,
        y + 1.0,
        tile_zoom,
        0,
        200,
        2,
        32,
        32,
        "turbo".to_string(),
        false,
        0.0,
        0.0,
        0.0,
        crate::ValidColorSpace::Hsl,
        true,
        0,
        200,
    );

    let legacy = crate::get_mandelbrot_set_image(
        -0.5 + tile_coordinate_offset(x, tile_zoom),
        -0.5 + tile_coordinate_offset(x + 1.0, tile_zoom),
        -tile_coordinate_offset(y + 1.0, tile_zoom),
        -tile_coordinate_offset(y, tile_zoom),
        200,
        2,
        32,
        32,
        "turbo".to_string(),
        false,
        0.0,
        0.0,
        0.0,
        crate::ValidColorSpace::Hsl,
        true,
        0,
        200,
    );

    assert_eq!(precise, legacy);
}

#[test]
fn shallow_path_handles_zoom_offset() {
    // At shallow depths the direct f64 renderer is used even when the client
    // has re-anchored (zoom_offset > 0); the offsets must then be scaled by
    // 2^-zoom_offset.
    let tile_zoom = 12;
    let zoom_offset = 20_u32;
    let center = centered_tile_coordinate(tile_zoom).floor();

    let precise = crate::get_mandelbrot_image_precise(
        DEEP_RE.to_string(),
        DEEP_IM.to_string(),
        center,
        center + 1.0,
        center,
        center + 1.0,
        tile_zoom,
        zoom_offset,
        300,
        2,
        32,
        32,
        "turbo".to_string(),
        false,
        0.0,
        0.0,
        0.0,
        crate::ValidColorSpace::Hsl,
        true,
        0,
        300,
    );

    let origin_re: f64 = DEEP_RE.parse().unwrap();
    let origin_im: f64 = DEEP_IM.parse().unwrap();
    let scaled = |value: f64| {
        crate::float_exp::ldexp(
            tile_coordinate_offset(value, tile_zoom),
            -(zoom_offset as i64),
        )
    };

    let legacy = crate::get_mandelbrot_set_image(
        origin_re + scaled(center),
        origin_re + scaled(center + 1.0),
        origin_im - scaled(center + 1.0),
        origin_im - scaled(center),
        300,
        2,
        32,
        32,
        "turbo".to_string(),
        false,
        0.0,
        0.0,
        0.0,
        crate::ValidColorSpace::Hsl,
        true,
        0,
        300,
    );

    assert_eq!(precise, legacy);
}

#[test]
fn direct_rendering_cutoff_accounts_for_tile_resolution() {
    // One tile mapped onto `width` pixels at the client's rebased tile zoom.
    let spacing = |effective_zoom: i64, width: usize| {
        pixel_spacing(0.0, 1.0, 12, (effective_zoom - 12) as u32, width)
    };

    // Standard 200px tiles: direct through effective zoom 45 (2 ULP of
    // coordinates near magnitude 4), perturbation from 46.
    assert!(spacing(45, 200) >= MIN_DIRECT_PIXEL_SPACING);
    assert!(spacing(46, 200) < MIN_DIRECT_PIXEL_SPACING);

    // High-DPI tiles halve the pixel spacing, so the switch moves a level
    // earlier; a fixed zoom threshold would leave a blocky zone here.
    assert!(spacing(44, 400) >= MIN_DIRECT_PIXEL_SPACING);
    assert!(spacing(45, 400) < MIN_DIRECT_PIXEL_SPACING);

    // Extreme depths underflow to zero spacing, which still reads as deep.
    assert_eq!(spacing(5000, 200), 0.0);
    assert!(spacing(5000, 200) < MIN_DIRECT_PIXEL_SPACING);
}

#[test]
fn parse_decimal_accepts_long_and_scientific_input() {
    assert!(parse_decimal(DEEP_RE, 512).is_ok());
    assert!(parse_decimal("1.5e-200", 256).is_ok());
    assert!(parse_decimal("-2", 64).is_ok());
    assert!(parse_decimal("not a number", 64).is_err());
}

// ---------------------------------------------------------------------------
// Perf-experiment probes (ignored; run with
// `cargo test --release <name> -- --ignored --nocapture`). These measure
// whether iteration-skipping techniques could cut the heavy pf64 views, and
// exist so the negative verdicts in bench/LOG.md (2026-07-08, "iteration
// work at real pf64 depths is irreducible") stay reproducible. `bla_probe`:
// how much work a Zhuoran-style BLA (bivariate linear approximation) table
// skips and how far output diverges from the exact loop, per tolerance.
// `multiplier_interior_probe`: whether attracting-cycle (multiplier)
// detection could retire interior pixels without falsely retiring escapers.
// ---------------------------------------------------------------------------

struct ProbeView {
    id: &'static str,
    re: &'static str,
    im: &'static str,
    zoom: i32,
    iterations: u32,
    exponent: u32,
}

const PROBE_TILE_SIZE: usize = 100;

const PROBE_VIEWS: &[ProbeView] = &[
    ProbeView {
        id: "fb5f0315 trapped-needle i50k",
        re: "-1.7723767931915395",
        im: "0.00439357468238466",
        zoom: 47,
        iterations: 50000,
        exponent: 2,
    },
    ProbeView {
        id: "0a309fb2 cusp-channel i48k",
        re: "0.2500612710671293",
        im: "-7.752127428872768e-7",
        zoom: 48,
        iterations: 48000,
        exponent: 2,
    },
    ProbeView {
        id: "f36112fd border-band i50k",
        re: "-1.1883354848761543",
        im: "0.30460678136290387",
        zoom: 48,
        iterations: 50000,
        exponent: 2,
    },
    ProbeView {
        id: "d0e211ec trapped i32k",
        re: "-1.4739395392171728",
        im: "0.0007618796514439197",
        zoom: 48,
        iterations: 32768,
        exponent: 2,
    },
    ProbeView {
        id: "953fa585 interior i25k",
        re: "0.2500041326416138",
        im: "1.3249754182709239e-8",
        zoom: 47,
        iterations: 25600,
        exponent: 2,
    },
    ProbeView {
        id: "dc40277a border i16k",
        re: "-1.3778495543648615",
        im: "0.014769422435958912",
        zoom: 48,
        iterations: 16000,
        exponent: 2,
    },
    ProbeView {
        id: "0611aae8 e52 i46k",
        re: "-0.561760682385648",
        im: "-0.7341970302369814",
        zoom: 48,
        iterations: 45999,
        exponent: 52,
    },
];

fn probe_frame(view: &ProbeView) -> PerturbedFrame {
    // Mirrors bench/src/normalize.mjs: the client rebases Leaflet at zoom 12
    // and accumulates the rest in zoom_offset; the origin tile has coordinate
    // floor(0.64 * 2^tile_zoom).
    let zoom_offset = (view.zoom - 12).max(0) as u32;
    let tile_zoom = view.zoom - zoom_offset as i32;
    let v = (0.64 * f64::powi(2.0, tile_zoom)).floor();
    PerturbedFrame::new(
        view.re,
        view.im,
        v,
        v + 1.0,
        v,
        v + 1.0,
        tile_zoom,
        zoom_offset,
        PROBE_TILE_SIZE,
        PROBE_TILE_SIZE,
        view.iterations,
        view.exponent,
        3.0,
    )
    .unwrap()
}

/// Copy of `perturbed_escape_iterations_f64` with an advance counter.
fn exact_escape_counted(
    orbit: &[(f64, f64)],
    dc: Complex64,
    max_iterations: u32,
    exponent: u32,
    escape_radius_squared: f64,
    advances: &mut u64,
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
        if *reference_index == last_index || z.norm_sqr() < dz.norm_sqr() {
            *dz = *z;
            *reference_index = 0;
        }
    };

    advance(&mut reference_index, &mut dz, &mut z);
    *advances += 1;

    let mut saved_dz = dz;
    let mut saved_index = reference_index;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    let mut iterations = 0;
    while z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        advance(&mut reference_index, &mut dz, &mut z);
        *advances += 1;
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

struct BlaEntry {
    a: Complex64,
    b: Complex64,
    r2: f64,
}

/// `levels[l][j]` approximates 2^l perturbation steps starting at orbit
/// index `j * 2^l`: dz -> A*dz + B*dc, valid while |dz| < r.
struct BlaTable {
    levels: Vec<Vec<BlaEntry>>,
}

fn build_bla_table(orbit: &[(f64, f64)], exponent: u32, dc_max: f64, epsilon: f64) -> BlaTable {
    let last = orbit.len() - 1;
    let mut level0 = Vec::with_capacity(last);
    for value in orbit.iter().take(last) {
        let z = Complex64::new(value.0, value.1);
        let (a, r) = if exponent == 2 {
            let a = z * 2.0;
            // Dropped term is dz^2; |dz^2| <= eps*|A dz| iff |dz| <= eps*|A|.
            (a, epsilon * a.norm())
        } else {
            let mut z_power = Complex64::new(1.0, 0.0);
            for _ in 0..exponent - 1 {
                z_power *= z;
            }
            let a = z_power * exponent as f64;
            // Leading dropped term is C(e,2) Z^(e-2) dz^2; relative to the
            // linear term it is ((e-1)/2)|dz|/|Z|.
            (a, 2.0 * epsilon * z.norm() / (exponent - 1) as f64)
        };
        let ok = a.re.is_finite() && a.im.is_finite() && r.is_finite();
        level0.push(BlaEntry {
            a,
            b: Complex64::new(1.0, 0.0),
            r2: if ok { r * r } else { 0.0 },
        });
    }

    let mut levels = vec![level0];
    while levels.last().unwrap().len() >= 2 {
        let prev = levels.last().unwrap();
        let mut next = Vec::with_capacity(prev.len() / 2);
        for j in 0..prev.len() / 2 {
            let x = &prev[2 * j];
            let y = &prev[2 * j + 1];
            let a = y.a * x.a;
            let b = y.a * x.b + y.b;
            // Valid when |dz| fits x's radius and the mid-skip delta
            // |A1 dz + B1 dc| fits y's radius for any tile dc.
            let r =
                x.r2.sqrt()
                    .min(((y.r2.sqrt() - x.b.norm() * dc_max) / x.a.norm()).max(0.0));
            let ok = a.re.is_finite()
                && a.im.is_finite()
                && b.re.is_finite()
                && b.im.is_finite()
                && r.is_finite();
            next.push(BlaEntry {
                a,
                b,
                r2: if ok { r * r } else { 0.0 },
            });
        }
        levels.push(next);
    }
    BlaTable { levels }
}

const MIN_SKIP_LEVEL: usize = 1;

#[allow(clippy::too_many_arguments)]
fn bla_escape_counted(
    orbit: &[(f64, f64)],
    table: &BlaTable,
    dc: Complex64,
    max_iterations: u32,
    exponent: u32,
    escape_radius_squared: f64,
    advances: &mut u64,
    skipped_iterations: &mut u64,
) -> (u32, Complex64) {
    let last_index = orbit.len() - 1;
    let mut index: usize;
    let mut dz = Complex64::new(0.0, 0.0);
    let mut z: Complex64;

    // Un-counted pre-step, identical to the exact loop.
    {
        let z_ref = orbit[0];
        dz = delta_step_f64(Complex64::new(z_ref.0, z_ref.1), dz, exponent) + dc;
        index = 1;
        z = Complex64::new(orbit[index].0 + dz.re, orbit[index].1 + dz.im);
        if index == last_index || z.norm_sqr() < dz.norm_sqr() {
            dz = z;
            index = 0;
        }
        *advances += 1;
    }

    let mut saved_dz = dz;
    let mut saved_index = index;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    let mut iterations = 0u32;
    while z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        // Try the largest valid BLA skip aligned at this orbit index.
        let mut applied = false;
        if index > 0 {
            let dz_norm_sqr = dz.norm_sqr();
            let remaining = (max_iterations - iterations) as usize;
            let mut level = (index.trailing_zeros() as usize).min(table.levels.len() - 1);
            while level >= MIN_SKIP_LEVEL {
                let step = 1usize << level;
                if step <= remaining {
                    if let Some(entry) = table.levels[level].get(index >> level) {
                        if dz_norm_sqr < entry.r2 {
                            dz = entry.a * dz + entry.b * dc;
                            index += step;
                            iterations += step as u32;
                            z = Complex64::new(orbit[index].0 + dz.re, orbit[index].1 + dz.im);
                            if index == last_index || z.norm_sqr() < dz.norm_sqr() {
                                dz = z;
                                index = 0;
                            }
                            *advances += 1;
                            *skipped_iterations += step as u64;
                            applied = true;
                            break;
                        }
                    }
                }
                level -= 1;
            }
        }
        if applied {
            continue;
        }

        let z_ref = orbit[index];
        dz = delta_step_f64(Complex64::new(z_ref.0, z_ref.1), dz, exponent) + dc;
        index += 1;
        z = Complex64::new(orbit[index].0 + dz.re, orbit[index].1 + dz.im);
        if index == last_index || z.norm_sqr() < dz.norm_sqr() {
            dz = z;
            index = 0;
        }
        iterations += 1;
        *advances += 1;

        if iterations % PERIODICITY_CHECK_STRIDE == 0 {
            if dz == saved_dz && index == saved_index {
                return (max_iterations, z);
            }
            if iterations >= next_save {
                saved_dz = dz;
                saved_index = index;
                next_save = next_save.saturating_mul(2);
            }
        }
    }

    (iterations, z)
}

#[test]
#[ignore = "perf-experiment probe, not a correctness test"]
fn bla_probe() {
    for view in PROBE_VIEWS {
        let frame = probe_frame(view);
        let orbit = &frame.orbit.values;
        let size = PROBE_TILE_SIZE;

        let corner_dc_max = [(0, 0), (size - 1, 0), (0, size - 1), (size - 1, size - 1)]
            .iter()
            .map(|&(c, r)| frame.pixel_dc_f64(c, r).norm())
            .fold(0.0_f64, f64::max)
            * 1.001;

        // Exact pass.
        let start = std::time::Instant::now();
        let mut exact_advances = 0u64;
        let mut exact_results = Vec::with_capacity(size * size);
        for row in 0..size {
            for column in 0..size {
                let dc = frame.pixel_dc_f64(column, row);
                exact_results.push(exact_escape_counted(
                    orbit,
                    dc,
                    view.iterations,
                    view.exponent,
                    9.0,
                    &mut exact_advances,
                ));
            }
        }
        let exact_ms = start.elapsed().as_secs_f64() * 1e3;
        println!(
            "\n=== {} (orbit len {}, dc_max {:.3e}) ===\n  exact: {} advances, {:.0} ms",
            view.id,
            orbit.len(),
            corner_dc_max,
            exact_advances,
            exact_ms
        );

        for eps_bits in [16i32, 24, 32, 40] {
            let epsilon = f64::powi(2.0, -eps_bits);
            let build_start = std::time::Instant::now();
            let table = build_bla_table(orbit, view.exponent, corner_dc_max, epsilon);
            let build_ms = build_start.elapsed().as_secs_f64() * 1e3;

            let start = std::time::Instant::now();
            let mut bla_advances = 0u64;
            let mut skipped = 0u64;
            let mut iter_diffs = 0usize;
            let mut max_iter_diff = 0u32;
            let mut max_z_rel = 0.0_f64;
            for row in 0..size {
                for column in 0..size {
                    let dc = frame.pixel_dc_f64(column, row);
                    let (iterations, z) = bla_escape_counted(
                        orbit,
                        &table,
                        dc,
                        view.iterations,
                        view.exponent,
                        9.0,
                        &mut bla_advances,
                        &mut skipped,
                    );
                    let (exact_iterations, exact_z) = exact_results[row * size + column];
                    if iterations != exact_iterations {
                        iter_diffs += 1;
                        max_iter_diff = max_iter_diff.max(iterations.abs_diff(exact_iterations));
                    } else if iterations < view.iterations {
                        let denominator = exact_z.norm().max(1e-300);
                        max_z_rel = max_z_rel.max((z - exact_z).norm() / denominator);
                    }
                }
            }
            let bla_ms = start.elapsed().as_secs_f64() * 1e3;
            println!(
                "  eps 2^-{eps_bits}: advances {bla_advances} ({:.1}% of exact), skipped {:.1}% of iters, \
                 time {:.0} ms ({:.2}x, build {:.0} ms), iter-diff pixels {iter_diffs} (max {max_iter_diff}), max z rel err {max_z_rel:.2e}",
                100.0 * bla_advances as f64 / exact_advances as f64,
                100.0 * skipped as f64 / (skipped + bla_advances) as f64,
                bla_ms,
                exact_ms / bla_ms.max(0.001),
                build_ms,
            );
        }
    }
}

/// Second probe: attracting-cycle (multiplier) interior detection. Runs the
/// exact loop unchanged, but additionally simulates a detector: on an
/// approximate return `|z - saved_z| < delta`, compute the multiplier
/// `prod(2z)` over the candidate period; if |m| < margin the pixel would be
/// retired as interior at that point. Records the retire iteration without
/// changing the loop, so we can compare against the pixel's true outcome.
#[allow(clippy::too_many_arguments)]
fn exact_escape_with_multiplier_probe(
    orbit: &[(f64, f64)],
    dc: Complex64,
    max_iterations: u32,
    escape_radius_squared: f64,
    delta_squared: f64,
    margin_norm_sqr: f64,
    multiplier_steps: &mut u64,
) -> (u32, Option<u32>) {
    let last_index = orbit.len() - 1;
    let mut reference_index: usize = 0;
    let mut dz = Complex64::new(0.0, 0.0);
    let mut z = Complex64::new(0.0, 0.0);

    let advance = |reference_index: &mut usize, dz: &mut Complex64, z: &mut Complex64| {
        let z_ref = orbit[*reference_index];
        *dz = delta_step_f64(Complex64::new(z_ref.0, z_ref.1), *dz, 2) + dc;
        *reference_index += 1;
        let z_ref_next = orbit[*reference_index];
        *z = Complex64::new(z_ref_next.0 + dz.re, z_ref_next.1 + dz.im);
        if *reference_index == last_index || z.norm_sqr() < dz.norm_sqr() {
            *dz = *z;
            *reference_index = 0;
        }
    };

    advance(&mut reference_index, &mut dz, &mut z);

    let mut saved_z = z;
    let mut saved_iteration = 0u32;
    let mut next_save = PERIODICITY_FIRST_SAVE;

    // Multiplier phase state: while `phase_left > 0` we are accumulating the
    // product of 2z over the candidate period.
    let mut phase_left = 0u32;
    let mut multiplier = Complex64::new(1.0, 0.0);
    let mut retire_at: Option<u32> = None;

    let mut iterations = 0;
    while z.norm_sqr() < escape_radius_squared && iterations < max_iterations {
        advance(&mut reference_index, &mut dz, &mut z);
        iterations += 1;

        if retire_at.is_none() {
            if phase_left > 0 {
                multiplier *= z * 2.0;
                *multiplier_steps += 1;
                phase_left -= 1;
                if phase_left == 0 {
                    let m = multiplier.norm_sqr();
                    if m.is_finite() && m < margin_norm_sqr {
                        retire_at = Some(iterations);
                    }
                }
            } else if iterations % PERIODICITY_CHECK_STRIDE == 0 {
                let dist = (z - saved_z).norm_sqr();
                if dist < delta_squared && iterations > saved_iteration {
                    phase_left = iterations - saved_iteration;
                    multiplier = Complex64::new(1.0, 0.0);
                }
            }
        }

        if iterations == next_save {
            saved_z = z;
            saved_iteration = iterations;
            next_save = next_save.saturating_mul(2);
        }
    }

    (iterations, retire_at)
}

#[test]
#[ignore = "perf-experiment probe, not a correctness test"]
fn multiplier_interior_probe() {
    for view in PROBE_VIEWS.iter().filter(|v| v.exponent == 2) {
        let frame = probe_frame(view);
        let orbit = &frame.orbit.values;
        let size = PROBE_TILE_SIZE;
        println!("\n=== {} ===", view.id);

        for (delta, margin) in [(1e-6, 0.9), (1e-9, 0.9), (1e-6, 0.99)] {
            let mut total_budget_work = 0u64;
            let mut saved_work = 0u64;
            let mut multiplier_steps = 0u64;
            let mut interior_pixels = 0usize;
            let mut retired_pixels = 0usize;
            let mut false_retires = 0usize;
            let mut escaper_work = 0u64;

            let start = std::time::Instant::now();
            for row in 0..size {
                for column in 0..size {
                    let dc = frame.pixel_dc_f64(column, row);
                    let (iterations, retire_at) = exact_escape_with_multiplier_probe(
                        orbit,
                        dc,
                        view.iterations,
                        9.0,
                        delta * delta,
                        margin * margin,
                        &mut multiplier_steps,
                    );
                    if iterations >= view.iterations {
                        interior_pixels += 1;
                        total_budget_work += u64::from(view.iterations);
                        if let Some(retire) = retire_at {
                            retired_pixels += 1;
                            saved_work += u64::from(view.iterations - retire);
                        }
                    } else {
                        escaper_work += u64::from(iterations);
                        if let Some(retire) = retire_at {
                            if retire < iterations {
                                false_retires += 1;
                            }
                        }
                    }
                }
            }
            let ms = start.elapsed().as_secs_f64() * 1e3;
            let total_work = total_budget_work + escaper_work;
            println!(
                "  delta {delta:.0e} margin {margin}: retired {retired_pixels}/{interior_pixels} interior px, \
                 saved {:.1}% of interior work ({:.1}% of ALL work), mult-phase steps {:.2}% of work, \
                 FALSE RETIRES {false_retires}, probe time {ms:.0} ms",
                100.0 * saved_work as f64 / total_budget_work.max(1) as f64,
                100.0 * saved_work as f64 / total_work.max(1) as f64,
                100.0 * multiplier_steps as f64 / total_work.max(1) as f64,
            );
        }
    }
}

#[test]
fn deep_zoom_image_is_not_degenerate() {
    // A window straddling the needle tip at c = -2 contains set members
    // (re >= -2 on the real axis) and escaping points (re < -2) at any zoom
    // depth, so the image must contain more than one color. Plain f64 would
    // produce a constant or blocky image here.
    let center = centered_tile_coordinate(10).floor();
    let image = crate::get_mandelbrot_image_precise(
        "-2".to_string(),
        "0".to_string(),
        center,
        center + 1.0,
        center,
        center + 1.0,
        10,
        140,
        3000,
        2,
        32,
        32,
        "turbo".to_string(),
        false,
        0.0,
        0.0,
        0.0,
        crate::ValidColorSpace::Hsl,
        true,
        0,
        3000,
    );

    let mut colors: std::collections::HashSet<&[u8]> = std::collections::HashSet::new();
    for pixel in image.chunks(4) {
        colors.insert(pixel);
    }
    assert!(colors.len() > 1, "deep zoom image is a single flat color");
}
