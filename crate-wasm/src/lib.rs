mod utils;
use wasm_bindgen::prelude::*;

use itertools_num::linspace;
use num::complex::Complex64;
use std::f64::consts;

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
    exponent: u32
) -> (u32, f64) {
    let c: Complex64 = Complex64::new(x, y);
    let mut z: Complex64 = c;

    let mut iter: u32 = 0;

    if exponent == 2 {
        while z.norm() < escape_radius && iter < max_iterations {
            iter += 1;
            z = z * z + c;
        }

        // https://stackoverflow.com/questions/369438/smooth-spectrum-for-mandelbrot-set-rendering
        let smoothed = (iter as f64) + 1.0 - z.norm().ln().ln() / consts::LN_2;

        (iter, smoothed)
    } else {
        while z.norm() < escape_radius && iter < max_iterations {
            iter += 1;
            z = z.powu(exponent) + c;
        }

        (iter, iter as f64)
    }
}

// map leaflet coordinates to complex plane
fn map_coordinates(x: f64, y: f64, z: f64) -> (f64, f64) {
    let n: f64 = 2.0f64.powf(z);
    let re = x / n * 2.0 - 4.5;
    let im = y / n * 2.0 - 4.0;

    (re, im)
}

fn generate_image(
    center_x: f64,
    center_y: f64,
    z: f64,
    max_iterations: u32,
    exponent: u32
) -> [u8; 256 * 256 * 4] {
    // size of leaflet tile
    let size: u32 = 256;

    // Canvas API expects UInt8ClampedArray
    let mut img: [u8; 256 * 256 * 4] = [0; 256 * 256 * 4]; // [ r, g, b, a, r, g, b, a, r, g, b, a...]

    let palette = colorous::TURBO;

    let (re_min, im_min) = map_coordinates(center_x, center_y, z);
    let (re_max, im_max) = map_coordinates(center_x + 1.0, center_y + 1.0, z);

    let re_range = linspace(re_min, re_max, size as usize).enumerate();
    let im_range = linspace(im_min, im_max, size as usize).enumerate();

    let scaled_max_iterations = (max_iterations * 20) as usize;
    let black = [0, 0, 0];
    let escape_radius = if exponent == 2 { 3.0 } else { 2.0 };

    for (x, im) in im_range {
        for (y, re) in re_range.clone() {
            let (escape_time, smoothed_value) =
                get_escape_time(re, im, max_iterations, escape_radius, exponent);

            let pixel: [u8; 3] = if escape_time == max_iterations {
                black
            } else {
                let color = palette.eval_rational(
                    (smoothed_value * 20.0) as usize, // more colors to reduce banding
                    scaled_max_iterations,
                );

                color.as_array()
            };

            // index = ((current row * row length) + current column) * 4 to fit r,g,b,a values
            let index = (x * (size as usize) + y) * 4;

            let r = pixel[0];
            let g = pixel[1];
            let b = pixel[2];

            #[allow(non_snake_case)]
            let UInt8ClampedArray_max = 255;

            img[index] = r;
            img[index + 1] = g;
            img[index + 2] = b;
            // alpha value:
            img[index + 3] = UInt8ClampedArray_max;
        }
    }

    img
}

#[wasm_bindgen]
pub fn get_tile(x: u32, y: u32, z: u32, max_iterations: u32, exponent: u32) -> Vec<u8> {
    let image_data = generate_image(
        x as f64,
        y as f64,
        (z as f64) - 2.0, // increase leaflet viewport
        max_iterations,
        exponent,
    );

    image_data.to_vec()
}

#[wasm_bindgen]
pub fn init() {
    utils::init();
}
