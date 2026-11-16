//! The deepest program of 0.6 that loads and applies a pattern, as
//! `crates/mandate-check/tests/statics.rs` writes it (`deep_pattern_program`).

/// A chain of 59 functions, each calling the next under `depth` levels of
/// `(1 + …)`, the built-in std.patterns imported, and a workflow that
/// applies a pattern of its own whose body is as deep.
pub fn deep_program(depth: usize) -> String {
    let nest = |inner: &str| {
        let mut e = inner.to_owned();
        for _ in 0..depth {
            e = format!("(1 + {e})");
        }
        e
    };
    let mut lines: Vec<String> = vec![
        "mandate @ 0.6".to_owned(),
        "module m @ 0.1".to_owned(),
        "use std.{fs}".to_owned(),
        "use std.patterns.{FanOutMerge}".to_owned(),
        "capability R = fs.read(\"/w\")".to_owned(),
    ];
    for i in 0..59 {
        let next = if i + 1 < 59 {
            format!("f{}(n)", i + 1)
        } else {
            "n".to_owned()
        };
        lines.push(format!("fn f{i}(n: Int) -> Int {{ {} }}", nest(&next)));
    }
    lines.push(format!(
        "pattern Deep(n: const Int) -> Int {{\n  {}\n}}",
        nest("f0(n)")
    ));
    lines.push("workflow W = Deep(n: 1)\n  caps   R\n  budget { time: 1m }".to_owned());
    format!("{}\n", lines.join("\n"))
}
