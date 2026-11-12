//! RFC 8785 JSON Canonicalization Scheme (JCS) for the IR value domain: a
//! port of `compiler/src/json/jcs.ts`.
//!
//! Object members are sorted by the UTF-16 code units of their names, strings
//! are written as ECMAScript's `JSON.stringify` writes them, and numbers, which
//! are safe integers here, in decimal. There is no whitespace and no Unicode
//! normalisation.

use std::cmp::Ordering;
use std::fmt::Write as _;

use crate::value::Value;

/// The canonical text of `value`: `canonicalize` in `jcs.ts`.
///
/// It recurses once per level of nesting. A value read by [`crate::parse`] is
/// at most [`crate::limits::JSON_DEPTH`] deep; a value built by hand is not
/// bounded here.
#[must_use]
pub fn canonicalize(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// Orders two strings by their UTF-16 code units, as RFC 8785 §3.2.3 requires
/// (`compareUtf16` in `jcs.ts`). It differs from `str`'s order, which is by
/// code point: a character outside the Basic Multilingual Plane sorts before
/// U+E000 to U+FFFF here.
#[must_use]
pub fn compare_utf16(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => {
            let _ = write!(out, "{n}");
        }
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut members: Vec<(&str, &Value)> = map.iter().collect();
            members.sort_by(|a, b| compare_utf16(a.0, b.0));
            out.push('{');
            for (i, (key, item)) in members.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_value(out, item);
            }
            out.push('}');
        }
    }
}

/// Writes `s` as `JSON.stringify` does: `"` and `\` escaped, the five short
/// escapes `\b \f \n \r \t`, any other character below U+0020 as `\u00xx` in
/// lower-case hex, and every other character as itself (U+007F, U+2028 and
/// U+2029 included).
fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
