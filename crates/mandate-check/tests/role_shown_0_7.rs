//! E1909 on a question that names no role (spec/attention.md "Lock 0.7"):
//! the runtime lists its wait to every role the lock binds and takes the
//! answer of any member the lock lists, so the check holds what it shows to
//! the lowest class of the roles the lock binds, one diagnostic for the site
//! naming that role (fact `asked: any_member`). A `pause` shows nobody
//! content and is not compared. The programs are conformance/A05 with one
//! change each, under its lock (the observer, who may be shown `internal`,
//! the lowest-capped role it binds), and under that lock with every bound
//! role given `confidential`.

use mandate_check::{CheckOptions, CheckResult, check};
use mandate_ir::{Value, stringify};
use mandate_syntax::SourceKind;
use mandate_testkit::{read_json, read_text};

const PROGRAM: &str = "conformance/A05/program.mdt";
const LOCK: &str = "conformance/A05/mandate.lock.json";
const ASK: &str = r#"let answer = human.ask("Is {it.key} right?", role: accountant)"#;

fn checked_with(text: &str, lock: &Value) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock: Some(lock),
            ..CheckOptions::default()
        },
    )
}

/// A05 with `from` (which must be in it once) written `to`.
fn patched(from: &str, to: &str) -> String {
    let t = read_text(PROGRAM).unwrap();
    assert_eq!(t.matches(from).count(), 1, "{from}");
    t.replace(from, to)
}

/// A05's lock, with `role` given `class` in its role_classes.
fn lock_with(role: &str, class: &str) -> Value {
    let mut lock = read_json(LOCK).unwrap();
    if let Value::Object(m) = &mut lock
        && let Some(Value::Object(c)) = m.get_mut("role_classes")
    {
        c.insert(role, class);
    }
    lock
}

/// Each diagnostic's code, path and facts.
fn found(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .map(|d| {
            let facts = stringify(&mandate_ir::JsValue::Object(
                d.facts.clone().unwrap_or_default(),
            ))
            .unwrap();
            format!(
                "{} at {} {facts}",
                d.code,
                d.at.path.as_deref().unwrap_or("")
            )
        })
        .collect()
}

#[test]
fn the_base_checks_with_its_lock() {
    let r = checked_with(&read_text(PROGRAM).unwrap(), &read_json(LOCK).unwrap());
    assert!(r.ok, "{:?}", found(&r));
}

#[test]
fn a_question_that_names_no_role_is_held_to_the_lowest_class_of_the_roles_the_lock_binds() {
    let text = patched(ASK, r#"let answer = human.ask("Is {it.key} right?")"#);
    let r = checked_with(&text, &read_json(LOCK).unwrap());
    assert!(!r.ok);
    assert_eq!(
        found(&r),
        [
            r#"MDT-E1909 at /defs/Settle/body/3/value {"workflow":"Settle","role":"observer","class":"internal","shown":"confidential","site":"ask","asked":"any_member"}"#
        ]
    );
    let d = &r.diagnostics[0];
    assert!(
        d.message.contains("names no role") && d.message.contains("any member the lock binds"),
        "{}",
        d.message
    );
    // Accepted once every role the lock binds may be shown the value.
    assert!(checked_with(&text, &lock_with("observer", "confidential")).ok);
}

#[test]
fn an_escalation_that_names_no_role_is_held_so_too() {
    let text = patched(
        ASK,
        &format!("{ASK}\n  let look = escalate human(\"Look at {{it.key}}\")"),
    );
    let r = checked_with(&text, &read_json(LOCK).unwrap());
    assert!(!r.ok);
    assert_eq!(
        found(&r),
        [
            r#"MDT-E1909 at /defs/Settle/body/4/value {"workflow":"Settle","role":"observer","class":"internal","shown":"confidential","site":"escalate","asked":"any_member"}"#
        ]
    );
    assert!(checked_with(&text, &lock_with("observer", "confidential")).ok);
}

#[test]
fn of_the_roles_the_lock_binds_the_one_named_is_the_first_by_name_of_the_lowest_class() {
    // The observer and the finance lead both public: the finance lead is
    // the first by name; one diagnostic for the site.
    let text = patched(ASK, r#"let answer = human.ask("Is {it.key} right?")"#);
    let mut lock = lock_with("observer", "public");
    if let Value::Object(m) = &mut lock
        && let Some(Value::Object(c)) = m.get_mut("role_classes")
    {
        c.insert("finance_lead", "public");
    }
    let r = checked_with(&text, &lock);
    let no_role: Vec<String> = found(&r)
        .into_iter()
        .filter(|d| d.contains(r#""asked":"any_member""#))
        .collect();
    assert_eq!(
        no_role,
        [
            r#"MDT-E1909 at /defs/Settle/body/3/value {"workflow":"Settle","role":"finance_lead","class":"public","shown":"confidential","site":"ask","asked":"any_member"}"#
        ]
    );
}

#[test]
fn a_pause_shows_nobody_content_and_is_not_compared() {
    let text = patched(ASK, &format!("{ASK}\n  let held = pause"));
    let r = checked_with(&text, &lock_with("observer", "public"));
    assert!(r.ok, "{:?}", found(&r));
}
