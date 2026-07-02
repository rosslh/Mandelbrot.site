//! Complex arithmetic with an extended exponent range.
//!
//! Deep zooms require pixel offsets far smaller than the smallest positive
//! `f64` (~1e-308). `ComplexExp` stores a complex number as an `f64` mantissa
//! pair plus a shared power-of-two exponent, giving ~53 bits of relative
//! precision with a practically unlimited exponent range. That is exactly what
//! perturbation deltas need: high *relative* accuracy at any magnitude.

#[cfg(test)]
#[path = "float_exp_test.rs"]
mod float_exp_test;

/// Multiplies an `f64` by 2^exp without intermediate overflow or underflow.
pub fn ldexp(x: f64, exp: i64) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }

    let mut result = x;
    let mut remaining = exp;

    // Apply the exponent in steps that each stay within f64's range.
    const STEP: i64 = 512;
    while remaining != 0 {
        let step = remaining.clamp(-STEP, STEP);
        result *= f64::from_bits(((1023 + step) as u64) << 52);
        remaining -= step;

        if result == 0.0 || !result.is_finite() {
            return result;
        }
    }

    result
}

/// A complex number `(re + im*i) * 2^exp` where `re` and `im` are kept in a
/// normalized range so products and sums of mantissas never overflow.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ComplexExp {
    pub re: f64,
    pub im: f64,
    pub exp: i64,
}

impl ComplexExp {
    pub const ZERO: ComplexExp = ComplexExp {
        re: 0.0,
        im: 0.0,
        exp: 0,
    };

    /// Creates a normalized value from mantissas and a power-of-two exponent.
    pub fn new(re: f64, im: f64, exp: i64) -> Self {
        ComplexExp { re, im, exp }.normalized()
    }

    pub fn from_f64s(re: f64, im: f64) -> Self {
        Self::new(re, im, 0)
    }

    pub fn is_zero(&self) -> bool {
        self.re == 0.0 && self.im == 0.0
    }

    /// Rescales so the larger mantissa magnitude lies in [1, 2).
    fn normalized(mut self) -> Self {
        let magnitude = self.re.abs().max(self.im.abs());

        if magnitude == 0.0 {
            return ComplexExp::ZERO;
        }

        // Bring subnormal mantissas into the normal range first so exponent
        // extraction via the bit representation is valid.
        if magnitude < f64::MIN_POSITIVE {
            self.re = ldexp(self.re, 1074);
            self.im = ldexp(self.im, 1074);
            self.exp -= 1074;
            return self.normalized();
        }

        let magnitude_exp = ((magnitude.to_bits() >> 52) & 0x7ff) as i64 - 1023;
        let scale = f64::from_bits(((1023 - magnitude_exp) as u64) << 52);
        ComplexExp {
            re: self.re * scale,
            im: self.im * scale,
            exp: self.exp + magnitude_exp,
        }
    }

    pub fn mul(&self, other: &ComplexExp) -> ComplexExp {
        ComplexExp {
            re: self.re * other.re - self.im * other.im,
            im: self.re * other.im + self.im * other.re,
            exp: self.exp + other.exp,
        }
        .normalized()
    }

    pub fn add(&self, other: &ComplexExp) -> ComplexExp {
        if self.is_zero() {
            return *other;
        }
        if other.is_zero() {
            return *self;
        }

        let (larger, smaller) = if self.exp >= other.exp {
            (self, other)
        } else {
            (other, self)
        };

        let exp_diff = larger.exp - smaller.exp;
        // The smaller operand is below the larger one's precision.
        if exp_diff > 120 {
            return *larger;
        }

        let scale = ldexp(1.0, -exp_diff);
        ComplexExp {
            re: larger.re + smaller.re * scale,
            im: larger.im + smaller.im * scale,
            exp: larger.exp,
        }
        .normalized()
    }

    /// The squared magnitude as (mantissa, power-of-two exponent).
    pub fn norm_sqr_exp(&self) -> (f64, i64) {
        (self.re * self.re + self.im * self.im, 2 * self.exp)
    }

    /// Converts to a plain complex number. Underflows to zero and overflows to
    /// infinity when the exponent is out of f64 range.
    pub fn to_f64s(self) -> (f64, f64) {
        (ldexp(self.re, self.exp), ldexp(self.im, self.exp))
    }
}

/// Compares two non-negative (mantissa, exponent) magnitudes: `a < b`.
pub fn exp_value_less_than(a: (f64, i64), b: (f64, i64)) -> bool {
    let (a_mantissa, a_exp) = a;
    let (b_mantissa, b_exp) = b;

    if a_mantissa == 0.0 {
        return b_mantissa > 0.0;
    }
    if b_mantissa == 0.0 {
        return false;
    }

    // Normalize both mantissas into [1, 2) so exponents are comparable.
    let normalize = |mantissa: f64, exp: i64| -> (f64, i64) {
        let value = ComplexExp::new(mantissa, 0.0, exp);
        (value.re, value.exp)
    };
    let (a_mantissa, a_exp) = normalize(a_mantissa, a_exp);
    let (b_mantissa, b_exp) = normalize(b_mantissa, b_exp);

    if a_exp != b_exp {
        a_exp < b_exp
    } else {
        a_mantissa < b_mantissa
    }
}
