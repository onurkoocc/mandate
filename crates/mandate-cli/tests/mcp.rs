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

/// 0.7 (RP1): `project` with `view: "attention"` answers with the view as
/// JSON, as every other view of `project` does (the Markdown and the HTML
/// are the command's and the door's): the view of `workflow`, or the views
/// of every workflow, exactly what `mandate view --attention --format json`
/// prints, with the lock and the libraries the tool is given.
#[test]
fn project_gives_the_attention_view_as_the_command_prints_it() {
    for (program, lock) in [
        (
            "fixtures/attention/view.mdt",
            "fixtures/attention/view.lock.json",
        ),
        // A lock that pins std.patterns 1.0.0: the view reads that version.
        (
            "fixtures/attention/batch.mdt",
            "conformance/E1609c/mandate.lock.json",
        ),
        (
            "fixtures/attention/batch.mdt",
            "fixtures/attention/batch.lock.json",
        ),
    ] {
        let mut io = MemoryIo::new();
        for f in [program, lock] {
            io.files.insert(f.to_owned(), read_bytes(f).unwrap());
        }
        let source = quoted(&read_text(program).unwrap());
        let lock_json = mandate_ir::stringify(&mandate_ir::JsValue::from(
            &mandate_ir::parse(&read_text(lock).unwrap()).unwrap().value,
        ))
        .unwrap();
        // Every workflow: one object, as the command prints it (also for a
        // program of one).
        let code = serve_io(
            &mut io,
            &[
                "view",
                program,
                "--attention",
                "--format",
                "json",
                "--lock",
                lock,
            ],
            b"",
        );
        assert_eq!(code, 0, "{program}: {}", io.err);
        let all = io.out.clone();
        let named = mandate_ir::parse(&all).unwrap().value;
        let names: Vec<String> = named
            .get("workflows")
            .and_then(mandate_ir::Value::as_array)
            .unwrap()
            .iter()
            .filter_map(|v| v.get("workflow").and_then(mandate_ir::Value::as_str))
            .map(str::to_owned)
            .collect();
        assert!(!names.is_empty());
        let out = serve(&[call(
            1,
            "mandate.project",
            &format!(r#"{{"source":{source},"lock":{lock_json},"view":"attention"}}"#),
        )]);
        assert!(
            out[0].contains(&content(all.trim_end())),
            "{program}: {}",
            &out[0][..300.min(out[0].len())]
        );
        // One workflow: its view, as `--workflow` prints it.
        for name in &names {
            let code = serve_io(
                &mut io,
                &[
                    "view",
                    program,
                    "--attention",
                    "--workflow",
                    name,
                    "--format",
                    "json",
                    "--lock",
                    lock,
                ],
                b"",
            );
            assert_eq!(code, 0, "{program} {name}: {}", io.err);
            let one = io.out.clone();
            let out = serve(&[call(
                2,
                "mandate.project",
                &format!(
                    r#"{{"source":{source},"lock":{lock_json},"view":"attention","workflow":"{name}"}}"#
                ),
            )]);
            assert!(
                out[0].contains(&content(one.trim_end())),
                "{program} {name}: {}",
                &out[0][..300.min(out[0].len())]
            );
        }
    }
}

#[test]
fn the_attention_view_is_refused_where_it_has_none() {
    let source = quoted(&read_text("fixtures/attention/minimal.mdt").unwrap());
    let out = serve(&[call(
        1,
        "mandate.project",
        &format!(r#"{{"source":{source},"view":"attention","workflow":"Nothing"}}"#),
    )]);
    assert_eq!(
        out,
        [tool_error(1, "Nothing is not a workflow of this program")]
    );
    // A program before 0.7 has none.
    let old = quoted(&read_text("fixtures/fixbug/fixbug.mdt").unwrap());
    let out = serve(&[call(
        2,
        "mandate.project",
        &format!(r#"{{"source":{old},"view":"attention"}}"#),
    )]);
    assert_eq!(
        out,
        [tool_error(
            2,
            "view attention is of a program of language 0.7 or later"
        )]
    );
    // A program that does not check is said first, as for every view.
    let out = serve(&[call(
        3,
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

/// What `mandate <args>` prints over the invoices program's files.
fn mandate_on_invoices(args: &[&str]) -> String {
    let mut io = invoices_io();
    let code = serve_io(&mut io, args, b"");
    assert_eq!(code, 0, "{args:?}: {}{}", io.out, io.err);
    io.out
}

/// The member `name` of a JSON text, written as `JSON.stringify(v, null,
/// 2)` writes it: what the tool's `content` text of that view is.
fn pretty_member(text: &str, name: &str) -> String {
    let v = mandate_ir::parse(text).unwrap().value;
    let member = mandate_ir::JsValue::from(v.get(name).unwrap());
    mandate_ir::stringify_pretty(&member).unwrap()
}

/// The `content` text of a tool result, `text` quoted as JSON.
fn content(text: &str) -> String {
    format!(r#""content":[{{"type":"text","text":{}}}]"#, quoted(text))
}

#[test]
fn project_views_of_a_program_that_applies_a_pinned_librarys_pattern_are_mandate_views() {
    let pinned = [
        "--lock",
        "fixtures/library/invoices.lock.json",
        "--libraries",
        "libs",
    ];
    let mut args = vec!["view", "fixtures/library/invoices.mdt", "--format", "json"];
    args.extend(pinned);
    let views = mandate_on_invoices(&args);
    let mut args = vec!["view", "fixtures/library/invoices.mdt", "--format", "json"];
    args.extend([
        "--against",
        "fixtures/library/invoices.mdt",
        "--against-lock",
        "fixtures/library/invoices.lock.json",
    ]);
    args.extend(pinned);
    let diff = mandate_on_invoices(&args);
    let source = quoted(&read_text("fixtures/library/invoices.mdt").unwrap());
    let out = serve(&[
        call(
            1,
            "mandate.project",
            &invoices_args(r#","view":"authority""#),
        ),
        call(2, "mandate.project", &invoices_args(r#","view":"cost""#)),
        call(
            3,
            "mandate.project",
            &invoices_args(r#","view":"architecture""#),
        ),
        call(
            4,
            "mandate.project",
            &invoices_args(&format!(r#","view":"diff","before":{source}"#)),
        ),
    ]);
    // `mandate view` prints the three views of the program with the
    // libraries' modules, the tool one at a time.
    assert!(
        out[0].contains(&content(&pretty_member(&views, "authority"))),
        "{}",
        &out[0][..300]
    );
    assert!(
        out[1].contains(&content(&pretty_member(&views, "cost"))),
        "{}",
        &out[1][..300]
    );
    // `mandate view` gives the architecture view the lock as well, and the
    // tool, as the Node server's, does not; for this program the two are
    // the same.
    assert!(
        out[2].contains(&content(&pretty_member(&views, "architecture"))),
        "{}",
        &out[2][..300]
    );
    // The diff of the program with itself, its libraries and its lock on
    // both sides: what `mandate view --against` prints.
    assert!(
        out[3].contains(&content(diff.trim_end())),
        "{}",
        &out[3][..300]
    );
}

/// 0.7 (RL6): a program of 0.7 whose lock pins std.patterns 1.0.0 is
/// projected, in every view, with 1.0.0's expansion, as `mandate view`
/// shows it with that lock; without the lock, with 2.0.0's, the version of
/// its language. The Node server does not hand the pin yet (its slice comes
/// later), and no recorded conversation holds such a program.
#[test]
fn project_shows_the_version_of_std_patterns_the_lock_pins() {
    const PROGRAM: &str = "fixtures/attention/batch.mdt";
    const LOCK: &str = "conformance/E1609c/mandate.lock.json";
    let mut io = MemoryIo::new();
    for f in [PROGRAM, LOCK] {
        io.files.insert(f.to_owned(), read_bytes(f).unwrap());
    }
    let code = serve_io(
        &mut io,
        &["view", PROGRAM, "--format", "json", "--lock", LOCK],
        b"",
    );
    assert_eq!(code, 0, "{}", io.err);
    let views = io.out.clone();
    let lock = mandate_ir::parse(&read_text(LOCK).unwrap()).unwrap().value;
    let source = quoted(&read_text(PROGRAM).unwrap());
    let with_lock = |view: &str| {
        format!(
            r#"{{"source":{source},"lock":{},"view":"{view}"}}"#,
            mandate_ir::stringify(&mandate_ir::JsValue::from(&lock)).unwrap()
        )
    };
    let alone = |view: &str| format!(r#"{{"source":{source},"view":"{view}"}}"#);
    let out = serve(&[
        call(1, "mandate.project", &with_lock("architecture")),
        call(2, "mandate.project", &with_lock("authority")),
        call(3, "mandate.project", &with_lock("cost")),
        call(4, "mandate.project", &alone("architecture")),
    ]);
    for (i, view) in ["architecture", "authority", "cost"].iter().enumerate() {
        assert!(
            out[i].contains(&content(&pretty_member(&views, view))),
            "{view}: {}",
            &out[i][..300.min(out[i].len())]
        );
    }
    assert!(out[0].contains("BatchWithExceptions (std.patterns 1.0.0)"));
    assert!(out[3].contains("BatchWithExceptions (std.patterns 2.0.0)"));
    // The diff of the program with itself, the lock given: no change.
    let diff = serve(&[call(
        5,
        "mandate.project",
        &with_lock("diff").replace(
            r#","view":"diff""#,
            &format!(r#","view":"diff","before":{source}"#),
        ),
    )]);
    assert!(
        diff[0].contains(r#"\"governance\": []"#),
        "{}",
        &diff[0][..300.min(diff[0].len())]
    );
    // caps_of reads the authority view of that expansion as well.
    let caps = serve(&[call(
        6,
        "mandate.caps_of",
        &with_lock("authority").replace(r#","view":"authority""#, r#","name":"MatchAll""#),
    )]);
    let auth = pretty_member(&views, "authority");
    let row = mandate_ir::parse(&auth).unwrap().value;
    let wanted = row
        .get("rows")
        .and_then(mandate_ir::Value::as_array)
        .unwrap()
        .iter()
        .find(|r| r.get("who").and_then(mandate_ir::Value::as_str) == Some("MatchAll"))
        .map(|r| mandate_ir::stringify(&mandate_ir::JsValue::from(r)).unwrap())
        .unwrap();
    assert!(
        structured(&caps[0]).contains(&wanted),
        "{}",
        &caps[0][..300.min(caps[0].len())]
    );
}

#[test]
fn libraries_that_are_not_libraries_are_a_tool_error_in_each_tool_that_takes_them() {
    let refused = "libraries must be a list of libraries, each { manifest, files }";
    let source = quoted(&read_text("fixtures/fixbug/fixbug.mdt").unwrap());
    for libraries in [
        "5",
        "{}",
        "[5]",
        "[{}]",
        "[null]",
        "[[]]",
        r#"[{"manifest":"x"}]"#,
        r#"[{"files":{}}]"#,
        r#"[{"manifest":5,"files":{}}]"#,
        r#"[{"manifest":"x","files":[]}]"#,
        r#"[{"manifest":"x","files":{"a.mdt":5}}]"#,
        r#"[{"manifest":"x","files":{"a.mdt":"t","b.mdt":null}}]"#,
    ] {
        let args = format!(r#"{{"source":{source},"libraries":{libraries}}}"#);
        let named = format!(r#"{{"source":{source},"name":"FixBug","libraries":{libraries}}}"#);
        let viewed = format!(r#"{{"source":{source},"view":"authority","libraries":{libraries}}}"#);
        let out = serve(&[
            call(1, "mandate.check", &args),
            call(2, "mandate.project", &viewed),
            call(3, "mandate.caps_of", &named),
        ]);
        assert_eq!(
            out,
            [
                tool_error(1, refused),
                tool_error(2, refused),
                tool_error(3, refused)
            ],
            "{libraries}"
        );
    }
    // One of the shape that does not read is the compiler's to say, as a
    // diagnostic of the check, not an Internal error.
    let out = serve(&[call(
        4,
        "mandate.check",
        &format!(r#"{{"source":{source},"libraries":[{{"manifest":"x","files":{{}}}}]}}"#),
    )]);
    assert!(out[0].contains(r#""isError":false"#), "{}", out[0]);
}

#[test]
fn caps_of_and_apply_patch_take_the_lock_and_the_libraries() {
    let out = serve(&[
        call(
            1,
            "mandate.caps_of",
            &invoices_args(r#","name":"MatchInvoices""#),
        ),
        call(
            2,
            "mandate.caps_of",
            &invoices_args_with(r#","name":"MatchInvoices""#),
        ),
        call(
            3,
            "mandate.caps_of",
            &invoices_args(r#","name":"MatchInvoices","lock":null"#),
        ),
    ]);
    // With both: the authority of the workflow, its delegations among them.
    assert!(out[0].contains(r#""isError":false"#), "{}", &out[0][..300]);
    assert!(out[0].contains(r#""who":"MatchInvoices""#));
    assert!(out[0].contains(r#""who":"MatchInvoices → "#));
    // Without the libraries, as `check`: the pinned library is not there.
    assert!(
        out[1].contains("the program does not check: MDT-E"),
        "{}",
        out[1]
    );
    // With the libraries and no lock, as `check` with no lock.
    let mut io = invoices_io();
    let check_no_lock = serve_io(
        &mut io,
        &["mcp"],
        format!(
            "{}\n",
            call(4, "mandate.check", &invoices_args(r#","lock":null"#))
        )
        .as_bytes(),
    );
    assert_eq!(check_no_lock, 0);
    let checks = io.out.contains(r#""structuredContent":{"ok":true"#);
    assert_eq!(
        out[2].contains(r#""isError":false"#),
        checks,
        "{}\n{}",
        out[2],
        io.out
    );
    // apply_patch takes them too (spec/attention.md "The MCP server"): its
    // door, check_patch, checks the patched program with the lock and the
    // libraries, as `check` does.
    let hash = {
        let line = serve(&[call(5, "mandate.check", &invoices_args(""))]).remove(0);
        let at = line.find(r#""program":"sha256:"#).unwrap() + r#""program":""#.len();
        line[at..at + 71].to_owned()
    };
    let patch = format!(r#","base":"{hash}","ops":[]"#);
    // The pinned library's digest, made another: the lock says what the
    // library must be (E1605), and without a lock there is no pin to break.
    let pinned = read_text("fixtures/library/invoices.lock.json").unwrap();
    let digest = "sha256:a595b65236947513762e57701405a1069cebdbe97f3daa48aff59ca3b50e3220";
    assert!(pinned.contains(digest));
    let other = format!("sha256:{}", "a".repeat(64));
    let broken = pinned.replace(digest, &other);
    let broken = mandate_ir::stringify(&mandate_ir::JsValue::from(
        &mandate_ir::parse(&broken).unwrap().value,
    ))
    .unwrap();
    let broken_args = format!(
        r#"{{"source":{},"lock":{broken},"libraries":{}{patch}}}"#,
        quoted(&read_text("fixtures/library/invoices.mdt").unwrap()),
        acme_connectors(),
    );
    let patched = serve(&[
        call(6, "mandate.apply_patch", &invoices_args(&patch)),
        call(7, "mandate.apply_patch", &invoices_args_with(&patch)),
        call(
            8,
            "mandate.apply_patch",
            &invoices_args(&format!("{patch},\"lock\":null")),
        ),
        call(9, "mandate.apply_patch", &broken_args),
        call(
            10,
            "mandate.apply_patch",
            &invoices_args(&format!("{patch},\"libraries\":[]")),
        ),
    ]);
    // With both: the patched program checks, and is what the patch made.
    assert!(
        patched[0].contains(r#""structuredContent":{"ok":true"#),
        "{}",
        &patched[0][..400.min(patched[0].len())]
    );
    assert!(patched[0].contains(&hash), "{}", &patched[0]);
    // With the lock and no libraries (as `check` gives it): the pinned
    // library is not there.
    assert!(
        patched[1].contains(r#""structuredContent":{"ok":false"#),
        "{}",
        &patched[1][..400.min(patched[1].len())]
    );
    assert!(patched[1].contains("MDT-E1604"), "{}", &patched[1]);
    // With the libraries and no lock: as `check` with no lock, whatever it says.
    assert_eq!(
        patched[2].contains(r#""structuredContent":{"ok":true"#),
        checks,
        "{}
{}",
        patched[2],
        io.out
    );
    // The answer differs with the lock: a lock that pins another digest of
    // the library breaks the pin (E1605) of a program that checked.
    assert!(
        patched[3].contains(r#""structuredContent":{"ok":false"#),
        "{}",
        &patched[3][..400.min(patched[3].len())]
    );
    assert!(patched[3].contains("MDT-E1605"), "{}", &patched[3]);
    assert_ne!(patched[0], patched[3]);
    // An empty list of libraries is none, as it is for `check`.
    assert_eq!(patched[4].replace(r#""id":10"#, r#""id":7"#), patched[1]);
    // A list that is not libraries is the tool error `caps_of` gives.
    let refused = serve(&[call(
        11,
        "mandate.apply_patch",
        &invoices_args_with(&format!(r#"{patch},"libraries":[5]"#)),
    )]);
    assert_eq!(
        refused,
        [tool_error(
            11,
            "libraries must be a list of libraries, each { manifest, files }"
        )]
    );
}

#[test]
fn a_library_module_of_a_name_the_server_has_takes_its_place_in_a_view() {
    // A view is given `{ ...modules, ...modulesOf(libraries) }`: a library's
    // module in the place of a server module of its name. Which one a view
    // reads can differ only when their texts do, and then the check refuses
    // the program first (E1605: the library's text is the one its digest
    // covers), so no view is made of the server's.
    //
    // The server is started with modules of the library's two names, its
    // acme.connectors changed: the mailbox's class is internal, where the
    // library's is confidential. The call gives the library.
    let dir = "fixtures/library/acme.connectors";
    let connectors = read_text(&format!("{dir}/connectors.mdt")).unwrap();
    let mailbox = "pub connector mailbox = mcp(\"https://mail.acme.example/mcp\")\n  version \"1.4\"\n  class   confidential";
    assert!(connectors.contains(mailbox));
    let changed = connectors.replace(mailbox, &mailbox.replace("confidential", "internal"));
    let mut io = invoices_io();
    io.files.insert(
        "types.mdt".to_owned(),
        read_bytes(&format!("{dir}/types.mdt")).unwrap(),
    );
    io.files
        .insert("connectors.mdt".to_owned(), changed.into_bytes());
    let server = ["mcp", "--module", "types.mdt", "--module", "connectors.mdt"];
    let authority = r#","view":"authority""#;
    let input = format!(
        "{}\n{}\n{}\n",
        call(1, "mandate.check", &invoices_args("")),
        call(2, "mandate.project", &invoices_args(authority)),
        // The server's modules alone, without the library or its lock.
        call(
            3,
            "mandate.project",
            &invoices_args_with(&format!(r#","lock":null{authority}"#))
        ),
    );
    assert_eq!(
        serve_io(&mut io, &server, input.as_bytes()),
        0,
        "{}",
        io.err
    );
    let with_modules: Vec<String> = io.out.lines().map(str::to_owned).collect();
    let alone = serve(&[
        call(1, "mandate.check", &invoices_args("")),
        call(2, "mandate.project", &invoices_args(authority)),
    ]);
    let refused = "Module acme.connectors is given to the check and is a module of a library, with another text: the library's is the one its digest covers.";
    assert!(
        with_modules[0].contains(r#""structuredContent":{"ok":false"#),
        "{}",
        &with_modules[0][..300]
    );
    assert!(with_modules[0].contains("MDT-E1605"));
    assert!(
        with_modules[0].contains(refused),
        "{}",
        &with_modules[0][..600]
    );
    assert_eq!(
        with_modules[1],
        tool_error(
            2,
            &format!("the program does not check: MDT-E1605 {refused}")
        )
    );
    assert!(alone[0].contains(r#""structuredContent":{"ok":true"#));
    // The server's modules alone, without the library, check, and the view
    // of them is the library's view (the mailbox's class is not in it).
    assert!(
        with_modules[2].contains(r#""isError":false"#),
        "{}",
        &with_modules[2][..300]
    );
    assert_eq!(
        with_modules[2].replacen(r#""id":3"#, r#""id":2"#, 1),
        alone[1]
    );

    // A server module of the library's text: the check takes both and checks
    // as without it, and the view is the view without it.
    let mut io = invoices_io();
    io.files.insert(
        "types.mdt".to_owned(),
        read_bytes(&format!("{dir}/types.mdt")).unwrap(),
    );
    let input = format!(
        "{}\n{}\n",
        call(1, "mandate.check", &invoices_args("")),
        call(2, "mandate.project", &invoices_args(authority)),
    );
    assert_eq!(
        serve_io(&mut io, &["mcp", "--module", "types.mdt"], input.as_bytes()),
        0,
        "{}",
        io.err
    );
    let same: Vec<String> = io.out.lines().map(str::to_owned).collect();
    assert_eq!(same, alone);
}
