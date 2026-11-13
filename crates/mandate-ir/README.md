# mandate-ir

Reads, canonicalises and hashes Mandate IR exactly as the TypeScript
compiler does, and holds what the ported phases of that compiler share. It
ports these modules, which remain the specification:

- `parse`, `parse_bytes`: the strict JSON reader, `compiler/src/json/strict-json.ts`
  (E0102, E0105, E0106, E0107, E0108, with the same messages, JSON Pointers
  and UTF-16 columns), and `limits`: `compiler/src/limits.ts`;
- `canonicalize`: RFC 8785 canonical text, `compiler/src/json/jcs.ts`;
- `domain_hash`, `hash_program`, `package_hash`: `compiler/src/hash.ts`;
- `Diagnostic`, `Location`, `Repair`, `ptr`, `has_errors`, `format_diagnostic`:
  `compiler/src/diag.ts`. `Diagnostic::to_js` is the object `diag()` builds,
  with the member order of `at` that each call site writes (`Location`'s
  constructors name them).

And the ECMAScript behaviour the compiler's output depends on, so that no
ported phase reinvents it:

- `Map` and `JsObject` keep their members in the order of an ECMAScript
  object: array-index names (`"0"` to `"4294967294"`) first, ascending, then
  the others in the order assigned or read;
- `JsValue` is the output value (doubles, `undefined`), and `stringify` and
  `stringify_pretty` are `JSON.stringify(v)` and `JSON.stringify(v, null, 2)`;
  `JsValue::to_js_string` is `String(v)`;
- `number_to_string` is `Number::toString`; `is_integer`, `is_safe_integer`;
- `utf16_len`, `compare_utf16`, `sort_utf16`, `is_js_whitespace`, `trim`,
  `trim_start`, `trim_end`, `unique_in_order` (`[...new Set(xs)]`).

`tests/js.rs` checks these against `tests/data/js-semantics.json`, which
`node scripts/js-semantics.mjs` writes from what Node gives.

The crate reads no file, environment variable or clock and starts no process;
`crates/mandate-testkit/tests/authority.rs` holds it to that. Its one
dependency is `sha2`. `cargo test` checks it against the vectors in
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
