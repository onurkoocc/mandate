//! The Managed Agents executor binding (BACKLOG item 39; decisions K45–K47,
//! K79, K80): a port of `compiler/src/target/managed-agents.ts`. A program
//! whose agents run as Claude Managed Agents sessions records what they were
//! deployed as in its lock file, under `bindings["managed-agents"]`. The lock
//! is part of the package hash, so the binding is part of what a person
//! approves (INV-02): the deployed agents and their pinned versions, the
//! environment, the session fee that prices a session's running time, and
//! the guarantee profile the executor gives.
//!
//! The checks here need only the program and the lock ([`binding_checks`]);
//! `ValidateBinding` in the runtime compares the binding with what the
//! service reports before every run.
//!
//! One oddity of the TypeScript is carried: the profile table is a plain
//! object, read with `MA_BRIDGE_PROFILE[g]` and no `Object.hasOwn`, so a
//! guarantee named like a member of `Object.prototype` (`constructor`,
//! `toString`, `__proto__`, …) has a "real" level that is a function or an
//! object, ranked 0, and written into the message as `String` writes it.

use mandate_ir::{
    DefKind, Definition, Diagnostic, Expr, ExprOp, JsObject, JsValue, Location, Program, Spans,
    Value, compare_utf16, sort_utf16, unique_in_order,
};

use crate::caps::{CapOptions, CapVal, cap_from_call};
use crate::lock::{Lock, js_less};
use crate::modules::object_prototype_text;
use crate::stdlib::{DEFAULT_MODEL_MAX_CLASS, DataClass, class_rank};

/// The format of the binding: `MA_BINDING_FORMAT`.
pub const MA_BINDING_FORMAT: &str = "mandate/binding/managed-agents/0.1";

/// The beta the binding was deployed under; a binding for another beta is
/// refused, not translated: `MA_BETA`.
pub const MA_BETA: &str = "managed-agents-2026-04-01";

/// The highest data class an agent bound to a cloud executor may send to its
/// model (K46): `MA_MAX_CLASS`.
pub const MA_MAX_CLASS: DataClass = DataClass::Internal;

/// How a guarantee holds on an executor (design doc 10 §4): `ProfileLevel`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ProfileLevel {
    /// `full`.
    Full,
    /// `partial`.
    Partial,
    /// `none`.
    None,
}

impl ProfileLevel {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ProfileLevel::Full => "full",
            ProfileLevel::Partial => "partial",
            ProfileLevel::None => "none",
        }
    }
}

/// The guarantee profile of a bridge binding, by guarantee, in the order of
/// `MA_BRIDGE_PROFILE`. It is written into the binding, so a person approves
/// it with the package, and checked against this table: a binding that claims
/// more than this implementation gives is refused (E0903).
pub const MA_BRIDGE_PROFILE: [(&str, ProfileLevel); 17] = [
    ("package.identity", ProfileLevel::Full),
    ("static.checks", ProfileLevel::Full),
    ("caps.paths_commands", ProfileLevel::Full),
    ("caps.network", ProfileLevel::Full),
    ("parallel.isolation", ProfileLevel::Full),
    ("model.pinning", ProfileLevel::Full),
    ("model.max_class", ProfileLevel::Partial),
    ("budget.tokens_spend", ProfileLevel::Full),
    ("budget.steps", ProfileLevel::Full),
    ("budget.time", ProfileLevel::Full),
    ("loop.progress", ProfileLevel::Full),
    ("journal.turns", ProfileLevel::Full),
    ("replay.no_adapter", ProfileLevel::Full),
    ("evidence.verifier", ProfileLevel::Full),
    ("effects.prepare_authorize_commit", ProfileLevel::Full),
    ("credentials.control_plane", ProfileLevel::Full),
    ("cancel", ProfileLevel::Partial),
];

/// `rank(level)`: the order of the levels, `0` for anything else.
fn rank(level: Option<&str>) -> u8 {
    match level {
        Some("full") => 2,
        Some("partial") => 1,
        _ => 0,
    }
}

/// The model tiers an agent may call, and the highest data class it may send
/// them: `agentModels`' result.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AgentModels {
    /// The tiers, each once, sorted.
    pub tiers: Vec<String>,
    /// The highest class any of its model capabilities may receive, `public`
    /// when it has none.
    pub max_class: DataClass,
}

/// The capabilities an agent declares, opened up through capability
/// definitions: `agentCaps`. The TypeScript recurses without a guard, so a
/// capability definition that names itself overflows its stack; the checks
/// that run before the lock checks refuse such a program, and here the cycle
/// is nothing.
fn agent_caps(program: Program<'_>, agent: Definition<'_>) -> Vec<CapVal> {
    fn resolve(program: Program<'_>, e: Expr<'_>, seen: &mut Vec<String>) -> Option<CapVal> {
        if e.is(ExprOp::Var) {
            // `program.defs[e.name]`; a name `defs` has no member of is
            // `undefined`, and so is what `Object.prototype` has for it.
            let name = e.name()?;
            let d = program.definition(name)?;
            if d.kind() != Some(DefKind::Capability) || seen.iter().any(|s| s == name) {
                return None;
            }
            seen.push(name.to_owned());
            let found = d.value_expr().and_then(|v| resolve(program, v, seen));
            seen.pop();
            return found;
        }
        let opts = CapOptions {
            language: program.language(),
        };
        cap_from_call(e, opts)
    }
    agent
        .caps()
        .iter()
        .filter_map(Expr::of)
        .filter_map(|e| resolve(program, e, &mut Vec::new()))
        .collect()
}

/// The model tiers an agent may call, and the highest data class it may send
/// them: `agentModels(program, agent)`.
#[must_use]
pub fn agent_models(program: Program<'_>, agent: Definition<'_>) -> AgentModels {
    let caps = agent_caps(program, agent);
    let models: Vec<&CapVal> = caps.iter().filter(|c| c.ctor() == "model.infer").collect();
    let mut tiers = unique_in_order(models.iter().filter_map(|c| c.tier().map(str::to_owned)));
    sort_utf16(&mut tiers);
    let max_class = models
        .iter()
        .map(|c| c.max_class().unwrap_or(DEFAULT_MODEL_MAX_CLASS))
        .fold(DataClass::Public, |a, b| {
            if class_rank(b) > class_rank(a) { b } else { a }
        });
    AgentModels { tiers, max_class }
}

/// A location with the span of exactly `path`, when the spans have one.
fn at(spans: Option<&Spans>, path: &str) -> Location {
    Location::path_span(path, spans.and_then(|s| s.get(path)).copied())
}

/// `{ path: "lock:/bindings/managed-agents<path>" }`.
fn lock_at(path: &str) -> Location {
    Location::path(format!("lock:/bindings/managed-agents{path}"))
}

/// A member as the value TypeScript holds, `undefined` when there is none.
fn js(v: Option<&Value>) -> JsValue {
    v.map_or(JsValue::Undefined, JsValue::from)
}

/// `a === b` where `a` is a member and `b` a string.
fn is_str(v: Option<&Value>, s: &str) -> bool {
    v.and_then(Value::as_str) == Some(s)
}

/// The checks a Managed Agents binding needs: every bound agent is a local
/// agent of the program with one model tier (E0903); the binding still
/// matches the lock's model and effort for that tier, so a changed lock needs
/// a new deployment (E0903); the lock's output limit is at least the
/// executor's ceiling, which the service cannot lower (E0904, K80); and no
/// bound agent may send its model data above `internal`, since the service
/// keeps session history and is not zero-retention (E0905, K46):
/// `bindingChecks(program, lock, spans)`.
#[must_use]
pub fn binding_checks(
    program: Program<'_>,
    lock: Lock<'_>,
    spans: Option<&Spans>,
) -> Vec<Diagnostic> {
    let Some(b) = lock.managed_agents().filter(|b| b.is_truthy()) else {
        return Vec::new();
    };
    let mut out: Vec<Diagnostic> = Vec::new();
    if !is_str(b.get("beta"), MA_BETA) {
        let beta = js(b.get("beta"));
        out.push(Diagnostic::new(
            "E0903",
            format!(
                "The Managed Agents binding was deployed under {}; this runtime speaks {MA_BETA}. Deploy again.",
                beta.to_js_string()
            ),
            lock_at("/beta"),
            Some(JsObject::new().with("beta", beta).with("supported", MA_BETA)),
        ));
    }
    let profile = b.get("profile").and_then(Value::as_object);
    let mut claims: Vec<(&str, &Value)> = profile.into_iter().flat_map(|p| p.iter()).collect();
    claims.sort_by(|x, y| compare_utf16(x.0, y.0));
    for (g, level) in claims {
        let table = MA_BRIDGE_PROFILE.iter().find(|(n, _)| *n == g);
        let level_text = JsValue::from(level).to_js_string();
        // `MA_BRIDGE_PROFILE[g]`: a plain object, read with no `Object.hasOwn`.
        let prototype = object_prototype_text(g);
        let real = table.map(|(_, l)| l.as_str());
        let real_rank = rank(real);
        if (table.is_none() && prototype.is_none()) || rank(level.as_str()) > real_rank {
            let gives = match (&real, &prototype) {
                (Some(real), _) => (*real).to_owned(),
                (None, Some(text)) => text.clone(),
                (None, None) => "no such guarantee".to_owned(),
            };
            // `real ?? null` as a fact: a function is left out of the object
            // `JSON.stringify` writes, `Object.prototype` is `{}`.
            let actual = match (&real, &prototype) {
                (Some(real), _) => JsValue::from(*real),
                (None, Some(_)) if g == "__proto__" => JsValue::Object(JsObject::new()),
                (None, Some(_)) => JsValue::Undefined,
                (None, None) => JsValue::Null,
            };
            out.push(Diagnostic::new(
                "E0903",
                format!("The binding claims {g} is {level_text}; a bridge binding gives {gives}."),
                lock_at(&format!("/profile/{g}")),
                Some(
                    JsObject::new()
                        .with("guarantee", g)
                        .with("claimed", JsValue::from(level))
                        .with("actual", actual),
                ),
            ));
        }
    }
    for (g, _) in MA_BRIDGE_PROFILE {
        if !profile.is_some_and(|p| p.contains_key(g)) {
            out.push(Diagnostic::new(
                "E0903",
                format!(
                    "The binding's profile leaves out {g}; every guarantee is listed, so none is dropped silently (INV-11)."
                ),
                lock_at("/profile"),
                Some(JsObject::new().with("guarantee", g)),
            ));
        }
    }
    let agents = b.get("agents").and_then(Value::as_object);
    let mut bound: Vec<(&str, &Value)> = agents.into_iter().flat_map(|a| a.iter()).collect();
    bound.sort_by(|x, y| compare_utf16(x.0, y.0));
    for (name, a) in bound {
        let def = program.definition(name).filter(|d| {
            d.kind() == Some(DefKind::Agent)
                && !d.value().get("remote").is_some_and(Value::is_truthy)
        });
        let Some(d) = def else {
            out.push(Diagnostic::new(
                "E0903",
                format!("The Managed Agents binding names {name}, which is not a local agent of this program."),
                lock_at(&format!("/agents/{name}")),
                Some(JsObject::new().with("agent", name)),
            ));
            continue;
        };
        let AgentModels { tiers, max_class } = agent_models(program, d);
        let tier = a.get("tier");
        if tiers.len() != 1 || !tiers.first().is_some_and(|t| is_str(tier, t)) {
            let named = if tiers.is_empty() {
                "no model tier".to_owned()
            } else {
                tiers.join(", ")
            };
            out.push(Diagnostic::new(
                "E0903",
                format!(
                    "{name} is bound to tier {}, but its capabilities name {named}. A bound agent has exactly one tier.",
                    js(tier).to_js_string()
                ),
                at(spans, &format!("/defs/{name}/caps")),
                Some(
                    JsObject::new()
                        .with("agent", name)
                        .with("bound", js(tier))
                        .with(
                            "tiers",
                            JsValue::Array(tiers.iter().map(|t| JsValue::from(t.as_str())).collect()),
                        ),
                ),
            ));
            continue;
        }
        let tier_text = js(tier).to_js_string();
        let model = a.get("model");
        let effort = a.get("effort");
        // `lock.models && Object.hasOwn(lock.models, a.tier) ? lock.models[a.tier] : undefined`.
        let locked_m = lock.model(&tier_text);
        let fits = locked_m.filter(|m| js_equal(m.model(), model) && js_equal(m.effort(), effort));
        let Some(m) = fits else {
            let locked = match locked_m {
                Some(m) => format!(
                    "{} at effort {}",
                    js(m.model()).to_js_string(),
                    js(m.effort()).to_js_string()
                ),
                None => "nothing".to_owned(),
            };
            out.push(Diagnostic::new(
                "E0903",
                format!(
                    "{name} was deployed with {} at effort {}; the lock maps {tier_text} to {locked}. Deploy again.",
                    js(model).to_js_string(),
                    js(effort).to_js_string()
                ),
                lock_at(&format!("/agents/{name}")),
                Some(
                    JsObject::new()
                        .with("agent", name)
                        .with("tier", tier_text.as_str())
                        .with(
                            "deployed",
                            JsObject::new()
                                .with("model", js(model))
                                .with("effort", js(effort)),
                        )
                        .with(
                            "locked",
                            match locked_m {
                                Some(m) => JsValue::Object(
                                    JsObject::new()
                                        .with("model", js(m.model()))
                                        .with("effort", js(m.effort())),
                                ),
                                None => JsValue::Null,
                            },
                        ),
                ),
            ));
            continue;
        };
        let ceiling = a.get("max_output_tokens");
        if js_less(&js(m.max_output_tokens()), &js(ceiling)) {
            out.push(Diagnostic::new(
                "E0904",
                format!(
                    "{name} runs on Managed Agents, which cannot cap a request's output below {}'s ceiling of {} tokens; the lock's max_output_tokens for {tier_text} is {}. Lock the ceiling, so the upper bound of a call stays true (K80).",
                    js(model).to_js_string(),
                    js(ceiling).to_js_string(),
                    js(m.max_output_tokens()).to_js_string()
                ),
                Location::path(format!("lock:/models/{tier_text}/max_output_tokens")),
                Some(
                    JsObject::new()
                        .with("agent", name)
                        .with("tier", tier_text.as_str())
                        .with("locked", js(m.max_output_tokens()))
                        .with("ceiling", js(ceiling)),
                ),
            ));
        }
        if class_rank(max_class) > class_rank(MA_MAX_CLASS) {
            out.push(Diagnostic::new(
                "E0905",
                format!(
                    "{name} may send {max_class} data to its model, and Managed Agents keeps session history and is not zero-retention: a bound agent may send at most {MA_MAX_CLASS} (K46). Run it on the local runtime."
                ),
                at(spans, &format!("/defs/{name}/caps")),
                Some(
                    JsObject::new()
                        .with("agent", name)
                        .with("max_class", max_class.as_str())
                        .with("allowed", MA_MAX_CLASS.as_str()),
                ),
            ));
        }
    }
    out
}

/// `a === b` on two members: equal primitives, `undefined` with
/// `undefined`; an array or an object is not equal to another.
fn js_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x == y,
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}
