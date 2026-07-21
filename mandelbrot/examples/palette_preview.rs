//! Renders a preview grid of every color scheme the app exposes, plus
//! per-palette lightness stats, to diagnose low-contrast palettes.
//!
//! Usage: cargo run --release --example palette_preview -- <output_dir>

use mandelbrot::{get_mandelbrot_tile_precise, recolor_values, ColoringOptions, ValidColorSpace};
use rayon::prelude::*;

const TILE: usize = 256;
const STRIP_H: usize = 20;
const CELL_W: usize = TILE;
const CELL_H: usize = TILE + STRIP_H;
const COLS: usize = 5;

// Mirrors the UI grouping order in index.html.
const SCHEMES: &[&str] = &[
    // Sequential (multi-hue)
    "cividis",
    "cool",
    "cubehelix",
    "gnuplot",
    "inferno",
    "jet",
    "magma",
    "nipySpectral",
    "plasma",
    "turbo",
    "viridis",
    "warm",
    "yellowGreenBlue",
    "greenBlue",
    "purpleBlueGreen",
    "yellowGreen",
    "redPurple",
    "yellowOrangeRed",
    "orangeRed",
    "purpleRed",
    "yellowOrangeBrown",
    // Sequential (single-hue)
    "blues",
    "greens",
    "greys",
    "oranges",
    "purples",
    "reds",
    // Diverging
    "spectral",
    "brownGreen",
    "pinkGreen",
    "purpleGreen",
    "purpleOrange",
    "redBlue",
    "redGrey",
    "redYellowBlue",
    "redYellowGreen",
    // Cyclical
    "rainbow",
    "sinebow",
];

/// Samples a palette as the app applies it (default orientation, no
/// transforms): 256 RGBA pixels across the full gradient.
fn palette_colors(name: &str) -> Vec<u8> {
    let values: Vec<f32> = (0..256).map(|i| i as f32).collect();
    recolor_values(
        &values,
        &ColoringOptions {
            color_scheme: name.to_string(),
            reverse_colors: false,
            shift_hue_amount: 0.0,
            saturate_amount: 0.0,
            lighten_amount: 0.0,
            color_space: 0, // Hsl
            palette_min_iter: 0,
            palette_max_iter: 255,
            color_cycles: 1,
            distance_estimate: false,
            atom_domain: false,
            palette_cdf: None,
            palette_offset: 0.0,
        },
    )
}

// CIE L* (0-100) of an sRGB color.
fn lightness(r: u8, g: u8, b: u8) -> f64 {
    fn lin(u: u8) -> f64 {
        let v = u as f64 / 255.0;
        if v <= 0.04045 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        }
    }
    let y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    if y > 0.008856 {
        116.0 * y.cbrt() - 16.0
    } else {
        903.3 * y
    }
}

fn main() {
    let out_dir = std::env::args().nth(2).or_else(|| std::env::args().nth(1));
    let out_dir = out_dir.expect("pass output dir");
    std::fs::create_dir_all(&out_dir).unwrap();

    // Seahorse valley detail: dense banding, good contrast test.
    let cx = -0.743_643_887_037_151;
    let cy = 0.131_825_904_205_33;
    let half = 0.001;
    let max_iter = 300;

    let strips: Vec<Vec<u8>> = SCHEMES.iter().map(|name| palette_colors(name)).collect();

    println!(
        "{:<20} {:>7} {:>7} {:>7} {:>9}",
        "scheme", "L*min", "L*max", "range", "meanStep"
    );
    let mut stats: Vec<(&str, f64)> = Vec::new();
    for (name, strip) in SCHEMES.iter().zip(&strips) {
        let ls: Vec<f64> = strip
            .chunks_exact(4)
            .map(|px| lightness(px[0], px[1], px[2]))
            .collect();
        let min = ls.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = ls.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
        let mean_step: f64 = ls.windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>() / 255.0;
        println!(
            "{:<20} {:>7.1} {:>7.1} {:>7.1} {:>9.3}",
            name,
            min,
            max,
            max - min,
            mean_step
        );
        stats.push((name, max - min));
    }
    stats.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    println!("\nSorted by L* range (lowest contrast first):");
    for (name, range) in &stats {
        println!("  {:<20} {:>6.1}", name, range);
    }

    // Map the desired complex bounds onto tile coordinates at tile_zoom=2,
    // zoom_offset=0, where offset(v) = v * (200/128/1) - 4 relative to the
    // origin (see render_tile_precise).
    let scale = 200.0 / 128.0;
    let tx = |offset: f64| (offset + 4.0) / scale;

    let render = |name: &str, pal_min: i32, pal_max: i32| {
        get_mandelbrot_tile_precise(
            cx.to_string(),
            cy.to_string(),
            tx(-half),
            tx(half),
            tx(-half),
            tx(half),
            2,
            0,
            max_iter,
            2,
            TILE,
            TILE,
            name.to_string(),
            false,
            0.0,
            0.0,
            0.0,
            ValidColorSpace::Hsl,
            true,
            pal_min,
            pal_max,
            false,
            None,
        )
    };

    let tiles: Vec<(usize, Vec<u8>)> = SCHEMES
        .par_iter()
        .enumerate()
        .map(|(idx, name)| {
            // Two passes: first to learn the visible iteration range, then a
            // re-render with the palette fitted to it, matching the app's
            // paletteAutoAdjust behavior.
            let probe = render(name, 0, max_iter as i32);
            let img = if probe.min_iter >= 0 {
                render(name, probe.min_iter, probe.max_iter).image
            } else {
                probe.image
            };
            (idx, img)
        })
        .collect();

    let rows = SCHEMES.len().div_ceil(COLS);
    let (w, h) = (COLS * CELL_W, rows * CELL_H);
    let mut montage = vec![0u8; w * h * 4];

    for (idx, tile) in &tiles {
        let (col, row) = (*idx % COLS, *idx / COLS);
        let (x0, y0) = (col * CELL_W, row * CELL_H);

        for y in 0..TILE {
            for x in 0..TILE {
                let src = (y * TILE + x) * 4;
                let dst = ((y0 + y) * w + x0 + x) * 4;
                montage[dst..dst + 4].copy_from_slice(&tile[src..src + 4]);
            }
        }

        // Gradient strip under the tile, oriented as the app applies it.
        let strip = &strips[*idx];
        for x in 0..TILE {
            let src = x * 4;
            for y in 0..STRIP_H {
                let dst = ((y0 + TILE + y) * w + x0 + x) * 4;
                montage[dst..dst + 4].copy_from_slice(&strip[src..src + 4]);
            }
        }
    }

    let path = format!("{out_dir}/montage.png");
    image::save_buffer(&path, &montage, w as u32, h as u32, image::ColorType::Rgba8).unwrap();
    println!("\nwrote {path}");
    println!("grid order (5 per row):");
    for (i, name) in SCHEMES.iter().enumerate() {
        if i % COLS == 0 {
            print!("\nrow {}: ", i / COLS + 1);
        }
        print!("{name}  ");
    }
    println!();
}
