//! Inputs nested as deep as the reader goes, built to need the most stack:
//! none may overflow it, in a debug build (a test thread has 2 MiB) or
//! under Node's WebAssembly. The vectors hold the depth limits at their
//! boundaries for one construct at a time; these combine the constructs
//! whose frames are the largest, on both sides of an interpolation (whose
//! parser counts its nesting from zero again), and take the inputs that are
//! nested without bound (`a + a + …`, `f()()…`) to the size limit.
//!
//! Where TypeScript gives a diagnostic, this is it, as `load` gave it
//! (written down from the TypeScript compiler run on the same input). Where
//! TypeScript runs out of stack (a `RangeError`, which `load` throws), the
//! test says what Rust gives instead.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_ir::stringify;
use mandate_syntax::parse_mdt;

const H: &str = "module m @ 0.1\n";

/// An operand followed by an operator of each precedence, each binding
/// tighter than the one before: the right operand of the last is read
/// seven calls of `binary` deep.
const CHAIN: &str = "a or a and a == a .. a + a * ";

/// The construct whose frames on the way down are the largest: a change
/// set's member's arguments, which hold a chain.
fn heavy() -> String {
    format!("changeset(p) {{ member c = e.f({CHAIN}")
}

/// The one diagnostic `text` gives, as JSON; it must give no program.
fn refusal(text: &str) -> String {
    let read = parse_mdt(text);
    assert!(read.program.is_none(), "a program came back");
    assert_eq!(read.diagnostics.len(), 1, "{:?}", read.diagnostics);
    stringify(&read.diagnostics[0].to_js()).expect("JSON")
}

fn nesting_at(line: usize, col: usize) -> String {
    format!(
        r#"{{"code":"MDT-E0105","severity":"error","message":"Nesting exceeds the depth limit of 64.","at":{{"span":[{line},{col},{line},{}]}},"docs":"mandate explain MDT-E0105","facts":{{"limit":64}}}}"#,
        col + 1
    )
}

fn ir_depth_at(span: [usize; 4], path: &str) -> String {
    format!(
        r#"{{"code":"MDT-E0105","severity":"error","message":"JSON nesting exceeds the depth limit of 64.","at":{{"span":[{},{},{},{}],"path":"{path}"}},"docs":"mandate explain MDT-E0105","facts":{{"limit":64}}}}"#,
        span[0], span[1], span[2], span[3]
    )
}

/// 64 change sets nested: refused at the 64th, as in TypeScript.
#[test]
fn the_largest_frames_64_deep() {
    let text = format!("{H}let x = {}1\n", heavy().repeat(64));
    assert_eq!(refusal(&text), nesting_at(2, 3736));
}

/// 63 levels of the largest frames, then a string whose interpolation has
/// 63 more, then calls nested in calls: the most stack an input can take.
/// Rust refuses the 65th nested call (`Parser::enter_postfix`); TypeScript,
/// which counts no nesting of calls, reads on and gives `Expected ')' but
/// found '}'.` at line 2, column 9461.
#[test]
fn the_most_stack_an_input_takes() {
    let call = format!("f({CHAIN}");
    let before = format!(
        "let x = {}\"{{{}{}",
        heavy().repeat(63),
        heavy().repeat(63),
        call.repeat(64)
    );
    let closing = "}".repeat(63);
    let text = format!("{H}{before}{call}1{closing}}}\"\n");
    // The column of the 65th call's `(`.
    assert_eq!(refusal(&text), nesting_at(2, before.len() + 2));
}

/// Parenthesised chains on both sides of an interpolation and 64 calls
/// nested in calls, all read to the end: TypeScript's diagnostic, from the
/// IR's depth.
#[test]
fn the_most_stack_a_text_read_to_the_end_takes() {
    let paren = format!("({CHAIN}");
    let call = format!("f({CHAIN}");
    let text = format!(
        "{H}let x = {}\"{{{}{}1{}{}}}\"{}\n",
        paren.repeat(63),
        paren.repeat(63),
        call.repeat(64),
        ")".repeat(64),
        ")".repeat(63),
        ")".repeat(63)
    );
    let path = format!(
        "/defs/x/value/right/right/right/to/right{}/left/name",
        "/right/right/right/right/to/right".repeat(9)
    );
    assert_eq!(refusal(&text), ir_depth_at([2, 305, 2, 306], &path));
}

/// `a + a + … + a`, a megabyte long: read in a loop, as deep as it is long,
/// refused by the IR's depth at the first value too deep.
#[test]
fn a_sum_as_long_as_the_size_limit() {
    let text = format!("{H}let x = {}a\n", "a + ".repeat(262_000));
    assert!(text.len() <= 1024 * 1024);
    let path = format!("/defs/x/value{}/bop", "/left".repeat(60));
    assert_eq!(refusal(&text), ir_depth_at([2, 9, 2, 1_047_770], &path));
}

/// `a()()…()`, a megabyte long.
#[test]
fn calls_in_a_row_as_long_as_the_size_limit() {
    let text = format!("{H}let x = a{}\n", "()".repeat(524_000));
    let path = format!("/defs/x/value{}/args", "/callee".repeat(60));
    assert_eq!(refusal(&text), ir_depth_at([2, 9, 2, 1_047_890], &path));
}

/// `f(f(…` half a million deep: TypeScript runs out of stack (a
/// `RangeError`); Rust refuses the 65th call.
#[test]
fn calls_nested_as_deep_as_the_size_limit() {
    let text = format!("{H}let x = {}1{}\n", "f(".repeat(500_000), ")".repeat(1000));
    assert_eq!(refusal(&text), nesting_at(2, 8 + 64 * 2 + 2));
}

/// `T { a: T { a: …`: as calls, with records; TypeScript runs out of stack
/// past some 2,600 levels.
#[test]
fn records_nested_as_deep_as_the_size_limit() {
    let text = format!("{H}let x = {}1\n", "T { a: ".repeat(140_000));
    assert_eq!(refusal(&text), nesting_at(2, 8 + 64 * 7 + 3));
}

/// A capability that is a sum 1000 long: sorted by its canonical text, then
/// refused by the IR's depth, as in TypeScript.
#[test]
fn a_deep_capability_is_sorted_then_refused() {
    let text = format!(
        "{H}workflow w() -> Int\n  caps {}a, b\n{{\n}}\n",
        "a + ".repeat(1000)
    );
    let path = format!("/defs/w/caps/0{}/bop", "/left".repeat(59));
    assert_eq!(refusal(&text), ir_depth_at([3, 8, 3, 3773], &path));
}

/// The same, 200,000 long: TypeScript runs out of stack taking its
/// canonical text to sort the capabilities; Rust takes it without
/// recursion and gives the diagnostic of the IR's depth.
#[test]
fn a_capability_too_deep_for_typescript_to_sort() {
    let text = format!(
        "{H}workflow w() -> Int\n  caps {}a, b\n{{\n}}\n",
        "a + ".repeat(200_000)
    );
    let path = format!("/defs/w/caps/0{}/bop", "/left".repeat(59));
    assert_eq!(refusal(&text), ir_depth_at([3, 8, 3, 799_773], &path));
}
