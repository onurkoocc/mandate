//! The front door of the compiler: `check` and `loadModules`, lines 60–131
//! of `compiler/src/check.ts`.
//!
//! ```text
//! load → (stop if no program or an error) → link → (Rust: the import checks
//!      of `crate::imports`) → resolveNames → roleChecks
//!      → importedMethods → (Rust, 0.6: the patterns and applications of
//!      `crate::expand`, and the expanded program, which every stage after
//!      this one reads) → staticCheck (only if no error so far)
//!      → the lock checks (only with a lock and no error so far) → ok, hashes
//! ```
//!
//! Every stage runs, in this order, and `ok` means there is no error from any
//! of them (the static checks are [`crate::statics`]). The doors that stand
//! on `check` (`checkPatch`, `checkSubprogram`, `checkAmendment`) are in
//! [`crate::doors`].

use mandate_ir::{
    Diagnostic, JsObject, JsValue, Location, Map, Program, ProgramHashes, Spans, Value, has_errors,
    hash_program,
};
use mandate_syntax::{SourceKind, load};

use crate::caps::imported_methods;
use crate::expand::{ExpandOptions, expand};
use crate::imports::{KnownModules, import_checks_known, parent_of_subprogram};
use crate::lock::{
    Lock, connector_lock_checks, lock_checks, module_lock_checks, role_lock_checks, validate_lock,
};
use crate::modules::{Modules, Reach, link_reaching};
use crate::resolve::resolve_names;
use crate::roles::role_checks;

/// What [`check`] is given besides the text: `CheckOptions`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct CheckOptions<'a> {
    /// The lock file (spec/lock.md), as read. With it, tiers are checked
    /// against it and W0504 is computed.
    pub lock: Option<&'a Value>,
    /// Imported modules the caller has loaded, by name, such as a system
    /// model (design doc 9 §2.1). Their definitions are linked in; a module
    /// left out stays opaque. Each module should pass `check` on its own.
    pub modules: Option<&'a Modules>,
    /// For a lead's sub-program: the envelope its workflow stands under and
    /// its lead's data class, as `checkSubprogram` passes it, `{ envelope,
    /// lead }`.
    pub claim: Option<&'a Value>,
    /// 0.6: the libraries handed to the check (`crate::library`): the
    /// manifest and the module files of each library the lock pins, read
    /// from the operator's directory by the caller. With a lock, each must
    /// match its pin (E1605); without one, their modules are known as given
    /// modules are, and checked as a library's. The built-in `std.patterns`
    /// is never handed in.
    pub libraries: Option<&'a [crate::library::LibrarySource]>,
    /// 0.6: the digests the runtime's configuration revokes
    /// (`libraries.revoked`): a pinned library with one is E1608.
    pub revoked: Option<&'a std::collections::BTreeSet<mandate_lib::Digest>>,
    /// 0.6: the check is of a module of a library, whose given modules are
    /// what its library reaches, with what each of them reaches: no library
    /// is read besides, and linking follows the modules' imports into
    /// those they reach ([`crate::link_reaching`]).
    pub reach: Option<&'a crate::modules::Reach>,
}

/// What [`check`] gives: `CheckResult`, `LoadResult` with `ok` and
/// `hashes`.
#[derive(Clone, Debug, PartialEq)]
pub struct CheckResult {
    /// The program, as `load` gave it (from Mandate text also when it does
    /// not check).
    pub program: Option<Value>,
    /// JSON Pointer into the IR → span in the input.
    pub spans: Spans,
    /// Every diagnostic, in the order the stages gave them.
    pub diagnostics: Vec<Diagnostic>,
    /// No diagnostic is an error.
    pub ok: bool,
    /// The program's hashes, when `ok`.
    pub hashes: Option<ProgramHashes>,
    /// 0.6: when the program applies a pattern and checks (`ok`), the
    /// expanded program: the program with every application replaced by its
    /// expansion, a program of 0.6 with no `apply` in it (spec/library.md
    /// "Expansion"). The checks after the expansion read it; the hashes are
    /// the program's. `None` for every other program, and for one that does
    /// not check.
    pub expanded: Option<Value>,
}

impl CheckResult {
    /// `{ ok, hashes?, diagnostics }`: the object `mandate check` prints
    /// (`checkOutput` in `compiler/test/golden-outputs.ts`) and the
    /// conformance vectors store.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("ok", self.ok)
            .with_some("hashes", self.hashes.as_ref().map(ProgramHashes::to_js))
            .with(
                "diagnostics",
                self.diagnostics
                    .iter()
                    .map(Diagnostic::to_js)
                    .collect::<Vec<_>>(),
            )
            .into()
    }
}

/// One module source for [`load_modules`]: `ModuleSource`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModuleSource<'a> {
    /// The text.
    pub text: &'a str,
    /// Its form.
    pub kind: SourceKind,
    /// Where it was read from, for messages.
    pub file: &'a str,
}

/// The diagnostics of one module that did not load or check.
#[derive(Clone, Debug, PartialEq)]
pub struct ModuleProblem {
    /// The module's `file`.
    pub file: String,
    /// What `load`, or `check` against the other modules, said.
    pub diagnostics: Vec<Diagnostic>,
}

/// What [`load_modules`] gives.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LoadedModules {
    /// The modules that loaded, by the name each declares, in the order
    /// given.
    pub modules: Modules,
    /// The modules that did not load or did not check, in the order found.
    pub problems: Vec<ModuleProblem>,
}

/// Loads modules a program imports, such as a system model, and checks each
/// against the others: `loadModules(sources)`. Keyed by the name each
/// declares (`module …`); a name given twice is refused (E0121).
#[must_use]
pub fn load_modules(sources: &[ModuleSource<'_>]) -> LoadedModules {
    let mut modules = Modules::new();
    let mut problems = Vec::new();
    let mut loaded: Vec<(ModuleSource<'_>, String)> = Vec::new();
    for src in sources {
        let r = load(src.text, src.kind);
        let program = match r.program {
            Some(p) if !has_errors(&r.diagnostics) => p,
            _ => {
                problems.push(ModuleProblem {
                    file: src.file.to_owned(),
                    diagnostics: r.diagnostics,
                });
                continue;
            }
        };
        // `r.program.module`, written into a template literal and used as a
        // key: a program that loaded has a string there.
        let module = program
            .get("module")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if modules.contains_key(&module) {
            problems.push(ModuleProblem {
                file: src.file.to_owned(),
                diagnostics: vec![Diagnostic::new(
                    "E0121",
                    format!("Module {module} is given twice."),
                    Location::path("/module"),
                    Some(JsObject::new().with("module", module.as_str())),
                )],
            });
            continue;
        }
        // `modules[name] = program` on a plain object: for `__proto__` it
        // sets the prototype and adds no member, so the module is checked
        // below but is not among the modules.
        if module != "__proto__" {
            modules.insert(module.clone(), program);
        }
        loaded.push((*src, module));
    }
    for (src, module) in &loaded {
        // `Object.fromEntries(Object.entries(modules).filter(([m]) => m !== program.module))`.
        let others: Modules = modules
            .iter()
            .filter(|(m, _)| m != module)
            .map(|(m, p)| (m, p.clone()))
            .collect();
        let r = check(
            src.text,
            src.kind,
            &CheckOptions {
                modules: Some(&others),
                ..CheckOptions::default()
            },
        );
        if !r.ok {
            problems.push(ModuleProblem {
                file: src.file.to_owned(),
                diagnostics: r.diagnostics,
            });
        }
    }
    LoadedModules { modules, problems }
}

/// `d.at.path !== undefined && spans.get(d.at.path) ? { ...d, at: { ...d.at, span } } : d`:
/// the span of exactly the diagnostic's path, not the nearest one.
fn with_exact_span(d: Diagnostic, spans: &Spans) -> Diagnostic {
    match d.at.path.as_deref().and_then(|p| spans.get(p)).copied() {
        Some(span) => {
            let mut d = d;
            d.at = std::mem::take(&mut d.at).with_span(span);
            d
        }
        None => d,
    }
}

/// Reads, validates and checks a program, and hashes it when it checks:
/// `check(text, kind, opts)`.
///
/// The stages run as in `check.ts`: `load`, `link`, `resolveNames`,
/// `roleChecks`, `importedMethods`, then the static checks only if there is
/// no error so far, then, given a lock and still no error, the lock checks
/// (`validateLock` and, when it finds nothing, `lockChecks`,
/// `roleLockChecks` and `moduleLockChecks`).
#[must_use]
pub fn check(text: &str, kind: SourceKind, opts: &CheckOptions<'_>) -> CheckResult {
    let loaded = load(text, kind);
    let mut diagnostics = loaded.diagnostics.clone();
    let program_value = match &loaded.program {
        Some(p) if !has_errors(&diagnostics) => p,
        _ => {
            return CheckResult {
                program: loaded.program,
                spans: loaded.spans,
                diagnostics,
                ok: false,
                hashes: None,
                expanded: None,
            };
        }
    };
    let Some(program) = Program::of(program_value) else {
        // A program that loaded without an error is an object.
        return CheckResult {
            program: loaded.program,
            spans: loaded.spans,
            diagnostics,
            ok: false,
            hashes: None,
            expanded: None,
        };
    };
    // 0.6: the libraries the program reads (`crate::library`), whose
    // modules it links as given ones, each linked through what it reaches.
    // A check of a module of a library reads none: it is given them.
    let (libraries, merged) = libraries_of(program, opts);
    let modules: Option<&Modules> = merged.as_deref().or(opts.modules);
    let reach: Option<&Reach> = opts.reach.or(libraries.as_ref().map(|l| &l.reach));
    let linked = link_reaching(program, modules, reach);
    diagnostics.extend(
        linked
            .diagnostics
            .iter()
            .cloned()
            .map(|d| with_exact_span(d, &loaded.spans)),
    );
    if let Some(l) = &libraries {
        diagnostics.extend(l.diagnostics.iter().cloned());
    }
    let known = KnownModules {
        given: opts.modules,
        libraries: libraries
            .as_ref()
            .map(|l| &l.modules)
            .filter(|m| !m.is_empty()),
    };
    // 0.6: what a `use` may name (E1602, E1604); before 0.6, a module of
    // 0.6 given to an earlier program (E1603). Rust only.
    let own = parent_of_subprogram(program, opts.claim.is_some());
    diagnostics.extend(import_checks_known(
        program,
        known,
        Some(&loaded.spans),
        own,
    ));
    diagnostics.extend(resolve_names(
        program,
        Some(&loaded.spans),
        Some(&linked.defs),
    ));
    // A role is a name too, from 0.4: where one is named, it is a role
    // definition (E1501, E1503).
    diagnostics.extend(role_checks(
        program,
        Some(&loaded.spans),
        Some(&linked.defs),
    ));
    // Before 0.5, a method limit an imported 0.5 capability writes would be
    // read as none (E1804).
    let no_modules = Modules::new();
    let origin = linked.origin.iter().map(|(n, m)| (n.as_str(), m.as_str()));
    diagnostics.extend(
        imported_methods(
            program,
            &linked.defs,
            origin,
            modules.unwrap_or(&no_modules),
        )
        .into_iter()
        .map(|d| with_exact_span(d, &loaded.spans)),
    );
    // 0.6: the patterns and the applications (E1301 to E1307), and the
    // expanded program, which every check after this one reads in the
    // program's place (spec/library.md "Expansion"). A program that applies
    // no pattern is read as it is.
    let expansion = Some(expand(
        program,
        &linked,
        &ExpandOptions {
            modules,
            reach,
            spans: Some(&loaded.spans),
            own,
            applications: !has_errors(&diagnostics),
        },
    ));
    if let Some(e) = &expansion {
        diagnostics.extend(e.diagnostics.iter().cloned());
    }
    let expanded = expansion.as_ref().and_then(|e| e.program.clone());
    let expanded_linked = expanded
        .as_ref()
        .and_then(Program::of)
        .map(|p| link_reaching(p, modules, reach));
    let (target, target_linked) = match (expanded.as_ref().and_then(Program::of), &expanded_linked)
    {
        (Some(p), Some(l)) => (p, l),
        _ => (program, &linked),
    };
    // A diagnostic of the expansion, reported in the program that was
    // checked; any other as it is.
    let back = |d: Diagnostic| match &expansion {
        Some(e) if expanded.is_some() => e.map(d, Some(&loaded.spans)),
        _ => d,
    };
    // What the expansion wrote is held to the stages before the static
    // checks too: its names resolve, its roles are roles, and the names it
    // adds to the `use`s may be named. The rest of the program was checked
    // above, unchanged.
    if let Some(e) = expansion.as_ref().filter(|_| expanded.is_some())
        && !has_errors(&diagnostics)
    {
        let again = again_stage(target, target_linked, known, &loaded.spans, own);
        diagnostics.extend(
            again
                .into_iter()
                .filter(|d| d.at.path.as_deref().is_some_and(|p| e.expanded(p)))
                .map(back),
        );
    }
    // Static checks assume every name resolves.
    if !has_errors(&diagnostics) {
        diagnostics.extend(
            static_check(target, &loaded.spans, &target_linked.defs, opts.claim)
                .into_iter()
                .map(back),
        );
    }
    // `opts.lock && !hasErrors(diagnostics)`: a lock that is falsy is none.
    if let Some(lock) = opts.lock.filter(|l| l.is_truthy())
        && !has_errors(&diagnostics)
    {
        let pinned = libraries.as_ref().map(|l| &l.pinned);
        match lock_stage(lock, target, target_linked, &loaded.spans, modules, pinned) {
            Ok(found) => diagnostics.extend(found.into_iter().map(back)),
            Err(lock_diags) => diagnostics.extend(lock_diags),
        }
    }
    let ok = !has_errors(&diagnostics);
    // The program hash covers the application, not the expansion; and the
    // expansion is given only for a program that checks, as the hash is: a
    // caller never holds an expanded program that was refused.
    let hashes = ok.then(|| hash_program(program_value));
    CheckResult {
        program: loaded.program.clone(),
        spans: loaded.spans,
        diagnostics,
        ok,
        hashes,
        expanded: expanded.filter(|_| ok),
    }
}

/// The stages before the static checks, run again on what the expansion
/// wrote: its names resolve, its roles are roles, and the names it adds to
/// the `use`s may be named. Apart from [`check`], so that its frame, which
/// the static checks run under, stays small.
#[inline(never)]
fn again_stage(
    target: Program<'_>,
    target_linked: &crate::modules::Linked,
    known: KnownModules<'_>,
    spans: &Spans,
    own: Option<&str>,
) -> Vec<Diagnostic> {
    let mut again = import_checks_known(target, known, Some(spans), own);
    again.extend(resolve_names(
        target,
        Some(spans),
        Some(&target_linked.defs),
    ));
    again.extend(role_checks(target, Some(spans), Some(&target_linked.defs)));
    again
}

/// The lock checks of a program with no error so far: `Err` with what
/// `validateLock` finds when it finds something, else `Ok` with the
/// diagnostics of `lockChecks`, `roleLockChecks`, `moduleLockChecks` (but
/// for a module a library pins, 0.6) and, 0.6, the connectors' binding.
/// Apart from [`check`], so that its frame stays small.
#[inline(never)]
fn lock_stage(
    lock: &Value,
    target: Program<'_>,
    target_linked: &crate::modules::Linked,
    spans: &Spans,
    modules: Option<&Modules>,
    pinned: Option<&std::collections::BTreeSet<String>>,
) -> Result<Vec<Diagnostic>, Vec<Diagnostic>> {
    let lock_diags = validate_lock(lock);
    if !lock_diags.is_empty() {
        return Err(lock_diags);
    }
    let view = Lock::of(lock);
    let mut found: Vec<Diagnostic> = Vec::new();
    // `{ ...loaded.program, defs: linked.defs }`.
    let mut with_linked = target.members().clone();
    with_linked.insert("defs", target_linked.defs.clone());
    let with_linked = Value::Object(with_linked);
    if let Some(with_linked) = Program::of(&with_linked) {
        found.extend(lock_checks(with_linked, view, Some(spans)));
    }
    found.extend(role_lock_checks(target, target_linked, view, Some(spans)));
    found.extend(
        module_lock_checks(target, view, modules)
            .into_iter()
            .filter(|d| !pinned.is_some_and(|p| pinned_by_library(d, p))),
    );
    // 0.6: the connectors the package can call, bound (E1407, E1408).
    found.extend(connector_lock_checks(target, target_linked, view, modules));
    Ok(found)
}

/// `staticCheck(program, spans, linked.defs, opts.claim)` (Gate 1): the
/// static checks of `check/static.ts` and what it calls, with the claim of a
/// sub-program ([`crate::statics`]): the core (types, expressions,
/// constants, functions, contracts, recursion, budgets, the node count), the
/// authority (capabilities, agents, workflows, par, delegation, map,
/// effects, envelopes) and the system model (providers, reads, change
/// sets).
fn static_check(
    program: Program<'_>,
    spans: &Spans,
    defs: &Map,
    claim: Option<&Value>,
) -> Vec<Diagnostic> {
    crate::statics::static_check(program, Some(spans), Some(defs), claim)
}

/// What a check reads of the libraries (`crate::library::for_check`), and
/// the modules it links: the given ones with those of the libraries. Both
/// boxed and made here, so that the frame of [`check`] stays as small as it
/// was: the deepest programs are checked within a fixed stack.
#[inline(never)]
fn libraries_of(
    program: Program<'_>,
    opts: &CheckOptions<'_>,
) -> (Option<Box<crate::library::ForCheck>>, Option<Box<Modules>>) {
    if opts.reach.is_some()
        || !program
            .language()
            .is_some_and(|l| l.at_least(mandate_ir::Language::V0_6))
    {
        return (None, None);
    }
    let Some(libraries) = crate::library::for_check(program, opts) else {
        return (None, None);
    };
    let merged = (!libraries.modules.is_empty()).then(|| {
        let mut all = opts.modules.cloned().unwrap_or_default();
        for (m, p) in libraries.modules.iter() {
            all.insert(m, p.clone());
        }
        Box::new(all)
    });
    (Some(Box::new(libraries)), merged)
}

/// Whether `d` is the E0142 of a module a library of the lock pins, which
/// the lock's top-level `modules` does not pin (0.6: its library's pin is
/// its pin, E1605).
fn pinned_by_library(d: &Diagnostic, pinned: &std::collections::BTreeSet<String>) -> bool {
    d.code == "MDT-E0142"
        && d.facts
            .as_ref()
            .and_then(|f| f.get("module"))
            .and_then(JsValue::as_str)
            .is_some_and(|m| pinned.contains(m))
}
