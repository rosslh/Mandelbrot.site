use super::*;

#[cfg(test)]
mod lib_test {
    const MAX_ITERATIONS: u32 = 1000;
    #[test]
    fn get_escape_iterations_if_not_in_set_escapes() {
        let escapes_iterations_top_left =
            super::get_escape_iterations(-2.0, 1.0, MAX_ITERATIONS, 3.0, 2).0;
        assert_ne!(escapes_iterations_top_left, MAX_ITERATIONS);

        let escapes_iterations_center_right =
            super::get_escape_iterations(1.0, 0.0, MAX_ITERATIONS, 3.0, 2).0;
        assert_ne!(escapes_iterations_center_right, MAX_ITERATIONS);
    }

    #[test]
    fn get_escape_iterations_if_in_set_stays_bounded() {
        let bounded_iterations_origin = super::get_escape_iterations(0.0, 0.0, MAX_ITERATIONS, 3.0, 2).0;
        assert_eq!(bounded_iterations_origin, MAX_ITERATIONS);

        let bounded_iterations_bulb = super::get_escape_iterations(-1.0, 0.0, MAX_ITERATIONS, 3.0, 2).0;
        assert_eq!(bounded_iterations_bulb, MAX_ITERATIONS);
    }

    #[test]
    fn get_tile_outputs_correct_length() {
        let image_size: usize = 256 * 256 * 4;

        let image = super::get_tile(0.0, 0.0, 2.0, MAX_ITERATIONS, 2, 256);
        assert_eq!(image.len(), image_size);

        let zoomed_image = super::get_tile(8476.0, 9507.0, 12.0, MAX_ITERATIONS, 2, 256);
        assert_eq!(zoomed_image.len(), image_size);
    }

    #[test]
    fn get_tile_outputs_valid_colors() {
        let image = super::get_tile(0.0, 0.0, 2.0, MAX_ITERATIONS, 2, 256);
        for n in image.clone().iter_mut() {
            assert!(n >= &mut 0 && n <= &mut 255);
        }

        let zoomed_image = super::get_tile(8476.0, 9507.0, 12.0, MAX_ITERATIONS, 2, 256);
        for n in zoomed_image.clone().iter_mut() {
            assert!(n >= &mut 0 && n <= &mut 255);
        }
    }
}
