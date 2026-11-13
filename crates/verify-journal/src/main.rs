//! `verify-journal <export.json> --key <public key.pem> [--key FILE]…`
//!
//! Verifies an exported run journal under the public keys given, and reads
//! nothing else (spec/journal.md "Verification"). It prints the report,
//! `mandate/journal-verification/0.1`, on stdout exactly as
//! `mandate journal verify --json` prints it (`JSON.stringify(report, null,
//! 2)` and a line feed), and what it says, for a person, on stderr, as
//! `mandate journal verify` prints it without `--json`. `--json` is accepted
//! and changes nothing.
//!
//! A key file holds one or more PEM blocks `-----BEGIN PUBLIC KEY-----`, each
//! an Ed25519 SubjectPublicKeyInfo; `--key` may be given more than once.
//!
//! Exit status: 0 verified; 1 broken or unchained (the journal was checked,
//! and is not verified); 2 nothing could be checked: a usage error, an export
//! or key file that is missing, is not a file or cannot be read, a key file
//! that holds no Ed25519 public key, or an unreadable export.

#![forbid(unsafe_code)]

use std::ffi::OsString;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use verify_journal::{PublicKey, public_keys_in, verify_export};

const USAGE: &str =
    "usage: verify-journal <export.json> --key <public key.pem> [--key <public key.pem>]…";

/// Why nothing could be checked: exit 2.
struct Unchecked(String);

/// The command line, read.
struct Args {
    export: PathBuf,
    keys: Vec<PathBuf>,
}

/// Reads the arguments; `Ok(None)` for `--help`.
fn args(raw: Vec<OsString>) -> Result<Option<Args>, Unchecked> {
    let usage = |why: &str| Unchecked(format!("{why}\n{USAGE}"));
    let mut positional: Vec<PathBuf> = Vec::new();
    let mut keys: Vec<PathBuf> = Vec::new();
    let mut raw = raw.into_iter();
    let mut options = true;
    while let Some(arg) = raw.next() {
        let text = arg.to_str();
        if options {
            match text {
                Some("--") => {
                    options = false;
                    continue;
                }
                Some("-h" | "--help") => return Ok(None),
                Some("--json") => continue,
                Some("--key") => {
                    let file = raw
                        .next()
                        .ok_or_else(|| usage("--key needs a file: --key <public key.pem>"))?;
                    keys.push(PathBuf::from(file));
                    continue;
                }
                Some(t) if t.starts_with("--key=") => {
                    keys.push(PathBuf::from(t.strip_prefix("--key=").unwrap_or(t)));
                    continue;
                }
                Some(t) if t.starts_with('-') && t != "-" => {
                    return Err(usage(&format!("unknown option {t}")));
                }
                _ => {}
            }
        }
        positional.push(PathBuf::from(arg));
    }
    let mut positional = positional.into_iter();
    let (Some(export), None) = (positional.next(), positional.next()) else {
        return Err(usage("verify-journal takes one export file"));
    };
    if keys.is_empty() {
        return Err(usage(
            "verify-journal needs the public keys the anchors are verified against: --key <public key.pem> (mandate journal key writes them)",
        ));
    }
    Ok(Some(Args { export, keys }))
}

/// The bytes of a file that must be there and be a file.
fn read(path: &Path, what: &str) -> Result<Vec<u8>, Unchecked> {
    let shown = path.display();
    let meta = std::fs::metadata(path).map_err(|_| Unchecked(format!("no {what} at {shown}")))?;
    if !meta.is_file() {
        return Err(Unchecked(format!("{shown} is not a file; the {what} is")));
    }
    std::fs::read(path).map_err(|e| Unchecked(format!("cannot read the {what} {shown}: {e}")))
}

fn run(raw: Vec<OsString>) -> Result<u8, Unchecked> {
    let Some(a) = args(raw)? else {
        let _ = writeln!(std::io::stdout().lock(), "{USAGE}");
        return Ok(0);
    };
    let mut keys: Vec<PublicKey> = Vec::new();
    for file in &a.keys {
        // A key file is text; what is not UTF-8 in it is no PEM block.
        let text = String::from_utf8_lossy(&read(file, "key file")?).into_owned();
        let found =
            public_keys_in(&text).map_err(|e| Unchecked(format!("{} {e}", file.display())))?;
        keys.extend(found);
    }
    let bytes = read(&a.export, "export")?;
    let report = verify_export(&bytes, &keys);
    // A report that cannot be written is still the report: the exit status
    // says what it says.
    let _ = std::io::stdout()
        .lock()
        .write_all(report.to_pretty().as_bytes());
    let _ = std::io::stderr()
        .lock()
        .write_all(report.summary(&a.export.display().to_string()).as_bytes());
    Ok(report.status.exit_code())
}

fn main() -> ExitCode {
    match run(std::env::args_os().skip(1).collect()) {
        Ok(code) => ExitCode::from(code),
        Err(Unchecked(why)) => {
            let _ = writeln!(std::io::stderr().lock(), "verify-journal: {why}");
            ExitCode::from(2)
        }
    }
}
