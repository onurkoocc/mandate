//! The command line run in memory: every command, every refusal, and the
//! library commands with their rules, over an `MemoryIo` that holds the
//! repository's fixtures. Nothing here starts a process, so it runs under
//! `scripts/wasi-test.mjs` too.
//!
//! What the commands of the Node command line print is held to the two
//! golden files (`compiler/test/golden/outputs.json`, written by the
//! TypeScript compiler, and `vectors/golden/0.6.json`): the digest of what
//! `mandate <command>` writes to standard output is the digest pinned for
//! that output of that program.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod deep;

use mandate_check::library::{LibrarySource, load_library};
use mandate_cli::{Io, MemoryIo, run};
use mandate_ir::{Value, canonicalize, parse};
use mandate_lib::Timestamp;
use mandate_testkit::rust_vectors::{GOLDEN_0_6, GOLDEN_0_7};
use mandate_testkit::{Golden, files, library_files, path, read_text, sha256};

const OPS: &str = "fixtures/library/upgrade/acme.ops";
const VERSIONS: [&str; 5] = ["1.0.0", "1.0.1", "1.1.0", "1.2.0", "2.0.0"];

/// Runs `mandate <args>` over `io`, whose two streams are emptied first.
fn mandate(io: &mut MemoryIo, args: &[&str]) -> i32 {
    io.out.clear();
    io.err.clear();
    let owned: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    run(&owned, io)
}

/// The repository file `rel` put into `io` under the same path.
fn put(io: &mut MemoryIo, rel: &str) {
    io.files
        .insert(rel.to_owned(), mandate_testkit::read_bytes(rel).unwrap());
}

/// The repository file `rel` put into `io` as `to`.
fn put_as(io: &mut MemoryIo, rel: &str, to: &str) {
    io.files
        .insert(to.to_owned(), mandate_testkit::read_bytes(rel).unwrap());
}

fn seconds(time: &str) -> i64 {
    Timestamp::parse(time).unwrap().unix_seconds()
}

fn json(text: &str) -> Value {
    parse(text)
        .unwrap_or_else(|d| panic!("not JSON: {d:?}\n{text}"))
        .value
}

/// The operator's directory `libs` with the versions `versions` of
/// acme.ops, each as the repository holds it (published, with its index).
fn ops_io(versions: &[&str]) -> MemoryIo {
    let mut io = MemoryIo::new();
    for v in versions {
        for f in ["mandate.library.json", "ops.mdt", "index.json"] {
            put_as(
                &mut io,
                &format!("{OPS}/{v}/{f}"),
                &format!("libs/acme.ops/{v}/{f}"),
            );
        }
    }
    io.now = seconds("2026-11-15T00:00:00Z");
    io
}

/// The version `v` of acme.ops put into `io` as the source directory `src`.
fn ops_source(io: &mut MemoryIo, v: &str) {
    for f in ["mandate.library.json", "ops.mdt"] {
        put_as(io, &format!("{OPS}/{v}/{f}"), &format!("src/{f}"));
    }
}

/// The lock that pins acme.ops 1.0.0 (the one of conformance/L02).
fn ops_lock(io: &mut MemoryIo) {
    put_as(io, "conformance/L02/mandate.lock.json", "mandate.lock.json");
}

fn digest_of(dir: &str) -> String {
    let (manifest, files) = library_files(dir).unwrap();
    load_library(&LibrarySource { manifest, files }, false, "x")
        .unwrap()
        .digest
        .to_string()
}

/// The version the lock in `io` pins acme.ops at.
fn pinned(io: &MemoryIo, lock: &str) -> Option<String> {
    let lock = json(io.text(lock)?);
    lock.get("libraries")?
        .get("acme.ops")?
        .get("version")?
        .as_str()
        .map(str::to_owned)
}

// ── the commands of the Node command line, held to the golden files ──────

/// `MODULE_FILES` of `compiler/test/golden-outputs.ts`, and what
/// `crates/mandate-testkit/tests/outputs/mod.rs` gives the programs of 0.6.
fn module_files_of(program: &str) -> Vec<&'static str> {
    match program {
        "fixtures/envelope/migrate-all.mdt" => vec!["fixtures/envelope/domain.mdt"],
        "fixtures/library/summarize.mdt" => vec!["fixtures/library/shared.mdt"],
        "fixtures/library/drafts.mdt" | "fixtures/library/review.mdt" => vec![
            "fixtures/library/acme.connectors/types.mdt",
            "fixtures/library/acme.connectors/connectors.mdt",
        ],
        // Their modules are their libraries': the acceptance program's from
        // its lock, the shaped migration's the built-in std.patterns alone.
        "fixtures/library/invoices.mdt" | "fixtures/library/migrate-all.mdt" => Vec::new(),
        "fixtures/library/batch.mdt" => vec![
            "fixtures/library/acme.connectors/types.mdt",
            "fixtures/library/acme.connectors/connectors.mdt",
            "fixtures/library/batch.patterns.mdt",
        ],
        _ => vec![
            "fixtures/system/acme.system.mdt",
            "fixtures/system/repos.mdt",
        ],
    }
}

/// `lockFileOf` of `compiler/test/helpers.ts`.
fn lock_file_of(program: &str) -> Option<String> {
    let (dir, file) = program.rsplit_once('/').unwrap();
    let name = file.rsplit_once('.').map_or(file, |(name, _)| name);
    [
        format!("{dir}/{name}.lock.json"),
        format!("{dir}/mandate.lock.json"),
    ]
    .into_iter()
    .find(|p| path(p).exists())
}

/// The acceptance library in the layout of the operator's directory.
fn acme_connectors(io: &mut MemoryIo) {
    for f in ["mandate.library.json", "connectors.mdt", "types.mdt"] {
        put_as(
            io,
            &format!("fixtures/library/acme.connectors/{f}"),
            &format!("libs/acme.connectors/2.3.0/{f}"),
        );
    }
    io.put(
        "libs/acme.connectors/2.3.0/index.json",
        "{ \"published_at\": \"2026-11-01T09:00:00Z\" }\n",
    );
}

/// What `mandate <args>` of `program` writes to standard output, with the
/// program, its modules and (with `locked`) its lock in the file system.
fn output(program: &str, locked: bool, with_modules: bool, command: &[&str]) -> String {
    let mut io = MemoryIo::new();
    put(&mut io, program);
    let mut args: Vec<String> = command.iter().map(|a| (*a).to_owned()).collect();
    if let Some(at) = args.iter().position(|a| a == "FILE") {
        args[at] = program.to_owned();
    }
    if with_modules {
        for m in module_files_of(program) {
            put(&mut io, m);
            args.extend(["--module".to_owned(), m.to_owned()]);
        }
    }
    if locked && let Some(lock) = lock_file_of(program) {
        put(&mut io, &lock);
        // `mandate.lock.json` beside the program is found without being named.
        if !lock.ends_with("/mandate.lock.json") {
            args.extend(["--lock".to_owned(), lock]);
        }
        if program == "fixtures/library/invoices.mdt" {
            acme_connectors(&mut io);
            args.extend(["--libraries".to_owned(), "libs".to_owned()]);
        }
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    mandate(&mut io, &borrowed);
    io.out
}

/// An output of the golden files and the command that prints it: its name,
/// whether the program's lock and its modules are given, the arguments.
type Pinned = (&'static str, bool, bool, Vec<&'static str>);

#[test]
fn every_command_prints_what_the_golden_files_pin() {
    let mut problems: Vec<String> = Vec::new();
    let mut compared = 0;
    let mut programs = 0;
    let goldens = [
        (Golden::load().unwrap(), false),
        (Golden::read(GOLDEN_0_6).unwrap(), true),
        (Golden::read(GOLDEN_0_7).unwrap(), true),
    ];
    for (golden, of_0_6) in &goldens {
        for program in golden.programs() {
            programs += 1;
            let has_lock = lock_file_of(program).is_some();
            // A program whose modules are its libraries' has them from its
            // lock alone: the command line has no check of it with its
            // libraries and without its lock.
            let from_libraries = program == "fixtures/library/invoices.mdt";
            let commands: Vec<Pinned> = vec![
                ("check", false, false, vec!["check", "FILE", "--json"]),
                (
                    "check --module",
                    false,
                    true,
                    vec!["check", "FILE", "--json"],
                ),
                ("check --lock", true, true, vec!["check", "FILE", "--json"]),
                (
                    "ir --canonical",
                    false,
                    false,
                    vec!["ir", "FILE", "--canonical"],
                ),
                ("fmt", false, false, vec!["fmt", "FILE"]),
                ("hash", false, false, vec!["hash", "FILE"]),
                (
                    "view --format json",
                    true,
                    true,
                    vec!["view", "FILE", "--format", "json"],
                ),
                ("view --format md", true, true, vec!["view", "FILE"]),
                (
                    "view --format html",
                    true,
                    true,
                    vec!["view", "FILE", "--format", "html"],
                ),
                ("sandbox", true, true, vec!["sandbox", "FILE"]),
                (
                    "view --card --format json",
                    true,
                    true,
                    vec!["view", "FILE", "--card", "--format", "json"],
                ),
                (
                    "view --card --format md",
                    true,
                    true,
                    vec!["view", "FILE", "--card"],
                ),
                (
                    "view --card --format html",
                    true,
                    true,
                    vec!["view", "FILE", "--card", "--format", "html"],
                ),
            ];
            for (name, locked, with_modules, command) in commands {
                let Some(digest) = golden.digest(program, name) else {
                    continue;
                };
                if name == "check --module" && from_libraries {
                    continue;
                }
                if name == "check --lock" && !has_lock {
                    continue;
                }
                // The golden file of the TypeScript pins the document made
                // with the program's modules; `mandate view` of cli.ts makes
                // it from the program alone (0.1 to 0.5: the test after
                // this one). A program of 0.6 is shown with its modules.
                if !of_0_6 && ["view --format md", "view --format html"].contains(&name) {
                    continue;
                }
                let text = output(program, locked, with_modules, &command);
                compared += 1;
                if sha256(&text) != digest {
                    let start: String = text.chars().take(300).collect();
                    problems.push(format!(
                        "{name} @ {program}: not the pinned output; it begins\n{start}"
                    ));
                }
            }
        }
    }
    println!("golden outputs through the command line: {programs} programs, {compared} outputs");
    assert!(programs >= 30, "{programs} programs");
    assert!(compared >= 240, "{compared} outputs");
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

/// `mandate view` of a program of 0.1 to 0.5 as Markdown or HTML is the
/// document of the program alone, as cli.ts makes it
/// (`programDoc(program, lock)`), whatever modules are given.
#[test]
fn the_document_of_a_program_before_0_6_is_made_from_the_program_alone() {
    let program = "fixtures/envelope/migrate-all.mdt";
    let text = read_text(program).unwrap();
    let p = mandate_syntax::load(&text, mandate_syntax::SourceKind::Mdt)
        .program
        .unwrap();
    let doc = mandate_views::program_doc(&p, None, None);
    assert_eq!(
        output(program, true, true, &["view", "FILE"]),
        mandate_views::to_markdown(&doc)
    );
    assert_eq!(
        output(program, true, true, &["view", "FILE", "--format", "html"]),
        mandate_views::to_html(&doc)
    );
    assert!(mandate_views::to_markdown(&doc).contains("generated from the program alone"));
}

#[test]
fn check_says_ok_with_the_hash_or_the_diagnostics_on_standard_error() {
    let mut io = MemoryIo::new();
    put(&mut io, "fixtures/fixbug/fixbug.mdt");
    put(&mut io, "fixtures/fixbug/mandate.lock.json");
    assert_eq!(
        mandate(&mut io, &["check", "fixtures/fixbug/fixbug.mdt"]),
        0
    );
    assert!(
        io.out.starts_with("ok sha256:") && io.out.ends_with('\n'),
        "{}",
        io.out
    );
    assert!(!io.err.contains("error"), "{}", io.err);
    // A program that does not check: nothing on standard output, one line
    // a diagnostic on standard error, exit status 1.
    io.put("bad.mdt", "mandate @ 0.5\n\nthis is not a program\n");
    assert_eq!(mandate(&mut io, &["check", "bad.mdt"]), 1);
    assert_eq!(io.out, "");
    assert!(io.err.starts_with("bad.mdt:"), "{}", io.err);
    assert!(io.err.contains(": error MDT-E"), "{}", io.err);
    // As JSON it is all on standard output.
    assert_eq!(mandate(&mut io, &["check", "bad.mdt", "--json"]), 1);
    assert_eq!(io.err, "");
    let answer = json(&io.out);
    assert_eq!(answer.get("ok"), Some(&Value::Bool(false)));
    assert!(
        answer
            .get("diagnostics")
            .and_then(Value::as_array)
            .is_some()
    );
}

#[test]
fn a_lock_or_a_denial_report_that_is_not_json_stops_the_check() {
    let mut io = MemoryIo::new();
    put(&mut io, "fixtures/fixbug/fixbug.mdt");
    put(&mut io, "fixtures/fixbug/mandate.lock.json");
    io.put("not.json", "{ this is not json");
    let file = "fixtures/fixbug/fixbug.mdt";
    assert_eq!(mandate(&mut io, &["check", file, "--lock", "not.json"]), 1);
    assert!(io.err.starts_with("not.json:1:"), "{}", io.err);
    assert_eq!(io.out, "");
    assert_eq!(
        mandate(&mut io, &["check", file, "--denials", "not.json"]),
        1
    );
    assert!(io.err.starts_with("not.json:1:"), "{}", io.err);
    // A report that names no denial adds nothing; one of another program
    // is said (E0104 is an error: exit status 1).
    io.put("denials.json", "{\"format\":\"made-up\",\"denials\":[]}");
    let code = mandate(
        &mut io,
        &["check", file, "--denials", "denials.json", "--json"],
    );
    let answer = json(&io.out);
    assert_eq!(
        code,
        i32::from(answer.get("ok") != Some(&Value::Bool(true)))
    );
    // A lock that is missing where it is named cannot be read.
    assert_eq!(mandate(&mut io, &["check", file, "--lock", "none.json"]), 2);
    assert!(
        io.err.starts_with("mandate: cannot read none.json: "),
        "{}",
        io.err
    );
}

#[test]
fn a_module_that_does_not_load_stops_every_command() {
    let mut io = MemoryIo::new();
    put(&mut io, "fixtures/fixbug/fixbug.mdt");
    io.put("broken.mdt", "mandate @ 0.5\n\nthis is not a module\n");
    for command in [
        vec![
            "check",
            "fixtures/fixbug/fixbug.mdt",
            "--module",
            "broken.mdt",
        ],
        vec!["explain", "E0101", "--module", "broken.mdt"],
    ] {
        assert_eq!(mandate(&mut io, &command), 1, "{command:?}");
        assert!(io.err.starts_with("broken.mdt:"), "{}", io.err);
        assert_eq!(io.out, "");
    }
    assert_eq!(
        mandate(&mut io, &["explain", "E0101", "--module", "none.mdt"]),
        2
    );
    assert!(
        io.err.starts_with("mandate: cannot read none.mdt: "),
        "{}",
        io.err
    );
}

#[test]
fn ir_fmt_and_hash_print_the_program() {
    let mut io = MemoryIo::new();
    let file = "fixtures/fixbug/fixbug.mdt";
    put(&mut io, file);
    // The pretty IR is the canonical one, read and written with two spaces.
    assert_eq!(mandate(&mut io, &["ir", file, "--canonical"]), 0);
    let canonical = io.out.clone();
    assert!(!canonical.ends_with('\n'));
    assert_eq!(mandate(&mut io, &["ir", file]), 0);
    assert!(io.out.starts_with("{\n  \""), "{}", &io.out[..40]);
    assert_eq!(canonicalize(&json(&io.out)), canonical);
    // The IR it printed is a program: it reads, and prints as the same IR.
    io.put("again.ir.json", &canonical);
    assert_eq!(mandate(&mut io, &["ir", "again.ir.json", "--canonical"]), 0);
    assert_eq!(io.out, canonical);
    assert_eq!(mandate(&mut io, &["fmt", file]), 0);
    let printed = io.out.clone();
    assert!(printed.starts_with("mandate @ "), "{printed}");
    assert_eq!(mandate(&mut io, &["hash", file]), 0);
    assert!(
        json(&io.out)
            .get("program")
            .and_then(Value::as_str)
            .is_some()
    );
    // Standard input stands for the file `-` (the native command's alone).
    io.input = mandate_testkit::read_bytes(file).unwrap();
    assert_eq!(mandate(&mut io, &["fmt", "-"]), 0);
    assert_eq!(io.out, printed);
    // A program that does not load.
    io.put("bad.mdt", "mandate @ 0.5\n\nthis is not a program\n");
    for cmd in ["ir", "fmt", "hash"] {
        assert_eq!(mandate(&mut io, &[cmd, "bad.mdt"]), 1, "{cmd}");
        assert_eq!(io.out, "", "{cmd}");
        assert!(io.err.contains(" error MDT-E"), "{cmd}: {}", io.err);
    }
}

#[test]
fn patch_applies_operations_written_for_the_program_hash() {
    let mut io = MemoryIo::new();
    let file = "fixtures/fixbug/fixbug.mdt";
    put(&mut io, file);
    assert_eq!(mandate(&mut io, &["hash", file]), 0);
    let hash = json(&io.out)
        .get("program")
        .and_then(Value::as_str)
        .unwrap()
        .to_owned();
    // No operation: the program as it is, as IR.
    io.put("empty.json", &format!("{{\"base\":\"{hash}\",\"ops\":[]}}"));
    assert_eq!(
        mandate(&mut io, &["patch", file, "empty.json"]),
        0,
        "{}",
        io.err
    );
    assert!(io.out.starts_with("{\n"), "{}", io.out);
    let patched = canonicalize(&json(&io.out));
    assert_eq!(mandate(&mut io, &["ir", file, "--canonical"]), 0);
    assert_eq!(patched, io.out);
    assert_eq!(
        mandate(&mut io, &["patch", file, "empty.json", "--json"]),
        0
    );
    let answer = json(&io.out);
    assert_eq!(answer.get("ok"), Some(&Value::Bool(true)));
    assert_eq!(
        answer.get("hash").and_then(Value::as_str),
        Some(hash.as_str())
    );
    assert!(answer.get("governance").and_then(Value::as_array).is_some());
    assert!(answer.get("program").and_then(Value::as_object).is_some());
    // Written for another hash: refused, exit status 1.
    io.put("stale.json", "{\"base\":\"sha256:0000\",\"ops\":[]}");
    assert_eq!(mandate(&mut io, &["patch", file, "stale.json"]), 1);
    assert_eq!(io.out, "");
    assert!(io.err.contains(" error MDT-E"), "{}", io.err);
    assert_eq!(
        mandate(&mut io, &["patch", file, "stale.json", "--json"]),
        1
    );
    let answer = json(&io.out);
    assert_eq!(answer.get("hash"), Some(&Value::Null));
    assert_eq!(answer.get("program"), Some(&Value::Null));
    // A patch file of another shape is a usage error; one that is not
    // JSON is reported; one argument is not enough.
    io.put("wrong.json", "{\"ops\":\"none\"}");
    assert_eq!(mandate(&mut io, &["patch", file, "wrong.json"]), 2);
    assert_eq!(
        io.err,
        "mandate: patch file must be { \"base\": \"sha256:…\", \"ops\": [ … ] }\n"
    );
    io.put("not.json", "{ this is not json");
    assert_eq!(mandate(&mut io, &["patch", file, "not.json"]), 1);
    assert!(io.err.starts_with("not.json:1:"), "{}", io.err);
    assert_eq!(mandate(&mut io, &["patch", file]), 2);
    assert!(io.err.starts_with("usage: mandate"), "{}", io.err);
}

#[test]
fn sandbox_prints_every_requirement_or_the_one_of_an_agent() {
    let mut io = MemoryIo::new();
    let file = "fixtures/fixbug/fixbug.mdt";
    put(&mut io, file);
    put(&mut io, "fixtures/fixbug/mandate.lock.json");
    assert_eq!(mandate(&mut io, &["sandbox", file]), 0, "{}", io.err);
    let all = json(&io.out);
    assert!(all.get("program").and_then(Value::as_str).is_some());
    let requirements = all.get("requirements").and_then(Value::as_object).unwrap();
    let agent = requirements
        .keys()
        .next()
        .expect("a local agent")
        .to_owned();
    assert_eq!(mandate(&mut io, &["sandbox", file, "--agent", &agent]), 0);
    assert_eq!(
        canonicalize(&json(&io.out)),
        canonicalize(requirements.get(&agent).unwrap())
    );
    assert_eq!(mandate(&mut io, &["sandbox", file, "--agent", "Nobody"]), 2);
    assert_eq!(
        io.err,
        format!("mandate: no local agent Nobody in {file}\n")
    );
    assert_eq!(io.out, "");
}

#[test]
fn target_acs_writes_the_manifest_the_policy_and_the_requirement_of_each_agent() {
    let mut io = MemoryIo::new();
    let file = "fixtures/fixbug/fixbug.mdt";
    put(&mut io, file);
    put(&mut io, "fixtures/fixbug/mandate.lock.json");
    assert_eq!(
        mandate(&mut io, &["target", "acs", file, "--out", "o"]),
        0,
        "{}",
        io.err
    );
    let profile = json(io.text("o/profile.json").expect("profile.json"));
    let agents: Vec<String> = profile
        .get("agents")
        .and_then(Value::as_array)
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap().to_owned())
        .collect();
    assert!(!agents.is_empty());
    let binding = profile.get("binding").and_then(Value::as_str).unwrap();
    assert_eq!(
        io.out,
        format!(
            "wrote {} agent(s) to o; hosts present {binding} as envelope.agent.version\n",
            agents.len()
        )
    );
    for a in &agents {
        assert!(io.dirs.contains(&format!("o/{a}")), "{a}");
        assert!(
            json(io.text(&format!("o/{a}.manifest.json")).unwrap())
                .as_object()
                .is_some()
        );
        assert!(
            io.text(&format!("o/{a}/policy.rego"))
                .unwrap()
                .contains("package")
        );
        let requirement = json(io.text(&format!("o/{a}.sandbox-requirement.json")).unwrap());
        assert_eq!(mandate(&mut io, &["sandbox", file, "--agent", a]), 0);
        assert_eq!(canonicalize(&json(&io.out)), canonicalize(&requirement));
    }
    // As JSON: the summary with where it was written; `acs` in `./acs`.
    assert_eq!(mandate(&mut io, &["target", "acs", file, "--json"]), 0);
    let answer = json(&io.out);
    assert_eq!(answer.get("out").and_then(Value::as_str), Some("acs"));
    assert_eq!(answer.get("binding").and_then(Value::as_str), Some(binding));
    assert!(io.text("acs/profile.json").is_some());
    // Only `target acs` is a target; a directory that cannot be made.
    assert_eq!(mandate(&mut io, &["target", "other", file]), 2);
    assert!(io.err.starts_with("usage: mandate"));
    io.denied.insert("no".to_owned());
    assert_eq!(mandate(&mut io, &["target", "acs", file, "--out", "no"]), 2);
    assert_eq!(io.err, "mandate: cannot make no: permission denied\n");
}

#[test]
fn view_shows_the_program_its_diff_and_its_card() {
    let mut io = MemoryIo::new();
    let file = "fixtures/envelope/migrate-all.mdt";
    let domain = "fixtures/envelope/domain.mdt";
    put(&mut io, file);
    put(&mut io, domain);
    assert_eq!(
        mandate(&mut io, &["view", file, "--module", domain]),
        0,
        "{}",
        io.err
    );
    assert!(io.out.starts_with("# "), "{}", io.out);
    // Against itself nothing changed, in each format.
    let against = ["view", file, "--module", domain, "--against", file];
    assert_eq!(mandate(&mut io, &against), 0, "{}", io.err);
    assert!(io.out.starts_with("# "));
    let mut as_json = against.to_vec();
    as_json.extend(["--format", "json"]);
    assert_eq!(mandate(&mut io, &as_json), 0);
    let diff = json(&io.out);
    assert_eq!(diff.get("kind").and_then(Value::as_str), Some("diff"));
    assert_eq!(
        diff.get("governance")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(0)
    );
    // The card, and its refusals.
    let card = ["view", file, "--module", domain, "--card"];
    assert_eq!(mandate(&mut io, &card), 0, "{}", io.err);
    let mut named = card.to_vec();
    named.extend(["--workflow", "Nobody"]);
    assert_eq!(mandate(&mut io, &named), 2);
    assert!(
        io.err.starts_with(&format!(
            "mandate: no workflow Nobody with an envelope in {file}; name one with --workflow: "
        )),
        "{}",
        io.err
    );
    let mut both = card.to_vec();
    both.extend(["--against", file]);
    assert_eq!(mandate(&mut io, &both), 2);
    assert!(io.err.starts_with("usage: mandate"));
    assert_eq!(
        mandate(
            &mut io,
            &["view", file, "--module", domain, "--format", "pdf"]
        ),
        2
    );
    assert!(io.err.starts_with("usage: mandate"));
    // A program of 0.5 without an envelope has no card.
    put(&mut io, "fixtures/boundary/fetch.mdt");
    put(&mut io, "fixtures/boundary/mandate.lock.json");
    assert_eq!(
        mandate(&mut io, &["view", "fixtures/boundary/fetch.mdt", "--card"]),
        1
    );
    assert_eq!(
        io.err,
        "mandate: fixtures/boundary/fetch.mdt has no workflow with an envelope, so it has no card\n"
    );
    // A program that does not check has no view.
    io.put("bad.mdt", "mandate @ 0.5\n\nthis is not a program\n");
    assert_eq!(mandate(&mut io, &["view", "bad.mdt"]), 1);
    assert_eq!(io.out, "");
}

#[test]
fn explain_prints_a_code_of_the_table() {
    let mut io = MemoryIo::new();
    let row = mandate_ir::codes::lookup("MDT-E1607").expect("E1607");
    for code in ["E1607", "MDT-E1607"] {
        assert_eq!(mandate(&mut io, &["explain", code]), 0);
        assert_eq!(
            io.out,
            format!("MDT-E1607 {}\n\n{}\n", row.title, row.explain)
        );
    }
    assert_eq!(mandate(&mut io, &["explain", "E0101", "--json"]), 0);
    let answer = json(&io.out);
    let members: Vec<&str> = answer.as_object().unwrap().keys().collect();
    assert_eq!(members, ["code", "title", "explain"]);
    assert_eq!(
        answer.get("code").and_then(Value::as_str),
        Some("MDT-E0101")
    );
    assert_eq!(mandate(&mut io, &["explain", "E9999"]), 2);
    assert_eq!(io.err, "mandate: unknown code E9999\n");
    assert_eq!(io.out, "");
    assert_eq!(mandate(&mut io, &["explain"]), 2);
    assert!(io.err.starts_with("usage: mandate"));
}

#[test]
fn what_is_not_a_command_of_this_executable_is_refused() {
    let mut io = MemoryIo::new();
    for args in [
        vec![],
        vec!["nothing"],
        vec!["check"],
        vec!["check", "f", "--lock"],
    ] {
        assert_eq!(mandate(&mut io, &args), 2, "{args:?}");
        assert!(
            io.err.starts_with("usage: mandate <command> [options]\n"),
            "{}",
            io.err
        );
        assert_eq!(io.out, "");
    }
    for cmd in [
        "mcp", "run", "resume", "status", "approve", "journal", "test", "egress",
    ] {
        let code = mandate(&mut io, &[cmd, "x"]);
        assert_eq!(code, 2, "{cmd}");
        assert_eq!(io.out, "");
        if cmd == "resume" {
            // Not a command of either command line.
            assert!(io.err.starts_with("usage: mandate"), "{}", io.err);
        } else {
            assert!(
                io.err
                    .starts_with(&format!("mandate: {cmd} is not in this executable: ")),
                "{}",
                io.err
            );
        }
    }
}

#[test]
fn a_file_that_is_missing_or_cannot_be_read_is_a_usage_error() {
    let mut io = MemoryIo::new();
    put(&mut io, "fixtures/fixbug/fixbug.mdt");
    io.denied.insert("secret.mdt".to_owned());
    for cmd in ["check", "ir", "fmt", "hash", "sandbox", "view"] {
        assert_eq!(mandate(&mut io, &[cmd, "none.mdt"]), 2, "{cmd}");
        assert_eq!(
            io.err, "mandate: cannot read none.mdt: no such file\n",
            "{cmd}"
        );
        assert_eq!(io.out, "", "{cmd}");
        assert_eq!(mandate(&mut io, &[cmd, "secret.mdt"]), 2, "{cmd}");
        assert_eq!(
            io.err, "mandate: cannot read secret.mdt: permission denied\n",
            "{cmd}"
        );
    }
    assert_eq!(mandate(&mut io, &["target", "acs", "none.mdt"]), 2);
    assert_eq!(mandate(&mut io, &["patch", "none.mdt", "p.json"]), 2);
    assert_eq!(
        mandate(&mut io, &["patch", "fixtures/fixbug/fixbug.mdt", "p.json"]),
        2
    );
    assert_eq!(io.err, "mandate: cannot read p.json: no such file\n");
    // A lock beside the program that is there and cannot be read.
    io.denied
        .insert("fixtures/fixbug/mandate.lock.json".to_owned());
    assert_eq!(
        mandate(&mut io, &["check", "fixtures/fixbug/fixbug.mdt"]),
        2
    );
    assert_eq!(
        io.err,
        "mandate: cannot read fixtures/fixbug/mandate.lock.json: permission denied\n"
    );
}

/// The deepest program of 0.6 that loads checks through the command (here
/// within the stack of the test; the executable's own stack is
/// `tests/process.rs`'s to hold).
#[test]
fn the_deepest_program_checks() {
    let mut io = MemoryIo::new();
    io.put("deep.mdt", &deep::deep_program(54));
    assert_eq!(mandate(&mut io, &["check", "deep.mdt"]), 0, "{}", io.err);
    assert!(io.out.starts_with("ok sha256:"), "{}", io.out);
}

// ── libraries ────────────────────────────────────────────────────────────

#[test]
fn add_pins_the_highest_version_and_writes_the_lock() {
    let mut io = ops_io(&VERSIONS);
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops@^1.0", "--libraries", "libs"]),
        0,
        "{}",
        io.err
    );
    let digest = digest_of(&format!("{OPS}/1.2.0"));
    assert!(
        io.out.starts_with(&format!(
            "acme.ops 1.2.0 {digest}\nauthority signature:\n{{\n"
        )),
        "{}",
        io.out
    );
    assert!(io.out.contains("\"acme.ops.Inventory\": {"), "{}", io.out);
    assert!(
        io.out.ends_with("}\nwrote mandate.lock.json\n"),
        "{}",
        io.out
    );
    assert_eq!(io.err, "");
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.2.0"));
    assert!(io.text("mandate.lock.json").unwrap().ends_with("}\n"));
    // Any version: the highest of all. The lock --lock names, in its place.
    assert_eq!(
        mandate(
            &mut io,
            &[
                "add",
                "acme.ops",
                "--libraries",
                "libs",
                "--lock",
                "d/l.json"
            ]
        ),
        0
    );
    assert_eq!(pinned(&io, "d/l.json").as_deref(), Some("2.0.0"));
    assert!(io.out.ends_with("wrote d/l.json\n"));
    // An exact version, into a new lock: the lock of conformance/L02.
    let mut io = ops_io(&VERSIONS);
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops@1.0.0", "--libraries", "libs"]),
        0
    );
    assert_eq!(
        canonicalize(&json(io.text("mandate.lock.json").unwrap())),
        canonicalize(&json(
            &read_text("conformance/L02/mandate.lock.json").unwrap()
        ))
    );
    // Nothing within the range: E1606, and no lock.
    let mut io = ops_io(&VERSIONS);
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops@^3", "--libraries", "libs"]),
        1
    );
    assert!(
        io.err.starts_with("mandate.lock.json: error MDT-E1606: "),
        "{}",
        io.err
    );
    assert_eq!(io.out, "");
    assert!(io.text("mandate.lock.json").is_none());
    // A library the directory does not hold: the same.
    assert_eq!(
        mandate(&mut io, &["add", "acme.other", "--libraries", "libs"]),
        1
    );
    assert!(io.err.contains(" error MDT-E1606: "), "{}", io.err);
}

#[test]
fn add_prints_what_the_door_gives_as_json() {
    let mut io = ops_io(&VERSIONS);
    assert_eq!(
        mandate(
            &mut io,
            &["add", "acme.ops@^1.0", "--libraries", "libs", "--json"]
        ),
        0
    );
    assert_eq!(io.err, "");
    let answer = json(&io.out);
    let members: Vec<&str> = answer.as_object().unwrap().keys().collect();
    assert_eq!(
        members,
        [
            "ok",
            "diagnostics",
            "resolution",
            "version",
            "digest",
            "signature",
            "lock"
        ]
    );
    assert_eq!(answer.get("version").and_then(Value::as_str), Some("1.2.0"));
    // The lock it gives is the lock it wrote.
    assert_eq!(
        canonicalize(answer.get("lock").unwrap()),
        canonicalize(&json(io.text("mandate.lock.json").unwrap()))
    );
    assert_eq!(
        mandate(
            &mut io,
            &["add", "acme.ops@^3", "--libraries", "libs", "--json"]
        ),
        1
    );
    let answer = json(&io.out);
    assert_eq!(answer.get("ok"), Some(&Value::Bool(false)));
    assert_eq!(answer.get("lock"), Some(&Value::Null));
}

#[test]
fn add_pins_the_builtin_library_with_no_directory() {
    let mut io = MemoryIo::new();
    io.now = seconds("2026-11-15T00:00:00Z");
    assert_eq!(mandate(&mut io, &["add", "std.patterns"]), 0, "{}", io.err);
    let digest = mandate_check::library::std_patterns_digest(None).unwrap();
    assert!(
        io.out
            .starts_with(&format!("std.patterns 1.0.0 {digest}\n")),
        "{}",
        io.out
    );
    let lock = json(io.text("mandate.lock.json").unwrap());
    assert_eq!(
        lock.get("lock").and_then(Value::as_str),
        Some("mandate/lock/0.6")
    );
    // Any other library needs the directory.
    assert_eq!(mandate(&mut io, &["add", "acme.ops"]), 2);
    assert!(
        io.err.starts_with("mandate: no directory of libraries: "),
        "{}",
        io.err
    );
    // What is not a library's name is not looked for in the directory.
    for name in ["../acme", "Acme", "acme/ops", ""] {
        assert_eq!(
            mandate(&mut io, &["add", name, "--libraries", "libs"]),
            2,
            "{name}"
        );
        assert_eq!(
            io.err,
            format!("mandate: {name} is not the name of a library\n")
        );
    }
    assert_eq!(mandate(&mut io, &["add"]), 2);
    assert!(io.err.starts_with("usage: mandate"));
}

/// The waiting period and the directory come from the configuration:
/// `mandate.runtime.json` of the working directory, or `--config`.
#[test]
fn a_version_within_its_waiting_period_is_not_resolved() {
    let mut io = ops_io(&VERSIONS);
    io.now = seconds("2026-11-13T12:00:00Z");
    io.put(
        "mandate.runtime.json",
        "{\"database\":\"pglite:db\",\"libraries\":{\"dir\":\"libs\",\"wait_days\":2}}",
    );
    // 1.2.0, published on the 12th, waits; 1.1.0 is taken.
    assert_eq!(mandate(&mut io, &["add", "acme.ops@^1.0"]), 0, "{}", io.err);
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.1.0"));
    // Exactly 1.2.0: E1608 naming the day, and the lock is not written.
    let before = io.text("mandate.lock.json").unwrap().to_owned();
    assert_eq!(mandate(&mut io, &["add", "acme.ops@1.2.0"]), 1);
    assert!(
        io.err.starts_with("mandate.lock.json: error MDT-E1608: "),
        "{}",
        io.err
    );
    assert!(io.err.contains("2026-11-14"), "{}", io.err);
    assert_eq!(io.out, "");
    assert_eq!(io.text("mandate.lock.json"), Some(before.as_str()));
    // Without the configuration nothing waits; --config names another.
    io.put("conf/other.json", "{\"libraries\":{\"dir\":\"../libs\"}}");
    io.files.remove("mandate.lock.json");
    assert_eq!(
        mandate(
            &mut io,
            &[
                "add",
                "acme.ops@^1.0",
                "--config",
                "conf/other.json",
                "--libraries",
                "libs"
            ]
        ),
        0
    );
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.2.0"));
    // An upgrade waits as an add does.
    let mut io = ops_io(&VERSIONS);
    io.now = seconds("2026-11-13T12:00:00Z");
    io.put(
        "mandate.runtime.json",
        "{\"libraries\":{\"dir\":\"libs\",\"wait_days\":30}}",
    );
    ops_lock(&mut io);
    assert_eq!(mandate(&mut io, &["upgrade", "acme.ops@1.0.1"]), 1);
    assert!(io.err.contains(" error MDT-E1608: "), "{}", io.err);
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.0.0"));
}

#[test]
fn a_revoked_digest_is_not_resolved() {
    let mut io = ops_io(&VERSIONS);
    let revoked = digest_of(&format!("{OPS}/1.2.0"));
    io.put(
        "mandate.runtime.json",
        &format!("{{\"libraries\":{{\"dir\":\"libs\",\"revoked\":[\"{revoked}\"]}}}}"),
    );
    assert_eq!(mandate(&mut io, &["add", "acme.ops@^1.0"]), 0, "{}", io.err);
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.1.0"));
    io.files.remove("mandate.lock.json");
    assert_eq!(mandate(&mut io, &["add", "acme.ops@1.2.0"]), 1);
    assert!(
        io.err.starts_with("mandate.lock.json: error MDT-E1608: "),
        "{}",
        io.err
    );
    assert!(io.err.contains(&revoked), "{}", io.err);
    assert!(io.text("mandate.lock.json").is_none());
}

#[test]
fn a_configuration_that_cannot_be_read_stops_the_command() {
    let mut io = ops_io(&VERSIONS);
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops", "--config", "none.json"]),
        2
    );
    assert_eq!(io.err, "mandate: cannot read none.json: no such file\n");
    io.put("c.json", "{ not json");
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops", "--config", "c.json"]),
        1
    );
    assert!(io.err.starts_with("c.json:1:"), "{}", io.err);
    io.put("c.json", "[]");
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops", "--config", "c.json"]),
        2
    );
    assert_eq!(
        io.err,
        "mandate: c.json is not a configuration: it is not an object\n"
    );
    // A member the reader does not know is refused, not read as nothing.
    io.put(
        "c.json",
        "{\"libraries\":{\"dir\":\"libs\",\"wait_day\":7}}",
    );
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops", "--config", "c.json"]),
        2
    );
    assert!(
        io.err.starts_with(
            "mandate: c.json: its member libraries is not { dir, wait_days?, revoked? }: "
        ),
        "{}",
        io.err
    );
    assert!(io.text("mandate.lock.json").is_none());
    // A lock that is not a lock.
    io.put("mandate.lock.json", "[]");
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops", "--libraries", "libs"]),
        2
    );
    assert_eq!(
        io.err,
        "mandate: mandate.lock.json is not a lock: it is not an object\n"
    );
}

/// The gate of `--accept-governance`: an upgrade that widens the authority
/// signature shows the change and leaves the lock as it is.
#[test]
fn an_upgrade_with_a_governance_change_writes_the_lock_only_when_it_is_accepted() {
    let mut io = ops_io(&VERSIONS);
    ops_lock(&mut io);
    let before = io.text("mandate.lock.json").unwrap().to_owned();
    let upgrade = ["upgrade", "acme.ops@1.1.0", "--libraries", "libs"];
    assert_eq!(mandate(&mut io, &upgrade), 1);
    assert_eq!(io.err, "");
    let digest = digest_of(&format!("{OPS}/1.1.0"));
    assert!(
        io.out
            .starts_with(&format!("acme.ops 1.0.0 -> 1.1.0 {digest}\n")),
        "{}",
        io.out
    );
    assert!(
        io.out.contains(
            "\ngovernance change: widened at acme.ops.Inventory: ~ acme.ops.Inventory.budget.time"
        ),
        "{}",
        io.out
    );
    assert!(
        io.out
            .contains("\ngovernance change: budget_increased at acme.ops"),
        "{}",
        io.out
    );
    assert!(io.out.contains("\nauthority signature:\n{\n"), "{}", io.out);
    assert!(
        io.out.ends_with(
            " governance change(s); mandate.lock.json is written only with --accept-governance\n"
        ),
        "{}",
        io.out
    );
    assert_eq!(
        io.text("mandate.lock.json"),
        Some(before.as_str()),
        "the lock was written"
    );
    // As JSON: what the door gives, its lock null; still nothing written.
    let mut as_json = upgrade.to_vec();
    as_json.push("--json");
    assert_eq!(mandate(&mut io, &as_json), 1);
    let answer = json(&io.out);
    assert_eq!(answer.get("ok"), Some(&Value::Bool(true)));
    assert_eq!(answer.get("lock"), Some(&Value::Null));
    assert!(
        !answer
            .get("governance")
            .and_then(Value::as_array)
            .unwrap()
            .is_empty()
    );
    assert_eq!(io.text("mandate.lock.json"), Some(before.as_str()));
    // A raised class of a connector is held the same.
    assert_eq!(
        mandate(
            &mut io,
            &["upgrade", "acme.ops@1.2.0", "--libraries", "libs"]
        ),
        1
    );
    assert!(
        io.out.contains("governance change: widened at acme.ops.store: ~ connector acme.ops.store.class: internal → confidential\n"),
        "{}",
        io.out
    );
    assert_eq!(io.text("mandate.lock.json"), Some(before.as_str()));
    // Accepted: the same changes shown, and the lock written.
    let mut accepted = upgrade.to_vec();
    accepted.push("--accept-governance");
    assert_eq!(mandate(&mut io, &accepted), 0, "{}", io.err);
    assert!(
        io.out
            .contains("\ngovernance change: widened at acme.ops.Inventory: "),
        "{}",
        io.out
    );
    assert!(io.out.ends_with("wrote mandate.lock.json\n"), "{}", io.out);
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.1.0"));
}

#[test]
fn an_upgrade_without_a_governance_change_writes_the_lock() {
    let mut io = ops_io(&VERSIONS);
    ops_lock(&mut io);
    // A doc line changed: a behavior change at most.
    assert_eq!(
        mandate(
            &mut io,
            &["upgrade", "acme.ops@1.0.1", "--libraries", "libs"]
        ),
        0,
        "{}",
        io.err
    );
    assert!(
        io.out.starts_with("acme.ops 1.0.0 -> 1.0.1 sha256:"),
        "{}",
        io.out
    );
    assert!(!io.out.contains("governance change"), "{}", io.out);
    assert!(io.out.ends_with("wrote mandate.lock.json\n"), "{}", io.out);
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.0.1"));
    // A library the lock does not pin is added first.
    let mut io = ops_io(&VERSIONS);
    assert_eq!(
        mandate(&mut io, &["upgrade", "acme.ops", "--libraries", "libs"]),
        1
    );
    assert!(
        io.err.starts_with("mandate.lock.json: error MDT-E1605: "),
        "{}",
        io.err
    );
    assert!(io.text("mandate.lock.json").is_none());
    // The pinned version is not in the directory as the lock pins it.
    let mut io = ops_io(&["1.0.1", "1.1.0"]);
    ops_lock(&mut io);
    assert_eq!(
        mandate(
            &mut io,
            &["upgrade", "acme.ops@1.0.1", "--libraries", "libs"]
        ),
        1
    );
    assert!(io.err.contains(" error MDT-E1601: "), "{}", io.err);
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.0.0"));
}

#[test]
fn publish_copies_the_library_and_writes_its_index_last() {
    let mut io = ops_io(&["1.0.0"]);
    ops_source(&mut io, "1.0.1");
    assert_eq!(
        mandate(&mut io, &["publish", "src", "--libraries", "libs"]),
        0,
        "{}",
        io.err
    );
    let digest = digest_of(&format!("{OPS}/1.0.1"));
    assert_eq!(
        io.out,
        format!("published acme.ops 1.0.1 {digest} to libs/acme.ops/1.0.1\n")
    );
    assert_eq!(io.err, "");
    for f in ["mandate.library.json", "ops.mdt"] {
        assert_eq!(
            io.text(&format!("libs/acme.ops/1.0.1/{f}")),
            io.text(&format!("src/{f}")),
            "{f}"
        );
    }
    assert_eq!(
        io.text("libs/acme.ops/1.0.1/index.json"),
        Some("{ \"published_at\": \"2026-11-15T00:00:00Z\" }\n")
    );
    // What was published is what `add` resolves.
    assert_eq!(
        mandate(&mut io, &["add", "acme.ops@^1.0", "--libraries", "libs"]),
        0,
        "{}",
        io.err
    );
    assert_eq!(pinned(&io, "mandate.lock.json").as_deref(), Some("1.0.1"));
    // A version already published: E1607.
    assert_eq!(
        mandate(&mut io, &["publish", "src", "--libraries", "libs"]),
        1
    );
    assert!(
        io.err
            .starts_with("src/mandate.library.json: error MDT-E1607: "),
        "{}",
        io.err
    );
    // A source that is not a library, and no directory to publish into.
    assert_eq!(
        mandate(&mut io, &["publish", "nowhere", "--libraries", "libs"]),
        2
    );
    assert_eq!(
        io.err,
        "mandate: cannot read nowhere/mandate.library.json: no such file\n"
    );
    assert_eq!(mandate(&mut io, &["publish", "src"]), 2);
    assert!(
        io.err.starts_with("mandate: no directory of libraries: "),
        "{}",
        io.err
    );
    assert_eq!(mandate(&mut io, &["publish"]), 2);
    // The directory from the configuration.
    let mut io = ops_io(&["1.0.0"]);
    ops_source(&mut io, "2.0.0");
    io.put(
        "etc/mandate.runtime.json",
        "{\"libraries\":{\"dir\":\"../libs\"}}",
    );
    assert_eq!(
        mandate(
            &mut io,
            &[
                "publish",
                "src",
                "--config",
                "etc/mandate.runtime.json",
                "--json"
            ]
        ),
        0
    );
    let answer = json(&io.out);
    assert_eq!(answer.get("ok"), Some(&Value::Bool(true)));
    assert_eq!(answer.get("version").and_then(Value::as_str), Some("2.0.0"));
    assert!(io.text("etc/../libs/acme.ops/2.0.0/index.json").is_some());
}

/// E1607: a version that widens the signature of the version below it and
/// is not a major one is refused, and nothing is written.
#[test]
fn publish_refuses_a_version_that_widens_and_is_not_major() {
    for (version, what) in [("1.1.0", "budget_increased"), ("1.2.0", "widened")] {
        let mut io = ops_io(&["1.0.0"]);
        ops_source(&mut io, version);
        let before = io.files.clone();
        assert_eq!(
            mandate(&mut io, &["publish", "src", "--libraries", "libs"]),
            1,
            "{version}"
        );
        assert!(
            io.err
                .starts_with("src/mandate.library.json: error MDT-E1607: "),
            "{version}: {}",
            io.err
        );
        assert!(
            io.out
                .contains(&format!("against 1.0.0: governance change: {what} at ")),
            "{version}: {}",
            io.out
        );
        assert!(!io.out.contains("published"), "{version}: {}", io.out);
        assert_eq!(io.files, before, "{version}: something was written");
        assert!(io.dirs.is_empty(), "{version}: a directory was made");
        // As JSON: the door's answer, with no files to copy.
        assert_eq!(
            mandate(
                &mut io,
                &["publish", "src", "--libraries", "libs", "--json"]
            ),
            1
        );
        let answer = json(&io.out);
        assert_eq!(answer.get("ok"), Some(&Value::Bool(false)));
        assert!(answer.get("files").is_none());
        assert_eq!(io.files, before);
    }
    // The same change as a major version is published.
    let mut io = ops_io(&["1.0.0"]);
    ops_source(&mut io, "2.0.0");
    assert_eq!(
        mandate(&mut io, &["publish", "src", "--libraries", "libs"]),
        0,
        "{}",
        io.err
    );
    assert!(io.text("libs/acme.ops/2.0.0/index.json").is_some());
}

#[test]
fn a_program_is_checked_with_the_libraries_its_lock_pins() {
    let mut io = MemoryIo::new();
    let file = "fixtures/library/invoices.mdt";
    let lock = "fixtures/library/invoices.lock.json";
    put(&mut io, file);
    put(&mut io, lock);
    acme_connectors(&mut io);
    let check = ["check", file, "--lock", lock, "--libraries", "libs"];
    assert_eq!(mandate(&mut io, &check), 0, "{}", io.err);
    assert!(io.out.starts_with("ok sha256:"), "{}", io.out);
    // The directory from the configuration, relative to it.
    io.put("mandate.runtime.json", "{\"libraries\":{\"dir\":\"libs\"}}");
    assert_eq!(
        mandate(&mut io, &["check", file, "--lock", lock]),
        0,
        "{}",
        io.err
    );
    io.files.remove("mandate.runtime.json");
    // Without the directory the pinned library was not handed in: E1605.
    assert_eq!(mandate(&mut io, &["check", file, "--lock", lock]), 1);
    assert!(io.err.contains(" error MDT-E1605: "), "{}", io.err);
    // A library that is not what the lock pins: E1605.
    let types = "libs/acme.connectors/2.3.0/types.mdt";
    let text = io.text(types).unwrap().to_owned();
    io.put(
        types,
        &format!("{text}\n/// Another line.\npub type Extra = {{ id: Text }}\n"),
    );
    assert_eq!(mandate(&mut io, &check), 1);
    assert!(io.err.contains(" error MDT-E1605: "), "{}", io.err);
    io.put(types, &text);
    // The card of a workflow without an envelope, in each format, and the
    // views, with the modules of the library.
    for format in ["md", "html", "json"] {
        let card = [
            "view",
            file,
            "--lock",
            lock,
            "--libraries",
            "libs",
            "--card",
            "--format",
            format,
        ];
        assert_eq!(mandate(&mut io, &card), 0, "{format}: {}", io.err);
        assert!(io.out.contains("MatchInvoices"), "{format}");
        assert!(io.out.contains("acme.connectors"), "{format}");
    }
    assert_eq!(
        mandate(
            &mut io,
            &[
                "view",
                file,
                "--lock",
                lock,
                "--libraries",
                "libs",
                "--against",
                file,
                "--against-lock",
                lock,
                "--format",
                "json"
            ]
        ),
        0,
        "{}",
        io.err
    );
    let diff = json(&io.out);
    assert_eq!(
        diff.get("governance")
            .and_then(Value::as_array)
            .map(<[Value]>::len),
        Some(0)
    );
    assert_eq!(
        mandate(
            &mut io,
            &[
                "target",
                "acs",
                file,
                "--lock",
                lock,
                "--libraries",
                "libs",
                "--out",
                "o"
            ]
        ),
        0,
        "{}",
        io.err
    );
}

/// E1608 at a check: a pinned digest the configuration revokes.
#[test]
fn a_check_refuses_a_pinned_library_whose_digest_is_revoked() {
    let mut io = MemoryIo::new();
    let file = "fixtures/library/invoices.mdt";
    let lock = "fixtures/library/invoices.lock.json";
    put(&mut io, file);
    put(&mut io, lock);
    acme_connectors(&mut io);
    let digest = digest_of("fixtures/library/acme.connectors");
    io.put(
        "mandate.runtime.json",
        &format!("{{\"libraries\":{{\"dir\":\"libs\",\"revoked\":[\"{digest}\"]}}}}"),
    );
    for cmd in [
        vec!["check", file, "--lock", lock],
        vec!["view", file, "--lock", lock, "--card"],
    ] {
        assert_eq!(mandate(&mut io, &cmd), 1, "{cmd:?}");
        assert!(io.err.contains(" error MDT-E1608: "), "{cmd:?}: {}", io.err);
        assert!(io.err.contains(&digest), "{cmd:?}: {}", io.err);
        assert_eq!(io.out, "", "{cmd:?}");
    }
    // Another digest revoked: it checks.
    io.put(
        "mandate.runtime.json",
        &format!(
            "{{\"libraries\":{{\"dir\":\"libs\",\"revoked\":[\"sha256:{}\"]}}}}",
            "0".repeat(64)
        ),
    );
    assert_eq!(
        mandate(&mut io, &["check", file, "--lock", lock]),
        0,
        "{}",
        io.err
    );
}

#[test]
fn the_fixtures_this_file_reads_are_there() {
    // A fixture renamed would make a test above pass for nothing.
    assert_eq!(files(&format!("{OPS}/1.0.0")).unwrap().len(), 3);
    let mut io = MemoryIo::new();
    io.put("a/b/c.txt", "x");
    io.put("a/d.txt", "y");
    let names: Vec<(String, bool)> = io
        .list_dir("a")
        .unwrap()
        .into_iter()
        .map(|e| (e.name, e.is_dir))
        .collect();
    assert_eq!(names, [("b".to_owned(), true), ("d.txt".to_owned(), false)]);
    assert!(io.list_dir("nowhere").is_err());
    assert_eq!(io.parent("a/b/c.txt"), "a/b");
    assert_eq!(io.parent("c.txt"), "");
    assert_eq!(io.join("a", "b"), "a/b");
    assert_eq!(io.join("a", "/b"), "/b");
}
