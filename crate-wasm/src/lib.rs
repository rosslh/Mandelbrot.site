mod utils;
use wasm_bindgen::prelude::*;

use itertools_num::linspace;
use num::complex::Complex64;
use std::f64::consts;

// When the `wee_alloc` feature is enabled, use `wee_alloc` as the global allocator.
#[cfg(feature = "wee_alloc")]
#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

fn in_cardioid(x: f64, y: f64) -> bool {
    let a = x - 1.0 / 4.0;
    let q = a * a + y * y;
    q * (q + a) <= 0.25 * y * y
}

fn in_bulb(x: f64, y: f64) -> bool {
    let a = x + 1.0;
    a * a + y * y <= 0.0625 // <= 1/16
}

// how many iterations does it take to escape?
fn get_escape_time(
    x: f64,
    y: f64,
    max_iterations: u32,
    escape_radius: f64,
    is_smoothed: bool,
) -> (u32, f64) {
    if in_cardioid(x, y) || in_bulb(x, y) {
        return (max_iterations, 0.0);
    }
    let c: Complex64 = Complex64::new(x, y);
    let mut z: Complex64 = c.clone();
    let mut iter: u32 = 0;
    while z.norm() < escape_radius && iter < max_iterations {
        iter += 1;
        z = z * z + c;
    }
    // https://stackoverflow.com/questions/369438/smooth-spectrum-for-mandelbrot-set-rendering
    let smoothed = if is_smoothed {
        (iter as f64) + 1.0 - z.norm().ln().ln() / consts::LN_2
    } else {
        iter as f64
    };
    (iter, smoothed)
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
    is_smoothed: bool,
) -> [u8; 256 * 256 * 4] {
    let size: u32 = 256; // size of leaflet tile
    let mut img: [u8; 256 * 256 * 4] = [0; 256 * 256 * 4]; // [ r, g, b, a, r, g, b, a, r, g, b, a...]

    let palette = colorous::TURBO;

    let (re_min, im_min) = map_coordinates(center_x, center_y, z);
    let (re_max, im_max) = map_coordinates(center_x + 1.0, center_y + 1.0, z);
    let re_range = linspace(re_min, re_max, size as usize).enumerate();
    let im_range = linspace(im_min, im_max, size as usize).enumerate();
    let scaled_max_iterations = (max_iterations * 20) as usize;
    let black = [0, 0, 0];
    let escape_radius = if is_smoothed { 3.0 } else { 2.0 };

    for (x, im) in im_range {
        for (y, re) in re_range.clone() {
            let (escape_time, smoothed_value) =
                get_escape_time(re, im, max_iterations, escape_radius, is_smoothed);

            let pixel: [u8; 3] = if escape_time == max_iterations {
                black
            } else {
                let color = palette.eval_rational(
                    (smoothed_value * 20.0) as usize, // more colors to reduce banding
                    scaled_max_iterations,
                );
                color.as_array()
            };
            let index = (x * (size as usize) + y) * 4;
            img[index] = pixel[0];
            img[index + 1] = pixel[1];
            img[index + 2] = pixel[2];
            img[index + 3] = 255;
        }
    }
    img
}

#[wasm_bindgen]
pub fn get_tile(x: u32, y: u32, z: u32, max_iterations: u32, is_smoothed: bool) -> Vec<u8> {
    generate_image(
        x as f64,
        y as f64,
        (z as f64) - 2.0, // increase leaflet viewport
        max_iterations,
        is_smoothed,
    )
    .to_vec()
}

#[wasm_bindgen]
pub fn init() {
    utils::init();
}
