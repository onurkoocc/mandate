//! Tests of the helpers of the printer that have JavaScript semantics in
//! them. Every expectation in the tables was written by running the
//! TypeScript printer (`compiler/dist/print/printer.js`, built from
//! `compiler/src/print/printer.ts`) on the same input: `printProgram` of a
//! program holding one constant (or one function with a budget), the text
//! after `let x = `. The tables are reproduced from that run, not from the
//! Rust.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects
)]

use super::*;

/// The program a JSON text is, read as the strict reader reads it.
fn read(json: &str) -> Value {
    mandate_ir::parse(json).expect("valid JSON").value
}

/// `printProgram` of the program a JSON text is.
fn print(json: &str) -> Printed {
    print_program(&read(json))
}

/// The text after `let x = ` that the printer gives for a program with one
/// constant `x` holding `expr` (JSON text).
fn const_text(expr: &str) -> Printed {
    let program = format!(
        r#"{{"language":"mandate/0.1","module":"m","version":"0.1","defs":{{"x":{{"kind":"const","value":{expr}}}}}}}"#
    );
    let printed = print(&program)?;
    let body = printed
        .strip_prefix("module m @ 0.1\n\nlet x = ")
        .expect("the shape of a program with one constant");
    Ok(body
        .strip_suffix('\n')
        .expect("a final line feed")
        .to_owned())
}

#[test]
fn durations() {
    for (ms, expected) in [
        (0_i64, "0ms"),
        (1, "1ms"),
        (999, "999ms"),
        (1000, "1s"),
        (1500, "1500ms"),
        (60000, "1m"),
        (61000, "61s"),
        (3_600_000, "1h"),
        (3_660_000, "61m"),
        (86_400_000, "1d"),
        (90_000_000, "25h"),
        (172_800_000, "2d"),
        (604_800_000, "7d"),
        (9_007_199_254_740_991, "9007199254740991ms"),
        (-1000, "-1s"),
        (-86_400_000, "-1d"),
        (-1500, "-1500ms"),
    ] {
        assert_eq!(duration_of(ms), expected, "{ms}");
        let value = format!(r#"{{"op":"duration","ms":{ms}}}"#);
        assert_eq!(const_text(&value).as_deref(), Ok(expected), "{ms}");
    }
}

#[test]
fn money_amounts() {
    for (micros, currency, expected) in [
        (0_i64, "USD", "0 USD"),
        (1, "USD", "0.000001 USD"),
        (1_000_000, "USD", "1 USD"),
        (1_500_000, "EUR", "1.5 EUR"),
        (123_456_789, "USD", "123.456789 USD"),
        (10, "JPY", "0.00001 JPY"),
        (100_000, "USD", "0.1 USD"),
        (999_999, "USD", "0.999999 USD"),
        (9_007_199_254_740_991, "USD", "9007199254.740991 USD"),
        (-1_500_000, "USD", "-1.5 USD"),
        (-1, "USD", "-0.000001 USD"),
        (-1_000_000, "USD", "-1 USD"),
        (2_500_000_000, "USD", "2500 USD"),
    ] {
        assert_eq!(money_of(micros, currency), expected, "{micros}");
        let value = format!(r#"{{"op":"money","micros":{micros},"currency":"{currency}"}}"#);
        assert_eq!(const_text(&value).as_deref(), Ok(expected), "{micros}");
    }
}

#[test]
fn token_counts() {
    // The line `budget { tokens: ... }` of a function with that budget.
    for (n, expected) in [
        (0_i64, "budget { tokens: 0 }"),
        (1, "budget { tokens: 1 }"),
        (999, "budget { tokens: 999 }"),
        (1000, "budget { tokens: 1k }"),
        (1500, "budget { tokens: 1500 }"),
        (1_000_000, "budget { tokens: 1M }"),
        (1_001_000, "budget { tokens: 1001k }"),
        (2_000_000, "budget { tokens: 2M }"),
        (2_500_000, "budget { tokens: 2500k }"),
        (1_000_000_000, "budget { tokens: 1000M }"),
        // `-1000 % 1000 === 0` in JavaScript (it is `-0`), so a negative
        // multiple gets its suffix too.
        (-1000, "budget { tokens: -1k }"),
        (-2_000_000, "budget { tokens: -2M }"),
        (-1500, "budget { tokens: -1500 }"),
        (9_007_199_254_740_991, "budget { tokens: 9007199254740991 }"),
        (9_007_199_000_000_000, "budget { tokens: 9007199000M }"),
    ] {
        let b = read(&format!(r#"{{"tokens":{n}}}"#));
        assert_eq!(budget(&b).as_deref(), Ok(expected), "{n}");
    }
}

#[test]
fn integers() {
    for (n, expected) in [
        (0_i64, "0"),
        (7, "7"),
        (-7, "-7"),
        (9_007_199_254_740_991, "9007199254740991"),
        (-9_007_199_254_740_991, "-9007199254740991"),
    ] {
        let value = format!(r#"{{"op":"int","value":{n}}}"#);
        assert_eq!(const_text(&value).as_deref(), Ok(expected), "{n}");
    }
}

#[test]
fn quoted_text() {
    for (text, expected) in [
        ("", "\"\""),
        ("plain", "\"plain\""),
        ("a \"quoted\" word", "\"a \\\"quoted\\\" word\""),
        ("back\\slash", "\"back\\\\slash\""),
        ("braces {x} and }{", "\"braces \\{x\\} and \\}\\{\""),
        ("tab\tcr\rlf\n", "\"tab\\tcr\\rlf\\n\""),
        ("ctrl\u{1}\u{7f}\u{2028}", "\"ctrl\u{1}\u{7f}\u{2028}\""),
        ("é ü 日本 😀", "\"é ü 日本 😀\""),
        ("\\\"{}", "\"\\\\\\\"\\{\\}\""),
        ("\\n literal", "\"\\\\n literal\""),
    ] {
        assert_eq!(quote_text(text), expected, "{text:?}");
        let value = Value::Object(
            [("op", Value::from("text")), ("value", Value::from(text))]
                .into_iter()
                .collect(),
        );
        assert_eq!(expr(&value, 0, ""), Ok(expected.to_owned()), "{text:?}");
    }
}

#[test]
fn templates_and_prompts() {
    let cases: &[(&str, Printed, Printed)] = &[
        // plain
        (
            r#"[{"text":"hello"}]"#,
            Ok("\"hello\"".into()),
            Ok("prompt\"\"\"hello\"\"\"".into()),
        ),
        // interp
        (
            r#"[{"text":"a "},{"expr":{"op":"var","name":"x"}},{"text":" b"}]"#,
            Ok("\"a {x} b\"".into()),
            Ok("prompt\"\"\"a {x} b\"\"\"".into()),
        ),
        // newline text goes triple
        (
            r#"[{"text":"line1\nline2"},{"expr":{"op":"var","name":"y"}}]"#,
            Ok("\"\"\"line1\nline2{y}\"\"\"".into()),
            Ok("prompt\"\"\"line1\nline2{y}\"\"\"".into()),
        ),
        // escapes single
        (
            r#"[{"text":"q\"b\\{}\t"}]"#,
            Ok("\"q\\\"b\\\\\\{\\}\\t\"".into()),
            Ok("prompt\"\"\"q\\\"b\\\\\\{\\}\\t\"\"\"".into()),
        ),
        // escapes triple
        (
            r#"[{"text":"q\"b\\{}\t\n"}]"#,
            Ok("\"\"\"q\\\"b\\\\\\{\\}\\t\n\"\"\"".into()),
            Ok("prompt\"\"\"q\\\"b\\\\\\{\\}\\t\n\"\"\"".into()),
        ),
        // empty
        (r#"[]"#, Ok("\"\"".into()), Ok("prompt\"\"\"\"\"\"".into())),
        // interp field
        (
            r#"[{"expr":{"op":"field","of":{"op":"var","name":"a"},"name":"b"}}]"#,
            Ok("\"{a.b}\"".into()),
            Ok("prompt\"\"\"{a.b}\"\"\"".into()),
        ),
        // interp string literal
        (
            r#"[{"expr":{"op":"text","value":"s"}}]"#,
            Err("String literals cannot appear inside an interpolation.".into()),
            Err("String literals cannot appear inside an interpolation.".into()),
        ),
        // interp binary
        (
            r#"[{"text":"n="},{"expr":{"op":"binary","bop":"+","left":{"op":"var","name":"a"},"right":{"op":"int","value":1}}}]"#,
            Ok("\"n={a + 1}\"".into()),
            Ok("prompt\"\"\"n={a + 1}\"\"\"".into()),
        ),
        // interp call with string
        (
            r#"[{"expr":{"op":"call","callee":{"op":"var","name":"f"},"args":[{"value":{"op":"text","value":"x"}}]}}]"#,
            Err("String literals cannot appear inside an interpolation.".into()),
            Err("String literals cannot appear inside an interpolation.".into()),
        ),
    ];
    for (parts, template, prompt) in cases {
        let t = const_text(&format!(r#"{{"op":"template","parts":{parts}}}"#));
        assert_eq!(&t, template, "template {parts}");
        let p = const_text(&format!(r#"{{"op":"prompt","parts":{parts}}}"#));
        assert_eq!(&p, prompt, "prompt {parts}");
    }
}

#[test]
fn escaping_one_character_at_a_time() {
    // `/\\/g`, `/"/g`, `/\{/g`, `/\}/g`, `/\t/g`, `/\r/g` and, outside triple
    // quotes, `/\n/g`, in that order, as `escapeText` applies them, give what
    // an independent replacement of each character gives: the backslash that
    // one rule writes is not met by a later one.
    assert_eq!(
        escape_text("\\\"{}\t\r\n", false),
        "\\\\\\\"\\{\\}\\t\\r\\n"
    );
    assert_eq!(escape_text("\\\"{}\t\r\n", true), "\\\\\\\"\\{\\}\\t\\r\n");
    assert_eq!(escape_text("", true), "");
}

#[test]
fn programs() {
    let cases: &[(&str, Printed)] = &[
        // empty generics and empty type args are written
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"Box":{"kind":"type","generics":[],"type":{"ref":"List","args":[]}}}}"#, Ok("module m @ 0.1\n\ntype Box<> = List<>\n".into())),
        // empty record type and empty record literal have two spaces
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"R":{"kind":"type","type":{"record":{}}},"c":{"kind":"const","value":{"op":"record","type":"R","fields":{}}}}}"#, Ok("module m @ 0.1\n\ntype R = {  }\n\nlet c = R {  }\n".into())),
        // empty effect list and empty argument list
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"f":{"kind":"fn","params":[],"returns":{"ref":"Unit"},"effects":[{"effect":"net"},{"effect":"log","args":[]}],"body":[]}}}"#, Ok("module m @ 0.1\n\nfn f() -> Unit ! {net, log()}\n{\n}\n".into())),
        // a record field written by its name alone
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"R":{"kind":"type","type":{"record":{"a":{"ref":"Int"}}}},"c":{"kind":"const","value":{"op":"record","type":"R","fields":{"a":{"op":"var","name":"a"},"b":{"op":"var","name":"c"},"c":{"op":"var","name":"c"}}}}}}"#, Ok("module m @ 0.1\n\ntype R = { a: Int }\n\nlet c = R { a, b: c, c }\n".into())),
        // precedence: or under and, subtraction on the right, negation, not
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"c":{"kind":"const","value":{"op":"binary","bop":"and","left":{"op":"binary","bop":"or","left":{"op":"var","name":"a"},"right":{"op":"var","name":"b"}},"right":{"op":"binary","bop":"-","left":{"op":"var","name":"c"},"right":{"op":"binary","bop":"-","left":{"op":"var","name":"d"},"right":{"op":"var","name":"e"}}}}},"d":{"kind":"const","value":{"op":"unary","uop":"neg","of":{"op":"binary","bop":"+","left":{"op":"var","name":"a"},"right":{"op":"int","value":1}}}},"e":{"kind":"const","value":{"op":"unary","uop":"not","of":{"op":"binary","bop":"==","left":{"op":"var","name":"a"},"right":{"op":"var","name":"b"}}}}}}"#, Ok("module m @ 0.1\n\nlet c = (a or b) and c - (d - e)\n\nlet d = -(a + 1)\n\nlet e = not a == b\n".into())),
        // a comparison on the left of a comparison is not parenthesised
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"c":{"kind":"const","value":{"op":"binary","bop":"<","left":{"op":"binary","bop":"<","left":{"op":"var","name":"a"},"right":{"op":"var","name":"b"}},"right":{"op":"var","name":"c"}}}}}"#, Ok("module m @ 0.1\n\nlet c = a < b < c\n".into())),
        // subseteq is written as the sign
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"c":{"kind":"const","value":{"op":"binary","bop":"subseteq","left":{"op":"var","name":"a"},"right":{"op":"var","name":"b"}}}}}"#, Ok("module m @ 0.1\n\nlet c = a ⊆ b\n".into())),
        // a set with items has no text form
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"c":{"kind":"const","value":{"op":"set","items":[{"op":"int","value":1}]}}}}"#, Err("Only the empty set literal has a text form.".into())),
        // the empty set
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"c":{"kind":"const","value":{"op":"set","items":[]}}}}"#, Ok("module m @ 0.1\n\nlet c = {}\n".into())),
        // a union type nested in a type
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"c":{"kind":"const","type":{"union":[{"tag":"A"}]},"value":{"op":"int","value":1}}}}"#, Err("A union type can only appear as a type definition.".into())),
        // a union type definition
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"U":{"kind":"type","type":{"union":[{"tag":"A"},{"tag":"B","fields":[{"name":"x","type":{"ref":"Int"}}]}]},"class":"internal"}}}"#, Ok("module m @ 0.1\n\ntype U = A | B(x: Int) classified internal\n".into())),
        // a statement that starts with a minus is parenthesised
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"f":{"kind":"fn","params":[],"returns":{"ref":"Int"},"body":[{"op":"expr","value":{"op":"unary","uop":"neg","of":{"op":"var","name":"x"}}},{"op":"return","value":{"op":"int","value":0}}]}}}"#, Ok("module m @ 0.1\n\nfn f() -> Int\n{\n  (-x)\n  return 0\n}\n".into())),
        // a record literal in a condition is parenthesised
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"f":{"kind":"fn","params":[],"returns":{"ref":"Int"},"body":[{"op":"if","cond":{"op":"binary","bop":"==","left":{"op":"record","type":"R","fields":{}},"right":{"op":"var","name":"x"}},"then":[],"else":[{"op":"return"}]}]}}}"#, Ok("module m @ 0.1\n\nfn f() -> Int\n{\n  if (R {  } == x) {\n  } else {\n    return\n  }\n}\n".into())),
        // definitions are sorted by kind and by UTF-16 code units
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"b":{"kind":"const","value":{"op":"int","value":1}},"😀":{"kind":"const","value":{"op":"int","value":2}},"Ａ":{"kind":"const","value":{"op":"int","value":3}},"B":{"kind":"const","value":{"op":"int","value":4}},"a":{"kind":"capability","value":{"op":"var","name":"x"}}}}"#, Ok("module m @ 0.1\n\ncapability a = x\n\nlet B = 4\n\nlet b = 1\n\nlet 😀 = 2\n\nlet Ａ = 3\n".into())),
        // tests keep their order, index-like names first
        (r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{},"tests":{"2":{"handlers":{"h":{"op":"int","value":1},"g":{"op":"int","value":2}},"body":[]},"10":{"body":[{"op":"return"}]},"zeta":{"body":[]}}}"#, Ok("module m @ 0.1\n\ntest \"2\" {\n  with handlers {\n    h = 1,\n    g = 2\n  }\n}\n\ntest \"10\" {\n  return\n}\n\ntest \"zeta\" {\n}\n".into())),
        // a language other than 0.1, uses with and without names
        (r#"{"language":"mandate/0.5","module":"m","version":"0.1","uses":[{"module":"a.b"},{"module":"c","names":["x","y"]},{"module":"d","names":[]}],"defs":{}}"#, Ok("mandate @ 0.5\n\nmodule m @ 0.1\n\nuse a.b\nuse c.{x, y}\nuse d.{}\n".into())),
    ];
    for (program, expected) in cases {
        assert_eq!(&print(program), expected, "{program}");
    }
}

#[test]
fn javascript_conversions() {
    // Each expectation is what node gives for `String(x)` of the same value.
    let value = read(r#"[1,[2,null],3]"#);
    assert_eq!(js_string(Some(&value)), "1,2,,3");
    assert_eq!(js_string(Some(&read(r#"{"a":1}"#))), "[object Object]");
    assert_eq!(js_string(Some(&Value::Null)), "null");
    assert_eq!(js_string(None), "undefined");
    assert_eq!(js_string(Some(&read("[]"))), "");
    assert_eq!(js_string(Some(&read("[null]"))), "");
    assert_eq!(js_string(Some(&read("true"))), "true");
    assert_eq!(js_string(Some(&read("-7"))), "-7");
    // `xs.join(", ")` writes nothing for a `null`.
    assert_eq!(
        join(&[Value::from("a"), Value::Null, Value::from("b")], ", "),
        "a, , b"
    );

    // Truthiness: an empty list and an empty object are true, `""` and `0` false.
    assert!(truthy(&read("[]")));
    assert!(truthy(&read("{}")));
    assert!(!truthy(&read(r#""""#)));
    assert!(!truthy(&read("0")));
    assert!(truthy(&read("-1")));
    assert!(!truthy(&Value::Null));
    assert!(!truthy(&Value::Bool(false)));

    // `"/".replace("/", " @ ")` replaces the first match only.
    assert_eq!("a/b/c".replacen('/', " @ ", 1), "a @ b/c");
    assert_eq!(
        "budget { budget: 1 }".replacen("budget ", "budget  ", 1),
        "budget  { budget: 1 }"
    );
}

#[test]
fn a_value_that_is_not_a_program_does_not_panic() {
    assert!(print_program(&Value::Null).is_err());
    assert!(print_program(&read("[]")).is_err());
    assert!(print_program(&read(r#"{"language":"mandate/0.1"}"#)).is_ok());
    // A definition of no kind the IR has is not printed (TypeScript prints
    // only the kinds of `KIND_ORDER`).
    assert!(
        print(r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"x":{}}}"#).is_ok()
    );
    assert!(
        print(r#"{"language":"mandate/0.1","module":"m","version":"0.1","defs":{"x":{"kind":"const","value":{}}}}"#)
            .is_err()
    );
}

#[test]
fn nesting_as_deep_as_a_loaded_program_prints() {
    // 28 lists inside lists: 60 levels of IR with the program around them.
    let mut value = String::from(r#"{"op":"int","value":1}"#);
    for _ in 0..28 {
        value = format!(r#"{{"op":"list","items":[{value}]}}"#);
    }
    let printed = const_text(&value).expect("prints");
    assert_eq!(printed, format!("{}1{}", "[".repeat(28), "]".repeat(28)));
}
