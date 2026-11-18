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
//! A question site or a plan that names no role is asked of anyone: the
//! runtime lists its wait to every role the lock binds and takes the answer
//! of any member the lock lists (`runtime/src/decisions.ts`). So it is held
//! to the lowest class of the roles the lock binds, one diagnostic for the
//! site naming that role (fact `asked: any_member`). A `pause`, and the
//! pause a workflow without an `on budget_exceeded` handler falls back to,
//! show nobody content (a role's view shows that the run waits; the
//! notification carries ids, kinds, roles, deadlines and a link) and are not
//! compared. Nor is an effect site only the runtime's configuration hands to
//! a person: its row has no class, and the runtime's start compares what it
//! can (`runtime/src/asks.ts`). A program of 0.1 to 0.6 is given nothing,
//! lock or not.

use mandate_ir::{
    DefKind, Definition, Diagnostic, JsObject, Language, Location, Program, ReportField, Spans,
    Stmt, StmtOp, Value, nearest_span, ptr_token,
};

use crate::asks::{Detail, Only, QuestionFact, SiteKind, WorkflowBound};
use crate::lock::Lock;
use crate::statics::Typing;
use crate::stdlib::DataClass;

/// One place a role is shown data: who, what class, what and where.
struct Showing {
    /// The workflow.
    workflow: String,
    /// The IR path of the construct that shows it.
    path: String,
    /// The role it is shown to; `None` for a question that names no role,
    /// which any member the lock binds may answer.
    role: Option<String>,
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
        // Every table of the bound, named: a table the facts gain is a
        // decision here (does it show a role anything?), not a silent skip.
        let WorkflowBound {
            workflow,
            questions,
            effects: _,
            plans,
            budget_exceeded,
            asks: _,
            reports: _,
            declared: _,
            declared_at: _,
        } = b;
        for q in questions.iter().chain(budget_exceeded) {
            // A pause, written or the one a workflow without a handler falls
            // back to, shows nobody content: a role's view shows that the
            // run waits, and its notification carries no content.
            if q.role.is_none() && q.kind == SiteKind::Pause {
                continue;
            }
            put(Showing {
                workflow: workflow.clone(),
                path: q.path.clone(),
                role: q.role.clone(),
                shown: q.shown,
                site: q.kind.as_str(),
                what: question_words(q),
                only: q.only,
                field: None,
            });
        }
        for p in plans {
            put(Showing {
                workflow: workflow.clone(),
                path: p.path.clone(),
                role: p.role.clone(),
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
                    role: Some(shown.role.clone()),
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

/// The roles `lock` binds: those of its `roles`, and those its
/// `role_classes` names (a lead's sub-program is checked with a lock that
/// holds only `role_classes`, in which its caller names every role the
/// parent's lock binds), in the order of their names.
fn bound_roles(lock: Lock<'_>) -> Vec<String> {
    let mut out: Vec<String> = [lock.roles(), lock.role_classes()]
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
        .flat_map(|o| o.keys().map(str::to_owned))
        .collect();
    out.sort();
    out.dedup();
    out
}

/// The first by name of the members `lock` lists (its `members`) who hold
/// no role in it (its `roles`): such a member may answer a question that
/// names no role, and has the class of a role the lock does not name,
/// `internal`. A lead's sub-program is checked with a lock whose `members`
/// holds that member alone, when its caller gives one.
fn member_without_role(lock: Lock<'_>) -> Option<String> {
    let members = lock.members()?.as_object()?;
    let holds = |m: &str| {
        lock.roles()
            .and_then(Value::as_object)
            .is_some_and(|roles| {
                roles.iter().any(|(_, ms)| {
                    ms.as_array()
                        .is_some_and(|ms| ms.iter().any(|x| x.as_str() == Some(m)))
                })
            })
    };
    let mut out: Vec<&str> = members.keys().filter(|m| !holds(m)).collect();
    out.sort_unstable();
    out.first().map(|m| (*m).to_owned())
}

/// Who a question that names no role is held to: a role the lock binds, or
/// a member it lists who holds no role.
enum Held {
    /// The role it names, or the lowest-capped role the lock binds.
    Role(String),
    /// A member who holds no role, held to `internal`.
    Member(String),
}

/// E1909: with a lock, each place `program` (the program the static checks
/// read: an expansion, for one that applies a pattern) shows a role data
/// above the role's class in the lock ([`Lock::role_class`]), at the place,
/// from what the typing gave the attention facts (`typing`). A question
/// that names no role may be answered by any member the lock lists, so it
/// is held to the lowest class of the roles the lock binds and, when the
/// lock lists a member who holds no role, to `internal` too (the class of a
/// role the lock does not name), and the diagnostic names that role (the
/// first by name of those with that class) or, where `internal` is the lower
/// (or no role is bound), the first such member by name; one diagnostic for
/// the site. A lock that lists no member and binds no role leaves it
/// uncompared: nobody can answer it. `lock` is a lock
/// [`crate::lock::validate_lock`] passed, or, for a lead's sub-program, one
/// that holds only the `role_classes` its caller gives, for every role the
/// parent's lock binds, and the member who holds no role it gives. Nothing
/// for a program older than 0.7.
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
    let bound = bound_roles(lock);
    let lowest = bound.iter().min_by_key(|r| lock.role_class(r)).cloned();
    let unroled = member_without_role(lock);
    let mut out: Vec<Diagnostic> = Vec::new();
    for s in showings(program, typing) {
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
        let anyone = role.is_none();
        // Who is held to it: the role it names; or the lowest-capped role
        // the lock binds, or a member who holds no role where `internal` is
        // lower (none of either: nobody the lock lists can answer it).
        let held = match (role, &lowest, &unroled) {
            (Some(r), _, _) => Held::Role(r),
            (None, Some(r), Some(m)) if DataClass::Internal < lock.role_class(r) => {
                Held::Member(m.clone())
            }
            (None, Some(r), _) => Held::Role(r.clone()),
            (None, None, Some(m)) => Held::Member(m.clone()),
            (None, None, None) => continue,
        };
        let cap = match &held {
            Held::Role(r) => lock.role_class(r),
            Held::Member(_) => DataClass::Internal,
        };
        if shown <= cap {
            continue;
        }
        let message = match &held {
            Held::Member(member) => format!(
                "In workflow {workflow}, {what} names no role, so any member the lock lists may answer it, and it shows {shown} data; member {member}, whom the lock lists and binds to no role, may be shown data up to internal (the class of a role the lock does not name): nobody can decide on what they may not see. Ask a role whose class covers it, bind every member the lock lists to a role whose class covers it, or show it less (spec/attention.md \"Lock 0.7\")."
            ),
            Held::Role(role) if anyone => format!(
                "In workflow {workflow}, {what} names no role, so any member the lock binds may answer it, and it shows {shown} data; role {role}, which the lock binds, may be shown data up to {cap} (its class in the lock's role_classes, internal when the lock does not name it): nobody can decide on what they may not see. Ask a role whose class covers it, raise the class of every role the lock binds, or show it less (spec/attention.md \"Lock 0.7\")."
            ),
            Held::Role(role) => format!(
                "Role {role} may be shown data up to {cap} (its class in the lock's role_classes, internal when the lock does not name it), and {what} shows it {shown} data in workflow {workflow}: nobody can decide on, or be told, what they may not see. Raise the class of {role} in the lock's role_classes, or show it less (spec/attention.md \"Lock 0.7\")."
            ),
        };
        let (role, member) = match held {
            Held::Role(r) => (Some(r), None),
            Held::Member(m) => (None, Some(m)),
        };
        out.push(Diagnostic::new(
            "E1909",
            message,
            Location::path_span(&path, nearest_span(spans, &path)),
            Some(
                JsObject::new()
                    .with("workflow", workflow)
                    .with_some("role", role)
                    .with_some("member", member)
                    .with("class", cap.as_str())
                    .with("shown", shown.as_str())
                    .with("site", site)
                    .with_some("only", only.map(Only::as_str))
                    .with_some("field", field)
                    .with_some("asked", anyone.then_some("any_member")),
            ),
        ));
    }
    out
}
