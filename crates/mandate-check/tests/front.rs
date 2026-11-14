//! The stages before the static checks against the TypeScript on inputs
//! written to reach their JavaScript: `tests/front/inputs.json`, and in
//! `tests/front/expected.json` what `scripts/front-vectors.mjs` has the
//! TypeScript compiler give for them (`link`, `references`, `resolveNames`,
//! `roleSites`, `rolesNamed`, `roleChecks`). Each result is compared whole,
//! as `JSON.stringify(value, null, 2)` text.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{link, references, resolve_names, role_checks, role_sites, roles_named};
use mandate_ir::{Diagnostic, JsObject, JsValue, Program, Value, stringify_pretty};
use mandate_testkit::{compare_text, read_json};

fn strings(xs: &[String]) -> JsValue {
    JsValue::Array(xs.iter().map(|x| JsValue::from(x.as_str())).collect())
}

fn diagnostics(ds: &[Diagnostic]) -> JsValue {
    JsValue::Array(ds.iter().map(Diagnostic::to_js).collect())
}

#[test]
fn the_stages_before_the_static_checks_are_the_typescript_ones() {
    let inputs = read_json("crates/mandate-check/tests/front/inputs.json").unwrap();
    let expected = read_json("crates/mandate-check/tests/front/expected.json").unwrap();
    let modules = inputs.get("modules").and_then(Value::as_object).unwrap();
    let program = |key: &str| Program::of(inputs.get(key).unwrap()).unwrap();

    let linked = link(program("program"), Some(modules));
    let roles = program("roles");
    let roles_defs = roles.defs().unwrap();
    let roles_linked = link(roles, Some(modules));
    let names = program("names");
    let names_linked = link(names, Some(modules));

    let mine: Vec<(&str, JsValue)> = vec![
        (
            "references",
            strings(&references(inputs.get("workflow").unwrap())),
        ),
        (
            "link",
            JsObject::new()
                .with(
                    "defs",
                    JsValue::Array(linked.defs.keys().map(JsValue::from).collect()),
                )
                .with(
                    "origin",
                    JsValue::Array(
                        linked
                            .origin
                            .iter()
                            .map(|(n, m)| {
                                JsValue::Array(vec![
                                    JsValue::from(n.as_str()),
                                    JsValue::from(m.as_str()),
                                ])
                            })
                            .collect(),
                    ),
                )
                .with("diagnostics", diagnostics(&linked.diagnostics))
                .into(),
        ),
        (
            "role_sites",
            JsValue::Array(
                role_sites(roles_defs)
                    .iter()
                    .map(|s| {
                        JsObject::new()
                            .with("def", s.def.as_str())
                            .with("role", s.role.as_deref())
                            .with("path", s.path.as_str())
                            .with("where", s.r#where.as_str())
                            .with("distinct", s.distinct)
                            .with("value", s.value.value("X"))
                            .into()
                    })
                    .collect(),
            ),
        ),
        ("roles_named", strings(&roles_named(roles_defs))),
        (
            "role_checks",
            diagnostics(&role_checks(roles, None, Some(&roles_linked.defs))),
        ),
        (
            "role_checks_opaque",
            diagnostics(&role_checks(roles, None, None)),
        ),
        ("resolve", diagnostics(&resolve_names(names, None, None))),
        (
            "resolve_linked",
            diagnostics(&resolve_names(names, None, Some(&names_linked.defs))),
        ),
    ];
    let mut failures = Vec::new();
    for (key, value) in &mine {
        let want = stringify_pretty(&JsValue::from(expected.get(key).unwrap())).unwrap();
        let got = stringify_pretty(value).unwrap();
        if let Err(why) = compare_text(&want, &got) {
            failures.push(format!("{key}: {why}"));
        }
    }
    assert_eq!(
        expected.as_object().unwrap().len(),
        mine.len(),
        "every result is compared"
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
