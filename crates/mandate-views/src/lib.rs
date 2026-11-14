//! The documents of the Rust Mandate compiler: the human projections of a
//! program (Doc 4 §15) as Markdown and as one self-contained HTML page,
//! written from the TypeScript reference compiler, which remains the
//! specification: the same text, byte for byte. It holds:
//!
//! - [`doc`]: the document model ([`Doc`], [`Block`], [`Cell`]) and its two
//!   renderings ([`to_markdown`], [`to_html`], with [`md_escape`],
//!   [`html_escape`] and [`cell_text`]), `compiler/src/views/doc.ts`.
//! - [`diff`]: the document of a semantic diff ([`diff_doc`],
//!   [`diff_blocks`]), `compiler/src/views/views.ts`. The analyses that the
//!   views show are in `mandate-check` (`mandate_check::view_shared` for what
//!   every view stands on, `mandate_check::diff` for the comparison of two
//!   programs).
//! - The views of one program, `compiler/src/views/views.ts`, each with the
//!   `to_js` that builds the object `mandate view --format json` writes and
//!   the blocks of its part of the document: `architecture` (a graph of each
//!   workflow, [`mermaid`]), `authority` ([`late_kinds`]), `cost`
//!   ([`delegate_budget`], [`Sum`]), `system` ([`has_system`]), and
//!   `program_doc`, which puts them in one document. [`shown`] holds the
//!   small texts they are written in ([`show`], [`list`], [`mermaid_text`],
//!   [`type_text`]). The envelope card is not in this crate: it stays in TypeScript
//!   for 0.5.
//!
//! The cost view counts the delegations a workflow with an envelope may
//! start as the checker does, with `mandate_check::static_cost`
//! (`check/cost.ts`).
//!
//! Programs are the IR as [`mandate_ir::Value`], as in `mandate-check`; the
//! views walk them in the order of their members, as JavaScript does.
//!
//! Like the other library crates, it reads no file, environment variable or
//! clock and starts no process, and it builds for `wasm32-wasip1`. The gates
//! of `mandate-testkit` hold its output to the vectors the TypeScript wrote.

#![forbid(unsafe_code)]

pub mod architecture;
pub mod authority;
pub mod cost;
pub mod diff;
pub mod doc;
pub mod program_doc;
pub mod shown;
pub mod system;

pub use architecture::{
    ArchitectureView, WorkflowArchitecture, architecture, architecture_blocks, mermaid,
};
pub use authority::{AuthorityRow, AuthorityView, authority, authority_blocks, late_kinds};
pub use cost::{
    BudgetFrom, CostRow, CostView, DelegateBudget, Sum, WorkflowCost, cost, cost_blocks,
    delegate_budget,
};
pub use diff::{diff_blocks, diff_doc};
pub use doc::{Block, Cell, Doc, cell_text, html_escape, md_escape, to_html, to_markdown};
pub use program_doc::program_doc;
pub use shown::{list, mermaid_text, show, show_command, type_text};
pub use system::{
    SystemAuthorize, SystemComponent, SystemEnvironment, SystemInterface, SystemRead, SystemView,
    has_system, system, system_blocks,
};
