//! What each role of a program of 0.7 is shown, held to the class the lock
//! gives it (spec/attention.md "Lock 0.7", "Static rules"), which only the
//! Rust compiler reads: E1909.
//!
//! With a lock, a role may be shown data up to its class in `role_classes`
//! ([`Lock::role_class`]: `internal` for a role the lock does not name). The
//! runtime masks a value above that class (`runtime/src/mask.ts`); the check
//! refuses, before any run, a program that would show a role such a value,
//! since nobody can decide on what they may not see and a report would
//! promise what its role cannot be shown. [`role_class_checks`] is the one
//! comparison, and it computes no class: it reads the classes the one typing
//! pass gave the attention facts ([`Typing`]), which the facts, the attention
//! view, E1906, E1907 and the runtime read too:
//!
//! - each question site of each workflow (the bound's `questions` and the
//!   rows of its `on budget_exceeded` handler) that names a role: its
//!   `shown` against that role's class. That covers an approval a `verify`
//!   asks, `human.ask`, `escalate`, the escalations of `supervise escalate`,
//!   a review and the role it escalates to (its `only: on_escalation` row),
//!   the authorization of an effect the program hands to a person (the
//!   envelope's `approve E by r`, a tier `by human`, an irreversible
//!   action's `owner`: the authorizer is shown the action's parameters), a
//!   change set's member and approver, and the owner's gate of a
//!   governance-class file;
//! - each `plan`'s amendment request, which the envelope's owner decides:
//!   its `shown` (what the lead is handed, which a lead's reason is made of)
//!   against the owner's class;
//! - each field of each report: its class against the class of the role the
//!   report is addressed to.
//!
//! A row that names no role is shown to nobody the lock can cap: a `pause`
//! and the pause a workflow without an `on budget_exceeded` handler falls
//! back to (whose notification carries ids, kinds, roles, deadlines and a
//! link, never content), and an effect site the runtime's configuration
//! may hand to a person, which has no class and which the runtime masks for
//! every role. A program of 0.1 to 0.6 is given nothing, lock or not.

use mandate_ir::{
    DefKind, Definition, Diagnostic, JsObject, Language, Location, Program, ReportField, Spans,
    Stmt, StmtOp, nearest_span, ptr_token,
};

use crate::asks::{Detail, Only, QuestionFact, SiteKind};
use crate::lock::Lock;
use crate::statics::Typing;
use crate::stdlib::DataClass;

/// One place a role is shown data: who, what class, what and where.
struct Showing {
    /// The workflow.
    workflow: String,
    /// The IR path of the construct that shows it.
    path: String,
    /// The role it is shown to.
    role: String,
    /// The class of what it shows.
    shown: DataClass,
    /// The site, as the facts name its kind (`report` for a report field).
    site: &'static str,
    /// What it is, in the message's words.
    what: String,
    /// When it is shown only in part of the runs.
    only: Option<Only>,
    /// A report field's name.
    field: Option<String>,
}

/// What a question site of `kind` shows, in the message's words.
fn question_words(q: &QuestionFact) -> String {
    match q.kind {
        SiteKind::Verify => match &q.detail {
            Some(Detail::Verify {
                contract,
                criterion,
            }) => format!(
                "the approval of {contract}.{criterion} a verify asks of it, with the contract's arguments,"
            ),
            _ => "the approval a verify asks of it, with the contract's arguments,".to_owned(),
        },
        SiteKind::Ask => "human.ask, with its question and what it is given,".to_owned(),
        SiteKind::Escalate => "escalate, with what it escalates,".to_owned(),
        SiteKind::Pause => "pause".to_owned(),
        SiteKind::SuperviseEscalate => {
            "the escalation of supervise escalate, with the fault it names,".to_owned()
        }
        SiteKind::Effect => {
            "the authorization of an effect, with the action's parameters,".to_owned()
        }
        SiteKind::Changeset => {
            "the authorization of a change set, with the changes of its actions,".to_owned()
        }
        SiteKind::Governance => {
            "the owner's gate of a governance-class file, with the action's parameters,".to_owned()
        }
        SiteKind::Review if q.only == Some(Only::OnEscalation) => {
            "the review escalated to it, with the items, their failed criteria and values,"
                .to_owned()
        }
        SiteKind::Review => {
            "human.review, with the items, their failed criteria and values,".to_owned()
        }
        SiteKind::Plan => {
            "the lead's amendment request, made of what its lead is handed,".to_owned()
        }
    }
}

/// Whether `program` is of language 0.7 or later.
fn reads_0_7(program: Program<'_>) -> bool {
    program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
}

/// Every place `program`'s workflows show a role data, from what its typing
/// gave the attention facts: per workflow, in the order of the definitions,
/// its question sites, the rows of its handler, its plans, then its reports'
/// fields in the order of its body. A site of a function or a contract that
/// two workflows reach is listed once, at the class the higher of them
/// gives it.
fn showings(program: Program<'_>, typing: &Typing) -> Vec<Showing> {
    let mut out: Vec<Showing> = Vec::new();
    let mut put = |s: Showing| match out
        .iter_mut()
        .find(|o| o.path == s.path && o.site == s.site && o.role == s.role && o.only == s.only)
    {
        Some(o) => o.shown = o.shown.max(s.shown),
        None => out.push(s),
    };
    for b in &typing.bounds {
        for q in b.questions.iter().chain(&b.budget_exceeded) {
            let Some(role) = &q.role else { continue };
            put(Showing {
                workflow: b.workflow.clone(),
                path: q.path.clone(),
                role: role.clone(),
                shown: q.shown,
                site: q.kind.as_str(),
                what: question_words(q),
                only: q.only,
                field: None,
            });
        }
        for p in &b.plans {
            let Some(role) = &p.role else { continue };
            put(Showing {
                workflow: b.workflow.clone(),
                path: p.path.clone(),
                role: role.clone(),
                shown: p.shown,
                site: SiteKind::Plan.as_str(),
                what: "the lead's amendment request, made of what its lead is handed,".to_owned(),
                only: None,
                field: None,
            });
        }
    }
    // The reports, as the facts list them (`crate::attention`): each of a
    // workflow's body, each field with what the typing gave it.
    for (name, d) in program.definitions() {
        if d.kind() != Some(DefKind::Workflow) {
            continue;
        }
        let base = format!("/defs/{}/body", ptr_token(name));
        crate::attention::sites(Definition::body(d), &base, &mut |site| {
            let Some(s) = Stmt::of(site.node).filter(|s| s.op() == Some(StmtOp::Report)) else {
                return;
            };
            let title = s.title().unwrap_or_default();
            for (i, f) in s.fields().iter().enumerate() {
                let Some(f) = ReportField::of(f) else {
                    continue;
                };
                let at = format!("{}/fields/{i}/value", site.path);
                let Some(shown) = typing.shown.get(&at) else {
                    continue;
                };
                let field = f.name().unwrap_or_default();
                put(Showing {
                    workflow: name.to_owned(),
                    path: at,
                    role: shown.role.clone(),
                    shown: shown.cls,
                    site: "report",
                    what: format!("field {field} of the report \"{title}\""),
                    only: None,
                    field: Some(field.to_owned()),
                });
            }
        });
    }
    out
}

/// E1909: with a lock, each place `program` (the program the static checks
/// read: an expansion, for one that applies a pattern) shows a role data
/// above the role's class in the lock ([`Lock::role_class`]), at the place,
/// from what the typing gave the attention facts (`typing`). `lock` is a
/// lock [`crate::lock::validate_lock`] passed, or, for a lead's sub-program,
/// one that holds only the `role_classes` of its parent's lock. Nothing for
/// a program older than 0.7.
#[must_use]
pub fn role_class_checks(
    program: Program<'_>,
    typing: &Typing,
    lock: Lock<'_>,
    spans: Option<&Spans>,
) -> Vec<Diagnostic> {
    if !reads_0_7(program) {
        return Vec::new();
    }
    let mut out: Vec<Diagnostic> = Vec::new();
    for s in showings(program, typing) {
        let cap = lock.role_class(&s.role);
        if s.shown <= cap {
            continue;
        }
        let Showing {
            workflow,
            path,
            role,
            shown,
            site,
            what,
            only,
            field,
        } = s;
        out.push(Diagnostic::new(
            "E1909",
            format!(
                "Role {role} may be shown data up to {cap} (its class in the lock's role_classes, internal when the lock does not name it), and {what} shows it {shown} data in workflow {workflow}: nobody can decide on, or be told, what they may not see. Raise the class of {role} in the lock's role_classes, or show it less (spec/attention.md \"Lock 0.7\")."
            ),
            Location::path_span(&path, nearest_span(spans, &path)),
            Some(
                JsObject::new()
                    .with("workflow", workflow)
                    .with("role", role)
                    .with("class", cap.as_str())
                    .with("shown", shown.as_str())
                    .with("site", site)
                    .with_some("only", only.map(Only::as_str))
                    .with_some("field", field),
            ),
        ));
    }
    out
}
