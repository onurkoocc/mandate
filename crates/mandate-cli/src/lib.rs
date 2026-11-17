//! The native command line of the compiler: its commands, over the doors.
//!
//! [`run`] is the whole command: the arguments after the program's name in,
//! the exit status out, and everything it reads and writes through an
//! [`Io`]. The library reads no file, environment variable or clock and
//! starts no process (`crates/mandate-testkit/tests/authority.rs` holds it to
//! that); `src/main.rs` gives it the real file system, and the tests an
//! [`MemoryIo`].
//!
//! # The commands
//!
//! The commands the Node command line (`bridge/src/cli.ts`) has are answered
//! as it answers them, by the same functions of the compiler: the same
//! bytes on standard output, the same exit status (0, 1 when an error
//! diagnostic is reported, 2 on a usage error), the same diagnostics.
//!
//! ```text
//! mandate check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]…
//! mandate ir <file> [--canonical]
//! mandate fmt <file>
//! mandate hash <file>
//! mandate patch <program> <patch.json> [--json]
//! mandate sandbox <file> [--agent <name>] [--lock <lock.json>] [--module <file>]…
//! mandate target acs <file> [--out <dir>] [--json] [--lock <lock.json>] [--module <file>]…
//! mandate explain <code> [--json]
//! mandate view <file> [--against <old file>] [--against-lock <old lock.json>] [--format md|html|json] [--lock <lock.json>] [--module <file>]…
//! mandate view <file> --attention [--workflow W] [--format md|html|json] [--lock <lock.json>] [--module <file>]…
//! mandate view <file> --card [--workflow W] [--format md|html|json] [--lock <lock.json>] [--module <file>]…
//! mandate mcp [--module <file>]…
//! ```
//!
//! `mcp` is the compiler as an MCP server on the standard streams, the
//! native one beside `bridge/src/mcp.ts`, which answers the same bytes to
//! the same conversation and serves the tools of language 0.7 (`mcp`).
//!
//! The commands that control a run (`run`, `status`, `approve`, …) are the
//! Node command line's alone: this executable says so and exits with 2.
//!
//! # Libraries (language 0.6)
//!
//! ```text
//! mandate add     <library>[@<range>] [--lock FILE] [--program FILE] [--libraries DIR] [--config FILE] [--json]
//! mandate upgrade <library>[@<range>] [--lock FILE] [--program FILE] [--libraries DIR] [--config FILE] [--accept-governance] [--json]
//! mandate publish <source dir> [--libraries DIR] [--config FILE] [--json]
//! ```
//!
//! The directory of libraries (`<dir>/<name>/<version>/`, spec/library.md
//! "The local directory") is the one `--libraries` names, or else
//! `libraries.dir` of the runtime's configuration (`--config`, or
//! `mandate.runtime.json` in the working directory when there is one),
//! relative to that file. The configuration gives the waiting period and the
//! revoked digests too. `check`, `sandbox`, `target acs` and `view` take
//! `--libraries` and `--config` as well: when the lock pins libraries, each
//! is read from the directory at the version the lock pins and handed to the
//! check, and its modules to the views.
//!
//! `upgrade` writes the lock only when the comparison with the pinned
//! version holds no governance change, or with `--accept-governance`;
//! `publish` writes nothing when the compiler refuses the version (E1607).

#![forbid(unsafe_code)]

mod args;
mod commands;
mod libraries;
mod mcp;
mod memory;

pub use memory::MemoryIo;

/// Why a file or a directory could not be read or written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IoErrorKind {
    /// There is no such file or directory.
    NotFound,
    /// Anything else.
    Other,
}

/// A failure of the outside: its kind, and a message for a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IoError {
    /// What kind of failure.
    pub kind: IoErrorKind,
    /// What the outside said.
    pub message: String,
}

impl IoError {
    /// A failure of `kind` with `message`.
    #[must_use]
    pub fn new(kind: IoErrorKind, message: impl Into<String>) -> IoError {
        IoError {
            kind,
            message: message.into(),
        }
    }

    /// There is no such file or directory.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> IoError {
        IoError::new(IoErrorKind::NotFound, message)
    }
}

/// One entry of a directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    /// Its name in the directory.
    pub name: String,
    /// Whether it is a directory.
    pub is_dir: bool,
}

/// Everything the commands need from outside. A path is text, as the
/// command line gave it or as [`Io::join`] made it; what a path means is the
/// implementation's.
pub trait Io {
    /// The bytes of the file at `path`.
    ///
    /// # Errors
    ///
    /// When it cannot be read; [`IoErrorKind::NotFound`] when it is not there.
    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, IoError>;

    /// Writes `bytes` as the file at `path`, in the place of what was there.
    ///
    /// # Errors
    ///
    /// When it cannot be written.
    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), IoError>;

    /// Makes the directory `path` and those above it that are missing.
    ///
    /// # Errors
    ///
    /// When it cannot be made.
    fn create_dir_all(&mut self, path: &str) -> Result<(), IoError>;

    /// The entries of the directory `path`, in any order.
    ///
    /// # Errors
    ///
    /// When it cannot be listed; [`IoErrorKind::NotFound`] when it is not
    /// there.
    fn list_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, IoError>;

    /// Standard input, read to its end: what the file name `-` stands for.
    ///
    /// # Errors
    ///
    /// When it cannot be read.
    fn read_input(&mut self) -> Result<Vec<u8>, IoError>;

    /// Reads the next bytes of standard input into `buf`, waiting for some
    /// when none has come yet: how many, 0 at the end of the input. What
    /// `mandate mcp` reads its lines with, so that it never holds more of
    /// the input than the line it is reading.
    ///
    /// # Errors
    ///
    /// When it cannot be read.
    fn read_input_part(&mut self, buf: &mut [u8]) -> Result<usize, IoError>;

    /// Writes `text` to standard output.
    fn write_out(&mut self, text: &str);

    /// Writes `text` to standard output, and says whether it was: what
    /// `mandate mcp` writes an answer with, so that it stops when no one
    /// reads its answers any more.
    ///
    /// # Errors
    ///
    /// When it cannot be written (the reader went away).
    fn write_out_part(&mut self, text: &str) -> Result<(), IoError>;

    /// Writes `text` to standard error.
    fn write_err(&mut self, text: &str);

    /// The time, in seconds since 1970-01-01T00:00:00Z: what the doors that
    /// resolve or publish a library are given as now.
    fn now_unix_seconds(&mut self) -> i64;

    /// The directory `path` is in, as text; empty or `.` for a bare name.
    fn parent(&self, path: &str) -> String;

    /// The path of `name` in the directory `dir`; `name` itself when it is
    /// an absolute path.
    fn join(&self, dir: &str, name: &str) -> String;
}

/// Runs the command `args` (the arguments after the program's name) and
/// gives its exit status: 0, 1 when an error diagnostic was reported or a
/// library command wrote nothing, 2 on a usage error or a file that cannot
/// be read or written.
pub fn run(args: &[String], io: &mut dyn Io) -> i32 {
    commands::Cli::new(io).run(args)
}
