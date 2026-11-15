//! The authority signature of a library (spec/library.md "The authority
//! signature"): for each `pub` workflow, pattern, connector and agent of its
//! modules, what it can do, and whether a new version widens it.
//!
//! - **A workflow** (its expansion, when it applies a pattern): the
//!   capabilities its `caps` (or its envelope's) stand for, the effects its
//!   body runs with how each is authorized (`not critical`, `critical`,
//!   `irreversible`; a connector's write tool is critical), its budget, the
//!   roles it waits for (a review's `role` and `escalate_to`, an
//!   escalation's, an approval's, its envelope's owner and approvals) and the
//!   highest data class a model capability of it may receive.
//! - **An agent**: its capabilities, its budget and that class.
//! - **A pattern**: its shape, the digest of its type parameters, slots, run
//!   parameters, result and body. What a pattern can do is a formula in its
//!   slots (`max_items ×` the budget of `work`, …), and any other shape is
//!   another formula: a pattern whose shape changed widens.
//! - **A connector**: its server's URL, its class, and each tool with its
//!   class, `read_only` or `write` and its retry class.
//!
//! A new version widens a definition's signature ([`widenings`]) when it
//! needs a capability no capability of the old one covers
//! ([`crate::cap_covers`]), runs an effect the old one did not or authorizes
//! one more strictly (critical, then irreversible), raises or lifts a budget
//! ([`crate::diff::budget_changes`]), waits for a role the old one did not,
//! lets a model receive a higher class, has another pattern shape, another
//! connector URL or a higher connector class, a tool it did not have, a
//! read-only tool that writes or a write tool with another retry class, or
//! is another kind of definition; and a `pub` workflow, pattern, connector
//! or agent the old version did not have widens it too. A `doc` line is not
//! part of any of these.

use std::collections::{BTreeMap, BTreeSet};

use mandate_ir::{
    ConnectorDef, DefKind, Definition, JsObject, JsValue, Map, Program, Value, domain_hash,
    workflow_bounds,
};

use crate::caps::{CapVal, cap_covers, show_cap};
use crate::diff::budget_changes;
use crate::modules::{Modules, Reach, link_reaching};
use crate::stdlib::DataClass;
use crate::view_shared::{caps_in, effect_info};

/// How an effect is authorized, from the least to the strictest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Authorized {
    /// Not a critical effect.
    NotCritical,
    /// A critical effect: policy or a person authorizes it.
    Critical,
    /// An irreversible effect.
    Irreversible,
}

impl Authorized {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Authorized::NotCritical => "not_critical",
            Authorized::Critical => "critical",
            Authorized::Irreversible => "irreversible",
        }
    }
}

/// The signature of one definition.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    /// `workflow`, `agent`, `pattern` or `connector`.
    pub kind: &'static str,
    /// The capabilities it holds (a workflow, an agent).
    pub caps: Vec<CapVal>,
    /// The effects its body runs, by name, with how each is authorized.
    pub effects: BTreeMap<String, Authorized>,
    /// Its budget, as written (a workflow, an agent).
    pub budget: Option<Value>,
    /// The roles it waits for.
    pub roles: BTreeSet<String>,
    /// The highest class a model capability of it may receive.
    pub max_class: Option<DataClass>,
    /// A pattern's shape: the digest of what it is.
    pub shape: Option<String>,
    /// A connector's server URL.
    pub url: Option<String>,
    /// A connector's class.
    pub class: Option<String>,
    /// A connector's tools: `read_only`, or `write <retry class>`.
    pub tools: BTreeMap<String, String>,
}

impl Entry {
    fn new(kind: &'static str) -> Entry {
        Entry {
            kind,
            caps: Vec::new(),
            effects: BTreeMap::new(),
            budget: None,
            roles: BTreeSet::new(),
            max_class: None,
            shape: None,
            url: None,
            class: None,
            tools: BTreeMap::new(),
        }
    }

    /// The entry as JSON: `{ kind, … }` with the members of its kind.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let strings = |xs: Vec<String>| JsValue::Array(xs.into_iter().map(JsValue::from).collect());
        let mut out = JsObject::new().with("kind", self.kind);
        match self.kind {
            "workflow" | "agent" => {
                let mut caps: Vec<String> = self.caps.iter().map(show_cap).collect();
                caps.sort();
                caps.dedup();
                out.insert("caps", strings(caps));
                if self.kind == "workflow" {
                    out.insert(
                        "effects",
                        self.effects
                            .iter()
                            .map(|(e, a)| (e.as_str(), a.as_str()))
                            .collect::<JsObject>(),
                    );
                    out.insert("roles", strings(self.roles.iter().cloned().collect()));
                }
                out.insert(
                    "budget",
                    self.budget.as_ref().map_or(JsValue::Null, JsValue::from),
                );
                out.insert(
                    "max_class",
                    self.max_class.map_or(JsValue::Null, |c| c.as_str().into()),
                );
            }
            "pattern" => {
                out.insert("shape", self.shape.clone().unwrap_or_default());
            }
            _ => {
                out.insert("url", self.url.clone().unwrap_or_default());
                out.insert("class", self.class.clone().unwrap_or_default());
                out.insert(
                    "tools",
                    self.tools
                        .iter()
                        .map(|(t, c)| (t.as_str(), c.as_str()))
                        .collect::<JsObject>(),
                );
            }
        }
        out
    }
}

/// A library's authority signature: each `pub` workflow, pattern,
/// connector and agent of its modules, by `<module>.<name>`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Signature {
    /// The entries, by `<module>.<name>`.
    pub entries: BTreeMap<String, Entry>,
}

impl Signature {
    /// The signature as JSON: `{ "<module>.<name>": entry, … }`, by name.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        self.entries
            .iter()
            .map(|(n, e)| (n.as_str(), JsValue::Object(e.to_js())))
            .collect()
    }
}

/// One way a new signature widens an old one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Widening {
    /// The definition, `<module>.<name>`.
    pub name: String,
    /// What widened: `added`, `kind`, `capability`, `effect`, `budget`,
    /// `role`, `class`, `shape`, `url`, `connector_class` or `tool`.
    pub what: &'static str,
    /// The change, for a person.
    pub text: String,
}

impl Widening {
    /// `{ name, what, text }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("name", self.name.as_str())
            .with("what", self.what)
            .with("text", self.text.as_str())
    }
}

/// The roles a body waits for: an argument `role`, `escalate_to` or
/// `distinct_from` of a call, and a supervision's `escalate` role, each a
/// name or a text.
fn roles_in(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| roles_in(x, out)),
        Value::Object(o) => {
            if o.get("op").and_then(Value::as_str) == Some("call")
                || o.get("name").and_then(Value::as_str) == Some("escalate")
            {
                for a in o.get("args").and_then(Value::as_array).unwrap_or_default() {
                    let named = a.get("name").and_then(Value::as_str);
                    if matches!(named, Some("role" | "escalate_to" | "distinct_from")) {
                        let value = a.get("value");
                        let name = value
                            .and_then(|x| x.get("name"))
                            .or_else(|| value.and_then(|x| x.get("value")))
                            .and_then(Value::as_str);
                        if let Some(r) = name {
                            out.insert(r.to_owned());
                        }
                    }
                }
            }
            o.iter().for_each(|(_, x)| roles_in(x, out));
        }
        _ => {}
    }
}

/// The effects a body runs, with how each is authorized.
fn effects_in(program: Program<'_>, defs: &Map, v: &Value, out: &mut BTreeMap<String, Authorized>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| effects_in(program, defs, x, out)),
        Value::Object(o) => {
            if o.get("op").and_then(Value::as_str) == Some("effect")
                && let Some(name) = o.get("name").and_then(Value::as_str)
            {
                let write_tool = name.split_once('.').is_some_and(|(c, t)| {
                    defs.get(c)
                        .and_then(ConnectorDef::of)
                        .and_then(|conn| conn.tool(t))
                        .is_some_and(|tool| tool.is_write())
                });
                let info = effect_info(program, name);
                let level = if info.irreversible {
                    Authorized::Irreversible
                } else if info.critical || write_tool {
                    Authorized::Critical
                } else {
                    Authorized::NotCritical
                };
                let at = out.entry(name.to_owned()).or_insert(level);
                *at = (*at).max(level);
            }
            o.iter()
                .for_each(|(_, x)| effects_in(program, defs, x, out));
        }
        _ => {}
    }
}

/// The highest class a model capability among `caps` may receive.
fn max_class(caps: &[CapVal]) -> Option<DataClass> {
    caps.iter()
        .filter(|c| c.ctor() == "model.infer")
        .map(|c| c.max_class().unwrap_or(DataClass::Internal))
        .max()
}

/// A pattern's shape: what it is, without its `doc` and `pub`.
fn shape_of(d: &Value) -> String {
    let mut m = d.as_object().cloned().unwrap_or_default();
    m.remove("doc");
    m.remove("pub");
    domain_hash(
        mandate_ir::HashDomain::Def,
        &Value::Object(m),
        mandate_ir::LIBRARY_HASH_VERSION,
    )
}

/// The signature of `module`'s `pub` definitions, its imports linked with
/// `modules` through `reach`, into `out`.
fn module_signature(
    name: &str,
    module: &Value,
    modules: &Modules,
    reach: &Reach,
    out: &mut Signature,
) {
    let Some(view) = Program::of(module) else {
        return;
    };
    // A workflow that applies a pattern is read as its expansion.
    let expanded = crate::expand::expanded_program_reaching(module, Some(modules), Some(reach));
    let source = expanded.as_ref().unwrap_or(module);
    let Some(program) = Program::of(source) else {
        return;
    };
    let linked = link_reaching(program, Some(modules), Some(reach)).defs;
    let mut with_linked = program.members().clone();
    with_linked.insert("defs", linked.clone());
    let with_linked = Value::Object(with_linked);
    let Some(lp) = Program::of(&with_linked) else {
        return;
    };
    for (def, d) in view.definitions() {
        if !d.value().get("pub").is_some_and(Value::is_truthy) {
            continue;
        }
        let key = format!("{name}.{def}");
        let value = program.defs().and_then(|x| x.get(def)).unwrap_or(d.value());
        let entry = match d.kind() {
            Some(DefKind::Workflow) => {
                let mut e = Entry::new("workflow");
                let bounds = workflow_bounds(value);
                e.caps = caps_in(lp, bounds.caps);
                e.budget = bounds.budget.cloned();
                e.max_class = max_class(&e.caps);
                let body = value.get("body").cloned().unwrap_or(Value::Null);
                effects_in(lp, &linked, &body, &mut e.effects);
                roles_in(&body, &mut e.roles);
                if let Some(env) = value.get("envelope") {
                    if let Some(owner) = env.get("owner").and_then(Value::as_str) {
                        e.roles.insert(owner.to_owned());
                    }
                    for (_, r) in env
                        .get("approve")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flat_map(Map::iter)
                    {
                        if let Some(r) = r.as_str() {
                            e.roles.insert(r.to_owned());
                        }
                    }
                }
                e
            }
            Some(DefKind::Agent) => {
                let mut e = Entry::new("agent");
                e.caps = caps_in(lp, Definition::of(value).caps());
                e.budget = value.get("budget").cloned();
                e.max_class = max_class(&e.caps);
                e
            }
            Some(DefKind::Pattern) => {
                let mut e = Entry::new("pattern");
                e.shape = Some(shape_of(value));
                e
            }
            Some(DefKind::Connector) => {
                let mut e = Entry::new("connector");
                if let Some(c) = ConnectorDef::of(value) {
                    e.url = c.mcp().map(str::to_owned);
                    for (t, tool) in c.tools() {
                        let class = if tool.is_write() {
                            format!(
                                "write {}",
                                tool.members()
                                    .get("retry_class")
                                    .and_then(Value::as_str)
                                    .unwrap_or("?")
                            )
                        } else {
                            "read_only".to_owned()
                        };
                        e.tools.insert(t.to_owned(), class);
                    }
                }
                e.class = value
                    .get("class")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                e
            }
            _ => continue,
        };
        out.entries.insert(key, entry);
    }
}

/// The authority signature of the library whose modules are `own`, with
/// `modules` all the modules it reaches (its own among them) and `reach`
/// what each reaches.
#[must_use]
pub fn signature(own: &Modules, modules: &Modules, reach: &Reach) -> Signature {
    let mut out = Signature::default();
    for (name, module) in own.iter() {
        module_signature(name, module, modules, reach, &mut out);
    }
    out
}

/// The class of a connector, ranked; an unknown one ranks above all.
fn class_rank(c: Option<&str>) -> usize {
    c.and_then(DataClass::from_name)
        .and_then(|d| DataClass::ALL.iter().position(|x| *x == d))
        .unwrap_or(DataClass::ALL.len())
}

/// Every way `new` widens `old`, by definition and then in the order the
/// members are compared.
#[must_use]
pub fn widenings(old: &Signature, new: &Signature) -> Vec<Widening> {
    let mut out = Vec::new();
    for (name, n) in &new.entries {
        let mut w = |what: &'static str, text: String| {
            out.push(Widening {
                name: name.clone(),
                what,
                text,
            });
        };
        let Some(o) = old.entries.get(name) else {
            w("added", format!("+ {} {name}", n.kind));
            continue;
        };
        if o.kind != n.kind {
            w("kind", format!("~ {name}: {} → {}", o.kind, n.kind));
            continue;
        }
        for c in &n.caps {
            if !o.caps.iter().any(|x| cap_covers(x, c)) {
                w("capability", format!("+ {name}: {}", show_cap(c)));
            }
        }
        for (e, level) in &n.effects {
            match o.effects.get(e) {
                None => w(
                    "effect",
                    format!("+ {name}: effect {e} ({})", level.as_str()),
                ),
                Some(was) if level > was => w(
                    "effect",
                    format!("~ {name}: effect {e} {} → {}", was.as_str(), level.as_str()),
                ),
                Some(_) => {}
            }
        }
        if o.kind != "pattern" && o.kind != "connector" {
            for t in budget_changes(name, o.budget.as_ref(), n.budget.as_ref()).up {
                w("budget", format!("~ {t}"));
            }
        }
        for r in n.roles.difference(&o.roles) {
            w("role", format!("+ {name}: waits for {r}"));
        }
        if n.max_class > o.max_class {
            let shown = |c: Option<DataClass>| c.map_or("none", DataClass::as_str);
            w(
                "class",
                format!(
                    "~ {name}: a model may receive {} → {}",
                    shown(o.max_class),
                    shown(n.max_class)
                ),
            );
        }
        if o.shape != n.shape {
            w("shape", format!("~ pattern {name}: another shape"));
        }
        if o.url != n.url {
            w(
                "url",
                format!(
                    "~ connector {name}: server {} → {}",
                    o.url.as_deref().unwrap_or("none"),
                    n.url.as_deref().unwrap_or("none")
                ),
            );
        }
        if class_rank(n.class.as_deref()) > class_rank(o.class.as_deref()) {
            w(
                "connector_class",
                format!(
                    "~ connector {name}.class: {} → {}",
                    o.class.as_deref().unwrap_or("none"),
                    n.class.as_deref().unwrap_or("none")
                ),
            );
        }
        for (t, class) in &n.tools {
            match o.tools.get(t) {
                None => w("tool", format!("+ connector {name}: tool {t} ({class})")),
                Some(was) if was != class && class != "read_only" => {
                    w("tool", format!("~ connector {name}.{t}: {was} → {class}"));
                }
                Some(_) => {}
            }
        }
    }
    out
}
