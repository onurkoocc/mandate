//! The JSON doors of `mandate-views`: the views, the documents and the ACS
//! target as functions from a JSON value to a JSON value, for a host (the
//! Node runtime, through the WebAssembly module of `mandate-wasm`) to call.
//!
//! This is the second table of doors. It keeps the contract of the first,
//! `mandate_check::json_doors` (which states it), and is built the same way:
//! each door is a [`DoorFn`](mandate_check::json_doors::DoorFn) that reads
//! its input with `mandate_check::json_doors::input`, the table is
//! [`DOORS`] and [`door`] finds one by name. The dispatcher of `mandate-doors` merges it with the
//! checker's; no name is in both. The table is committed as data in
//! `crates/mandate-views/tests/json_doors/doors.json`, beside the calls
//! (`inputs.json`) and what the TypeScript gives for each
//! (`expected.json`, which `scripts/json-doors-vectors.mjs` writes).
//!
//! The doors are those of the functions of `compiler/src/index.ts` whose
//! Rust is in this crate and that the runtime, the command line or the MCP
//! server call: the views of a program (`architecture`, `authority`, `cost`),
//! the blocks the runtime puts in its own documents (`architecture_blocks`,
//! `authority_blocks`), the documents (`program_doc`, `diff_doc`, `card_doc`)
//! and their two renderings (`to_markdown`, `to_html`), the envelope card
//! (`card`, `envelope_workflows`) and the ACS target (`acs_target`).
//! `programRef` and `rolesNamed` are doors of the first table, since their
//! Rust is in `mandate-check`; `system` and `hasSystem` are not doors: no
//! caller calls them (the document of a program shows the system itself).
//!
//! # What is read back
//!
//! Four doors take what another door gave: `to_markdown` and `to_html` a
//! document (`Doc`), `architecture_blocks` an architecture view and
//! `authority_blocks` an authority view. Each is read back into its typed
//! form, which holds everything those doors give; what the typed form cannot
//! hold is `bad_input`, where the TypeScript is laxer:
//!
//! - A document is `{ title, meta, blocks }`: `meta` an array of
//!   `[key, value]` arrays of two strings (more items are ignored, as the
//!   TypeScript's destructuring ignores them), `blocks` an array of blocks.
//!   A block is an object, read as the TypeScript reads it: the first of
//!   `h`, `p`, `note`, `list` and `table` that it has decides what it is,
//!   and one with none of them is code; other members are ignored. A cell is
//!   a string or `{ text, untrusted?, mono? }`. The door refuses what the
//!   TypeScript takes by its iteration and truthiness: a string where an
//!   array is (`meta: ""` is no meta there, a meta entry `"kv"` is the key
//!   `k` and the value `v`), `untrusted` or `mono` that is not a boolean, a
//!   `lang` that is not a string (the TypeScript writes any value in the
//!   fence). `null` for `lang`, `untrusted` or `mono` is the same as left
//!   out, as it is there.
//! - A view is read for what the blocks are made of: an architecture view's
//!   `workflows` (`workflow`, `budget`, `mermaid`, `nodes` with `id`, `kind`,
//!   `label` and `detail`, `edges` with `from`, `to` and `label?`), an
//!   authority view's `rows` (`who`, `kind`, `effects` and the lists of the
//!   authority). Its other members (`format`, `kind`, `program`) are not
//!   read, as the TypeScript does not read them. Every text is a string and
//!   every list an array of strings; a step's `kind` is one of the kinds a
//!   graph has and a row's `kind` one of `agent`, `workflow` and
//!   `delegation`. The TypeScript writes whatever value is there into the
//!   blocks.
//!
//! Each door's doc comment names the TypeScript function and file it stands
//! for, its input members and its output.

use mandate_check::json_doors::Door;

mod documents;
mod programs;

/// The door named `name`.
#[must_use]
pub fn door(name: &str) -> Option<&'static Door> {
    DOORS.iter().find(|d| d.name == name)
}

/// Every door, in the order of `doors.json`: the views of a program and
/// their blocks, the documents, the card, the ACS target, then the two
/// renderings of a document.
pub static DOORS: &[Door] = &[
    Door::new(
        "architecture",
        "architecture",
        programs::ARCHITECTURE,
        programs::architecture,
    ),
    Door::new(
        "architecture_blocks",
        "architectureBlocks",
        documents::ARCHITECTURE_BLOCKS,
        documents::architecture_blocks,
    ),
    Door::new(
        "authority",
        "authority",
        programs::AUTHORITY,
        programs::authority,
    ),
    Door::new(
        "authority_blocks",
        "authorityBlocks",
        documents::AUTHORITY_BLOCKS,
        documents::authority_blocks,
    ),
    Door::new("cost", "cost", programs::COST, programs::cost),
    Door::new(
        "program_doc",
        "programDoc",
        programs::PROGRAM_DOC,
        programs::program_doc,
    ),
    Door::new(
        "diff_doc",
        "diffDoc",
        programs::DIFF_DOC,
        programs::diff_doc,
    ),
    Door::new(
        "envelope_workflows",
        "envelopeWorkflows",
        programs::ENVELOPE_WORKFLOWS,
        programs::envelope_workflows,
    ),
    Door::new("card", "card", programs::CARD, programs::card),
    Door::new(
        "card_doc",
        "cardDoc",
        programs::CARD_DOC,
        programs::card_doc,
    ),
    Door::new(
        "acs_target",
        "acsTarget",
        programs::ACS_TARGET,
        programs::acs_target,
    ),
    Door::new(
        "to_markdown",
        "toMarkdown",
        documents::TO_MARKDOWN,
        documents::to_markdown,
    ),
    Door::new("to_html", "toHtml", documents::TO_HTML, documents::to_html),
];
