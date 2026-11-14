//! What every view of a program stands on, from `compiler/src/views/views.ts`
//! (lines 62-155, 170-260, 264-275, 292-416, 475-494, 688 and 716-718): the
//! reference to the program a view shows, the capabilities a list of
//! expressions stands for and what a delegation is granted at run time, the
//! authority a list of capabilities amounts to, the graph of a workflow's
//! steps, and the small texts the views and the semantic diff are written
//! in. The comparing analyses ([`crate::diff`], [`crate::lock_diff`]) and,
//! from another crate, the program views (architecture, authority, cost,
//! system) are built on these, so they are public.
//!
//! Programs are the IR as [`Value`], read through the views of `mandate-ir`.
//! The TypeScript walks the IR with plain property access; where it does so
//! over a value that was not validated, this reads a member that is missing
//! or of another type as nothing, and never panics.
//!
//! JavaScript semantics imitated here: `.sort()` with no comparator is by
//! UTF-16 code units ([`sort_utf16`]); `[...new Set(x)]` keeps the first
//! occurrence ([`unique_in_order`]); `Object.keys`, `Object.values` and
//! `Object.entries` follow the member order of the IR object ([`Map`] keeps
//! it); `${micros / 1_000_000}` is a double divided and written as
//! JavaScript writes it ([`number_to_string`]).
//!
//! `children` of this file is a different function from the `children` of
//! `check/static.ts`: it is named [`view_children`] so that the two cannot
//! be confused or shared.

use mandate_ir::{
    Definition, Expr, ExprOp, JsObject, JsValue, Map, Program, Stmt, StmtOp, Value, canonicalize,
    compare_utf16, hash_program, number_to_string, sort_utf16, unique_in_order, workflow_bounds,
    write_json_string,
};

use crate::caps::{CapOptions, CapVal, callee_path, cap_covers, caps_of, show_cap};
use crate::stdlib::{std_effect, std_fn};

/// `VIEW_FORMAT`: the format tag every view carries.
pub const VIEW_FORMAT: &str = "mandate/view/0.1";

/// The table of definitions of nothing: what `program.defs` is when a
/// program has none.
static NO_DEFS: Map = Map::new();

/// The definitions of `program` (`program.defs`), none when there are none.
#[must_use]
pub fn defs_of(program: Program<'_>) -> &Map {
    program.defs().unwrap_or(&NO_DEFS)
}

/// `String(x)` as a template literal writes a member that may be missing:
/// `undefined` for none, else the text ECMAScript gives the value.
#[must_use]
pub fn js_text(v: Option<&Value>) -> String {
    v.map_or_else(
        || "undefined".to_owned(),
        |v| JsValue::from(v).to_js_string(),
    )
}

/// `j(v)`: the canonical text of a value, which the views compare and show.
#[must_use]
pub fn j(v: &Value) -> String {
    canonicalize(v)
}

/// `j(v ?? null)`.
#[must_use]
pub fn j_or_null(v: Option<&Value>) -> String {
    v.map_or_else(|| "null".to_owned(), canonicalize)
}

/// `JSON.stringify(s)` of a string.
#[must_use]
pub fn json_string(s: &str) -> String {
    let mut out = String::new();
    write_json_string(&mut out, s);
    out
}

/// `isSystem(kind)`: a definition of the system model (a component, an
/// interface or an environment).
#[must_use]
pub fn is_system(kind: &str) -> bool {
    matches!(kind, "component" | "interface" | "environment")
}

/// The `kind` of a definition as text (`d.kind` in a template).
#[must_use]
pub fn kind_text(def: &Value) -> String {
    js_text(def.get("kind"))
}

// ── the program a view shows ─────────────────────────────────────────────

/// `ProgramRef`: the program a view shows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramRef {
    /// `module`.
    pub module: String,
    /// `version`.
    pub version: String,
    /// `language`.
    pub language: String,
    /// The program hash.
    pub hash: String,
}

impl ProgramRef {
    /// `{ module, version, language, hash }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("module", self.module.as_str())
            .with("version", self.version.as_str())
            .with("language", self.language.as_str())
            .with("hash", self.hash.as_str())
            .into()
    }
}

/// `programRef(p)`.
#[must_use]
pub fn program_ref(program: &Value) -> ProgramRef {
    let text = |key: &str| {
        program
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    ProgramRef {
        module: text("module"),
        version: text("version"),
        language: text("language"),
        hash: hash_program(program).program,
    }
}

// ── capabilities ─────────────────────────────────────────────────────────

/// The capabilities a list of capability expressions stands for (component
/// capabilities may stand for several): `capsIn(program, list)`.
#[must_use]
pub fn caps_in(program: Program<'_>, list: &[Value]) -> Vec<CapVal> {
    let opts = CapOptions {
        language: program.language(),
    };
    list.iter()
        .filter_map(Expr::of)
        .flat_map(|e| caps_of(defs_of(program), e, opts))
        .collect()
}

/// `c.narrow(v)` whose scope is a value of the run: where it lies is known
/// only then. `chosenAtRunTime(e)`.
#[must_use]
pub fn chosen_at_run_time(e: Expr<'_>) -> bool {
    e.is(ExprOp::Call)
        && e.callee()
            .is_some_and(|c| c.is(ExprOp::Field) && c.name() == Some("narrow"))
        && e.args()
            .any(|a| !a.value().is_some_and(|v| v.is(ExprOp::Text)))
}

/// What a list of `with caps` stands for in a view of the program. A
/// narrowing whose scope the run chooses is shown as the capability it
/// narrows: the scope must lie inside that one (`outside_capability`), so it
/// is the most the narrowing can be. `widest(program, list)`.
#[must_use]
pub fn widest(program: Program<'_>, list: &[Value]) -> Vec<CapVal> {
    let opts = CapOptions {
        language: program.language(),
    };
    list.iter()
        .filter_map(Expr::of)
        .flat_map(|e| {
            let target = if chosen_at_run_time(e) {
                e.callee().and_then(Expr::operand).unwrap_or(e)
            } else {
                e
            };
            caps_of(defs_of(program), target, opts)
        })
        .collect()
}

/// What a map hands the delegations of its body: its `with caps`, and what a
/// map around it hands of other kinds. `handedBy(program, outer, map)`.
#[must_use]
pub fn handed_by(program: Program<'_>, outer: &[CapVal], map: Expr<'_>) -> Vec<CapVal> {
    let given = widest(program, map.caps().unwrap_or_default());
    let mut out: Vec<CapVal> = outer
        .iter()
        .filter(|c| !given.iter().any(|g| g.ctor() == c.ctor()))
        .cloned()
        .collect();
    out.extend(given);
    out
}

/// What a delegation is granted at run time: the agent's capabilities inside
/// the workflow's, `with caps` replacing its kinds (C2). `handed` is what a
/// map around the delegation hands it: one of those replaces a kind too,
/// where the agent holds it at least as widely and the delegation names none
/// (spec/envelope.md "map"). `grantOf(program, wf, agent, withCaps, handed)`.
#[must_use]
pub fn grant_of(
    program: Program<'_>,
    wf: &Value,
    agent: &Value,
    with_caps: &[Value],
    handed: &[CapVal],
) -> Vec<CapVal> {
    let avail = caps_in(program, workflow_bounds(wf).caps);
    let held = caps_in(program, Definition::of(agent).caps());
    let mut out: Vec<CapVal> = held
        .iter()
        .filter(|c| avail.iter().any(|a| cap_covers(a, c)))
        .cloned()
        .collect();
    let mut given = widest(program, with_caps);
    let own: Vec<String> = given.iter().map(|g| g.ctor().to_owned()).collect();
    let remote = agent.get("remote").is_some_and(Value::is_truthy);
    for k in handed {
        if !own.iter().any(|c| c == k.ctor()) && (remote || held.iter().any(|a| cap_covers(a, k))) {
            given.push(k.clone());
        }
    }
    if !given.is_empty() {
        let mut kept: Vec<CapVal> = out
            .into_iter()
            .filter(|c| !given.iter().any(|g| g.ctor() == c.ctor()))
            .collect();
        kept.extend(given);
        out = kept;
    }
    out
}

/// What the capabilities a holder has amount to, by kind, each list sorted
/// and without duplicates: `Authority`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Authority {
    /// Paths it may read.
    pub read: Vec<String>,
    /// Paths it may write.
    pub write: Vec<String>,
    /// Hosts it may reach.
    pub network: Vec<String>,
    /// Model tiers it may ask.
    pub model: Vec<String>,
    /// Commands it may run.
    pub exec: Vec<String>,
    /// Repositories it may open pull requests in.
    pub repos: Vec<String>,
    /// Money it may spend.
    pub money: Vec<String>,
    /// Capabilities whose scope is not statically known.
    pub unbounded: Vec<String>,
}

impl Authority {
    /// The members in the order the TypeScript object has them (`read`,
    /// `write`, `network`, `model`, `exec`, `repos`, `money`, `unbounded`),
    /// to be spread into a row: `{ who, ...authorityOf(caps) }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let list =
            |xs: &[String]| JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect());
        JsObject::new()
            .with("read", list(&self.read))
            .with("write", list(&self.write))
            .with("network", list(&self.network))
            .with("model", list(&self.model))
            .with("exec", list(&self.exec))
            .with("repos", list(&self.repos))
            .with("money", list(&self.money))
            .with("unbounded", list(&self.unbounded))
    }
}

/// `authorityOf(caps)`.
#[must_use]
pub fn authority_of(caps: &[CapVal]) -> Authority {
    let mut a = Authority::default();
    for c in caps {
        let scope: &[String] = c.scope().unwrap_or_default();
        if c.scope().is_none()
            && ["fs.read", "fs.write", "net.https", "exec", "git.pr"].contains(&c.ctor())
        {
            a.unbounded.push(show_cap(c));
        }
        match c.ctor() {
            "fs.read" => a.read.extend(scope.iter().cloned()),
            "fs.write" => a.write.extend(scope.iter().cloned()),
            // A host a 0.5 capability allows only some methods of is shown with them.
            "net.https" => a.network.extend(scope.iter().map(|h| match c.methods() {
                Some(methods) => format!("{h} ({})", methods.join(", ")),
                None => h.clone(),
            })),
            "model.infer" => a.model.push(format!(
                "{} (up to {})",
                c.tier().unwrap_or("any tier"),
                c.max_class().map_or("internal", |m| m.as_str())
            )),
            "exec" => a.exec.extend(scope.iter().map(|cmd| {
                match c.args_prefix() {
                    Some(prefixes) if !prefixes.is_empty() => prefixes
                        .iter()
                        .map(|p| {
                            let mut words = vec![cmd.as_str()];
                            words.extend(p.iter().map(String::as_str));
                            words.join(" ")
                        })
                        .collect::<Vec<_>>()
                        .join("; "),
                    _ => format!("{cmd} …"),
                }
            })),
            "git.pr" => a.repos.extend(scope.iter().cloned()),
            "money.spend" => a.money.push(show_cap(c)),
            _ => {}
        }
    }
    for list in [
        &mut a.read,
        &mut a.write,
        &mut a.network,
        &mut a.model,
        &mut a.exec,
        &mut a.repos,
        &mut a.money,
        &mut a.unbounded,
    ] {
        let mut sorted = unique_in_order(list.iter().cloned());
        sort_utf16(&mut sorted);
        *list = sorted;
    }
    a
}

// ── shared walks ─────────────────────────────────────────────────────────

/// The direct sub-expressions of an expression, in the order the views walk
/// them: `children(e)` of `views.ts` lines 170-215. It is not the
/// `children` of `check/static.ts`, which reads other members.
#[must_use]
pub fn view_children(e: Expr<'_>) -> Vec<Expr<'_>> {
    fn args<'a>(e: Expr<'a>, out: &mut Vec<Expr<'a>>) {
        out.extend(e.args().filter_map(|a| a.value()));
    }
    let mut out: Vec<Expr<'_>> = Vec::new();
    match e.op() {
        Some(ExprOp::List | ExprOp::Set) => out.extend(e.items()),
        Some(ExprOp::Template | ExprOp::Prompt) => out.extend(
            e.parts()
                .iter()
                .filter_map(|p| p.get("expr").and_then(Expr::of)),
        ),
        Some(ExprOp::Field | ExprOp::Unary | ExprOp::Try | ExprOp::Await) => {
            out.extend(e.operand());
        }
        Some(ExprOp::Call) => {
            out.extend(e.callee());
            args(e, &mut out);
        }
        Some(ExprOp::Binary) => {
            out.extend(e.left());
            out.extend(e.right());
        }
        Some(ExprOp::Range) => {
            out.extend(e.from());
            out.extend(e.to());
        }
        Some(ExprOp::Record) => out.extend(e.fields().filter_map(|(_, v)| Expr::of(v))),
        Some(ExprOp::Infer) => {
            out.extend(e.from());
            out.extend(e.using());
        }
        Some(ExprOp::Delegate | ExprOp::Plan | ExprOp::Effect) => args(e, &mut out),
        Some(ExprOp::Map) => out.extend(e.over()),
        Some(ExprOp::Verify) => {
            out.extend(e.value_expr());
            args(e, &mut out);
        }
        Some(ExprOp::Changeset) => {
            out.extend(e.plan());
            for (_, m) in e.changeset_members() {
                out.extend(
                    m.arg_values()
                        .iter()
                        .filter_map(|a| a.get("value").and_then(Expr::of)),
                );
            }
        }
        Some(ExprOp::Escalate) => out.extend(e.to()),
        Some(ExprOp::Pause) => out.extend(e.then()),
        Some(ExprOp::Switch) => {
            out.extend(e.on());
            out.extend(e.cases().filter_map(|c| c.then()));
        }
        _ => {}
    }
    out
}

/// What an effect is: `{ critical, irreversible }`. `effectInfo`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EffectInfo {
    /// A critical effect: policy or a person authorizes it.
    pub critical: bool,
    /// An effect that cannot be undone.
    pub irreversible: bool,
}

/// `effectInfo(program, name)`: the program's own effect of that name, else
/// the standard library's.
#[must_use]
pub fn effect_info(program: Program<'_>, name: &str) -> EffectInfo {
    if let Some(d) = defs_of(program)
        .get(name)
        .filter(|d| d.get("kind").and_then(Value::as_str) == Some("effect"))
    {
        let irreversible = d.get("irreversible").is_some_and(Value::is_truthy);
        return EffectInfo {
            critical: d.get("critical").is_some_and(Value::is_truthy) || irreversible,
            irreversible,
        };
    }
    let s = std_effect(name);
    EffectInfo {
        critical: s.is_some_and(|s| s.critical),
        irreversible: s.is_some_and(|s| s.irreversible),
    }
}

/// `duration(ms)`: `1h`, `20m`, `5s` or `1500ms`.
#[must_use]
pub fn duration(ms: i64) -> String {
    // `ms % unit === 0` and `ms / unit`, with a unit that is never zero.
    let whole = |unit: i64| {
        (ms.checked_rem(unit) == Some(0)).then(|| ms.checked_div(unit).unwrap_or_default())
    };
    if let Some(h) = whole(3_600_000) {
        format!("{h}h")
    } else if let Some(m) = whole(60_000) {
        format!("{m}m")
    } else if let Some(s) = whole(1000) {
        format!("{s}s")
    } else {
        format!("{ms}ms")
    }
}

/// `${micros / 1_000_000}`: a double divided, and written as JavaScript
/// writes a number.
#[must_use]
pub fn micros_text(micros: i64) -> String {
    number_to_string(micros as f64 / 1_000_000.0)
}

/// One-line grant for graph nodes: `shortCaps(caps)`.
#[must_use]
pub fn short_caps(caps: &[CapVal]) -> String {
    let a = authority_of(caps);
    let mut parts: Vec<String> = Vec::new();
    parts.extend(a.read.iter().map(|p| format!("read {p}")));
    parts.extend(a.write.iter().map(|p| format!("write {p}")));
    parts.extend(a.network.iter().map(|h| format!("net {h}")));
    parts.extend(a.exec.iter().map(|x| format!("run {x}")));
    parts.extend(a.model.iter().map(|m| format!("model {m}")));
    parts.extend(a.repos.iter().map(|r| format!("PR {r}")));
    parts.join(" · ")
}

/// A delegation's supervision as text, `restart(max: 2)`: `supervision(e)`.
#[must_use]
pub fn supervision(e: Expr<'_>) -> Option<String> {
    let s = e.supervise()?;
    let args: Vec<String> = s
        .args()
        .iter()
        .filter_map(mandate_ir::Arg::of)
        .map(|a| {
            let label = match a.name() {
                Some(n) if !n.is_empty() => format!("{n}: "),
                _ => String::new(),
            };
            let v = a.value();
            let shown = match v.and_then(|v| v.op()) {
                Some(ExprOp::Int) => js_text(v.and_then(|v| v.value())),
                Some(ExprOp::Duration) => v
                    .and_then(|v| v.get("ms"))
                    .and_then(Value::as_i64)
                    .map_or_else(|| "undefined".to_owned(), duration),
                Some(ExprOp::Var) => js_text(v.and_then(|v| v.get("name"))),
                Some(ExprOp::Text) => json_string(v.and_then(|v| v.text()).unwrap_or_default()),
                _ => "…".to_owned(),
            };
            format!("{label}{shown}")
        })
        .collect();
    Some(format!(
        "{}({})",
        js_text(s.members().get("name")),
        args.join(", ")
    ))
}

// ── the graph of a workflow ──────────────────────────────────────────────

/// What a step of a workflow is: `ArchNode["kind"]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArchKind {
    /// A delegation.
    Delegate,
    /// A verification.
    Verify,
    /// An external effect.
    Effect,
    /// A change set.
    Changeset,
    /// A person.
    Human,
    /// A model call.
    Infer,
    /// A read.
    Read,
    /// A map.
    Map,
}

impl ArchKind {
    /// Its name in the view.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ArchKind::Delegate => "delegate",
            ArchKind::Verify => "verify",
            ArchKind::Effect => "effect",
            ArchKind::Changeset => "changeset",
            ArchKind::Human => "human",
            ArchKind::Infer => "infer",
            ArchKind::Read => "read",
            ArchKind::Map => "map",
        }
    }
}

/// One step of a workflow in its graph: `ArchNode`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchNode {
    /// `n1`, `n2`, … in the order the steps were added.
    pub id: String,
    /// What it is.
    pub kind: ArchKind,
    /// Its name.
    pub label: String,
    /// What else a person reads of it.
    pub detail: Vec<String>,
}

impl ArchNode {
    /// `{ id, kind, label, detail }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("id", self.id.as_str())
            .with("kind", self.kind.as_str())
            .with("label", self.label.as_str())
            .with(
                "detail",
                JsValue::Array(
                    self.detail
                        .iter()
                        .map(|d| JsValue::from(d.as_str()))
                        .collect(),
                ),
            )
            .into()
    }
}

/// What follows what: `ArchEdge`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArchEdge {
    /// The id of the step before.
    pub from: String,
    /// The id of the step after.
    pub to: String,
    /// Why, when it says more than "after".
    pub label: Option<String>,
}

impl ArchEdge {
    /// `{ from, to, label? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("from", self.from.as_str())
            .with("to", self.to.as_str())
            .with_some("label", self.label.as_deref())
            .into()
    }
}

/// A workflow as a graph of its steps: `class Graph`. Build one with
/// [`Graph::new`], walk the body with [`Graph::block`] (starting from no
/// step before), and read [`Graph::nodes`] and [`Graph::edges`].
#[derive(Clone, Debug)]
pub struct Graph<'a> {
    /// The steps, in the order they were found.
    pub nodes: Vec<ArchNode>,
    /// What follows what.
    pub edges: Vec<ArchEdge>,
    program: Program<'a>,
    wf: &'a Value,
    /// Inside a map's body: what the map hands each delegation.
    handed: Vec<CapVal>,
}

impl<'a> Graph<'a> {
    /// A graph of the workflow `wf` of `program`, with no steps.
    #[must_use]
    pub fn new(program: Program<'a>, wf: &'a Value) -> Graph<'a> {
        Graph {
            nodes: Vec::new(),
            edges: Vec::new(),
            program,
            wf,
            handed: Vec::new(),
        }
    }

    fn add(
        &mut self,
        kind: ArchKind,
        label: String,
        detail: Vec<String>,
        from: &[String],
    ) -> String {
        let id = format!("n{}", self.nodes.len().saturating_add(1));
        self.nodes.push(ArchNode {
            id: id.clone(),
            kind,
            label,
            detail,
        });
        for f in from {
            self.edges.push(ArchEdge {
                from: f.clone(),
                to: id.clone(),
                label: None,
            });
        }
        id
    }

    /// The statements of a block, one after the other, starting from the
    /// steps `prev`; the steps the block ends with.
    pub fn block(&mut self, stmts: &'a [Value], prev: Vec<String>) -> Vec<String> {
        let mut prev = prev;
        for s in stmts {
            prev = self.stmt(s, prev);
        }
        prev
    }

    fn stmt(&mut self, s: &'a Value, prev: Vec<String>) -> Vec<String> {
        let Some(s) = Stmt::of(s) else { return prev };
        match s.op() {
            Some(StmtOp::Let | StmtOp::Expr) => match s.value() {
                Some(v) => self.expr(v, prev),
                None => prev,
            },
            Some(StmtOp::Return) => match s.value() {
                Some(v) => self.expr(v, prev),
                None => prev,
            },
            Some(StmtOp::Par) => {
                let mut branches: Vec<(&'a str, &'a Value)> = s.branches().collect();
                branches.sort_by(|a, b| compare_utf16(a.0, b.0));
                let mut ends: Vec<String> = Vec::new();
                for (_, v) in branches {
                    if let Some(e) = Expr::of(v) {
                        ends.extend(self.expr(e, prev.clone()));
                    }
                }
                if ends.is_empty() { prev } else { ends }
            }
            Some(StmtOp::If) => {
                let c = match s.cond() {
                    Some(cond) => self.expr(cond, prev),
                    None => prev,
                };
                let then = self.block(s.then_block(), c.clone());
                let otherwise = self.block(s.else_block().unwrap_or_default(), c);
                unique_in_order(then.into_iter().chain(otherwise))
            }
            Some(StmtOp::Loop) => self.block(s.body(), prev),
            _ => prev,
        }
    }

    fn expr(&mut self, e: Expr<'a>, prev: Vec<String>) -> Vec<String> {
        let mut prev = prev;
        for c in view_children(e) {
            prev = self.expr(c, prev);
        }
        match e.op() {
            Some(ExprOp::Delegate) => {
                let agent = e.agent().and_then(|a| defs_of(self.program).get(a));
                let grant = match agent.filter(|a| is_kind(a, "agent")) {
                    Some(agent) => grant_of(
                        self.program,
                        self.wf,
                        agent,
                        e.caps().unwrap_or_default(),
                        &self.handed,
                    ),
                    None => Vec::new(),
                };
                let timeout = e
                    .timeout()
                    .filter(|t| t.is(ExprOp::Duration))
                    .and_then(|t| t.get("ms"))
                    .and_then(Value::as_i64)
                    .map(|ms| format!("timeout {}", duration(ms)));
                let detail: Vec<String> = [
                    Some(short_caps(&grant)),
                    e.get("isolated")
                        .is_some_and(Value::is_truthy)
                        .then(|| "isolated".to_owned()),
                    supervision(e),
                    timeout,
                ]
                .into_iter()
                .flatten()
                .filter(|d| !d.is_empty())
                .collect();
                let label = format!("{}.{}", js_text(e.get("agent")), js_text(e.get("skill")));
                vec![self.add(ArchKind::Delegate, label, detail, &prev)]
            }
            Some(ExprOp::Map) => {
                // One node for the map, then its body once: each item runs the same steps (spec/envelope.md "map").
                let mut bound: Vec<String> = Vec::new();
                if let Some(max) = e.get("max") {
                    bound.push(format!("at most {} items", js_text(Some(max))));
                }
                bound.push(format!(
                    "{} at a time",
                    e.get("par")
                        .filter(|p| !matches!(p, Value::Null))
                        .map_or_else(|| "1".to_owned(), |p| js_text(Some(p)))
                ));
                if e.caps().is_some_and(|c| !c.is_empty()) {
                    bound.push("with caps".to_owned());
                }
                if let Some(name) = e.supervise().and_then(|s| s.members().get("name")) {
                    let name = js_text(Some(name));
                    if !name.is_empty() {
                        bound.push(name);
                    }
                }
                let outer = self.handed.clone();
                self.handed = handed_by(self.program, &outer, e);
                let label = format!("map {}", js_text(e.get("bind")));
                let node = self.add(ArchKind::Map, label, bound, &prev);
                let ends = self.block(e.body(), vec![node]);
                self.handed = outer;
                ends
            }
            Some(ExprOp::Plan) => {
                let lead = e.agent().and_then(|a| defs_of(self.program).get(a));
                let grant = match lead.filter(|a| is_kind(a, "agent")) {
                    Some(lead) => grant_of(self.program, self.wf, lead, &[], &[]),
                    None => Vec::new(),
                };
                let detail: Vec<String> = [
                    short_caps(&grant),
                    "submits sub-programs within the envelope".to_owned(),
                ]
                .into_iter()
                .filter(|d| !d.is_empty())
                .collect();
                let label = format!(
                    "plan {}.{}",
                    js_text(e.get("agent")),
                    js_text(e.get("skill"))
                );
                vec![self.add(ArchKind::Delegate, label, detail, &prev)]
            }
            Some(ExprOp::Verify) => {
                let contract = e.contract().unwrap_or_default();
                let label = format!("verify {}", js_text(e.get("contract")));
                let v = self.add(
                    ArchKind::Verify,
                    label,
                    criteria(self.program, contract),
                    &prev,
                );
                if let Some(then) = e.on_unmet().and_then(|u| u.then()) {
                    self.expr(then, vec![v.clone()]);
                }
                // An escalation on unmet criteria waits for a person; the next steps follow the met path (§15.1).
                let unmet: Vec<String> = self
                    .nodes
                    .iter()
                    .filter(|n| {
                        n.kind == ArchKind::Human
                            && self.edges.iter().any(|x| x.from == v && x.to == n.id)
                    })
                    .map(|n| n.id.clone())
                    .collect();
                for x in &mut self.edges {
                    if x.from == v && unmet.contains(&x.to) {
                        x.label = Some("open criteria".to_owned());
                    }
                }
                vec![v]
            }
            Some(ExprOp::Effect) => {
                let name = e.get("name");
                let info = effect_info(
                    self.program,
                    name.and_then(Value::as_str).unwrap_or_default(),
                );
                let mut detail: Vec<String> = Vec::new();
                if info.irreversible {
                    detail.push("irreversible".to_owned());
                } else if info.critical {
                    detail.push("critical".to_owned());
                }
                if e.get("idempotent_by").is_some_and(Value::is_truthy) {
                    detail.push("idempotent".to_owned());
                }
                if let Some(c) = e.get("compensate").filter(|c| c.is_truthy()) {
                    detail.push(format!("compensation offered: {}", js_text(Some(c))));
                }
                vec![self.add(ArchKind::Effect, js_text(name), detail, &prev)]
            }
            Some(ExprOp::Changeset) => {
                // Who approves what, and in which order the members land (doc 9 §3).
                let members = e.changeset_members().collect::<Vec<_>>();
                let member = |m: &str| members.iter().find(|(n, _)| *n == m).map(|(_, v)| *v);
                let owner = |m: &str| -> String {
                    match member(m).and_then(|v| v.members().get("approver")) {
                        Some(a) => js_text(Some(a)),
                        None => match defs_of(self.program)
                            .get(m)
                            .filter(|c| is_kind(c, "component"))
                        {
                            Some(c) => js_text(c.get("owner")),
                            None => "owner".to_owned(),
                        },
                    }
                };
                let order: Vec<&str> = e
                    .get("order")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(Value::as_str)
                    .collect();
                let mut detail: Vec<String> = Vec::new();
                for (i, m) in order.iter().enumerate() {
                    let effect = member(m)
                        .and_then(|v| v.members().get("effect"))
                        .map_or_else(|| "?".to_owned(), |v| js_text(Some(v)));
                    detail.push(format!(
                        "{}. {m}: {effect} (approved by {})",
                        i.saturating_add(1),
                        owner(m)
                    ));
                }
                for (i, k) in e.changes() {
                    detail.push(format!("{i}: {}", js_text(Some(k))));
                }
                detail.push(format!(
                    "the set approved by {}",
                    js_text(e.get("approver"))
                ));
                let label = format!("change set {}", order.join(" → "));
                vec![self.add(ArchKind::Changeset, label, detail, &prev)]
            }
            Some(ExprOp::Infer) => {
                let target = match e.get("type").and_then(|t| t.get("ref")) {
                    Some(r) => js_text(Some(r)),
                    None => "value".to_owned(),
                };
                vec![self.add(
                    ArchKind::Infer,
                    format!("infer {target}"),
                    Vec::new(),
                    &prev,
                )]
            }
            Some(ExprOp::Escalate) => {
                vec![self.add(
                    ArchKind::Human,
                    "person: escalation".to_owned(),
                    Vec::new(),
                    &prev,
                )]
            }
            Some(ExprOp::Pause) => {
                vec![self.add(
                    ArchKind::Human,
                    "person: pause".to_owned(),
                    Vec::new(),
                    &prev,
                )]
            }
            Some(ExprOp::Call) => {
                let p = e.callee().and_then(callee_path);
                match p {
                    Some(p) if p == "human.ask" => {
                        vec![self.add(
                            ArchKind::Human,
                            "person: question".to_owned(),
                            Vec::new(),
                            &prev,
                        )]
                    }
                    Some(p) if std_fn(&p).is_some() && p != "human.approve" => {
                        vec![self.add(ArchKind::Read, p, Vec::new(), &prev)]
                    }
                    _ => prev,
                }
            }
            _ => prev,
        }
    }
}

/// Whether the definition `d` has `kind`: `d?.kind === kind`.
fn is_kind(d: &Value, kind: &str) -> bool {
    d.get("kind").and_then(Value::as_str) == Some(kind)
}

/// The criteria of a contract, one `name: method` line each: `criteria`.
#[must_use]
pub fn criteria(program: Program<'_>, contract: &str) -> Vec<String> {
    let Some(c) = defs_of(program)
        .get(contract)
        .filter(|c| is_kind(c, "contract"))
    else {
        return Vec::new();
    };
    let d = Definition::of(c);
    d.accept()
        .chain(d.invariant())
        .map(|(n, k)| format!("{n}: {}", method_of(k.get("by"))))
        .collect()
}

/// How a verifier checks, as text: `methodOf(v)`. `all` verifiers are
/// joined with " and ".
#[must_use]
pub fn method_of(v: Option<&Value>) -> String {
    let Some(v) = v else { return "call".to_owned() };
    if let Some(all) = v.get("all") {
        return all
            .as_array()
            .unwrap_or_default()
            .iter()
            .map(|x| method_of(Some(x)))
            .collect::<Vec<_>>()
            .join(" and ");
    }
    if v.get("static").is_some() {
        return "static".to_owned();
    }
    match v.get("call").and_then(Expr::of) {
        Some(call) if call.is(ExprOp::Call) => call
            .callee()
            .and_then(callee_path)
            .unwrap_or_else(|| "call".to_owned()),
        _ => "call".to_owned(),
    }
}

/// The external effects a workflow body commits, and how each is authorized
/// by default, sorted: `workflowEffects(program, body)`. The body is walked
/// as plain data, every object in the order of its members.
#[must_use]
pub fn workflow_effects(program: Program<'_>, body: &[Value]) -> Vec<String> {
    fn visit(program: Program<'_>, v: &Value, out: &mut Vec<String>) {
        match v {
            Value::Array(items) => {
                for x in items {
                    visit(program, x, out);
                }
            }
            Value::Object(map) => {
                let op = map.get("op").and_then(Value::as_str);
                if op == Some("effect")
                    && let Some(name) = map.get("name").and_then(Value::as_str)
                {
                    let info = effect_info(program, name);
                    let how = if info.irreversible {
                        "irreversible; a person authorizes"
                    } else if info.critical {
                        "critical; policy authorizes"
                    } else {
                        "not critical"
                    };
                    out.push(format!("{name} ({how})"));
                }
                if op == Some("changeset")
                    && let Some(cs) = Expr::of(v)
                {
                    for (m, mem) in cs.changeset_members() {
                        out.push(format!(
                            "{} on {m} (change set: its owner and {} authorize)",
                            js_text(mem.members().get("effect")),
                            js_text(cs.get("approver"))
                        ));
                    }
                }
                for (_, x) in map.iter() {
                    visit(program, x, out);
                }
            }
            _ => {}
        }
    }
    let mut out: Vec<String> = Vec::new();
    for s in body {
        visit(program, s, &mut out);
    }
    let mut out = unique_in_order(out);
    sort_utf16(&mut out);
    out
}
