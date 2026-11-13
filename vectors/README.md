# Vectors

What the TypeScript compiler's strict reader, canonical text and hashes
give, for another implementation to match byte for byte. They are written
by `compiler/test/vectors.test.ts`, which fails when a committed file
differs from what the compiler gives now, and read by the Rust tests in
`crates/mandate-ir/tests/vectors.rs`. To write them again:
`MANDATE_UPDATE_VECTORS=1 npm test`.

They are not conformance cases (`conformance/`): a case states a rule and
is checked against the spec; a vector records what the reference
implementation does, down to the message text and the column.

Every file is ASCII strict JSON within the reader's limits, so any
implementation's reader can read it: characters from U+007F up are written
as `\u` escapes. An input that needs a carriage return, a control
character or a byte order mark carries it in a JSON string, never as a raw
byte in the file.

## reader.json

`{ "format": "mandate/vectors/reader/0.1", "vectors": [ … ] }`. Each vector
has a `name` and exactly one input:

- `input`: the text;
- `input_parts`: `[[text, count], …]`, each text repeated `count` times and
  joined, for inputs too large to write out;
- `input_bytes`: `[[hex, count], …]`, bytes in the same way. They are
  decoded as `readFileSync(file, "utf8")` decodes a file: a byte order mark
  is kept, and each ill-formed UTF-8 sequence becomes U+FFFD.

Then `"ok": true` with the value's `canonical` text (or, when it is longer
than 4096 characters, `canonical_sha256`, the hex SHA-256 of its UTF-8) and
`spans`, each value's `[startLine, startCol, endLine, endCol]` by JSON
Pointer; or `"ok": false` with `diagnostics`, as the compiler writes them
(`code`, `severity`, `message`, `at`, `docs`, `facts`). Columns count UTF-16
code units. Compare spans and diagnostics as values, not by member order.

The TypeScript reader quotes the character it found as one UTF-16 code
unit. Where that is half of a surrogate pair (an unexpected character
outside the Basic Multilingual Plane), its message holds a lone surrogate,
which no vector can carry; there is no such vector. The Rust reader writes
U+FFFD there.

## jcs.json

`{ "format": "mandate/vectors/jcs/0.1", "vectors": [ { "name", "input",
"canonical" } ] }`. `input` is read by the strict reader; `canonical` is its
canonical text.

## hash.json

`{ "format": "mandate/vectors/hash/0.1", "domain", "program", "package" }`:

- `domain`: `{ domain, version, input, hash }`, the domain hash of the value
  `input` reads to;
- `program`: `{ name, input, program, defs }`, the program's hashes, `defs`
  as `[[name, hash], …]` in the order they are computed (UTF-16 order of the
  names);
- `package`: `{ name, program_hash, lock, hash }`, `lock` being the lock as a
  package carries it, as text.

## programs/

One file per program the golden file (`compiler/test/golden/outputs.json`)
pins, named after its path with `/` as `.`:
`{ format: "mandate/vectors/program/0.1", source, kind, language,
canonical, hashes: { program, defs }, lock?, package?, ir }`. `ir` is the
program's IR in the compiler's member order; `canonical` is its canonical
text. Where the program has a lock, `lock` is that lock as a package
carries it (without its `lock` field) and `package` the package hash. A
program's lock is `<name>.lock.json` beside it when that exists
(`reach.mdt` has `reach.lock.json`), else `mandate.lock.json` beside it.
