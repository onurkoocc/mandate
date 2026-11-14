//! What a `use` may name, from language 0.6 on (spec/library.md "The 0.6
//! surface"): the modules a program of 0.6 may import (closed imports,
//! E1604), the definitions of a module of 0.6 that another module may name
//! (visibility, E1602), and a program of 0.1 to 0.5 that imports a module of
//! 0.6 (E1603).
//!
//! **What stays as it was.** Before 0.6 an import of a module that is not
//! loaded is taken on trust: [`crate::link`] adds nothing for it, and
//! [`crate::resolve_names`] accepts its names as imported, so that the
//! static checks see them with unknown types. That trust is not changed
//! here, for any version: in a program of 0.6, every `use` that would be
//! taken on trust is E1604 instead, so the trust is never reached without
//! an error. And every definition of a module of 0.1 to 0.5 may be named,
//! from any program. So for a program of 0.1 to 0.5 this module adds one
//! thing only, E1603, for a module of 0.6 given to its check, which no
//! stored result of such a program has (no TypeScript loads a module of
//! 0.6); everything else is read for a program of 0.6 alone.
//!
//! **What a check knows.** [`KnownModules`] is the one answer to "is this
//! module known to this check". It knows `std` itself and `std.decision`
//! (the standard library the compiler describes) and the modules the check
//! was given (`CheckOptions::modules`: `--module`, the modules of an MCP
//! call or of a package). spec/library.md also lets a program of 0.6 import
//! the compiler's built-in `std.patterns` and the modules of a library the
//! lock pins under `libraries`; neither exists in the compiler yet, so a
//! `use std.patterns…` that no given module satisfies is E1604 today. The
//! step that adds libraries adds both in [`KnownModules::knows`], the one
//! place that decides.
//!
//! **Where a name of a module is.** In a `use` list (`use acme.types.{Order}`,
//! E1602 at `/uses/<i>/names/<j>`), checked here; and written with its module
//! (`types.Order`, `acme.types.Order` as a type, a record literal's type or
//! an effect, and `types.helper` as a value), checked by the name resolution,
//! which knows what a name means where it is ([`Visibility`]).

use mandate_ir::{
    Diagnostic, JsObject, Language, Location, Program, Spans, Value, nearest_span, ptr,
};

use crate::modules::Modules;

/// The standard modules a program of 0.6 may import without being given
/// them: `std` itself (`use std.{fs, model}`) and `std.decision`.
pub const STD_MODULES: [&str; 2] = ["std", "std.decision"];

/// The modules a check knows: what a `use` of a program of 0.6 may name
/// (spec/library.md "Closed imports").
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct KnownModules<'a> {
    /// The modules the check was given, by name.
    pub given: Option<&'a Modules>,
}

impl KnownModules<'_> {
    /// Whether `module` is known to this check: `std`, `std.decision`, or a
    /// module the check was given.
    ///
    /// The step of 0.6 that reads libraries (RL8) adds here, and nowhere
    /// else, the two other kinds spec/library.md allows: the compiler's
    /// built-in `std.patterns`, and the modules of each library the lock
    /// pins (`libraries.<name>.modules`, with a module of a library that
    /// imports the modules of its own library and of the libraries its
    /// manifest `requires`).
    #[must_use]
    pub fn knows(&self, module: &str) -> bool {
        STD_MODULES.contains(&module) || self.given.is_some_and(|m| m.contains_key(module))
    }

    /// What the check knows, as a message says it.
    fn described(&self) -> &'static str {
        "std, std.decision and the modules the check was given"
    }
}

/// Whether a program of `language` reads the rules of 0.6.
fn reads_0_6(language: Option<Language>) -> bool {
    language.is_some_and(|l| l.at_least(Language::V0_6))
}

/// Whether the definition `d` is `pub`.
fn is_pub(d: &Value) -> bool {
    d.get("pub").is_some_and(Value::is_truthy)
}

/// The E1602 for naming `name`, a definition of the 0.6 module `module`
/// that is not `pub`, at `path`; `None` when the module does not hold it as
/// a definition that is not `pub` (it is `pub`, or the module is of 0.1 to
/// 0.5, or it has no such definition, which is another code's).
fn not_public(
    module: &str,
    m: &Value,
    name: &str,
    path: &str,
    spans: Option<&Spans>,
) -> Option<Diagnostic> {
    if !reads_0_6(m.get("language").and_then(Language::from_value)) {
        return None;
    }
    let d = m.get("defs").and_then(|defs| defs.get(name))?;
    if is_pub(d) {
        return None;
    }
    Some(Diagnostic::new(
        "E1602",
        format!(
            "'{name}' of {module} is not pub: a module of mandate/0.6 lets another module name only its pub definitions."
        ),
        Location::path_span(path, nearest_span(spans, path)),
        Some(JsObject::new().with("name", name).with("module", module)),
    ))
}

/// The module whose definitions a lead's sub-program names as its own: its
/// parent's, `<parent>` for the sub-program `<parent>.plan_<n>`
/// (spec/envelope.md "The sub-program"), when the check is one of a
/// sub-program (`claimed`: it was given the claim of its envelope). The
/// sub-program is the parent's plan, run in the parent's run, and sees
/// everything its parent sees ([`crate::opened`] imports every definition of
/// the parent), `pub` or not.
#[must_use]
pub fn parent_of_subprogram(program: Program<'_>, claimed: bool) -> Option<&str> {
    let (parent, n) = program.module()?.rsplit_once(".plan_")?;
    (claimed && !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())).then_some(parent)
}

/// The checks of a program's imports: E1603 for a program of 0.1 to 0.5,
/// E1604 and the E1602 of its `use` lists for a program of 0.6, in the order
/// of its `uses`. `modules` are the modules the check was given; `own` is
/// the module whose definitions the program names as its own, `pub` or not
/// (the parent of a sub-program, [`parent_of_subprogram`]).
#[must_use]
pub fn import_checks(
    program: Program<'_>,
    modules: Option<&Modules>,
    spans: Option<&Spans>,
    own: Option<&str>,
) -> Vec<Diagnostic> {
    let language = program.language();
    let known = KnownModules { given: modules };
    let mut out = Vec::new();
    for (i, u) in program.use_values().iter().enumerate() {
        let Some(module) = u.get("module").and_then(Value::as_str) else {
            continue;
        };
        let given = modules.and_then(|ms| ms.get(module));
        let path = ptr(&[&"uses", &i]);
        if !reads_0_6(language) {
            if let Some(m) = given
                && let Some(module_language) = m
                    .get("language")
                    .and_then(Language::from_value)
                    .filter(|l| reads_0_6(Some(*l)))
            {
                out.push(earlier_program(
                    program,
                    module,
                    module_language,
                    &path,
                    spans,
                ));
            }
            continue;
        }
        if !known.knows(module) {
            out.push(Diagnostic::new(
                "E1604",
                format!(
                    "Module {module} is not known to this check: a program of mandate/0.6 imports only {}. Give the module, or remove the use.",
                    known.described()
                ),
                Location::path_span(&path, nearest_span(spans, &path)),
                Some(JsObject::new().with("module", module)),
            ));
            continue;
        }
        let Some(m) = given.filter(|_| own != Some(module)) else {
            continue;
        };
        let names = u.get("names").and_then(Value::as_array).unwrap_or_default();
        for (j, name) in names.iter().enumerate() {
            let Some(name) = name.as_str() else { continue };
            let at = ptr(&[&"uses", &i, &"names", &j]);
            out.extend(not_public(module, m, name, &at, spans));
        }
    }
    out
}

/// The E1603 of a program of 0.1 to 0.5 that imports `module`, of
/// `module_language`, at `path`.
fn earlier_program(
    program: Program<'_>,
    module: &str,
    module_language: Language,
    path: &str,
    spans: Option<&Spans>,
) -> Diagnostic {
    let language = program
        .members()
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("mandate/0.1");
    Diagnostic::new(
        "E1603",
        format!(
            "Module {module} is written in {}, and this program is {language}, which would read its definitions without the rules of {}. Write the program in {} or later.",
            module_language.as_str(),
            module_language.as_str(),
            module_language.as_str()
        ),
        Location::path_span(path, nearest_span(spans, path)),
        Some(
            JsObject::new()
                .with("module", module)
                .with("module_language", module_language.as_str())
                .with("language", language),
        ),
    )
}

/// Visibility where a name is written with its module, for the name
/// resolution of a program of 0.6: `types.Order` (after `use acme.types`)
/// or `acme.types.Order` (after any `use acme.types`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Visibility<'a> {
    program: Program<'a>,
    modules: &'a Modules,
    own: Option<&'a str>,
}

impl<'a> Visibility<'a> {
    /// The visibility of `program` with `modules` given, `own` the module
    /// whose definitions it names as its own ([`import_checks`]); `None` for
    /// a program of 0.1 to 0.5, which names every definition as before, and
    /// for a check given no module.
    pub(crate) fn of(
        program: Program<'a>,
        modules: Option<&'a Modules>,
        own: Option<&'a str>,
    ) -> Option<Self> {
        let modules = modules?;
        reads_0_6(program.language()).then_some(Visibility {
            program,
            modules,
            own,
        })
    }

    /// The module `prefix` stands for: the module of a `use` that names it
    /// whole (`acme.types`), or the module of a `use` without names whose
    /// last part it is (`types` for `use acme.types`).
    fn module_of(&self, prefix: &str) -> Option<&'a str> {
        let mut by_alias = None;
        for u in self.program.imports() {
            let Some(module) = u.module() else { continue };
            if module == prefix {
                return Some(module);
            }
            let alias = module.rsplit('.').next().unwrap_or(module);
            if by_alias.is_none() && u.names_given().is_none() && alias == prefix {
                by_alias = Some(module);
            }
        }
        by_alias
    }

    /// The E1602 for `name` written as a member of `prefix` at `path`, when
    /// `prefix` stands for a 0.6 module the check was given and `name` is a
    /// definition of it that is not `pub`.
    pub(crate) fn member(
        &self,
        prefix: &str,
        name: &str,
        path: &str,
        spans: Option<&Spans>,
    ) -> Option<Diagnostic> {
        let module = self.module_of(prefix).filter(|m| self.own != Some(*m))?;
        let m = self.modules.get(module)?;
        not_public(module, m, name, path, spans)
    }

    /// The E1602 for a qualified name (`types.Order`) at `path`, as
    /// [`Visibility::member`] of its last part.
    pub(crate) fn qualified(
        &self,
        qualified: &str,
        path: &str,
        spans: Option<&Spans>,
    ) -> Option<Diagnostic> {
        let (prefix, name) = qualified.rsplit_once('.')?;
        self.member(prefix, name, path, spans)
    }
}
