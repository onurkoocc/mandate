//! The doors over programs: `architecture`, `authority`, `cost`,
//! `program_doc`, `diff_doc`, `envelope_workflows`, `card`, `card_doc` and
//! `acs_target`.

use mandate_check::Locks;
use mandate_check::Modules;
use mandate_check::json_doors::DoorError;
use mandate_check::json_doors::input::{Members, args};
use mandate_ir::{JsValue, Value};

use super::documents::doc_js;
use crate::card::CardView;

/// The members of `card`'s and `card_doc`'s `opts`: `{ lock?, modules? }`.
#[derive(Clone, Copy, Default)]
struct CardOpts<'a> {
    lock: Option<&'a Value>,
    modules: Option<&'a Modules>,
}

impl<'a> CardOpts<'a> {
    /// The member `opts` of `a`, when it is there.
    fn of(a: Members<'a>) -> Result<CardOpts<'a>, DoorError> {
        Ok(match a.opt_members("opts", "opts.")? {
            None => CardOpts::default(),
            Some(o) => CardOpts {
                lock: o.opt_lock("lock"),
                modules: o.opt_modules("modules")?,
            },
        })
    }
}

/// The parameters of [`architecture`].
pub(super) const ARCHITECTURE: &[&str] = &["program", "modules", "lock"];

/// `architecture(program)`, `compiler/src/views/views.ts`: each workflow as a
/// graph of its steps.
///
/// Input: `{ program, modules?: { <name>: program }, lock?: the lock as read
/// }`. `modules` is the Rust's alone (0.6): the modules a workflow's pattern
/// comes from, so that it is shown as its expansion
/// (`crate::architecture_with_lock`); `lock` is the Rust's alone too: with it
/// a workflow that applies a pattern names the library and the version the
/// lock pins. The TypeScript takes the program alone, and a program that
/// applies no pattern is shown the same with or without them.
/// Output: `ArchitectureView`, `{ format, kind: "architecture", program,
/// workflows: [{ workflow, budget, pattern?, nodes, edges, mermaid }] }`.
pub(super) fn architecture(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ARCHITECTURE)?;
    let modules = a.opt_modules("modules")?;
    Ok(crate::architecture_with_lock(a.program("program")?, a.opt_lock("lock"), modules).to_js())
}

/// The parameters of [`authority`].
pub(super) const AUTHORITY: &[&str] = &["program", "modules"];

/// `authority(program)`, `compiler/src/views/views.ts`: what each agent,
/// workflow and delegation may touch.
///
/// Input: `{ program, modules?: { <name>: program } }`, `modules` as
/// [`architecture`] takes it (`crate::authority_with`).
/// Output: `AuthorityView`, `{ format, kind: "authority", program, rows:
/// [{ who, kind, effects, read, write, network, model, exec, repos, money,
/// unbounded }] }`.
pub(super) fn authority(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, AUTHORITY)?;
    let modules = a.opt_modules("modules")?;
    Ok(crate::authority_with(a.program("program")?, modules).to_js())
}

/// The parameters of [`cost`].
pub(super) const COST: &[&str] = &["program", "lock", "modules"];

/// `cost(program, lock)`, `compiler/src/views/views.ts`: the static upper
/// bound of what each workflow hands out.
///
/// Input: `{ program, lock?: the lock as read, modules?: { <name>: program }
/// }`, `modules` as [`architecture`] takes it (`crate::cost_with`).
/// Output: `CostView`, `{ format, kind: "cost", program, workflows }`.
pub(super) fn cost(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, COST)?;
    let modules = a.opt_modules("modules")?;
    Ok(crate::cost_with(a.program("program")?, a.opt_lock("lock"), modules).to_js())
}

/// The parameters of [`program_doc`].
pub(super) const PROGRAM_DOC: &[&str] = &["program", "lock", "modules"];

/// `programDoc(program, lock, modules)`, `compiler/src/views/views.ts`: the
/// views of a program as one document.
///
/// Input: `{ program, lock?: the lock as read, modules?: { <name>: program } }`.
/// Output: `Doc`, `{ title, meta: [[key, value]], blocks }`.
pub(super) fn program_doc(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, PROGRAM_DOC)?;
    let program = a.program("program")?;
    let lock = a.opt_lock("lock");
    let modules = a.opt_modules("modules")?;
    Ok(doc_js(&crate::program_doc(program, lock, modules)))
}

/// The parameters of [`diff_doc`].
pub(super) const DIFF_DOC: &[&str] = &["before", "after", "locks", "modules"];

/// `diffDoc(before, after, locks)`, `compiler/src/views/views.ts`: the
/// semantic diff of two programs as a document.
///
/// Input: `{ before: program, after: program, locks?: { before?, after? },
/// modules?: { <name>: program } }`, each lock as read; `modules` as
/// [`architecture`] takes it (`crate::diff_doc_with`).
/// Output: `Doc`.
pub(super) fn diff_doc(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, DIFF_DOC)?;
    let before = a.program("before")?;
    let after = a.program("after")?;
    let locks = a.opt_members("locks", "locks.")?.map(|l| Locks {
        before: l.opt_value("before"),
        after: l.opt_value("after"),
    });
    let modules = a.opt_modules("modules")?;
    Ok(doc_js(&crate::diff_doc_with(before, after, locks, modules)))
}

/// The parameters of [`envelope_workflows`].
pub(super) const ENVELOPE_WORKFLOWS: &[&str] = &["program"];

/// `envelopeWorkflows(program)`, `compiler/src/views/views.ts`: the
/// workflows that have an envelope, so a card.
///
/// Input: `{ program }`.
/// Output: their names, an array of strings.
pub(super) fn envelope_workflows(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ENVELOPE_WORKFLOWS)?;
    let names = crate::envelope_workflows(a.program("program")?);
    Ok(JsValue::Array(
        names.into_iter().map(JsValue::String).collect(),
    ))
}

/// The parameters of [`card`].
pub(super) const CARD: &[&str] = &["program", "workflow", "opts"];

/// `card(program, workflow, opts)`, `compiler/src/views/views.ts`: the
/// envelope card of a workflow.
///
/// Input: `{ program, workflow: string, opts?: { lock?: the lock as read,
/// modules?: { <name>: program } } }`.
/// Output: `CardView`, or `null` for a workflow that has no envelope or is
/// not there (the TypeScript gives `undefined`).
pub(super) fn card(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CARD)?;
    let program = a.program("program")?;
    let workflow = a.str("workflow")?;
    let o = CardOpts::of(a)?;
    Ok(crate::card(program, workflow, o.lock, o.modules)
        .as_ref()
        .map_or(JsValue::Null, CardView::to_js))
}

/// The parameters of [`card_doc`].
pub(super) const CARD_DOC: &[&str] = &["program", "workflow", "opts"];

/// `cardDoc(program, workflow, opts)`, `compiler/src/views/views.ts`: the
/// card as a document, headed by the package hash an approval binds to.
///
/// Input: as [`card`].
/// Output: `Doc`, or `null` where [`card`] is.
pub(super) fn card_doc(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CARD_DOC)?;
    let program = a.program("program")?;
    let workflow = a.str("workflow")?;
    let o = CardOpts::of(a)?;
    Ok(crate::card_doc(program, workflow, o.lock, o.modules)
        .as_ref()
        .map_or(JsValue::Null, doc_js))
}

/// The parameters of [`acs_target`].
pub(super) const ACS_TARGET: &[&str] = &["program", "modules", "lock"];

/// `acsTarget(program, modules, lock)`, `compiler/src/target/acs.ts`: each
/// local agent as an ACS manifest and a Rego policy.
///
/// Input: `{ program, modules?: { <name>: program }, lock?: the lock as read }`.
/// Output: `AcsTarget`, `{ format, acs_version, program, binding, agents:
/// { <agent>: { manifest, rego, requirement } }, profile, diagnostics }`.
pub(super) fn acs_target(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ACS_TARGET)?;
    let program = a.program("program")?;
    let modules = a.opt_modules("modules")?;
    let lock = a.opt_lock("lock");
    Ok(crate::acs_target(program, modules, lock).to_js())
}
