use super::*;

#[test]
fn ldexp_matches_f64_scaling() {
    assert_eq!(ldexp(1.5, 3), 12.0);
    assert_eq!(ldexp(-3.0, -1), -1.5);
    assert_eq!(ldexp(0.0, 100), 0.0);
    assert_eq!(ldexp(1.0, 0), 1.0);
}

#[test]
fn ldexp_handles_extreme_exponents() {
    // Far beyond f64 range in both directions.
    assert_eq!(ldexp(1.0, -3000), 0.0);
    assert!(ldexp(1.0, 3000).is_infinite());
    // Round trip within range.
    let tiny = ldexp(1.0, -1000);
    assert_eq!(ldexp(tiny, 1000), 1.0);
}

#[test]
fn complex_exp_matches_f64_arithmetic() {
    let a = ComplexExp::from_f64s(1.25, -2.5);
    let b = ComplexExp::from_f64s(0.75, 3.0);

    let product = a.mul(&b);
    let (re, im) = product.to_f64s();
    // (1.25 - 2.5i)(0.75 + 3i) = 0.9375 + 7.5 + (3.75 - 1.875)i
    assert!((re - 8.4375).abs() < 1e-12);
    assert!((im - 1.875).abs() < 1e-12);

    let sum = a.add(&b);
    let (re, im) = sum.to_f64s();
    assert!((re - 2.0).abs() < 1e-12);
    assert!((im - 0.5).abs() < 1e-12);
}

#[test]
fn complex_exp_survives_deep_underflow() {
    // A value far below f64's subnormal range keeps full relative precision.
    let deep = ComplexExp::new(1.5, -0.5, -5000);
    let squared = deep.mul(&deep);
    // (1.5 - 0.5i)^2 = 2.0 - 1.5i, at exponent -10000.
    let expected = ComplexExp::new(2.0, -1.5, -10000);
    let difference = squared.add(&ComplexExp::new(-expected.re, -expected.im, expected.exp));
    let (mantissa, exp) = difference.norm_sqr_exp();
    assert!(
        mantissa == 0.0 || exp < -20100,
        "unexpected error: {mantissa} * 2^{exp}"
    );
}

#[test]
fn add_keeps_larger_operand_when_magnitudes_are_incomparable() {
    let large = ComplexExp::new(1.0, 0.0, 0);
    let tiny = ComplexExp::new(1.0, 0.0, -500);
    assert_eq!(large.add(&tiny), large);
}

#[test]
fn exp_value_comparison() {
    assert!(exp_value_less_than((1.0, -10), (1.0, -5)));
    assert!(!exp_value_less_than((1.0, -5), (1.0, -10)));
    assert!(exp_value_less_than((1.0, 0), (1.5, 0)));
    assert!(exp_value_less_than((0.0, 0), (1.0, -1000)));
    assert!(!exp_value_less_than((1.0, -1000), (0.0, 0)));
    // Mantissas needing normalization before exponents are comparable.
    assert!(exp_value_less_than((8.0, 0), (1.0, 4)));
    assert!(!exp_value_less_than((8.0, 0), (1.0, 3)));
}
