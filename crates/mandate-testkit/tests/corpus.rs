//! Tests of the corpus module of the testkit that need no door: the corpus
//! reads and agrees with its summary, and the digests of a program and of a
//! span table are what Node computes from the README's rule
//! (`JSON.stringify` of the value, UTF-8, SHA-256), so that a change to a
//! writer is found here and not as 145 failures.

#![allow(clippy::panic, clippy::expect_used, missing_docs)]

use mandate_ir::{Span, Spans, Value, parse};
use mandate_testkit::corpus::{Corpus, digest_of, ir_text, spans_text};

#[test]
fn the_corpus_reads() {
    let corpus = Corpus::load().unwrap_or_else(|e| panic!("{e}"));
    println!("corpus: {} entries", corpus.entries.len());
}

fn ir(text: &str) -> Value {
    parse(text).expect("the IR parses").value
}

#[test]
fn ir_digest_follows_the_member_order_of_javascript() {
    // Names that are array indices come first, in numeric order, at every
    // level; the others in the order they were written.
    let program = ir(r#"{"b":1,"10":2,"2":3,"a":{"z":[1,"x"],"1":null,"0":true}}"#);
    let text = ir_text(&program);
    assert_eq!(
        text,
        r#"{"2":3,"10":2,"b":1,"a":{"0":true,"1":null,"z":[1,"x"]}}"#
    );
    assert_eq!(
        digest_of(&text),
        "sha256:95972b7770a908caf0a121e34bc2c0c6e8fba63a48a56323772ac0d7dfab31f8"
    );
}

#[test]
fn ir_digest_escapes_as_json_stringify_does() {
    // Quote, backslash and the short escapes; \u00xx in lower case for the
    // other characters below U+0020; U+007F, U+2028, accented letters and a
    // character outside the BMP as themselves.
    let program = ir(r#"{"s":"a\"b\\c\b\f\n\r\t\u0001\u001f\u007f é😀/"}"#);
    let text = ir_text(&program);
    assert_eq!(
        text,
        "{\"s\":\"a\\\"b\\\\c\\b\\f\\n\\r\\t\\u0001\\u001f\u{7f}\u{2028}\u{e9}\u{1F600}/\"}"
    );
    assert_eq!(
        digest_of(&text),
        "sha256:54d62f2fb30d0cc28aeb42aa115c73451d872da78aca4615bef261f1eaa6da9b"
    );
}

#[test]
fn span_digest_sorts_by_utf16_not_utf8() {
    // U+FF5E sorts before U+1F600 in UTF-8 and after it in UTF-16.
    let span = |a, b, c, d| Span {
        start_line: a,
        start_col: b,
        end_line: c,
        end_col: d,
    };
    let mut spans = Spans::new();
    spans.insert("/\u{ff5e}".to_owned(), span(1, 2, 3, 4));
    spans.insert("/\u{1F600}".to_owned(), span(5, 6, 7, 8));
    spans.insert("/a".to_owned(), span(1, 1, 1, 2));
    spans.insert("/Z".to_owned(), span(2, 1, 2, 9));
    spans.insert(String::new(), span(1, 1, 9, 1));
    spans.insert("/10".to_owned(), span(3, 3, 3, 4));
    spans.insert("/9".to_owned(), span(4, 4, 4, 5));
    let text = spans_text(&spans);
    assert_eq!(
        text,
        "[[\"\",[1,1,9,1]],[\"/10\",[3,3,3,4]],[\"/9\",[4,4,4,5]],[\"/Z\",[2,1,2,9]],[\"/a\",[1,1,1,2]],[\"/\u{1F600}\",[5,6,7,8]],[\"/\u{ff5e}\",[1,2,3,4]]]"
    );
    assert_eq!(
        digest_of(&text),
        "sha256:94b722200c6788c0c719a9c9e47a247270e99e87ebcd06bfa6102e2af8d646f9"
    );
    // No spans: the digest of `[]`.
    assert_eq!(
        digest_of(&spans_text(&Spans::new())),
        "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945"
    );
}
