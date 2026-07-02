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
    // Below DEEP_ZOOM_THRESHOLD the direct f64 renderer is used even when the
    // client has re-anchored (zoom_offset > 0); the offsets must then be
    // scaled by 2^-zoom_offset.
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
fn parse_decimal_accepts_long_and_scientific_input() {
    assert!(parse_decimal(DEEP_RE, 512).is_ok());
    assert!(parse_decimal("1.5e-200", 256).is_ok());
    assert!(parse_decimal("-2", 64).is_ok());
    assert!(parse_decimal("not a number", 64).is_err());
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
