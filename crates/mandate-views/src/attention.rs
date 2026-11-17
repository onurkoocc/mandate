//! The attention view of a workflow of language 0.7, the fourth view of a
//! program beside architecture, authority and cost (spec/attention.md "The
//! attention view"): for each role, when the workflow can ask it something,
//! about what, at most how many times, by when, and what happens when nobody
//! answers; and what the workflow tells each role. A person who is not a
//! developer reads it before approving the workflow's card and when
//! deciding, so it says only what the attention facts and the lock hold, in
//! plain sentences.
//!
//! Rust only: no TypeScript reads 0.7. The view is made from the facts
//! ([`mandate_check::AttentionFacts`], the one structure the checks and the
//! runtime read) and the lock, and computes nothing the facts hold: every
//! number is a count, a deadline or a total the facts give, written in words;
//! every role is a role the facts name, with the members and the class the
//! lock gives it. What the facts do not carry is not said: the contract a
//! question asks about, the criterion that may be waived, how many items a
//! review decides on, and what the run does after a question nobody answered
//! are not in them, so the view does not show them (a fixed sentence per kind
//! of question stands in their place, [`what_is_asked`]).
//!
//! # The structure, `mandate/view/0.1`, kind `attention`
//!
//! ```json
//! { "format": "mandate/view/0.1", "kind": "attention", "program": "sha256:…",
//!   "workflow": "W",
//!   "stages": [ { "name", "title" } ],
//!   "lock": true,
//!   "bound": { "total", "asks", "declared", "unbounded_because", "leaves_out_plans", "text" },
//!   "owner": { "role", "members", "from", "promotion", "text" } | null,
//!   "configuration": "…",
//!   "uncounted_effects": [ { "effect", "at_most" } ],
//!   "questions": [ <a row> ],
//!   "reports": [ { "role", "stage", "when", "title", "at_most", "fields": [ { "name", "type", "class", "known", "known_text" } ] } ] }
//! ```
//!
//! A row, in the order of the facts (the question sites in the order of the
//! body, then each `plan`, then the rows of `on budget_exceeded`): `{ kind,
//! role, members, notified, class, shown, known, stage, only, effect,
//! at_most, per_time, unbounded_because, deadline_ms, on_no_answer,
//! escalates_to, when, what, at_most_text, deadline, if_no_answer }`. The last
//! five are the words the table's cells hold; the others are what the facts and
//! the lock give. The Markdown and the HTML are made from the same structure
//! by the document model ([`crate::doc`]), which escapes everything an author
//! wrote.

use mandate_check::asks::{OnNoAnswer, Only, QuestionFact, SiteKind};
use mandate_check::attention::{AttentionFacts, Count};
use mandate_check::reports::known_name;
use mandate_check::ty::{Level, show};
use mandate_check::{
    CheckOptions, DataClass, Lock, ProgramRef, VIEW_FORMAT, attention_facts, check, program_ref,
};
use mandate_ir::{DefKind, Definition, JsObject, JsValue, Program, Value};
use mandate_syntax::SourceKind;

use crate::card::members_of;
use crate::doc::{Block, Cell, Doc};

/// The head of the table of questions.
const QUESTION_HEAD: [&str; 8] = [
    "Role",
    "Members",
    "May be shown",
    "When",
    "What is asked",
    "At most",
    "Deadline",
    "If no answer",
];

/// The head of the table of reports.
const REPORT_HEAD: [&str; 4] = ["To", "When", "Report", "Fields (class · how known)"];

/// What is said of the runtime's configuration: it may add authorizations
/// the program does not name, and a run that adds more than the `asks` limit
/// leaves room for does not start (`attention_above_asks`).
const CONFIGURATION: &str = "The runtime's configuration may add authorizations by a person that this program does not name, and may hand one to a role other than the one a row names: only the total is held at run time, not the count of each role. A run whose configuration adds more questions than the asks limit leaves room for does not start.";

/// What is said where no lock was given.
const NO_LOCK: &str = "No lock was given, so the members who hold each role and the class each role may be shown are not known.";

/// Where a role's members or class would be, with no lock.
const NO_LOCK_CELL: &str = "no lock was given";

/// A stage of the workflow.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewStage {
    /// Its name.
    pub name: String,
    /// Its title.
    pub title: String,
}

/// The bound: how many questions a run can put to people.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewBound {
    /// The total the compiler counts, `totals.questions` of the facts.
    pub total: Count,
    /// The declared `asks`, if any.
    pub asks: Option<i64>,
    /// Why the total is unbounded, in the order the questions give it
    /// (`loop`, `map`, `recursion`, `overflow`); empty for a number.
    pub unbounded_because: Vec<String>,
    /// Whether the workflow has a `plan`, whose lead's sub-programs and
    /// amendment requests the total leaves out.
    pub leaves_out_plans: bool,
    /// The bound as a sentence.
    pub text: String,
}

/// Who approves the workflow's card and promotes it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewOwner {
    /// The role.
    pub role: String,
    /// The members the lock binds to it; `None` with no lock.
    pub members: Option<Vec<String>>,
    /// `workflow` (its own `owner`) or `envelope` (the envelope's).
    pub from: &'static str,
    /// Whether the lock asks for the promotion ladder; `None` with no lock.
    pub promotion: Option<bool>,
    /// The sentence.
    pub text: String,
}

/// An effect the static total does not count and the runtime's
/// configuration may hand to a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewEffect {
    /// The effect's name.
    pub effect: String,
    /// At most how many times one run authorizes it.
    pub multiplicity: Count,
}

/// One row of the table of questions: a site that asks a role (or no role).
#[derive(Clone, Debug, PartialEq)]
pub struct ViewRow {
    /// The kind of the question.
    pub kind: SiteKind,
    /// The role asked, if the program names one.
    pub role: Option<String>,
    /// The members the lock binds to the role; `None` with no lock or no
    /// role.
    pub members: Option<Vec<String>>,
    /// For a question that asks no role: the owner role the runtime
    /// notifies, if the workflow has one.
    pub notified: Option<String>,
    /// The highest class the role may be shown; `None` with no lock or no
    /// role.
    pub class: Option<DataClass>,
    /// The class of what the question shows (the facts' `shown`).
    pub shown: DataClass,
    /// How what it shows is known (the facts' `known`).
    pub known: Level,
    /// The name of its stage, if any.
    pub stage: Option<String>,
    /// When it is asked in only part of the runs.
    pub only: Option<Only>,
    /// For an escalation, the role whose deadline it waits for.
    pub after: Option<String>,
    /// The effect it is about, for a question about an effect.
    pub effect: Option<String>,
    /// How many times at most; per time of the budget running out for a row
    /// of `on budget_exceeded`.
    pub multiplicity: Count,
    /// Why the multiplicity is unbounded.
    pub unbounded: Option<String>,
    /// Its deadline, when a constant gives one.
    pub deadline_ms: Option<i64>,
    /// What happens when nobody answers.
    pub on_no_answer: OnNoAnswer,
    /// Whether it is a `plan` row.
    pub plan: bool,
    /// The words of the "When" cell.
    pub when: String,
    /// The words of the "What is asked" cell.
    pub what: String,
    /// The words of the "At most" cell.
    pub at_most: String,
    /// The words of the "Deadline" cell.
    pub deadline: String,
    /// The words of the "If no answer" cell.
    pub if_no_answer: String,
}

/// One field of a report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ViewField {
    /// Its name.
    pub name: String,
    /// Its type.
    pub ty: String,
    /// Its data class.
    pub class: DataClass,
    /// How it is known.
    pub known: Level,
}

/// One report: what the workflow tells a role.
#[derive(Clone, Debug, PartialEq)]
pub struct ViewReport {
    /// The role it is addressed to.
    pub role: String,
    /// The name of its stage, if any.
    pub stage: Option<String>,
    /// The words of its stage.
    pub when: String,
    /// Its title.
    pub title: String,
    /// How many times at most one run shows it.
    pub multiplicity: Count,
    /// Its fields, in the order written.
    pub fields: Vec<ViewField>,
}

/// The attention view of one workflow.
#[derive(Clone, Debug, PartialEq)]
pub struct AttentionView {
    /// The program it shows.
    pub program: ProgramRef,
    /// The program's hash as the facts give it.
    pub hash: String,
    /// The workflow.
    pub workflow: String,
    /// Its stages, in order.
    pub stages: Vec<ViewStage>,
    /// Whether a lock was given.
    pub lock: bool,
    /// The bound.
    pub bound: ViewBound,
    /// Who approves its card, if anyone.
    pub owner: Option<ViewOwner>,
    /// What the static total does not count and the configuration may add.
    pub uncounted_effects: Vec<ViewEffect>,
    /// The rows of the table of questions.
    pub questions: Vec<ViewRow>,
    /// What it tells whom.
    pub reports: Vec<ViewReport>,
}

// ── the words ────────────────────────────────────────────────────────────

/// `1 question`, `2 questions`.
fn plural(n: u64, noun: &str) -> String {
    if n == 1 {
        format!("1 {noun}")
    } else {
        format!("{n} {noun}s")
    }
}

/// A count in words: the number, or `unbounded`.

/// A duration in words, exact: `1 day`, `90 minutes` is `1 hour and 30
/// minutes`. The deadlines of the facts are milliseconds.
fn duration_words(ms: i64) -> String {
    if ms < 0 {
        return format!("{ms} milliseconds");
    }
    let units: [(i64, &str); 5] = [
        (86_400_000, "day"),
        (3_600_000, "hour"),
        (60_000, "minute"),
        (1_000, "second"),
        (1, "millisecond"),
    ];
    let mut rest = ms;
    let mut parts: Vec<String> = Vec::new();
    for (size, name) in units {
        let n = rest.checked_div(size).unwrap_or(0);
        rest = rest.checked_rem(size).unwrap_or(0);
        if n > 0 {
            parts.push(if n == 1 {
                format!("1 {name}")
            } else {
                format!("{n} {name}s")
            });
        }
    }
    match parts.as_slice() {
        [] => "0 seconds".to_owned(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} and {last}", init.join(", ")),
    }
}

/// Why a count is unbounded, in a clause.
fn unbounded_clause(reason: &str) -> &'static str {
    match reason {
        "loop" => "it stands in a loop that has no max_iter",
        "map" => "it stands in a map that has no bound",
        "recursion" => "it stands in a call that recurses",
        "overflow" => "its count is past the largest the compiler holds",
        _ => "the compiler can give no bound",
    }
}

/// What a question asks of the person, one fixed sentence for each kind of
/// question the facts carry. The match is exhaustive and has no catch-all
/// arm, so a kind added to the facts without a sentence does not compile.
/// The names are the facts': the effect an effect site is about.
#[must_use]
pub fn what_is_asked(kind: SiteKind, effect: Option<&str>) -> String {
    match kind {
        SiteKind::Verify => "Approve a criterion of a contract that the workflow checks".to_owned(),
        SiteKind::Ask => "Answer a question the workflow asks".to_owned(),
        SiteKind::Escalate => "Take a case the workflow escalates".to_owned(),
        SiteKind::Pause => "Resume the run, which is paused".to_owned(),
        SiteKind::SuperviseEscalate => {
            "Take a delegation that its supervision escalates".to_owned()
        }
        SiteKind::Effect => match effect {
            Some(e) => format!("Authorize the effect {e}"),
            None => "Authorize an effect".to_owned(),
        },
        SiteKind::Changeset => match effect {
            Some(e) => format!("Authorize {e}, a member of a change set"),
            None => "Approve a change set as a whole".to_owned(),
        },
        SiteKind::Governance => match effect {
            Some(e) => {
                format!("Approve what {e} does to a governance file, as the file's owner")
            }
            None => "Approve a change to a governance file, as the file's owner".to_owned(),
        },
        SiteKind::Review => {
            "Waive or decline the open items of a batch: one decision about the whole batch"
                .to_owned()
        }
        SiteKind::Plan => "Decide a request from the lead to amend the envelope".to_owned(),
    }
}

/// What happens when nobody answers, one fixed sentence for each outcome of
/// the facts (exhaustive, no catch-all arm). `deadline_ms` is the deadline
/// of the role it goes to, for an escalation.
#[must_use]
pub fn if_no_answer(on: &OnNoAnswer) -> String {
    match on {
        OnNoAnswer::Waits => "The run waits for an answer".to_owned(),
        OnNoAnswer::Unmet => "Past the deadline the criterion is unmet".to_owned(),
        OnNoAnswer::Escalates { to, deadline_ms } => match deadline_ms {
            Some(ms) => format!(
                "It goes to {to}, who has {} of their own",
                duration_words(*ms)
            ),
            None => format!("It goes to {to}, who has no deadline of their own"),
        },
        OnNoAnswer::Declined => "Every open item is declined, by nobody".to_owned(),
        OnNoAnswer::RefusedToLead => "The request is refused to the lead".to_owned(),
    }
}

/// How a value is known, in words: `verified`, "counted or given by the
/// run", "a model's output", "outside content" (exhaustive).
#[must_use]
pub const fn known_text(level: Level) -> &'static str {
    match level {
        Level::Verified => "verified",
        Level::Plain => "counted or given by the run",
        Level::Inferred => "a model's output",
        Level::Untrusted => "outside content",
    }
}

/// `accountant (ana)`, `accountant (nobody bound)`, or just the role with
/// no lock.
fn role_text(role: &str, members: Option<&[String]>) -> String {
    match members {
        None => role.to_owned(),
        Some([]) => format!("{role} (nobody bound)"),
        Some(m) => format!("{role} ({})", m.join(", ")),
    }
}

// ── making it ────────────────────────────────────────────────────────────

/// The title of the stage named `name`.
fn stage_title<'a>(facts: &'a AttentionFacts, name: Option<&str>) -> Option<&'a str> {
    let name = name?;
    facts
        .stages
        .iter()
        .find(|s| s.name == name)
        .map(|s| s.title.as_str())
}

/// The owner role of the workflow `name`: its own `owner`, else its
/// envelope's, with where it comes from.
fn owner_of<'a>(program: &'a Value, name: &str) -> Option<(&'a str, &'static str)> {
    let d = Definition::of(Program::of(program)?.defs()?.get(name)?);
    if d.kind() != Some(DefKind::Workflow) {
        return None;
    }
    if let Some(role) = d.owner() {
        return Some((role, "workflow"));
    }
    d.envelope()
        .and_then(|e| e.owner())
        .map(|r| (r, "envelope"))
}

/// The attention view of the workflow the facts are of, read with the
/// program's own text (for its owner) and the lock (for the members and the
/// class of each role). The facts are those of `program`'s `workflow`.
#[must_use]
pub fn attention_view_of(
    facts: &AttentionFacts,
    program: &Value,
    lock: Option<&Value>,
) -> AttentionView {
    let lock = lock.filter(|l| l.is_truthy());
    let have_lock = lock.is_some();
    let members_for =
        |role: &str| -> Option<Vec<String>> { have_lock.then(|| members_of(lock, role)) };
    let class_for =
        |role: &str| -> Option<DataClass> { lock.map(|l| Lock::of(l).role_class(role)) };
    let b = &facts.bound;
    let owner_role = owner_of(program, &facts.workflow);

    // The rows: the question sites, each `plan`, then the rows of the
    // `on budget_exceeded` handler.
    let mut questions: Vec<ViewRow> = Vec::new();
    for q in &b.questions {
        questions.push(row_of(q, &b.questions, facts, &members_for, &class_for));
    }
    for p in &b.plans {
        let role = p.role.clone();
        let multiplicity = p.multiplicity;
        let stage = p.stage.clone();
        let on = OnNoAnswer::RefusedToLead;
        let when = when_words(facts, stage.as_deref(), None, None);
        questions.push(ViewRow {
            kind: SiteKind::Plan,
            members: role.as_deref().and_then(&members_for),
            notified: None,
            class: role.as_deref().and_then(&class_for),
            role,
            shown: p.shown,
            // As the facts write a `plan` row: the lead's request is a
            // model's output.
            known: Level::Inferred,
            stage,
            only: None,
            after: None,
            effect: None,
            multiplicity,
            unbounded: None,
            deadline_ms: None,
            plan: true,
            when,
            what: what_is_asked(SiteKind::Plan, None),
            at_most: "out of what is left of asks".to_owned(),
            deadline: "no deadline".to_owned(),
            if_no_answer: if_no_answer(&on),
            on_no_answer: on,
        });
    }
    for q in &b.budget_exceeded {
        questions.push(row_of(
            q,
            &b.budget_exceeded,
            facts,
            &members_for,
            &class_for,
        ));
    }

    // The bound.
    let mut because: Vec<String> = Vec::new();
    for q in &b.questions {
        if let Some(r) = q.unbounded
            && !because.iter().any(|x| x == r)
        {
            because.push(r.to_owned());
        }
    }
    let bound = bound_of(facts, because);

    // Who approves the card.
    let owner = owner_role.map(|(role, from)| {
        let members = members_for(role);
        let ladder = lock.map(|l| Lock::of(l).promotion_required());
        let who = role_text(role, members.as_deref());
        let text = match ladder {
            Some(true) => format!("Its card is approved, and it is promoted, by {who}."),
            Some(false) | None => format!("Its card is approved by {who}."),
        };
        ViewOwner {
            role: role.to_owned(),
            members,
            from,
            promotion: ladder,
            text,
        }
    });

    // A question that goes to no role is notified to the owner role.
    for r in questions.iter_mut().filter(|r| r.role.is_none()) {
        r.notified = owner.as_ref().map(|o| o.role.clone());
    }

    let reports = facts
        .reports
        .iter()
        .map(|r| ViewReport {
            role: r.role.clone(),
            stage: r.stage.clone(),
            when: stage_title(facts, r.stage.as_deref())
                .map_or_else(|| "outside any stage".to_owned(), str::to_owned),
            title: r.title.clone(),
            multiplicity: r.multiplicity,
            fields: r
                .fields
                .iter()
                .map(|f| ViewField {
                    name: f.name.clone(),
                    ty: show(&f.shown.ty),
                    class: f.shown.cls,
                    known: f.shown.known,
                })
                .collect(),
        })
        .collect();

    let uncounted_effects = b
        .effects
        .iter()
        .filter(|e| !e.counted && !e.batch)
        .map(|e| ViewEffect {
            effect: e.effect.clone(),
            multiplicity: e.multiplicity,
        })
        .collect();

    AttentionView {
        program: program_ref(program),
        hash: facts.program.clone(),
        workflow: facts.workflow.clone(),
        stages: facts
            .stages
            .iter()
            .map(|s| ViewStage {
                name: s.name.clone(),
                title: s.title.clone(),
            })
            .collect(),
        lock: have_lock,
        bound,
        owner,
        uncounted_effects,
        questions,
        reports,
    }
}

/// The "When" words: the stage's title, then what limits it.
fn when_words(
    facts: &AttentionFacts,
    stage: Option<&str>,
    only: Option<Only>,
    after: Option<&str>,
) -> String {
    let title = stage_title(facts, stage);
    let base = title.map_or_else(|| "outside any stage".to_owned(), str::to_owned);
    match only {
        None => base,
        Some(Only::OnEscalation) => {
            let first = after.map_or_else(
                || "the first role's deadline".to_owned(),
                |r| format!("the {r}'s deadline"),
            );
            format!("{base}, only after {first}")
        }
        Some(Only::GovernanceFile) => {
            format!("{base}, only if the action carries a governance file")
        }
        Some(Only::BudgetExceeded) => {
            // Not in a stage's order: it happens whenever the budget runs
            // out, so no stage is named.
            "only if the budget runs out, and again each time it runs out after an answer that does not raise the limits".to_owned()
        }
    }
}

/// One row of a question site, read with the other rows of its list (an
/// escalation finds the role it waits for there).
fn row_of(
    q: &QuestionFact,
    list: &[QuestionFact],
    facts: &AttentionFacts,
    members_for: &dyn Fn(&str) -> Option<Vec<String>>,
    class_for: &dyn Fn(&str) -> Option<DataClass>,
) -> ViewRow {
    // The role an escalation waits for: the earlier row of the same site
    // that escalates to this role.
    let after: Option<String> = match q.only {
        Some(Only::OnEscalation) => list
            .iter()
            .find(|p| {
                p.path == q.path
                    && matches!(&p.on_no_answer, OnNoAnswer::Escalates { to, .. } if Some(to) == q.role.as_ref())
            })
            .and_then(|p| p.role.clone()),
        _ => None,
    };
    let effect = facts
        .bound
        .effects
        .iter()
        .find(|e| e.path == q.path)
        .map(|e| e.effect.clone());
    let budget = q.only == Some(Only::BudgetExceeded);
    let escalated = q.only == Some(Only::OnEscalation);
    let what = if escalated && q.kind == SiteKind::Review {
        "The same decision".to_owned()
    } else {
        what_is_asked(q.kind, effect.as_deref())
    };
    let at_most = match (q.kind, q.multiplicity) {
        (_, m) if budget => format!("not bounded ({} each time it runs out)", times_words(m)),
        (SiteKind::Review, Count::Finite(n)) => plural(n, "decision"),
        (_, Count::Finite(1)) => "once".to_owned(),
        (_, Count::Finite(n)) => format!("{n} times"),
        (_, Count::Unbounded) => match q.unbounded {
            Some(r) => format!("unbounded ({})", unbounded_clause(r)),
            None => "unbounded".to_owned(),
        },
    };
    let deadline = match (q.deadline_ms, escalated) {
        (None, _) => "no deadline".to_owned(),
        (Some(ms), false) => format!("{} from when it is asked", duration_words(ms)),
        (Some(ms), true) => {
            let first = after.as_deref().map_or_else(
                || "the first role's deadline".to_owned(),
                |r| format!("the {r}'s deadline"),
            );
            format!(
                "{} from the escalation, which comes at the first tick after {first}",
                duration_words(ms)
            )
        }
    };
    ViewRow {
        kind: q.kind,
        members: q.role.as_deref().and_then(members_for),
        notified: None,
        class: q.role.as_deref().and_then(class_for),
        role: q.role.clone(),
        shown: q.shown,
        known: q.known,
        stage: q.stage.clone(),
        only: q.only,
        when: when_words(facts, q.stage.as_deref(), q.only, after.as_deref()),
        after,
        effect,
        multiplicity: q.multiplicity,
        unbounded: q.unbounded.map(str::to_owned),
        deadline_ms: q.deadline_ms,
        plan: false,
        what,
        at_most,
        deadline,
        if_no_answer: if_no_answer(&q.on_no_answer),
        on_no_answer: q.on_no_answer.clone(),
    }
}

/// `once`, `2 times`.
fn times_words(m: Count) -> String {
    match m {
        Count::Finite(1) => "once".to_owned(),
        Count::Finite(n) => format!("{n} times"),
        Count::Unbounded => "unboundedly often".to_owned(),
    }
}

/// The bound as a sentence. A workflow with a `plan` and no declared `asks`
/// has no bound: the total leaves out what the lead's sub-programs and
/// amendment requests ask.
fn bound_of(facts: &AttentionFacts, because: Vec<String>) -> ViewBound {
    let b = &facts.bound;
    let total = b.asks.total;
    let plans = !b.plans.is_empty();
    let text = match (b.declared, total) {
        (Some(n), Count::Finite(t)) => {
            let leave = if plans {
                ", not counting what the lead's sub-programs and amendment requests ask, which comes out of what is left of asks"
            } else {
                ""
            };
            format!(
                "At most {} in all (asks: {n}){leave}.",
                plural(t, "question")
            )
        }
        (Some(n), Count::Unbounded) => format!(
            "The questions are unbounded{} although asks is {n}.",
            reasons(&because)
        ),
        (None, Count::Finite(t)) if plans => format!(
            "This run has no bound on its questions. Its own steps ask {} in all, but what the lead's sub-programs and amendment requests ask is not in that total, and no asks is declared to hold it.",
            plural(t, "question")
        ),
        (None, Count::Unbounded) if plans => format!(
            "This run has no bound on its questions: they are unbounded{}, and what the lead's sub-programs and amendment requests ask is not in the total either. No asks is declared.",
            reasons(&because)
        ),
        (None, Count::Finite(t)) => format!(
            "At most {} in all; no bound is declared (asks is not set).",
            plural(t, "question")
        ),
        (None, Count::Unbounded) => format!(
            "This run has no bound on its questions: they are unbounded{}, and no asks is declared.",
            reasons(&because)
        ),
    };
    ViewBound {
        total,
        asks: b.declared,
        unbounded_because: because,
        leaves_out_plans: plans,
        text,
    }
}

/// ` (because …)` for the reasons a count is unbounded.
fn reasons(because: &[String]) -> String {
    if because.is_empty() {
        return String::new();
    }
    let clauses: Vec<&str> = because.iter().map(|r| unbounded_clause(r)).collect();
    format!(" ({})", clauses.join("; "))
}

/// The attention view of `workflow` in the program `text` (of `kind`),
/// checked with `opts` as `check` checks it, read with its lock: `None` when
/// the program does not check, is older than 0.7, or defines no workflow of
/// that name ([`attention_facts`]).
#[must_use]
pub fn attention_view(
    text: &str,
    kind: SourceKind,
    opts: &CheckOptions<'_>,
    workflow: &str,
) -> Option<AttentionView> {
    let facts = attention_facts(text, kind, opts, workflow)?;
    let checked = check(text, kind, opts);
    let program = checked.program?;
    Some(attention_view_of(&facts, &program, opts.lock))
}

/// The names of the workflows of `program`'s own definitions, in the order
/// of its definitions.
#[must_use]
pub fn workflow_names(program: &Value) -> Vec<String> {
    Program::of(program)
        .map(|p| {
            p.definitions()
                .filter(|(_, d)| d.kind() == Some(DefKind::Workflow))
                .map(|(n, _)| n.to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// Whether `program` is of language 0.7 or later, which has an attention
/// view.
#[must_use]
pub fn has_attention(program: &Value) -> bool {
    Program::of(program)
        .and_then(|p| p.language())
        .is_some_and(|l| l.at_least(mandate_ir::Language::V0_7))
}

// ── the structure as JSON ────────────────────────────────────────────────

fn count_js(c: Count) -> JsValue {
    c.to_js()
}

fn opt_str(s: Option<&str>) -> JsValue {
    s.map_or(JsValue::Null, JsValue::from)
}

fn strings(xs: &[String]) -> JsValue {
    JsValue::Array(xs.iter().map(|s| JsValue::from(s.as_str())).collect())
}

impl ViewRow {
    /// The row as JSON, in the order the module's documentation gives.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let escalates_to = match &self.on_no_answer {
            OnNoAnswer::Escalates { to, .. } => JsValue::from(to.as_str()),
            _ => JsValue::Null,
        };
        JsObject::new()
            .with("kind", self.kind.as_str())
            .with("role", opt_str(self.role.as_deref()))
            .with(
                "members",
                self.members.as_deref().map_or(JsValue::Null, strings),
            )
            .with("notified", opt_str(self.notified.as_deref()))
            .with("class", opt_str(self.class.map(DataClass::as_str)))
            .with("shown", self.shown.as_str())
            .with("known", known_name(self.known))
            .with("stage", opt_str(self.stage.as_deref()))
            .with("only", opt_str(self.only.map(Only::as_str)))
            .with("effect", opt_str(self.effect.as_deref()))
            .with("at_most", count_js(self.multiplicity))
            .with("unbounded_because", opt_str(self.unbounded.as_deref()))
            .with(
                "deadline_ms",
                self.deadline_ms
                    .map_or(JsValue::Null, |ms| JsValue::Number(ms as f64)),
            )
            .with("on_no_answer", self.on_no_answer.as_str())
            .with("escalates_to", escalates_to)
            .with("when", self.when.as_str())
            .with("what", self.what.as_str())
            .with("at_most_text", self.at_most.as_str())
            .with("deadline", self.deadline.as_str())
            .with("if_no_answer", self.if_no_answer.as_str())
            .into()
    }
}

impl AttentionView {
    /// `{ format, kind: "attention", program, workflow, stages, lock, bound,
    /// owner, configuration, uncounted_effects, questions, reports }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        let stages: Vec<JsValue> = self
            .stages
            .iter()
            .map(|s| {
                JsObject::new()
                    .with("name", s.name.as_str())
                    .with("title", s.title.as_str())
                    .into()
            })
            .collect();
        let bound = JsObject::new()
            .with("total", count_js(self.bound.total))
            .with(
                "asks",
                self.bound
                    .asks
                    .map_or(JsValue::Null, |n| JsValue::Number(n as f64)),
            )
            .with("declared", self.bound.asks.is_some())
            .with("unbounded_because", strings(&self.bound.unbounded_because))
            .with("leaves_out_plans", self.bound.leaves_out_plans)
            .with("text", self.bound.text.as_str());
        let owner = self.owner.as_ref().map_or(JsValue::Null, |o| {
            JsObject::new()
                .with("role", o.role.as_str())
                .with(
                    "members",
                    o.members.as_deref().map_or(JsValue::Null, strings),
                )
                .with("from", o.from)
                .with(
                    "promotion",
                    o.promotion.map_or(JsValue::Null, JsValue::from),
                )
                .with("text", o.text.as_str())
                .into()
        });
        let uncounted: Vec<JsValue> = self
            .uncounted_effects
            .iter()
            .map(|e| {
                JsObject::new()
                    .with("effect", e.effect.as_str())
                    .with("at_most", count_js(e.multiplicity))
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
                            .with("type", f.ty.as_str())
                            .with("class", f.class.as_str())
                            .with("known", known_name(f.known))
                            .with("known_text", known_text(f.known))
                            .into()
                    })
                    .collect();
                JsObject::new()
                    .with("role", r.role.as_str())
                    .with("stage", opt_str(r.stage.as_deref()))
                    .with("when", r.when.as_str())
                    .with("title", r.title.as_str())
                    .with("at_most", count_js(r.multiplicity))
                    .with("fields", fields)
                    .into()
            })
            .collect();
        JsObject::new()
            .with("format", VIEW_FORMAT)
            .with("kind", "attention")
            .with("program", self.hash.as_str())
            .with("workflow", self.workflow.as_str())
            .with("stages", stages)
            .with("lock", self.lock)
            .with("bound", bound)
            .with("owner", owner)
            .with("configuration", CONFIGURATION)
            .with("uncounted_effects", uncounted)
            .with(
                "questions",
                JsValue::Array(self.questions.iter().map(ViewRow::to_js).collect()),
            )
            .with("reports", reports)
            .into()
    }
}

/// The views of every workflow of a program as JSON:
/// `{ format, kind: "attention", program, workflows: [view] }`.
#[must_use]
pub fn attention_views_js(program: &ProgramRef, views: &[AttentionView]) -> JsValue {
    JsObject::new()
        .with("format", VIEW_FORMAT)
        .with("kind", "attention")
        .with("program", program.hash.as_str())
        .with(
            "workflows",
            JsValue::Array(views.iter().map(AttentionView::to_js).collect()),
        )
        .into()
}

// ── the blocks and the documents ─────────────────────────────────────────

/// The cell of the members of a row's role.
fn members_cell(r: &ViewRow, owner: Option<&ViewOwner>) -> String {
    match (&r.role, &r.members) {
        (Some(_), Some(m)) if m.is_empty() => "nobody bound".to_owned(),
        (Some(_), Some(m)) => m.join(", "),
        (Some(_), None) => NO_LOCK_CELL.to_owned(),
        (None, _) => match owner {
            Some(o) => format!(
                "no role is asked; the owner, {}, is notified",
                role_text(&o.role, o.members.as_deref())
            ),
            None => "no role is asked; with no owner, nobody is notified, and every role the lock binds can list it".to_owned(),
        },
    }
}

/// The cell of the class a row's role may be shown.
fn class_cell(r: &ViewRow) -> String {
    match (&r.role, r.class) {
        (Some(_), Some(c)) => format!("up to {}", c.as_str()),
        (Some(_), None) => NO_LOCK_CELL.to_owned(),
        (None, _) => "—".to_owned(),
    }
}

/// The fields of a report, those with the same type, class and way of being
/// known together: `posted, declined, failed (Int · confidential · counted or
/// given by the run)`.
fn fields_cell(fields: &[ViewField]) -> String {
    if fields.is_empty() {
        return "no fields".to_owned();
    }
    let mut groups: Vec<(&ViewField, Vec<&str>)> = Vec::new();
    for f in fields {
        match groups
            .iter_mut()
            .find(|(g, _)| g.ty == f.ty && g.class == f.class && g.known == f.known)
        {
            Some((_, names)) => names.push(f.name.as_str()),
            None => groups.push((f, vec![f.name.as_str()])),
        }
    }
    groups
        .iter()
        .map(|(g, names)| {
            format!(
                "{} ({} · {} · {})",
                names.join(", "),
                g.ty,
                g.class.as_str(),
                known_text(g.known)
            )
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// The blocks of one workflow's attention view, which a document puts after
/// its heading.
#[must_use]
pub fn attention_blocks(v: &AttentionView) -> Vec<Block> {
    let mut out: Vec<Block> = Vec::new();
    out.push(Block::P(if v.stages.is_empty() {
        "Stages: none".to_owned()
    } else {
        format!(
            "Stages: {}",
            v.stages
                .iter()
                .map(|s| s.title.as_str())
                .collect::<Vec<_>>()
                .join(" · ")
        )
    }));
    let owner = v.owner.as_ref().map_or_else(
        || "It names no owner, so no role approves its card.".to_owned(),
        |o| o.text.clone(),
    );
    out.push(Block::P(format!("{} {owner}", v.bound.text)));
    if !v.lock {
        out.push(Block::P(NO_LOCK.to_owned()));
    }
    out.push(Block::Note(CONFIGURATION.to_owned()));
    if !v.uncounted_effects.is_empty() {
        let list: Vec<String> = v
            .uncounted_effects
            .iter()
            .map(|e| match e.multiplicity {
                Count::Finite(1) => format!("{} (once)", e.effect),
                Count::Finite(n) => format!("{} ({n} times)", e.effect),
                Count::Unbounded => format!("{} (unbounded)", e.effect),
            })
            .collect();
        out.push(Block::P(format!(
            "The total above does not count the authorization of these effects, which the runtime's configuration may hand to a person as well: {}.",
            list.join(", ")
        )));
    }
    if v.questions.is_empty() {
        out.push(Block::P("It asks nobody anything.".to_owned()));
    } else {
        let rows = v
            .questions
            .iter()
            .map(|r| {
                vec![
                    Cell::plain(r.role.as_deref().unwrap_or("no role")),
                    Cell::plain(members_cell(r, v.owner.as_ref())),
                    Cell::plain(class_cell(r)),
                    Cell::plain(r.when.as_str()),
                    Cell::plain(r.what.as_str()),
                    Cell::plain(r.at_most.as_str()),
                    Cell::plain(r.deadline.as_str()),
                    Cell::plain(r.if_no_answer.as_str()),
                ]
            })
            .collect();
        out.push(Block::Table {
            head: QUESTION_HEAD.iter().map(|h| (*h).to_owned()).collect(),
            rows,
        });
    }
    if v.reports.is_empty() {
        out.push(Block::P(
            "What it tells whom: nothing, it makes no report.".to_owned(),
        ));
    } else {
        out.push(Block::P("What it tells whom:".to_owned()));
        let rows = v
            .reports
            .iter()
            .map(|r| {
                let title = match r.multiplicity {
                    Count::Finite(1) => r.title.clone(),
                    Count::Finite(n) => format!("{} (at most {n} times)", r.title),
                    Count::Unbounded => format!("{} (unbounded)", r.title),
                };
                vec![
                    Cell::plain(r.role.as_str()),
                    Cell::plain(r.when.as_str()),
                    Cell::plain(title),
                    Cell::plain(fields_cell(&r.fields)),
                ]
            })
            .collect();
        out.push(Block::Table {
            head: REPORT_HEAD.iter().map(|h| (*h).to_owned()).collect(),
            rows,
        });
    }
    out
}

/// The heading and the blocks of a workflow's view, as `program_doc` puts
/// them after the other views.
#[must_use]
pub fn attention_section(v: &AttentionView) -> Vec<Block> {
    let mut out = vec![Block::H(format!("Attention: {}", v.workflow))];
    out.extend(attention_blocks(v));
    out
}

/// What the document says of what it was made from.
fn view_meta(lock: bool) -> String {
    format!(
        "{VIEW_FORMAT} attention, generated from the program and {}",
        if lock { "its lock" } else { "no lock" }
    )
}

/// The view of one workflow as a document, headed by the hash it shows:
/// `# Attention: W`.
#[must_use]
pub fn attention_doc(v: &AttentionView) -> Doc {
    Doc {
        title: format!("Attention: {}", v.workflow),
        meta: vec![
            ("Program".to_owned(), v.hash.clone()),
            ("Language".to_owned(), v.program.language.clone()),
            ("View".to_owned(), view_meta(v.lock)),
        ],
        blocks: attention_blocks(v),
    }
}

/// The views of several workflows of a program as one document: the
/// program's name and version, then a heading and the blocks of each
/// workflow. `None` for no view.
#[must_use]
pub fn attention_program_doc(views: &[AttentionView]) -> Option<Doc> {
    let first = views.first()?;
    Some(Doc {
        title: format!("{} {}", first.program.module, first.program.version),
        meta: vec![
            ("Program".to_owned(), first.hash.clone()),
            ("Language".to_owned(), first.program.language.clone()),
            ("View".to_owned(), view_meta(first.lock)),
        ],
        blocks: views.iter().flat_map(attention_section).collect(),
    })
}

/// The blocks that `program_doc` adds for a program of 0.7: the attention
/// view of each of its workflows, after the other views; a workflow whose
/// facts cannot be made (the program does not check with the modules and the
/// lock given) says so. Nothing for a program of 0.1 to 0.6.
#[must_use]
pub fn attention_doc_blocks(
    program: &Value,
    lock: Option<&Value>,
    check_with: &CheckOptions<'_>,
) -> Vec<Block> {
    if !has_attention(program) {
        return Vec::new();
    }
    let text = mandate_ir::canonicalize(program);
    let opts = CheckOptions {
        lock,
        ..*check_with
    };
    let mut out: Vec<Block> = Vec::new();
    for name in workflow_names(program) {
        match attention_view(&text, SourceKind::Json, &opts, &name) {
            Some(v) => out.extend(attention_section(&v)),
            None => {
                out.push(Block::H(format!("Attention: {name}")));
                out.push(Block::Note(
                    "The attention view is not shown: the program does not check with the modules and the lock given.".to_owned(),
                ));
            }
        }
    }
    out
}
