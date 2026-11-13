//! Verifies an exported Mandate run journal from its bytes and public keys
//! alone, as `spec/journal.md` specifies, independently of the TypeScript
//! runtime: a second implementation of `mandate journal verify`, written
//! from the specification.
//!
//! - [`read_export`]: the export's reading rules and limits (64 MiB, 256
//!   arrays and objects deep) and its shape;
//! - [`canonical`] and [`digest`]: the canonical form of a runtime value,
//!   numbers as ECMAScript writes them;
//! - [`public_keys_in`] and [`PublicKey`]: Ed25519 SubjectPublicKeyInfo PEM
//!   and key ids;
//! - [`verify_export`]: the steps of "Verification", giving a [`Report`].
//!
//! The package's hashes are recomputed with [`mandate_ir`], over the IR's
//! canonical form, as the spec says.
//!
//! ```
//! use verify_journal::{Status, verify_export};
//!
//! let report = verify_export(br#"{"format": "mandate/journal-export/0.1"}"#, &[]);
//! assert_eq!(report.status, Status::Unreadable);
//! assert_eq!(report.findings[0].code.as_str(), "malformed_export");
//! assert_eq!(report.status.exit_code(), 2);
//! ```

#![forbid(unsafe_code)]

pub mod canonical;
pub mod export;
pub mod json;
pub mod keys;
pub mod read;
pub mod report;
pub mod verify;

pub use canonical::{canonical, digest, number_to_string};
pub use export::{Export, read_export};
pub use json::Json;
pub use keys::{KeyError, PublicKey, public_keys_in};
pub use read::{EXPORT_BYTES, EXPORT_DEPTH, ReadError, read_json};
pub use report::{Code, Finding, REPORT_FORMAT, Report, Status};
pub use verify::{event_hash, verify, verify_export};
