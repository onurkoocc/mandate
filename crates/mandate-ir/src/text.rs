//! ECMAScript string and collection operations whose Rust counterparts
//! differ, for the ported phases to share.
//!
//! An ECMAScript string is a sequence of UTF-16 code units: its `length`,
//! its indices and `<` between strings count and compare those, not bytes
//! or code points ([`utf16_len`], [`crate::compare_utf16`],
//! [`sort_utf16`]). Its white space ([`is_js_whitespace`]) is not
//! [`char::is_whitespace`].

use std::collections::HashSet;
use std::hash::Hash;

use crate::jcs::compare_utf16;

/// Whether `c` is ECMAScript white space: a `WhiteSpace` or
/// `LineTerminator` code point (ECMA-262 §12.2, §12.3), which is what
/// `String.prototype.trim` removes and what `\s` matches in a regular
/// expression. Unlike [`char::is_whitespace`] it holds U+FEFF and not
/// U+0085.
#[must_use]
pub const fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\u{09}'..='\u{0d}'
            | ' '
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

/// `s.trim()`.
#[must_use]
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `s.trimStart()`.
#[must_use]
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_whitespace)
}

/// `s.trimEnd()`.
#[must_use]
pub fn trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// `s.length`: the number of UTF-16 code units, so a character outside the
/// Basic Multilingual Plane counts two.
#[must_use]
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `xs.sort()` with no comparator, on strings: ascending by UTF-16 code
/// units, stable (as `Array.prototype.sort` is since ES2019). Rust's own
/// order of `str` is by code point and puts U+E000–U+FFFF before the
/// characters outside the Basic Multilingual Plane; this does not.
pub fn sort_utf16<S: AsRef<str>>(xs: &mut [S]) {
    xs.sort_by(|a, b| compare_utf16(a.as_ref(), b.as_ref()));
}

/// `[...new Set(items)]`: each distinct item once, where it first occurs,
/// in order. (A `Set` and a `Map` iterate in insertion order; for strings,
/// its `SameValueZero` is `==`.)
#[must_use]
pub fn unique_in_order<T: Eq + Hash + Clone>(items: impl IntoIterator<Item = T>) -> Vec<T> {
    let mut seen: HashSet<T> = HashSet::new();
    items
        .into_iter()
        .filter(|x| seen.insert(x.clone()))
        .collect()
}
