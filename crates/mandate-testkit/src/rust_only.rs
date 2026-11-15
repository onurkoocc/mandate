//! The language versions only the Rust compiler reads, and the one rule by
//! which its results are compared with the TypeScript's stored ones because
//! of them (`vectors/README.md`, "The versions only the Rust compiler
//! reads").
//!
//! The Rust compiler reads language 0.6 (spec/library.md); the TypeScript
//! compiler stays at 0.5 for ever. A program of 0.1 to 0.5 reads, checks,
//! hashes and prints in the Rust exactly as in the TypeScript, with one
//! difference: what lists the language versions a compiler reads has one
//! entry more. That is E0103, whose message and `facts.expected` name them,
//! and the `tables` door's `LANGUAGE_VERSIONS`; and the door's
//! `LANGUAGE_VERSION`, the newest version, is 0.6 where the TypeScript's is
//! 0.5. Every comparison of the Rust with a stored result of the TypeScript
//! goes through this module first, and nowhere else is a result changed
//! before it is compared:
//!
//! - [`KNOWN_VERSIONS`]: in every E0103 (in its message, and in its
//!   `facts.expected`) and in `LANGUAGE_VERSIONS`, the versions of
//!   [`RUST_ONLY_LANGUAGES`] are taken out ([`diagnostic_as_typescript`],
//!   [`js_as_typescript`], [`tables_as_typescript`]).
//! - [`NEWEST_VERSION`]: the `LANGUAGE_VERSION` of the `tables` door is
//!   [`TYPESCRIPT_NEWEST`] when the Rust's is [`RUST_NEWEST`]
//!   ([`tables_as_typescript`]).
//!
//! Each gate that applies a rule counts the stored results the rule changed
//! something in, and holds the count to [`PINNED`] ([`check_count`]), so
//! that the rule cannot come to cover more results without a commit that
//! says so. The cases and vectors of 0.6 itself are written by hand or by
//! the Rust, and are compared whole, with no rule.

use mandate_ir::{Diagnostic, JsObject, JsValue};

/// The language versions the Rust compiler reads and the TypeScript one
/// does not.
pub const RUST_ONLY_LANGUAGES: [&str; 1] = ["mandate/0.6"];

/// The newest language version the Rust compiler reads
/// (`mandate_ir::Language::NEWEST`).
pub const RUST_NEWEST: &str = "mandate/0.6";

/// The newest language version the TypeScript compiler reads
/// (`LANGUAGE_VERSION` in `compiler/src/ir/types.ts`).
pub const TYPESCRIPT_NEWEST: &str = "mandate/0.5";

/// The first rule, as the gates print it.
pub const KNOWN_VERSIONS: &str = "the list of the language versions a compiler reads, with mandate/0.6 taken out (E0103's message and facts.expected, the tables door's LANGUAGE_VERSIONS)";

/// The second rule, as the gates print it.
pub const NEWEST_VERSION: &str = "the newest language version, mandate/0.6 in the Rust and mandate/0.5 in the TypeScript (the tables door's LANGUAGE_VERSION)";

/// For each gate that applies a rule, by the title it prints, the number of
/// stored results the rule changes something in. A gate that applies one
/// and is not listed here fails, as does one whose count is not this.
pub const PINNED: &[(&str, usize)] = &[
    ("invalid IR diagnostics", 5),
    ("diagnostic vectors", 2),
    ("conformance cases", 2),
    ("syntax", 2),
    ("corpus", 5),
    ("json doors of crates/mandate-check/tests/json_doors", 1),
];

/// The code whose message and facts list the versions.
const UNKNOWN_LANGUAGE: &str = "MDT-E0103";

/// `message` without the Rust-only versions in its list: ` or "v"` (the
/// reader of JSON IR) and ` or 'v'` (the parser) taken out.
fn message_as_typescript(message: &str) -> String {
    let mut out = message.to_owned();
    for v in RUST_ONLY_LANGUAGES {
        out = out
            .replace(&format!(" or \"{v}\""), "")
            .replace(&format!(" or '{v}'"), "");
    }
    out
}

/// A list of versions without the Rust-only ones, when `v` is an array.
fn list_as_typescript(v: &mut JsValue) {
    if let JsValue::Array(items) = v {
        items.retain(|x| x.as_str().is_none_or(|s| !RUST_ONLY_LANGUAGES.contains(&s)));
    }
}

/// `facts.expected` without the Rust-only versions.
fn facts_as_typescript(facts: &mut JsObject) {
    if let Some(expected) = facts.get_mut("expected") {
        list_as_typescript(expected);
    }
}

/// [`KNOWN_VERSIONS`] on one diagnostic: whether it changed it.
pub fn diagnostic_as_typescript(d: &mut Diagnostic) -> bool {
    if d.code != UNKNOWN_LANGUAGE {
        return false;
    }
    let before = d.clone();
    d.message = message_as_typescript(&d.message);
    if let Some(facts) = d.facts.as_mut() {
        facts_as_typescript(facts);
    }
    *d != before
}

/// [`KNOWN_VERSIONS`] on each diagnostic of a result: whether it changed
/// any.
pub fn diagnostics_as_typescript(ds: &mut [Diagnostic]) -> bool {
    let mut changed = false;
    for d in ds {
        changed |= diagnostic_as_typescript(d);
    }
    changed
}

/// [`KNOWN_VERSIONS`] on every diagnostic in a result as JSON (an object
/// whose `code` is E0103, wherever it is): whether it changed any.
pub fn js_as_typescript(v: &mut JsValue) -> bool {
    match v {
        JsValue::Array(items) => {
            let mut changed = false;
            for x in items {
                changed |= js_as_typescript(x);
            }
            changed
        }
        JsValue::Object(o) => {
            if o.get("code").and_then(JsValue::as_str) == Some(UNKNOWN_LANGUAGE) {
                let before = o.clone();
                if let Some(JsValue::String(message)) = o.get_mut("message") {
                    *message = message_as_typescript(message);
                }
                if let Some(JsValue::Object(facts)) = o.get_mut("facts") {
                    facts_as_typescript(facts);
                }
                return *o != before;
            }
            let keys: Vec<String> = o.keys().map(str::to_owned).collect();
            let mut changed = false;
            for k in keys {
                if let Some(x) = o.get_mut(&k) {
                    changed |= js_as_typescript(x);
                }
            }
            changed
        }
        _ => false,
    }
}

/// Whether a stored result holds an E0103, the diagnostic [`KNOWN_VERSIONS`]
/// is about, anywhere: for a gate that counts the stored results it applies
/// to rather than the Rust results it changed (the corpus, whose test
/// compares each entry on its own).
#[must_use]
pub fn holds_unknown_language(v: &JsValue) -> bool {
    match v {
        JsValue::Array(items) => items.iter().any(holds_unknown_language),
        JsValue::Object(o) => {
            o.get("code").and_then(JsValue::as_str) == Some(UNKNOWN_LANGUAGE)
                || o.iter().any(|(_, x)| holds_unknown_language(x))
        }
        _ => false,
    }
}

/// [`KNOWN_VERSIONS`] and [`NEWEST_VERSION`] on the output of the `tables`
/// door: `LANGUAGE_VERSIONS` without the Rust-only versions, and
/// `LANGUAGE_VERSION` the TypeScript's when it is the Rust's newest. Whether
/// it changed either.
pub fn tables_as_typescript(v: &mut JsValue) -> bool {
    let JsValue::Object(o) = v else {
        return false;
    };
    let before = o.clone();
    if let Some(list) = o.get_mut("LANGUAGE_VERSIONS") {
        list_as_typescript(list);
    }
    if o.get("LANGUAGE_VERSION").and_then(JsValue::as_str) == Some(RUST_NEWEST) {
        o.insert("LANGUAGE_VERSION", TYPESCRIPT_NEWEST);
    }
    *o != before
}

/// Holds the number of stored results a gate changed by a rule to the one
/// [`PINNED`] gives it, and prints it.
///
/// # Errors
///
/// When the gate is not listed (and changed any), or its count is not the
/// pinned one.
pub fn check_count(gate: &str, changed: usize) -> Result<String, String> {
    let pinned = PINNED.iter().find(|(g, _)| *g == gate).map(|(_, n)| *n);
    let line = format!(
        "{gate}: {changed} stored result(s) compared without the versions only the Rust reads"
    );
    println!("{line}");
    match pinned {
        Some(n) if n == changed => Ok(line),
        None if changed == 0 => Ok(line),
        Some(n) => Err(format!(
            "{line}, where mandate_testkit::rust_only::PINNED says {n}: a stored result that needs the rule was added or removed; change the count in the same commit, and in vectors/README.md"
        )),
        None => Err(format!(
            "{line}, and the gate is not in mandate_testkit::rust_only::PINNED"
        )),
    }
}

#[cfg(test)]
mod tests {
    use mandate_ir::{Diagnostic, JsObject, JsValue, Location};

    use super::{diagnostic_as_typescript, js_as_typescript, tables_as_typescript};

    fn listed(versions: &[&str]) -> JsValue {
        JsValue::Array(versions.iter().map(|v| JsValue::from(*v)).collect())
    }

    #[test]
    fn an_e0103_loses_the_rust_only_versions_and_nothing_else() {
        let rust = Diagnostic::new(
            "E0103",
            "Unsupported language version '9.9'; this compiler reads 'mandate/0.5' or 'mandate/0.6'.",
            Location::path("/language"),
            Some(
                JsObject::new()
                    .with("expected", listed(&["mandate/0.5", "mandate/0.6"]))
                    .with("found", "mandate/9.9"),
            ),
        );
        let mut d = rust.clone();
        assert!(diagnostic_as_typescript(&mut d));
        assert_eq!(
            d.message,
            "Unsupported language version '9.9'; this compiler reads 'mandate/0.5'."
        );
        assert_eq!(
            d.facts.as_ref().and_then(|f| f.get("expected")),
            Some(&listed(&["mandate/0.5"]))
        );
        assert!(!diagnostic_as_typescript(&mut d), "once is enough");
        let mut js = rust.to_js();
        assert!(js_as_typescript(&mut JsValue::Array(vec![js.clone()])));
        assert!(js_as_typescript(&mut js));
        assert_eq!(js, d.to_js());
        // Another code is left as it is, even when it names 0.6.
        let mut other = Diagnostic::new(
            "E0104",
            "'x' is a mandate/0.6 field or \"mandate/0.6\"",
            Location::path(""),
            Some(JsObject::new().with("expected", listed(&["mandate/0.6"]))),
        );
        assert!(!diagnostic_as_typescript(&mut other));
        assert!(!js_as_typescript(&mut other.to_js()));
    }

    #[test]
    fn the_tables_lose_the_rust_only_versions_and_the_newest_is_the_typescripts() {
        let mut tables = JsValue::Object(
            JsObject::new()
                .with("LANGUAGE_VERSION", "mandate/0.6")
                .with("LANGUAGE_VERSIONS", listed(&["mandate/0.5", "mandate/0.6"]))
                .with("LOCK_FORMATS", listed(&["mandate/0.6"])),
        );
        assert!(tables_as_typescript(&mut tables));
        assert_eq!(
            tables.get("LANGUAGE_VERSION").and_then(JsValue::as_str),
            Some("mandate/0.5")
        );
        assert_eq!(
            tables.get("LANGUAGE_VERSIONS"),
            Some(&listed(&["mandate/0.5"]))
        );
        assert_eq!(tables.get("LOCK_FORMATS"), Some(&listed(&["mandate/0.6"])));
        assert!(!tables_as_typescript(&mut tables));
    }
}
