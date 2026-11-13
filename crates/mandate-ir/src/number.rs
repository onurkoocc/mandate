//! ECMAScript numbers as the TypeScript compiler writes and tests them:
//! `Number::toString` (what `String(n)`, a template literal and
//! `JSON.stringify` write for a finite number), `Number.isInteger` and
//! `Number.isSafeInteger`.
//!
//! A TypeScript `number` is a double, so where a port does arithmetic whose
//! result can leave ±(2^53−1), it must do it in `f64` to round as TypeScript
//! does; these functions take `f64` for that reason.

use std::fmt::Write as _;

/// `x` as ECMAScript's `Number::toString(x)` writes it (ECMA-262
/// §6.1.6.1.20, RFC 8785 §3.2.2.3): `String(x)`.
///
/// `NaN`, `Infinity` and `-Infinity` for the values that are not finite (as
/// `String` writes them; `JSON.stringify` writes `null` there instead); `0`
/// for both zeros; otherwise the shortest digits that read back as `x` (the
/// closer to `x` of two), as an integer up to 21 digits, as a decimal
/// fraction down to `0.000001`, and in exponent form beyond those.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    let mut out = String::new();
    write_number(&mut out, x);
    out
}

/// Appends [`number_to_string`] of `x` to `out`.
pub fn write_number(out: &mut String, x: f64) {
    if x.is_nan() {
        out.push_str("NaN");
        return;
    }
    if x == 0.0 {
        out.push('0');
        return;
    }
    if x < 0.0 {
        out.push('-');
    }
    if x.is_infinite() {
        out.push_str("Infinity");
        return;
    }
    // Rust's exponent form of a double is its shortest round-trip digits,
    // the one closest to it when two are as short (`{:e}` of core's
    // flt2dec, Grisu with a Dragon4 fallback): `1e21`, `1.2345e-7`.
    let sci = format!("{:e}", x.abs());
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((sci.as_str(), "0"));
    let digits: String = mantissa.chars().filter(char::is_ascii_digit).collect();
    let e: i64 = exponent.parse().unwrap_or(0);
    // In the spec's terms: s is `digits`, k its length, x = s × 10^(n−k).
    let k = i64::try_from(digits.len()).unwrap_or(i64::MAX);
    let n = e.saturating_add(1);
    if (k..=21).contains(&n) {
        out.push_str(&digits);
        for _ in 0..n.saturating_sub(k) {
            out.push('0');
        }
    } else if (1..=21).contains(&n) {
        let (int, frac) = digits
            .split_at_checked(usize::try_from(n).unwrap_or(0))
            .unwrap_or((digits.as_str(), ""));
        out.push_str(int);
        out.push('.');
        out.push_str(frac);
    } else if (-5..=0).contains(&n) {
        out.push_str("0.");
        for _ in 0..n.saturating_neg() {
            out.push('0');
        }
        out.push_str(&digits);
    } else {
        let (first, rest) = digits.split_at_checked(1).unwrap_or((digits.as_str(), ""));
        out.push_str(first);
        if !rest.is_empty() {
            out.push('.');
            out.push_str(rest);
        }
        let power = n.saturating_sub(1);
        out.push('e');
        out.push(if power < 0 { '-' } else { '+' });
        // Writing to a String cannot fail.
        let _ = write!(out, "{}", power.unsigned_abs());
    }
}

/// `Number.isInteger(x)`: finite with no fraction; `-0` is an integer.
#[must_use]
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Number.isSafeInteger(x)`: an integer of magnitude at most 2^53−1.
#[must_use]
pub fn is_safe_integer(x: f64) -> bool {
    is_integer(x) && x.abs() <= 9_007_199_254_740_991.0
}
