//! The attention facts of a workflow of language 0.7 (spec/attention.md
//! "The facts"): the one structure, computed by the compiler, from which the
//! attention view, the approval card, the static checks of attention and the
//! runtime's masking read what a workflow shows to whom. Rust only; the door
//! `attention_facts` gives it ([`attention_facts`]).
//!
//! # Which program, which paths
//!
//! The facts are of the **running program**: the program a run of the
//! workflow runs, which `check` gives as `linked` when it is asked for it
//! (and as `expanded`, with the program's own definitions): the expanded
//! program when the workflow applies a pattern, the program itself when not.
//! A workflow that applies a pattern has its stages and its reports only
//! there, the role of each report the one the application binds. Every
//! `path` is a JSON Pointer into that program, the path of the statement the
//! runtime runs (`/defs/W/body/i`, a nested one `/defs/W/body/i/then/j`);
//! the runtime's command ids are these paths with a loop's iteration (`@k`)
//! and the like after a segment, and with a sub-program's command before
//! them.
//!
//! # What a report's fields are
//!
//! Each field's type, data class and how it is known come from the static
//! checks' typing of the workflow, the very pass `check` runs
//! ([`crate::statics::Shown`]): the type its value is typed with
//! ([`crate::ty::show`]), the data class of the value (`Val.cls`), and the
//! level of its type, the weakest wrapper deciding
//! ([`crate::reports::known`]): `verified`, `plain`, `model` (a model's
//! output, `Inferred`) or `external` (outside content, `Untrusted`).
//!
//! # How many times
//!
//! [`Count`] is the algebra of spec/attention.md "The algebra", a count in
//! ℕ ∪ {∞}: summed over a sequence and the branches of a `par`, the larger
//! of the branches of an `if` or a `switch`, multiplied by a loop's bound.
//! [`sites`] walks a body and gives each statement and expression the number
//! of times one run can meet it: once at the top level and in a branch, `n`
//! times in `loop max_iter n` (unbounded in a loop without one), `max` times
//! in a map's body, twice in a branch of a `par` that `supervise
//! restart_all` runs again. A report's `multiplicity` is its site's count;
//! the questions and the effect sites of the attention bound are counted by
//! the same walk.
//!
//! # The shape, `mandate/attention/0.1`
//!
//! ```json
//! { "format": "mandate/attention/0.1", "workflow": "W", "program": "sha256:…",
//!   "stages":  [ { "path", "name", "title", "index" } ],
//!   "reports": [ { "path", "role", "title", "stage", "multiplicity",
//!                  "fields": [ { "name", "type", "class", "known" } ] } ] }
//! ```
//!
//! `stages` in the order of the body, `index` from 0; `reports` in the
//! order of the body (a depth-first walk), `stage` the name of the stage of
//! the top-level statement it stands in (`null` before the first, or in a
//! body with none), `multiplicity` an integer or `"unbounded"`; `fields` in
//! the order the author wrote them. Each list is an array, not an object,
//! because the canonical form (JCS) would sort an object's members: the
//! order is the order a person reads. A consumer that looks a node up by its
//! path builds its own index. The attention bound (RL4, [`crate::asks`])
//! adds members beside these and changes none of them: `questions`,
//! `effects`, `totals`, `asks`, `budget_exceeded` and `plans`, whose shape
//! the door's documentation gives (`crate::json_doors`, `attention_facts`)
//! and `vectors/README.md` ("The attention facts"); the format stays
//! `mandate/attention/0.1`, and a consumer ignores a member it does not
//! know. The facts are not part of the IR or of any hash, and computing
//! them changes nothing of `check`: the bound is the static checks' own, the
//! one that gives E1906 and E1907.

use mandate_ir::{
    DefKind, Definition, JsObject, JsValue, Language, Program, ReportField, Stmt, StmtOp, Value,
    ptr_token,
};
use mandate_syntax::SourceKind;

use crate::asks::{Detail, OnNoAnswer, QuestionFact, SiteKind, WorkflowBound};
use crate::check::{CheckOptions, check_shown};
use crate::reports::known_name;
use crate::statics::{ShownField, Typing};

/// The format tag of the facts.
pub const FORMAT: &str = "mandate/attention/0.1";

/// The largest finite count, `Number.MAX_SAFE_INTEGER`: a count the
/// arithmetic would take past it is unbounded, which bounds it soundly and
/// keeps every count one a JSON reader holds exactly.
const MAX_COUNT: u64 = 9_007_199_254_740_991;

/// How many rounds a `par` with `supervise restart_all` runs its branches
/// at most: the first, and one again (`rounds` in `par` of
/// `runtime/src/interp.ts`).
pub const RESTART_ALL_ROUNDS: u64 = 2;

/// A count in ℕ ∪ {∞}: how many times something can happen in one run
/// (spec/attention.md "The algebra").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Count {
    /// At most this many times.
    Finite(u64),
    /// No bound the compiler can give.
    Unbounded,
}

impl Count {
    /// Never.
    pub const ZERO: Count = Count::Finite(0);
    /// Once.
    pub const ONE: Count = Count::Finite(1);

    /// The count `n` (a negative bound is no time at all), unbounded past
    /// [`MAX_COUNT`].
    #[must_use]
    pub fn of(n: i64) -> Count {
        Count::bounded(u64::try_from(n).unwrap_or(0))
    }

    fn bounded(n: u64) -> Count {
        if n > MAX_COUNT {
            Count::Unbounded
        } else {
            Count::Finite(n)
        }
    }

    /// One after the other, or side by side (a sequence, the branches of a
    /// `par`): the sum.
    #[must_use]
    pub fn plus(self, other: Count) -> Count {
        match (self, other) {
            (Count::Finite(a), Count::Finite(b)) => {
                a.checked_add(b).map_or(Count::Unbounded, Count::bounded)
            }
            _ => Count::Unbounded,
        }
    }

    /// One or the other (the branches of an `if` or a `switch`): the larger.
    #[must_use]
    pub fn max(self, other: Count) -> Count {
        match (self, other) {
            (Count::Finite(a), Count::Finite(b)) => Count::Finite(a.max(b)),
            _ => Count::Unbounded,
        }
    }

    /// Each time something else happens (a loop's body, a map's item, a
    /// call): the product. Zero times anything is zero.
    #[must_use]
    pub fn times(self, other: Count) -> Count {
        match (self, other) {
            (Count::Finite(0), _) | (_, Count::Finite(0)) => Count::ZERO,
            (Count::Finite(a), Count::Finite(b)) => {
                a.checked_mul(b).map_or(Count::Unbounded, Count::bounded)
            }
            _ => Count::Unbounded,
        }
    }

    /// As the facts write it: the integer, or `"unbounded"`.
    #[must_use]
    pub fn to_js(self) -> JsValue {
        match self {
            // At most `MAX_COUNT`, which a double holds exactly.
            #[allow(clippy::cast_precision_loss)]
            Count::Finite(n) => JsValue::Number(n as f64),
            Count::Unbounded => JsValue::from("unbounded"),
        }
    }
}

/// One statement or expression of a body, as the algebra meets it.
#[derive(Clone, Copy, Debug)]
pub struct Site<'a, 'p> {
    /// Its JSON Pointer.
    pub path: &'p str,
    /// The statement or the expression.
    pub node: &'a Value,
    /// How many times one run can meet it.
    pub times: Count,
    /// The name of the stage of the top-level statement it stands in.
    pub stage: Option<&'a str>,
}

/// Every statement and expression of the workflow's `body` (at `base`,
/// `/defs/W/body`), depth first, each with how many times one run can meet
/// it and the stage it stands in ([`Site`]). A node is visited before what
/// it holds. Nothing outside the body is walked: the functions a body calls
/// and the workflow's `on budget_exceeded` handler are counted apart, by the
/// one who needs them.
pub fn sites<'a>(body: &'a [Value], base: &str, visit: &mut dyn FnMut(&Site<'a, '_>)) {
    let mut stage: Option<&'a str> = None;
    for (i, s) in body.iter().enumerate() {
        if let Some(st) = Stmt::of(s).filter(|st| st.op() == Some(StmtOp::Stage)) {
            stage = st.name();
        }
        walk(s, &format!("{base}/{i}"), Count::ONE, stage, visit);
    }
}

/// The part of [`sites`] below the top level.
fn walk<'a>(
    v: &'a Value,
    path: &str,
    times: Count,
    stage: Option<&'a str>,
    visit: &mut dyn FnMut(&Site<'a, '_>),
) {
    match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                walk(x, &format!("{path}/{i}"), times, stage, visit);
            }
        }
        Value::Object(m) => {
            let op = v.get("op").and_then(Value::as_str);
            if op.is_some() {
                visit(&Site {
                    path,
                    node: v,
                    times,
                    stage,
                });
            }
            for (k, x) in m.iter() {
                let inner = times.times(multiplier(v, op, k));
                walk(x, &format!("{path}/{}", ptr_token(k)), inner, stage, visit);
            }
        }
        _ => {}
    }
}

/// How many times the member `k` of the node `v` (of `op`) is met each time
/// the node is: a loop's body and condition its bound (unbounded without
/// `max_iter`), a map's body its `max` (unbounded without one), the branches
/// of a `par` that `supervise restart_all` runs [`RESTART_ALL_ROUNDS`] times;
/// every other member once.
fn multiplier(v: &Value, op: Option<&str>, k: &str) -> Count {
    match (op, k) {
        (Some("loop"), "body" | "until") => v
            .get("max_iter")
            .and_then(Value::as_i64)
            .map_or(Count::Unbounded, Count::of),
        (Some("map"), "body") => v
            .get("max")
            .and_then(Value::as_i64)
            .map_or(Count::Unbounded, Count::of),
        (Some("par"), "branches")
            if v.get("supervise")
                .and_then(|s| s.get("name"))
                .and_then(Value::as_str)
                == Some("restart_all") =>
        {
            Count::Finite(RESTART_ALL_ROUNDS)
        }
        _ => Count::ONE,
    }
}

/// One stage of a workflow's body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StageFact {
    /// Its path.
    pub path: String,
    /// Its name.
    pub name: String,
    /// Its title.
    pub title: String,
    /// Its place among the body's stages, from 0.
    pub index: usize,
}

/// One field of a report.
#[derive(Clone, Debug, PartialEq)]
pub struct FieldFact {
    /// Its name.
    pub name: String,
    /// What the typing gave it.
    pub shown: ShownField,
}

/// One report of a workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct ReportFact {
    /// Its path.
    pub path: String,
    /// The role it is addressed to.
    pub role: String,
    /// Its title.
    pub title: String,
    /// The name of the stage it stands in, if any.
    pub stage: Option<String>,
    /// How many times one run can show it.
    pub multiplicity: Count,
    /// Its fields, in the order written.
    pub fields: Vec<FieldFact>,
}

/// The facts of one workflow (`mandate/attention/0.1`).
#[derive(Clone, Debug, PartialEq)]
pub struct AttentionFacts {
    /// The workflow.
    pub workflow: String,
    /// The program's hash, `hashes.program` of its check.
    pub program: String,
    /// Its stages, in order.
    pub stages: Vec<StageFact>,
    /// Its reports, in the order of the body.
    pub reports: Vec<ReportFact>,
    /// Its attention bound: the question sites, the effect sites, the
    /// totals, the declared `asks`, the rows of `on budget_exceeded` and of
    /// each `plan` ([`crate::asks`]).
    pub bound: WorkflowBound,
}

/// A role as the facts write it: its name, or `null` for none.
fn role_js(role: Option<&str>) -> JsValue {
    role.map_or(JsValue::Null, JsValue::from)
}

/// The roles of a tally, by name, the count for no role last.
fn by_role(t: &crate::asks::Tally, member: &str) -> Vec<JsValue> {
    let mut rows: Vec<(&Option<String>, &Count)> = t.by_role.iter().collect();
    rows.sort_by(|(a, _), (b, _)| match (a, b) {
        (Some(a), Some(b)) => mandate_ir::compare_utf16(a, b),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => std::cmp::Ordering::Equal,
    });
    rows.into_iter()
        .map(|(r, n)| {
            JsObject::new()
                .with("role", role_js(r.as_deref()))
                .with(member, n.to_js())
                .into()
        })
        .collect()
}

/// One question site as the facts write it.
fn question_js(q: &QuestionFact) -> JsValue {
    let mut o = JsObject::new()
        .with("path", q.path.as_str())
        .with("wait", q.wait.as_str())
        .with("kind", q.kind.as_str())
        .with("role", role_js(q.role.as_deref()))
        .with("shown", q.shown.as_str())
        .with("known", known_name(q.known))
        .with(
            "deadline_ms",
            q.deadline_ms
                .map_or(JsValue::Null, |ms| JsValue::Number(ms as f64)),
        )
        .with("on_no_answer", q.on_no_answer.as_str());
    if let OnNoAnswer::Escalates { to, deadline_ms } = &q.on_no_answer {
        o = o.with(
            "escalates",
            JsObject::new().with("to", to.as_str()).with(
                "deadline_ms",
                deadline_ms.map_or(JsValue::Null, |ms| JsValue::Number(ms as f64)),
            ),
        );
    }
    o = o
        .with(
            "stage",
            q.stage.as_deref().map_or(JsValue::Null, JsValue::from),
        )
        .with("multiplicity", q.multiplicity.to_js())
        .with(
            "only",
            q.only.map_or(JsValue::Null, |o| JsValue::from(o.as_str())),
        );
    // Members a row of its kind alone has: every other row is as it was.
    match &q.detail {
        Some(Detail::Verify {
            contract,
            criterion,
        }) => o
            .with("contract", contract.as_str())
            .with("criterion", criterion.as_str())
            .into(),
        Some(Detail::Review { items, waivable }) => o
            .with("items", items.to_js())
            .with(
                "waivable",
                waivable
                    .iter()
                    .map(|w| JsValue::from(w.as_str()))
                    .collect::<Vec<_>>(),
            )
            .into(),
        None => o.into(),
    }
}

/// `waivable` (each `Contract.criterion`) in the order the running program
/// writes each contract's criteria, `accept` before `invariant`: the checks
/// read a canonical program, whose members are sorted.
fn program_order(waivable: &mut [String], defs: Option<&Value>) {
    let place = |w: &String| -> usize {
        let Some((c, n)) = w.split_once('.') else {
            return usize::MAX;
        };
        let Some(d) = defs.and_then(|d| d.get(c)).map(Definition::of) else {
            return usize::MAX;
        };
        d.accept()
            .chain(d.invariant())
            .position(|(k, _)| k == n)
            .unwrap_or(usize::MAX)
    };
    waivable.sort_by_key(|w| place(w));
}

impl AttentionFacts {
    /// The facts as JSON, in the shape the module's documentation gives.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let stages: Vec<JsValue> = self
            .stages
            .iter()
            .map(|s| {
                JsObject::new()
                    .with("path", s.path.as_str())
                    .with("name", s.name.as_str())
                    .with("title", s.title.as_str())
                    .with("index", s.index)
                    .into()
            })
            .collect();
        let reports: Vec<JsValue> = self
            .reports
            .iter()
            .map(|r| {
                let fields: Vec<JsValue> = r
                    .fields
                    .iter()
                    .map(|f| {
                        JsObject::new()
                            .with("name", f.name.as_str())
                            .with("type", crate::ty::show(&f.shown.ty))
                            .with("class", f.shown.cls.as_str())
                            .with("known", known_name(f.shown.known))
                            .into()
                    })
                    .collect();
                JsObject::new()
                    .with("path", r.path.as_str())
                    .with("role", r.role.as_str())
                    .with("title", r.title.as_str())
                    .with(
                        "stage",
                        r.stage.as_deref().map_or(JsValue::Null, JsValue::from),
                    )
                    .with("multiplicity", r.multiplicity.to_js())
                    .with("fields", fields)
                    .into()
            })
            .collect();
        let b = &self.bound;
        let questions: Vec<JsValue> = b.questions.iter().map(question_js).collect();
        let effects: Vec<JsValue> = b
            .effects
            .iter()
            .map(|e| {
                JsObject::new()
                    .with("path", e.path.as_str())
                    .with("effect", e.effect.as_str())
                    .with("multiplicity", e.multiplicity.to_js())
                    .with("counted", e.counted)
                    .with("role", role_js(e.role.as_deref()))
                    .with("batch", e.batch)
                    .with(
                        "stage",
                        e.stage.as_deref().map_or(JsValue::Null, JsValue::from),
                    )
                    .into()
            })
            .collect();
        let plans: Vec<JsValue> = b
            .plans
            .iter()
            .map(|p| {
                JsObject::new()
                    .with("path", p.path.as_str())
                    .with("wait", p.wait.as_str())
                    .with("kind", SiteKind::Plan.as_str())
                    .with("role", role_js(p.role.as_deref()))
                    .with("shown", p.shown.as_str())
                    .with("known", known_name(crate::ty::Level::Inferred))
                    .with("on_no_answer", OnNoAnswer::RefusedToLead.as_str())
                    .with(
                        "stage",
                        p.stage.as_deref().map_or(JsValue::Null, JsValue::from),
                    )
                    .with("multiplicity", p.multiplicity.to_js())
                    .with("from", "asks_left")
                    .into()
            })
            .collect();
        let budget_exceeded: Vec<JsValue> = b.budget_exceeded.iter().map(question_js).collect();
        let totals = JsObject::new()
            .with("questions", b.asks.total.to_js())
            .with("by_role", by_role(&b.asks, "questions"))
            .with("reports", by_role(&b.reports, "reports"));
        JsObject::new()
            .with("format", FORMAT)
            .with("workflow", self.workflow.as_str())
            .with("program", self.program.as_str())
            .with("stages", stages)
            .with("reports", reports)
            .with("questions", questions)
            .with("effects", effects)
            .with("totals", totals)
            .with(
                "asks",
                b.declared
                    .map_or(JsValue::Null, |n| JsValue::Number(n as f64)),
            )
            .with("budget_exceeded", budget_exceeded)
            .with("plans", plans)
            .into()
    }
}

/// The attention facts of `workflow` in the program `text` (of `kind`),
/// checked with `opts` as `check` checks it (the running program is asked
/// for, whatever `opts.linked` says): `None` when the program does not
/// check, is older than 0.7, or has no workflow of that name of its own.
/// Each field's type, class and level are what the check's typing gave it.
#[must_use]
pub fn attention_facts(
    text: &str,
    kind: SourceKind,
    opts: &CheckOptions<'_>,
    workflow: &str,
) -> Option<AttentionFacts> {
    let opts = CheckOptions {
        linked: true,
        ..*opts
    };
    let mut typing = Typing::default();
    let r = check_shown(text, kind, &opts, Some(&mut typing));
    let shown = &typing.shown;
    if !r.ok {
        return None;
    }
    let program = Program::of(r.program.as_ref()?)?;
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
    {
        return None;
    }
    // The program's own workflow, as it runs.
    program.defs()?.get(workflow)?;
    let running = r.linked.as_ref()?;
    let d = running.get("defs")?.get(workflow)?;
    if Definition::of(d).kind() != Some(DefKind::Workflow) {
        return None;
    }
    let body = Definition::of(d).body();
    let base = format!("/defs/{}/body", ptr_token(workflow));
    let mut stages: Vec<StageFact> = Vec::new();
    for (i, s) in body.iter().enumerate() {
        if let Some(st) = Stmt::of(s).filter(|st| st.op() == Some(StmtOp::Stage)) {
            stages.push(StageFact {
                path: format!("{base}/{i}"),
                name: st.name().unwrap_or_default().to_owned(),
                title: st.title().unwrap_or_default().to_owned(),
                index: stages.len(),
            });
        }
    }
    let mut reports: Vec<ReportFact> = Vec::new();
    sites(body, &base, &mut |site| {
        let Some(s) = Stmt::of(site.node).filter(|s| s.op() == Some(StmtOp::Report)) else {
            return;
        };
        let fields = s
            .fields()
            .iter()
            .enumerate()
            .filter_map(|(i, f)| {
                let f = ReportField::of(f)?;
                let at = format!("{}/fields/{i}/value", site.path);
                Some(FieldFact {
                    name: f.name().unwrap_or_default().to_owned(),
                    shown: shown.get(&at)?.clone(),
                })
            })
            .collect();
        reports.push(ReportFact {
            path: site.path.to_owned(),
            role: s.role().unwrap_or_default().to_owned(),
            title: s.title().unwrap_or_default().to_owned(),
            stage: site.stage.map(str::to_owned),
            multiplicity: site.times,
            fields,
        });
    });
    let mut bound = typing
        .bounds
        .iter()
        .find(|b| b.workflow == workflow)?
        .clone();
    for q in bound
        .questions
        .iter_mut()
        .chain(bound.budget_exceeded.iter_mut())
    {
        if let Some(Detail::Review { waivable, .. }) = &mut q.detail {
            program_order(waivable, running.get("defs"));
        }
    }
    Some(AttentionFacts {
        workflow: workflow.to_owned(),
        program: r.hashes.as_ref()?.program.clone(),
        stages,
        reports,
        bound,
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::{Count, sites};
    use mandate_ir::{Value, parse};

    #[test]
    fn counts_compose_as_the_algebra_says() {
        let (one, two, three) = (Count::ONE, Count::Finite(2), Count::Finite(3));
        assert_eq!(one.plus(two), three);
        assert_eq!(two.max(three), three);
        assert_eq!(two.times(three), Count::Finite(6));
        assert_eq!(Count::ZERO.times(Count::Unbounded), Count::ZERO);
        assert_eq!(two.times(Count::Unbounded), Count::Unbounded);
        assert_eq!(two.plus(Count::Unbounded), Count::Unbounded);
        assert_eq!(two.max(Count::Unbounded), Count::Unbounded);
        assert_eq!(Count::of(-4), Count::ZERO);
        // Past what a JSON reader holds exactly: unbounded, which bounds it.
        let big = Count::of(9_007_199_254_740_991);
        assert_eq!(big, Count::Finite(9_007_199_254_740_991));
        assert_eq!(big.plus(one), Count::Unbounded);
        assert_eq!(big.times(two), Count::Unbounded);
        assert_eq!(Count::Finite(4).to_js().to_js_string(), "4");
        assert_eq!(Count::Unbounded.to_js().to_js_string(), "unbounded");
    }

    #[test]
    fn each_site_has_its_multiplicity_and_its_stage() {
        let body: Value = parse(
            r#"[
              {"op":"expr","value":{"op":"int","value":0}},
              {"op":"stage","name":"a","title":"A"},
              {"op":"loop","max_iter":3,"body":[
                {"op":"if","cond":{"op":"bool","value":true},"then":[
                  {"op":"loop","max_iter":4,"body":[{"op":"expr","value":{"op":"int","value":1}}]}
                ]}
              ]},
              {"op":"stage","name":"b","title":"B"},
              {"op":"loop","until":{"op":"bool","value":true},"body":[{"op":"expr","value":{"op":"int","value":2}}]},
              {"op":"let","name":"m","value":{"op":"map","bind":"x","over":{"op":"var","name":"xs"},"max":5,"body":[{"op":"expr","value":{"op":"int","value":3}}]}},
              {"op":"par","supervise":{"name":"restart_all"},"branches":{"p":{"op":"int","value":4}}},
              {"op":"par","branches":{"q":{"op":"int","value":5}}}
            ]"#,
        )
        .unwrap()
        .value;
        let mut seen: Vec<(String, Count, Option<String>)> = Vec::new();
        sites(body.as_array().unwrap(), "/defs/W/body", &mut |s| {
            if s.node.get("op").and_then(Value::as_str) == Some("int") {
                seen.push((s.path.to_owned(), s.times, s.stage.map(str::to_owned)));
            }
        });
        let at = |p: &str| seen.iter().find(|(q, _, _)| q == p).cloned().unwrap();
        assert_eq!(at("/defs/W/body/0/value").1, Count::ONE);
        assert_eq!(at("/defs/W/body/0/value").2, None);
        let deep = at("/defs/W/body/2/body/0/then/0/body/0/value");
        assert_eq!((deep.1, deep.2.as_deref()), (Count::Finite(12), Some("a")));
        let unbounded = at("/defs/W/body/4/body/0/value");
        assert_eq!(
            (unbounded.1, unbounded.2.as_deref()),
            (Count::Unbounded, Some("b"))
        );
        assert_eq!(at("/defs/W/body/5/value/body/0/value").1, Count::Finite(5));
        assert_eq!(at("/defs/W/body/6/branches/p").1, Count::Finite(2));
        assert_eq!(at("/defs/W/body/7/branches/q").1, Count::ONE);
    }
}
