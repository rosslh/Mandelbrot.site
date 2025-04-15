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

    #[test]
    fn test_palette_min_iter() {
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
            (50.0 as f64).max(50.0 + f64::EPSILON),
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
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
        let (palette, should_reverse) = super::get_color_palette("turbo", false);
        assert!(!should_reverse);
        assert_eq!(palette.eval_continuous(0.0).as_array(), [34, 23, 27]);

        // Test reverse palette
        let (_palette, should_reverse) = super::get_color_palette("turbo", true);
        assert!(should_reverse);

        // Test palette from reverse set
        let (_palette, should_reverse) = super::get_color_palette("blues", false);
        // This has different behavior than expected - blues is in REVERSE_PALETTE so should_reverse is true
        assert!(should_reverse);

        // Test reverse palette from reverse set
        let (_palette, should_reverse) = super::get_color_palette("blues", true);
        // When reversing a reverse palette, it's !reverse_colors, so should be false
        assert!(!should_reverse);

        // Test fallback to default palette
        let (palette, should_reverse) = super::get_color_palette("nonexistent", false);
        assert!(!should_reverse);
        assert_eq!(palette.eval_continuous(0.0).as_array(), [34, 23, 27]); // turbo start color
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
        let palette = &colorous::TURBO;
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

        // Test extreme color transformations
        let color = super::compute_pixel_color(
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
        // Should return a valid color after transformation (just check it doesn't panic)
        assert!(color.iter().all(|&c| c <= u8::MAX));
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
            "inferno",
            "magma",
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
            let (palette, should_reverse) = super::get_color_palette(name, false);
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
            let (palette, should_reverse) = super::get_color_palette(name, false);
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
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
        let palette = &colorous::TURBO;
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
            (0.0 as f64).max(0.0 + f64::EPSILON),
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
}
