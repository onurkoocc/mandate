//! The regular expressions of `spec/ir.schema.json` and
//! `spec/lock.schema.json`, matched by hand.
//!
//! Ajv compiles a `pattern` as `new RegExp(pattern, "u")` and tests it with
//! `test`, which searches the whole string: a pattern holds only where it is
//! anchored. `$` without the `m` flag is the end of the input (not before a
//! final line feed, as in some other engines). With the `u` flag the input is
//! read by code points; every class here is ASCII, so a character outside
//! the Basic Multilingual Plane, one code point or two code units, never
//! matches one. Each matcher below keeps its pattern beside it and was
//! checked against Node's `RegExp` on the strings of the unit tests.
//!
//! A pattern that is not one of these has no matcher: the schema validator
//! refuses a schema that uses one ([`Pattern::from_source`] is `None`),
//! rather than ignoring it.

/// One of the patterns the schemas use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Pattern {
    /// `^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.]+)?$`, a program's `version`.
    ProgramVersion,
    /// `^[A-Za-z_][A-Za-z0-9_]*$`, a name.
    Name,
    /// `^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$`, a qualified name.
    QName,
    /// `^[A-Z]{3}$`, a currency.
    Currency,
    /// `^-?[0-9]+\.[0-9]+$`, a decimal literal.
    Decimal,
    /// `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`, a component's repository.
    Repo,
    /// `^(/|[A-Za-z]:[\/])`, a component's root.
    Root,
    /// `^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,2}$`, a host version in a lock.
    HostVersion,
    /// `^[A-Za-z][A-Za-z0-9_-]{0,63}$`, a credential's name in a lock.
    Credential,
    /// `^[a-z][a-z0-9_]*$`, a tier in a lock.
    Tier,
    /// `^[0-9]{4}-[0-9]{2}-[0-9]{2}$`, a tariff's date.
    Date,
    /// `^sha256:[0-9a-f]{64}$`, a digest.
    Sha256,
}

/// Every pattern with its source text, as the schemas write it.
const SOURCES: [(Pattern, &str); 12] = [
    (
        Pattern::ProgramVersion,
        r"^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.]+)?$",
    ),
    (Pattern::Name, r"^[A-Za-z_][A-Za-z0-9_]*$"),
    (
        Pattern::QName,
        r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$",
    ),
    (Pattern::Currency, r"^[A-Z]{3}$"),
    (Pattern::Decimal, r"^-?[0-9]+\.[0-9]+$"),
    (Pattern::Repo, r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"),
    (Pattern::Root, r"^(/|[A-Za-z]:[\/])"),
    (
        Pattern::HostVersion,
        r"^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,2}$",
    ),
    (Pattern::Credential, r"^[A-Za-z][A-Za-z0-9_-]{0,63}$"),
    (Pattern::Tier, r"^[a-z][a-z0-9_]*$"),
    (Pattern::Date, r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"),
    (Pattern::Sha256, r"^sha256:[0-9a-f]{64}$"),
];

/// `[A-Za-z_]`.
fn name_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

/// `[A-Za-z0-9_]`.
fn name_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`.
fn is_name(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(name_start) && chars.all(name_char)
}

/// `^[0-9]+$`.
fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `^(0|[1-9][0-9]{0,8})$`: one component of a host version.
fn is_host_component(s: &str) -> bool {
    s == "0" || (is_digits(s) && !s.starts_with('0') && s.len() <= 9)
}

impl Pattern {
    /// The matcher of the pattern whose source text is `source`, if there is one.
    pub(crate) fn from_source(source: &str) -> Option<Pattern> {
        SOURCES
            .iter()
            .find(|(_, text)| *text == source)
            .map(|(pattern, _)| *pattern)
    }

    /// `new RegExp(source, "u").test(s)`.
    pub(crate) fn test(self, s: &str) -> bool {
        match self {
            // ^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.]+)?$ : a component cannot
            // hold a dot or a sign, so taking each part greedily is the only
            // way the pattern can match.
            Pattern::ProgramVersion => {
                let (core, build) = match s.find(['-', '+']) {
                    Some(at) => (s.get(..at), s.get(at.saturating_add(1)..)),
                    None => (Some(s), None),
                };
                let core_ok = core.is_some_and(|c| c.split('.').all(is_digits));
                let build_ok = build.is_none_or(|b| {
                    !b.is_empty() && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '.')
                });
                core_ok && build_ok
            }
            // ^[A-Za-z_][A-Za-z0-9_]*$
            Pattern::Name => is_name(s),
            // ^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$ : names
            // joined by dots.
            Pattern::QName => s.split('.').all(is_name),
            // ^[A-Z]{3}$
            Pattern::Currency => s.len() == 3 && s.bytes().all(|b| b.is_ascii_uppercase()),
            // ^-?[0-9]+\.[0-9]+$
            Pattern::Decimal => {
                let unsigned = s.strip_prefix('-').unwrap_or(s);
                unsigned
                    .split_once('.')
                    .is_some_and(|(whole, fraction)| is_digits(whole) && is_digits(fraction))
            }
            // ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ : the class has no slash, so
            // there is exactly one.
            Pattern::Repo => {
                let part = |p: &str| {
                    !p.is_empty()
                        && p.chars()
                            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
                };
                s.split_once('/')
                    .is_some_and(|(owner, name)| part(owner) && part(name))
            }
            // ^(/|[A-Za-z]:[\/]) : not anchored at the end. `[\/]` is the
            // class of `/` alone (`\/` escapes the slash), so `C:\` does not
            // match.
            Pattern::Root => {
                let mut chars = s.chars();
                match chars.next() {
                    Some('/') => true,
                    Some(c) if c.is_ascii_alphabetic() => {
                        chars.next() == Some(':') && chars.next() == Some('/')
                    }
                    _ => false,
                }
            }
            // ^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,2}$ : one to
            // three components; a component cannot hold a dot.
            Pattern::HostVersion => {
                let mut count: usize = 0;
                let ok = s.split('.').all(|part| {
                    count = count.saturating_add(1);
                    is_host_component(part)
                });
                ok && count <= 3
            }
            // ^[A-Za-z][A-Za-z0-9_-]{0,63}$
            Pattern::Credential => {
                let mut chars = s.chars();
                chars.next().is_some_and(|c| c.is_ascii_alphabetic())
                    && s.len() <= 64
                    && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-'))
            }
            // ^[a-z][a-z0-9_]*$
            Pattern::Tier => {
                let mut chars = s.chars();
                chars.next().is_some_and(|c| c.is_ascii_lowercase())
                    && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
            }
            // ^[0-9]{4}-[0-9]{2}-[0-9]{2}$
            Pattern::Date => {
                let b = s.as_bytes();
                b.len() == 10
                    && b.iter().enumerate().all(|(i, c)| {
                        if i == 4 || i == 7 {
                            *c == b'-'
                        } else {
                            c.is_ascii_digit()
                        }
                    })
            }
            // ^sha256:[0-9a-f]{64}$
            Pattern::Sha256 => s.strip_prefix("sha256:").is_some_and(|hex| {
                hex.len() == 64 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
            }),
        }
    }
}

#[cfg(test)]
#[allow(clippy::panic)]
mod tests {
    use super::{Pattern, SOURCES};

    /// Asserts `pattern` on each string as Node's `RegExp(source, "u")` gives it.
    fn check(pattern: Pattern, cases: &[(&str, bool)]) {
        for (s, expected) in cases {
            if pattern.test(s) != *expected {
                panic!("{pattern:?} on {s:?}: expected {expected}");
            }
        }
    }

    #[test]
    fn every_source_has_its_matcher() {
        for (pattern, source) in SOURCES {
            assert_eq!(Pattern::from_source(source), Some(pattern));
        }
        assert_eq!(Pattern::from_source("^[a-z]+$"), None);
    }

    #[test]
    fn program_version() {
        check(
            Pattern::ProgramVersion,
            &[
                ("0.1", true),
                ("1", true),
                ("10.20.30", true),
                ("1.0-rc.1", true),
                ("1.0+build.5", true),
                ("1.0-a.b.c", true),
                ("1.0-", false),
                ("1.", false),
                ("1..2", false),
                (".1", false),
                ("1.0-rc+1", false),
                ("1.0+A-b", false),
                ("v1", false),
                ("1a", false),
                ("1.0 ", false),
                ("1.0\n", false),
                ("1.0-\u{1F600}", false),
                ("\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn name() {
        check(
            Pattern::Name,
            &[
                ("a", true),
                ("_", true),
                ("A9_z", true),
                ("__proto__", true),
                ("9a", false),
                ("a-b", false),
                ("a b", false),
                ("a\n", false),
                ("\u{e9}", false),
                ("a\u{1F600}", false),
                ("\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn qualified_name() {
        check(
            Pattern::QName,
            &[
                ("a", true),
                ("a.b", true),
                ("a.b.c", true),
                ("_x._y", true),
                ("a.", false),
                ("a..b", false),
                (".a", false),
                ("a.9b", false),
                ("9a.b", false),
                ("a.b\n", false),
                ("a.b\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn currency() {
        check(
            Pattern::Currency,
            &[
                ("USD", true),
                ("usd", false),
                ("USDX", false),
                ("US", false),
                ("EU1", false),
                ("U\u{1F600}D", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn decimal() {
        check(
            Pattern::Decimal,
            &[
                ("1.5", true),
                ("-1.5", true),
                ("-0.0", true),
                ("12.34", true),
                ("1", false),
                ("1.", false),
                ("-.5", false),
                ("+1.5", false),
                ("1.5.5", false),
                ("1.5\n", false),
                ("\u{1F600}", false),
            ],
        );
    }

    #[test]
    fn repo() {
        check(
            Pattern::Repo,
            &[
                ("acme/core", true),
                ("a/b", true),
                ("a.b-c_d/e.f", true),
                ("no slash", false),
                ("a/b/c", false),
                ("/b", false),
                ("a/", false),
                ("a b/c", false),
                ("a/\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn root() {
        check(
            Pattern::Root,
            &[
                ("/", true),
                ("/work", true),
                ("C:/x", true),
                ("c:/", true),
                ("/\u{1F600}", true),
                ("C:\\x", false),
                ("relative/path", false),
                ("C:", false),
                ("1:/x", false),
                ("CC:/", false),
                (":/", false),
                ("\u{1F600}/", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn host_version() {
        check(
            Pattern::HostVersion,
            &[
                ("0", true),
                ("22", true),
                ("0.1", true),
                ("1.2.3", true),
                ("0.0.0", true),
                ("123456789", true),
                ("999999999.0", true),
                ("1.2.3.4", false),
                ("01", false),
                ("1.01", false),
                ("1234567890", false),
                ("1..2", false),
                ("1.", false),
                ("22.x", false),
                ("2\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn credential() {
        let longest = "a".repeat(64);
        let too_long = "a".repeat(65);
        check(
            Pattern::Credential,
            &[
                ("github", true),
                ("g", true),
                ("A-b_c", true),
                (&longest, true),
                (&too_long, false),
                ("9x", false),
                ("-a", false),
                ("a\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn tier() {
        check(
            Pattern::Tier,
            &[
                ("standard", true),
                ("a1_", true),
                ("Standard", false),
                ("1a", false),
                ("a-b", false),
                ("a\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn date() {
        check(
            Pattern::Date,
            &[
                ("2026-10-09", true),
                ("2026-1-9", false),
                ("20261009", false),
                ("2026-10-091", false),
                ("2026-10-0\u{1F600}", false),
                ("", false),
            ],
        );
    }

    #[test]
    fn sha256() {
        let hex = "0123456789abcdef".repeat(4);
        let upper = format!("sha256:0123456789ABCDEF{}", "0123456789abcdef".repeat(3));
        check(
            Pattern::Sha256,
            &[
                (&format!("sha256:{hex}"), true),
                (&upper, false),
                ("sha256:short", false),
                (
                    &format!("sha256:{}", hex.get(..63).unwrap_or_default()),
                    false,
                ),
                (&format!("sha256:{hex}0"), false),
                (
                    &format!("sha256:{}\u{1F600}", hex.get(..63).unwrap_or_default()),
                    false,
                ),
            ],
        );
    }
}
