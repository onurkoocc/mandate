//! A lead's sub-program (0.4; spec/envelope.md "The sub-program"): a port of
//! `compiler/src/check/subprogram.ts`.
//!
//! A lead agent writes a sub-program while a run is going, as a patch to a
//! skeleton the runtime starts for it ([`skeleton`]). Before any of it runs
//! it is held to what the person who approved the envelope approved:
//!
//! - E1705 ([`subprogram_shape`]): it defines only types, constants,
//!   capabilities, functions, local agents and one workflow, which takes no
//!   parameters, has no envelope and does not `plan`; what the skeleton says
//!   of the module stays;
//! - E1706 ([`containment`]): its workflow's `caps` and `budget`, its claim
//!   on the envelope, fit what is left: every capability inside one of the
//!   envelope's and clear of the writes still in flight, the budget within
//!   the remainder in every dimension the run is limited in, and its time
//!   before the run's deadline.
//!
//! The rest of containment is checked where it always is (the static
//! checks, with a claim).
//!
//! JavaScript imitated: `.sort()` without a comparator and `<` on text by
//! UTF-16 code units ([`mandate_ir::compare_utf16`]), the numbers of the
//! ledger as doubles written with [`mandate_ir::number_to_string`], an
//! object's members in ECMAScript order ([`Map`] and [`JsObject`]),
//! truthiness of an object member, and a `Record<string, number>` read with
//! `Object.hasOwn`.

use mandate_ir::{
    BUDGET_DIMENSIONS, DefKind, Definition, Diagnostic, Expr, JsObject, JsValue, Language,
    Location, Map, Program, Value, budget_amount, canonicalize, compare_utf16, number_to_string,
    ptr, ptr_token, sort_utf16,
};

use crate::caps::{CapOptions, CapVal, cap_covers, caps_of, show_cap, writes_overlap};
use crate::stdlib::DataClass;

/// The module the runtime starts for sub-program `n` of a lead in module
/// `parent`: `skeleton(parent, n, language)`. Its hash is the `base` of the
/// lead's patch. It is written in its parent's language, and in 0.4 at
/// least, where `plan` begins (`language` defaults to 0.4 when the parent
/// has none).
#[must_use]
pub fn skeleton(parent: &str, n: f64, language: Option<Language>) -> Value {
    let language = language.unwrap_or(Language::V0_4);
    let language = if language.at_least(Language::V0_4) {
        language
    } else {
        Language::V0_4
    };
    let mut uses = Map::new();
    uses.insert("module", parent);
    let mut program = Map::new();
    program.insert("language", language.as_str());
    program.insert("module", format!("{parent}.plan_{}", number_to_string(n)));
    program.insert("version", "0.1");
    program.insert("uses", Value::Array(vec![Value::Object(uses)]));
    program.insert("defs", Map::new());
    Value::Object(program)
}

/// The sub-program as the checks and the interpreter read it: `opened(sub,
/// parent)`, `{ ...sub, uses: [...(parent.uses ?? []), { module:
/// parent.module, names: Object.keys(parent.defs).sort() }] }`. Its `use`
/// of its parent names nothing, and stands for all the parent sees. Never
/// hashed and never stored.
#[must_use]
pub fn opened(sub: &Value, parent: &Value) -> Value {
    let mut uses: Vec<Value> = parent
        .get("uses")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .to_vec();
    let mut names: Vec<&str> = parent
        .get("defs")
        .and_then(Value::as_object)
        .map(|d| d.keys().collect())
        .unwrap_or_default();
    sort_utf16(&mut names);
    let mut own = Map::new();
    own.insert(
        "module",
        parent.get("module").cloned().unwrap_or(Value::Null),
    );
    own.insert(
        "names",
        Value::Array(names.into_iter().map(Value::from).collect()),
    );
    uses.push(Value::Object(own));
    // `{ ...sub, uses }`: a member that is there keeps its place.
    let mut view = sub.as_object().cloned().unwrap_or_default();
    view.insert("uses", Value::Array(uses));
    Value::Object(view)
}

/// The kinds a sub-program may define.
const ALLOWED: [&str; 6] = ["type", "const", "capability", "fn", "agent", "workflow"];

/// `list(xs)`: `a`, `a and b`, `a, b and c`.
fn list(xs: &[&str]) -> String {
    match xs.split_last() {
        None => String::new(),
        Some((last, [])) => (*last).to_owned(),
        Some((last, init)) => format!("{} and {last}", init.join(", ")),
    }
}

/// Every node under `v` whose `op` is `op`, by JSON Pointer: `nodes(v, op,
/// path, found)`. The members of an object are visited in their order, the
/// node itself first.
fn nodes(v: &Value, op: &str, path: &str, found: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                nodes(x, op, &format!("{path}/{i}"), found);
            }
        }
        Value::Object(map) => {
            if v.get("op").and_then(Value::as_str) == Some(op) {
                found.push(path.to_owned());
            }
            for (k, x) in map.iter() {
                nodes(x, op, &format!("{path}/{}", ptr_token(&k)), found);
            }
        }
        _ => {}
    }
}

/// `diag("E1706" | "E1705", message, { path }, { facts })`.
fn diagnostic(code: &str, message: String, path: &str, facts: JsObject) -> Diagnostic {
    Diagnostic::new(code, message, Location::path(path), Some(facts))
}

/// E1705: what a sub-program may be: `subprogramShape(sub, parent, n,
/// language)`. `parent` and `n` say which skeleton it was patched from.
/// Acceptance criteria, external effects, host code, people and the system
/// model belong to the program a person approved, so a sub-program defines
/// none of them; a remote agent is a network binding, and an envelope or a
/// `plan` of its own would be authority nobody approved.
#[must_use]
pub fn subprogram_shape(
    sub: &Value,
    parent: &str,
    n: f64,
    language: Option<Language>,
) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let mut no = |message: String, path: &str, facts: JsObject| {
        out.push(diagnostic("E1705", message, path, facts));
    };
    let base = skeleton(parent, n, language);
    // `canonicalize((a ?? null)) === canonicalize((b ?? null))`.
    let same = |a: Option<&Value>, b: Option<&Value>| {
        canonicalize(a.unwrap_or(&Value::Null)) == canonicalize(b.unwrap_or(&Value::Null))
    };
    for field in ["language", "module", "version", "uses", "tests"] {
        if same(sub.get(field), base.get(field)) {
            continue;
        }
        no(
            format!(
                "A sub-program adds definitions and nothing else: '{field}' stays as the runtime gave it (spec/envelope.md \"The sub-program\")."
            ),
            &format!("/{field}"),
            JsObject::new().with("field", field),
        );
    }
    let mut workflows: Vec<&str> = Vec::new();
    let mut entries: Vec<(&str, &Value)> = sub
        .get("defs")
        .and_then(Value::as_object)
        .map(|d| d.iter().collect())
        .unwrap_or_default();
    // `.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))`.
    entries.sort_by(|(a, _), (b, _)| compare_utf16(a, b));
    for (name, d) in entries {
        let at = ptr(&[&"defs", &name]);
        let kind = d.get("kind").and_then(Value::as_str).unwrap_or_default();
        if !ALLOWED.contains(&kind) {
            // `/^[aeiou]/.test(d.kind)`: ASCII, case-sensitive.
            let article = if kind.starts_with(['a', 'e', 'i', 'o', 'u']) {
                "an"
            } else {
                "a"
            };
            no(
                format!(
                    "A sub-program cannot define {article} {kind} ('{name}'). It defines only types, constants, capabilities, functions, local agents and one workflow; the rest belongs to the program a person approved (spec/envelope.md \"The sub-program\")."
                ),
                &at,
                JsObject::new().with("def", name).with("kind", kind),
            );
            continue;
        }
        if kind == "agent" && d.get("remote").is_some_and(Value::is_truthy) {
            no(
                format!(
                    "A sub-program cannot define a remote agent ('{name}'): a network binding is a governance change (G11)."
                ),
                &format!("{at}/remote"),
                JsObject::new()
                    .with("def", name)
                    .with("kind", "remote agent"),
            );
        }
        if kind == "workflow" {
            workflows.push(name);
            if d.get("envelope").is_some_and(Value::is_truthy) {
                no(
                    format!(
                        "A sub-program's workflow has no envelope of its own ('{name}'): it runs inside the one a person approved, and its caps and budget are its claim on it."
                    ),
                    &format!("{at}/envelope"),
                    JsObject::new().with("def", name).with("kind", "envelope"),
                );
            }
            let params = d
                .get("params")
                .and_then(Value::as_array)
                .map_or(0, <[Value]>::len);
            if params > 0 {
                no(
                    format!(
                        "A sub-program's workflow takes no parameters ('{name}' takes {params}): nothing calls it with arguments. Write the values it works on into the sub-program."
                    ),
                    &format!("{at}/params"),
                    JsObject::new()
                        .with("def", name)
                        .with("kind", "parameters")
                        .with("params", params),
                );
            }
        }
        let mut plans: Vec<String> = Vec::new();
        nodes(d, "plan", &at, &mut plans);
        // `plans.sort()`: the pointers as text, so `/body/10` before `/body/2`.
        sort_utf16(&mut plans);
        for path in plans {
            no(
                "A sub-program cannot 'plan': only the program a person approved starts a lead (spec/envelope.md \"The sub-program\").".to_owned(),
                &path,
                JsObject::new().with("def", name).with("kind", "plan"),
            );
        }
    }
    if workflows.len() != 1 {
        let message = if workflows.is_empty() {
            "A sub-program has exactly one workflow, which is what runs. This one has none."
                .to_owned()
        } else {
            format!(
                "A sub-program has exactly one workflow, and this one has {}: {}.",
                workflows.len(),
                list(&workflows)
            )
        };
        let names: Vec<JsValue> = workflows.iter().map(|w| JsValue::from(*w)).collect();
        no(
            message,
            "/defs",
            JsObject::new()
                .with("kind", "workflow")
                .with("workflows", names),
        );
    }
    out
}

/// The name of a sub-program's one workflow, once [`subprogram_shape`] has
/// passed it: `subprogramWorkflow(sub)`, the first definition (in the order
/// of `Object.keys`) that is a workflow.
#[must_use]
pub fn subprogram_workflow(sub: &Value) -> Option<String> {
    sub.get("defs")
        .and_then(Value::as_object)?
        .iter()
        .find(|(_, d)| Definition::of(d).kind() == Some(DefKind::Workflow))
        .map(|(n, _)| n.to_owned())
}

/// What is left of an envelope when a sub-program asks for a part of it:
/// `Room`. The runtime reads it from the run's ledger.
#[derive(Clone, Debug, PartialEq)]
pub struct Room {
    /// What the run has left in each ledger dimension it is limited in:
    /// `limit − settled − active reservations`, by dimension, in the order
    /// of the object (`tokens`, `steps`, `agents` and `spend:<currency>` in
    /// micro-units).
    pub left: Vec<(String, f64)>,
    /// Milliseconds to the run's deadline; none when the envelope names no
    /// time.
    pub time_left_ms: Option<f64>,
    /// The write capabilities that sub-programs and map items still in
    /// flight hold.
    pub writes: Vec<CapVal>,
}

impl Room {
    /// The room a stored `room` stands for: `{ left, time_left_ms?, writes }`,
    /// each write a capability as the TypeScript's `CapVal` is written
    /// (`ctor`, `effect`, `write`, and the members it has). `left` is read
    /// as the object `{ ...left }` is, in ECMAScript order.
    ///
    /// # Errors
    ///
    /// What of the room is not of the shape of a [`Room`].
    pub fn from_value(room: &Value) -> Result<Room, String> {
        let left = room
            .get("left")
            .and_then(Value::as_object)
            .ok_or("room.left is not an object")?
            .iter()
            .map(|(k, v)| {
                v.as_i64()
                    .map(|n| (k.to_owned(), n as f64))
                    .ok_or_else(|| format!("room.left.{k} is not a number"))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let time_left_ms = match room.get("time_left_ms") {
            None => None,
            Some(v) => Some(
                v.as_i64()
                    .map(|n| n as f64)
                    .ok_or("room.time_left_ms is not a number")?,
            ),
        };
        let writes = room
            .get("writes")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .iter()
            .map(cap_val_of)
            .collect::<Result<Vec<_>, _>>()?;
        Ok(Room {
            left,
            time_left_ms,
            writes,
        })
    }

    /// `Object.hasOwn(room.left, dimension) ? room.left[dimension] : undefined`.
    fn left_of(&self, dimension: &str) -> Option<f64> {
        self.left
            .iter()
            .find(|(d, _)| d == dimension)
            .map(|(_, n)| *n)
    }
}

/// A capability value as the TypeScript writes it in JSON, with the members
/// it has in the order it has them.
fn cap_val_of(v: &Value) -> Result<CapVal, String> {
    let map = v.as_object().ok_or("a write is not an object")?;
    let text = |k: &str| map.get(k).and_then(Value::as_str).map(str::to_owned);
    let strings = |k: &str| {
        map.get(k).and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
    };
    let ctor = text("ctor").ok_or("a write has no ctor")?;
    let effect = text("effect").ok_or("a write has no effect")?;
    let write = matches!(map.get("write"), Some(Value::Bool(true)));
    let mut cap = CapVal::new(ctor, effect, write);
    // The setters place a member as assignment does: in the order of the object.
    for (k, _) in map.iter() {
        match k {
            "name" => cap.set_name(text("name")),
            "via" => cap.set_via(text("via")),
            "components" => cap.set_components(strings("components")),
            "root" => cap.set_root(text("root")),
            "scope" => cap.set_scope(strings("scope")),
            "max_class" => cap.set_max_class(
                map.get("max_class")
                    .and_then(Value::as_str)
                    .and_then(DataClass::from_name),
            ),
            "tier" => cap.set_tier(text("tier")),
            "methods" => cap.set_methods(strings("methods")),
            _ => {}
        }
    }
    Ok(cap)
}

/// A budget's amount in each ledger dimension it names, and where it is
/// written under the budget: `claimed(b)`. The time is left out.
fn claimed(b: Option<&Value>) -> Vec<(String, &'static str, i64)> {
    let mut out = Vec::new();
    for field in BUDGET_DIMENSIONS {
        let Some(amount) = budget_amount(b, field) else {
            continue;
        };
        if field == "time" {
            continue;
        }
        let dimension = if field == "spend" {
            let currency = b
                .and_then(|b| b.get("spend"))
                .and_then(|s| s.get("currency"))
                .and_then(Value::as_str)
                .unwrap_or("undefined");
            format!("spend:{currency}")
        } else {
            field.to_owned()
        };
        out.push((dimension, field, amount));
    }
    out
}

/// `x` as a fact.
fn num(x: f64) -> JsValue {
    JsValue::Number(x)
}

/// E1706: whether a sub-program's claim fits what is left of the envelope
/// (N01, INV-15): `containment(defs, workflow, envelope, room, opts)`.
/// `defs` is every definition the sub-program sees, its own and its
/// parent's; `workflow` is its one workflow; `envelope` holds the
/// envelope's capabilities, evaluated; `opts` says how the sub-program's own
/// are read (its language). Each diagnostic names the dimension that does
/// not fit, with the numbers, so that the lead can ask for less.
#[must_use]
pub fn containment(
    defs: &Map,
    workflow: &str,
    envelope: &[CapVal],
    room: &Room,
    opts: CapOptions,
) -> Vec<Diagnostic> {
    let mut out: Vec<Diagnostic> = Vec::new();
    let Some(wf) = defs
        .get(workflow)
        .filter(|d| Definition::of(d).kind() == Some(DefKind::Workflow))
    else {
        return out;
    };
    let at = ptr(&[&"defs", &workflow]);
    let mut no = |message: String, path: &str, facts: JsObject| {
        out.push(diagnostic("E1706", message, path, facts));
    };

    // C2: every capability lies inside one the envelope holds. C5 across
    // the run: none may write where something still in flight writes.
    for (i, e) in Definition::of(wf).caps().iter().enumerate() {
        let Some(e) = Expr::of(e) else { continue };
        for c in caps_of(defs, e, opts) {
            let shown = show_cap(&c);
            if !envelope.iter().any(|w| cap_covers(w, &c)) {
                let held: Vec<JsValue> = envelope
                    .iter()
                    .map(|w| JsValue::from(show_cap(w)))
                    .collect();
                no(
                    format!(
                        "{workflow} asks for {shown}, which lies inside no capability of the envelope. A sub-program holds only what the envelope's owner approved (C2)."
                    ),
                    &format!("{at}/caps/{i}"),
                    JsObject::new()
                        .with("dimension", "capability")
                        .with("capability", shown.as_str())
                        .with("envelope", held),
                );
                continue;
            }
            if let Some(held) = room.writes.iter().find(|w| writes_overlap(w, &c)) {
                no(
                    format!(
                        "{workflow} asks for {shown}, and {} is still held by a part of the run that has not ended. Two parts of a run do not write the same place at once (C5).",
                        show_cap(held)
                    ),
                    &format!("{at}/caps/{i}"),
                    JsObject::new()
                        .with("dimension", "write_scope")
                        .with("capability", shown.as_str())
                        .with("in_flight", show_cap(held)),
                );
            }
        }
    }

    // The budget is what admission reserves, so it names every dimension
    // the run is limited in, and fits.
    let budget = wf.get("budget");
    let has_budget = budget.is_some_and(Value::is_truthy);
    let asked = claimed(budget);
    let mut dimensions: Vec<&str> = room.left.iter().map(|(d, _)| d.as_str()).collect();
    sort_utf16(&mut dimensions);
    for dimension in dimensions {
        if asked.iter().any(|(d, _, _)| d == dimension) {
            continue;
        }
        no(
            format!(
                "{workflow}'s budget names no {dimension}. A sub-program reserves what it may use of the envelope in every dimension the run is limited in."
            ),
            &if has_budget {
                format!("{at}/budget")
            } else {
                at.clone()
            },
            JsObject::new()
                .with("dimension", dimension)
                .with("asked", JsValue::Null)
                .with("left", room.left_of(dimension).map(num)),
        );
    }
    for (dimension, field, amount) in &asked {
        let left = room.left_of(dimension);
        // A dimension the run has no limit in is not held to one; money in
        // a currency the envelope does not give is.
        let spend_limited = room.left.iter().any(|(d, _)| d.starts_with("spend:"));
        if left.is_none() && !(*field == "spend" && spend_limited) {
            continue;
        }
        let amount = *amount as f64;
        let left = left.unwrap_or(0.0);
        if amount <= left {
            continue;
        }
        no(
            format!(
                "{workflow} asks for {} {dimension}, and the envelope has {} left.",
                number_to_string(amount),
                number_to_string(left)
            ),
            &format!("{at}/budget/{field}"),
            JsObject::new()
                .with("dimension", dimension.as_str())
                .with("asked", num(amount))
                .with("left", num(left)),
        );
    }
    if let Some(time_left) = room.time_left_ms {
        match budget_amount(budget, "time") {
            None => no(
                format!(
                    "{workflow}'s budget names no time. A sub-program says how long it may take, which must end before the run's deadline."
                ),
                &if has_budget {
                    format!("{at}/budget")
                } else {
                    at.clone()
                },
                JsObject::new()
                    .with("dimension", "time")
                    .with("asked", JsValue::Null)
                    .with("left", num(time_left)),
            ),
            Some(time) if time as f64 > time_left => no(
                format!(
                    "{workflow} asks for {time} ms, and the run's deadline is {} ms away.",
                    number_to_string(time_left.max(0.0))
                ),
                &format!("{at}/budget/time"),
                JsObject::new()
                    .with("dimension", "time")
                    .with("asked", num(time as f64))
                    .with("left", num(time_left)),
            ),
            Some(_) => {}
        }
    }
    out
}

/// The program of a sub-program's view, as a typed view: its language.
#[must_use]
pub fn language_of(program: &Value) -> Option<Language> {
    Program::of(program).and_then(Program::language)
}
