mod utils;

#[cfg(test)]
#[path = "lib_test.rs"]
mod lib_test;

use wasm_bindgen::prelude::*;

use itertools_num::linspace;
use num::complex::Complex64;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

// how many iterations does it take to escape?
fn get_escape_time(
    x: f64,
    y: f64,
    max_iterations: u32,
    escape_radius: f64,
    exponent: u32,
) -> (u32, f64) {
    let c: Complex64 = Complex64::new(x, y);
    let mut z: Complex64 = c;

    let mut iter: u32 = 0;

    while z.norm() < escape_radius && iter < max_iterations {
        iter += 1;
        z = z.powu(exponent) + c;
    }

    // See: https://www.iquilezles.org/www/articles/mset_smooth/mset_smooth.htm
    let smoothed =
        f64::from(iter) - ((z.norm().ln() / escape_radius.ln()).ln() / f64::from(exponent).ln());

    (iter, smoothed)
}

// map leaflet coordinates to complex plane
fn map_coordinates(x: f64, y: f64, z: f64) -> (f64, f64) {
    let n: f64 = 2.0f64.powf(z);
    let re = x / n * 2.0 - 4.5;
    let im = y / n * 2.0 - 4.0;

    (re, im)
}

// size of leaflet tile
const IMAGE_SIDE_LENGTH: usize = 256;
const NUM_COLOR_CHANNELS: usize = 4;
const OUTPUT_SIZE: usize = IMAGE_SIDE_LENGTH * IMAGE_SIDE_LENGTH * NUM_COLOR_CHANNELS;

fn generate_image(
    center_x: f64,
    center_y: f64,
    z: f64,
    max_iterations: u32,
    exponent: u32,
) -> [u8; OUTPUT_SIZE] {
    let min_channel_value = 0;
    let max_channel_value = 255;
    let palette = colorous::TURBO;

    // Canvas API expects UInt8ClampedArray
    let mut img: [u8; OUTPUT_SIZE] = [min_channel_value; OUTPUT_SIZE]; // [ r, g, b, a, r, g, b, a, r, g, b, a...]

    let (re_min, im_min) = map_coordinates(center_x, center_y, z);
    let (re_max, im_max) = map_coordinates(center_x + 1.0, center_y + 1.0, z);

    let re_range = linspace(re_min, re_max, IMAGE_SIDE_LENGTH).enumerate();
    let im_range = linspace(im_min, im_max, IMAGE_SIDE_LENGTH).enumerate();

    let palette_scale_factor = 20.0;
    let scaled_max_iterations = (max_iterations * palette_scale_factor as u32) as usize;
    let black = [min_channel_value; 3];

    // radius has to be >=3 for color smoothing
    let escape_radius = 3.0;

    for (x, im) in im_range {
        for (y, re) in re_range.clone() {
            let (escape_time, smoothed_value) =
                get_escape_time(re, im, max_iterations, escape_radius, exponent);

            let pixel: [u8; 3] = if escape_time == max_iterations {
                black
            } else {
                // more colors to reduce banding
                let scaled_value = (smoothed_value * palette_scale_factor) as usize;
                let color = palette.eval_rational(scaled_value, scaled_max_iterations);

                color.as_array()
            };

            // index = ((current row * row length) + current column) * 4 to fit r,g,b,a values
            let index = (x * IMAGE_SIDE_LENGTH + y) * NUM_COLOR_CHANNELS;

            let r = pixel[0];
            let g = pixel[1];
            let b = pixel[2];

            img[index] = r;
            img[index + 1] = g;
            img[index + 2] = b;
            img[index + 3] = max_channel_value;
        }
    }

    img
}

#[wasm_bindgen]
pub fn get_tile(x: u32, y: u32, z: u32, max_iterations: u32, exponent: u32) -> Vec<u8> {
    let image_data = generate_image(
        f64::from(x),
        f64::from(y),
        f64::from(z) - 2.0, // increase leaflet viewport
        max_iterations,
        exponent,
    );

    image_data.to_vec()
}

#[wasm_bindgen]
pub fn init() {
    utils::init();
}
