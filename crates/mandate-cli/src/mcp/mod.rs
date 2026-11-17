//! `mandate mcp`: the compiler as an MCP server on stdio (spec/mcp.md,
//! spec/attention.md "The MCP server"), the native one beside the Node
//! server of `bridge/src/mcp.ts`.
//!
//! It answers what the Node server answers, with the same bytes: the same
//! two protocol eras (modern, `2026-07-28`, with the version in `_meta`; and
//! legacy, a session opened by `initialize`), the same JSON-RPC errors and
//! their `data`, the same limits on a message, each held before the message
//! is handled, and the same tools, which call the same doors of the
//! compiler. It serves the tools of language 0.7, as the door `mcp_tools`
//! gives them; what 0.7 adds to the tools is `tools.rs`'s.
//!
//! The loop is a plain blocking read of standard input ([`Io::read_input_part`]):
//! each line is bounded while it is read ([`lines`]), read as `JSON.parse`
//! reads it, held to the limits, handled, and answered with one line of
//! `JSON.stringify` on standard output ([`json`]). Standard output carries
//! only those lines. The end of the input ends the server, with status 0.
//!
//! The server only computes: it reads no file (the modules it is started
//! with are read before it starts, and the specification is part of the
//! executable), writes none, and no tool signs, approves, decides or
//! promotes.

mod json;
mod lines;
mod tools;

use mandate_ir::{JsObject, JsValue, Map, Value};

use crate::Io;
use json::{J, JObj, JStr, KEPT_DEPTH, Key, js_space, js_string_of};
use lines::{Line, Lines};

/// The versions of the modern era.
const MODERN_VERSIONS: [&str; 1] = ["2026-07-28"];

/// The newest version of the legacy era: what `initialize` opens a session
/// with when it asks for a version the server does not speak.
const NEWEST_LEGACY: &str = "2025-11-25";

/// The versions of the legacy era, newest first.
const LEGACY_VERSIONS: [&str; 4] = [NEWEST_LEGACY, "2025-06-18", "2025-03-26", "2024-11-05"];

/// The prefix of the protocol's names in `_meta`.
const META: &str = "io.modelcontextprotocol/";

/// The server's name and version.
const SERVER_NAME: &str = "mandate-compiler";
const SERVER_VERSION: &str = "0.2.0";

/// What the server tells a client it is for.
const INSTRUCTIONS: &str = "Mandate's compiler. Check a program before proposing it, read a diagnostic's code and repair, and change programs with apply_patch against the hash you read. A patch that widens authority, raises a budget, removes a criterion or adds an irreversible effect needs a person's approval; you cannot grant it.";

/// How long a client may keep `server/discover`'s answer, and for whom.
const DISCOVER_TTL_MS: u32 = 3_600_000;
const DISCOVER_CACHE_SCOPE: &str = "public";

/// The language whose tools the server serves.
const LANGUAGE: &str = "mandate/0.7";

/// `MESSAGE_LIMITS` of `bridge/src/mcp.ts`: the bytes of one line, its
/// break not counted (as large as a program may be).
pub(crate) const LIMIT_BYTES: usize = mandate_ir::limits::SOURCE_BYTES;

/// The elements of any one array.
const LIMIT_ITEMS: usize = 10_000;

/// The nesting depth.
const LIMIT_DEPTH: usize = KEPT_DEPTH;

/// How much of the input is read at once.
const READ_BYTES: usize = 64 * 1024;

/// A call a tool could not serve: a tool result with `isError: true`
/// (`ToolError`), or a failure that is an Internal error of the protocol.
#[derive(Debug)]
pub(crate) enum Fail {
    /// The tool's message.
    Tool(JStr),
    /// What failed, after `Internal error: `.
    Internal(JStr),
}

/// The tool list of 0.7, from the door `mcp_tools`.
struct ToolList {
    /// The `tools` member of `tools/list`.
    tools: JsValue,
    /// What the modern era adds beside it.
    modern: JsObject,
    /// The tools' names.
    names: Vec<String>,
}

impl ToolList {
    /// The list the door gives for [`LANGUAGE`].
    fn of_door() -> ToolList {
        let mut input = Map::new();
        input.insert("language", LANGUAGE);
        let out =
            mandate_doors::door("mcp_tools").and_then(|d| (d.call)(&Value::Object(input)).ok());
        let tools = out
            .as_ref()
            .and_then(|o| o.get("tools"))
            .cloned()
            .unwrap_or(JsValue::Array(Vec::new()));
        let modern = out
            .as_ref()
            .and_then(|o| o.get("modern"))
            .and_then(JsValue::as_object)
            .cloned()
            .unwrap_or_default();
        let names = tools
            .as_array()
            .unwrap_or_default()
            .iter()
            .filter_map(|t| t.get("name").and_then(JsValue::as_str))
            .map(str::to_owned)
            .collect();
        ToolList {
            tools,
            modern,
            names,
        }
    }
}

/// One server: one process, which may open a legacy session with
/// `initialize`.
pub(crate) struct Server {
    /// The legacy version a session was opened with.
    legacy: Option<String>,
    /// What every call's program may import (`--module`).
    modules: JsObject,
    /// The tools.
    list: ToolList,
    /// The table of codes (the door `codes`), once it is read.
    codes: Option<JsValue>,
}

/// The first array or nesting limit a message breaks: its reason, message,
/// limit and the JSON Pointer of the value.
struct Breach {
    reason: &'static str,
    message: String,
    limit: usize,
    path: JStr,
}

/// `ptrToken` of a member name that may hold a lone surrogate.
fn token_of(k: Key<'_>) -> JStr {
    match k.to_jstr() {
        JStr::Text(s) => JStr::Text(json::pointer_token(&s)),
        JStr::Units(u) => {
            let mut out = Vec::with_capacity(u.len());
            for c in u {
                match c {
                    0x7e => out.extend([0x7e, 0x30]),
                    0x2f => out.extend([0x7e, 0x31]),
                    c => out.push(c),
                }
            }
            JStr::from_units(out)
        }
    }
}

/// `overLimit`: the first limit `v` breaks, in the order the Node server
/// walks it (each value's depth, then an array's length, then its
/// elements; an object's members in their order).
fn over_limit(v: &J, path: &JStr, depth: usize) -> Option<Breach> {
    if depth > LIMIT_DEPTH {
        return Some(Breach {
            reason: "E_INPUT_TOO_DEEP",
            message: format!("Request nesting exceeds the depth limit of {LIMIT_DEPTH}"),
            limit: LIMIT_DEPTH,
            path: path.clone(),
        });
    }
    let slash = JStr::from("/");
    match v {
        J::Arr(items) => {
            if items.len() > LIMIT_ITEMS {
                return Some(Breach {
                    reason: "E_ARRAY_TOO_LONG",
                    message: format!(
                        "Request has an array of {} elements; the limit is {LIMIT_ITEMS}",
                        items.len()
                    ),
                    limit: LIMIT_ITEMS,
                    path: path.clone(),
                });
            }
            items.iter().enumerate().find_map(|(i, item)| {
                let at = JStr::concat(&[path, &slash, &JStr::Text(i.to_string())]);
                over_limit(item, &at, depth.saturating_add(1))
            })
        }
        J::Obj(o) => o.iter().find_map(|(k, item)| {
            let at = JStr::concat(&[path, &slash, &token_of(k)]);
            over_limit(item, &at, depth.saturating_add(1))
        }),
        _ => None,
    }
}

/// `idOf`: the message's id, when it is one an answer may carry.
fn id_of(msg: &J) -> J {
    match msg.get("id") {
        Some(id @ (J::Str(_) | J::Num(_))) => id.clone(),
        _ => J::Null,
    }
}

/// `{ jsonrpc: "2.0", id, error: { code, message, data? } }`.
fn failure(id: J, code: i32, message: JStr, data: Option<J>) -> J {
    let error = JObj::new()
        .with("code", J::Num(f64::from(code)))
        .with("message", J::Str(message))
        .with_some("data", data);
    J::Obj(
        JObj::new()
            .with("jsonrpc", J::str("2.0"))
            .with("id", id)
            .with("error", J::Obj(error)),
    )
}

/// A list of strings.
fn strings(items: &[&str]) -> J {
    J::Arr(items.iter().map(|s| J::str(*s)).collect())
}

/// Every version the server speaks, modern first.
fn supported() -> J {
    let all: Vec<&str> = MODERN_VERSIONS
        .iter()
        .chain(LEGACY_VERSIONS.iter())
        .copied()
        .collect();
    strings(&all)
}

/// The server's name and version, `SERVER_INFO`.
fn server_info() -> J {
    J::Obj(
        JObj::new()
            .with("name", J::str(SERVER_NAME))
            .with("version", J::str(SERVER_VERSION)),
    )
}

/// A JavaScript `Response` with `result`: in the modern era, with
/// `resultType` before it and the server's identity in `_meta` after it.
fn answered(id: J, result: JObj, modern: bool) -> J {
    let result = if modern {
        let mut all = JObj::new().with("resultType", J::str("complete"));
        for (k, v) in result.iter() {
            all.insert(k.to_jstr(), v.clone());
        }
        all.with(
            "_meta",
            J::Obj(JObj::new().with(&format!("{META}serverInfo"), server_info())),
        )
    } else {
        result
    };
    J::Obj(
        JObj::new()
            .with("jsonrpc", J::str("2.0"))
            .with("id", id)
            .with("result", J::Obj(result)),
    )
}

/// `v` when it is an object or an array that JavaScript reads as true, else
/// `{}`: what `(x && typeof x === "object" ? x : {})` gives.
fn object_or_empty<'a>(v: Option<&'a J>, empty: &'a J) -> &'a J {
    match v {
        Some(x) if x.is_object_like() => x,
        _ => empty,
    }
}

impl Server {
    /// A server whose calls may import `modules`.
    pub(crate) fn new(modules: JsObject) -> Server {
        Server {
            legacy: None,
            modules,
            list: ToolList::of_door(),
            codes: None,
        }
    }

    /// The answer to one line, with its line break; `None` for a line that
    /// is answered with nothing (an empty line, a notification).
    pub(crate) fn answer(&mut self, line: Line) -> Option<String> {
        let answer = match line {
            Line::TooLarge(bytes) => {
                let data = JObj::new()
                    .with("reason", J::str("E_INPUT_TOO_LARGE"))
                    .with("limit", J::Num(LIMIT_BYTES as f64))
                    .with("bytes", J::Num(bytes as f64));
                failure(
                    J::Null,
                    -32600,
                    JStr::Text(format!(
                        "Request exceeds the {LIMIT_BYTES}-byte message limit"
                    )),
                    Some(J::Obj(data)),
                )
            }
            Line::Bytes(bytes) => {
                // Decoded as Node's Buffer decodes UTF-8: an ill-formed
                // sequence is U+FFFD, a byte order mark is kept.
                let text = String::from_utf8_lossy(&bytes);
                if text.chars().all(js_space) {
                    return None;
                }
                let Some(msg) = json::parse(&text) else {
                    return Some(line_of(&failure(
                        J::Null,
                        -32700,
                        JStr::from("Parse error"),
                        None,
                    )));
                };
                if let Some(b) = over_limit(&msg, &JStr::from(""), 1) {
                    let data = JObj::new()
                        .with("reason", J::str(b.reason))
                        .with("limit", J::Num(b.limit as f64))
                        .with("path", J::Str(b.path));
                    failure(
                        id_of(&msg),
                        -32600,
                        JStr::Text(b.message),
                        Some(J::Obj(data)),
                    )
                } else {
                    match self.handle(&msg) {
                        Ok(Some(res)) => res,
                        Ok(None) => return None,
                        Err(message) => {
                            let id = match &msg {
                                J::Obj(o) => o
                                    .get("id")
                                    .filter(|v| !matches!(v, J::Null))
                                    .cloned()
                                    .unwrap_or(J::Null),
                                _ => J::Null,
                            };
                            failure(
                                id,
                                -32603,
                                JStr::concat(&[&JStr::from("Internal error: "), &message]),
                                None,
                            )
                        }
                    }
                }
            }
        };
        Some(line_of(&answer))
    }

    /// `handle`: the answer to one JSON-RPC message, `None` for a
    /// notification; an `Err` is an Internal error, with what failed.
    fn handle(&mut self, msg: &J) -> Result<Option<J>, JStr> {
        let J::Obj(req) = msg else {
            return Ok(Some(failure(
                J::Null,
                -32600,
                JStr::from("Invalid request"),
                None,
            )));
        };
        let id = req
            .get("id")
            .filter(|v| !matches!(v, J::Null))
            .cloned()
            .unwrap_or(J::Null);
        let method = match (req.get("jsonrpc").and_then(J::as_jstr), req.get("method")) {
            (Some(JStr::Text(v)), Some(J::Str(m))) if v == "2.0" => m.clone(),
            _ => {
                return Ok(Some(failure(
                    id,
                    -32600,
                    JStr::from("Invalid request"),
                    None,
                )));
            }
        };
        let notification = req.get("id").is_none();
        let empty = J::Obj(JObj::new());
        let params = object_or_empty(req.get("params").filter(|p| p.truthy()), &empty);
        let meta = object_or_empty(params.get("_meta").filter(|p| p.truthy()), &empty);
        let method_is = |name: &str| method.text() == Some(name);

        // Legacy era: the handshake opens a session for this process.
        if method_is("initialize") {
            let asked = match params.get("protocolVersion") {
                None | Some(J::Null) => JStr::from(""),
                Some(v) => v.to_js_string(),
            };
            let version = asked
                .text()
                .filter(|a| LEGACY_VERSIONS.contains(a))
                .unwrap_or(NEWEST_LEGACY)
                .to_owned();
            let result = JObj::new()
                .with("protocolVersion", J::str(version.as_str()))
                .with(
                    "capabilities",
                    J::Obj(JObj::new().with(
                        "tools",
                        J::Obj(JObj::new().with("listChanged", J::Bool(false))),
                    )),
                )
                .with("serverInfo", server_info())
                .with("instructions", J::str(INSTRUCTIONS));
            self.legacy = Some(version);
            return Ok(Some(answered(id, result, false)));
        }
        if notification {
            return Ok(None);
        }

        let unsupported = |requested: J| {
            let data = JObj::new()
                .with("supported", supported())
                .with("requested", requested);
            failure(
                id.clone(),
                -32022,
                JStr::from("Unsupported protocol version"),
                Some(J::Obj(data)),
            )
        };
        let modern = match meta.get(&format!("{META}protocolVersion")) {
            Some(J::Str(requested)) => {
                if !requested
                    .text()
                    .is_some_and(|r| MODERN_VERSIONS.contains(&r))
                {
                    return Ok(Some(unsupported(J::Str(requested.clone()))));
                }
                true
            }
            _ if self.legacy.is_some() => false,
            _ if method_is("server/discover") => true,
            _ => return Ok(Some(unsupported(J::Null))),
        };

        let result = match method.text() {
            Some("server/discover") => {
                let result = JObj::new()
                    .with("supportedVersions", supported())
                    .with(
                        "capabilities",
                        J::Obj(JObj::new().with("tools", J::Obj(JObj::new()))),
                    )
                    .with("instructions", J::str(INSTRUCTIONS))
                    .with("ttlMs", J::Num(f64::from(DISCOVER_TTL_MS)))
                    .with("cacheScope", J::str(DISCOVER_CACHE_SCOPE));
                return Ok(Some(answered(id, result, true)));
            }
            Some("ping") => JObj::new(),
            Some("tools/list") => {
                let mut result = JObj::new().with("tools", J::Js(self.list.tools.clone()));
                if modern {
                    for (k, v) in self.list.modern.iter() {
                        result.insert(JStr::from(k), J::Js(v.clone()));
                    }
                }
                result
            }
            Some("tools/call") => {
                let name = params.get("name");
                let args = object_or_empty(params.get("arguments").filter(|a| a.truthy()), &empty);
                let known = match name {
                    Some(J::Str(JStr::Text(n))) => self.list.names.iter().any(|t| t == n),
                    _ => false,
                };
                let Some(J::Str(JStr::Text(name))) = name.filter(|_| known) else {
                    let message =
                        JStr::concat(&[&JStr::from("Unknown tool: "), &js_string_of(name)]);
                    return Ok(Some(failure(id, -32602, message, None)));
                };
                match self.call_tool(name, args) {
                    Ok(structured) => {
                        let text = mandate_ir::stringify_pretty(&structured);
                        let content = JObj::new()
                            .with("type", J::str("text"))
                            .with_some("text", text.map(J::str));
                        JObj::new()
                            .with("content", J::Arr(vec![J::Obj(content)]))
                            .with("structuredContent", J::Js(structured))
                            .with("isError", J::Bool(false))
                    }
                    // A call the tool cannot serve is a tool result the model
                    // can read and act on, not a protocol error.
                    Err(Fail::Tool(message)) => {
                        let content = JObj::new()
                            .with("type", J::str("text"))
                            .with("text", J::Str(message));
                        JObj::new()
                            .with("content", J::Arr(vec![J::Obj(content)]))
                            .with("isError", J::Bool(true))
                    }
                    Err(Fail::Internal(message)) => return Err(message),
                }
            }
            _ => {
                let message = JStr::concat(&[&JStr::from("Method not found: "), &method]);
                return Ok(Some(failure(id, -32601, message, None)));
            }
        };
        Ok(Some(answered(id, result, modern)))
    }
}

/// `JSON.stringify(v) + "\n"`.
fn line_of(v: &J) -> String {
    let mut text = json::stringify(v);
    text.push('\n');
    text
}

/// Serves newline-delimited JSON-RPC over `io`'s standard streams until
/// the input ends (status 0). Status 1 when an answer cannot be written
/// (the reader of standard output went away), 2 when the input cannot be
/// read; either is said on standard error.
pub(crate) fn serve(io: &mut dyn Io, modules: JsObject) -> i32 {
    let mut server = Server::new(modules);
    let mut lines = Lines::new(LIMIT_BYTES);
    let mut buf = vec![0u8; READ_BYTES];
    loop {
        let read = match io.read_input_part(&mut buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                io.write_err(&format!(
                    "mandate: cannot read standard input: {}\n",
                    e.message
                ));
                return 2;
            }
        };
        for line in lines.feed(buf.get(..read).unwrap_or_default()) {
            if let Some(answer) = server.answer(line)
                && let Err(e) = io.write_out_part(&answer)
            {
                io.write_err(&format!(
                    "mandate: cannot write standard output: {}\n",
                    e.message
                ));
                return 1;
            }
        }
    }
    if let Some(line) = lines.end()
        && let Some(answer) = server.answer(line)
        && let Err(e) = io.write_out_part(&answer)
    {
        io.write_err(&format!(
            "mandate: cannot write standard output: {}\n",
            e.message
        ));
        return 1;
    }
    0
}
