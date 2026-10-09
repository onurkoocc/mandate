# Mandate

Mandate is an agent-native coordination and contract language. Agents write
and edit programs; people review them through generated views; the compiler
checks capabilities, effects, budgets, contracts and delegation before
anything runs. This repository holds the 0.1 reference implementation.

## Status

0.1 is being built in four steps:

1. **Compiler core (done):** canonical IR with a closed JSON Schema,
   strict JSON reading, JCS + SHA-256 hashing, the `.mdt` text projection
   (parser and printer), name resolution, JSON diagnostics with repair
   patches, IR patches with `stale_base`, and the `mandate` CLI.
2. **Static checks, Gate 1 (done):** epistemic types and data
   classes, effects, capabilities and disjoint writes, budgets, delegation,
   contracts and supervision. See [`spec/checks.md`](spec/checks.md).
3. **Runtime, Gate 2 (done):** TypeScript + Temporal + PostgreSQL;
   event journal, prepare → authorize → commit, budget reservations,
   supervision, cancellation, replay, Temporal scheduling, and simulated
   adapters with fault injection. See [`spec/runtime.md`](spec/runtime.md).
4. **End to end (done):** the FixBug workflow running against simulated
   adapters, directly and through Temporal; sandbox requirements and an MXC
   adapter, see [`spec/sandbox.md`](spec/sandbox.md); and the compact core
   spec, [`spec/core.md`](spec/core.md).

Start with [`spec/core.md`](spec/core.md): the language on one page, small
enough for an agent's context.

## Layout

```text
spec/        core spec, IR schema and rules, static checks, diagnostic codes, runtime, sandboxes
compiler/    reference compiler (TypeScript)
runtime/     reference runtime (TypeScript, PostgreSQL or in-process PGlite)
examples/    example programs; fixbug/ is the design document's §20 workflow
```

## Using the compiler

```sh
npm install
npm run build
node compiler/dist/cli.js check examples/fixbug/fixbug.mdt
node compiler/dist/cli.js check examples/fixbug/fixbug.ir.json --json
node compiler/dist/cli.js fmt examples/fixbug/fixbug.ir.json
node compiler/dist/cli.js sandbox examples/fixbug/fixbug.mdt --agent Implementer
node compiler/dist/cli.js explain E0320
npm test
```

| Command | Does |
|---|---|
| `check <file> [--json]` | Validate, resolve and statically check a `.mdt` or `.json` program; print its diagnostics and hash |
| `ir <file> [--canonical]` | Print the canonical IR (pretty, or exact JCS bytes) |
| `fmt <file>` | Print the `.mdt` projection of a program |
| `hash <file>` | Print the program hash and one hash per definition |
| `patch <program> <patch.json> [--json]` | Apply `{ "base": "sha256:…", "ops": [ … ] }` |
| `sandbox <file> [--agent <name>]` | Print each local agent's sandbox requirement, or one agent's |
| `explain <code>` | Explain a diagnostic code |

Exit status is 1 when an error diagnostic is reported and 2 on usage errors.
Warnings do not change the exit status. FixBug checks with two W0601
warnings: two of its `static` acceptance criteria become run-time checks.

## Conformance

Tests live in `compiler/test`. These conformance cases from the design
document's §25 are covered:

| Case | Rule | Code |
|---|---|---|
| S01 | Duplicate JSON keys are rejected before schema validation | E0102 |
| S02 | Unknown fields and language versions are rejected | E0103, E0104 |
| S03 | References to missing nodes are rejected | E0120 |
| S04 | Call cycles are rejected | E0502 |
| S05 | A switch must handle every variant | E0230 |
| S06 | Unbounded iteration is rejected | E0502 |
| S07 | No external write inside a function or skill | E0408 |
| S08 | Programs cannot produce Evidence, Authorization, Receipt or Verified | E0213 |
| S10 | Key order does not change the hash | — |
| S11 | No silent Unicode or number normalization | E0106, E0107 |
| S12 | A patch against a stale base is rejected | E0130 |
| V01 | `Inferred<T>` cannot reach a critical effect | E0210 |
| V02 | `Untrusted<T>` cannot reach the instruction part of a prompt | E0215 |
| V03 | `par` branches cannot write overlapping scopes | E0320 |
| V04 | Restricted data cannot reach a model that may not receive it | E0220 |
| V05 | No dynamic `spawn` in 0.1 | E0711 |
| V06 | `UnknownOutcome` is reconciled, never restarted | E0712 |
| V07 | A switch on a decision handles `Uncertain` | E0230 |
| V08 | A decision cannot reach a critical effect directly | E0210 |

S09 (load-time verification) is covered by the runtime, below.
`compiler/test/static.test.ts` also checks the §20 FixBug table: 18.5 USD of
child budgets inside 20 USD, delegated capabilities inside the workflow's,
disjoint writes for the two parallel agents, step limits, review never
counted alone, and a verified, idempotent PR. It also applies one mutation
per rule to FixBug and checks that the rule fires.

## Runtime

The runtime's tests run on in-process PGlite by default. To run them on a
PostgreSQL server instead (one schema per test file):

```sh
MANDATE_TEST_DATABASE_URL=postgresql://user:pass@localhost:5432/db npm test -w runtime
```

`temporal.test.ts` starts a local Temporal dev server. The SDK downloads it,
or `TEMPORAL_CLI_PATH` points at an existing `temporal` binary.

Tests live in `runtime/test`. `temporal.test.ts` drives runs through
Temporal.

`fixbug.test.ts` runs the §20 FixBug workflow end to end on simulated
adapters:

- **Happy path.** Explorer, Planner, then Implementer and TestWriter in
  parallel, then an isolated Reviewer. The acceptance contract is checked,
  and the run waits for the code owner. After the approval it opens exactly
  one PR. The test checks:
  - the evidence for every criterion;
  - the budget table: 18.5 USD of agent budgets reserved within 20 USD,
    11 USD reserved while the two parallel agents run, 11 USD settled;
  - a replay that calls no adapter.
- **A failing check.** It is escalated, and the code owner is never asked.
- **A declined approval.** It is escalated too, and a person's answer to
  the escalation cannot stand in for the evidence: no PR is prepared.
- **An approval past its deadline.** With
  `human.approve(role: "code_owner", deadline: 24h)`, an approval not given
  in time is unmet. This holds whether the clock or a late answer gets
  there first. The run escalates and no PR is prepared.
- **A caller limit below the agents' budgets.** It stops at
  `budget_exceeded` before the Implementer runs, and the workflow's handler
  asks a person. A person raises the limit from 10 to 20 USD (a governance
  change, never past the workflow's own budget) and answers. The run then
  goes on from the Implementer to the PR. Answered without a raise, it
  asks again.

`temporal.test.ts` runs the same workflow under Temporal. The approval
wakes the run, and a worker that crashes after commit still opens one PR.

`sandbox.test.ts` runs FixBug's five agents in five MXC sandboxes, one per
agent. Implementer may write only `/work/repo/src`, and TestWriter only
`/work/repo/test`. A host that cannot enforce a requirement never starts the
agent (G05).

These cases from §25 are covered:

| Case | Behavior | Test file |
|---|---|---|
| R01 | A journaled result is not fetched again after a crash | `recovery` |
| R02 | A committed action survives a crash; idempotent, reconcilable, non-retryable | `recovery` |
| R03 | Duplicate messages are ignored; the same key with another payload is refused | `messages` |
| R04 | A lost response becomes `unknown_outcome` and is reconciled, not retried blindly | `effects` |
| R05 | A non-retryable timeout is never dispatched again | `effects` |
| R06 | A worker with an old fence cannot overwrite the newer result | `recovery` |
| R07 | Two siblings cannot both reserve what only one fits | `budget` |
| R08 | Cancel before commit: nothing is sent | `effects` |
| R09 | Cancel after dispatch: the real result is followed and reported | `effects` |
| R10 | A failed sibling does not end the run while an action is in flight | `effects` |
| R13 | Replay makes no adapter call | `recovery` |
| R14 | Purged payloads make replay report `incomplete_replay` | `recovery` |
| R15 | No dispatch after an approval deadline | `effects` |
| R16 | An unknown charge keeps its reservation until it is settled | `budget` |
| S09 | Unlocked modules, changed packages and failing checks are refused at load | `messages` |
| E0406, E0407 | Commit needs a matching, unconsumed, unexpired authorization | `effects` |
| G05 | A host that cannot enforce the sandbox refuses the agent; no permissive fallback | `sandbox` |

R11 and R12 are about `map`, which the 0.1 IR does not have yet; `budget`
tests that `par` results are bound by branch name instead.
