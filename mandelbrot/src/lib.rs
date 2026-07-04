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
    let mut z = c;
    let mut iter = 0;

    while z.norm_sqr() < escape_radius_squared && iter < max_iterations {
        z = z * z + c;
        iter += 1;
    }

    (iter, z)
}

/// Performs the escape time algorithm for the general Mandelbrot set (exponent > 2).
///
/// # Parameters
/// - `c`: The complex number to iterate on.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `escape_radius`: The escape radius.
/// - `exponent`: The exponent used in the iteration formula.
///
/// # Returns
/// A tuple containing the number of iterations and the final complex value.
fn calculate_escape_iterations_general(
    c: Complex64,
    max_iterations: u32,
    escape_radius: f64,
    exponent: u32,
) -> (u32, Complex64) {
    let mut z = c;
    let mut iter = 0;

    while z.norm() < escape_radius && iter < max_iterations {
        z = z.powu(exponent) + c;
        iter += 1;
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

    let c_re = f64x2(c_first.re, c_second.re);
    let c_im = f64x2(c_first.im, c_second.im);
    let radius_squared = f64x2_splat(escape_radius_squared);

    let mut z_re = c_re;
    let mut z_im = c_im;
    // Alive lanes are all-ones, so subtracting the mask adds 1 per live lane.
    let mut alive = i64x2_splat(-1);
    let mut lane_iterations = i64x2_splat(0);
    let mut remaining = max_iterations;

    while remaining > 0 {
        let norm_sqr = f64x2_add(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im));
        alive = v128_and(alive, f64x2_lt(norm_sqr, radius_squared));
        if !v128_any_true(alive) {
            break;
        }

        let next_re = f64x2_add(f64x2_sub(f64x2_mul(z_re, z_re), f64x2_mul(z_im, z_im)), c_re);
        let next_im = f64x2_add(f64x2_mul(f64x2_splat(2.0), f64x2_mul(z_re, z_im)), c_im);
        z_re = v128_bitselect(next_re, z_re, alive);
        z_im = v128_bitselect(next_im, z_im, alive);
        lane_iterations = i64x2_sub(lane_iterations, alive);
        remaining -= 1;
    }

    [
        (
            i64x2_extract_lane::<0>(lane_iterations) as u32,
            Complex64::new(f64x2_extract_lane::<0>(z_re), f64x2_extract_lane::<0>(z_im)),
        ),
        (
            i64x2_extract_lane::<1>(lane_iterations) as u32,
            Complex64::new(f64x2_extract_lane::<1>(z_re), f64x2_extract_lane::<1>(z_im)),
        ),
    ]
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
        calculate_escape_iterations_general(c, max_iterations, ESCAPE_RADIUS, exponent)
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
    if !points_in_set_pair((re_min, im_min), (re_min, im_max), max_iterations, exponent)
        || !points_in_set_pair((re_max, im_min), (re_max, im_max), max_iterations, exponent)
    {
        return false;
    }

    // Check the borders of the rectangle
    for re in re_range {
        if !points_in_set_pair((re, im_min), (re, im_max), max_iterations, exponent) {
            return false;
        }
    }

    for im in im_range {
        if !points_in_set_pair((re_min, im), (re_max, im), max_iterations, exponent) {
            return false;
        }
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

/// Maps an escape-time result to a color. Shared by the direct and the
/// perturbation-based renderers.
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
    if escape_iterations == max_iterations {
        [0, 0, 0]
    } else {
        let smoothed_value = if smooth_coloring {
            static ESCAPE_RADIUS_LN: once_cell::sync::Lazy<f64> =
                once_cell::sync::Lazy::new(|| ESCAPE_RADIUS.ln());

            let exponent_ln = f64::from(exponent).ln();

            // See: https://iquilezles.org/articles/msetsmooth/
            f64::from(escape_iterations) - ((z.norm().ln() / *ESCAPE_RADIUS_LN).ln() / exponent_ln)
        } else {
            f64::from(escape_iterations)
        };

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
/// A vector of bytes representing the RGBA color values of the image.
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
) -> Vec<u8> {
    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];

    // Pre-fill the alpha channel with 255 for the entire image
    for alpha_idx in (3..output_size).step_by(NUM_COLOR_CHANNELS) {
        img[alpha_idx] = 255;
    }

    let min_iterations_threshold = f64::from(palette_min_iter);
    let max_iterations_threshold =
        f64::from(palette_max_iter).max(min_iterations_threshold + f64::EPSILON);

    let re_values: Vec<f64> = re_range.collect();

    for (x, im) in im_range.enumerate() {
        let mut y = 0;
        while y + 1 < re_values.len() {
            let results = calculate_escape_iterations_pair(
                (re_values[y], im),
                (re_values[y + 1], im),
                max_iterations,
                exponent,
            );

            for (lane, &(escape_iterations, z)) in results.iter().enumerate() {
                let pixel = color_from_escape_result(
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
                );

                let index = (x * image_width + y + lane) * NUM_COLOR_CHANNELS;
                img[index] = pixel[0];
                img[index + 1] = pixel[1];
                img[index + 2] = pixel[2];
            }

            y += 2;
        }

        if y < re_values.len() {
            let pixel = compute_pixel_color(
                re_values[y],
                im,
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
            );

            let index = (x * image_width + y) * NUM_COLOR_CHANNELS;
            img[index] = pixel[0];
            img[index + 1] = pixel[1];
            img[index + 2] = pixel[2];
        }
    }

    img
}

/// Creates a solid black image
fn create_solid_black_image(image_width: usize, image_height: usize) -> Vec<u8> {
    vec![0, 0, 0, 255]
        .into_iter()
        .cycle()
        .take(image_width * image_height * NUM_COLOR_CHANNELS)
        .collect()
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
    let (palette, should_reverse_colors) = get_color_palette(&color_scheme, reverse_colors);

    let re_range = linspace(re_min, re_max, image_width);
    let im_range = linspace(im_max, im_min, image_height);

    if rect_in_set(re_range.clone(), im_range.clone(), max_iterations, exponent) {
        return create_solid_black_image(image_width, image_height);
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

/// Renders a Mandelbrot set image at any zoom depth.
///
/// The view is described by an arbitrary-precision world origin (decimal
/// strings) plus a rectangle in Leaflet tile coordinates. A tile coordinate
/// `v` at `tile_zoom` maps to the complex offset
/// `((v / 2^(tile_zoom - 2)) * (200 / 128) - 4) * 2^-zoom_offset` from the
/// origin. Shallow views use the direct f64 renderer; deep views use
/// perturbation theory with an arbitrary-precision reference orbit, so zoom
/// depth is not limited by f64 precision.
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

        return get_mandelbrot_set_image(
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
        &origin_re,
        &origin_im,
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
        Err(_) => return create_solid_black_image(image_width, image_height),
    };

    if frame.border_in_set(image_width, image_height) {
        return create_solid_black_image(image_width, image_height);
    }

    let (palette, should_reverse_colors) = get_color_palette(&color_scheme, reverse_colors);

    let min_iterations_threshold = f64::from(palette_min_iter);
    let max_iterations_threshold =
        f64::from(palette_max_iter).max(min_iterations_threshold + f64::EPSILON);

    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];

    for row in 0..image_height {
        let mut column = 0;
        while column < image_width {
            // Batch pairs of pixels into SIMD lanes; a trailing odd pixel is
            // paired with itself.
            let second_column = (column + 1).min(image_width - 1);
            let results = frame.escape_iterations_pair((column, row), (second_column, row));

            for (lane, &(escape_iterations, z)) in
                results.iter().take(second_column - column + 1).enumerate()
            {
                let pixel = color_from_escape_result(
                    escape_iterations,
                    z,
                    max_iterations,
                    exponent,
                    palette,
                    should_reverse_colors,
                    &color_space,
                    shift_hue_amount,
                    saturate_amount,
                    lighten_amount,
                    smooth_coloring,
                    min_iterations_threshold,
                    max_iterations_threshold,
                );

                let index = (row * image_width + column + lane) * NUM_COLOR_CHANNELS;
                img[index] = pixel[0];
                img[index + 1] = pixel[1];
                img[index + 2] = pixel[2];
                img[index + 3] = 255;
            }

            column += 2;
        }
    }

    img
}

/// Initializes the module. This function is specifically designed to be called
/// from WebAssembly to perform necessary initializations.
#[wasm_bindgen]
pub fn init() {
    utils::init();
}
