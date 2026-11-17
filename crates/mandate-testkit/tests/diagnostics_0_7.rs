//! The diagnostic vectors of language 0.7, `vectors/diagnostics-0.7/`: the
//! whole result the Rust compiler gives for every compile case of 0.7 in
//! `conformance/` (whose `language` is `mandate/0.7`) and for the checks of
//! every 0.7 program of `fixtures/attention/`, in the layout and formats of
//! `vectors/diagnostics-0.6/` (`rust_diagnostics`). No TypeScript reads
//! 0.7, so the Rust writes them.
//!
//! A normal run makes them again and fails when one differs from the
//! committed file; `MANDATE_UPDATE_0_7=1` writes them instead
//! (`mandate_testkit::rust_vectors`). They catch a change of a message or a
//! span; the conformance cases of 0.7 say which codes and paths are right.

#![allow(clippy::expect_used, missing_docs)]

mod common;
mod outputs;
mod rust_diagnostics;

use mandate_testkit::rust_vectors::{DIAGNOSTICS_0_7, pin_0_7, programs_0_7};

#[test]
fn the_diagnostic_vectors_of_0_7_are_what_the_rust_gives() {
    rust_diagnostics::hold(&rust_diagnostics::Vectors {
        language: "mandate/0.7",
        version: "0.7",
        dir: DIAGNOSTICS_0_7,
        programs: programs_0_7().expect("the 0.7 programs"),
        pin: pin_0_7,
    });
}
