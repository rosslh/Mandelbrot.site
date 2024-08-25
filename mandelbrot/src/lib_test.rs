use super::*;

#[cfg(test)]
mod lib_test {
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

    #[test]
    fn get_escape_iterations_if_not_in_set_escapes() {
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
            let iterations = super::get_escape_iterations(re, im, MAX_ITERATIONS, 3.0, 2).0;

            assert_ne!(
                iterations, MAX_ITERATIONS,
                "Failed at point: ({}, {})",
                re, im
            );
        }
    }

    #[test]
    fn get_escape_iterations_if_in_set_stays_bounded() {
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
            let iterations = super::get_escape_iterations(re, im, MAX_ITERATIONS, 3.0, 2).0;

            assert_eq!(
                iterations, MAX_ITERATIONS,
                "Failed at point: ({}, {})",
                re, im
            );
        }
    }

    #[test]
    fn get_mandelbrot_image_outputs_correct_length() {
        for &(x_min, x_max, y_min, y_max) in SQUARES.iter() {
            let response = super::get_mandelbrot_image(
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
    fn get_mandelbrot_image_outputs_valid_colors() {
        for &(x_min, x_max, y_min, y_max) in SQUARES.iter() {
            let response = super::get_mandelbrot_image(
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
    fn test_get_mandelbrot_image_snapshot() {
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

        for &max_iterations in max_iterations.iter() {
            for &exponent in exponents.iter() {
                for &image_side_length in image_side_lengths.iter() {
                    for color_scheme in color_schemes.iter() {
                        for &reverse_color in reverse_color_options.iter() {
                            for &hue_shift in hue_shifts.iter() {
                                for &saturation_shift in saturation_shifts.iter() {
                                    for &lightness_shift in lightness_shifts.iter() {
                                        for &color_space in color_spaces.iter() {
                                            for (index, &(x_min, x_max, y_min, y_max)) in
                                                snapshot_squares.iter().enumerate()
                                            {
                                                let response = super::get_mandelbrot_image(
                                                    x_min,
                                                    x_max,
                                                    y_min,
                                                    y_max,
                                                    max_iterations,
                                                    exponent,
                                                    image_side_length,
                                                    image_side_length,
                                                    color_scheme.to_string(),
                                                    reverse_color,
                                                    hue_shift as f32,
                                                    saturation_shift,
                                                    lightness_shift,
                                                    color_space,
                                                );

                                                let snapshot_name = format!(
                                                    "snapshot_{}_{}_{}_{}_{}_{}_{}_{}_{}_{:?}",
                                                    index,
                                                    max_iterations,
                                                    exponent,
                                                    image_side_length,
                                                    color_scheme,
                                                    reverse_color,
                                                    hue_shift,
                                                    saturation_shift,
                                                    lightness_shift,
                                                    color_space
                                                );

                                                // this updates each value in the response to the nearest even integer
                                                // to reduce flakes in the snapshot tests
                                                let even_response: Vec<u8> = response
                                                    .iter()
                                                    .map(|&x| {
                                                        if x % 2 == 0 || x == 255 {
                                                            x
                                                        } else {
                                                            x + 1
                                                        }
                                                    })
                                                    .collect();

                                                insta::assert_snapshot!(
                                                    snapshot_name.clone(),
                                                    format!("{:?}", even_response)
                                                );

                                                let image_name = format!(
                                                    "./src/snapshots/{}.png",
                                                    snapshot_name
                                                );

                                                if let Err(err) = image::save_buffer(
                                                    image_name,
                                                    &response,
                                                    image_side_length as u32,
                                                    image_side_length as u32,
                                                    image::ColorType::Rgba8,
                                                ) {
                                                    panic!("Failed to save image: {}", err);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
