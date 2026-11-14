# Conformance cases

A case is one small, checkable claim about a Mandate compiler: this input, with
these modules and this lock, gives these diagnostics. The files here are meant to
be read by any implementation. The TypeScript reference compiler reads them in
`compiler/test/cases.test.ts`, and the Rust compiler reads the same files (see
"What the Rust crates run" below).

A journal case (J01–J16) is a claim about a journal verifier instead: this export
of a run's journal, under these public keys, gives this report (spec/journal.md).

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
- `kind`: `"compile"`, `"run"` or `"journal"`. `compile` and `journal` have
  runners. A `run` case fails the test run until a runner exists, so none is
  mistaken for checked.
- `title`: one sentence.
- `spec`: a non-empty list of references, such as `"spec/ir.md#reading-ir"`.
- `language`: optional, such as `"mandate/0.1"`. When given, the program the
  case checks (after the patch) must declare that language.
- `input`: required except in a journal case. `{ "file": "<path>", "kind": "mdt" | "json" }` or
  `{ "text": "<source>", "kind": ... }`. Exactly one of `file` and `text`.
- `modules`: optional list of module files, loaded the way `--module` loads them.
- `lock`: optional path to a lock file, or `null`.
- `patch`: optional RFC 6902 patch, only `add`, `replace` and `remove`. It is
  applied to the IR of the input, and the patched IR is checked as JSON IR. No
  base hash is involved, unless the case gives `base`. Use it to say "this
  program, with this change" without copying the program. The unpatched input
  must load without errors.
- `base`: optional, only with `patch`: `sha256:` and 64 lower-case hex digits.
  The program hash the patch was written against; see below.
- `subprogram`: optional; see below. A case with it has no top-level `patch`
  or `lock`.
- `amendment`: optional; see below. A case with it has no top-level `patch`
  or `lock`, and no `subprogram`.
- `expect`: required except in a journal case. `{ "ok": boolean, "diagnostics":
  [ { "code", "path", "facts"? } ], "hashes"?: { "program"?, "defs"? } }`.
- `journal`: only in a journal case, and required there; see below. A journal
  case has no `input`, `expect`, `language`, `modules`, `lock`, `patch`,
  `subprogram` or `amendment`.

## A patch against a base

A patch is written against one version of a program, named by its program hash
(spec/ir.md "Patches"; the compiler's `mandate.apply_patch`). A `compile` case
with `base` says which version the patch of the case was written against, and
the patch is applied the way `apply_patch` applies it:

- If `base` is not the program hash of the input's IR (before the patch), the
  patch is stale: the result is exactly one diagnostic, `MDT-E0130` at path `""`,
  with the facts `base` (the case's) and `current` (the input's hash). Nothing
  else is checked.
- If an operation cannot be applied (a missing member, an index out of range),
  the result is one `MDT-E0131` at that operation's path, with the fact `index`,
  the operation's place in the patch.
- Otherwise the patched IR is checked as JSON IR, as in a case without `base`,
  and `expect.hashes`, when given, are the hashes of the patched program.

`base` needs `patch`, and so excludes `subprogram` and `amendment`, which have
a base of their own.

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

## A journal case

A case of `kind: "journal"` checks a verifier of a run's chained journal
(spec/journal.md "Verification"). Its `journal` field names three kinds of file:

- `export`: a `mandate/journal-export/0.1` document, exactly as
  `mandate journal export` wrote it.
- `keys`: one or more PEM files, each holding one or more ed25519 public keys
  (SPKI, `-----BEGIN PUBLIC KEY-----`). They are the keys the verifier is given;
  the export's own `keys` field is not one of them.
- `report`: the `mandate/journal-verification/0.1` report the verifier must give.

The verifier reads the export's bytes and the keys, and nothing else. Its report
is compared with `report` as JSON values, exactly: every member, the findings
in their order. The TypeScript verifier runs the cases in
`runtime/test/journal-cases.test.ts`, and the Rust verifier, written from
the spec alone, in `crates/verify-journal/tests/conformance.rs`; the
compiler's case test only checks that the files are there. A case gives no
exit status: it is the one the report's status means (0 `verified`, 1
`broken` or `unchained`, 2 `unreadable`), and the Rust runner checks it too.

The cases come from real runs on PGlite, written by
`runtime/scripts/journal-cases.mjs` (`npm run build`, then
`node runtime/scripts/journal-cases.mjs`). Each run has a fresh evidence key, so
writing them again changes every file; the files committed are the cases. Only
public keys are committed.

| Case | What the export shows | Status |
|---|---|---|
| J01 | A closed run, also over data with fractions, exponents, escapes and keys that sort differently by UTF-16 code units and by code points | verified |
| J02 | An event's data edited in the database | broken: `chain_broken` |
| J03 | An event deleted | broken: `seq_gap`, `chain_broken` |
| J04 | The tail cut while its anchors stay | broken: `anchor_beyond_end`, `unanchored_tail` |
| J05 | An open run with events after its last anchor | verified, `unanchored_tail` |
| J06 | An anchor signed by another key, one whose signature does not verify | broken: `anchor_unknown_key`, `anchor_signature_invalid` |
| J07 | The manifest and the package edited | broken: `manifest_mismatch`, `package_mismatch` |
| J08 | A run begun before the journal was chained | unchained |
| J09 | The export of a closed run spelled otherwise: `1E21`, `0.10`, `-0`, `1e-400`, `1.0`, escapes, members in another order, tabs | verified |
| J10 | An event's hash removed in the database | broken: `hash_missing`, `chain_broken` |
| J11 | An anchor the runtime's key signed over a hash its event does not have | broken: `anchor_mismatch` |
| J12 | A state event's anchor removed | broken: `anchor_missing` |
| J13 | Events moved in the export, seqs `[1, 2, 5, 3, 4, …]` | broken: `seq_gap`, `chain_broken` |
| J14 | A second event with the last seq after the genuine one: the anchor names the first in the export's order | broken: `seq_gap`, `chain_broken` |
| J15 | An export with a duplicate member | unreadable: `malformed_export` |
| J16 | A run whose data nests deeper than a verifier reads | unreadable: `export_over_limit` |

All paths are relative to the case directory and must stay inside the
repository. A path may go up into the repository to share a fixture, as V03 does.

## How a result is compared

- `ok` must match.
- The compiler's diagnostics and `expect.diagnostics` are compared in order, one
  to one: same count, and for each pair the same `code` and the same `path` (the
  diagnostic's `at.path`). A diagnostic that has no path, such as a text
  reader's error that has only a position, is at the path `""`.
- `facts`, when a case gives them, are a subset: every key the case names must
  be deeply equal in the diagnostic. Extra keys in the diagnostic are allowed.
- `message` and `span` are never compared. Messages may change, and columns
  depend on how a compiler counts characters.
- `hashes`, when given, must equal the result's hashes exactly.

## The S and V cases

The conformance claims of the design document's §25 are cases here. An id is
the claim's number and a letter for each distinct thing the claim says; the
vitest tests (`compiler/test/conformance.test.ts` and `static.test.ts`) stay as
they are and say more where a claim is about a message, a position or an API.

| Claim | Cases |
|---|---|
| S01 duplicate JSON keys | `S01` |
| S02 unknown fields and language versions | `S02a`–`S02e` |
| S03 references to missing nodes | `S03a`–`S03i` |
| S04 call cycles | `S04a` |
| S05 a switch handles every variant | `S05a`, `S05b` |
| S06 unbounded iteration | `S06a`, `S06b` |
| S07 no external write inside a function or skill | `S07a`, `S07b` |
| S08 programs cannot produce Evidence, Authorization, Receipt or Verified | `S08a`–`S08d` |
| S10 key order does not change the hash | `S10a`–`S10d`, in pairs: a with b, c with d |
| S11 no silent Unicode or number normalization | `S11a`–`S11m`; `S11a` and `S11b` differ, `S11l` and `S11m` agree |
| S12 a patch against a stale base | `S12a`–`S12d`, with `base` |
| V01 `Inferred<T>` cannot reach a critical effect | `V01a`–`V01e` |
| V02 `Untrusted<T>` in the instruction part of a prompt | `V02a`, `V02b` |
| V03 `par` branches with overlapping writes | `V03`, `V03b`–`V03d` |
| V04 restricted data to a model | `V04a`–`V04c` |
| V05 dynamic `spawn` | `V05a` |
| V06 `UnknownOutcome` | `V06a`, `V06b` |
| V07 a decision switch handles `Uncertain` | `V07a` |
| V08 a decision to a critical effect | `V08a` |
| V20 a text literal as a `Path` | `V20a`–`V20e` |

S09 (load-time verification) is a claim about the runtime, not about a
compile, and has no case here.

Paired cases say a claim that is about two inputs. `S10a` and `S10b` are one
program with its keys in two orders, and both expect the same hashes. `S11a`
and `S11b` are the same text in two Unicode forms, and expect different ones.
`S11l` is a decimal in text and `S11m` the IR it must become; they expect the
same hashes.

Some of what the vitest tests assert is not an input and diagnostics, and stays
there: a diagnostic's message (V01, V20), its source position (S01, S02, S03),
the `repair` patch it offers (S03), and that applying a patch leaves the program
it was given as it was (S12).

## What the Rust crates run

| Implementation | Runs | Where |
|---|---|---|
| TypeScript compiler | every `compile` case | `compiler/test/cases.test.ts` |
| TypeScript runtime | every `journal` case | `runtime/test/journal-cases.test.ts` |
| Rust compiler | every `compile` case, through the front door its kind names | `crates/mandate-testkit/tests/conformance.rs` |
| Rust `mandate-ir` | the six `compile` cases whose hashes need only the reader (below) | `crates/mandate-ir/tests/conformance.rs` |
| Rust `verify-journal` | every `journal` case, through its library and its binary | `crates/verify-journal/tests/conformance.rs` |

**The Rust compiler.** `conformance_gate` in
`crates/mandate-testkit/tests/conformance.rs` reads every directory of
`conformance/` and runs each `compile` case through the door its fields name
(the same names as `doorOf` in `compiler/test/diagnostic-vectors.test.ts`):

- a case with `amendment`: `check_amendment`; with `subprogram`:
  `check_subprogram`;
- a case with `patch` and `base`: `apply_ops` (a refusal, E0130 or E0131, is
  the result; otherwise the patched IR is checked);
- a case with `patch` and no `base`: the RFC 6902 patch is applied to the IR as
  `compiler/test/cases-runner.ts` applies it, and the patched IR is checked as
  JSON text (`check_patched`);
- every other case: `check`, with the case's modules and lock.

The result is compared with `expect` by the rule of "How a result is compared"
above and nothing else: `ok`; the diagnostics in order, one to one, by `code`
and `path`; `facts` as a subset, each deeply equal; `hashes` exactly when
given. Messages and spans are not compared here; `vectors/diagnostics/` holds
the TypeScript's whole result for each of these cases (and for every golden
program), and the diagnostics gate (`crates/mandate-testkit/tests/diagnostics.rs`)
compares the Rust's result with it whole, byte for byte.

The gate prints what it ran, and the `journal` cases, which are not compile
cases, as skipped:

```
conformance cases: ran 125, passed 125, pending 0
conformance cases: of the 0 pending, 0 give only what the TypeScript gives, in its order, and 0 are excluded by rule
  skipped 16: journal cases: a run's journal, which crates/verify-journal checks
```

(141 cases: 125 `compile`, 16 `journal`; no case has the kind `run` yet.) A case
that fails is named as `<door> @ conformance/<id> [codes]` with every
difference. `pending` is the number of cases a list in the test holds back; the
list is empty, and what it is for now is this: a new rule of the language is
written first as a case here, listed as pending, and the list is shortened by
the commit that makes the Rust pass it. A pending case is held to failing only
by leaving diagnostics out, never by giving one the TypeScript does not.

What the gates compare, and what the Rust compiler is not held to, is in
`vectors/README.md`, "Where the Rust compiler is not held to the TypeScript".

**`verify-journal`.** `crates/verify-journal/tests/conformance.rs` finds the
journal cases by their `kind`, verifies each export under its keys, and compares
the report with the case's as JSON values, and the binary's output with the
report file byte for byte; it prints how many it ran. It starts the binary, so
it runs natively (CI's `rust` job), not under WebAssembly.

**`mandate-ir`.** `crates/mandate-ir/tests/conformance.rs` runs, with the Rust
crate alone, the cases that need only the strict JSON reader and the hashes, and
counts the rest as skipped, with the reason (it prints `ran 6, skipped 135 (of
141)`). It runs a `compile` case with a JSON input and none of `patch`,
`modules`, `lock`, `subprogram`, `amendment` and `base`, when it expects `ok`
with `hashes` and no diagnostics (E0104c, S10a, S10b, S11a, S11b, S11m): the
reader must accept the input with no diagnostic and the hashes must be the
case's.

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

or only the cases: `cd compiler && npx vitest run test/cases`. The journal
cases: `cd runtime && npx vitest run test/journal-cases`.

The Rust compiler's cases: `cargo test -p mandate-testkit --test conformance --
--nocapture`, or, where a native test cannot run, `node scripts/wasi-test.mjs -p
mandate-testkit --test conformance -- --nocapture`. The journal cases need a
native run: `cargo test -p verify-journal --test conformance`.
