//! The Envelope Card: what a person reads before approving a workflow that
//! plans at run time (`compiler/src/views/views.ts`: `CardView` and its
//! parts, lines 1245-1314; `envelopeWorkflows`, 1317-1322; `exprText`,
//! 1324-1340; `grouped` and `hoursText`, 1343-1358; `reachable`, 1360-1377;
//! `WAIT_KIND`, 1379-1387; `card`, 1389-1507; `cardBlocks`, 1598-1650 and
//! `cardDoc`, 1652-1666; `spec/views.md`, `spec/envelope.md` "Views").
//!
//! The card of a workflow is computed from the program, the lock and the
//! modules the program imports; its package hash is the one an approval is
//! signed for. Like the other views, a [`CardView`] is a typed value whose
//! `to_js` builds the object `mandate view --card --format json` writes.
//!
//! JavaScript imitated here, besides what the other views do: the walks of
//! the body are over the IR as plain data, every object in the order of its
//! members (`Object.values`); `[...x].sort()` is by UTF-16 code units; the
//! counts are doubles, written as `String(n)` writes them; `x ?? y` takes
//! `y` for a member that is missing and for `null`. A lock that is not
//! valid is read as little as the TypeScript reads it: where the TypeScript
//! would throw (a role's members that are no array, a member without
//! `keys`), this reads nothing, and says so where it does.

use mandate_check::attention::{Count, sites};
use mandate_check::{
    Authority, CheckOptions, Lock, Modules, ProgramRef, VIEW_FORMAT, authority_of, caps_in,
    defs_of, is_kind, j, js_text, json_string, link, linked_program, micros_text, own,
    packaged_lock, program_ref, reads_var, role_sites, show_cap, static_cost, steps,
};
use mandate_ir::{
    Definition, Expr, ExprOp, JsObject, JsValue, Language, Map, Program, Value, compare_utf16,
    number_to_string, package_hash, sort_utf16, unique_in_order, utf16_len, workflow_bounds,
};

use mandate_ir::{ReportField, Stmt, StmtOp};
use mandate_syntax::SourceKind;

use crate::attention::{AttentionView, ViewStage, asks_blocks, attention_view, reports_blocks};
use crate::card_library::{CardLibrary, Gather, gather};
use crate::cost::{BudgetFrom, DelegateBudget, delegate_budget, delegate_of_plan};
use crate::doc::{Block, Cell, Doc};
use crate::shown::{js, list, num, show, texts};

// ── the card ─────────────────────────────────────────────────────────────

/// What a map hands each item: one capability of its `with caps`:
/// `CardMap["handed"][number]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardHanded {
    /// What it is written as.
    pub cap: String,
    /// Its kinds.
    pub kinds: Vec<String>,
    /// A static scope; `None` when the scope is not known before the run.
    pub scope: Option<Vec<String>>,
    /// Whether the item narrows it.
    pub by_item: bool,
}

impl CardHanded {
    /// `{ cap, kinds, scope, by_item }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("cap", self.cap.as_str())
            .with("kinds", texts(&self.kinds))
            .with("scope", self.scope.as_deref().map_or(JsValue::Null, texts))
            .with("by_item", self.by_item)
            .into()
    }
}

/// What a map runs: its bounds, the delegations of its body, and what it
/// hands each item: `CardMap`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardMap {
    /// The name each item is bound to.
    pub bind: String,
    /// What it runs over, as a person reads it.
    pub over: String,
    /// The most items; `None` when the map has no `max` and the envelope's
    /// `agents` bounds it at run time.
    pub max: Option<f64>,
    /// How many run at a time.
    pub par: f64,
    /// The delegations of its body, `agent.skill` each, once.
    pub delegates: Vec<String>,
    /// What it hands each item.
    pub handed: Vec<CardHanded>,
}

impl CardMap {
    /// `{ bind, over, max, par, delegates, handed }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("bind", self.bind.as_str())
            .with("over", self.over.as_str())
            .with("max", self.max.map_or(JsValue::Null, JsValue::from))
            .with("par", self.par)
            .with("delegates", texts(&self.delegates))
            .with(
                "handed",
                JsValue::Array(self.handed.iter().map(CardHanded::to_js).collect()),
            )
            .into()
    }
}

/// The numbers of a plan's lead's budget: `CardPlan["numbers"]`. Each is the
/// IR's own value, or `null`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardPlanNumbers {
    /// `{ micros, currency }` as the budget has it, or `null`.
    pub spend: JsValue,
    /// Tokens, or `null`.
    pub tokens: JsValue,
    /// Milliseconds, or `null`.
    pub time_ms: JsValue,
    /// Steps, or `null`.
    pub steps: JsValue,
    /// Agents, or `null`.
    pub agents: JsValue,
}

/// A `plan`: its lead and the budget the lead's own delegation reserves:
/// `CardPlan`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardPlan {
    /// `agent.skill`.
    pub lead: String,
    /// The budget as one line.
    pub budget: String,
    /// Where the budget comes from.
    pub from: BudgetFrom,
    /// The budget's numbers.
    pub numbers: CardPlanNumbers,
}

impl CardPlan {
    /// `{ lead, budget, from, numbers: { spend, tokens, time_ms, steps,
    /// agents } }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("lead", self.lead.as_str())
            .with("budget", self.budget.as_str())
            .with("from", self.from.as_str())
            .with(
                "numbers",
                JsObject::new()
                    .with("spend", self.numbers.spend.clone())
                    .with("tokens", self.numbers.tokens.clone())
                    .with("time_ms", self.numbers.time_ms.clone())
                    .with("steps", self.numbers.steps.clone())
                    .with("agents", self.numbers.agents.clone()),
            )
            .into()
    }
}

/// What the envelope can touch: the authority of its capabilities, opened,
/// with the capabilities themselves and the limits of its `spawn`:
/// `CardView["touches"]`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardTouches {
    /// What the capabilities amount to.
    pub authority: Authority,
    /// The capabilities, as the views show them.
    pub caps: Vec<String>,
    /// The highest data class a delegation receives; `internal` when the
    /// envelope's `spawn` names none.
    pub max_class: String,
    /// The most delegations in flight at once; `None` for no limit.
    pub max_concurrent: Option<f64>,
}

/// The text of the budget's `text` member: `CardBudgetRow["text"]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardBudgetText {
    /// The envelope's limit, or `no limit`.
    pub envelope: String,
    /// The static part.
    pub r#static: String,
    /// What is left, or `no limit`.
    pub left: String,
}

/// One dimension of the envelope's budget, beside the static part's upper
/// bound: `CardBudgetRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardBudgetRow {
    /// `spend`, `tokens`, `time`, `steps` or `agents`.
    pub dimension: &'static str,
    /// For spend, the currency; amounts are then in micro-units.
    pub currency: Option<String>,
    /// `micros`, `tokens`, `ms`, `steps` or `agents`.
    pub unit: &'static str,
    /// `None` when the envelope does not bound this dimension.
    pub envelope: Option<f64>,
    /// The static part's upper bound.
    pub r#static: f64,
    /// What sub-programs may claim: the envelope less the static part;
    /// `None` without a limit.
    pub left: Option<f64>,
    /// The three as text.
    pub text: CardBudgetText,
}

impl CardBudgetRow {
    /// `{ dimension, currency, unit, envelope, static, left, text: {
    /// envelope, static, left } }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let number = |x: Option<f64>| x.map_or(JsValue::Null, JsValue::from);
        JsObject::new()
            .with("dimension", self.dimension)
            .with(
                "currency",
                self.currency
                    .as_deref()
                    .map_or(JsValue::Null, JsValue::from),
            )
            .with("unit", self.unit)
            .with("envelope", number(self.envelope))
            .with("static", self.r#static)
            .with("left", number(self.left))
            .with(
                "text",
                JsObject::new()
                    .with("envelope", self.text.envelope.as_str())
                    .with("static", self.text.r#static.as_str())
                    .with("left", self.text.left.as_str()),
            )
            .into()
    }
}

/// A place the workflow waits for a person by role: `CardWait`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardWait {
    /// The role.
    pub role: String,
    /// How it waits: `human.approve`, `human.ask`, `escalate human(…)`,
    /// `supervise escalate(…)`, a change set's approval.
    pub kind: String,
    /// The definition it is in: the workflow, a function it calls, a
    /// contract it verifies against.
    pub def: String,
    /// The same, said as a person reads it (`its body`, `function f`,
    /// `contract C`).
    pub r#in: String,
    /// JSON Pointer of the name of the role.
    pub path: String,
    /// The members the lock binds to the role.
    pub members: Vec<String>,
}

impl CardWait {
    /// `{ role, kind, def, in, path, members }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("role", self.role.as_str())
            .with("kind", self.kind.as_str())
            .with("def", self.def.as_str())
            .with("in", self.r#in.as_str())
            .with("path", self.path.as_str())
            .with("members", texts(&self.members))
            .into()
    }
}

/// An effect only a decision of a role authorizes: an entry of the
/// envelope's `approve`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardApproval {
    /// The effect.
    pub effect: String,
    /// The role.
    pub role: String,
    /// The members the lock binds to the role.
    pub members: Vec<String>,
}

impl CardApproval {
    /// `{ effect, role, members }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("effect", self.effect.as_str())
            .with("role", self.role.as_str())
            .with("members", texts(&self.members))
            .into()
    }
}

/// A member the lock binds to the owner role, with the keys it holds:
/// `CardMember`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardMember {
    /// The member.
    pub member: String,
    /// How many keys the lock holds for it.
    pub keys: usize,
}

/// Who approves the envelope, and who may amend it: `CardView["approves"]`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardApproves {
    /// The owner role; `None` when the envelope names none.
    pub role: Option<String>,
    /// The role's description: `null` when the owner is no role of the
    /// program, `undefined` when the role has none.
    pub description: JsValue,
    /// Whether a lock was given.
    pub lock: bool,
    /// The members the lock binds to the owner role.
    pub members: Vec<CardMember>,
    /// Whether any member is bound.
    pub bound: bool,
    /// The sentence that says who can approve it.
    pub text: String,
}

/// What the sub-programs that apply a pattern of the envelope's `shapes` may
/// report (0.7): one report of the pattern's body, read as it is written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardShapeReport {
    /// The role slot (or role) the pattern reports to: the role the
    /// application binds to the slot gets it.
    pub role: String,
    /// The report's title.
    pub title: String,
    /// The names of its fields, in order.
    pub fields: Vec<String>,
    /// How many times one run of the pattern can make it.
    pub multiplicity: Count,
}

/// A shape: a pattern a lead's sub-program may apply, with the stages and
/// the reports its application shows (0.7).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardShape {
    /// The pattern's name.
    pub pattern: String,
    /// The module that defines it, when the program does not.
    pub module: Option<String>,
    /// Whether the card was given the pattern's definition. When it was not,
    /// nothing is said of its stages and reports.
    pub known: bool,
    /// Its stages, in order.
    pub stages: Vec<ViewStage>,
    /// Its reports, in the order of its body.
    pub reports: Vec<CardShapeReport>,
}

/// The ladder of the lock (0.7): `promotion: "required"`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardLadder {
    /// Whether the lock says `promotion: "required"`.
    pub required: bool,
    /// The role that signs the promotions: the workflow's owner.
    pub role: Option<String>,
    /// The sentence the card shows; `None` when the ladder is not required.
    pub text: Option<String>,
}

/// What a program of 0.7 adds to its card (spec/attention.md "The card of a
/// 0.7 program"): the attention view, the ladder and the shapes.
#[derive(Clone, Debug, PartialEq)]
pub struct CardAttention {
    /// The attention view of the workflow. A card of 0.7 is not made without
    /// it: a program that does not check with what the card is given has no
    /// card ([`CardRefused`]).
    pub view: AttentionView,
    /// The ladder.
    pub ladder: CardLadder,
    /// What the shapes of the envelope may report.
    pub shapes: Vec<CardShape>,
}

impl CardShape {
    /// `{ pattern, module, known, stages, reports }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("pattern", self.pattern.as_str())
            .with(
                "module",
                self.module.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("known", self.known)
            .with(
                "stages",
                JsValue::Array(
                    self.stages
                        .iter()
                        .map(|s| {
                            JsObject::new()
                                .with("name", s.name.as_str())
                                .with("title", s.title.as_str())
                                .into()
                        })
                        .collect(),
                ),
            )
            .with(
                "reports",
                JsValue::Array(
                    self.reports
                        .iter()
                        .map(|r| {
                            JsObject::new()
                                .with("role", r.role.as_str())
                                .with("title", r.title.as_str())
                                .with("fields", texts(&r.fields))
                                .with("at_most", r.multiplicity.to_js())
                                .into()
                        })
                        .collect(),
                ),
            )
            .into()
    }
}

impl CardAttention {
    /// `{ attention, ladder: { required, role, text }, shapes }`: the three
    /// members a card of 0.7 ends with.
    fn to_js(&self) -> [(&'static str, JsValue); 3] {
        let ladder = JsObject::new()
            .with("required", self.ladder.required)
            .with(
                "role",
                self.ladder
                    .role
                    .as_deref()
                    .map_or(JsValue::Null, JsValue::from),
            )
            .with(
                "text",
                self.ladder
                    .text
                    .as_deref()
                    .map_or(JsValue::Null, JsValue::from),
            );
        [
            ("attention", self.view.to_js()),
            ("ladder", ladder.into()),
            (
                "shapes",
                JsValue::Array(self.shapes.iter().map(CardShape::to_js).collect()),
            ),
        ]
    }
}

/// The card of a workflow with an envelope: `CardView`.
#[derive(Clone, Debug, PartialEq)]
pub struct CardView {
    /// The program it shows.
    pub program: ProgramRef,
    /// The workflow.
    pub workflow: String,
    /// The package hash an approval of this envelope is signed for.
    pub package: String,
    /// What it does: the steps the architecture view draws.
    pub steps: Vec<String>,
    /// Each map, with its bounds.
    pub maps: Vec<CardMap>,
    /// Each plan, with its lead's budget.
    pub plans: Vec<CardPlan>,
    /// What it can touch.
    pub touches: CardTouches,
    /// The most it spends, per dimension.
    pub spends: Vec<CardBudgetRow>,
    /// When it asks whom: the places it waits for a person by role.
    pub waits: Vec<CardWait>,
    /// When it asks whom: the envelope's approvals.
    pub approvals: Vec<CardApproval>,
    /// Who approves it, and who may amend it.
    pub approves: CardApproves,
    /// 0.6: what a program of 0.6 adds ([`CardLibrary`]); `None` for a
    /// program of 0.1 to 0.5, whose card is what it was.
    pub library: Option<CardLibrary>,
    /// 0.7: what a program of 0.7 adds ([`CardAttention`]); `None` for a
    /// program of 0.1 to 0.6, whose card is what it was.
    pub attention: Option<CardAttention>,
}

impl CardView {
    /// `{ format, kind, program, workflow, package, does: { steps, maps,
    /// plans }, touches, spends, asks: { waits, approvals }, approves }`,
    /// and in 0.6 a `library` member, and in 0.7 `attention`, `ladder` and
    /// `shapes` last.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let t = &self.touches;
        let touches = JsObject::new()
            .spread(&t.authority.to_js())
            .with("caps", texts(&t.caps))
            .with("max_class", t.max_class.as_str())
            .with(
                "max_concurrent",
                t.max_concurrent.map_or(JsValue::Null, JsValue::from),
            );
        let a = &self.approves;
        let approves = JsObject::new()
            .with(
                "role",
                a.role.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("description", a.description.clone())
            .with("lock", a.lock)
            .with(
                "members",
                JsValue::Array(
                    a.members
                        .iter()
                        .map(|m| {
                            JsObject::new()
                                .with("member", m.member.as_str())
                                .with("keys", m.keys)
                                .into()
                        })
                        .collect(),
                ),
            )
            .with("bound", a.bound)
            .with("text", a.text.as_str());
        let card = JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "card")
            .with("program", self.program.to_js())
            .with("workflow", self.workflow.as_str())
            .with("package", self.package.as_str())
            .with(
                "does",
                JsObject::new()
                    .with("steps", texts(&self.steps))
                    .with(
                        "maps",
                        JsValue::Array(self.maps.iter().map(CardMap::to_js).collect()),
                    )
                    .with(
                        "plans",
                        JsValue::Array(self.plans.iter().map(CardPlan::to_js).collect()),
                    ),
            )
            .with("touches", touches)
            .with(
                "spends",
                JsValue::Array(self.spends.iter().map(CardBudgetRow::to_js).collect()),
            )
            .with(
                "asks",
                JsObject::new()
                    .with(
                        "waits",
                        JsValue::Array(self.waits.iter().map(CardWait::to_js).collect()),
                    )
                    .with(
                        "approvals",
                        JsValue::Array(self.approvals.iter().map(CardApproval::to_js).collect()),
                    ),
            )
            .with("approves", approves);
        let card = match &self.library {
            Some(library) => card.with("library", library.to_js()),
            None => card,
        };
        match &self.attention {
            Some(a) => a
                .to_js()
                .into_iter()
                .fold(card, |card, (name, v)| card.with(name, v))
                .into(),
            None => card.into(),
        }
    }
}

// ── small texts ──────────────────────────────────────────────────────────

/// Whether a program is of 0.6 (or later), whose card is made for a
/// workflow without an envelope too.
fn reads_0_6(p: Program<'_>) -> bool {
    p.language().is_some_and(|l| l.at_least(Language::V0_6))
}

/// The workflows of a program that have an envelope, sorted: the ones that
/// have a card: `envelopeWorkflows(program)`. In a program of 0.6 every
/// workflow has a card (spec/library.md "Views"), so every workflow is here,
/// with an envelope or without.
#[must_use]
pub fn envelope_workflows(program: &Value) -> Vec<String> {
    let mut names: Vec<String> = Program::of(program)
        .map(|p| {
            let all = reads_0_6(p);
            defs_of(p)
                .iter()
                .filter(|(_, d)| {
                    is_kind(d, "workflow")
                        && (all || d.get("envelope").is_some_and(Value::is_truthy))
                })
                .map(|(n, _)| n.to_owned())
                .collect()
        })
        .unwrap_or_default();
    sort_utf16(&mut names);
    names
}

/// An expression as a person reads it in a card: names, fields, literals and
/// calls; anything else is `…`: `exprText(e)`. An expression that is not
/// there is read as `…` too (the TypeScript would throw).
pub(crate) fn expr_text(e: Option<Expr<'_>>) -> String {
    let Some(e) = e else {
        return "…".to_owned();
    };
    match e.op() {
        Some(ExprOp::Var) => js_text(e.get("name")),
        Some(ExprOp::Field) => format!("{}.{}", expr_text(e.operand()), js_text(e.get("name"))),
        // `JSON.stringify(e.value)`.
        Some(ExprOp::Text) => match e.value() {
            Some(Value::String(s)) => json_string(s),
            Some(other) => j(other),
            None => "undefined".to_owned(),
        },
        Some(ExprOp::Int) => js_text(e.value()),
        Some(ExprOp::Call) => {
            let args: Vec<String> = e
                .args()
                .map(|a| {
                    // `a.name ? `${a.name}: ` : ""`.
                    let name = a
                        .name()
                        .filter(|n| !n.is_empty())
                        .map(|n| format!("{n}: "))
                        .unwrap_or_default();
                    format!("{name}{}", expr_text(a.value()))
                })
                .collect();
            format!("{}({})", expr_text(e.callee()), args.join(", "))
        }
        _ => "…".to_owned(),
    }
}

/// `/\w/`: a letter, a digit or an underscore of ASCII.
fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// 80000000 as `80,000,000`: `grouped(n)`. It does what
/// `String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",")` does to the
/// text of the number: a comma before each run of digits whose length is a
/// multiple of three, where a word character comes before it. So it also
/// groups the digits after a decimal point (`1234.5678` is `1,234.5,678`),
/// as the TypeScript does.
fn grouped(n: f64) -> String {
    let text = number_to_string(n.abs());
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::new();
    for (i, c) in chars.iter().enumerate() {
        if i > 0 {
            let after_word = chars.get(i.saturating_sub(1)).is_some_and(|p| is_word(*p));
            let digits = chars
                .iter()
                .skip(i)
                .take_while(|d| d.is_ascii_digit())
                .count();
            if after_word && digits > 0 && digits.checked_rem(3) == Some(0) {
                out.push(',');
            }
        }
        out.push(*c);
    }
    if n < 0.0 { format!("-{out}") } else { out }
}

/// A number as `if (x)` reads it: neither zero nor `NaN`.
fn truthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// Milliseconds as hours and minutes: `6 h`, `3 h 20 min`: `hoursText(ms)`.
fn hours_text(ms: f64) -> String {
    if ms < 0.0 {
        return format!("-{}", hours_text(-ms));
    }
    let h = (ms / 3_600_000.0).floor();
    let m = ((ms % 3_600_000.0) / 60_000.0).floor();
    let s = ((ms % 60_000.0) / 1000.0).floor();
    let rest = ms % 1000.0;
    let parts: Vec<String> = [(h, "h"), (m, "min"), (s, "s"), (rest, "ms")]
        .iter()
        .filter(|(v, _)| truthy(*v))
        .map(|(v, unit)| format!("{} {unit}", number_to_string(*v)))
        .collect();
    if parts.is_empty() {
        "0 min".to_owned()
    } else {
        parts.join(" ")
    }
}

/// How a role site waits for a person, as the card names it: `WAIT_KIND`.
fn wait_kind(site: &str) -> Option<&'static str> {
    match site {
        "human.approve" => Some("human.approve"),
        "human.ask" => Some("human.ask"),
        "an escalation" => Some("escalate human(…)"),
        "a supervision's escalation" => Some("supervise escalate(…)"),
        "a change set's approver" => Some("change set approval"),
        "a change set member's approver" => Some("change set member approval"),
        _ => None,
    }
}

/// The definitions a workflow reaches: itself, the functions it calls (and
/// theirs), the contracts it verifies against: `reachable(defs, start)`.
fn reachable(defs: &Map, start: &str) -> Vec<String> {
    fn kind_is(defs: &Map, name: &str, kind: &str) -> bool {
        defs.get(name).is_some_and(|d| is_kind(d, kind))
    }
    fn walk(defs: &Map, v: &Value, found: &mut Vec<String>) {
        match v {
            Value::Array(items) => {
                for x in items {
                    walk(defs, x, found);
                }
            }
            Value::Object(map) => {
                let op = map.get("op").and_then(Value::as_str);
                let callee = map.get("callee");
                let next: Option<&str> = if op == Some("call") {
                    callee
                        .filter(|c| c.get("op").and_then(Value::as_str) == Some("var"))
                        .and_then(|c| c.get("name"))
                        .and_then(Value::as_str)
                        .filter(|n| kind_is(defs, n, "fn"))
                } else if op == Some("verify") {
                    map.get("contract")
                        .and_then(Value::as_str)
                        .filter(|c| kind_is(defs, c, "contract"))
                } else {
                    None
                };
                if let Some(next) = next
                    && !found.iter().any(|f| f == next)
                {
                    found.push(next.to_owned());
                    if let Some(d) = defs.get(next) {
                        walk(defs, d, found);
                    }
                }
                for (_, x) in map.iter() {
                    walk(defs, x, found);
                }
            }
            _ => {}
        }
    }
    let mut found = vec![start.to_owned()];
    if let Some(d) = defs.get(start) {
        walk(defs, d, &mut found);
    }
    found
}

/// The members a lock binds to a role, sorted: `[...(own(lock?.roles, role)
/// ?? [])].sort()`. A role whose members are a string is spread by
/// character, as JavaScript spreads one; a value that is neither an array,
/// a string nor `null` is not iterable, which the TypeScript throws at: here
/// it has no members.
pub(crate) fn members_of(lock: Option<&Value>, role: &str) -> Vec<String> {
    let found = own(lock.and_then(|l| l.get("roles")), role);
    let mut members: Vec<String> = match found {
        Some(Value::Array(items)) => items.iter().map(|x| js_text(Some(x))).collect(),
        Some(Value::String(s)) => s.chars().map(String::from).collect(),
        _ => Vec::new(),
    };
    sort_utf16(&mut members);
    members
}

/// How many keys the lock holds for a member: `own(lock?.members,
/// m)?.keys.length ?? 0`. A member without `keys` makes the TypeScript throw:
/// here it holds none.
fn key_count(lock: Option<&Value>, member: &str) -> usize {
    match own(lock.and_then(|l| l.get("members")), member).and_then(|m| m.get("keys")) {
        Some(Value::Array(keys)) => keys.len(),
        Some(Value::String(s)) => utf16_len(s),
        _ => 0,
    }
}

/// `x ?? null` of a member of the IR, as a value of a view.
fn present(v: Option<&Value>) -> JsValue {
    match v {
        None | Some(Value::Null) => JsValue::Null,
        Some(v) => JsValue::from(v),
    }
}

/// `x ?? null` of a number of the IR: `None` for a member that is missing or
/// `null`, else what `ToNumber` makes of it.
pub(crate) fn limit_of(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        Some(v) => Some(num(Some(v))),
    }
}

// ── what it does ─────────────────────────────────────────────────────────

/// The `agent.skill` of every delegation inside `v`, once each, in the order
/// the walk meets them (every object in the order of its members).
fn delegates_in(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::Array(items) => {
            for x in items {
                delegates_in(x, out);
            }
        }
        Value::Object(map) => {
            if Expr::of(v).is_some_and(|d| d.is(ExprOp::Delegate)) {
                let name = format!(
                    "{}.{}",
                    js_text(map.get("agent")),
                    js_text(map.get("skill"))
                );
                if !out.contains(&name) {
                    out.push(name);
                }
            }
            for (_, x) in map.iter() {
                delegates_in(x, out);
            }
        }
        _ => {}
    }
}

/// The maps and the plans of a workflow's body, found by the walk of
/// `card`'s `visit`.
struct Visit<'a> {
    /// The program the card is of, linked with its modules.
    lp: Program<'a>,
    maps: Vec<CardMap>,
    plans: Vec<CardPlan>,
}

impl Visit<'_> {
    fn walk(&mut self, v: &Value) {
        match v {
            Value::Array(items) => {
                for x in items {
                    self.walk(x);
                }
            }
            Value::Object(map) => {
                if let Some(e) = Expr::of(v) {
                    if e.is(ExprOp::Map) {
                        self.map(e);
                    }
                    if e.is(ExprOp::Plan) {
                        self.plan(e);
                    }
                }
                for (_, x) in map.iter() {
                    self.walk(x);
                }
            }
            _ => {}
        }
    }

    /// What a map runs over, as a person reads it. In 0.6 a pattern's `const`
    /// slot may carry a list of constants, which its expansion puts here: it is
    /// said by its length and its type (`a list of 2 Repo`), never printed.
    fn over_text(&self, over: Option<Expr<'_>>) -> String {
        let list = over.filter(|o| {
            o.is(ExprOp::List)
                && self
                    .lp
                    .language()
                    .is_some_and(|l| l.at_least(Language::V0_6))
        });
        let Some(list) = list else {
            return expr_text(over);
        };
        let types = unique_in_order(
            list.items()
                .filter_map(|i| i.record_type().map(str::to_owned)),
        );
        let n = list.item_values().len();
        match types.as_slice() {
            [one] => format!("a list of {n} {one}"),
            _ => format!("a list of {n}"),
        }
    }

    fn map(&mut self, e: Expr<'_>) {
        let mut delegates: Vec<String> = Vec::new();
        for s in e.body() {
            delegates_in(s, &mut delegates);
        }
        let handed = e
            .caps()
            .unwrap_or_default()
            .iter()
            .map(|c| {
                let vals = caps_in(self.lp, std::slice::from_ref(c));
                let kinds = unique_in_order(vals.iter().map(|x| x.ctor().to_owned()));
                let scopes: Vec<String> = vals
                    .iter()
                    .flat_map(|x| x.scope().unwrap_or_default().iter().cloned())
                    .collect();
                // `vals.length && vals.every((x) => x.scope) ? scopes : null`.
                let static_scope = !vals.is_empty() && vals.iter().all(|x| x.scope().is_some());
                CardHanded {
                    cap: expr_text(Expr::of(c)),
                    kinds,
                    scope: static_scope.then_some(scopes),
                    by_item: e.bind().is_some_and(|b| reads_var(c, b)),
                }
            })
            .collect();
        self.maps.push(CardMap {
            bind: js_text(e.get("bind")),
            over: self.over_text(e.over()),
            max: limit_of(e.get("max")),
            par: e.get("par").map_or(1.0, |p| match p {
                Value::Null => 1.0,
                p => num(Some(p)),
            }),
            delegates,
            handed,
        });
    }

    fn plan(&mut self, e: Expr<'_>) {
        // The plan's lead is costed as the delegation it stands for.
        let delegation = delegate_of_plan(e);
        let DelegateBudget { budget, from } = Expr::of(&delegation).map_or(
            DelegateBudget {
                budget: None,
                from: BudgetFrom::None,
            },
            |d| delegate_budget(self.lp, d, None),
        );
        let of = |key: &str| present(budget.and_then(|b| b.get(key)));
        // `budget?.spend ? { ...budget.spend } : null`.
        let spend = match budget
            .and_then(|b| b.get("spend"))
            .filter(|s| s.is_truthy())
        {
            Some(Value::Object(m)) => JsValue::Object(JsObject::from(m)),
            Some(_) => JsValue::Object(JsObject::new()),
            None => JsValue::Null,
        };
        self.plans.push(CardPlan {
            lead: format!("{}.{}", js_text(e.get("agent")), js_text(e.get("skill"))),
            budget: show(budget),
            from,
            numbers: CardPlanNumbers {
                spend,
                tokens: of("tokens"),
                time_ms: present(budget.and_then(|b| b.get("time")).and_then(|t| t.get("ms"))),
                steps: of("steps"),
                agents: of("agents"),
            },
        });
    }
}

// ── the most it spends ───────────────────────────────────────────────────

/// One row of the budget beside the static part: the `row` of `card`.
fn budget_row(
    dimension: &'static str,
    unit: &'static str,
    currency: Option<&str>,
    limit: Option<f64>,
    used: f64,
    fmt: &dyn Fn(f64) -> String,
) -> CardBudgetRow {
    let left = limit.map(|l| l - used);
    CardBudgetRow {
        dimension,
        currency: currency.map(str::to_owned),
        unit,
        envelope: limit,
        r#static: used,
        left,
        text: CardBudgetText {
            envelope: limit.map_or_else(|| "no limit".to_owned(), fmt),
            r#static: fmt(used),
            left: left.map_or_else(|| "no limit".to_owned(), fmt),
        },
    }
}

/// The most delegations a workflow without an envelope has in flight at once:
/// the widest `par` of a map that delegates, else one if it delegates at all.
fn in_flight(maps: &[CardMap], wf: &Value) -> f64 {
    let widest = maps
        .iter()
        .filter(|m| !m.delegates.is_empty())
        .map(|m| m.par)
        .fold(0.0_f64, f64::max);
    if widest > 0.0 {
        return widest;
    }
    let mut any: Vec<String> = Vec::new();
    for s in Definition::of(wf).body() {
        delegates_in(s, &mut any);
    }
    if any.is_empty() { 0.0 } else { 1.0 }
}

// ── the card ─────────────────────────────────────────────────────────────

/// The card of a workflow with an envelope: what a person reads before
/// approving it. Computed from the IR and the lock; `modules` are the
/// modules the program imports, so imported functions and capabilities are
/// seen. The package hash is the one the runtime checks at load and an
/// approval is signed for. `None` for a workflow without an envelope, or no
/// workflow: `card(program, workflow, { lock, modules })`.
///
/// A program of 0.7 whose attention part cannot be made (it does not check
/// with these modules and this lock) has no card either: use [`card_given`]
/// to be told why.
#[must_use]
pub fn card(
    program: &Value,
    workflow: &str,
    lock: Option<&Value>,
    modules: Option<&Modules>,
) -> Option<CardView> {
    let given = CheckOptions {
        modules,
        ..CheckOptions::default()
    };
    card_given(program, workflow, lock, modules, &given)
        .ok()
        .flatten()
}

/// Why a card cannot be made: a program of 0.7 or later that does not check
/// with the modules, libraries and lock the card is given. A card of such a
/// program is not made in any form, not even without its attention part,
/// since what a person would sign would leave out what the workflow asks and
/// tells.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardRefused {
    /// What is missing: the diagnostics of the check, one after the other.
    pub message: String,
}

impl std::fmt::Display for CardRefused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl CardRefused {
    /// The refusal of the card of `workflow`, from the check that failed.
    fn of(workflow: &str, diagnostics: &[mandate_ir::Diagnostic]) -> CardRefused {
        let errors: Vec<String> = diagnostics
            .iter()
            .filter(|d| d.severity == mandate_ir::Severity::Error)
            .map(|d| format!("{}: {}", d.code, d.message))
            .collect();
        let why = if errors.is_empty() {
            "its attention facts could not be made".to_owned()
        } else {
            errors.join("; ")
        };
        let libraries = if diagnostics.iter().any(|d| d.code == "MDT-E1605") {
            " (the libraries the lock pins were not given, or are not what it pins)"
        } else {
            ""
        };
        CardRefused {
            message: format!(
                "the card of {workflow} is not made: the program does not check with the modules, libraries and lock it is given{libraries}: {why}"
            ),
        }
    }
}

/// [`card`], with the options the check of a program of 0.7 is given besides
/// the lock: the attention view of the card is made from the facts of that
/// check, which a program that needs libraries read from a directory is
/// given by this function (`CheckOptions`; its `lock` is the one given
/// here). `modules` is what the other parts of the card are given.
///
/// `Ok(None)` where [`card`] is `None` for want of a workflow. For a
/// program of 0.7 or later that does not check with these options there is
/// no card in any form: the refusal says what is missing.
///
/// # Errors
/// [`CardRefused`] for such a program.
pub fn card_given(
    program: &Value,
    workflow: &str,
    lock: Option<&Value>,
    modules: Option<&Modules>,
    check_with: &CheckOptions<'_>,
) -> Result<Option<CardView>, CardRefused> {
    let Some(written) = Program::of(program) else {
        return Ok(None);
    };
    let has_workflow = defs_of(written)
        .get(workflow)
        .is_some_and(|d| is_kind(d, "workflow"));
    if !has_workflow || !reads_0_7(written) {
        return Ok(card_made(program, workflow, lock, modules, None));
    }
    let opts = CheckOptions {
        lock,
        ..*check_with
    };
    let text = mandate_ir::canonicalize(program);
    let view = attention_view(&text, SourceKind::Json, &opts, workflow);
    match view {
        Some(view) => Ok(card_made(program, workflow, lock, modules, Some(view))),
        None => Err(CardRefused::of(
            workflow,
            &mandate_check::check(&text, SourceKind::Json, &opts).diagnostics,
        )),
    }
}

/// The card, with the attention view of a program of 0.7.
fn card_made(
    program: &Value,
    workflow: &str,
    lock: Option<&Value>,
    modules: Option<&Modules>,
    view: Option<AttentionView>,
) -> Option<CardView> {
    let written = Program::of(program)?;
    let is_0_6 = reads_0_6(written);
    let orig_wf = defs_of(written)
        .get(workflow)
        .filter(|d| is_kind(d, "workflow"))?;
    // 0.6: a workflow that applies a pattern is read as its expansion (or, if
    // the pattern's module is not given, the stand-in that says so).
    let expanded: Option<Value> = if is_0_6 {
        mandate_check::expand::for_views_pinned(
            program,
            modules,
            mandate_check::library::std_patterns_pin(lock).as_ref(),
        )
    } else {
        None
    };
    let body_program = expanded.as_ref().unwrap_or(program);
    let p = Program::of(body_program)?;
    let wf = defs_of(p)
        .get(workflow)
        .filter(|d| is_kind(d, "workflow"))?;
    // An envelope, or in 0.6 the workflow's own `caps` and `budget` in its
    // place.
    let env = wf.get("envelope").filter(|e| e.is_truthy());
    if env.is_none() && !is_0_6 {
        return None;
    }
    let linked = link(p, modules);
    // `Object.keys(modules).length ? linkedProgram(program, modules) : program`.
    let linked_value: Option<Value> = modules
        .filter(|m| !m.is_empty())
        .map(|_| linked_program(p, modules));
    let lp = Program::of(linked_value.as_ref().unwrap_or(body_program))?;
    let r = program_ref(program);
    // `!!lock`: a lock that is `null` or another falsy value is no lock.
    let lock_given = lock.is_some_and(Value::is_truthy);

    // What it does: the steps the architecture view draws, then each map and
    // plan with its bounds.
    let mut visit = Visit {
        lp,
        maps: Vec::new(),
        plans: Vec::new(),
    };
    for s in Definition::of(wf).body() {
        visit.walk(s);
    }

    // What it can touch: the envelope's capabilities, opened as the authority
    // view opens them.
    let caps = caps_in(
        lp,
        match env {
            Some(env) => env
                .get("caps")
                .and_then(Value::as_array)
                .unwrap_or_default(),
            None => workflow_bounds(wf).caps,
        },
    );
    let spawn = env.and_then(|e| e.get("spawn"));
    let touches = CardTouches {
        authority: authority_of(&caps),
        caps: caps.iter().map(show_cap).collect(),
        max_class: match (env, spawn.and_then(|s| s.get("max_class"))) {
            // Without an envelope nothing is `spawn`ed; a delegation receives
            // at most what the model capabilities the workflow holds allow.
            (None, _) => caps
                .iter()
                .filter(|c| c.ctor() == "model.infer")
                .filter_map(|c| c.max_class())
                .max()
                .map_or_else(|| "internal".to_owned(), |c| c.as_str().to_owned()),
            (Some(_), None | Some(Value::Null)) => "internal".to_owned(),
            (Some(_), some) => js_text(some),
        },
        max_concurrent: match env {
            Some(_) => limit_of(spawn.and_then(|s| s.get("max_concurrent"))),
            // The stand-in of a pattern that was not expanded does not say
            // how many run at a time.
            None => (!wf.get("unexpanded").is_some_and(Value::is_truthy))
                .then(|| in_flight(&visit.maps, wf)),
        },
    };

    // The most it spends: the envelope's budget beside the checker's static
    // upper bound.
    let sc = static_cost(p, workflow, Some(&linked.defs)).unwrap_or_default();
    let b = match env {
        Some(env) => env.get("budget"),
        None => wf.get("budget").filter(|b| b.is_truthy()),
    };
    let mut currencies: Vec<String> = Vec::new();
    let mut named: Vec<String> = sc.spend.iter().map(|(c, _)| c.clone()).collect();
    sort_utf16(&mut named);
    let spend_of_budget = b.and_then(|b| b.get("spend")).filter(|s| s.is_truthy());
    if let Some(spend) = spend_of_budget {
        currencies.push(js_text(spend.get("currency")));
    }
    currencies.extend(named);
    let currencies = unique_in_order(currencies);
    let mut spends: Vec<CardBudgetRow> = Vec::new();
    if currencies.is_empty() {
        spends.push(budget_row(
            "spend",
            "micros",
            None,
            None,
            0.0,
            &number_to_string,
        ));
    }
    for c in &currencies {
        let limit = spend_of_budget
            .filter(|s| js_text(s.get("currency")) == *c)
            .and_then(|s| limit_of(s.get("micros")));
        spends.push(budget_row(
            "spend",
            "micros",
            Some(c),
            limit,
            sc.spend_in(c).unwrap_or(0.0),
            &|n| micros_text(n, c),
        ));
    }
    let dimension = |name: &'static str,
                     unit: &'static str,
                     key: &str,
                     used: f64,
                     fmt: &dyn Fn(f64) -> String| {
        budget_row(
            name,
            unit,
            None,
            limit_of(b.and_then(|b| b.get(key))),
            used,
            fmt,
        )
    };
    spends.push(dimension("tokens", "tokens", "tokens", sc.tokens, &grouped));
    spends.push(budget_row(
        "time",
        "ms",
        None,
        limit_of(b.and_then(|b| b.get("time")).and_then(|t| t.get("ms"))),
        sc.time,
        &hours_text,
    ));
    spends.push(dimension("steps", "steps", "steps", sc.steps, &grouped));
    spends.push(dimension("agents", "agents", "agents", sc.agents, &grouped));
    // 0.6: a workflow whose pattern the card is not given has no static part
    // it can bound; it says so, and shows no number that would be less than
    // the expansion's.
    if wf.get("unexpanded").is_some_and(Value::is_truthy) {
        for row in &mut spends {
            row.r#static = f64::NAN;
            row.left = None;
            row.text.r#static = "unknown".to_owned();
            row.text.left = "unknown".to_owned();
        }
    }

    // When it asks whom: every place it reaches that waits for a person and
    // names a role, and the envelope's approvals.
    let names = reachable(&linked.defs, workflow);
    let mut reached = Map::new();
    for n in &names {
        if let Some(d) = linked.defs.get(n) {
            reached.insert(n.as_str(), d.clone());
        }
    }
    let place = |n: &str| -> String {
        if n == workflow {
            "its body".to_owned()
        } else if linked.defs.get(n).is_some_and(|d| is_kind(d, "fn")) {
            format!("function {n}")
        } else {
            format!("contract {n}")
        }
    };
    let waits: Vec<CardWait> = role_sites(&reached)
        .into_iter()
        .filter(|s| !s.distinct && s.role.is_some())
        .filter_map(|s| {
            let kind = wait_kind(&s.r#where)?;
            let role = s.role?;
            Some(CardWait {
                members: members_of(lock, &role),
                role,
                kind: kind.to_owned(),
                r#in: place(&s.def),
                def: s.def,
                path: s.path,
            })
        })
        .collect();
    let mut approve: Vec<(&str, &Value)> = env
        .and_then(|e| e.get("approve"))
        .and_then(Value::as_object)
        .map(|m| m.iter().collect())
        .unwrap_or_default();
    approve.sort_by(|a, b| compare_utf16(a.0, b.0));
    let approvals: Vec<CardApproval> = approve
        .into_iter()
        .map(|(effect, role)| {
            let role = js_text(Some(role));
            CardApproval {
                effect: effect.to_owned(),
                members: members_of(lock, &role),
                role,
            }
        })
        .collect();

    // Who approves it, and every amendment: the owner role and the members
    // the lock binds to it.
    // 0.7: a workflow without an envelope may name its own `owner`.
    let owner: Option<String> = match env.and_then(|e| e.get("owner")) {
        None | Some(Value::Null) if env.is_none() && reads_0_7(written) => {
            Definition::of(orig_wf).owner().map(str::to_owned)
        }
        None | Some(Value::Null) => None,
        some => Some(js_text(some)),
    };
    let owned = env.is_none() && owner.is_some();
    let role_def = owner
        .as_deref()
        .and_then(|o| defs_of(lp).get(o))
        .filter(|d| is_kind(d, "role"));
    let members: Vec<CardMember> = owner.as_deref().map_or_else(Vec::new, |o| {
        members_of(lock, o)
            .into_iter()
            .map(|m| CardMember {
                keys: key_count(lock, &m),
                member: m,
            })
            .collect()
    });
    let text = match owner.as_deref() {
        None if env.is_none() => NO_ENVELOPE.to_owned(),
        None => "Nobody can approve it yet: the envelope names no owner role.".to_owned(),
        Some(o) if !lock_given => {
            format!("Nobody can approve it yet: there is no lock, so no member holds the role {o}.")
        }
        Some(o) if members.is_empty() => {
            format!("Nobody can approve it yet: the lock binds no member to the role {o}.")
        }
        Some(o) => {
            let who: Vec<String> = members
                .iter()
                .map(|m| {
                    format!(
                        "{} ({} {})",
                        m.member,
                        m.keys,
                        if m.keys == 1 { "key" } else { "keys" }
                    )
                })
                .collect();
            if owned {
                format!(
                    "A member of {o} approves this card before any run: {}. Nobody may amend a workflow without an envelope.",
                    who.join(", ")
                )
            } else {
                format!(
                    "A member of {o} approves it, and every amendment: {}.",
                    who.join(", ")
                )
            }
        }
    };
    let package = package_hash(&r.hash, &Value::Object(packaged_lock(lock)));
    // 0.6: what the card adds. A workflow with an envelope that has nothing
    // of 0.6 to say has the card it had.
    let library = is_0_6
        .then(|| {
            gather(&Gather {
                program: written,
                orig_wf,
                lp,
                wf,
                workflow,
                envelope: env.is_some(),
                lock,
                modules,
                sc: &sc,
            })
        })
        .filter(|l| !l.envelope || l.has_content());
    let attention = view.map(|view| CardAttention {
        view,
        ladder: ladder_of(lock, owner.as_deref(), &members),
        shapes: env.map_or_else(Vec::new, |e| shapes_of_card(written, e, modules, lock)),
    });
    Some(CardView {
        program: r,
        workflow: workflow.to_owned(),
        package,
        steps: steps(lp, wf),
        maps: visit.maps,
        plans: visit.plans,
        touches,
        spends,
        waits,
        approvals,
        approves: CardApproves {
            description: match role_def {
                Some(d) => js(d.get("description")),
                None => JsValue::Null,
            },
            role: owner,
            lock: lock_given,
            bound: !members.is_empty(),
            members,
            text,
        },
        library,
        attention,
    })
}

/// The ladder the lock asks for, and who signs its promotions (0.7;
/// spec/attention.md "Promotion").
fn ladder_of(lock: Option<&Value>, owner: Option<&str>, members: &[CardMember]) -> CardLadder {
    let required = lock.is_some_and(|l| Lock::of(l).promotion_required());
    let text = required.then(|| {
        let by = match owner {
            Some(role) => {
                let names: Vec<&str> = members.iter().map(|m| m.member.as_str()).collect();
                if names.is_empty() {
                    format!("a member of {role}")
                } else {
                    format!("a member of {role} ({})", names.join(", "))
                }
            }
            None => "nobody: the workflow names no owner, so no one could sign one".to_owned(),
        };
        format!(
            "Every run in read_only mode and in live mode needs a promotion signed by {by}: a run in read_only needs a succeeded design run of this package and workflow, and a run in live needs a succeeded read_only run of them, with the shadow diff of that run against its design run. A promotion holds for every later run of the same package hash and workflow in its target mode; a changed package is a new hash and needs new promotions."
        )
    });
    CardLadder {
        required,
        role: owner.map(str::to_owned),
        text,
    }
}

/// What the shapes of an envelope may report, each read from the definition
/// of its pattern as the program, or the library it uses, writes it (0.7).
fn shapes_of_card(
    written: Program<'_>,
    envelope: &Value,
    modules: Option<&Modules>,
    lock: Option<&Value>,
) -> Vec<CardShape> {
    let names = mandate_check::shapes::shapes_of(envelope).unwrap_or_default();
    if names.is_empty() {
        return Vec::new();
    }
    // The built-in `std.patterns` the lock pins, unless the modules hold it.
    let pin = mandate_check::library::std_patterns_pin(lock);
    let with_builtin = mandate_check::library::with_builtin(written, modules, pin.as_ref());
    let linked = link(written, with_builtin.as_ref().or(modules));
    names
        .into_iter()
        .map(|name| {
            let module = mandate_check::shapes::module_of(written, name)
                .filter(|m| Some(*m) != written.module())
                .map(str::to_owned);
            let body = linked
                .defs
                .get(name)
                .filter(|d| is_kind(d, "pattern"))
                .and_then(|d| d.get("body"))
                .and_then(Value::as_array);
            let mut stages: Vec<ViewStage> = Vec::new();
            let mut reports: Vec<CardShapeReport> = Vec::new();
            if let Some(body) = body {
                for s in body {
                    if let Some(st) = Stmt::of(s).filter(|st| st.op() == Some(StmtOp::Stage)) {
                        stages.push(ViewStage {
                            name: st.name().unwrap_or_default().to_owned(),
                            title: st.title().unwrap_or_default().to_owned(),
                        });
                    }
                }
                sites(body, "/body", &mut |site| {
                    if let Some(st) =
                        Stmt::of(site.node).filter(|st| st.op() == Some(StmtOp::Report))
                    {
                        reports.push(CardShapeReport {
                            role: st.role().unwrap_or_default().to_owned(),
                            title: st.title().unwrap_or_default().to_owned(),
                            fields: st
                                .fields()
                                .iter()
                                .filter_map(|f| {
                                    ReportField::of(f)
                                        .and_then(ReportField::name)
                                        .map(str::to_owned)
                                })
                                .collect(),
                            multiplicity: site.times,
                        });
                    }
                });
            }
            CardShape {
                pattern: name.to_owned(),
                module,
                known: body.is_some(),
                stages,
                reports,
            }
        })
        .collect()
}

/// Whether a program is of 0.7 (or later), whose card has an attention
/// part.
fn reads_0_7(p: Program<'_>) -> bool {
    p.language().is_some_and(|l| l.at_least(Language::V0_7))
}

/// What the card of a 0.7 program says of the authorizations the envelope
/// declares for effects that no step of the workflow itself reaches (the
/// list that follows names them).
const UNLISTED_APPROVALS: &str = "These authorizations are decided by the role the table above names, but no step of the workflow itself reaches the effect, so the table of questions has no row for them and its total does not count them. A sub-program a lead writes under the envelope may reach them: each decision is then one of that sub-program's questions, taken, where the envelope limits asks, from what is left of the run's asks at its admission (E1706), and held by that limit while the run goes on.";

/// What a card of a workflow without an envelope says of who approves it.
const NO_ENVELOPE: &str = "No envelope is approved before a run, and nobody may amend it.";

// ── documents ────────────────────────────────────────────────────────────

/// A value as `if (x)` reads it.
fn js_truthy(v: &JsValue) -> bool {
    match v {
        JsValue::Undefined | JsValue::Null => false,
        JsValue::Bool(b) => *b,
        JsValue::Number(n) => truthy(*n),
        JsValue::String(s) => !s.is_empty(),
        JsValue::Array(_) | JsValue::Object(_) => true,
        // A value written once: falsy when it is written as one that is.
        JsValue::Json(text) => !matches!(text.as_str(), "null" | "false" | "0" | "\"\""),
    }
}

/// The members of a role as a table shows them: `nobody bound` for none.
fn members_text(ms: &[String]) -> String {
    if ms.is_empty() {
        "nobody bound".to_owned()
    } else {
        ms.join(", ")
    }
}

/// What a map hands each item, as one cell.
fn handed_text(m: &CardMap) -> String {
    let parts: Vec<String> = m
        .handed
        .iter()
        .map(|h| {
            let kinds = h.kinds.join(", ");
            let what = if kinds.is_empty() {
                h.cap.as_str()
            } else {
                &kinds
            };
            let scope = match &h.scope {
                Some(scope) => format!("within {}", scope.join(", ")),
                None if h.by_item => format!("narrowed by each item ({})", h.cap),
                None => format!("of unknown scope ({})", h.cap),
            };
            format!("{what} {scope}")
        })
        .collect();
    list(&parts)
}

fn heads(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|x| (*x).to_owned()).collect()
}

/// What the envelope's shapes may report (0.7), as blocks.
fn shape_blocks(shapes: &[CardShape]) -> Vec<Block> {
    if shapes.is_empty() {
        return Vec::new();
    }
    let rows: Vec<Vec<Cell>> = shapes
        .iter()
        .map(|s| {
            let name = match &s.module {
                Some(m) => format!("{} (of {m})", s.pattern),
                None => s.pattern.clone(),
            };
            let (stages, reports) = if s.known {
                let stages = if s.stages.is_empty() {
                    "none".to_owned()
                } else {
                    s.stages
                        .iter()
                        .map(|x| x.title.as_str())
                        .collect::<Vec<_>>()
                        .join(" · ")
                };
                let reports = if s.reports.is_empty() {
                    "none".to_owned()
                } else {
                    s.reports
                        .iter()
                        .map(|r| {
                            let times = match r.multiplicity {
                                Count::Finite(1) => String::new(),
                                Count::Finite(n) => format!(", at most {n} times"),
                                Count::Unbounded => ", unbounded".to_owned(),
                            };
                            let fields = if r.fields.is_empty() {
                                "none".to_owned()
                            } else {
                                r.fields.join(", ")
                            };
                            format!(
                                "{} (to the role bound to {}; fields {fields}{times})",
                                r.title, r.role
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("; ")
                };
                (stages, reports)
            } else {
                let unknown = "not known: the card is not given the pattern's definition";
                (unknown.to_owned(), unknown.to_owned())
            };
            vec![Cell::plain(name), Cell::plain(stages), Cell::plain(reports)]
        })
        .collect();
    vec![
        Block::P("Sub-programs that apply one of these patterns, the shapes of the envelope, show its stages and make its reports; the pattern's text is the program's, so no lead wrote them:".to_owned()),
        Block::Table {
            head: heads(&["Shape", "Stages", "Reports"]),
            rows,
        },
        Block::Note("A report of a sub-program goes to the role its application binds to the pattern's role slot, and is masked to the class that role may be shown; the class of each field depends on what the application gives the pattern.".to_owned()),
    ]
}

/// The blocks of the card in a document: `cardBlocks(v)`.
#[must_use]
pub fn card_blocks(v: &CardView) -> Vec<Block> {
    let t = &v.touches;
    let a = &v.approves;
    let lib = v.library.as_ref();
    // Without an envelope, the workflow's own budget stands in its place.
    let enveloped = lib.is_none_or(|l| l.envelope);
    // 0.7: the attention view (or why there is none), and a workflow that
    // names its own owner, whose card a member of that role approves.
    let attention = v.attention.as_ref();
    let view = attention.map(|x| &x.view);
    let owned = !enveloped && a.role.is_some();
    let mut out: Vec<Block> = lib.map(CardLibrary::head_blocks).unwrap_or_default();
    out.push(Block::H("What it does".to_owned()));
    out.extend(lib.map(CardLibrary::pattern_blocks).unwrap_or_default());
    // 0.7: what it does is told by its stages, by title, in order.
    match view.map(|x| &x.stages).filter(|s| !s.is_empty()) {
        Some(stages) => out.push(Block::List(
            stages
                .iter()
                .map(|s| Cell::plain(s.title.as_str()))
                .collect(),
        )),
        None => out.push(Block::List(if v.steps.is_empty() {
            vec![Cell::plain("no static steps")]
        } else {
            v.steps.iter().map(Cell::plain).collect()
        })),
    }
    if !v.maps.is_empty() {
        out.push(Block::Table {
            head: heads(&[
                "Map",
                "Over",
                "At most",
                "At a time",
                "Delegates",
                "Each item gets",
            ]),
            rows: v
                .maps
                .iter()
                .map(|m| {
                    vec![
                        Cell::plain(format!("map {}", m.bind)),
                        Cell::plain(m.over.as_str()),
                        Cell::plain(match m.max {
                            None => "no max (the envelope's agents bound it)".to_owned(),
                            Some(max) => grouped(max),
                        }),
                        Cell::plain(number_to_string(m.par)),
                        Cell::plain(list(&m.delegates)),
                        Cell::plain(handed_text(m)),
                    ]
                })
                .collect(),
        });
    }
    out.extend(lib.map(CardLibrary::bound_blocks).unwrap_or_default());
    if !v.plans.is_empty() {
        out.push(Block::P("Each plan's lead writes sub-programs while the run goes on; each one is checked against what is left of the envelope when it is submitted.".to_owned()));
        out.push(Block::Table {
            head: heads(&["Plan lead", "Lead's budget", "From"]),
            rows: v
                .plans
                .iter()
                .map(|p| {
                    vec![
                        Cell::plain(p.lead.as_str()),
                        Cell::plain(p.budget.as_str()),
                        Cell::plain(p.from.as_str()),
                    ]
                })
                .collect(),
        });
    }
    let row = |what: &str, scope: &[String]| vec![Cell::plain(what), Cell::plain(list(scope))];
    out.push(Block::H("What it can touch".to_owned()));
    out.push(Block::Table {
        head: heads(&["What", "Scope"]),
        rows: vec![
            row("Read paths", &t.authority.read),
            row("Write paths", &t.authority.write),
            row("Network hosts", &t.authority.network),
            row("Commands", &t.authority.exec),
            row("Model tiers", &t.authority.model),
            row("Pull requests in", &t.authority.repos),
            row("Money", &t.authority.money),
            row("Unbounded", &t.authority.unbounded),
            vec![
                Cell::plain("Highest data class a delegation receives"),
                Cell::plain(t.max_class.as_str()),
            ],
            vec![
                Cell::plain("Delegations in flight at once"),
                Cell::plain(match t.max_concurrent {
                    None if lib.is_some_and(|l| l.unexpanded) => "not known".to_owned(),
                    None => "no limit".to_owned(),
                    Some(n) => number_to_string(n),
                }),
            ],
        ],
    });
    out.push(Block::List(t.caps.iter().map(Cell::mono).collect()));
    out.extend(lib.map(CardLibrary::tool_blocks).unwrap_or_default());
    out.push(Block::H("The most it spends".to_owned()));
    out.push(Block::Table {
        head: if enveloped {
            heads(&[
                "Dimension",
                "Envelope",
                "Static part (upper bound)",
                "Left for sub-programs",
            ])
        } else {
            heads(&[
                "Dimension",
                "Budget",
                "Static part (upper bound)",
                "Left over",
            ])
        },
        rows: v
            .spends
            .iter()
            .map(|r| {
                vec![
                    Cell::plain(match r.currency.as_deref().filter(|c| !c.is_empty()) {
                        Some(c) => format!("{} ({c})", r.dimension),
                        None => r.dimension.to_owned(),
                    }),
                    Cell::plain(r.text.envelope.as_str()),
                    Cell::plain(r.text.r#static.as_str()),
                    Cell::plain(r.text.left.as_str()),
                ]
            })
            .collect(),
    });
    out.extend(
        lib.map(|l| l.spend_blocks(attention.is_some()))
            .unwrap_or_default(),
    );
    out.push(Block::H("When it asks whom".to_owned()));
    if let Some(view) = view {
        // 0.7: what the attention view says, with the two deadlines of a
        // review exact; the 0.6 sentences would say them twice.
        out.extend(asks_blocks(view, false));
    }
    // What the card of 0.6 says of the waits and the authorizations stays on
    // the card of 0.7: the table of questions counts the sites the facts
    // hold, and does not say where a wait is asked.
    let old_asks = view.is_none();
    if v.waits.is_empty() {
        if old_asks && lib.is_none_or(|l| l.reviews.is_empty()) {
            out.push(Block::P(
                "No step it reaches waits for a person by role.".to_owned(),
            ));
        }
    } else {
        if !old_asks {
            out.push(Block::P(
                "The steps it reaches that wait for a person by role, and where each is:"
                    .to_owned(),
            ));
        }
        out.push(Block::Table {
            head: heads(&["Wait", "Role", "In", "Members"]),
            rows: v
                .waits
                .iter()
                .map(|w| {
                    vec![
                        Cell::plain(w.kind.as_str()),
                        Cell::plain(w.role.as_str()),
                        Cell::plain(w.r#in.as_str()),
                        Cell::plain(members_text(&w.members)),
                    ]
                })
                .collect(),
        });
    }
    if !v.approvals.is_empty() {
        out.push(Block::Table {
            head: heads(&["Effect", "Authorized only by a decision of", "Members"]),
            rows: v
                .approvals
                .iter()
                .map(|p| {
                    vec![
                        Cell::plain(p.effect.as_str()),
                        Cell::plain(p.role.as_str()),
                        Cell::plain(members_text(&p.members)),
                    ]
                })
                .collect(),
        });
    }
    // 0.7: an authorization the envelope declares for an effect that no step
    // of the workflow itself reaches has no row in the table of questions.
    if let Some(view) = view {
        let unlisted: Vec<Cell> = v
            .approvals
            .iter()
            .filter(|p| {
                !view
                    .questions
                    .iter()
                    .any(|r| r.effect.as_deref() == Some(p.effect.as_str()))
            })
            .map(|p| Cell::mono(p.effect.as_str()))
            .collect();
        if !unlisted.is_empty() {
            out.push(Block::Note(UNLISTED_APPROVALS.to_owned()));
            out.push(Block::List(unlisted));
        }
    }
    out.extend(lib.map(|l| l.ask_blocks(old_asks)).unwrap_or_default());
    out.extend(lib.map(CardLibrary::commit_blocks).unwrap_or_default());
    if let Some(att) = attention {
        out.push(Block::H("What it tells whom".to_owned()));
        if let Some(view) = view {
            out.extend(reports_blocks(view, false));
        }
        out.extend(shape_blocks(&att.shapes));
    }
    out.push(Block::H("Who approves it, and who may amend it".to_owned()));
    out.push(Block::P(match &a.role {
        None => a.text.clone(),
        Some(role) => {
            let described = if js_truthy(&a.description) {
                format!(" ({})", a.description.to_js_string())
            } else {
                String::new()
            };
            if owned {
                format!(
                    "The role {role}{described} approves this card before any run. Nobody may amend a workflow without an envelope."
                )
            } else {
                format!(
                    "The role {role}{described} approves the envelope before any run, and every amendment."
                )
            }
        }
    }));
    match (enveloped || owned, a.members.is_empty()) {
        // Said once, above.
        (false, _) => {}
        (true, true) => out.push(Block::Note(a.text.clone())),
        (true, false) => out.push(Block::Table {
            head: heads(&["Member", "Keys"]),
            rows: a
                .members
                .iter()
                .map(|m| {
                    vec![
                        Cell::plain(m.member.as_str()),
                        Cell::plain(m.keys.to_string()),
                    ]
                })
                .collect(),
        }),
    }
    out.extend(
        attention
            .and_then(|x| x.ladder.text.as_ref())
            .map(|text| Block::P(text.clone())),
    );
    out.push(Block::P(if enveloped || owned {
        format!(
            "An approval is signed for package {}: a changed program, lock or imported module is a new package and needs a new approval.",
            v.package
        )
    } else {
        format!(
            "The package is {}: a changed program, lock or imported module is a new package.",
            v.package
        )
    }));
    out
}

/// The card as a document, headed by the package hash an approval binds to.
/// `None` as [`card`] is: `cardDoc(program, workflow, { lock, modules })`.
#[must_use]
pub fn card_doc(
    program: &Value,
    workflow: &str,
    lock: Option<&Value>,
    modules: Option<&Modules>,
) -> Option<Doc> {
    let given = CheckOptions {
        modules,
        ..CheckOptions::default()
    };
    card_doc_given(program, workflow, lock, modules, &given)
        .ok()
        .flatten()
}

/// [`card_doc`], with the options the check of a program of 0.7 is given
/// besides the lock ([`card_given`]).
///
/// # Errors
/// [`CardRefused`], as [`card_given`] gives it.
pub fn card_doc_given(
    program: &Value,
    workflow: &str,
    lock: Option<&Value>,
    modules: Option<&Modules>,
    check_with: &CheckOptions<'_>,
) -> Result<Option<Doc>, CardRefused> {
    let Some(v) = card_given(program, workflow, lock, modules, check_with)? else {
        return Ok(None);
    };
    let imports = modules.is_some_and(|m| !m.is_empty());
    Ok(Some(Doc {
        title: format!("{} {}: {}", v.program.module, v.program.version, v.workflow),
        meta: vec![
            ("Package".to_owned(), v.package.clone()),
            ("Program".to_owned(), v.program.hash.clone()),
            ("Language".to_owned(), v.program.language.clone()),
            (
                "View".to_owned(),
                format!(
                    "{VIEW_FORMAT} card, generated from the program{} and {}",
                    if imports {
                        ", the modules it imports"
                    } else {
                        ""
                    },
                    if lock.is_some_and(Value::is_truthy) {
                        "its lock"
                    } else {
                        "no lock"
                    }
                ),
            ),
        ],
        blocks: card_blocks(&v),
    }))
}
