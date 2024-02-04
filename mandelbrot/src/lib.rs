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

// how many iterations does it take to escape?
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

    while z.norm() < escape_radius && iter < max_iterations {
        iter += 1;
        z = z.powu(exponent) + c;
    }

    (iter, z)
}

// Mandelbrot set is simply connected.
// So if the border of the rectangle is in the set, we know the rest of it is too.
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

static COLOROUS_PALETTES: Lazy<HashMap<String, colorous::Gradient>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert("blueGreen".to_string(), colorous::BLUE_GREEN);
    map.insert("bluePurple".to_string(), colorous::BLUE_PURPLE);
    map.insert("blues".to_string(), colorous::BLUES);
    map.insert("brownGreen".to_string(), colorous::BROWN_GREEN);
    map.insert("cividis".to_string(), colorous::CIVIDIS);
    map.insert("cool".to_string(), colorous::COOL);
    map.insert("cubehelix".to_string(), colorous::CUBEHELIX);
    map.insert("greenBlue".to_string(), colorous::GREEN_BLUE);
    map.insert("greens".to_string(), colorous::GREENS);
    map.insert("greys".to_string(), colorous::GREYS);
    map.insert("inferno".to_string(), colorous::INFERNO);
    map.insert("magma".to_string(), colorous::MAGMA);
    map.insert("orangeRed".to_string(), colorous::ORANGE_RED);
    map.insert("oranges".to_string(), colorous::ORANGES);
    map.insert("pinkGreen".to_string(), colorous::PINK_GREEN);
    map.insert("plasma".to_string(), colorous::PLASMA);
    map.insert("purpleBlue".to_string(), colorous::PURPLE_BLUE);
    map.insert("purpleBlueGreen".to_string(), colorous::PURPLE_BLUE_GREEN);
    map.insert("purpleGreen".to_string(), colorous::PURPLE_GREEN);
    map.insert("purpleOrange".to_string(), colorous::PURPLE_ORANGE);
    map.insert("purpleRed".to_string(), colorous::PURPLE_RED);
    map.insert("purples".to_string(), colorous::PURPLES);
    map.insert("rainbow".to_string(), colorous::RAINBOW);
    map.insert("redBlue".to_string(), colorous::RED_BLUE);
    map.insert("redGrey".to_string(), colorous::RED_GREY);
    map.insert("redPurple".to_string(), colorous::RED_PURPLE);
    map.insert("reds".to_string(), colorous::REDS);
    map.insert("redYellowBlue".to_string(), colorous::RED_YELLOW_BLUE);
    map.insert("redYellowGreen".to_string(), colorous::RED_YELLOW_GREEN);
    map.insert("sinebow".to_string(), colorous::SINEBOW);
    map.insert("spectral".to_string(), colorous::SPECTRAL);
    map.insert("turbo".to_string(), colorous::TURBO);
    map.insert("viridis".to_string(), colorous::VIRIDIS);
    map.insert("warm".to_string(), colorous::WARM);
    map.insert("yellowGreen".to_string(), colorous::YELLOW_GREEN);
    map.insert("yellowGreenBlue".to_string(), colorous::YELLOW_GREEN_BLUE);
    map.insert(
        "yellowOrangeBrown".to_string(),
        colorous::YELLOW_ORANGE_BROWN,
    );
    map.insert("yellowOrangeRed".to_string(), colorous::YELLOW_ORANGE_RED);
    map
});

#[wasm_bindgen]
pub fn get_tile(
    re_min: f64,
    re_max: f64,
    im_min: f64,
    im_max: f64,
    max_iterations: u32,
    exponent: u32,
    image_side_length: usize,
    color_scheme: String,
    reverse_colors: bool,
) -> Vec<u8> {
    let min_channel_value = 0;
    let max_channel_value = 255;
    let palette = if color_scheme != "turbo" && COLOROUS_PALETTES.contains_key(&color_scheme) {
        COLOROUS_PALETTES.get(&color_scheme).unwrap()
    } else {
        &colorous::TURBO
    };

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
                // See: https://www.iquilezles.org/www/articles/mset_smooth/mset_smooth.htm
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

#[wasm_bindgen]
pub fn init() {
    utils::init();
}
