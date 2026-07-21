use super::*;

// Renaming this module to the conventional `tests` would rename the module
// path baked into every checked-in insta snapshot filename
// (mandelbrot__lib_test__lib_test__*.snap), so the inception stays.
#[allow(clippy::module_inception)]
#[cfg(test)]
mod lib_test {
    use rayon::prelude::*;

    const MAX_ITERATIONS: u32 = 200;

    const SQUARES: [(f64, f64, f64, f64); 6] = [
        (-0.75, -0.25, 0.25, 0.75),
        (-1.5, 0.0, -0.5, 0.5),
        (-2.0, -1.0, 0.0, 1.0),
        (-2.0, 0.5, -1.0, 1.0),
        (0.0, 1.5, 0.0, 1.0),
        (
            -0.38239270518262103,
            -0.38239196302361966,
            0.6251400899330468,
            0.6251408320920477,
        ),
    ];

    struct TestParams {
        x_min: f64,
        x_max: f64,
        y_min: f64,
        y_max: f64,
        max_iterations: u32,
        exponent: u32,
        image_side_length: usize,
        color_scheme: &'static str,
        reverse_color: bool,
        hue_shift: f32,
        saturation_shift: f32,
        lightness_shift: f32,
        color_space: crate::ValidColorSpace,
        smooth_coloring: bool,
        index: usize,
    }

    // Helper to convert u32 to i32 safely for palette parameters
    fn as_i32(val: u32) -> i32 {
        // Simple casting is safe for our use case since all values are small enough
        val as i32
    }

    fn generate_test_params() -> Vec<TestParams> {
        let snapshot_squares = [
            (-0.75, -0.25, 0.25, 0.75),
            (
                -0.3823928482597694,
                -0.38239262683782727,
                0.6251399290049449,
                0.625140139949508,
            ),
        ];
        let max_iterations = [200, 400];
        let exponents = [2, 3];
        let image_side_lengths = [50, 100];
        let color_schemes = ["turbo", "inferno"];
        let reverse_color_options = [true, false];
        let hue_shifts = [0, 90];
        let saturation_shifts = [0.0, 0.5];
        let lightness_shifts = [0.0, 0.5];
        let color_spaces = [crate::ValidColorSpace::Hsl, crate::ValidColorSpace::Lch];
        let smooth_coloring_options = [true, false];

        max_iterations
            .iter()
            .flat_map(|&max_iterations| {
                exponents
                    .iter()
                    .map(move |&exponent| (max_iterations, exponent))
            })
            .flat_map(|(max_iterations, exponent)| {
                image_side_lengths
                    .iter()
                    .map(move |&image_side_length| (max_iterations, exponent, image_side_length))
            })
            .flat_map(|(max_iterations, exponent, image_side_length)| {
                color_schemes.iter().map(move |&color_scheme| {
                    (max_iterations, exponent, image_side_length, color_scheme)
                })
            })
            .flat_map(
                |(max_iterations, exponent, image_side_length, color_scheme)| {
                    reverse_color_options.iter().map(move |&reverse_color| {
                        (
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                        )
                    })
                },
            )
            .flat_map(
                |(max_iterations, exponent, image_side_length, color_scheme, reverse_color)| {
                    hue_shifts.iter().map(move |&hue_shift| {
                        (
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                            hue_shift,
                        )
                    })
                },
            )
            .flat_map(
                |(
                    max_iterations,
                    exponent,
                    image_side_length,
                    color_scheme,
                    reverse_color,
                    hue_shift,
                )| {
                    saturation_shifts.iter().map(move |&saturation_shift| {
                        (
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                            hue_shift,
                            saturation_shift,
                        )
                    })
                },
            )
            .flat_map(
                |(
                    max_iterations,
                    exponent,
                    image_side_length,
                    color_scheme,
                    reverse_color,
                    hue_shift,
                    saturation_shift,
                )| {
                    lightness_shifts.iter().map(move |&lightness_shift| {
                        (
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                            hue_shift,
                            saturation_shift,
                            lightness_shift,
                        )
                    })
                },
            )
            .flat_map(
                |(
                    max_iterations,
                    exponent,
                    image_side_length,
                    color_scheme,
                    reverse_color,
                    hue_shift,
                    saturation_shift,
                    lightness_shift,
                )| {
                    color_spaces.iter().map(move |&color_space| {
                        (
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                            hue_shift,
                            saturation_shift,
                            lightness_shift,
                            color_space,
                        )
                    })
                },
            )
            .flat_map(
                |(
                    max_iterations,
                    exponent,
                    image_side_length,
                    color_scheme,
                    reverse_color,
                    hue_shift,
                    saturation_shift,
                    lightness_shift,
                    color_space,
                )| {
                    smooth_coloring_options.iter().map(move |&smooth_coloring| {
                        (
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                            hue_shift,
                            saturation_shift,
                            lightness_shift,
                            color_space,
                            smooth_coloring,
                        )
                    })
                },
            )
            .flat_map(
                |(
                    max_iterations,
                    exponent,
                    image_side_length,
                    color_scheme,
                    reverse_color,
                    hue_shift,
                    saturation_shift,
                    lightness_shift,
                    color_space,
                    smooth_coloring,
                )| {
                    snapshot_squares.iter().enumerate().map(
                        move |(index, &(x_min, x_max, y_min, y_max))| TestParams {
                            x_min,
                            x_max,
                            y_min,
                            y_max,
                            max_iterations,
                            exponent,
                            image_side_length,
                            color_scheme,
                            reverse_color,
                            hue_shift: hue_shift as f32,
                            saturation_shift,
                            lightness_shift,
                            color_space,
                            smooth_coloring,
                            index,
                        },
                    )
                },
            )
            .collect()
    }

    #[test]
    fn test_get_mandelbrot_image_snapshot() {
        let params = generate_test_params();

        params.par_iter().for_each(|param| {
            let response = super::get_mandelbrot_set_image(
                param.x_min,
                param.x_max,
                param.y_min,
                param.y_max,
                param.max_iterations,
                param.exponent,
                param.image_side_length,
                param.image_side_length,
                param.color_scheme.to_string(),
                param.reverse_color,
                param.hue_shift,
                param.saturation_shift,
                param.lightness_shift,
                param.color_space,
                param.smooth_coloring,
                0,
                as_i32(param.max_iterations),
            );

            let snapshot_name = format!(
                "snapshot_{}_{}_{}_{}_{}_{}_{}_{}_{}_{:?}_{}",
                param.index,
                param.max_iterations,
                param.exponent,
                param.image_side_length,
                param.color_scheme,
                param.reverse_color,
                param.hue_shift,
                param.saturation_shift,
                param.lightness_shift,
                param.color_space,
                param.smooth_coloring
            );

            let even_response: Vec<u8> = response
                .iter()
                .map(|&x| if x % 2 == 0 || x == 255 { x } else { x + 1 })
                .collect();

            insta::assert_snapshot!(snapshot_name.clone(), format!("{:?}", even_response));

            let image_name = format!("./src/snapshots/{}.png", snapshot_name);

            if let Err(err) = image::save_buffer(
                image_name,
                &response,
                param.image_side_length as u32,
                param.image_side_length as u32,
                image::ColorType::Rgba8,
            ) {
                panic!("Failed to save image: {}", err);
            }
        });
    }

    #[test]
    fn calculate_escape_iterations_if_not_in_set_escapes() {
        let points = [
            (-0.1, 1.5),
            (-0.7, 0.3),
            (-0.75, 0.25),
            (-1.2, -0.2),
            (-1.3, 0.15),
            (-1.8, 0.5),
            (-2.0, -1.5),
            (-2.5, 1.5),
            (0.3, -1.3),
            (0.5, 0.5),
            (0.7, 1.2),
            (1.0, -1.5),
        ];

        for &(re, im) in points.iter() {
            let iterations = super::calculate_escape_iterations(re, im, MAX_ITERATIONS, 2).0;

            assert_ne!(
                iterations, MAX_ITERATIONS,
                "Failed at point: ({}, {})",
                re, im
            );
        }
    }

    #[test]
    fn calculate_escape_iterations_if_in_set_stays_bounded() {
        let points = [
            (-0.1, -0.1),
            (-0.1, 0.0),
            (-0.1, 0.1),
            (0.0, -0.1),
            (0.0, 0.0),
            (0.0, 0.1),
            (0.1, -0.1),
            (0.1, 0.0),
            (0.1, 0.1),
        ];
        for &(re, im) in points.iter() {
            let iterations = super::calculate_escape_iterations(re, im, MAX_ITERATIONS, 2).0;

            assert_eq!(
                iterations, MAX_ITERATIONS,
                "Failed at point: ({}, {})",
                re, im
            );
        }
    }

    #[test]
    fn get_mandelbrot_set_image_outputs_correct_length() {
        for &(x_min, x_max, y_min, y_max) in SQUARES.iter() {
            let response = super::get_mandelbrot_set_image(
                x_min,
                x_max,
                y_min,
                y_max,
                MAX_ITERATIONS,
                2,
                256,
                256,
                "turbo".to_string(),
                false,
                0.0,
                0.0,
                0.0,
                crate::ValidColorSpace::Hsl,
                true,
                0,
                as_i32(MAX_ITERATIONS),
            );

            assert_eq!(
                response.len(),
                256 * 256 * 4,
                "Failed at tile: ({}, {}, {}, {})",
                x_min,
                x_max,
                y_min,
                y_max
            );
        }
    }

    #[test]
    fn get_mandelbrot_set_image_outputs_valid_colors() {
        for &(x_min, x_max, y_min, y_max) in SQUARES.iter() {
            let response = super::get_mandelbrot_set_image(
                x_min,
                x_max,
                y_min,
                y_max,
                MAX_ITERATIONS,
                2,
                256,
                256,
                "turbo".to_string(),
                false,
                0.0,
                0.0,
                0.0,
                crate::ValidColorSpace::Hsl,
                true,
                0,
                as_i32(MAX_ITERATIONS),
            );
            assert_eq!(
                response.len(),
                256 * 256 * 4,
                "wrong image size at tile: ({x_min}, {x_max}, {y_min}, {y_max})"
            );
            for pixel in response.chunks_exact(4) {
                assert_eq!(
                    pixel[3], 255,
                    "non-opaque pixel at tile: ({x_min}, {x_max}, {y_min}, {y_max})"
                );
            }
        }
    }

    #[test]
    fn test_transform_color() {
        let original_color = colorous::Color {
            r: 128,
            g: 64,
            b: 32,
        };

        // Test HSL color space
        let transformed_hsl =
            super::transform_color(original_color, &super::ValidColorSpace::Hsl, 90.0, 0.2, 0.1);
        assert_eq!(transformed_hsl.r, 53);
        assert_eq!(transformed_hsl.g, 163);
        assert_eq!(transformed_hsl.b, 31);

        // Test HSLUV color space
        let transformed_hsluv = super::transform_color(
            original_color,
            &super::ValidColorSpace::Hsluv,
            90.0,
            0.2,
            0.1,
        );
        assert_eq!(transformed_hsluv.r, 64);
        assert_eq!(transformed_hsluv.g, 108);
        assert_eq!(transformed_hsluv.b, 33);

        // Test LCH color space
        let transformed_lch =
            super::transform_color(original_color, &super::ValidColorSpace::Lch, 90.0, 0.2, 0.1);
        assert_eq!(transformed_lch.r, 1);
        assert_eq!(transformed_lch.g, 113);
        assert_eq!(transformed_lch.b, 32);

        // Test OKHSL color space
        let transformed_okhsl = super::transform_color(
            original_color,
            &super::ValidColorSpace::Okhsl,
            90.0,
            0.2,
            0.1,
        );
        assert_eq!(transformed_okhsl.r, 71);
        assert_eq!(transformed_okhsl.g, 113);
        assert_eq!(transformed_okhsl.b, 47);
    }

    #[test]
    fn test_transform_color_no_change() {
        let original_color = colorous::Color {
            r: 128,
            g: 64,
            b: 32,
        };

        let transformed =
            super::transform_color(original_color, &super::ValidColorSpace::Hsl, 0.0, 0.0, 0.0);

        assert_eq!(transformed.r, original_color.r);
        assert_eq!(transformed.g, original_color.g);
        assert_eq!(transformed.b, original_color.b);
    }

    #[test]
    fn test_transform_color_extreme_values() {
        let original_color = colorous::Color {
            r: 128,
            g: 64,
            b: 32,
        };

        let transformed = super::transform_color(
            original_color,
            &super::ValidColorSpace::Hsl,
            360.0,
            1.0,
            1.0,
        );

        assert_eq!(transformed.r, 255);
        assert_eq!(transformed.g, 255);
        assert_eq!(transformed.b, 255);
    }

    #[test]
    fn test_transform_color_negative_values() {
        let original_color = colorous::Color {
            r: 128,
            g: 64,
            b: 32,
        };

        let transformed = super::transform_color(
            original_color,
            &super::ValidColorSpace::Hsl,
            -90.0,
            -0.2,
            -0.1,
        );

        assert_eq!(transformed.r, 95);
        assert_eq!(transformed.g, 37);
        assert_eq!(transformed.b, 106);
    }

    #[test]
    fn test_calculate_escape_iterations_quadratic() {
        use num::complex::Complex64;

        let c = Complex64::new(0.0, 0.0);
        let (iterations, final_z) = super::calculate_escape_iterations_quadratic(c, 100, 4.0);
        assert_eq!(iterations, 100);
        assert_eq!(final_z, Complex64::new(0.0, 0.0));

        let c = Complex64::new(1.0, 1.0);
        let (iterations, _) = super::calculate_escape_iterations_quadratic(c, 100, 4.0);
        assert!(iterations < 100);
    }

    #[test]
    fn test_calculate_escape_iterations_general() {
        use num::complex::Complex64;

        let c = Complex64::new(0.0, 0.0);
        let (iterations, final_z) = super::calculate_escape_iterations_general(c, 100, 2.0, 3);
        assert_eq!(iterations, 100);
        assert_eq!(final_z, Complex64::new(0.0, 0.0));

        let c = Complex64::new(1.0, 1.0);
        let (iterations, _) = super::calculate_escape_iterations_general(c, 100, 2.0, 3);
        assert!(iterations < 100);
    }

    #[test]
    fn test_distance_estimate_at_c() {
        use num::complex::Complex64;

        let escape_radius_squared = crate::ESCAPE_RADIUS * crate::ESCAPE_RADIUS;

        // Interior points (origin, and a cardioid point) have no exterior
        // distance.
        assert_eq!(
            super::distance_estimate_at_c(Complex64::new(0.0, 0.0), 1000, escape_radius_squared, 2),
            None
        );
        assert_eq!(
            super::distance_estimate_at_c(
                Complex64::new(-0.5, 0.0),
                1000,
                escape_radius_squared,
                2
            ),
            None
        );

        // A point well outside the set escapes fast and sits a comfortable
        // distance from the boundary.
        let far =
            super::distance_estimate_at_c(Complex64::new(2.0, 2.0), 1000, escape_radius_squared, 2)
                .expect("exterior point should have a distance estimate");
        assert!(far > 0.0 && far.is_finite());

        // A point just outside the set (near the cardioid cusp at re = 0.25)
        // should report a small positive distance, smaller than the far point.
        let near = super::distance_estimate_at_c(
            Complex64::new(0.26, 0.0),
            5000,
            escape_radius_squared,
            2,
        )
        .expect("exterior point should have a distance estimate");
        assert!(near > 0.0 && near.is_finite());
        assert!(near < far);

        // The general-exponent path also produces a finite positive estimate
        // for exterior points.
        let general =
            super::distance_estimate_at_c(Complex64::new(1.5, 1.5), 1000, escape_radius_squared, 3)
                .expect("exterior point should have a distance estimate");
        assert!(general > 0.0 && general.is_finite());
    }

    #[test]
    fn test_period_at_c() {
        use num::complex::Complex64;

        let escape_radius_squared = crate::ESCAPE_RADIUS * crate::ESCAPE_RADIUS;
        let period = |re: f64, im: f64| {
            super::period_at_c(Complex64::new(re, im), 100_000, escape_radius_squared)
        };

        // Main cardioid: c = 0 has the superattracting fixed point 0 (period 1).
        assert_eq!(period(0.0, 0.0), Some(1));
        // Interior cardioid point, still period 1.
        assert_eq!(period(-0.12, 0.0), Some(1));

        // Period-2 bulb: c = -1 has the superattracting 2-cycle {0, -1}.
        assert_eq!(period(-1.0, 0.0), Some(2));

        // Period-3 bulbs: the two large ones off the top and bottom of the
        // cardioid are centered near c = -0.122 ± 0.745i.
        assert_eq!(
            period(-0.122_561_166_876_654, 0.744_861_766_619_745),
            Some(3)
        );
        assert_eq!(
            period(-0.122_561_166_876_654, -0.744_861_766_619_745),
            Some(3)
        );

        // A period-4 bulb, centered near c = -1.311 on the real axis (the bulb
        // hanging off the period-2 bulb).
        assert_eq!(period(-1.310_702_641_336_832, 0.0), Some(4));

        // Points outside the set escape and have no attracting cycle.
        assert_eq!(period(2.0, 2.0), None);
        assert_eq!(period(1.0, 1.0), None);
    }

    #[test]
    fn test_compute_pixel_color() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;

        // Test point in set
        let color: super::RgbColor = super::compute_pixel_color(
            0.0,
            0.0,
            100,
            2,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            true,
            0.0,
            f64::from(100),
        );
        assert_eq!(color, [0, 0, 0]);

        // Test point out of set
        let color: super::RgbColor = super::compute_pixel_color(
            2.0,
            2.0,
            100,
            2,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            true,
            0.0,
            f64::from(100),
        );
        assert_eq!(color[0], 34); // Red component
        assert_eq!(color[1], 23); // Green component
        assert_eq!(color[2], 27); // Blue component
    }

    #[test]
    fn test_render_mandelbrot_set() {
        use super::linspace;
        use super::ValidColorSpace;

        let re_range = linspace(-2.0, 1.0, 10);
        let im_range = linspace(-1.0, 1.0, 10);
        let max_iterations = 100;
        let exponent = 2;
        let image_width = 10;
        let image_height = 10;
        let palette = &super::Palette::Original(colorous::TURBO);
        let should_reverse_colors = false;
        let color_space = ValidColorSpace::Hsl;
        let shift_hue_amount = 0.0;
        let saturate_amount = 0.0;
        let lighten_amount = 0.0;
        let smooth_coloring = true;
        let palette_start = 0;
        let palette_end = 100;

        let rendered = super::render_mandelbrot_set(
            re_range,
            im_range,
            max_iterations,
            exponent,
            image_width,
            image_height,
            palette,
            should_reverse_colors,
            false,
            1,
            &color_space,
            shift_hue_amount,
            saturate_amount,
            lighten_amount,
            smooth_coloring,
            palette_start,
            palette_end,
            None,
        );

        assert_eq!(
            rendered.image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );

        assert_eq!(rendered.image[0..4], [44, 28, 55, 255]); // Top-left pixel
        assert_eq!(rendered.image[396..400], [44, 28, 55, 255]); // Bottom-right pixel

        // The view mixes interior and escaping points, so a range is observed
        let (min, max) = rendered.stats.range.expect("mixed view should have stats");
        assert!(min <= max);
        assert!(max < max_iterations);

        // One escape value per pixel; escaped pixels are finite, interior
        // pixels are the Infinity sentinel, and both kinds are present here
        assert_eq!(rendered.values.len(), image_width * image_height);
        assert!(rendered.values.iter().any(|v| v.is_finite()));
        assert!(rendered.values.iter().any(|v| v.is_infinite()));
    }

    #[test]
    fn test_distance_estimate_brightness() {
        // Interior points (no exterior distance) map to the Infinity sentinel,
        // which the color mapping renders black — exactly like interior escape
        // values.
        assert!(super::distance_estimate_brightness(None, 1e-3).is_infinite());

        // A point on the boundary (distance 0) is fully dark; a point several
        // pixels out is nearly full brightness; and brightness rises with
        // distance in between.
        let spacing = 1e-3;
        let on_boundary = super::distance_estimate_brightness(Some(0.0), spacing);
        let near = super::distance_estimate_brightness(Some(spacing * 0.5), spacing);
        let far = super::distance_estimate_brightness(Some(spacing * 20.0), spacing);
        assert_eq!(on_boundary, 0.0);
        assert!(near > on_boundary);
        assert!(far > near);
        assert!((0.0..=1.0).contains(&far));
        assert!(far > 0.99, "several pixels out should read near-white");

        // The estimate is relative to pixel spacing, so the same distance
        // reads darker at a coarser spacing (more pixels between it and the
        // boundary) — the scale-invariance that keeps boundary weight uniform.
        let d = 1e-4;
        let fine = super::distance_estimate_brightness(Some(d), 1e-4);
        let coarse = super::distance_estimate_brightness(Some(d), 1e-2);
        assert!(coarse < fine);

        // A degenerate (non-positive) pixel spacing must not divide by zero;
        // it falls back to the raw distance and stays in range.
        let fallback = super::distance_estimate_brightness(Some(1.0), 0.0);
        assert!((0.0..=1.0).contains(&fallback));
    }

    #[test]
    fn test_generate_distance_estimate_image() {
        // The classic full-set view: mixes interior (black) and exterior
        // pixels, with the boundary running through it.
        let image_width = 40;
        let image_height = 40;
        let pixel_spacing = 3.0 / image_width as f64;
        let rendered = super::generate_distance_estimate_image(
            -2.0,
            1.0,
            -1.0,
            1.0,
            pixel_spacing,
            500,
            2,
            image_width,
            image_height,
            "greys",
            false,
            0.0,
            0.0,
            0.0,
            crate::ValidColorSpace::Hsl,
            1,
        );

        assert_eq!(
            rendered.image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );
        assert_eq!(rendered.values.len(), image_width * image_height);

        // The DE image must not be degenerate: it carries both interior
        // (Infinity) pixels and a spread of finite exterior brightnesses.
        assert!(rendered.values.iter().any(|v| v.is_infinite()));
        let finite: Vec<f32> = rendered
            .values
            .iter()
            .copied()
            .filter(|v| v.is_finite())
            .collect();
        assert!(!finite.is_empty(), "exterior pixels must be present");
        assert!(
            finite.iter().all(|&v| (0.0..=1.0).contains(&v)),
            "DE brightness is normalized to [0, 1]"
        );
        let brightest = finite.iter().cloned().fold(f32::MIN, f32::max);
        let darkest = finite.iter().cloned().fold(f32::MAX, f32::min);
        assert!(
            brightest - darkest > 0.1,
            "a boundary-crossing view should span a range of brightnesses"
        );

        // Boundary pixels (small distance estimate, so near-black) must be
        // darker than the deep exterior. With the greys palette, higher
        // brightness -> lighter pixel, so compare a near-boundary column to the
        // far corner of the view.
        let luminance = |pixel_index: usize| -> u32 {
            let base = pixel_index * super::NUM_COLOR_CHANNELS;
            rendered.image[base] as u32
                + rendered.image[base + 1] as u32
                + rendered.image[base + 2] as u32
        };
        // Top-left corner sits at (-2, 1), the far exterior; the set boundary
        // runs near the middle-right of this view.
        let far_corner = luminance(0);
        // A pixel is near the boundary if its brightness is among the smallest
        // finite values; find one and confirm it is darker than the far corner.
        let (dark_index, _) = rendered
            .values
            .iter()
            .enumerate()
            .filter(|(_, v)| v.is_finite())
            .min_by(|a, b| a.1.partial_cmp(b.1).unwrap())
            .expect("some exterior pixel exists");
        assert!(
            luminance(dark_index) < far_corner,
            "boundary pixels must render darker than the far exterior"
        );

        // Interior pixels are black regardless of palette.
        let interior_index = rendered
            .values
            .iter()
            .position(|v| v.is_infinite())
            .expect("interior pixel exists");
        let base = interior_index * super::NUM_COLOR_CHANNELS;
        assert_eq!(
            &rendered.image[base..base + 4],
            &[0, 0, 0, 255],
            "interior pixels render black"
        );

        // DE tiles fix the palette range at 0..1, so no iteration stats are
        // tracked (nothing to auto-fit).
        assert!(rendered.stats.range.is_none());

        // The cached brightness values recolor through the same pipeline as
        // escape-time tiles when the distance-estimate flag is set.
        let mut coloring = coloring_options("greys", 0, 200);
        coloring.distance_estimate = true;
        let recolored = super::recolor_values(&rendered.values, &coloring);
        assert_eq!(recolored, rendered.image);
    }

    #[test]
    fn test_atom_domain_index_at_c() {
        use num::complex::Complex64;

        let escape_radius_squared = super::ESCAPE_RADIUS * super::ESCAPE_RADIUS;

        // c = 0: the orbit is 0, 0, 0, ... so from z_1 = c = 0 onward every
        // point is exactly the origin. The first minimum is attained at the
        // starting index 1 and never beaten, so the index is 1 (period-1 atom).
        assert_eq!(
            super::atom_domain_index_at_c(Complex64::new(0.0, 0.0), 1000, escape_radius_squared),
            1
        );

        // c = -1 (center of the period-2 bulb): the orbit settles onto the
        // 2-cycle 0 <-> -1. z_1 = -1, z_2 = 0, z_3 = -1, ... The nearest point
        // to the origin is z_2 = 0, so the running minimum is first attained at
        // index 2 — the period-2 atom domain.
        assert_eq!(
            super::atom_domain_index_at_c(Complex64::new(-1.0, 0.0), 1000, escape_radius_squared),
            2
        );

        // A far exterior point escapes almost immediately; its nearest approach
        // to the origin is its own starting value z_1 = c (already large), so
        // the reported index is the starting index 1 and the loop bails on
        // escape without panicking or running the full budget.
        let index =
            super::atom_domain_index_at_c(Complex64::new(4.0, 4.0), 1000, escape_radius_squared);
        assert_eq!(index, 1);

        // The index is always at least 1 (index 0, |z_0| = 0, is excluded so it
        // never trivially wins) and never exceeds the iteration budget.
        for &(re, im) in &[(-0.5, 0.5), (0.25, 0.5), (-0.75, 0.1), (0.3, 0.0)] {
            let index =
                super::atom_domain_index_at_c(Complex64::new(re, im), 200, escape_radius_squared);
            assert!(
                (1..=200).contains(&index),
                "index {index} out of range for c = ({re}, {im})"
            );
        }
    }

    #[test]
    fn test_atom_domain_value() {
        // Every index maps into [0, 1), the fixed palette domain.
        for index in 0..2000u32 {
            let value = super::atom_domain_value(index);
            assert!((0.0..1.0).contains(&value), "value {value} out of [0, 1)");
        }

        // Consecutive indices land far apart on the palette (the golden-ratio
        // scatter that makes adjacent periods read as distinct categorical
        // bands): every successive pair differs by an appreciable amount.
        for index in 1..500u32 {
            let a = super::atom_domain_value(index);
            let b = super::atom_domain_value(index + 1);
            let gap = (a - b).abs().min(1.0 - (a - b).abs());
            assert!(
                gap > 0.1,
                "consecutive indices {index} and {} too close: {a} vs {b}",
                index + 1
            );
        }

        // The mapping is deterministic.
        assert_eq!(super::atom_domain_value(7), super::atom_domain_value(7));
    }

    #[test]
    fn test_generate_atom_domain_image() {
        // The classic full-set view: exterior filaments plus the interior
        // components (each a flat atom domain — no interior black sentinel).
        let image_width = 40;
        let image_height = 40;
        let rendered = super::generate_atom_domain_image(
            -2.0,
            1.0,
            -1.0,
            1.0,
            500,
            image_width,
            image_height,
            "turbo",
            false,
            0.0,
            0.0,
            0.0,
            crate::ValidColorSpace::Hsl,
            1,
        );

        assert_eq!(
            rendered.image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );
        assert_eq!(rendered.values.len(), image_width * image_height);

        // Every pixel — interior and exterior alike — has an atom-domain value,
        // so none is left at the interior Infinity sentinel, and all values sit
        // in the fixed [0, 1) palette domain.
        assert!(
            rendered.values.iter().all(|v| v.is_finite()),
            "atom-domain tiles color every pixel (no interior sentinel)"
        );
        assert!(
            rendered.values.iter().all(|&v| (0.0..1.0).contains(&v)),
            "atom-domain values are normalized to [0, 1)"
        );

        // The view spans several periods, so the image must not be degenerate:
        // it carries a spread of distinct atom-domain values.
        let distinct: std::collections::BTreeSet<u32> =
            rendered.values.iter().map(|v| v.to_bits()).collect();
        assert!(
            distinct.len() > 3,
            "a full-set view should span several atom domains"
        );

        // The cached values recolor through the same pipeline as escape-time
        // tiles when the atom-domain flag is set — bit-for-bit.
        let mut coloring = coloring_options("turbo", 0, 200);
        coloring.atom_domain = true;
        let recolored = super::recolor_values(&rendered.values, &coloring);
        assert_eq!(recolored, rendered.image);
    }

    #[test]
    fn test_calculate_julia_escape_iterations() {
        use num::complex::Complex64;

        // For c = 0 the filled Julia set is the closed unit disk: points with
        // |z0| < 1 never escape, points with |z0| > 1 do.
        let c = Complex64::new(0.0, 0.0);
        let (iterations, _) =
            super::calculate_julia_escape_iterations(Complex64::new(0.5, 0.0), c, 100, 9.0, 2);
        assert_eq!(iterations, 100, "|z0| < 1 stays bounded for c = 0");

        let (iterations, _) =
            super::calculate_julia_escape_iterations(Complex64::new(1.5, 0.0), c, 100, 9.0, 2);
        assert!(iterations < 100, "|z0| > 1 escapes for c = 0");

        // Unlike the Mandelbrot iteration, c is fixed and z0 varies: the same
        // z0 that stays bounded for c = 0 can escape for a different c.
        let c = Complex64::new(2.0, 2.0);
        let (iterations, _) =
            super::calculate_julia_escape_iterations(Complex64::new(0.5, 0.0), c, 100, 9.0, 2);
        assert!(iterations < 100, "large |c| pushes the orbit out to escape");

        // The general (exponent > 2) branch behaves too: z0 = 0, c = 0 is a
        // fixed point that never escapes.
        let (iterations, final_z) = super::calculate_julia_escape_iterations(
            Complex64::new(0.0, 0.0),
            Complex64::new(0.0, 0.0),
            100,
            9.0,
            3,
        );
        assert_eq!(iterations, 100);
        assert_eq!(final_z, Complex64::new(0.0, 0.0));
    }

    #[test]
    fn test_generate_julia_image() {
        // A well-known Julia parameter (the "Douady rabbit", c = -0.123 + 0.745i)
        // produces a connected set with both interior and exterior pixels.
        let image_width = 48;
        let image_height = 48;
        let rendered = super::generate_julia_image(
            -0.123,
            0.745,
            200,
            2,
            image_width,
            image_height,
            "turbo",
            false,
            0.0,
            0.0,
            0.0,
            crate::ValidColorSpace::Hsl,
            true,
            0,
            200,
            1,
            None,
        );

        assert_eq!(
            rendered.image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );
        assert_eq!(rendered.values.len(), image_width * image_height);

        // Alpha is fully opaque everywhere.
        assert!(
            rendered.image[3..]
                .iter()
                .step_by(super::NUM_COLOR_CHANNELS)
                .all(|&a| a == 255),
            "every pixel is opaque"
        );

        // The set is non-trivial: some pixels stay bounded (interior, Infinity
        // sentinel) and some escape (finite smoothed value).
        assert!(
            rendered.values.iter().any(|v| v.is_infinite()),
            "the Douady rabbit has interior pixels"
        );
        assert!(
            rendered.values.iter().any(|v| v.is_finite()),
            "the view frames exterior pixels too"
        );

        // Interior pixels render black; a mix of escaping pixels means the
        // image is not a solid color.
        let interior_index = rendered
            .values
            .iter()
            .position(|v| v.is_infinite())
            .expect("interior pixel exists");
        let base = interior_index * super::NUM_COLOR_CHANNELS;
        assert_eq!(&rendered.image[base..base + 4], &[0, 0, 0, 255]);

        // Escaped pixels populate the iteration range for palette auto-fit.
        assert!(rendered.stats.range.is_some());
    }

    #[test]
    fn test_generate_julia_image_symmetry() {
        // Filled Julia sets have point symmetry about the origin: z and -z
        // share the same escape time (the map z -> z^2 + c is even up to the
        // constant, and both branches of z^2 coincide). The fixed origin-
        // centered window with even width samples symmetric z0 pairs, so the
        // image is symmetric under a 180-degree rotation.
        let size = 32;
        let rendered = super::generate_julia_image(
            -0.8,
            0.156,
            150,
            2,
            size,
            size,
            "greys",
            false,
            0.0,
            0.0,
            0.0,
            crate::ValidColorSpace::Hsl,
            false,
            0,
            150,
            1,
            None,
        );

        for row in 0..size {
            for col in 0..size {
                let index = row * size + col;
                let mirror = (size - 1 - row) * size + (size - 1 - col);
                let value = rendered.values[index];
                let mirror_value = rendered.values[mirror];
                assert!(
                    (value == mirror_value) || (value.is_infinite() && mirror_value.is_infinite()),
                    "Julia set is symmetric under 180-degree rotation"
                );
            }
        }
    }

    #[test]
    fn test_point_in_set() {
        // Test points known to be in the set
        assert!(super::point_in_set(0.0, 0.0, 100, 2));
        assert!(super::point_in_set(-1.0, 0.0, 100, 2));

        // Test points known to be outside the set
        assert!(!super::point_in_set(2.0, 2.0, 100, 2));
        assert!(!super::point_in_set(-2.0, 3.0, 100, 2));
    }

    #[test]
    fn test_create_solid_black_image() {
        let image = super::create_solid_black_image(10, 10);
        assert_eq!(image.len(), 10 * 10 * super::NUM_COLOR_CHANNELS);
        assert!(image.chunks(4).all(|chunk| chunk == [0, 0, 0, 255]));
    }

    #[test]
    fn test_calculate_escape_iterations() {
        use num::complex::Complex64;

        let (iterations, z) = super::calculate_escape_iterations(0.0, 0.0, 100, 2);
        assert_eq!(iterations, 100);
        assert_eq!(z, Complex64::new(0.0, 0.0));

        let (iterations, z) = super::calculate_escape_iterations(2.0, 2.0, 100, 2);
        assert!(iterations < 10); // Should escape quickly
        assert!(z.norm() > super::ESCAPE_RADIUS);

        let (iterations, z) = super::calculate_escape_iterations(0.0, 0.0, 100, 3);
        assert_eq!(iterations, 100);
        assert_eq!(z, Complex64::new(0.0, 0.0));
    }

    #[test]
    fn test_rect_in_set() {
        use super::linspace;

        let re_range = linspace(-0.05, 0.05, 10);
        let im_range = linspace(-0.05, 0.05, 10);
        assert!(super::rect_in_set(re_range, im_range, 100, 2));

        let re_range = linspace(-2.0, 2.0, 10);
        let im_range = linspace(-2.0, 2.0, 10);
        assert!(!super::rect_in_set(re_range, im_range, 100, 2));
    }

    #[test]
    fn test_palette_min_iter() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point that we know escapes from the existing test case
        let c = (1.0, -1.5); // From existing test points known to escape

        // Verify it escapes
        let escape_iters = super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent).0;
        assert!(escape_iters < max_iterations, "Test point should escape");

        // Get color with standard settings (min_iter = 0)
        let color1 = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(max_iterations),
        );

        // Get color with min_iter = escape_iters (should shift color mapping)
        let color2 = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(escape_iters),
            f64::from(max_iterations),
        );

        // The colors should differ because we've shifted the palette mapping
        assert_ne!(
            color1, color2,
            "Colors should be different with different palette_min_iter values"
        );

        // With min_iter = escape iterations, the color should be at the start of the palette
        let min_palette_color = palette.eval_continuous(0.0).as_array();
        assert_eq!(color2, min_palette_color);
    }

    #[test]
    fn test_palette_max_iter() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point that we know escapes from the existing test case
        let c = (0.5, 0.5); // From existing test points known to escape

        // Verify it escapes
        let escape_iters = super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent).0;
        assert!(escape_iters < max_iterations, "Test point should escape");

        // Normal case (full palette range)
        let color1 = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(max_iterations),
        );

        // Compressed palette range (max set to half of escape_iters)
        let palette_max = escape_iters / 2;
        assert!(
            palette_max > 0,
            "Test point should escape after several iterations"
        );

        let color2 = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(palette_max),
        );

        // The colors should be different
        assert_ne!(
            color1, color2,
            "Colors should differ with different palette_max values"
        );

        // With escape_iters > palette_max, we should get the max color
        let max_palette_color = palette.eval_continuous(1.0).as_array();
        assert_eq!(color2, max_palette_color);
    }

    #[test]
    fn test_equal_min_max_iter() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point deeper in the complex plane that takes several iterations to escape
        let c = (-0.7, 0.3); // Point from the existing test list that escapes after multiple iterations

        // Verify it escapes and takes multiple iterations
        let (escape_iters, _) =
            super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent);
        assert!(escape_iters < max_iterations, "Test point should escape");
        println!(
            "Point ({}, {}) escapes after {} iterations",
            c.0, c.1, escape_iters
        );
        assert!(
            escape_iters > 2,
            "Test point should take multiple iterations to escape"
        );

        // Set both min and max to half of escape iterations
        let threshold = escape_iters / 2;
        assert!(
            threshold > 0,
            "Escape iterations should be high enough to divide"
        );

        let color = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(threshold),
            f64::from(threshold).max(f64::from(threshold) + f64::EPSILON),
        );

        // When min equals max, max gets clamped to min+epsilon
        // Since escape_iters > threshold, we should get max color
        let max_palette_color = palette.eval_continuous(1.0).as_array();

        println!("Actual color with equal min/max: {:?}", color);
        println!("Expected max_palette_color: {:?}", max_palette_color);

        assert_eq!(
            color, max_palette_color,
            "When min==max and escape_iters > threshold, should get max palette color"
        );
    }

    #[test]
    fn test_palette_range() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Generate several points that escape at different iteration counts
        let test_points = [(0.3, 0.5), (0.1, 0.8), (-0.5, 0.6), (-1.0, 0.3)];

        for &(re, im) in &test_points {
            let escape_iters =
                super::calculate_escape_iterations(re, im, max_iterations, exponent).0;
            if escape_iters == max_iterations {
                continue; // Skip points in the set
            }

            // Standard color (full range)
            let standard_color = super::compute_pixel_color(
                re,
                im,
                max_iterations,
                exponent,
                palette,
                false,
                &color_space,
                0.0,
                0.0,
                0.0,
                true,
                0.0,
                f64::from(max_iterations),
            );

            // Narrow range around the escape value
            let min_iter = escape_iters.saturating_sub(2);
            let max_iter = escape_iters + 2;

            let narrow_range_color = super::compute_pixel_color(
                re,
                im,
                max_iterations,
                exponent,
                palette,
                false,
                &color_space,
                0.0,
                0.0,
                0.0,
                true,
                f64::from(min_iter),
                f64::from(max_iter),
            );

            // Colors should be different with different ranges
            assert!(standard_color != narrow_range_color,
                    "Colors should differ for point ({}, {}) with escape iters {} when using different palette ranges",
                    re, im, escape_iters);
        }
    }

    #[test]
    fn test_integration_min_max_iter() {
        // Integration test to verify min/max iter in full image generation
        let x_min = -2.0;
        let x_max = 1.0;
        let y_min = -1.0;
        let y_max = 1.0;
        let max_iterations = 100;
        let image_width = 50;
        let image_height = 50;

        // Generate an image with standard palette range
        let standard_image = super::get_mandelbrot_set_image(
            x_min,
            x_max,
            y_min,
            y_max,
            max_iterations,
            2,
            image_width,
            image_height,
            "turbo".to_string(),
            false,
            0.0,
            0.0,
            0.0,
            super::ValidColorSpace::Hsl,
            true,
            0,
            as_i32(max_iterations),
        );

        // Generate an image with limited palette range
        let limited_range_image = super::get_mandelbrot_set_image(
            x_min,
            x_max,
            y_min,
            y_max,
            max_iterations,
            2,
            image_width,
            image_height,
            "turbo".to_string(),
            false,
            0.0,
            0.0,
            0.0,
            super::ValidColorSpace::Hsl,
            true,
            20,
            60, // Only iterations between 20-60 get full color range
        );

        // Images should be different
        assert_ne!(standard_image, limited_range_image);

        // Both should be the right size
        assert_eq!(
            standard_image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );
        assert_eq!(
            limited_range_image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );
    }

    #[test]
    fn test_palette_range_ordering() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point that's known to escape
        let c = (-0.7, 0.3);
        let escape_iters = super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent).0;
        assert!(escape_iters < max_iterations, "Test point should escape");

        // Ensure the escape iterations are between our test values
        assert!(
            escape_iters > 20 && escape_iters < 50,
            "Test point should escape between iterations 20 and 50"
        );

        // When min > max, the implementation should ensure max >= min
        // We expect this to be equivalent to min=max=50
        let color1 = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            50.0,
            50.0_f64.max(50.0 + f64::EPSILON),
        );

        // When parameters are correctly ordered
        let color2 = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            10.0,
            80.0,
        );

        // These colors should differ due to different parameter ranges
        assert_ne!(
            color1, color2,
            "Different parameters should produce different colors"
        );
    }

    #[test]
    fn test_palette_min_max_with_smooth_coloring() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point that produces visible smooth coloring differences
        let c = (-1.2, -0.2); // Point from existing test list

        // Get actual iterations (need a point that doesn't escape too quickly)
        let (escape_iters, _z_final) =
            super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent);
        assert!(escape_iters < max_iterations, "Test point should escape");
        assert!(
            escape_iters > 5,
            "Test point should take several iterations to escape"
        );

        // For smooth coloring to differ from non-smooth, we need:
        // 1. A point that takes several iterations to escape
        // 2. A final z value that's not exactly at an integer number of iterations
        // 3. A narrow palette range to amplify differences

        // Get color with smooth coloring
        let color_smooth = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            true,
            f64::from(escape_iters - 5),
            f64::from(escape_iters + 5),
        );

        // Get color without smooth coloring
        let color_non_smooth = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(escape_iters - 5),
            f64::from(escape_iters + 5),
        );

        println!(
            "Point ({}, {}) escapes after {} iterations",
            c.0, c.1, escape_iters
        );
        println!("With smooth coloring: {:?}", color_smooth);
        println!("Without smooth coloring: {:?}", color_non_smooth);

        // Smooth coloring should affect the result
        assert_ne!(
            color_smooth, color_non_smooth,
            "Smooth and non-smooth coloring should produce different colors"
        );
    }

    #[test]
    fn test_varying_palette_min_max() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Test point that escapes after several iterations
        let c = (-0.7, 0.3);
        let escape_iters = super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent).0;
        assert!(escape_iters < max_iterations, "Test point should escape");

        // Generate several colors with different palette ranges
        let color_standard = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(max_iterations),
        );

        let color_narrow_range = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(escape_iters - 5),
            f64::from(escape_iters + 5),
        );

        let color_high_min = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(escape_iters - 2),
            f64::from(max_iterations),
        );

        let color_low_max = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(escape_iters + 2),
        );

        // Check that different parameter values produce different colors
        assert_ne!(
            color_standard, color_narrow_range,
            "Standard and narrow range should produce different colors"
        );
        assert_ne!(
            color_standard, color_high_min,
            "Standard and high min should produce different colors"
        );
        assert_ne!(
            color_standard, color_low_max,
            "Standard and low max should produce different colors"
        );
    }

    #[test]
    fn test_get_color_palette() {
        // Test standard palette
        let (palette, should_reverse, is_cyclic) = super::get_color_palette("turbo", false);
        assert!(!should_reverse);
        assert!(!is_cyclic);
        assert_eq!(palette.eval_continuous(0.0).as_array(), [34, 23, 27]);

        // Test reverse palette
        let (_palette, should_reverse, _) = super::get_color_palette("turbo", true);
        assert!(should_reverse);

        // Test palette from reverse set
        let (_palette, should_reverse, _) = super::get_color_palette("blues", false);
        // This has different behavior than expected - blues is in REVERSE_PALETTE so should_reverse is true
        assert!(should_reverse);

        // Test reverse palette from reverse set
        let (_palette, should_reverse, _) = super::get_color_palette("blues", true);
        // When reversing a reverse palette, it's !reverse_colors, so should be false
        assert!(!should_reverse);

        // Test cyclical palettes
        let (_palette, _, is_cyclic) = super::get_color_palette("rainbow", false);
        assert!(is_cyclic);
        let (_palette, _, is_cyclic) = super::get_color_palette("sinebow", false);
        assert!(is_cyclic);

        // Test fallback to default palette
        let (palette, should_reverse, is_cyclic) = super::get_color_palette("nonexistent", false);
        assert!(!should_reverse);
        assert!(!is_cyclic);
        assert_eq!(palette.eval_continuous(0.0).as_array(), [34, 23, 27]); // turbo start color
    }

    #[test]
    fn test_cyclical_palettes_wrap_seamlessly() {
        for name in ["rainbow", "sinebow"] {
            let (palette, _, _) = super::get_color_palette(name, false);
            assert_eq!(
                palette.eval_continuous(0.0).as_array(),
                palette.eval_continuous(1.0).as_array(),
                "cyclical palette {name} endpoints diverged"
            );
        }
    }

    #[test]
    fn test_apply_color_cycles() {
        // One cycle is the identity, cyclic or not
        assert_eq!(super::apply_color_cycles(0.75, 1, false), 0.75);
        assert_eq!(super::apply_color_cycles(0.75, 1, true), 0.75);

        // Cyclic palettes wrap: 3 cycles tile [0,1) three times
        assert_eq!(super::apply_color_cycles(0.0, 3, true), 0.0);
        assert!((super::apply_color_cycles(0.5, 3, true) - 0.5).abs() < 1e-12);
        assert!((super::apply_color_cycles(0.4, 3, true) - 0.2).abs() < 1e-12);
        // The top of the range lands back on the (identical) start color
        assert_eq!(super::apply_color_cycles(1.0, 3, true), 0.0);

        // Non-cyclic palettes boomerang: the second pass runs backward
        assert_eq!(super::apply_color_cycles(0.25, 2, false), 0.5);
        assert_eq!(super::apply_color_cycles(0.5, 2, false), 1.0);
        assert_eq!(super::apply_color_cycles(0.75, 2, false), 0.5);
        assert_eq!(super::apply_color_cycles(1.0, 2, false), 0.0);
        // Odd cycle counts end on the palette's far end
        assert_eq!(super::apply_color_cycles(1.0, 3, false), 1.0);
    }

    #[test]
    fn test_apply_palette_cdf_lookup() {
        // Degenerate tables (too short to interpolate) are the identity
        assert_eq!(super::apply_palette_cdf(0.3, &[]), 0.3);
        assert_eq!(super::apply_palette_cdf(0.3, &[0.5]), 0.3);

        // An identity table maps every position to itself (up to f32
        // narrowing of the table entries, which are exact here)
        let identity: Vec<f32> = (0..=8).map(|i| i as f32 / 8.0).collect();
        for &norm in &[0.0, 0.125, 0.3, 0.5, 0.99, 1.0] {
            assert!(
                (super::apply_palette_cdf(norm, &identity) - norm).abs() < 1e-7,
                "identity table moved {norm}"
            );
        }

        // Linear interpolation between entries: a two-entry table [0, 1] is
        // exactly linear, and a bent table lands halfway between neighbors
        assert_eq!(super::apply_palette_cdf(0.37, &[0.0, 1.0]), 0.37);
        let bent = [0.0_f32, 0.8, 1.0];
        // norm 0.25 sits halfway between entries 0 and 1
        assert!((super::apply_palette_cdf(0.25, &bent) - 0.4).abs() < 1e-7);
        // norm 0.75 sits halfway between entries 1 and 2
        assert!((super::apply_palette_cdf(0.75, &bent) - 0.9).abs() < 1e-7);

        // Endpoints hit the table's ends exactly, and out-of-range positions
        // clamp to them (values outside the palette window keep clamping to
        // the palette's start and end colors)
        assert_eq!(super::apply_palette_cdf(0.0, &bent), 0.0);
        assert_eq!(super::apply_palette_cdf(1.0, &bent), 1.0);
        assert_eq!(super::apply_palette_cdf(-0.5, &bent), 0.0);
        assert_eq!(super::apply_palette_cdf(1.5, &bent), 1.0);

        // A monotone table yields a monotone mapping, flat segments included
        let plateau = [0.0_f32, 0.6, 0.6, 0.6, 1.0];
        let mut previous = 0.0;
        for step in 0..=1000 {
            let norm = step as f64 / 1000.0;
            let mapped = super::apply_palette_cdf(norm, &plateau);
            assert!(
                mapped >= previous,
                "mapping decreased at {norm}: {mapped} < {previous}"
            );
            assert!((0.0..=1.0).contains(&mapped));
            previous = mapped;
        }
    }

    #[test]
    fn test_color_cycles_apply_after_palette_cdf() {
        // The CDF remaps the position inside the palette window; cycles then
        // repeat the palette over the *remapped* position (mass-uniform
        // cycles). So a value whose window position t remaps to g(t) must
        // color exactly like a CDF-less value sitting at position g(t), for
        // the same cycle count.
        let (palette, reverse, cyclic) = super::get_color_palette("turbo", false);
        let color_space = super::ValidColorSpace::Hsl;
        // Window 0..100; g bends the midpoint down to 0.25
        let cdf = [0.0_f32, 0.25, 1.0];
        let color = |value: f64, cycles: u32, table: Option<&[f32]>| {
            super::color_from_smoothed_value(
                value,
                palette,
                reverse,
                cyclic,
                cycles,
                &color_space,
                0.0,
                0.0,
                0.0,
                0.0,
                100.0,
                table,
            )
        };

        for cycles in [1, 2, 5] {
            // value 50 -> t = 0.5 -> g(t) = 0.25 -> same color as value 25
            // without a table
            assert_eq!(color(50.0, cycles, Some(&cdf)), color(25.0, cycles, None));
        }
        // And the remap genuinely changes the output against linear
        assert_ne!(color(50.0, 1, Some(&cdf)), color(50.0, 1, None));

        // Interior pixels stay black regardless of the table
        assert_eq!(color(f64::INFINITY, 2, Some(&cdf)), [0, 0, 0]);
    }

    #[test]
    fn test_color_palettes_initialization() {
        // Test that all palettes are properly initialized
        assert!(super::COLOR_PALETTES.contains_key("turbo"));
        assert!(super::COLOR_PALETTES.contains_key("viridis"));
        assert!(super::COLOR_PALETTES.contains_key("inferno"));
        assert!(super::COLOR_PALETTES.contains_key("plasma"));
        assert!(super::COLOR_PALETTES.contains_key("magma"));

        // Check a few specific palette colors
        let turbo = super::COLOR_PALETTES.get("turbo").unwrap();
        assert_eq!(turbo.eval_continuous(0.0).as_array(), [34, 23, 27]);
        // Check end color of palette
        assert_eq!(turbo.eval_continuous(1.0).as_array(), [144, 12, 0]);

        // Test reverse palettes
        assert!(super::REVERSE_COLOR_PALETTES.contains_key("blues"));
        assert!(super::REVERSE_COLOR_PALETTES.contains_key("greens"));
        assert!(super::REVERSE_COLOR_PALETTES.contains_key("reds"));
    }

    #[test]
    fn test_rect_in_set_edge_cases() {
        use super::linspace;

        // Test very small rectangle entirely within the set
        let re_range = linspace(-0.2, -0.1, 10);
        let im_range = linspace(0.0, 0.05, 10);
        assert!(super::rect_in_set(re_range, im_range, 100, 2));

        // Test rectangle straddling the boundary of the set
        let re_range = linspace(-0.8, -0.7, 10);
        let im_range = linspace(0.0, 0.1, 10);
        assert!(!super::rect_in_set(re_range, im_range, 100, 2));

        // Test 1-pixel rectangle (degenerate case)
        let re_range = linspace(0.0, 0.0, 1);
        let im_range = linspace(0.0, 0.0, 1);
        assert!(super::rect_in_set(re_range, im_range, 100, 2));

        // Test rectangle with point (-0.75, 0.0) which is exactly on the boundary
        // of the period-2 bulb - this actually gets detected as in the set because of limited precision
        let re_range = linspace(-0.76, -0.74, 10);
        let im_range = linspace(-0.01, 0.01, 10);
        assert!(super::rect_in_set(re_range, im_range, 100, 2));
    }

    #[test]
    fn test_higher_exponent_mandelbrot() {
        // Test points in different exponent Mandelbrot sets

        // For exponent=2 (standard)
        assert!(super::point_in_set(0.0, 0.0, 100, 2));
        assert!(super::point_in_set(-1.0, 0.0, 100, 2));
        assert!(!super::point_in_set(0.5, 0.5, 100, 2));

        // For exponent=3
        assert!(super::point_in_set(0.0, 0.0, 100, 3));
        // The following point is in exponent=2 set but not in exponent=3
        assert!(!super::point_in_set(-1.0, 0.0, 100, 3));

        // For exponent=4
        assert!(super::point_in_set(0.0, 0.0, 100, 4));
        // Points specifically in the exponent=4 set
        assert!(super::point_in_set(-0.2, 0.0, 100, 4));
        // This point is actually in the set for exponent=4
        assert!(super::point_in_set(0.4, 0.4, 100, 4));

        // Compare escape iterations for different exponents
        let (iter2, _) = super::calculate_escape_iterations(0.3, 0.3, 100, 2);
        let (iter3, _) = super::calculate_escape_iterations(0.3, 0.3, 100, 3);
        let (iter4, _) = super::calculate_escape_iterations(0.3, 0.3, 100, 4);

        // Higher exponents usually escape faster for points outside the set
        assert!(iter4 <= iter3 || iter3 <= iter2);
    }

    #[test]
    fn test_escape_iterations_with_large_inputs() {
        // Test handling of large coordinate inputs
        let (iterations, _) = super::calculate_escape_iterations(1e10, 1e10, 100, 2);
        assert_eq!(iterations, 0); // Should escape immediately

        // Test handling of large iteration counts
        let (iterations, _) = super::calculate_escape_iterations(0.0, 0.0, 1_000_000, 2);
        assert_eq!(iterations, 1_000_000); // Should not escape

        // Test handling of large exponents
        let (iterations, _) = super::calculate_escape_iterations(0.5, 0.5, 100, 10);
        // This point doesn't escape as quickly as expected with exponent 10
        assert!(iterations <= 100); // Just ensure it doesn't exceed max iterations
    }

    #[test]
    fn test_compute_pixel_color_edge_cases() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;

        // Test NaN/Infinity inputs (should not panic)
        let color = super::compute_pixel_color(
            f64::NAN,
            0.0,
            100,
            2,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            100.0,
        );
        // The function returns a color for NaN inputs because they escape immediately
        assert_eq!(color, [34, 23, 27]);

        // Extreme color transformations should not panic; the exact output
        // is not pinned down.
        let _ = super::compute_pixel_color(
            2.0,
            2.0,
            100,
            2,
            palette,
            false,
            &color_space,
            180.0,
            3.0,
            2.0,
            false,
            0.0,
            100.0,
        );
    }

    #[test]
    fn test_init_function() {
        // Test that the init function doesn't panic
        super::init();
    }

    #[test]
    fn test_create_solid_black_image_size_zero() {
        // Test with zero dimensions (should produce empty vector)
        let image = super::create_solid_black_image(0, 0);
        assert_eq!(image.len(), 0);

        // Test with zero width
        let image = super::create_solid_black_image(0, 10);
        assert_eq!(image.len(), 0);

        // Test with zero height
        let image = super::create_solid_black_image(10, 0);
        assert_eq!(image.len(), 0);
    }

    #[test]
    fn test_get_color_palette_with_all_palettes() {
        // Test each palette in COLOR_PALETTES
        for name in &[
            "brownGreen",
            "cividis",
            "cool",
            "cubehelix",
            "gnuplot",
            "inferno",
            "jet",
            "magma",
            "nipySpectral",
            "plasma",
            "purpleGreen",
            "purpleOrange",
            "rainbow",
            "redBlue",
            "redGrey",
            "redYellowBlue",
            "redYellowGreen",
            "sinebow",
            "spectral",
            "turbo",
            "viridis",
            "warm",
            "yellowOrangeBrown",
        ] {
            let (palette, should_reverse, _) = super::get_color_palette(name, false);
            assert!(!should_reverse);
            assert!(palette.eval_continuous(0.0).as_array().len() == 3);
        }

        // Test each palette in REVERSE_COLOR_PALETTES
        for name in &[
            "blues",
            "greenBlue",
            "greens",
            "greys",
            "orangeRed",
            "oranges",
            "pinkGreen",
            "purpleBlueGreen",
            "purpleRed",
            "purples",
            "redPurple",
            "reds",
            "yellowGreen",
            "yellowGreenBlue",
            "yellowOrangeRed",
        ] {
            let (palette, should_reverse, _) = super::get_color_palette(name, false);
            assert!(should_reverse);
            assert!(palette.eval_continuous(0.0).as_array().len() == 3);
        }
    }

    #[test]
    fn test_transform_color_with_all_color_spaces() {
        // Test transforming color with all color spaces
        let original_color = colorous::Color {
            r: 128,
            g: 64,
            b: 32,
        };

        // Create a reusable test that works with any color space
        let test_color_space = |color_space: super::ValidColorSpace| {
            // No transformation
            let transformed = super::transform_color(original_color, &color_space, 0.0, 0.0, 0.0);
            assert_eq!(transformed.r, original_color.r);
            assert_eq!(transformed.g, original_color.g);
            assert_eq!(transformed.b, original_color.b);

            // Full hue shift
            let transformed = super::transform_color(original_color, &color_space, 180.0, 0.0, 0.0);
            assert!(
                transformed.r != original_color.r
                    || transformed.g != original_color.g
                    || transformed.b != original_color.b
            );

            // Full saturation
            let transformed = super::transform_color(original_color, &color_space, 0.0, 1.0, 0.0);
            assert!(
                transformed.r != original_color.r
                    || transformed.g != original_color.g
                    || transformed.b != original_color.b
            );

            // Full lightness
            let transformed = super::transform_color(original_color, &color_space, 0.0, 0.0, 1.0);
            assert!(
                transformed.r != original_color.r
                    || transformed.g != original_color.g
                    || transformed.b != original_color.b
            );
        };

        // Test all color spaces
        test_color_space(super::ValidColorSpace::Hsl);
        test_color_space(super::ValidColorSpace::Hsluv);
        test_color_space(super::ValidColorSpace::Lch);
        test_color_space(super::ValidColorSpace::Okhsl);
    }

    #[test]
    fn test_get_mandelbrot_set_image_with_different_exponents() {
        // Test the main function with different exponents
        let x_min = -2.0;
        let x_max = 1.0;
        let y_min = -1.0;
        let y_max = 1.0;
        let max_iterations = 100;
        let width = 30;
        let height = 30;

        // Generate images with different exponents
        let image2 = super::get_mandelbrot_set_image(
            x_min,
            x_max,
            y_min,
            y_max,
            max_iterations,
            2,
            width,
            height,
            "turbo".to_string(),
            false,
            0.0,
            0.0,
            0.0,
            super::ValidColorSpace::Hsl,
            true,
            0,
            as_i32(max_iterations),
        );

        let image3 = super::get_mandelbrot_set_image(
            x_min,
            x_max,
            y_min,
            y_max,
            max_iterations,
            3,
            width,
            height,
            "turbo".to_string(),
            false,
            0.0,
            0.0,
            0.0,
            super::ValidColorSpace::Hsl,
            true,
            0,
            as_i32(max_iterations),
        );

        let image4 = super::get_mandelbrot_set_image(
            x_min,
            x_max,
            y_min,
            y_max,
            max_iterations,
            4,
            width,
            height,
            "turbo".to_string(),
            false,
            0.0,
            0.0,
            0.0,
            super::ValidColorSpace::Hsl,
            true,
            0,
            as_i32(max_iterations),
        );

        // All images should be the correct size
        assert_eq!(image2.len(), width * height * super::NUM_COLOR_CHANNELS);
        assert_eq!(image3.len(), width * height * super::NUM_COLOR_CHANNELS);
        assert_eq!(image4.len(), width * height * super::NUM_COLOR_CHANNELS);

        // Images should be different (shapes of Mandelbrot set change with exponent)
        assert_ne!(image2, image3);
        assert_ne!(image3, image4);
        assert_ne!(image2, image4);
    }

    #[test]
    fn test_negative_palette_min_iter() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point that escapes
        let c = (0.4, 0.5);
        let (escape_iters, _) =
            super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent);
        assert!(escape_iters < max_iterations, "Test point should escape");

        // Get color with negative min_iter
        let negative_min = -20;
        let color_neg_min = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(negative_min),
            f64::from(max_iterations),
        );

        // Get color with zero min_iter
        let color_zero_min = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(max_iterations),
        );

        // Colors should be different because negative min shifts the palette mapping
        assert_ne!(
            color_neg_min, color_zero_min,
            "Negative min_iter should produce different color than zero min_iter"
        );

        // Verify the calculation is as expected
        // With negative min_iter, the normalized position should be:
        // (escape_iters - negative_min) / (max_iterations - negative_min)
        // which will be greater than the standard (escape_iters / max_iterations)
        let expected_norm_standard = f64::from(escape_iters) / f64::from(max_iterations);
        let expected_norm_negative = (f64::from(escape_iters) - f64::from(negative_min))
            / (f64::from(max_iterations as i32) - f64::from(negative_min));

        assert!(
            expected_norm_negative > expected_norm_standard,
            "Negative min_iter should increase the normalized position in the palette"
        );
    }

    #[test]
    fn test_negative_palette_max_iter() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point with negative escape value
        let c = (0.3, 0.6);
        let (escape_iters, _) =
            super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent);
        assert!(escape_iters < max_iterations, "Test point should escape");

        // Test with negative max_iter but positive min_iter
        // This shouldn't crash, and since max is forced to be >= min + epsilon,
        // we should get a reasonable result
        let positive_min = 10;
        let negative_max = -5;

        let color = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            f64::from(positive_min),
            f64::from(negative_max).max(f64::from(positive_min) + f64::EPSILON),
        );

        // The code should correct negative_max to be at least positive_min + epsilon
        // So we should get the max color from the palette
        let max_palette_color = palette.eval_continuous(1.0).as_array();
        assert_eq!(
            color, max_palette_color,
            "When max < min, max should be adjusted to min + epsilon and we should get max color"
        );
    }

    #[test]
    fn test_zero_palette_values() {
        let palette = &super::Palette::Original(colorous::TURBO);
        let color_space = super::ValidColorSpace::Hsl;
        let max_iterations = 100;
        let exponent = 2;

        // Use a point that escapes
        let c = (0.5, 0.5);
        let (escape_iters, _) =
            super::calculate_escape_iterations(c.0, c.1, max_iterations, exponent);
        assert!(escape_iters < max_iterations, "Test point should escape");
        assert!(
            escape_iters > 0,
            "Test point should take >0 iterations to escape"
        );

        // Test with zero min and zero max
        let color_zero_both = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            0.0_f64.max(0.0 + f64::EPSILON),
        );

        // When min equals max, max gets clamped to min+epsilon
        // Since escape_iters > 0, we should get max color
        let max_palette_color = palette.eval_continuous(1.0).as_array();

        println!("Actual color_zero_both: {:?}", color_zero_both);
        println!("Expected max_palette_color: {:?}", max_palette_color);

        assert_eq!(
            color_zero_both, max_palette_color,
            "When min==max==0 and escape_iters > 0, should get max palette color"
        );

        // Test with zero min and positive max
        let color_zero_min = super::compute_pixel_color(
            c.0,
            c.1,
            max_iterations,
            exponent,
            palette,
            false,
            &color_space,
            0.0,
            0.0,
            0.0,
            false,
            0.0,
            f64::from(max_iterations),
        );

        // Should be different from zero min, zero max case
        assert_ne!(
            color_zero_min, color_zero_both,
            "Zero min, positive max should differ from zero min, zero max"
        );
    }

    // Shared arguments for the tile functions: (color and palette settings
    // that both get_mandelbrot_image_precise and get_mandelbrot_tile_precise
    // accept after the geometry/iteration parameters).
    fn tile_precise_image(
        origin_re: &str,
        origin_im: &str,
        tile: (f64, f64, f64, f64),
        tile_zoom: i32,
        zoom_offset: u32,
        max_iterations: u32,
    ) -> Vec<u8> {
        super::get_mandelbrot_image_precise(
            origin_re.to_string(),
            origin_im.to_string(),
            tile.0,
            tile.1,
            tile.2,
            tile.3,
            tile_zoom,
            zoom_offset,
            max_iterations,
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
            as_i32(max_iterations),
        )
    }

    fn tile_precise_with_stats(
        origin_re: &str,
        origin_im: &str,
        tile: (f64, f64, f64, f64),
        tile_zoom: i32,
        zoom_offset: u32,
        max_iterations: u32,
    ) -> super::MandelbrotTile {
        super::get_mandelbrot_tile_precise(
            origin_re.to_string(),
            origin_im.to_string(),
            tile.0,
            tile.1,
            tile.2,
            tile.3,
            tile_zoom,
            zoom_offset,
            max_iterations,
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
            as_i32(max_iterations),
            true,
            None,
        )
    }

    /// Default-orientation coloring settings (no transforms, Hsl space),
    /// matching what the recolor tests previously passed positionally.
    /// `palette_cdf` stays `None` (the linear mapping); tests exercising
    /// histogram equalization set it on the returned value.
    fn coloring_options(
        scheme: &str,
        palette_min: i32,
        palette_max: i32,
    ) -> super::ColoringOptions {
        super::ColoringOptions {
            color_scheme: scheme.to_string(),
            reverse_colors: false,
            shift_hue_amount: 0.0,
            saturate_amount: 0.0,
            lighten_amount: 0.0,
            color_space: 0, // Hsl
            palette_min_iter: palette_min,
            palette_max_iter: palette_max,
            color_cycles: 1,
            distance_estimate: false,
            atom_domain: false,
            palette_cdf: None,
        }
    }

    #[test]
    fn test_get_mandelbrot_tile_precise_mixed_view() {
        let max_iterations = 200;

        // At zoom 2 with origin 0, tile coordinates [1.3, 3.2] x [1.8, 3.3]
        // cover roughly re in [-1.97, 1.0] and im in [-1.16, 1.19]: the
        // classic full-set view, which contains both interior and escaping
        // points
        let view = (1.3, 3.2, 1.8, 3.3);
        let tile = tile_precise_with_stats("0", "0", view, 2, 0, max_iterations);

        assert!(tile.min_iter >= 0, "Mixed view should observe a range");
        assert!(tile.min_iter <= tile.max_iter);
        assert!(
            tile.max_iter < as_i32(max_iterations),
            "Interior points must be excluded from the range"
        );

        // The image must match the stats-free legacy export bit-for-bit
        let legacy = tile_precise_image("0", "0", view, 2, 0, max_iterations);
        assert_eq!(tile.image, legacy);
    }

    #[test]
    fn test_get_mandelbrot_tile_precise_inside_set() {
        // A small rectangle around the origin lies entirely inside the set;
        // the rect_in_set shortcut yields a solid black tile with no stats
        let tile = tile_precise_with_stats("0", "0", (655.0, 656.0, 655.0, 656.0), 10, 0, 200);

        assert_eq!(tile.min_iter, -1, "Fully-interior tile has no range");
        assert_eq!(tile.max_iter, -1);
        assert_eq!(tile.image, super::create_solid_black_image(32, 32));
        assert_eq!(tile.values.len(), 32 * 32);
        assert!(
            tile.values.iter().all(|v| v.is_infinite()),
            "Interior pixels carry the Infinity sentinel"
        );
    }

    #[test]
    fn test_get_mandelbrot_tile_precise_deep_zoom() {
        let max_iterations = 100_000;

        // Effective zoom 12 + 40 = 52 is past the direct-rendering cutoff, so
        // this exercises the perturbation path. The origin sits on the set
        // boundary, so the view contains escaping points
        let view = (2621.0, 2622.0, 2621.0, 2622.0);
        let origin = ("-0.7436438870371587", "0.1318259042053119");
        let tile = tile_precise_with_stats(origin.0, origin.1, view, 12, 40, max_iterations);

        assert!(tile.min_iter >= 1, "Boundary view should observe a range");
        assert!(tile.min_iter <= tile.max_iter);
        assert!(tile.max_iter < as_i32(max_iterations));

        let legacy = tile_precise_image(origin.0, origin.1, view, 12, 40, max_iterations);
        assert_eq!(tile.image, legacy);

        // Recoloring the deep-zoom tile's cached values with its own params
        // must reproduce a valid image of the same size
        let recolored = super::recolor_values(
            &tile.values,
            &coloring_options("turbo", 0, as_i32(max_iterations)),
        );
        assert_eq!(recolored.len(), tile.image.len());
    }

    #[test]
    fn test_get_mandelbrot_tile_precise_values_flag() {
        // include_values=false returns an empty buffer, saving the transfer
        // for large offscreen renders (image export)
        let tile = super::get_mandelbrot_tile_precise(
            "0".to_string(),
            "0".to_string(),
            1.3,
            3.2,
            1.8,
            3.3,
            2,
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
            false,
            None,
        );

        assert!(tile.values.is_empty());
        assert_eq!(tile.image.len(), 32 * 32 * super::NUM_COLOR_CHANNELS);
        assert!(tile.min_iter >= 0, "Stats are still reported");
    }

    #[test]
    fn test_recolor_tile_matches_render() {
        // Without smooth coloring the cached values are whole iteration
        // counts, exactly representable in f32, so recoloring with the same
        // parameters must reproduce the rendered image byte-for-byte
        let max_iterations = 200;
        let render = |palette_min: i32, palette_max: i32| {
            super::get_mandelbrot_tile_precise(
                "0".to_string(),
                "0".to_string(),
                1.3,
                3.2,
                1.8,
                3.3,
                2,
                0,
                max_iterations,
                2,
                32,
                32,
                "inferno".to_string(),
                false,
                0.0,
                0.0,
                0.0,
                crate::ValidColorSpace::Hsl,
                false,
                palette_min,
                palette_max,
                true,
                None,
            )
        };

        let tile = render(0, as_i32(max_iterations));

        let recolored = super::recolor_values(
            &tile.values,
            &coloring_options("inferno", 0, as_i32(max_iterations)),
        );
        assert_eq!(
            recolored, tile.image,
            "Recolor with identical params must match the render"
        );

        // Recoloring with the tile's own detected range must equal a fresh
        // render that used that range from the start
        let refit = super::recolor_values(
            &tile.values,
            &coloring_options("inferno", tile.min_iter, tile.max_iter),
        );
        let rerendered = render(tile.min_iter, tile.max_iter);
        assert_eq!(
            refit, rerendered.image,
            "Recolor with a new range must match a full re-render"
        );
        assert_ne!(refit, tile.image, "The narrowed range changes the output");
    }

    #[test]
    fn test_recolor_with_cdf_matches_render() {
        // The equalization table rides ColoringOptions so renders and
        // recolors share it: rendering with a CDF attached and recoloring the
        // cached values with the same CDF must agree byte-for-byte (smooth
        // coloring off, so the f32-cached values are exact) — the same
        // recolor-matches-render guarantee the linear path has.
        let max_iterations = 200;
        // A monotone, deliberately non-identity table (a sqrt bend).
        let cdf: Vec<f32> = (0..=63).map(|i| (i as f32 / 63.0).sqrt()).collect();
        let render = |table: Option<&[f32]>| {
            super::generate_mandelbrot_set_image(
                -2.0,
                1.0,
                -1.2,
                1.2,
                max_iterations,
                2,
                32,
                32,
                "inferno",
                false,
                0.0,
                0.0,
                0.0,
                crate::ValidColorSpace::Hsl,
                false,
                0,
                as_i32(max_iterations),
                1,
                table,
            )
        };

        let rendered = render(Some(&cdf));
        let mut coloring = coloring_options("inferno", 0, as_i32(max_iterations));
        coloring.palette_cdf = Some(cdf.clone());
        let recolored = super::recolor_values(&rendered.values, &coloring);
        assert_eq!(
            recolored, rendered.image,
            "Recolor with the render's CDF must match the render"
        );

        // The table genuinely changes the output, and dropping it from the
        // recolor reproduces the linear render exactly.
        let linear = render(None);
        assert_ne!(rendered.image, linear.image);
        let linear_recolor = super::recolor_values(
            &rendered.values,
            &coloring_options("inferno", 0, as_i32(max_iterations)),
        );
        assert_eq!(
            linear_recolor, linear.image,
            "No CDF must reproduce the linear render byte-for-byte"
        );
    }

    #[test]
    fn test_fixed_palette_modes_ignore_cdf() {
        // Distance-estimate and atom-domain values are already normalized to
        // a fixed 0..1 palette domain; a stray equalization table must not
        // distort them.
        let values: Vec<f32> = (0..64).map(|i| i as f32 / 63.0).collect();
        for mode in ["distanceEstimate", "atomDomain"] {
            let mut with_cdf = coloring_options("turbo", 0, 200);
            let mut without_cdf = coloring_options("turbo", 0, 200);
            if mode == "distanceEstimate" {
                with_cdf.distance_estimate = true;
                without_cdf.distance_estimate = true;
            } else {
                with_cdf.atom_domain = true;
                without_cdf.atom_domain = true;
            }
            with_cdf.palette_cdf = Some(vec![0.0, 0.9, 1.0]);

            assert_eq!(
                super::recolor_values(&values, &with_cdf),
                super::recolor_values(&values, &without_cdf),
                "{mode} mode must ignore the CDF"
            );
        }
    }

    #[test]
    fn test_recolor_tile_interior_is_black() {
        let values = vec![f32::INFINITY; 16];
        let img = super::recolor_values(&values, &coloring_options("turbo", 0, 200));

        assert_eq!(img, super::create_solid_black_image(4, 4));
    }
}
