//! The constants and the codes: `tables`, `codes` and `explain`.
//!
//! `tables` gives every constant the TypeScript entry point
//! (`compiler/src/index.ts`) exports as a value, by its export name. Most
//! are the crates' own constants; the few that no Rust code needed until
//! now are here as data: the ACS target's format, version and profile
//! (`compiler/src/target/acs.ts`, whose port is another slice's), the MCP
//! server's tools and protocol versions (`compiler/src/mcp/server.ts`,
//! which stays in TypeScript in release 0.6; the tools in `tools.json`
//! beside this file), `PROGRESS_DEFAULTS` and `SYSTEM_KINDS`
//! (`compiler/src/ir/types.ts`). The vectors hold each to the TypeScript's.

use mandate_ir::codes::{CodeRow, Reference};
use mandate_ir::{
    BUDGET_DIMENSIONS, DefKind, JsObject, JsValue, LOCK_FIELDS_0_5, LOCK_FORMAT, LOCK_FORMATS,
    Language, Value, compare_utf16, limits, parse,
};

use super::DoorError;
use super::input::args;
use super::program::strings_js;
use crate::caps::HTTP_METHODS;
use crate::governance::{GOVERNANCE_FILES, GOVERNANCE_KINDS};
use crate::managed_agents::{MA_BETA, MA_BINDING_FORMAT, MA_BRIDGE_PROFILE, MA_MAX_CLASS};
use crate::path::PATH_PATTERN;
use crate::sandbox::{
    ISOLATION_LEVELS, SANDBOX_DENIALS_FORMAT, SANDBOX_REQUIREMENT_FORMAT,
    SANDBOX_REQUIREMENT_FORMAT_0_2,
};
use crate::stdlib::{BUILTIN_EFFECTS, DATA_CLASSES, DECISION_POLICIES, STD_EFFECTS, STD_FNS};
use crate::view_shared::VIEW_FORMAT;

/// `ACS_TARGET_FORMAT`, `compiler/src/target/acs.ts`.
const ACS_TARGET_FORMAT: &str = "mandate/acs-target/0.1";

/// `ACS_VERSION`, `compiler/src/target/acs.ts`: the ACS manifest contract
/// the target writes.
const ACS_VERSION: &str = "0.4.0-alpha.1";

/// `ACS_PROFILE`, `compiler/src/target/acs.ts`: how each guarantee holds
/// when an agent's calls are governed by an ACS host alone.
const ACS_PROFILE: [(&str, &str); 18] = [
    ("package.identity", "partial"),
    ("static.checks", "full"),
    ("caps.paths_commands", "partial"),
    ("caps.delegation_narrowing", "none"),
    ("caps.network", "none"),
    ("parallel.isolation", "none"),
    ("model.pinning", "partial"),
    ("model.max_class", "partial"),
    ("budget.tokens_spend", "partial"),
    ("budget.steps", "none"),
    ("budget.time", "partial"),
    ("loop.progress", "none"),
    ("journal.turns", "none"),
    ("replay.no_adapter", "none"),
    ("evidence.verifier", "none"),
    ("effects.prepare_authorize_commit", "none"),
    ("credentials.control_plane", "none"),
    ("cancel", "none"),
];

/// `MODERN_VERSIONS`, `compiler/src/mcp/server.ts`: the MCP protocol
/// versions the server answers in the modern form.
const MODERN_VERSIONS: [&str; 1] = ["2026-07-28"];

/// `LEGACY_VERSIONS`, `compiler/src/mcp/server.ts`: the MCP protocol
/// versions the server answers in the legacy form, newest first.
const LEGACY_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/// `TOOLS`, `compiler/src/mcp/server.ts`: the MCP server's tools as
/// `tools/list` gives them, as JSON text.
const TOOLS: &str = include_str!("tools.json");

/// `PROGRESS_DEFAULTS`, `compiler/src/ir/types.ts`: a loop's progress
/// limits when it names none.
const PROGRESS_DEFAULTS: [(&str, i32); 3] = [("window", 8), ("repeats", 3), ("stall", 5)];

/// `SYSTEM_KINDS`, `compiler/src/ir/types.ts`: the kinds of definition of a
/// system model.
const SYSTEM_KINDS: [DefKind; 3] = [DefKind::Component, DefKind::Interface, DefKind::Environment];

/// A table of names and texts as an object.
fn pairs_js(pairs: &[(&str, &str)]) -> JsValue {
    let mut out = JsObject::new();
    for (name, text) in pairs {
        out.insert(*name, *text);
    }
    out.into()
}

/// The rows as `CODES` is written: `{ "MDT-E0101": { title, explain }, ... }`.
fn codes_js<'a>(rows: impl Iterator<Item = &'a CodeRow>) -> JsValue {
    rows.map(|row| {
        (
            row.code,
            JsObject::new()
                .with("title", row.title)
                .with("explain", row.explain),
        )
    })
    .collect::<JsObject>()
    .into()
}

/// The parameters of [`tables`].
pub(super) const TABLES: &[&str] = &[];

/// Every constant `compiler/src/index.ts` exports as a value, by its export
/// name.
///
/// Input: `{}`.
/// Output: `{ <export name>: <value> }`, the names in UTF-16 order (the
/// order of a module's exports), each value as `JSON.stringify` writes it
/// (a `Set` as an array). `CODES` is the rows of `compiler/src/codes.ts`,
/// the rows of the Rust table whose reference is the TypeScript; [`codes`]
/// has every row.
pub(super) fn tables(input: &Value) -> Result<JsValue, DoorError> {
    args(input, TABLES)?;
    let tools = parse(TOOLS)
        .map_err(|_| DoorError::bad_input("the table of the MCP server's tools does not read"))?
        .value;
    let mut rows: Vec<(&str, JsValue)> = vec![
        ("ACS_PROFILE", pairs_js(&ACS_PROFILE)),
        ("ACS_TARGET_FORMAT", ACS_TARGET_FORMAT.into()),
        ("ACS_VERSION", ACS_VERSION.into()),
        ("BUDGET_DIMENSIONS", strings_js(&BUDGET_DIMENSIONS)),
        ("BUILTIN_EFFECTS", strings_js(&BUILTIN_EFFECTS)),
        (
            "CODES",
            codes_js(
                mandate_ir::codes::iter().filter(|row| row.reference == Reference::TypeScript),
            ),
        ),
        (
            "DATA_CLASSES",
            strings_js(&DATA_CLASSES.map(|c| c.as_str())),
        ),
        ("DECISION_POLICIES", strings_js(&DECISION_POLICIES)),
        (
            "GOVERNANCE_FILES",
            GOVERNANCE_FILES
                .iter()
                .map(|(kind, globs)| (kind.as_str(), strings_js(globs)))
                .collect::<JsObject>()
                .into(),
        ),
        (
            "GOVERNANCE_KINDS",
            strings_js(&GOVERNANCE_KINDS.map(|k| k.as_str())),
        ),
        ("HTTP_METHODS", strings_js(&HTTP_METHODS)),
        (
            "INTERFACE_PROTOCOLS",
            strings_js(&mandate_syntax::INTERFACE_PROTOCOLS),
        ),
        (
            "ISOLATION_LEVELS",
            strings_js(&ISOLATION_LEVELS.map(|l| l.as_str())),
        ),
        ("LANGUAGE_VERSION", Language::NEWEST.as_str().into()),
        (
            "LANGUAGE_VERSIONS",
            JsValue::Array(Language::ALL.iter().map(|l| l.as_str().into()).collect()),
        ),
        ("LEGACY_VERSIONS", strings_js(&LEGACY_VERSIONS)),
        (
            "LIMITS",
            JsObject::new()
                .with("sourceBytes", limits::SOURCE_BYTES)
                .with("jsonDepth", limits::JSON_DEPTH)
                .with("definitions", limits::DEFINITIONS)
                .with("expandedNodes", limits::EXPANDED_NODES)
                .into(),
        ),
        ("LOCK_FIELDS_0_5", strings_js(&LOCK_FIELDS_0_5)),
        ("LOCK_FORMAT", LOCK_FORMAT.into()),
        ("LOCK_FORMATS", strings_js(&LOCK_FORMATS)),
        ("MA_BETA", MA_BETA.into()),
        ("MA_BINDING_FORMAT", MA_BINDING_FORMAT.into()),
        (
            "MA_BRIDGE_PROFILE",
            MA_BRIDGE_PROFILE
                .iter()
                .map(|(guarantee, level)| (*guarantee, level.as_str()))
                .collect::<JsObject>()
                .into(),
        ),
        ("MA_MAX_CLASS", MA_MAX_CLASS.as_str().into()),
        ("MODERN_VERSIONS", strings_js(&MODERN_VERSIONS)),
        ("PATH_PATTERN", PATH_PATTERN.into()),
        (
            "PROGRESS_DEFAULTS",
            PROGRESS_DEFAULTS
                .iter()
                .map(|(name, n)| (*name, JsValue::from(*n)))
                .collect::<JsObject>()
                .into(),
        ),
        ("RESERVED", strings_js(&mandate_syntax::RESERVED)),
        ("SANDBOX_DENIALS_FORMAT", SANDBOX_DENIALS_FORMAT.into()),
        (
            "SANDBOX_REQUIREMENT_FORMAT",
            SANDBOX_REQUIREMENT_FORMAT.into(),
        ),
        (
            "SANDBOX_REQUIREMENT_FORMAT_0_2",
            SANDBOX_REQUIREMENT_FORMAT_0_2.into(),
        ),
        (
            "STD_EFFECTS",
            STD_EFFECTS
                .iter()
                .map(|(name, e)| (*name, e.to_js()))
                .collect::<JsObject>()
                .into(),
        ),
        (
            "STD_FNS",
            STD_FNS
                .iter()
                .map(|(name, f)| (*name, f.to_js()))
                .collect::<JsObject>()
                .into(),
        ),
        (
            "SYSTEM_KINDS",
            strings_js(&SYSTEM_KINDS.map(DefKind::as_str)),
        ),
        ("TOOLS", JsValue::from(&tools)),
        ("VIEW_FORMAT", VIEW_FORMAT.into()),
    ];
    rows.sort_by(|a, b| compare_utf16(a.0, b.0));
    Ok(rows.into_iter().collect::<JsObject>().into())
}

/// The parameters of [`codes`].
pub(super) const CODES: &[&str] = &[];

/// The whole table of diagnostic codes, `mandate_ir::codes`.
///
/// Input: `{}`.
/// Output: `{ "MDT-E0101": { title, explain }, ... }`, every row in the table's order,
/// as `CODES` (`compiler/src/codes.ts`) is written, the rows added in Rust
/// from language 0.6 on included.
pub(super) fn codes(input: &Value) -> Result<JsValue, DoorError> {
    args(input, CODES)?;
    Ok(codes_js(mandate_ir::codes::iter()))
}

/// The parameters of [`explain`].
pub(super) const EXPLAIN: &[&str] = &["code"];

/// What `mandate explain <code>` (`compiler/src/cli.ts`) and the MCP tool
/// `mandate.explain` (`compiler/src/mcp/server.ts`) answer, as data: the
/// code with `MDT-` put in front when it lacks it, and its row.
///
/// Input: `{ code: string }`, such as `"E0320"` or `"MDT-E0320"`.
/// Output: `{ code, title, explain }`, or `null` when the table has no such
/// code (where the command line says "unknown code" and the MCP tool fails).
pub(super) fn explain(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, EXPLAIN)?;
    let raw = a.str("code")?;
    let code = if raw.starts_with("MDT-") {
        raw.to_owned()
    } else {
        format!("MDT-{raw}")
    };
    Ok(match mandate_ir::codes::lookup(&code) {
        None => JsValue::Null,
        Some(row) => JsObject::new()
            .with("code", code.as_str())
            .with("title", row.title)
            .with("explain", row.explain)
            .into(),
    })
}
