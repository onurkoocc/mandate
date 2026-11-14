//! The library crates hold no ambient authority: their sources name none of
//! `std::fs`, `std::env`, `std::process`, `std::net`, `std::os`, `std::path`
//! (whose `Path` methods such as `exists`, `metadata` and `read_dir` touch
//! the file system; a compiler library treats a path as text), `SystemTime`,
//! `Instant`, the standard streams (`stdin`, `stdout`, `stderr`) and the
//! macros that write to them (`print!`, `println!`, `eprint!`, `eprintln!`,
//! `dbg!`); nor do they rename `std` (`use std as s`) or glob it
//! (`use std::*`), which would hide the rest. So they read no file,
//! environment variable or clock, write nothing out, start no process and
//! open no connection; what they work on is given to them. This keeps them
//! buildable for `wasm32-wasip1` and callable from a sandbox.
//!
//! The sources are scanned as text, with comments, strings (raw and byte
//! strings too) and character literals left out, and a `std::{...}` group is
//! looked into. Each crate of the compiler adds itself to `LIBRARIES` when it
//! is written; a file that is not library code is exempted there by name.
//! The workspace has no `clippy.toml`, so no `disallowed-methods` rule backs
//! this up.

#![allow(
    clippy::panic,
    clippy::expect_used,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_testkit::{files, read_text, subdirectories};

/// Each library crate, and the files under its `src/` that are not library
/// code (a command line's `main.rs`).
const LIBRARIES: &[(&str, &[&str])] = &[
    ("mandate-ir", &[]),
    ("mandate-check", &[]),
    ("verify-journal", &["main.rs"]),
];

/// The modules of `std` that give ambient authority.
const MODULES: [&str; 6] = ["fs", "env", "process", "net", "os", "path"];

/// The names that give it wherever they are named from: the clocks, the
/// standard streams, and the macros that write to them.
const NAMES: [&str; 13] = [
    "SystemTime",
    "Instant",
    "stdin",
    "stdout",
    "stderr",
    "Stdin",
    "Stdout",
    "Stderr",
    "print!",
    "println!",
    "eprint!",
    "eprintln!",
    "dbg!",
];

/// The `.rs` files under the repository directory `dir`, relative to it.
fn rust_files(dir: &str) -> Vec<String> {
    let mut out: Vec<String> = files(dir)
        .expect("a source directory")
        .into_iter()
        .filter(|f| f.ends_with(".rs"))
        .collect();
    for sub in subdirectories(dir).expect("a source directory") {
        let inner = rust_files(&format!("{dir}/{sub}"));
        out.extend(inner.into_iter().map(|f| format!("{sub}/{f}")));
    }
    out
}

fn ident(c: Option<&char>) -> bool {
    c.is_some_and(|c| c.is_alphanumeric() || *c == '_')
}

/// The code of a Rust source with comments, strings and character literals
/// replaced by spaces (line feeds kept, so that lines keep their numbers).
fn code_only(src: &str) -> String {
    let chars: Vec<char> = src.chars().collect();
    let at = |i: usize| chars.get(i).copied();
    let mut out = String::with_capacity(src.len());
    let blank = |out: &mut String, c: char| out.push(if c == '\n' { '\n' } else { ' ' });
    let mut i = 0;
    while let Some(c) = at(i) {
        let next = at(i + 1);
        if c == '/' && next == Some('/') {
            while at(i).is_some_and(|c| c != '\n') {
                out.push(' ');
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            let mut depth = 0;
            while let Some(c) = at(i) {
                let pair = (c, at(i + 1));
                if pair == ('/', Some('*')) || pair == ('*', Some('/')) {
                    depth = if c == '/' { depth + 1 } else { depth - 1 };
                    out.push_str("  ");
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    blank(&mut out, c);
                    i += 1;
                }
            }
        } else if c == 'r'
            && matches!(next, Some('"' | '#'))
            && (!ident(chars.get(i.wrapping_sub(1)))
                || (matches!(at(i.wrapping_sub(1)), Some('b' | 'c'))
                    && !ident(chars.get(i.wrapping_sub(2)))))
        {
            // A raw string, r"..." or r#"..."#, and the raw byte and C
            // strings br"..." and cr#"..."#.
            let mut j = i + 1;
            while at(j) == Some('#') {
                j += 1;
            }
            if at(j) != Some('"') {
                out.push(c);
                i += 1;
                continue;
            }
            let hashes = j - i - 1;
            for _ in i..=j {
                out.push(' ');
            }
            i = j + 1;
            while let Some(c) = at(i) {
                if c == '"' && (1..=hashes).all(|h| at(i + h) == Some('#')) {
                    for _ in 0..=hashes {
                        out.push(' ');
                    }
                    i += hashes + 1;
                    break;
                }
                blank(&mut out, c);
                i += 1;
            }
        } else if c == '"' || (c == '\'' && (next == Some('\\') || at(i + 2) == Some('\''))) {
            // A string, or a character literal ('x', '\n'), not a lifetime.
            out.push(' ');
            i += 1;
            while let Some(d) = at(i) {
                blank(&mut out, d);
                i += 1;
                if d == '\\' {
                    if let Some(e) = at(i) {
                        blank(&mut out, e);
                        i += 1;
                    }
                } else if d == c {
                    break;
                }
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The words of `code` with their lines; `::`, `{`, `}` and `,` are words,
/// `*` is kept, and a macro's name keeps its `!`.
fn words(code: &str) -> Vec<(usize, String)> {
    let mut out = Vec::new();
    for (n, line) in code.lines().enumerate() {
        let kept: String = line
            .chars()
            .map(|c| {
                if ident(Some(&c)) || ":{},!*".contains(c) {
                    c
                } else {
                    ' '
                }
            })
            .collect();
        let spaced = kept
            .replace("::", " :: ")
            .replace('{', " { ")
            .replace('}', " } ")
            .replace(',', " , ")
            .replace('*', " * ");
        out.extend(
            spaced
                .split_whitespace()
                .map(|w| w.trim_start_matches('!'))
                .filter(|w| !w.is_empty())
                .map(|w| (n + 1, w.to_owned())),
        );
    }
    out
}

/// The ambient authority `code` names, as `line: what`.
fn findings(code: &str) -> Vec<String> {
    let words = words(code);
    let mut out = Vec::new();
    for (k, (line, w)) in words.iter().enumerate() {
        if NAMES.contains(&w.as_str()) {
            out.push(format!("{line}: {w}"));
        }
        let next = words.get(k + 1).map(|(_, w)| w.as_str());
        if w == "std" && next == Some("as") {
            out.push(format!("{line}: std renamed"));
        }
        if w != "std" || next != Some("::") {
            continue;
        }
        // `std::x` or `std::{a, b::c, d::{e}}`: the first segment of each path.
        let (mut depth, mut first) = (0, true);
        for (_, w) in &words[k + 2..] {
            match w.as_str() {
                "{" => {
                    depth += 1;
                    first = depth == 1;
                }
                "}" => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
                "," => first = depth == 1,
                "::" => {}
                segment => {
                    if first && (MODULES.contains(&segment) || segment == "*") {
                        out.push(format!("{line}: std::{segment}"));
                    }
                    first = false;
                    if depth == 0 {
                        break;
                    }
                }
            }
        }
    }
    out
}

#[test]
fn the_scan_finds_what_it_looks_for() {
    let found = |src: &str| findings(&code_only(src));
    assert_eq!(found("use std::fs;"), ["1: std::fs"]);
    assert_eq!(found("let x = std::env::var(\"A\");"), ["1: std::env"]);
    assert_eq!(
        found("use std::{\n  collections::HashMap,\n  process::Command, net};"),
        ["1: std::process", "1: std::net"]
    );
    assert_eq!(found("use std::time::{Duration, Instant};"), ["1: Instant"]);
    assert_eq!(found("\nlet t = SystemTime::now();"), ["2: SystemTime"]);
    assert_eq!(found("use std::path::Path;"), ["1: std::path"]);
    assert_eq!(found("use std::{fmt, path};"), ["1: std::path"]);
    assert_eq!(found("use std::os::unix::ffi::OsStrExt;"), ["1: std::os"]);
    assert_eq!(found("let s = std::io::stdout();"), ["1: stdout"]);
    assert_eq!(found("use std::io::{self, Stdin};"), ["1: Stdin"]);
    assert_eq!(found("if !*stderr {}"), ["1: stderr"]);
    assert_eq!(
        found("println!(\"x\"); dbg!(y);\nprint!(\"a\"); eprint!(\"b\"); eprintln!();"),
        [
            "1: println!",
            "1: dbg!",
            "2: print!",
            "2: eprint!",
            "2: eprintln!"
        ]
    );
    assert_eq!(found("use std as s;"), ["1: std renamed"]);
    assert_eq!(found("extern crate std as s;"), ["1: std renamed"]);
    assert_eq!(found("use std::*;"), ["1: std::*"]);
    assert_eq!(found("use std::{io, *};"), ["1: std::*"]);
    // After a raw byte string with a backslash in it, the code is still scanned.
    assert_eq!(found("let b = br\"\\\"; use std::fs;"), ["1: std::fs"]);
    assert_eq!(found("let b = br#\"\\\"#; use std::env;"), ["1: std::env"]);
    assert_eq!(found("let c = cr\"\\\"; use std::net;"), ["1: std::net"]);
    assert!(found("let b = br\"std::fs\"; let x = a!=b; let y = *p;").is_empty());
    // Not code: comments, strings, characters; nor other modules of std.
    assert!(found("// std::fs\n/* std::env /* */ */ let s = \"std::process\";").is_empty());
    assert!(found("let c = '\"'; let s = r#\"std::fs\"#; let q = '\\''; use std::fmt;").is_empty());
    assert!(
        found("use std::collections::{HashMap, btree_map::{self, Entry}}; fn f<'a>(x: &'a str) {}")
            .is_empty()
    );
}

#[test]
fn library_crates_hold_no_ambient_authority() {
    let mut problems = Vec::new();
    let mut scanned = 0;
    for (krate, exempt) in LIBRARIES {
        let dir = format!("crates/{krate}/src");
        for file in rust_files(&dir) {
            if exempt.contains(&file.as_str()) {
                continue;
            }
            scanned += 1;
            let rel = format!("{dir}/{file}");
            let src = read_text(&rel).expect("a source file");
            problems.extend(
                findings(&code_only(&src))
                    .into_iter()
                    .map(|f| format!("{rel}:{f}")),
            );
        }
    }
    println!("ambient authority: {scanned} library source files scanned");
    assert!(scanned > 0, "no source file was scanned");
    assert!(
        problems.is_empty(),
        "library code names ambient authority:\n{}",
        problems.join("\n")
    );
}
