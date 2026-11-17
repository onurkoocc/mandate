//! `mandate mcp` started as a process: the recorded conversations of
//! `vectors/mcp/` (the Node server's bytes) through the executable, and
//! what only a process shows: a line of 100 MiB read without the process
//! growing, the end of the input, a closed output pipe, the modules named
//! by `--module` read from the file system. `tests/mcp.rs` holds the rest,
//! in memory.
//!
//! WASI has no processes, so `scripts/wasi-test.mjs` builds nothing of this
//! file: it runs where `cargo test` runs natively (the `rust` job of CI).

#![cfg(not(target_os = "wasi"))]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod transcripts;

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};

use mandate_testkit::repo;
use transcripts::{conversations, tools_text};

/// A ping of the modern era.
fn ping(id: u32) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"method":"ping","params":{{"_meta":{{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}}}}"#
    )
}

/// What the server answers to [`ping`].
fn pong(id: u32) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","id":{id},"result":{{"resultType":"complete","_meta":{{"io.modelcontextprotocol/serverInfo":{{"name":"mandate-compiler","version":"0.2.0"}}}}}}}}"#
    )
}

/// `mandate <args>` started in the repository root, its three streams
/// piped.
fn start(args: &[&str]) -> Child {
    Command::new(env!("CARGO_BIN_EXE_mandate"))
        .args(args)
        .current_dir(repo())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the mandate executable starts")
}

/// The standard output, standard error and exit status of `mandate <args>`
/// given `input`, written from another thread while the answers are read.
fn run_with(args: &[&str], input: Vec<u8>) -> (String, String, Option<i32>) {
    let mut child = start(args);
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        // A server that stops before the end (a module that does not load)
        // takes no more; what it wrote says so.
        let _ = stdin.write_all(&input);
    });
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    (
        String::from_utf8(out.stdout).expect("UTF-8 on standard output"),
        String::from_utf8(out.stderr).expect("UTF-8 on standard error"),
        out.status.code(),
    )
}

#[test]
fn every_recorded_conversation_gets_the_node_servers_bytes_through_the_executable() {
    let (frozen, of_0_7) = (tools_text("mandate/0.6"), tools_text("mandate/0.7"));
    let all = conversations();
    let mut problems = Vec::new();
    let mut answers = 0;
    for c in &all {
        let args: Vec<&str> = c.args.iter().map(String::as_str).collect();
        let (out, err, code) = run_with(&args, c.input.clone());
        if code != Some(0) || !err.is_empty() {
            problems.push(format!(
                "{}: status {code:?}, standard error {err:?}",
                c.name
            ));
        } else if let Err(e) = c.compare(&out, &frozen, &of_0_7) {
            problems.push(e);
        }
        answers += c.answers();
    }
    println!(
        "compared {} conversations, {answers} answers, through the executable",
        all.len()
    );
    assert!(all.len() >= 15 && answers >= 200);
    assert!(problems.is_empty(), "{}", problems.join("\n\n"));
}

/// The peak resident memory of process `pid`, in KiB (`VmHWM`).
#[cfg(target_os = "linux")]
fn peak_kib(pid: u32) -> u64 {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).unwrap();
    let line = status
        .lines()
        .find(|l| l.starts_with("VmHWM:"))
        .expect("VmHWM");
    line.split_whitespace().nth(1).unwrap().parse().unwrap()
}

/// A line of 100 MiB is refused for its size, read through to its end
/// without being held: the process's peak memory grows by less than 16 MiB
/// while it reads it, and the server answers the next line.
#[cfg(target_os = "linux")]
#[test]
fn a_line_of_100_mib_is_read_without_growing_the_process() {
    let mut child = start(&["mcp"]);
    let mut stdin = child.stdin.take().unwrap();
    let mut answers = BufReader::new(child.stdout.take().unwrap());
    let mut next = || {
        let mut line = String::new();
        answers.read_line(&mut line).unwrap();
        line
    };
    // Once it has answered one line, its memory is what serving takes.
    writeln!(stdin, "{}", ping(1)).unwrap();
    stdin.flush().unwrap();
    assert_eq!(next(), format!("{}\n", pong(1)));
    let before = peak_kib(child.id());
    let block = vec![b'a'; 64 * 1024];
    for _ in 0..1600 {
        stdin.write_all(&block).unwrap();
    }
    writeln!(stdin).unwrap();
    writeln!(stdin, "{}", ping(2)).unwrap();
    stdin.flush().unwrap();
    assert_eq!(
        next(),
        "{\"jsonrpc\":\"2.0\",\"id\":null,\"error\":{\"code\":-32600,\"message\":\"Request exceeds the 1048576-byte message limit\",\"data\":{\"reason\":\"E_INPUT_TOO_LARGE\",\"limit\":1048576,\"bytes\":104857600}}}\n"
    );
    assert_eq!(next(), format!("{}\n", pong(2)));
    let after = peak_kib(child.id());
    println!("peak resident memory: {before} KiB before the line, {after} KiB after it");
    assert!(
        after < before + 16 * 1024,
        "{before} KiB before, {after} KiB after"
    );
    drop(stdin);
    assert_eq!(next(), "");
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

#[test]
fn the_end_of_the_input_ends_the_server_with_status_0() {
    let out = Command::new(env!("CARGO_BIN_EXE_mandate"))
        .arg("mcp")
        .current_dir(repo())
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(0));
    assert!(out.stdout.is_empty() && out.stderr.is_empty());
    // Answered as it goes, before the input ends.
    let mut child = start(&["mcp"]);
    let mut stdin = child.stdin.take().unwrap();
    let mut answers = BufReader::new(child.stdout.take().unwrap());
    for id in 1..=3 {
        writeln!(stdin, "{}", ping(id)).unwrap();
        stdin.flush().unwrap();
        let mut line = String::new();
        answers.read_line(&mut line).unwrap();
        assert_eq!(line, format!("{}\n", pong(id)));
    }
    // A last line without a line break is answered at the end.
    write!(stdin, "{}", ping(4)).unwrap();
    drop(stdin);
    let mut rest = String::new();
    std::io::Read::read_to_string(&mut answers, &mut rest).unwrap();
    assert_eq!(rest, format!("{}\n", pong(4)));
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

#[test]
fn a_closed_output_pipe_stops_the_server_with_status_1() {
    let mut child = start(&["mcp"]);
    // No one reads the answers.
    drop(child.stdout.take());
    let mut stdin = child.stdin.take().unwrap();
    let writer = std::thread::spawn(move || {
        for id in 0..1000 {
            // The server may be gone before all is written.
            if writeln!(stdin, "{}", ping(id)).is_err() {
                break;
            }
        }
    });
    let out = child.wait_with_output().unwrap();
    writer.join().unwrap();
    assert_eq!(out.status.code(), Some(1));
    let err = String::from_utf8(out.stderr).unwrap();
    assert!(
        err.starts_with("mandate: cannot write standard output: "),
        "{err}"
    );
}

#[test]
fn the_servers_modules_are_the_files_module_names() {
    // The recorded conversation `server-modules` runs with one; here the
    // refusals, before anything is served.
    let (out, err, code) = run_with(
        &["mcp", "--module", "no-such-module.mdt"],
        ping(1).into_bytes(),
    );
    assert_eq!((out.as_str(), code), ("", Some(2)));
    assert!(
        err.starts_with("mandate: cannot read no-such-module.mdt: "),
        "{err}"
    );
    let bad =
        std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("mandate-cli-mcp-bad-module.mdt");
    std::fs::write(&bad, "not a module\n").unwrap();
    let bad = bad.to_str().unwrap();
    let (out, err, code) = run_with(&["mcp", "--module", bad], ping(1).into_bytes());
    assert_eq!(code, Some(1), "{out}{err}");
    assert_eq!(out, "");
    assert!(err.contains(": error MDT-E"), "{err}");
}
