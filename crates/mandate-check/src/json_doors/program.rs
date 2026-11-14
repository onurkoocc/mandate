//! The doors over what a program is made of: `link`, `linked_program`,
//! `references`, `roles_named`, `program_ref`, `lead_classes`,
//! `workflow_bounds`, `caps_of`, `show_cap`, `governance_files`,
//! `glob_match`, `skeleton` and `subprogram_linked`.

use mandate_ir::{Expr, JsObject, JsValue, Value};

use super::DoorError;
use super::front::{diagnostics_js, ir};
use super::input::{args, cap_val};
use crate::caps::{CapVal, caps_of_within};
use crate::governance::GovernanceFile;

/// A list of strings as an array.
pub(super) fn strings_js<S: AsRef<str>>(items: &[S]) -> JsValue {
    JsValue::Array(items.iter().map(|s| JsValue::from(s.as_ref())).collect())
}

/// The parameters of [`link`].
pub(super) const LINK: &[&str] = &["program", "modules"];

/// `link(program, modules)`, `compiler/src/modules.ts`: the definitions a
/// program sees with its imported modules loaded.
///
/// Input: `{ program, modules?: { <name>: program } }`.
/// Output: `Linked`, `{ defs, origin: { <definition>: <module> },
/// diagnostics }`.
pub(super) fn link(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LINK)?;
    let program = a.program_view("program")?;
    let modules = a.opt_modules("modules")?;
    let linked = crate::modules::link(program, modules);
    let origin: JsObject = linked
        .origin
        .iter()
        .map(|(name, module)| (name.as_str(), module.as_str()))
        .collect();
    Ok(JsObject::new()
        .with("defs", ir(&Value::Object(linked.defs)))
        .with("origin", origin)
        .with("diagnostics", diagnostics_js(&linked.diagnostics))
        .into())
}

/// The parameters of [`linked_program`].
pub(super) const LINKED_PROGRAM: &[&str] = &["program", "modules"];

/// `linkedProgram(program, modules)`, `compiler/src/modules.ts`: the
/// program with the linked definitions as its `defs`.
///
/// Input: `{ program, modules?: { <name>: program } }`.
/// Output: the program, `{ ...program, defs }`.
pub(super) fn linked_program(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LINKED_PROGRAM)?;
    let program = a.program_view("program")?;
    let modules = a.opt_modules("modules")?;
    Ok(ir(&crate::modules::linked_program(program, modules)))
}

/// The parameters of [`references`].
pub(super) const REFERENCES: &[&str] = &["d"];

/// `references(d)`, `compiler/src/modules.ts`: the names a definition
/// refers to.
///
/// Input: `{ d: a definition (any JSON value) }`.
/// Output: the names, each once, in the order found (a `Set`).
pub(super) fn references(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, REFERENCES)?;
    Ok(strings_js(&crate::modules::references(a.value("d")?)))
}

/// The parameters of [`roles_named`].
pub(super) const ROLES_NAMED: &[&str] = &["defs"];

/// `rolesNamed(defs)`, `compiler/src/check/roles.ts`: the roles the
/// definitions name.
///
/// Input: `{ defs: { <name>: definition } }`.
/// Output: the role names, each once, sorted.
pub(super) fn roles_named(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ROLES_NAMED)?;
    Ok(strings_js(&crate::roles::roles_named(a.map("defs")?)))
}

/// The parameters of [`program_ref`].
pub(super) const PROGRAM_REF: &[&str] = &["p"];

/// `programRef(p)`, `compiler/src/views/views.ts`: how a view names the
/// program it is of.
///
/// Input: `{ p: program }`.
/// Output: `{ module, version, language, hash }`.
pub(super) fn program_ref(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, PROGRAM_REF)?;
    Ok(crate::view_shared::program_ref(a.program("p")?).to_js())
}

/// The parameters of [`lead_classes`].
pub(super) const LEAD_CLASSES: &[&str] = &["program", "linked"];

/// `leadClasses(program, linked)`, `compiler/src/check/static.ts`: the data
/// class of what each `plan` of a program hands its lead.
///
/// Input: `{ program, linked?: { <name>: definition } }`.
/// Output: `{ <path of the plan>: <data class> }`, sorted by path.
pub(super) fn lead_classes(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, LEAD_CLASSES)?;
    let program = a.program_view("program")?;
    let linked = a.opt_map("linked")?;
    let classes = crate::statics::lead_classes(program, linked);
    let out: JsObject = classes
        .iter()
        .map(|(path, class)| (path.as_str(), class.as_str()))
        .collect();
    Ok(out.into())
}

/// The parameters of [`workflow_bounds`].
pub(super) const WORKFLOW_BOUNDS: &[&str] = &["d"];

/// `workflowBounds(d)`, `compiler/src/ir/types.ts`: what a workflow may hold
/// and spend, its envelope's when it has one.
///
/// Input: `{ d: a workflow definition }`.
/// Output: `{ caps, capsAt, budget?, budgetAt }`. (A workflow without its
/// `caps`, which the schema refuses, has `caps: []` here.)
pub(super) fn workflow_bounds(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, WORKFLOW_BOUNDS)?;
    let b = mandate_ir::workflow_bounds(a.object("d")?);
    Ok(JsObject::new()
        .with("caps", JsValue::Array(b.caps.iter().map(ir).collect()))
        .with("capsAt", b.caps_at)
        .with_some("budget", b.budget.map(ir))
        .with("budgetAt", b.budget_at)
        .into())
}

/// The parameters of [`caps_of`].
pub(super) const CAPS_OF: &[&str] = &["defs", "e", "opts", "within"];

/// `capsOf(defs, e, opts, within)`, `compiler/src/check/caps.ts`: the
/// capabilities an expression stands for.
///
/// Input: `{ defs: { <name>: definition }, e: expression, opts?: { language? },
/// within?: [name] }` (`within`, a `Set` in the TypeScript, an array here).
/// Output: the capabilities, each `CapVal`.
pub(super) fn caps_of(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, CAPS_OF)?;
    let defs = a.map("defs")?;
    let e = Expr::of(a.object("e")?).ok_or_else(|| DoorError::bad_input("`e` is not an object"))?;
    let opts = a.opt_cap_options("opts")?;
    let within: Vec<String> = a
        .opt_strings("within")?
        .unwrap_or_default()
        .into_iter()
        .map(str::to_owned)
        .collect();
    let caps = caps_of_within(defs, e, opts, &within);
    Ok(JsValue::Array(
        caps.iter().map(|c| JsValue::Object(c.to_js())).collect(),
    ))
}

/// The parameters of [`show_cap`].
pub(super) const SHOW_CAP: &[&str] = &["c"];

/// `showCap(c)`, `compiler/src/check/caps.ts`: a capability as a person
/// reads it.
///
/// Input: `{ c: CapVal }`, `{ ctor, effect, write, ... }`.
/// Output: the text, a string.
pub(super) fn show_cap(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, SHOW_CAP)?;
    let c: CapVal =
        cap_val(a.value("c")?).map_err(|e| DoorError::bad_input(format!("`c`: {e}")))?;
    Ok(JsValue::String(crate::caps::show_cap(&c)))
}

/// The parameters of [`governance_files`].
pub(super) const GOVERNANCE_FILES: &[&str] = &["files", "extra"];

/// `governanceFiles(files, extra)`, `compiler/src/std/governance.ts`: the
/// governance-class files among `files`.
///
/// Input: `{ files: [string], extra?: [glob] }` (`files` an `Iterable` in
/// the TypeScript, an array here).
/// Output: `[{ file, kind }]`, sorted by file.
pub(super) fn governance_files(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, GOVERNANCE_FILES)?;
    let files = a.strings("files")?;
    let extra = a.opt_strings("extra")?.unwrap_or_default();
    let found = crate::governance::governance_files(files, &extra);
    Ok(JsValue::Array(
        found
            .iter()
            .map(|f: &GovernanceFile| JsValue::Object(f.to_js()))
            .collect(),
    ))
}

/// The parameters of [`glob_match`].
pub(super) const GLOB_MATCH: &[&str] = &["glob", "text"];

/// Whether a glob matches the whole of a text: `globRegExp(glob).test(text)`,
/// `compiler/src/std/governance.ts`. `globRegExp` returns a `RegExp`, which
/// JSON cannot carry; this is the question the runtime asks of it.
///
/// Input: `{ glob: string, text: string }`.
/// Output: a boolean.
pub(super) fn glob_match(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, GLOB_MATCH)?;
    let glob = a.str("glob")?;
    let text = a.str("text")?;
    Ok(JsValue::Bool(
        crate::governance::glob_reg_exp(glob).test(text),
    ))
}

/// The parameters of [`skeleton`].
pub(super) const SKELETON: &[&str] = &["parent", "n", "language"];

/// `skeleton(parent, n, language)`, `compiler/src/check/subprogram.ts`: the
/// module the runtime starts for sub-program `n` of a lead.
///
/// Input: `{ parent: string, n: number, language?: language version }`
/// (`"mandate/0.4"` when absent).
/// Output: the program, `{ language, module, version, uses, defs }`.
pub(super) fn skeleton(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, SKELETON)?;
    let parent = a.str("parent")?;
    let n = a.int("n")?;
    let language = a.opt_language("language")?;
    // An integer of the IR's domain, within ±(2^53−1): a double holds it.
    Ok(ir(&crate::subprogram::skeleton(parent, n as f64, language)))
}

/// The parameters of [`subprogram_linked`].
pub(super) const SUBPROGRAM_LINKED: &[&str] = &["sub", "parent", "modules"];

/// `subprogramLinked(sub, parent, modules)`, `compiler/src/check.ts`: a
/// sub-program with every definition it sees, for the interpreter.
///
/// Input: `{ sub: program, parent: program, modules?: { <name>: program } }`.
/// Output: the program.
pub(super) fn subprogram_linked(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, SUBPROGRAM_LINKED)?;
    let sub = a.program("sub")?;
    let parent = a.program("parent")?;
    let modules = a.opt_modules("modules")?;
    Ok(ir(&crate::doors::subprogram_linked(sub, parent, modules)))
}
