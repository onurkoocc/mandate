//! Comparing two programs: the semantic diff (§15.3), from
//! `compiler/src/views/views.ts` lines 670-1140. What changed in authority
//! and in behavior between two versions of a program, each change as a line
//! a person reads, with the JSON pointer of where it is.
//!
//! [`classify`] is the one place that decides what a change is; both
//! [`semantic_diff`] (a view of two programs) and [`governance_changes`]
//! (what a patch reports) read it, so a view and a patch classify a change
//! alike. The people the two locks bind and what they ask of the host and a
//! sandbox are [`crate::lock_diff`].
//!
//! The order of everything is the TypeScript's: definitions by name in
//! UTF-16 order, the changes of each in the order of the code, and, for a
//! comparison of two sets, the first set's order then the second's. The
//! texts are copied character for character, oddities included (see the
//! notes at [`semantic_diff`]).

use mandate_ir::{
    Definition, JsObject, JsValue, Map, Program, Value, budget_amount, canonicalize, ptr_token,
    sort_utf16, unique_in_order, workflow_bounds,
};

use crate::caps::{CapVal, show_cap, within};
use crate::lock_diff::{lock_diff, lock_limits_diff};
use crate::modules::{Modules, linked_program};
use crate::view_shared::{
    Graph, ProgramRef, VIEW_FORMAT, caps_in, defs_of, duration, is_system, j, j_or_null, js_text,
    json_string, kind_text, method_of, micros_text, program_ref, workflow_effects,
};

/// One change: where it is, and what it is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Change {
    /// A JSON Pointer into the program (or the lock).
    pub path: String,
    /// The change as a person reads it.
    pub text: String,
}

impl Change {
    /// A change at `path`.
    #[must_use]
    pub fn new(path: impl Into<String>, text: impl Into<String>) -> Change {
        Change {
            path: path.into(),
            text: text.into(),
        }
    }

    /// `{ path, text }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("path", self.path.as_str())
            .with("text", self.text.as_str())
            .into()
    }
}

/// The semantic diff of two programs: `DiffView`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiffView {
    /// The program before.
    pub from: ProgramRef,
    /// The program after.
    pub to: ProgramRef,
    /// Changes a person must approve (§13.2): authority widened, budgets
    /// raised, criteria removed or changed, irreversible effects.
    pub governance: Vec<Change>,
    /// The other changes.
    pub behavior: Vec<Change>,
    /// What stayed the same.
    pub unchanged: Vec<String>,
}

impl DiffView {
    /// The view as `JSON.stringify` writes it: `{ format, kind, from, to,
    /// governance, behavior, unchanged }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let changes = |cs: &[Change]| JsValue::Array(cs.iter().map(Change::to_js).collect());
        JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "diff")
            .with("from", self.from.to_js())
            .with("to", self.to.to_js())
            .with("governance", changes(&self.governance))
            .with("behavior", changes(&self.behavior))
            .with(
                "unchanged",
                JsValue::Array(
                    self.unchanged
                        .iter()
                        .map(|u| JsValue::from(u.as_str()))
                        .collect(),
                ),
            )
            .into()
    }
}

/// What a comparison of capabilities found: `{ added, removed, other }`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ScopeDiff {
    /// What the later capability allows and the earlier did not.
    pub added: Vec<String>,
    /// What the earlier allowed and the later does not.
    pub removed: Vec<String>,
    /// Other changes (a tier, a data class, argument prefixes, methods).
    pub other: Vec<String>,
}

/// `j(x ?? null)` of a list of lists of strings, as one of a capability's
/// argument prefixes; `none` when there are none.
fn prefixes_text(p: Option<&[Vec<String>]>, none: &str) -> String {
    match p {
        None => none.to_owned(),
        Some(ps) => {
            let rows: Vec<String> = ps.iter().map(|row| strings_text(row)).collect();
            format!("[{}]", rows.join(","))
        }
    }
}

/// The canonical text of a list of strings.
fn strings_text(xs: &[String]) -> String {
    let items: Vec<String> = xs.iter().map(|x| json_string(x)).collect();
    format!("[{}]", items.join(","))
}

/// One capability's scope change: `scopeDiff(before, after)`.
#[must_use]
pub fn scope_diff(before: Option<&CapVal>, after: Option<&CapVal>) -> ScopeDiff {
    let label = |c: &CapVal| match c.ctor() {
        "fs.read" => "read path",
        "fs.write" => "write path",
        "net.https" => "network host",
        "exec" => "command",
        "git.pr" => "repository",
        _ => "scope",
    };
    let Some(after) = after else {
        return ScopeDiff {
            removed: before.map(show_cap).into_iter().collect(),
            ..ScopeDiff::default()
        };
    };
    let Some(before_same) = before.filter(|b| b.ctor() == after.ctor()) else {
        return ScopeDiff {
            added: vec![show_cap(after)],
            removed: before.map(show_cap).into_iter().collect(),
            other: Vec::new(),
        };
    };
    let before = before_same;
    // A new path inside an old one widens nothing; an old path still inside a new one was not taken away.
    let fs = after.ctor().starts_with("fs.");
    let covered =
        |x: &str, by: &[String]| by.iter().any(|y| if fs { within(x, y) } else { x == y });
    let b: &[String] = before.scope().unwrap_or_default();
    let a: &[String] = after.scope().unwrap_or_default();
    let mut added: Vec<String> = a
        .iter()
        .filter(|x| !covered(x, b))
        .map(|x| format!("{} {}", label(after), json_string(x)))
        .collect();
    let mut removed: Vec<String> = b
        .iter()
        .filter(|x| !a.contains(x))
        .map(|x| format!("{} {}", label(after), json_string(x)))
        .collect();
    if before.scope().is_some() && after.scope().is_none() {
        added.push(format!(
            "{}s without a static scope (unbounded)",
            label(after)
        ));
    }
    let mut other: Vec<String> = Vec::new();
    if before.tier() != after.tier() {
        other.push(format!(
            "model tier {} → {}",
            before.tier().unwrap_or("any"),
            after.tier().unwrap_or("any")
        ));
    }
    let class = |c: &CapVal| c.max_class().map_or("internal", |m| m.as_str());
    if class(before) != class(after) {
        other.push(format!(
            "data class up to {} → {}",
            class(before),
            class(after)
        ));
    }
    if prefixes_text(before.args_prefix(), "null") != prefixes_text(after.args_prefix(), "null") {
        other.push(format!(
            "argument prefixes {} → {}",
            prefixes_text(before.args_prefix(), "\"any\""),
            prefixes_text(after.args_prefix(), "\"any\"")
        ));
    }
    // Methods (0.5): one more method, or none named where some were, widens; fewer narrows.
    let methods_text = |m: Option<&[String]>| m.map_or_else(|| "any".to_owned(), |m| m.join(", "));
    let methods_j = |m: Option<&[String]>| m.map_or_else(|| "null".to_owned(), strings_text);
    if methods_j(before.methods()) != methods_j(after.methods()) {
        let widened = match (before.methods(), after.methods()) {
            (_, None) => true,
            (Some(bm), Some(am)) => am.iter().any(|m| !bm.contains(m)),
            (None, Some(_)) => false,
        };
        let text = format!(
            "methods {} → {}",
            methods_text(before.methods()),
            methods_text(after.methods())
        );
        if widened {
            other.push(text);
        } else {
            removed.push(text);
        }
    }
    ScopeDiff {
        added,
        removed,
        other,
    }
}

/// Field by field, what changed in a component, an interface or an
/// environment: `systemChanges(name, b, a)`.
#[must_use]
pub fn system_changes(name: &str, b: &Value, a: &Value) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let kind = kind_text(a);
    let mut field = |label: &str, x: Option<&Value>, y: Option<&Value>| {
        if j_or_null(x) != j_or_null(y) {
            out.push(format!(
                "{kind} {name}.{label}: {} → {}",
                j_or_null(x),
                j_or_null(y)
            ));
        }
    };
    let (bk, ak) = (
        b.get("kind").and_then(Value::as_str),
        a.get("kind").and_then(Value::as_str),
    );
    if ak == Some("component") && bk == Some("component") {
        for f in [
            "repo",
            "root",
            "lang",
            "owner",
            "build",
            "test",
            "provides",
            "consumes",
            "governance",
        ] {
            field(f, b.get(f), a.get(f));
        }
    } else if ak == Some("interface") && bk == Some("interface") {
        field("protocol", b.get("protocol"), a.get("protocol"));
        field("spec", b.get("spec"), a.get("spec"));
    } else if ak == Some("environment") && bk == Some("environment") {
        field("class", b.get("class"), a.get("class"));
        for key in ["reads", "authorize"] {
            let (bo, ao) = (object_member(b, key), object_member(a, key));
            let mut names = unique_in_order(
                bo.into_iter()
                    .chain(ao)
                    .flat_map(Map::keys)
                    .map(str::to_owned),
            );
            sort_utf16(&mut names);
            for r in names {
                field(
                    &format!("{key}.{r}"),
                    bo.and_then(|m| m.get(&r)),
                    ao.and_then(|m| m.get(&r)),
                );
            }
        }
    }
    out
}

/// [`scope_diff`] over what two capability definitions stand for, paired by
/// kind (and by command for `exec`): `scopeDiffs(before, after)`.
#[must_use]
pub fn scope_diffs(before: &[CapVal], after: &[CapVal]) -> ScopeDiff {
    let key = |c: &CapVal| {
        if c.ctor() == "exec" {
            format!("exec:{}", c.scope().unwrap_or_default().join(","))
        } else {
            c.ctor().to_owned()
        }
    };
    let mut keys = unique_in_order(before.iter().chain(after).map(key));
    sort_utf16(&mut keys);
    let mut out = ScopeDiff::default();
    for k in keys {
        let d = scope_diff(
            before.iter().find(|c| key(c) == k),
            after.iter().find(|c| key(c) == k),
        );
        out.added.extend(d.added);
        out.removed.extend(d.removed);
        out.other.extend(d.other);
    }
    out
}

/// The capabilities of the expression `e` as text, or the expression itself
/// where it stands for none: `shownCaps(p, e)`.
#[must_use]
pub fn shown_caps(program: Program<'_>, e: &Value) -> String {
    let caps = caps_in(program, std::slice::from_ref(e));
    let text = caps.iter().map(show_cap).collect::<Vec<_>>().join(", ");
    if text.is_empty() { j(e) } else { text }
}

/// What [`budget_changes`] gives: `{ up, down }`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BudgetChanges {
    /// A limit raised or taken away.
    pub up: Vec<String>,
    /// A limit lowered or put in place.
    pub down: Vec<String>,
}

/// A budget's dimensions in the order a person reads them: what it costs
/// first. `SHOWN_DIMENSIONS`.
const SHOWN_DIMENSIONS: [&str; 5] = ["spend", "tokens", "steps", "time", "agents"];

/// An amount of each dimension, as a change between two budgets shows it:
/// `AMOUNT_TEXT[dim](n, currency)`.
fn amount_text(dim: &str, n: i64, currency: &str) -> String {
    match dim {
        "time" => duration(n),
        "spend" => format!("{} {currency}", micros_text(n)),
        _ => n.to_string(),
    }
}

/// What changed between two budgets, as lines of `up` (raised or lifted: a
/// person approves) and `down`: `budgetChanges(name, before, after)`.
#[must_use]
pub fn budget_changes(name: &str, before: Option<&Value>, after: Option<&Value>) -> BudgetChanges {
    let mut out = BudgetChanges::default();
    let was = before
        .and_then(|b| b.get("spend"))
        .filter(|s| s.is_truthy());
    let now = after.and_then(|b| b.get("spend")).filter(|s| s.is_truthy());
    let cur = now
        .and_then(|s| s.get("currency"))
        .or(was.and_then(|s| s.get("currency")))
        .and_then(Value::as_str)
        .unwrap_or_default();
    for dim in SHOWN_DIMENSIONS {
        // Amounts in two currencies are not comparable: a person approves the change (as apply_patch reports it).
        if let (true, Some(w), Some(n)) = (dim == "spend", was, now)
            && w.get("currency") != n.get("currency")
        {
            out.up.push(format!(
                "{name}.budget.spend: {} {} → {} {}",
                micros_of(w),
                js_text(w.get("currency")),
                micros_of(n),
                js_text(n.get("currency"))
            ));
            continue;
        }
        let x = budget_amount(before, dim);
        let y = budget_amount(after, dim);
        let line = |x: i64, y: i64| {
            format!(
                "{name}.budget.{dim}: {} → {}",
                amount_text(dim, x, cur),
                amount_text(dim, y, cur)
            )
        };
        match (x, y) {
            (None, None) => {}
            (Some(x), None) => out.up.push(format!(
                "{name}.budget.{dim}: {} → no limit",
                amount_text(dim, x, cur)
            )),
            (None, Some(y)) => out.down.push(format!(
                "{name}.budget.{dim}: no limit → {}",
                amount_text(dim, y, cur)
            )),
            (Some(x), Some(y)) if y > x => out.up.push(line(x, y)),
            (Some(x), Some(y)) if y < x => out.down.push(line(x, y)),
            (Some(_), Some(_)) => {}
        }
    }
    out
}

/// `${was.micros / 1_000_000}`.
fn micros_of(spend: &Value) -> String {
    spend
        .get("micros")
        .and_then(Value::as_i64)
        .map_or_else(|| "NaN".to_owned(), micros_text)
}

/// What a workflow does, as the labels of its steps with their grant and
/// supervision: `steps(program, wf)`. A contract's criteria are compared as
/// the contract.
#[must_use]
pub fn steps<'a>(program: Program<'a>, wf: &'a Value) -> Vec<String> {
    let mut g = Graph::new(program, wf);
    g.block(Definition::of(wf).body(), Vec::new());
    g.nodes
        .iter()
        .map(|n| {
            let prefix = match n.kind.as_str() {
                "delegate" => "delegate ",
                "effect" => "effect ",
                _ => "",
            };
            let detail = if n.kind.as_str() != "verify" && !n.detail.is_empty() {
                format!(" [{}]", n.detail.join(", "))
            } else {
                String::new()
            };
            format!("{prefix}{}{detail}", n.label)
        })
        .collect()
}

/// The object member `key` of `v`.
fn object_member<'a>(v: &'a Value, key: &str) -> Option<&'a Map> {
    v.get(key)?.as_object()
}

/// The envelope of the workflow `workflow` of `p`, when it is one and has one.
fn envelope_of<'a>(p: Program<'a>, workflow: &str) -> Option<&'a Value> {
    p.defs()?
        .get(workflow)
        .filter(|d| d.get("kind").and_then(Value::as_str) == Some("workflow"))?
        .get("envelope")
        .filter(|e| e.is_truthy())
}

/// What changed in a workflow's envelope, line by line: what the one
/// `envelope_changed` of a diff stands for. The owner who decides an
/// amendment is shown these lines beside the hash they sign for
/// (spec/envelope.md "Amendments"). Nothing, when the workflow has no
/// envelope on one side: then the envelope came or went whole.
/// `envelopeChanges(before, after, workflow, modules)`.
#[must_use]
pub fn envelope_changes(
    before: &Value,
    after: &Value,
    workflow: &str,
    modules: Option<&Modules>,
) -> Vec<Change> {
    let (Some(bp), Some(ap)) = (Program::of(before), Program::of(after)) else {
        return Vec::new();
    };
    let (Some(b), Some(a)) = (envelope_of(bp, workflow), envelope_of(ap, workflow)) else {
        return Vec::new();
    };
    let linked = modules.is_some_and(|m| !m.is_empty());
    let (lb_value, la_value);
    let (lb, la) = if linked {
        lb_value = linked_program(bp, modules);
        la_value = linked_program(ap, modules);
        (
            Program::of(&lb_value).unwrap_or(bp),
            Program::of(&la_value).unwrap_or(ap),
        )
    } else {
        (bp, ap)
    };
    let at = format!("/defs/{}/envelope", ptr_token(workflow));
    let name = format!("{workflow}.envelope");
    let mut out: Vec<Change> = Vec::new();
    if b.get("owner") != a.get("owner") {
        out.push(Change::new(
            format!("{at}/owner"),
            format!(
                "~ {name}.owner: {} → {}",
                b.get("owner")
                    .map_or_else(|| "nobody".to_owned(), |o| js_text(Some(o))),
                a.get("owner")
                    .map_or_else(|| "nobody".to_owned(), |o| js_text(Some(o)))
            ),
        ));
    }
    let caps = |e: &Value| -> Vec<Value> {
        e.get("caps")
            .and_then(Value::as_array)
            .unwrap_or_default()
            .to_vec()
    };
    let (bc, ac) = (caps(b), caps(a));
    let had: Vec<String> = bc.iter().map(j).collect();
    let has: Vec<String> = ac.iter().map(j).collect();
    for (i, c) in ac.iter().enumerate() {
        if !had.contains(&j(c)) {
            out.push(Change::new(
                format!("{at}/caps/{i}"),
                format!("+ {name}: {}", shown_caps(la, c)),
            ));
        }
    }
    for c in &bc {
        if !has.contains(&j(c)) {
            out.push(Change::new(
                format!("{at}/caps"),
                format!("- {name}: {}", shown_caps(lb, c)),
            ));
        }
    }
    let budget = budget_changes(&name, b.get("budget"), a.get("budget"));
    for t in budget.up.iter().chain(&budget.down) {
        out.push(Change::new(format!("{at}/budget"), format!("~ {t}")));
    }
    let at_once = |e: &Value| match e.get("spawn").and_then(|s| s.get("max_concurrent")) {
        None => "no bound".to_owned(),
        Some(v) => js_text(Some(v)),
    };
    if at_once(b) != at_once(a) {
        out.push(Change::new(
            format!("{at}/spawn/max_concurrent"),
            format!(
                "~ {name}.spawn.max_concurrent: {} → {}",
                at_once(b),
                at_once(a)
            ),
        ));
    }
    let class = |e: &Value| match e.get("spawn").and_then(|s| s.get("max_class")) {
        None | Some(Value::Null) => "internal".to_owned(),
        Some(v) => js_text(Some(v)),
    };
    if class(b) != class(a) {
        out.push(Change::new(
            format!("{at}/spawn/max_class"),
            format!("~ {name}.spawn.max_class: {} → {}", class(b), class(a)),
        ));
    }
    let (ba, aa) = (object_member(b, "approve"), object_member(a, "approve"));
    let mut effects = unique_in_order(
        ba.into_iter()
            .chain(aa)
            .flat_map(Map::keys)
            .map(str::to_owned),
    );
    sort_utf16(&mut effects);
    for effect in effects {
        let was = ba.and_then(|m| m.get(&effect));
        let now = aa.and_then(|m| m.get(&effect));
        if was == now {
            continue;
        }
        let text = match (was, now) {
            (None, now) => format!("+ {name}.approve: {effect} by {}", js_text(now)),
            (was, None) => format!("- {name}.approve: {effect} by {}", js_text(was)),
            (was, now) => format!(
                "~ {name}.approve: {effect} by {} → {}",
                js_text(was),
                js_text(now)
            ),
        };
        out.push(Change::new(
            format!("{at}/approve/{}", ptr_token(&effect)),
            text,
        ));
    }
    out
}

/// What a governance change (§13.2) is, as a machine reads it. The diff
/// shows only each change's text; `mandate.apply_patch` and `mandate patch`
/// report the kind with it ([`governance_changes`]): `GovernanceChangeKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GovernanceChangeKind {
    /// Authority widened: a capability added or widened, or one more held by
    /// an agent or a workflow.
    CapabilityAdded,
    /// A budget raised, or a limit taken away.
    BudgetIncreased,
    /// A criterion removed, or a whole contract with its criteria.
    CriterionRemoved,
    /// A criterion checked by another method.
    CriterionChanged,
    /// A contract's `require` changed.
    RequireChanged,
    /// An effect became irreversible, or a new one is.
    IrreversibleAdded,
    /// The system model changed.
    SystemModelChanged,
    /// A workflow's envelope came, went or changed.
    EnvelopeChanged,
    /// A remote agent was added.
    RemoteAgentAdded,
    /// A remote agent's binding changed.
    RemoteBindingChanged,
    /// A definition replaced by one of another kind under the same name.
    KindChanged,
}

impl GovernanceChangeKind {
    /// The name a machine reads, such as `capability_added`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            GovernanceChangeKind::CapabilityAdded => "capability_added",
            GovernanceChangeKind::BudgetIncreased => "budget_increased",
            GovernanceChangeKind::CriterionRemoved => "criterion_removed",
            GovernanceChangeKind::CriterionChanged => "criterion_changed",
            GovernanceChangeKind::RequireChanged => "require_changed",
            GovernanceChangeKind::IrreversibleAdded => "irreversible_added",
            GovernanceChangeKind::SystemModelChanged => "system_model_changed",
            GovernanceChangeKind::EnvelopeChanged => "envelope_changed",
            GovernanceChangeKind::RemoteAgentAdded => "remote_agent_added",
            GovernanceChangeKind::RemoteBindingChanged => "remote_binding_changed",
            GovernanceChangeKind::KindChanged => "kind_changed",
        }
    }
}

/// A governance change with its kind: `KindedChange`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KindedChange {
    /// What kind of governance change it is.
    pub kind: GovernanceChangeKind,
    /// Where it is.
    pub path: String,
    /// The change as the diff shows it.
    pub text: String,
}

impl KindedChange {
    /// `{ kind, path, text }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("kind", self.kind.as_str())
            .with("path", self.path.as_str())
            .with("text", self.text.as_str())
            .into()
    }
}

/// The program's own changes from `before` to `after`: what [`classify`]
/// gives.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Classified {
    /// Changes a person must approve, each with its kind.
    pub governance: Vec<KindedChange>,
    /// The others.
    pub behavior: Vec<Change>,
}

impl Classified {
    fn gov(
        &mut self,
        kind: GovernanceChangeKind,
        path: impl Into<String>,
        text: impl Into<String>,
    ) {
        self.governance.push(KindedChange {
            kind,
            path: path.into(),
            text: text.into(),
        });
    }

    fn beh(&mut self, path: impl Into<String>, text: impl Into<String>) {
        self.behavior.push(Change::new(path, text));
    }
}

/// `{ op: "var", name }`: a reference to a named capability.
fn var_expr(name: &str) -> Value {
    let mut m = Map::new();
    m.insert("op", "var");
    m.insert("name", name);
    Value::Object(m)
}

/// The program's own changes from `before` to `after`, each governance change
/// with its kind. Both [`semantic_diff`] and [`governance_changes`] read them
/// from here, so a view and a patch classify a change alike. `modules` opens
/// capabilities over imported components; definitions are compared only where
/// the programs themselves hold them. `classify(before, after, modules)`.
#[must_use]
pub fn classify(before: &Value, after: &Value, modules: Option<&Modules>) -> Classified {
    let mut out = Classified::default();
    let (Some(bp), Some(ap)) = (Program::of(before), Program::of(after)) else {
        return out;
    };
    let linked = modules.is_some_and(|m| !m.is_empty());
    let (lb_value, la_value);
    let (lb, la) = if linked {
        lb_value = linked_program(bp, modules);
        la_value = linked_program(ap, modules);
        (
            Program::of(&lb_value).unwrap_or(bp),
            Program::of(&la_value).unwrap_or(ap),
        )
    } else {
        (bp, ap)
    };
    let (bdefs, adefs) = (defs_of(bp), defs_of(ap));
    let mut names = unique_in_order(bdefs.keys().chain(adefs.keys()).map(str::to_owned));
    sort_utf16(&mut names);
    for name in &names {
        let b = bdefs.get(name);
        let a = adefs.get(name);
        let path = format!("/defs/{name}");
        if let (Some(b), Some(a)) = (b, a)
            && j(b) == j(a)
        {
            continue;
        }
        let Some(a) = a else {
            let Some(b) = b else { continue };
            let kind = kind_text(b);
            let text = format!("- {kind} {name} removed");
            if kind == "contract" {
                out.gov(GovernanceChangeKind::CriterionRemoved, path, text);
            } else if is_system(&kind) {
                out.gov(GovernanceChangeKind::SystemModelChanged, path, text);
            } else {
                out.beh(path, text);
            }
            continue;
        };
        let a_kind = kind_text(a);
        let Some(b) = b else {
            if a_kind == "capability" {
                let text = format!("+ capability {}", shown_caps(la, &var_expr(name)));
                out.gov(GovernanceChangeKind::CapabilityAdded, path, text);
            } else if is_system(&a_kind) {
                out.gov(
                    GovernanceChangeKind::SystemModelChanged,
                    path,
                    format!("+ {a_kind} {name} (system model)"),
                );
            } else if a_kind == "agent" && a.get("remote").is_some_and(Value::is_truthy) {
                out.gov(
                    GovernanceChangeKind::RemoteAgentAdded,
                    path,
                    format!("+ remote agent {name}"),
                );
            } else if a_kind == "effect" && a.get("irreversible").is_some_and(Value::is_truthy) {
                out.gov(
                    GovernanceChangeKind::IrreversibleAdded,
                    path,
                    format!("+ irreversible effect {name}"),
                );
            } else {
                out.beh(path.clone(), format!("+ {a_kind} {name}"));
                // A workflow is where authority starts: every capability a new one holds is authority added (G11).
                if a_kind == "workflow" {
                    let bounds = workflow_bounds(a);
                    for (i, c) in bounds.caps.iter().enumerate() {
                        out.gov(
                            GovernanceChangeKind::CapabilityAdded,
                            format!("{path}/{}/{i}", bounds.caps_at),
                            format!("+ {name}: {}", shown_caps(la, c)),
                        );
                    }
                    if a.get("envelope").is_some_and(Value::is_truthy) {
                        out.gov(
                            GovernanceChangeKind::EnvelopeChanged,
                            format!("{path}/envelope"),
                            format!("+ {name}: envelope"),
                        );
                    }
                }
            }
            continue;
        };
        let b_kind = kind_text(b);
        if a_kind != b_kind {
            out.gov(
                GovernanceChangeKind::KindChanged,
                path,
                format!("~ {name}: {b_kind} → {a_kind}"),
            );
            continue;
        }
        match a_kind.as_str() {
            "capability" => {
                let var = var_expr(name);
                let d = scope_diffs(
                    &caps_in(lb, std::slice::from_ref(&var)),
                    &caps_in(la, std::slice::from_ref(&var)),
                );
                for x in &d.added {
                    out.gov(
                        GovernanceChangeKind::CapabilityAdded,
                        path.clone(),
                        format!("+ {name}: {x}"),
                    );
                }
                for x in &d.other {
                    out.gov(
                        GovernanceChangeKind::CapabilityAdded,
                        path.clone(),
                        format!("~ {name}: {x}"),
                    );
                }
                for x in &d.removed {
                    out.beh(path.clone(), format!("- {name}: {x} (narrowed)"));
                }
                // What the scopes do not show may still widen: the amount `money.spend` allows, or a capability over a
                // module that is not loaded here. A change this diff cannot read is a person's to see.
                if d.added.is_empty() && d.other.is_empty() && d.removed.is_empty() {
                    out.gov(
                        GovernanceChangeKind::CapabilityAdded,
                        path,
                        format!("~ capability {name} changed"),
                    );
                }
            }
            "agent" | "workflow" => {
                let (bd, ad) = (Definition::of(b), Definition::of(a));
                let had: Vec<String> = bd.caps().iter().map(j).collect();
                let has: Vec<String> = ad.caps().iter().map(j).collect();
                for (i, c) in ad.caps().iter().enumerate() {
                    if !had.contains(&j(c)) {
                        out.gov(
                            GovernanceChangeKind::CapabilityAdded,
                            format!("{path}/caps/{i}"),
                            format!("+ {name}: {}", shown_caps(la, c)),
                        );
                    }
                }
                for c in bd.caps() {
                    if !has.contains(&j(c)) {
                        out.beh(
                            format!("{path}/caps"),
                            format!("- {name}: {} (narrowed)", shown_caps(lb, c)),
                        );
                    }
                }
                let bc = budget_changes(name, b.get("budget"), a.get("budget"));
                for t in &bc.up {
                    out.gov(
                        GovernanceChangeKind::BudgetIncreased,
                        format!("{path}/budget"),
                        format!("~ {t}"),
                    );
                }
                for t in &bc.down {
                    out.beh(format!("{path}/budget"), format!("~ {t}"));
                }
                if a_kind == "agent" {
                    agent_changes(&mut out, name, &path, b, a);
                } else {
                    workflow_changes(&mut out, (lb, la), name, &path, b, a);
                }
            }
            "fn" => {
                // A function's budget bounds what a call to it may spend, as an agent's does: raising it is a governance change.
                for t in &budget_changes(name, b.get("budget"), a.get("budget")).up {
                    out.gov(
                        GovernanceChangeKind::BudgetIncreased,
                        format!("{path}/budget"),
                        format!("~ {t}"),
                    );
                }
                out.beh(path, format!("~ fn {name} changed"));
            }
            "contract" => contract_changes(&mut out, name, &path, b, a),
            "effect" => {
                if a.get("irreversible").is_some_and(Value::is_truthy)
                    && !b.get("irreversible").is_some_and(Value::is_truthy)
                {
                    out.gov(
                        GovernanceChangeKind::IrreversibleAdded,
                        path,
                        format!("~ effect {name} became irreversible"),
                    );
                } else if j(b) != j(a) {
                    out.beh(path, format!("~ effect {name} changed"));
                }
            }
            "component" | "interface" | "environment" => {
                // The system model is the institution's, not the program's: every change to it is a governance change (doc 9 §1, §5.3).
                for t in system_changes(name, b, a) {
                    out.gov(
                        GovernanceChangeKind::SystemModelChanged,
                        path.clone(),
                        format!("~ {t}"),
                    );
                }
            }
            _ => out.beh(path, format!("~ {a_kind} {name} changed")),
        }
    }
    out
}

/// The skills, the loop, the role and the remote binding of an agent that
/// changed (the agent case of [`classify`]).
fn agent_changes(out: &mut Classified, name: &str, path: &str, b: &Value, a: &Value) {
    let (bs, asks) = (object_member(b, "skills"), object_member(a, "skills"));
    let mut names = unique_in_order(
        bs.into_iter()
            .chain(asks)
            .flat_map(Map::keys)
            .map(str::to_owned),
    );
    sort_utf16(&mut names);
    for sn in names {
        let before = bs.and_then(|m| m.get(&sn));
        let after = asks.and_then(|m| m.get(&sn));
        match (before, after) {
            (_, None) => out.beh(
                format!("{path}/skills/{sn}"),
                format!("- skill {name}.{sn}"),
            ),
            (None, Some(_)) => out.beh(
                format!("{path}/skills/{sn}"),
                format!("+ skill {name}.{sn}"),
            ),
            (Some(bs), Some(as_)) => {
                let sb =
                    budget_changes(&format!("{name}.{sn}"), bs.get("budget"), as_.get("budget"));
                for t in &sb.up {
                    out.gov(
                        GovernanceChangeKind::BudgetIncreased,
                        format!("{path}/skills/{sn}/budget"),
                        format!("~ {t}"),
                    );
                }
                for t in &sb.down {
                    out.beh(format!("{path}/skills/{sn}/budget"), format!("~ {t}"));
                }
                if skill_shape(bs) != skill_shape(as_) {
                    out.beh(
                        format!("{path}/skills/{sn}"),
                        format!("~ skill {name}.{sn} changed"),
                    );
                }
            }
        }
    }
    let loop_shape = |v: &Value| {
        let item = |k: &str| v.get(k).cloned().unwrap_or(Value::Null);
        j(&Value::Array(vec![
            item("loop"),
            item("progress"),
            item("role"),
            item("model"),
        ]))
    };
    if loop_shape(b) != loop_shape(a) {
        out.beh(
            path,
            format!("~ {name}: role, loop strategy or progress thresholds changed"),
        );
    }
    if j_or_null(b.get("remote")) != j_or_null(a.get("remote")) {
        out.gov(
            GovernanceChangeKind::RemoteBindingChanged,
            format!("{path}/remote"),
            format!("~ {name}: remote binding changed"),
        );
    }
}

/// `j({ p: s.params, r: s.returns, e: s.effects, b: s.body ?? null })`.
fn skill_shape(s: &Value) -> String {
    let mut m = Map::new();
    for (key, member) in [("p", "params"), ("r", "returns"), ("e", "effects")] {
        if let Some(v) = s.get(member) {
            m.insert(key, v.clone());
        }
    }
    m.insert("b", s.get("body").cloned().unwrap_or(Value::Null));
    j(&Value::Object(m))
}

/// The steps, the envelope, the postcondition and the handlers of a workflow
/// that changed (the workflow case of [`classify`]).
fn workflow_changes(
    out: &mut Classified,
    (lb, la): (Program<'_>, Program<'_>),
    name: &str,
    path: &str,
    b: &Value,
    a: &Value,
) {
    let before = steps(lb, b);
    let after = steps(la, a);
    for s in after.iter().filter(|x| !before.contains(x)) {
        out.beh(format!("{path}/body"), format!("+ step: {s}"));
    }
    for s in before.iter().filter(|x| !after.contains(x)) {
        out.beh(format!("{path}/body"), format!("- step: {s}"));
    }
    let body = |v: &Value| Value::Array(Definition::of(v).body().to_vec());
    if !before.iter().any(|x| !after.contains(x))
        && !after.iter().any(|x| !before.contains(x))
        && j(&body(b)) != j(&body(a))
    {
        out.beh(
            format!("{path}/body"),
            format!("~ {name}: the body changed, with the same steps"),
        );
    }
    // The envelope is what a person approved for the run: any change to it is theirs to see (spec/envelope.md).
    if j_or_null(b.get("envelope")) != j_or_null(a.get("envelope")) {
        let how = if !b.get("envelope").is_some_and(Value::is_truthy) {
            "added"
        } else if !a.get("envelope").is_some_and(Value::is_truthy) {
            "removed"
        } else {
            "changed"
        };
        out.gov(
            GovernanceChangeKind::EnvelopeChanged,
            format!("{path}/envelope"),
            format!("~ {name}: envelope {how}"),
        );
    }
    if j_or_null(b.get("ensures")) != j_or_null(a.get("ensures")) {
        out.beh(
            format!("{path}/ensures"),
            format!("~ {name}: ensures changed"),
        );
    }
    if j_or_null(b.get("on")) != j_or_null(a.get("on")) {
        out.beh(
            format!("{path}/on"),
            format!("~ {name}: event handlers changed"),
        );
    }
}

/// `Object.keys(m ?? {}).sort()`.
fn sorted_keys(m: Option<&Map>) -> Vec<&str> {
    let mut ks: Vec<&str> = m.into_iter().flat_map(Map::keys).collect();
    ks.sort_by(|x, y| mandate_ir::compare_utf16(x, y));
    ks
}

/// The criteria and the `require` of a contract that changed (the contract
/// case of [`classify`]).
fn contract_changes(out: &mut Classified, name: &str, path: &str, b: &Value, a: &Value) {
    for group in ["accept", "invariant"] {
        let was = b.get(group).and_then(Value::as_object);
        let now = a.get(group).and_then(Value::as_object);
        for k in sorted_keys(was) {
            let by_was = was.and_then(|m| m.get(k)).and_then(|c| c.get("by"));
            match now.and_then(|m| m.get(k)) {
                None => out.gov(
                    GovernanceChangeKind::CriterionRemoved,
                    format!("{path}/{group}/{k}"),
                    format!("- {name}.{k} ({}) removed", method_of(by_was)),
                ),
                Some(c) => {
                    let by_now = c.get("by");
                    if j_or_null(by_was) != j_or_null(by_now) {
                        out.gov(
                            GovernanceChangeKind::CriterionChanged,
                            format!("{path}/{group}/{k}"),
                            format!(
                                "~ {name}.{k}: {} → {}",
                                method_of(by_was),
                                method_of(by_now)
                            ),
                        );
                    }
                }
            }
        }
        for k in sorted_keys(now) {
            if !was.is_some_and(|m| m.contains_key(k)) {
                let by_now = now.and_then(|m| m.get(k)).and_then(|c| c.get("by"));
                out.beh(
                    format!("{path}/{group}/{k}"),
                    format!("+ {name}.{k} by {}", method_of(by_now)),
                );
            }
        }
    }
    if j_or_null(b.get("require")) != j_or_null(a.get("require")) {
        out.gov(
            GovernanceChangeKind::RequireChanged,
            format!("{path}/require"),
            format!("~ {name}: require changed"),
        );
    }
}

/// The governance changes from `before` to `after`, each with its kind: the
/// semantic diff's, without the locks' (a patch changes the program, not the
/// lock). `mandate.apply_patch` reports these. `governanceChanges(before,
/// after, modules)`.
#[must_use]
pub fn governance_changes(
    before: &Value,
    after: &Value,
    modules: Option<&Modules>,
) -> Vec<KindedChange> {
    classify(before, after, modules).governance
}

/// The two locks a diff compares: `{ before?, after? }`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Locks<'a> {
    /// The lock of the program before.
    pub before: Option<&'a Value>,
    /// The lock of the program after.
    pub after: Option<&'a Value>,
}

/// The semantic diff of two programs, `semanticDiff(before, after, locks)`.
/// With `locks`, the people the two locks bind are compared too
/// ([`lock_diff`]), and listed as governance changes, and what they ask of
/// the host and the sandboxes after them ([`lock_limits_diff`]).
///
/// Oddities of the TypeScript this keeps: the `unchanged` lines "no authority
/// added" and "no budget raised" look at the texts of the governance changes
/// only, so a changed envelope, which is the one line `~ W: envelope changed`,
/// leaves both standing, as do `~ capability N changed` and a change of
/// argument prefixes; the "external effects" of the workflows are listed once
/// for each workflow that has them, sorted but not made distinct; and the
/// contracts are compared in the order the program holds them.
#[must_use]
pub fn semantic_diff(before: &Value, after: &Value, locks: Option<Locks<'_>>) -> DiffView {
    let changes = classify(before, after, None);
    let mut governance: Vec<Change> = changes
        .governance
        .into_iter()
        .map(|c| Change::new(c.path, c.text))
        .collect();
    let mut behavior = changes.behavior;
    // After the program's own changes, so a diff without locks, or with the same people in both, reads as it did.
    if let Some(locks) = locks {
        governance.extend(lock_diff(locks.before, locks.after));
        // Then what the locks ask of the host and the sandboxes (0.5); a lock without it adds nothing.
        let limits = lock_limits_diff(locks.before, locks.after);
        governance.extend(limits.governance);
        behavior.extend(limits.behavior);
    }
    let critical = |p: &Value| -> Vec<String> {
        let Some(program) = Program::of(p) else {
            return Vec::new();
        };
        let mut all: Vec<String> = defs_of(program)
            .iter()
            .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("workflow"))
            .flat_map(|(_, w)| workflow_effects(program, Definition::of(w).body()))
            .collect();
        sort_utf16(&mut all);
        all
    };
    let mut unchanged: Vec<String> = Vec::new();
    let cb = critical(before);
    let ca = critical(after);
    if cb == ca {
        unchanged.push(if cb.is_empty() {
            "no external effects, before or after".to_owned()
        } else {
            format!("external effects unchanged: {}", cb.join(", "))
        });
    }
    let contracts = |p: &Value| -> String {
        let Some(program) = Program::of(p) else {
            return "[]".to_owned();
        };
        let rows: Vec<Value> = defs_of(program)
            .iter()
            .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("contract"))
            .map(|(n, d)| Value::Array(vec![Value::from(n), d.clone()]))
            .collect();
        canonicalize(&Value::Array(rows))
    };
    if contracts(before) == contracts(after) {
        unchanged.push("contracts and their criteria unchanged".to_owned());
    }
    if !governance.iter().any(|g| {
        g.text.starts_with('+')
            || g.text.contains("tier")
            || g.text.contains("data class")
            || g.text.contains(": methods ")
    }) {
        unchanged.push("no authority added".to_owned());
    }
    if !governance.iter().any(|g| g.text.contains(".budget.")) {
        unchanged.push("no budget raised".to_owned());
    }
    DiffView {
        from: program_ref(before),
        to: program_ref(after),
        governance,
        behavior,
        unchanged,
    }
}
