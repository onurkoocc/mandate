//! The canonical form of a runtime value and its digest (spec/journal.md
//! "The canonical form of a runtime value"): RFC 8785 over doubles, as the
//! reference's `canonical` in `runtime/src/values.ts` writes it.
//!
//! Strings and member names are written as [`mandate_ir::write_json_string`]
//! writes them and members are sorted by [`mandate_ir::compare_utf16`]: those
//! rules are the IR's too. Numbers are not: the IR admits only safe integers,
//! and a runtime value holds any double, written as ECMAScript's
//! `Number::toString` writes it ([`write_number`], which is
//! [`mandate_ir::write_number`] for the finite doubles an export holds).

use std::fmt::Write as _;

use mandate_ir::{compare_utf16, write_json_string};
use sha2::{Digest, Sha256};

use crate::json::Json;

/// The canonical form of `value`.
#[must_use]
pub fn canonical(value: &Json) -> String {
    let mut out = String::new();
    write_canonical(&mut out, value);
    out
}

/// Appends the canonical form of `value` to `out`. It recurses once per level
/// of nesting; a value read from an export is at most
/// [`crate::read::EXPORT_DEPTH`] deep.
pub fn write_canonical(out: &mut String, value: &Json) {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(true) => out.push_str("true"),
        Json::Bool(false) => out.push_str("false"),
        Json::Number(x) => write_number(out, *x),
        Json::String(s) => write_json_string(out, s),
        Json::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_canonical(out, item);
            }
            out.push(']');
        }
        Json::Object(members) => {
            let mut sorted: Vec<&(String, Json)> = members.iter().collect();
            sorted.sort_by(|a, b| compare_utf16(&a.0, &b.0));
            out.push('{');
            for (i, (name, item)) in sorted.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, name);
                out.push(':');
                write_canonical(out, item);
            }
            out.push('}');
        }
    }
}

/// `x` as ECMAScript's `Number::toString` writes it (ECMA-262
/// §6.1.6.1.20, RFC 8785 §3.2.2.3), and `null` for a value that is not
/// finite, which a read export never holds, as `JSON.stringify` writes it.
#[must_use]
pub fn number_to_string(x: f64) -> String {
    let mut out = String::new();
    write_number(&mut out, x);
    out
}

/// Appends [`number_to_string`] of `x`: [`mandate_ir::write_number`] for a
/// finite `x` (`0` for both zeros; otherwise the shortest digits that read
/// back as `x`, of two as close the one whose last digit is even, as an
/// integer up to 21 digits, as a decimal fraction down to
/// `0.000001`, and in exponent form beyond those), and `null` otherwise.
pub fn write_number(out: &mut String, x: f64) {
    if x.is_finite() {
        mandate_ir::write_number(out, x);
    } else {
        out.push_str("null");
    }
}

/// `sha256:` and the lowercase hex SHA-256 of the parts, one after another.
#[must_use]
pub fn sha256_tagged(parts: &[&[u8]]) -> String {
    let mut h = Sha256::new();
    for part in parts {
        h.update(part);
    }
    let digest = h.finalize();
    let mut out = String::with_capacity(71);
    out.push_str("sha256:");
    for byte in digest.iter() {
        // Writing to a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// The digest of `value` in the domain `domain`: `sha256:` and the hex
/// SHA-256 of `mandate/<domain>/0.1`, a line feed, and the canonical form
/// (`digest` in `runtime/src/values.ts`).
#[must_use]
pub fn digest(domain: &str, value: &Json) -> String {
    digest_of_canonical(domain, &canonical(value))
}

/// As [`digest`], over a canonical form already written.
#[must_use]
pub fn digest_of_canonical(domain: &str, canonical: &str) -> String {
    sha256_tagged(&[
        b"mandate/",
        domain.as_bytes(),
        b"/0.1\n",
        canonical.as_bytes(),
    ])
}
