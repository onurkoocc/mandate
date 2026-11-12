# Conformance cases

A case is one small, checkable claim about a Mandate compiler: this input, with
these modules and this lock, gives these diagnostics. The files here are meant to
be read by any implementation. The TypeScript reference compiler reads them in
`compiler/test/cases.test.ts`; the Rust compiler will read the same files.

## Layout

One directory per case: `conformance/<id>/`. It holds `case.json` and the case's
own input files (`program.mdt` or `program.ir.json`, module files,
`mandate.lock.json`). `case.json` is closed by `conformance/case.schema.json`
(JSON Schema 2020-12; no unknown fields anywhere).

## Fields of case.json

- `$schema`: optional, a path to the schema, for editors.
- `format`: the constant `"mandate/conformance-case/0.1"`.
- `id`: `S01`, `V03`, `V03b` (a letter, two digits, an optional lower-case
  letter) or `E0320` (a diagnostic code number). It equals the directory name.
- `kind`: `"compile"` or `"run"`. Only `compile` has a runner now. A `run` case
  fails the test run until a runner exists, so none is mistaken for checked.
- `title`: one sentence.
- `spec`: a non-empty list of references, such as `"spec/ir.md#reading-ir"`.
- `language`: optional, such as `"mandate/0.1"`. When given, the program the
  case checks (after the patch) must declare that language.
- `input`: `{ "file": "<path>", "kind": "mdt" | "json" }` or
  `{ "text": "<source>", "kind": ... }`. Exactly one of `file` and `text`.
- `modules`: optional list of module files, loaded the way `--module` loads them.
- `lock`: optional path to a lock file, or `null`.
- `patch`: optional RFC 6902 patch, only `add`, `replace` and `remove`. It is
  applied to the IR of the input, and the patched IR is checked as JSON IR. No
  base hash is involved. Use it to say "this program, with this change" without
  copying the program. The unpatched input must load without errors.
- `expect`: `{ "ok": boolean, "diagnostics": [ { "code", "path", "facts"? } ],
  "hashes"?: { "program"?, "defs"? } }`.

All paths are relative to the case directory and must stay inside the
repository. A path may go up into the repository to share a fixture, as V03 does.

## How a result is compared

- `ok` must match.
- The compiler's diagnostics and `expect.diagnostics` are compared in order, one
  to one: same count, and for each pair the same `code` and the same `path` (the
  diagnostic's `at.path`).
- `facts`, when a case gives them, are a subset: every key the case names must
  be deeply equal in the diagnostic. Extra keys in the diagnostic are allowed.
- `message` and `span` are never compared. Messages may change, and columns
  depend on how a compiler counts characters.
- `hashes`, when given, must equal the result's hashes exactly.

## Adding a case

1. Make the directory `conformance/<id>/` and put the input files in it.
2. Write `case.json`. Take the expected diagnostics from the spec, not from
   whatever a compiler prints.
3. Run the tests. A directory with no `case.json`, a `case.json` that does not
   match the schema, or an `id` that differs from the directory name fails.

## Running

```
npm test --workspace compiler
```

or only the cases: `cd compiler && npx vitest run test/cases`.
