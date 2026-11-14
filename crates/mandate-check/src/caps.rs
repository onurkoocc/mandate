//! Static capability values (Doc 4 §7): what a capability authorizes and
//! over which scope, how narrowing works (C3), and whether write scopes
//! overlap (C5). A port of `compiler/src/check/caps.ts`.
//!
//! A capability over a component (design doc 9 §2.2) is written with the
//! component's name and opens into the same values as the paths, commands
//! and repositories it stands for, so every check and every sandbox treats
//! it exactly like one written out:
//!
//! ```text
//! component.read(c…)             fs.read(c.root…)
//! component.write(c, p…)         fs.write(c.root/p…), or c.root without paths
//! component.exec(c, build|test)  exec(command, args_prefix) per declared command
//! component.repo(c…)             git.pr(c.repo…)
//! ```
//!
//! Expressions are read through the views of `mandate-ir` ([`Expr`],
//! [`Arg`]); a member that is missing or of another type reads as nothing,
//! so these functions never panic, but they give the TypeScript's answer
//! only on IR the TypeScript would read without throwing (validated IR).

use std::collections::{BTreeMap, HashMap};

use mandate_ir::{
    Arg, ComponentDef, Diagnostic, EnvironmentDef, Expr, ExprOp, JsObject, JsValue, Language,
    Location, Map, Program, Value, compare_utf16, ptr, sort_utf16, unique_in_order,
    write_json_string,
};

use crate::posix;
use crate::stdlib::{DEFAULT_MODEL_MAX_CLASS, DataClass, ScopeKind, cap_ctor, class_rank};

/// A table of definitions (or of modules) by name, as the TypeScript's
/// `Record<string, Def>` and `Record<string, Program>` are read here: only
/// own entries, `Object.hasOwn(table, name) ? table[name] : undefined`.
pub trait Table {
    /// The entry `name`, if there is one.
    fn entry(&self, name: &str) -> Option<&Value>;
}

impl Table for Map {
    fn entry(&self, name: &str) -> Option<&Value> {
        self.get(name)
    }
}

impl Table for HashMap<String, Value> {
    fn entry(&self, name: &str) -> Option<&Value> {
        self.get(name)
    }
}

impl Table for HashMap<&str, &Value> {
    fn entry(&self, name: &str) -> Option<&Value> {
        self.get(name).copied()
    }
}

impl Table for BTreeMap<String, Value> {
    fn entry(&self, name: &str) -> Option<&Value> {
        self.get(name)
    }
}

impl Table for BTreeMap<&str, &Value> {
    fn entry(&self, name: &str) -> Option<&Value> {
        self.get(name).copied()
    }
}

impl<T: Table + ?Sized> Table for &T {
    fn entry(&self, name: &str) -> Option<&Value> {
        (**self).entry(name)
    }
}

/// A member of a [`CapVal`], by the name the TypeScript object gives it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CapMember {
    /// `name`.
    Name,
    /// `via`.
    Via,
    /// `components`.
    Components,
    /// `root`.
    Root,
    /// `ctor`.
    Ctor,
    /// `effect`.
    Effect,
    /// `write`.
    Write,
    /// `scope`.
    Scope,
    /// `maxClass`.
    MaxClass,
    /// `tier`.
    Tier,
    /// `argsPrefix`.
    ArgsPrefix,
    /// `methods`.
    Methods,
}

impl CapMember {
    /// The member's name in the TypeScript object.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            CapMember::Name => "name",
            CapMember::Via => "via",
            CapMember::Components => "components",
            CapMember::Root => "root",
            CapMember::Ctor => "ctor",
            CapMember::Effect => "effect",
            CapMember::Write => "write",
            CapMember::Scope => "scope",
            CapMember::MaxClass => "maxClass",
            CapMember::Tier => "tier",
            CapMember::ArgsPrefix => "argsPrefix",
            CapMember::Methods => "methods",
        }
    }
}

/// A static capability value: `CapVal`.
///
/// The TypeScript builds these as object literals and copies them with
/// spreads, so the order of their members depends on how each was made,
/// and it is kept here ([`CapVal::members`], [`CapVal::to_js`]): the
/// setters behave as assignment to an object does, a member already there
/// keeping its place and a new one coming last, and a member set to `None`
/// is taken out, as a rest pattern (`const { scope, ...rest } = c`) does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CapVal {
    ctor: String,
    effect: String,
    write: bool,
    name: Option<String>,
    via: Option<String>,
    components: Option<Vec<String>>,
    root: Option<String>,
    scope: Option<Vec<String>>,
    max_class: Option<DataClass>,
    tier: Option<String>,
    args_prefix: Option<Vec<Vec<String>>>,
    methods: Option<Vec<String>>,
    order: Vec<CapMember>,
}

impl CapVal {
    /// `{ ctor, effect, write }`.
    #[must_use]
    pub fn new(ctor: impl Into<String>, effect: impl Into<String>, write: bool) -> CapVal {
        CapVal {
            ctor: ctor.into(),
            effect: effect.into(),
            write,
            name: None,
            via: None,
            components: None,
            root: None,
            scope: None,
            max_class: None,
            tier: None,
            args_prefix: None,
            methods: None,
            order: vec![CapMember::Ctor, CapMember::Effect, CapMember::Write],
        }
    }

    /// The constructor, e.g. `fs.write`.
    #[must_use]
    pub fn ctor(&self) -> &str {
        &self.ctor
    }

    /// The authorized effect: `Fs.Write`, `Model`, or a namespace such as
    /// `git.*`.
    #[must_use]
    pub fn effect(&self) -> &str {
        &self.effect
    }

    /// Whether it changes shared state.
    #[must_use]
    pub fn write(&self) -> bool {
        self.write
    }

    /// The capability's name when it comes from a `capability` definition.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    /// For a capability over components: what it was written as, e.g.
    /// `component.read(mcp)`.
    #[must_use]
    pub fn via(&self) -> Option<&str> {
        self.via.as_deref()
    }

    /// For a capability over components: their names.
    #[must_use]
    pub fn components(&self) -> Option<&[String]> {
        self.components.as_deref()
    }

    /// For `component.exec`: the component's root, where its commands run.
    #[must_use]
    pub fn root(&self) -> Option<&str> {
        self.root.as_deref()
    }

    /// Paths, hosts, commands or repositories; `None` means not statically
    /// known (treated as unbounded).
    #[must_use]
    pub fn scope(&self) -> Option<&[String]> {
        self.scope.as_deref()
    }

    /// For `model.infer`: the highest data class it may receive.
    #[must_use]
    pub fn max_class(&self) -> Option<DataClass> {
        self.max_class
    }

    /// For `model.infer`: the model tier, e.g. `standard`.
    #[must_use]
    pub fn tier(&self) -> Option<&str> {
        self.tier.as_deref()
    }

    /// For `exec`: the argument prefixes a command may start with.
    #[must_use]
    pub fn args_prefix(&self) -> Option<&[Vec<String>]> {
        self.args_prefix.as_deref()
    }

    /// For `net.https` from 0.5: the HTTP methods it allows, sorted, without
    /// duplicates; `None` means any method. Before 0.5 `methods` is not
    /// read, and a capability that writes it allows any method.
    #[must_use]
    pub fn methods(&self) -> Option<&[String]> {
        self.methods.as_deref()
    }

    /// The members it has, in the order the TypeScript object has them.
    #[must_use]
    pub fn members(&self) -> &[CapMember] {
        &self.order
    }

    fn place(&mut self, member: CapMember, present: bool) {
        if !present {
            self.order.retain(|m| *m != member);
        } else if !self.order.contains(&member) {
            self.order.push(member);
        }
    }

    /// Sets `name`, as `{ ...c, name }` does.
    pub fn set_name(&mut self, name: Option<String>) {
        self.place(CapMember::Name, name.is_some());
        self.name = name;
    }

    /// Sets `via`.
    pub fn set_via(&mut self, via: Option<String>) {
        self.place(CapMember::Via, via.is_some());
        self.via = via;
    }

    /// Sets `components`.
    pub fn set_components(&mut self, components: Option<Vec<String>>) {
        self.place(CapMember::Components, components.is_some());
        self.components = components;
    }

    /// Sets `root`.
    pub fn set_root(&mut self, root: Option<String>) {
        self.place(CapMember::Root, root.is_some());
        self.root = root;
    }

    /// Sets `scope`, as `{ ...c, scope }` does; `None` takes it out, as
    /// `const { scope, ...rest } = c` does.
    pub fn set_scope(&mut self, scope: Option<Vec<String>>) {
        self.place(CapMember::Scope, scope.is_some());
        self.scope = scope;
    }

    /// Sets `maxClass`.
    pub fn set_max_class(&mut self, max_class: Option<DataClass>) {
        self.place(CapMember::MaxClass, max_class.is_some());
        self.max_class = max_class;
    }

    /// Sets `tier`.
    pub fn set_tier(&mut self, tier: Option<String>) {
        self.place(CapMember::Tier, tier.is_some());
        self.tier = tier;
    }

    /// Sets `argsPrefix`.
    pub fn set_args_prefix(&mut self, args_prefix: Option<Vec<Vec<String>>>) {
        self.place(CapMember::ArgsPrefix, args_prefix.is_some());
        self.args_prefix = args_prefix;
    }

    /// Sets `methods`.
    pub fn set_methods(&mut self, methods: Option<Vec<String>>) {
        self.place(CapMember::Methods, methods.is_some());
        self.methods = methods;
    }

    /// The object the TypeScript has, members in its order.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        fn strings(xs: &[String]) -> JsValue {
            JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect())
        }
        let mut out = JsObject::new();
        for member in &self.order {
            let value = match member {
                CapMember::Name => self.name.as_deref().map(JsValue::from),
                CapMember::Via => self.via.as_deref().map(JsValue::from),
                CapMember::Components => self.components.as_deref().map(strings),
                CapMember::Root => self.root.as_deref().map(JsValue::from),
                CapMember::Ctor => Some(JsValue::from(self.ctor.as_str())),
                CapMember::Effect => Some(JsValue::from(self.effect.as_str())),
                CapMember::Write => Some(JsValue::from(self.write)),
                CapMember::Scope => self.scope.as_deref().map(strings),
                CapMember::MaxClass => self.max_class.map(|c| JsValue::from(c.as_str())),
                CapMember::Tier => self.tier.as_deref().map(JsValue::from),
                CapMember::ArgsPrefix => self
                    .args_prefix
                    .as_deref()
                    .map(|ps| JsValue::Array(ps.iter().map(|p| strings(p)).collect())),
                CapMember::Methods => self.methods.as_deref().map(strings),
            };
            out.insert(member.as_str(), value);
        }
        out
    }
}

/// The methods `net.https(methods: […])` may name, from 0.5
/// (spec/boundary.md): `HTTP_METHODS`.
pub const HTTP_METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// Whether a capability read in `language` reads `methods`: from 0.5.
/// `readsMethods`.
#[must_use]
pub fn reads_methods(language: Option<Language>) -> bool {
    language.is_some_and(|l| l.at_least(Language::V0_5))
}

/// What is wrong with a `methods:` value or one of its items:
/// `MethodProblem["problem"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MethodProblemKind {
    /// `not_a_list`.
    NotAList,
    /// `empty`.
    Empty,
    /// `not_a_name`.
    NotAName,
    /// `unknown`.
    Unknown,
}

impl MethodProblemKind {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            MethodProblemKind::NotAList => "not_a_list",
            MethodProblemKind::Empty => "empty",
            MethodProblemKind::NotAName => "not_a_name",
            MethodProblemKind::Unknown => "unknown",
        }
    }
}

/// One problem with a `methods:` argument (E1801): `MethodProblem`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct MethodProblem {
    /// JSON Pointer below the argument's value: `""` for the value itself,
    /// `/items/<i>` for an item.
    pub at: String,
    /// The name written, or `None` (`null`) where no bare name is written.
    pub found: Option<String>,
    /// What is wrong.
    pub problem: MethodProblemKind,
}

impl MethodProblem {
    /// The object the TypeScript gives: `{ at, found, problem }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("at", self.at.as_str())
            .with(
                "found",
                self.found.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("problem", self.problem.as_str())
    }
}

/// What `readMethods` gives: the methods named and the problems.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Methods {
    /// The methods it names that are known, sorted, without duplicates.
    pub methods: Vec<String>,
    /// What is wrong with the value, in order.
    pub problems: Vec<MethodProblem>,
}

/// The methods a `methods:` value names, and what is wrong with it: it is a
/// non-empty list of bare names from [`HTTP_METHODS`]. Only names it knows
/// are in `methods`; a value with a problem does not check (E1801).
/// `readMethods`.
#[must_use]
pub fn read_methods(v: Expr<'_>) -> Methods {
    let problem = |at: String, found: Option<&str>, problem: MethodProblemKind| MethodProblem {
        at,
        found: found.map(str::to_owned),
        problem,
    };
    if !v.is(ExprOp::List) {
        return Methods {
            methods: Vec::new(),
            problems: vec![problem(String::new(), None, MethodProblemKind::NotAList)],
        };
    }
    let items = v.item_values();
    if items.is_empty() {
        return Methods {
            methods: Vec::new(),
            problems: vec![problem(String::new(), None, MethodProblemKind::Empty)],
        };
    }
    let mut methods: Vec<String> = Vec::new();
    let mut problems = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let item = Expr::of(item);
        let at = format!("/items/{i}");
        match item.filter(|e| e.is(ExprOp::Var)) {
            None => {
                let found = item.filter(|e| e.is(ExprOp::Text)).and_then(Expr::text);
                problems.push(problem(at, found, MethodProblemKind::NotAName));
            }
            Some(var) => {
                let name = var.name().unwrap_or_default();
                if !HTTP_METHODS.contains(&name) {
                    problems.push(problem(at, Some(name), MethodProblemKind::Unknown));
                } else if !methods.iter().any(|m| m == name) {
                    methods.push(name.to_owned());
                }
            }
        }
    }
    sort_utf16(&mut methods);
    Methods { methods, problems }
}

/// How a capability expression is read: `CapOptions`. What it means can
/// depend on the language of the program it is read in, as a definition
/// imported from a module is read in the program that imports it. Without
/// a language it is read as in 0.1 to 0.4.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct CapOptions {
    /// The language of the program the capability is read in.
    pub language: Option<Language>,
}

/// Dotted path of a callee such as `fs.read` or `git.pr`, if it is one:
/// `calleePath`.
#[must_use]
pub fn callee_path(e: Expr<'_>) -> Option<String> {
    let mut fields: Vec<&str> = Vec::new();
    let mut at = e;
    let base = loop {
        match at.op() {
            Some(ExprOp::Var) => break at.name()?,
            Some(ExprOp::Field) => {
                fields.push(at.name()?);
                at = at.operand()?;
            }
            _ => return None,
        }
    };
    let mut path = base.to_owned();
    for name in fields.iter().rev() {
        path.push('.');
        path.push_str(name);
    }
    Some(path)
}

/// `literalStrings`: the text of a `text`, or of every `text` in a list
/// (and in its lists, flattened); `None` when anything else is in it.
fn literal_strings(e: Expr<'_>) -> Option<Vec<String>> {
    match e.op() {
        Some(ExprOp::Text) => Some(vec![e.text()?.to_owned()]),
        Some(ExprOp::List) => {
            let mut out = Vec::new();
            for item in e.item_values() {
                out.extend(literal_strings(Expr::of(item)?)?);
            }
            Some(out)
        }
        _ => None,
    }
}

/// `symbol`: the name of a `var` or the text of a `text`.
fn symbol(e: Expr<'_>) -> Option<&str> {
    match e.op() {
        Some(ExprOp::Var) => e.name(),
        Some(ExprOp::Text) => e.text(),
        _ => None,
    }
}

/// The first argument named `name`: `e.args.find((a) => a.name === n)`.
fn named<'a>(e: Expr<'a>, name: &str) -> Option<Arg<'a>> {
    e.args().find(|a| a.name() == Some(name))
}

/// Evaluates a capability constructor call such as
/// `fs.write("/work/repo/src")`; `None` when the expression is not a
/// call of a constructor of [`crate::stdlib::CAP_CTORS`]: `capFromCall`.
#[must_use]
pub fn cap_from_call(e: Expr<'_>, opts: CapOptions) -> Option<CapVal> {
    if !e.is(ExprOp::Call) {
        return None;
    }
    let ctor = callee_path(e.callee()?).filter(|c| !c.is_empty())?;
    let spec = cap_ctor(&ctor)?;
    let mut cap = CapVal::new(ctor, spec.effect, spec.write);
    match spec.scope {
        ScopeKind::Positional => {
            let pos: Vec<Arg<'_>> = e.args().filter(|a| a.name().is_none()).collect();
            let vals: Option<Vec<Vec<String>>> = pos
                .iter()
                .map(|a| a.value().and_then(literal_strings))
                .collect();
            if !pos.is_empty()
                && let Some(vals) = vals
            {
                cap.set_scope(Some(vals.concat()));
            }
        }
        ScopeKind::Hosts => {
            let v = named(e, "hosts")
                .and_then(Arg::value)
                .and_then(literal_strings);
            if v.is_some() {
                cap.set_scope(v);
            }
            // From 0.5 a capability may allow only some methods. Before,
            // `methods` is written and means nothing.
            if reads_methods(opts.language)
                && let Some(m) = named(e, "methods")
            {
                let methods = m.value().map(read_methods).unwrap_or_default().methods;
                cap.set_methods(Some(methods));
            }
        }
        ScopeKind::Commands => {
            let v = named(e, "commands")
                .and_then(Arg::value)
                .and_then(literal_strings);
            if v.is_some() {
                cap.set_scope(v);
            }
            if let Some(p) = named(e, "args_prefix").and_then(Arg::value)
                && p.is(ExprOp::List)
            {
                let prefixes: Option<Vec<Vec<String>>> = p
                    .item_values()
                    .iter()
                    .map(|i| {
                        Expr::of(i)
                            .filter(|i| i.is(ExprOp::List))
                            .and_then(literal_strings)
                    })
                    .collect();
                if prefixes.is_some() {
                    cap.set_args_prefix(prefixes);
                }
            }
        }
        ScopeKind::None => {}
    }
    if cap.ctor == "model.infer" {
        let s = named(e, "max_class").and_then(Arg::value).and_then(symbol);
        let class = s.and_then(DataClass::from_name);
        cap.set_max_class(Some(class.unwrap_or(DEFAULT_MODEL_MAX_CLASS)));
        let tier = named(e, "tier").and_then(Arg::value).and_then(symbol);
        if let Some(tier) = tier.filter(|t| !t.is_empty()) {
            cap.set_tier(Some(tier.to_owned()));
        }
    }
    Some(cap)
}

/// Whether `v` holds a `net.https` call that writes `methods`, anywhere.
fn holds(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().any(holds),
        Value::Object(map) => {
            if let Some(e) = Expr::of(v)
                && e.is(ExprOp::Call)
                && e.callee().and_then(callee_path).as_deref() == Some("net.https")
                && e.args().any(|a| a.name() == Some("methods"))
            {
                return true;
            }
            map.iter().any(|(_, x)| holds(x))
        }
        _ => false,
    }
}

/// E1804: a program of 0.1 to 0.4 reads every capability in its own
/// language, so a `net.https` written with `methods` in a module of 0.5 or
/// later, which it reaches through an import, would allow any method there.
/// Each imported definition that holds such a call is refused, at the
/// import that brings it in. What the program writes itself, and what a
/// module below 0.5 writes, are read as they always were and not looked at.
/// `importedMethods(program, linked, modules)`.
///
/// `defs` and `origin` are the linked program's (`link` in
/// `compiler/src/modules.ts`): every definition visible to the checks, and
/// for each imported one the module it comes from, in any order (they are
/// sorted here). `modules` are the loaded modules by name. The diagnostics
/// have a `path` and no span; `check` adds the span of that path.
#[must_use]
pub fn imported_methods<K: AsRef<str>, M: AsRef<str>>(
    program: Program<'_>,
    defs: &impl Table,
    origin: impl IntoIterator<Item = (K, M)>,
    modules: &impl Table,
) -> Vec<Diagnostic> {
    if reads_methods(program.language()) {
        return Vec::new();
    }
    let language = program
        .members()
        .get("language")
        .map_or(JsValue::Undefined, JsValue::from);
    let mut origin: Vec<(K, M)> = origin.into_iter().collect();
    origin.sort_by(|(a, _), (b, _)| compare_utf16(a.as_ref(), b.as_ref()));
    let mut out = Vec::new();
    for (name, module) in &origin {
        let (name, module) = (name.as_ref(), module.as_ref());
        let Some(m) = modules.entry(module) else {
            continue;
        };
        let module_language = m.get("language").and_then(Language::from_value);
        if !reads_methods(module_language) || !defs.entry(name).is_some_and(holds) {
            continue;
        }
        let module_language = module_language.map_or("", Language::as_str);
        let index = program
            .members()
            .get("uses")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .position(|u| u.get("module").and_then(Value::as_str) == Some(module));
        let path = match index {
            Some(i) => ptr(&[&"uses", &i]),
            None => "/uses".to_owned(),
        };
        out.push(Diagnostic::new(
            "E1804",
            format!(
                "{name}, imported from {module}, holds a net.https capability that allows only some methods, as {module_language} reads it. This program is {}, which would read it without the limit, allowing any method. Write the program in mandate/0.5 or later.",
                language.to_js_string()
            ),
            Location::path(path),
            Some(
                JsObject::new()
                    .with("definition", name)
                    .with("module", module)
                    .with("module_language", module_language)
                    .with("language", language.clone()),
            ),
        ));
    }
    out
}

/// What a capability expression stands for, or why it stands for nothing:
/// `CapResult`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CapResult {
    /// The capabilities.
    pub caps: Vec<CapVal>,
    /// Why it stands for none, when it cannot be opened.
    pub problem: Option<String>,
}

impl CapResult {
    fn of(caps: Vec<CapVal>) -> CapResult {
        CapResult {
            caps,
            problem: None,
        }
    }

    fn fail(problem: String) -> CapResult {
        CapResult {
            caps: Vec::new(),
            problem: Some(problem),
        }
    }
}

/// The constructors over components.
const COMPONENT_CTORS: [&str; 4] = [
    "component.read",
    "component.write",
    "component.exec",
    "component.repo",
];

/// A capability constructor call, with the component and environment
/// definitions in `defs` for `component.*`, `data.read` and `env.*`;
/// `None` when the expression is no constructor. A constructor that cannot
/// be opened (an argument that is not a component, a command kind it does
/// not declare) has a `problem` and no capabilities. `capsFromCall`.
#[must_use]
pub fn caps_from_call(e: Expr<'_>, defs: &impl Table, opts: CapOptions) -> Option<CapResult> {
    if !e.is(ExprOp::Call) {
        return None;
    }
    let ctor = e.callee().and_then(callee_path);
    let args: Vec<Arg<'_>> = e.args().collect();
    match ctor.as_deref() {
        Some(c) if COMPONENT_CTORS.contains(&c) => return Some(component_caps(c, &args, defs)),
        Some("data.read") => return Some(read_caps(&args, defs)),
        Some(c @ ("env.deploy" | "env.migrate")) => return Some(env_caps(c, &args, defs)),
        _ => {}
    }
    cap_from_call(e, opts).map(|c| CapResult::of(vec![c]))
}

/// The value of an argument when it is a `var`: its name, `""` for a `var`
/// without one.
fn var_name<'a>(a: &Arg<'a>) -> Option<&'a str> {
    a.value()
        .filter(|v| v.is(ExprOp::Var))
        .map(|v| v.name().unwrap_or_default())
}

/// `JSON.stringify(s)`.
fn json(s: &str) -> String {
    let mut out = String::new();
    write_json_string(&mut out, s);
    out
}

/// The component an argument of `ctor` names, or why it names none:
/// `named` in `componentCaps`.
fn component_named<'d>(
    ctor: &str,
    a: Option<&Arg<'_>>,
    defs: &'d impl Table,
) -> Result<(String, ComponentDef<'d>), String> {
    let n = a.and_then(var_name).filter(|n| !n.is_empty());
    let d = n.and_then(|n| defs.entry(n)).and_then(ComponentDef::of);
    match (n, d) {
        (Some(n), Some(d)) => Ok((n.to_owned(), d)),
        (Some(n), None) => Err(format!("{ctor} takes components; '{n}' is not a component")),
        (None, _) => Err(format!(
            "{ctor} takes components; an argument is not a component name"
        )),
    }
}

/// `componentCaps`.
fn component_caps(ctor: &str, args: &[Arg<'_>], defs: &impl Table) -> CapResult {
    let named = |a: Option<&Arg<'_>>| component_named(ctor, a, defs);
    let shown_args: Vec<String> = args
        .iter()
        .map(|a| match a.value() {
            Some(v) if v.is(ExprOp::Var) => v.name().unwrap_or_default().to_owned(),
            Some(v) if v.is(ExprOp::Text) => json(v.text().unwrap_or_default()),
            _ => "…".to_owned(),
        })
        .collect();
    let shown = format!("{ctor}({})", shown_args.join(", "));
    if args.is_empty() {
        return CapResult::fail(format!("{ctor} needs a component"));
    }
    if ctor == "component.read" || ctor == "component.repo" {
        let mut cs: Vec<(String, ComponentDef<'_>)> = Vec::new();
        for a in args {
            match named(Some(a)) {
                Ok(c) => cs.push(c),
                Err(problem) => return CapResult::fail(problem),
            }
        }
        let names: Vec<String> = cs.iter().map(|(n, _)| n.clone()).collect();
        let mut cap = if ctor == "component.read" {
            let mut cap = CapVal::new("fs.read", "Fs.Read", false);
            cap.set_scope(Some(
                cs.iter()
                    .map(|(_, c)| c.root().unwrap_or_default().to_owned())
                    .collect(),
            ));
            cap
        } else {
            let mut cap = CapVal::new("git.pr", "git.*", true);
            cap.set_scope(Some(unique_in_order(
                cs.iter()
                    .map(|(_, c)| c.repo().unwrap_or_default().to_owned()),
            )));
            cap
        };
        cap.set_via(Some(shown));
        cap.set_components(Some(names));
        return CapResult::of(vec![cap]);
    }
    let (name, comp) = match named(args.first()) {
        Ok(c) => c,
        Err(problem) => return CapResult::fail(problem),
    };
    let root = comp.root().unwrap_or_default();
    if ctor == "component.write" {
        let mut paths: Vec<String> = Vec::new();
        for a in args.iter().skip(1) {
            let Some(text) = a
                .value()
                .filter(|v| v.is(ExprOp::Text))
                .map(|v| v.text().unwrap_or_default())
            else {
                return CapResult::fail(format!("{ctor} takes paths inside the component as text"));
            };
            let rel = posix::normalize(text);
            if posix::is_absolute(&rel) || rel == ".." || rel.starts_with("../") {
                return CapResult::fail(format!("{} is not a path inside {name}", json(text)));
            }
            paths.push(if rel == "." {
                root.to_owned()
            } else {
                format!("{}/{rel}", root.strip_suffix('/').unwrap_or(root))
            });
        }
        let mut cap = CapVal::new("fs.write", "Fs.Write", true);
        cap.set_scope(Some(if paths.is_empty() {
            vec![root.to_owned()]
        } else {
            paths
        }));
        cap.set_via(Some(shown));
        cap.set_components(Some(vec![name]));
        return CapResult::of(vec![cap]);
    }
    // component.exec(c, build | test …): one exec capability per declared
    // command, with exactly its argument prefixes.
    let kinds: Vec<&str> = args
        .iter()
        .skip(1)
        .map(|a| var_name(a).unwrap_or_default())
        .collect();
    if kinds.is_empty() {
        return CapResult::fail(format!("{ctor} names what to run: build or test"));
    }
    let mut by_command: Vec<(String, Vec<Vec<String>>)> = Vec::new();
    for k in kinds {
        let declared = match k {
            "build" => comp.build().map(Iterator::collect::<Vec<_>>),
            "test" => comp.test().map(Iterator::collect::<Vec<_>>),
            _ => {
                let k = if k.is_empty() { "an expression" } else { k };
                return CapResult::fail(format!("{ctor} runs build or test, not '{k}'"));
            }
        };
        let Some(declared) = declared else {
            return CapResult::fail(format!("{name} declares no {k} commands"));
        };
        for cmd in declared {
            let command = cmd.command().unwrap_or_default();
            let args: Vec<String> = cmd.args().map(str::to_owned).collect();
            match by_command.iter_mut().find(|(c, _)| c.as_str() == command) {
                Some((_, prefixes)) => prefixes.push(args),
                None => by_command.push((command.to_owned(), vec![args])),
            }
        }
    }
    by_command.sort_by(|(a, _), (b, _)| compare_utf16(a, b));
    CapResult::of(
        by_command
            .into_iter()
            .map(|(command, prefixes)| {
                let mut cap = CapVal::new("exec", "Exec", false);
                cap.set_scope(Some(vec![command]));
                cap.set_args_prefix(Some(unique_in_order(prefixes)));
                cap.set_via(Some(shown.clone()));
                cap.set_components(Some(vec![name.clone()]));
                cap.set_root(Some(root.to_owned()));
                cap
            })
            .collect(),
    )
}

/// `env.deploy(staging, prod)`: deploy (or migrate) in those environments
/// of the system model, and nowhere else. `envCaps`.
fn env_caps(ctor: &str, args: &[Arg<'_>], defs: &impl Table) -> CapResult {
    let mut envs: Vec<String> = Vec::new();
    for a in args {
        let n = var_name(a).filter(|n| !n.is_empty());
        let is_env = n
            .and_then(|n| defs.entry(n))
            .and_then(|d| d.get("kind"))
            .and_then(Value::as_str)
            == Some("environment");
        match n {
            Some(n) if is_env => envs.push(n.to_owned()),
            Some(n) => {
                return CapResult::fail(format!("{ctor} takes environments; '{n}' is not one"));
            }
            None => {
                return CapResult::fail(format!(
                    "{ctor} takes environments; an argument is not an environment name"
                ));
            }
        }
    }
    if envs.is_empty() {
        return CapResult::fail(format!("{ctor} needs an environment"));
    }
    let Some(spec) = cap_ctor(ctor) else {
        return CapResult::default();
    };
    let mut scope = unique_in_order(envs.iter().cloned());
    sort_utf16(&mut scope);
    let mut cap = CapVal::new(ctor, spec.effect, spec.write);
    cap.set_scope(Some(scope));
    cap.set_via(Some(format!("{ctor}({})", envs.join(", "))));
    CapResult::of(vec![cap])
}

/// `data.read(env, read…)`: the authority to run those declared reads of an
/// environment through the read broker (design doc 9 §5.1); without read
/// names, every read the environment declares. Scope items are `env.read`.
/// `readCaps`.
fn read_caps(args: &[Arg<'_>], defs: &impl Table) -> CapResult {
    let env = args.first().and_then(var_name).filter(|n| !n.is_empty());
    let d = env.and_then(|n| defs.entry(n)).and_then(EnvironmentDef::of);
    let (Some(env), Some(d)) = (env, d) else {
        return CapResult::fail(match env {
            Some(env) => format!("data.read takes an environment first; '{env}' is not one"),
            None => "data.read takes an environment first; the first argument is not an environment name".to_owned(),
        });
    };
    let declared: Vec<String> = d.reads().map(|(r, _)| r.to_owned()).collect();
    let mut named: Vec<String> = Vec::new();
    for a in args.iter().skip(1) {
        let r = a
            .value()
            .and_then(|v| match v.op() {
                Some(ExprOp::Var) => Some(v.name().unwrap_or_default()),
                Some(ExprOp::Text) => Some(v.text().unwrap_or_default()),
                _ => None,
            })
            .filter(|r| !r.is_empty());
        match r {
            Some(r) if declared.iter().any(|x| x == r) => named.push(r.to_owned()),
            Some(r) => return CapResult::fail(format!("{env} declares no read '{r}'")),
            None => {
                return CapResult::fail(format!("{env} declares no read named by that argument"));
            }
        }
    }
    // `(named.length ? named : declared).sort()` sorts `named` in place, so
    // `via` below lists the names sorted, not as written.
    let reads = if named.is_empty() {
        let mut declared = declared;
        sort_utf16(&mut declared);
        declared
    } else {
        sort_utf16(&mut named);
        named.clone()
    };
    if reads.is_empty() {
        return CapResult::fail(format!("{env} declares no reads"));
    }
    let mut via = vec![env.to_owned()];
    via.extend(named);
    let mut cap = CapVal::new("data.read", "Data.Read", false);
    cap.set_scope(Some(reads.iter().map(|r| format!("{env}.{r}")).collect()));
    cap.set_via(Some(format!("data.read({})", via.join(", "))));
    CapResult::of(vec![cap])
}

/// The capabilities an expression stands for: a named capability, a
/// constructor (including `component.*`), or `c.narrow(…)`. A narrowing
/// whose scope is not literal leaves the scope unknown, never the base's
/// wider one. The checker reports what cannot be evaluated; here it stands
/// for nothing. `capsOf(defs, e, opts)`.
#[must_use]
pub fn caps_of(defs: &impl Table, e: Expr<'_>, opts: CapOptions) -> Vec<CapVal> {
    caps_of_within(defs, e, opts, &[])
}

/// [`caps_of`] inside the capability definitions `within`, which are
/// being read already: `capsOf(defs, e, opts, within)`. A capability that
/// names itself, directly or through another, is nothing.
#[must_use]
pub fn caps_of_within(
    defs: &impl Table,
    e: Expr<'_>,
    opts: CapOptions,
    within: &[String],
) -> Vec<CapVal> {
    if e.is(ExprOp::Var) {
        let name = e.name().unwrap_or_default();
        let Some(value) = defs
            .entry(name)
            .filter(|d| d.get("kind").and_then(Value::as_str) == Some("capability"))
        else {
            return Vec::new();
        };
        if within.iter().any(|w| w == name) {
            return Vec::new();
        }
        let Some(inner) = value.get("value").and_then(Expr::of) else {
            return Vec::new();
        };
        let mut deeper = within.to_vec();
        deeper.push(name.to_owned());
        let mut caps = caps_of_within(defs, inner, opts, &deeper);
        for c in &mut caps {
            c.set_name(Some(name.to_owned()));
        }
        return caps;
    }
    if e.is(ExprOp::Call)
        && let Some(callee) = e.callee()
        && callee.is(ExprOp::Field)
        && callee.name() == Some("narrow")
    {
        let bases = callee
            .operand()
            .map(|of| caps_of_within(defs, of, opts, within))
            .unwrap_or_default();
        let args: Vec<Arg<'_>> = e.args().collect();
        let scope: Vec<String> = args
            .iter()
            .filter_map(|a| a.value().filter(|v| v.is(ExprOp::Text)))
            .map(|v| v.text().unwrap_or_default().to_owned())
            .collect();
        let narrowed = bases.len() == 1 && scope.len() == args.len();
        return bases
            .into_iter()
            .map(|mut base| {
                base.set_scope(None);
                if narrowed {
                    let name = format!("{}.narrow", base.name().unwrap_or(base.ctor()));
                    base.set_scope(Some(scope.clone()));
                    base.set_name(Some(name));
                }
                base
            })
            .collect();
    }
    caps_from_call(e, defs, opts)
        .map(|r| r.caps)
        .unwrap_or_default()
}

/// Normalizes an absolute path into segments; `..` and `.` are resolved,
/// trailing slashes dropped (a `..` at the root is dropped). `segments`.
#[must_use]
pub fn segments(path: &str) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for s in path.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            s => out.push(s),
        }
    }
    out
}

/// True when path `inner` lies at or below `outer`, segment by segment (not
/// by string prefix). `within`.
#[must_use]
pub fn within(inner: &str, outer: &str) -> bool {
    let a = segments(inner);
    let b = segments(outer);
    b.len() <= a.len() && b.iter().zip(&a).all(|(s, t)| s == t)
}

/// Whether one of two paths lies at or below the other. `pathsOverlap`.
#[must_use]
pub fn paths_overlap(a: &str, b: &str) -> bool {
    within(a, b) || within(b, a)
}

/// `scopeItemWithin`: a path for `fs.*`, the same text otherwise.
fn scope_item_within(ctor: &str, item: &str, outer: &str) -> bool {
    if ctor.starts_with("fs.") {
        within(item, outer)
    } else {
        item == outer
    }
}

/// C3: every item of `inner` lies inside some item of `outer`. Unknown
/// scopes are not provably inside; an unknown `outer` holds everything.
/// `scopeWithin`.
#[must_use]
pub fn scope_within(ctor: &str, inner: Option<&[String]>, outer: Option<&[String]>) -> bool {
    let Some(outer) = outer else {
        return true;
    };
    let Some(inner) = inner else {
        return false;
    };
    inner
        .iter()
        .all(|i| outer.iter().any(|o| scope_item_within(ctor, i, o)))
}

/// Every argument prefix in `inner` extends one in `outer`. No prefixes
/// means any arguments. `prefixesWithin`.
#[must_use]
pub fn prefixes_within(inner: Option<&[Vec<String>]>, outer: Option<&[Vec<String>]>) -> bool {
    let Some(outer) = outer else {
        return true;
    };
    let Some(inner) = inner else {
        return false;
    };
    inner.iter().all(|p| {
        outer
            .iter()
            .any(|o| o.len() <= p.len() && o.iter().zip(p).all(|(s, t)| s == t))
    })
}

/// Does `cap` authorize everything `need` authorizes? `capCovers`.
#[must_use]
pub fn cap_covers(cap: &CapVal, need: &CapVal) -> bool {
    if cap.ctor != need.ctor {
        return false;
    }
    if !scope_within(&cap.ctor, need.scope(), cap.scope()) {
        return false;
    }
    if let (Some(n), Some(c)) = (need.max_class, cap.max_class)
        && class_rank(n) > class_rank(c)
    {
        return false;
    }
    // Tiers are not ordered: a capability without a tier allows any, one
    // with a tier allows only that one.
    if cap.tier.is_some() && need.tier != cap.tier {
        return false;
    }
    if !prefixes_within(need.args_prefix(), cap.args_prefix()) {
        return false;
    }
    // Methods (0.5): a capability without them allows any method, so only
    // one without them covers one without them.
    if let Some(allowed) = &cap.methods {
        match &need.methods {
            None => return false,
            Some(asked) if !asked.iter().all(|m| allowed.contains(m)) => return false,
            Some(_) => {}
        }
    }
    true
}

/// Does `cap` authorize effect `effect`, optionally over `scope`?
/// `capAuthorizes`. A capability whose effect is a namespace such as
/// `git.*` authorizes every effect that starts with `git.`.
#[must_use]
pub fn cap_authorizes(cap: &CapVal, effect: &str, scope: Option<&[String]>) -> bool {
    if let Some(namespace) = cap
        .effect
        .strip_suffix('*')
        .filter(|_| cap.effect.ends_with(".*"))
    {
        if !effect.starts_with(namespace) {
            return false;
        }
    } else if cap.effect != effect {
        return false;
    }
    scope.is_none() || scope_within(&cap.ctor, scope, cap.scope())
}

/// C5: two write capabilities whose scopes intersect. Unknown scopes are
/// assumed to overlap. `writesOverlap`.
#[must_use]
pub fn writes_overlap(a: &CapVal, b: &CapVal) -> bool {
    if !a.write || !b.write || a.ctor != b.ctor {
        return false;
    }
    let (Some(sa), Some(sb)) = (&a.scope, &b.scope) else {
        return true;
    };
    let fs = a.ctor.starts_with("fs.");
    sa.iter().any(|x| {
        sb.iter()
            .any(|y| if fs { paths_overlap(x, y) } else { x == y })
    })
}

/// A capability as people read it, e.g.
/// `src = fs.write("/work/repo/src")` or
/// `component.read(mcp) → fs.read("/work/mcp")`. `showCap`.
#[must_use]
pub fn show_cap(c: &CapVal) -> String {
    let mut args: Vec<String> = c
        .scope
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|s| json(s))
        .collect();
    if let Some(methods) = &c.methods {
        args.push(format!("methods: [{}]", methods.join(", ")));
    }
    let scope = if c.scope.is_some() || c.methods.is_some() {
        format!("({})", args.join(", "))
    } else {
        String::new()
    };
    let name = c
        .name
        .as_deref()
        .filter(|n| !n.is_empty())
        .map(|n| format!("{n} = "))
        .unwrap_or_default();
    let via = c
        .via
        .as_deref()
        .filter(|v| !v.is_empty())
        .map(|v| format!("{v} → "))
        .unwrap_or_default();
    format!("{name}{via}{}{scope}", c.ctor)
}
