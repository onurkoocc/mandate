//! What a `use` may name, from language 0.6 on (spec/library.md "The 0.6
//! surface"): the modules a program of 0.6 may import (closed imports,
//! E1604), the definitions of a module of 0.6 that another module may name
//! (visibility, E1602), and a program of 0.1 to 0.5 that imports a module of
//! 0.6 (E1603).
//!
//! **What stays as it was.** Before 0.6 an import of a module that is not
//! loaded is taken on trust: [`crate::link`] adds nothing for it, and
//! [`crate::resolve_names`] accepts its names as imported, so that the
//! static checks see them with unknown types. So is a name written with a
//! module path (`types.Order` after `use acme.types`, `acme.types.Order`
//! after any `use acme.types`), which `link` never links: the resolver takes
//! the path as a module's and what it names on trust. That trust is not
//! changed for 0.1 to 0.5. In a program of 0.6 it is never reached without
//! an error: a `use` of a module the check does not know is E1604, a `use`
//! of a module that is not the standard library's lists the names it brings
//! or is E1604 too, and the resolver reads neither the last segment of such
//! a module nor a name written with its path as a name (it reports each as
//! the unknown name of its place). So in 0.6 a module's definitions are
//! named through a `use` list alone, and E1602 is a `use` list's; and a name
//! a list brings is the definition it names, held to its kind as the
//! program's own definition is (`crate::resolve`). Every
//! definition of a module of 0.1 to 0.5 may still be named, from any
//! program. For a program of 0.1 to 0.5 this module adds one thing only,
//! E1603, for a module of 0.6 given to its check, which no stored result of
//! such a program has (no TypeScript loads a module of 0.6).
//!
//! **What a check knows.** [`KnownModules`] is the one answer to "is this
//! module known to this check". It knows `std` itself and `std.decision`
//! (the standard library the compiler describes), the modules the check
//! was given (`CheckOptions::modules`: `--module`, the modules of an MCP
//! call or of a package), and the modules of the libraries the check reads
//! (`crate::library`): the compiler's built-in `std.patterns`, and each
//! library handed to it, which the lock pins when the check has one (a
//! library that does not match its pin is E1605, not unknown). Inside a
//! library a module is checked with the modules of its own library and of
//! the libraries its manifest requires as its given modules, and nothing
//! else, so it imports no others (E1604). [`KnownModules::is_builtin`] is
//! the one answer to "is this module the standard library's", whose path
//! and members stay names: `std.patterns` is not, it is linked as a given
//! module is, by the names its `use` lists.

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
    /// 0.6: the modules of the libraries the check reads, by name: the
    /// built-in `std.patterns` when the program imports it, and the modules
    /// of each library handed to the check (`crate::library`).
    pub libraries: Option<&'a Modules>,
}

impl KnownModules<'_> {
    /// Whether `module` is known to this check: `std`, `std.decision`, a
    /// module the check was given, or a module of a library it reads (the
    /// built-in `std.patterns` among them). This is the one place that
    /// decides.
    #[must_use]
    pub fn knows(&self, module: &str) -> bool {
        Self::is_builtin(module)
            || self.given.is_some_and(|m| m.contains_key(module))
            || self.libraries.is_some_and(|m| m.contains_key(module))
    }

    /// The module's IR, as the check was given it or as a library holds it.
    #[must_use]
    pub fn module(&self, module: &str) -> Option<&Value> {
        self.libraries
            .and_then(|m| m.get(module))
            .or_else(|| self.given.and_then(|m| m.get(module)))
    }

    /// Whether `module` is built into the compiler, the standard library:
    /// `std` and `std.decision`, whose members a program names through the
    /// module (`fs.read`, `decision.threshold`) and which a `use` may import
    /// without a list. A program of 0.6 imports every other module through
    /// the list of its `use`, `std.patterns` included: it is a library,
    /// whose names are the definitions its `use` lists.
    #[must_use]
    pub fn is_builtin(module: &str) -> bool {
        STD_MODULES.contains(&module)
    }

    /// What the check knows, as a message says it.
    fn described(&self) -> &'static str {
        "std, std.decision, std.patterns, the modules the check was given and those of the libraries the lock pins"
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

/// The checks of a program's imports: E1603 for a program of 0.1 to 0.5;
/// for a program of 0.6, E1604 for a `use` of a module the check does not
/// know or of a module not the standard library's without a list, and the
/// E1602 of its `use` lists; in the order of its `uses`. `modules` are the modules the check was given; `own` is
/// the module whose definitions the program names as its own, `pub` or not
/// (the parent of a sub-program, [`parent_of_subprogram`]).
#[must_use]
pub fn import_checks(
    program: Program<'_>,
    modules: Option<&Modules>,
    spans: Option<&Spans>,
    own: Option<&str>,
) -> Vec<Diagnostic> {
    import_checks_known(
        program,
        KnownModules {
            given: modules,
            libraries: None,
        },
        spans,
        own,
    )
}

/// [`import_checks`] with what the check knows besides the modules it was
/// given: the modules of the libraries it reads (0.6).
#[must_use]
pub fn import_checks_known(
    program: Program<'_>,
    known: KnownModules<'_>,
    spans: Option<&Spans>,
    own: Option<&str>,
) -> Vec<Diagnostic> {
    let language = program.language();
    let mut out = Vec::new();
    for (i, u) in program.use_values().iter().enumerate() {
        let Some(module) = u.get("module").and_then(Value::as_str) else {
            continue;
        };
        let given = known.module(module);
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
        if u.get("names").is_none() && !KnownModules::is_builtin(module) {
            out.push(Diagnostic::new(
                "E1604",
                format!(
                    "The use of {module} lists no names: in a program of mandate/0.6 an import of a module that is not the standard library's brings only the names it lists. List them, as in use {module}.{{…}}."
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
