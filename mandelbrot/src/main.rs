use actix_files::NamedFile;
use actix_web::{web, App, HttpServer, Result};
use image::{Rgba, RgbaImage};
use itertools_num::linspace;
use num::complex::Complex64;
use std::path::Path;
use std::path::PathBuf;

// how many iterations does it take to escape?
fn get_escape_time(x: f64, y: f64, max_iterations: u32) -> (u32, f64) {
    let c: Complex64 = Complex64::new(x, y);
    let mut z: Complex64 = c.clone();
    let mut iter: u32 = 0;
    while z.norm() < 4.0 && iter < max_iterations {
        iter += 1;
        z = z * z + c;
    }
    let two: f64 = 2.0;
    let smoothed = (iter as f64) + 1.0 - z.norm().ln().ln() / two.ln(); // https://stackoverflow.com/questions/369438/smooth-spectrum-for-mandelbrot-set-rendering
    (iter, smoothed)
}

// map leaflet coordinates to complex plane
fn map_coordinates(x: f64, y: f64, z: f64) -> (f64, f64) {
    let n: f64 = 2.0_f64.powf(z);
    let re = x / n * 2.0 - 0.5;
    let im = y / n * 2.0 - 1.0;
    (re, im)
}

// generate image at point/zoom-level and save it
fn generate_image(
    center_x: f64,
    center_y: f64,
    z: f64,
    max_iterations: u32,
    image_path: &str,
) -> () {
    let size: u32 = 256;
    let mut img: RgbaImage = RgbaImage::new(size, size);
    let palette = colorous::TURBO;

    let (re_min, im_min) = map_coordinates(center_x, center_y, z);
    let (re_max, im_max) = map_coordinates(center_x + 1.0, center_y + 1.0, z);
    let re_range = linspace(re_min, re_max, size as usize).enumerate();
    let im_range = linspace(im_min, im_max, size as usize).enumerate();

    for (y, im) in im_range {
        for (x, re) in re_range.clone() {
            let (escape_time, smoothed) = get_escape_time(re, im, max_iterations);

            img.put_pixel(
                x as u32,
                y as u32,
                if escape_time == max_iterations {
                    Rgba::from([0, 0, 0, 255])
                } else {
                    let color = palette.eval_rational(
                        (smoothed * 100.0) as usize,
                        (max_iterations * 100) as usize,
                    );
                    Rgba::from([color.r, color.g, color.b, 255])
                },
            );
        }
    }
    let _ = image::DynamicImage::ImageRgba8(img).save(&Path::new(image_path));
}

async fn index(web::Path((z, x, y)): web::Path<(i32, i32, i32)>) -> Result<NamedFile> {
    let image_path: &str = &format!(
        r"C:\Users\ross\Projects\rust-fractals\mandelbrot\static\{}-{}-{}.png",
        z, x, y
    ); // TODO: figure out how to keep in memory

    let max_iterations = 90;

    if !Path::new(image_path).exists() {
        generate_image(x as f64, y as f64, z as f64, max_iterations, image_path);
    }

    let path: PathBuf = PathBuf::from(image_path);
    Ok(NamedFile::open(path)?)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    HttpServer::new(|| App::new().route("/{z}/{x}/{y}", web::get().to(index)))
        .bind("127.0.0.1:3030")?
        .run()
        .await
}
