//! The expansion proper (spec/library.md "Expansion"): a pattern's body,
//! run parameters and result with each use of a slot replaced by its
//! argument, each type parameter by its type argument, and each `v.slot` of
//! a `field` slot by that field; and the origin of every place the
//! replacement wrote, so that a diagnostic of the expansion is reported in
//! the program that was checked.
//!
//! Hygiene: a name an argument writes into the body is checked against the
//! names the body binds around the use (E1306); nothing is renamed. The
//! walk follows the nesting of the pattern's body (bounded by the reader),
//! never that of an argument, which is copied; the depth of what it copies
//! is counted, so that the expansion nests no deeper than the reader
//! allows, and so is the size of what it copies (E0105).

use std::rc::Rc;

use mandate_ir::{JsObject, Map, Value, canonicalize, limits, ptr_token};

use super::apply::{Binding, Bound};
use super::pattern::Problem;
use super::walk::{Scope, is_type, pattern_binds};

/// `{ ref: name }`.
pub(crate) fn type_ref(name: &str) -> Value {
    let mut m = Map::new();
    m.insert("ref", name);
    Value::Object(m)
}

/// A type with each type parameter of `types` replaced by its type
/// argument: what a slot's signature means in an application.
pub(crate) fn substitute_type(t: &Value, types: &[(String, Value, String)]) -> Value {
    match t {
        Value::Array(items) => {
            Value::Array(items.iter().map(|x| substitute_type(x, types)).collect())
        }
        Value::Object(m) => {
            if let Some(r) = t.get("ref").and_then(Value::as_str)
                && let Some((_, arg, _)) = types.iter().find(|(g, _, _)| g == r)
                && t.get("args").is_none()
            {
                return arg.clone();
            }
            let mut out = Map::new();
            for (k, x) in m.iter() {
                out.insert(k, substitute_type(x, types));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Where a place of the expansion comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Origin {
    /// The same place of the applying program (the workflow's `caps`,
    /// `budget`, `doc`).
    Same,
    /// A slot's argument, at `at` in the applying program; with `subtree`,
    /// what is below the place is what is below the argument.
    Arg {
        /// The argument's path.
        at: String,
        /// The slot.
        slot: String,
        /// The place is a copy of the argument.
        subtree: bool,
    },
    /// The pattern's own text, at `pattern_path` (and below) in its home.
    Body {
        /// The path in the pattern's home.
        pattern_path: String,
    },
}

/// The expansion of one application.
pub(crate) struct Subst<'a> {
    /// The slots and what each is given.
    pub(crate) bindings: &'a [Binding],
    /// The type arguments by type parameter, each with its path.
    pub(crate) types: &'a [(String, Value, String)],
    /// The pattern's name, for messages.
    pub(crate) pattern: &'a str,
    /// Where each place written comes from, by its path in the expansion.
    pub(crate) origins: Vec<(String, Origin)>,
    /// What does not hold (E1306 capture, E1305 count, E0105 limits), at
    /// paths in the applying program.
    pub(crate) problems: Vec<Problem>,
    /// The bytes of canonical text copied from arguments so far.
    pub(crate) copied: usize,
    /// The canonical length and the depth of what each slot's use copies,
    /// by slot, and of each type argument, by type parameter: each measured
    /// once, when the expansion starts, never at a use.
    measures: Vec<(String, Measure)>,
    /// The copies have passed the size limit: nothing more is written.
    stopped: bool,
    /// One capture reported per slot and name.
    captured: Vec<(String, String)>,
    /// The depth limit was reported.
    too_deep: bool,
}

/// What one copy of an argument adds: its canonical length in bytes and
/// its depth.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Measure {
    bytes: usize,
    depth: usize,
}

impl Measure {
    fn of(v: &Value) -> Measure {
        Measure {
            bytes: canonicalize(v).len(),
            depth: depth_of(v),
        }
    }
}

/// The measure of what a use of a slot bound to `b` copies into the
/// expansion, when it copies anything: a constant's value, a type, a tool's
/// callee, a role's or a capability's name.
fn measure_of(b: &Bound) -> Option<Measure> {
    match b {
        Bound::Const { value, .. } | Bound::Type(value) | Bound::Tool(value) => {
            Some(Measure::of(value))
        }
        Bound::Role(r) | Bound::Capability(r) => Some(Measure::of(&var(r))),
        _ => None,
    }
}

/// The depth of a value: 1 for a scalar, one more for each level of
/// nesting.
fn depth_of(v: &Value) -> usize {
    match v {
        Value::Array(items) => items
            .iter()
            .map(depth_of)
            .max()
            .unwrap_or(0)
            .saturating_add(1),
        Value::Object(m) => m
            .iter()
            .map(|(_, x)| depth_of(x))
            .max()
            .unwrap_or(0)
            .saturating_add(1),
        _ => 1,
    }
}

/// `path/k`.
fn sub(path: &str, k: &str) -> String {
    format!("{path}/{}", ptr_token(k))
}

impl<'a> Subst<'a> {
    /// An expansion with `bindings` and `types`.
    pub(crate) fn new(
        bindings: &'a [Binding],
        types: &'a [(String, Value, String)],
        pattern: &'a str,
    ) -> Subst<'a> {
        let mut measures: Vec<(String, Measure)> = Vec::new();
        for b in bindings {
            if let Some(m) = measure_of(&b.bound) {
                measures.push((b.slot.clone(), m));
            }
        }
        for (g, arg, _) in types {
            measures.push((format!("<{g}>"), Measure::of(arg)));
        }
        Subst {
            bindings,
            types,
            pattern,
            origins: Vec::new(),
            problems: Vec::new(),
            copied: 0,
            measures,
            stopped: false,
            captured: Vec::new(),
            too_deep: false,
        }
    }

    /// The measure of `key`'s copy (a slot, or `<T>` for a type
    /// parameter); `v`'s own when it was not measured (it is then small).
    fn measure(&self, key: &str, v: &Value) -> Measure {
        self.measures
            .iter()
            .find(|(k, _)| k == key)
            .map_or_else(|| Measure::of(v), |(_, m)| *m)
    }

    /// Counts the bytes of one copy; `false`, and nothing more is written,
    /// once they pass the reader's limit.
    fn count(&mut self, bytes: usize) -> bool {
        self.copied = self.copied.saturating_add(bytes);
        if self.copied > limits::SOURCE_BYTES {
            self.stopped = true;
        }
        !self.stopped
    }

    fn binding(&self, slot: &str) -> Option<&'a Binding> {
        self.bindings.iter().find(|b| b.slot == slot)
    }

    fn origin(&mut self, path: &str, origin: Origin) {
        self.origins.push((path.to_owned(), origin));
    }

    fn arg(&mut self, path: &str, b: &Binding, subtree: bool) {
        self.origin(
            path,
            Origin::Arg {
                at: b.at.clone(),
                slot: b.slot.clone(),
                subtree,
            },
        );
    }

    /// Body origins for the members of a slot's use that the pattern wrote.
    fn body_members(&mut self, path: &str, pattern_path: &str, v: &Value, skip: &[&str]) {
        for (k, _) in v.as_object().into_iter().flat_map(Map::iter) {
            if k == "op" || skip.contains(&k) {
                continue;
            }
            self.origin(
                &sub(path, k),
                Origin::Body {
                    pattern_path: sub(pattern_path, k),
                },
            );
        }
    }

    /// A copy of an argument's value at depth `depth` of the expansion,
    /// checked against the names in `scope` (capture), the depth and the
    /// size limits.
    fn copy(&mut self, v: &Value, b: &Binding, scope: &Scope, depth: usize) -> Value {
        for n in &b.names {
            if scope.binds(n) && !self.captured.iter().any(|(s, m)| *s == b.slot && m == n) {
                self.captured.push((b.slot.clone(), n.clone()));
                self.problems.push(Problem::new(
                    "E1306",
                    format!(
                        "The argument of the slot {} names {n}, and the body of {} binds {n} where it uses the slot: in the expansion the name would be the body's.",
                        b.slot, self.pattern
                    ),
                    &b.at,
                    JsObject::new()
                        .with("pattern", self.pattern)
                        .with("problem", "captured")
                        .with("slot", b.slot.as_str())
                        .with("name", n.as_str()),
                ));
            }
        }
        let measure = self.measure(&b.slot, v);
        let deepest = depth.saturating_add(measure.depth).saturating_sub(1);
        if deepest > limits::JSON_DEPTH && !self.too_deep {
            self.too_deep = true;
            self.problems.push(Problem::new(
                "E0105",
                format!(
                    "The expansion of {} nests the argument of the slot {} {deepest} levels deep; the limit is {}.",
                    self.pattern,
                    b.slot,
                    limits::JSON_DEPTH
                ),
                &b.at,
                JsObject::new()
                    .with("pattern", self.pattern)
                    .with("limit", limits::JSON_DEPTH)
                    .with("slot", b.slot.as_str()),
            ));
        }
        if !self.count(measure.bytes) {
            return Value::Null;
        }
        v.clone()
    }

    /// Whether the bytes copied passed the reader's limit, which stopped the
    /// expansion.
    pub(crate) fn over_size(&self) -> bool {
        self.stopped
    }

    /// A list of statements: `let` and `par` bind for what follows.
    pub(crate) fn block(
        &mut self,
        stmts: &[Value],
        path: &str,
        pp: &str,
        scope: &Rc<Scope>,
        depth: usize,
    ) -> Value {
        let mut scope = Rc::clone(scope);
        let mut out = Vec::with_capacity(stmts.len());
        for (i, s) in stmts.iter().enumerate() {
            if self.stopped {
                break;
            }
            out.push(self.node(
                s,
                &format!("{path}/{i}"),
                &format!("{pp}/{i}"),
                &scope,
                depth.saturating_add(1),
            ));
            let mut bound: Vec<String> = Vec::new();
            match s.get("op").and_then(Value::as_str) {
                Some("let") => {
                    if let Some(n) = s.get("name").and_then(Value::as_str) {
                        bound.push(n.to_owned());
                    }
                }
                Some("par") => {
                    for (n, _) in s
                        .get("branches")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flat_map(Map::iter)
                    {
                        bound.push(n.to_owned());
                    }
                }
                _ => {}
            }
            if !bound.is_empty() {
                scope = Scope::child(&scope, bound);
            }
        }
        Value::Array(out)
    }

    /// Any value of the pattern, at `path` in the expansion and `pp` in the
    /// pattern's home, at depth `depth` of the expansion.
    pub(crate) fn node(
        &mut self,
        v: &Value,
        path: &str,
        pp: &str,
        scope: &Rc<Scope>,
        depth: usize,
    ) -> Value {
        // Past the size limit nothing more is written (E0105 follows).
        if self.stopped {
            return Value::Null;
        }
        match v {
            Value::Array(items) => Value::Array(
                items
                    .iter()
                    .enumerate()
                    .map(|(i, x)| {
                        self.node(
                            x,
                            &format!("{path}/{i}"),
                            &format!("{pp}/{i}"),
                            scope,
                            depth.saturating_add(1),
                        )
                    })
                    .collect(),
            ),
            Value::Object(_) if v.get("op").and_then(Value::as_str).is_some() => {
                self.op(v, path, pp, scope, depth)
            }
            Value::Object(_) if is_type(v) => self.type_(v, path, scope, depth),
            Value::Object(m) => self.members(m, path, pp, scope, depth, &[]),
            other => other.clone(),
        }
    }

    /// The members of an object, each walked, those in `keep` copied.
    fn members(
        &mut self,
        m: &Map,
        path: &str,
        pp: &str,
        scope: &Rc<Scope>,
        depth: usize,
        keep: &[&str],
    ) -> Value {
        let mut out = Map::new();
        for (k, x) in m.iter() {
            let value = if keep.contains(&k) {
                x.clone()
            } else {
                self.node(
                    x,
                    &sub(path, k),
                    &sub(pp, k),
                    scope,
                    depth.saturating_add(1),
                )
            };
            out.insert(k, value);
        }
        Value::Object(out)
    }

    /// A type: a type parameter or a `type` slot replaced by its argument,
    /// a `contract` slot in the second place of `Verified` and `Review` by
    /// its contract.
    pub(crate) fn type_(
        &mut self,
        t: &Value,
        path: &str,
        scope: &Rc<Scope>,
        depth: usize,
    ) -> Value {
        let Some(m) = t.as_object() else {
            return t.clone();
        };
        if self.stopped {
            return Value::Null;
        }
        if let Some(r) = t.get("ref").and_then(Value::as_str) {
            if t.get("args").is_none() {
                if let Some((_, arg, at)) = self.types.iter().find(|(g, _, _)| g == r) {
                    self.origin(
                        path,
                        Origin::Arg {
                            at: at.clone(),
                            slot: r.to_owned(),
                            subtree: true,
                        },
                    );
                    let measure = self.measure(&format!("<{r}>"), arg);
                    let deepest = depth.saturating_add(measure.depth).saturating_sub(1);
                    if deepest > limits::JSON_DEPTH && !self.too_deep {
                        self.too_deep = true;
                        self.problems.push(Problem::new(
                            "E0105",
                            format!(
                                "The expansion of {} nests the type argument {r} {deepest} levels deep; the limit is {}.",
                                self.pattern,
                                limits::JSON_DEPTH
                            ),
                            at,
                            JsObject::new()
                                .with("pattern", self.pattern)
                                .with("limit", limits::JSON_DEPTH),
                        ));
                    }
                    if !self.count(measure.bytes) {
                        return Value::Null;
                    }
                    return arg.clone();
                }
                if let Some(b) = self.binding(r)
                    && let Bound::Type(arg) = &b.bound
                {
                    self.arg(path, b, true);
                    return self.copy(arg, b, scope, depth);
                }
            }
            let mut out = m.clone();
            if let Some(args) = t.get("args").and_then(Value::as_array) {
                let mut new_args = Vec::with_capacity(args.len());
                for (i, a) in args.iter().enumerate() {
                    let at = format!("{path}/args/{i}");
                    let contract = if i == 1
                        && (r == "Verified" || r == "Review")
                        && a.get("args").is_none()
                    {
                        a.get("ref")
                            .and_then(Value::as_str)
                            .and_then(|c| self.binding(c))
                    } else {
                        None
                    };
                    if let Some(b) = contract
                        && let Bound::Contract(c) = &b.bound
                    {
                        self.arg(&at, b, false);
                        new_args.push(type_ref(c));
                        continue;
                    }
                    new_args.push(self.type_(a, &at, scope, depth.saturating_add(2)));
                }
                out.insert("args", Value::Array(new_args));
            }
            return Value::Object(out);
        }
        let mut out = Map::new();
        for (k, x) in m.iter() {
            let at = sub(path, k);
            let value = match k {
                "refine" => self.type_(x, &at, scope, depth.saturating_add(1)),
                "where" => {
                    let inner = Scope::child(scope, vec!["value".to_owned()]);
                    self.node(x, &at, &at, &inner, depth.saturating_add(1))
                }
                "record" => {
                    let mut fields = Map::new();
                    for (f, ft) in x.as_object().into_iter().flat_map(Map::iter) {
                        fields.insert(
                            f,
                            self.type_(ft, &sub(&at, f), scope, depth.saturating_add(2)),
                        );
                    }
                    Value::Object(fields)
                }
                "union" => self.node(x, &at, &at, scope, depth.saturating_add(1)),
                _ => x.clone(),
            };
            out.insert(k, value);
        }
        Value::Object(out)
    }

    /// A statement or an expression.
    #[allow(clippy::too_many_lines)]
    fn op(&mut self, v: &Value, path: &str, pp: &str, scope: &Rc<Scope>, depth: usize) -> Value {
        let Some(m) = v.as_object() else {
            return v.clone();
        };
        if self.stopped {
            return Value::Null;
        }
        let op = v.get("op").and_then(Value::as_str).unwrap_or_default();
        let name = v.get("name").and_then(Value::as_str);
        let d1 = depth.saturating_add(1);
        match op {
            "var" => {
                let n = name.unwrap_or_default();
                if scope.binds(n) {
                    return v.clone();
                }
                let Some(b) = self.binding(n) else {
                    return v.clone();
                };
                let written = match &b.bound {
                    Bound::Role(r) | Bound::Capability(r) => var(r),
                    Bound::Const { value, .. } => {
                        self.arg(path, b, true);
                        return self.copy(value, b, scope, depth);
                    }
                    Bound::Tool(callee) => callee.clone(),
                    _ => return v.clone(),
                };
                self.arg(path, b, false);
                return self.copy(&written, b, scope, depth);
            }
            "field" => {
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let value = match k {
                        "of" => self.node(x, &sub(path, k), &sub(pp, k), scope, d1),
                        "name" => {
                            let f = x
                                .as_str()
                                .and_then(|n| self.binding(n))
                                .and_then(|b| match &b.bound {
                                    Bound::Field(f) => Some((b, f.clone())),
                                    _ => None,
                                });
                            match f {
                                Some((b, f)) => {
                                    self.arg(&sub(path, k), b, false);
                                    Value::from(f)
                                }
                                None => x.clone(),
                            }
                        }
                        _ => x.clone(),
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            "call" => {
                let tool = v
                    .get("callee")
                    .filter(|c| c.get("op").and_then(Value::as_str) == Some("var"))
                    .and_then(|c| c.get("name").and_then(Value::as_str))
                    .filter(|n| !scope.binds(n))
                    .and_then(|n| self.binding(n))
                    .filter(|b| matches!(b.bound, Bound::Tool(_)));
                if let Some(b) = tool
                    && let Bound::Tool(callee) = &b.bound
                {
                    self.arg(path, b, false);
                    self.body_members(path, pp, v, &["callee"]);
                    let mut out = Map::new();
                    for (k, x) in m.iter() {
                        let value = if k == "callee" {
                            self.copy(callee, b, scope, d1)
                        } else if k == "op" {
                            x.clone()
                        } else {
                            self.node(x, &sub(path, k), &sub(pp, k), scope, d1)
                        };
                        out.insert(k, value);
                    }
                    return Value::Object(out);
                }
            }
            "delegate" => {
                if let Some(b) = v
                    .get("slot")
                    .and_then(Value::as_str)
                    .and_then(|s| self.binding(s))
                    && let Bound::Skill { agent, skill } = &b.bound
                {
                    self.arg(path, b, false);
                    self.body_members(path, pp, v, &["slot"]);
                    let mut out = Map::new();
                    out.insert("op", "delegate");
                    out.insert("agent", agent.as_str());
                    out.insert("skill", skill.as_str());
                    // The slot's argument is the agent and the skill: an
                    // `agent` or `skill` of the body's own (E1301) never
                    // takes their place.
                    for (k, x) in m.iter() {
                        if matches!(k, "op" | "slot" | "agent" | "skill") {
                            continue;
                        }
                        out.insert(k, self.node(x, &sub(path, k), &sub(pp, k), scope, d1));
                    }
                    return Value::Object(out);
                }
            }
            "effect" => {
                if let Some(b) = name.and_then(|s| self.binding(s))
                    && let Bound::Effect(e) = &b.bound
                {
                    self.arg(path, b, false);
                    self.body_members(path, pp, v, &["name"]);
                    let mut out = Map::new();
                    for (k, x) in m.iter() {
                        let value = match k {
                            "name" => Value::from(e.as_str()),
                            "op" | "compensate" => x.clone(),
                            _ => self.node(x, &sub(path, k), &sub(pp, k), scope, d1),
                        };
                        out.insert(k, value);
                    }
                    return Value::Object(out);
                }
            }
            "verify" => {
                let contract = v
                    .get("contract")
                    .and_then(Value::as_str)
                    .and_then(|s| self.binding(s))
                    .and_then(|b| match &b.bound {
                        Bound::Contract(c) => Some((b, c.clone())),
                        _ => None,
                    });
                if let Some((b, _)) = contract {
                    self.arg(path, b, false);
                    self.body_members(path, pp, v, &["contract"]);
                }
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let at = sub(path, k);
                    let value = match k {
                        "op" => x.clone(),
                        "contract" => match &contract {
                            Some((_, c)) => Value::from(c.as_str()),
                            None => x.clone(),
                        },
                        "on_unmet" => {
                            let bind = x.get("bind").and_then(Value::as_str).unwrap_or_default();
                            let inner = Scope::child(scope, vec![bind.to_owned()]);
                            let mut on = Map::new();
                            for (ok, ox) in x.as_object().into_iter().flat_map(Map::iter) {
                                let value = if ok == "then" {
                                    self.node(
                                        ox,
                                        &sub(&at, ok),
                                        &sub(&sub(pp, k), ok),
                                        &inner,
                                        depth.saturating_add(2),
                                    )
                                } else {
                                    ox.clone()
                                };
                                on.insert(ok, value);
                            }
                            Value::Object(on)
                        }
                        _ => self.node(x, &at, &sub(pp, k), scope, d1),
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            "map" => {
                let bind = v.get("bind").and_then(Value::as_str).unwrap_or_default();
                let inner = Scope::child(scope, vec![bind.to_owned()]);
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let at = sub(path, k);
                    let value = match k {
                        "op" | "bind" => x.clone(),
                        "max" | "par" => match x.as_str().and_then(|s| self.binding(s)) {
                            Some(b) => match &b.bound {
                                Bound::Const { count: Some(n), .. } => {
                                    self.arg(&at, b, false);
                                    Value::Number(mandate_ir::Int::saturating(*n))
                                }
                                _ => x.clone(),
                            },
                            None => x.clone(),
                        },
                        "caps" => self.node(x, &at, &sub(pp, k), &inner, d1),
                        "body" => self.block(
                            x.as_array().unwrap_or_default(),
                            &at,
                            &sub(pp, k),
                            &inner,
                            d1,
                        ),
                        _ => self.node(x, &at, &sub(pp, k), scope, d1),
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            "block" => {
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let value = if k == "body" {
                        self.block(
                            x.as_array().unwrap_or_default(),
                            &sub(path, k),
                            &sub(pp, k),
                            scope,
                            d1,
                        )
                    } else {
                        x.clone()
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            "if" | "loop" => {
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let at = sub(path, k);
                    let value = match k {
                        "op" | "max_iter" => x.clone(),
                        "then" | "else" | "body" => self.block(
                            x.as_array().unwrap_or_default(),
                            &at,
                            &sub(pp, k),
                            scope,
                            d1,
                        ),
                        _ => self.node(x, &at, &sub(pp, k), scope, d1),
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            "switch" => {
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let at = sub(path, k);
                    let value = if k == "cases" {
                        let cases = x.as_array().unwrap_or_default();
                        let mut new_cases = Vec::with_capacity(cases.len());
                        for (i, c) in cases.iter().enumerate() {
                            let mut binds = Vec::new();
                            pattern_binds(c.get("pattern"), &mut binds);
                            let inner = Scope::child(scope, binds);
                            let cat = format!("{at}/{i}");
                            let cpp = format!("{}/{i}", sub(pp, k));
                            let mut nc = Map::new();
                            for (ck, cx) in c.as_object().into_iter().flat_map(Map::iter) {
                                let value = if ck == "then" {
                                    self.node(
                                        cx,
                                        &sub(&cat, ck),
                                        &sub(&cpp, ck),
                                        &inner,
                                        depth.saturating_add(3),
                                    )
                                } else {
                                    cx.clone()
                                };
                                nc.insert(ck, value);
                            }
                            new_cases.push(Value::Object(nc));
                        }
                        Value::Array(new_cases)
                    } else if k == "op" {
                        x.clone()
                    } else {
                        self.node(x, &at, &sub(pp, k), scope, d1)
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            "on_error" => {
                let mut binds = Vec::new();
                pattern_binds(v.get("pattern"), &mut binds);
                let inner = Scope::child(scope, binds);
                let mut out = Map::new();
                for (k, x) in m.iter() {
                    let value = if k == "then" {
                        self.node(x, &sub(path, k), &sub(pp, k), &inner, d1)
                    } else {
                        x.clone()
                    };
                    out.insert(k, value);
                }
                return Value::Object(out);
            }
            _ => {}
        }
        // Every other statement and expression, member by member; names and
        // tags are copied.
        let keep: &[&str] = match op {
            "let" => &["op", "name"],
            "record" => &["op", "type"],
            "spawn" | "plan" => &["op", "agent", "skill"],
            "delegate" => &["op", "agent", "skill", "slot"],
            "effect" => &["op", "name", "compensate"],
            "par" => &["op"],
            "changeset" => &["op", "order", "changes", "approver"],
            "run" => &["op", "expect"],
            _ => &["op"],
        };
        self.members(m, path, pp, scope, depth, keep)
    }
}

/// `{ op: "var", name }`.
fn var(name: &str) -> Value {
    let mut m = Map::new();
    m.insert("op", "var");
    m.insert("name", name);
    Value::Object(m)
}
