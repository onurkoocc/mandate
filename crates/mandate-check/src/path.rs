//! The `Path` type (K68, G14): a port of `compiler/src/path.ts`.
//!
//! A Path names a file relative to the root of a working copy, the same way
//! on every host and executor:
//!
//! - one or more segments separated by `/`
//! - no empty segment: no leading or trailing `/`, no `//`
//! - no `.` or `..` segment
//! - no `\`, no `:` (a Windows drive or alternate data stream), no NUL
//!
//! A model's answer that breaks the rule is refused by schema validation
//! (`runtime/src/schema.ts`), and a text literal that breaks it where a Path
//! is expected does not check (E0204). The runtime still checks each path
//! where it uses one (`runtime/src/paths.ts`): the type is the first line,
//! not the only one.

/// The rule as a JSON Schema `pattern` (ECMA 262): `PATH_PATTERN`.
///
/// ```js
/// const CH = "[^/\\\\:\\x00]";
/// const FIRST = "[^/\\\\:\\x00.]";
/// // A segment that is not `.` or `..`, written without lookahead so that a
/// // model provider's structured output accepts it.
/// const SEGMENT = `(${FIRST}${CH}*|\\.${FIRST}${CH}*|\\.\\.${CH}+)`;
/// export const PATH_PATTERN = `^${SEGMENT}(/${SEGMENT})*$`;
/// ```
pub const PATH_PATTERN: &str = r"^([^/\\:\x00.][^/\\:\x00]*|\.[^/\\:\x00.][^/\\:\x00]*|\.\.[^/\\:\x00]+)(/([^/\\:\x00.][^/\\:\x00]*|\.[^/\\:\x00.][^/\\:\x00]*|\.\.[^/\\:\x00]+))*$";

/// Whether `segment` matches `SEGMENT`. Its three alternatives, a first
/// character that is not `.`, then `.` and one that is not, then `..` and
/// at least one more, together take every non-empty run of characters that
/// are none of `/`, `\`, `:` and NUL, except `.` and `..`. (With the `u`
/// flag the pattern reads code points; every class is ASCII, so code points
/// and code units take the same strings.)
fn is_segment(segment: &str) -> bool {
    !segment.is_empty() && segment != "." && segment != ".." && !segment.contains(['\\', ':', '\0'])
}

/// `new RegExp(PATH_PATTERN, "u").test(s)`: segments separated by `/`, each
/// matching `SEGMENT`.
fn matches(s: &str) -> bool {
    s.split('/').all(is_segment)
}

/// Why `s` is not a Path, or `None` when it is one: `pathProblem`.
///
/// ```js
/// if (RE.test(s)) return undefined;
/// if (s === "") return "it is empty";
/// if (s.includes("\0")) return "it contains NUL";
/// if (s.includes("\\")) return "it contains `\\`; use `/`";
/// if (s.includes(":")) return "it contains `:` (a drive or a stream)";
/// if (s.startsWith("/")) return "it is absolute";
/// if (s.endsWith("/") || s.includes("//")) return "it has an empty segment";
/// return "it has a `.` or `..` segment";
/// ```
#[must_use]
pub fn path_problem(s: &str) -> Option<&'static str> {
    if matches(s) {
        return None;
    }
    Some(if s.is_empty() {
        "it is empty"
    } else if s.contains('\0') {
        "it contains NUL"
    } else if s.contains('\\') {
        "it contains `\\`; use `/`"
    } else if s.contains(':') {
        "it contains `:` (a drive or a stream)"
    } else if s.starts_with('/') {
        "it is absolute"
    } else if s.ends_with('/') || s.contains("//") {
        "it has an empty segment"
    } else {
        "it has a `.` or `..` segment"
    })
}

/// Whether `s` is a Path: `isPath` on a string.
#[must_use]
pub fn is_path(s: &str) -> bool {
    matches(s)
}
