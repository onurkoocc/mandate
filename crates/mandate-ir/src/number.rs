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
/// closer to `x` of two, and of two as close the one whose last digit is
/// even), as an integer up to 21 digits, as a decimal
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
    let (digits, e) = shortest_digits(x.abs());
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

/// The digits of an exponent form such as `1.2345e-7`, and its exponent.
fn split_exponent_form(sci: &str) -> (String, i64) {
    let (mantissa, exponent) = sci.split_once('e').unwrap_or((sci, "0"));
    let digits = mantissa.chars().filter(char::is_ascii_digit).collect();
    (digits, exponent.parse().unwrap_or(0))
}

/// The digits s and the exponent n − 1 of a positive finite `a` as
/// `Number::toString` chooses them: the fewest digits k that read back as
/// `a`, and of two such k-digit numbers equally close to `a`, the one whose
/// last digit is even (ECMA-262 §6.1.6.1.20, Note 2).
///
/// Rust's shortest form (`{:e}`, core's flt2dec) gives the right k, but on
/// such a tie it takes the larger one: `1394865425023536.3` for
/// 1394865425023536.25, where ECMAScript writes `1394865425023536.2`. The
/// digits are therefore taken from `{:.*e}` with k − 1 decimals, which
/// rounds the exact binary value half to even, as long as that reads back as
/// `a`; at a power of two, where the doubles on the two sides are not
/// equally far apart, it may not, and then the shortest form's digits stand.
fn shortest_digits(a: f64) -> (String, i64) {
    let shortest = split_exponent_form(&format!("{a:e}"));
    let decimals = shortest.0.len().saturating_sub(1);
    let rounded = format!("{a:.decimals$e}");
    if rounded.parse::<f64>() == Ok(a) {
        split_exponent_form(&rounded)
    } else {
        shortest
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
