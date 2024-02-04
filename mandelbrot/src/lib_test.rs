use super::*;

#[cfg(test)]
mod lib_test {
    const MAX_ITERATIONS: u32 = 200;
    const SQUARES: [(f64, f64, f64, f64); 8] = [
        (-0.75, -0.25, 0.25, 0.75),
        (-1.5, 0.0, -0.5, 0.5),
        (-2.0, -1.0, 0.0, 1.0),
        (-2.0, 0.5, -1.0, 1.0),
        (-2.5, 1.0, -1.5, 1.5),
        (0.0, 1.5, 0.0, 1.0),
        (0.0, 2.0, 0.0, 2.0),
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
    fn get_tile_outputs_correct_length() {
        for &(x_min, x_max, y_min, y_max) in SQUARES.iter() {
            let response = super::get_tile(
                x_min,
                x_max,
                y_min,
                y_max,
                MAX_ITERATIONS,
                2,
                256,
                "turbo".to_string(),
                false,
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
    fn get_tile_outputs_valid_colors() {
        for &(x_min, x_max, y_min, y_max) in SQUARES.iter() {
            let response = super::get_tile(
                x_min,
                x_max,
                y_min,
                y_max,
                MAX_ITERATIONS,
                2,
                256,
                "turbo".to_string(),
                false,
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
    fn test_get_tile_snapshot() {
        for (index, &(x_min, x_max, y_min, y_max)) in SQUARES.iter().enumerate() {
            let response = super::get_tile(
                x_min,
                x_max,
                y_min,
                y_max,
                MAX_ITERATIONS,
                2,
                100,
                "turbo".to_string(),
                false,
            );
            insta::assert_snapshot!(format!("snapshot{}", index), format!("{:?}", response));

            if let Err(err) = image::save_buffer(
                format!("./src/snapshots/snapshot{}.png", index),
                &response,
                100,
                100,
                image::ColorType::Rgba8,
            ) {
                panic!("Failed to save image: {}", err);
            }
        }
    }
}
