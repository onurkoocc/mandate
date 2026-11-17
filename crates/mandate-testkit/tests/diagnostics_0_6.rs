//! The diagnostic vectors of language 0.6, `vectors/diagnostics-0.6/`: the
//! whole result the Rust compiler gives for every compile case of 0.6 in
//! `conformance/` (whose `language` is `mandate/0.6`) and for the checks of
//! every 0.6 program of `fixtures/library/`, in the layout and formats of
//! `vectors/diagnostics/` (`conformance-N.json`, `golden-N.json`,
//! `summary.json`, written as `vectorText` in
//! `compiler/test/diagnostic-vectors.test.ts` writes them). No TypeScript
//! reads 0.6, so the Rust writes them (`rust_diagnostics`, shared with the
//! vectors of 0.7).
//!
//! A normal run makes them again and fails when one differs from the
//! committed file; `MANDATE_UPDATE_0_6=1` writes them instead
//! (`mandate_testkit::rust_vectors`). They hold messages and spans, which the
//! conformance cases do not compare: they catch a change of either; the
//! cases say which codes and paths are right.

#![allow(clippy::expect_used, missing_docs)]

mod common;
mod outputs;
mod rust_diagnostics;

use mandate_testkit::rust_vectors::{DIAGNOSTICS_0_6, pin, programs_0_6};

#[test]
fn the_diagnostic_vectors_of_0_6_are_what_the_rust_gives() {
    rust_diagnostics::hold(&rust_diagnostics::Vectors {
        language: "mandate/0.6",
        version: "0.6",
        dir: DIAGNOSTICS_0_6,
        programs: programs_0_6().expect("the 0.6 programs"),
        pin,
    });
}
