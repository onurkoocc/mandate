//! Every place a pattern names something, with the local names in scope
//! there: what the checks of a pattern's definition (E1301, E1302, E1306)
//! and of an application (which definitions of the pattern's module the
//! expansion names) read.
//!
//! The walk knows the structure of the IR: which members of a statement or
//! an expression are blocks, and where a name is bound (a `let` for the
//! statements after it, a `par`'s branches likewise, a map's item in its
//! `with caps` and its body, `on unmet(x)` in what follows it, the names a
//! `switch` case or `on error` binds in what it gives). Everything else is
//! walked member by member, so that no expression is missed. The recursion
//! follows the nesting of the IR, which the reader bounds (64 levels).

use std::rc::Rc;

use mandate_ir::{Pattern, PatternKind, StmtOp, Value, ptr_token};

use crate::caps::callee_path;

/// The local names in scope: a chain, shared.
#[derive(Debug, Default)]
pub(crate) struct Scope {
    names: Vec<String>,
    parent: Option<Rc<Scope>>,
}

impl Scope {
    /// A scope of `names` inside `parent`.
    pub(crate) fn child(parent: &Rc<Scope>, names: Vec<String>) -> Rc<Scope> {
        Rc::new(Scope {
            names,
            parent: Some(Rc::clone(parent)),
        })
    }

    /// Whether `name` is bound here or around.
    pub(crate) fn binds(&self, name: &str) -> bool {
        let mut s = Some(self);
        while let Some(at) = s {
            if at.names.iter().any(|n| n == name) {
                return true;
            }
            s = at.parent.as_deref();
        }
        false
    }
}

/// What a place of a pattern names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Named {
    /// `{ op: "var", name }`; `called` when it is the callee of a call,
    /// `caps` when it stands in a `with caps` list.
    Var {
        /// The name.
        name: String,
        /// The callee of a call.
        called: bool,
        /// In a capability's place.
        caps: bool,
    },
    /// A type's `ref`; `contract` when it is the second argument of
    /// `Verified` or `Review`, which names a contract.
    Type {
        /// The name.
        name: String,
        /// A contract's place.
        contract: bool,
    },
    /// The type of a record literal.
    Record(String),
    /// A delegation (or a `spawn`, a `plan`) to `Agent.skill` written out.
    Agent(String),
    /// `delegate slot(…)`.
    SkillSlot(String),
    /// `effect name(…)`.
    Effect(String),
    /// `compensate name`.
    Compensate(String),
    /// `verify x against name(…)`.
    Contract(String),
    /// `v.name`, the field read.
    Field(String),
    /// A map's `max` or `par` written as a name.
    Count(String),
    /// A call of a dotted path the program does not define (`fs.write(…)`,
    /// `human.review(…)`); `caps` when it stands in a `with caps` list.
    Path {
        /// The callee's path.
        path: String,
        /// In a capability's place.
        caps: bool,
    },
    /// A role written as text where a person is asked (`role: "r"`).
    RoleText,
    /// A name the body binds.
    Bind(String),
}

/// One place: what it names, where, and whether a local name of the body
/// shadows it there.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Place {
    /// What it names.
    pub(crate) named: Named,
    /// Its JSON Pointer, from the walk's root.
    pub(crate) path: String,
    /// A local name of the body binds the name here.
    pub(crate) shadowed: bool,
}

/// The walk.
#[derive(Debug, Default)]
pub(crate) struct Walk {
    pub(crate) out: Vec<Place>,
}

/// `path/k`.
fn sub(path: &str, k: &str) -> String {
    format!("{path}/{}", ptr_token(k))
}

/// The names a match pattern binds.
pub(crate) fn pattern_binds(p: Option<&Value>, out: &mut Vec<String>) {
    let Some(p) = p.and_then(Pattern::of) else {
        return;
    };
    match p.kind() {
        Some(PatternKind::Bind) => out.push(p.name().unwrap_or_default().to_owned()),
        Some(PatternKind::Tag) => {
            for a in p.args() {
                pattern_binds(Some(a), out);
            }
        }
        _ => {}
    }
}

/// Whether `v` is a type expression: an object with `ref`, `record`,
/// `enum`, `union` or `refine` and no `op`.
pub(crate) fn is_type(v: &Value) -> bool {
    v.get("op").is_none()
        && ["ref", "record", "enum", "union", "refine"]
            .iter()
            .any(|k| v.get(k).is_some())
}

impl Walk {
    /// A walk with nothing found yet.
    pub(crate) fn new() -> Walk {
        Walk { out: Vec::new() }
    }

    fn found(&mut self, named: Named, path: String, shadowed: bool) {
        self.out.push(Place {
            named,
            path,
            shadowed,
        });
    }

    /// A list of statements in `scope`: each `let` and `par` binds its
    /// names for the statements after it.
    pub(crate) fn block(&mut self, stmts: &[Value], path: &str, scope: &Rc<Scope>) {
        let mut scope = Rc::clone(scope);
        for (i, s) in stmts.iter().enumerate() {
            let at = format!("{path}/{i}");
            let op = s.get("op").and_then(StmtOp::from_value);
            self.node(s, &at, &scope, false);
            let mut bound: Vec<String> = Vec::new();
            match op {
                Some(StmtOp::Let) => {
                    if let Some(n) = s.get("name").and_then(Value::as_str) {
                        self.found(Named::Bind(n.to_owned()), sub(&at, "name"), false);
                        bound.push(n.to_owned());
                    }
                }
                Some(StmtOp::Par) => {
                    for (n, _) in s
                        .get("branches")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flat_map(mandate_ir::Map::iter)
                    {
                        self.found(Named::Bind(n.to_owned()), sub(&at, "branches"), false);
                        bound.push(n.to_owned());
                    }
                }
                // Bind nothing for what follows; a stage of 0.7 opens no
                // scope either (spec/attention.md "`stage`").
                Some(
                    StmtOp::If
                    | StmtOp::Loop
                    | StmtOp::Return
                    | StmtOp::OnError
                    | StmtOp::Run
                    | StmtOp::Expr
                    | StmtOp::Stage,
                )
                | None => {}
            }
            if !bound.is_empty() {
                scope = Scope::child(&scope, bound);
            }
        }
    }

    /// Any value of the IR: a statement or an expression (by its `op`), a
    /// type, a list, or an object of other parts, member by member. `caps`
    /// says it stands in a `with caps` list.
    pub(crate) fn node(&mut self, v: &Value, path: &str, scope: &Rc<Scope>, caps: bool) {
        match v {
            Value::Array(items) => {
                for (i, x) in items.iter().enumerate() {
                    self.node(x, &format!("{path}/{i}"), scope, caps);
                }
            }
            Value::Object(_) if v.get("op").and_then(Value::as_str).is_some() => {
                self.op(v, path, scope, caps);
            }
            Value::Object(_) if is_type(v) => self.type_(v, path, scope),
            Value::Object(m) => {
                for (k, x) in m.iter() {
                    self.node(x, &sub(path, k), scope, caps);
                }
            }
            _ => {}
        }
    }

    /// A type: the names it refers to, a contract in the second place of
    /// `Verified` and `Review`, and a refinement's condition.
    pub(crate) fn type_(&mut self, t: &Value, path: &str, scope: &Rc<Scope>) {
        if let Some(r) = t.get("ref").and_then(Value::as_str) {
            self.found(
                Named::Type {
                    name: r.to_owned(),
                    contract: false,
                },
                sub(path, "ref"),
                false,
            );
            let args = t.get("args").and_then(Value::as_array).unwrap_or_default();
            for (i, a) in args.iter().enumerate() {
                let at = format!("{path}/args/{i}");
                let bare = a.get("args").is_none();
                if i == 1
                    && bare
                    && (r == "Verified" || r == "Review")
                    && let Some(c) = a.get("ref").and_then(Value::as_str)
                {
                    self.found(
                        Named::Type {
                            name: c.to_owned(),
                            contract: true,
                        },
                        sub(&at, "ref"),
                        false,
                    );
                    continue;
                }
                self.type_(a, &at, scope);
            }
            return;
        }
        if let Some(r) = t.get("refine") {
            self.type_(r, &sub(path, "refine"), scope);
            if let Some(w) = t.get("where") {
                let inner = Scope::child(scope, vec!["value".to_owned()]);
                self.node(w, &sub(path, "where"), &inner, false);
            }
            return;
        }
        if let Some(record) = t.get("record").and_then(Value::as_object) {
            for (f, ft) in record.iter() {
                self.type_(ft, &format!("{path}/record/{}", ptr_token(f)), scope);
            }
            return;
        }
        if let Some(union) = t.get("union").and_then(Value::as_array) {
            for (i, variant) in union.iter().enumerate() {
                let fields = variant
                    .get("fields")
                    .and_then(Value::as_array)
                    .unwrap_or_default();
                for (j, p) in fields.iter().enumerate() {
                    if let Some(pt) = p.get("type") {
                        self.type_(pt, &format!("{path}/union/{i}/fields/{j}/type"), scope);
                    }
                }
            }
        }
    }

    /// A statement or an expression.
    fn op(&mut self, v: &Value, path: &str, scope: &Rc<Scope>, caps: bool) {
        let Some(m) = v.as_object() else { return };
        let op = v.get("op").and_then(Value::as_str).unwrap_or_default();
        let name = v.get("name").and_then(Value::as_str);
        match op {
            "var" => {
                let n = name.unwrap_or_default();
                self.found(
                    Named::Var {
                        name: n.to_owned(),
                        called: false,
                        caps,
                    },
                    path.to_owned(),
                    scope.binds(n),
                );
                return;
            }
            "field" => {
                if let Some(n) = name {
                    self.found(Named::Field(n.to_owned()), sub(path, "name"), false);
                }
                if let Some(of) = v.get("of") {
                    self.node(of, &sub(path, "of"), scope, caps);
                }
                return;
            }
            "call" => {
                if let Some(callee) = v.get("callee") {
                    let at = sub(path, "callee");
                    match callee.get("op").and_then(Value::as_str) {
                        Some("var") => {
                            let n = callee
                                .get("name")
                                .and_then(Value::as_str)
                                .unwrap_or_default();
                            self.found(
                                Named::Var {
                                    name: n.to_owned(),
                                    called: true,
                                    caps,
                                },
                                at,
                                scope.binds(n),
                            );
                        }
                        _ => {
                            let dotted = mandate_ir::Expr::of(callee).and_then(callee_path);
                            let head_bound = dotted
                                .as_deref()
                                .and_then(|p| p.split('.').next())
                                .is_some_and(|h| scope.binds(h));
                            if let Some(p) = dotted.filter(|_| !head_bound) {
                                if p.starts_with("human") {
                                    self.role_texts(v, path);
                                }
                                self.found(Named::Path { path: p, caps }, path.to_owned(), false);
                            }
                            self.node(callee, &at, scope, caps);
                        }
                    }
                }
                if let Some(args) = v.get("args") {
                    self.node(args, &sub(path, "args"), scope, false);
                }
                return;
            }
            "record" => {
                if let Some(t) = v.get("type").and_then(Value::as_str) {
                    self.found(Named::Record(t.to_owned()), sub(path, "type"), false);
                }
                if let Some(fields) = v.get("fields") {
                    self.node(fields, &sub(path, "fields"), scope, false);
                }
                return;
            }
            "delegate" | "spawn" | "plan" => {
                // Both, when both are written (E1301): an agent is named
                // whether or not a slot is beside it.
                if let Some(s) = v.get("slot").and_then(Value::as_str) {
                    self.found(Named::SkillSlot(s.to_owned()), sub(path, "slot"), false);
                }
                if let Some(a) = v.get("agent").and_then(Value::as_str) {
                    self.found(Named::Agent(a.to_owned()), sub(path, "agent"), false);
                }
                for (k, x) in m.iter() {
                    if matches!(k, "op" | "agent" | "skill" | "slot") {
                        continue;
                    }
                    self.node(x, &sub(path, k), scope, k == "caps");
                }
                return;
            }
            "effect" => {
                if let Some(n) = name {
                    self.found(Named::Effect(n.to_owned()), sub(path, "name"), false);
                }
                if let Some(c) = v.get("compensate").and_then(Value::as_str) {
                    self.found(
                        Named::Compensate(c.to_owned()),
                        sub(path, "compensate"),
                        false,
                    );
                }
                for k in ["args", "idempotent_by"] {
                    if let Some(x) = v.get(k) {
                        self.node(x, &sub(path, k), scope, false);
                    }
                }
                return;
            }
            "verify" => {
                if let Some(c) = v.get("contract").and_then(Value::as_str) {
                    self.found(Named::Contract(c.to_owned()), sub(path, "contract"), false);
                }
                for k in ["value", "args"] {
                    if let Some(x) = v.get(k) {
                        self.node(x, &sub(path, k), scope, false);
                    }
                }
                if let Some(on) = v.get("on_unmet") {
                    let at = sub(path, "on_unmet");
                    let bind = on.get("bind").and_then(Value::as_str).unwrap_or_default();
                    self.found(Named::Bind(bind.to_owned()), sub(&at, "bind"), false);
                    let inner = Scope::child(scope, vec![bind.to_owned()]);
                    if let Some(then) = on.get("then") {
                        self.node(then, &sub(&at, "then"), &inner, false);
                    }
                }
                return;
            }
            "map" => {
                if let Some(over) = v.get("over") {
                    self.node(over, &sub(path, "over"), scope, false);
                }
                for k in ["max", "par"] {
                    if let Some(n) = v.get(k).and_then(Value::as_str) {
                        self.found(Named::Count(n.to_owned()), sub(path, k), false);
                    }
                }
                let bind = v.get("bind").and_then(Value::as_str).unwrap_or_default();
                self.found(Named::Bind(bind.to_owned()), sub(path, "bind"), false);
                let inner = Scope::child(scope, vec![bind.to_owned()]);
                if let Some(c) = v.get("caps") {
                    self.node(c, &sub(path, "caps"), &inner, true);
                }
                for k in ["budget", "supervise"] {
                    if let Some(x) = v.get(k) {
                        self.node(x, &sub(path, k), scope, false);
                    }
                }
                let body = v.get("body").and_then(Value::as_array).unwrap_or_default();
                self.block(body, &sub(path, "body"), &inner);
                return;
            }
            "block" => {
                let body = v.get("body").and_then(Value::as_array).unwrap_or_default();
                self.block(body, &sub(path, "body"), scope);
                return;
            }
            "switch" => {
                if let Some(on) = v.get("on") {
                    self.node(on, &sub(path, "on"), scope, false);
                }
                let cases = v.get("cases").and_then(Value::as_array).unwrap_or_default();
                for (i, c) in cases.iter().enumerate() {
                    let mut binds = Vec::new();
                    pattern_binds(c.get("pattern"), &mut binds);
                    let at = format!("{path}/cases/{i}");
                    for b in &binds {
                        self.found(Named::Bind(b.clone()), sub(&at, "pattern"), false);
                    }
                    let inner = Scope::child(scope, binds);
                    if let Some(then) = c.get("then") {
                        self.node(then, &sub(&at, "then"), &inner, false);
                    }
                }
                return;
            }
            "on_error" => {
                let mut binds = Vec::new();
                pattern_binds(v.get("pattern"), &mut binds);
                for b in &binds {
                    self.found(Named::Bind(b.clone()), sub(path, "pattern"), false);
                }
                let inner = Scope::child(scope, binds);
                if let Some(then) = v.get("then") {
                    self.node(then, &sub(path, "then"), &inner, false);
                }
                return;
            }
            "if" => {
                if let Some(c) = v.get("cond") {
                    self.node(c, &sub(path, "cond"), scope, false);
                }
                for k in ["then", "else"] {
                    let b = v.get(k).and_then(Value::as_array).unwrap_or_default();
                    self.block(b, &sub(path, k), scope);
                }
                return;
            }
            "loop" => {
                if let Some(u) = v.get("until") {
                    self.node(u, &sub(path, "until"), scope, false);
                }
                let b = v.get("body").and_then(Value::as_array).unwrap_or_default();
                self.block(b, &sub(path, "body"), scope);
                return;
            }
            "changeset" => {
                for (k, x) in m.iter() {
                    match k {
                        "op" | "order" | "changes" => {}
                        "approver" => self.found(Named::RoleText, sub(path, k), false),
                        "members" => {
                            for (mn, mem) in
                                x.as_object().into_iter().flat_map(mandate_ir::Map::iter)
                            {
                                let at = format!("{path}/members/{}", ptr_token(mn));
                                if let Some(e) = mem.get("effect").and_then(Value::as_str) {
                                    self.found(
                                        Named::Effect(e.to_owned()),
                                        sub(&at, "effect"),
                                        false,
                                    );
                                }
                                if mem.get("approver").is_some() {
                                    self.found(Named::RoleText, sub(&at, "approver"), false);
                                }
                                if let Some(a) = mem.get("args") {
                                    self.node(a, &sub(&at, "args"), scope, false);
                                }
                            }
                        }
                        _ => self.node(x, &sub(path, k), scope, false),
                    }
                }
                return;
            }
            // 0.7: a stage names nothing: its name is no reference and its
            // title is text (spec/attention.md "`stage`").
            "stage" => return,
            _ => {}
        }
        // Every other statement and expression: its members, a `let`'s type
        // and value among them.
        for (k, x) in m.iter() {
            if k == "op" || (op == "let" && k == "name") {
                continue;
            }
            self.node(x, &sub(path, k), scope, caps);
        }
    }

    /// `role: "r"` (and `escalate_to`, `distinct_from`) written as text in
    /// a call of `human.*`.
    fn role_texts(&mut self, call: &Value, path: &str) {
        let args = call
            .get("args")
            .and_then(Value::as_array)
            .unwrap_or_default();
        for (i, a) in args.iter().enumerate() {
            let named = a.get("name").and_then(Value::as_str);
            let text = a
                .get("value")
                .and_then(|x| x.get("op"))
                .and_then(Value::as_str)
                == Some("text");
            if text && matches!(named, Some("role" | "escalate_to" | "distinct_from")) {
                self.found(Named::RoleText, format!("{path}/args/{i}/value"), false);
            }
        }
    }
}
