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
    Definition, JsObject, JsValue, Map, Program, Value, budget_amount, budget_asks, canonicalize,
    ptr_token, sort_utf16, unique_in_order, workflow_bounds,
};

use crate::caps::{CapVal, show_cap, within};
use crate::lock_diff::{lock_diff, lock_limits_diff};
use crate::modules::{Modules, linked_program};
use crate::view_shared::{
    Graph, ProgramRef, VIEW_FORMAT, caps_in, defs_of, duration, is_system, j, j_or_null, js_text,
    json_string, kind_text, method_of, micros_as_units, program_ref, workflow_effects,
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
        "tool.call" => "tool",
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
        } else if c.ctor() == "tool.call" {
            // 0.6: a `tool.call` stands for its read-only tools and its write
            // tools, two capabilities, each compared with its own kind.
            format!("tool.call:{}", if c.write() { "write" } else { "read" })
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
        "spend" => format!("{} {currency}", micros_as_units(n)),
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
    // 0.7: `asks`, the most questions a run may put to people, which no
    // budget of an earlier program has: raised or lifted, a person
    // approves, as for every other limit (spec/attention.md "`asks`").
    match (budget_asks(before), budget_asks(after)) {
        (Some(x), None) => out.up.push(format!("{name}.budget.asks: {x} → no limit")),
        (None, Some(y)) => out.down.push(format!("{name}.budget.asks: no limit → {y}")),
        (Some(x), Some(y)) if y > x => out.up.push(format!("{name}.budget.asks: {x} → {y}")),
        (Some(x), Some(y)) if y < x => out.down.push(format!("{name}.budget.asks: {x} → {y}")),
        _ => {}
    }
    out
}

/// `${was.micros / 1_000_000}`.
fn micros_of(spend: &Value) -> String {
    spend
        .get("micros")
        .and_then(Value::as_i64)
        .map_or_else(|| "NaN".to_owned(), micros_as_units)
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
    // 0.6: the patterns a lead's sub-programs may apply. No envelope before
    // 0.6 has `shapes`, so an earlier program's lines are what they were.
    let shapes = |e: &Value| -> Option<Vec<String>> {
        e.get("shapes").and_then(Value::as_array).map(|xs| {
            xs.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
    };
    match (shapes(b), shapes(a)) {
        (None, None) => {}
        (Some(was), None) => out.push(Change::new(
            format!("{at}/shapes"),
            format!("~ {name}.shapes: {} → any workflow", was.join(", ")),
        )),
        (None, Some(now)) => out.push(Change::new(
            format!("{at}/shapes"),
            format!("~ {name}.shapes: any workflow → {}", now.join(", ")),
        )),
        (Some(was), Some(now)) => {
            for s in now.iter().filter(|s| !was.contains(s)) {
                out.push(Change::new(
                    format!("{at}/shapes"),
                    format!("+ {name}.shapes: {s}"),
                ));
            }
            for s in was.iter().filter(|s| !now.contains(s)) {
                out.push(Change::new(
                    format!("{at}/shapes"),
                    format!("- {name}.shapes: {s}"),
                ));
            }
        }
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
    /// 0.6: a criterion may be waived by a role it could not be waived by
    /// before (`waive by` added, or a role added to it).
    WaiverAdded,
    /// 0.6: a role may no longer waive a criterion (`waive by` taken away,
    /// or a role taken from it).
    WaiverRemoved,
    /// 0.6: what a workflow's expansion may do changed: the application it
    /// is (its pattern, type arguments or slot arguments) came, went or
    /// changed, or a pattern a workflow applies changed. Every such change
    /// is a person's to see, whatever it does: a slot argument swapped for
    /// an effect of a higher class, a contract for a weaker one, another
    /// reviewer, a higher `max_items` (spec/library.md "Patterns").
    ApplicationChanged,
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
            GovernanceChangeKind::WaiverAdded => "waiver_added",
            GovernanceChangeKind::WaiverRemoved => "waiver_removed",
            GovernanceChangeKind::ApplicationChanged => "application_changed",
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
        let path = format!("/defs/{name}");
        // 0.6: a definition's `doc` is a person's text about it. A changed
        // doc is a new program (it is hashed), and a behavior change here,
        // never a governance one; the rest of the definition is compared
        // without it. Before 0.6 no definition has a `doc`.
        let (b_value, a_value);
        let (b, a) = match (bdefs.get(name), adefs.get(name)) {
            (Some(b), Some(a)) if b.get("doc").is_some() || a.get("doc").is_some() => {
                if b.get("doc") != a.get("doc") {
                    out.beh(
                        format!("{path}/doc"),
                        format!("~ {} {name}: doc changed", kind_text(a)),
                    );
                }
                b_value = without_doc(b);
                a_value = without_doc(a);
                (Some(&b_value), Some(&a_value))
            }
            other => other,
        };
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
            } else if kind == "pattern" && !applied_by(bp, name).is_empty() {
                // 0.6: a pattern a workflow applied is gone from under it.
                out.gov(GovernanceChangeKind::ApplicationChanged, path, text);
            } else if is_system(&kind) {
                out.gov(GovernanceChangeKind::SystemModelChanged, path, text);
            } else {
                out.beh(path, text);
            }
            continue;
        };
        let a_kind = kind_text(a);
        let Some(b) = b else {
            verify_waivers(&mut out, (lb, la), name, &path, None, a);
            if a_kind == "capability" {
                let text = format!("+ capability {}", shown_caps(la, &var_expr(name)));
                out.gov(GovernanceChangeKind::CapabilityAdded, path, text);
            } else if is_system(&a_kind) {
                out.gov(
                    GovernanceChangeKind::SystemModelChanged,
                    path,
                    format!("+ {a_kind} {name} (system model)"),
                );
            } else if a_kind == "connector" {
                // 0.6: a connector a program did not have widens its
                // authority signature (spec/library.md "The authority
                // signature").
                out.gov(
                    GovernanceChangeKind::CapabilityAdded,
                    path,
                    format!("+ connector {name}"),
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
                if a_kind == "contract" {
                    new_contract_waivers(&mut out, name, &path, a);
                }
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
                    // 0.6: what the new workflow's expansion does.
                    if let Some(p) = applied(a) {
                        out.gov(
                            GovernanceChangeKind::ApplicationChanged,
                            format!("{path}/apply"),
                            format!("+ {name}: applies {p}"),
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
        verify_waivers(&mut out, (lb, la), name, &path, Some(b), a);
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
                    application_changes(&mut out, name, &path, b, a);
                    workflow_changes(&mut out, (lb, la), name, &path, b, a);
                }
            }
            // 0.6: a pattern's body is what its applications do.
            "pattern" => {
                let mut by = applied_by(bp, name);
                by.extend(applied_by(ap, name));
                let by = unique_in_order(by);
                if by.is_empty() {
                    out.beh(path, format!("~ pattern {name} changed"));
                } else {
                    out.gov(
                        GovernanceChangeKind::ApplicationChanged,
                        path,
                        format!("~ pattern {name} changed, which {} applies", by.join(", ")),
                    );
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
            "connector" => connector_changes(&mut out, name, &path, b, a),
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
    // 0.6: an application written the same in both whose pattern or
    // arguments mean something else now.
    for name in &names {
        if let (Some(b), Some(a)) = (bdefs.get(name), adefs.get(name)) {
            resolution_changes(&mut out, (bp, ap), name, b, a);
        }
    }
    out
}

/// What the pattern `p` names in `program`: `"local"` for one it defines,
/// `"module m"` for one a `use` list brings from `m`, else `"unknown"`.
fn resolved(program: Program<'_>, p: &str) -> String {
    if program
        .defs()
        .and_then(|d| d.get(p))
        .is_some_and(|d| kind_text(d) == "pattern")
    {
        return "local".to_owned();
    }
    program
        .imports()
        .find(|u| u.module().is_some_and(|m| m != "std") && u.names().any(|n| n == p))
        .and_then(|u| u.module())
        .map_or_else(|| "unknown".to_owned(), |m| format!("module {m}"))
}

/// The names the arguments of an application refer to, each once, in the
/// order found: a variable's name and a dotted path's root.
fn argument_names(apply: &Value) -> Vec<String> {
    fn walk(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Array(items) => items.iter().for_each(|x| walk(x, out)),
            Value::Object(m) => {
                if m.get("op").and_then(Value::as_str) == Some("var")
                    && let Some(n) = m.get("name").and_then(Value::as_str)
                    && !out.iter().any(|x| x == n)
                {
                    out.push(n.to_owned());
                }
                for (_, x) in m.iter() {
                    walk(x, out);
                }
            }
            _ => {}
        }
    }
    let mut out = Vec::new();
    if let Some(args) = apply.get("args") {
        walk(args, &mut out);
    }
    out
}

/// 0.6: a workflow whose application is written the same before and after,
/// but whose pattern name now means another pattern (one the program
/// defines rather than one a module gives, or one of another module), or one
/// of whose arguments names a constant whose value changed (a map's `max`
/// read from it, say): what the expansion may do changed with nothing in
/// the workflow changing, a governance change as the application's own
/// change is ([`application_changes`]).
fn resolution_changes(
    out: &mut Classified,
    (bp, ap): (Program<'_>, Program<'_>),
    name: &str,
    b: &Value,
    a: &Value,
) {
    let (Some(was), Some(now)) = (b.get("apply"), a.get("apply")) else {
        return;
    };
    if j(was) != j(now) {
        return;
    }
    let path = format!("/defs/{name}/apply");
    let p = js_text(now.get("pattern"));
    let (rb, ra) = (resolved(bp, &p), resolved(ap, &p));
    if rb != ra {
        let said = |r: &str| match r.strip_prefix("module ") {
            Some(m) => format!("the pattern of module {m}"),
            None if r == "local" => "the program's own pattern".to_owned(),
            None => "no pattern the program defines or imports".to_owned(),
        };
        out.gov(
            GovernanceChangeKind::ApplicationChanged,
            path.clone(),
            format!("~ {name}: {p} is now {}, not {}", said(&ra), said(&rb)),
        );
    }
    let (bdefs, adefs) = (defs_of(bp), defs_of(ap));
    for n in argument_names(now) {
        let (bc, ac) = (bdefs.get(&n), adefs.get(&n));
        let constant = |d: Option<&Value>| d.is_some_and(|d| kind_text(d) == "const");
        if (constant(bc) || constant(ac)) && j_or_null(bc) != j_or_null(ac) {
            out.gov(
                GovernanceChangeKind::ApplicationChanged,
                path.clone(),
                format!("~ {name}: the constant {n} its application of {p} names changed"),
            );
        }
    }
}

/// What changed in a connector (0.6), as its authority signature reads it
/// (spec/library.md "The authority signature"): another server, another
/// class (a higher one lets more be sent to it, a lower one declassifies
/// everything its tools return), a tool it did not have, a read-only tool
/// that writes, and a write tool's class, retry class, `reconcile by` or
/// `compensation` changed, and any tool's parameters or result, are
/// governance changes (authority widened); a tool taken away, a write tool
/// that became read-only and another `version` are behavior changes.
fn connector_changes(out: &mut Classified, name: &str, path: &str, b: &Value, a: &Value) {
    let gov = |out: &mut Classified, at: String, text: String| {
        out.gov(GovernanceChangeKind::CapabilityAdded, at, text);
    };
    if j_or_null(b.get("mcp")) != j_or_null(a.get("mcp")) {
        gov(
            out,
            format!("{path}/mcp"),
            format!(
                "~ connector {name}: server {} → {}",
                j_or_null(b.get("mcp")),
                j_or_null(a.get("mcp"))
            ),
        );
    }
    let (bc, ac) = (b.get("class"), a.get("class"));
    if j_or_null(bc) != j_or_null(ac) {
        let text = format!(
            "~ connector {name}.class: {} → {}",
            js_text(bc),
            js_text(ac)
        );
        gov(out, format!("{path}/class"), text);
    }
    if j_or_null(b.get("version")) != j_or_null(a.get("version")) {
        out.beh(
            format!("{path}/version"),
            format!(
                "~ connector {name}.version: {} → {}",
                js_text(b.get("version")),
                js_text(a.get("version"))
            ),
        );
    }
    let (bt, at) = (object_member(b, "tools"), object_member(a, "tools"));
    let mut tools = unique_in_order(
        bt.into_iter()
            .chain(at)
            .flat_map(Map::keys)
            .map(str::to_owned),
    );
    sort_utf16(&mut tools);
    let class_of = |t: &Value| {
        if t.get("read_only") == Some(&Value::Bool(true))
            && [
                "critical",
                "idempotency_key",
                "retry_class",
                "reconcile_by",
                "compensation",
            ]
            .iter()
            .all(|k| t.get(k).is_none())
        {
            "read_only"
        } else {
            "write"
        }
    };
    for t in tools {
        let tp = format!("{path}/tools/{t}");
        let (before, after) = (bt.and_then(|m| m.get(&t)), at.and_then(|m| m.get(&t)));
        let (before, after) = match (before, after) {
            (None, Some(x)) => {
                gov(
                    out,
                    tp,
                    format!("+ connector {name}: tool {t} ({})", class_of(x)),
                );
                continue;
            }
            (Some(_), None) => {
                out.beh(tp, format!("- connector {name}: tool {t} removed"));
                continue;
            }
            (Some(x), Some(y)) => (x, y),
            (None, None) => continue,
        };
        let (cb, ca) = (class_of(before), class_of(after));
        if cb != ca {
            let text = format!("~ connector {name}.{t}: {cb} → {ca}");
            if ca == "write" {
                gov(out, tp.clone(), text);
            } else {
                out.beh(tp.clone(), text);
            }
        } else if ca == "write" {
            for k in [
                "critical",
                "idempotency_key",
                "retry_class",
                "reconcile_by",
                "compensation",
            ] {
                if j_or_null(before.get(k)) != j_or_null(after.get(k)) {
                    gov(
                        out,
                        format!("{tp}/{k}"),
                        format!(
                            "~ connector {name}.{t}: {k} {} → {}",
                            js_text(before.get(k)),
                            js_text(after.get(k))
                        ),
                    );
                }
            }
        }
        for k in ["params", "returns"] {
            if j_or_null(before.get(k)) != j_or_null(after.get(k)) {
                gov(
                    out,
                    format!("{tp}/{k}"),
                    format!("~ connector {name}.{t}: {k} changed"),
                );
            }
        }
    }
}

/// A definition without its `doc` (language 0.6).
fn without_doc(d: &Value) -> Value {
    let mut d = d.clone();
    if let Value::Object(m) = &mut d {
        m.remove("doc");
    }
    d
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

/// 0.6: each workflow of `after` that applies a pattern from the same module
/// as in `before`, where the two locks pin that module to another hash: the
/// application is written the same, its pattern is another.
fn pattern_pin_changes(before: &Value, after: &Value, locks: Locks<'_>) -> Vec<Change> {
    let (Some(lb), Some(la)) = (locks.before, locks.after) else {
        return Vec::new();
    };
    let (Some(bp), Some(ap)) = (Program::of(before), Program::of(after)) else {
        return Vec::new();
    };
    let pin = |lock: &Value, m: &str| lock.get("modules").and_then(|ms| ms.get(m)).cloned();
    let mut out = Vec::new();
    for (name, d) in defs_of(ap).iter() {
        let Some(p) = applied(d) else { continue };
        let was = defs_of(bp).get(name).and_then(applied);
        let (rb, ra) = (resolved(bp, &p), resolved(ap, &p));
        let Some(m) = ra.strip_prefix("module ") else {
            continue;
        };
        if was.as_deref() != Some(p.as_str()) || rb != ra {
            continue;
        }
        if pin(lb, m) != pin(la, m) {
            out.push(Change::new(
                format!("/defs/{name}/apply"),
                format!("~ {name}: {p} comes from module {m}, which the lock pins to another hash"),
            ));
        }
    }
    out
}

/// The pattern a workflow applies, when it is an application (0.6).
fn applied(w: &Value) -> Option<String> {
    let a = w.get("apply")?;
    Some(js_text(a.get("pattern")))
}

/// The workflows of `p` that apply the pattern `name`, sorted.
fn applied_by(p: Program<'_>, name: &str) -> Vec<String> {
    let mut out: Vec<String> = p
        .definitions()
        .filter(|(_, d)| {
            d.kind() == Some(mandate_ir::DefKind::Workflow)
                && d.value()
                    .get("apply")
                    .and_then(|a| a.get("pattern"))
                    .and_then(Value::as_str)
                    == Some(name)
        })
        .map(|(n, _)| n.to_owned())
        .collect();
    sort_utf16(&mut out);
    out
}

/// 0.6: a workflow's application that came, went or changed (its pattern,
/// type arguments or slot arguments): a governance change, whatever it
/// changes, since what the expansion may do is what the slots are given
/// (the workflow case of [`classify`]). A later slice classifies it finer.
fn application_changes(out: &mut Classified, name: &str, path: &str, b: &Value, a: &Value) {
    let (was, now) = (b.get("apply"), a.get("apply"));
    if j_or_null(was) == j_or_null(now) {
        return;
    }
    let text = match (applied(b), applied(a)) {
        (None, Some(p)) => format!("~ {name}: now applies {p}"),
        (Some(p), None) => format!("~ {name}: no longer applies {p}"),
        (Some(p), Some(q)) if p != q => format!("~ {name}: applies {q}, not {p}"),
        (_, Some(p)) => format!("~ {name}: the application of {p} changed"),
        (None, None) => return,
    };
    out.gov(
        GovernanceChangeKind::ApplicationChanged,
        format!("{path}/apply"),
        text,
    );
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
                    let crit_was = was.and_then(|m| m.get(k));
                    waiver_changes(
                        out,
                        &format!("{name}.{k}"),
                        &format!("{path}/{group}/{k}"),
                        crit_was,
                        c,
                    );
                }
            }
        }
        for k in sorted_keys(now) {
            if !was.is_some_and(|m| m.contains_key(k)) {
                let c = now.and_then(|m| m.get(k));
                out.beh(
                    format!("{path}/{group}/{k}"),
                    format!("+ {name}.{k} by {}", method_of(c.and_then(|c| c.get("by")))),
                );
                // 0.6: a new criterion that carries a waiver lets a person
                // accept what fails it.
                if let Some(c) = c {
                    waiver_changes(
                        out,
                        &format!("{name}.{k}"),
                        &format!("{path}/{group}/{k}"),
                        None,
                        c,
                    );
                }
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

/// 0.6: the waivers of a contract the program did not have, each a
/// governance change, `waiver_added`: a person may accept what fails the
/// criterion. A contract without one gives nothing.
fn new_contract_waivers(out: &mut Classified, name: &str, path: &str, a: &Value) {
    for group in ["accept", "invariant"] {
        let now = a.get(group).and_then(Value::as_object);
        for k in sorted_keys(now) {
            if let Some(c) = now.and_then(|m| m.get(k)) {
                waiver_changes(
                    out,
                    &format!("{name}.{k}"),
                    &format!("{path}/{group}/{k}"),
                    None,
                    c,
                );
            }
        }
    }
}

/// 0.6: the criteria of the contract `contract` in `defs` that a person may
/// waive, each with a role that may waive it.
fn waivable_criteria<'a>(defs: &'a Map, contract: &str) -> Vec<(&'a str, &'a str)> {
    let Some(c) = defs.get(contract).filter(|c| kind_text(c) == "contract") else {
        return Vec::new();
    };
    ["accept", "invariant"]
        .into_iter()
        .filter_map(|g| c.get(g).and_then(Value::as_object))
        .flat_map(Map::iter)
        .flat_map(|(k, crit)| waive_roles(Some(crit)).into_iter().map(move |r| (k, r)))
        .collect()
}

/// Every `verify` in `v`, each as the JSON Pointer under `at` where it
/// stands and the name of its contract.
fn verifies_in<'a>(v: &'a Value, at: &str, out: &mut Vec<(String, &'a str)>) {
    match v {
        Value::Object(m) => {
            if m.get("op").and_then(Value::as_str) == Some("verify")
                && let Some(c) = m.get("contract").and_then(Value::as_str)
            {
                out.push((at.to_owned(), c));
            }
            for (k, x) in m.iter() {
                verifies_in(x, &format!("{at}/{}", ptr_token(k)), out);
            }
        }
        Value::Array(xs) => {
            for (i, x) in xs.iter().enumerate() {
                verifies_in(x, &format!("{at}/{i}"), out);
            }
        }
        _ => {}
    }
}

/// 0.6: each `verify` of the definition `name` (at `path`, `b` before and
/// `a` after) that checks against another contract than before, under which
/// a person may accept what they could not: a criterion a role may waive
/// that the contract checked against before did not have under that name
/// with that role. Each such criterion is a governance change,
/// `waiver_added`, at the `verify`. Before is the `verify` that stood where
/// this one stands; when none did (a `verify` new, or moved by a step put
/// before it), every `verify` of the definition before, and of none when the
/// definition is new. A `verify` against a contract of the same name as
/// before is that contract's change, if any, and none of its own.
fn verify_waivers(
    out: &mut Classified,
    (lb, la): (Program<'_>, Program<'_>),
    name: &str,
    path: &str,
    b: Option<&Value>,
    a: &Value,
) {
    let (bdefs, adefs) = (defs_of(lb), defs_of(la));
    let mut was = Vec::new();
    if let Some(b) = b {
        verifies_in(b, path, &mut was);
    }
    let mut now = Vec::new();
    verifies_in(a, path, &mut now);
    for (at, contract) in &now {
        let here = was.iter().find(|(p, _)| p == at).map(|(_, c)| *c);
        let before: Vec<(&str, &str)> = match here {
            Some(c) if c == *contract => continue,
            Some(c) => waivable_criteria(bdefs, c),
            None if was.iter().any(|(_, c)| c == contract) => continue,
            None => was
                .iter()
                .flat_map(|(_, c)| waivable_criteria(bdefs, c))
                .collect(),
        };
        let added: Vec<(&str, &str)> = waivable_criteria(adefs, contract)
            .into_iter()
            .filter(|x| !before.contains(x))
            .collect();
        let mut criteria: Vec<&str> = Vec::new();
        for &(k, _) in &added {
            if !criteria.contains(&k) {
                criteria.push(k);
            }
        }
        for k in criteria {
            let roles: Vec<&str> = added
                .iter()
                .filter(|(c, _)| *c == k)
                .map(|(_, r)| *r)
                .collect();
            out.gov(
                GovernanceChangeKind::WaiverAdded,
                at.clone(),
                format!(
                    "+ {name}: verifies against {contract}, whose {k} may be waived by {}",
                    roles.join(", ")
                ),
            );
        }
    }
}

/// The roles a criterion's `waive` names (0.6), in its order.
fn waive_roles(c: Option<&Value>) -> Vec<&str> {
    c.and_then(|c| c.get("waive"))
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .collect()
}

/// 0.6: who may waive the criterion `who` (at `path`) from `b` to `a`: a
/// role that may waive it now and could not before is a governance change,
/// `waiver_added` (a person may then accept what fails it); one that could
/// and may not, `waiver_removed`. Before 0.6 no criterion has a waiver, so
/// nothing is found.
fn waiver_changes(out: &mut Classified, who: &str, path: &str, b: Option<&Value>, a: &Value) {
    let (was, now) = (waive_roles(b), waive_roles(Some(a)));
    let added: Vec<&str> = now.iter().copied().filter(|r| !was.contains(r)).collect();
    let removed: Vec<&str> = was.iter().copied().filter(|r| !now.contains(r)).collect();
    if !added.is_empty() {
        out.gov(
            GovernanceChangeKind::WaiverAdded,
            format!("{path}/waive"),
            format!("+ {who}: may be waived by {}", added.join(", ")),
        );
    }
    if !removed.is_empty() {
        out.gov(
            GovernanceChangeKind::WaiverRemoved,
            format!("{path}/waive"),
            format!("- {who}: no longer waived by {}", removed.join(", ")),
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
    semantic_diff_with(before, after, locks, None)
}

/// [`semantic_diff`] with the modules the programs import (0.6, which only
/// the Rust reads): what a workflow that applies a pattern of one of them
/// commits is what its expansion commits. The changes are classified as
/// [`semantic_diff`] classifies them; with `locks`, a pattern whose module
/// the locks pin to another hash is a governance change too. A program that
/// applies no pattern is compared as [`semantic_diff`] compares it.
#[must_use]
pub fn semantic_diff_with(
    before: &Value,
    after: &Value,
    locks: Option<Locks<'_>>,
    modules: Option<&Modules>,
) -> DiffView {
    // 0.6 (B13): one classification of a change for the semantic diff, a
    // patch (`governance_changes`), and an upgrade or a publication of a
    // library (`crate::library::ops`): `classify` with the modules. Before
    // 0.6 the diff classifies without them, as the TypeScript does.
    let both_0_6 = [before, after].iter().all(|p| {
        Program::of(p)
            .and_then(Program::language)
            .is_some_and(|l| l.at_least(mandate_ir::Language::V0_6))
    });
    let changes = classify(before, after, modules.filter(|_| both_0_6));
    let mut governance: Vec<Change> = changes
        .governance
        .into_iter()
        .map(|c| Change::new(c.path, c.text))
        .collect();
    let mut behavior = changes.behavior;
    let mut repinned = false;
    // After the program's own changes, so a diff without locks, or with the same people in both, reads as it did.
    if let Some(locks) = locks {
        governance.extend(lock_diff(locks.before, locks.after));
        // Then what the locks ask of the host and the sandboxes (0.5); a lock without it adds nothing.
        let limits = lock_limits_diff(locks.before, locks.after);
        governance.extend(limits.governance);
        behavior.extend(limits.behavior);
        // 0.6: the module an applied pattern comes from, pinned to another
        // hash: another pattern under the same application.
        let pins = pattern_pin_changes(before, after, locks);
        repinned = !pins.is_empty();
        governance.extend(pins);
    }
    // 0.6: what each workflow applies, as this diff can tell it.
    let applications = |p: &Value| -> Vec<String> {
        Program::of(p)
            .into_iter()
            .flat_map(|q| {
                q.definitions()
                    .filter_map(move |(n, d)| applied(d.value()).map(|a| (n, a, q)))
            })
            .map(|(n, a, q)| format!("{n} {a} {}", resolved(q, &a)))
            .collect()
    };
    let critical = |p: &Value| -> Vec<String> {
        // 0.6: a workflow that applies a pattern commits what its expansion
        // does; one this diff cannot expand (its pattern is in a module it
        // is not given) is said to, so that no line says it commits nothing.
        let expanded = crate::expand::for_views(p, modules);
        let Some(program) = Program::of(expanded.as_ref().unwrap_or(p)) else {
            return Vec::new();
        };
        let mut all: Vec<String> = defs_of(program)
            .iter()
            .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("workflow"))
            .flat_map(|(_, w)| workflow_effects(program, Definition::of(w).body()))
            .collect();
        for (n, w) in defs_of(program).iter() {
            if let Some(u) = w.get("unexpanded") {
                all.push(format!(
                    "what {n}'s expansion of {} commits",
                    js_text(u.get("pattern"))
                ));
            }
        }
        sort_utf16(&mut all);
        all
    };
    let mut unchanged: Vec<String> = Vec::new();
    let cb = critical(before);
    let ca = critical(after);
    // What an application's pattern is may change with nothing in the
    // workflow changing (another module, or a pattern the program defines
    // now, or its module pinned to another hash): what it commits is then
    // not known to be the same, whatever the two sides show.
    let same_patterns = applications(before) == applications(after) && !repinned;
    if cb == ca && same_patterns {
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
