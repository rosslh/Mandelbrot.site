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

/// Checks if a point is within the Mandelbrot set.
///
/// # Parameters
/// - `re`: The real part of the complex number.
/// - `im`: The imaginary part of the complex number.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `exponent`: The exponent used in the escape time algorithm.
///
/// # Returns
/// `true` if the point is within the Mandelbrot set, `false` otherwise.
fn point_in_set(re: f64, im: f64, max_iterations: u32, exponent: u32) -> bool {
    calculate_escape_iterations(re, im, max_iterations, exponent).0 == max_iterations
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
        re_range.clone().last().unwrap(),
    );
    let (im_min, im_max) = (
        im_range.clone().next().unwrap(),
        im_range.clone().last().unwrap(),
    );

    // Check the four corners of the rectangle
    let corners = [
        (re_min, im_min),
        (re_min, im_max),
        (re_max, im_min),
        (re_max, im_max),
    ];

    // If any corner is not in the set, the rectangle is not entirely in the set
    if corners
        .iter()
        .any(|&(re, im)| !point_in_set(re, im, max_iterations, exponent))
    {
        return false;
    }

    // Check the borders of the rectangle
    for re in re_range {
        if !point_in_set(re, im_min, max_iterations, exponent)
            || !point_in_set(re, im_max, max_iterations, exponent)
        {
            return false;
        }
    }

    for im in im_range {
        if !point_in_set(re_min, im, max_iterations, exponent)
            || !point_in_set(re_max, im, max_iterations, exponent)
        {
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
/// - `scaled_max_iterations`: The scaled maximum number of iterations.
/// - `color_space`: The color space to use for color transformations.
/// - `shift_hue_amount`: The amount to shift the hue by.
/// - `saturate_amount`: The amount to saturate the color by.
/// - `lighten_amount`: The amount to lighten the color by.
/// - `smooth_coloring`: Whether to use smooth coloring.
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
    scaled_max_iterations: usize,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    smooth_coloring: bool,
) -> RgbColor {
    let (escape_iterations, z) = calculate_escape_iterations(re, im, max_iterations, exponent);

    if escape_iterations == max_iterations {
        [0, 0, 0]
    } else {
        let smoothed_value = if smooth_coloring {
            // See: https://iquilezles.org/articles/msetsmooth/
            f64::from(escape_iterations)
                - ((z.norm().ln() / ESCAPE_RADIUS.ln()).ln() / f64::from(exponent).ln())
        } else {
            f64::from(escape_iterations)
        };

        let mut scaled_value = (smoothed_value * 20.0) as usize;

        if should_reverse_colors {
            scaled_value = scaled_max_iterations - scaled_value;
        }

        let color = palette.eval_rational(scaled_value, scaled_max_iterations);

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
/// - `scaled_max_iterations`: The scaled maximum number of iterations.
/// - `color_space`: The color space to use for color transformations.
/// - `shift_hue_amount`: The amount to shift the hue by.
/// - `saturate_amount`: The amount to saturate the color by.
/// - `lighten_amount`: The amount to lighten the color by.
/// - `smooth_coloring`: Whether to use smooth coloring.
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
    scaled_max_iterations: usize,
    color_space: &ValidColorSpace,
    shift_hue_amount: f32,
    saturate_amount: f32,
    lighten_amount: f32,
    smooth_coloring: bool,
) -> Vec<u8> {
    let output_size: usize = image_width * image_height * NUM_COLOR_CHANNELS;
    let mut img: Vec<u8> = vec![0; output_size];

    for (x, im) in im_range.enumerate() {
        for (y, re) in re_range.clone().enumerate() {
            let pixel = compute_pixel_color(
                re,
                im,
                max_iterations,
                exponent,
                palette,
                should_reverse_colors,
                scaled_max_iterations,
                color_space,
                shift_hue_amount,
                saturate_amount,
                lighten_amount,
                smooth_coloring,
            );

            let index = (x * image_width + y) * NUM_COLOR_CHANNELS;
            img[index] = pixel[0];
            img[index + 1] = pixel[1];
            img[index + 2] = pixel[2];
            img[index + 3] = 255;
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
) -> Vec<u8> {
    let (palette, should_reverse_colors) = get_color_palette(&color_scheme, reverse_colors);

    let re_range = linspace(re_min, re_max, image_width);
    let im_range = linspace(im_min, im_max, image_height);

    if rect_in_set(re_range.clone(), im_range.clone(), max_iterations, exponent) {
        return create_solid_black_image(image_width, image_height);
    }

    let scaled_max_iterations = (max_iterations * 20) as usize;

    render_mandelbrot_set(
        re_range,
        im_range,
        max_iterations,
        exponent,
        image_width,
        image_height,
        palette,
        should_reverse_colors,
        scaled_max_iterations,
        &color_space,
        shift_hue_amount,
        saturate_amount,
        lighten_amount,
        smooth_coloring,
    )
}

/// Initializes the module. This function is specifically designed to be called
/// from WebAssembly to perform necessary initializations.
#[wasm_bindgen]
pub fn init() {
    utils::init();
}
