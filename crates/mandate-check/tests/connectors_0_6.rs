//! Connectors and `tool.call` (language 0.6, spec/library.md "Connectors"),
//! where a conformance case cannot say it: a connector's tool is a member of
//! its definition (never a value, never an opaque call), the value of a
//! tool's call has its declared type and its connector's class, the four
//! run-time authority doors decide a `tool.call` by the predicates the static
//! checks use, and the semantic diff classifies a connector's changes. No
//! TypeScript reads 0.6, so every expectation is written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::caps::{
    CapOptions, CapVal, cap_covers, caps_of, tool_call_caps, writes_overlap,
};
use mandate_check::grant::{
    AuthorityContext, Capability, GrantDelegation, GrantInput, GrantOutput, InFlightOverlapInput,
    InFlightProgram, MapScopesInput, MapScopesOutput, NarrowInput, NarrowOutput, grant,
    in_flight_overlap, map_scopes, narrow,
};
use mandate_check::{
    CheckOptions, ModuleSource, Modules, check, governance_changes, link, load_modules,
};
use mandate_ir::{Expr, Language, Map, Program, Value};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::read_text;

const TYPES: &str = "fixtures/library/acme.connectors/types.mdt";
const CONNECTORS: &str = "fixtures/library/acme.connectors/connectors.mdt";
const DRAFTS: &str = "fixtures/library/drafts.mdt";
const OWN: &str = "conformance/T01/program.mdt";

/// The two modules of the acme.connectors fixture, loaded.
fn modules() -> Modules {
    let texts: Vec<(String, String)> = [TYPES, CONNECTORS]
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

/// `code at path` of each diagnostic of `text` checked with `modules`.
fn checked(text: &str, modules: Option<&Modules>) -> Vec<String> {
    let r = check(
        text,
        SourceKind::Mdt,
        &CheckOptions {
            modules,
            ..CheckOptions::default()
        },
    );
    r.diagnostics
        .iter()
        .filter(|d| d.code != "MDT-W0601")
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// `text` with `from` replaced by `to`, which it holds once.
fn changed(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "{from}");
    text.replacen(from, to, 1)
}

#[test]
fn the_fixture_and_the_case_program_check() {
    let m = modules();
    assert_eq!(
        checked(&read_text(DRAFTS).unwrap(), Some(&m)),
        Vec::<String>::new()
    );
    assert_eq!(
        checked(&read_text(OWN).unwrap(), None),
        Vec::<String>::new()
    );
}

/// A connector is a definition whose members are its tools: used as a
/// value, or with a member that is not a declared tool, or a tool named
/// without a call, it is refused at the name (E0120), for a connector of the
/// program's own and a listed one alike; a variable of the same name is the
/// variable.
#[test]
fn a_connector_is_no_value_and_its_members_are_its_declared_tools() {
    let m = modules();
    let drafts = read_text(DRAFTS).unwrap();
    let listed = [
        (
            "  let waiting = mailbox.list_invoices()",
            "  let waiting = mailbox",
            "MDT-E0120 at /defs/DraftOne/body/0/value",
        ),
        (
            "  let waiting = mailbox.list_invoices()",
            "  let waiting = mailbox.list_invoices",
            "MDT-E0120 at /defs/DraftOne/body/0/value",
        ),
        (
            "  let waiting = mailbox.list_invoices()",
            "  let waiting = mailbox.list_drafts()",
            "MDT-E0120 at /defs/DraftOne/body/0/value/callee/name",
        ),
        (
            "  let waiting = mailbox.list_invoices()",
            "  let waiting = mailbox.list_drafts",
            "MDT-E0120 at /defs/DraftOne/body/0/value",
        ),
        (
            "effect erp.post_draft_invoice(checked)",
            "effect erp.post_draft(checked)",
            "MDT-E0120 at /defs/DraftOne/body/4/value/name",
        ),
        (
            "effect erp.post_draft_invoice(checked)",
            "effect acme.connectors.erp.post_draft_invoice(checked)",
            "MDT-E0120 at /defs/DraftOne/body/4/value/name",
        ),
        (
            "  let waiting = mailbox.list_invoices()",
            "  let waiting = acme.connectors.mailbox.list_invoices()",
            "MDT-E0120 at /defs/DraftOne/body/0/value/callee/of/of/of",
        ),
    ];
    for (from, to, want) in listed {
        let got = checked(&changed(&drafts, from, to), Some(&m));
        assert_eq!(got, [want], "{to}");
    }
    let own = read_text(OWN).unwrap();
    for (to, want) in [
        (
            "  let orders = erp",
            "MDT-E0120 at /defs/Draft/body/0/value",
        ),
        (
            "  let orders = erp.list_orders",
            "MDT-E0120 at /defs/Draft/body/0/value",
        ),
        (
            "  let orders = erp.list_all(vendor_id)",
            "MDT-E0120 at /defs/Draft/body/0/value/callee/name",
        ),
        // The arguments of a tool's call are names of the program: an
        // unknown one is unknown, as in any call the compiler describes.
        (
            "  let orders = erp.list_orders(nobody)",
            "MDT-E0120 at /defs/Draft/body/0/value/args/0/value",
        ),
    ] {
        let got = checked(
            &changed(&own, "  let orders = erp.list_orders(vendor_id)", to),
            None,
        );
        assert_eq!(got, [want], "{to}");
    }
    // A variable named as the connector is the variable.
    let shadowed = changed(
        &drafts,
        "  let waiting = mailbox.list_invoices()",
        "  let mailbox = inv\n  let waiting = mailbox.vendor_id",
    );
    assert_eq!(
        checked(&shadowed, Some(&m)),
        ["MDT-W0310 at /defs/DraftOne/caps/2"]
    );
}

/// The value of a tool's call is its declared result, `Untrusted<T>` for a
/// read-only tool, of its connector's class: never an unknown type, so it is
/// held to a declared type and to a model's class like any value.
#[test]
fn a_tools_result_has_its_declared_type_and_its_connectors_class() {
    let own = read_text(OWN).unwrap();
    // Its type: a List of Orders, read from outside.
    let typed = changed(
        &own,
        "  let orders = erp.list_orders(vendor_id)",
        "  let orders: Int = erp.list_orders(vendor_id)",
    );
    let r = check(&typed, SourceKind::Mdt, &CheckOptions::default());
    let messages: Vec<String> = r
        .diagnostics
        .iter()
        .map(|d| format!("{} {}", d.code, d.message))
        .collect();
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert!(
        messages[0].contains("MDT-E0211") && messages[0].contains("Untrusted<List<Order>>"),
        "{messages:?}"
    );
    // Its class: confidential, the connector's, above what an internal
    // model may receive.
    let internal = changed(
        &own,
        "capability ModelAll = model.infer(tier: standard, max_class: restricted)",
        "capability ModelAll = model.infer(tier: standard, max_class: internal)",
    );
    let sent = changed(
        &internal,
        "  skill orders(vendor_id: Text) -> Inferred<Text> ! {Tool, Model}",
        "  skill orders(vendor_id: Text) -> Inferred<Text> ! {Tool, Model}\n  skill sum(orders: Untrusted<List<Order>>) -> Inferred<Text> ! {Model}",
    );
    let sent = changed(
        &sent,
        "  let summary = delegate Reader.orders(vendor_id)",
        "  let summary = delegate Reader.sum(orders)",
    );
    let r = check(&sent, SourceKind::Mdt, &CheckOptions::default());
    let found: Vec<(String, String)> = r
        .diagnostics
        .iter()
        .map(|d| {
            (
                d.code.clone(),
                d.facts
                    .as_ref()
                    .and_then(|f| f.get("data_class"))
                    .and_then(|c| c.as_str())
                    .unwrap_or_default()
                    .to_owned(),
            )
        })
        .collect();
    assert!(
        found.contains(&("MDT-E0220".to_owned(), "confidential".to_owned())),
        "{found:?}"
    );
}

/// A tool's place: a read-only tool in a skill's body, a contract and a
/// constant is E1405 too (the cases hold a `fn` and the two wrong forms).
#[test]
fn a_tool_is_called_in_a_workflows_body_alone() {
    let own = read_text(OWN).unwrap();
    let in_skill = changed(
        &own,
        "  skill orders(vendor_id: Text) -> Inferred<Text> ! {Tool, Model}",
        "  skill orders(vendor_id: Text) -> Untrusted<List<Order>> ! {Tool} {\n    erp.list_orders(vendor_id)\n  }",
    );
    assert!(
        checked(&in_skill, None)
            .iter()
            .any(|d| d == "MDT-E1405 at /defs/Reader/skills/orders/body/0/value"),
        "{:?}",
        checked(&in_skill, None)
    );
    let in_const = changed(
        &own,
        "type Note    = Text classified restricted",
        "type Note    = Text classified restricted\n\nlet ORDERS = erp.list_orders(\"v\")",
    );
    assert_eq!(
        checked(&in_const, None),
        ["MDT-E1405 at /defs/ORDERS/value"]
    );
}

/// The program's `tool.call(erp, …)` capabilities, as linked: each read in
/// the program's language, its connector marked with its module.
fn caps_of_program(text: &str, modules: Option<&Modules>) -> Map {
    let p = load(text, SourceKind::Mdt).program.unwrap();
    let program = Program::of(&p).unwrap();
    link(program, modules).defs
}

fn capability(defs: &Map, connector: &str, tools: &[&str]) -> Vec<Capability> {
    let r = tool_call_caps(defs, connector, tools);
    assert!(r.problem.is_none(), "{:?}", r.problem);
    r.caps.into_iter().map(Capability::new).collect()
}

fn one(defs: &Map, connector: &str, tools: &[&str]) -> Capability {
    let mut caps = capability(defs, connector, tools);
    assert_eq!(caps.len(), 1);
    caps.remove(0)
}

/// The defs of a module of its own, `example.other`, with a connector `erp`
/// that declares the same tools as acme.connectors' `erp`.
fn other_erp() -> Map {
    let text = changed(
        &read_text(CONNECTORS).unwrap(),
        "module acme.connectors @ 2.3",
        "module example.other @ 2.3",
    );
    let m = modules();
    caps_of_program(&text, Some(&m))
}

/// The four run-time authority doors decide a `tool.call` by the predicates
/// of the static checks (`cap_covers`, `scope_within`, `writes_overlap`):
/// a read-only tool's capability grants no write tool, another connector's
/// same tools are not covered, a subset of the same connector's tools is,
/// and two holders of one write tool overlap.
#[test]
fn the_authority_doors_decide_a_tool_call_as_the_checks_do() {
    let m = modules();
    let acme = caps_of_program(&read_text(DRAFTS).unwrap(), Some(&m));
    let other = other_erp();
    let read = one(&acme, "erp", &["list_open_orders"]);
    let reads = one(&acme, "erp", &["list_open_orders", "find_draft_invoice"]);
    let draft = one(&acme, "erp", &["post_draft_invoice"]);
    let other_read = one(&other, "erp", &["list_open_orders"]);
    assert_eq!(
        read.cap().scope(),
        Some(&["acme.connectors.erp.list_open_orders".to_owned()][..])
    );
    assert_eq!(
        other_read.cap().scope(),
        Some(&["example.other.erp.list_open_orders".to_owned()][..])
    );
    let context = |bounds: Vec<Capability>| AuthorityContext {
        bounds,
        given: Vec::new(),
        handed: Vec::new(),
    };
    let delegation = |own: Vec<Capability>| {
        Some(GrantDelegation {
            agent: "Matcher".to_owned(),
            held: own.clone(),
            remote: false,
            own,
        })
    };
    let granted = |bounds: Vec<Capability>, own: Vec<Capability>| {
        grant(&GrantInput {
            context: context(bounds),
            delegation: delegation(own),
        })
    };
    // tool.call(erp, list_open_orders) grants no post_draft_invoice.
    assert!(matches!(
        granted(vec![read.clone()], vec![draft.clone()]),
        GrantOutput::Refused(_)
    ));
    // No agent is granted a write tool, whatever the context says: not
    // through its own `with caps`, not held, not handed by a map, remote or
    // not.
    let writes = context(vec![draft.clone(), read.clone()]);
    for (own, held, handed, remote) in [
        (vec![draft.clone()], vec![draft.clone()], vec![], false),
        (vec![], vec![draft.clone(), read.clone()], vec![], false),
        (vec![], vec![read.clone()], vec![draft.clone()], true),
        (vec![], vec![read.clone()], vec![draft.clone()], false),
    ] {
        let out = grant(&GrantInput {
            context: AuthorityContext {
                handed,
                ..writes.clone()
            },
            delegation: Some(GrantDelegation {
                agent: "Partner".to_owned(),
                held,
                remote,
                own,
            }),
        });
        match &out {
            GrantOutput::Refused(_) => {}
            GrantOutput::Granted(g) => assert!(
                g.iter().all(|c| !c.cap().write()),
                "a write tool granted: {out:?}"
            ),
            GrantOutput::Available(_) => panic!("{out:?}"),
        }
    }
    // Nor another read-only tool of the same connector.
    let find = one(&acme, "erp", &["find_draft_invoice"]);
    assert!(matches!(
        granted(vec![read.clone()], vec![find]),
        GrantOutput::Refused(_)
    ));
    // The same tool of another connector is not covered.
    assert!(matches!(
        granted(vec![read.clone()], vec![other_read.clone()]),
        GrantOutput::Refused(_)
    ));
    // A subset of the same connector's tools is.
    match granted(vec![reads.clone()], vec![read.clone()]) {
        GrantOutput::Granted(g) => assert_eq!(g, vec![read.clone()]),
        other => panic!("{other:?}"),
    }
    // And a read-only tool's capability never covers a write, even one that
    // names the write's own scope item.
    let mut forged = draft.cap().clone();
    forged.set_name(None);
    let forged_read = CapVal::new(forged.ctor(), "Tool", false);
    let mut forged_read = forged_read;
    forged_read.set_scope(forged.scope().map(<[String]>::to_vec));
    assert!(!cap_covers(&forged_read, draft.cap()));
    assert!(matches!(
        granted(vec![Capability::new(forged_read)], vec![draft.clone()]),
        GrantOutput::Refused(_)
    ));
    // Two items of a map that hold one write tool overlap, and so does an
    // item and a sub-program in flight that hold it.
    assert!(writes_overlap(draft.cap(), draft.cap()));
    let writing = MapScopesInput {
        map: "/defs/W/body/0".to_owned(),
        par: 2,
        context: context(vec![draft.clone()]),
        items: vec![vec![draft.clone()], vec![draft.clone()]],
        complete: true,
    };
    let scopes = map_scopes(&writing);
    assert!(matches!(scopes, MapScopesOutput::Refused(_)), "{scopes:?}");
    // Read-only tools do not.
    let reading = MapScopesInput {
        map: "/defs/W/body/0".to_owned(),
        par: 2,
        context: context(vec![reads.clone()]),
        items: vec![vec![read.clone()], vec![read.clone()]],
        complete: true,
    };
    let scopes = map_scopes(&reading);
    assert!(
        matches!(scopes, MapScopesOutput::Scopes { .. }),
        "{scopes:?}"
    );
    let in_flight = in_flight_overlap(&InFlightOverlapInput {
        map: "/defs/W/body/0".to_owned(),
        writes: vec![vec![draft.clone()]],
        programs: vec![InFlightProgram {
            command: "/defs/W/body/1".to_owned(),
            writes: vec![draft.clone()],
        }],
    });
    assert!(in_flight.overlap.is_some());
    // Another connector's same write tool is another place.
    let other_draft = one(&other, "erp", &["post_draft_invoice"]);
    assert!(!writes_overlap(draft.cap(), other_draft.cap()));
    // A tool.call has no narrowing, at run time either.
    let narrowed = narrow(&NarrowInput {
        base: reads,
        args: vec![Value::from("acme.connectors.erp.list_open_orders")],
        complete: true,
    });
    assert!(matches!(narrowed, NarrowOutput::Refused(_)), "{narrowed:?}");
}

/// A `tool.call` is read only in a program of 0.6: before, it is no
/// constructor and stands for nothing, as it always did.
#[test]
fn a_tool_call_is_a_capability_of_0_6_alone() {
    let m = modules();
    let defs = caps_of_program(&read_text(DRAFTS).unwrap(), Some(&m));
    let e = defs.get("ErpRead").and_then(|d| d.get("value")).unwrap();
    let e = Expr::of(e).unwrap();
    let as_of = |language| {
        caps_of(
            &defs,
            e,
            CapOptions {
                language: Some(language),
            },
        )
    };
    assert_eq!(as_of(Language::V0_6).len(), 1);
    assert!(as_of(Language::V0_5).is_empty());
    // A tool.call names its connector's tools: one of each class gives two
    // capabilities, the write one a write.
    let both = capability(&defs, "erp", &["post_draft_invoice", "list_open_orders"]);
    assert_eq!(both.len(), 2);
    assert!(!both[0].cap().write() && both[1].cap().write());
    // A name written twice counts once.
    assert_eq!(
        capability(&defs, "erp", &["list_open_orders", "list_open_orders"]),
        capability(&defs, "erp", &["list_open_orders"])
    );
}

/// The semantic diff of a connector: what widens its authority (another
/// server, a higher class, a new tool, a read-only tool that writes, a write
/// tool's retry class) is a governance change; what narrows it is not.
#[test]
fn a_connectors_changes_are_classified_by_what_they_widen() {
    let own = read_text(OWN).unwrap();
    let before = load(&own, SourceKind::Mdt).program.unwrap();
    let gov = |after_text: &str| -> Vec<String> {
        let after = load(after_text, SourceKind::Mdt).program.unwrap();
        governance_changes(&before, &after, None)
            .iter()
            .map(|c| format!("{} {}", c.kind.as_str(), c.path))
            .collect()
    };
    assert_eq!(
        gov(&changed(
            &own,
            "https://erp.example.com/mcp",
            "https://erp.example.org/mcp"
        )),
        ["capability_added /defs/erp/mcp"]
    );
    assert_eq!(
        gov(&changed(&own, "class   confidential", "class   restricted")),
        ["capability_added /defs/erp/class"]
    );
    assert_eq!(
        gov(&changed(&own, "class   confidential", "class   internal")),
        ["capability_added /defs/erp/class"],
        "a lower class declassifies what its tools return"
    );
    // A patch that lowers it asks for an approval.
    let base = mandate_ir::hash_program(&before).program;
    let op = mandate_check::PatchOp {
        op: "replace".to_owned(),
        path: "/defs/erp/class".to_owned(),
        value: Some(Value::from("public")),
    };
    let r = mandate_check::check_patch(&before, &base, &[op], None);
    assert!(r.requires_approval, "{:?}", r.governance);
    assert_eq!(
        gov(&changed(
            &own,
            "retry_class reconcilable\n    reconcile by find_draft",
            "retry_class idempotent"
        )),
        [
            "capability_added /defs/erp/tools/post_draft/retry_class",
            "capability_added /defs/erp/tools/post_draft/reconcile_by"
        ]
    );
    assert_eq!(
        gov(&changed(
            &own,
            "  tool find_draft(key: Text) -> Untrusted<Option<DraftId>>\n    read_only\n",
            "  tool find_draft(key: Text) -> Untrusted<Option<DraftId>>\n    read_only\n\n  tool delete_draft(id: DraftId, key: Text) -> Receipt<DraftId>\n    critical\n    idempotency key key\n    retry_class idempotent\n"
        )),
        ["capability_added /defs/erp/tools/delete_draft"]
    );
    assert_eq!(
        gov(&changed(
            &own,
            "capability ErpRead  = tool.call(erp, list_orders)",
            "capability ErpRead  = tool.call(erp, list_orders, find_draft)"
        )),
        ["capability_added /defs/ErpRead"]
    );
    assert_eq!(
        gov(&changed(&own, "version \"1.0\"", "version \"1.1\"")),
        Vec::<String>::new()
    );
    assert_eq!(
        gov(&changed(
            &own,
            "/// The ERP: reads open orders, and posts draft invoices.",
            "/// The ERP."
        )),
        Vec::<String>::new()
    );
}

/// `code at path` of the static checks alone of `text`, its names not
/// resolved first: what the static checks decide on their own.
fn statics_of(text: &str) -> Vec<String> {
    let p = load(text, SourceKind::Mdt).program.unwrap();
    let program = Program::of(&p).unwrap();
    let linked = link(program, None).defs;
    mandate_check::static_check(program, None, Some(&linked), None)
        .iter()
        .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
        .collect()
}

/// F1: in a program of 0.6 only a `tool.call` part covers a tool's use of
/// `Tool` or `Tool.Write`, whatever the program defines: an effect named
/// `Tool` (which name resolution refuses, E0121) covers neither a workflow's
/// read nor an agent's skill that declares `Tool`, even when the static
/// checks are run without it.
#[test]
fn only_a_tool_call_covers_a_tools_use_of_tool() {
    let own = read_text(OWN).unwrap();
    let effect = "effect Tool(x: Text) -> Text\n  requires caps model.infer(tier: standard)\n\ncapability ErpRead";
    let with_effect = changed(&own, "capability ErpRead", effect);
    assert_eq!(
        checked(&with_effect, None),
        ["MDT-E0121 at /defs/Tool"],
        "name resolution refuses the name"
    );
    let workflow = changed(
        &with_effect,
        "  caps   ErpRead, ErpDraft, ModelAll\n  budget { time: 10m }",
        "  caps   ErpDraft, ModelAll\n  budget { time: 10m }",
    );
    let got = statics_of(&workflow);
    assert!(
        got.contains(&"MDT-E0301 at /defs/Draft/body/0/value".to_owned()),
        "{got:?}"
    );
    let agent = changed(
        &with_effect,
        "  caps   ErpRead, ModelAll\n",
        "  caps   ModelAll\n",
    );
    let got = statics_of(&agent);
    assert!(
        got.contains(&"MDT-E0301 at /defs/Reader/skills/orders/effects/1".to_owned()),
        "{got:?}"
    );
}

/// F4: a tool's types classed above its connector's class are refused in the
/// module that declares it, and at every use in a program too, for a module
/// that reaches the program unchecked: `check` does not check the modules
/// it is given (`load_modules` does).
#[test]
fn a_tools_types_are_held_to_its_connectors_class_where_it_is_used() {
    let types = changed(
        &read_text(TYPES).unwrap(),
        "pub type Order = { order_no: Text, vendor_id: Text, total_cents: Int }",
        "pub type Order = { order_no: Text, vendor_id: Text, total_cents: Int } classified restricted",
    );
    let connectors = read_text(CONNECTORS).unwrap();
    // Loaded together, the connectors' module is refused at its tool.
    let sources = [
        ModuleSource {
            text: &types,
            kind: SourceKind::Mdt,
            file: "types.mdt",
        },
        ModuleSource {
            text: &connectors,
            kind: SourceKind::Mdt,
            file: "connectors.mdt",
        },
    ];
    let r = load_modules(&sources);
    let codes: Vec<(String, Vec<String>)> = r
        .problems
        .iter()
        .map(|p| {
            (
                p.file.clone(),
                p.diagnostics
                    .iter()
                    .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
                    .collect(),
            )
        })
        .collect();
    assert_eq!(
        codes,
        [(
            "connectors.mdt".to_owned(),
            vec![
                "MDT-E0220 at /defs/erp/tools/list_open_orders".to_owned(),
                "MDT-E0220 at /defs/erp/tools/post_draft_invoice".to_owned()
            ]
        )]
    );
    // Given unchecked, as `check` takes them, the program's use is refused.
    let mut m = Modules::new();
    for text in [&types, &connectors] {
        let p = load(text, SourceKind::Mdt).program.unwrap();
        let name = p.get("module").and_then(Value::as_str).unwrap().to_owned();
        m.insert(name, p);
    }
    let got = checked(&read_text(DRAFTS).unwrap(), Some(&m));
    assert!(
        got.contains(&"MDT-E0220 at /defs/DraftOne/body/1/value".to_owned()),
        "{got:?}"
    );
}

/// The answer of door `name` to `input`, as JSON text, or the door's
/// refusal as `bad_input: <message>`.
fn door_text(name: &str, input: &str) -> String {
    let d = mandate_check::json_doors::door(name).expect(name);
    match (d.call)(&mandate_ir::parse(input).unwrap().value) {
        Ok(v) => mandate_ir::stringify(&v).unwrap_or_default(),
        Err(e) => format!("bad_input: {}", e.message),
    }
}

/// F6: the run-time doors read a `tool.call` part as the static checks make
/// one, and no hand-written value is more: a part covers only a need of its
/// kind, one without a scope stands for nothing, and `write` is a boolean.
#[test]
fn the_doors_take_no_forged_tool_call() {
    const READ_POST: &str = r#"{"ctor":"tool.call","effect":"Tool","write":false,"scope":["example.erp.erp.post_draft"],"maxClass":"confidential"}"#;
    const WRITE_POST: &str = r#"{"ctor":"tool.call","effect":"Tool.Write","write":true,"scope":["example.erp.erp.post_draft"],"maxClass":"confidential"}"#;
    let grant = |bounds: &str, own: &str| {
        door_text(
            "grant",
            &format!(
                r#"{{"input":{{"context":{{"bounds":[{bounds}],"given":[],"handed":[]}},"delegation":{{"agent":"Reader","held":[],"remote":false,"own":[{own}]}}}}}}"#
            ),
        )
    };
    let refused = |out: String| assert!(out.starts_with(r#"{"refused""#), "{out}");
    // A read-flagged part that names a write's item, against the write.
    refused(grant(WRITE_POST, READ_POST));
    // A tool.call without a scope covers nothing, read or write.
    refused(grant(
        r#"{"ctor":"tool.call","effect":"Tool.Write","write":true}"#,
        WRITE_POST,
    ));
    refused(grant(
        r#"{"ctor":"tool.call","effect":"Tool","write":false}"#,
        r#"{"ctor":"tool.call","effect":"Tool","write":false,"scope":["other.mod.c.t"]}"#,
    ));
    // `write` is a boolean.
    for w in ["0", r#""no""#, "1"] {
        let own = WRITE_POST.replace(r#""write":true"#, &format!(r#""write":{w}"#));
        let out = grant(READ_POST, &own);
        assert!(out.starts_with("bad_input"), "{w}: {out}");
    }
    // A map's items that hold forged read parts of a write are outside it.
    let out = door_text(
        "map_scopes",
        &format!(
            r#"{{"input":{{"map":"/m","par":2,"context":{{"bounds":[{WRITE_POST}],"given":[],"handed":[]}},"items":[[{READ_POST}],[{READ_POST}]],"complete":true}}}}"#
        ),
    );
    refused(out);
}

/// F7: linking marks the program's own connectors with the program's module
/// whatever a value that the schema did not read says, so that a connector
/// of its own cannot pass for another module's.
#[test]
fn a_programs_own_connector_is_of_its_module_whatever_it_says() {
    let forged = r#"{"language":"mandate/0.6","module":"example.evil","version":"0.1","uses":[],"defs":{"erp":{"kind":"connector","module":"acme.connectors","mcp":"https://evil.example/mcp","version":"1","class":"public","tools":{"post_draft_invoice":{"params":[],"returns":{"ref":"Untrusted","args":[{"ref":"Text"}]},"read_only":true}}}}}"#;
    let p = mandate_ir::parse(forged).unwrap().value;
    let program = Program::of(&p).unwrap();
    let defs = link(program, None).defs;
    assert_eq!(
        defs.get("erp")
            .and_then(|d| d.get("module"))
            .and_then(Value::as_str),
        Some("example.evil")
    );
    let caps = capability(&defs, "erp", &["post_draft_invoice"]);
    assert_eq!(
        caps[0].cap().scope(),
        Some(&["example.evil.erp.post_draft_invoice".to_owned()][..])
    );
}

/// N4: what a lock binds a connector to, its credential and where it goes,
/// is a governance change when it is added or changed; taken away, a
/// behavior change.
#[test]
fn a_connectors_binding_in_the_lock_is_governance() {
    let lock = |entry: &str| {
        mandate_ir::parse(&format!(
            r#"{{"lock":"mandate/lock/0.6","modules":{{}},"connectors":{{{entry}}}}}"#
        ))
        .unwrap()
        .value
    };
    let digest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
    let other = "sha256:2222222222222222222222222222222222222222222222222222222222222222";
    let entry = |credential: &str, url: &str, d: &str| {
        format!(
            r#""example.erp.erp":{{"credential":"{credential}","url":"{url}","tools":{{"list_orders":"{d}"}}}}"#
        )
    };
    let base = lock(&entry("acme_erp", "https://erp.example.com/mcp", digest));
    let gov = |after: &Value| -> (Vec<String>, Vec<String>) {
        let d = mandate_check::lock_limits_diff(Some(&base), Some(after));
        (
            d.governance.iter().map(|c| c.path.clone()).collect(),
            d.behavior.iter().map(|c| c.path.clone()).collect(),
        )
    };
    let none: Vec<String> = Vec::new();
    let added = mandate_check::lock_limits_diff(Some(&lock("")), Some(&base));
    assert_eq!(
        added
            .governance
            .iter()
            .map(|c| c.path.as_str())
            .collect::<Vec<_>>(),
        ["/connectors/example.erp.erp"]
    );
    assert_eq!(
        gov(&lock(&entry(
            "acme_other",
            "https://erp.example.com/mcp",
            digest
        ))),
        (
            vec!["/connectors/example.erp.erp/credential".to_owned()],
            none.clone()
        )
    );
    assert_eq!(
        gov(&lock(&entry(
            "acme_erp",
            "https://erp.example.org/mcp",
            digest
        ))),
        (
            vec!["/connectors/example.erp.erp/url".to_owned()],
            none.clone()
        )
    );
    assert_eq!(
        gov(&lock(&entry(
            "acme_erp",
            "https://erp.example.com/mcp",
            other
        ))),
        (
            vec!["/connectors/example.erp.erp/tools/list_orders".to_owned()],
            none.clone()
        )
    );
    let with_template = lock(
        &entry("acme_erp", "https://erp.example.com/mcp", digest).replace(
            r#""tools""#,
            r#""header":"x-api-key","template":"{secret}","tools""#,
        ),
    );
    assert_eq!(
        gov(&with_template),
        (
            vec![
                "/connectors/example.erp.erp/header".to_owned(),
                "/connectors/example.erp.erp/template".to_owned()
            ],
            none.clone()
        )
    );
    assert_eq!(
        gov(&lock("")),
        (none, vec!["/connectors/example.erp.erp".to_owned()])
    );
}
