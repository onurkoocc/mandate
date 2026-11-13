# mandate-ir

Reads, canonicalises and hashes Mandate IR exactly as the TypeScript
compiler does. It ports three modules, which remain the specification:

- `parse`, `parse_bytes`: the strict JSON reader, `compiler/src/json/strict-json.ts`
  (E0102, E0105, E0106, E0107, E0108, with the same messages, JSON Pointers
  and UTF-16 columns);
- `canonicalize`: RFC 8785 canonical text, `compiler/src/json/jcs.ts`;
- `domain_hash`, `hash_program`, `package_hash`: `compiler/src/hash.ts`.

Its one dependency is `sha2`. `cargo test` checks it against the vectors in
[`../../vectors`](../../vectors/README.md), which the TypeScript compiler
writes. It also runs the conformance cases in
[`../../conformance`](../../conformance/README.md) that need only the reader and the
hashes (`tests/conformance.rs`); the others need a compiler, and the test prints
how many it ran and how many it skipped.

## Running the tests without a native executable

On a machine that does not start freshly built native programs (Smart App
Control on Windows is one), the tests can run as WebAssembly under Node's
built-in WASI. From the repository root:

```
node scripts/wasi-test.mjs -p mandate-ir
```

This builds the tests for `wasm32-wasip1` and runs each test executable in
Node, then prints libtest's `test result:` lines; the exit code is not 0 if
anything failed. Arguments after `--` go to libtest, for example
`-- --nocapture` or a test name. It needs cargo on the path, the
`wasm32-wasip1` target (`rustup toolchain install` installs it, because
`rust-toolchain.toml` lists it) and Node 22 or later. The tests find the
repository through the environment variable `MANDATE_REPO`, which the script
sets; without it they use the path from the crate's directory, as before.

The limits, which `scripts/wasi-test.mjs` also lists: a panic aborts the
program, so the first failing test ends its executable and no `FAILED` line is
printed; `#[should_panic]` tests cannot pass; tests run one at a time; a test
that starts a process cannot run; doc tests are not run. On a 32-bit target
`usize::MAX` is smaller than `Int::MAX`, so one assertion in
`tests/api.rs` is compiled only for 64-bit targets. This is a way to
develop, not a replacement for `cargo test` and `cargo clippy`, which CI runs
natively.
