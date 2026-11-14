//! The Mandate compiler as a `wasm32-wasip1` command module, which the Node
//! runtime calls: a fresh instance for each call, given the request on
//! standard input, giving the answer on standard output.
//!
//! It reads standard input to its end (at most one byte past
//! `mandate_doors::MAX_REQUEST_BYTES`, so that a longer request is answered
//! `too_large` without being read whole), gives the bytes to
//! `mandate_doors::answer_bytes`, writes the answer, and returns. It reads no
//! argument, environment variable, clock or file, and writes nothing to
//! standard error: everything it says is the answer. What a request and an
//! answer are is `mandate_doors`'s to say.

use std::io::{Read, Write};
use std::process::ExitCode;

use mandate_doors::{ErrorKind, MAX_REQUEST_BYTES, Refusal, answer_bytes, written};

/// Answers the request on standard input; fails only when the answer
/// cannot be written.
fn main() -> ExitCode {
    let most = u64::try_from(MAX_REQUEST_BYTES)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut request = Vec::new();
    let answer = match std::io::stdin().lock().take(most).read_to_end(&mut request) {
        Ok(_) => answer_bytes(&request),
        Err(_) => written(Err(Refusal::new(
            ErrorKind::BadRequest,
            "the request could not be read",
        ))),
    };
    let mut out = std::io::stdout().lock();
    match out.write_all(answer.as_bytes()).and_then(|()| out.flush()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => ExitCode::FAILURE,
    }
}
