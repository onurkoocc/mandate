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
//!   [`type_text`]).
//! - [`card`]: the envelope card of a workflow, the one-page summary of its
//!   envelope for the person who approves it ([`card()`], [`card_doc`],
//!   [`envelope_workflows`], [`CardView`]); it stayed in TypeScript for 0.5
//!   and is ported in 0.6.
//! - [`acs`]: the ACS target, `compiler/src/target/acs.ts`: each local agent
//!   written as an Agent Control Specification manifest and a Rego policy
//!   ([`acs_target`], [`AcsTarget`], [`AcsAgent`]), with the profile of what an
//!   ACS host alone guarantees ([`ACS_PROFILE`], [`ACS_PROFILE_NOTES`]); it
//!   stayed in TypeScript for 0.5 and is ported in 0.6. The Rego is the
//!   TypeScript's byte for byte; CI evaluates the TypeScript's on a real OPA.
//! - [`json_doors`]: the JSON doors of this crate, the second table of doors
//!   after `mandate_check::json_doors` (whose contract they keep): the views,
//!   the documents, their Markdown and HTML, the card and the ACS target as
//!   functions from a JSON value to a JSON value, with the readers that take a
//!   document or a view back from its JSON. The dispatcher of `mandate-doors`
//!   merges the two tables.
//!
//! The cost view counts the delegations a workflow with an envelope may
//! start as the checker does, with `mandate_check::static_cost`
//! (`check/cost.ts`).
//!
//! 0.6, which only the Rust reads: a workflow that applies a pattern is shown
//! as its expansion. The views that the TypeScript gives the program alone
//! have a form that takes the modules too ([`architecture_with`],
//! [`authority_with`], [`cost_with`], [`diff_doc_with`]), since the pattern is
//! most often in one of them; without it, a stand-in shows what the
//! application's arguments name and says that the cost is unknown.
//!
//! Programs are the IR as [`mandate_ir::Value`], as in `mandate-check`; the
//! views walk them in the order of their members, as JavaScript does.
//!
//! Like the other library crates, it reads no file, environment variable or
//! clock and starts no process, and it builds for `wasm32-wasip1`. The gates
//! of `mandate-testkit` hold its output to the vectors the TypeScript wrote.

#![forbid(unsafe_code)]

pub mod acs;
pub mod architecture;
pub mod authority;
pub mod card;
pub mod cost;
pub mod diff;
pub mod doc;
pub mod json_doors;
pub mod program_doc;
pub mod shown;
pub mod system;

pub use acs::{
    ACS_PROFILE, ACS_PROFILE_NOTES, ACS_TARGET_FORMAT, ACS_VERSION, AcsAgent, AcsProfileRow,
    AcsTarget, acs_target,
};
pub use architecture::{
    ArchitectureView, WorkflowArchitecture, architecture, architecture_blocks, architecture_with,
    mermaid,
};
pub use authority::{
    AuthorityRow, AuthorityView, authority, authority_blocks, authority_with, late_kinds,
};
pub use card::{
    CardApproval, CardApproves, CardBudgetRow, CardBudgetText, CardHanded, CardMap, CardMember,
    CardPlan, CardPlanNumbers, CardTouches, CardView, CardWait, card, card_blocks, card_doc,
    envelope_workflows,
};
pub use cost::{
    BudgetFrom, CostRow, CostView, DelegateBudget, Sum, WorkflowCost, cost, cost_blocks, cost_with,
    delegate_budget,
};
pub use diff::{diff_blocks, diff_doc, diff_doc_with};
pub use doc::{Block, Cell, Doc, cell_text, html_escape, md_escape, to_html, to_markdown};
pub use program_doc::program_doc;
pub use shown::{list, mermaid_text, show, show_command, type_text};
pub use system::{
    SystemAuthorize, SystemComponent, SystemEnvironment, SystemInterface, SystemRead, SystemView,
    has_system, system, system_blocks,
};
