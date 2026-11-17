//! The views of a program of 0.7 whose workflows have an `owner`
//! (spec/attention.md "`owner`"): the architecture, authority and cost
//! views, the document and the card of each workflow are made as for the
//! same program without its owners, with its lock of 0.7 or without one.
//! Showing the owner on the card is a later slice's (RP2): until then a
//! view does not read it. No TypeScript reads 0.7, so every expectation is
//! written by hand.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_ir::{Value, stringify};
use mandate_syntax::{SourceKind, load};
use mandate_testkit::{read_json, read_text};
use mandate_views::{
    architecture_with_lock, authority_with, card, card_doc, cost_with, program_doc, to_html,
    to_markdown,
};

fn program(text: &str) -> Value {
    load(text, SourceKind::Mdt).program.unwrap()
}

/// Every view of `p` this slice holds, as one text, with `lock`.
fn views(p: &Value, lock: Option<&Value>) -> String {
    let mut out = Vec::new();
    out.push(stringify(&architecture_with_lock(p, lock, None).to_js()).unwrap());
    out.push(stringify(&authority_with(p, None).to_js()).unwrap());
    out.push(stringify(&cost_with(p, lock, None).to_js()).unwrap());
    let doc = program_doc(p, lock, None);
    out.push(to_markdown(&doc));
    out.push(to_html(&doc));
    for w in ["Describe", "Check"] {
        out.push(stringify(&card(p, w, lock, None).unwrap().to_js()).unwrap());
        out.push(to_markdown(&card_doc(p, w, lock, None).unwrap()));
    }
    out.join("\n")
}

#[test]
fn the_views_of_a_program_with_owners_are_those_of_the_program_without() {
    let text = read_text("fixtures/attention/owner.mdt").unwrap();
    let with = program(&text);
    let without = program(
        &text
            .replace("  owner   accountant\n", "")
            .replace("  owner   finance_lead\n", ""),
    );
    let lock = read_json("fixtures/attention/owner.lock.json").unwrap();
    for l in [None, Some(&lock)] {
        let (a, b) = (views(&with, l), views(&without, l));
        // Only the program's hash differs: the owner is part of the
        // program.
        let strip = |s: &str| {
            let mut out = String::new();
            let mut rest = s;
            while let Some(at) = rest.find("sha256:") {
                out.push_str(&rest[..at]);
                rest = rest[at + 7..].trim_start_matches(|c: char| c.is_ascii_hexdigit());
            }
            out.push_str(rest);
            out
        };
        assert_eq!(strip(&a), strip(&b));
    }
}
