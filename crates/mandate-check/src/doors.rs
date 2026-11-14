//! The three front doors of `compiler/src/check.ts` (lines 133-279) that
//! stand on `check`: [`check_patch`], [`check_subprogram`] and
//! [`check_amendment`], and [`subprogram_linked`].
//!
//! Each does what its TypeScript function does in the same order, which is
//! observable: the diagnostics of the second part of a door are located in
//! the re-written JSON text (`JSON.stringify` of the patched, opened or
//! amended program, whose members are in the order the TypeScript builds
//! them: a spread keeps a member that is there in its place, a computed key
//! goes last when new), and the result's members are in the TypeScript's
//! order with the absent ones left out.
//!
//! The two throws of the TypeScript (a workflow that is not one with an
//! envelope) are the `Err` of [`check_subprogram`] and [`check_amendment`],
//! with the message of the `Error`.

use mandate_ir::{
    DefKind, Definition, Diagnostic, JsObject, JsValue, Location, Map, Program, Value, has_errors,
    hash_program, ptr, stringify,
};
use mandate_syntax::SourceKind;

use crate::amendment::narrowings;
use crate::caps::{CapOptions, caps_of};
use crate::check::{CheckOptions, check};
use crate::modules::{Modules, link};
use crate::patch::{GovernanceChange, PatchOp, apply_ops, apply_patch};
use crate::stdlib::DataClass;
use crate::subprogram::{
    Room, containment, language_of, opened, skeleton, subprogram_shape, subprogram_workflow,
};

/// `JSON.stringify(value)`: the text a door checks.
fn json_text(value: &Value) -> String {
    stringify(&JsValue::from(value)).unwrap_or_default()
}

/// What [`check_patch`] gives: `PatchCheck`, `{ ok, hash?, diagnostics,
/// governance, requires_approval, program? }`.
#[derive(Clone, Debug, PartialEq)]
pub struct PatchCheck {
    /// The patch applied and the patched program checks.
    pub ok: bool,
    /// The patched program's hash, when the patch was applied.
    pub hash: Option<String>,
    /// The diagnostics of the patch, then those of the patched program.
    pub diagnostics: Vec<Diagnostic>,
    /// The governance changes the patch makes.
    pub governance: Vec<GovernanceChange>,
    /// Whether it makes any.
    pub requires_approval: bool,
    /// The patched program, when the patch was applied.
    pub program: Option<Value>,
}

impl PatchCheck {
    /// The result as the TypeScript writes it, members in its order:
    /// `{ ok, hash?, diagnostics, governance, requires_approval, program? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("ok", self.ok)
            .with_some("hash", self.hash.as_deref())
            .with(
                "diagnostics",
                self.diagnostics
                    .iter()
                    .map(Diagnostic::to_js)
                    .collect::<Vec<_>>(),
            )
            .with("governance", self.governance_js())
            .with("requires_approval", self.requires_approval)
            .with_some("program", self.program.as_ref().map(JsValue::from))
            .into()
    }

    /// `GovernanceChange` as the result writes them, in an array.
    #[must_use]
    pub fn governance_js(&self) -> JsValue {
        JsValue::Array(
            self.governance
                .iter()
                .map(GovernanceChange::to_js)
                .collect(),
        )
    }
}

/// Applies `ops` to `program` against the hash they were written for
/// (`applyPatch`), then checks the patched program with `modules`, so the
/// caller sees what it would be asked to fix next: `checkPatch(program,
/// base, ops, modules)`. Nothing is saved.
#[must_use]
pub fn check_patch(
    program: &Value,
    base: &str,
    ops: &[PatchOp],
    modules: Option<&Modules>,
) -> PatchCheck {
    // `modules = {}`.
    let none = Modules::new();
    let modules = modules.unwrap_or(&none);
    let r = apply_patch(program, base, ops, Some(modules));
    let checked = r.program.as_ref().map(|p| {
        check(
            &json_text(p),
            SourceKind::Json,
            &CheckOptions {
                modules: Some(modules),
                ..CheckOptions::default()
            },
        )
    });
    let mut diagnostics = r.diagnostics;
    if let Some(c) = &checked {
        diagnostics.extend(c.diagnostics.iter().cloned());
    }
    let requires_approval = !r.governance.is_empty();
    PatchCheck {
        ok: r.ok && checked.as_ref().is_some_and(|c| c.ok),
        // `r.hash ? { hash } : {}`: a hash is never the empty string.
        hash: r.hash.filter(|h| !h.is_empty()),
        diagnostics,
        governance: r.governance,
        requires_approval,
        program: r.program,
    }
}

/// A lead's sub-program, as `check_program` and `submit_program` receive it:
/// `SubprogramInput`.
#[derive(Clone, Copy, Debug)]
pub struct SubprogramInput<'a> {
    /// The program whose `plan` runs the lead.
    pub parent: &'a Value,
    /// The modules it imports.
    pub modules: Option<&'a Modules>,
    /// The workflow of `parent` whose envelope bounds the run.
    pub workflow: &'a str,
    /// The sub-program's number under its `plan`, which names the skeleton
    /// it is a patch to.
    pub number: f64,
    /// The hash of that skeleton.
    pub base: &'a str,
    /// The lead's operations.
    pub ops: &'a [PatchOp],
    /// The data class of what the lead received (`leadClasses`).
    pub lead: DataClass,
    /// What is left of the envelope now.
    pub room: &'a Room,
}

/// What [`check_subprogram`] gives: `SubprogramCheck`, `{ ok, diagnostics,
/// program?, hash?, workflow? }`.
#[derive(Clone, Debug, PartialEq)]
pub struct SubprogramCheck {
    /// The sub-program passed every check and fits what is left of the
    /// envelope.
    pub ok: bool,
    /// Every diagnostic, in order.
    pub diagnostics: Vec<Diagnostic>,
    /// When `ok`: the sub-program as the lead wrote it.
    pub program: Option<Value>,
    /// When `ok`: its hash.
    pub hash: Option<String>,
    /// When `ok`: the name of its one workflow.
    pub workflow: Option<String>,
}

impl SubprogramCheck {
    /// The result as the TypeScript writes it: `{ ok, diagnostics, program?,
    /// hash?, workflow? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("ok", self.ok)
            .with(
                "diagnostics",
                self.diagnostics
                    .iter()
                    .map(Diagnostic::to_js)
                    .collect::<Vec<_>>(),
            )
            .with_some("program", self.program.as_ref().map(JsValue::from))
            .with_some("hash", self.hash.as_deref())
            .with_some("workflow", self.workflow.as_deref())
            .into()
    }

    fn refused(diagnostics: Vec<Diagnostic>) -> SubprogramCheck {
        SubprogramCheck {
            ok: false,
            diagnostics,
            program: None,
            hash: None,
            workflow: None,
        }
    }
}

/// The workflow `name` of `parent` when it is one with an envelope (an
/// envelope that is truthy): `Object.hasOwn(parent.defs, name) ? … : undefined`,
/// then `wf?.kind !== "workflow" || !wf.envelope`.
fn workflow_with_envelope<'a>(parent: &'a Value, name: &str) -> Option<&'a Value> {
    parent
        .get("defs")
        .and_then(Value::as_object)
        .and_then(|d| d.get(name))
        .filter(|wf| Definition::of(wf).kind() == Some(DefKind::Workflow))
        .filter(|wf| wf.get("envelope").is_some_and(Value::is_truthy))
}

/// Checks a lead's sub-program and whether it fits what is left of the
/// envelope (spec/envelope.md "The sub-program", INV-15):
/// `checkSubprogram(i)`. In order: the patch applies to the skeleton of its
/// number; it defines only what a sub-program may (E1705); all of `check`
/// passes, with every definition of the parent in sight and its workflow
/// under the parent's envelope; its claim fits `room` (E1706). Nothing is
/// saved and nothing runs.
///
/// # Errors
///
/// The message of the `Error` the TypeScript throws when the workflow is not
/// a workflow with an envelope.
pub fn check_subprogram(i: &SubprogramInput<'_>) -> Result<SubprogramCheck, String> {
    let Some(wf) = workflow_with_envelope(i.parent, i.workflow) else {
        return Err(format!(
            "{} is not a workflow with an envelope, so it has no sub-programs",
            i.workflow
        ));
    };
    let envelope = wf.get("envelope").cloned().unwrap_or(Value::Null);
    let parent_module = i
        .parent
        .get("module")
        .and_then(Value::as_str)
        .unwrap_or("undefined");
    let parent_language = language_of(i.parent);
    let patched = apply_ops(
        &skeleton(parent_module, i.number, parent_language),
        i.base,
        i.ops,
    );
    let Some(sub) = patched.program else {
        return Ok(SubprogramCheck::refused(patched.diagnostics));
    };
    let mut diagnostics = patched.diagnostics;
    diagnostics.extend(subprogram_shape(
        &sub,
        parent_module,
        i.number,
        parent_language,
    ));
    if has_errors(&diagnostics) {
        return Ok(SubprogramCheck::refused(diagnostics));
    }
    let view = opened(&sub, i.parent);
    // `{ ...(i.modules ?? {}), [i.parent.module]: i.parent }`.
    let mut modules = i.modules.cloned().unwrap_or_default();
    modules.insert(parent_module, i.parent.clone());
    let claim = {
        let mut c = Map::new();
        c.insert("envelope", envelope.clone());
        c.insert("lead", i.lead.as_str());
        Value::Object(c)
    };
    let checked = check(
        &json_text(&view),
        SourceKind::Json,
        &CheckOptions {
            lock: None,
            modules: Some(&modules),
            claim: Some(&claim),
        },
    );
    // A name the sub-program defines and its parent already has is
    // reported once, at the definition the lead wrote.
    let mut collided: Vec<String> = Vec::new();
    for d in checked.diagnostics {
        let name = if d.code == "MDT-E0121" {
            d.facts
                .as_ref()
                .and_then(|f| f.get("name"))
                .and_then(JsValue::as_str)
                .map(str::to_owned)
        } else {
            None
        };
        match name {
            None => diagnostics.push(d),
            Some(name) if !collided.contains(&name) => {
                let mut d = d;
                // `{ ...d, at: { path: ptr("defs", name) } }`.
                d.at = Location::path(ptr(&[&"defs", &name]));
                collided.push(name);
                diagnostics.push(d);
            }
            Some(_) => {}
        }
    }
    // `subprogramWorkflow(sub)!`: the shape check passed, so there is one.
    let workflow = subprogram_workflow(&sub).unwrap_or_default();
    if !has_errors(&diagnostics) {
        // The envelope is read in its parent's language, the sub-program in its own.
        let parent_defs = Program::of(i.parent).map(|p| link(p, i.modules).defs);
        let held = parent_defs
            .as_ref()
            .map(|defs| {
                envelope
                    .get("caps")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(mandate_ir::Expr::of)
                    .flat_map(|c| {
                        caps_of(
                            defs,
                            c,
                            CapOptions {
                                language: parent_language,
                            },
                        )
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if let Some(view_program) = Program::of(&view) {
            let defs = link(view_program, Some(&modules)).defs;
            diagnostics.extend(containment(
                &defs,
                &workflow,
                &held,
                i.room,
                CapOptions {
                    language: view_program.language(),
                },
            ));
        }
    }
    if has_errors(&diagnostics) {
        return Ok(SubprogramCheck::refused(diagnostics));
    }
    let hash = hash_program(&sub).program;
    Ok(SubprogramCheck {
        ok: true,
        diagnostics,
        program: Some(sub),
        hash: Some(hash),
        workflow: Some(workflow),
    })
}

/// An amendment of an envelope, as `request_amendment` receives it:
/// `AmendmentInput`.
#[derive(Clone, Copy, Debug)]
pub struct AmendmentInput<'a> {
    /// The run's program as it is now.
    pub parent: &'a Value,
    /// The modules it imports.
    pub modules: Option<&'a Modules>,
    /// The workflow of `parent` whose envelope the amendment replaces.
    pub workflow: &'a str,
    /// The new envelope, as IR: a lead's writing, any JSON value, or none.
    pub envelope: Option<&'a Value>,
}

/// What [`check_amendment`] gives: `AmendmentCheck`, `{ ok, diagnostics,
/// program?, hash? }`.
#[derive(Clone, Debug, PartialEq)]
pub struct AmendmentCheck {
    /// The program with the new envelope passes every check, and the new
    /// envelope takes nothing away.
    pub ok: bool,
    /// Every diagnostic, in order.
    pub diagnostics: Vec<Diagnostic>,
    /// When `ok`: the program with the new envelope, as loaded.
    pub program: Option<Value>,
    /// When `ok`: its hash.
    pub hash: Option<String>,
}

impl AmendmentCheck {
    /// The result as the TypeScript writes it: `{ ok, diagnostics, program?,
    /// hash? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("ok", self.ok)
            .with(
                "diagnostics",
                self.diagnostics
                    .iter()
                    .map(Diagnostic::to_js)
                    .collect::<Vec<_>>(),
            )
            .with_some("program", self.program.as_ref().map(JsValue::from))
            .with_some("hash", self.hash.as_deref())
            .into()
    }

    fn refused(diagnostics: Vec<Diagnostic>) -> AmendmentCheck {
        AmendmentCheck {
            ok: false,
            diagnostics,
            program: None,
            hash: None,
        }
    }
}

/// Checks an amendment (spec/envelope.md "Amendments", N04): the run's
/// program with `envelope` in place of its workflow's own, and nothing else
/// changed: `checkAmendment(i)`. All of `check` passes on it, and the new
/// envelope only widens the old one (E1709). Nothing is saved and nothing
/// runs.
///
/// # Errors
///
/// The message of the `Error` the TypeScript throws when the workflow is not
/// a workflow with an envelope.
pub fn check_amendment(i: &AmendmentInput<'_>) -> Result<AmendmentCheck, String> {
    let Some(wf) = workflow_with_envelope(i.parent, i.workflow) else {
        return Err(format!(
            "{} is not a workflow with an envelope, so it has none to amend",
            i.workflow
        ));
    };
    let at = format!("{}/envelope", ptr(&[&"defs", &i.workflow]));
    // `!i.envelope || typeof i.envelope !== "object" || Array.isArray(i.envelope)`:
    // only an object is one.
    let Some(envelope) = i.envelope.filter(|e| matches!(e, Value::Object(_))) else {
        return Ok(AmendmentCheck::refused(vec![Diagnostic::new(
            "E1701",
            format!(
                "An amendment gives {}'s new envelope, with its owner, its caps and its budget.",
                i.workflow
            ),
            Location::path(at),
            Some(JsObject::new().with(
                "missing",
                vec![
                    JsValue::from("owner"),
                    JsValue::from("caps"),
                    JsValue::from("budget"),
                ],
            )),
        )]));
    };
    // `{ ...i.parent, defs: { ...i.parent.defs, [i.workflow]: { ...wf, envelope: i.envelope } } }`:
    // each member that is there keeps its place.
    let amended = {
        let mut workflow = wf.as_object().cloned().unwrap_or_default();
        workflow.insert("envelope", envelope.clone());
        let mut defs = i
            .parent
            .get("defs")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        defs.insert(i.workflow, Value::Object(workflow));
        let mut program = i.parent.as_object().cloned().unwrap_or_default();
        program.insert("defs", Value::Object(defs));
        Value::Object(program)
    };
    let checked = check(
        &json_text(&amended),
        SourceKind::Json,
        &CheckOptions {
            modules: i.modules,
            ..CheckOptions::default()
        },
    );
    let mut diagnostics = checked.diagnostics.clone();
    // `checked.program?.defs[i.workflow]`.
    let now = checked
        .program
        .as_ref()
        .and_then(|p| p.get("defs"))
        .and_then(|d| d.get(i.workflow))
        .filter(|d| Definition::of(d).kind() == Some(DefKind::Workflow))
        .and_then(|d| d.get("envelope"))
        .filter(|e| e.is_truthy());
    if checked.ok
        && let (Some(program), Some(now), Some(before)) =
            (checked.program.as_ref(), now, wf.get("envelope"))
        && let Some(view) = Program::of(program)
    {
        let defs = link(view, i.modules).defs;
        diagnostics.extend(narrowings(
            &defs,
            i.workflow,
            before,
            now,
            CapOptions {
                language: view.language(),
            },
        ));
    }
    match (checked.program, checked.hashes) {
        (Some(program), Some(hashes)) if !has_errors(&diagnostics) => Ok(AmendmentCheck {
            ok: true,
            diagnostics,
            program: Some(program),
            hash: Some(hashes.program),
        }),
        _ => Ok(AmendmentCheck::refused(diagnostics)),
    }
}

/// An admitted sub-program as the interpreter runs it: its own definitions
/// and all its parent sees. Never hashed: `subprogramLinked(sub, parent,
/// modules)`, `{ ...sub, defs: link(view, { ...modules, [parent.module]:
/// parent }).defs }`.
#[must_use]
pub fn subprogram_linked(sub: &Value, parent: &Value, modules: Option<&Modules>) -> Value {
    let view = opened(sub, parent);
    let mut all = modules.cloned().unwrap_or_default();
    all.insert(
        parent
            .get("module")
            .and_then(Value::as_str)
            .unwrap_or("undefined"),
        parent.clone(),
    );
    let defs = Program::of(&view)
        .map(|p| link(p, Some(&all)).defs)
        .unwrap_or_default();
    let mut out = sub.as_object().cloned().unwrap_or_default();
    out.insert("defs", Value::Object(defs));
    Value::Object(out)
}
