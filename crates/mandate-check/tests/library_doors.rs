//! The library doors of language 0.6 (`json_doors::LIBRARY_DOORS`), which
//! no TypeScript function stands for: the table equals the committed
//! `crates/mandate-check/tests/library_doors/doors.json`; every door refuses
//! what it does not take as `bad_input`; and each gives, as JSON, what the
//! function of `mandate_check::library` it stands on gives, for the inputs
//! of the fixtures of `fixtures/library/` (the acceptance library, and the
//! versions of `upgrade/acme.ops`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_check::json_doors::{LIBRARY_DOORS, library_door};
use mandate_check::library::ops::{Published, Request, add, publish, upgrade};
use mandate_check::library::{LibrarySource, Timestamp, load_library};
use mandate_ir::{JsObject, JsValue, Value, parse, stringify};
use mandate_testkit::json_doors::{Answer, JsonDoor, check_table};
use mandate_testkit::{library_files, read_text};

const DIR: &str = "crates/mandate-check/tests/library_doors";
const OPS: &str = "fixtures/library/upgrade/acme.ops";
const NOW: &str = "2026-11-15T09:00:00Z";

fn doors() -> Vec<JsonDoor<'static>> {
    LIBRARY_DOORS
        .iter()
        .map(|d| JsonDoor {
            name: d.name,
            ts: d.ts,
            params: d.params,
            note: d.note,
            call: Box::new(move |input| match (d.call)(input) {
                Ok(output) => Answer::Output(output),
                Err(e) => Answer::Refused {
                    kind: e.kind.as_str().to_owned(),
                    message: e.message,
                },
            }),
        })
        .collect()
}

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

fn published(version: &str) -> Published {
    let dir = format!("{OPS}/{version}");
    Published {
        version: version.to_owned(),
        source: library(&dir),
        index: read_text(&format!("{dir}/index.json")).ok(),
    }
}

fn published_js(p: &Published) -> JsValue {
    JsObject::new()
        .with("version", p.version.as_str())
        .with("library", source_js(&p.source))
        .with(
            "index",
            p.index.as_deref().map_or(JsValue::Null, JsValue::from),
        )
        .into()
}

fn value(v: &JsValue) -> Value {
    parse(&stringify(v).unwrap()).unwrap().value
}

fn call(door: &str, input: JsObject) -> Result<String, String> {
    let d = library_door(door).unwrap();
    (d.call)(&value(&JsValue::Object(input)))
        .map(|o| stringify(&o).unwrap())
        .map_err(|e| e.message)
}

fn lock_1_0_0() -> Value {
    mandate_testkit::read_json("conformance/L02/mandate.lock.json").unwrap()
}

#[test]
fn the_table_is_doors_json() {
    match check_table(DIR, &doors()) {
        Ok(summary) => println!("{summary}"),
        Err(e) => panic!("{e}"),
    }
}

#[test]
fn every_door_refuses_what_it_does_not_take() {
    for d in LIBRARY_DOORS {
        for text in [
            "null",
            "true",
            "1",
            "\"made-up\"",
            "[]",
            r#"{"made_up":null}"#,
            "{}",
        ] {
            let input = parse(text).unwrap().value;
            assert!((d.call)(&input).is_err(), "{} with {text}", d.name);
        }
    }
    // A member of the wrong type, deeper.
    let bad = |door: &str, input: &str| {
        let d = library_door(door).unwrap();
        let e = (d.call)(&parse(input).unwrap().value).unwrap_err();
        assert_eq!(e.kind.as_str(), "bad_input", "{door}: {input}");
        e.message
    };
    bad("library_verify", r#"{"library":{"manifest":1,"files":{}}}"#);
    bad(
        "library_verify",
        r#"{"library":{"manifest":"{}","files":{"a.mdt":1}}}"#,
    );
    let message = bad(
        "library_add",
        r#"{"library":"a","lock":{},"versions":[],"now":"yesterday"}"#,
    );
    assert!(message.contains("`now`"), "{message}");
    let message = bad(
        "library_add",
        r#"{"library":"a","lock":{},"versions":[],"now":"2026-11-15T09:00:00Z","config":{"dir":"d","wait_day":2}}"#,
    );
    assert!(message.contains("`config`"), "{message}");
}

/// The `check` door reads the libraries and the configuration from its
/// `opts` (0.6): the acceptance program checks with them and its lock, and
/// a configuration that revokes its library's digest refuses it (E1608).
#[test]
fn the_check_door_takes_the_libraries_and_the_configuration() {
    let door = mandate_check::json_doors::door("check").unwrap();
    let acme = library("fixtures/library/acme.connectors");
    let digest = load_library(&acme, false, "acme").unwrap().digest;
    let lock = mandate_testkit::read_json("fixtures/library/invoices.lock.json").unwrap();
    let run = |config: Option<JsValue>| {
        let mut opts = JsObject::new()
            .with("lock", JsValue::from(&lock))
            .with("libraries", JsValue::Array(vec![source_js(&acme)]));
        if let Some(c) = config {
            opts.insert("config", c);
        }
        let input = JsObject::new()
            .with("text", read_text("fixtures/library/invoices.mdt").unwrap())
            .with("kind", "mdt")
            .with("opts", opts);
        let out = (door.call)(&value(&JsValue::Object(input))).unwrap();
        stringify(&out.get("diagnostics").cloned().unwrap()).unwrap()
            + &stringify(&out.get("ok").cloned().unwrap()).unwrap()
    };
    let plain = run(None);
    assert!(plain.ends_with("true"), "{plain}");
    let revoked = run(Some(
        JsObject::new()
            .with("dir", "libraries")
            .with(
                "revoked",
                JsValue::Array(vec![JsValue::from(digest.as_str())]),
            )
            .into(),
    ));
    assert!(
        revoked.contains("MDT-E1608") && revoked.ends_with("false"),
        "{revoked}"
    );
}

/// Each door gives what its function gives.
#[test]
fn each_door_gives_what_its_function_gives() {
    let now = Timestamp::parse(NOW).unwrap();
    let versions: Vec<Published> = ["1.0.0", "1.0.1", "1.1.0", "1.2.0", "2.0.0"]
        .iter()
        .map(|v| published(v))
        .collect();
    let versions_js = JsValue::Array(versions.iter().map(published_js).collect());
    let lock = lock_1_0_0();
    let request = Request {
        library: "acme.ops",
        range: Some("1.1.0"),
        lock: &lock,
        versions: &versions,
        libraries: &[],
        config: None,
        now,
        language: None,
    };
    // add
    let door = call(
        "library_add",
        JsObject::new()
            .with("library", "acme.ops")
            .with("range", "1.1.0")
            .with("lock", JsValue::from(&lock))
            .with("versions", versions_js.clone())
            .with("now", NOW),
    )
    .unwrap();
    assert_eq!(door, stringify(&add(&request).to_js()).unwrap());
    // upgrade, without and with acceptance
    let pinned = published("1.0.0").source;
    for accept in [false, true] {
        let door = call(
            "library_upgrade",
            JsObject::new()
                .with("library", "acme.ops")
                .with("range", "1.1.0")
                .with("lock", JsValue::from(&lock))
                .with("versions", versions_js.clone())
                .with("pinned", source_js(&pinned))
                .with("now", NOW)
                .with("accept_governance", accept),
        )
        .unwrap();
        let direct = upgrade(&request, &pinned, accept);
        assert_eq!(door, stringify(&direct.to_js()).unwrap());
        assert_eq!(direct.lock.is_some(), accept, "accept_governance {accept}");
        assert!(door.contains("\"kind\":\"widened\""), "{door}");
    }
    // publish
    let base = [published("1.0.0")];
    let door = call(
        "library_publish",
        JsObject::new()
            .with("source", source_js(&published("1.1.0").source))
            .with(
                "published",
                JsValue::Array(base.iter().map(published_js).collect()),
            )
            .with("now", NOW),
    )
    .unwrap();
    let direct = publish(&published("1.1.0").source, &base, &[], now);
    assert_eq!(door, stringify(&direct.to_js()).unwrap());
    assert!(door.contains("MDT-E1607"), "{door}");
    // verify and the signature of the acceptance library
    let acme = library("fixtures/library/acme.connectors");
    let input = JsObject::new().with("library", source_js(&acme));
    let verified = call("library_verify", input.clone()).unwrap();
    let loaded = load_library(&acme, false, "acme").unwrap();
    assert!(
        verified.contains(&format!("\"digest\":\"{}\"", loaded.digest)),
        "{verified}"
    );
    assert!(verified.starts_with("{\"ok\":true,"), "{verified}");
    let signature = call("authority_signature", input).unwrap();
    assert!(
        signature.contains(r#""acme.connectors.erp":{"kind":"connector","url":"https://erp.acme.example/mcp","class":"confidential","tools":{"delete_draft_invoice":"write idempotent","find_draft_invoice":"read_only","list_open_orders":"read_only","post_draft_invoice":"write reconcilable"}}"#),
        "{signature}"
    );
}
