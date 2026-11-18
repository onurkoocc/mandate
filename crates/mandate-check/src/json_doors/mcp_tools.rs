//! The door of the tool list of the MCP servers (spec/attention.md "The MCP
//! server"), which no TypeScript function of the compiler stands for: the
//! TypeScript compiler is frozen at 0.5, and its list, `TOOLS` of
//! `compiler/src/mcp/server.ts`, is the `tables` door's and does not
//! change. The door is in the table [`super::LIBRARY_DOORS`], committed as
//! `crates/mandate-check/tests/library_doors/doors.json`.
//!
//! Both servers, the Node one (`bridge/src/mcp.ts`) and the native
//! `mandate mcp`, answer `tools/list` with what this door gives, so that they
//! cannot drift. The data is two files, embedded:
//!
//! - `tools.json`, the frozen list (also embedded by the `tables` door), which
//!   is the list of every language up to 0.6;
//! - `tools-0.7.json`, the list of 0.7: the frozen list and the changes the
//!   spec names (`crates/mandate-check/tests/mcp_tools.rs` holds the set of
//!   differences between the two, one named change at a time).

use mandate_ir::{JsObject, JsValue, Value, parse};

use super::DoorError;
use super::input::args;

/// The tools of the languages up to 0.6: the frozen list.
const FROZEN: &str = include_str!("tools.json");

/// The tools of language 0.7.
const TOOLS_0_7: &str = include_str!("tools-0.7.json");

/// The languages whose tools are the frozen list.
const FROZEN_LANGUAGES: [&str; 6] = [
    "mandate/0.1",
    "mandate/0.2",
    "mandate/0.3",
    "mandate/0.4",
    "mandate/0.5",
    "mandate/0.6",
];

/// The newest language the door knows.
const NEWEST: &str = "mandate/0.7";

/// What the modern protocol era adds to the result of `tools/list`: how long
/// a client may keep the list (`ttlMs`) and for whom (`cacheScope`).
const MODERN_TTL_MS: u32 = 3_600_000;
const MODERN_CACHE_SCOPE: &str = "public";

/// The parameters of [`mcp_tools`].
pub(super) const MCP_TOOLS: &[&str] = &["language"];

/// `mcp_tools`: the tools an MCP server of a language serves.
///
/// Input: `{ language }`, one of the language versions (`mandate/0.1` to
/// `mandate/0.7`), required: a caller says which language's tools it serves,
/// and never gets another's by default, so that a later language cannot
/// change what a caller of today receives. A language the door does not know
/// is `bad_input`, which names those it does. `mandate/0.1` to `mandate/0.6`
/// give the frozen list; `mandate/0.7` the list of 0.7. The next language
/// adds its own entry.
///
/// Output: `{ language, tools, modern }`.
///
/// - `tools` is the `tools` member of the result of `tools/list`, as the
///   servers hand it over unchanged: each tool is `{ name, title,
///   description, inputSchema }`, `inputSchema` a JSON Schema 2020-12 object.
/// - `modern` is what the modern protocol era (`2026-07-28`) adds to that
///   result beside `tools`: `{ ttlMs, cacheScope }`. A server of the legacy
///   eras answers `{ tools }` alone, one of the modern era `{ tools,
///   ...modern }`; nothing else in the list differs between the eras.
///
/// The output depends on the language and on nothing else: no file, clock
/// or environment is read.
pub(super) fn mcp_tools(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, MCP_TOOLS)?;
    let language = a.str("language")?;
    let text = if FROZEN_LANGUAGES.contains(&language) {
        FROZEN
    } else if language == NEWEST {
        TOOLS_0_7
    } else {
        return Err(DoorError::bad_input(format!(
            "`language` is \"{language}\", which has no tool list: the door knows {}",
            FROZEN_LANGUAGES
                .iter()
                .chain([&NEWEST])
                .map(|l| format!("\"{l}\""))
                .collect::<Vec<_>>()
                .join(", ")
        )));
    };
    let tools = parse(text)
        .map_err(|_| DoorError::bad_input("the table of the MCP server's tools does not read"))?
        .value;
    Ok(JsObject::new()
        .with("language", language)
        .with("tools", JsValue::from(&tools))
        .with(
            "modern",
            JsObject::new()
                .with("ttlMs", MODERN_TTL_MS)
                .with("cacheScope", MODERN_CACHE_SCOPE),
        )
        .into())
}
