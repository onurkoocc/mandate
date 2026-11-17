//! The doors over patches, sub-programs, amendments and the comparison of
//! two programs: `apply_patch`, `check_patch`, `check_subprogram`,
//! `check_amendment`, `semantic_diff`, `governance_changes` and
//! `envelope_changes`.

use mandate_ir::{JsObject, JsValue, Value};

use super::DoorError;
use super::front::{diagnostics_js, ir};
use super::input::args;
use crate::diff::{Change, KindedChange, Locks};
use crate::doors::{AmendmentCheck, AmendmentInput, SubprogramCheck, SubprogramInput};
use crate::patch::GovernanceChange;
use crate::subprogram::Room;

/// The governance changes of a patch as an array.
fn governance_js(changes: &[GovernanceChange]) -> JsValue {
    JsValue::Array(changes.iter().map(GovernanceChange::to_js).collect())
}

/// The parameters of [`apply_patch`].
pub(super) const APPLY_PATCH: &[&str] = &["program", "base", "ops", "modules"];

/// `applyPatch(program, base, ops, modules)`, `compiler/src/patch/patch.ts`:
/// RFC 6902 operations applied to a program against the hash they were
/// written for, and the governance changes they make.
///
/// Input: `{ program, base: string, ops: [{ op, path, value? }], modules?:
/// { <name>: program } }`.
/// Output: `PatchResult`, `{ ok: true, diagnostics, governance, program,
/// hash }`, or `{ ok: false, diagnostics, governance: [] }`.
pub(super) fn apply_patch(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, APPLY_PATCH)?;
    let program = a.program("program")?;
    let base = a.str("base")?;
    let ops = a.ops("ops")?;
    let modules = a.opt_modules("modules")?;
    let r = crate::patch::apply_patch(program, base, &ops, modules);
    let out = JsObject::new()
        .with("ok", r.ok)
        .with("diagnostics", diagnostics_js(&r.diagnostics))
        .with("governance", governance_js(&r.governance));
    Ok(if r.ok {
        out.with_some("program", r.program.as_ref().map(ir))
            .with_some("hash", r.hash.as_deref())
    } else {
        out
    }
    .into())
}

/// The parameters of [`check_patch`].
pub(super) const CHECK_PATCH: &[&str] = &["program", "base", "ops", "modules"];

/// `checkPatch(program, base, ops, modules)`, `compiler/src/check.ts`: a
/// patch applied to a program, with the patched program's own checks.
///
/// Input: `{ program, base: string, ops: [{ op, path, value? }], modules?:
/// { <name>: program } }`.
/// Output: `PatchCheck`, `{ ok, hash?, diagnostics, governance,
/// requires_approval, program? }`.
pub(super) fn check_patch(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CHECK_PATCH)?;
    let program = a.program("program")?;
    let base = a.str("base")?;
    let ops = a.ops("ops")?;
    let modules = a.opt_modules("modules")?;
    Ok(crate::doors::check_patch(program, base, &ops, modules).to_js())
}

/// The parameters of [`check_subprogram`].
pub(super) const CHECK_SUBPROGRAM: &[&str] = &["i"];

/// `checkSubprogram(i)`, `compiler/src/check.ts`: a lead's sub-program,
/// checked and held to what is left of its envelope.
///
/// Input: `{ i: { parent: program, modules?: { <name>: program }, workflow:
/// string, number: number, base: string, ops: [{ op, path, value? }], lead:
/// data class, room: { left: { <dimension>: number }, time_left_ms?: number,
/// writes: [CapVal] }, std_patterns?: version } }`; `std_patterns` (0.7)
/// the version of `std.patterns` the parent's lock pins, one the compiler
/// embeds (anything else is `bad_input`), which the check reads.
/// Output: `SubprogramCheck`, `{ ok, diagnostics, program?, hash?,
/// workflow? }`, and, for a sub-program of 0.6 that applies a pattern and
/// is admitted (the Rust's alone), `running`, the sub-program as a run runs
/// it (expanded, with the linked definitions as its `defs`), and
/// `running_hash`, its hash; `bad_input` with the TypeScript's message when
/// `workflow` is not a workflow with an envelope.
pub(super) fn check_subprogram(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CHECK_SUBPROGRAM)?;
    let i = a.members("i", "i.")?;
    let parent = i.program("parent")?;
    let modules = i.opt_modules("modules")?;
    let workflow = i.str("workflow")?;
    // An integer of the IR's domain, within ±(2^53−1): a double holds it.
    let number = i.int("number")? as f64;
    let base = i.str("base")?;
    let ops = i.ops("ops")?;
    let lead = i.data_class("lead")?;
    let room = Room::from_value(i.object("room")?)
        .map_err(|e| DoorError::bad_input(format!("`i.room`: {e}")))?;
    let r = crate::doors::check_subprogram(&SubprogramInput {
        parent,
        modules,
        workflow,
        number,
        base,
        ops: &ops,
        lead,
        room: &room,
        std_patterns: i.opt_std_patterns("std_patterns")?,
    });
    r.as_ref()
        .map(SubprogramCheck::to_js)
        .map_err(DoorError::bad_input)
}

/// The parameters of [`check_amendment`].
pub(super) const CHECK_AMENDMENT: &[&str] = &["i"];

/// `checkAmendment(i)`, `compiler/src/check.ts`: an amendment of an
/// envelope, checked, and held to widening the old one only.
///
/// Input: `{ i: { parent: program, modules?: { <name>: program }, workflow:
/// string, envelope?: the new envelope as IR (any JSON value),
/// std_patterns?: version } }`, `std_patterns` as [`check_subprogram`] takes it.
/// Output: `AmendmentCheck`, `{ ok, diagnostics, program?, hash? }`;
/// `bad_input` with the TypeScript's message when `workflow` is not a
/// workflow with an envelope.
pub(super) fn check_amendment(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CHECK_AMENDMENT)?;
    let i = a.members("i", "i.")?;
    let parent = i.program("parent")?;
    let modules = i.opt_modules("modules")?;
    let workflow = i.str("workflow")?;
    // `envelope: unknown`: `null` is a value here, which the check reads.
    let envelope = i.value("envelope").ok();
    let r = crate::doors::check_amendment(&AmendmentInput {
        parent,
        modules,
        workflow,
        envelope,
        std_patterns: i.opt_std_patterns("std_patterns")?,
    });
    r.as_ref()
        .map(AmendmentCheck::to_js)
        .map_err(DoorError::bad_input)
}

/// The parameters of [`semantic_diff`].
pub(super) const SEMANTIC_DIFF: &[&str] = &["before", "after", "locks", "modules", "std_patterns"];

/// `semanticDiff(before, after, locks)`, `compiler/src/views/views.ts`: the
/// semantic diff of two programs.
///
/// Input: `{ before: program, after: program, locks?: { before?, after? },
/// modules?: { <name>: program } }`, each lock as read. `modules` is the
/// Rust's alone (0.6): the modules a workflow's pattern comes from, so that
/// what it commits is read from its expansion
/// (`crate::diff::semantic_diff_with`); the TypeScript takes none, and two
/// programs that apply no pattern compare the same with or without them.
/// Output: `DiffView`, `{ format, kind, from, to, governance, behavior,
/// unchanged }`.
pub(super) fn semantic_diff(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, SEMANTIC_DIFF)?;
    let before = a.program("before")?;
    let after = a.program("after")?;
    let locks = a.opt_members("locks", "locks.")?.map(|l| Locks {
        before: l.opt_value("before"),
        after: l.opt_value("after"),
    });
    let modules = a.opt_modules("modules")?;
    // 0.7: the version of std.patterns a caller that holds no lock names;
    // each lock given must pin that one.
    let named = a.opt_std_patterns("std_patterns")?;
    for lock in [locks.and_then(|l| l.before), locks.and_then(|l| l.after)] {
        crate::library::pin_of(lock, named.as_ref())
            .map_err(|e| DoorError::bad_input(format!("`std_patterns`: {e}")))?;
    }
    Ok(crate::diff::semantic_diff_pinned(before, after, locks, modules, named.as_ref()).to_js())
}

/// The parameters of [`governance_changes`].
pub(super) const GOVERNANCE_CHANGES: &[&str] = &["before", "after", "modules"];

/// `governanceChanges(before, after, modules)`, `compiler/src/views/views.ts`:
/// the governance changes from one program to another, each with its kind.
///
/// Input: `{ before: program, after: program, modules?: { <name>: program } }`.
/// Output: `[{ kind, path, text }]`.
pub(super) fn governance_changes(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, GOVERNANCE_CHANGES)?;
    let before = a.program("before")?;
    let after = a.program("after")?;
    let modules = a.opt_modules("modules")?;
    let changes = crate::diff::governance_changes(before, after, modules);
    Ok(JsValue::Array(
        changes.iter().map(KindedChange::to_js).collect(),
    ))
}

/// The parameters of [`envelope_changes`].
pub(super) const ENVELOPE_CHANGES: &[&str] = &["before", "after", "workflow", "modules"];

/// `envelopeChanges(before, after, workflow, modules)`,
/// `compiler/src/views/views.ts`: how a workflow's envelope changed.
///
/// Input: `{ before: program, after: program, workflow: string, modules?:
/// { <name>: program } }`.
/// Output: `[{ path, text }]`.
pub(super) fn envelope_changes(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ENVELOPE_CHANGES)?;
    let before = a.program("before")?;
    let after = a.program("after")?;
    let workflow = a.str("workflow")?;
    let modules = a.opt_modules("modules")?;
    let changes = crate::diff::envelope_changes(before, after, workflow, modules);
    Ok(JsValue::Array(changes.iter().map(Change::to_js).collect()))
}
