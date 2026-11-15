//! The arguments of an application (spec/library.md "Application",
//! "Slots"): each slot has exactly one, of its kind (E1304), that fits its
//! signature (E1305), and none names a pattern (E1307). An argument means
//! what it means in the applying program: its names are looked up among
//! the program's own definitions and the names its `use` lists bring.
//!
//! The fit is that of "how a value is known" (spec/core.md §2.1): a slot's
//! parameter type is accepted where the argument's parameter is expected,
//! and the argument's result where the slot's is (`crate::ty::assignable`).
//! Whatever it accepts is checked again in the expansion, as written code.

use mandate_ir::{
    ConnectorDef, DefKind, Definition, Expr, ExprOp, JsObject, JsValue, Map, Program, SlotArg,
    TypeExpr, Value,
};

use super::pattern::{Problem, builtin_type};
use super::subst::{substitute_type, type_ref};
use crate::caps::{CapOptions, caps_of, show_cap};
use crate::stdlib::std_effect;
use crate::ty::{Ty, TypeEnv, assignable, fields_of, from_type_expr, show, ty_of};

/// What a slot is given, once its argument is read by the slot's kind.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Bound {
    /// A type.
    Type(Value),
    /// `Agent.skill`.
    Skill {
        /// The agent.
        agent: String,
        /// Its skill.
        skill: String,
    },
    /// A read-only tool `c.t`, the callee of its calls.
    Tool(Value),
    /// An effect's name: a user effect, a std effect, or a write tool `c.t`.
    Effect(String),
    /// A contract's name.
    Contract(String),
    /// A role's name.
    Role(String),
    /// A capability's name.
    Capability(String),
    /// A constant expression, and its whole number when it is one of at
    /// least 1 (what a map's `max` or `par` takes).
    Const {
        /// The expression.
        value: Value,
        /// The number.
        count: Option<i64>,
    },
    /// A field's name.
    Field(String),
}

/// A slot and what it is given.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Binding {
    /// The slot's name.
    pub(crate) slot: String,
    /// What it is given.
    pub(crate) bound: Bound,
    /// The argument's path in the applying program.
    pub(crate) at: String,
    /// The names of values the expansion writes for it, which a name the
    /// body binds around a use of the slot would capture.
    pub(crate) names: Vec<String>,
}

/// The applying program's names: its own definitions, and those its `use`
/// lists bring, as linked.
pub(crate) struct Names<'a> {
    pub(crate) program: Program<'a>,
    pub(crate) linked: &'a Map,
}

impl<'a> Names<'a> {
    /// The definition `name` stands for in the program, when it is one.
    pub(crate) fn def(&self, name: &str) -> Option<&'a Value> {
        if let Some(d) = self.program.defs().and_then(|d| d.get(name)) {
            return Some(d);
        }
        let listed = self
            .program
            .imports()
            .any(|u| u.module() != Some("std") && u.names().any(|n| n == name));
        if listed { self.linked.get(name) } else { None }
    }

    /// The kind of the definition `name` stands for.
    pub(crate) fn kind(&self, name: &str) -> Option<DefKind> {
        self.def(name).and_then(|d| Definition::of(d).kind())
    }
}

/// Type definitions and contracts in two tables, the first first: the
/// applying program's linked definitions, then the pattern's home's.
pub(crate) struct Env<'a> {
    pub(crate) first: &'a Map,
    pub(crate) second: &'a Map,
}

impl TypeEnv for Env<'_> {
    fn type_def(&self, name: &str) -> Option<&Value> {
        let is_type = |d: &&Value| Definition::of(d).kind() == Some(DefKind::Type);
        self.first
            .get(name)
            .filter(is_type)
            .or_else(|| self.second.get(name).filter(is_type))
    }

    fn is_contract(&self, name: &str) -> bool {
        let is = |m: &Map| {
            m.get(name)
                .is_some_and(|d| Definition::of(d).kind() == Some(DefKind::Contract))
        };
        is(self.first) || is(self.second)
    }
}

/// `a`, `a.b`, `a.b.c`: the dotted name an expression of names and fields
/// is.
pub(crate) fn dotted(e: Expr<'_>) -> Option<String> {
    match e.op()? {
        ExprOp::Var => e.name().map(str::to_owned),
        ExprOp::Field => {
            let of = dotted(e.operand()?)?;
            Some(format!("{of}.{}", e.name()?))
        }
        _ => None,
    }
}

/// The root name of a chain of names, fields and calls.
pub(crate) fn root_name(e: Expr<'_>) -> Option<&str> {
    match e.op()? {
        ExprOp::Var => e.name(),
        ExprOp::Field => root_name(e.operand()?),
        ExprOp::Call => root_name(e.callee()?),
        _ => None,
    }
}

/// Every name of a value an expression reads, each once.
pub(crate) fn value_names(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| value_names(x, out)),
        Value::Object(m) => {
            if v.get("op").and_then(Value::as_str) == Some("var")
                && let Some(n) = v.get("name").and_then(Value::as_str)
                && !out.iter().any(|x| x == n)
            {
                out.push(n.to_owned());
            }
            for (_, x) in m.iter() {
                value_names(x, out);
            }
        }
        _ => {}
    }
}

/// The type of a constant expression and, when it is a whole number, the
/// number: a literal, the negation of one, or the name of a constant of the
/// program, followed through other constants (at most 16). `None` for an
/// expression that is no constant.
pub(crate) fn constant(e: &Value, names: &Names<'_>, depth: usize) -> Option<(Value, Option<i64>)> {
    if depth > 16 {
        return None;
    }
    let t = |r: &str| {
        let mut m = Map::new();
        m.insert("ref", r);
        Value::Object(m)
    };
    match e.get("op").and_then(Value::as_str)? {
        "int" => Some((t("Int"), e.get("value").and_then(Value::as_i64))),
        "dec" => Some((t("Dec"), None)),
        "text" => Some((t("Text"), None)),
        "bool" => Some((t("Bool"), None)),
        "money" => Some((t("Money"), None)),
        "duration" => Some((t("Duration"), None)),
        "unary" => {
            let (ty, n) = constant(e.get("of")?, names, depth.saturating_add(1))?;
            match e.get("uop").and_then(Value::as_str)? {
                "neg" if ty.get("ref").and_then(Value::as_str) != Some("Bool") => {
                    Some((ty, n.map(i64::saturating_neg)))
                }
                "not" if ty.get("ref").and_then(Value::as_str) == Some("Bool") => Some((ty, None)),
                _ => None,
            }
        }
        "var" => {
            let n = e.get("name").and_then(Value::as_str)?;
            let d = names
                .def(n)
                .filter(|d| Definition::of(d).kind() == Some(DefKind::Const))?;
            let (inner, count) = constant(d.get("value")?, names, depth.saturating_add(1))?;
            Some((d.get("type").cloned().unwrap_or(inner), count))
        }
        _ => None,
    }
}

/// The deepest a structured constant is followed: lists in lists, records
/// in records and constants naming constants, together.
const STRUCTURED_DEPTH: usize = 64;

/// Whether `e` is a structured constant (0.6): a list, a set or a record
/// literal, or the name of a constant of the program whose value is one.
/// Whether its parts are constants of the slot's type is
/// [`Reader::value_fits`]'s.
pub(crate) fn structured(e: &Value, names: &Names<'_>) -> bool {
    match e.get("op").and_then(Value::as_str) {
        Some("list" | "set" | "record") => true,
        Some("var") => e
            .get("name")
            .and_then(Value::as_str)
            .and_then(|n| names.def(n))
            .filter(|d| Definition::of(d).kind() == Some(DefKind::Const))
            .and_then(|d| d.get("value"))
            .is_some_and(|v| {
                matches!(
                    v.get("op").and_then(Value::as_str),
                    Some("list" | "set" | "record")
                )
            }),
        _ => false,
    }
}

/// What reading the arguments of one application gives.
pub(crate) struct Read {
    /// Each slot that has an argument of its kind, with what it is given.
    pub(crate) bindings: Vec<Binding>,
    /// The type arguments, by type parameter, each with its path.
    pub(crate) types: Vec<(String, Value, String)>,
    /// What does not hold, at paths in the applying program.
    pub(crate) problems: Vec<Problem>,
}

/// The context of reading one application's arguments.
pub(crate) struct Reader<'a> {
    /// The applying workflow's path, `/defs/W`.
    pub(crate) base: String,
    /// The pattern's name.
    pub(crate) pattern: &'a str,
    /// The program's names.
    pub(crate) names: Names<'a>,
    /// Types and contracts, the program's and the pattern's home's.
    pub(crate) env: Env<'a>,
    /// How capabilities are read.
    pub(crate) opts: CapOptions,
    /// The const slots a map's `max` or `par` reads.
    pub(crate) counted: Vec<String>,
}

impl Reader<'_> {
    /// Whether the constant `e` is a value of `want` (0.6), part by part: a
    /// list or a set of values of its element type, a record literal of a
    /// record type with exactly its fields, each of its field's type, a
    /// literal of a type accepted where `want` is expected (a text literal
    /// as a `Path` by the rule of paths), or a constant the program defines
    /// whose declared type is accepted there (or whose value fits, when it
    /// declares none). Anything else is no constant: a call, a field read,
    /// a name that is not a constant (an agent, an effect, a tool, a role, a
    /// capability), so a value slot brings no authority (INV-21). The
    /// reason, for the message, when it does not fit.
    pub(crate) fn value_fits(&self, e: &Value, want: &Ty, depth: usize) -> Result<(), String> {
        if depth > STRUCTURED_DEPTH {
            return Err(format!("it is nested deeper than {STRUCTURED_DEPTH}"));
        }
        let deeper = depth.saturating_add(1);
        let want = crate::ty::unalias(want, &self.env);
        match e.get("op").and_then(Value::as_str).unwrap_or_default() {
            op @ ("list" | "set") => {
                let collection = if op == "list" { "List" } else { "Set" };
                if !want.is_named(collection) {
                    return Err(format!("a {op} is no {}", show(&want)));
                }
                let element = want.arg(0);
                for (i, item) in e
                    .get("items")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .enumerate()
                {
                    self.value_fits(item, &element, deeper)
                        .map_err(|why| format!("item {i}: {why}"))?;
                }
                Ok(())
            }
            "record" => {
                let written = e.get("type").and_then(Value::as_str).unwrap_or_default();
                if let Some(n) = want.name()
                    && n != written
                {
                    return Err(format!("a record {written} is no {}", show(&want)));
                }
                let Some(fields) = fields_of(&want, &self.env) else {
                    return Err(format!("{} has no fields", show(&want)));
                };
                let given = e.get("fields").and_then(Value::as_object);
                let given_names: Vec<&str> = given.map(|g| g.keys().collect()).unwrap_or_default();
                for (f, _) in &fields {
                    if !given_names.contains(&f.as_str()) {
                        return Err(format!("it has no field {f}"));
                    }
                }
                for g in &given_names {
                    if !fields.iter().any(|(f, _)| f == g) {
                        return Err(format!("{} has no field {g}", show(&want)));
                    }
                }
                for (f, ty) in &fields {
                    if let Some(v) = given.and_then(|g| g.get(f)) {
                        self.value_fits(v, ty, deeper)
                            .map_err(|why| format!("field {f}: {why}"))?;
                    }
                }
                Ok(())
            }
            "var" => {
                let n = e.get("name").and_then(Value::as_str).unwrap_or_default();
                let Some(d) = self
                    .names
                    .def(n)
                    .filter(|d| Definition::of(d).kind() == Some(DefKind::Const))
                else {
                    return Err(format!("{n} is no constant"));
                };
                match d.get("type") {
                    Some(t) => match assignable(&ty_of(TypeExpr::of(t)), &want, &self.env) {
                        Some(p) => Err(p.message),
                        None => Ok(()),
                    },
                    None => self.value_fits(d.get("value").unwrap_or(&Value::Null), &want, deeper),
                }
            }
            "text" => {
                let lit = e.get("value").and_then(Value::as_str).map(str::to_owned);
                let ty = Ty::named_lit("Text", Vec::new(), lit);
                assignable(&ty, &want, &self.env).map_or(Ok(()), |p| Err(p.message))
            }
            _ => match constant(e, &self.names, deeper) {
                Some((ty, _)) => assignable(&ty_of(TypeExpr::of(&ty)), &want, &self.env)
                    .map_or(Ok(()), |p| Err(p.message)),
                None => Err(
                    "it is no constant: a literal, or a constant the program defines".to_owned(),
                ),
            },
        }
    }

    fn problem(&self, code: &'static str, message: String, at: &str, facts: JsObject) -> Problem {
        Problem::new(code, message, at, facts.with("pattern", self.pattern))
    }

    /// Reads the type arguments and the slot arguments of `apply` against
    /// the pattern's type parameters `generics` and slots `slots` (each
    /// slot's value, in order).
    pub(crate) fn read(
        &self,
        apply: mandate_ir::Application<'_>,
        generics: &[&str],
        slots: &[&Value],
    ) -> Read {
        let mut out = Read {
            bindings: Vec::new(),
            types: Vec::new(),
            problems: Vec::new(),
        };
        let at = format!("{}/apply", self.base);
        let given = apply.types();
        if given.len() != generics.len() {
            let path = if apply.members().get("types").is_some() {
                format!("{at}/types")
            } else {
                format!("{at}/pattern")
            };
            out.problems.push(
                self.problem(
                    "E1304",
                    format!(
                        "{} takes {} type arguments, and {} are given; 0.6 does not infer them.",
                        self.pattern,
                        generics.len(),
                        given.len()
                    ),
                    &path,
                    JsObject::new()
                        .with("problem", "type_arguments")
                        .with("expected", generics.len())
                        .with("given", given.len()),
                ),
            );
            // The slots' signatures cannot be read without them.
            return out;
        }
        for (i, (g, t)) in generics.iter().zip(given).enumerate() {
            out.types
                .push(((*g).to_owned(), t.clone(), format!("{at}/types/{i}")));
        }
        let args = apply.arg_values();
        let slot_names: Vec<&str> = slots
            .iter()
            .map(|s| s.get("name").and_then(Value::as_str).unwrap_or_default())
            .collect();
        for (i, a) in args.iter().enumerate() {
            let n = a.get("name").and_then(Value::as_str).unwrap_or_default();
            if !slot_names.contains(&n) {
                out.problems.push(
                    self.problem(
                        "E1304",
                        format!("{} has no slot {n}.", self.pattern),
                        &format!("{at}/args/{i}/name"),
                        JsObject::new()
                            .with("problem", "no_slot")
                            .with("slot", n)
                            .with(
                                "slots",
                                slot_names
                                    .iter()
                                    .map(|s| JsValue::from(*s))
                                    .collect::<Vec<_>>(),
                            ),
                    ),
                );
            }
        }
        let mut reading: Vec<(&Value, &str, SlotArg<'_>, String)> = Vec::new();
        for slot in slots {
            let name = slot.get("name").and_then(Value::as_str).unwrap_or_default();
            let given: Vec<usize> = args
                .iter()
                .enumerate()
                .filter(|(_, a)| a.get("name").and_then(Value::as_str) == Some(name))
                .map(|(i, _)| i)
                .collect();
            let Some((&first, rest)) = given.split_first() else {
                out.problems.push(
                    self.problem(
                        "E1304",
                        format!("The slot {name} of {} is given no argument.", self.pattern),
                        &format!("{at}/args"),
                        JsObject::new()
                            .with("problem", "missing")
                            .with("slot", name),
                    ),
                );
                continue;
            };
            for &again in rest {
                out.problems.push(self.problem(
                    "E1304",
                    format!("The slot {name} of {} is given twice.", self.pattern),
                    &format!("{at}/args/{again}/name"),
                    JsObject::new().with("problem", "twice").with("slot", name),
                ));
            }
            let Some(arg) = args.get(first).and_then(SlotArg::of) else {
                continue;
            };
            reading.push((slot, name, arg, format!("{at}/args/{first}")));
        }
        // The `type` and `contract` slots first: the other slots'
        // signatures name them (`skill(T) -> page`, `Verified<Out,
        // accepted>`), and are read with what they are given.
        let early = |s: &Value| {
            matches!(
                s.get("kind").and_then(Value::as_str),
                Some("type" | "contract")
            )
        };
        let mut named = out.types.clone();
        for pass in [true, false] {
            // A signature that names a slot whose argument does not hold is
            // not read with it.
            if !pass && !out.problems.is_empty() {
                break;
            }
            for (slot, name, arg, path) in &reading {
                if early(slot) != pass {
                    continue;
                }
                match self.bind(slot, name, *arg, path, &named) {
                    Ok(b) => {
                        let written = match &b.bound {
                            Bound::Type(t) => Some(t.clone()),
                            Bound::Contract(c) => Some(type_ref(c)),
                            _ => None,
                        };
                        if let Some(t) = written {
                            named.push(((*name).to_owned(), t, b.at.clone()));
                        }
                        out.bindings.push(b);
                    }
                    Err(p) => out.problems.push(p),
                }
            }
        }
        out
    }

    /// One slot's argument, read by the slot's kind.
    fn bind(
        &self,
        slot: &Value,
        name: &str,
        arg: SlotArg<'_>,
        at: &str,
        types: &[(String, Value, String)],
    ) -> Result<Binding, Problem> {
        let kind = slot.get("kind").and_then(Value::as_str).unwrap_or_default();
        let value_at = if arg.members().get("type").is_some() {
            format!("{at}/type")
        } else {
            format!("{at}/value")
        };
        let other = |expected: &str, why: String| {
            self.problem(
                "E1304",
                format!(
                    "The slot {name} of {} is {} {kind} slot, which takes {expected}; {why}.",
                    self.pattern,
                    super::pattern::article(kind)
                ),
                &value_at,
                JsObject::new()
                    .with("problem", "kind")
                    .with("slot", name)
                    .with("kind", kind),
            )
        };
        // A pattern is applied only as the definition of a workflow, never
        // as an argument (E1307).
        if let Some(root) = arg.value().and_then(root_name)
            && self.names.kind(root) == Some(DefKind::Pattern)
        {
            return Err(self.problem(
                "E1307",
                format!(
                    "The slot {name} of {} is given the pattern {root}: a pattern is applied only as the definition of a workflow.",
                    self.pattern
                ),
                &value_at,
                JsObject::new()
                    .with("problem", "argument")
                    .with("slot", name)
                    .with("applies", root),
            ));
        }
        let qname = arg.value().and_then(dotted);
        let binding = |bound: Bound, names: Vec<String>| Binding {
            slot: name.to_owned(),
            bound,
            at: value_at.clone(),
            names,
        };
        let signature = |key: &str| -> Vec<Value> {
            slot.get(key)
                .and_then(Value::as_array)
                .unwrap_or_default()
                .iter()
                .map(|t| substitute_type(t, types))
                .collect()
        };
        let result = || slot.get("returns").map(|t| substitute_type(t, types));
        match kind {
            "type" => {
                if let Some(t) = arg.members().get("type") {
                    return Ok(binding(Bound::Type(t.clone()), Vec::new()));
                }
                let Some(q) = qname else {
                    return Err(other("a type", "this is no type's name".to_owned()));
                };
                let is_type = builtin_type(&q) || self.names.kind(&q) == Some(DefKind::Type);
                if !is_type {
                    return Err(other("a type", format!("{q} names no type")));
                }
                Ok(binding(Bound::Type(type_ref(&q)), Vec::new()))
            }
            "skill" => {
                let pair = arg.value().and_then(agent_skill);
                let Some((agent, skill)) = pair else {
                    return Err(other("a skill Agent.skill", "this is none".to_owned()));
                };
                let Some(a) = self
                    .names
                    .def(&agent)
                    .filter(|d| Definition::of(d).kind() == Some(DefKind::Agent))
                else {
                    return Err(other("a skill Agent.skill", format!("{agent} is no agent")));
                };
                let Some(s) = Definition::of(a).skill(&skill) else {
                    return Err(other(
                        "a skill Agent.skill",
                        format!("{agent} has no skill {skill}"),
                    ));
                };
                let params: Vec<Value> = s
                    .get("params")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|p| p.get("type").cloned())
                    .collect();
                self.fit_signature(
                    name,
                    &value_at,
                    &signature("params"),
                    result().as_ref(),
                    &params,
                    s.get("returns"),
                )?;
                if slot.get("read_only") == Some(&Value::Bool(true)) {
                    for c in Definition::of(a).caps().iter().filter_map(Expr::of) {
                        for cap in caps_of(self.names.linked, c, self.opts) {
                            if cap.write() {
                                return Err(self.problem(
                                    "E1305",
                                    format!(
                                        "The slot {name} of {} takes the skill of an agent that holds no write capability, and {agent} holds {}.",
                                        self.pattern,
                                        show_cap(&cap)
                                    ),
                                    &value_at,
                                    JsObject::new()
                                        .with("problem", "read_only")
                                        .with("slot", name)
                                        .with("agent", agent.as_str())
                                        .with("capability", show_cap(&cap)),
                                ));
                            }
                        }
                    }
                }
                Ok(binding(Bound::Skill { agent, skill }, Vec::new()))
            }
            "tool" => {
                let Some((c, t)) = arg.value().and_then(agent_skill) else {
                    return Err(other("a read-only tool c.t", "this is none".to_owned()));
                };
                let Some(conn) = self.names.def(&c).and_then(ConnectorDef::of) else {
                    return Err(other(
                        "a read-only tool c.t",
                        format!("{c} is no connector"),
                    ));
                };
                let Some(tool) = conn.tool(&t) else {
                    return Err(other(
                        "a read-only tool c.t",
                        format!("{c} has no tool {t}"),
                    ));
                };
                if tool.is_write() {
                    return Err(other(
                        "a read-only tool c.t",
                        format!(
                            "{c}.{t} writes, and a tool that writes is given to an effect slot"
                        ),
                    ));
                }
                let params: Vec<Value> = tool
                    .params()
                    .iter()
                    .filter_map(|p| p.get("type").cloned())
                    .collect();
                let returns = tool.members().get("returns");
                self.fit_signature(
                    name,
                    &value_at,
                    &signature("params"),
                    result().as_ref(),
                    &params,
                    returns,
                )?;
                let callee = arg.members().get("value").cloned().unwrap_or(Value::Null);
                Ok(binding(Bound::Tool(callee), vec![c]))
            }
            "effect" => {
                let Some(q) = qname else {
                    return Err(other("an effect", "this is no effect's name".to_owned()));
                };
                // A write tool of a connector, c.t, before any other reading.
                if let Some((c, t)) = q.split_once('.')
                    && !t.contains('.')
                    && let Some(conn) = self.names.def(c).and_then(ConnectorDef::of)
                {
                    let Some(tool) = conn.tool(t) else {
                        return Err(other("an effect", format!("{c} has no tool {t}")));
                    };
                    if !tool.is_write() {
                        return Err(other(
                            "an effect",
                            format!("{q} is a read-only tool, which is given to a tool slot"),
                        ));
                    }
                    let key = tool.idempotency_key();
                    let params: Vec<Value> = tool
                        .params()
                        .iter()
                        .filter(|p| p.get("name").and_then(Value::as_str) != key || key.is_none())
                        .filter_map(|p| p.get("type").cloned())
                        .collect();
                    let returns = tool.members().get("returns");
                    self.fit_signature(
                        name,
                        &value_at,
                        &signature("params"),
                        result().as_ref(),
                        &params,
                        returns,
                    )?;
                    return Ok(binding(Bound::Effect(q), Vec::new()));
                }
                if let Some(d) = self
                    .names
                    .def(&q)
                    .filter(|d| Definition::of(d).kind() == Some(DefKind::Effect))
                {
                    let params: Vec<Value> = Definition::of(d)
                        .params()
                        .iter()
                        .filter_map(|p| p.get("type").cloned())
                        .collect();
                    self.fit_signature(
                        name,
                        &value_at,
                        &signature("params"),
                        result().as_ref(),
                        &params,
                        d.get("returns"),
                    )?;
                    return Ok(binding(Bound::Effect(q), Vec::new()));
                }
                if self.names.def(&q).is_none()
                    && let Some(e) = std_effect(&q)
                {
                    let params: Vec<Value> = e.params.iter().map(|p| p.to_value()).collect();
                    let returns = e.returns.to_value();
                    self.fit_signature(
                        name,
                        &value_at,
                        &signature("params"),
                        result().as_ref(),
                        &params,
                        Some(&returns),
                    )?;
                    return Ok(binding(Bound::Effect(q), Vec::new()));
                }
                Err(other("an effect", format!("{q} names no effect")))
            }
            "contract" | "role" | "capability" => {
                let want = match kind {
                    "contract" => DefKind::Contract,
                    "role" => DefKind::Role,
                    _ => DefKind::Capability,
                };
                let simple = arg
                    .value()
                    .filter(|e| e.is(ExprOp::Var))
                    .and_then(Expr::name);
                let Some(n) = simple.filter(|n| self.names.kind(n) == Some(want)) else {
                    let a = if kind == "role" { "a role" } else { "a" };
                    let what = if kind == "role" {
                        String::new()
                    } else {
                        format!(" {kind}")
                    };
                    return Err(other(
                        &format!("{a}{what} the program defines or imports"),
                        format!("{} is none", qname.as_deref().unwrap_or("this")),
                    ));
                };
                if kind == "contract" {
                    let d = self.names.def(n);
                    let params: Vec<Value> = d
                        .map(|d| Definition::of(d).params())
                        .unwrap_or_default()
                        .iter()
                        .filter_map(|p| p.get("type").cloned())
                        .collect();
                    self.fit_signature(name, &value_at, &signature("params"), None, &params, None)?;
                    return Ok(binding(Bound::Contract(n.to_owned()), Vec::new()));
                }
                let bound = if kind == "role" {
                    Bound::Role(n.to_owned())
                } else {
                    Bound::Capability(n.to_owned())
                };
                Ok(binding(bound, vec![n.to_owned()]))
            }
            "const" => {
                let Some(e) = arg.members().get("value") else {
                    return Err(other("a constant expression", "a type is none".to_owned()));
                };
                let want = slot.get("type").map(|t| substitute_type(t, types));
                // 0.6: a list, a set or a record of constants, or a constant
                // that is one, held to the slot's type part by part
                // (`value_fits`): a value a sub-program's workflow, which
                // takes no parameters, hands its pattern.
                if constant(e, &self.names, 0).is_none()
                    && !self.counted.iter().any(|c| c == name)
                    && let Some(want) = &want
                    && structured(e, &self.names)
                {
                    let w = ty_of(TypeExpr::of(want));
                    if let Err(why) = self.value_fits(e, &w, 0) {
                        return Err(self.problem(
                            "E1305",
                            format!(
                                "The slot {name} of {} takes a constant of type {}, and is given one that is not: {why}",
                                self.pattern,
                                show(&w),
                            ),
                            &value_at,
                            JsObject::new()
                                .with("problem", "type")
                                .with("slot", name)
                                .with("expected", show(&w))
                                .with("why", why.as_str()),
                        ));
                    }
                    let mut names = Vec::new();
                    value_names(e, &mut names);
                    return Ok(binding(
                        Bound::Const {
                            value: e.clone(),
                            count: None,
                        },
                        names,
                    ));
                }
                let Some((ty, count)) = constant(e, &self.names, 0) else {
                    return Err(self.problem(
                        "E1305",
                        format!(
                            "The slot {name} of {} takes a constant: a literal, or a constant the program defines.",
                            self.pattern
                        ),
                        &value_at,
                        JsObject::new().with("problem", "not_constant").with("slot", name),
                    ));
                };
                if let Some(want) = &want {
                    let (a, w) = (ty_of(TypeExpr::of(&ty)), ty_of(TypeExpr::of(want)));
                    if let Some(p) = assignable(&a, &w, &self.env) {
                        return Err(self.problem(
                            "E1305",
                            format!(
                                "The slot {name} of {} takes a constant of type {}, and is given one of type {}: {}",
                                self.pattern,
                                show(&w),
                                show(&a),
                                p.message
                            ),
                            &value_at,
                            JsObject::new()
                                .with("problem", "type")
                                .with("slot", name)
                                .with("expected", show(&w))
                                .with("given", show(&a)),
                        ));
                    }
                }
                let count = count.filter(|n| *n >= 1);
                if self.counted.iter().any(|c| c == name) && count.is_none() {
                    return Err(self.problem(
                        "E1305",
                        format!(
                            "The slot {name} of {} is a map's max or par, which is a whole number of at least 1.",
                            self.pattern
                        ),
                        &value_at,
                        JsObject::new().with("problem", "count").with("slot", name),
                    ));
                }
                let mut names = Vec::new();
                value_names(e, &mut names);
                Ok(binding(
                    Bound::Const {
                        value: e.clone(),
                        count,
                    },
                    names,
                ))
            }
            "field" => {
                let simple = arg
                    .value()
                    .filter(|e| e.is(ExprOp::Var))
                    .and_then(Expr::name);
                let Some(f) = simple else {
                    return Err(other("the name of a field", "this is none".to_owned()));
                };
                let record = slot.get("type").map(|t| substitute_type(t, types));
                let ty = record
                    .as_ref()
                    .and_then(TypeExpr::of)
                    .map_or(crate::ty::Ty::Unknown, |t| from_type_expr(t, &[]));
                let fields = fields_of(&ty, &self.env).unwrap_or_default();
                if !fields.iter().any(|(k, _)| k == f) {
                    return Err(self.problem(
                        "E1305",
                        format!(
                            "The slot {name} of {} takes a field of {}, which has no field {f}.",
                            self.pattern,
                            show(&ty)
                        ),
                        &value_at,
                        JsObject::new()
                            .with("problem", "field")
                            .with("slot", name)
                            .with("type", show(&ty))
                            .with(
                                "fields",
                                fields
                                    .iter()
                                    .map(|(k, _)| JsValue::from(k.as_str()))
                                    .collect::<Vec<_>>(),
                            ),
                    ));
                }
                Ok(binding(Bound::Field(f.to_owned()), Vec::new()))
            }
            _ => Err(other("nothing", format!("{kind} is no slot kind"))),
        }
    }

    /// The fit of a signature: as many parameters; each of the slot's
    /// accepted where the argument's is expected; the argument's result
    /// accepted where the slot's is.
    fn fit_signature(
        &self,
        name: &str,
        at: &str,
        slot_params: &[Value],
        slot_result: Option<&Value>,
        params: &[Value],
        result: Option<&Value>,
    ) -> Result<(), Problem> {
        if slot_params.len() != params.len() {
            return Err(self.problem(
                "E1305",
                format!(
                    "The slot {name} of {} takes {} parameters, and its argument takes {}.",
                    self.pattern,
                    slot_params.len(),
                    params.len()
                ),
                at,
                JsObject::new()
                    .with("problem", "arity")
                    .with("slot", name)
                    .with("expected", slot_params.len())
                    .with("given", params.len()),
            ));
        }
        for (i, (s, p)) in slot_params.iter().zip(params).enumerate() {
            let (given, expected) = (ty_of(TypeExpr::of(s)), ty_of(TypeExpr::of(p)));
            if let Some(why) = assignable(&given, &expected, &self.env) {
                return Err(self.problem(
                    "E1305",
                    format!(
                        "Parameter {} of the slot {name} of {} is {}, which its argument does not accept where it expects {}: {}",
                        i.saturating_add(1),
                        self.pattern,
                        show(&given),
                        show(&expected),
                        why.message
                    ),
                    at,
                    JsObject::new()
                        .with("problem", "parameter")
                        .with("slot", name)
                        .with("index", i)
                        .with("slot_type", show(&given))
                        .with("argument_type", show(&expected)),
                ));
            }
        }
        if let (Some(s), Some(r)) = (slot_result, result) {
            let (expected, given) = (ty_of(TypeExpr::of(s)), ty_of(TypeExpr::of(r)));
            if let Some(why) = assignable(&given, &expected, &self.env) {
                return Err(self.problem(
                    "E1305",
                    format!(
                        "The slot {name} of {} gives {}, and its argument gives {}: {}",
                        self.pattern,
                        show(&expected),
                        show(&given),
                        why.message
                    ),
                    at,
                    JsObject::new()
                        .with("problem", "result")
                        .with("slot", name)
                        .with("slot_type", show(&expected))
                        .with("argument_type", show(&given)),
                ));
            }
        }
        Ok(())
    }
}

/// `A.b` of `{ op: "field", of: { op: "var", name: A }, name: b }`.
fn agent_skill(e: Expr<'_>) -> Option<(String, String)> {
    if !e.is(ExprOp::Field) {
        return None;
    }
    let of = e.operand().filter(|o| o.is(ExprOp::Var))?;
    Some((of.name()?.to_owned(), e.name()?.to_owned()))
}
