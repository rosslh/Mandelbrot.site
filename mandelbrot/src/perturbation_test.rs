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

// ---------------------------------------------------------------------------
// Orbit budget clamp (2026-07-20): at budgets past MAX_ORBIT_LENGTH the
// kernels stop — post-wrap results are provably noise. The probes below are
// the evidence; the regression test pins the shipped semantics.
// ---------------------------------------------------------------------------

/// Nucleus of a period-71,856 minibrot (size estimate ~1.3e-26, true
/// cardioid half-width ~2e-29) in the seahorse valley, found by Newton's
/// method. Verified interior against exact 320-bit arithmetic on 2026-07-19:
/// the plain f64 kernel under a 50M budget reported escape at iteration
/// 1,039,019 while the exact orbit's |z|^2 never exceeded 1.06.
const CLAMP_NUCLEUS_RE: &str = "-0.743643887037158529124262633840590589474343670625260499495284935007669060714154485652591430661801";
const CLAMP_NUCLEUS_IM: &str = "0.131825904205312534027373980876551122510476781672307528630636070697923286940995281450093585415491";

/// Frame centered on the nucleus at zoom 88, sized so the pixel grid lands
/// exactly on the nucleus: with 101 pixels per side the tile-space offsets
/// make pixel (44, 44) have dc == 0 (asserted in the test, not assumed).
fn clamp_probe_frame(max_iterations: u32) -> PerturbedFrame {
    let zoom = 88;
    let zoom_offset = (zoom - 12).max(0) as u32;
    let tile_zoom = zoom - zoom_offset as i32;
    let v = (0.64 * f64::powi(2.0, tile_zoom)).floor();
    PerturbedFrame::new(
        CLAMP_NUCLEUS_RE,
        CLAMP_NUCLEUS_IM,
        v,
        v + 1.0,
        v,
        v + 1.0,
        tile_zoom,
        zoom_offset,
        101,
        101,
        max_iterations,
        2,
        3.0,
    )
    .unwrap()
}

#[test]
fn orbit_clamp_deep_minibrot_interior() {
    let max_iterations = 50_002_400;
    let frame = clamp_probe_frame(max_iterations);
    assert!(frame.kernel_budget() < max_iterations, "clamp must engage");
    assert_eq!(frame.kernel_budget(), MAX_ORBIT_LENGTH as u32);

    // Locate the pixel whose delta is exactly the nucleus.
    let column = (-frame.first_column_offset / frame.column_step).round() as usize;
    let row = (-frame.first_row_offset / frame.row_step).round() as usize;
    let dc = frame.pixel_dc_f64(column, row);
    assert!(
        dc.norm_sqr() < 1e-60,
        "expected a pixel on the nucleus, got dc {dc:?} at ({column}, {row})"
    );

    // The superstable nucleus is provably interior at any budget: its exact
    // orbit returns to 0 every 71,856 iterations forever. Under the clamp it
    // survives the kernel budget and must report the caller's budget.
    let (iterations, _) = frame.escape_iterations(column, row);
    assert_eq!(
        iterations, max_iterations,
        "nucleus pixel must classify interior under the orbit budget clamp"
    );

    // Document the failure mode the clamp exists for: driven past the stored
    // orbit, the plain kernel corrupts the delta at the end-of-orbit rebase
    // and reports a spurious finite escape shortly after the wrap. If this
    // ever classifies interior instead (e.g. higher-precision deltas), the
    // clamp deserves re-evaluation.
    let (unclamped_iterations, _) = perturbed_escape_iterations_f64(
        &frame.orbit.values,
        dc,
        max_iterations,
        2,
        frame.escape_radius_squared,
    );
    assert!(
        unclamped_iterations > MAX_ORBIT_LENGTH as u32 && unclamped_iterations < max_iterations,
        "expected the unclamped kernel's spurious post-wrap escape, got {unclamped_iterations}"
    );

    // Pixels that resolve within the orbit are untouched by the clamp:
    // border pixels report exactly what the unclamped kernel reports.
    for (column, row) in [(0, 0), (100, 0), (0, 100), (100, 100), (50, 0), (0, 50)] {
        let dc = frame.pixel_dc_f64(column, row);
        let reported = frame.escape_iterations(column, row);
        let unclamped = perturbed_escape_iterations_f64(
            &frame.orbit.values,
            dc,
            max_iterations,
            2,
            frame.escape_radius_squared,
        );
        assert!(
            reported.0 < MAX_ORBIT_LENGTH as u32,
            "border pixel ({column}, {row}) unexpectedly slow: {} iterations",
            reported.0
        );
        assert_eq!(
            reported, unclamped,
            "clamp changed a sub-orbit-length result at ({column}, {row})"
        );
    }
}

/// Post-wrap counts carry no information — the evidence for the clamp.
/// Exact 320-bit iteration vs the unclamped kernel near the component
/// boundary (dc = numerator * 2^-100, exact in f64 and bigfloat): every
/// pixel whose exact count exceeds the orbit length collapses onto one
/// corrupted trajectory and reports the same bogus finite count (1,039,019
/// at this precision), whether its true count is 1.2M, 9M, or
/// interior-forever. Pre-wrap counts match exact (or deviate by
/// rounding-class amounts near the boundary).
///
/// 2026-07-20 output:
///   t 0.50000: exact  329509            unclamped  329509
///   t 0.25000: exact  407860            unclamped  407831
///   t 0.12500: exact  647799            unclamped  647799
///   t 0.06250: exact 9002400 (interior) unclamped 1039019
///   t 0.09375: exact 1146721            unclamped 1039019
///   t 0.08984: exact 1218597            unclamped 1039019
///   t 0.09766: exact 1325406            unclamped 1039019
#[test]
#[ignore = "oracle probe (minutes of bigfloat work), not a correctness test"]
fn orbit_clamp_post_wrap_trust_probe() {
    let cap = 9_002_400u32;
    let frame = clamp_probe_frame(cap);
    let nucleus_re = parse_decimal(CLAMP_NUCLEUS_RE, 320).unwrap();
    let nucleus_im = parse_decimal(CLAMP_NUCLEUS_IM, 320).unwrap();

    let probe = |numerator: i64| {
        let dc = Complex64::new(numerator as f64 * f64::powi(2.0, -100), 0.0);
        let offset = BigFloat::from_parts(IBig::from(numerator), -100)
            .with_precision(320)
            .value();
        let c_re = &nucleus_re + offset;
        let exact = direct_escape_iterations_big(&c_re, &nucleus_im, cap);
        let unclamped = perturbed_escape_iterations_f64(
            &frame.orbit.values,
            dc,
            cap,
            2,
            frame.escape_radius_squared,
        );
        println!(
            "t {:>8.5}: exact {exact:>9}{}  unclamped {:>9}{}",
            numerator as f64 / 256.0,
            if exact >= cap { " (interior)" } else { "" },
            unclamped.0,
            if unclamped.0 >= cap {
                " (interior)"
            } else {
                ""
            },
        );
        (exact, unclamped.0)
    };

    let mut in_band = false;
    let (mut lo, mut hi) = (0i64, 256i64);
    for _ in 0..12 {
        let mid = (lo + hi) / 2;
        let (exact, unclamped) = probe(mid);
        if (exact as usize) > MAX_ORBIT_LENGTH && exact < cap {
            in_band = true;
            assert_ne!(
                exact, unclamped,
                "post-wrap kernel count unexpectedly matches exact; \
                 re-evaluate the clamp (see kernel_budget docs)"
            );
            probe(mid - 1);
            probe(mid + 1);
            break;
        }
        if exact >= cap {
            lo = mid;
        } else {
            hi = mid;
        }
        if hi - lo <= 1 {
            break;
        }
    }
    assert!(in_band, "bisection never landed in the 1M..cap band");
}

/// Attracting-cycle (multiplier) interior detection, re-probed at wrap
/// depths and re-refuted — the 2026-07-08 settled negative holds here too,
/// via a different failure path: embedded-island corridors. Near this
/// minibrot every orbit shadows its period-998 host island; an
/// approximate-return hunt (|z - saved_z| < 1e-9, checked every iteration)
/// fires at q=998 with a one-period multiplier of |m| ~ 0.709 < 0.8 for
/// exterior dust that exact arithmetic proves escapes at ~170k-300k.
/// A stride-4 hunt cadence merely hides the corridor (998 % 4 != 0) while
/// also hiding true periods not divisible by 4. Single-period contraction
/// estimates are not evidence of an attracting cycle; corridors can
/// contract transiently for many periods. Do not re-ship detection without
/// an oracle-class verification step.
///
/// 2026-07-20 output (dc = k * 2^-92, exact escape counts on the right):
///   k  0: exact interior  detector retired (correct, by luck)
///   k  1: exact   298526  detector retired (FALSE, q=998 |m|=0.709)
///   k  2: exact   248674  detector retired (FALSE)   ... etc for all k
#[test]
#[ignore = "oracle probe documenting the refuted detector, not a correctness test"]
fn orbit_clamp_ground_truth_probe() {
    const RETURN_DISTANCE_SQ: f64 = 1e-18;
    const MULTIPLIER_MARGIN_SQ: f64 = 0.64;

    let cap = 5_002_400u32;
    let frame = clamp_probe_frame(cap);
    let nucleus_re = parse_decimal(CLAMP_NUCLEUS_RE, 320).unwrap();
    let nucleus_im = parse_decimal(CLAMP_NUCLEUS_IM, 320).unwrap();
    let orbit = &frame.orbit.values;

    // The refuted detector, inlined: unclamped loop + every-iteration
    // approximate-return hunt + one-period multiplier acceptance.
    let detect = |dc: Complex64| -> (u32, bool, Option<(u32, f64)>) {
        let last_index = orbit.len() - 1;
        let mut reference_index: usize = 0;
        let mut dz = Complex64::new(0.0, 0.0);
        let mut z = Complex64::new(0.0, 0.0);
        let mut wrapped = false;

        let advance = |reference_index: &mut usize,
                       dz: &mut Complex64,
                       z: &mut Complex64,
                       wrapped: &mut bool| {
            let z_ref = orbit[*reference_index];
            *dz = delta_step_f64(Complex64::new(z_ref.0, z_ref.1), *dz, 2) + dc;
            *reference_index += 1;
            let z_ref_next = orbit[*reference_index];
            *z = Complex64::new(z_ref_next.0 + dz.re, z_ref_next.1 + dz.im);
            if *reference_index == last_index || z.norm_sqr() < dz.norm_sqr() {
                if *reference_index == last_index {
                    *wrapped = true;
                }
                *dz = *z;
                *reference_index = 0;
            }
        };

        advance(&mut reference_index, &mut dz, &mut z, &mut wrapped);
        let mut saved_z = z;
        let mut saved_iteration = 0u32;
        let mut next_save = PERIODICITY_FIRST_SAVE;
        let mut phase_left = 0u32;
        let mut candidate_q = 0u32;
        let mut multiplier = Complex64::new(1.0, 0.0);

        let mut iterations = 0;
        while z.norm_sqr() < frame.escape_radius_squared && iterations < cap {
            advance(&mut reference_index, &mut dz, &mut z, &mut wrapped);
            iterations += 1;

            if phase_left > 0 && !wrapped {
                multiplier *= z * 2.0;
                phase_left -= 1;
                if phase_left == 0 {
                    let m = multiplier.norm_sqr();
                    if m.is_finite() && m < MULTIPLIER_MARGIN_SQ {
                        return (cap, true, Some((candidate_q, m.sqrt())));
                    }
                }
            } else if !wrapped && iterations > saved_iteration {
                let d = (z - saved_z).norm_sqr();
                if d < RETURN_DISTANCE_SQ {
                    candidate_q = iterations - saved_iteration;
                    phase_left = candidate_q;
                    multiplier = Complex64::new(1.0, 0.0);
                }
            }
            if iterations % PERIODICITY_CHECK_STRIDE == 0 && iterations == next_save {
                saved_z = z;
                saved_iteration = iterations;
                next_save = next_save.saturating_mul(2);
            }
        }
        (iterations, false, None)
    };

    let mut false_retires = 0usize;
    for k in [0i64, 1, 2, 4, 8, 16, 32, 56] {
        let dc = Complex64::new(k as f64 * f64::powi(2.0, -92), 0.0);
        let offset = BigFloat::from_parts(IBig::from(k), -92)
            .with_precision(320)
            .value();
        let c_re = &nucleus_re + offset;
        let exact = direct_escape_iterations_big(&c_re, &nucleus_im, cap);
        let (iterations, retired, evidence) = detect(dc);
        let falsely = retired && exact < cap;
        false_retires += falsely as usize;
        println!(
            "k {k:3}: exact {exact:>9}{}  detector {iterations:>9}{}{}  {evidence:?}",
            if exact >= cap { " (interior)" } else { "" },
            if retired { " (retired)" } else { "" },
            if falsely { " FALSE" } else { "" },
        );
    }
    assert!(
        false_retires > 0,
        "detector no longer false-retires here; if deliberately re-shipping \
         detection, pair it with an oracle-class verification step"
    );
}

// ---------------------------------------------------------------------------
// Published deep-zoom coordinates (2026-07-27): end-to-end coverage for
// well-known, externally verified zoom targets, from decimal-string parsing
// through tier selection to the rendered tile. Every expected iteration count
// below was pinned independently with mpmath at generous precision (escape
// radius 3, matching ESCAPE_RADIUS) before being asserted here, so these
// tests detect digit-loss anywhere in the pipeline, not just self-consistency.
// ---------------------------------------------------------------------------

/// Seahorse valley center of Wikimedia's "Mandelbrot sequence new" zoom
/// (Zom-B), published magnification 3.18e31 -> effective zoom 108. The center
/// stays bounded for >=500k iterations; the surrounding tile pixels escape
/// between ~56k and ~67k.
const SEAHORSE_E31_RE: &str = "-0.743643887037158704752191506114774";
const SEAHORSE_E31_IM: &str = "0.131825904205311970493132056385139";
const SEAHORSE_E31_ZOOM: i32 = 108;

/// "Hardest Mandelbrot zoom 2017" (Kalles Fraktaler), published magnification
/// 3.187e99 -> effective zoom 334. The published render needed ~750M
/// iterations, far past MAX_ORBIT_LENGTH, so at practical budgets every pixel
/// in the view is still bounded and the tile must come back clean solid
/// black via the border-in-set shortcut. The `...999999995` tails are KF's
/// decimal rounding as published, not corruption.
const HARDEST_2017_E99_RE: &str = "-1.74995768370609350360221450607069970727110579726252077930242837820286008082972804887218672784431700831100544507655659531379747541999999995";
const HARDEST_2017_E99_IM: &str = "0.00000000000000000278793706563379402178294753790944364927085054500163081379043930650189386849765202169477470552201325772332454726999999995";
const HARDEST_2017_E99_ZOOM: i32 = 334;

/// Orson Wang's "Fractal Journey Ultra Zoom #5" center as circulated (286/285
/// digits), published magnification 2.07e275 -> effective zoom 918. As
/// circulated the coordinate carries the truncation damage its source page
/// warns about: its true distance to the set boundary is ~1.45e-212, so it
/// escapes at iteration 9944 and is only a *structured* zoom target down to
/// roughly zoom 707. It still exercises 286-digit parsing and float-exp
/// rendering at zoom 918, where the whole view escapes uniformly at ~9944.
const ULTRA5_E275_RE: &str = "-1.740062382579339905220844167065825638296641720436171866879862418461182919644153056054840718339483225743450008259172138785492983677893366503417299549623738838303346465461290768441055486136870719850559269507357211790243666940134793753068611574745943820712885258222629105433648695946003865";
const ULTRA5_E275_IM: &str = "0.0281753397792110489924115211443195096875390767429906085704013095958801743240920186385400814658560553615695084486774077000669037710191665338060418999324320867147028768983704831316527873719459264592084600433150333628593181020170329580747999667210303082150171994798478089798638258639934";
const ULTRA5_E275_ZOOM: i32 = 918;
const ULTRA5_E275_ESCAPE: u32 = 9944;

/// Misiurewicz point M(4,1), the principal branch point of the 1/3-limb,
/// computed to 140 digits by Newton's method on f_c^5(0) = f_c^4(0) (residual
/// ~1e-221; digits stable between 160- and 220-digit solves). The 140-digit
/// truncation sits ~1.1e-141 from the boundary, so it is an exact,
/// transcription-risk-free float-exp target good to roughly zoom 470.
const M41_RE: &str = "-0.1010963638456221610257854457386225654638054428262534838769311776607808407404705842748212198105167790334045319085567411939715461442609";
const M41_IM: &str = "0.9562865108091415007710960577299774358098333365105291700343143215005246590657167325269784107873398072043444724926469284366752406567465";
const M41_ZOOM: i32 = 330;

/// Renders one 32x32 tile through the public wasm-level entrypoint using the
/// client's rebase convention (leaflet zoom pinned to 12, remainder in
/// zoom_offset, origin tile floor(0.64 * 2^12) = 2621), i.e. exactly the call
/// the production worker makes for the tile containing the shared coordinate.
fn published_coordinate_tile(
    origin_re: &str,
    origin_im: &str,
    zoom: i32,
    max_iterations: u32,
) -> crate::MandelbrotTile {
    let zoom_offset = (zoom - 12).max(0) as u32;
    let tile_zoom = zoom - zoom_offset as i32;
    let v = (0.64 * f64::powi(2.0, tile_zoom)).floor();
    crate::get_mandelbrot_tile_precise(
        origin_re.to_string(),
        origin_im.to_string(),
        v,
        v + 1.0,
        v,
        v + 1.0,
        tile_zoom,
        zoom_offset,
        max_iterations,
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
        max_iterations as i32,
        true,
        None,
    )
}

/// The precision the renderer derives for a given effective zoom
/// (PerturbedFrame::new): enough bits for the zoom depth plus 64 guard bits,
/// rounded up to a 32-bit limb.
fn renderer_precision_bits(effective_zoom: i64) -> usize {
    (effective_zoom.max(0) as usize + 64).div_ceil(32) * 32
}

#[test]
fn published_coordinate_centers_match_external_escape_ground_truth() {
    // (re, im, precision bits, iteration cap, expected escape iteration;
    // expected == cap means "stays bounded through the cap"). Expectations
    // come from mpmath at >= 40 guard digits over the coordinate length.
    let cases: [(&str, &str, usize, u32, u32, &str); 4] = [
        (
            SEAHORSE_E31_RE,
            SEAHORSE_E31_IM,
            renderer_precision_bits(SEAHORSE_E31_ZOOM as i64),
            100_000,
            100_000,
            "seahorse e31",
        ),
        (
            HARDEST_2017_E99_RE,
            HARDEST_2017_E99_IM,
            renderer_precision_bits(HARDEST_2017_E99_ZOOM as i64),
            20_000,
            20_000,
            "hardest 2017 e99",
        ),
        (
            ULTRA5_E275_RE,
            ULTRA5_E275_IM,
            renderer_precision_bits(ULTRA5_E275_ZOOM as i64),
            15_000,
            ULTRA5_E275_ESCAPE,
            "ultra zoom 5 e275",
        ),
        // 512 bits (~154 digits) represents all 140 published digits, so the
        // escape iteration is pinned by the coordinate itself, not the parse.
        (M41_RE, M41_IM, 512, 5_000, 1_083, "misiurewicz M(4,1)"),
    ];

    for (re, im, precision_bits, cap, expected, name) in cases {
        let c_re = parse_decimal(re, precision_bits).unwrap();
        let c_im = parse_decimal(im, precision_bits).unwrap();
        // +-5 absorbs rounding-mode differences against the mpmath reference
        // near the escape threshold; digit loss would shift counts by far
        // more (the 250-digit truncation of the e275 coordinate, for
        // instance, moves its behavior by orders of magnitude at depth).
        let iterations = direct_escape_iterations_big(&c_re, &c_im, cap);
        assert!(
            iterations.abs_diff(expected) <= 5,
            "{name}: expected escape at {expected} (cap {cap}), got {iterations}"
        );
    }
}

#[test]
fn seahorse_e31_tile_renders_boundary_structure_at_published_depth() {
    let max_iterations = 100_000;
    let tile = published_coordinate_tile(
        SEAHORSE_E31_RE,
        SEAHORSE_E31_IM,
        SEAHORSE_E31_ZOOM,
        max_iterations,
    );

    assert_eq!(tile.tier, crate::RenderTier::Perturbation as u8);
    // Externally probed grid pixels escape between ~56.8k (corner 31,31) and
    // ~66.1k (corner 0,0), while the center region stays bounded: the tile
    // must show a wide escape band around a bounded interior.
    assert!(
        (40_000..=66_200).contains(&tile.min_iter),
        "min_iter {} outside the externally verified band",
        tile.min_iter
    );
    assert!(
        tile.max_iter >= 66_117,
        "max_iter {} lost the slow corner",
        tile.max_iter
    );
    assert!(tile.max_iter < max_iterations as i32);
    assert!(
        tile.values.iter().any(|v| v.is_infinite()),
        "the bounded center region must survive 100k iterations"
    );
    let distinct_colors: std::collections::HashSet<&[u8]> = tile.image.chunks(4).collect();
    assert!(
        distinct_colors.len() > 4,
        "expected visible structure, got {} distinct colors",
        distinct_colors.len()
    );
}

#[test]
fn hardest_2017_e99_tile_renders_clean_interior_at_published_depth() {
    let max_iterations = 2_000;
    let tile = published_coordinate_tile(
        HARDEST_2017_E99_RE,
        HARDEST_2017_E99_IM,
        HARDEST_2017_E99_ZOOM,
        max_iterations,
    );

    assert_eq!(tile.tier, crate::RenderTier::FloatExp as u8);
    // Every pixel is still bounded at this budget (the published render used
    // ~750M iterations): a clean solid-black interior tile, not noise.
    assert_eq!(tile.min_iter, -1, "no pixel may escape at this budget");
    assert_eq!(tile.max_iter, -1);
    assert_eq!(tile.image, crate::create_solid_black_image(32, 32));
    assert!(tile.values.iter().all(|v| v.is_infinite()));
}

#[test]
fn ultra5_e275_tile_renders_uniform_escape_at_published_depth() {
    let max_iterations = 15_000;
    let tile = published_coordinate_tile(
        ULTRA5_E275_RE,
        ULTRA5_E275_IM,
        ULTRA5_E275_ZOOM,
        max_iterations,
    );

    assert_eq!(tile.tier, crate::RenderTier::FloatExp as u8);
    // The whole 1.9e-275-wide view sits ~1.45e-212 from the boundary, so
    // every pixel escapes together at ~9944; digit loss anywhere in the
    // 286-digit pipeline would move this band.
    assert!(
        (9_900..=10_000).contains(&tile.min_iter),
        "min_iter {} outside the externally verified escape band",
        tile.min_iter
    );
    assert!(
        (9_900..=10_000).contains(&tile.max_iter),
        "max_iter {} outside the externally verified escape band",
        tile.max_iter
    );
    assert!(
        tile.values.iter().all(|v| v.is_finite()),
        "no pixel in this view may classify interior"
    );
}

#[test]
fn ultra5_e275_tile_renders_structure_at_boundary_depth() {
    // At zoom 700 the ~1.45e-212 boundary distance is inside the view again:
    // probed grid pixels escape between 9933 (corners) and 9941+ (center).
    let max_iterations = 15_000;
    let tile = published_coordinate_tile(ULTRA5_E275_RE, ULTRA5_E275_IM, 700, max_iterations);

    assert_eq!(tile.tier, crate::RenderTier::FloatExp as u8);
    assert!(
        (9_900..=9_950).contains(&tile.min_iter),
        "min_iter {} outside the externally verified band",
        tile.min_iter
    );
    assert!(
        tile.max_iter - tile.min_iter >= 5,
        "escape band collapsed: min {} max {}",
        tile.min_iter,
        tile.max_iter
    );
}

#[test]
fn misiurewicz_m41_tile_renders_structure_at_float_exp_depth() {
    let max_iterations = 5_000;
    let tile = published_coordinate_tile(M41_RE, M41_IM, M41_ZOOM, max_iterations);

    assert_eq!(tile.tier, crate::RenderTier::FloatExp as u8);
    // Probed grid pixels escape between ~800 and ~813; the Misiurewicz
    // center itself holds out to 1083.
    assert!(
        (700..=950).contains(&tile.min_iter),
        "min_iter {} outside the externally verified band",
        tile.min_iter
    );
    assert!(
        tile.max_iter - tile.min_iter >= 5,
        "escape band collapsed: min {} max {}",
        tile.min_iter,
        tile.max_iter
    );
}

#[test]
fn exact_algebraic_points_render_at_e275_depth() {
    // M(2,1) = -2 (tip of the antenna) and M(2,2) = i (tip of the 1/3-limb
    // dendrite) are exact at every depth, so they give transcription-free
    // structure at the same zoom the e275 coordinate targets. Externally
    // probed escape bands at zoom 918: 460..=466 around -2, 735..=740
    // around i.
    let max_iterations = 3_000;
    let cases = [
        ("-2", "0", 440, 480, "antenna tip -2"),
        ("0", "1", 700, 780, "dendrite tip i"),
    ];

    for (re, im, band_min, band_max, name) in cases {
        let tile = published_coordinate_tile(re, im, 918, max_iterations);
        assert_eq!(tile.tier, crate::RenderTier::FloatExp as u8, "{name}");
        assert!(
            (band_min..=band_max).contains(&tile.min_iter),
            "{name}: min_iter {} outside the externally verified band",
            tile.min_iter
        );
        assert!(
            tile.max_iter - tile.min_iter >= 3,
            "{name}: escape band collapsed: min {} max {}",
            tile.min_iter,
            tile.max_iter
        );
        assert!(tile.max_iter < max_iterations as i32, "{name}");
    }
}

/// Misiurewicz point M(22,1) in seahorse valley (preperiod 22 from z=0,
/// period-1 landing fixed point, multiplier magnitude ~3.03), computed to
/// 1012 digits by Newton's method (residual ~2.4e-1099, digits stable
/// between 1100- and 1250-digit solves). The strongly repelling multiplier
/// keeps escape times low even at magnification ~1.05e1000, making it the
/// gate's cheapest source of real structure at four-digit zoom levels.
const M221_RE: &str = "-0.7746724469356738080461171765322245435665009634996757196925763115299425962283014864589690183581885748430138088165308986575760739845395374554399750678253210153068529322781239209519866648355959030654665668885974698821086557325734881760549966896235238992147272519073915254995423260399092985392885028164560281456137789832760566539485756443905422916318129749558197019114973491544402817366831463152707114483207872350094279731748948355835313597996205669690322396885813558657365936640529599746967422516427768350808850454571018237002924648253236998316887820440065542321741884933579969951685202979437222980810534468765940226330539387169085343276454881175352871706298824662314831723592274165718033222008780945889336086340016394672948556228828740802511210263307137850397526048548647484994637687149379484454150799971546750159895327502905875408343040956757793038890909258427409086829699247468211946846230066458709669711282376665446081182543591777461464356205166882685391442276169161064362001910538095561088008454681907040656642";
const M221_IM: &str = "0.1374292923409168905915434640978695290073047059069381610343287435141172764888543912434490128003568538372300074143347301415302886386462782652776406279639431688988581762531208016486668033800396271990595154258886593908823013624062339571820419412904383334582087382932358676129100970544836964110528920520278972319211734254521736850911114457972726878339710387756284161552926537531826332838440390004350125808040372697000051132566075454255703931498471130716522817062123042972160571759776455040107017864777016818431475654388429767184484507964074928723194765419592815243406991359020824233271893283061578523843397728811595211479713457484112555593551500514831521411950009550369202959132082847423310732462755883245986254526404651573145752251034030470295148435492205184555237295507672569215417232050752846064432933152476009949143398740675874254935629921193734330086436646201718658547315710918510011613929632616758791779052527416062902617096080817587526446116719572501770039789097438199696668795685712367662446523656421483117594";

#[test]
fn misiurewicz_m221_tile_renders_structure_at_e1000_depth() {
    // Zoom 3325 is magnification ~1.05e1000; the renderer derives 3392-bit
    // precision. Externally probed pixels escape at ~2094-2098.
    let max_iterations = 5_000;
    let tile = published_coordinate_tile(M221_RE, M221_IM, 3325, max_iterations);

    assert_eq!(tile.tier, crate::RenderTier::FloatExp as u8);
    assert!(
        (2_000..=2_110).contains(&tile.min_iter),
        "min_iter {} outside the externally verified band",
        tile.min_iter
    );
    assert!(
        tile.max_iter - tile.min_iter >= 3,
        "escape band collapsed: min {} max {}",
        tile.min_iter,
        tile.max_iter
    );
    assert!(tile.max_iter < max_iterations as i32);
}
