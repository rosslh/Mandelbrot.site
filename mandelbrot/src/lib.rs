mod utils;

use once_cell::sync::Lazy;
use std::collections::HashMap;

#[cfg(test)]
#[path = "lib_test.rs"]
mod lib_test;

use itertools_num::linspace;
use num::complex::Complex64;
use wasm_bindgen::prelude::*;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

/// Calculates the number of iterations it takes for a complex number to escape the set,
/// based on the given coordinates, maximum iterations, escape radius, and exponent.
///
/// # Parameters
/// - `x`: The real part of the complex number.
/// - `y`: The imaginary part of the complex number.
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `escape_radius`: The escape radius beyond which the function considers the number to have escaped.
/// - `exponent`: The exponent used in the escape time algorithm.
///
/// # Returns
/// A tuple containing the number of iterations it took to escape and the final value of the complex number.
fn get_escape_iterations(
    x: f64,
    y: f64,
    max_iterations: u32,
    escape_radius: f64,
    exponent: u32,
) -> (u32, Complex64) {
    let c: Complex64 = Complex64::new(x, y);
    let mut z: Complex64 = c;

    let mut iter: u32 = 0;

    if exponent == 2 {
        while z.norm_sqr() < escape_radius.powi(2) && iter < max_iterations {
            iter += 1;
            z = z * z + c;
        }
    } else {
        while z.norm() < escape_radius && iter < max_iterations {
            iter += 1;
            z = z.powu(exponent) + c;
        }
    }

    (iter, z)
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
/// - `escape_radius`: The escape radius beyond which the function considers a point to have escaped the set.
/// - `exponent`: The exponent used in the escape time algorithm.
///
/// # Returns
/// `true` if the entire rectangle is within the Mandelbrot set, `false` otherwise.
fn rect_in_set(
    re_range: itertools_num::Linspace<f64>,
    im_range: itertools_num::Linspace<f64>,
    max_iterations: u32,
    escape_radius: f64,
    exponent: u32,
) -> bool {
    let (top, bottom) = (
        im_range.clone().next().unwrap(),
        im_range.clone().last().unwrap(),
    );
    for re in re_range.clone() {
        let top_in_set = get_escape_iterations(re, top, max_iterations, escape_radius, exponent).0
            == max_iterations;
        let bottom_in_set =
            get_escape_iterations(re, bottom, max_iterations, escape_radius, exponent).0
                == max_iterations;
        if !top_in_set || !bottom_in_set {
            return false;
        }
    }

    let (left, right) = (
        re_range.clone().next().unwrap(),
        re_range.clone().last().unwrap(),
    );
    for im in im_range {
        let left_in_set = get_escape_iterations(left, im, max_iterations, escape_radius, exponent)
            .0
            == max_iterations;
        let right_in_set =
            get_escape_iterations(right, im, max_iterations, escape_radius, exponent).0
                == max_iterations;
        if !left_in_set || !right_in_set {
            return false;
        }
    }

    true
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

/// Generates a image of the Mandelbrot set given the bounds, number of iterations,
/// exponent for escape time algorithm, image side length, and color scheme.
///
/// # Parameters
/// - `re_min`: The minimum real value (left side of the image).
/// - `re_max`: The maximum real value (right side of the image).
/// - `im_min`: The minimum imaginary value (bottom of the image).
/// - `im_max`: The maximum imaginary value (top of the image).
/// - `max_iterations`: The maximum number of iterations to perform.
/// - `exponent`: The exponent used in the escape time algorithm.
/// - `image_side_length`: The length of one side of the square image, in pixels.
/// - `color_scheme`: The name of the color scheme to use.
/// - `_reverse_colors`: Whether to reverse the colors of the color scheme.
///
/// # Returns
/// A vector of bytes representing the RGBA color values of the image.
#[wasm_bindgen]
pub fn get_mandelbrot_image(
    re_min: f64,
    re_max: f64,
    im_min: f64,
    im_max: f64,
    max_iterations: u32,
    exponent: u32,
    image_side_length: usize,
    color_scheme: String,
    _reverse_colors: bool,
) -> Vec<u8> {
    let mut reverse_colors = _reverse_colors;

    let min_channel_value = 0;
    let max_channel_value = 255;
    let mut palette = &colorous::TURBO;

    if COLOR_PALETTES.contains_key(&color_scheme) {
        palette = COLOR_PALETTES.get(&color_scheme).unwrap();
    }

    if REVERSE_COLOR_PALETTES.contains_key(&color_scheme) {
        palette = REVERSE_COLOR_PALETTES.get(&color_scheme).unwrap();
        reverse_colors = !reverse_colors;
    }

    let output_size: usize = image_side_length * image_side_length * NUM_COLOR_CHANNELS;

    let re_range = linspace(re_min, re_max, image_side_length);
    let im_range = linspace(im_min, im_max, image_side_length);
    let enumerated_re_range = re_range.clone().enumerate();
    let enumerated_im_range = im_range.clone().enumerate();

    let palette_scale_factor = 20.0;
    let scaled_max_iterations = (max_iterations * palette_scale_factor as u32) as usize;
    let rgb_black = [min_channel_value; 3];
    let rgba_black = [
        min_channel_value,
        min_channel_value,
        min_channel_value,
        max_channel_value,
    ];

    // radius has to be >=3 for color smoothing
    let escape_radius = 3.0;

    if rect_in_set(re_range, im_range, max_iterations, escape_radius, exponent) {
        let black_pixels = rgba_black
            .iter()
            .cycle()
            .take(output_size)
            .cloned()
            .collect();

        return black_pixels;
    }

    // Canvas API expects UInt8ClampedArray
    let mut img: Vec<u8> = vec![0; output_size]; // [ r, g, b, a, r, g, b, a, r, g, b, a... ]

    for (x, im) in enumerated_im_range {
        for (y, re) in enumerated_re_range.clone() {
            let (escape_iterations, z) =
                get_escape_iterations(re, im, max_iterations, escape_radius, exponent);

            let pixel: [u8; 3] = if escape_iterations == max_iterations {
                rgb_black
            } else {
                // See: https://iquilezles.org/articles/msetsmooth/
                let smoothed_value = f64::from(escape_iterations)
                    - ((z.norm().ln() / escape_radius.ln()).ln() / f64::from(exponent).ln());
                // more colors to reduce banding
                let mut scaled_value = (smoothed_value * palette_scale_factor) as usize;
                if reverse_colors {
                    scaled_value = scaled_max_iterations - scaled_value;
                }
                let color = palette.eval_rational(scaled_value, scaled_max_iterations);

                color.as_array()
            };

            // index = ((current row * row length) + current column) * 4 to fit r,g,b,a values
            let index = (x * image_side_length + y) * NUM_COLOR_CHANNELS;
            img[index] = pixel[0]; // r
            img[index + 1] = pixel[1]; // g
            img[index + 2] = pixel[2]; // b
            img[index + 3] = max_channel_value; // a
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
