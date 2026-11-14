//! The documents of the Rust Mandate compiler: the human projections of a
//! program (Doc 4 §15) as Markdown and as one self-contained HTML page,
//! ported from the TypeScript reference compiler, which remains the
//! specification: the same text, byte for byte.
//!
//! So far it holds:
//!
//! - [`doc`]: the document model ([`Doc`], [`Block`], [`Cell`]) and its two
//!   renderings ([`to_markdown`], [`to_html`], with [`md_escape`],
//!   [`html_escape`] and [`cell_text`]), `compiler/src/views/doc.ts`.
//! - [`diff`]: the document of a semantic diff ([`diff_doc`],
//!   [`diff_blocks`]), `compiler/src/views/views.ts`. The analyses that the
//!   views show are in `mandate-check` (`mandate_check::view_shared` for what
//!   every view stands on, `mandate_check::diff` for the comparison of two
//!   programs); the program views (architecture, authority, cost, system and
//!   the envelope card) come in a later slice, built on those.
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
    BudgetFrom, CostRow, CostView, DelegateBudget, Sum, ViewError, WorkflowCost, cost, cost_blocks,
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
