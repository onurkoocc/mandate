//! What a workflow or a pattern of language 0.7 shows people, as a
//! library's authority signature (`crate::library::signature`) and the
//! semantic diff (`crate::diff`) record it (spec/attention.md "Reports are
//! governance"): each report's role (in a pattern, its role slot), its
//! title, and the highest data class of its fields. What a person is shown
//! is part of what they approved, so a report added, or one whose highest
//! class rises, is a governance change; a report taken away, or one whose
//! class falls, is not. Both read the one record and the one comparison of
//! this module.
//!
//! # A class that depends on what the application binds
//!
//! A workflow's report fields are typed by the static checks, the very pass
//! `check` runs ([`crate::statics::static_check_shown`]): each field's class
//! is its value's (`Val.cls`), and the report's is the highest of its
//! fields'. A pattern is not typed on its own: what its fields hold comes
//! from its slots, run parameters and type parameters (`len(items)` keeps
//! the class of what it counts, and `items` is what the application's
//! `source` gives), so their class is known only at each application, where
//! the workflow's expansion has it. The signature of a pattern records such
//! a field as [`ShownClass::Applied`], "what the application binds", which
//! ranks above every data class: a field that names anything (a variable, a
//! slot, a parameter, a constant) is `applied`; one made of literals alone
//! is `public`, the class of a literal. The rule is conservative (a field
//! that could show more than the class written records the most it could:
//! nothing the application binds can make it rise unseen), deterministic
//! (it reads the field's expression, not a typing that depends on an
//! application), and readable (`applied` in the signature, "what the
//! application binds" in the diff). A report of a pattern added, or a field
//! of literals that comes to name something, widens it; and a pattern whose
//! body changed has another shape, a widening of its own, whatever its
//! reports do. In a workflow, a field the typing did not reach (in a
//! program that does not check) is recorded `applied` too, so that what is
//! not known is never read as low.

use std::collections::BTreeMap;

use mandate_ir::{DefKind, JsObject, Language, Map, Program, Stmt, StmtOp, Value, ptr_token};

use crate::stdlib::DataClass;

/// The class a report shows, as the signature records it: a data class, or
/// what an application binds, above every data class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ShownClass {
    /// A data class.
    Class(DataClass),
    /// What the application of a pattern binds (or, in a workflow, what the
    /// typing did not reach): the most any data class could be.
    Applied,
}

impl ShownClass {
    /// Its name: a data class's, or `applied`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            ShownClass::Class(c) => c.as_str(),
            ShownClass::Applied => "applied",
        }
    }

    /// How a person reads it in the diff.
    fn said(self) -> &'static str {
        match self {
            ShownClass::Class(c) => c.as_str(),
            ShownClass::Applied => "what the application binds",
        }
    }
}

/// One report of a workflow or a pattern, as it is recorded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReportSig {
    /// The role it is addressed to; in a pattern, its role slot.
    pub role: String,
    /// Its title.
    pub title: String,
    /// The highest class of its fields.
    pub class: ShownClass,
}

impl ReportSig {
    /// `{ role, title, class }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("role", self.role.as_str())
            .with("title", self.title.as_str())
            .with("class", self.class.as_str())
    }
}

/// The reports of each workflow and pattern of a program, by name, each in
/// the order of its body.
pub type Reports = BTreeMap<String, Vec<ReportSig>>;

/// Whether `v` holds a `report` statement anywhere.
fn holds_report(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().any(holds_report),
        Value::Object(m) => {
            m.get("op").and_then(Value::as_str) == Some("report")
                || m.iter().any(|(_, x)| holds_report(x))
        }
        _ => false,
    }
}

/// Whether the expression `v` names anything: a variable, which in a
/// pattern is a slot, a run parameter, a name a statement bound or a
/// constant, any of which an application decides.
fn names_anything(v: &Value) -> bool {
    match v {
        Value::Array(items) => items.iter().any(names_anything),
        Value::Object(m) => {
            m.get("op").and_then(Value::as_str) == Some("var")
                || m.iter().any(|(_, x)| names_anything(x))
        }
        _ => false,
    }
}

/// Every report of `body` (at `base`), with the class `class_of` gives each
/// field (by the path of its value).
fn reports_in(
    body: &[Value],
    base: &str,
    class_of: &dyn Fn(&str, &Value) -> ShownClass,
) -> Vec<ReportSig> {
    let mut out = Vec::new();
    crate::attention::sites(body, base, &mut |site| {
        let Some(s) = Stmt::of(site.node).filter(|s| s.op() == Some(StmtOp::Report)) else {
            return;
        };
        let class = s
            .fields()
            .iter()
            .enumerate()
            .filter_map(|(i, f)| {
                let value = f.get("value")?;
                Some(class_of(&format!("{}/fields/{i}/value", site.path), value))
            })
            .max()
            .unwrap_or(ShownClass::Class(DataClass::Public));
        out.push(ReportSig {
            role: s.role().unwrap_or_default().to_owned(),
            title: s.title().unwrap_or_default().to_owned(),
            class,
        });
    });
    out
}

/// The reports of each workflow and pattern of `program`, a program of 0.7
/// or later as it runs (its expansion, for a workflow that applies a
/// pattern), with `linked` the definitions it sees: a workflow's fields
/// typed by the static checks, a pattern's by the rule of this module's
/// documentation. Every workflow and pattern has an entry, empty when it
/// makes no report. Empty for a program older than 0.7, which has none.
#[must_use]
pub fn report_records(program: Program<'_>, linked: &Map) -> Reports {
    let mut out = Reports::new();
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
    {
        return out;
    }
    let typed = program
        .definitions()
        .any(|(_, d)| d.kind() == Some(DefKind::Workflow) && holds_report(d.value()));
    let shown = if typed {
        crate::statics::static_check_shown(program, None, Some(linked), None).1
    } else {
        crate::statics::Shown::new()
    };
    for (name, d) in program.definitions() {
        let base = format!("/defs/{}/body", ptr_token(name));
        let reports = match d.kind() {
            Some(DefKind::Workflow) => reports_in(d.body(), &base, &|path, _| {
                shown
                    .get(path)
                    .map_or(ShownClass::Applied, |f| ShownClass::Class(f.cls))
            }),
            Some(DefKind::Pattern) => reports_in(d.body(), &base, &|_, value| {
                if names_anything(value) {
                    ShownClass::Applied
                } else {
                    ShownClass::Class(DataClass::Public)
                }
            }),
            _ => continue,
        };
        out.insert(name.to_owned(), reports);
    }
    out
}

/// Each report of `reports` by its role and title, with how many there are
/// and the highest class among them, in the order first met.
fn by_key(reports: &[ReportSig]) -> Vec<((&str, &str), usize, ShownClass)> {
    let mut out: Vec<((&str, &str), usize, ShownClass)> = Vec::new();
    for r in reports {
        let key = (r.role.as_str(), r.title.as_str());
        match out.iter_mut().find(|(k, _, _)| *k == key) {
            Some((_, n, c)) => {
                *n = n.saturating_add(1);
                *c = (*c).max(r.class);
            }
            None => out.push((key, 1, r.class)),
        }
    }
    out
}

/// What changed in the reports of `name` from `old` to `new`: the changes
/// that may show a person more (a report added, by its role and title, or
/// one more of them, or a highest class risen), which are governance
/// changes, and the others (a report taken away, or a class fallen), each
/// as a line a person reads.
#[must_use]
pub fn compare_reports(
    name: &str,
    old: &[ReportSig],
    new: &[ReportSig],
) -> (Vec<String>, Vec<String>) {
    let (was, now) = (by_key(old), by_key(new));
    let mut up = Vec::new();
    let mut down = Vec::new();
    for ((role, title), n, class) in &now {
        match was.iter().find(|(k, _, _)| k == &(*role, *title)) {
            None => up.push(format!(
                "+ {name}: report \"{title}\" to {role} (shows {})",
                class.said()
            )),
            Some((_, m, before)) => {
                if n > m {
                    up.push(format!(
                        "+ {name}: report \"{title}\" to {role}, {n} where there were {m}"
                    ));
                }
                if class > before {
                    up.push(format!(
                        "~ {name}: report \"{title}\" to {role} shows {} → {}",
                        before.said(),
                        class.said()
                    ));
                }
            }
        }
    }
    for ((role, title), m, before) in &was {
        match now.iter().find(|(k, _, _)| k == &(*role, *title)) {
            None => down.push(format!("- {name}: report \"{title}\" to {role} removed")),
            Some((_, n, class)) => {
                if n < m {
                    down.push(format!(
                        "- {name}: report \"{title}\" to {role}, {n} where there were {m}"
                    ));
                }
                if class < before {
                    down.push(format!(
                        "~ {name}: report \"{title}\" to {role} shows {} → {}",
                        before.said(),
                        class.said()
                    ));
                }
            }
        }
    }
    (up, down)
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::{ReportSig, ShownClass, compare_reports};
    use crate::stdlib::DataClass;

    fn r(role: &str, title: &str, class: ShownClass) -> ReportSig {
        ReportSig {
            role: role.to_owned(),
            title: title.to_owned(),
            class,
        }
    }

    #[test]
    fn a_report_added_or_raised_is_up_and_one_removed_or_lowered_is_down() {
        let internal = ShownClass::Class(DataClass::Internal);
        let confidential = ShownClass::Class(DataClass::Confidential);
        let a = r("reviewer", "A", internal);
        let b = r("reviewer", "B", confidential);
        assert_eq!(
            compare_reports("W", &[a.clone()], &[a.clone(), b.clone()]),
            (
                vec!["+ W: report \"B\" to reviewer (shows confidential)".to_owned()],
                vec![]
            )
        );
        assert_eq!(
            compare_reports("W", &[a.clone(), b.clone()], &[a.clone()]),
            (
                vec![],
                vec!["- W: report \"B\" to reviewer removed".to_owned()]
            )
        );
        let raised = r("reviewer", "A", ShownClass::Applied);
        assert_eq!(
            compare_reports("P", &[a.clone()], &[raised.clone()]).0,
            ["~ P: report \"A\" to reviewer shows internal → what the application binds"]
        );
        assert_eq!(
            compare_reports("P", &[raised], &[a.clone()]).1,
            ["~ P: report \"A\" to reviewer shows what the application binds → internal"]
        );
        // Another role is another report: one added, one removed.
        let other = r("escalate_to", "A", internal);
        let (up, down) = compare_reports("P", &[a.clone()], &[other]);
        assert_eq!(up.len(), 1);
        assert_eq!(down.len(), 1);
        // One more of the same.
        assert_eq!(
            compare_reports("W", &[a.clone()], &[a.clone(), a.clone()]).0,
            ["+ W: report \"A\" to reviewer, 2 where there were 1"]
        );
        assert_eq!(compare_reports("W", &[a.clone()], &[a]), (vec![], vec![]));
        assert!(ShownClass::Applied > ShownClass::Class(DataClass::Restricted));
    }
}
