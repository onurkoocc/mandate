//! The authority view: per agent, workflow and delegation, the paths, hosts,
//! model tiers, commands and repositories it may use, the money it may
//! spend and the external effects it commits (`compiler/src/views/views.ts`,
//! lines 96-99 and 459-473, 496-538 and `authorityBlocks`, lines
//! 1528-1538).
//!
//! The rows of delegations and plans come from a generic walk of the body
//! over the IR as plain data: every object in the order of its members
//! (`Object.values(v)`, which puts index-like names first), not through a
//! typed view that would read them in another order.

use mandate_check::{
    Authority, CapVal, Modules, ProgramRef, VIEW_FORMAT, authority_of, caps_in, chosen_at_run_time,
    defs_of, grant_of, handed_by, is_kind, linked_program, program_ref, widest, workflow_effects,
};
use mandate_ir::{
    Definition, Expr, ExprOp, JsObject, JsValue, Language, Program, Value, sort_utf16,
    unique_in_order, workflow_bounds,
};

use crate::card_library::{ToolFact, tool_facts, tool_facts_of};
use crate::doc::{Block, Cell};
use crate::shown::{list, sorted_defs, texts};

/// One row of the authority view: `AuthorityRow`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorityRow {
    /// Who: an agent, a workflow or a delegation.
    pub who: String,
    /// `agent`, `workflow` or `delegation`.
    pub kind: &'static str,
    /// For a workflow: the external effects its body commits, and how each
    /// is authorized by default.
    pub effects: Vec<String>,
    /// What the capabilities amount to.
    pub authority: Authority,
    /// 0.6: the connector tools its `tool.call` capabilities name, each as
    /// the connector declares it (`erp.list_open_orders (read-only)`,
    /// `erp.post_draft_invoice (write, critical, retry reconcilable)`); empty
    /// in a program of 0.1 to 0.5, which has none, and then not written.
    pub tools: Vec<String>,
}

impl AuthorityRow {
    /// `{ who, kind, effects, ...authority }`: the effects come before the
    /// members of the authority; in 0.6, `tools` comes last when the row has
    /// any.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let row = JsObject::new()
            .with("who", self.who.as_str())
            .with("kind", self.kind)
            .with("effects", texts(&self.effects))
            .spread(&self.authority.to_js());
        if self.tools.is_empty() {
            row.into()
        } else {
            row.with("tools", texts(&self.tools)).into()
        }
    }
}

/// Tools as a row shows them, sorted.
fn described(facts: Vec<ToolFact>) -> Vec<String> {
    let mut tools: Vec<String> = facts.iter().map(ToolFact::describe).collect();
    sort_utf16(&mut tools);
    unique_in_order(tools)
}

/// The tools of the capabilities `caps` name, as a row shows them, sorted.
fn tools_of(program: Program<'_>, caps: &[CapVal]) -> Vec<String> {
    described(tool_facts(program, caps))
}

/// 0.6: an effect `c.t` whose connector is no definition the view sees (its
/// module is not given) is not "not critical": its class is not known.
fn unknown_connectors(program: Program<'_>, effects: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = effects
        .into_iter()
        .map(|e| {
            let unknown = e
                .strip_suffix(" (not critical)")
                .filter(|name| {
                    name.split_once('.').is_some_and(|(c, _)| {
                        defs_of(program).get(c).is_none()
                            && mandate_check::stdlib::std_effect(name).is_none()
                    })
                })
                .map(|name| format!("{name} (class not known: its connector is not given)"));
            unknown.unwrap_or(e)
        })
        .collect();
    sort_utf16(&mut out);
    out
}

/// The authority of a program: `AuthorityView`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuthorityView {
    /// The program it shows.
    pub program: ProgramRef,
    /// The agents, then each workflow with its delegations.
    pub rows: Vec<AuthorityRow>,
}

impl AuthorityView {
    /// `{ format, kind, program, rows }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "authority")
            .with("program", self.program.to_js())
            .with(
                "rows",
                JsValue::Array(self.rows.iter().map(AuthorityRow::to_js).collect()),
            )
            .into()
    }
}

/// The kinds of capability in a list of `with caps` whose scope the run
/// chooses: `lateKinds(program, list)`.
#[must_use]
pub fn late_kinds(program: Program<'_>, list: &[Value]) -> Vec<String> {
    let chosen: Vec<Value> = list
        .iter()
        .filter(|v| Expr::of(v).is_some_and(chosen_at_run_time))
        .cloned()
        .collect();
    widest(program, &chosen)
        .iter()
        .map(|c| c.ctor().to_owned())
        .collect()
}

/// What the walk of a workflow's body carries: the program, the workflow,
/// and the rows so far.
struct Walk<'a> {
    program: Program<'a>,
    name: &'a str,
    wf: &'a Value,
    rows: Vec<AuthorityRow>,
}

impl Walk<'_> {
    /// `visit(v, handed, late)`: `handed` is what the maps around a step
    /// hand it, `late` the kinds they hand with a scope the run chooses.
    fn visit(&mut self, v: &Value, handed: &[CapVal], late: &[String]) {
        match v {
            Value::Array(items) => {
                for x in items {
                    self.visit(x, handed, late);
                }
            }
            Value::Object(map) => {
                let Some(e) = Expr::of(v) else { return };
                if e.is(ExprOp::Delegate) {
                    self.delegate(e, handed, late);
                }
                if e.is(ExprOp::Map) {
                    let kinds: Vec<String> = widest(self.program, e.caps().unwrap_or_default())
                        .iter()
                        .map(|c| c.ctor().to_owned())
                        .collect();
                    let mut inside: Vec<String> = late
                        .iter()
                        .filter(|k| !kinds.contains(k))
                        .cloned()
                        .collect();
                    inside.extend(late_kinds(self.program, e.caps().unwrap_or_default()));
                    let for_body = handed_by(self.program, handed, e);
                    for (k, x) in map.iter() {
                        if k == "body" {
                            self.visit(x, &for_body, &inside);
                        } else {
                            self.visit(x, handed, late);
                        }
                    }
                    return;
                }
                if e.is(ExprOp::Plan) {
                    let lead = defs_of(self.program)
                        .get(e.agent().unwrap_or_default())
                        .filter(|l| is_kind(l, "agent"));
                    if let Some(lead) = lead {
                        let grant = grant_of(self.program, self.wf, lead, &[], &[]);
                        self.rows.push(AuthorityRow {
                            who: format!(
                                "{} → plan {}.{}",
                                self.name,
                                js_name(e, "agent"),
                                js_name(e, "skill")
                            ),
                            kind: "delegation",
                            effects: Vec::new(),
                            authority: authority_of(&grant),
                            tools: tools_of(self.program, &grant),
                        });
                    }
                }
                for (_, x) in map.iter() {
                    self.visit(x, handed, late);
                }
            }
            _ => {}
        }
    }

    /// The row of a delegation: the grant the agent gets inside the
    /// workflow, and how it came to be.
    fn delegate(&mut self, e: Expr<'_>, handed: &[CapVal], late: &[String]) {
        let agent = defs_of(self.program)
            .get(e.agent().unwrap_or_default())
            .filter(|a| is_kind(a, "agent"));
        let Some(agent) = agent else { return };
        let with_caps = e.caps().unwrap_or_default();
        let grant = grant_of(self.program, self.wf, agent, with_caps, handed);
        // A kind the delegation names is its own to narrow. Any other kind comes from the maps around it.
        let own: Vec<String> = widest(self.program, with_caps)
            .iter()
            .map(|c| c.ctor().to_owned())
            .collect();
        let mut at_run = late_kinds(self.program, with_caps);
        at_run.extend(late.iter().filter(|k| !own.contains(k)).cloned());
        // The row then shows the capability that is narrowed: the most the grant can be, not what one run gets.
        let how = if with_caps.is_empty() && handed.is_empty() {
            ""
        } else if grant.iter().any(|c| at_run.iter().any(|k| k == c.ctor())) {
            " (with caps, scope chosen at run time)"
        } else {
            " (with caps)"
        };
        self.rows.push(AuthorityRow {
            who: format!(
                "{} → {}.{}{how}",
                self.name,
                js_name(e, "agent"),
                js_name(e, "skill")
            ),
            kind: "delegation",
            effects: Vec::new(),
            authority: authority_of(&grant),
            tools: tools_of(self.program, &grant),
        });
    }
}

/// A member of an expression as a template writes it.
fn js_name(e: Expr<'_>, key: &str) -> String {
    mandate_check::js_text(e.get(key))
}

/// The authority of a program: `authority(program)`. A value that is no
/// program has no rows.
#[must_use]
pub fn authority(program: &Value) -> AuthorityView {
    authority_with(program, None)
}

/// [`authority`] with the modules the program imports (0.6, which only the
/// Rust reads): a workflow that applies a pattern of one of them is shown as
/// its expansion, and one whose pattern is in a module that is not given as
/// the stand-in of [`mandate_check::expand::for_views`], which shows no less
/// than the expansion may do. A program that applies no pattern is shown as
/// [`authority`] shows it.
#[must_use]
pub fn authority_with(program: &Value, modules: Option<&Modules>) -> AuthorityView {
    let mut rows: Vec<AuthorityRow> = Vec::new();
    // 0.6: a workflow that applies a pattern is shown as its expansion.
    let expanded = mandate_check::expand::for_views(program, modules);
    if let Some(p) = Program::of(expanded.as_ref().unwrap_or(program)) {
        let defs = sorted_defs(p);
        // 0.6: the connectors the program imports are read, so that a
        // `tool.call` is the tools it names, and a write tool is the critical
        // effect it declares. A program of 0.1 to 0.5 is read as it was.
        let is_0_6 = p.language().is_some_and(|l| l.at_least(Language::V0_6));
        let linked_value: Option<Value> = modules
            .filter(|m| is_0_6 && !m.is_empty())
            .map(|_| linked_program(p, modules));
        let lp = linked_value.as_ref().and_then(Program::of).unwrap_or(p);
        for (name, d) in &defs {
            if is_kind(d, "agent") {
                let remote = d.get("remote").is_some_and(Value::is_truthy);
                let caps = caps_in(lp, Definition::of(d).caps());
                rows.push(AuthorityRow {
                    who: if remote {
                        format!("{name} (remote)")
                    } else {
                        (*name).to_owned()
                    },
                    kind: "agent",
                    effects: Vec::new(),
                    authority: authority_of(&caps),
                    tools: described(tool_facts_of(lp, Definition::of(d).caps())),
                });
            }
        }
        for (name, d) in &defs {
            if !is_kind(d, "workflow") {
                continue;
            }
            let body = Definition::of(d).body();
            let caps = caps_in(lp, workflow_bounds(d).caps);
            let mut effects = workflow_effects(lp, body);
            if is_0_6 {
                effects = unknown_connectors(lp, effects);
            }
            rows.push(AuthorityRow {
                who: (*name).to_owned(),
                kind: "workflow",
                effects,
                authority: authority_of(&caps),
                tools: described(tool_facts_of(lp, workflow_bounds(d).caps)),
            });
            let mut walk = Walk {
                program: lp,
                name,
                wf: d,
                rows: Vec::new(),
            };
            for s in body {
                walk.visit(s, &[], &[]);
            }
            rows.append(&mut walk.rows);
        }
    }
    AuthorityView {
        program: program_ref(program),
        rows,
    }
}

/// The blocks of the authority in a document: `authorityBlocks(v)`.
#[must_use]
pub fn authority_blocks(v: &AuthorityView) -> Vec<Block> {
    // 0.6: a column for the connector tools, only when a row has any.
    let with_tools = v.rows.iter().any(|r| !r.tools.is_empty());
    let rows = v
        .rows
        .iter()
        .map(|r| {
            let a = &r.authority;
            let mut cells = vec![Cell::plain(r.who.as_str()), Cell::plain(r.kind)];
            for xs in [
                &a.read,
                &a.write,
                &a.network,
                &a.model,
                &a.exec,
                &a.repos,
                &a.money,
                &r.effects,
                &a.unbounded,
            ] {
                cells.push(Cell::plain(list(xs)));
            }
            if with_tools {
                cells.push(Cell::plain(list(&r.tools)));
            }
            cells
        })
        .collect();
    let mut head: Vec<String> = [
        "Who",
        "Kind",
        "Read",
        "Write",
        "Network",
        "Model",
        "Run",
        "Pull requests",
        "Money",
        "External effects",
        "Unbounded",
    ]
    .map(str::to_owned)
    .to_vec();
    if with_tools {
        head.push("Connector tools".to_owned());
    }
    vec![
        Block::H("Authority".to_owned()),
        Block::Table { head, rows },
    ]
}
