//! `mandate mcp`, the native MCP server, run in memory (over a `MemoryIo`,
//! so that it runs under `scripts/wasi-test.mjs` too): the recorded
//! conversations of `vectors/mcp/` give the Node server's bytes, read whole
//! and in small reads; and what language 0.7 adds, which the Node server
//! does not do yet (slice B9): the tool list of the door `mcp_tools`,
//! `libraries`, the card, the attention view, the two sections of `spec`.
//! `tests/mcp_process.rs` runs the same conversations through the
//! executable, and holds what only a process shows (memory, pipes).

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod transcripts;

use mandate_cli::{MemoryIo, run};
use mandate_testkit::{read_bytes, read_text};
use transcripts::{conversations, tools_text};

/// The modern era's `_meta`.
const META: &str = r#""_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}"#;

/// The server's identity in a modern answer.
const SERVER_INFO: &str = r#""_meta":{"io.modelcontextprotocol/serverInfo":{"name":"mandate-compiler","version":"0.2.0"}}"#;

/// `mandate <args>` over `io`, standard input `input`.
fn serve_io(io: &mut MemoryIo, args: &[&str], input: &[u8]) -> i32 {
    io.input = input.to_vec();
    io.input_read = 0;
    io.out.clear();
    io.err.clear();
    let owned: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
    run(&owned, io)
}

/// What `mandate mcp` writes for these lines, which must end with status 0
/// and nothing on standard error.
fn serve(lines: &[String]) -> Vec<String> {
    let mut io = MemoryIo::new();
    let mut input = lines.join("\n");
    input.push('\n');
    let code = serve_io(&mut io, &["mcp"], input.as_bytes());
    assert_eq!(code, 0, "{}", io.err);
    assert_eq!(io.err, "");
    io.out.lines().map(str::to_owned).collect()
}

/// A modern `tools/call` of `name` with `args` (JSON text).
fn call(id: u32, name: &str, args: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"{name}","arguments":{args},{META}}}}}"#
    )
}

/// A JSON string of `text`.
fn quoted(text: &str) -> String {
    let mut out = String::new();
    mandate_ir::write_json_string(&mut out, text);
    out
}

/// The text of a tool result that is an error.
fn tool_error(id: u32, message: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"result":{{"resultType":"complete","content":[{{"type":"text","text":{}}}],"isError":true,{SERVER_INFO}}}}}"#,
        quoted(message)
    )
}

/// The `structuredContent` of a tool result that is not an error, and its
/// text, which must be that value written as `JSON.stringify(v, null, 2)`.
fn structured(line: &str) -> String {
    let at = line
        .find(r#","structuredContent":"#)
        .unwrap_or_else(|| panic!("not a tool result: {line}"));
    let rest = &line[at + r#","structuredContent":"#.len()..];
    let end = rest
        .rfind(&format!(r#","isError":false,{SERVER_INFO}}}}}"#))
        .unwrap_or_else(|| panic!("not a modern tool result: {line}"));
    rest[..end].to_owned()
}

#[test]
fn every_recorded_conversation_gets_the_node_servers_bytes() {
    let frozen = tools_text("mandate/0.6");
    let of_0_7 = tools_text("mandate/0.7");
    assert_ne!(frozen, of_0_7);
    let all = conversations();
    assert!(all.len() >= 15, "{} conversations", all.len());
    let mut problems = Vec::new();
    let mut answers = 0;
    for c in &all {
        // Whole, then in reads small enough to cut lines, CRLFs and
        // characters apart (one byte at a time where the input is small).
        let small = if c.input.len() < 64 * 1024 { 1 } else { 4093 };
        for part in [0, small] {
            let mut io = MemoryIo::new();
            for f in c.module_files() {
                io.files.insert(f.to_owned(), read_bytes(f).unwrap());
            }
            io.input_part = part;
            let args: Vec<&str> = c.args.iter().map(String::as_str).collect();
            let code = serve_io(&mut io, &args, &c.input);
            if code != 0 || !io.err.is_empty() {
                problems.push(format!(
                    "{} (reads of {part}): status {code}, {}",
                    c.name, io.err
                ));
                continue;
            }
            if let Err(e) = c.compare(&io.out, &frozen, &of_0_7) {
                problems.push(format!("(reads of {part}) {e}"));
            }
        }
        answers += c.answers();
    }
    println!(
        "compared {} conversations, {answers} answers, twice each",
        all.len()
    );
    assert!(answers >= 200, "{answers} answers");
    assert!(problems.is_empty(), "{}", problems.join("\n\n"));
}

#[test]
fn the_tool_list_is_the_doors_of_0_7_in_both_eras_and_the_server_adds_no_tool() {
    let tools = tools_text("mandate/0.7");
    let out = serve(&[
        r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#.to_owned(),
        r#"{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}"#.to_owned(),
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#.to_owned(),
    ]);
    assert_eq!(
        out[0],
        format!(
            r#"{{"jsonrpc":"2.0","id":1,"result":{{"resultType":"complete","tools":{tools},"ttlMs":3600000,"cacheScope":"public",{SERVER_INFO}}}}}"#
        )
    );
    assert_eq!(
        out[2],
        format!(r#"{{"jsonrpc":"2.0","id":3,"result":{{"tools":{tools}}}}}"#)
    );
    // The six tools of today's names, and a call of each other name is refused.
    let names: Vec<&str> = tools
        .match_indices(r#"{"name":""#)
        .map(|(i, _)| {
            let rest = &tools[i + 9..];
            &rest[..rest.find('"').unwrap()]
        })
        .collect();
    assert_eq!(
        names,
        [
            "mandate.check",
            "mandate.explain",
            "mandate.apply_patch",
            "mandate.caps_of",
            "mandate.project",
            "mandate.spec"
        ]
    );
    for name in [
        "mandate.sign",
        "mandate.approve",
        "mandate.approve_envelope",
        "mandate.decide",
        "mandate.promote",
    ] {
        assert_eq!(
            serve(&[call(9, name, "{}")]),
            [format!(
                r#"{{"jsonrpc":"2.0","id":9,"error":{{"code":-32602,"message":"Unknown tool: {name}"}}}}"#
            )]
        );
    }
}

#[test]
fn the_attention_view_is_answered_by_name_until_it_has_a_door() {
    let source = quoted(&read_text("fixtures/attention/minimal.mdt").unwrap());
    let out = serve(&[call(
        1,
        "mandate.project",
        &format!(r#"{{"source":{source},"view":"attention"}}"#),
    )]);
    assert_eq!(
        out,
        [tool_error(
            1,
            "view attention is not available yet: the Rust compiler has no door attention"
        )]
    );
    // A program that does not check is said first, as for every view.
    let out = serve(&[call(
        2,
        "mandate.project",
        r#"{"source":"not a program","view":"attention"}"#,
    )]);
    assert!(
        out[0].contains("the program does not check: MDT-E"),
        "{}",
        out[0]
    );
}

#[test]
fn a_view_that_is_not_one_is_refused_with_the_views_of_0_7() {
    let source = quoted(&read_text("fixtures/fixbug/fixbug.mdt").unwrap());
    for view in [r#""nonsense""#, "5", "null"] {
        let out = serve(&[call(
            1,
            "mandate.project",
            &format!(r#"{{"source":{source},"view":{view}}}"#),
        )]);
        assert_eq!(
            out,
            [tool_error(
                1,
                "view must be architecture, authority, cost, diff, card or attention"
            )]
        );
    }
    let out = serve(&[call(
        2,
        "mandate.project",
        &format!(r#"{{"source":{source}}}"#),
    )]);
    assert_eq!(
        out,
        [tool_error(
            2,
            "view must be architecture, authority, cost, diff, card or attention"
        )]
    );
}

#[test]
fn spec_serves_the_specifications_of_patterns_and_of_attention() {
    let out = serve(&[
        call(1, "mandate.spec", r#"{"section":"patterns"}"#),
        call(2, "mandate.spec", r#"{"section":" attention "}"#),
        call(3, "mandate.spec", r#"{"section":"Patterns"}"#),
        call(4, "mandate.spec", r#"{"section":"4"}"#),
    ]);
    let text_of = |file: &str| {
        let text = read_text(file).unwrap();
        // `{ text }`, as `JSON.stringify(v, null, 2)` writes it in `content`.
        format!(r#""structuredContent":{{"text":{}}}"#, quoted(&text))
    };
    assert!(out[0].contains(&text_of("spec/library.md")));
    assert!(out[1].contains(&text_of("spec/attention.md")));
    assert_eq!(
        out[2],
        tool_error(3, "no section Patterns in the core specification")
    );
    assert!(
        out[3].contains("\"structuredContent\":{\"text\":\"## 4. "),
        "{}",
        &out[3][..200]
    );
}

/// The library acme.connectors as the call carries it: `{ manifest, files }`.
fn acme_connectors() -> String {
    let dir = "fixtures/library/acme.connectors";
    let file = |f: &str| quoted(&read_text(&format!("{dir}/{f}")).unwrap());
    format!(
        r#"[{{"manifest":{},"files":{{"connectors.mdt":{},"types.mdt":{}}}}}]"#,
        file("mandate.library.json"),
        file("connectors.mdt"),
        file("types.mdt")
    )
}

/// An `MemoryIo` with the invoices program, its lock, and acme.connectors
/// in a directory of libraries, for `mandate check` and `mandate view`.
fn invoices_io() -> MemoryIo {
    let mut io = MemoryIo::new();
    for f in [
        "fixtures/library/invoices.mdt",
        "fixtures/library/invoices.lock.json",
    ] {
        io.files.insert(f.to_owned(), read_bytes(f).unwrap());
    }
    for f in ["mandate.library.json", "connectors.mdt", "types.mdt"] {
        io.files.insert(
            format!("libs/acme.connectors/2.3.0/{f}"),
            read_bytes(&format!("fixtures/library/acme.connectors/{f}")).unwrap(),
        );
    }
    io
}

/// The invoices program, its lock and acme.connectors, as a call's
/// arguments, with `more`.
fn invoices_args(more: &str) -> String {
    invoices_args_with(&format!(r#","libraries":{}{more}"#, acme_connectors()))
}

/// The invoices program and its lock, as a call's arguments, with `more`.
fn invoices_args_with(more: &str) -> String {
    let lock = mandate_ir::parse(&read_text("fixtures/library/invoices.lock.json").unwrap())
        .unwrap()
        .value;
    format!(
        r#"{{"source":{},"lock":{}{more}}}"#,
        quoted(&read_text("fixtures/library/invoices.mdt").unwrap()),
        mandate_ir::stringify(&mandate_ir::JsValue::from(&lock)).unwrap(),
    )
}

#[test]
fn check_takes_the_libraries_a_lock_pins_and_finds_std_patterns_itself() {
    // What `mandate check --json` prints of the program with its libraries
    // read from the directory is what the tool gives with them in the call.
    let mut io = invoices_io();
    let code = serve_io(
        &mut io,
        &[
            "check",
            "fixtures/library/invoices.mdt",
            "--json",
            "--lock",
            "fixtures/library/invoices.lock.json",
            "--libraries",
            "libs",
        ],
        b"",
    );
    assert_eq!(code, 0, "{}{}", io.out, io.err);
    let cli = io.out.trim_end().to_owned();
    let out = serve(&[
        call(1, "mandate.check", &invoices_args("")),
        call(2, "mandate.check", &invoices_args_with("")),
        call(
            3,
            "mandate.check",
            &invoices_args_with(r#","libraries":[]"#),
        ),
        call(4, "mandate.check", &invoices_args(r#","libraries":"none""#)),
    ]);
    let text = format!(r#""content":[{{"type":"text","text":{}}}]"#, quoted(&cli));
    assert!(
        out[0].contains(&text),
        "{}",
        &out[0][..400.min(out[0].len())]
    );
    assert!(out[0].contains(r#""structuredContent":{"ok":true,"#));
    // Without them (an empty list is none), the pinned library was not
    // handed in: E1605, as `mandate check` without its directory.
    for o in &out[1..3] {
        assert!(
            o.contains(r#""structuredContent":{"ok":false,"#),
            "{}",
            &o[..400.min(o.len())]
        );
        assert!(o.contains("MDT-E1605"));
    }
    // The last `libraries` given is the one read, as JSON.parse reads it.
    assert_eq!(
        out[3],
        tool_error(
            4,
            "libraries must be a list of libraries, each { manifest, files }"
        )
    );
}

#[test]
fn project_gives_the_card_of_a_workflow_as_mandate_view_does() {
    // The card `mandate view --card --format json` prints, with the
    // libraries read from the directory, is the tool's.
    let mut io = invoices_io();
    let code = serve_io(
        &mut io,
        &[
            "view",
            "fixtures/library/invoices.mdt",
            "--card",
            "--format",
            "json",
            "--workflow",
            "MatchInvoices",
            "--lock",
            "fixtures/library/invoices.lock.json",
            "--libraries",
            "libs",
        ],
        b"",
    );
    assert_eq!(code, 0, "{}{}", io.out, io.err);
    let cli = io.out.trim_end().to_owned();
    let out = serve(&[
        call(
            1,
            "mandate.project",
            &invoices_args(r#","view":"card","workflow":"MatchInvoices""#),
        ),
        call(
            2,
            "mandate.project",
            &invoices_args(r#","view":"card","workflow":"NoSuch""#),
        ),
        call(3, "mandate.project", &invoices_args(r#","view":"card""#)),
        call(
            4,
            "mandate.project",
            &invoices_args(r#","view":"authority""#),
        ),
    ]);
    let text = format!(r#""content":[{{"type":"text","text":{}}}]"#, quoted(&cli));
    assert!(
        out[0].contains(&text),
        "{}",
        &out[0][..600.min(out[0].len())]
    );
    assert!(!structured(&out[0]).is_empty());
    assert_eq!(
        out[1],
        tool_error(
            2,
            "NoSuch is not a workflow with an envelope of this program"
        )
    );
    assert_eq!(out[2], tool_error(3, "workflow must be a string"));
    // A view of a program that applies a pattern of a library is given the
    // library's modules.
    assert!(
        out[3].contains(r#""isError":false"#),
        "{}",
        &out[3][..400.min(out[3].len())]
    );
    assert!(out[3].contains(r#""kind":"authority""#));

    // A program of 0.4 with its module: the card door's answer, through the
    // tool, as `mandate view --card` prints it.
    let mut io = MemoryIo::new();
    for f in [
        "fixtures/envelope/migrate-all.mdt",
        "fixtures/envelope/domain.mdt",
    ] {
        io.files.insert(f.to_owned(), read_bytes(f).unwrap());
    }
    let code = serve_io(
        &mut io,
        &[
            "view",
            "fixtures/envelope/migrate-all.mdt",
            "--card",
            "--format",
            "json",
            "--module",
            "fixtures/envelope/domain.mdt",
        ],
        b"",
    );
    assert_eq!(code, 0, "{}", io.err);
    let cli = io.out.trim_end().to_owned();
    let args = format!(
        r#"{{"source":{},"modules":[{}],"view":"card","workflow":"MigrateAll"}}"#,
        quoted(&read_text("fixtures/envelope/migrate-all.mdt").unwrap()),
        quoted(&read_text("fixtures/envelope/domain.mdt").unwrap())
    );
    let out = serve(&[call(5, "mandate.project", &args)]);
    assert!(
        out[0].contains(&format!(
            r#""content":[{{"type":"text","text":{}}}]"#,
            quoted(&cli)
        )),
        "{}",
        out[0]
    );
}

#[test]
fn the_end_of_the_input_ends_the_server_with_status_0() {
    let mut io = MemoryIo::new();
    assert_eq!(serve_io(&mut io, &["mcp"], b""), 0);
    assert_eq!((io.out.as_str(), io.err.as_str()), ("", ""));
    // A last line without a line break is answered before the end.
    let ping = r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#;
    assert_eq!(
        serve_io(&mut io, &["mcp", "positional", "--json"], ping.as_bytes()),
        0
    );
    assert_eq!(io.out.lines().count(), 1, "{}", io.out);
}

#[test]
fn a_server_whose_answers_no_one_reads_stops_with_status_1() {
    let mut io = MemoryIo::new();
    io.out_closed = true;
    let ping = format!(
        "{}\n",
        r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}"#
    );
    assert_eq!(serve_io(&mut io, &["mcp"], ping.repeat(3).as_bytes()), 1);
    assert_eq!(io.out, "");
    assert_eq!(
        io.err,
        "mandate: cannot write standard output: broken pipe\n"
    );
    // A notification has no answer, so nothing is written and nothing fails.
    let note = "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}\n";
    assert_eq!(serve_io(&mut io, &["mcp"], note.as_bytes()), 0);
}

#[test]
fn the_servers_modules_are_read_before_it_starts_as_the_node_command_line_reads_them() {
    // A module that is not there: a usage error, before anything is served.
    let mut io = MemoryIo::new();
    assert_eq!(
        serve_io(&mut io, &["mcp", "--module", "missing.mdt"], b""),
        2
    );
    assert!(
        io.err.starts_with("mandate: cannot read missing.mdt: "),
        "{}",
        io.err
    );
    // One that does not load: its diagnostics, and status 1.
    io.files
        .insert("bad.mdt".to_owned(), b"not a module".to_vec());
    assert_eq!(serve_io(&mut io, &["mcp", "--module", "bad.mdt"], b""), 1);
    assert!(
        io.err.contains("bad.mdt:") && io.err.contains("MDT-E"),
        "{}",
        io.err
    );
    assert_eq!(io.out, "");
    // With --json, as JSON on standard output.
    assert_eq!(
        serve_io(&mut io, &["mcp", "--module", "bad.mdt", "--json"], b""),
        1
    );
    assert!(io.out.starts_with("{\n  \"ok\": false,"), "{}", io.out);
    // An option without its value.
    assert_eq!(serve_io(&mut io, &["mcp", "--module"], b""), 2);
    assert!(io.err.starts_with("usage: mandate"), "{}", io.err);
}
