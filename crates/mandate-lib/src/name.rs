//! The names a library is made of: its own name (and a module's), and the
//! paths of its module files.
//!
//! # Names
//!
//! A library's name is "dot-separated lower-case names, as a module's name"
//! (spec/library.md "The manifest"). The parser reads a module's name as
//! names of ASCII letters, digits and `_` that do not start with a digit
//! joined by `.` (`qname`), allowing upper-case letters; the specification says
//! lower-case, and so do the lock schema (`LibraryName`, for the keys of its
//! `libraries` and their `modules`) and this crate: a name is one or more *segments*
//! joined by `.`, each of `[a-z_][a-z0-9_]*`, at most [`NAME_MAX_BYTES`]
//! bytes in all. Every module of a library has a name that is the library's
//! or begins with it and a `.`, so a module's name is held to the same rule.
//!
//! A library is stored in a directory of its name (`<dir>/<name>/<version>/`),
//! so a name must be one on every file system. On Windows a segment that is a
//! device name (`con`, `prn`, `aux`, `nul`, `com0` to `com9`, `lpt0` to
//! `lpt9`) makes a name that cannot be a directory (nor a file, with any
//! extension after it), and a name that ends in a dot or a space loses it;
//! the first is refused here, and the second cannot be written (a segment
//! is not empty, and ends in a letter, a digit or `_`). The other characters
//! that Windows refuses are not in the alphabet. A name is also never `.`
//! or `..`, and has no `/` or `\`, for the same reason.
//!
//! The compiler's own libraries are `std` and `std.…` ([`is_reserved_name`]).
//! A manifest may name one: the caller decides, since `mandate publish` must
//! refuse it and the compiler itself does not.
//!
//! # Module files
//!
//! A manifest lists its modules as paths relative to itself, which a command
//! line reads and copies. [`check_module_path`] is an allow-list of what such
//! a path may be, so that no path can leave the library's directory, name a
//! device, an alternate stream or a file the library itself writes, or be
//! two files on a file system that does not tell letters of one case from
//! the other.

/// The longest name, in bytes: 128. A directory's name may be 255 on the
/// file systems this meets, and it has a path of its own around it.
pub const NAME_MAX_BYTES: usize = 128;

/// The longest path of a module file, in bytes: 200.
pub const PATH_MAX_BYTES: usize = 200;

/// The longest segment of a module file's path, in bytes: 64.
pub const PATH_SEGMENT_MAX_BYTES: usize = 64;

/// The files a library's directory holds besides its modules, which no
/// module may be: the manifest and the publication time (compared without
/// regard to case).
pub const RESERVED_FILES: [&str; 2] = ["mandate.library.json", "index.json"];

/// The names Windows keeps for devices, which no directory or file may have
/// as its name or as the part of it before the first dot.
const DEVICE_NAMES: [&str; 24] = [
    "con", "prn", "aux", "nul", "com0", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
    "com8", "com9", "lpt0", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// Whether `stem` is a Windows device name, in any case.
#[must_use]
pub fn is_device_name(stem: &str) -> bool {
    let lower = stem.to_ascii_lowercase();
    DEVICE_NAMES.contains(&lower.as_str())
}

/// The part of a file name before its first dot, which is what Windows
/// compares with the device names.
fn stem(segment: &str) -> &str {
    segment.split('.').next().unwrap_or(segment)
}

/// Why a text is not a library's (or a module's) name. The first fault found
/// is the one given, in the order of this list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NameFault {
    /// The name is empty.
    Empty,
    /// It is over [`NAME_MAX_BYTES`].
    TooLong,
    /// A segment is empty: a leading, a trailing or a doubled `.`.
    EmptySegment,
    /// An upper-case ASCII letter.
    UpperCase,
    /// A segment starts with a character that is not `a` to `z` or `_`
    /// (a digit, a `-`, a character of another script).
    SegmentStart,
    /// A character that is not `a` to `z`, `0` to `9`, `_` or the `.` between
    /// segments.
    BadCharacter,
    /// A segment is a Windows device name (`con`, `nul`, `com1`, …).
    DeviceName,
}

impl NameFault {
    /// The fault's identifier.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            NameFault::Empty => "empty",
            NameFault::TooLong => "too_long",
            NameFault::EmptySegment => "empty_segment",
            NameFault::UpperCase => "upper_case",
            NameFault::SegmentStart => "segment_start",
            NameFault::BadCharacter => "bad_character",
            NameFault::DeviceName => "device_name",
        }
    }
}

/// Checks that `name` is a library's (or a module's) name.
///
/// # Errors
///
/// The [`NameFault`] that says why it is not one.
pub fn check_name(name: &str) -> Result<(), NameFault> {
    if name.is_empty() {
        return Err(NameFault::Empty);
    }
    if name.len() > NAME_MAX_BYTES {
        return Err(NameFault::TooLong);
    }
    if name.split('.').any(str::is_empty) {
        return Err(NameFault::EmptySegment);
    }
    for segment in name.split('.') {
        for (i, c) in segment.chars().enumerate() {
            let allowed = if i == 0 {
                matches!(c, 'a'..='z' | '_')
            } else {
                matches!(c, 'a'..='z' | '0'..='9' | '_')
            };
            if allowed {
                continue;
            }
            return Err(if c.is_ascii_uppercase() {
                NameFault::UpperCase
            } else if i == 0 {
                NameFault::SegmentStart
            } else {
                NameFault::BadCharacter
            });
        }
        if is_device_name(segment) {
            return Err(NameFault::DeviceName);
        }
    }
    Ok(())
}

/// Whether `name` is a library's (or a module's) name: [`check_name`] gives
/// no fault.
#[must_use]
pub fn is_name(name: &str) -> bool {
    check_name(name).is_ok()
}

/// Whether `name` is `std` or begins with `std.`: the compiler's own
/// libraries, such as `std.patterns`. [`check_name`] accepts them; a caller
/// that publishes or reads a library from a directory refuses them.
#[must_use]
pub fn is_reserved_name(name: &str) -> bool {
    name == "std" || name.starts_with("std.")
}

/// Whether `module` is `library`'s own module name (the same) or begins with
/// `library` and a dot. `acmex.y` does not belong to `acme`.
#[must_use]
pub fn module_belongs_to(module: &str, library: &str) -> bool {
    module == library
        || module
            .strip_prefix(library)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Why a text is not the path of a module file. The first fault found is the
/// one given, in the order of this list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathFault {
    /// The path is empty.
    Empty,
    /// It is over [`PATH_MAX_BYTES`].
    TooLong,
    /// A byte outside ASCII (so no letter that looks like an ASCII one).
    NotAscii,
    /// A control character, NUL included, or DEL.
    ControlCharacter,
    /// A `\`: segments are separated by `/` alone.
    Backslash,
    /// A `:` (a drive, an alternate data stream).
    Colon,
    /// The path starts with `/`.
    LeadingSlash,
    /// A segment is empty: `a//b`, or a trailing `/`.
    EmptySegment,
    /// A segment is `.` or `..`.
    DotSegment,
    /// A segment is over [`PATH_SEGMENT_MAX_BYTES`].
    SegmentTooLong,
    /// A segment ends in `.` or a space, which Windows drops.
    TrailingDotOrSpace,
    /// A segment starts with a character that is not a letter, a digit or
    /// `_`: a `.` (a hidden file), a `-`, a space.
    SegmentStart,
    /// A character that is not a letter, a digit, `_`, `-` or `.`.
    BadCharacter,
    /// A segment is a Windows device name (`con`, `NUL.json`, `aux/x.mdt`).
    DeviceName,
    /// The path does not end in `.mdt` or `.json`, in lower case.
    Extension,
    /// The first segment is `mandate.library.json` or `index.json`, in any
    /// case: what the library's own directory holds besides its modules.
    ReservedFile,
}

impl PathFault {
    /// The fault's identifier.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            PathFault::Empty => "empty",
            PathFault::TooLong => "too_long",
            PathFault::NotAscii => "not_ascii",
            PathFault::ControlCharacter => "control_character",
            PathFault::Backslash => "backslash",
            PathFault::Colon => "colon",
            PathFault::LeadingSlash => "leading_slash",
            PathFault::EmptySegment => "empty_segment",
            PathFault::DotSegment => "dot_segment",
            PathFault::SegmentTooLong => "segment_too_long",
            PathFault::TrailingDotOrSpace => "trailing_dot_or_space",
            PathFault::SegmentStart => "segment_start",
            PathFault::BadCharacter => "bad_character",
            PathFault::DeviceName => "device_name",
            PathFault::Extension => "extension",
            PathFault::ReservedFile => "reserved_file",
        }
    }
}

/// Checks that `path` is a safe relative path of a module file: segments of
/// `[A-Za-z0-9_][A-Za-z0-9_.-]*` that do not end in a dot, separated by `/`,
/// no segment a Windows device name, the whole ending in `.mdt` or `.json`,
/// and not one of [`RESERVED_FILES`] at the library's root. It is an
/// allow-list: whatever it does not list is refused.
///
/// A path that passes can still collide with another of the same manifest
/// (the same file in another case, a file that is another's directory); the
/// manifest reader checks that across its list.
///
/// # Errors
///
/// The [`PathFault`] that says why it is not one.
pub fn check_module_path(path: &str) -> Result<(), PathFault> {
    if path.is_empty() {
        return Err(PathFault::Empty);
    }
    if path.len() > PATH_MAX_BYTES {
        return Err(PathFault::TooLong);
    }
    if !path.is_ascii() {
        return Err(PathFault::NotAscii);
    }
    if path.bytes().any(|b| b < 0x20 || b == 0x7f) {
        return Err(PathFault::ControlCharacter);
    }
    if path.contains('\\') {
        return Err(PathFault::Backslash);
    }
    if path.contains(':') {
        return Err(PathFault::Colon);
    }
    if path.starts_with('/') {
        return Err(PathFault::LeadingSlash);
    }
    for segment in path.split('/') {
        check_segment(segment)?;
    }
    if !(path.ends_with(".mdt") || path.ends_with(".json")) {
        return Err(PathFault::Extension);
    }
    let first = path.split('/').next().unwrap_or(path).to_ascii_lowercase();
    if RESERVED_FILES.contains(&first.as_str()) {
        return Err(PathFault::ReservedFile);
    }
    Ok(())
}

/// One segment of a module file's path.
fn check_segment(segment: &str) -> Result<(), PathFault> {
    if segment.is_empty() {
        return Err(PathFault::EmptySegment);
    }
    if segment == "." || segment == ".." {
        return Err(PathFault::DotSegment);
    }
    if segment.len() > PATH_SEGMENT_MAX_BYTES {
        return Err(PathFault::SegmentTooLong);
    }
    if segment.ends_with(['.', ' ']) {
        return Err(PathFault::TrailingDotOrSpace);
    }
    let mut bytes = segment.bytes();
    if !bytes
        .next()
        .is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        return Err(PathFault::SegmentStart);
    }
    if !bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')) {
        return Err(PathFault::BadCharacter);
    }
    if is_device_name(stem(segment)) {
        return Err(PathFault::DeviceName);
    }
    Ok(())
}
