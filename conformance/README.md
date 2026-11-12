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
- `subprogram`: optional; see below. A case with it has no top-level `patch`
  or `lock`.
- `amendment`: optional; see below. A case with it has no top-level `patch`
  or `lock`, and no `subprogram`.
- `expect`: `{ "ok": boolean, "diagnostics": [ { "code", "path", "facts"? } ],
  "hashes"?: { "program"?, "defs"? } }`.

## A sub-program case

A `compile` case with `subprogram` checks a lead's sub-program
(spec/envelope.md "The sub-program"). Its `input` and `modules` are the
parent program, which must check without errors. `expect` is compared with
the check of the sub-program, not of the parent. `language`, when given, is
the parent's.

- `workflow`: the parent's workflow whose envelope bounds the run.
- `number`: optional, 1 when not given. The sub-program's number. The patch
  is written against the skeleton of that number, `<parent module>.plan_<n>`,
  and its program hash is the patch's base.
- `defs`: optional, a module given like `input`. Each of its definitions
  becomes one `add` operation at `/defs/<name>`, in the order the module
  defines them. Only its definitions are read, not its header. It must load;
  if it does not, the case is wrong.
- `patch`: optional, more operations of the lead, after those from `defs`.
  They are given to the check as they are.
- `lead`: optional, `public` when not given. The data class of what the lead
  received: `public`, `internal`, `confidential` or `restricted`.
- `room`: what is left of the envelope.
  - `left`: what is left in each ledger dimension the run is limited in,
    such as `tokens`, `steps`, `agents` and `spend:USD` in micro-units.
  - `time_left_ms`: optional, milliseconds to the run's deadline.
  - `writes`: optional, the write capabilities still in flight, each
    `{ "ctor", "scope" }`. `ctor` is `fs.write`, `git.pr`, `env.deploy` or
    `env.migrate`; `scope` lists its paths, repositories or environments.

The sub-program cases share the parent of N01: `conformance/N01/parent.mdt`
and the module it imports, `conformance/N01/domain.mdt`.

## An amendment case

A `compile` case with `amendment` checks an amendment of an envelope
(spec/envelope.md "Amendments"). Its `input` and `modules` are the program
the run has, which must check without errors. `expect` is compared with the
check of the amendment: the program with the new envelope, checked as any
program is, and then held to the envelope it had (E1709). `language`, when
given, is the program's.

- `workflow`: the workflow whose envelope is amended. It has an envelope; if
  it has none, the case is wrong.
- `patch`: an RFC 6902 patch, only `add`, `replace` and `remove`, applied to
  the IR of that envelope. Its paths start at the envelope, so `/budget/tokens`
  is the envelope's tokens. The patched envelope is the one the lead asks for.

`expect.hashes`, when given, is `{ "program": "<hash>" }`: the hash of the
program with the new envelope. An amendment that is refused has none.

The amendment cases share the program of N01 too.

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
