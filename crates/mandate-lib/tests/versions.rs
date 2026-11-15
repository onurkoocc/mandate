//! Versions and ranges: what they accept with the exact value, what they
//! refuse with the exact fault, and `holds` against a second, differently
//! written predicate.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use common::Table;
use mandate_lib::{Range, VERSION_COMPONENT_MAX, Version, VersionFault};

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

fn r(text: &str) -> Range {
    Range::parse(text).unwrap()
}

#[test]
fn versions_accepted_are_read_and_written_back_exactly() {
    let mut t = Table::new();
    for (text, parts) in [
        ("0.0.0", (0, 0, 0)),
        ("1.2.3", (1, 2, 3)),
        ("10.20.30", (10, 20, 30)),
        ("0.10.0", (0, 10, 0)),
        ("999999999.999999999.999999999", (999_999_999, 999_999_999, 999_999_999)),
    ] {
        let version = Version::parse(text).unwrap();
        t.eq(text, (version.major(), version.minor(), version.patch()), parts);
        t.eq(text, version.to_string(), text.to_owned());
    }
    t.finish();
}

#[test]
fn versions_refused_say_why() {
    use VersionFault::{Components, Empty, EmptyComponent, LeadingZero, NotDecimal, TooLarge};
    let mut t = Table::new();
    for (text, fault) in [
        ("", Empty),
        ("01.0.0", LeadingZero),
        ("1.00.0", LeadingZero),
        ("1.0.00", LeadingZero),
        ("00.0.0", LeadingZero),
        ("1.0", Components),
        ("1", Components),
        ("1.0.0.0", Components),
        ("1.0.0.", Components),
        (".", Components),
        ("1.0.0-rc1", NotDecimal),
        ("1.0.0+b", NotDecimal),
        ("1.0.0-", NotDecimal),
        (" 1.0.0", NotDecimal),
        ("1.0.0 ", NotDecimal),
        ("1.0.0\n", NotDecimal),
        ("1.0.0\0", NotDecimal),
        ("+1.0.0", NotDecimal),
        ("-1.0.0", NotDecimal),
        ("1.-1.0", NotDecimal),
        ("1.x.0", NotDecimal),
        ("1.0.0x", NotDecimal),
        ("0x1.0.0", NotDecimal),
        ("1e3.0.0", NotDecimal),
        // An Arabic-Indic digit one, and a full-width one.
        ("\u{661}.0.0", NotDecimal),
        ("\u{ff11}.0.0", NotDecimal),
        ("1..0", EmptyComponent),
        (".1.0", EmptyComponent),
        ("1.0.", EmptyComponent),
        ("..", EmptyComponent),
        // 2^32 and 2^64, and the bound's neighbours.
        ("4294967296.0.0", TooLarge),
        ("0.18446744073709551616.0", TooLarge),
        ("0.0.18446744073709551615", TooLarge),
        ("1000000000.0.0", TooLarge),
        ("0.1000000000.0", TooLarge),
        ("0.0.1000000000", TooLarge),
        ("0.0.99999999999999999999999999", TooLarge),
    ] {
        t.eq(&format!("{text:?}"), Version::parse(text).err(), Some(fault));
    }
    t.finish();
}

#[test]
fn the_bound_of_a_component_is_nine_digits() {
    assert_eq!(VERSION_COMPONENT_MAX, 999_999_999);
    assert!(Version::new(VERSION_COMPONENT_MAX, 0, 0).is_some());
    assert!(Version::new(0, VERSION_COMPONENT_MAX, 0).is_some());
    assert!(Version::new(0, 0, VERSION_COMPONENT_MAX).is_some());
    assert!(Version::new(VERSION_COMPONENT_MAX + 1, 0, 0).is_none());
    assert!(Version::new(0, VERSION_COMPONENT_MAX + 1, 0).is_none());
    assert!(Version::new(0, 0, u32::MAX).is_none());
}

#[test]
fn versions_compare_by_number_not_by_text() {
    let mut t = Table::new();
    for (low, high) in [
        ("1.9.0", "1.10.0"),
        ("1.99.99", "2.0.0"),
        ("0.0.9", "0.0.10"),
        ("0.9.9", "1.0.0"),
        ("1.0.0", "1.0.1"),
        ("2.0.0", "10.0.0"),
        ("999999999.999999999.998", "999999999.999999999.999999999"),
    ] {
        t.ok(&format!("{low} < {high}"), v(low) < v(high));
        t.ok(&format!("{high} > {low}"), v(high) > v(low));
    }
    t.eq("equal", v("1.2.3").cmp(&v("1.2.3")), std::cmp::Ordering::Equal);
    t.finish();
}

#[test]
fn ranges_accepted_are_written_back_as_written() {
    let mut t = Table::new();
    for text in [
        "^0", "^1", "^12", "^0.0", "^1.0", "^0.3", "^1.2.3", "^0.0.3", "^0.0.0", "1.2.3", "0.0.0",
        "^999999999", "^999999999.999999999.999999999",
    ] {
        t.eq(text, Range::parse(text).unwrap().to_string(), text.to_owned());
    }
    // A caret range and the version it names are two ranges.
    t.ok("^1.2.3 is not 1.2.3", r("^1.2.3") != r("1.2.3"));
    t.ok("^1.0 is not ^1.0.0 (two texts)", r("^1.0") != r("^1.0.0"));
    t.ok("exact", r("1.2.3").is_exact());
    t.ok("caret", !r("^1.2.3").is_exact());
    t.eq("lowest of ^1.2", r("^1.2").lowest(), v("1.2.0"));
    t.eq("lowest of ^7", r("^7").lowest(), v("7.0.0"));
    t.eq("lowest of 4.5.6", r("4.5.6").lowest(), v("4.5.6"));
    t.finish();
}

#[test]
fn ranges_refused_say_why() {
    use VersionFault::{Components, Empty, EmptyComponent, LeadingZero, NotDecimal, TooLarge};
    let mut t = Table::new();
    for (text, fault) in [
        ("", Empty),
        ("^", Empty),
        ("^1.", EmptyComponent),
        ("^.1", EmptyComponent),
        ("^1..2", EmptyComponent),
        ("^01", LeadingZero),
        ("^1.02", LeadingZero),
        ("~1.0", Components),
        ("~1.0.0", NotDecimal),
        (">=1.0", Components),
        (">=1.0.0", NotDecimal),
        ("1.x", Components),
        ("1.x.x", NotDecimal),
        ("*", Components),
        ("1", Components),
        ("1.0", Components),
        ("^1.0.0.0", Components),
        ("^ 1", NotDecimal),
        ("^1 ", NotDecimal),
        (" ^1", Components),
        ("^^1", NotDecimal),
        ("^-1", NotDecimal),
        ("^+1", NotDecimal),
        ("^1.x", NotDecimal),
        ("^1.0.0-rc1", NotDecimal),
        ("^\u{661}", NotDecimal),
        ("^4294967296", TooLarge),
        ("^1.18446744073709551616", TooLarge),
        ("^1000000000", TooLarge),
        ("1.0.0.", Components),
        ("01.0.0", LeadingZero),
    ] {
        t.eq(&format!("{text:?}"), Range::parse(text).err(), Some(fault));
    }
    t.finish();
}

#[test]
fn what_the_specification_says_a_caret_holds() {
    let mut t = Table::new();
    let cases: [(&str, &[(&str, bool)]); 8] = [
        (
            "^1.0",
            &[
                ("0.9.9", false),
                ("1.0.0", true),
                ("1.0.1", true),
                ("1.9.9", true),
                ("1.999999999.999999999", true),
                ("2.0.0", false),
            ],
        ),
        (
            "^0.3",
            &[
                ("0.2.9", false),
                ("0.3.0", true),
                ("0.3.99", true),
                ("0.4.0", false),
                ("1.3.0", false),
            ],
        ),
        (
            "^0.0.3",
            &[
                ("0.0.2", false),
                ("0.0.3", true),
                ("0.0.4", false),
                ("0.1.3", false),
                ("1.0.3", false),
            ],
        ),
        (
            "^1.2.3",
            &[
                ("1.2.2", false),
                ("1.2.3", true),
                ("1.3.0", true),
                ("1.99.0", true),
                ("2.0.0", false),
                ("0.9.0", false),
            ],
        ),
        (
            "^0.3.5",
            &[
                ("0.3.4", false),
                ("0.3.5", true),
                ("0.3.6", true),
                ("0.4.0", false),
            ],
        ),
        (
            "^2",
            &[
                ("1.9.9", false),
                ("2.0.0", true),
                ("2.5.7", true),
                ("3.0.0", false),
            ],
        ),
        (
            "^1.2",
            &[
                ("1.1.9", false),
                ("1.2.0", true),
                ("1.7.0", true),
                ("2.0.0", false),
            ],
        ),
        (
            "1.2.3",
            &[("1.2.2", false), ("1.2.3", true), ("1.2.4", false), ("1.3.3", false)],
        ),
    ];
    for (range, versions) in cases {
        for (version, holds) in versions {
            t.eq(&format!("{range} holds {version}"), r(range).holds(&v(version)), *holds);
        }
    }
    t.finish();
}

#[test]
fn what_a_range_of_zeros_holds_is_decided_here() {
    // The specification does not say. The last component written is the one
    // that may not change.
    let mut t = Table::new();
    let cases: [(&str, &[(&str, bool)]); 3] = [
        (
            "^0",
            &[
                ("0.0.0", true),
                ("0.0.1", true),
                ("0.9.9", true),
                ("0.999999999.999999999", true),
                ("1.0.0", false),
            ],
        ),
        (
            "^0.0",
            &[
                ("0.0.0", true),
                ("0.0.7", true),
                ("0.0.999999999", true),
                ("0.1.0", false),
                ("1.0.0", false),
            ],
        ),
        (
            "^0.0.0",
            &[("0.0.0", true), ("0.0.1", false), ("0.1.0", false), ("1.0.0", false)],
        ),
    ];
    for (range, versions) in cases {
        for (version, holds) in versions {
            t.eq(&format!("{range} holds {version}"), r(range).holds(&v(version)), *holds);
        }
    }
    t.finish();
}

/// The range as the bounds a person reads: `lo <= v < hi`, computed in
/// `u64` so that nothing wraps, with `hi` written out by the rule of the
/// specification ("up to, and not including, the next change of its first
/// nonzero component") and not by the pivot the crate uses.
fn bounds(written: usize, named: [u64; 3]) -> ([u64; 3], [u64; 3]) {
    let mut pivot = written - 1;
    for (i, &c) in named.iter().enumerate().take(written) {
        if c != 0 {
            pivot = i;
            break;
        }
    }
    let mut hi = [0_u64; 3];
    for i in 0..3 {
        hi[i] = if i < pivot {
            named[i]
        } else if i == pivot {
            named[i] + 1
        } else {
            0
        };
    }
    (named, hi)
}

fn text_of(written: usize, named: [u64; 3]) -> String {
    let parts: Vec<String> = named.iter().take(written).map(u64::to_string).collect();
    format!("^{}", parts.join("."))
}

fn sweep(values: &[u64]) -> usize {
    let mut t = Table::new();
    for written in 1..=3_usize {
        for &a in values {
            for &b in values {
                for &c in values {
                    // Components not written are 0.
                    let named = [
                        a,
                        if written >= 2 { b } else { 0 },
                        if written >= 3 { c } else { 0 },
                    ];
                    if (written < 2 && b != values[0]) || (written < 3 && c != values[0]) {
                        continue;
                    }
                    let text = text_of(written, named);
                    let range = Range::parse(&text).unwrap();
                    let (lo, hi) = bounds(written, named);
                    for &x in values {
                        for &y in values {
                            for &z in values {
                                let version = [x, y, z];
                                let want = lo <= version && version < hi;
                                let got = range.holds(
                                    &Version::new(x as u32, y as u32, z as u32).unwrap(),
                                );
                                t.eq(&format!("{text} holds {x}.{y}.{z}"), got, want);
                            }
                        }
                    }
                }
            }
        }
    }
    t.finish()
}

#[test]
fn holds_agrees_with_the_bounds_on_every_range_and_version_of_0_to_3() {
    let cases = sweep(&[0, 1, 2, 3]);
    // 84 ranges (4 + 16 + 64) and 64 versions each, less the repeats the
    // loop skips for components that are not written.
    assert_eq!(cases, 84 * 64);
}

#[test]
fn holds_agrees_with_the_bounds_at_the_largest_component() {
    let max = u64::from(VERSION_COMPONENT_MAX);
    let cases = sweep(&[0, 1, max - 1, max]);
    assert_eq!(cases, 84 * 64);
}

#[test]
fn the_upper_bound_is_right_at_the_top_of_the_number_space() {
    let max = VERSION_COMPONENT_MAX;
    let top = format!("{max}.{max}.{max}");
    let mut t = Table::new();
    // `^MAX` has no next major inside the bound, and holds everything of MAX.
    t.ok("^MAX holds MAX.MAX.MAX", r(&format!("^{max}")).holds(&v(&top)));
    t.ok("^MAX holds MAX.0.0", r(&format!("^{max}")).holds(&v(&format!("{max}.0.0"))));
    t.ok("^MAX does not hold MAX-1.MAX.MAX", !r(&format!("^{max}")).holds(&v(&format!("{}.{max}.{max}", max - 1))));
    t.ok("^0.MAX holds 0.MAX.MAX", r(&format!("^0.{max}")).holds(&v(&format!("0.{max}.{max}"))));
    t.ok("^0.MAX does not hold 0.MAX-1.MAX", !r(&format!("^0.{max}")).holds(&v(&format!("0.{}.{max}", max - 1))));
    t.ok("^0.0.MAX holds 0.0.MAX", r(&format!("^0.0.{max}")).holds(&v(&format!("0.0.{max}"))));
    t.ok("^0.0.MAX does not hold 0.0.MAX-1", !r(&format!("^0.0.{max}")).holds(&v(&format!("0.0.{}", max - 1))));
    t.ok("^MAX.MAX.MAX holds itself", r(&format!("^{top}")).holds(&v(&top)));
    t.ok("exact MAX holds itself", r(&top).holds(&v(&top)));
    t.ok("^1.0 does not hold MAX.0.0", !r("^1.0").holds(&v(&format!("{max}.0.0"))));
    t.finish();
}
