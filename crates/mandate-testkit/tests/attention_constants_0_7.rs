//! The constants the attention algebra of 0.7 shares with the runtime
//! (spec/attention.md "The algebra"): each held equal to the runtime's own,
//! read from its source as text, since no test of the Rust can run the
//! TypeScript.
//!
//! - `RESTART_ALL_ROUNDS` (`crates/mandate-check/src/attention.rs`): how
//!   many rounds a `par` under `supervise restart_all` runs its branches at
//!   most, which a report's and a question's multiplicity count. The runtime
//!   says it in `par` of `runtime/src/interp.ts`:
//!   `const rounds = strategy === "restart_all" ? N : 1;`.

#![allow(clippy::panic, missing_docs)]

use mandate_check::attention::RESTART_ALL_ROUNDS;
use mandate_testkit::read_text;

const INTERP: &str = "runtime/src/interp.ts";
const ATTENTION: &str = "crates/mandate-check/src/attention.rs";

/// The `N` of `const rounds = strategy === "restart_all" ? N : 1;`, the
/// one such line of `text`.
fn restart_all_rounds(text: &str) -> Result<u64, String> {
    const HEAD: &str = "const rounds = strategy === \"restart_all\" ? ";
    const TAIL: &str = " : 1;";
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with(HEAD))
        .collect();
    let [line] = lines.as_slice() else {
        return Err(format!(
            "{} lines of the form `{HEAD}N{TAIL}`, not one",
            lines.len()
        ));
    };
    line.strip_prefix(HEAD)
        .and_then(|rest| rest.strip_suffix(TAIL))
        .and_then(|n| n.parse::<u64>().ok())
        .ok_or_else(|| format!("`{line}` is not of the form `{HEAD}N{TAIL}`"))
}

#[test]
fn restart_all_rounds_is_the_runtimes() {
    let text = read_text(INTERP).unwrap_or_else(|e| panic!("{e}"));
    let runtime = restart_all_rounds(&text).unwrap_or_else(|e| {
        panic!(
            "{INTERP}: {e}; the round count of `supervise restart_all` is no longer found there, and RESTART_ALL_ROUNDS of {ATTENTION} is held to it"
        )
    });
    assert_eq!(
        runtime, RESTART_ALL_ROUNDS,
        "RESTART_ALL_ROUNDS of {ATTENTION} is {RESTART_ALL_ROUNDS}, and {INTERP} runs the branches of a par under supervise restart_all {runtime} times: the two must be one number"
    );
    println!("RESTART_ALL_ROUNDS: {RESTART_ALL_ROUNDS}, as {INTERP} has it");
}

#[test]
fn the_reader_finds_the_line_and_only_it() {
    assert_eq!(
        restart_all_rounds("x\n    const rounds = strategy === \"restart_all\" ? 3 : 1;\n    y"),
        Ok(3)
    );
    assert!(restart_all_rounds("const rounds = 2;").is_err());
    assert!(restart_all_rounds("const rounds = strategy === \"restart_all\" ? two : 1;").is_err());
    assert!(
        restart_all_rounds(
            "const rounds = strategy === \"restart_all\" ? 2 : 1;\nconst rounds = strategy === \"restart_all\" ? 2 : 1;"
        )
        .is_err()
    );
}
