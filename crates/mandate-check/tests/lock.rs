//! The lock, the Managed Agents binding checks and the sandbox requirements
//! against the TypeScript on inputs written to reach the branches no stored
//! result reaches: `tests/lock/inputs.json`, and in `tests/lock/expected.json`
//! what `scripts/lock-vectors.mjs` has the TypeScript compiler give for them.
//! Each result is the text `JSON.stringify` gives, compared whole (a double
//! beyond 2^53 is not a number the strict reader reads, so no result is
//! parsed). A `check` is compared on `ok` and the diagnostics of the lock.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{
    CapVal, CheckOptions, DataClass, ISOLATION_LEVELS, Lock, Modules, RequirementOptions, Subject,
    agent_models, binding_checks, check, co_tenancy_for, denial_diagnostics, floor_for, link,
    linked_program, lock_checks, model_tiers, module_lock_checks, own, packaged_lock,
    per_call_bound, requirement_for, requirements_to_js, role_lock_checks, sandbox_lock_checks,
    sandbox_requirements, validate_lock,
};
use mandate_ir::{Diagnostic, JsObject, JsValue, Language, Map, Program, Value, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{compare_text, read_json};

/// The codes the check of a program is compared on (`LOCK_CODES` in the script).
fn is_lock_code(code: &str) -> bool {
    matches!(
        code,
        "MDT-E0140"
            | "MDT-E0141"
            | "MDT-E0142"
            | "MDT-W0504"
            | "MDT-E0504"
            | "MDT-E0903"
            | "MDT-E0904"
            | "MDT-E0905"
            | "MDT-E1502"
            | "MDT-E1802"
            | "MDT-E1803"
    )
}

struct Inputs {
    file: Value,
}

impl Inputs {
    fn section(&self, name: &str) -> Vec<&Value> {
        match self.file.get(name) {
            Some(Value::Array(items)) => items.iter().collect(),
            other => panic!("no section {name}: {other:?}"),
        }
    }

    fn text(&self, table: &str, name: &str) -> &str {
        self.file
            .get(table)
            .and_then(|t| t.get(name))
            .and_then(Value::as_str)
            .unwrap_or_else(|| panic!("no {table} {name}"))
    }

    /// The program `name`, as `load` gives it.
    fn program(&self, name: &str) -> Value {
        let loaded = load(self.text("programs", name), SourceKind::Mdt);
        loaded
            .program
            .unwrap_or_else(|| panic!("the program {name} does not load"))
    }

    /// The modules `names`, by the name each declares.
    fn modules(&self, names: &Value) -> Modules {
        let mut out = Modules::new();
        for n in names.as_array().unwrap() {
            let n = n.as_str().unwrap();
            let loaded = load(self.text("modules", n), SourceKind::Mdt);
            out.insert(n, loaded.program.expect("the module loads"));
        }
        out
    }
}

fn texts(ds: &[Diagnostic]) -> JsValue {
    JsValue::Array(ds.iter().map(Diagnostic::to_js).collect())
}

fn strings(xs: impl IntoIterator<Item = impl AsRef<str>>) -> JsValue {
    JsValue::Array(xs.into_iter().map(|x| JsValue::from(x.as_ref())).collect())
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap()
}

/// A capability written as the TypeScript's `CapVal`.
fn cap_of(v: &Value) -> CapVal {
    let mut c = CapVal::new(
        str_of(v, "ctor"),
        str_of(v, "effect"),
        v.get("write") == Some(&Value::Bool(true)),
    );
    let list = |key: &str| -> Option<Vec<String>> {
        v.get(key).and_then(Value::as_array).map(|items| {
            items
                .iter()
                .map(|s| s.as_str().unwrap().to_owned())
                .collect()
        })
    };
    c.set_name(v.get("name").and_then(Value::as_str).map(str::to_owned));
    c.set_via(v.get("via").and_then(Value::as_str).map(str::to_owned));
    c.set_scope(list("scope"));
    c.set_tier(v.get("tier").and_then(Value::as_str).map(str::to_owned));
    c.set_max_class(
        v.get("maxClass")
            .and_then(Value::as_str)
            .and_then(DataClass::from_name),
    );
    c.set_args_prefix(v.get("argsPrefix").and_then(Value::as_array).map(|lists| {
        lists
            .iter()
            .map(|l| {
                l.as_array()
                    .unwrap()
                    .iter()
                    .map(|s| s.as_str().unwrap().to_owned())
                    .collect()
            })
            .collect()
    }));
    c.set_methods(list("methods"));
    c
}

/// What `JSON.stringify` gives for a result (`undefined` as null).
fn text_of(v: &JsValue) -> String {
    stringify(v).unwrap_or_else(|| "null".to_owned())
}

fn run_check(inputs: &Inputs, c: &Value) -> JsValue {
    let mods = inputs.modules(c.get("modules").unwrap());
    let lock = c.get("lock").unwrap();
    let program = c.get("program").and_then(Value::as_str).unwrap();
    let r = check(
        inputs.text("programs", program),
        SourceKind::Mdt,
        &CheckOptions {
            lock: Some(lock),
            modules: Some(&mods),
            claim: None,
        },
    );
    let ours: Vec<Diagnostic> = r
        .diagnostics
        .into_iter()
        .filter(|d| is_lock_code(&d.code))
        .collect();
    JsObject::new()
        .with("ok", r.ok)
        .with("diagnostics", texts(&ours))
        .into()
}

fn run_direct(inputs: &Inputs, c: &Value) -> JsValue {
    let p = inputs.program(str_of(c, "program"));
    let mods = inputs.modules(c.get("modules").unwrap());
    let lock = c.get("lock").unwrap();
    let view = Program::of(&p).unwrap();
    let linked = linked_program(view, Some(&mods));
    let linked_view = Program::of(&linked).unwrap();
    let lock_view = Lock::of(lock);
    let ds = match str_of(c, "fn") {
        "lockChecks" => lock_checks(linked_view, lock_view, None),
        "bindingChecks" => binding_checks(linked_view, lock_view, None),
        "sandboxLockChecks" => sandbox_lock_checks(linked_view, lock_view),
        "roleLockChecks" => role_lock_checks(view, &link(view, Some(&mods)), lock_view, None),
        "moduleLockChecks" => module_lock_checks(view, lock_view, Some(&mods)),
        other => panic!("no function {other}"),
    };
    texts(&ds)
}

fn run_sandbox(inputs: &Inputs, c: &Value) -> JsValue {
    let p = inputs.program(str_of(c, "program"));
    let mods = inputs.modules(c.get("modules").unwrap());
    let reqs = sandbox_requirements(&p, Some(&mods), c.get("lock"));
    JsValue::Object(requirements_to_js(&reqs))
}

fn run_requirement(c: &Value) -> JsValue {
    let subject = c.get("subject").unwrap();
    let caps: Vec<CapVal> = c
        .get("caps")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(cap_of)
        .collect();
    let timeout = c.get("timeout").and_then(Value::as_i64).map(|n| n as f64);
    let opts = RequirementOptions {
        language: c
            .get("language")
            .and_then(Value::as_str)
            .and_then(Language::from_tag),
        lock: c.get("lock"),
    };
    let req = requirement_for(
        Subject {
            agent: str_of(subject, "agent").to_owned(),
            def: str_of(subject, "def").to_owned(),
        },
        &caps,
        timeout,
        &opts,
    );
    JsValue::Object(req.to_js())
}

fn run_isolation(c: &Value) -> JsValue {
    let iso = c.get("iso");
    let mut floor = JsObject::new();
    let mut co = JsObject::new();
    for class in mandate_check::DATA_CLASSES {
        floor.insert(class.as_str(), floor_for(iso, class).as_str());
        co.insert(class.as_str(), co_tenancy_for(iso, class).as_str());
    }
    JsObject::new()
        .with("levels", strings(ISOLATION_LEVELS.map(|l| l.as_str())))
        .with("floor", floor)
        .with("co_tenancy", co)
        .into()
}

fn run_bound(c: &Value) -> JsValue {
    let lock = Lock::of(c.get("lock").unwrap());
    match per_call_bound(lock, str_of(c, "tier")) {
        None => JsValue::Null,
        Some(b) => JsObject::new()
            .with("tokens", b.tokens)
            .with(
                "spend",
                JsObject::new()
                    .with("micros", b.micros)
                    .with("currency", b.currency),
            )
            .into(),
    }
}

fn run_models(inputs: &Inputs, c: &Value) -> JsValue {
    let p = inputs.program(str_of(c, "program"));
    let mods = inputs.modules(c.get("modules").unwrap());
    let linked = linked_program(Program::of(&p).unwrap(), Some(&mods));
    let view = Program::of(&linked).unwrap();
    let mut agents = JsObject::new();
    for (name, def) in view.definitions() {
        if def.kind() != Some(mandate_ir::DefKind::Agent) {
            continue;
        }
        let m = agent_models(view, def);
        agents.insert(
            name,
            JsObject::new()
                .with("tiers", strings(&m.tiers))
                .with("maxClass", m.max_class.as_str()),
        );
    }
    JsObject::new()
        .with("tiers", strings(model_tiers(view)))
        .with("agents", agents)
        .into()
}

fn run_packaged(c: &Value) -> JsValue {
    let map: Map = packaged_lock(c.get("lock"));
    JsValue::Object(JsObject::from(&map))
}

fn run_own(c: &Value) -> JsValue {
    let found = own(c.get("o"), str_of(c, "k"));
    JsObject::new()
        .with("value", found.map(JsValue::from))
        .into()
}

fn run_denial(inputs: &Inputs, c: &Value) -> JsValue {
    let p = inputs.program(str_of(c, "program"));
    match denial_diagnostics(&p, c.get("report").unwrap()) {
        Ok(ds) => texts(&ds),
        Err(message) => JsObject::new().with("throws", message).into(),
    }
}

fn run_validate(c: &Value) -> JsValue {
    texts(&validate_lock(c.get("value").unwrap_or(&Value::Null)))
}

#[test]
fn the_lock_is_what_the_typescript_gives() {
    let inputs = Inputs {
        file: read_json("crates/mandate-check/tests/lock/inputs.json").unwrap(),
    };
    let expected = read_json("crates/mandate-check/tests/lock/expected.json").unwrap();
    type Run = fn(&Inputs, &Value) -> JsValue;
    let sections: Vec<(&str, Run)> = vec![
        ("checks", run_check),
        ("direct", run_direct),
        ("sandbox", run_sandbox),
        ("requirements", |_, c| run_requirement(c)),
        ("isolation", |_, c| run_isolation(c)),
        ("bounds", |_, c| run_bound(c)),
        ("models", run_models),
        ("packaged", |_, c| run_packaged(c)),
        ("own", |_, c| run_own(c)),
        ("denials", run_denial),
        ("validate", |_, c| run_validate(c)),
    ];
    let mut failures = Vec::new();
    let mut compared = 0_usize;
    for (name, run) in &sections {
        let want = expected
            .get(name)
            .and_then(Value::as_object)
            .unwrap_or_else(|| panic!("no expectations for {name}"));
        let items = inputs.section(name);
        assert_eq!(items.len(), want.len(), "{name}: every result is compared");
        for item in items {
            let id = str_of(item, "id");
            let expected_text = want
                .get(id)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{name} {id}: no expectation"));
            let actual = text_of(&run(&inputs, item));
            compared += 1;
            if let Err(why) = compare_text(expected_text, &actual) {
                failures.push(format!("{name} {id}: {why}"));
            }
        }
    }
    println!(
        "lock vectors: compared {compared}, failed {}",
        failures.len()
    );
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
