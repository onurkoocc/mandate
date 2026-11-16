//! The `mandate` executable, started as a process: its exit status, what
//! goes to standard output and what to standard error, the real file system
//! behind the library commands, and the 64 MiB stack of the thread it runs
//! on. What each command prints is `tests/cli.rs`'s to hold; here a few
//! outputs are held to the golden files again, through the process.
//!
//! WASI has no processes, so `scripts/wasi-test.mjs` builds nothing of this
//! file: it runs where `cargo test` runs natively (the `rust` job of CI).

#![cfg(not(target_os = "wasi"))]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod deep;

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use deep::deep_program;
use mandate_testkit::{Golden, repo, sha256};

/// `mandate <args>`, run in the repository root.
fn mandate(args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_mandate"))
        .args(args)
        .current_dir(repo())
        .output()
        .expect("the mandate executable starts")
}

fn out(o: &Output) -> String {
    String::from_utf8(o.stdout.clone()).expect("standard output is UTF-8")
}

fn err(o: &Output) -> String {
    String::from_utf8(o.stderr.clone()).expect("standard error is UTF-8")
}

/// A directory of this test's own, empty, under cargo's directory for the
/// files of integration tests.
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("mandate-cli-{name}"));
    if dir.exists() {
        std::fs::remove_dir_all(&dir).expect("the old directory is removed");
    }
    std::fs::create_dir_all(&dir).expect("the directory is made");
    dir
}

fn text(path: &Path) -> &str {
    path.to_str().expect("a path that is UTF-8")
}

#[test]
fn the_exit_status_and_the_two_streams_are_the_commands() {
    // It checks: the hash on standard output, nothing on standard error.
    let ok = mandate(&["check", "fixtures/fixbug/fixbug.mdt"]);
    assert_eq!(ok.status.code(), Some(0), "{}", err(&ok));
    assert!(out(&ok).starts_with("ok sha256:"), "{}", out(&ok));
    assert!(!err(&ok).contains("error"), "{}", err(&ok));
    // It does not: the diagnostics on standard error, exit status 1.
    let dir = scratch("streams");
    let bad = dir.join("bad.mdt");
    std::fs::write(&bad, "mandate @ 0.5\n\nthis is not a program\n").unwrap();
    let no = mandate(&["check", text(&bad)]);
    assert_eq!(no.status.code(), Some(1));
    assert_eq!(out(&no), "");
    assert!(err(&no).contains(": error MDT-E"), "{}", err(&no));
    // As JSON the diagnostics are standard output's.
    let no = mandate(&["check", text(&bad), "--json"]);
    assert_eq!(no.status.code(), Some(1));
    assert!(out(&no).starts_with("{\n  \"ok\": false,"), "{}", out(&no));
    assert_eq!(err(&no), "");
    // Usage errors: exit status 2, on standard error.
    for args in [
        vec![],
        vec!["nothing"],
        vec!["run", "x"],
        vec!["mcp"],
        vec!["check", "no-such-file.mdt"],
        vec!["explain", "E9999"],
    ] {
        let o = mandate(&args);
        assert_eq!(o.status.code(), Some(2), "{args:?}");
        assert_eq!(out(&o), "", "{args:?}");
        assert!(!err(&o).is_empty(), "{args:?}");
    }
    assert!(err(&mandate(&[])).starts_with("usage: mandate <command> [options]\n"));
    assert!(
        err(&mandate(&["check", "no-such-file.mdt"]))
            .starts_with("mandate: cannot read no-such-file.mdt: ")
    );
    assert!(err(&mandate(&["run", "x"])).starts_with("mandate: run is not in this executable: "));
}

/// What the executable prints for the programs of the TypeScript's golden
/// file is what that file pins: the native command line against the
/// outputs the Node one's compiler wrote.
#[test]
fn the_executable_prints_what_the_golden_file_pins() {
    let golden = Golden::load().expect("the golden file");
    let mut compared = 0;
    let mut problems: Vec<String> = Vec::new();
    for program in golden.programs() {
        for (name, args) in [
            ("ir --canonical", vec!["ir", program, "--canonical"]),
            ("fmt", vec!["fmt", program]),
            ("hash", vec!["hash", program]),
        ] {
            let Some(digest) = golden.digest(program, name) else {
                continue;
            };
            let o = mandate(&args);
            compared += 1;
            if o.status.code() != Some(0) || sha256(&out(&o)) != digest {
                problems.push(format!(
                    "{name} @ {program}: exit status {:?}, not the pinned output; standard error:\n{}",
                    o.status.code(),
                    err(&o)
                ));
            }
        }
    }
    assert!(compared >= 50, "{compared} outputs");
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_deepest_program_checks_on_the_commands_own_stack() {
    let dir = scratch("deep");
    let file = dir.join("deep.mdt");
    std::fs::write(&file, deep_program(54)).unwrap();
    let o = mandate(&["check", text(&file)]);
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    assert!(out(&o).starts_with("ok sha256:"), "{}", out(&o));
}

/// The command does not run on the main thread's stack: with the stack the
/// system gives a process cut to 512 KiB, the deepest program still checks,
/// on the 64 MiB of the command's own thread.
#[cfg(unix)]
#[test]
fn the_deepest_program_checks_whatever_stack_the_system_gives() {
    let dir = scratch("deep-small-stack");
    let file = dir.join("deep.mdt");
    std::fs::write(&file, deep_program(54)).unwrap();
    let o = Command::new("sh")
        .arg("-c")
        .arg("ulimit -s 512 && exec \"$0\" check \"$1\"")
        .arg(env!("CARGO_BIN_EXE_mandate"))
        .arg(file)
        .output()
        .expect("sh starts");
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    assert!(out(&o).starts_with("ok sha256:"), "{}", out(&o));
}

/// `publish`, `add` and `upgrade` over a real directory: what one writes
/// the next reads.
#[test]
fn the_library_commands_work_over_the_file_system() {
    let dir = scratch("libraries");
    let libs = dir.join("libs");
    let lock = dir.join("mandate.lock.json");
    let (libs, lock) = (text(&libs), text(&lock));
    let source = |v: &str| format!("fixtures/library/upgrade/acme.ops/{v}");
    // Published: the manifest, the module and the index.
    let o = mandate(&["publish", &source("1.0.0"), "--libraries", libs]);
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    assert!(
        out(&o).starts_with("published acme.ops 1.0.0 sha256:"),
        "{}",
        out(&o)
    );
    let version = Path::new(libs).join("acme.ops").join("1.0.0");
    for f in ["mandate.library.json", "ops.mdt", "index.json"] {
        assert!(version.join(f).is_file(), "{f}");
    }
    // Added: the lock written, pinning it.
    let o = mandate(&["add", "acme.ops", "--libraries", libs, "--lock", lock]);
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    assert!(out(&o).starts_with("acme.ops 1.0.0 sha256:"), "{}", out(&o));
    let written = std::fs::read_to_string(lock).unwrap();
    assert!(written.contains("\"version\": \"1.0.0\""), "{written}");
    // A version that widens and is not major is refused, and not written.
    let o = mandate(&["publish", &source("1.1.0"), "--libraries", libs]);
    assert_eq!(o.status.code(), Some(1));
    assert!(err(&o).contains(" error MDT-E1607: "), "{}", err(&o));
    assert!(!Path::new(libs).join("acme.ops").join("1.1.0").exists());
    // As a major version it is published; the upgrade to it shows a
    // governance change and leaves the lock, until it is accepted.
    let o = mandate(&["publish", &source("2.0.0"), "--libraries", libs]);
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    let upgrade = ["upgrade", "acme.ops", "--libraries", libs, "--lock", lock];
    let o = mandate(&upgrade);
    assert_eq!(o.status.code(), Some(1), "{}", err(&o));
    assert!(
        out(&o).contains("\ngovernance change: widened at "),
        "{}",
        out(&o)
    );
    assert_eq!(std::fs::read_to_string(lock).unwrap(), written);
    let mut accepted = upgrade.to_vec();
    accepted.push("--accept-governance");
    let o = mandate(&accepted);
    assert_eq!(o.status.code(), Some(0), "{}", err(&o));
    let written = std::fs::read_to_string(lock).unwrap();
    assert!(written.contains("\"version\": \"2.0.0\""), "{written}");
}
