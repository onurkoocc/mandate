//! The text of what language 0.6 adds to every definition (spec/library.md
//! "The 0.6 surface"): `pub` before any kind and `///` doc lines, read into
//! the IR (`"pub": true`, `doc`) and printed back; and the same text in a
//! program of 0.5, which reads as it always did. No TypeScript reads 0.6, so
//! every expectation here is written by hand. The conformance cases of 0.6
//! (`P01`, `E0101` to `E0101g`, `E0104d`) say the same through `check`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    missing_docs
)]

use mandate_ir::{Value, canonicalize};
use mandate_syntax::{SourceKind, load, print_program};

/// The program `text` reads to, which must read without a diagnostic.
fn read(text: &str) -> Value {
    let loaded = load(text, SourceKind::Mdt);
    assert!(
        loaded.diagnostics.is_empty(),
        "{text}\n{:?}",
        loaded.diagnostics
    );
    loaded.program.expect("a program")
}

/// The one diagnostic `text` is refused with: its code, message and the
/// line and column it starts at.
fn refused(text: &str) -> (String, String, Option<(usize, usize)>) {
    let loaded = load(text, SourceKind::Mdt);
    assert!(loaded.program.is_none(), "{text} reads");
    assert_eq!(loaded.diagnostics.len(), 1, "{text}");
    let d = &loaded.diagnostics[0];
    (
        d.code.clone(),
        d.message.clone(),
        d.at.span.map(|s| (s.start_line, s.start_col)),
    )
}

fn def<'a>(p: &'a Value, name: &str) -> &'a Value {
    p.get("defs").and_then(|d| d.get(name)).expect(name)
}

/// One definition of every kind but `fn` (whose `pub` every version reads),
/// each after `pub`.
const EVERY_KIND: &str = r#"mandate @ 0.6

module example.kinds @ 1.0

use std.{model}

pub role owner "Owner"

pub interface Api {
  protocol openapi
  spec     "docs/openapi.json"
}

pub component app {
  repo     "example/app"
  root     "/work/app"
  lang     ts
  owner    role "owner"
  provides Api
}

pub environment staging {
  class internal
}

pub capability ModelStd = model.infer(tier: standard, max_class: internal)

pub type Greeting = Text

pub let LIMIT: Int = 3

pub effect record(g: Greeting) -> Text

pub extern py "tools/greet.py"::parse(text: Text) -> Greeting
  ! {}

pub fn shout(g: Greeting) -> Greeting ! {}
{
  g
}

pub contract Greeted(g: Greeting) {
  accept owner "The owner accepts it"
    by human.approve(role: owner)
}

pub agent Greeter {
  role   "Writes one greeting."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill greet(name: Text) -> Inferred<Text> ! {Model}
}

pub workflow Greet(name: Text) -> Inferred<Text>
  caps    ModelStd
  budget { time: 5m, steps: 4 }
{
  delegate Greeter.greet(name)
}
"#;

#[test]
fn pub_before_every_kind_reads_and_prints_back() {
    let p = read(EVERY_KIND);
    let defs = p.get("defs").and_then(Value::as_object).unwrap();
    assert_eq!(defs.len(), 13, "one definition of each kind");
    for (name, d) in defs.iter() {
        assert_eq!(d.get("pub"), Some(&Value::Bool(true)), "{name}");
        assert!(d.get("doc").is_none(), "{name}");
    }
    let printed = print_program(&p).unwrap();
    // The printer writes the text it was given, which is printed as
    // `mandate fmt` prints it.
    assert_eq!(printed, EVERY_KIND);
    assert_eq!(canonicalize(&read(&printed)), canonicalize(&p));
}

#[test]
fn a_pub_fn_reads_to_the_ir_it_had_before_0_6() {
    let body = "\n\nmodule m @ 0.1\n\npub fn f(x: Int) -> Int ! {}\n{\n  x\n}\n";
    let old = read(&format!("mandate @ 0.5{body}"));
    let new = read(&format!("mandate @ 0.6{body}"));
    assert_eq!(
        canonicalize(def(&old, "f")),
        canonicalize(def(&new, "f")),
        "the same definition"
    );
}

#[test]
fn before_0_6_pub_stands_before_a_fn_only() {
    for (kind, text) in [
        ("type", "pub type Greeting = Text"),
        ("let", "pub let LIMIT: Int = 3"),
        (
            "capability",
            "pub capability C = model.infer(tier: standard)",
        ),
    ] {
        let src = format!("mandate @ 0.5\n\nmodule m @ 0.1\n\n{text}\n");
        assert_eq!(
            refused(&src),
            (
                "MDT-E0101".to_owned(),
                format!("Expected 'fn' but found '{kind}'."),
                Some((5, 5))
            ),
            "{text}"
        );
    }
    // In 0.6, `pub` once.
    let (code, message, at) = refused("mandate @ 0.6\n\nmodule m @ 0.1\n\npub pub type T = Text\n");
    assert_eq!(
        (code.as_str(), message.as_str(), at),
        (
            "MDT-E0101",
            "Expected a declaration but found 'pub'.",
            Some((5, 5))
        )
    );
}

const DOCUMENTED: &str = "mandate @ 0.6

module example.docs @ 1.0

/// A greeting.
///
///  Indented, after an empty line.
pub type Greeting = Text

///Without a space.
type Note = Text
";

#[test]
fn doc_lines_are_joined_into_the_definitions_doc() {
    let p = read(DOCUMENTED);
    assert_eq!(
        def(&p, "Greeting").get("doc").and_then(Value::as_str),
        Some("A greeting.\n\n Indented, after an empty line.")
    );
    assert_eq!(
        def(&p, "Note").get("doc").and_then(Value::as_str),
        Some("Without a space.")
    );
    let printed = print_program(&p).unwrap();
    assert_eq!(
        printed,
        DOCUMENTED.replace("///Without", "/// Without"),
        "one space after ///, and the lines as they were"
    );
    assert_eq!(canonicalize(&read(&printed)), canonicalize(&p));
    // A line that ends in \r\n has the same text.
    let crlf = DOCUMENTED.replace('\n', "\r\n");
    assert_eq!(canonicalize(&read(&crlf)), canonicalize(&p));
}

#[test]
fn a_doc_line_that_documents_no_definition_is_refused_where_it_is() {
    let message = "A doc line ('///') stands only on the lines directly before a definition or its 'pub'; write '//' for a comment.";
    for (src, at) in [
        // Before the header.
        ("/// x\nmandate @ 0.6\n\nmodule m @ 0.1\n", (1, 1)),
        // Before a `test` and a top-level `on`.
        (
            "mandate @ 0.6\n\nmodule m @ 0.1\n\n/// x\ntest \"t\" {\n}\n",
            (5, 1),
        ),
        // Inside an interpolation.
        (
            "mandate @ 0.6\n\nmodule m @ 0.1\n\nlet greeting = \"\"\"{ 1 /// x\n}\"\"\"\n",
            (5, 23),
        ),
        // Two doc lines, the first of them inside the definition before.
        (
            "mandate @ 0.6\n\nmodule m @ 0.1\n\ntype A = {\n  /// x\n  a: Text\n}\n/// y\ntype B = Text\n",
            (6, 3),
        ),
    ] {
        assert_eq!(
            refused(src),
            ("MDT-E0101".to_owned(), message.to_owned(), Some(at)),
            "{src}"
        );
    }
}

#[test]
fn before_0_6_a_doc_line_is_a_comment() {
    let old = DOCUMENTED
        .replace("mandate @ 0.6", "mandate @ 0.5")
        .replace("pub type", "type");
    let p = read(&old);
    for name in ["Greeting", "Note"] {
        assert!(def(&p, name).get("doc").is_none(), "{name}");
    }
    let stripped: String = old
        .lines()
        .filter(|l| !l.starts_with("///"))
        .map(|l| format!("{l}\n"))
        .collect();
    assert_eq!(canonicalize(&p), canonicalize(&read(&stripped)));
}
