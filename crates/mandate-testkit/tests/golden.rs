//! The golden gate: what the Rust compiler prints for each program pinned
//! in `compiler/test/golden/outputs.json` must have the digest the
//! TypeScript compiler's output has there (see `compiler/test/golden.test.ts`
//! for what each output is). Release 0.5 closes when `PENDING` is empty.
//!
//! It lives in this crate because the outputs come from every compiler
//! crate (`load` and `fmt` from the syntax, `check` and `hash` from the
//! checks, the views from the views): the testkit depends on none of them,
//! so its tests can take each as a dev-dependency as it is written, and no
//! test moves when an output moves from one crate to another.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use mandate_ir::{Diagnostic, JsValue, Loaded, canonicalize, stringify_pretty};
use mandate_syntax::{kind_of, load};
use mandate_testkit::{Golden, GoldenOutput, compare_digest, read_text, run_gate};

/// The outputs the Rust crates do not give yet, as `<output> @ <program>`
/// patterns. Shorten it in the commit that makes an item pass.
const PENDING: &[&str] = &[
    "check @ *",
    "check --module @ *",
    "check --lock @ *",
    "fmt @ *",
    "hash @ *",
    "view --format json @ *",
    "view --format md @ *",
    "view --format html @ *",
    "view --against itself @ *",
    "sandbox @ *",
];

/// What the Rust crates print for one pinned output.
fn output(o: &GoldenOutput<'_>) -> Result<String, String> {
    // `load(text, kindOf(file))`.
    let loaded =
        || -> Result<Loaded, String> { Ok(load(&read_text(o.program)?, kind_of(o.program))) };
    match o.output {
        // `canonicalize(load(text, kind).program)`.
        "ir --canonical" => loaded()?
            .program
            .map(|program| canonicalize(&program))
            .ok_or_else(|| "load gave no program".to_owned()),
        // `JSON.stringify(load(text, kind).diagnostics, null, 2) + "\n"`.
        "load" => {
            let loaded = loaded()?;
            let diagnostics =
                JsValue::Array(loaded.diagnostics.iter().map(Diagnostic::to_js).collect());
            let mut text = stringify_pretty(&diagnostics).unwrap_or_default();
            text.push('\n');
            Ok(text)
        }
        _ => Err("no Rust implementation yet".to_owned()),
    }
}

#[test]
fn golden_outputs() {
    let golden = Golden::load().expect("the golden file");
    let items = golden.outputs().map(|o| (o.name(), o));
    let gate = run_gate("golden outputs", PENDING, items, |o| {
        compare_digest(o.digest, &output(o)?)
    });
    if let Err(report) = gate {
        panic!("{report}");
    }
}
