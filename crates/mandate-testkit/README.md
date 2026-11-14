# mandate-testkit

What the tests of the Rust Mandate crates share, so that none of them writes
it again. It is a dev-dependency only (`publish = false`) and depends only on
`mandate-ir` (and `sha2`). Unlike the library crates it reads files and the
environment.

- `repo()`, `path(rel)`: the repository root, from `MANDATE_REPO` (which
  `scripts/wasi-test.mjs` sets to `/repo`) or else from this crate's
  directory; `read_bytes`, `read_text`, `read_json` (with `mandate-ir`'s
  strict reader), `parse_json`, `subdirectories`, `files`.
- `sha256(text)`: `sha256:<hex>`, as the golden file writes a digest.
- `Golden`: `compiler/test/golden/outputs.json`, by program and output name
  (`programs`, `output_names`, `outputs`, `digest`).
- `compare_text` (the first differing line of each text) and `compare_digest`
  (both digests and the start of the actual text).
- `run_gate(title, pending, items, check)`: the pending-list rule. Every item
  not matched by a pattern of `pending` must pass; an item on the list that
  passes is an error, and so is a pattern that matches no item, a name given
  twice, and a gate of no items. Every item is evaluated, none may panic,
  and the gate prints `<title>: ran N, passed M, pending K`.

- `corpus`: the compiled corpus, `vectors/corpus/`. `Corpus::load` reads it
  and checks it against its summary, `Corpus::input` builds the arguments of
  an entry for its door, the `render_*` functions write what a Rust door
  returned as the corpus stores it (a program, a span table and a module as
  digests), and `compare` compares it with the stored result and says where
  they first differ. `tests/corpus.rs` is its gate, one per door.

Every function returns its failure as text instead of panicking: under WASI
a panic aborts the whole test executable. Its types are for integration
tests: a unit test inside a crate's `src` that used them would see two copies
of `mandate-ir`.

Its tests are two gates of the whole workspace:

- `tests/golden.rs`, the golden gate: each output the golden file pins, named
  `<output> @ <program>`, against what the Rust crates give, with the list of
  those they do not give yet. It is here because the outputs come from every
  compiler crate; each joins this crate's dev-dependencies when it is written,
  and the gate grows by shortening its `PENDING` list.
- `tests/authority.rs`: the library crates' sources name no `std::fs`,
  `std::env`, `std::process`, `std::net`, `SystemTime` or `Instant`. A new
  library crate adds itself to its `LIBRARIES`.

```
node scripts/wasi-test.mjs -p mandate-testkit -- --nocapture
```
