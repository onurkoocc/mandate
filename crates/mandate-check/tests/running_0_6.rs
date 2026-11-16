//! The running program (language 0.6, spec/library.md "Hashes, and what the
//! runtime stores"): what the `check` door gives as `linked` when it is
//! asked, and what `check_subprogram` gives as `running` for a sub-program
//! that applies a pattern. It is the program a run runs: expanded, and
//! linked through what each library reaches, with the very definitions the
//! checks read. No TypeScript reads 0.6, so every expectation is written by
//! hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::library::LibrarySource;
use mandate_check::{CheckOptions, Modules, check, json_doors};
use mandate_ir::{JsObject, JsValue, Value, hash_program, parse, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{library_files, read_json, read_text};

const INVOICES: &str = "fixtures/library/invoices.mdt";
const ACME: &str = "fixtures/library/acme.connectors";

fn library(dir: &str) -> LibrarySource {
    let (manifest, files) = library_files(dir).unwrap();
    LibrarySource { manifest, files }
}

fn source_js(s: &LibrarySource) -> JsValue {
    JsObject::new()
        .with("manifest", s.manifest.as_str())
        .with(
            "files",
            s.files
                .iter()
                .map(|(p, t)| (p.as_str(), t.as_str()))
                .collect::<JsObject>(),
        )
        .into()
}

/// The JSON door `name` called with `input`.
fn door(name: &str, input: &JsValue) -> JsValue {
    let d = json_doors::door(name).expect(name);
    let input = parse(&stringify(input).unwrap()).unwrap().value;
    (d.call)(&input).unwrap_or_else(|e| panic!("{name}: {e:?}"))
}

/// The `check` door on `text` with `opts`.
fn checked(text: &str, opts: JsObject) -> JsValue {
    door(
        "check",
        &JsObject::new()
            .with("text", text)
            .with("kind", "mdt")
            .with("opts", opts)
            .into(),
    )
}

fn ir(text: &str) -> Value {
    load(text, SourceKind::Mdt).program.expect("a program")
}

/// The names of the definitions of a program given by a door.
fn names(program: &JsValue) -> Vec<String> {
    let text = stringify(program.get("defs").expect("defs")).unwrap();
    parse(&text)
        .unwrap()
        .value
        .as_object()
        .unwrap()
        .keys()
        .map(str::to_owned)
        .collect()
}

fn kind_of(program: &JsValue, name: &str) -> Option<String> {
    program
        .get("defs")
        .and_then(|d| d.get(name))
        .and_then(|d| d.get("kind"))
        .and_then(JsValue::as_str)
        .map(str::to_owned)
}

fn invoices_opts(linked: Option<bool>) -> JsObject {
    let lock = read_json("fixtures/library/invoices.lock.json").unwrap();
    let mut opts = JsObject::new()
        .with("lock", JsValue::from(&lock))
        .with("libraries", JsValue::Array(vec![source_js(&library(ACME))]));
    if let Some(l) = linked {
        opts.insert("linked", l);
    }
    opts
}

/// The acceptance program with its library and its lock: its running
/// program holds the types of the library's types module, the result type
/// of the built-in pattern, and the connectors, and applies nothing.
#[test]
fn the_running_program_of_the_acceptance_program_is_expanded_and_linked() {
    let text = read_text(INVOICES).unwrap();
    let out = checked(&text, invoices_opts(Some(true)));
    assert_eq!(
        out.get("ok").and_then(JsValue::as_bool),
        Some(true),
        "{}",
        stringify(out.get("diagnostics").unwrap()).unwrap()
    );
    let running = out.get("linked").expect("the running program");
    for (name, kind) in [
        ("Invoice", "type"),
        ("Match", "type"),
        ("DraftId", "type"),
        // What Match names in its own module.
        ("Order", "type"),
        ("near", "fn"),
        // The built-in std.patterns: the result type of the pattern applied.
        ("Batch", "type"),
        ("erp", "connector"),
        ("mailbox", "connector"),
        ("Matched", "contract"),
        ("Matcher", "agent"),
        ("MatchInvoices", "workflow"),
    ] {
        assert_eq!(kind_of(running, name).as_deref(), Some(kind), "{name}");
    }
    let shown = stringify(running).unwrap();
    assert!(!shown.contains("\"apply\""), "an application is left");
    // The workflow is its expansion: it has the pattern's body.
    let workflow = running.get("defs").and_then(|d| d.get("MatchInvoices"));
    assert!(workflow.and_then(|w| w.get("body")).is_some());
    // It is the expanded program with other definitions, and nothing else
    // of it is changed.
    let expanded = out.get("expanded").expect("the expanded program");
    for member in ["language", "module", "version", "uses"] {
        assert_eq!(
            stringify(running.get(member).unwrap()),
            stringify(expanded.get(member).unwrap()),
            "{member}"
        );
    }
    for name in names(expanded) {
        assert!(kind_of(running, &name).is_some(), "{name}");
    }
    // The same answer twice, and the same hash.
    let again = checked(&text, invoices_opts(Some(true)));
    assert_eq!(shown, stringify(again.get("linked").unwrap()).unwrap());
    let hash = |v: &JsValue| hash_program(&parse(&stringify(v).unwrap()).unwrap().value).program;
    assert_eq!(hash(running), hash(again.get("linked").unwrap()));
    assert_ne!(hash(running), hash(expanded));
}

/// The door gives the running program only when it is asked, and the rest
/// of its answer is the same asked or not; a program of 0.1 to 0.5 is given
/// none, asked or not; nor is a program that does not check.
#[test]
fn the_running_program_is_given_only_when_asked_and_only_for_0_6() {
    let text = read_text(INVOICES).unwrap();
    let asked = checked(&text, invoices_opts(Some(true)));
    for opts in [invoices_opts(None), invoices_opts(Some(false))] {
        let plain = checked(&text, opts);
        assert!(plain.get("linked").is_none());
        let mut without = asked.as_object().unwrap().clone();
        without.remove("linked");
        assert_eq!(
            stringify(&plain).unwrap(),
            stringify(&JsValue::Object(without)).unwrap()
        );
    }
    // 0.5: the same answer asked or not, with no member added.
    let older = read_text("fixtures/envelope/migrate-all.mdt").unwrap();
    let domain = ir(&read_text("fixtures/envelope/domain.mdt").unwrap());
    let modules = || JsObject::new().with("company.domain", JsValue::from(&domain));
    let plain = checked(&older, JsObject::new().with("modules", modules()));
    let asked_older = checked(
        &older,
        JsObject::new()
            .with("modules", modules())
            .with("linked", true),
    );
    assert_eq!(plain.get("ok").and_then(JsValue::as_bool), Some(true));
    assert_eq!(stringify(&plain).unwrap(), stringify(&asked_older).unwrap());
    assert!(asked_older.get("linked").is_none());
    // A program of 0.6 that does not check is given none.
    let broken = text.replace("max_items: 60", "max_items: \"sixty\"");
    let refused = checked(&broken, invoices_opts(Some(true)));
    assert_eq!(refused.get("ok").and_then(JsValue::as_bool), Some(false));
    assert!(refused.get("linked").is_none());
    assert!(refused.get("expanded").is_none());
    // `linked` is a boolean, for a program of 0.6.
    let d = json_doors::door("check").unwrap();
    let call = |text: &str, opts: JsObject| {
        let input: JsValue = JsObject::new()
            .with("text", text)
            .with("kind", "mdt")
            .with("opts", opts)
            .into();
        (d.call)(&parse(&stringify(&input).unwrap()).unwrap().value)
    };
    assert!(call(&text, invoices_opts(None).with("linked", "yes")).is_err());
    // For a program of 0.1 to 0.5 the member is not read, whatever it
    // holds: the answer is the one without it, byte for byte.
    for wrong in [
        JsValue::from("yes"),
        JsValue::from(1),
        JsValue::Array(Vec::new()),
    ] {
        let answered = call(
            &older,
            JsObject::new()
                .with("modules", modules())
                .with("linked", wrong),
        )
        .expect("a program of 0.5 is answered");
        assert_eq!(stringify(&plain).unwrap(), stringify(&answered).unwrap());
    }
    // Nor for a text that is no program.
    assert!(call("", JsObject::new().with("linked", "yes")).is_ok());
}

/// A library of two modules: `acme.two` imports a type of `acme.two.types`.
fn two() -> LibrarySource {
    LibrarySource {
        manifest: r#"{"library":"mandate/library/0.6","name":"acme.two","version":"1.0.0","modules":["a.mdt","b.mdt"]}"#.to_owned(),
        files: vec![
            (
                "a.mdt".to_owned(),
                "mandate @ 0.6\n\nmodule acme.two @ 1.0\n\nuse acme.two.types.{Note}\n\n/// A note's text.\npub fn text_of(n: Note) -> Text ! {} {\n  n.text\n}\n".to_owned(),
            ),
            (
                "b.mdt".to_owned(),
                "mandate @ 0.6\n\nmodule acme.two.types @ 1.0\n\n/// A note.\npub type Note = { text: Text }\n\n/// Nothing names it.\npub type Unused = { n: Int }\n".to_owned(),
            ),
        ],
    }
}

/// A library nothing imports.
fn other() -> LibrarySource {
    LibrarySource {
        manifest: r#"{"library":"mandate/library/0.6","name":"acme.other","version":"1.0.0","modules":["o.mdt"]}"#.to_owned(),
        files: vec![(
            "o.mdt".to_owned(),
            "mandate @ 0.6\n\nmodule acme.other @ 1.0\n\n/// Far away.\npub type Far = { n: Int }\n".to_owned(),
        )],
    }
}

const TWO_PROGRAM: &str = "mandate @ 0.6\n\nmodule example.two @ 0.1\n\nuse acme.two.{text_of}\nuse example.given.{deep_of}\n\nfn one() -> Int {\n  1\n}\n";

/// The modules given to the check, which are of no library: one imports a
/// type of the other.
fn given() -> Modules {
    let mut modules = Modules::new();
    modules.insert(
        "example.given",
        ir("mandate @ 0.6\n\nmodule example.given @ 0.1\n\nuse example.far.{Deep}\n\n/// How deep.\npub fn deep_of(d: Deep) -> Int ! {} {\n  d.n\n}\n"),
    );
    modules.insert(
        "example.far",
        ir("mandate @ 0.6\n\nmodule example.far @ 0.1\n\n/// Deep.\npub type Deep = { n: Int }\n"),
    );
    modules
}

/// Linking follows a library's module into the modules its library reaches,
/// and into no other: what a module of a library names of its sibling is in
/// the running program; a definition nothing names, a library nothing
/// imports, and what a given module (of no library, so with no reach)
/// imports from another are not.
#[test]
fn a_module_outside_every_reach_is_not_linked_in() {
    let libraries = [two(), other()];
    let modules = given();
    let r = check(
        TWO_PROGRAM,
        SourceKind::Mdt,
        &CheckOptions {
            libraries: Some(&libraries),
            modules: Some(&modules),
            linked: true,
            ..CheckOptions::default()
        },
    );
    assert!(r.ok, "{:#?}", r.diagnostics);
    // It applies no pattern: no expansion, and the program linked.
    assert!(r.expanded.is_none());
    let running = r.linked.expect("the running program");
    let defs = running.get("defs").and_then(Value::as_object).unwrap();
    let mut found: Vec<&str> = defs.keys().collect();
    found.sort_unstable();
    assert_eq!(found, vec!["Note", "deep_of", "one", "text_of"]);
    // Not asked: none.
    let plain = check(
        TWO_PROGRAM,
        SourceKind::Mdt,
        &CheckOptions {
            libraries: Some(&libraries),
            modules: Some(&modules),
            ..CheckOptions::default()
        },
    );
    assert!(plain.ok && plain.linked.is_none());
    // The door gives the same.
    let out = checked(
        TWO_PROGRAM,
        JsObject::new()
            .with(
                "libraries",
                JsValue::Array(libraries.iter().map(source_js).collect()),
            )
            .with(
                "modules",
                modules
                    .iter()
                    .map(|(m, p)| (m, JsValue::from(p)))
                    .collect::<JsObject>(),
            )
            .with("linked", true),
    );
    assert_eq!(
        stringify(out.get("linked").unwrap()).unwrap(),
        stringify(&JsValue::from(&running)).unwrap()
    );
}

/// The parent of the sub-program cases, in 0.6, with a pattern of its own
/// that a sub-program may apply.
fn parent() -> Value {
    let text = read_text("fixtures/envelope/migrate-all.mdt")
        .unwrap()
        .replace("mandate @ 0.4", "mandate @ 0.6")
        .replace(
            "workflow MigrateAll(",
            "/// Moves one repository.\npattern Once<In, Out>(\n  item: const In,\n  work: skill(In) -> Inferred<Out>\n) () -> Inferred<Out>\n{\n  delegate work(item)\n}\n\nworkflow MigrateAll(",
        );
    assert!(text.contains("pattern Once<"));
    ir(&text)
}

/// `check_subprogram` on the sub-program whose one workflow is `workflow`
/// (Mandate text, after the module's header).
fn subprogram(workflow: &str) -> JsValue {
    let parent = parent();
    let domain = ir(&read_text("fixtures/envelope/domain.mdt").unwrap());
    let skeleton = door(
        "skeleton",
        &JsObject::new()
            .with("parent", "company.migrations")
            .with("n", 1)
            .with("language", "mandate/0.6")
            .into(),
    );
    let base = hash_program(&parse(&stringify(&skeleton).unwrap()).unwrap().value).program;
    let sub = load(
        &format!(
            "mandate @ 0.6\n\nmodule company.migrations.plan_1 @ 0.1\n\nuse company.migrations\n\n{workflow}"
        ),
        SourceKind::Mdt,
    );
    assert!(
        !mandate_ir::has_errors(&sub.diagnostics),
        "{:#?}",
        sub.diagnostics
    );
    let sub = sub.program.unwrap();
    let ops: Vec<JsValue> = sub
        .get("defs")
        .and_then(Value::as_object)
        .unwrap()
        .iter()
        .map(|(name, d)| {
            JsObject::new()
                .with("op", "add")
                .with("path", format!("/defs/{name}"))
                .with("value", JsValue::from(d))
                .into()
        })
        .collect();
    let room = JsObject::new()
        .with(
            "left",
            JsObject::new()
                .with("tokens", 50_000_000)
                .with("steps", 1000)
                .with("agents", 100)
                .with("spend:USD", 100_000_000),
        )
        .with("time_left_ms", 3_600_000)
        .with("writes", JsValue::Array(Vec::new()));
    let i = JsObject::new()
        .with("parent", JsValue::from(&parent))
        .with(
            "modules",
            JsObject::new().with("company.domain", JsValue::from(&domain)),
        )
        .with("workflow", "MigrateAll")
        .with("number", 1)
        .with("base", base)
        .with("ops", JsValue::Array(ops))
        .with("lead", "internal")
        .with("room", room);
    door("check_subprogram", &JsObject::new().with("i", i).into())
}

/// A workflow that applies the parent's pattern.
const APPLIED: &str = "workflow Finish = Once<Repo, Summary>(item: Repo { name: \"a\", root: \"a\" }, work: Migrator.migrate)\n";

const CLAIM: &str = "  caps   Build, ModelStd, RepoRead, SrcWrite\n  budget { tokens: 500k, time: 30m, spend: 1 USD, steps: 20, agents: 2 }\n";

/// A sub-program that applies a pattern of its parent is given as the lead
/// wrote it, with its hash, and besides as a run runs it: expanded, with
/// all its parent sees linked in, under the hash of that.
#[test]
fn a_sub_program_that_applies_a_pattern_is_given_its_running_program() {
    let out = subprogram(&format!("{APPLIED}{CLAIM}"));
    assert_eq!(
        out.get("ok").and_then(JsValue::as_bool),
        Some(true),
        "{}",
        stringify(&out).unwrap()
    );
    // As written: the application, and its hash.
    let program = out.get("program").unwrap();
    assert_eq!(names(program), vec!["Finish"]);
    let written = program.get("defs").and_then(|d| d.get("Finish")).unwrap();
    assert!(written.get("apply").is_some() && written.get("body").is_none());
    let value = |v: &JsValue| parse(&stringify(v).unwrap()).unwrap().value;
    assert_eq!(
        out.get("hash").and_then(JsValue::as_str),
        Some(hash_program(&value(program)).program.as_str())
    );
    // As it runs: the expansion, and what its parent sees.
    let running = out.get("running").expect("the running program");
    let finish = running.get("defs").and_then(|d| d.get("Finish")).unwrap();
    assert!(finish.get("apply").is_none());
    let body = stringify(finish.get("body").expect("a body")).unwrap();
    assert!(body.contains("\"delegate\"") && body.contains("\"Migrator\""));
    assert!(finish.get("caps").is_some() && finish.get("budget").is_some());
    for (name, kind) in [
        ("Migrator", "agent"),
        ("Repo", "type"),
        ("Summary", "type"),
        ("SrcWrite", "capability"),
        ("Once", "pattern"),
        ("MigrateAll", "workflow"),
    ] {
        assert_eq!(kind_of(running, name).as_deref(), Some(kind), "{name}");
    }
    for member in ["language", "module", "version", "uses"] {
        assert_eq!(
            stringify(running.get(member).unwrap()),
            stringify(program.get(member).unwrap()),
            "{member}"
        );
    }
    assert_eq!(
        out.get("running_hash").and_then(JsValue::as_str),
        Some(hash_program(&value(running)).program.as_str())
    );
    assert_ne!(out.get("running_hash"), out.get("hash"));
    // The members are in this order, the new ones last.
    let members: Vec<&str> = out.as_object().unwrap().keys().collect();
    assert_eq!(
        members,
        vec![
            "ok",
            "diagnostics",
            "program",
            "hash",
            "workflow",
            "running",
            "running_hash"
        ]
    );
    // Twice the same.
    let again = subprogram(&format!("{APPLIED}{CLAIM}"));
    assert_eq!(stringify(&out).unwrap(), stringify(&again).unwrap());
}

/// A sub-program that applies no pattern is given as before, with no
/// running program; so is one that is refused.
#[test]
fn a_sub_program_that_applies_none_is_given_no_running_program() {
    let body = "{\n  delegate Migrator.migrate(Repo { name: \"a\", root: \"a\" })\n}\n";
    let out = subprogram(&format!(
        "workflow Finish() -> Inferred<Summary>\n{CLAIM}{body}"
    ));
    assert_eq!(
        out.get("ok").and_then(JsValue::as_bool),
        Some(true),
        "{}",
        stringify(&out).unwrap()
    );
    let members: Vec<&str> = out.as_object().unwrap().keys().collect();
    assert_eq!(
        members,
        vec!["ok", "diagnostics", "program", "hash", "workflow"]
    );
    // One that applies a pattern and claims more than is left (E1706).
    let over = subprogram(&format!(
        "{APPLIED}{}",
        CLAIM.replace("steps: 20", "steps: 2000")
    ));
    assert_eq!(over.get("ok").and_then(JsValue::as_bool), Some(false));
    let shown = stringify(&over).unwrap();
    assert!(shown.contains("MDT-E1706"), "{shown}");
    let members: Vec<&str> = over.as_object().unwrap().keys().collect();
    assert_eq!(members, vec!["ok", "diagnostics"]);
}
