//! Versions and ranges (spec/library.md "Versions").
//!
//! A [`Version`] is `MAJOR.MINOR.PATCH`: three decimal numbers of ASCII
//! digits, none with a leading zero, no sign, no space, no pre-release or
//! build part. Each is at most [`VERSION_COMPONENT_MAX`], 999 999 999: nine
//! digits, the bound the lock schema (`spec/lock-0.6.schema.json`,
//! `LibraryVersion`) holds a pinned version to, so that every version a
//! library may have is a version the lock can pin, and small enough to
//! survive JSON and JavaScript, whose numbers hold 2^53 − 1.
//!
//! A [`Range`] is `^MAJOR`, `^MAJOR.MINOR`, `^MAJOR.MINOR.PATCH` or an exact
//! version. A caret range names a version (components not written are 0) and
//! holds the versions from it up to, and not including, the next change of
//! the first nonzero component *among those written*. The specification
//! gives `^1.0` (`>= 1.0.0, < 2.0.0`), `^0.3` (`>= 0.3.0, < 0.4.0`) and
//! `^0.0.3` (`0.0.3` alone) and does not say what a range of zeros holds;
//! here the last component written is the one that may not change:
//!
//! | Range | Holds |
//! |---|---|
//! | `^0` | `>= 0.0.0, < 1.0.0` |
//! | `^0.0` | `>= 0.0.0, < 0.1.0` |
//! | `^0.0.0` | `0.0.0` alone |
//!
//! A range is held to a version by comparing prefixes of components, never
//! by computing the bound above it, so that nothing overflows at the largest
//! component. Each range and version has one written form, which
//! [`Display`](std::fmt::Display) gives back exactly (`^1.0` and `^1.0.0`
//! hold the same versions and are two ranges, as two texts).

use std::fmt;

/// The largest a component of a version may be: 999 999 999.
pub const VERSION_COMPONENT_MAX: u32 = 999_999_999;

/// Why a text is not a version or a range. A text has one fault: the first
/// that is found, in the order of this list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VersionFault {
    /// The text is empty, or is a `^` alone.
    Empty,
    /// It does not have the components the form has: a version has three
    /// (`1.0`, `1` and `1.0.0.0` are not versions), a caret range one to
    /// three.
    Components,
    /// A component is empty (`1..0`, `^1.`).
    EmptyComponent,
    /// A component has a character that is not an ASCII digit: a sign, a
    /// space, a letter, a pre-release or build part, a digit of another
    /// script.
    NotDecimal,
    /// A component of more than one digit starts with `0`.
    LeadingZero,
    /// A component is over [`VERSION_COMPONENT_MAX`].
    TooLarge,
}

impl VersionFault {
    /// The fault's identifier.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            VersionFault::Empty => "empty",
            VersionFault::Components => "components",
            VersionFault::EmptyComponent => "empty_component",
            VersionFault::NotDecimal => "not_decimal",
            VersionFault::LeadingZero => "leading_zero",
            VersionFault::TooLarge => "too_large",
        }
    }
}

/// One component: the number a text of ASCII digits without a leading zero
/// stands for, within [`VERSION_COMPONENT_MAX`].
fn component(text: &str) -> Result<u32, VersionFault> {
    if text.is_empty() {
        return Err(VersionFault::EmptyComponent);
    }
    if !text.bytes().all(|b| b.is_ascii_digit()) {
        return Err(VersionFault::NotDecimal);
    }
    if text.len() > 1 && text.starts_with('0') {
        return Err(VersionFault::LeadingZero);
    }
    // More than ten digits is over the bound whatever they are, and ten
    // digits fit a u64: nothing overflows.
    if text.len() > 10 {
        return Err(VersionFault::TooLarge);
    }
    match text.parse::<u64>() {
        Ok(n) if n <= u64::from(VERSION_COMPONENT_MAX) => {
            u32::try_from(n).map_err(|_| VersionFault::TooLarge)
        }
        _ => Err(VersionFault::TooLarge),
    }
}

/// The components of `text`, split at `.`: between `min` and `max` of them,
/// each valid. The faults are reported in this order: how many, then each
/// component's, first to last.
fn components(text: &str, min: usize, max: usize) -> Result<Vec<u32>, VersionFault> {
    if text.is_empty() {
        return Err(VersionFault::Empty);
    }
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() < min || parts.len() > max {
        return Err(VersionFault::Components);
    }
    parts.into_iter().map(component).collect()
}

/// A version: `MAJOR.MINOR.PATCH`. Versions compare by number, component by
/// component, `MAJOR` first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Version {
    major: u32,
    minor: u32,
    patch: u32,
}

impl Version {
    /// The version with these components, when each is within
    /// [`VERSION_COMPONENT_MAX`].
    #[must_use]
    pub fn new(major: u32, minor: u32, patch: u32) -> Option<Version> {
        [major, minor, patch]
            .iter()
            .all(|&c| c <= VERSION_COMPONENT_MAX)
            .then_some(Version {
                major,
                minor,
                patch,
            })
    }

    /// Reads a version: exactly `MAJOR.MINOR.PATCH`.
    ///
    /// # Errors
    ///
    /// The [`VersionFault`] that says why `text` is not one.
    pub fn parse(text: &str) -> Result<Version, VersionFault> {
        let parts = <[u32; 3]>::try_from(components(text, 3, 3)?)
            .map_err(|_| VersionFault::Components)?;
        let [major, minor, patch] = parts;
        Ok(Version {
            major,
            minor,
            patch,
        })
    }

    /// The first component, which a library's breaking changes raise.
    #[must_use]
    pub const fn major(&self) -> u32 {
        self.major
    }

    /// The second component.
    #[must_use]
    pub const fn minor(&self) -> u32 {
        self.minor
    }

    /// The third component.
    #[must_use]
    pub const fn patch(&self) -> u32 {
        self.patch
    }

    /// The components, `MAJOR` first.
    const fn parts(&self) -> [u32; 3] {
        [self.major, self.minor, self.patch]
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// How a range was written.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Form {
    /// `MAJOR.MINOR.PATCH`.
    Exact,
    /// `^` and one to three components; the number written is 1, 2 or 3.
    Caret { written: u8 },
}

/// A version range: an exact version, or a caret range.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Range {
    from: Version,
    form: Form,
}

impl Range {
    /// The range that holds `version` alone, written `MAJOR.MINOR.PATCH`.
    #[must_use]
    pub const fn exact(version: Version) -> Range {
        Range {
            from: version,
            form: Form::Exact,
        }
    }

    /// The caret range that names `from` and was written with `written`
    /// components (1 to 3; the ones not written must be 0, since they are
    /// not in the text), `^MAJOR`, `^MAJOR.MINOR` or `^MAJOR.MINOR.PATCH`.
    #[must_use]
    pub fn caret(from: Version, written: u8) -> Option<Range> {
        let unwritten_are_zero = match written {
            1 => from.minor == 0 && from.patch == 0,
            2 => from.patch == 0,
            3 => true,
            _ => false,
        };
        unwritten_are_zero.then_some(Range {
            from,
            form: Form::Caret { written },
        })
    }

    /// Reads a range: `^MAJOR`, `^MAJOR.MINOR`, `^MAJOR.MINOR.PATCH`, or an
    /// exact `MAJOR.MINOR.PATCH`.
    ///
    /// # Errors
    ///
    /// The [`VersionFault`] that says why `text` is not one.
    pub fn parse(text: &str) -> Result<Range, VersionFault> {
        let Some(rest) = text.strip_prefix('^') else {
            return Version::parse(text).map(Range::exact);
        };
        let found = components(rest, 1, 3)?;
        let written = u8::try_from(found.len()).map_err(|_| VersionFault::Components)?;
        let mut parts = [0_u32; 3];
        for (slot, n) in parts.iter_mut().zip(found) {
            *slot = n;
        }
        let [major, minor, patch] = parts;
        Ok(Range {
            from: Version {
                major,
                minor,
                patch,
            },
            form: Form::Caret { written },
        })
    }

    /// The lowest version the range holds.
    #[must_use]
    pub const fn lowest(&self) -> Version {
        self.from
    }

    /// Whether the range is one version, written without a caret.
    #[must_use]
    pub const fn is_exact(&self) -> bool {
        matches!(self.form, Form::Exact)
    }

    /// Whether the range holds `version`.
    ///
    /// A caret range holds the versions that are not below the one it names
    /// and that agree with it in every component up to its pivot: the first
    /// nonzero component among those written, or the last one written when
    /// they are all zero.
    #[must_use]
    pub fn holds(&self, version: &Version) -> bool {
        match self.form {
            Form::Exact => self.from == *version,
            Form::Caret { written } => {
                if *version < self.from {
                    return false;
                }
                let named = self.from.parts();
                let written = usize::from(written);
                let pivot = named
                    .iter()
                    .take(written)
                    .position(|&c| c != 0)
                    .unwrap_or_else(|| written.saturating_sub(1));
                version
                    .parts()
                    .iter()
                    .zip(named.iter())
                    .take(pivot.saturating_add(1))
                    .all(|(a, b)| a == b)
            }
        }
    }
}

impl fmt::Display for Range {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self.form {
            Form::Exact => fmt::Display::fmt(&self.from, f),
            Form::Caret { written: 1 } => write!(f, "^{}", self.from.major),
            Form::Caret { written: 2 } => write!(f, "^{}.{}", self.from.major, self.from.minor),
            Form::Caret { .. } => write!(f, "^{}", self.from),
        }
    }
}
