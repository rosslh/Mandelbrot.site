use super::*;

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
                param.max_iterations,
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
                MAX_ITERATIONS,
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
                MAX_ITERATIONS,
            );
            for n in response.iter() {
                assert!(
                    *n <= u8::MAX,
                    "Invalid color value: {} at tile: ({}, {}, {}, {})",
                    n,
                    x_min,
                    x_max,
                    y_min,
                    y_max
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
    fn test_compute_pixel_color() {
        let palette = &colorous::TURBO;
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
            0,
            100,
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
            0,
            100,
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
        let palette = &colorous::TURBO;
        let should_reverse_colors = false;
        let color_space = ValidColorSpace::Hsl;
        let shift_hue_amount = 0.0;
        let saturate_amount = 0.0;
        let lighten_amount = 0.0;
        let smooth_coloring = true;
        let palette_start = 0;
        let palette_end = 100;

        let image = super::render_mandelbrot_set(
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
            palette_start,
            palette_end,
        );

        assert_eq!(
            image.len(),
            image_width * image_height * super::NUM_COLOR_CHANNELS
        );

        assert_eq!(image[0..4], [44, 28, 55, 255]); // Top-left pixel
        assert_eq!(image[396..400], [44, 28, 55, 255]); // Bottom-right pixel
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
}
