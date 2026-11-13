//! The `verify-journal` command line: its arguments, and exit 2 whenever
//! nothing could be checked (spec/journal.md, the exit statuses of
//! `mandate journal verify`).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

fn case(id: &str, file: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../conformance")
        .join(id)
        .join(file)
}

fn run(args: &[&OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_verify-journal"))
        .args(args)
        .output()
        .expect("verify-journal runs")
}

fn code(out: &Output) -> Option<i32> {
    out.status.code()
}

/// A scratch directory of this test's own, under the target directory.
fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

#[test]
fn a_verified_export_exits_0_and_prints_the_report() {
    let (export, key) = (case("J01", "export.json"), case("J01", "key.pem"));
    let out = run(&[export.as_os_str(), OsStr::new("--key"), key.as_os_str()]);
    assert_eq!(
        code(&out),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        out.stdout,
        fs::read(case("J01", "report.json")).expect("the report")
    );
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        stderr.starts_with("verified: run j01, 10 events\n"),
        "{stderr}"
    );
    assert!(stderr.contains("signed through seq 10"), "{stderr}");
    // The key given as --key=FILE, and --json, which changes nothing.
    let mut flag = std::ffi::OsString::from("--key=");
    flag.push(key.as_os_str());
    let again = run(&[OsStr::new("--json"), flag.as_os_str(), export.as_os_str()]);
    assert_eq!(code(&again), Some(0));
    assert_eq!(again.stdout, out.stdout);
}

#[test]
fn a_broken_and_an_unchained_export_exit_1_and_an_unreadable_one_2() {
    for (id, exit) in [("J02", 1), ("J08", 1), ("J15", 2), ("J16", 2)] {
        let out = run(&[
            case(id, "export.json").as_os_str(),
            OsStr::new("--key"),
            case(id, "key.pem").as_os_str(),
        ]);
        assert_eq!(code(&out), Some(exit), "{id}");
        assert_eq!(
            out.stdout,
            fs::read(case(id, "report.json")).expect("the report"),
            "{id}"
        );
    }
}

#[test]
fn several_key_files_and_several_keys_in_one() {
    let dir = scratch("several-keys");
    let both = dir.join("both.pem");
    let mut text = fs::read(case("J02", "key.pem")).expect("a key");
    text.extend(fs::read(case("J01", "key.pem")).expect("a key"));
    fs::write(&both, text).expect("written");
    let export = case("J01", "export.json");
    let out = run(&[export.as_os_str(), OsStr::new("--key"), both.as_os_str()]);
    assert_eq!(code(&out), Some(0));
    let out = run(&[
        export.as_os_str(),
        OsStr::new("--key"),
        case("J02", "key.pem").as_os_str(),
        OsStr::new("--key"),
        case("J01", "key.pem").as_os_str(),
    ]);
    assert_eq!(code(&out), Some(0));
    // Only another key: checked, and not verified.
    let out = run(&[
        export.as_os_str(),
        OsStr::new("--key"),
        case("J02", "key.pem").as_os_str(),
    ]);
    assert_eq!(code(&out), Some(1));
}

#[test]
fn nothing_checked_exits_2() {
    let dir = scratch("unchecked");
    let export = case("J01", "export.json");
    let key = case("J01", "key.pem");
    let missing = dir.join("missing.json");
    let empty_key = dir.join("empty.pem");
    fs::write(&empty_key, "no key here\n").expect("written");
    let not_ed25519 = dir.join("x25519.pem");
    fs::write(
        &not_ed25519,
        "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n",
    )
    .expect("written");
    let k = OsStr::new("--key");
    for (what, args) in [
        ("no argument", vec![]),
        ("no key", vec![export.as_os_str()]),
        ("--key without a file", vec![export.as_os_str(), k]),
        (
            "two exports",
            vec![export.as_os_str(), export.as_os_str(), k, key.as_os_str()],
        ),
        (
            "an unknown option",
            vec![export.as_os_str(), k, key.as_os_str(), OsStr::new("--jsn")],
        ),
        (
            "a missing export",
            vec![missing.as_os_str(), k, key.as_os_str()],
        ),
        (
            "an export that is a directory",
            vec![dir.as_os_str(), k, key.as_os_str()],
        ),
        (
            "a missing key file",
            vec![export.as_os_str(), k, missing.as_os_str()],
        ),
        (
            "a key file that is a directory",
            vec![export.as_os_str(), k, dir.as_os_str()],
        ),
        (
            "a key file with no key",
            vec![export.as_os_str(), k, empty_key.as_os_str()],
        ),
        (
            "a key file with another kind of key",
            vec![export.as_os_str(), k, not_ed25519.as_os_str()],
        ),
        (
            "one bad key file among good ones",
            vec![
                export.as_os_str(),
                k,
                key.as_os_str(),
                k,
                empty_key.as_os_str(),
            ],
        ),
    ] {
        let out = run(&args);
        assert_eq!(code(&out), Some(2), "{what}");
        assert!(out.stdout.is_empty(), "{what}: no report");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.starts_with("verify-journal: "), "{what}: {stderr}");
    }
    let help = run(&[OsStr::new("--help")]);
    assert_eq!(code(&help), Some(0));
    assert!(String::from_utf8_lossy(&help.stdout).starts_with("usage: verify-journal"));
}
