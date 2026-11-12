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
