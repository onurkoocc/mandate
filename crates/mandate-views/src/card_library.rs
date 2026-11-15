//! What the card of a program of 0.6 says besides what the card of 0.5 says
//! (spec/library.md "Views"): the pattern a workflow applies and the library
//! it comes from, the `///` doc lines of the workflow, its contracts and its
//! pattern, the most items of each map and the proof that they fit the
//! budget, each review as one decision of its role with its escalation, the
//! criteria that may be waived and the roles that may waive them, the
//! connector tools by what they are, and each batch commit step. Only the
//! Rust compiler reads 0.6, so none of this has a TypeScript to match; it is
//! a part of the card only when the program is of 0.6, and a card of 0.1 to
//! 0.5 is what it was.
//!
//! The card reads the expansion of a workflow that applies a pattern
//! ([`mandate_check::expand::for_views`]), so everything here is about the
//! workflow as it runs. When the pattern cannot be expanded (its module is
//! not given), the expansion is the stand-in of `for_views`, which keeps what
//! its arguments name and says it is `unexpanded`: the card then lists what
//! is not known ([`CardLibrary::unknown`]) and shows no number that depends
//! on it, so that it never shows less authority than the expansion.

use mandate_check::{
    CapVal, Modules, StaticCost, callee_path, caps_in, defs_of, duration, is_kind, js_text,
    micros_text, own,
};
use mandate_ir::{
    Application, ConnectorDef, Criterion, Definition, Expr, ExprOp, JsObject, JsValue, Map,
    Program, Value, number_to_string, sort_utf16, unique_in_order, workflow_bounds,
};

use crate::card::{expr_text, limit_of, members_of};
use crate::cost::{BudgetFrom, delegate_budget};
use crate::doc::{Block, Cell};
use crate::shown::{num, texts};

// ── the model ────────────────────────────────────────────────────────────

/// A role, and the members the lock binds to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardRole {
    /// The role.
    pub role: String,
    /// Its members.
    pub members: Vec<String>,
}

impl CardRole {
    fn of(role: &str, lock: Option<&Value>) -> CardRole {
        CardRole {
            role: role.to_owned(),
            members: members_of(lock, role),
        }
    }

    fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("role", self.role.as_str())
            .with("members", texts(&self.members))
            .into()
    }

    /// `accountant (ana)`, or `accountant (nobody bound)`.
    fn text(&self) -> String {
        if self.members.is_empty() {
            format!("{} (nobody bound)", self.role)
        } else {
            format!("{} ({})", self.role, self.members.join(", "))
        }
    }
}

/// The pattern a workflow applies, and where it comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardPattern {
    /// The pattern.
    pub name: String,
    /// The module that defines it; `None` when the program does.
    pub module: Option<String>,
    /// The library the module belongs to, when the lock pins it or it is
    /// built in.
    pub library: Option<String>,
    /// The library's version.
    pub version: Option<String>,
    /// The library's digest.
    pub digest: Option<String>,
    /// How the library is known: `lock`, `built in`, or `none`.
    pub pinned: &'static str,
    /// The pattern's doc lines.
    pub doc: Option<String>,
    /// The line the card shows, `BatchWithExceptions (std.patterns 1.0.0)`.
    pub text: String,
}

impl CardPattern {
    fn to_js(&self) -> JsValue {
        let opt = |x: &Option<String>| x.as_deref().map_or(JsValue::Null, JsValue::from);
        JsObject::new()
            .with("name", self.name.as_str())
            .with("module", opt(&self.module))
            .with("library", opt(&self.library))
            .with("version", opt(&self.version))
            .with("digest", opt(&self.digest))
            .with("pinned", self.pinned)
            .with("doc", opt(&self.doc))
            .with("text", self.text.as_str())
            .into()
    }
}

/// One criterion of a contract the workflow verifies against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardCriterion {
    /// Its name.
    pub name: String,
    /// What it says.
    pub description: String,
    /// The roles that may waive it, with their members; none when nobody
    /// may.
    pub waive_by: Vec<CardRole>,
}

/// A contract the workflow verifies against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardContract {
    /// Its name.
    pub name: String,
    /// Its doc lines.
    pub doc: Option<String>,
    /// Its criteria.
    pub criteria: Vec<CardCriterion>,
}

impl CardContract {
    fn to_js(&self) -> JsValue {
        let criteria = self
            .criteria
            .iter()
            .map(|c| {
                JsObject::new()
                    .with("name", c.name.as_str())
                    .with("description", c.description.as_str())
                    .with(
                        "waive_by",
                        JsValue::Array(c.waive_by.iter().map(CardRole::to_js).collect()),
                    )
                    .into()
            })
            .collect();
        JsObject::new()
            .with("name", self.name.as_str())
            .with(
                "doc",
                self.doc.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("criteria", JsValue::Array(criteria))
            .into()
    }
}

/// A `human.review`: one decision of a role about a list.
#[derive(Clone, Debug, PartialEq)]
pub struct CardReview {
    /// The map whose outcomes it asks about.
    pub over: String,
    /// The role asked.
    pub role: CardRole,
    /// The role asked after the deadline; `None` when the review is not
    /// escalated.
    pub escalate_to: Option<CardRole>,
    /// The deadline in milliseconds; `NaN` when it is not a constant.
    pub deadline_ms: f64,
    /// The deadline as the program writes it, `1d`.
    pub deadline: String,
    /// The most items it asks about, when the map has a `max`.
    pub at_most: Option<f64>,
    /// The longest the wait lasts: the deadline, twice with an escalation.
    pub longest: String,
    /// The sentence the card shows.
    pub text: String,
}

impl CardReview {
    fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("over", self.over.as_str())
            .with("role", self.role.to_js())
            .with(
                "escalate_to",
                self.escalate_to
                    .as_ref()
                    .map_or(JsValue::Null, CardRole::to_js),
            )
            .with("deadline_ms", self.deadline_ms)
            .with("deadline", self.deadline.as_str())
            .with("at_most", self.at_most.map_or(JsValue::Null, JsValue::from))
            .with("longest", self.longest.as_str())
            .with("text", self.text.as_str())
            .into()
    }
}

/// A connector tool the workflow or an agent holds the authority to call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CardTool {
    /// The connector, `<module>.<name>` when its module is known.
    pub connector: String,
    /// The tool.
    pub tool: String,
    /// The data class of what the connector returns; `None` when the
    /// connector is not known to the card.
    pub class: Option<String>,
    /// `read_only`, `write`, or `unknown` when the connector is not known.
    pub kind: &'static str,
    /// For a write tool, its retry class.
    pub retry_class: Option<String>,
    /// Who holds it: `workflow W` and `agent A`.
    pub held_by: Vec<String>,
}

impl CardTool {
    /// What the tool is, as a person reads it.
    #[must_use]
    pub fn what(&self) -> String {
        match self.kind {
            "read_only" => "read-only".to_owned(),
            "write" => match &self.retry_class {
                Some(r) => format!("write, critical, retry {r}"),
                None => "write, critical".to_owned(),
            },
            _ => "class not known".to_owned(),
        }
    }

    fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("connector", self.connector.as_str())
            .with("tool", self.tool.as_str())
            .with(
                "class",
                self.class.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("kind", self.kind)
            .with(
                "retry_class",
                self.retry_class
                    .as_deref()
                    .map_or(JsValue::Null, JsValue::from),
            )
            .with("held_by", texts(&self.held_by))
            .into()
    }
}

/// A batch commit step: an effect of a write tool in the body of a map.
#[derive(Clone, Debug, PartialEq)]
pub struct CardCommit {
    /// The effect, `erp.post_draft_invoice`.
    pub effect: String,
    /// What it commits, `accepted` or the list the map runs over.
    pub over: String,
    /// The most items.
    pub at_most: Option<f64>,
    /// The key, as `idempotent_by` reads it.
    pub key: String,
    /// The tool's retry class.
    pub retry_class: Option<String>,
    /// The sentence the card shows.
    pub text: String,
}

impl CardCommit {
    fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("effect", self.effect.as_str())
            .with("over", self.over.as_str())
            .with("at_most", self.at_most.map_or(JsValue::Null, JsValue::from))
            .with("key", self.key.as_str())
            .with(
                "retry_class",
                self.retry_class
                    .as_deref()
                    .map_or(JsValue::Null, JsValue::from),
            )
            .with("text", self.text.as_str())
            .into()
    }
}

/// The most a map spends, against the workflow's budget.
#[derive(Clone, Debug, PartialEq)]
pub struct CardBound {
    /// The map.
    pub map: String,
    /// Its most items.
    pub at_most: f64,
    /// What one item may spend, `0.30 USD`.
    pub per_item: String,
    /// What all of them may, `18 USD`.
    pub total: String,
    /// The workflow's spend limit in that currency; `None` for no limit.
    pub limit: Option<String>,
    /// Whether the map's total, and the workflow's, fit the limit; `None`
    /// without a limit.
    pub fits: Option<bool>,
    /// The line the card shows, `60 × 0.30 USD = 18 USD ≤ 20 USD`.
    pub text: String,
}

impl CardBound {
    fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("map", self.map.as_str())
            .with("at_most", self.at_most)
            .with("per_item", self.per_item.as_str())
            .with("total", self.total.as_str())
            .with(
                "limit",
                self.limit.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("fits", self.fits.map_or(JsValue::Null, JsValue::from))
            .with("text", self.text.as_str())
            .into()
    }
}

/// The part of the card a program of 0.6 adds: [`CardView::library`].
///
/// [`CardView::library`]: crate::card::CardView
#[derive(Clone, Debug, PartialEq)]
pub struct CardLibrary {
    /// Whether the workflow has an envelope; when it has none, its `caps`
    /// and `budget` stand in for the envelope's.
    pub envelope: bool,
    /// The workflow's doc lines.
    pub doc: Option<String>,
    /// Whether the workflow applies a pattern the card could not expand with
    /// the modules it is given: what it shows is the stand-in's, and what
    /// depends on the expansion is not known.
    pub unexpanded: bool,
    /// The pattern it applies.
    pub pattern: Option<CardPattern>,
    /// The contracts it verifies against.
    pub contracts: Vec<CardContract>,
    /// Its reviews.
    pub reviews: Vec<CardReview>,
    /// The connector tools it and its agents may call.
    pub tools: Vec<CardTool>,
    /// Its batch commit steps.
    pub commits: Vec<CardCommit>,
    /// What its maps spend against its budget.
    pub bounds: Vec<CardBound>,
    /// What the card cannot say, and why.
    pub unknown: Vec<String>,
}

impl CardLibrary {
    /// Whether the card of a program of 0.6 says anything a card of 0.5 does
    /// not. A workflow with an envelope that has nothing of 0.6 is shown as
    /// it was.
    #[must_use]
    pub fn has_content(&self) -> bool {
        self.doc.is_some()
            || self.unexpanded
            || self.pattern.is_some()
            || !self.contracts.is_empty()
            || !self.reviews.is_empty()
            || !self.tools.is_empty()
            || !self.commits.is_empty()
            || !self.bounds.is_empty()
            || !self.unknown.is_empty()
    }

    /// `{ envelope, doc, pattern, contracts, reviews, tools, commits,
    /// bounds, unknown }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("envelope", self.envelope)
            .with(
                "doc",
                self.doc.as_deref().map_or(JsValue::Null, JsValue::from),
            )
            .with("unexpanded", self.unexpanded)
            .with(
                "pattern",
                self.pattern
                    .as_ref()
                    .map_or(JsValue::Null, CardPattern::to_js),
            )
            .with(
                "contracts",
                JsValue::Array(self.contracts.iter().map(CardContract::to_js).collect()),
            )
            .with(
                "reviews",
                JsValue::Array(self.reviews.iter().map(CardReview::to_js).collect()),
            )
            .with(
                "tools",
                JsValue::Array(self.tools.iter().map(CardTool::to_js).collect()),
            )
            .with(
                "commits",
                JsValue::Array(self.commits.iter().map(CardCommit::to_js).collect()),
            )
            .with(
                "bounds",
                JsValue::Array(self.bounds.iter().map(CardBound::to_js).collect()),
            )
            .with("unknown", texts(&self.unknown))
            .into()
    }
}

// ── connector tools ──────────────────────────────────────────────────────

/// A tool a `tool.call` capability names, with what the connector says of
/// it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ToolFact {
    /// `<module>.<connector>`.
    pub connector: String,
    /// The tool.
    pub tool: String,
    /// The data class of the connector.
    pub class: Option<String>,
    /// `read_only`, `write` or `unknown`.
    pub kind: &'static str,
    /// A write tool's retry class.
    pub retry_class: Option<String>,
}

impl ToolFact {
    /// `erp.post_draft_invoice (write, critical, retry reconcilable)`.
    pub(crate) fn describe(&self) -> String {
        let short = self.connector.rsplit('.').next().unwrap_or(&self.connector);
        let tool = CardTool {
            connector: self.connector.clone(),
            tool: self.tool.clone(),
            class: self.class.clone(),
            kind: self.kind,
            retry_class: self.retry_class.clone(),
            held_by: Vec::new(),
        };
        format!("{short}.{} ({})", self.tool, tool.what())
    }
}

/// The tools the `tool.call` capabilities among `caps` name, read from the
/// connectors of `program` (which a view links).
pub(crate) fn tool_facts(program: Program<'_>, caps: &[CapVal]) -> Vec<ToolFact> {
    let defs = defs_of(program);
    let mut out: Vec<ToolFact> = Vec::new();
    for c in caps.iter().filter(|c| c.ctor() == "tool.call") {
        for item in c.scope().unwrap_or_default() {
            // `<module>.<connector>.<tool>`.
            let Some((connector, tool)) = item.rsplit_once('.') else {
                continue;
            };
            let name = connector.rsplit('.').next().unwrap_or(connector);
            let t = defs
                .get(name)
                .and_then(ConnectorDef::of)
                .and_then(|d| d.tool(tool));
            out.push(ToolFact {
                connector: connector.to_owned(),
                tool: tool.to_owned(),
                class: c.max_class_name().map(str::to_owned),
                kind: match t {
                    Some(t) if t.is_write() => "write",
                    Some(_) => "read_only",
                    None if c.write() => "write",
                    None => "read_only",
                },
                retry_class: t
                    .filter(|t| t.is_write())
                    .and_then(|t| t.retry_class().map(str::to_owned)),
            });
        }
    }
    out
}

/// The tools a list of capability expressions names when the connector is
/// not a definition the card can see: read as the program writes them,
/// `tool.call(erp, post_draft_invoice)`, with what is not known unknown.
fn written_tool_calls(program: Program<'_>, e: &Value, depth: u8, out: &mut Vec<ToolFact>) {
    let defs = defs_of(program);
    let Some(e) = Expr::of(e) else { return };
    if e.is(ExprOp::Var) {
        let named = e
            .name()
            .and_then(|n| defs.get(n))
            .filter(|d| is_kind(d, "capability"))
            .and_then(|d| d.get("value"));
        if let (Some(inner), Some(deeper)) = (named, depth.checked_add(1).filter(|d| *d < 8)) {
            written_tool_calls(program, inner, deeper, out);
        }
        return;
    }
    if !e.is(ExprOp::Call) || e.callee().and_then(callee_path).as_deref() != Some("tool.call") {
        return;
    }
    let mut names = e
        .args()
        .filter(|a| a.name().is_none())
        .filter_map(|a| a.value())
        .filter(|v| v.is(ExprOp::Var))
        .filter_map(Expr::name);
    let Some(connector) = names.next() else {
        return;
    };
    out.extend(names.map(|tool| ToolFact {
        connector: connector.to_owned(),
        tool: tool.to_owned(),
        class: None,
        kind: "unknown",
        retry_class: None,
    }));
}

/// The tools a list of capability expressions names, wherever they can be
/// read.
pub(crate) fn tool_facts_of(program: Program<'_>, list: &[Value]) -> Vec<ToolFact> {
    let mut out: Vec<ToolFact> = Vec::new();
    for item in list {
        let caps = caps_in(program, std::slice::from_ref(item));
        let mut found = tool_facts(program, &caps);
        if found.is_empty() {
            written_tool_calls(program, item, 0, &mut found);
        }
        out.extend(found);
    }
    out
}

// ── what the body holds ──────────────────────────────────────────────────

/// What one walk of an expanded body meets.
#[derive(Default)]
struct Found<'a> {
    /// The calls of `human.review`.
    reviews: Vec<Expr<'a>>,
    /// Each effect, with the maps around it, the innermost last.
    effects: Vec<(Vec<Expr<'a>>, Expr<'a>)>,
    /// The maps a `let` binds, by the name.
    lets: Vec<(&'a str, Expr<'a>)>,
    /// Every map.
    maps: Vec<Expr<'a>>,
    /// The contracts it verifies against.
    contracts: Vec<String>,
    /// The agents it delegates to.
    agents: Vec<String>,
}

impl<'a> Found<'a> {
    fn walk(&mut self, v: &'a Value, around: &mut Vec<Expr<'a>>) {
        match v {
            Value::Array(items) => items.iter().for_each(|x| self.walk(x, around)),
            Value::Object(m) => {
                if m.get("op").and_then(Value::as_str) == Some("let")
                    && let (Some(name), Some(value)) = (
                        m.get("name").and_then(Value::as_str),
                        m.get("value").and_then(Expr::of),
                    )
                    && value.is(ExprOp::Map)
                {
                    self.lets.push((name, value));
                }
                let e = Expr::of(v);
                if let Some(e) = e {
                    match e.op() {
                        Some(ExprOp::Call) if is_review(e) => self.reviews.push(e),
                        Some(ExprOp::Effect) => self.effects.push((around.clone(), e)),
                        Some(ExprOp::Verify) => {
                            if let Some(c) = e.contract() {
                                self.contracts.push(c.to_owned());
                            }
                        }
                        Some(ExprOp::Delegate) => {
                            if let Some(a) = e.agent() {
                                self.agents.push(a.to_owned());
                            }
                        }
                        Some(ExprOp::Map) => self.maps.push(e),
                        _ => {}
                    }
                }
                let is_map = e.filter(|e| e.is(ExprOp::Map));
                for (k, x) in m.iter() {
                    match is_map.filter(|_| k == "body") {
                        Some(map) => {
                            around.push(map);
                            self.walk(x, around);
                            around.pop();
                        }
                        None => self.walk(x, around),
                    }
                }
            }
            _ => {}
        }
    }
}

/// `human.review(…)`.
fn is_review(e: Expr<'_>) -> bool {
    e.callee().and_then(callee_path).as_deref() == Some("human.review")
}

/// The role a review names: a name, or text.
fn role_name(e: Option<Expr<'_>>) -> String {
    match e {
        Some(e) if e.is(ExprOp::Var) => js_text(e.get("name")),
        Some(e) if e.is(ExprOp::Text) => js_text(e.get("value")),
        other => expr_text(other),
    }
}

/// A deadline as the program writes it: `1d`, `20m`.
fn deadline_text(ms: f64) -> String {
    let day = 86_400_000.0;
    if ms.is_finite() && ms > 0.0 && ms % day == 0.0 {
        return format!("{}d", number_to_string(ms / day));
    }
    if ms.is_finite() && ms.fract() == 0.0 && ms.abs() < 9e15 {
        return duration(ms as i64);
    }
    "a deadline the program does not fix".to_owned()
}

/// The argument of a call by its name.
fn named_arg<'a>(e: Expr<'a>, name: &str) -> Option<Expr<'a>> {
    e.args()
        .find(|a| a.name() == Some(name))
        .and_then(|a| a.value())
}

/// A review, as the card tells it.
fn review_of(e: Expr<'_>, lets: &[(&str, Expr<'_>)], lock: Option<&Value>) -> Option<CardReview> {
    let over = e
        .args()
        .find(|a| a.name().is_none())
        .and_then(|a| a.value())
        .map(|v| expr_text(Some(v)))
        .unwrap_or_default();
    let role = CardRole::of(&role_name(named_arg(e, "role")), lock);
    let escalate_to = named_arg(e, "escalate_to").map(|r| CardRole::of(&role_name(Some(r)), lock));
    let deadline_ms = named_arg(e, "deadline")
        .and_then(|d| d.get("ms"))
        .map_or(f64::NAN, |ms| num(Some(ms)));
    let deadline = deadline_text(deadline_ms);
    let at_most = lets
        .iter()
        .find(|(n, _)| *n == over)
        .and_then(|(_, m)| limit_of(m.get("max")));
    let longest = deadline_text(deadline_ms * if escalate_to.is_some() { 2.0 } else { 1.0 });
    // The stand-in of a pattern the card cannot expand asks a role, and no
    // more: its deadline and its escalation are the pattern's.
    if !deadline_ms.is_finite() {
        let text = format!(
            "May ask {} for one batch decision about a list of items. Its deadline, its escalation and what happens when it passes are the pattern's, which is not known here.",
            role.text()
        );
        return Some(CardReview {
            over,
            role,
            escalate_to,
            deadline_ms,
            deadline,
            at_most,
            longest: "not known".to_owned(),
            text,
        });
    }
    let items = match at_most {
        Some(n) => format!(
            " about at most {} items (those that failed only a criterion it may waive)",
            number_to_string(n)
        ),
        None => " about the items that failed only a criterion it may waive".to_owned(),
    };
    let after = match &escalate_to {
        Some(r) => format!(
            "if the deadline ({deadline}) passes, to {}; if that passes too, every open item is declined",
            r.text()
        ),
        None => format!("if the deadline ({deadline}) passes, every open item is declined"),
    };
    let text = format!(
        "At most one batch decision to {}{items}; {after}. Nobody is asked about a single item, and nothing passes on its own.",
        role.text()
    );
    Some(CardReview {
        over,
        role,
        escalate_to,
        deadline_ms,
        deadline,
        at_most,
        longest,
        text,
    })
}

/// A key as the card says it: the field of the item, or the expression.
fn key_text(key: Option<Expr<'_>>, item: Option<&str>) -> String {
    match key {
        Some(k)
            if k.is(ExprOp::Field)
                && item.is_some()
                && k.operand()
                    .is_some_and(|o| o.is(ExprOp::Var) && o.name() == item) =>
        {
            js_text(k.get("name"))
        }
        other => expr_text(other),
    }
}

/// A commit step: an effect of a write tool in the body of a map.
fn commit_of(around: &[Expr<'_>], effect: Expr<'_>, lp: Program<'_>) -> Option<CardCommit> {
    let name = effect.name()?;
    let (connector, tool) = name.split_once('.')?;
    let t = defs_of(lp)
        .get(connector)
        .and_then(ConnectorDef::of)
        .and_then(|c| c.tool(tool))
        .filter(|t| t.is_write())?;
    let map = around.last()?;
    let item = map.bind();
    let over_expr = map.over();
    // `reviewed.accepted`, where `reviewed` is a review's result: what a
    // person accepted.
    let accepted = over_expr.is_some_and(|o| o.is(ExprOp::Field) && o.name() == Some("accepted"));
    let over = if accepted {
        "accepted".to_owned()
    } else {
        expr_text(over_expr)
    };
    let at_most = limit_of(map.get("max"));
    let key = key_text(effect.idempotent_by(), item);
    let retry_class = t.retry_class().map(str::to_owned);
    let what = if accepted {
        "Each accepted item".to_owned()
    } else {
        format!("Each item of {over}")
    };
    let class = match &retry_class {
        Some(r) => format!("a critical write tool, retry class {r}"),
        None => "a critical write tool".to_owned(),
    };
    let text = format!(
        "{what} is posted as its own action by {name} ({class}), authorized by policy, idempotent by {key}. Nobody is asked about one item."
    );
    Some(CardCommit {
        effect: name.to_owned(),
        over,
        at_most,
        key,
        retry_class,
        text,
    })
}

// ── doc lines, contracts, the pattern ────────────────────────────────────

/// A doc as one paragraph: its lines joined by a space.
fn doc_of(d: Option<&Value>) -> Option<String> {
    let text = d?.get("doc")?.as_str()?;
    let flat = text.split('\n').collect::<Vec<_>>().join(" ");
    (!flat.trim().is_empty()).then_some(flat)
}

fn contract_of(name: &str, d: &Value, lock: Option<&Value>) -> CardContract {
    let criteria = Definition::of(d)
        .accept()
        .map(|(n, c)| {
            let c = Criterion::of(c);
            let mut roles: Vec<String> = c
                .map(|c| {
                    c.waive()
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            sort_utf16(&mut roles);
            CardCriterion {
                name: n.to_owned(),
                description: c
                    .and_then(Criterion::description)
                    .unwrap_or_default()
                    .to_owned(),
                waive_by: unique_in_order(roles)
                    .iter()
                    .map(|r| CardRole::of(r, lock))
                    .collect(),
            }
        })
        .collect();
    CardContract {
        name: name.to_owned(),
        doc: doc_of(Some(d)),
        criteria,
    }
}

/// The library a module belongs to: the one the lock pins with it, else
/// the built-in `std.patterns`.
fn library_of(module: &str, lock: Option<&Value>) -> Pin {
    if let Some(Value::Object(libs)) = lock.and_then(|l| l.get("libraries")) {
        for (lib, pin) in libs.iter() {
            if own(pin.get("modules"), module).is_some() {
                let text = |k: &str| pin.get(k).and_then(Value::as_str).map(str::to_owned);
                return Pin {
                    library: Some(lib.to_owned()),
                    version: text("version"),
                    digest: text("digest"),
                    pinned: "lock",
                };
            }
        }
    }
    if module == mandate_check::library::STD_PATTERNS
        && let Some(built_in) = mandate_check::library::std_patterns()
    {
        return Pin {
            library: Some(built_in.name().to_owned()),
            version: Some(built_in.manifest.version().to_string()),
            digest: Some(built_in.digest.to_string()),
            pinned: "built in",
        };
    }
    Pin {
        library: None,
        version: None,
        digest: None,
        pinned: "none",
    }
}

/// A library as the lock or the compiler knows it.
struct Pin {
    library: Option<String>,
    version: Option<String>,
    digest: Option<String>,
    pinned: &'static str,
}

fn pattern_of(
    orig: Program<'_>,
    orig_wf: &Value,
    lock: Option<&Value>,
    modules: Option<&Modules>,
) -> Option<CardPattern> {
    let a = Application::of_workflow(orig_wf)?;
    let name = a.pattern()?;
    let module = if orig.defs().is_some_and(|d| d.contains_key(name)) {
        None
    } else {
        orig.imports()
            .find(|u| u.module().is_some_and(|m| m != "std") && u.names().any(|n| n == name))
            .and_then(|u| u.module())
            .map(str::to_owned)
    };
    let with_builtin = mandate_check::library::with_builtin(orig, modules);
    let all = with_builtin.as_ref().or(modules);
    let home_defs: Option<&Map> = match &module {
        None => orig.defs(),
        Some(m) => all
            .and_then(|ms| ms.get(m))
            .and_then(Program::of)
            .and_then(Program::defs),
    };
    let doc = doc_of(home_defs.and_then(|d| d.get(name)));
    let Pin {
        library,
        version,
        digest,
        pinned,
    } = match &module {
        Some(m) => library_of(m, lock),
        None => Pin {
            library: None,
            version: None,
            digest: None,
            pinned: "none",
        },
    };
    let text = match (&module, &library, &version) {
        (None, _, _) => format!("{name} (defined in this program)"),
        (Some(_), Some(l), Some(v)) => format!("{name} ({l} {v})"),
        (Some(m), _, _) => format!("{name} (module {m}; no lock pins its version)"),
    };
    Some(CardPattern {
        name: name.to_owned(),
        module,
        library,
        version,
        digest,
        pinned,
        doc,
        text,
    })
}

// ── what the maps spend ──────────────────────────────────────────────────

/// A sum of money as the card says it: the units, and at least two digits of
/// the fraction when there is one (`0.30 USD`, `18 USD`).
pub(crate) fn money_text(micros: f64, currency: &str) -> String {
    let text = micros_text(micros, currency);
    match text.split_once(' ') {
        Some((n, c)) => match n.split_once('.') {
            Some((whole, frac)) if frac.len() == 1 => format!("{whole}.{frac}0 {c}"),
            _ => text,
        },
        None => text,
    }
}

/// The delegations in a map's body, not those of a map inside it.
fn delegations_in<'a>(v: &'a Value, out: &mut Vec<Expr<'a>>) {
    match v {
        Value::Array(items) => items.iter().for_each(|x| delegations_in(x, out)),
        Value::Object(m) => {
            if let Some(e) = Expr::of(v) {
                if e.is(ExprOp::Map) {
                    return;
                }
                if e.is(ExprOp::Delegate) {
                    out.push(e);
                }
            }
            m.iter().for_each(|(_, x)| delegations_in(x, out));
        }
        _ => {}
    }
}

fn bounds_of(maps: &[Expr<'_>], lp: Program<'_>, wf: &Value, sc: &StaticCost) -> Vec<CardBound> {
    let limit = workflow_bounds(wf)
        .budget
        .and_then(|b| b.get("spend"))
        .filter(|s| s.is_truthy());
    let mut out = Vec::new();
    for map in maps {
        let Some(at_most) = limit_of(map.get("max")) else {
            continue;
        };
        let mut delegates = Vec::new();
        for s in map.body() {
            delegations_in(s, &mut delegates);
        }
        // What one item may spend, in the one currency the delegations are
        // budgeted in.
        let mut currency: Option<String> = None;
        let mut per_item = 0.0_f64;
        let mut counted = !delegates.is_empty();
        for d in &delegates {
            let b = delegate_budget(lp, *d, None);
            let spend = b
                .budget
                .and_then(|b| b.get("spend"))
                .filter(|s| s.is_truthy());
            let Some(spend) = spend.filter(|_| b.from != BudgetFrom::None) else {
                counted = false;
                break;
            };
            let c = js_text(spend.get("currency"));
            if currency.as_deref().is_some_and(|have| have != c) {
                counted = false;
                break;
            }
            currency = Some(c);
            per_item += num(spend.get("micros"));
        }
        let (true, Some(currency)) = (counted, currency) else {
            continue;
        };
        let total = at_most * per_item;
        let whole = sc.spend_in(&currency).unwrap_or(total);
        let limit_micros = limit
            .filter(|s| js_text(s.get("currency")) == currency)
            .map(|s| num(s.get("micros")));
        let per = money_text(per_item, &currency);
        let total_text = money_text(total, &currency);
        let fits = limit_micros.map(|l| total <= l && whole <= l);
        let same = (whole - total).abs() < 0.5;
        let against = match (limit_micros, fits) {
            (Some(l), Some(true)) => format!(" ≤ {}", money_text(l, &currency)),
            (Some(l), _) => format!(
                " > {}: more than the budget allows",
                money_text(l, &currency)
            ),
            (None, _) => " (the workflow has no spend limit in this currency)".to_owned(),
        };
        let text = if same {
            format!(
                "{} × {per} = {total_text}{against}",
                number_to_string(at_most)
            )
        } else {
            format!(
                "{} × {per} = {total_text} for map {}; the whole workflow at most {}{against}",
                number_to_string(at_most),
                js_text(map.get("bind")),
                money_text(whole, &currency)
            )
        };
        out.push(CardBound {
            map: js_text(map.get("bind")),
            at_most,
            per_item: per,
            total: total_text,
            limit: limit_micros.map(|l| money_text(l, &currency)),
            fits,
            text,
        });
    }
    out
}

// ── the whole ────────────────────────────────────────────────────────────

/// What [`gather`] reads.
pub(crate) struct Gather<'a> {
    /// The program as written.
    pub program: Program<'a>,
    /// The workflow as written (it carries `apply` and `doc`).
    pub orig_wf: &'a Value,
    /// The program the views read, linked with its modules.
    pub lp: Program<'a>,
    /// The workflow as it runs: its expansion.
    pub wf: &'a Value,
    /// The workflow's name.
    pub workflow: &'a str,
    /// Whether it has an envelope.
    pub envelope: bool,
    /// The lock.
    pub lock: Option<&'a Value>,
    /// The modules.
    pub modules: Option<&'a Modules>,
    /// The static cost of the expansion.
    pub sc: &'a StaticCost,
}

/// The 0.6 part of the card of a workflow.
pub(crate) fn gather(g: &Gather<'_>) -> CardLibrary {
    let mut found = Found::default();
    let mut around: Vec<Expr<'_>> = Vec::new();
    for s in Definition::of(g.wf).body() {
        found.walk(s, &mut around);
    }
    let defs = defs_of(g.lp);
    let unexpanded = g.wf.get("unexpanded").filter(|u| u.is_truthy());
    let pattern = pattern_of(g.program, g.orig_wf, g.lock, g.modules);

    // The contracts it verifies against: those its body verifies, and those
    // an application names (the stand-in has no body to verify in).
    let mut names = found.contracts.clone();
    if let Some(a) = Application::of_workflow(g.orig_wf) {
        for arg in a.args() {
            if let Some(v) = arg
                .value()
                .filter(|v| v.is(ExprOp::Var))
                .and_then(Expr::name)
                && defs.get(v).is_some_and(|d| is_kind(d, "contract"))
            {
                names.push(v.to_owned());
            }
        }
    }
    // The card says which criteria a person may waive; a contract none of
    // whose criteria may be is not its business.
    let contracts: Vec<CardContract> = unique_in_order(names)
        .iter()
        .filter_map(|n| defs.get(n).map(|d| contract_of(n, d, g.lock)))
        .filter(|c| c.criteria.iter().any(|k| !k.waive_by.is_empty()))
        .collect();

    let reviews: Vec<CardReview> = found
        .reviews
        .iter()
        .filter_map(|r| review_of(*r, &found.lets, g.lock))
        .collect();
    let commits: Vec<CardCommit> = found
        .effects
        .iter()
        .filter_map(|(around, e)| commit_of(around, *e, g.lp))
        .collect();

    // The tools, by who holds them: the workflow, and the agents it
    // delegates to (or, in the stand-in, the agents its arguments name).
    let mut agents = found.agents.clone();
    agents.sort();
    let agents = unique_in_order(agents);
    let mut holders: Vec<(String, &[Value])> = vec![(
        format!("workflow {}", g.workflow),
        workflow_bounds(g.wf).caps,
    )];
    for a in &agents {
        if let Some(d) = defs.get(a).filter(|d| is_kind(d, "agent")) {
            holders.push((format!("agent {a}"), Definition::of(d).caps()));
        }
    }
    let mut tools: Vec<CardTool> = Vec::new();
    for (holder, list) in &holders {
        for f in tool_facts_of(g.lp, list) {
            match tools
                .iter_mut()
                .find(|t| t.connector == f.connector && t.tool == f.tool)
            {
                Some(t) => {
                    if !t.held_by.contains(holder) {
                        t.held_by.push(holder.clone());
                    }
                }
                None => tools.push(CardTool {
                    connector: f.connector,
                    tool: f.tool,
                    class: f.class,
                    kind: f.kind,
                    retry_class: f.retry_class,
                    held_by: vec![holder.clone()],
                }),
            }
        }
    }
    tools.sort_by(|a, b| {
        mandate_ir::compare_utf16(&a.connector, &b.connector)
            .then_with(|| mandate_ir::compare_utf16(&a.tool, &b.tool))
    });

    let mut unknown: Vec<String> = Vec::new();
    let bounds = if unexpanded.is_some() {
        let pattern_name = unexpanded.map_or_else(String::new, |u| js_text(u.get("pattern")));
        let from = unexpanded
            .and_then(|u| u.get("module"))
            .and_then(Value::as_str)
            .map(|m| format!(" of module {m}"))
            .unwrap_or_default();
        unknown.push(format!(
            "{pattern_name}{from} could not be expanded with the modules this card is given, so what the workflow does is not fully known: how many items each map runs, what that costs, when a review is escalated and what is committed are not shown. The agents, tools and reviews its arguments name are."
        ));
        Vec::new()
    } else {
        bounds_of(&found.maps, g.lp, g.wf, g.sc)
    };
    if tools.iter().any(|t| t.kind == "unknown") {
        unknown.push(
            "A connector a tool belongs to is not given to this card, so whether its tools read or write, and the class of what they return, are not known; each is shown as the capability names it."
                .to_owned(),
        );
    }

    CardLibrary {
        envelope: g.envelope,
        doc: doc_of(Some(g.orig_wf)),
        unexpanded: unexpanded.is_some(),
        pattern,
        contracts,
        reviews,
        tools,
        commits,
        bounds,
        unknown,
    }
}

// ── blocks ───────────────────────────────────────────────────────────────

impl CardLibrary {
    /// The workflow's doc lines, under the title.
    pub(crate) fn head_blocks(&self) -> Vec<Block> {
        self.doc.iter().map(|d| Block::P(d.clone())).collect()
    }

    /// The pattern, the library it comes from, its doc lines, and what the
    /// card does not know.
    pub(crate) fn pattern_blocks(&self) -> Vec<Block> {
        let mut out = Vec::new();
        if let Some(p) = &self.pattern {
            out.push(Block::P(format!("Applies the pattern {}.", p.text)));
            if let (Some(l), Some(d)) = (&p.library, &p.digest) {
                let how = if p.pinned == "lock" {
                    "pinned by the lock"
                } else {
                    "built into the compiler"
                };
                out.push(Block::P(format!("The library {l} has digest {d}, {how}.")));
            }
            if let Some(doc) = &p.doc {
                out.push(Block::P(doc.clone()));
            }
        }
        out.extend(self.unknown.iter().map(|u| Block::Note(u.clone())));
        out
    }

    /// What the maps may spend against the workflow's budget.
    pub(crate) fn bound_blocks(&self) -> Vec<Block> {
        self.bounds
            .iter()
            .map(|b| Block::P(format!("Spend bound of map {}: {}.", b.map, b.text)))
            .collect()
    }

    /// The connector tools, by connector, read and write apart.
    pub(crate) fn tool_blocks(&self) -> Vec<Block> {
        if self.tools.is_empty() {
            return Vec::new();
        }
        let connectors = unique_in_order(self.tools.iter().map(|t| t.connector.as_str()));
        let cell = |connector: &str, kind: &str| -> String {
            let items: Vec<String> = self
                .tools
                .iter()
                .filter(|t| t.connector == connector && t.kind == kind)
                .map(|t| {
                    let class = match (&t.retry_class, kind) {
                        (Some(r), "write") => format!("critical, retry {r}; "),
                        (None, "write") => "critical; ".to_owned(),
                        _ => String::new(),
                    };
                    format!("{} ({class}held by {})", t.tool, t.held_by.join(", "))
                })
                .collect();
            if items.is_empty() {
                "—".to_owned()
            } else {
                items.join("; ")
            }
        };
        let any_unknown = self.tools.iter().any(|t| t.kind == "unknown");
        let mut head = vec![
            "Connector".to_owned(),
            "Data class".to_owned(),
            "Reads (read-only)".to_owned(),
            "Writes".to_owned(),
        ];
        if any_unknown {
            head.push("Not known".to_owned());
        }
        let rows = connectors
            .iter()
            .map(|c| {
                let class = self
                    .tools
                    .iter()
                    .find(|t| t.connector == *c)
                    .and_then(|t| t.class.clone())
                    .unwrap_or_else(|| "not known".to_owned());
                let mut row = vec![
                    Cell::plain(*c),
                    Cell::plain(class),
                    Cell::plain(cell(c, "read_only")),
                    Cell::plain(cell(c, "write")),
                ];
                if any_unknown {
                    row.push(Cell::plain(cell(c, "unknown")));
                }
                row
            })
            .collect();
        vec![
            Block::P("Connector tools the workflow and its agents may call:".to_owned()),
            Block::Table { head, rows },
        ]
    }

    /// How long a review waits, apart from the time budget.
    pub(crate) fn spend_blocks(&self) -> Vec<Block> {
        self.reviews
            .iter()
            .filter(|r| r.deadline_ms.is_finite())
            .map(|r| {
                let then = match &r.escalate_to {
                    Some(e) => format!(
                        " ({}, then {} more after it is escalated to {})",
                        r.deadline, r.deadline, e.role
                    ),
                    None => String::new(),
                };
                Block::Note(format!(
                    "The review of {} waits apart from the time budget, for at most {}{then}.",
                    r.over, r.longest
                ))
            })
            .collect()
    }

    /// Each review as one decision, and the criteria a person may waive.
    pub(crate) fn ask_blocks(&self) -> Vec<Block> {
        let mut out: Vec<Block> = self
            .reviews
            .iter()
            .map(|r| Block::P(r.text.clone()))
            .collect();
        for c in &self.contracts {
            if let Some(doc) = &c.doc {
                out.push(Block::P(format!("Contract {}: {doc}", c.name)));
            }
        }
        let rows: Vec<Vec<Cell>> = self
            .contracts
            .iter()
            .flat_map(|c| {
                c.criteria.iter().map(move |k| {
                    let who = if k.waive_by.is_empty() {
                        "nobody: an item that fails it is declined without asking".to_owned()
                    } else {
                        k.waive_by
                            .iter()
                            .map(CardRole::text)
                            .collect::<Vec<_>>()
                            .join(", ")
                    };
                    vec![
                        Cell::plain(c.name.as_str()),
                        Cell::plain(k.name.as_str()),
                        Cell::plain(k.description.as_str()),
                        Cell::plain(who),
                    ]
                })
            })
            .collect();
        if !rows.is_empty() {
            out.push(Block::Table {
                head: ["Contract", "Criterion", "It says", "May be waived by"]
                    .map(str::to_owned)
                    .to_vec(),
                rows,
            });
        }
        if self
            .contracts
            .iter()
            .any(|c| c.criteria.iter().any(|k| !k.waive_by.is_empty()))
        {
            out.push(Block::Note(
                "A waived criterion is not a criterion that passed: the audit keeps the failed record and the waiver apart, as two methods.".to_owned(),
            ));
        }
        out
    }

    /// Each batch commit step.
    pub(crate) fn commit_blocks(&self) -> Vec<Block> {
        if self.commits.is_empty() {
            return Vec::new();
        }
        let mut out = vec![Block::H("What it commits".to_owned())];
        out.extend(self.commits.iter().map(|c| Block::P(c.text.clone())));
        out
    }
}
