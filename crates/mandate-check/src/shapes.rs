//! `shapes` in an envelope (language 0.6; spec/library.md "`shapes`"),
//! which only the Rust compiler reads.
//!
//! `shapes [P, …]` lists the patterns a lead's sub-programs may apply. In IR
//! it is the envelope's `"shapes"`, a set of names (the schema holds it to at
//! least one, each once; the parser writes it sorted). Three rules hold it:
//!
//! - E1711 ([`shape_checks`]): every name in `shapes` is a pattern the
//!   program can name, its own or one a `use` list brings (`std.patterns`
//!   among them), reported by `mandate check` at the name.
//! - E1710 ([`subprogram_shape_of`]): when the envelope has `shapes`, a
//!   lead's sub-program's one workflow is an application of a pattern the
//!   list names, and that name means the definition it means in the parent
//!   (the same module and the same name): a pattern of another module under
//!   a listed name is not one of the shapes. `crate::check_subprogram`
//!   returns it to the lead, as E1705. The result of an admitted sub-program
//!   names the shape it applies ([`Shape`]).
//! - E1709 with `dimension: "shapes"` (`crate::amendment::narrowings`): an
//!   amendment keeps every shape and does not add `shapes` to an envelope
//!   that had none.
//!
//! A name resolves as the pattern of an application does
//! (`crate::expand`): a definition of the program's own, else the first
//! `use` of a module other than `std` whose list names it.

use mandate_ir::{
    DefKind, Definition, Diagnostic, JsObject, JsValue, Language, Location, Map, Program, Spans,
    Value, nearest_span, ptr,
};

/// The shape a lead's sub-program applies: the pattern's name and the
/// module that defines it (the parent's own module for a pattern the parent
/// defines, `std.patterns` for one of the built-in library).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shape {
    /// The pattern's name.
    pub pattern: String,
    /// The module that defines it.
    pub module: String,
}

impl Shape {
    /// `{ pattern, module }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("pattern", self.pattern.as_str())
            .with("module", self.module.as_str())
            .into()
    }
}

/// The names of an envelope's `shapes`, as written, when it has them.
#[must_use]
pub fn shapes_of(envelope: &Value) -> Option<Vec<&str>> {
    envelope
        .get("shapes")
        .and_then(Value::as_array)
        .map(|xs| xs.iter().filter_map(Value::as_str).collect())
}

/// The module whose `use` list names `name`, when a `use` of a module that
/// is not `std` itself lists it.
fn imported_from<'a>(program: Program<'a>, name: &str) -> Option<&'a str> {
    program
        .imports()
        .find(|u| u.module().is_some_and(|m| m != "std") && u.names().any(|n| n == name))
        .and_then(|u| u.module())
}

/// The module `name` resolves to in `program`, as the pattern of an
/// application resolves: the program's own module for a definition of its
/// own, else the module a `use` list brings it from.
#[must_use]
pub fn module_of<'a>(program: Program<'a>, name: &str) -> Option<&'a str> {
    if program.defs().is_some_and(|d| d.contains_key(name)) {
        program.module()
    } else {
        imported_from(program, name)
    }
}

/// E1711: every name an envelope's `shapes` lists is a pattern, the
/// program's own or one a `use` list brings, in a program of 0.6. `linked`
/// is every definition the program sees.
#[must_use]
pub fn shape_checks(program: Program<'_>, linked: &Map, spans: Option<&Spans>) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_6))
    {
        return out;
    }
    for (workflow, d) in program.definitions() {
        if d.kind() != Some(DefKind::Workflow) {
            continue;
        }
        let Some(envelope) = d.value().get("envelope") else {
            continue;
        };
        let Some(shapes) = envelope.get("shapes").and_then(Value::as_array) else {
            continue;
        };
        for (i, s) in shapes.iter().enumerate() {
            let Some(name) = s.as_str() else { continue };
            let own = program.defs().and_then(|d| d.get(name));
            let module = if own.is_some() {
                None
            } else {
                imported_from(program, name)
            };
            let found = own.or_else(|| module.and_then(|_| linked.get(name)));
            let kind = found.and_then(|v| Definition::of(v).kind());
            if kind == Some(DefKind::Pattern) {
                continue;
            }
            let path = format!("{}/envelope/shapes/{i}", ptr(&[&"defs", &workflow]));
            let message = match (kind, module) {
                (Some(k), Some(m)) => format!(
                    "{workflow}'s envelope lists {name} among its shapes, which module {m} defines as {} {}, not a pattern. A shape is a pattern a lead's sub-program may apply (spec/library.md \"shapes\").",
                    article(k.as_str()),
                    k.as_str()
                ),
                (Some(k), None) => format!(
                    "{workflow}'s envelope lists {name} among its shapes, which is {} {}, not a pattern. A shape is a pattern a lead's sub-program may apply (spec/library.md \"shapes\").",
                    article(k.as_str()),
                    k.as_str()
                ),
                (None, _) => format!(
                    "{workflow}'s envelope lists {name} among its shapes, which names no definition of this program and no name a use list brings. A shape is a pattern the program defines or imports (spec/library.md \"shapes\")."
                ),
            };
            let facts = JsObject::new()
                .with("workflow", workflow)
                .with("shape", name)
                .with(
                    "kind",
                    kind.map_or(JsValue::Null, |k| JsValue::from(k.as_str())),
                )
                .with_some("module", module);
            out.push(Diagnostic::new(
                "E1711",
                message,
                Location::path_span(path.clone(), nearest_span(spans, &path)),
                Some(facts),
            ));
        }
    }
    out
}

/// `a` or `an` before `kind`.
fn article(kind: &str) -> &'static str {
    if kind.starts_with(['a', 'e', 'i', 'o', 'u']) {
        "an"
    } else {
        "a"
    }
}

/// E1710, or the shape a sub-program applies: whether the one workflow of
/// `sub` (`workflow`, the sub-program as the lead wrote it) applies a
/// pattern `shapes` lists, meaning by its name what the name means in
/// `parent`. `view` is the sub-program as its checks read it
/// (`crate::opened`), where the parent's own definitions and its imports
/// are in sight. `Ok` with the shape when it does; `Err` with the one
/// diagnostic otherwise.
///
/// # Errors
///
/// E1710: the workflow is written out, applies a pattern the list does not
/// name, or applies under a listed name a definition other than the one the
/// parent lists.
pub fn subprogram_shape_of(
    parent: Program<'_>,
    shapes: &[&str],
    view: Program<'_>,
    workflow: &str,
) -> Result<Shape, Box<Diagnostic>> {
    let listed: Vec<JsValue> = shapes.iter().map(|s| JsValue::from(*s)).collect();
    let at = ptr(&[&"defs", &workflow]);
    let wf = view.defs().and_then(|d| d.get(workflow));
    let applied = wf
        .and_then(|w| w.get("apply"))
        .and_then(|a| a.get("pattern"))
        .and_then(Value::as_str);
    let Some(pattern) = applied else {
        return Err(Box::new(Diagnostic::new(
            "E1710",
            format!(
                "{workflow} is written out, and the envelope's shapes say a sub-program applies one of {}: its workflow is `workflow {workflow} = P<…>(…)` with its caps and budget (spec/library.md \"shapes\").",
                shapes.join(", ")
            ),
            Location::path(at),
            Some(
                JsObject::new()
                    .with("workflow", workflow)
                    .with("problem", "not_an_application")
                    .with("shapes", listed),
            ),
        )));
    };
    let module = module_of(view, pattern);
    let wanted = shapes
        .contains(&pattern)
        .then(|| module_of(parent, pattern))
        .flatten();
    if let (Some(m), Some(w)) = (module, wanted)
        && m == w
    {
        return Ok(Shape {
            pattern: pattern.to_owned(),
            module: m.to_owned(),
        });
    }
    let (problem, message) = match wanted {
        None => (
            "not_listed",
            format!(
                "{workflow} applies {pattern}, which is not one of the envelope's shapes: {} (spec/library.md \"shapes\").",
                shapes.join(", ")
            ),
        ),
        Some(w) => (
            "other_definition",
            format!(
                "{workflow} applies {pattern} of {}, and the envelope's shape {pattern} is the pattern of {w}: a sub-program applies the very pattern the envelope lists (spec/library.md \"shapes\").",
                module.unwrap_or("no module")
            ),
        ),
    };
    Err(Box::new(Diagnostic::new(
        "E1710",
        message,
        Location::path(format!("{at}/apply/pattern")),
        Some(
            JsObject::new()
                .with("workflow", workflow)
                .with("pattern", pattern)
                .with("problem", problem)
                .with_some("module", module)
                .with_some("shape_module", wanted)
                .with("shapes", listed),
        ),
    )))
}
