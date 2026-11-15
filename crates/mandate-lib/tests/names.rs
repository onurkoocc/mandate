//! Names of libraries and modules, and the paths of module files.

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
use mandate_lib::{
    NAME_MAX_BYTES, NameFault, PATH_MAX_BYTES, PATH_SEGMENT_MAX_BYTES, PathFault,
    check_module_path, check_name, is_device_name, is_name, is_reserved_name, module_belongs_to,
};

#[test]
fn names_accepted() {
    let mut t = Table::new();
    let longest = "a".repeat(NAME_MAX_BYTES);
    for name in [
        "a",
        "acme",
        "acme.connectors",
        "std",
        "std.patterns",
        "_x",
        "_",
        "a1.b_2.c__3",
        "a.b.c.d.e.f",
        "nulx",
        "conn",
        "com10",
        "lpt",
        "acme.console",
        longest.as_str(),
    ] {
        t.eq(&format!("{name:?}"), check_name(name), Ok(()));
    }
    t.finish();
}

#[test]
fn names_refused_say_why() {
    use NameFault::{
        BadCharacter, DeviceName, Empty, EmptySegment, SegmentStart, TooLong, UpperCase,
    };
    let too_long = "a".repeat(NAME_MAX_BYTES + 1);
    let mut t = Table::new();
    for (name, fault) in [
        ("", Empty),
        (too_long.as_str(), TooLong),
        ("Acme", UpperCase),
        ("acme.Connectors", UpperCase),
        ("aCme", UpperCase),
        ("ACME", UpperCase),
        ("acme..x", EmptySegment),
        (".acme", EmptySegment),
        ("acme.", EmptySegment),
        (".", EmptySegment),
        ("1acme", SegmentStart),
        ("acme.1x", SegmentStart),
        ("acme.-x", SegmentStart),
        ("\u{e9}acme", SegmentStart),
        ("ac-me", BadCharacter),
        ("acme x", BadCharacter),
        (" acme", SegmentStart),
        ("acme ", BadCharacter),
        ("acm\u{e9}", BadCharacter),
        // Cyrillic small letter a, which looks like an ASCII one.
        ("acme.\u{430}", SegmentStart),
        ("ac\u{430}me", BadCharacter),
        ("acme\0", BadCharacter),
        ("acme\n", BadCharacter),
        ("acme/x", BadCharacter),
        ("acme\\x", BadCharacter),
        ("acme:x", BadCharacter),
        ("acme~1", BadCharacter),
        ("acme$", BadCharacter),
        ("con", DeviceName),
        ("prn", DeviceName),
        ("aux", DeviceName),
        ("nul", DeviceName),
        ("com0", DeviceName),
        ("com1", DeviceName),
        ("com9", DeviceName),
        ("lpt1", DeviceName),
        ("lpt9", DeviceName),
        ("acme.nul", DeviceName),
        ("con.acme", DeviceName),
        ("acme.con.x", DeviceName),
    ] {
        t.eq(&format!("{name:?}"), check_name(name), Err(fault));
    }
    t.finish();
}

#[test]
fn is_name_is_check_name() {
    assert!(is_name("acme.connectors"));
    assert!(!is_name("Acme"));
    assert!(!is_name(""));
}

#[test]
fn reserved_names_are_std_and_what_is_under_it() {
    let mut t = Table::new();
    for (name, reserved) in [
        ("std", true),
        ("std.patterns", true),
        ("std.a.b", true),
        ("stdx", false),
        ("std_x", false),
        ("standard", false),
        ("acme.std", false),
        ("acme", false),
        ("", false),
        ("st", false),
        ("STD", false),
    ] {
        t.eq(name, is_reserved_name(name), reserved);
    }
    // The reader does not refuse them: the caller decides.
    t.eq("std is a name", check_name("std"), Ok(()));
    t.eq("std.patterns is a name", check_name("std.patterns"), Ok(()));
    t.finish();
}

#[test]
fn a_module_belongs_to_a_library_by_its_name_and_a_dot() {
    let mut t = Table::new();
    for (module, library, belongs) in [
        ("acme", "acme", true),
        ("acme.x", "acme", true),
        ("acme.x.y", "acme", true),
        ("acme.connectors", "acme.connectors", true),
        ("acme.connectors.types", "acme.connectors", true),
        // The prefix needs the dot.
        ("acmex", "acme", false),
        ("acmex.y", "acme", false),
        ("acme_x", "acme", false),
        ("acme2.x", "acme", false),
        ("acm", "acme", false),
        ("acm.x", "acme", false),
        ("other.acme", "acme", false),
        ("acme.connectorsx", "acme.connectors", false),
        ("acme", "acme.connectors", false),
        ("", "acme", false),
        // Case is not folded.
        ("Acme.x", "acme", false),
        ("ACME", "acme", false),
    ] {
        t.eq(
            &format!("{module} of {library}"),
            module_belongs_to(module, library),
            belongs,
        );
    }
    t.finish();
}

#[test]
fn device_names_in_any_case() {
    let mut t = Table::new();
    for name in [
        "con", "CON", "Nul", "AUX", "prn", "com5", "COM9", "Lpt3", "lpt0",
    ] {
        t.ok(name, is_device_name(name));
    }
    for name in ["conn", "co", "com", "com10", "lpt", "nul.x", "console", ""] {
        t.ok(name, !is_device_name(name));
    }
    t.finish();
}

#[test]
fn module_paths_accepted() {
    let mut t = Table::new();
    let long_segment = format!("{}.mdt", "a".repeat(PATH_SEGMENT_MAX_BYTES - 4));
    for path in [
        "connectors.mdt",
        "types.json",
        "a/b/c.mdt",
        "lib/types_v2.mdt",
        "A.mdt",
        "Mixed_Case-Name.json",
        "x-y.z.mdt",
        "sub.dir/x.mdt",
        "a..b.mdt",
        "_private.mdt",
        "0.mdt",
        // Not at the root, so not the library's own files.
        "sub/index.json",
        "sub/mandate.library.json",
        "nulx.mdt",
        "console.mdt",
        "com10.mdt",
        "mandate.library.json.mdt",
        long_segment.as_str(),
    ] {
        t.eq(&format!("{path:?}"), check_module_path(path), Ok(()));
    }
    t.finish();
}

#[test]
fn module_paths_refused_say_why() {
    use PathFault::{
        Backslash, BadCharacter, Colon, ControlCharacter, DeviceName, DotSegment, EmptySegment,
        Extension, LeadingSlash, NotAscii, ReservedFile, SegmentStart, SegmentTooLong, TooLong,
        TrailingDotOrSpace,
    };
    let too_long = format!("{}.mdt", "a/".repeat(PATH_MAX_BYTES / 2));
    let segment_too_long = format!("{}.mdt", "a".repeat(PATH_SEGMENT_MAX_BYTES));
    let mut t = Table::new();
    for (path, fault) in [
        ("", PathFault::Empty),
        (too_long.as_str(), TooLong),
        (segment_too_long.as_str(), SegmentTooLong),
        ("../x.mdt", DotSegment),
        ("..", DotSegment),
        (".", DotSegment),
        ("/x.mdt", LeadingSlash),
        ("//x.mdt", LeadingSlash),
        ("/etc/passwd.json", LeadingSlash),
        ("C:/x.mdt", Colon),
        ("C:x.mdt", Colon),
        ("x.mdt:stream", Colon),
        ("a\\b.mdt", Backslash),
        ("..\\x.mdt", Backslash),
        ("a//b.mdt", EmptySegment),
        ("a/", EmptySegment),
        ("x.mdt/", EmptySegment),
        ("./a.mdt", DotSegment),
        ("a/./b.mdt", DotSegment),
        ("a/../b.mdt", DotSegment),
        ("a/b/..", DotSegment),
        ("x.mdt ", TrailingDotOrSpace),
        ("x.mdt.", TrailingDotOrSpace),
        ("a./b.mdt", TrailingDotOrSpace),
        ("a /b.mdt", TrailingDotOrSpace),
        (" x.mdt", SegmentStart),
        (".hidden.mdt", SegmentStart),
        ("a/.hidden.mdt", SegmentStart),
        ("-x.mdt", SegmentStart),
        ("a b.mdt", BadCharacter),
        ("a*.mdt", BadCharacter),
        ("a?.mdt", BadCharacter),
        ("a\".mdt", BadCharacter),
        ("a<b>.mdt", BadCharacter),
        ("a|b.mdt", BadCharacter),
        ("a$.mdt", BadCharacter),
        ("PROGRA~1.mdt", BadCharacter),
        ("a@b.mdt", BadCharacter),
        ("a#b.mdt", BadCharacter),
        ("a%20b.mdt", BadCharacter),
        ("con.mdt", DeviceName),
        ("CON.mdt", DeviceName),
        ("NUL.json", DeviceName),
        ("aux/x.mdt", DeviceName),
        ("a/Lpt1.mdt", DeviceName),
        ("COM3.x.mdt", DeviceName),
        ("prn.json", DeviceName),
        ("x.MDT", Extension),
        ("x.Json", Extension),
        ("x.JSON", Extension),
        ("x.txt", Extension),
        ("x.mdt.bak", Extension),
        ("x.md", Extension),
        ("x", Extension),
        ("con", DeviceName),
        ("mdt", Extension),
        ("a\0b.mdt", ControlCharacter),
        ("\0", ControlCharacter),
        ("a\tb.mdt", ControlCharacter),
        ("a\nb.mdt", ControlCharacter),
        ("a\rb.mdt", ControlCharacter),
        ("a\u{7f}.mdt", ControlCharacter),
        ("a\u{1b}.mdt", ControlCharacter),
        // Cyrillic small letter a, which looks like an ASCII one.
        ("\u{430}.mdt", NotAscii),
        ("a\u{430}.mdt", NotAscii),
        ("caf\u{e9}.mdt", NotAscii),
        // Fullwidth full stop, and a right-to-left override.
        ("a\u{ff0e}mdt", NotAscii),
        ("a\u{202e}.mdt", NotAscii),
        ("index.json", ReservedFile),
        ("Index.json", ReservedFile),
        ("mandate.library.json", ReservedFile),
        ("Mandate.Library.json", ReservedFile),
        ("Mandate.Library.Json", Extension),
        ("index.json/x.mdt", ReservedFile),
        ("mandate.library.json/x.json", ReservedFile),
    ] {
        t.eq(&format!("{path:?}"), check_module_path(path), Err(fault));
    }
    t.finish();
}

#[test]
fn the_bounds_of_a_path_are_exact() {
    let mut t = Table::new();
    let at_limit = format!("{}.mdt", "a".repeat(PATH_SEGMENT_MAX_BYTES - 4));
    t.eq("segment at the bound", check_module_path(&at_limit), Ok(()));
    let over = format!("{}.mdt", "a".repeat(PATH_SEGMENT_MAX_BYTES - 3));
    t.eq(
        "segment over the bound",
        check_module_path(&over),
        Err(PathFault::SegmentTooLong),
    );
    // Paths of 200 bytes in segments of 50: 3 segments of 50 and 3 slashes
    // make 153; make one of exactly the limit.
    let mut path = String::new();
    while path.len() + 1 + 50 <= PATH_MAX_BYTES - 8 {
        path.push_str(&"d".repeat(50));
        path.push('/');
    }
    path.push_str(&"e".repeat(PATH_MAX_BYTES - path.len() - 4));
    path.push_str(".mdt");
    t.eq(
        "path at the bound",
        (path.len(), check_module_path(&path)),
        (PATH_MAX_BYTES, Ok(())),
    );
    path.insert(0, 'z');
    t.eq(
        "path over the bound",
        check_module_path(&path),
        Err(PathFault::TooLong),
    );
    t.finish();
}
