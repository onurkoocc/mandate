//! The lock file, `mandate.lock.json` (BACKLOG K11; Doc 4 §19, §8.6): a port
//! of `compiler/src/lock.ts`. It pins what the program itself does not name:
//! the version of every imported module, each model tier's model, effort and
//! per-call token limits, each model's price, what the agents were deployed
//! as on an executor, the members who sign decisions and the roles they
//! hold, and from 0.5 the host's least versions, isolation floors and the
//! credentials agents' requests carry, by name. The compiler reads it for
//! the tiers a program names (E0141), for W0504 (a declared agent budget
//! below the upper bound `steps × per-call bound`), for the executor
//! bindings ([`crate::managed_agents`]), for the roles ([`role_lock_checks`])
//! and for the pins of imported modules ([`module_lock_checks`]).
//!
//! # The lock is a type over parsed JSON
//!
//! `Lock` in the TypeScript is only a type: nothing validates a lock that a
//! function is given, except [`validate_lock`] (which `check` calls first,
//! and runs the other checks only when it found nothing). So [`Lock`] is a
//! borrowed view over the [`Value`] that was read, and every read of a member
//! behaves as the JavaScript does on one that is missing or of another type:
//! `undefined` (`None`) for a member of a value that has none, `own` for a
//! lookup by a name that may be `constructor`, truthiness for `if (lock.x)`,
//! `??` for a default, and, in [`per_call_bound`], where a lock that was not
//! validated is read as numbers, `ToNumber` and the `+` of strings.
//!
//! The reads that throw in JavaScript (`Object.hasOwn(null, k)`, `p.input`
//! of an undefined `p`) do not throw here: a member that is not an object
//! reads as missing. That is the one difference, and only for a lock that
//! [`validate_lock`] refuses.
//!
//! # JavaScript imitated here
//!
//! - `Array.prototype.sort()` with no comparator, and `a < b` on strings:
//!   UTF-16 code units ([`mandate_ir::sort_utf16`], [`compare_utf16`]).
//! - `Set` and `Map` in insertion order ([`mandate_ir::unique_in_order`]);
//!   `Object.keys` and `Object.entries` in the order of [`Map`], where names
//!   that are array indices come first.
//! - `Math.ceil`, `Math.max` and the products of token counts and prices in
//!   doubles, and numbers written into messages as `String(x)` does
//!   ([`mandate_ir::number_to_string`]).
//! - `Object.hasOwn` against `o[k]`: [`own`].
//! - `{ ...lock }` without a member: [`packaged_lock`].

use mandate_ir::{
    DefKind, Definition, Diagnostic, Expr, Import, JsObject, JsValue, Location, Map, Program,
    Spans, Value, compare_utf16, hash_program, number_to_string, ptr, sort_utf16, unique_in_order,
};
pub use mandate_ir::{
    LOCK_FIELDS_0_5, LOCK_FORMAT, LOCK_FORMATS, lock_at_least, lock_schema_diagnostics,
    validate_lock,
};

use crate::caps::{CapOptions, cap_from_call, caps_of};
use crate::managed_agents::{agent_models, binding_checks};
use crate::modules::{Linked, Modules};
use crate::roles::role_sites;

// ---------------------------------------------------------------------------
// The lock as a view

/// The lock: `Lock`. A view over the value that was read, which may be any
/// value; a member it does not have, or that is not there because the value
/// is not an object, reads as `None` (`undefined`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lock<'a> {
    value: &'a Value,
}

impl<'a> Lock<'a> {
    /// The view of `value`.
    #[must_use]
    pub fn of(value: &'a Value) -> Lock<'a> {
        Lock { value }
    }

    /// The value, as read.
    #[must_use]
    pub fn value(self) -> &'a Value {
        self.value
    }

    /// The member `key`, as read.
    #[must_use]
    pub fn member(self, key: &str) -> Option<&'a Value> {
        self.value.get(key)
    }

    /// `lock`: the lock format.
    #[must_use]
    pub fn format(self) -> Option<&'a Value> {
        self.member("lock")
    }

    /// A lock's format is `format` or later: `atLeast(lock, format)`.
    #[must_use]
    pub fn at_least(self, format: &str) -> bool {
        lock_at_least(self.value, format)
    }

    /// `modules`: the version (hash) of every imported module.
    #[must_use]
    pub fn modules(self) -> Option<&'a Value> {
        self.member("modules")
    }

    /// `models`: by tier, the model and its limits.
    #[must_use]
    pub fn models(self) -> Option<&'a Value> {
        self.member("models")
    }

    /// `tariffs`: by model, its price.
    #[must_use]
    pub fn tariffs(self) -> Option<&'a Value> {
        self.member("tariffs")
    }

    /// `bindings`: what the agents were deployed as on an executor.
    #[must_use]
    pub fn bindings(self) -> Option<&'a Value> {
        self.member("bindings")
    }

    /// `bindings?.["managed-agents"]`.
    #[must_use]
    pub fn managed_agents(self) -> Option<&'a Value> {
        self.bindings().and_then(|b| b.get("managed-agents"))
    }

    /// `members`: each member's key ids.
    #[must_use]
    pub fn members(self) -> Option<&'a Value> {
        self.member("members")
    }

    /// `roles`: each role's members.
    #[must_use]
    pub fn roles(self) -> Option<&'a Value> {
        self.member("roles")
    }

    /// `host` (0.5): the least versions of the tools the host runs.
    #[must_use]
    pub fn host(self) -> Option<&'a Value> {
        self.member("host")
    }

    /// `isolation` (0.5): the floors by data class and for an untrusted
    /// network, and where a sandbox may not share its host.
    #[must_use]
    pub fn isolation(self) -> Option<&'a Value> {
        self.member("isolation")
    }

    /// `egress` (0.5): per agent, the credential each host's requests carry.
    #[must_use]
    pub fn egress(self) -> Option<&'a Value> {
        self.member("egress")
    }

    /// The model locked for `tier`: `own(lock.models, tier)`, when there is
    /// one that is not falsy.
    #[must_use]
    pub fn model(self, tier: &str) -> Option<ModelLock<'a>> {
        own(self.models(), tier)
            .filter(|m| m.is_truthy())
            .map(|value| ModelLock { value })
    }

    /// The tariff of `model`: `own(lock.tariffs, model)`, when there is one
    /// that is not falsy.
    #[must_use]
    pub fn tariff(self, model: &str) -> Option<Tariff<'a>> {
        own(self.tariffs(), model)
            .filter(|t| t.is_truthy())
            .map(|value| Tariff { value })
    }
}

/// A tier's model: `ModelLock`, `{ provider, model, effort,
/// max_input_tokens, max_output_tokens }`, each member as read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModelLock<'a> {
    value: &'a Value,
}

impl<'a> ModelLock<'a> {
    /// The value, as read.
    #[must_use]
    pub fn value(self) -> &'a Value {
        self.value
    }

    /// `model`.
    #[must_use]
    pub fn model(self) -> Option<&'a Value> {
        self.value.get("model")
    }

    /// `effort`.
    #[must_use]
    pub fn effort(self) -> Option<&'a Value> {
        self.value.get("effort")
    }

    /// `max_input_tokens`.
    #[must_use]
    pub fn max_input_tokens(self) -> Option<&'a Value> {
        self.value.get("max_input_tokens")
    }

    /// `max_output_tokens`.
    #[must_use]
    pub fn max_output_tokens(self) -> Option<&'a Value> {
        self.value.get("max_output_tokens")
    }
}

/// A model's price: `Tariff`, `{ currency, as_of, micros_per_mtok }`, each
/// member as read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tariff<'a> {
    value: &'a Value,
}

impl<'a> Tariff<'a> {
    /// The value, as read.
    #[must_use]
    pub fn value(self) -> &'a Value {
        self.value
    }

    /// `currency`.
    #[must_use]
    pub fn currency(self) -> Option<&'a Value> {
        self.value.get("currency")
    }

    /// `as_of`.
    #[must_use]
    pub fn as_of(self) -> Option<&'a Value> {
        self.value.get("as_of")
    }

    /// `micros_per_mtok`: `{ input, output, cache_read, cache_write }`.
    #[must_use]
    pub fn micros_per_mtok(self) -> Option<&'a Value> {
        self.value.get("micros_per_mtok")
    }
}

/// `o[k]` when `k` is a key of `o` itself: `own(o, k)` in `lock.ts`. A lock
/// read with `JSON.parse` has a prototype, and a model may be named
/// `constructor`: a name `o` does not hold itself is `None`, whatever
/// `Object.prototype` holds. A value that is not an object has no members
/// here, except that an array has its elements by index.
#[must_use]
pub fn own<'a>(o: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    match o? {
        Value::Object(map) => map.get(k),
        Value::Array(items) => array_index(k).and_then(|i| items.get(i)),
        _ => None,
    }
}

/// The index `k` is when it is the text of an array index (`"0"`, `"12"`,
/// no sign, no leading zero), as the property names of an array are.
fn array_index(k: &str) -> Option<usize> {
    let canonical = k == "0" || (!k.starts_with('0') && !k.is_empty());
    if canonical && k.bytes().all(|b| b.is_ascii_digit()) {
        k.parse::<usize>().ok()
    } else {
        None
    }
}

/// `Object.hasOwn(o, k)` for the values a lock holds.
fn has_own(o: &Value, k: &str) -> bool {
    own(Some(o), k).is_some()
}

/// `Object.keys(o ?? {})`: the names of an object in order, the indices of
/// an array or of a string; none for any other value.
fn js_keys(o: Option<&Value>) -> Vec<String> {
    match o {
        Some(Value::Object(map)) => map.keys().map(str::to_owned).collect(),
        Some(Value::Array(items)) => (0..items.len()).map(|i| i.to_string()).collect(),
        Some(Value::String(s)) => (0..s.chars().map(char::len_utf16).sum::<usize>())
            .map(|i| i.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

/// `Object.keys(o).sort()`, or with `sort(cmp)`: the same order.
fn sorted_keys(o: Option<&Value>) -> Vec<String> {
    let mut keys = js_keys(o);
    sort_utf16(&mut keys);
    keys
}

/// `{ lock: _format, ...pinned } = lock ?? { modules: {} }; return pinned`:
/// the lock as a package carries it, without its format field: `packagedLock`.
/// A program with no lock file is packaged with no pins. A value that is not
/// an object (not a lock) is spread as JavaScript spreads it: an array by
/// index, a string by character (by code point here, by UTF-16 code unit in
/// JavaScript, which differ for a character outside the Basic Multilingual
/// Plane), any other value as nothing.
#[must_use]
pub fn packaged_lock(lock: Option<&Value>) -> Map {
    match lock {
        Some(Value::Object(map)) => map
            .iter()
            .filter(|(k, _)| *k != "lock")
            .map(|(k, v)| (k, v.clone()))
            .collect(),
        Some(Value::Null) | None => {
            let mut pinned = Map::new();
            pinned.insert("modules", Map::new());
            pinned
        }
        // `{ ...["a", "b"] }` is `{ 0: "a", 1: "b" }`, and so is a string's.
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (i.to_string(), v.clone()))
            .collect(),
        Some(Value::String(s)) => s
            .chars()
            .enumerate()
            .map(|(i, c)| (i.to_string(), Value::String(c.to_string())))
            .collect(),
        Some(_) => Map::new(),
    }
}

// ---------------------------------------------------------------------------
// The numbers of a lock that was not validated

/// `ToNumber(v)`: what `*`, `<` and `Math.max` read a value as.
pub(crate) fn to_number(v: &JsValue) -> f64 {
    match v {
        JsValue::Undefined | JsValue::Object(_) => f64::NAN,
        JsValue::Null => 0.0,
        JsValue::Bool(b) => f64::from(u8::from(*b)),
        JsValue::Number(x) => *x,
        JsValue::String(s) => string_to_number(s),
        // `ToPrimitive` of an array is its `join(",")`.
        JsValue::Array(_) => string_to_number(&v.to_js_string()),
    }
}

/// `StringToNumber`, which is [`crate::js_number::js_to_number`]: `Number(s)`.
fn string_to_number(s: &str) -> f64 {
    crate::js_number::js_to_number(s)
}

/// `Math.max(...xs)`: `-Infinity` for none, `NaN` when any is.
fn js_max(xs: impl IntoIterator<Item = f64>) -> f64 {
    let mut best = f64::NEG_INFINITY;
    for x in xs {
        if x.is_nan() {
            return f64::NAN;
        }
        if x > best {
            best = x;
        }
    }
    best
}

/// `a + b` on two values a lock holds: the concatenation of their texts when
/// either is a string, an array or an object (whose primitive is its text),
/// else the sum of their numbers.
fn js_add(a: &JsValue, b: &JsValue) -> JsValue {
    let texty = |v: &JsValue| {
        matches!(
            v,
            JsValue::String(_) | JsValue::Array(_) | JsValue::Object(_)
        )
    };
    if texty(a) || texty(b) {
        JsValue::String(format!("{}{}", a.to_js_string(), b.to_js_string()))
    } else {
        JsValue::Number(to_number(a) + to_number(b))
    }
}

/// `a < b` on two values a lock holds: texts compare by UTF-16 code units
/// when both are texts (an array and an object are their text), else as
/// numbers, false when either is `NaN`.
pub(crate) fn js_less(a: &JsValue, b: &JsValue) -> bool {
    let primitive = |v: &JsValue| match v {
        JsValue::Array(_) | JsValue::Object(_) => JsValue::String(v.to_js_string()),
        other => other.clone(),
    };
    match (primitive(a), primitive(b)) {
        (JsValue::String(x), JsValue::String(y)) => compare_utf16(&x, &y).is_lt(),
        (x, y) => to_number(&x) < to_number(&y),
    }
}

/// `a === b` for the values a lock holds: equal primitives; an array or an
/// object is never equal to another.
fn js_strict_equal(a: &JsValue, b: &JsValue) -> bool {
    match (a, b) {
        (JsValue::Undefined, JsValue::Undefined) | (JsValue::Null, JsValue::Null) => true,
        (JsValue::Bool(x), JsValue::Bool(y)) => x == y,
        (JsValue::Number(x), JsValue::Number(y)) => x == y,
        (JsValue::String(x), JsValue::String(y)) => x == y,
        _ => false,
    }
}

/// A member as the value TypeScript holds, `undefined` when there is none.
fn js(v: Option<&Value>) -> JsValue {
    v.map_or(JsValue::Undefined, JsValue::from)
}

/// `String(v)` of a member.
fn text(v: Option<&Value>) -> String {
    js(v).to_js_string()
}

/// Whether a member is truthy: `if (lock.x)`.
fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_truthy)
}

// ---------------------------------------------------------------------------
// Per-call bounds

/// What a model call at a tier can use at most: `perCallBound`'s result,
/// `{ tokens, spend: { micros, currency } }`.
#[derive(Clone, Debug, PartialEq)]
pub struct PerCallBound {
    /// `m.max_input_tokens + m.max_output_tokens`, as a number for a lock
    /// that holds numbers there, the concatenation of two texts for one that
    /// does not (an unvalidated lock).
    pub tokens: JsValue,
    /// The price of a call in micro-units, rounded up to a whole one.
    pub micros: f64,
    /// `t.currency`, as the tariff has it.
    pub currency: JsValue,
}

impl PerCallBound {
    /// `tokens` as `Math.max` reads it.
    #[must_use]
    pub fn tokens_number(&self) -> f64 {
        to_number(&self.tokens)
    }
}

/// Upper bound of one model call at `tier` (§8.6): the locked input and
/// output limits, the input priced as if nothing hits the cache (the higher
/// of the input and cache-write prices, K12), rounded up to a whole
/// micro-unit: `perCallBound(lock, tier)`. `None` for a tier or a model the
/// lock has no entry for. The arithmetic is the double arithmetic of
/// JavaScript: `ceil((input_tokens × max(input, cache_write) + output_tokens
/// × output) / 1e6)`.
#[must_use]
pub fn per_call_bound(lock: Lock<'_>, tier: &str) -> Option<PerCallBound> {
    let m = lock.model(tier)?;
    // `own(lock.tariffs, m.model)`: the name is `m.model` as a property key.
    let t = lock.tariff(&text(m.model()))?;
    let p = t.micros_per_mtok();
    let price = |key: &str| to_number(&js(p.and_then(|p| p.get(key))));
    let input = to_number(&js(m.max_input_tokens()));
    let output = to_number(&js(m.max_output_tokens()));
    let micros = ((input * js_max([price("input"), price("cache_write")])
        + output * price("output"))
        / 1_000_000.0)
        .ceil();
    Some(PerCallBound {
        tokens: js_add(&js(m.max_input_tokens()), &js(m.max_output_tokens())),
        micros,
        currency: js(t.currency()),
    })
}

/// Model tiers a program's capabilities name, by the definition they appear
/// in, each once, in the order they are found: `modelTiers(program)` (a
/// `Set`). Every object under `defs` is read as an expression, whatever it
/// is.
#[must_use]
pub fn model_tiers(program: Program<'_>) -> Vec<String> {
    let opts = CapOptions {
        language: program.language(),
    };
    let mut tiers: Vec<String> = Vec::new();
    fn visit(v: &Value, opts: CapOptions, tiers: &mut Vec<String>) {
        match v {
            Value::Array(items) => items.iter().for_each(|x| visit(x, opts, tiers)),
            Value::Object(map) => {
                if let Some(c) = Expr::of(v).and_then(|e| cap_from_call(e, opts))
                    && c.ctor() == "model.infer"
                    && let Some(tier) = c.tier()
                {
                    tiers.push(tier.to_owned());
                }
                map.iter().for_each(|(_, x)| visit(x, opts, tiers));
            }
            _ => {}
        }
    }
    if let Some(defs) = program.members().get("defs") {
        visit(defs, opts, &mut tiers);
    }
    unique_in_order(tiers)
}

// ---------------------------------------------------------------------------
// The checks

/// A location with the span of exactly `path`, when the spans have one.
fn at(spans: Option<&Spans>, path: &str) -> Location {
    Location::path_span(path, spans.and_then(|s| s.get(path)).copied())
}

/// The checks that need the lock: every model tier the program names is
/// locked (E0141), every agent's declared budget covers the upper bound of
/// its agent loop, `steps × per-call bound` (W0504, §8.6; E0504 when it is
/// in another currency than the tier's price), and an executor binding still
/// fits the program and the lock (E0903–E0905), and the lock's isolation and
/// credentials fit the program (E1802, E1803): `lockChecks(program, lock,
/// spans)`. `program` has its imported definitions linked
/// ([`crate::linked_program`]).
#[must_use]
pub fn lock_checks(program: Program<'_>, lock: Lock<'_>, spans: Option<&Spans>) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut tiers = model_tiers(program);
    sort_utf16(&mut tiers);
    for tier in &tiers {
        if !truthy(own(lock.models(), tier)) {
            out.push(Diagnostic::new(
                "E0141",
                format!("Model tier {tier} is not in the lock file."),
                at(spans, "/defs"),
                Some(
                    JsObject::new()
                        .with("tier", tier.as_str())
                        .with("locked", strings(&sorted_keys(lock.models()))),
                ),
            ));
        }
    }
    let mut defs: Vec<(&str, &Value)> = program.defs().into_iter().flat_map(Map::iter).collect();
    defs.sort_by(|a, b| compare_utf16(a.0, b.0));
    for (name, def) in defs {
        let d = Definition::of(def);
        if d.kind() != Some(DefKind::Agent) || truthy(def.get("remote")) {
            continue;
        }
        let tiers = agent_models(program, d).tiers;
        let bounds: Vec<PerCallBound> = tiers
            .iter()
            .filter_map(|t| per_call_bound(lock, t))
            .collect();
        let Some(first) = bounds.first() else {
            continue;
        };
        let worst_tokens = js_max(bounds.iter().map(PerCallBound::tokens_number));
        let worst_micros = js_max(bounds.iter().map(|b| b.micros));
        let worst_currency = &first.currency;
        let currency_text = worst_currency.to_js_string();
        let tier_list = tiers.join(", ");
        for (skill_name, skill) in d.skills() {
            if truthy(skill.get("body")) {
                continue;
            }
            let own_budget = skill.get("budget").filter(|b| **b != Value::Null);
            let path = if truthy(skill.get("budget")) {
                format!("/defs/{name}/skills/{skill_name}/budget")
            } else {
                format!("/defs/{name}/budget")
            };
            let budget = own_budget.or_else(|| def.get("budget").filter(|b| **b != Value::Null));
            let Some(steps) = budget.and_then(|b| b.get("steps")) else {
                // E0503 already reports it.
                continue;
            };
            let steps_number = to_number(&js(Some(steps)));
            let need_tokens = steps_number * worst_tokens;
            let need_micros = steps_number * worst_micros;
            let spend = budget
                .and_then(|b| b.get("spend"))
                .filter(|s| s.is_truthy());
            if let Some(spend) = spend
                && !js_strict_equal(&js(spend.get("currency")), worst_currency)
            {
                out.push(Diagnostic::new(
                    "E0504",
                    format!(
                        "{name}.{skill_name} budgets {}, but tier {tier_list} is priced in {currency_text}.",
                        text(spend.get("currency"))
                    ),
                    at(spans, &path),
                    Some(
                        JsObject::new()
                            .with("agent", name)
                            .with("skill", skill_name)
                            .with("budget", js(spend.get("currency")))
                            .with("tariff", worst_currency.clone()),
                    ),
                ));
                continue;
            }
            // `short`: what falls short, by what it is, in this order.
            let mut short: Vec<(String, JsValue, f64)> = Vec::new();
            let tokens = budget.and_then(|b| b.get("tokens"));
            if let Some(tokens) = tokens
                && js_less(&js(Some(tokens)), &JsValue::Number(need_tokens))
            {
                short.push(("tokens".to_owned(), js(Some(tokens)), need_tokens));
            }
            if let Some(spend) = spend
                && js_less(&js(spend.get("micros")), &JsValue::Number(need_micros))
            {
                short.push((
                    format!("spend:{currency_text}"),
                    js(spend.get("micros")),
                    need_micros,
                ));
            }
            if short.is_empty() {
                continue;
            }
            let shown: Vec<String> = short
                .iter()
                .map(|(what, declared, bound)| {
                    format!(
                        "{what} {} < {}",
                        declared.to_js_string(),
                        number_to_string(*bound)
                    )
                })
                .collect();
            let short_facts: JsObject = short
                .iter()
                .map(|(what, declared, bound)| {
                    (
                        what.as_str(),
                        JsObject::new()
                            .with("declared", declared.clone())
                            .with("bound", *bound),
                    )
                })
                .collect();
            out.push(Diagnostic::new(
                "W0504",
                format!(
                    "{name}.{skill_name} declares less than its loop can use: {} ({} steps × the per-call bound of tier {tier_list}). The skill may not be able to finish.",
                    shown.join(", "),
                    text(Some(steps))
                ),
                at(spans, &path),
                Some(
                    JsObject::new()
                        .with("agent", name)
                        .with("skill", skill_name)
                        .with("steps", js(Some(steps)))
                        .with(
                            "per_call",
                            JsObject::new()
                                .with("tokens", worst_tokens)
                                .with("spend_micros", worst_micros)
                                .with("currency", worst_currency.clone()),
                        )
                        .with("short", short_facts),
                ),
            ));
        }
    }
    out.extend(binding_checks(program, lock, spans));
    out.extend(sandbox_lock_checks(program, lock));
    out
}

/// A list of strings as the value TypeScript holds.
fn strings(xs: &[String]) -> JsValue {
    JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect())
}

/// What the lock adds to sandbox requirements (spec/boundary.md "Lock 0.5").
/// Only a 0.5 program's requirement has an isolation level and credentials,
/// so a lock packaged with an earlier program that sets `isolation` or
/// `egress` would not apply, and is refused (E1803); `host` applies to every
/// program. A credential is bound to an agent that runs in the runtime's
/// sandbox, for a host one of its net.https capabilities holds (E1802).
/// `program` has its imported definitions linked. Paths are into the lock:
/// `sandboxLockChecks(program, lock)`.
#[must_use]
pub fn sandbox_lock_checks(program: Program<'_>, lock: Lock<'_>) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let language = program.language();
    if !language.is_some_and(|l| l.at_least(mandate_ir::Language::V0_5)) {
        let language = js(program.members().get("language"));
        for field in ["isolation", "egress"] {
            if !truthy(lock.member(field)) {
                continue;
            }
            let what = if field == "isolation" {
                "isolation level"
            } else {
                "credentials"
            };
            out.push(Diagnostic::new(
                "E1803",
                format!(
                    "Lock field {field} applies to a program of mandate/0.5 or later. This program is {}: its sandbox requirements have no {what}, so {field} would not apply. Write the program in mandate/0.5, or take {field} out of the lock.",
                    language.to_js_string()
                ),
                Location::path(format!("/{field}")),
                Some(
                    JsObject::new()
                        .with("field", field)
                        .with("language", language.clone()),
                ),
            ));
        }
        return out;
    }
    let executor = lock
        .managed_agents()
        .and_then(|b| b.get("agents"))
        .filter(|e| e.is_truthy());
    let empty = Map::new();
    let defs = program.defs().unwrap_or(&empty);
    let opts = CapOptions { language };
    for agent in sorted_keys(lock.egress()) {
        let hosts = own(lock.egress(), &agent);
        let def = defs.get(&agent);
        let d = def.map(Definition::of);
        let is_agent = d.is_some_and(|d| d.kind() == Some(DefKind::Agent));
        let remote = def.is_some_and(|d| truthy(d.get("remote")));
        let bound_to_executor = executor.is_some_and(|e| has_own(e, &agent));
        if !is_agent || remote || bound_to_executor {
            let (why, what) = if !is_agent {
                ("not_an_agent", "which is not an agent of the program")
            } else if remote {
                ("remote", "a remote agent")
            } else {
                ("executor", "an agent the lock binds to Managed Agents")
            };
            out.push(Diagnostic::new(
                "E1802",
                format!(
                    "The lock binds credentials to the requests of {agent}, {what}. A credential is bound only to an agent that runs in the runtime's sandbox, whose requests go through the egress proxy."
                ),
                Location::path(ptr(&[&"egress", &agent])),
                Some(
                    JsObject::new()
                        .with("agent", agent.as_str())
                        .with("reason", why)
                        .with("hosts", strings(&sorted_keys(hosts))),
                ),
            ));
            continue;
        }
        let mut held: Vec<String> = Vec::new();
        if let Some(d) = d {
            for cap in d.caps() {
                let Some(e) = Expr::of(cap) else { continue };
                for c in caps_of(defs, e, opts) {
                    if c.ctor() == "net.https" {
                        held.extend(c.scope().unwrap_or_default().iter().cloned());
                    }
                }
            }
        }
        for host in sorted_keys(hosts) {
            if held.contains(&host) {
                continue;
            }
            let credential = own(hosts, &host);
            let mut seen = unique_in_order(held.iter().cloned());
            sort_utf16(&mut seen);
            out.push(Diagnostic::new(
                "E1802",
                format!(
                    "The lock binds credential {} to {agent}'s requests to {host}, a host none of {agent}'s net.https capabilities holds.",
                    text(credential)
                ),
                Location::path(ptr(&[&"egress", &agent, &host])),
                Some(
                    JsObject::new()
                        .with("agent", agent.as_str())
                        .with("reason", "host_not_held")
                        .with("host", host.as_str())
                        .with("credential", js(credential))
                        .with("held", strings(&seen)),
                ),
            ));
        }
    }
    out
}

/// E1502: a decision in a 0.4 package is signed by a member, so every role
/// the package names is held by at least one (spec/envelope.md). `linked` is
/// the program's definitions with its imported modules loaded
/// ([`crate::link`]). A role named only by an imported definition, such as
/// the owner of an imported component, counts, and is reported at the import
/// that brings it in: `roleLockChecks(program, linked, lock, spans)`.
#[must_use]
pub fn role_lock_checks(
    program: Program<'_>,
    linked: &Linked,
    lock: Lock<'_>,
    spans: Option<&Spans>,
) -> Vec<Diagnostic> {
    if !program
        .language()
        .is_some_and(|l| l.at_least(mandate_ir::Language::V0_4))
    {
        return Vec::new();
    }
    let mut out: Vec<Diagnostic> = Vec::new();
    let sites: Vec<_> = role_sites(&linked.defs)
        .into_iter()
        .filter(|s| s.role.is_some())
        .collect();
    let mine = |def: &str| program.defs().is_some_and(|d| d.contains_key(def));
    let older = if lock.at_least("mandate/lock/0.4") {
        ""
    } else {
        " A 0.4 package needs a mandate/lock/0.4 lock, with members and roles."
    };
    for role in unique_in_order(sites.iter().filter_map(|s| s.role.clone())) {
        // `own(lock.roles, role)?.length`.
        let held = match own(lock.roles(), &role) {
            Some(Value::Array(members)) => !members.is_empty(),
            Some(Value::String(s)) => !s.is_empty(),
            _ => false,
        };
        if held {
            continue;
        }
        let named: Vec<_> = sites
            .iter()
            .filter(|s| s.role.as_deref() == Some(role.as_str()))
            .collect();
        let Some(site) = named
            .iter()
            .find(|s| mine(&s.def))
            .or_else(|| named.first())
        else {
            continue;
        };
        let mut facts = JsObject::new()
            .with("role", role.as_str())
            .with("lock", lock.format().map_or(JsValue::Null, JsValue::from))
            .with("bound", strings(&sorted_keys(lock.roles())));
        let mut path = site.path.clone();
        if !mine(&site.def) {
            let module = linked.origin_of(&site.def);
            let i = program.use_values().iter().position(|u| {
                // `u.module === module`; no `module` is `undefined`.
                Import::of(u).and_then(Import::module) == module
            });
            path = match i {
                Some(i) => ptr(&[&"uses", &i]),
                None => "/uses".to_owned(),
            };
            facts.insert("named_by", site.def.as_str());
            if let Some(module) = module {
                facts.insert("module", module);
            }
        }
        let by = if mine(&site.def) {
            String::new()
        } else {
            format!(" ({} of the imported {} names it)", site.r#where, site.def)
        };
        out.push(Diagnostic::new(
            "E1502",
            format!("Role {role} has no member in the lock file, so nobody could decide for it{by}.{older}"),
            at(spans, &path),
            Some(facts),
        ));
    }
    out
}

/// Every imported module the caller loaded is pinned in the lock by its
/// program hash (S09, INV-02): a system model that changed since the lock was
/// written is a different program, not the one the run was approved with
/// (E0142). A module that is imported but not loaded must still be locked:
/// `moduleLockChecks(program, lock, modules)`.
#[must_use]
pub fn module_lock_checks(
    program: Program<'_>,
    lock: Lock<'_>,
    modules: Option<&Modules>,
) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    for (i, u) in program.use_values().iter().enumerate() {
        let Some(module) = Import::of(u).and_then(Import::module) else {
            continue;
        };
        if module == "std" || module.starts_with("std.") {
            continue;
        }
        let Some(pinned) = own(lock.modules(), module) else {
            out.push(Diagnostic::new(
                "E0142",
                format!("Module {module} is imported but not in the lock file."),
                Location::path(format!("/uses/{i}")),
                Some(JsObject::new().with("module", module)),
            ));
            continue;
        };
        let Some(m) = modules
            .and_then(|ms| ms.get(module))
            .filter(|m| m.is_truthy())
        else {
            continue;
        };
        let hash = hash_program(m).program;
        if pinned.as_str() != Some(hash.as_str()) {
            out.push(Diagnostic::new(
                "E0142",
                format!(
                    "Module {module} hashes to {hash}, but the lock pins {}.",
                    text(Some(pinned))
                ),
                Location::path(format!("/uses/{i}")),
                Some(
                    JsObject::new()
                        .with("module", module)
                        .with("pinned", js(Some(pinned)))
                        .with("hash", hash.as_str()),
                ),
            ));
        }
    }
    out
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::float_cmp
)]
mod tests {
    use super::{array_index, js_add, js_max, string_to_number};
    use mandate_ir::JsValue;

    #[test]
    fn numbers_as_javascript_reads_them() {
        assert_eq!(string_to_number("  12 "), 12.0);
        assert_eq!(string_to_number(""), 0.0);
        assert_eq!(string_to_number("0x10"), 16.0);
        assert_eq!(string_to_number("0b101"), 5.0);
        assert!(string_to_number("-0x10").is_nan());
        assert_eq!(string_to_number("1e3"), 1000.0);
        assert_eq!(string_to_number(".5"), 0.5);
        assert_eq!(string_to_number("5."), 5.0);
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert!(string_to_number("inf").is_nan());
        assert!(string_to_number("nan").is_nan());
        assert!(string_to_number("1_0").is_nan());
        assert!(string_to_number("e5").is_nan());
        assert!(string_to_number("1 2").is_nan());
    }

    #[test]
    fn max_and_plus() {
        assert_eq!(js_max([1.0, 3.0, 2.0]), 3.0);
        assert!(js_max([1.0, f64::NAN]).is_nan());
        assert_eq!(js_max([]), f64::NEG_INFINITY);
        assert_eq!(
            js_add(&JsValue::from("1"), &JsValue::Number(2.0)),
            JsValue::from("12")
        );
        assert_eq!(
            js_add(&JsValue::Null, &JsValue::Number(2.0)),
            JsValue::Number(2.0)
        );
    }

    #[test]
    fn array_indices() {
        assert_eq!(array_index("0"), Some(0));
        assert_eq!(array_index("12"), Some(12));
        assert_eq!(array_index("01"), None);
        assert_eq!(array_index("-1"), None);
        assert_eq!(array_index(""), None);
    }
}
