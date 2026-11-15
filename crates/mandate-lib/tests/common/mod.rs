//! What the tests of this crate share: a table that collects every failing
//! case before it fails, and the JSON text of a problem.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::fmt::Debug;

use mandate_ir::{JsObject, JsValue, stringify};

/// A table of cases. A case that differs from what it should be is noted,
/// and [`Table::finish`] fails with all of them, so that one run shows
/// every case that is wrong (a panic ends a WASI test executable).
#[derive(Default)]
pub struct Table {
    cases: usize,
    failures: Vec<String>,
}

impl Table {
    pub fn new() -> Table {
        Table::default()
    }

    /// Notes a failure when `got` is not `want`.
    pub fn eq<T: Debug + PartialEq>(&mut self, case: &str, got: T, want: T) {
        self.cases += 1;
        if got != want {
            self.failures
                .push(format!("{case}\n    got:  {got:?}\n    want: {want:?}"));
        }
    }

    /// Notes a failure when `holds` is false.
    pub fn ok(&mut self, case: &str, holds: bool) {
        self.eq(case, holds, true);
    }

    /// Fails when any case failed; the number of cases otherwise.
    pub fn finish(self) -> usize {
        assert!(
            self.failures.is_empty(),
            "{} of {} cases failed:\n{}",
            self.failures.len(),
            self.cases,
            self.failures.join("\n")
        );
        self.cases
    }
}

/// The JSON text of an object.
pub fn json(object: JsObject) -> String {
    stringify(&JsValue::Object(object)).expect("a JSON object")
}
