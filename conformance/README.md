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
  case checks (after the patch) must declare that language. A case that
  expects E0103 for a version no compiler reads may name instead the version
  of the compiler it is written for, when that is one only the Rust compiler
  reads (`S02h`: a program of `mandate/0.8`, a case of `mandate/0.6`). So may a
  case about how a program of an earlier version meets what that version adds,
  which the TypeScript could not run or would write vectors for (`E0104d`: a
  program of 0.5 with fields of 0.6; `E1603`: a program of 0.5 that imports a
  module of 0.6): its program declares a version the Rust reads that is older
  than the case's. A text that does not read declares the version of its header
  (`mandate @ 0.6`). A case of `mandate/0.6` or `mandate/0.7` is a case of the Rust
  compiler alone (see "Cases of 0.6" and "Cases of 0.7").
- `input`: required except in a journal case and a library case. `{ "file": "<path>", "kind": "mdt" | "json" }` or
  `{ "text": "<source>", "kind": ... }`. Exactly one of `file` and `text`.
- `modules`: optional list of module files, loaded the way `--module` loads them.
- `lock`: optional path to a lock file, or `null`.
- `libraries` (0.6): optional list of library directories (a
  `mandate.library.json` and the module files it lists), handed to the check
  as a package carries them, or to a library case as the libraries its lock
  pins.
- `config` (0.6): optional path to the `libraries` member of a runtime
  configuration (`{ dir, wait_days?, revoked? }`): its revoked digests for a
  check, its waiting period too for a library case.
- `library` (0.6): optional; a library case. Instead of a check, `add`,
  `upgrade` or `publish` as the compiler's pure functions give them:
  `{ op, now, name?, range?, versions?, only?, pinned?, source?,
  accept_governance? }`, `versions` a directory of `<version>/` directories
  (each with its manifest, modules and `index.json`), `only` the ones to
  read, `pinned` the version the lock pins (upgrade), `source` the library
  to publish. Its `expect` may say `written`: whether `add` or `upgrade`
  gives back the lock with the new pin.
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

## Cases of 0.6

Language 0.6 (spec/library.md) is implemented in the Rust compiler alone. A case
of it says `"language": "mandate/0.6"`, and its expectation is written by a person:
codes, paths and facts, never generated from a compiler's output. The Rust
conformance gate runs it and compares it whole. The TypeScript runner
(`compiler/test/cases.test.ts`) skips it, and so do the TypeScript's vectors, and
each checks that it skipped exactly the directories whose `case.json` names 0.6 and
that there are `RUST_ONLY_CASES` of them (`compiler/test/cases-runner.ts`); a case
of 0.6 added or taken away changes that number in the same commit. The Rust writes
their whole results in `vectors/diagnostics-0.6/`.

| Case | Claim | Code |
|---|---|---|
| `S02f` | A 0.6 program with none of what 0.6 adds checks | — |
| `S02g` | An unknown field of a 0.6 program is refused: its IR is closed by `spec/ir-0.6.schema.json` | E0104 |
| `S02h` | An unknown version (`mandate/0.8`) is refused, and the versions the Rust compiler reads are 0.1 to 0.7 | E0103 |
| `E0140` | A 0.5 lock that carries `libraries`, a field of format 0.6 | E0140 |
| `E0140a` | A 0.6 lock whose library has a version that is not `MAJOR.MINOR.PATCH` and a module with no program hash | E0140 |
| `E0140b` | A 0.6 lock whose connector has no `tools` and a credential that is not a name | E0140 |
| `P01` | A 0.6 module with `pub` before each of the 13 kinds of definition and doc lines checks; its hashes cover each `pub` and `doc` | — |
| `P01a` | The IR `P01` reads to, as JSON IR: the 0.6 schema takes `pub` and `doc` on every kind; the hashes are `P01`'s | — |
| `P01b` | One doc line changed: a new program hash and a new hash of that definition, no other | — |
| `E0104d` | `doc` and `pub` (on a type) in the IR of a program of 0.5 | E0104 |
| `E0101` | A doc line inside the body of a definition | E0101 |
| `E0101a` | A doc line before a `use` | E0101 |
| `E0101b` | A doc line before `module` | E0101 |
| `E0101c` | A doc line at the end of the file | E0101 |
| `E0101d` | A doc line followed by a blank line before the definition | E0101 |
| `E0101e` | `pub type` in a program of 0.5: before 0.6, `pub` stands before a `fn` only | E0101 |
| `E0101f` | `///` lines everywhere in a program of 0.5 are comments: it checks with the hashes of its text without them | — |
| `E0101g` | A `///` comment at the end of a line of code, on the line before a definition | E0101 |
| `E1602` | A name of a 0.6 module that is not `pub`, in a `use` list (a mutation of a program that checks) | E1602 |
| `E1602a` | A type written with the path of a module that is not the standard library's (`example.library.types.Invoice`, after a `use` that lists `Invoice`) is no name in 0.6: an unknown type (a mutation) | E0120 |
| `E1602c` | A program of 0.5 that imports a module without a list and names its constant and type with the module's path, declared 0.6 (a mutation): the `use` is not closed, and neither `domain` nor `domain.Ticket` is a name | E1604, E0120 |
| `E1602b` | A 0.6 program names definitions of a 0.5 module, none of them `pub`, through its `use` list | — |
| `E1603` | A program of 0.5 that imports a module of 0.6 (a mutation: the program's `language`) | E1603 |
| `E1603a` | A module of 0.5, definitions only, that imports a module of 0.6 | E1603 |
| `E1604` | A `use` of a module the check is not given (a mutation: one `use` added) | E1604 |
| `E1604a` | A `use` of `std.patterns`, built into the compiler, needs no module; a name of its list the library does not define (a mutation: one `use` added) | E0120 |
| `E1604b` | Imports of `std`, `std.decision` and a module the check is given | — |
| `E1604c` | A `use` of a module the check is given, without a list of names (a mutation: one `use` added) | E1604 |
| `E1604d` | A `use` of the built-in `std.patterns` without a list of names: it is a library, linked by the names its `use` lists (a mutation: one `use` added) | E1604 |
| `E1601` | A library handed to the check, one of whose modules defines an `extern` (a mutation: one definition added) | E1601 |
| `E1601a` | A library named `std.extras`: `std` and the names under it are the compiler's own | E1601 |
| `E1606` | A library whose manifest requires `std.patterns ^2.0`, which the compiler builds in at 1.0.0 (a mutation: one member added) | E1606 |
| `L01` | The acceptance program with a lock whose digest of `acme.connectors` differs in one digit | E1605 |
| `L02` | `upgrade` of `acme.ops` 1.0.0 to 1.1.0, which raises a `pub` workflow's budget: a governance change, no lock given back | — (`written: false`) |
| `L03` | `publish` of `acme.ops` 1.1.0 over 1.0.0, a minor version that widens the signature | E1607 |
| `L04` | `add` of exactly `acme.ops` 1.2.0 within its waiting period, naming the day it may be resolved | E1608 |
| `L04a` | The acceptance program checked with a configuration that revokes the digest its lock pins | E1608 |
| `L05` | `upgrade` of `acme.ops` 1.0.0 to 1.0.1, a doc line: no governance change, the lock given back | — (`written: true`) |
| `L06` | `publish` of 1.0.5 between 1.0.0 and 1.1.0, against which 1.1.0 would widen without being a major version | E1607 |
| `L07` | A lead's sub-program calls a read tool of a connector its parent imports, with its types, from given modules | — |
| `L07a` | The same with `acme.connectors` as a library, the parent importing none of the tool's types: the sub-program's check, handed the library's modules, links them through what they reach | — |
| `L08` | A lead's sub-program, a workflow with no parameters, applies `FanOutMerge` to a constant list of repositories it writes, and is admitted | — |
| `L08a` | The same with `MakerChecker` and a constant brief | — |
| `L09` | An application of `FanOutMerge` whose `const List<Item>` slot is given a list of record literals checks | — |
| `E0120` | A listed constant used as a type: a listed name is the definition it names, held to its kind as the program's own (a mutation) | E0120 |
| `E0120a` | A lower-case listed name of a module that is not the standard library's used as a module path, `most.Anything` (a mutation) | E0120 |
| `E0120b` | A listed type named as the contract of `Verified` (a mutation) | E0120 |
| `T01a` | A program with a connector of its own checks, its lock binding the connector: a read in a workflow, read-only tools in an agent, a write as a critical effect | — |
| `T01` | `tool.call(erp, list_orders)` does not cover the write `post_draft` (B12; a mutation: the workflow's caps) | E0301 |
| `T01b` | A `tool.call` covers exactly the tools it lists: `tool.call(erp, list_orders)` does not cover the read-only `find_draft` (a mutation: the read) | E0301 |
| `E0320b` | A `tool.call` that lists a write tool is a write capability: two branches of a `par` that call one write tool (a mutation) | E0320 |
| `T02` | An agent that holds a write tool (a mutation: one capability added to its caps) | E1406, W0310 |
| `T06` | A tool's argument of a class above its connector's (a mutation: the argument) | E0220 |
| `T06a` | An agent that holds a tool and receives data of a class above its connector's (a mutation: the argument of the delegation) | E0220 |
| `E1401` | A write tool without `critical` | E1401 |
| `E1401a` | A `reconcile by` tool that does not answer about the write: not one `Text` parameter and `Untrusted<Option<T>>` | E1401 |
| `E1401b` | A tool that is `read_only` and of a write class | E1401 |
| `E1402` | A server URL with a port | E1402 |
| `E1402a` | A class that is not a data class | E1402 |
| `E1402b` | A tool declared twice, in the text | E1402 |
| `E1403` | A read-only tool that returns what is not `Untrusted<T>` | E1403 |
| `E1404` | A `tool.call` of a tool the connector does not declare (a mutation: a capability added) | E1404 |
| `E1405` | A read-only tool called through `effect` | E1405 |
| `E1405a` | A write tool called as an expression | E1405, W0310 |
| `E1405b` | A tool called in a function | E1405 |
| `E1406` | A delegation's `with caps` that hands an agent a write tool | E0701, E1406, E0301 |
| `E1407` | A connector the package can call, and a lock with no entry for it | E1407 |
| `E1407a` | A lock entry without the digest of one of the connector's tools | E1407 |
| `E1408` | A lock entry of a connector no module of the package defines | E1408 |
| `E1408a` | A lock entry with the digest of a tool the connector does not declare | E1408 |
| `E0140c` | A connector's `template` in the lock with `{secret}` twice | E0140 |
| `E0301a` | An effect with two `requires caps`, the second covered by no capability of the workflow (B12) | E0301, W0310 |
| `E0301b` | The program of `E0301a` as 0.5: only the first `requires caps` is compared, as before | — |
| `E0121` | An effect named `Tool` in a program of 0.6, which would decide what covers every read-only tool (a mutation: the effect added, the workflow without `ErpRead`) | E0121 |
| `E0121a` | The same effect, with the agent that declares `Tool` holding only its model capability | E0121 |
| `E0121b` | A program of 0.5 with an effect named `Model` is read as before | — |
| `E1406a` | A map's `with caps` that hands a write tool, its body delegating through a function | E1406 |
| `E1406b` | A map's `with caps` that hands a write tool, its body delegating directly | E1406 |
| `E0220c` | An agent that holds a connector's read-only tools whose class is above what its model capability may receive | E0220 |
| `E0220d` | A delegation whose `with caps` narrows the agent's model below its connector's class | E0220 |
| `E0220e` | A tool whose result type is classed above its connector's class, in the module that declares it | E0220 |
| `E0120c` | A program that calls a tool whose types it does not import: the type names of the signature are not the connector module's definitions in it | E0120 |
| `E0120d` | A program whose own `Match` stands where the tool means the types module's `Match` | E0120 |
| `E1408b` | A lock entry of a connector of a module the program does not import, though the check is given it | E1408 |
| `E1405e` | A tool called in a workflow's `ensures` | E1405 |
| `E1407b` | A lock entry whose `url` is not the connector's declared URL | E1407 |
| `E1405c` | A tool called in a contract's static criterion | E1405 |
| `E1405d` | A tool called in a workflow's handler | E1405 |
| `E1708m` | A write tool's effect in a map's body, its key not read from the item | E1708 |
| `E0403a` | A write tool's effect without `idempotent_by` | E0403 |
| `E0301c` | An effect whose second `requires caps` stands for no capability: nothing covers it (B12) | E0301, W0310 |
| `E0408a` | A skill that declares a write tool's effect: a write tool is a critical effect | E0408 |
| `E0210a` | A write tool whose parameter is `Untrusted`, in its declaration | E0210 |
| `E1404a` | A `tool.call` of a connector the program reaches through an imported capability and does not list | E1404 |
| `H06` | A review over a verifying map checks: one wait for the list, its accepted items committed by a batch commit step through a connector's write tool | — |
| `H07` | A review whose role is not among the waive by roles of the waived criterion (a mutation: the role) | E1508 |
| `E1508` | A review whose `escalate_to` may not waive the waived criterion | E1508 |
| `E1508a` | A review of a map that verifies against a contract with no waiver (a mutation: the waiver taken away) | E1508 |
| `E1506` | A review of a workflow's parameter | E1506 |
| `E1506a` | A review of a field that holds a verifying map's outcomes | E1506 |
| `E1506b` | A review of a call's result | E1506 |
| `E1506c` | A review of a map whose body does not end with a verify | E1506 |
| `E1506d` | A review of a map whose verify has `on unmet` | E1506 |
| `E1506e` | A review of a name bound again, after the map, to what is not a map | E1506 |
| `E1506f` | A review of a map whose body ends with an `if` that verifies on each path | E1506 |
| `E1506g` | A review in a function | E1506 |
| `E1506h` | A review that names no results first | E1506 |
| `E1507` | A review without a role | E1507 |
| `E1507a` | A review without a deadline | E1507 |
| `E1507b` | A review with an argument it does not take | E1507 |
| `E1507c` | A review that gives its role twice | E1507 |
| `E1507d` | A review with a second value without a name | E1507 |
| `E1507e` | A review whose role names no role definition | E1507 |
| `E1507f` | A review whose deadline is zero | E1507 |
| `E1507g` | A review whose deadline is a variable, not a constant | E1507 |
| `E1507h` | A review that escalates to the role it asks first | E1507 |
| `E1507i` | A review whose `escalate_to` names no role definition | E1507 |
| `E1504` | A criterion met by `human.approve` with a waiver (a mutation: a contract added) | E1504 |
| `E1504a` | A criterion whose method includes `human.approve` through `and`, with a waiver | E1504 |
| `E1505` | A value verified against a contract with a waiver as an argument of `git.merge`, after an approval (a mutation of a program that checks) | E1505 |
| `E1505a` | The same through a `let` whose declared type names no contract | E1505 |
| `E1505b` | A field of such a value as an argument of a declared irreversible effect | E1505 |
| `E1505c` | What a function gives back of such a value | E1505 |
| `E1505d` | What a function gives back that verifies against such a contract itself | E1505 |
| `E1505e` | A map's item made of such a value, where the irreversible effect is no batch commit step either | E1708, E1505 |
| `E1505f` | Such a value standing for the approval, its contract asking a person too | E1505, E0405 |
| `E1505g` | A review's `accepted` list as an argument of an irreversible effect | E1505 |
| `E1708b` | A batch commit step that checks, in a workflow with an envelope: a connector's write tool and a declared critical effect, each in a map's body | — |
| `E1708c` | An irreversible effect in a map's body, after an approval | E1708 |
| `E1708d` | An effect the envelope names under `approve` | E1708 |
| `E1708e` | An effect an environment asks a person to authorize | E1708 |
| `E1708f` | An effect whose key is a constant | E1708 |
| `E1708g` | An effect whose key is a variable of the enclosing scope | E1708 |
| `E1708h` | An effect whose key reads the item's name after a `let` of the body bound it again | E1708 |
| `E1708i` | A change set in a map's body, in a program of 0.6 | E1708 |
| `E1708j` | An effect in a map with `par 2` | E1708 |
| `E1708k` | An effect in a map in the body of another map | E1708 |
| `E1708l` | A review in a map's body | E1708 |
| `E0121c` | A type named `Declined` in a program of 0.6, which would type what a review declined (a mutation: the type added) | E0121 |
| `E0121d` | A use list that brings a type named `Declined` from a module of 0.5 | E0121 |
| `E0121e` | A connector named `human` with a tool `review`, which would make `human.review(…)` that tool | E0121 |
| `E0121f` | A use list that brings the name `tool`, the root of a standard module, from another module | E0121 |
| `E1504b` | A criterion met by a function that calls a function that asks a person, with a waiver | E1504 |
| `E0213a` | An extern whose result is an alias of `Review` | E0213 |
| `E0213b` | An extern whose result is a record with a `Review` in a field | E0213 |
| `E0213c` | A skill whose result is a `Review` | E0213 |
| `E0213d` | A record literal of an alias of `Review` | E0213 |
| `E0213e` | An `infer` whose target is an alias of `Review` | E0213 |
| `E0213f` | A declared effect whose result is a union with a `Declined` in a variant | E0213 |
| `E1505h` | A value a waiver may rest on, given by a later arm of a `switch`, as an argument of `git.merge` | E1505 |
| `E1505i` | The same through `pause and x` | E1505 |
| `E1505j` | The same through a block that ends with a `let` | E1505 |
| `E1505k` | The same through a block that ends with an `if` | E1505 |
| `E1505l` | The same through a block that ends with a `loop` | E1505 |
| `E0210b` | A declined item, given by a later arm of a `switch`, posted by a batch commit step | E0210 |
| `E0210c` | A declined item that an `on error` handler gives in place of a failed `verify`, posted | E0210 |
| `E0210d` | A declined item that an `on unmet` handler gives, posted | E0210 |
| `E0210e` | A declined item that an `if`'s `else` gives, posted | E0210 |
| `E0220f` | Restricted data given by a later arm of a `switch`, sent to a model that may receive internal data | E0220 |
| `E0220i` | Since 2026-11-18 a call of a function in 0.6 is of the class of what it returns: a confidential row the function reads and returns as `Text`, handed to a model allowed public data (a mutation; spec/attention.md, the security note) | E0220 |
| `E1706f` | The same in a lead's sub-program: its function's result handed to a delegation under an envelope whose `spawn.max_class` is public | E1706 |
| `E0120e` | A call of `human.ask` after a variable of the body took the name `human` | E0120 |
| `E0120f` | A call of a member of a value, `x.m()` | E0120 |
| `E0120g` | A call of a workflow | E0120 |
| `E0711` | An `await` in a program of 0.6 | E0711 |
| `E0212` | `x?` of a value that is not a `Result`, which keeps its contract, where another contract is required | E0212 |
| `E0201b` | A function whose body ends with an `if` whose `else` gives less than its declared type | E0201 |
| `H08` | A `verify` whose `on unmet` handler is an escalation, and one whose handler is a pause, each keeping the verified value's type: the one exception to the joins | — |
| `E0201a` | The program of `H08`, the first handler giving another value: the `verify` is that value or the verified one | E0201 |
| `E1506i` | A review of a map's name after an `on error` handler that gives a value of its own | E1506 |
| `E0408b` | An effect in a workflow's `ensures` | E0408 |
| `E0201c` | A record's field declared `Verified` given a value that is not verified | E0201 |
| `E0201d` | `peek` of a name nothing defines, where a verified value is required | W0207, E0201 |
| `E0201e` | A `switch` between a list of unverified changes and an empty list, where a list of verified ones is required | E0201 |

The cases of patterns (spec/library.md "Patterns") are mutations of
`P02/program.mdt`, a program that defines `BatchWithExceptions` and applies
it, but for those with a program of their own (`P02b`, `P04`, `E1304k`,
`E1304l`), those of an imported pattern (`P05`, `E1306d`, `E1602d`, `E1602e`,
on `fixtures/library/batch.mdt` and its modules) and those of a sub-program
(`P06` to `P06b`, on `P06/parent.mdt`):

| Case | Mutation | Expected |
|---|---|---|
| `P02` | A pattern the program defines, applied: every check runs on the expansion | — |
| `P02a` | A deadline of zero given to the deadline slot: the review's E1507 at that argument | E1507 |
| `P02b` | A type slot and a capability slot, used in a signature, a `let` and a `with caps` narrowed | — |
| `P03` | A pattern that declares `caps` | E1302 |
| `P03a` | A pattern that names a capability other than through a slot | E1302 |
| `P04` | An expansion of 1,202 static nodes | W0310, E0105 |
| `P05` | An imported pattern applied: the program hash covers the application | — |
| `P06` | A sub-program that applies its parent's pattern, admitted | — |
| `P06a` | The same with a width above the envelope's `max_concurrent`, at the argument | E1703 |
| `P06b` | A sub-program that applies a pattern with a run parameter: its workflow takes one | E1705 |
| `E0104e`, `E0104f` | A delegation with its slot and an `Agent.skill` too; a slot argument with a value and a type: each two forms of the IR of 0.6, refused when it is read | E0104 |
| `E1301` to `E1301g` | A slot of no kind, two slots of one name, a type parameter twice, a signature its kind does not take, no body, a tool slot delegated to, a map counted by a role slot, a tool slot read as a value | E1301 |
| `E1302` to `E1302j` | An effect run with `effect`, an agent, a connector's tool, a capability constructor in `with caps`, a role, a contract a person approves through a type, an agent through a function, a role written as text, an agent through a function that calls another, a constructor called by its own name in `with caps`, a contract verified against whose criterion a person may waive: each other than through a slot | E1302 |
| `E1303`, `E1303a` | An agent applied; a name nothing defines | E1303 |
| `E1304` to `E1304m` | A slot without an argument, an argument for no slot, another number of type arguments, an argument twice, and each kind given another's: tool, skill, contract, role, effect, field, const, type, capability, and a write tool given to a tool slot | E1304 |
| `E1305` to `E1305h` | An effect's parameter, a skill's result, a contract's parameters, a constant's type, a count of zero, a field the type has not, a `read_only` skill of an agent that writes, a tool's parameters, an expression that is no constant | E1305 |
| `E1305i` | A `const List<Item>` slot given a list whose record lacks a field of the item type (a mutation: the argument) | E1305 |
| `E1305j` | A `const List<Item>` slot given a list that names a capability: a value slot brings no authority (a mutation: the argument) | E1305 |
| `E1306` to `E1306e` | A run parameter like a slot, a type parameter like a definition, a body binding a slot's name, an argument the body captures, a name the expansion adds that the program defines, a run parameter like a binding of the body | E1306 |
| `E1307` to `E1307e` | An application with an envelope, in a pattern's body, in a workflow's body, as a slot's argument, as a capability, with a body | E1307 |
| `E1602d`, `E1602e` | A pattern of another module that is not `pub`; one whose expansion names a definition that is not | E1602 |
| `E1708o`, `E1708n` | A person in a map of the expansion; a commit map of the expansion run side by side | E1708 |
| `E1505m` | An irreversible effect given to the commit slot | E1708, E1505, E0405 |
| `E1506j` | A review in the expansion of a list that is no verifying map's | E1506 |
| `E1501a` | A person asked by a role that is a constant of the program, in the expansion | E1501 |
| `E0301d` | The commit's capability taken from the applying workflow | E0301 |
| `E0220g` | The model's class below the connector's | E0220 |
| `E0210` | Model output posted by the commit map | E0210 |

The cases of shapes (spec/library.md "`shapes`") share `N11/parent.mdt`, a program
of 0.6 whose envelope lists `Each`, a pattern it defines, and `FanOutMerge` of
`std.patterns` (and defines `Spare` and imports `MakerChecker`, which it does not list); the sub-programs
reuse `P06/sub.mdt`, an application of `Each`, and `E1709d` amends `P06/parent.mdt`,
whose envelope has no shapes:

| Case | Claim | Code |
|---|---|---|
| `N11` | A sub-program whose workflow is written out | E1710 |
| `N11a` | A shape that names an agent (a mutation) | E1711 |
| `N11b` | An amendment that drops a shape | E1709 |
| `N11c` | A sub-program that applies a listed shape, admitted | — |
| `N11d` | An amendment that adds a shape | — |
| `N11e` | An amendment that takes the list of shapes away | — |
| `E1710` | A sub-program that applies a pattern of its parent the list does not name | E1710 |
| `E1710a` | A sub-program that defines a type under a listed name and applies that name | E1710 |
| `E1710b` | A sub-program that applies `MakerChecker`, a pattern of `std.patterns` the parent imports and does not list | E1710 |
| `E1711` | A shape that names nothing (a mutation) | E1711 |
| `E1711a` | A shape that names a type of `std.patterns` (a mutation) | E1711 |
| `E1709d` | An amendment that gives shapes to an envelope that had none | E1709 |
| `E0104g` | `shapes` in the IR of a program of 0.4 | E0104 |

What the cases of shapes cannot say (the `shape` an admitted sub-program's result
names, the hash, the semantic diff and a patch's governance of a change to them, the
fixture `fixtures/library/migrate-all.mdt` and its sub-programs) is in
`crates/mandate-check/tests/shapes_0_6.rs`.

The import cases share the 0.6 module `E1602/types.mdt` and the program
`E1602/program.mdt`; the connector cases share `T01/program.mdt`, a program
with a connector of its own, and `E0301b` is `E0301a/program.mdt` as 0.5. The
review cases share `H06/program.mdt` (a verifying map, its review and a commit
map), the cases of what may not reach an irreversible effect `E1505/program.mdt`
(and `E1505g` and `E1708l` the review program), and those of the batch commit
step `E1708b/program.mdt`; `E1708i` is a program of its own. `E0121c` to
`E0121f` and `E1504b` are mutations of the review program (`E0121d` and
`E0121f` with a module of their own beside them), and `E0213a` to `E0213f` are
each the review program with what the case adds, a program of its own. The
cases of the typing of 0.6 (each form typed as the runtime evaluates it) are
programs of their own too: `E1505h` to `E1505l` the release program of
`E1505` with what the case adds, `E0210b` to `E0210e` and `E1506i` the review
program, `E0220f` a program of classes, `E0220i` and `E1706f` (with its parent) programs of
a function that reads a confidential row, and the others (and `E0408b`) a small
program that opens or lands a change. What a case cannot say, because its modules must load, is in
`crates/mandate-check/tests/language_0_6.rs`: a module of 0.5 among the modules given
to a check that imports one of 0.6 (E1603), and one of 0.6 that imports a module
nobody gave (E1604), do not load. What the cases of reviews and waivers cannot
say (the types a review's lists have, a change set's irreversible member, the
semantic diff's waivers, a program of 0.5 as before) is in
`crates/mandate-check/tests/review_0_6.rs`. What the cases of patterns cannot
say (the expanded program itself and its hash, an imported pattern checked
again from a module that was never checked, which may carry a slot beside an
agent or name what its module does not know, a module's import named by its
pattern, the limits of an expansion and when it stops, the semantic diff of
an application and of the pattern it means, a program of 0.5 as before) is in
`crates/mandate-check/tests/patterns_0_6.rs`, and their views in
`crates/mandate-views/tests/patterns_0_6.rs`: a case's modules must load, and
such a module does not.

spec/library.md reserves for 0.6 the letters P (patterns), T (tools), H from H06
(human steps), L (libraries) and N11 (shapes), and the code numbers of its
families; the cases above use P01 to P05 (which spec/library.md names) and P06, the S02 claim,
E0101, E0104, E0105, E0120, E0121, E0140, E0201, E0210, E0212, E0213, E0220, E0301, E0320,
E0403, E0408, E0711, E1501 and E1708, which 0.6 extends, T01, T02 and T06 (which spec/library.md names), H06 and
H07 (which it names), the letters of E1708 from b on (E1708b and E1708c, which it
names, one letter for each further refused condition of the batch commit step, and
E1708m, the connectors' own), N11 to N11e and E1710 to E1710b (shapes), E0104g and E1709d (0.6 extends
them), and the code numbers of E13xx, E14xx, E1504 to E1508, E16xx, E1710 and E1711.

## Cases of 0.7

Language 0.7 (spec/attention.md) is the Rust compiler's alone, as 0.6 is. A case of
it says `"language": "mandate/0.7"`, is written by a person and compared whole, and
is skipped and counted by the TypeScript runners with the cases of 0.6
(`RUST_ONLY_CASES`). The Rust writes their whole results in
`vectors/diagnostics-0.7/`. A code 0.7 adds is listed in
`mandate_ir::codes::CODES_0_7` and has a case of 0.7 that expects it
(`crates/mandate-testkit/tests/language_0_7.rs`).

| Case | Claim | Code |
|---|---|---|
| `S02i` | A 0.7 program with none of what 0.7 adds checks | — |
| `S02j` | An unknown field of a 0.7 program is refused: its IR is closed by `spec/ir-0.7.schema.json` | E0104 |
| `S02k` | A 0.7 program accepts a lock of an older format (0.6) | — |
| `S02l` | A lock of format 0.7, read by `spec/lock-0.7.schema.json`, with a 0.7 program | — |
| `E0140d` | An unknown field of a 0.7 lock is refused: the 0.7 lock schema is closed | E0140 |
| `E1509` | A criterion of a 0.7 program met by a call of `waiver` is refused (the runtime refuses it at load) | E1509 |
| `E1509a` | A `verify` among the `and` parts of an invariant criterion is refused | E1509 |
| `E1509b` | `test.verify`, alone and joined to another part with `and`, is not a reserved name: it checks | — |
| `A01` | A 0.7 program with stages checks (`fixtures/attention/stages.mdt`): a workflow in two stages, a pattern in four applied by a workflow whose expansion has them | — |
| `A01a` | `stage` is an ordinary name in a 0.7 program wherever a name and a string do not follow it on its line | — |
| `A01b` | Before 0.7 a stage line is ordinary names: in a 0.6 program, `stage collect "Collect"` is three expressions | E0120 |
| `E0104h` | A stage in the IR of a 0.6 program (a mutation: one statement added) | E0104 |
| `E0104i` | A stage title of 81 characters, refused by the 0.7 schema (a mutation) | E0104 |
| `E0104j` | An empty stage title (a mutation) | E0104 |
| `E0101h` | A stage title with an interpolation | E0101 |
| `E1901` | A stage moved into the body of a pattern's second map (a mutation) | E1901 |
| `E1901a` | A stage in a function's body (a mutation) | E1901 |
| `E1901b` | A stage in a branch of an `if` in a workflow's body | E1901 |
| `E1902` | Two stages of one body with one name (a mutation: a stage renamed) | E1902 |
| `E1902a` | A statement before the first stage of a body (a mutation: the first stage taken away) | E1902 |
| `E1902b` | A stage directly before another stage (a mutation: a stage added) | E1902 |
| `E1902c` | A stage at the end of a body (a mutation: a stage added) | E1902 |
| `E1902d` | An `on error` directly after a stage (a mutation: a handler added) | E1902 |
| `E1902e` | A stage title with a control character (a mutation: the title) | E1902 |
| `E1902f` | A stage title with a bidirectional control (a mutation: the title) | E1902 |
| `E1902g` | A stage title with a line separator, U+2028 (a mutation: the title) | E1902 |
| `A02` | A 0.7 program with reports checks (`fixtures/attention/reports.mdt`): a pattern reporting to its role slot, applied; a workflow reporting what a model wrote, a contract verified, a connector gave and the run counted, in a branch and a bounded loop | — |
| `A02a` | `report` and `to` are ordinary names in a 0.7 program wherever a report's shape does not follow them | — |
| `A02b` | Before 0.7 a report line is ordinary names: in a 0.6 program, `report to accountant` is three expressions | E0120 |
| `A03` | A lead's sub-program that applies a listed shape has the pattern's stages and report through its expansion, and is admitted | — |
| `E0101i` | A report title with an interpolation | E0101 |
| `E0104k` | A report in the IR of a 0.6 program (a mutation: one statement added) | E0104 |
| `E0104l` | A report title of 81 characters (a mutation) | E0104 |
| `E0104m` | An empty report title (a mutation) | E0104 |
| `E0104n` | A report of seventeen fields (a mutation) | E0104 |
| `E0104o` | A report of no field (a mutation) | E0104 |
| `E0121g` | Two fields of one report with one name, in the text | E0121 |
| `E1501b` | A report to a name no role definition has (a mutation: the role) | E1501 |
| `E1502a` | With a lock, a report to a role the lock binds to nobody | E1502 |
| `E1705b` | A stage a lead writes in its sub-program | E1705 |
| `E1705c` | A report a lead writes in its sub-program | E1705 |
| `E1903` | A report title with a control character (a mutation: the title) | E1903 |
| `E1903a` | A pattern's report title with a bidirectional control (a mutation: the title) | E1903 |
| `E1903b` | A report title with a paragraph separator, U+2029 (a mutation: the title) | E1903 |
| `E1903c` | Two fields of one report with one name, in IR (a mutation: a field renamed) | E1903 |
| `E1903d` | A pattern's report to a role definition, not a role slot (a mutation: the role) | E1903 |
| `E1903e` | A pattern's report to a slot of another kind (a mutation: the role) | E1903 |
| `E1904` to `E1904l` | A report's field that holds a delegation, a spawn, an await, an inference, a verification, an effect (in a pattern), a change set, a map, a plan, an escalation, a pause, a `try` or a block (a mutation each: the field) | E1904 |
| `E1904m` to `E1904p` | A report's field that calls `human.ask`, a function of the program, a connector's tool, a built-in other than `len` (a mutation each) | E1904 |
| `E1904q` | The part of a field that is not pure is refused where it stands: `len` of a delegation (a mutation) | E1904 |
| `E1904r` to `E1904u` | A report's field of a type a person is not shown: a set, a list of lists, a record two levels deep, a range the check cannot type (a mutation each) | E1904 |
| `E1904v` | A pattern's report field of a type not shown, refused on the expansion at the application (a mutation) | E1904 |
| `E1905` to `E1905g` | A report in a map's body, a loop without `max_iter`, a function, an `on error`, an `on unmet` and an `on budget_exceeded` handler, a test, and directly before an `on error` (a mutation each) | E1905 |
| `E1609` | A program of 0.6 (`fixtures/attention/batch.mdt`, a mutation: its `language`) whose lock pins `std.patterns` 2.0.0, a library of 0.7: refused at the pin and at the use | E1609 |
| `E1609a` | A program of 0.6 that imports a module of 0.7 given to the check (the module of `E1602` under the header of 0.7) | E1609 |
| `E1609b` | A program of 0.7 that imports a module of 0.6 given to the check (a mutation: its `language`) checks | — |
| `E1609c` | A program of 0.7 whose lock pins `std.patterns` 1.0.0 reads 1.0.0 and checks | — |
| `E1603b` | A program of 0.5 that imports a module of 0.7 is E1603, as for a module of 0.6 (a mutation: its `language`) | E1603 |
| `L10` | `mandate publish` of a minor version of a library of 0.7 (`acme.reports` 1.1.0, `L10/versions/`) that adds a report: the signature widens | E1607 |
| `L10a`, `L10b` | `mandate upgrade` to that version: not written without `--accept-governance`, written with it | — |
| `L10c` | `mandate publish` of a minor version whose report's highest class rises (internal to confidential) | E1607 |
| `L10d` | `mandate upgrade` to a version whose workflow's report is taken away: no governance change, written | — |
| `L10e` | `mandate publish` of a minor version whose pattern addresses its report to its other role slot | E1607 |
| `E1906` | A workflow whose attention bound is above its budget's `asks` (`fixtures/attention/asks.mdt`, whose workflows declare their exact bounds; a mutation: `asks` 9 becomes 8) | E1906 |
| `E1906a` to `E1906j` | One question more of each kind of site, against the exact bound: `human.ask`, `escalate`, `pause`, `supervise escalate` (5), a `human.approve` of a criterion, an effect the program hands to a person (with its owner's gate), a change set, the owner's gate of an action that may carry a governance-class file, a review, a review's escalation (a mutation each) | E1906 |
| `E1906k` to `E1906p` | The algebra: a loop's `max_iter` multiplies, a function counts at each call, `if` takes the larger branch, `supervise restart_all` counts a `par`'s branches twice, a `verify`'s `on unmet` and a statement's `on error` count beside it (a mutation each) | E1906 |
| `E1907` to `E1907b` | A question in a loop without `max_iter`, in a function that calls itself (with E0502), and in what a recursion through a contract's `require` reaches (with E0502), in a workflow that declares `asks` | E1907 |
| `S04b` | In 0.7 a cycle of calls through two contracts' `require` is a call cycle | E0502 |
| `E1501c` | In 0.7 an approval's role that a parameter of its contract also names is refused, since a run reads the role in the contract's scope (a mutation of `fixtures/attention/asks.mdt`) | E1501 |
| `E1501d` | In 0.7 the same of a contract of another module, of 0.6, that the program's `verify` reaches: refused at the `verify`, with the contract, its module and the place in it (`E1501d/lib.mdt`; a mutation: the contract) | E1501 |
| `S04c`, `E1907c` | In 0.7 a cycle through a contract of another module, of 0.6, refused where the program reaches it, and with `asks` declared the question the cycle reaches (`cyc.mdt`; a mutation each: the contract) | E0502, E1907 |
| `E0220h` | In 0.7 a call of a function is of the class of what it returns: a confidential row the function reads and returns as `Text`, handed to a model allowed public data (a mutation) | E0220 |
| `E1908` to `E1908e` | `asks` in an agent's, a delegation's, a map's, a plan's, a skill's and a function's budget (a mutation each) | E1908 |
| `E1706c` to `E1706e` | Under an envelope that limits `asks` (the room's `left.asks`): a sub-program whose static total does not fit what is left, one whose declared `asks` does not, and one whose total is unbounded and that declares none | E1706 |
| `E1709e` to `E1709g` | An amendment that lowers the envelope's `asks`, leaves it out, and adds it to an envelope that had none | E1709 |
| `A04` | A 0.7 program whose workflow written out and whose application of a pattern each have an owner checks with a 0.7 lock that has `role_classes` and `promotion: "required"` (`fixtures/attention/owner.mdt`) | — |
| `E1910` | An owner on a workflow that has an envelope (a mutation: the owner added) | E1910 |
| `E1910a`, `E1910b` | With `promotion: "required"`, a workflow written out and an application with neither an owner nor an envelope (a mutation each: the owner line removed) | E1910 |
| `E1911`, `E1911a` | A 0.7 lock's `role_classes`, and its `promotion`, with a program of 0.6 (a mutation each: the program relabelled 0.6) | E1911 |
| `E1705d` | An owner a lead writes in its sub-program | E1705 |
| `E1501e` | A workflow's owner that no role definition has (a mutation: the owner) | E1501 |
| `E1502b` | With a lock, a workflow's owner that the lock binds to nobody (a mutation: a role added and named) | E1502 |
| `E0140e`, `E0140f` | `role_classes`, and `promotion`, in a lock of 0.6, refused at its root | E0140 |
| `E0140g` | A class in `role_classes` for a role `roles` does not name | E0140 |
| `E0140h` | A class in `role_classes` that is no data class | E0140 |
| `E1307f` | An application with an owner and an envelope: E1307 at the envelope, and no E1910 (a mutation: an envelope added) | E1307 |
| `L11` | `mandate publish` of a library of 0.7 whose workflow's owner changed to a role it already asks, as a minor version (`changes_owner`) | E1607 |
| `L11a` | The same with one report more: the refusal names both reasons (`widens_authority`, `changes_owner`) | E1607 |

Of these, `E1609`, `E1609a` and `E1603b` are cases of 0.7 whose program
declares an older version: E1609 refuses a program of 0.6 that reads what
0.7 wrote, and no program of 0.7 can meet it, so its cases name the version
of the rule, as `E1603` names 0.6 for a program of 0.5.

## What the Rust crates run

| Implementation | Runs | Where |
|---|---|---|
| TypeScript compiler | every `compile` case but those of 0.6, which it counts | `compiler/test/cases.test.ts` |
| TypeScript runtime | every `journal` case | `runtime/test/journal-cases.test.ts` |
| Rust compiler | every `compile` case, those of 0.6 included, through the front door its kind names | `crates/mandate-testkit/tests/conformance.rs` |
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
conformance cases: ran 535, passed 535, pending 0
conformance cases: of the 0 pending, 0 give only what the TypeScript gives, in its order, and 0 are excluded by rule
  skipped 16: journal cases: a run's journal, which crates/verify-journal checks
  of them 410 of language mandate/0.6, mandate/0.7, which only the Rust reads, each expectation written by hand
```

(551 cases: 535 `compile`, 267 of them of language 0.6 and 143 of 0.7, and 16 `journal`; no case
has the kind `run` yet.) A case
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
counts the rest as skipped, with the reason (it prints `ran 7, skipped 165 (of
172)`). It runs a `compile` case with a JSON input and none of `patch`,
`modules`, `lock`, `subprogram`, `amendment` and `base`, when it expects `ok`
with `hashes` and no diagnostics (E0104c, P01a, S10a, S10b, S11a, S11b, S11m): the
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
