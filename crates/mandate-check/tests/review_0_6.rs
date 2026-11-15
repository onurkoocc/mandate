//! `human.review`, waivers and the batch commit step (language 0.6,
//! spec/library.md "`human.review` and waivers", "The batch commit step"),
//! where a conformance case cannot say it: what a review's value is typed as
//! (its accepted items verified, its declined ones never), the ways a value
//! a waiver may rest on is held from an irreversible effect besides the
//! cases', the semantic diff's kinds of a waiver, and a program of 0.5 that
//! reads as it always did. No TypeScript reads 0.6, so every expectation is
//! written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{
    CheckOptions, ModuleSource, Modules, check, governance_changes, load_modules, role_sites,
    role_sites_of, roles_named, semantic_diff,
};
use mandate_ir::{JsValue, Language, Value};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;

const REVIEW: &str = "conformance/H06/program.mdt";
const RELEASE: &str = "conformance/E1505/program.mdt";
const COMMIT: &str = "conformance/E1708b/program.mdt";
const FIXTURE: &str = "fixtures/library/review.mdt";

/// The two modules of the acme.connectors fixture, loaded.
fn connectors() -> Modules {
    let texts: Vec<(String, String)> = [
        "fixtures/library/acme.connectors/types.mdt",
        "fixtures/library/acme.connectors/connectors.mdt",
    ]
    .iter()
    .map(|f| ((*f).to_owned(), read_text(f).unwrap()))
    .collect();
    let sources: Vec<ModuleSource<'_>> = texts
        .iter()
        .map(|(file, text)| ModuleSource {
            text,
            kind: SourceKind::Mdt,
            file,
        })
        .collect();
    let r = load_modules(&sources);
    assert!(r.problems.is_empty(), "{:?}", r.problems);
    r.modules
}

/// Every diagnostic of `text` checked with `modules` but the warnings W0601
/// (a static criterion checked at run time), which every program here has.
fn diagnostics(text: &str, modules: Option<&Modules>) -> Vec<mandate_ir::Diagnostic> {
    let r = check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            modules,
            ..CheckOptions::default()
        },
    );
    r.diagnostics
        .into_iter()
        .filter(|d| d.code != "MDT-W0601")
        .collect()
}

/// `code at path` of each of [`diagnostics`].
fn checked(text: &str) -> Vec<String> {
    diagnostics(text, None)
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// A fact of a diagnostic, as text.
fn fact(d: &mandate_ir::Diagnostic, key: &str) -> Option<String> {
    let v = d.facts.as_ref()?.get(key)?;
    match v {
        JsValue::String(s) => Some(s.clone()),
        other => mandate_ir::stringify(other),
    }
}

/// `text` with `from` replaced by `to`, which it holds once.
fn changed(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from}");
    text.replacen(from, to, 1)
}

/// The workflow of the review program with `body` for its body, after the
/// review (`reviewed` is in scope, and `checked`, `items`).
fn after_review(body: &str) -> String {
    let text = read_text(REVIEW).unwrap();
    changed(
        &text,
        "  Batch { posted: posted, declined: reviewed.declined, failed: reviewed.failed }\n",
        &format!(
            "{body}\n  Batch {{ posted: posted, declined: reviewed.declined, failed: reviewed.failed }}\n"
        ),
    )
}

#[test]
fn the_review_programs_check() {
    assert_eq!(checked(&read_text(REVIEW).unwrap()), Vec::<String>::new());
    assert_eq!(checked(&read_text(RELEASE).unwrap()), Vec::<String>::new());
    assert_eq!(checked(&read_text(COMMIT).unwrap()), Vec::<String>::new());
    let m = connectors();
    assert!(diagnostics(&read_text(FIXTURE).unwrap(), Some(&m)).is_empty());
}

/// A review's `accepted` items are `Verified<T, C>`: they go where a value
/// verified against `C` is required. Its declined items' values are a
/// model's output, `Inferred<T>`, never verified: not where a verified value
/// or a plain one is required. `failed` is a list of indices, and `by` an
/// optional text.
#[test]
fn a_reviews_accepted_items_are_verified_and_its_declined_ones_never() {
    let text = read_text(REVIEW).unwrap();
    // A function that takes what only `Matched` verifies.
    let with_fns = changed(
        &text,
        "/// A match names",
        "fn strict(m: Verified<Match, Matched>) -> Text ! {} {\n  m.invoice_no\n}\n\nfn plain(m: Match) -> Text ! {} {\n  m.invoice_no\n}\n\nfn index(i: Int) -> Int ! {} {\n  i\n}\n\nfn who(by: Option<Text>) -> Int ! {} {\n  1\n}\n\n/// A match names",
    );
    let body = |b: &str| {
        changed(
            &with_fns,
            "  Batch { posted: posted, declined: reviewed.declined, failed: reviewed.failed }\n",
            &format!(
                "{b}\n  Batch {{ posted: posted, declined: reviewed.declined, failed: reviewed.failed }}\n"
            ),
        )
    };
    let ok = body(
        "  let names = map a in reviewed.accepted max 60 {\n    strict(a)\n  }\n  let indices = map f in reviewed.failed max 60 {\n    index(f)\n  }\n  let deciders = map d in reviewed.declined max 60 {\n    who(d.by)\n  }",
    );
    assert_eq!(checked(&ok), Vec::<String>::new());
    // A declined item's value: not verified, not plain.
    let to_strict =
        body("  let names = map d in reviewed.declined max 60 {\n    strict(d.value)\n  }");
    assert_eq!(
        checked(&to_strict),
        ["MDT-E0210 at /defs/MatchAll/body/4/value/body/0/value/args/0/value"]
    );
    let to_plain =
        body("  let names = map d in reviewed.declined max 60 {\n    plain(d.value)\n  }");
    assert_eq!(
        checked(&to_plain),
        ["MDT-E0210 at /defs/MatchAll/body/4/value/body/0/value/args/0/value"]
    );
    // Nor is it committed: the write tool takes a verified match.
    let posted = body(
        "  let again = map d in reviewed.declined max 60 {\n    effect erp.post_draft(d.value) idempotent_by d.value.invoice_no\n  }",
    );
    assert_eq!(
        checked(&posted),
        ["MDT-E0210 at /defs/MatchAll/body/4/value/body/0/value/args/0/value"]
    );
    // A failed item is an index, not a match.
    let failed = body("  let names = map f in reviewed.failed max 60 {\n    plain(f)\n  }");
    assert_eq!(
        checked(&failed),
        ["MDT-E0201 at /defs/MatchAll/body/4/value/body/0/value/args/0/value"]
    );
    // A field a review has not.
    let unknown = body("  let x = reviewed.waived");
    let d = diagnostics(&unknown, None);
    assert_eq!(d.len(), 1);
    assert_eq!(d[0].code, "MDT-E0202");
    assert_eq!(
        fact(&d[0], "fields").as_deref(),
        Some(r#"["accepted","declined","failed"]"#)
    );
    assert_eq!(
        fact(&d[0], "type").as_deref(),
        Some("Review<Match, Matched>")
    );
}

/// When the source map verified untrusted content, a declined item stays
/// untrusted: its review is `Review<Untrusted<T>, C>`, whose accepted items
/// are still `Verified<T, C>`.
#[test]
fn a_declined_item_of_untrusted_content_stays_untrusted() {
    let text = read_text(REVIEW).unwrap();
    let text = changed(
        &text,
        "  accept vendor \"The invoice's vendor is the order's vendor\"\n    by static inv.vendor_id == m.order.vendor_id\n",
        "",
    );
    // A contract over the invoice alone, and a map that verifies the invoice.
    let text = changed(
        &text,
        "/// A match names",
        "contract Small(inv: Invoice) {\n  accept small \"The total is small\"\n    by static inv.total_cents < 100000\n    waive by accountant, finance_lead\n}\n\nagent Reader {\n  role   \"Reads one invoice.\"\n  caps   ModelStd\n  budget { tokens: 1k, steps: 1 }\n  skill read(inv: Inferred<Invoice>) -> Inferred<Text> ! {Model}\n}\n\nfn total(inv: Verified<Invoice, Small>) -> Int ! {} {\n  inv.total_cents\n}\n\n/// A match names",
    );
    let body = |b: &str| {
        changed(
            &text,
            "  Batch { posted: posted, declined: reviewed.declined, failed: reviewed.failed }\n",
            &format!(
                "  let small = map inv in items max 60 {{\n    verify inv against Small(inv)\n  }}\n  let looked = human.review(small, role: accountant, deadline: 1d)\n{b}\n  Batch {{ posted: posted, declined: reviewed.declined, failed: reviewed.failed }}\n"
            ),
        )
    };
    assert_eq!(
        checked(&body(
            "  let totals = map a in looked.accepted max 60 {\n    total(a)\n  }"
        )),
        Vec::<String>::new()
    );
    // An untrusted value is not where a model's output is expected.
    let read = body(
        "  let read = map d in looked.declined max 60 {\n    delegate Reader.read(d.value)\n  }",
    );
    assert_eq!(
        checked(&read),
        ["MDT-E0211 at /defs/MatchAll/body/6/value/body/0/value/args/0/value"]
    );
    // Its type says so, and a declared type cannot say otherwise.
    let typed = body("  let d: List<Declined<Invoice>> = looked.declined");
    assert_eq!(
        checked(&typed),
        ["MDT-E0211 at /defs/MatchAll/body/6/value"]
    );
    let typed = body("  let r: Review<Invoice, Small> = looked");
    assert_eq!(
        checked(&typed),
        ["MDT-E0211 at /defs/MatchAll/body/6/value"]
    );
    let typed = body("  let r: Review<Untrusted<Invoice>, Small> = looked");
    assert_eq!(checked(&typed), Vec::<String>::new());
}

/// `Review` and `Declined` are built-in types of a program of 0.6, which only
/// the runtime makes; `Review`'s second argument is a contract. In an
/// earlier program they name nothing.
#[test]
fn review_and_declined_are_built_in_types_the_runtime_alone_makes() {
    let made = after_review(
        "  let forged = Review { accepted: reviewed.accepted, declined: reviewed.declined, failed: reviewed.failed }",
    );
    assert_eq!(
        checked(&made),
        ["MDT-E0213 at /defs/MatchAll/body/4/value/type"]
    );
    let made = after_review(
        "  let forged = Declined { index: 0, value: peek(items), unmet: [], by: \"me\" }",
    );
    let codes: Vec<String> = checked(&made);
    assert_eq!(
        codes.first().map(String::as_str),
        Some("MDT-E0213 at /defs/MatchAll/body/4/value/type")
    );
    let inferred = after_review("  let forged = infer Review<Match, Matched> from items");
    assert_eq!(
        checked(&inferred),
        ["MDT-E0213 at /defs/MatchAll/body/4/value/type"]
    );
    // The contract of a Review is a contract.
    let text = read_text(REVIEW).unwrap();
    let not_a_contract = changed(
        &text,
        "declined: List<Declined<Match>>",
        "declined: List<Declined<Match>>, last: Review<Match, Order>",
    );
    assert_eq!(
        checked(&not_a_contract),
        ["MDT-E0120 at /defs/Batch/type/record/last/args/1/ref"]
    );
    // Before 0.6 neither is a type.
    let old =
        "mandate @ 0.5\n\nmodule m @ 0.1\n\ntype T = { r: Review<Int, Int>, d: Declined<Int> }\n";
    let codes = checked(old);
    assert_eq!(
        codes,
        [
            "MDT-E0120 at /defs/T/type/record/r/ref",
            "MDT-E0120 at /defs/T/type/record/d/ref"
        ]
    );
}

/// No effect's adapter makes a review either, and a call written
/// `human.review(…)` is held to a review's rules wherever `human` stands for
/// something else.
#[test]
fn no_review_comes_from_elsewhere() {
    let text = read_text(REVIEW).unwrap();
    let effect = changed(
        &text,
        "/// A match names",
        "effect fetch_review(key: Text) -> Review<Match, Matched>\n  critical\n  idempotency required\n\n/// A match names",
    );
    assert_eq!(
        checked(&effect),
        ["MDT-E0213 at /defs/fetch_review/returns"]
    );
    // With `human` a variable, the call is still a review: its role is held
    // to the contract's waivers, and in a map's body it waits for a person.
    let shadowed = after_review(
        "  let human = items\n  let again = human.review(checked, role: controller, deadline: 1d)",
    );
    assert_eq!(
        checked(&shadowed),
        ["MDT-E1508 at /defs/MatchAll/body/5/value/args/1/value"]
    );
    let in_map = after_review(
        "  let human = items\n  let again = map x in items max 2 {\n    human.review(checked, role: accountant, deadline: 1d)\n  }",
    );
    assert_eq!(
        checked(&in_map),
        ["MDT-E1708 at /defs/MatchAll/body/5/value/body/0/value"]
    );
}

/// The arguments a review may take in other forms than the cases': no
/// `escalate_to`, a role as a text, a deadline as a constant.
#[test]
fn a_review_takes_its_arguments_as_a_role_is_named_elsewhere() {
    let text = read_text(REVIEW).unwrap();
    for (from, to) in [
        (", escalate_to: finance_lead)", ")"),
        ("role: accountant", "role: \"accountant\""),
        ("deadline: 1d", "deadline: WAIT"),
    ] {
        let t = changed(&text, from, to);
        let t = changed(
            &t,
            "/// A match names",
            "let WAIT: Duration = 1d\n\n/// A match names",
        );
        assert_eq!(checked(&t), Vec::<String>::new(), "{to}");
    }
    // A variable that holds a role's name is no role, whatever it holds.
    let t = changed(
        &text,
        "  let reviewed = human.review(checked, role: accountant,",
        "  let accountant = \"accountant\"\n  let reviewed = human.review(checked, role: accountant,",
    );
    let d = diagnostics(&t, None);
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!(d[0].code, "MDT-E1507");
    assert_eq!(fact(&d[0], "problem").as_deref(), Some("not_a_role"));
}

/// A review's source map that returns ends an item with what is not its
/// verify (E1506, `returns`).
#[test]
fn a_review_of_a_map_that_returns_is_refused() {
    let text = read_text(REVIEW).unwrap();
    let t = changed(
        &text,
        "    let out = delegate Matcher.match(it)\n",
        "    let out = delegate Matcher.match(it)\n    if false {\n      return Batch { posted: [], declined: [], failed: [] }\n    }\n",
    );
    let d = diagnostics(&t, None);
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!(d[0].code, "MDT-E1506");
    assert_eq!(fact(&d[0], "problem").as_deref(), Some("returns"));
}

/// The roles a waiver names are role definitions (E1501), places a program of
/// 0.6 names a role, which the lock's E1502 reads too; `role_sites` and
/// `roles_named`, the TypeScript's doors, do not list them.
#[test]
fn a_waivers_roles_are_roles() {
    let text = read_text(REVIEW).unwrap();
    let t = changed(
        &text,
        "waive by accountant, finance_lead",
        "waive by accountant, auditor",
    );
    let d = diagnostics(&t, None);
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!(d[0].code, "MDT-E1501");
    // The roles are a sorted set: `auditor` after `accountant`.
    assert_eq!(
        d[0].at.path.as_deref(),
        Some("/defs/Matched/accept/totals/waive/1")
    );
    assert_eq!(
        fact(&d[0], "where").as_deref(),
        Some("a criterion's waiver")
    );
    let program = load(&text, SourceKind::Mdt).program.unwrap();
    let defs = program.get("defs").unwrap().as_object().unwrap();
    assert!(
        role_sites(defs)
            .iter()
            .all(|s| s.r#where != "a criterion's waiver")
    );
    assert!(roles_named(defs).is_empty());
    let sites: Vec<(String, String)> = role_sites_of(defs, Some(Language::V0_6))
        .into_iter()
        .filter(|s| s.r#where == "a criterion's waiver")
        .map(|s| (s.role.unwrap_or_default(), s.path))
        .collect();
    assert_eq!(
        sites,
        [
            (
                "accountant".to_owned(),
                "/defs/Matched/accept/totals/waive/0".to_owned()
            ),
            (
                "finance_lead".to_owned(),
                "/defs/Matched/accept/totals/waive/1".to_owned()
            )
        ]
    );
}

/// What a value's type says it was verified against is held as what it
/// rests on: a parameter, a field of a record or a variant of a union whose
/// declared type names a contract with a waiver.
#[test]
fn a_waiver_a_type_names_is_held_by_the_type() {
    let text = read_text(RELEASE).unwrap();
    let with = |defs: &str, params: &str, arg: &str| {
        let t = changed(
            &text,
            "/// The change, as it was given.",
            &format!("{defs}\n\n/// The change, as it was given."),
        );
        let t = changed(
            &t,
            "workflow Ship(change: Change)",
            &format!("workflow Ship(change: Change{params})"),
        );
        changed(
            &t,
            "effect git.merge(same(named))",
            &format!("effect git.merge({arg})"),
        )
    };
    let at = "MDT-E1505 at /defs/Ship/body/3/value/args/0/value";
    assert_eq!(
        checked(&with("", ", given: Verified<Change, Small>", "given")),
        [at]
    );
    // An irreversible effect that takes the record, or the union.
    let effect = |t: &str| {
        format!(
            "effect ship_{t}(x: {t}) -> Receipt<Text>\n  requires caps git.pr(\"example/app\")\n  critical\n  irreversible\n  idempotency required"
        )
    };
    let tag = "MDT-E1505 at /defs/Ship/body/4/value/args/0/value";
    let ship = |defs: &str, params: &str, call: &str| {
        let t = with(defs, params, "same(named)");
        changed(&t, "effect tag_release(change.branch)", call)
    };
    assert_eq!(
        checked(&ship(
            &format!(
                "type Held = {{ c: Verified<Change, Small> }}\n\n{}",
                effect("Held")
            ),
            ", held: Held",
            "effect ship_Held(held)"
        )),
        [tag]
    );
    assert_eq!(
        checked(&ship(
            &format!(
                "type Either = Kept(c: Verified<Change, Small>) | Lost\n\n{}",
                effect("Either")
            ),
            ", either: Either",
            "effect ship_Either(either)"
        )),
        [tag]
    );
    // What names a contract without a waiver is not held.
    assert_eq!(
        checked(&with("", ", given: Verified<Change, Named>", "given")),
        Vec::<String>::new()
    );
}

/// A change set that commits an irreversible member: no argument of that
/// member, and not the set's plan, may rest on a waiver (E1505).
#[test]
fn a_change_sets_irreversible_member_takes_nothing_a_waiver_rests_on() {
    let text = read_text("conformance/E1708i/program.mdt").unwrap();
    // The change set after the map, as one action: it checks.
    let after = changed(
        &text,
        "  let landed = map t in tasks max 3 {\n    let plan = verify Plan { summary: t } against PlanAccepted(Plan { summary: t })\n    changeset(plan) {\n      member app = git.merge(plan)\n      order app\n      approve role \"architect\"\n    } idempotent_by t\n  }\n",
        "  let plan = verify Plan { summary: \"all\" } against PlanAccepted(Plan { summary: \"all\" })\n  let landed = changeset(plan) {\n    member app = git.merge(plan)\n    order app\n    approve role \"architect\"\n  } idempotent_by \"all\"\n",
    );
    assert_eq!(checked(&after), Vec::<String>::new());
    // The plan's contract with a waiver: both the member's argument and the
    // plan rest on it.
    let waived = changed(
        &after,
        "    by static len(plan.summary) >= 1\n",
        "    by static len(plan.summary) >= 1\n    waive by architect\n",
    );
    assert_eq!(
        checked(&waived),
        [
            "MDT-E1505 at /defs/LandAll/body/1/value/members/app/args/0/value",
            "MDT-E1505 at /defs/LandAll/body/1/value/plan"
        ]
    );
    // A member that can be undone takes it.
    let undone = changed(&waived, "git.merge(plan)", "git.open_pr(plan)");
    assert_eq!(checked(&undone), Vec::<String>::new());
}

/// A critical effect in a map's body with no `idempotent_by` key at all: the
/// key is missing (E0403) and so the commit step is refused (E1708, `key`).
#[test]
fn a_commit_step_without_a_key_is_refused_twice() {
    let text = read_text(COMMIT).unwrap();
    let t = changed(
        &text,
        "    effect file_draft(checked) idempotent_by d.invoice_no\n",
        "    effect file_draft(checked)\n",
    );
    let d = diagnostics(&t, None);
    let codes: Vec<&str> = d.iter().map(|d| d.code.as_str()).collect();
    assert_eq!(codes, ["MDT-E1708", "MDT-E0403"]);
    assert_eq!(fact(&d[0], "condition").as_deref(), Some("key"));
}

/// A program of 0.5 reads, checks and refuses as before: `waive` is no part
/// of a contract, a critical effect in a map's body is E1708 with the
/// message and facts of 0.4, and `human.review` is a call of a module the
/// checker does not describe.
#[test]
fn a_program_of_0_5_reads_as_before() {
    let text = read_text(COMMIT).unwrap();
    let old = changed(&text, "mandate @ 0.6", "mandate @ 0.5");
    // Without a connector, which 0.5 does not have, and with no doc lines.
    let old = old
        .lines()
        .filter(|l| !l.starts_with("///"))
        .collect::<Vec<_>>()
        .join("\n");
    let old = changed(
        &old,
        "connector erp = mcp(\"https://erp.example.com/mcp\")\n  version \"1.0\"\n  class   confidential\n{\n  tool find_draft(key: Text) -> Untrusted<Option<DraftId>>\n    read_only\n\n  tool post_draft(d: Verified<Draft>, key: Text) -> Receipt<DraftId>\n    critical\n    idempotency key key\n    retry_class reconcilable\n    reconcile by find_draft\n}\n\ncapability ErpDraft = tool.call(erp, post_draft)\n",
        "",
    );
    let old = changed(&old, "    caps   ErpDraft, Files\n", "    caps   Files\n");
    let old = changed(
        &old,
        "  let posted = map d in drafts max 20 {\n    let checked = verify d against Drafted(d)\n    effect erp.post_draft(checked) idempotent_by d.invoice_no\n  }\n",
        "",
    );
    let d = diagnostics(&old, None);
    assert_eq!(d.len(), 1, "{d:?}");
    assert_eq!(d[0].code, "MDT-E1708");
    assert_eq!(
        d[0].message,
        "The critical effect file_draft runs inside a map's body, where each item's would be authorized on its own. Run it after the map, or land a batch with a change set (spec/envelope.md \"map\")."
    );
    assert!(fact(&d[0], "condition").is_none());
    // The same text as 0.6 checks: a batch commit step.
    let new = changed(&old, "mandate @ 0.5", "mandate @ 0.6");
    assert!(diagnostics(&new, None).is_empty());
    // `waive by` in a contract of 0.5 does not read.
    let review = changed(
        &read_text(REVIEW).unwrap(),
        "mandate @ 0.6",
        "mandate @ 0.5",
    );
    let r = load(&review, SourceKind::Mdt);
    assert_eq!(
        r.diagnostics.first().map(|d| d.code.as_str()),
        Some("MDT-E0101")
    );
}

/// The semantic diff: a role that may now waive a criterion is a governance
/// change, `waiver_added`, and one that may no longer, `waiver_removed`; a
/// patch reports them with their kind.
#[test]
fn a_waiver_added_or_taken_away_is_a_governance_change() {
    let text = read_text(REVIEW).unwrap();
    let ir = |t: &str| load(t, SourceKind::Mdt).program.unwrap();
    let before = ir(&text);
    let kinds = |a: &Value, b: &Value| {
        governance_changes(a, b, None)
            .iter()
            .map(|c| format!("{} {} {}", c.kind.as_str(), c.path, c.text))
            .collect::<Vec<_>>()
    };
    let none = changed(&text, "    waive by accountant, finance_lead\n", "");
    let one = changed(
        &text,
        "waive by accountant, finance_lead",
        "waive by accountant",
    );
    let three = changed(
        &text,
        "waive by accountant, finance_lead",
        "waive by accountant, controller, finance_lead",
    );
    let other = changed(
        &text,
        "waive by accountant, finance_lead",
        "waive by controller",
    );
    let at = "/defs/Matched/accept/totals/waive";
    assert_eq!(
        kinds(&ir(&none), &before),
        [format!(
            "waiver_added {at} + Matched.totals: may be waived by accountant, finance_lead"
        )]
    );
    assert_eq!(
        kinds(&before, &ir(&none)),
        [format!(
            "waiver_removed {at} - Matched.totals: no longer waived by accountant, finance_lead"
        )]
    );
    assert_eq!(
        kinds(&ir(&one), &before),
        [format!(
            "waiver_added {at} + Matched.totals: may be waived by finance_lead"
        )]
    );
    assert_eq!(
        kinds(&before, &ir(&three)),
        [format!(
            "waiver_added {at} + Matched.totals: may be waived by controller"
        )]
    );
    assert_eq!(
        kinds(&before, &ir(&other)),
        [
            format!("waiver_added {at} + Matched.totals: may be waived by controller"),
            format!(
                "waiver_removed {at} - Matched.totals: no longer waived by accountant, finance_lead"
            )
        ]
    );
    // The diff shows them as governance changes, and authority added.
    let view = semantic_diff(&ir(&none), &before, None);
    let texts: Vec<&str> = view.governance.iter().map(|c| c.text.as_str()).collect();
    assert_eq!(
        texts,
        ["+ Matched.totals: may be waived by accountant, finance_lead"]
    );
    assert!(!view.unchanged.iter().any(|u| u == "no authority added"));
    // The same contract, its waiver unchanged: nothing.
    assert!(kinds(&before, &before).is_empty());
}
