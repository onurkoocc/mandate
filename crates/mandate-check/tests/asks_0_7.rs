//! The attention bound of language 0.7 (spec/attention.md "The attention
//! bound"): scratch.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_check::{CheckOptions, attention_facts, check};
use mandate_ir::stringify_pretty;
use mandate_syntax::SourceKind;
use mandate_testkit::read_text;

const ASKS: &str = "fixtures/attention/asks.mdt";

#[test]
fn scratch() {
    let text = read_text(ASKS).unwrap();
    let ir = mandate_syntax::load(&text, SourceKind::Mdt)
        .program
        .unwrap();
    println!(
        "IR {}",
        mandate_ir::stringify(&mandate_ir::JsValue::from(&ir)).unwrap()
    );
    let r = check(&text, SourceKind::Mdt, &CheckOptions::default());
    for d in &r.diagnostics {
        println!(
            "{} at {}: {}",
            d.code,
            d.at.path.as_deref().unwrap_or(""),
            d.message
        );
    }
    for w in [
        "Asking",
        "Approving",
        "Releasing",
        "Landing",
        "Handling",
        "Planning",
    ] {
        if let Some(f) = attention_facts(&text, SourceKind::Mdt, &CheckOptions::default(), w) {
            println!("{}", stringify_pretty(&f.to_js()).unwrap());
        }
    }
}
