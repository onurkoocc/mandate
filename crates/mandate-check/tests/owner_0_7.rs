//! A workflow's `owner` and the lock of 0.7 (spec/attention.md "`owner`",
//! "Lock 0.7", "Static rules") where a conformance case cannot say it: the
//! text read and printed back, `owner` an ordinary name everywhere else and
//! in 0.6, the role sites and the roles named, the expansion, E1910 and E1911
//! with their messages, the E0140s of `role_classes` and `promotion`, a
//! role's class, how a change of owner is classed by the diff and by a
//! library's signature, and what the one typing pass leaves for E1909. No
//! TypeScript reads 0.7, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::lock::Lock;
use mandate_check::stdlib::DataClass;
use mandate_check::{
    CheckOptions, CheckResult, Modules, attention_facts, check, governance_changes, role_sites_of,
    roles_named_in,
};
use mandate_ir::{Language, Value, canonicalize, parse, validate_lock};
use mandate_syntax::{SourceKind, load, print_program};
use mandate_testkit::{read_json, read_text};

const OWNER: &str = "fixtures/attention/owner.mdt";
const OWNER_LOCK: &str = "fixtures/attention/owner.lock.json";

fn json(text: &str) -> Value {
    parse(text).unwrap().value
}

fn checked(text: &str, lock: Option<&Value>) -> CheckResult {
    check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            lock,
            ..CheckOptions::default()
        },
    )
}

/// `code at path` of each diagnostic but W0601 and W0310.
fn found(r: &CheckResult) -> Vec<String> {
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0601" && d.code != "MDT-W0310")
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// The diagnostic of `code`, its message and facts as text.
fn one(r: &CheckResult, code: &str) -> (String, String) {
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == code)
        .unwrap_or_else(|| panic!("no {code}: {:?}", found(r)));
    (
        d.message.clone(),
        d.facts
            .as_ref()
            .map(|f| mandate_ir::stringify(&mandate_ir::JsValue::Object(f.clone())).unwrap())
            .unwrap_or_default(),
    )
}

fn text() -> String {
    read_text(OWNER).unwrap()
}

fn lock() -> Value {
    read_json(OWNER_LOCK).unwrap()
}

/// The lock of the fixture with `member` set to `value` (`None`: taken away).
fn lock_with(member: &str, value: Option<&str>) -> Value {
    let mut l = lock().as_object().cloned().unwrap();
    match value {
        Some(v) => {
            l.insert(member, json(v));
        }
        None => {
            l.remove(member);
        }
    }
    Value::Object(l)
}

#[test]
fn the_fixture_checks_with_and_without_its_lock() {
    let t = text();
    assert_eq!(found(&checked(&t, None)), Vec::<String>::new());
    let r = checked(&t, Some(&lock()));
    assert!(r.ok, "{:?}", found(&r));
    assert_eq!(found(&r), Vec::<String>::new());
    // The lock is one its own schema takes.
    assert!(validate_lock(&lock()).is_empty());
}

#[test]
fn owner_is_read_where_the_grammar_puts_it_and_printed_back() {
    let loaded = load(&text(), SourceKind::Mdt);
    assert!(loaded.diagnostics.is_empty(), "{:?}", loaded.diagnostics);
    let p = loaded.program.unwrap();
    let def = |w: &str| p.get("defs").and_then(|d| d.get(w)).unwrap();
    assert_eq!(
        def("Describe").get("owner").and_then(Value::as_str),
        Some("accountant")
    );
    assert_eq!(
        def("Check").get("owner").and_then(Value::as_str),
        Some("finance_lead")
    );
    // parse → print → parse is the identity, and the text says `owner`
    // where the grammar puts it: before the caps.
    let printed = print_program(&p).unwrap();
    assert!(
        printed.contains("workflow Describe(name: Text) -> Inferred<Text>\n  owner   accountant\n  caps    ModelStd"),
        "{printed}"
    );
    assert!(
        printed.contains("checker: accountant)\n  owner   finance_lead\n  caps    ModelStd"),
        "{printed}"
    );
    let again = load(&printed, SourceKind::Mdt).program.unwrap();
    assert_eq!(canonicalize(&again), canonicalize(&p));
    assert_eq!(print_program(&again).unwrap(), printed);
    // Beside an envelope it is read too, and printed before it: the check
    // names it (E1910).
    let beside = "mandate @ 0.7\n\nmodule example.beside @ 0.1\n\nrole boss \"Boss\"\n\nworkflow W() -> Int\n  owner boss\n  envelope {\n    owner boss\n    caps C\n    budget { steps: 1, agents: 1 }\n  }\n{\n  1\n}\n";
    let b = load(beside, SourceKind::Mdt);
    assert!(b.diagnostics.is_empty(), "{:?}", b.diagnostics);
    let bp = b.program.unwrap();
    let printed = print_program(&bp).unwrap();
    assert!(
        printed.contains("workflow W() -> Int\n  owner   boss\n  envelope {"),
        "{printed}"
    );
    assert_eq!(
        canonicalize(&load(&printed, SourceKind::Mdt).program.unwrap()),
        canonicalize(&bp)
    );
}

/// The first diagnostic `load` gives for `text`, as `code: message`.
fn first_load_error(text: &str) -> String {
    let d = load(text, SourceKind::Mdt).diagnostics;
    d.first()
        .map(|d| format!("{}: {}", d.code, d.message))
        .unwrap_or_default()
}

#[test]
fn owner_is_an_ordinary_name_everywhere_else_and_before_0_7() {
    // A program of 0.6 is told what it was told before: `owner` is no word
    // after a result type.
    let w = |v: &str| {
        format!(
            "mandate @ {v}\n\nmodule example.o @ 0.1\n\nrole boss \"Boss\"\n\nworkflow W() -> Int\n  owner boss\n  caps C\n{{\n  1\n}}\n"
        )
    };
    let as_0_6 = first_load_error(&w("0.6"));
    assert_eq!(
        as_0_6,
        first_load_error(&w("0.6").replace("owner boss", "ownr boss")).replace("ownr", "owner"),
        "the message names the word as any other"
    );
    assert!(as_0_6.starts_with("MDT-E0101"), "{as_0_6}");
    assert_eq!(first_load_error(&w("0.7")), "");
    // A missing role is a syntax error that names what is expected.
    let no_role = w("0.7").replace("owner boss", "owner {");
    assert!(
        first_load_error(&no_role).contains("Expected a role"),
        "{}",
        first_load_error(&no_role)
    );
    // In 0.7, `owner` is still a name: a variable, a field, a parameter, a
    // pattern's slot.
    let names = "mandate @ 0.7\n\nmodule example.o @ 0.1\n\ntype T = { owner: Text }\n\nfn f(owner: Text) -> Text ! {} {\n  let x = T { owner }\n  x.owner\n}\n\npattern P(owner: role) -> Int {\n  1\n}\n";
    let l = load(names, SourceKind::Mdt);
    assert!(l.diagnostics.is_empty(), "{:?}", l.diagnostics);
    let p = l.program.unwrap();
    assert!(
        p.get("defs")
            .and_then(|d| d.get("P"))
            .and_then(|d| d.get("slots"))
            .is_some()
    );
}

#[test]
fn an_owner_is_a_role_site_and_the_expansion_keeps_it() {
    let p = load(&text(), SourceKind::Mdt).program.unwrap();
    let defs = p.get("defs").and_then(Value::as_object).unwrap();
    let sites: Vec<(String, Option<String>, String)> = role_sites_of(defs, Some(Language::V0_7))
        .into_iter()
        .filter(|s| s.r#where == "a workflow's owner")
        .map(|s| (s.path, s.role, s.def))
        .collect();
    assert_eq!(
        sites,
        [
            (
                "/defs/Check/owner".to_owned(),
                Some("finance_lead".to_owned()),
                "Check".to_owned()
            ),
            (
                "/defs/Describe/owner".to_owned(),
                Some("accountant".to_owned()),
                "Describe".to_owned()
            ),
        ]
    );
    // The roles a program names (the door `roles_named`): the finance lead
    // is named only as an owner.
    assert_eq!(
        roles_named_in(defs, Language::V0_7),
        ["accountant", "finance_lead"]
    );
    let expanded = mandate_check::expand::expanded_program(&p, None).unwrap();
    let check = expanded.get("defs").and_then(|d| d.get("Check")).unwrap();
    assert_eq!(
        check.get("owner").and_then(Value::as_str),
        Some("finance_lead")
    );
    assert!(check.get("apply").is_none() && check.get("body").is_some());
}

#[test]
fn an_owner_names_a_role_the_lock_binds() {
    let t = text();
    // Not a role: E1501 at the owner, with what is near.
    let r = checked(&t.replace("owner   accountant", "owner   acountant"), None);
    assert_eq!(found(&r), ["MDT-E1501 at /defs/Describe/owner"]);
    let (message, facts) = one(&r, "MDT-E1501");
    assert_eq!(
        message,
        "A workflow's owner names the role 'acountant', but 'acountant' is not a role this module defines or imports. Define it: role acountant \"…\" (spec/envelope.md)."
    );
    assert!(facts.contains(r#""did_you_mean":"accountant""#), "{facts}");
    // The application's owner, at the application's owner.
    let r = checked(&t.replace("owner   finance_lead", "owner   Item"), None);
    assert_eq!(found(&r), ["MDT-E1501 at /defs/Check/owner"]);
    // A role the lock binds nobody to: E1502 at the owner.
    let mut roles = lock()
        .get("roles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap();
    roles.remove("finance_lead");
    let mut classes = lock()
        .get("role_classes")
        .and_then(Value::as_object)
        .cloned()
        .unwrap();
    classes.remove("finance_lead");
    let mut l = lock().as_object().cloned().unwrap();
    l.insert("roles", Value::Object(roles));
    l.insert("role_classes", Value::Object(classes));
    let r = checked(&t, Some(&Value::Object(l)));
    assert_eq!(found(&r), ["MDT-E1502 at /defs/Check/owner"]);
}

#[test]
fn an_owner_beside_an_envelope_is_e1910() {
    let program = "mandate @ 0.7\n\nmodule example.beside @ 0.1\n\nuse std.{model}\n\nrole boss \"Boss\"\n\ncapability M = model.infer(tier: standard)\n\nagent A {\n  role   \"Writes.\"\n  caps   M\n  budget { steps: 2 }\n  skill write(t: Text) -> Inferred<Text> ! {Model}\n}\n\nworkflow W() -> Inferred<Text>\n  owner boss\n  envelope {\n    owner  boss\n    caps   M\n    budget { tokens: 1000, time: 1h, spend: 1 USD, steps: 10, agents: 2 }\n  }\n{\n  plan A.write(\"x\") within envelope\n}\n";
    let r = checked(program, None);
    assert_eq!(found(&r), ["MDT-E1910 at /defs/W/owner"]);
    let (message, facts) = one(&r, "MDT-E1910");
    assert_eq!(
        message,
        "Workflow W has an envelope and an owner (boss): its envelope's owner approves it and signs its promotions. Take the owner line away, or name the role as the envelope's owner (spec/attention.md \"owner\")."
    );
    assert_eq!(
        facts,
        r#"{"workflow":"W","problem":"with_envelope","owner":"boss"}"#
    );
    // Without the owner line it checks.
    let without = program.replace("  owner boss\n  envelope", "  envelope");
    assert_eq!(found(&checked(&without, None)), Vec::<String>::new());
}

#[test]
fn with_the_promotion_ladder_every_workflow_has_an_owner_or_an_envelope() {
    let t = text();
    // The written-out workflow without its owner.
    let written = t.replace("  owner   accountant\n", "");
    let r = checked(&written, Some(&lock()));
    assert_eq!(found(&r), ["MDT-E1910 at /defs/Describe"]);
    let (message, facts) = one(&r, "MDT-E1910");
    assert_eq!(
        message,
        "The lock asks for the promotion ladder (promotion: \"required\"), and workflow Describe has neither an owner nor an envelope, so nobody could promote it. Name the role that promotes it: owner <role> (spec/attention.md \"owner\", \"Promotion\")."
    );
    assert_eq!(facts, r#"{"workflow":"Describe","problem":"no_owner"}"#);
    // The application without its owner: at the application's workflow, not
    // at its expansion.
    let applied = t.replace("  owner   finance_lead\n", "");
    let r = checked(&applied, Some(&lock()));
    assert_eq!(found(&r), ["MDT-E1910 at /defs/Check"]);
    // Without `promotion` in the lock there is no ladder, and nobody is
    // needed; nor without a lock.
    let no_ladder = lock_with("promotion", None);
    assert_eq!(
        found(&checked(&written, Some(&no_ladder))),
        Vec::<String>::new()
    );
    assert_eq!(found(&checked(&written, None)), Vec::<String>::new());
    // A lock of an older format has no ladder either.
    let older = json(
        &mandate_ir::stringify(&mandate_ir::JsValue::from(&lock_with("promotion", None)))
            .unwrap()
            .replace("mandate/lock/0.7", "mandate/lock/0.6")
            .replace(
                r#","role_classes":{"accountant":"confidential","finance_lead":"confidential"}"#,
                "",
            ),
    );
    assert!(
        validate_lock(&older).is_empty(),
        "{:?}",
        validate_lock(&older)
    );
    assert_eq!(
        found(&checked(&written, Some(&older))),
        Vec::<String>::new()
    );
}

/// A program of 0.7 with one workflow under an envelope, nothing of 0.7 in
/// it, so that it reads as 0.6 too.
const ENVELOPED: &str = "mandate @ 0.7\n\nmodule example.enveloped @ 0.1\n\nuse std.{model}\n\nrole accountant \"Accountant\"\n\ncapability M = model.infer(tier: standard)\n\nagent A {\n  role   \"Writes.\"\n  caps   M\n  budget { steps: 2 }\n  skill write(t: Text) -> Inferred<Text> ! {Model}\n}\n\nworkflow W() -> Inferred<Text>\n  envelope {\n    owner  accountant\n    caps   M\n    budget { tokens: 1000, time: 1h, spend: 1 USD, steps: 10, agents: 2 }\n  }\n{\n  plan A.write(\"x\") within envelope\n}\n";

#[test]
fn a_lock_field_of_0_7_with_an_older_program_is_e1911() {
    let l = lock();
    assert_eq!(found(&checked(ENVELOPED, Some(&l))), Vec::<String>::new());
    let as_0_6 = ENVELOPED.replace("mandate @ 0.7", "mandate @ 0.6");
    let r = checked(&as_0_6, Some(&l));
    assert_eq!(
        found(&r),
        ["MDT-E1911 at /role_classes", "MDT-E1911 at /promotion"]
    );
    let messages: Vec<&str> = r.diagnostics.iter().map(|d| d.message.as_str()).collect();
    assert_eq!(
        messages,
        [
            "Lock field role_classes applies to a program of mandate/0.7 or later. This program is mandate/0.6: its runs mask nothing for a role, so role_classes would not apply. Write the program in mandate/0.7, or take role_classes out of the lock.",
            "Lock field promotion applies to a program of mandate/0.7 or later. This program is mandate/0.6: its runs climb no promotion ladder, so promotion would not apply. Write the program in mandate/0.7, or take promotion out of the lock.",
        ]
    );
    assert_eq!(
        one(&r, "MDT-E1911").1,
        r#"{"field":"role_classes","language":"mandate/0.6"}"#
    );
    // One field alone, one diagnostic; a 0.7 lock with neither is taken.
    let r = checked(&as_0_6, Some(&lock_with("promotion", None)));
    assert_eq!(found(&r), ["MDT-E1911 at /role_classes"]);
    let r = checked(&as_0_6, Some(&lock_with("role_classes", None)));
    assert_eq!(found(&r), ["MDT-E1911 at /promotion"]);
    let neither = lock_with("role_classes", None);
    let mut neither = neither.as_object().cloned().unwrap();
    neither.remove("promotion");
    assert_eq!(
        found(&checked(&as_0_6, Some(&Value::Object(neither)))),
        Vec::<String>::new()
    );
    // A program of 0.5 too.
    let as_0_5 = ENVELOPED.replace("mandate @ 0.7", "mandate @ 0.5");
    let r = checked(&as_0_5, Some(&l));
    assert_eq!(
        found(&r),
        ["MDT-E1911 at /role_classes", "MDT-E1911 at /promotion"]
    );
}

/// What `validate_lock` gives, as `code at path` lines.
fn lock_found(l: &Value) -> Vec<String> {
    validate_lock(l)
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

#[test]
fn the_lock_fields_of_0_7_are_held_to_their_schema_and_to_roles() {
    // In a lock of an older format each is refused at the root, as any
    // field that format does not have.
    for older in ["mandate/lock/0.6", "mandate/lock/0.5", "mandate/lock/0.4"] {
        for (field, value) in [
            ("role_classes", r#"{"accountant":"confidential"}"#),
            ("promotion", r#""required""#),
        ] {
            let mut l = lock().as_object().cloned().unwrap();
            l.remove("role_classes");
            l.remove("promotion");
            l.insert("lock", older);
            assert!(
                validate_lock(&Value::Object(l.clone())).is_empty(),
                "{older} without them"
            );
            l.insert(field, json(value));
            let d = validate_lock(&Value::Object(l));
            assert!(
                !d.is_empty() && d.iter().all(|d| d.at.path.as_deref() == Some("")),
                "{older} {field}: {d:?}"
            );
            assert!(d[0].message.contains("must NOT have additional properties"));
        }
    }
    // A class that is none, a promotion that is not "required".
    assert_eq!(
        lock_found(&lock_with(
            "role_classes",
            Some(r#"{"accountant":"secret"}"#)
        )),
        ["MDT-E0140 at /role_classes/accountant"]
    );
    let not_a_name = lock_found(&lock_with(
        "role_classes",
        Some(r#"{"not a name":"public"}"#),
    ));
    assert!(
        !not_a_name.is_empty()
            && not_a_name
                .iter()
                .all(|l| l.starts_with("MDT-E0140 at /role_classes")),
        "{not_a_name:?}"
    );
    for bad in [r#""optional""#, "true", "null", r#"["required"]"#] {
        assert_eq!(
            lock_found(&lock_with("promotion", Some(bad))),
            ["MDT-E0140 at /promotion"],
            "{bad}"
        );
    }
    // A class for a role `roles` does not name.
    let l = lock_with(
        "role_classes",
        Some(r#"{"accountant":"confidential","auditor":"restricted"}"#),
    );
    assert_eq!(lock_found(&l), ["MDT-E0140 at /role_classes/auditor"]);
    let d = validate_lock(&l);
    assert_eq!(
        d[0].message,
        "Lock field role_classes gives a class to role auditor, which is not in roles."
    );
    // The check refuses such a lock as every lock its rules refuse.
    let r = checked(&text(), Some(&l));
    assert_eq!(found(&r), ["MDT-E0140 at /role_classes/auditor"]);
    // `roles` and `members` read as before: an empty class list is taken.
    assert!(lock_found(&lock_with("role_classes", Some("{}"))).is_empty());
}

#[test]
fn a_role_s_class_is_its_entry_else_internal() {
    let l = lock();
    let view = Lock::of(&l);
    assert_eq!(view.role_class("accountant"), DataClass::Confidential);
    assert_eq!(view.role_class("finance_lead"), DataClass::Confidential);
    // A role the lock does not name, and every role of a lock without
    // `role_classes` (any older format among them).
    assert_eq!(view.role_class("auditor"), DataClass::Internal);
    let none = lock_with("role_classes", None);
    assert_eq!(
        Lock::of(&none).role_class("accountant"),
        DataClass::Internal
    );
    let older = json(r#"{"lock":"mandate/lock/0.5","modules":{}}"#);
    assert_eq!(
        Lock::of(&older).role_class("accountant"),
        DataClass::Internal
    );
    let public = lock_with("role_classes", Some(r#"{"accountant":"public"}"#));
    assert_eq!(
        Lock::of(&public).role_class("accountant"),
        DataClass::Public
    );
    let restricted = lock_with("role_classes", Some(r#"{"accountant":"restricted"}"#));
    assert_eq!(
        Lock::of(&restricted).role_class("accountant"),
        DataClass::Restricted
    );
    // A name that is an inherited member of an object is no role.
    assert_eq!(view.role_class("constructor"), DataClass::Internal);
    assert!(view.promotion_required());
    let no_ladder = lock_with("promotion", None);
    assert!(!Lock::of(&no_ladder).promotion_required());
    assert!(!Lock::of(&older).promotion_required());
}

#[test]
fn the_lock_fields_of_0_7_are_kept_by_what_writes_or_hashes_a_lock() {
    let l = lock();
    // The lock a package carries, without its format, and the package
    // hash: both fields kept, in the canonical order.
    let packaged = Value::Object(mandate_check::packaged_lock(Some(&l)));
    assert_eq!(
        packaged.get("promotion").and_then(Value::as_str),
        Some("required")
    );
    assert_eq!(
        packaged.get("role_classes"),
        l.get("role_classes"),
        "role_classes kept"
    );
    let c = canonicalize(&packaged);
    let at = |s: &str| c.find(s).unwrap();
    assert!(
        at("\"members\"") < at("\"promotion\"") && at("\"promotion\"") < at("\"role_classes\"")
    );
    let program = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    let hash = mandate_ir::package_hash(program, &packaged);
    let without = Value::Object(mandate_check::packaged_lock(Some(&lock_with(
        "promotion",
        None,
    ))));
    assert_ne!(hash, mandate_ir::package_hash(program, &without));
    // Read back from its canonical text, the same lock.
    assert_eq!(canonicalize(&json(&canonicalize(&l))), canonicalize(&l));
}

/// The governance changes from `before` to `after` (the fixture's text with
/// each replacement made), as `kind path: text`.
fn changes(before: &str, after: &str) -> Vec<String> {
    let b = load(before, SourceKind::Mdt).program.unwrap();
    let a = load(after, SourceKind::Mdt).program.unwrap();
    governance_changes(&b, &a, None)
        .iter()
        .map(|c| format!("{} {}: {}", c.kind.as_str(), c.path, c.text))
        .collect()
}

#[test]
fn a_change_of_owner_is_a_change_of_who_approves() {
    let t = text();
    let other = t.replace("owner   accountant", "owner   finance_lead");
    assert_eq!(
        changes(&t, &other),
        ["owner_changed /defs/Describe/owner: ~ Describe.owner: accountant → finance_lead"]
    );
    let gone = t.replace("  owner   accountant\n", "");
    assert_eq!(
        changes(&t, &gone),
        ["owner_changed /defs/Describe/owner: ~ Describe.owner: accountant → nobody"]
    );
    assert_eq!(
        changes(&gone, &t),
        ["owner_changed /defs/Describe/owner: ~ Describe.owner: nobody → accountant"]
    );
    // The application's, beside what its application is.
    let applied = t.replace("owner   finance_lead", "owner   accountant");
    assert_eq!(
        changes(&t, &applied),
        ["owner_changed /defs/Check/owner: ~ Check.owner: finance_lead → accountant"]
    );
    // A new workflow with an owner: who approves it is new too.
    let before = t.replace(
        "workflow Describe(name: Text) -> Inferred<Text>",
        "workflow Describe2(name: Text) -> Inferred<Text>",
    );
    let found = changes(&before, &t);
    assert!(
        found.contains(
            &"owner_changed /defs/Describe/owner: + Describe: owner accountant".to_owned()
        ),
        "{found:?}"
    );
    // The same program: nothing.
    assert!(changes(&t, &t).is_empty());
}

#[test]
fn a_library_whose_workflow_names_another_owner_widens() {
    let module = |owner: &str| {
        let text = format!(
            "mandate @ 0.7\n\nmodule acme.flows @ 0.1\n\nuse std.{{model}}\n\npub role accountant \"Accountant\"\npub role finance_lead \"Finance lead\"\n\ncapability M = model.infer(tier: standard)\n\nagent A {{\n  role   \"Writes.\"\n  caps   M\n  budget {{ steps: 2 }}\n  skill write(t: Text) -> Inferred<Text> ! {{Model}}\n}}\n\npub workflow W(t: Text) -> Inferred<Text>\n  owner {owner}\n  caps  M\n  budget {{ steps: 4 }}\n{{\n  delegate A.write(t)\n}}\n"
        );
        let l = load(&text, SourceKind::Mdt);
        assert!(l.diagnostics.is_empty(), "{:?}", l.diagnostics);
        let mut m = Modules::new();
        m.insert("acme.flows", l.program.unwrap());
        m
    };
    let sig = |m: &Modules| {
        let reach = mandate_check::modules::reach_of_modules(m);
        mandate_check::library::signature::signature(m, m, &reach)
    };
    let old = sig(&module("accountant"));
    let entry = mandate_ir::stringify(&mandate_ir::JsValue::Object(old.to_js())).unwrap();
    assert!(entry.contains("\"accountant\""), "{entry}");
    let new = sig(&module("finance_lead"));
    let w = mandate_check::library::signature::widenings(&old, &new);
    assert!(
        w.iter().any(|w| w.text.contains("finance_lead")),
        "{:?}",
        w.iter().map(|w| w.text.clone()).collect::<Vec<_>>()
    );
    assert!(
        mandate_check::library::signature::widenings(&old, &sig(&module("accountant"))).is_empty()
    );
}

#[test]
fn the_typing_leaves_each_report_field_s_role_and_each_question_s() {
    let t = text();
    let opts = CheckOptions {
        lock: Some(&lock()),
        ..CheckOptions::default()
    };
    let describe = attention_facts(&t, SourceKind::Mdt, &opts, "Describe").unwrap();
    let field = &describe.reports[0].fields[0];
    assert_eq!(field.shown.role, "accountant");
    assert_eq!(describe.reports[0].role, "accountant");
    // The application's report goes to the role the application binds.
    let check_wf = attention_facts(&t, SourceKind::Mdt, &opts, "Check").unwrap();
    assert_eq!(check_wf.reports[0].fields[0].shown.role, "accountant");
    let q = &check_wf.bound.questions[0];
    assert_eq!(q.role.as_deref(), Some("accountant"));
    assert_eq!(q.kind.as_str(), "ask");
}

/// What the diff of the fixture with itself gives with `before` and
/// `after` as its locks: its governance lines, its behavior lines, and
/// whether it says no authority was added.
fn lock_changes(before: &Value, after: &Value) -> (Vec<String>, Vec<String>, bool) {
    let p = load(&text(), SourceKind::Mdt).program.unwrap();
    let d = mandate_check::semantic_diff(
        &p,
        &p,
        Some(mandate_check::Locks {
            before: Some(before),
            after: Some(after),
        }),
    );
    let lines = |c: &[mandate_check::Change]| {
        c.iter()
            .map(|c| format!("{} {}", c.path, c.text))
            .collect::<Vec<_>>()
    };
    (
        lines(&d.governance),
        lines(&d.behavior),
        d.unchanged.iter().any(|u| u == "no authority added"),
    )
}

/// The one line of a diff, as text.
fn line(s: &str) -> Vec<String> {
    vec![s.to_owned()]
}

#[test]
fn the_diff_of_two_locks_reads_their_role_classes_and_promotion() {
    let l = lock();
    let classes = |c: &str| lock_with("role_classes", Some(c));
    let none: Vec<String> = Vec::new();
    // The same lock: nothing.
    assert_eq!(lock_changes(&l, &l), (none.clone(), none.clone(), true));
    // A class raised: governance, and authority added.
    let raised = classes(r#"{"accountant":"restricted","finance_lead":"confidential"}"#);
    assert_eq!(
        lock_changes(&l, &raised),
        (
            line(
                "/role_classes/accountant ~ the data class role accountant may be shown, in effect: confidential → restricted (raised)"
            ),
            none.clone(),
            false
        )
    );
    // Lowered: behavior.
    assert_eq!(
        lock_changes(&raised, &l),
        (
            none.clone(),
            line(
                "/role_classes/accountant ~ the data class role accountant may be shown, in effect: restricted → confidential (lowered)"
            ),
            true
        )
    );
    // An entry taken away is read as `internal`: from above it, lowered;
    // from below it, raised.
    let without = classes(r#"{"finance_lead":"confidential"}"#);
    assert_eq!(
        lock_changes(&l, &without).1,
        line(
            "/role_classes/accountant ~ the data class role accountant may be shown, in effect: confidential → internal (lowered)"
        )
    );
    let public = classes(r#"{"accountant":"public","finance_lead":"confidential"}"#);
    assert_eq!(
        lock_changes(&public, &without).0,
        line(
            "/role_classes/accountant ~ the data class role accountant may be shown, in effect: public → internal (raised)"
        )
    );
    // An entry added below `internal` lowers; one added above raises.
    assert_eq!(
        lock_changes(&without, &public).1,
        line(
            "/role_classes/accountant ~ the data class role accountant may be shown, in effect: internal → public (lowered)"
        )
    );
    assert_eq!(
        lock_changes(&without, &l).0,
        line(
            "/role_classes/accountant ~ the data class role accountant may be shown, in effect: internal → confidential (raised)"
        )
    );
    // An entry `internal` added or taken away leaves the class in effect as
    // it was: no change; nor is a whole `role_classes` taken away whose
    // entries were all `internal`.
    let internal = classes(r#"{"accountant":"internal","finance_lead":"confidential"}"#);
    assert_eq!(
        lock_changes(&without, &internal),
        (none.clone(), none.clone(), true)
    );
    assert_eq!(
        lock_changes(&internal, &without),
        (none.clone(), none.clone(), true)
    );
    let all_internal = classes(r#"{"accountant":"internal"}"#);
    assert_eq!(
        lock_changes(&all_internal, &lock_with("role_classes", None)),
        (none.clone(), none.clone(), true)
    );
    // `promotion` taken away: governance; added: behavior.
    let no_ladder = lock_with("promotion", None);
    assert_eq!(
        lock_changes(&l, &no_ladder),
        (
            line(
                "/promotion - promotion: required (a run of read_only or live needs no promotion)"
            ),
            none.clone(),
            true
        )
    );
    assert_eq!(
        lock_changes(&no_ladder, &l),
        (
            none.clone(),
            line("/promotion + promotion: required (a run of read_only or live needs a promotion)"),
            true
        )
    );
    // Both at once, in that order: the classes, then the ladder.
    let mut both = no_ladder.as_object().cloned().unwrap();
    both.insert(
        "role_classes",
        json(r#"{"accountant":"restricted","finance_lead":"confidential"}"#),
    );
    assert_eq!(
        lock_changes(&l, &Value::Object(both)).0,
        [
            "/role_classes/accountant ~ the data class role accountant may be shown, in effect: confidential → restricted (raised)",
            "/promotion - promotion: required (a run of read_only or live needs no promotion)"
        ]
    );
}

/// `l` as a lock of 0.7 with the accountant `confidential` and the ladder.
fn as_lock_0_7(l: &Value) -> Value {
    let mut m = l.as_object().cloned().unwrap();
    m.insert("lock", "mandate/lock/0.7");
    m.insert("role_classes", json(r#"{"accountant":"confidential"}"#));
    m.insert("promotion", "required");
    Value::Object(m)
}

#[test]
fn the_diff_of_two_older_locks_is_what_it_was() {
    // Two locks of 0.6 that differ in what 0.6 has: what they ask of the
    // host, and nothing of 0.7.
    let older = |extra: &str| {
        json(&format!(
            r#"{{"lock":"mandate/lock/0.6","modules":{{}},"members":{{"ana":{{"keys":["sha256:{}"]}}}},"roles":{{"accountant":["ana"]}}{extra}}}"#,
            "6".repeat(64)
        ))
    };
    let none: Vec<String> = Vec::new();
    let (b, a) = (older(""), older(r#","host":{"node":"22"}"#));
    assert_eq!(
        lock_changes(&b, &a),
        (
            none.clone(),
            line("/host/node ~ host.node: no minimum → 22 (raised)"),
            true
        )
    );
    assert_eq!(
        lock_changes(&a, &b).0,
        line("/host/node ~ host.node: 22 → no minimum (lowered)")
    );
    assert_eq!(lock_changes(&b, &b), (none.clone(), none, true));
    // A lock of 0.6 against one of 0.7 that adds the two fields: what they
    // add, read as from nothing (every role `internal`, no ladder).
    let (g, beh, _) = lock_changes(&b, &as_lock_0_7(&b));
    assert_eq!(
        g,
        line(
            "/role_classes/accountant ~ the data class role accountant may be shown, in effect: internal → confidential (raised)"
        )
    );
    assert_eq!(
        beh,
        line("/promotion + promotion: required (a run of read_only or live needs a promotion)")
    );
}

#[test]
fn an_application_with_an_envelope_is_told_it_has_one_not_that_its_owner_does() {
    let t = text().replace(
        "  owner   finance_lead\n  caps    ModelStd\n  budget  { time: 10m, steps: 6 }",
        "  owner   finance_lead\n  envelope {\n    owner  finance_lead\n    caps   ModelStd\n    budget { steps: 6, agents: 1 }\n  }",
    );
    assert_ne!(t, text());
    let r = checked(&t, None);
    assert_eq!(found(&r), ["MDT-E1307 at /defs/Check/envelope"]);
}

#[test]
fn a_diagnostic_at_the_owner_points_at_the_role_s_name() {
    let t = text().replace("owner   accountant", "owner   acountant");
    let r = checked(&t, None);
    let d = r
        .diagnostics
        .iter()
        .find(|d| d.code == "MDT-E1501")
        .unwrap();
    let span = d.at.span.unwrap();
    let line = t
        .lines()
        .position(|l| l.contains("owner   acountant"))
        .unwrap();
    let line = line + 1;
    assert_eq!((span.start_line, span.end_line), (line, line));
    assert_eq!((span.start_col, span.end_col), (11, 20));
    // The source map has it at the owner's pointer; an envelope's owner
    // keeps the envelope's span, as before.
    let l = load(&text(), SourceKind::Mdt);
    assert!(l.spans.get("/defs/Describe/owner").is_some());
    assert!(l.spans.get("/defs/Check/owner").is_some());
    let e = load(ENVELOPED, SourceKind::Mdt);
    assert!(e.spans.get("/defs/W/envelope/owner").is_none());
    assert!(e.spans.get("/defs/W/envelope").is_some());
}
