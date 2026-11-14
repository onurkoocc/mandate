//! Name resolution over canonical IR (Doc 4 §11.1, stage 2; E01xx): a port
//! of `compiler/src/resolve/resolve.ts`.
//!
//! Every reference must name something that exists (S03): type references,
//! capabilities in `caps` lists, agents and skills in `delegate`, contracts
//! in `verify`, effects in `effect` calls and compensations, and variables.
//!
//! Members of standard-library and imported modules are not described, so
//! calls into them are not checked beyond their module name, and a bare
//! identifier passed as an argument to such a call (`tier: standard`,
//! `methods: [GET, POST]`) is read as a symbol rather than a variable.
//!
//! The TypeScript walks the IR with a class; here a `Resolver` does, one
//! method for each of its methods. Scopes are a chain (`{ names, parent }`),
//! shared with `Rc` where the TypeScript shares the object. The candidate
//! lists given to [`closest`] are not always built in the TypeScript's
//! order: [`closest`] gives the same answer for any order of the same
//! candidates (see its documentation).
//!
//! Paths are built as the TypeScript builds them: most keys of a map are
//! written into a path without `ptrToken` (a skill, a record field, a
//! branch, a handler, a criterion, all of which are names that need no
//! escape), and a read, an authorization, a change set's member and a
//! change with it. The port keeps each as it is.

use std::rc::Rc;

use mandate_ir::{
    Arg, CallSpec, Criterion, DefKind, Definition, Diagnostic, Expr, ExprOp, Import, JsObject,
    JsValue, Language, Location, Map, OnHandler, Param, Pattern, PatternKind, Program, Read,
    Repair, RepairOp, RepairOpKind, Risk, Skill, Spans, Stmt, StmtOp, TemplatePart, TestDef,
    TypeExpr, TypeForm, Value, Variant, Verifier, VerifierForm, nearest_span, ptr, ptr_token,
};

use crate::stdlib::{STD_EFFECTS, std_effect};

/// The built-in types, in order: `BUILTIN_TYPES`.
pub const BUILTIN_TYPES: [&str; 36] = [
    "Bool",
    "Int",
    "Dec",
    "Text",
    "Bytes",
    "Path",
    "Url",
    "Time",
    "Duration",
    "Money",
    "Id",
    "List",
    "Set",
    "Map",
    "Option",
    "Result",
    "Ratio",
    "Prob",
    "Inferred",
    "Verified",
    "Untrusted",
    "Evidence",
    "Decision",
    "PreparedAction",
    "Authorization",
    "Receipt",
    "Task",
    "Prompt",
    "Budget",
    "EvidenceRef",
    "ArtifactRef",
    "CapRef",
    "OperationKey",
    "Approval",
    "Question",
    "Masked",
];

/// The built-in types a 0.4 program has as well, what one item of a `map`
/// came to (spec/envelope.md): `BUILTIN_TYPES_0_4`.
pub const BUILTIN_TYPES_0_4: [&str; 1] = ["Outcome"];

/// Functions available without an import: `BUILTIN_FUNCTIONS`.
pub const BUILTIN_FUNCTIONS: [&str; 7] = [
    "quote",
    "peek",
    "len",
    "caps_diff",
    "review",
    "eval",
    "evidence",
];

/// Supervision strategies (§8.7), usable on their own after
/// `on error(…) =>`: `SUPERVISION_STRATEGIES`.
pub const SUPERVISION_STRATEGIES: [&str; 5] = [
    "restart",
    "restart_all",
    "fail_fast",
    "degrade",
    "reconcile",
];

/// The E0120 of every name of `program` that names nothing:
/// `resolveNames(program, spans, linked)`. `linked` is the table of
/// definitions the program sees with its imported modules loaded
/// ([`crate::link`]); without it, imports are opaque names.
#[must_use]
pub fn resolve_names(
    program: Program<'_>,
    spans: Option<&Spans>,
    linked: Option<&Map>,
) -> Vec<Diagnostic> {
    let empty = Map::new();
    let defs = program.defs().unwrap_or(&empty);
    let mut r = Resolver {
        program,
        spans,
        defs,
        all: linked.unwrap_or(defs),
        imported: Vec::new(),
        imported_modules: Vec::new(),
        builtin_types: BUILTIN_TYPES.to_vec(),
        out: Vec::new(),
    };
    if program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_4))
    {
        r.builtin_types.extend(BUILTIN_TYPES_0_4);
    }
    for u in program.use_values().iter().filter_map(Import::of) {
        if let Some(names) = u.names_given() {
            for n in names.iter().filter_map(Value::as_str) {
                insert(&mut r.imported, n);
                // `use std.{fs, net}` imports modules; their members are
                // called as fs.read(…). `/^[a-z]/.test(n)`.
                if u.module() == Some("std") || n.starts_with(|c: char| c.is_ascii_lowercase()) {
                    insert(&mut r.imported_modules, n);
                }
            }
        } else if let Some(module) = u.module() {
            // `u.module.split(".").pop()!`.
            let last = module.rsplit('.').next().unwrap_or(module);
            insert(&mut r.imported, last);
            insert(&mut r.imported_modules, last);
        }
    }
    r.run();
    r.out
}

/// `set.add(x)` on a set kept in insertion order.
fn insert<'a>(set: &mut Vec<&'a str>, x: &'a str) {
    if !set.contains(&x) {
        set.push(x);
    }
}

/// A scope: the names it binds, and the scope around it.
struct Scope {
    names: Vec<String>,
    parent: Option<Rc<Scope>>,
}

impl Scope {
    fn root() -> Rc<Scope> {
        Rc::new(Scope {
            names: Vec::new(),
            parent: None,
        })
    }

    fn child(names: Vec<String>, parent: &Rc<Scope>) -> Rc<Scope> {
        Rc::new(Scope {
            names,
            parent: Some(Rc::clone(parent)),
        })
    }
}

/// Where a walk is: `Ctx`. The TypeScript's `test` member is set and never
/// read, so it is left out.
#[derive(Clone)]
struct Ctx {
    scope: Rc<Scope>,
    /// Inside the arguments of a call into a module this compiler does not
    /// describe.
    symbolic: bool,
}

impl Ctx {
    fn top() -> Ctx {
        Ctx {
            scope: Scope::root(),
            symbolic: false,
        }
    }

    fn symbolic(&self) -> Ctx {
        Ctx {
            scope: Rc::clone(&self.scope),
            symbolic: true,
        }
    }

    fn with_scope(&self, scope: Rc<Scope>) -> Ctx {
        Ctx {
            scope,
            symbolic: self.symbolic,
        }
    }

    /// `{ ...ctx, scope: { names, parent: ctx.scope } }`.
    fn inner(&self, names: Vec<String>) -> Ctx {
        self.with_scope(Scope::child(names, &self.scope))
    }
}

/// The value a repair puts in place of a name: `replace(near)`.
#[derive(Clone, Copy)]
enum Replace {
    /// `(n) => n`: the name itself.
    Name,
    /// `(n) => ({ op: "var", name: n })`.
    Var,
}

impl Replace {
    fn value(self, name: &str) -> JsValue {
        match self {
            Replace::Name => JsValue::from(name),
            Replace::Var => JsObject::new().with("op", "var").with("name", name).into(),
        }
    }
}

struct Resolver<'a> {
    program: Program<'a>,
    spans: Option<&'a Spans>,
    /// The program's own definitions: what it names directly.
    defs: &'a Map,
    /// Its own and every linked imported definition: what the names mean.
    all: &'a Map,
    /// Names brought in by `use`: module aliases and imported members.
    imported: Vec<&'a str>,
    imported_modules: Vec<&'a str>,
    /// The built-in type names of the program's language version.
    builtin_types: Vec<&'static str>,
    out: Vec<Diagnostic>,
}

fn kind_of(d: &Value) -> Option<DefKind> {
    Definition::of(d).kind()
}

impl<'a> Resolver<'a> {
    fn run(&mut self) {
        for (name, def) in self.defs.iter() {
            self.def(def, &ptr(&[&"defs", &name]));
        }
        for (name, t) in self.program.tests() {
            let base = ptr(&[&"tests", &name]);
            let ctx = Ctx::top();
            let Some(t) = TestDef::of(t) else { continue };
            for (h, e) in t.handlers() {
                if let Some(e) = Expr::of(e) {
                    self.expr(e, &format!("{base}/handlers/{h}"), &ctx.symbolic());
                }
            }
            self.block(t.body(), &format!("{base}/body"), &ctx);
        }
    }

    fn report(
        &mut self,
        path: &str,
        message: String,
        name: &str,
        expected: &str,
        candidates: Vec<&str>,
        replace: Option<Replace>,
    ) {
        let span = nearest_span(self.spans, path);
        let near = closest(name, candidates);
        let mut d = Diagnostic::new(
            "E0120",
            message,
            Location::path_span(path, span),
            Some(
                JsObject::new()
                    .with("name", name)
                    .with("expected", expected)
                    .with_some("did_you_mean", near.as_deref()),
            ),
        );
        if let (Some(near), Some(replace)) = (near.as_deref(), replace) {
            d = d.with_repair(vec![Repair {
                id: "r1".to_owned(),
                summary: format!("Use '{near}'"),
                patch: vec![RepairOp {
                    op: RepairOpKind::Replace,
                    path: path.to_owned(),
                    value: Some(replace.value(near)),
                }],
                risk: Risk::Low,
                requires_approval: None,
            }]);
        }
        self.out.push(d);
    }

    /// Own-property lookup, so names like `constructor` never resolve by
    /// accident. A name is the program's own or one it imports; an imported
    /// name means the linked definition when its module is loaded: `def_`.
    fn def_(&self, name: &str) -> Option<&'a Value> {
        if let Some(d) = self.defs.get(name) {
            return Some(d);
        }
        if self.imported.contains(&name) {
            self.all.get(name)
        } else {
            None
        }
    }

    fn def_kind(&self, name: &str) -> Option<DefKind> {
        self.def_(name).and_then(kind_of)
    }

    /// The names of the definitions of `kind` the program sees:
    /// `defsOfKind(kind)`.
    fn defs_of_kind(&self, kind: DefKind) -> Vec<&'a str> {
        let mut names: Vec<&'a str> = self.defs.keys().collect();
        for n in &self.imported {
            if self.all.contains_key(n) {
                insert(&mut names, n);
            }
        }
        names.retain(|n| self.def_kind(n) == Some(kind));
        names
    }

    // ── definitions ────────────────────────────────────────────────────────

    /// `def(name, d, base)`; the TypeScript's `name` is not read.
    fn def(&mut self, value: &'a Value, base: &str) {
        let d = Definition::of(value);
        let top = Ctx::top();
        match d.kind() {
            Some(DefKind::Type) => {
                let generics: Vec<&str> = d.generics().collect();
                if let Some(t) = d.type_expr() {
                    self.type_(t, &format!("{base}/type"), &generics, &top, None);
                }
            }
            Some(DefKind::Capability) => {
                if let Some(v) = d.value_expr() {
                    self.expr(v, &format!("{base}/value"), &top);
                }
            }
            Some(DefKind::Const) => {
                if let Some(t) = d.type_expr() {
                    self.type_(t, &format!("{base}/type"), &[], &top, None);
                }
                if let Some(v) = d.value_expr() {
                    self.expr(v, &format!("{base}/value"), &top);
                }
            }
            Some(DefKind::Fn) => {
                let ctx = self.with_params(d.params(), &format!("{base}/params"), &top);
                self.returns(d.returns(), base, &top);
                self.block(d.body(), &format!("{base}/body"), &ctx);
            }
            Some(DefKind::Extern) => {
                let ctx = self.with_params(d.params(), &format!("{base}/params"), &top);
                self.returns(d.returns(), base, &top);
                if let Some(e) = d.idempotent_by() {
                    self.expr(e, &format!("{base}/idempotent_by"), &ctx);
                }
            }
            Some(DefKind::Effect) => {
                let ctx = self.with_params(d.params(), &format!("{base}/params"), &top);
                self.returns(d.returns(), base, &top);
                for (i, c) in d.requires_caps().iter().enumerate() {
                    if let Some(c) = Expr::of(c) {
                        self.expr(c, &format!("{base}/requires_caps/{i}"), &ctx);
                    }
                }
                // `if (d.compensation)`: an empty name is falsy.
                if let Some(c) = d.compensation().filter(|c| !c.is_empty()) {
                    self.effect_name(c, &format!("{base}/compensation"));
                }
            }
            Some(DefKind::Agent) => {
                if let Some(remote) = d.remote() {
                    if let Some(bind) = remote.bind() {
                        self.expr(bind, &format!("{base}/remote/bind"), &top.symbolic());
                    }
                    for (i, r) in remote.require().iter().enumerate() {
                        if let Some(r) = Expr::of(r) {
                            self.expr(r, &format!("{base}/remote/require/{i}"), &top.symbolic());
                        }
                    }
                }
                self.cap_list(d.caps(), &format!("{base}/caps"), &top);
                for (sn, s) in d.skills() {
                    let Some(s) = Skill::of(s) else { continue };
                    let sb = format!("{base}/skills/{sn}");
                    let ctx = self.with_params(s.params(), &format!("{sb}/params"), &top);
                    self.returns(s.returns(), &sb, &top);
                    if let Some(body) = s.body() {
                        self.block(body, &format!("{sb}/body"), &ctx);
                    }
                }
            }
            Some(DefKind::Workflow) => {
                let ctx = self.with_params(d.params(), &format!("{base}/params"), &top);
                self.returns(d.returns(), base, &top);
                self.cap_list(d.caps(), &format!("{base}/caps"), &top);
                if let Some(caps) = d.envelope().and_then(|e| e.caps()) {
                    self.cap_list(caps, &format!("{base}/envelope/caps"), &top);
                }
                if let Some(e) = d.ensures() {
                    self.expr(
                        e,
                        &format!("{base}/ensures"),
                        &ctx.inner(vec!["result".to_owned()]),
                    );
                }
                self.block(d.body(), &format!("{base}/body"), &ctx);
                for (i, h) in d.on().iter().enumerate() {
                    if let Some(then) = OnHandler::of(h).and_then(OnHandler::then) {
                        self.expr(then, &format!("{base}/on/{i}/then"), &ctx);
                    }
                }
            }
            Some(DefKind::Contract) => {
                let ctx = self.with_params(d.params(), &format!("{base}/params"), &top);
                for (i, r) in d.require().iter().enumerate() {
                    if let Some(r) = Expr::of(r) {
                        self.expr(r, &format!("{base}/require/{i}"), &ctx);
                    }
                }
                for (group, criteria) in [
                    ("accept", d.accept().collect::<Vec<_>>()),
                    ("invariant", d.invariant().collect::<Vec<_>>()),
                ] {
                    for (cn, c) in criteria {
                        if let Some(by) = Criterion::of(c).and_then(Criterion::by) {
                            self.verifier(by, &format!("{base}/{group}/{cn}/by"), &ctx);
                        }
                    }
                }
            }
            Some(DefKind::Component) => {
                for (field, names) in [("provides", d.provides()), ("consumes", d.consumes())] {
                    for (i, n) in names.unwrap_or_default().iter().enumerate() {
                        let Some(n) = n.as_str() else { continue };
                        if self.def_kind(n) != Some(DefKind::Interface) {
                            let candidates = self.defs_of_kind(DefKind::Interface);
                            self.report(
                                &format!("{base}/{field}/{i}"),
                                format!("Unknown interface '{n}'."),
                                n,
                                "interface",
                                candidates,
                                Some(Replace::Name),
                            );
                        }
                    }
                }
            }
            Some(DefKind::Interface | DefKind::Role) | None => {}
            Some(DefKind::Environment) => {
                for (rn, r) in d.reads() {
                    let Some(r) = Read::of(r) else { continue };
                    let rb = format!("{base}/reads/{}", ptr_token(rn));
                    let from = r.from().unwrap_or_default();
                    if self.def_kind(from) != Some(DefKind::Component) {
                        let candidates = self.defs_of_kind(DefKind::Component);
                        self.report(
                            &format!("{rb}/from"),
                            format!("Unknown component '{from}'."),
                            from,
                            "component",
                            candidates,
                            Some(Replace::Name),
                        );
                    }
                    let ctx = self.with_params(r.params(), &format!("{rb}/params"), &top);
                    self.returns(r.returns(), &rb, &top);
                    // A log filter names the row's fields and the read's
                    // parameters, nothing else: `{ names: fields, parent: {
                    // names: ctx.scope.names } }`, a parent with no parent.
                    if let Some(logs) = r.logs() {
                        let fields = r
                            .returns()
                            .map(|t| self.record_fields(t, &[]))
                            .unwrap_or_default();
                        let params = Rc::new(Scope {
                            names: ctx.scope.names.clone(),
                            parent: None,
                        });
                        let scope = Scope::child(fields, &params);
                        self.expr(logs, &format!("{rb}/query/logs"), &ctx.with_scope(scope));
                    }
                }
                for (effect, _) in d.authorize() {
                    let path = format!("{base}/authorize/{}", ptr_token(effect));
                    if std_effect(effect).is_none()
                        && self.def_kind(effect) != Some(DefKind::Effect)
                    {
                        let mut candidates: Vec<&str> =
                            STD_EFFECTS.iter().map(|(n, _)| *n).collect();
                        candidates.extend(self.defs_of_kind(DefKind::Effect));
                        self.report(
                            &path,
                            format!("Unknown effect '{effect}'."),
                            effect,
                            "effect",
                            candidates,
                            Some(Replace::Name),
                        );
                    }
                }
            }
        }
    }

    /// `this.type(d.returns, `${base}/returns`, new Set(), top)`.
    fn returns(&mut self, t: Option<TypeExpr<'a>>, base: &str, top: &Ctx) {
        if let Some(t) = t {
            self.type_(t, &format!("{base}/returns"), &[], top, None);
        }
    }

    /// Field names of a record type, through named types and refinements;
    /// none for anything else: `recordFields(t, seen)`.
    fn record_fields(&self, t: TypeExpr<'a>, seen: &[&'a str]) -> Vec<String> {
        if t.has(TypeForm::Record) {
            return t.record().map(|(f, _)| f.to_owned()).collect();
        }
        if t.has(TypeForm::Refine) {
            return t
                .refine()
                .map(|r| self.record_fields(r, seen))
                .unwrap_or_default();
        }
        if t.has(TypeForm::Ref)
            && let Some(r) = t.ref_name()
            && !seen.contains(&r)
        {
            // `this.def_(t.ref) ?? (Object.hasOwn(this.all, t.ref) ? this.all[t.ref] : undefined)`.
            let d = self.def_(r).or_else(|| self.all.get(r));
            if let Some(d) = d
                && kind_of(d) == Some(DefKind::Type)
                && let Some(inner) = Definition::of(d).type_expr()
            {
                let mut seen = seen.to_vec();
                seen.push(r);
                return self.record_fields(inner, &seen);
            }
        }
        Vec::new()
    }

    fn with_params(&mut self, params: &'a [Value], base: &str, ctx: &Ctx) -> Ctx {
        let mut names: Vec<String> = Vec::new();
        for (i, p) in params.iter().enumerate() {
            let Some(p) = Param::of(p) else { continue };
            let name = p.name();
            if let Some(n) = name
                && !names.iter().any(|x| x == n)
            {
                names.push(n.to_owned());
            }
            if let Some(t) = p.type_expr() {
                self.type_(t, &format!("{base}/{i}/type"), &[], ctx, name);
            }
        }
        ctx.inner(names)
    }

    fn cap_list(&mut self, caps: &'a [Value], base: &str, ctx: &Ctx) {
        for (i, c) in caps.iter().enumerate() {
            let Some(c) = Expr::of(c) else { continue };
            let path = format!("{base}/{i}");
            if c.is(ExprOp::Var) {
                let name = c.name().unwrap_or_default();
                if self.def_kind(name) != Some(DefKind::Capability) {
                    let candidates = self.defs_of_kind(DefKind::Capability);
                    self.report(
                        &path,
                        format!("Unknown capability '{name}'."),
                        name,
                        "capability",
                        candidates,
                        Some(Replace::Var),
                    );
                }
                continue;
            }
            self.expr(c, &path, ctx);
        }
    }

    fn verifier(&mut self, v: Verifier<'a>, path: &str, ctx: &Ctx) {
        if v.has(VerifierForm::All) {
            for (i, x) in v.all().iter().enumerate() {
                if let Some(x) = Verifier::of(x) {
                    self.verifier(x, &format!("{path}/all/{i}"), ctx);
                }
            }
        } else if v.has(VerifierForm::Static) {
            if let Some(e) = v.static_expr() {
                self.expr(e, &format!("{path}/static"), ctx);
            }
        } else if let Some(e) = v.call() {
            self.expr(e, &format!("{path}/call"), ctx);
        }
    }

    // ── types ──────────────────────────────────────────────────────────────

    fn type_(
        &mut self,
        t: TypeExpr<'a>,
        path: &str,
        generics: &[&str],
        ctx: &Ctx,
        binder: Option<&str>,
    ) {
        if t.has(TypeForm::Ref) {
            let r = t.ref_name().unwrap_or_default();
            if !self.is_type(r, generics) {
                let mut candidates: Vec<&str> = self.builtin_types.iter().copied().collect();
                candidates.extend(self.defs_of_kind(DefKind::Type));
                candidates.extend(self.imported.iter().copied());
                candidates.extend(generics.iter().copied());
                self.report(
                    &format!("{path}/ref"),
                    format!("Unknown type '{r}'."),
                    r,
                    "type",
                    candidates,
                    Some(Replace::Name),
                );
            }
            for (i, a) in t.args().unwrap_or_default().iter().enumerate() {
                let Some(a) = TypeExpr::of(a) else { continue };
                let ap = format!("{path}/args/{i}");
                // Verified<T, C>: C names a contract. Evidence<Profile,
                // Subject>: Profile is a check profile. `!a.args`: an empty
                // list is truthy.
                let bare = a.has(TypeForm::Ref) && a.args().is_none();
                if r == "Verified" && i == 1 && bare {
                    let ar = a.ref_name().unwrap_or_default();
                    if self.def_kind(ar) != Some(DefKind::Contract) && !self.imported.contains(&ar)
                    {
                        let candidates = self.defs_of_kind(DefKind::Contract);
                        self.report(
                            &format!("{ap}/ref"),
                            format!("Unknown contract '{ar}' in Verified<…>."),
                            ar,
                            "contract",
                            candidates,
                            Some(Replace::Name),
                        );
                    }
                    continue;
                }
                if r == "Evidence" && i == 0 && bare {
                    continue;
                }
                self.type_(a, &ap, generics, ctx, None);
            }
        } else if t.has(TypeForm::Record) {
            for (f, ft) in t.record() {
                if let Some(ft) = TypeExpr::of(ft) {
                    self.type_(ft, &format!("{path}/record/{f}"), generics, ctx, Some(f));
                }
            }
        } else if t.has(TypeForm::Union) {
            for (i, v) in t.union().iter().enumerate() {
                let Some(v) = Variant::of(v) else { continue };
                for (j, p) in v.fields().iter().enumerate() {
                    let Some(p) = Param::of(p) else { continue };
                    if let Some(pt) = p.type_expr() {
                        let at = format!("{path}/union/{i}/fields/{j}/type");
                        self.type_(pt, &at, generics, ctx, p.name());
                    }
                }
            }
        } else if t.has(TypeForm::Refine) {
            if let Some(inner) = t.refine() {
                self.type_(inner, &format!("{path}/refine"), generics, ctx, binder);
            }
            // `new Set(binder ? [binder] : ["value"])`: an empty binder is falsy.
            let name = binder.filter(|b| !b.is_empty()).unwrap_or("value");
            if let Some(w) = t.where_expr() {
                self.expr(
                    w,
                    &format!("{path}/where"),
                    &ctx.inner(vec![name.to_owned()]),
                );
            }
        }
    }

    fn is_type(&self, name: &str, generics: &[&str]) -> bool {
        if generics.contains(&name)
            || self.builtin_types.contains(&name)
            || self.imported.contains(&name)
        {
            return true;
        }
        if self.def_kind(name) == Some(DefKind::Type) {
            return true;
        }
        // Qualified references into an imported module: company.domain.Issue.
        // `dot > 0`: a `.` at index 0 is at byte 0 too.
        match name.rfind('.') {
            Some(dot) if dot > 0 => self.is_module_path(name.get(..dot).unwrap_or_default()),
            _ => false,
        }
    }

    fn is_module_path(&self, qname: &str) -> bool {
        let first = qname.split('.').next().unwrap_or_default();
        self.imported_modules.contains(&first)
            || self
                .program
                .use_values()
                .iter()
                .filter_map(Import::of)
                .any(|u| u.module() == Some(qname))
    }

    // ── statements and expressions ─────────────────────────────────────────

    fn block(&mut self, body: &'a [Value], base: &str, ctx: &Ctx) {
        let mut scope = Scope::child(Vec::new(), &ctx.scope);
        for (i, s) in body.iter().enumerate() {
            let Some(s) = Stmt::of(s) else { continue };
            let path = format!("{base}/{i}");
            let c = ctx.with_scope(Rc::clone(&scope));
            match s.op() {
                Some(StmtOp::Let) => {
                    if let Some(t) = s.type_expr() {
                        self.type_(t, &format!("{path}/type"), &[], &c, None);
                    }
                    if let Some(v) = s.value() {
                        self.expr(v, &format!("{path}/value"), &c);
                    }
                    let name = s.name().unwrap_or_default().to_owned();
                    scope = Scope::child(vec![name], &scope);
                }
                Some(StmtOp::Par) => {
                    let mut names: Vec<String> = Vec::new();
                    for (n, e) in s.branches() {
                        // Branches cannot see each other's results.
                        if let Some(e) = Expr::of(e) {
                            self.expr(e, &format!("{path}/branches/{n}"), &c);
                        }
                        if !names.iter().any(|x| x == n) {
                            names.push(n.to_owned());
                        }
                    }
                    if let Some(sup) = s.supervise() {
                        self.args(sup.args(), &format!("{path}/supervise/args"), &c.symbolic());
                    }
                    scope = Scope::child(names, &scope);
                }
                Some(StmtOp::If) => {
                    if let Some(cond) = s.cond() {
                        self.expr(cond, &format!("{path}/cond"), &c);
                    }
                    self.block(s.then_block(), &format!("{path}/then"), &c);
                    if let Some(e) = s.else_block() {
                        self.block(e, &format!("{path}/else"), &c);
                    }
                }
                Some(StmtOp::Loop) => {
                    if let Some(u) = s.until() {
                        self.expr(u, &format!("{path}/until"), &c);
                    }
                    self.block(s.body(), &format!("{path}/body"), &c);
                }
                Some(StmtOp::Return) => {
                    if let Some(v) = s.value() {
                        self.expr(v, &format!("{path}/value"), &c);
                    }
                }
                Some(StmtOp::OnError) => {
                    let binds = s.pattern().map(pattern_binds).unwrap_or_default();
                    let inner = ctx.with_scope(Scope::child(binds, &scope));
                    let Some(t) = s.then_expr() else { continue };
                    // A bare supervision strategy (`=> reconcile`, `=> restart(max: 2)`)
                    // is not a value reference.
                    let strategy = if t.is(ExprOp::Var) {
                        Some(t)
                    } else if t.is(ExprOp::Call) {
                        t.callee().filter(|c| c.is(ExprOp::Var))
                    } else {
                        None
                    };
                    let bare = strategy.and_then(Expr::name).is_some_and(|n| {
                        SUPERVISION_STRATEGIES.contains(&n) && !self.lookup(n, &inner.scope)
                    });
                    if bare {
                        if t.is(ExprOp::Call) {
                            self.args(
                                t.arg_values(),
                                &format!("{path}/then/args"),
                                &inner.symbolic(),
                            );
                        }
                    } else {
                        self.expr(t, &format!("{path}/then"), &inner);
                    }
                }
                Some(StmtOp::Run) => {
                    if let Some(t) = s.target() {
                        self.expr(t, &format!("{path}/target"), &c.symbolic());
                    }
                }
                Some(StmtOp::Expr) => {
                    if let Some(v) = s.value() {
                        self.expr(v, &format!("{path}/value"), &c);
                    }
                }
                None => {}
            }
        }
    }

    /// Whether `name` is bound in `scope` or names something the program
    /// sees: `lookup(name, scope)`.
    fn lookup(&self, name: &str, scope: &Rc<Scope>) -> bool {
        let mut s = Some(scope);
        while let Some(at) = s {
            if at.names.iter().any(|n| n == name) {
                return true;
            }
            s = at.parent.as_ref();
        }
        self.defs.contains_key(name)
            || self.imported.contains(&name)
            || BUILTIN_FUNCTIONS.contains(&name)
    }

    /// Every name in sight: `visible(scope)`.
    fn visible<'s>(&self, scope: &'s Rc<Scope>) -> Vec<&'s str>
    where
        'a: 's,
    {
        let mut out: Vec<&'s str> = Vec::new();
        let mut s = Some(scope);
        while let Some(at) = s {
            out.extend(at.names.iter().map(String::as_str));
            s = at.parent.as_ref();
        }
        out.extend(self.defs.keys());
        out.extend(self.imported.iter().copied());
        out.extend(BUILTIN_FUNCTIONS);
        out
    }

    fn args(&mut self, args: &'a [Value], base: &str, ctx: &Ctx) {
        for (i, a) in args.iter().enumerate() {
            if let Some(v) = Arg::of(a).and_then(Arg::value) {
                self.expr(v, &format!("{base}/{i}/value"), ctx);
            }
        }
    }

    /// True when a callee resolves to something this compiler describes:
    /// `isLocalCallee(callee)`.
    fn is_local_callee(&self, callee: Expr<'a>) -> bool {
        if callee.is(ExprOp::Var) {
            let d = self.def_(callee.name().unwrap_or_default());
            // `!!d && d.kind !== "const"`.
            return d.is_some_and(|d| kind_of(d) != Some(DefKind::Const));
        }
        false
    }

    fn effect_name(&mut self, name: &str, path: &str) {
        if let Some(d) = self.defs.get(name) {
            if kind_of(d) != Some(DefKind::Effect) {
                let candidates = self.defs_of_kind(DefKind::Effect);
                self.report(
                    path,
                    format!("'{name}' is not an effect."),
                    name,
                    "effect",
                    candidates,
                    None,
                );
            }
            return;
        }
        let dot = name.rfind('.');
        if let Some(dot) = dot
            && dot > 0
            && self.is_module_path(name.get(..dot).unwrap_or_default())
        {
            return;
        }
        // A std effect without a module (deploy, migrate) is a name of the
        // language; its capability is still required.
        if dot.is_none() && std_effect(name).is_some() {
            return;
        }
        let candidates = self.defs_of_kind(DefKind::Effect);
        self.report(
            path,
            format!("Unknown effect '{name}'."),
            name,
            "effect",
            candidates,
            Some(Replace::Name),
        );
    }

    fn sub(&mut self, e: Option<Expr<'a>>, path: &str, member: &str, ctx: &Ctx) {
        if let Some(e) = e {
            self.expr(e, &format!("{path}/{member}"), ctx);
        }
    }

    fn expr(&mut self, e: Expr<'a>, path: &str, ctx: &Ctx) {
        let Some(op) = e.op() else { return };
        match op {
            ExprOp::Int
            | ExprOp::Dec
            | ExprOp::Text
            | ExprOp::Bool
            | ExprOp::Money
            | ExprOp::Duration => {}
            ExprOp::List | ExprOp::Set => {
                for (i, x) in e.item_values().iter().enumerate() {
                    if let Some(x) = Expr::of(x) {
                        self.expr(x, &format!("{path}/items/{i}"), ctx);
                    }
                }
            }
            ExprOp::Template | ExprOp::Prompt => {
                for (i, p) in e.parts().iter().enumerate() {
                    // `"expr" in p`.
                    if p.get(TemplatePart::Expr.as_str()).is_some()
                        && let Some(x) = p.get("expr").and_then(Expr::of)
                    {
                        self.expr(x, &format!("{path}/parts/{i}/expr"), ctx);
                    }
                }
            }
            ExprOp::Var => {
                let name = e.name().unwrap_or_default();
                if !self.lookup(name, &ctx.scope) && !ctx.symbolic {
                    let candidates = self.visible(&ctx.scope);
                    self.report(
                        path,
                        format!("Unknown name '{name}'."),
                        name,
                        "value",
                        candidates,
                        Some(Replace::Var),
                    );
                }
            }
            ExprOp::Field | ExprOp::Unary | ExprOp::Try | ExprOp::Await => {
                self.sub(e.operand(), path, "of", ctx);
            }
            ExprOp::Call => {
                let callee = e.callee();
                self.sub(callee, path, "callee", ctx);
                let symbolic = ctx.symbolic || !callee.is_some_and(|c| self.is_local_callee(c));
                let inner = Ctx {
                    scope: Rc::clone(&ctx.scope),
                    symbolic,
                };
                self.args(e.arg_values(), &format!("{path}/args"), &inner);
            }
            ExprOp::Binary => {
                self.sub(e.left(), path, "left", ctx);
                self.sub(e.right(), path, "right", ctx);
            }
            ExprOp::Range => {
                self.sub(e.from(), path, "from", ctx);
                self.sub(e.to(), path, "to", ctx);
            }
            ExprOp::Record => {
                let t = e.record_type().unwrap_or_default();
                if !self.is_type(t, &[]) {
                    let mut candidates = self.defs_of_kind(DefKind::Type);
                    candidates.extend(self.imported.iter().copied());
                    self.report(
                        &format!("{path}/type"),
                        format!("Unknown type '{t}'."),
                        t,
                        "type",
                        candidates,
                        Some(Replace::Name),
                    );
                }
                for (f, v) in e.fields() {
                    if let Some(v) = Expr::of(v) {
                        self.expr(v, &format!("{path}/fields/{f}"), ctx);
                    }
                }
            }
            ExprOp::Infer => {
                if let Some(t) = e.type_expr() {
                    self.type_(t, &format!("{path}/type"), &[], ctx, None);
                }
                self.sub(e.from(), path, "from", ctx);
                self.sub(e.using(), path, "using", ctx);
            }
            ExprOp::Delegate | ExprOp::Spawn | ExprOp::Plan => {
                let agent_name = e.agent().unwrap_or_default();
                let agent = self
                    .def_(agent_name)
                    .filter(|d| kind_of(d) == Some(DefKind::Agent));
                match agent {
                    None => {
                        let candidates = self.defs_of_kind(DefKind::Agent);
                        self.report(
                            &format!("{path}/agent"),
                            format!("Unknown agent '{agent_name}'."),
                            agent_name,
                            "agent",
                            candidates,
                            Some(Replace::Name),
                        );
                    }
                    Some(agent) => {
                        let skill = e.skill().unwrap_or_default();
                        let agent = Definition::of(agent);
                        if agent.skill(skill).is_none() {
                            let candidates: Vec<&str> = agent.skills().map(|(n, _)| n).collect();
                            self.report(
                                &format!("{path}/skill"),
                                format!("Agent '{agent_name}' has no skill '{skill}'."),
                                skill,
                                "skill",
                                candidates,
                                Some(Replace::Name),
                            );
                        }
                    }
                }
                self.args(e.arg_values(), &format!("{path}/args"), ctx);
                if op == ExprOp::Delegate {
                    if let Some(caps) = e.caps() {
                        self.cap_list_exprs(caps, &format!("{path}/caps"), ctx);
                    }
                    self.sub(e.timeout(), path, "timeout", ctx);
                    if let Some(sup) = e.supervise() {
                        self.supervise(sup, path, ctx);
                    }
                }
            }
            ExprOp::Verify => {
                self.sub(e.value_expr(), path, "value", ctx);
                let contract = e.contract().unwrap_or_default();
                if self.def_kind(contract) != Some(DefKind::Contract) {
                    let candidates = self.defs_of_kind(DefKind::Contract);
                    self.report(
                        &format!("{path}/contract"),
                        format!("Unknown contract '{contract}'."),
                        contract,
                        "contract",
                        candidates,
                        Some(Replace::Name),
                    );
                }
                self.args(e.arg_values(), &format!("{path}/args"), ctx);
                if let Some(on) = e.on_unmet() {
                    let bind = on.bind().unwrap_or_default().to_owned();
                    self.sub(
                        on.then(),
                        &format!("{path}/on_unmet"),
                        "then",
                        &ctx.inner(vec![bind]),
                    );
                }
            }
            ExprOp::Effect => {
                let name = e.name().unwrap_or_default();
                self.effect_name(name, &format!("{path}/name"));
                self.args(e.arg_values(), &format!("{path}/args"), ctx);
                self.sub(e.idempotent_by(), path, "idempotent_by", ctx);
                // `if (e.compensate)`: an empty name is falsy.
                if let Some(c) = e.compensate().filter(|c| !c.is_empty()) {
                    self.effect_name(c, &format!("{path}/compensate"));
                }
            }
            ExprOp::Changeset => {
                self.sub(e.plan(), path, "plan", ctx);
                for (m, mem) in e.changeset_members() {
                    let mp = format!("{path}/members/{}", ptr_token(m));
                    if self.def_kind(m) != Some(DefKind::Component) {
                        let candidates = self.defs_of_kind(DefKind::Component);
                        self.report(
                            &mp,
                            format!("Unknown component '{m}'."),
                            m,
                            "component",
                            candidates,
                            None,
                        );
                    }
                    let effect = mem.effect().unwrap_or_default();
                    if std_effect(effect).is_none() {
                        self.effect_name(effect, &format!("{mp}/effect"));
                    }
                    self.args(mem.arg_values(), &format!("{mp}/args"), ctx);
                }
                for (i, _) in e.changes() {
                    if self.def_kind(i) != Some(DefKind::Interface) {
                        let candidates = self.defs_of_kind(DefKind::Interface);
                        self.report(
                            &format!("{path}/changes/{}", ptr_token(i)),
                            format!("Unknown interface '{i}'."),
                            i,
                            "interface",
                            candidates,
                            None,
                        );
                    }
                }
                self.sub(e.idempotent_by(), path, "idempotent_by", ctx);
            }
            ExprOp::Map => {
                self.sub(e.over(), path, "over", ctx);
                // The element is in scope in the capabilities the map hands
                // its body and in the body.
                let inner = ctx.inner(vec![e.bind().unwrap_or_default().to_owned()]);
                if let Some(caps) = e.caps() {
                    self.cap_list_exprs(caps, &format!("{path}/caps"), &inner);
                }
                if let Some(sup) = e.supervise() {
                    self.supervise(sup, path, ctx);
                }
                self.block(e.body(), &format!("{path}/body"), &inner);
            }
            ExprOp::Escalate => self.sub(e.to(), path, "to", ctx),
            ExprOp::Pause => self.sub(e.then(), path, "then", ctx),
            ExprOp::Switch => {
                self.sub(e.on(), path, "on", ctx);
                for (i, c) in e.cases().enumerate() {
                    let binds = c.pattern().map(pattern_binds).unwrap_or_default();
                    self.sub(
                        c.then(),
                        &format!("{path}/cases/{i}"),
                        "then",
                        &ctx.inner(binds),
                    );
                }
            }
            ExprOp::Block => self.block(e.body(), &format!("{path}/body"), ctx),
        }
    }

    /// `this.args(e.supervise.args ?? [], `${path}/supervise/args`, { ...ctx, symbolic: true })`.
    fn supervise(&mut self, sup: CallSpec<'a>, path: &str, ctx: &Ctx) {
        self.args(
            sup.args(),
            &format!("{path}/supervise/args"),
            &ctx.symbolic(),
        );
    }

    /// `with caps K`: names must be capabilities; narrowing calls are
    /// checked as expressions: `capListExprs`.
    fn cap_list_exprs(&mut self, caps: &'a [Value], base: &str, ctx: &Ctx) {
        for (i, c) in caps.iter().enumerate() {
            let Some(c) = Expr::of(c) else { continue };
            let path = format!("{base}/{i}");
            if let Some((name, at)) = root_var(c)
                && !self.lookup(name, &ctx.scope)
            {
                let candidates = self.defs_of_kind(DefKind::Capability);
                self.report(
                    &format!("{path}{at}"),
                    format!("Unknown capability '{name}'."),
                    name,
                    "capability",
                    candidates,
                    Some(Replace::Var),
                );
                continue;
            }
            if !c.is(ExprOp::Var) {
                self.expr(c, &path, ctx);
            }
        }
    }
}

/// The variable at the root of a chain of fields and calls, and its path
/// below the expression: `rootVar(e)`.
fn root_var(e: Expr<'_>) -> Option<(&str, String)> {
    let mut path = String::new();
    let mut cur = e;
    loop {
        match cur.op() {
            Some(ExprOp::Var) => return cur.name().map(|n| (n, path)),
            Some(ExprOp::Field) => {
                path.push_str("/of");
                cur = cur.operand()?;
            }
            Some(ExprOp::Call) => {
                path.push_str("/callee");
                cur = cur.callee()?;
            }
            _ => return None,
        }
    }
}

/// The names a pattern binds, in the order found: `patternBinds(p)`.
fn pattern_binds(p: Pattern<'_>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    walk_pattern(p, &mut out);
    out
}

fn walk_pattern(q: Pattern<'_>, out: &mut Vec<String>) {
    match q.kind() {
        Some(PatternKind::Bind) => {
            if let Some(n) = q.name()
                && !out.iter().any(|x| x == n)
            {
                out.push(n.to_owned());
            }
        }
        Some(PatternKind::Tag) => {
            for a in q.args().iter().filter_map(Pattern::of) {
                walk_pattern(a, out);
            }
        }
        _ => {}
    }
}

/// The single closest candidate within edit distance 2, if unambiguous:
/// `closest(name, candidates)`.
///
/// The TypeScript visits `new Set(candidates)` in order and keeps the first
/// that is nearer than every one before it, noting a tie when one is as near
/// as the best so far. So the answer is the one candidate at the least
/// distance below 3 when exactly one is there, and none otherwise: it does
/// not depend on the order of the candidates. A candidate equal to `name`
/// is passed over. Distances count UTF-16 code units, as `a.length` and
/// `a[i]` do.
#[must_use]
pub fn closest<S: AsRef<str>>(
    name: &str,
    candidates: impl IntoIterator<Item = S>,
) -> Option<String> {
    let mut seen: Vec<String> = Vec::new();
    let mut best: Option<String> = None;
    let mut best_d: usize = 3;
    let mut tie = false;
    let name16: Vec<u16> = name.encode_utf16().collect();
    for c in candidates {
        let c = c.as_ref();
        if seen.iter().any(|s| s == c) {
            continue;
        }
        seen.push(c.to_owned());
        if c == name {
            continue;
        }
        let d = edit_distance(&name16, &c.encode_utf16().collect::<Vec<u16>>());
        if d < best_d {
            best = Some(c.to_owned());
            best_d = d;
            tie = false;
        } else if d == best_d {
            tie = true;
        }
    }
    if tie { None } else { best }
}

/// The Levenshtein distance of two strings of UTF-16 code units:
/// `editDistance(a, b)`, row by row.
fn edit_distance(a: &[u16], b: &[u16]) -> usize {
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur: Vec<usize> = Vec::with_capacity(prev.len());
        cur.push(i.saturating_add(1));
        for (j, cb) in b.iter().enumerate() {
            let above = prev.get(j.saturating_add(1)).copied().unwrap_or(usize::MAX);
            let left = cur.get(j).copied().unwrap_or(usize::MAX);
            let diagonal = prev.get(j).copied().unwrap_or(usize::MAX);
            let d = above
                .saturating_add(1)
                .min(left.saturating_add(1))
                .min(diagonal.saturating_add(usize::from(ca != cb)));
            cur.push(d);
        }
        prev = cur;
    }
    prev.last().copied().unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{closest, edit_distance};

    fn d(a: &str, b: &str) -> usize {
        edit_distance(
            &a.encode_utf16().collect::<Vec<_>>(),
            &b.encode_utf16().collect::<Vec<_>>(),
        )
    }

    #[test]
    fn edit_distances() {
        assert_eq!(d("", ""), 0);
        assert_eq!(d("abc", ""), 3);
        assert_eq!(d("", "ab"), 2);
        assert_eq!(d("kitten", "sitting"), 3);
        assert_eq!(d("flaw", "lawn"), 2);
        // UTF-16 code units: an emoji is two.
        assert_eq!(d("\u{1F600}", "a"), 2);
    }

    /// Each with what `closest` of compiler/dist/resolve/resolve.js gives on
    /// the same input (null as None).
    #[test]
    fn closest_is_the_typescript_closest() {
        let cases: [(&str, &[&str], Option<&str>); 16] = [
            ("Isue", &["Issue", "Tissue", "Int"], Some("Issue")),
            ("Isue", &["Issue", "Isle"], None),
            ("Isue", &["Isle", "Issue"], None),
            ("foo", &["foo", "fob"], Some("fob")),
            ("foo", &["fob", "fob"], Some("fob")),
            ("foo", &["fab", "fob", "f"], Some("fob")),
            ("abc", &["xyz", "abcdef"], None),
            ("a", &[], None),
            ("\u{1F600}x", &["\u{1F601}x", "zz"], Some("\u{1F601}x")),
            // Two code units from "a" and from "ab": a tie, where code
            // points would give "a".
            ("\u{1F600}", &["a", "ab"], None),
            ("h\u{e9}llo", &["hello", "hallo"], None),
            ("kitten", &["sitting", "kitchen"], Some("kitchen")),
            ("reviewer", &["reviewers", "review", "reviewed"], None),
            ("code_owner", &["code_owners", "owner"], Some("code_owners")),
            ("", &["a", "bb"], Some("a")),
            ("", &["a"], Some("a")),
        ];
        for (name, candidates, want) in cases {
            assert_eq!(
                closest(name, candidates),
                want.map(str::to_owned),
                "{name} {candidates:?}"
            );
        }
    }
}
