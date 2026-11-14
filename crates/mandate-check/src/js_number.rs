//! `Number(string)` as ECMAScript reads a string (`StringToNumber`), for the
//! places the compiler gives a string to `Number` or to `.map(Number)`: a
//! version's segments in the diff of two locks, an array index in a JSON
//! Patch, and the numbers of a lock that was not validated (`lock.rs`). It is
//! the one implementation: a hexadecimal, octal or binary literal is read
//! exactly (and rounded once), as V8 rounds it.

/// The digits of a numeric literal in `radix`, as a double: `None` when
/// `digits` is empty or has a character that is no digit of the radix.
fn radix_number(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
        return None;
    }
    // Exact, and rounded once, up to 128 bits; past that a double at each step.
    match u128::from_str_radix(digits, radix) {
        Ok(n) => Some(n as f64),
        Err(_) => Some(
            digits
                .chars()
                .filter_map(|c| c.to_digit(radix))
                .fold(0.0_f64, |acc, d| acc * f64::from(radix) + f64::from(d)),
        ),
    }
}

/// `Number(s)` for a string. White space around the text is ignored (the
/// white space of ECMAScript, not Rust's); the empty string is 0; `0x`, `0o`
/// and `0b` read hexadecimal, octal and binary integers, with no sign; a
/// decimal literal may have a sign, a fraction and an exponent, and
/// `Infinity` is one; anything else (`1_0`, `1n`, `inf`, `nan`) is `NaN`.
/// `-0` is negative zero.
#[must_use]
pub fn js_to_number(s: &str) -> f64 {
    let t = mandate_ir::trim(s);
    if t.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = t.strip_prefix(prefix) {
            return radix_number(digits, radix).unwrap_or(f64::NAN);
        }
    }
    let (negative, body) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let sign = |x: f64| if negative { -x } else { x };
    if body == "Infinity" {
        return sign(f64::INFINITY);
    }
    // StrDecimalLiteral: digits, then a point and more digits, then an exponent.
    let bytes = body.as_bytes();
    let digits_from = |from: usize| {
        bytes
            .get(from..)
            .unwrap_or_default()
            .iter()
            .take_while(|b| b.is_ascii_digit())
            .count()
    };
    let int = digits_from(0);
    let mut at = int;
    let mut fraction = 0;
    if bytes.get(at) == Some(&b'.') {
        at = at.saturating_add(1);
        fraction = digits_from(at);
        at = at.saturating_add(fraction);
    }
    if int.saturating_add(fraction) == 0 {
        return f64::NAN;
    }
    if matches!(bytes.get(at), Some(b'e' | b'E')) {
        at = at.saturating_add(1);
        if matches!(bytes.get(at), Some(b'+' | b'-')) {
            at = at.saturating_add(1);
        }
        let exponent = digits_from(at);
        if exponent == 0 {
            return f64::NAN;
        }
        at = at.saturating_add(exponent);
    }
    if at != bytes.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, sign)
}

#[cfg(test)]
mod tests {
    use super::js_to_number;

    #[test]
    fn reads_what_number_reads() {
        assert_eq!(js_to_number(""), 0.0);
        assert_eq!(js_to_number("  \u{a0}\n"), 0.0);
        assert_eq!(js_to_number(" 1 "), 1.0);
        assert_eq!(js_to_number("1e0"), 1.0);
        assert_eq!(js_to_number("0x1"), 1.0);
        assert_eq!(js_to_number("0b11"), 3.0);
        assert_eq!(js_to_number("0o17"), 15.0);
        assert_eq!(js_to_number("+1"), 1.0);
        assert_eq!(js_to_number(".5"), 0.5);
        assert_eq!(js_to_number("5."), 5.0);
        assert!(js_to_number("-0").is_sign_negative());
        assert_eq!(js_to_number("Infinity"), f64::INFINITY);
        assert_eq!(js_to_number("-Infinity"), f64::NEG_INFINITY);
        for bad in [
            "-", "1_0", "inf", "nan", "-0x1", "0x", "1e", ".", "1.2.3", "1n", "infinity",
        ] {
            assert!(js_to_number(bad).is_nan(), "{bad}");
        }
    }
}
