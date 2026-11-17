//! The owner of a workflow of language 0.7 (spec/attention.md "`owner`",
//! "Static rules"), which only the Rust compiler reads: E1910.
//!
//! `owner r` names the role that approves a workflow's card before any run
//! of it and signs its promotions, for a workflow without an envelope; a
//! workflow with an envelope has its envelope's `owner` in that place. So:
//!
//! - [`owner_checks`]: an `owner` on a workflow written out that has an
//!   envelope is E1910 at the `owner` (`problem: "with_envelope"`), whatever
//!   the lock; a workflow that applies a pattern may have no envelope at all,
//!   and is told so (E1307), not this;
//! - [`promotion_checks`]: with a lock whose `promotion` is `"required"`, a
//!   workflow of the program's own with neither an `owner` nor an envelope
//!   is E1910 at the workflow (`problem: "no_owner"`): nobody could promote
//!   it.
//!
//! What `owner` names is a role site (`crate::roles`, E1501 and with a lock
//! E1502); one written in a lead's sub-program is E1705
//! (`crate::subprogram::subprogram_attention`). A program of 0.1 to 0.6 has
//! no `owner` (its schema closes a workflow) and no ladder: neither check
//! gives it anything, and a lock that asks for the ladder of such a program
//! is E1911 (`crate::lock::attention_lock_checks`).

use mandate_ir::{
    DefKind, Definition, Diagnostic, JsObject, Language, Location, Program, Spans, Value,
    nearest_span, ptr,
};

use crate::lock::Lock;

/// Whether `program` is of language 0.7 or later.
fn reads_0_7(program: Program<'_>) -> bool {
    program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
}

/// The program's own workflows, in the order of its definitions.
fn workflows(program: Program<'_>) -> impl Iterator<Item = (&str, Definition<'_>)> {
    program
        .definitions()
        .filter(|(_, d)| d.kind() == Some(DefKind::Workflow))
}

/// Whether `d` has an envelope: one that is there and not `null` or `false`.
fn has_envelope(d: Definition<'_>) -> bool {
    d.value().get("envelope").is_some_and(Value::is_truthy)
}

/// E1910 for an `owner` beside an envelope, in a program of 0.7 or later.
#[must_use]
pub fn owner_checks(program: Program<'_>, spans: Option<&Spans>) -> Vec<Diagnostic> {
    if !reads_0_7(program) {
        return Vec::new();
    }
    let mut out: Vec<Diagnostic> = Vec::new();
    for (name, d) in workflows(program) {
        let Some(owner) = d.value().get("owner") else {
            continue;
        };
        // A workflow that applies a pattern may have no envelope at all
        // (E1307, at the envelope): that is what it is told, not that its
        // owner has the envelope's place.
        if !has_envelope(d) || d.value().get("apply").is_some() {
            continue;
        }
        let path = format!("{}/owner", ptr(&[&"defs", &name]));
        let role = owner.as_str().unwrap_or_default();
        out.push(Diagnostic::new(
            "E1910",
            format!(
                "Workflow {name} has an envelope and an owner ({role}): its envelope's owner approves it and signs its promotions. Take the owner line away, or name the role as the envelope's owner (spec/attention.md \"owner\")."
            ),
            Location::path_span(&path, nearest_span(spans, &path)),
            Some(
                JsObject::new()
                    .with("workflow", name)
                    .with("problem", "with_envelope")
                    .with("owner", role),
            ),
        ));
    }
    out
}

/// E1910 for a workflow nobody could promote: with a lock whose `promotion`
/// is `"required"`, each workflow of `program`'s own (as written: one that
/// applies a pattern is the application) with neither an `owner` nor an
/// envelope, in a program of 0.7 or later. A lock without `promotion` asks
/// for no ladder, and then a workflow without either needs nobody.
#[must_use]
pub fn promotion_checks(
    program: Program<'_>,
    lock: Lock<'_>,
    spans: Option<&Spans>,
) -> Vec<Diagnostic> {
    if !reads_0_7(program) || !lock.promotion_required() {
        return Vec::new();
    }
    let mut out: Vec<Diagnostic> = Vec::new();
    for (name, d) in workflows(program) {
        if d.value().get("owner").is_some() || has_envelope(d) {
            continue;
        }
        let path = ptr(&[&"defs", &name]);
        out.push(Diagnostic::new(
            "E1910",
            format!(
                "The lock asks for the promotion ladder (promotion: \"required\"), and workflow {name} has neither an owner nor an envelope, so nobody could promote it. Name the role that promotes it: owner <role> (spec/attention.md \"owner\", \"Promotion\")."
            ),
            Location::path_span(&path, nearest_span(spans, &path)),
            Some(
                JsObject::new()
                    .with("workflow", name)
                    .with("problem", "no_owner"),
            ),
        ));
    }
    out
}
