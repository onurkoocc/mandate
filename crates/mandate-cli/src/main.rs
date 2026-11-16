//! The `mandate` command: the native command line of the compiler.
//!
//! It gives `mandate_cli::run` the real file system, the standard streams
//! and the clock, and runs it on a thread with a stack of 64 MiB: the
//! checker walks a program by recursion, and the deepest program that loads
//! must check whatever stack the system gives the main thread. The exit
//! status is the command's.

use std::io::{Read, Write};
use std::path::Path;
use std::process::ExitCode;
use std::time::{SystemTime, UNIX_EPOCH};

use mandate_cli::{DirEntry, Io, IoError, IoErrorKind};

/// The stack of the thread the command runs on: 64 MiB.
const STACK_BYTES: usize = 64 * 1024 * 1024;

/// The outside as it is.
struct Real;

/// An error of the system as the library takes it.
fn failure(e: &std::io::Error) -> IoError {
    let kind = if e.kind() == std::io::ErrorKind::NotFound {
        IoErrorKind::NotFound
    } else {
        IoErrorKind::Other
    };
    IoError::new(kind, e.to_string())
}

impl Io for Real {
    fn read_file(&mut self, path: &str) -> Result<Vec<u8>, IoError> {
        std::fs::read(path).map_err(|e| failure(&e))
    }

    fn write_file(&mut self, path: &str, bytes: &[u8]) -> Result<(), IoError> {
        std::fs::write(path, bytes).map_err(|e| failure(&e))
    }

    fn create_dir_all(&mut self, path: &str) -> Result<(), IoError> {
        std::fs::create_dir_all(path).map_err(|e| failure(&e))
    }

    fn list_dir(&mut self, path: &str) -> Result<Vec<DirEntry>, IoError> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(path).map_err(|e| failure(&e))? {
            let entry = entry.map_err(|e| failure(&e))?;
            out.push(DirEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_dir: entry.path().is_dir(),
            });
        }
        Ok(out)
    }

    fn read_input(&mut self) -> Result<Vec<u8>, IoError> {
        let mut bytes = Vec::new();
        std::io::stdin()
            .lock()
            .read_to_end(&mut bytes)
            .map_err(|e| failure(&e))?;
        Ok(bytes)
    }

    fn write_out(&mut self, text: &str) {
        // A reader that went away is not the command's failure.
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes()).and_then(|()| out.flush());
    }

    fn write_err(&mut self, text: &str) {
        let mut err = std::io::stderr().lock();
        let _ = err.write_all(text.as_bytes()).and_then(|()| err.flush());
    }

    fn now_unix_seconds(&mut self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|d| i64::try_from(d.as_secs()).ok())
            .unwrap_or(-1)
    }

    fn parent(&self, path: &str) -> String {
        Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    fn join(&self, dir: &str, name: &str) -> String {
        Path::new(dir).join(name).to_string_lossy().into_owned()
    }
}

/// The exit status as the system takes it.
fn status(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}

/// Runs the command on its own thread, and exits with its status; 2 when
/// the thread cannot be started, 101 when it panicked.
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    let thread = std::thread::Builder::new()
        .name("mandate".to_owned())
        .stack_size(STACK_BYTES)
        .spawn(move || mandate_cli::run(&args, &mut Real));
    match thread {
        Ok(handle) => handle.join().map_or(ExitCode::from(101), status),
        Err(e) => {
            Real.write_err(&format!(
                "mandate: cannot start the command's thread: {e}\n"
            ));
            ExitCode::from(2)
        }
    }
}
