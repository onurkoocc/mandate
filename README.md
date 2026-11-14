# Mandate

Mandate is an agent-native coordination and contract language. Agents write
and edit programs; people review them through generated views; the compiler
checks capabilities, effects, budgets, contracts and delegation before
anything runs. This repository holds the reference implementation of
versions 0.1 to 0.5, with a Rust port of the compiler beside the TypeScript
one (see [Rust](#rust)).

## Why

Agents now act on real systems: they open pull requests, change customer
records, spend money. Most agent frameworks describe what an agent does. Few
can show, before the first token is spent, what it is allowed to do. Mandate
makes that authority a program, and the compiler and runtime enforce it:

- **Capabilities and effects.** Every write, command, network target and model
  call is declared. A sub-agent gets no more than it is handed, and a host
  that cannot enforce its sandbox never starts it.
- **Budgets.** Tokens, time, spend and steps are reserved up front and settled
  per call. FixBug's five agents fit 49.28 USD inside a 50 USD workflow, and
  the compiler proves it.
- **Contracts with evidence.** Acceptance criteria are met by signed evidence
  bound to the exact bytes it checked. An agent saying "approved" creates no
  authorization.
- **People in the loop as typed steps.** `human.approve` has a role and a
  deadline; a missed deadline escalates, it never passes.
- **Data classes and trust.** Restricted data cannot reach a model that may not
  receive it, and `Untrusted<T>` cannot reach the instruction part of a prompt.
- **Recovery.** An event journal, prepare → authorize → commit, and
  reconciliation of an unknown outcome instead of a blind retry.

## A taste

Excerpt from [`fixtures/fixbug/fixbug.mdt`](fixtures/fixbug/fixbug.mdt), a five-agent
bugfix workflow:

```text
capability RepoRead  = fs.read("/work/repo")
capability SrcWrite  = fs.write("/work/repo/src")
capability Build     = exec(commands: ["mvn"], args_prefix: [["-q", "test"], ["-q", "verify"]])
capability ModelStd  = model.infer(tier: standard)
capability PR        = git.pr("company/backend")

contract FixAccepted(issue: Issue, pr: PullRequestDraft) {
  require issue.reproducible
  accept regression_test "A regression test fails before the fix and passes after it"
    by test.red_then_green(pr.patch, pr.tests)
  accept scope_respected "The change stays inside the task scope"
    by static pr.patch.files ⊆ issue.scope
  accept owner_approved "The code owner approved"
    by human.approve(role: "code_owner")
}

agent Implementer {
  role   "Applies the plan, only in the files it may change."
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget { tokens: 2800k, time: 45m, spend: 17.6 USD, steps: 20 }
}
```

The live acceptance run of 0.2: those five agents on Claude Opus 5.5, each in
its own sandbox, fixed a seeded bug, a person approved from the CLI, and one
pull request was opened, for 0.23 USD.

## Status

0.1 was built in four steps, then Gates 0, 3 and 4 took it to 0.2:

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
5. **Gate 0 (done):** FixBug in Open Agent Spec, with extensions and a
   runtime probe. Agent Spec cannot carry Mandate's guarantees, so the IR
   stays separate.
6. **0.2, Gate 3 (done):** language version 0.2; the lock file
   ([`spec/lock.md`](spec/lock.md)) and W0504; the Anthropic model adapter;
   agent loops with tools from capabilities, progress checks and
   `plan_execute`; MXC sandboxes with Bubblewrap; the GitHub `git.open_pr`
   adapter; the control CLI; and the acceptance run. FixBug's five agents
   on Claude Opus 5.5, each in its own sandbox, fixed a seeded bug in a
   test repository. The contract's tests ran in sandboxes of the runtime's
   own, a person approved from the CLI, and one pull request was opened,
   for 0.23 USD. `gate3.test.ts` rehearses it on simulated models
   (`fixtures/fixbug-target/`).
7. **Gate 4, the rest of 0.2 (done):** evidence and authority against an
   adversarial environment, with no real money or production effect. A
   content-addressed artifact store, with evidence bound to the bytes it
   checked; signed evidence records; acceptance suites pinned to the base
   commit; the thirteen G cases of §25. Human views of programs and runs,
   with a semantic diff ([`spec/views.md`](spec/views.md)); the compiler as
   an MCP server ([`spec/mcp.md`](spec/mcp.md)). A delegation's `timeout`,
   a workflow's `ensures` and a program's `tests`; `escalate` and
   `degrade`; `Throttled` and shared rate limits; durable timers and
   continue-as-new under Temporal; and the Windows sandbox backend with
   learning mode (W0311).

8. **0.3, existing systems (done; design doc 9):**
   language version 0.3. The system model (`component`, `interface`,
   `environment`) lives in the IR and is imported as a module pinned by the
   lock, and capabilities can be written over components. A run starts
   from one base commit per component, recorded in its manifest (R), and
   each agent's sandbox sees only its components. Change sets land one
   change per component as a unit: owners approve their members and an
   approver the set digest, members commit in order, and a partial set
   stops for a person (`git.merge` on GitHub). Boundary evidence checks
   each component's tests, interface specs against the declared change,
   the system end to end on an internal network, and attested or re-run
   CI. Production is read only through a broker in the control plane:
   declared, parameterized queries, data masked by class. A run is
   `live`, `read_only` (prepared, never committed) or `design`, and
   `mandate shadow-diff` compares what two runs would do. An onboarding
   program drafts a system model from the repositories and has it
   checked (specs, calls in the code, commands) and accepted;
   `mandate drift` finds where a model and its repositories disagree.
   A change set's view shows the approved plan, each component's change,
   the evidence matrix, the order and why, and what was real; a change
   outside the plan is an `unplanned_change`.
   See [`spec/system.md`](spec/system.md).
9. **Executors (item 39):** a program's agents can run on Claude Managed
   Agents in Form A. `mandate deploy --target managed-agents` deploys them
   and writes the binding into the lock. ValidateBinding runs before every
   run. Each delegation is one session, and every tool is a custom tool
   that the runtime runs in the agent's own sandbox (the bridge, K79), so
   the loop's checks, the journal and the budget hold as for a local loop.
   See [`spec/executors.md`](spec/executors.md).
10. **ACS target (item 40):** `mandate target acs` writes each agent's
   per-call rules as an Agent Control Specification manifest and generated
   Rego, for Microsoft AGT hosts. The Rego fails closed, is bound to the
   package hash, and comes with the profile of what one call cannot show.

11. **0.4, Envelope:** a person approves an
   envelope once (authority, budget, agents, data class, the effects a
   person authorizes), and a lead agent writes sub-programs that run only
   when the compiler shows they fit what is left of it. `map` with bounds
   and disjoint writes, roles bound to people's keys in the lock, and a
   signed record for every decision. A decision
   is a record its member signs with `--key`, and `mandate
   verify-decision` checks one without the runtime. A workflow with an
   envelope starts only once a member of its owner role has signed the
   package hash its card shows (`mandate view --card`, `mandate
   approve-envelope`), and every delegation attempt is one of the
   envelope's agents. A `map` runs its body once for each element of a
   list, at most `par` at a time, each item with the write scope its
   element chooses, and gives the outcomes in input order. A `plan` runs
   a lead agent whose sub-programs are checked within limits, admitted
   only when they fit what is left of the envelope, with their whole
   budget reserved, and run inside the same run; a finished run replays
   them from the artifact store. A lead may ask for a wider envelope:
   the run waits for the owner's signed decision (`mandate amend`), goes
   on under the new package, and what ran before stands as it was
   recorded. `mandate show` shows what is left of the envelope, what each
   lead submitted with every admitted sub-program as text, each map item's
   outcome, and for every decision its member, its role and whether its
   signature holds. See [`spec/envelope.md`](spec/envelope.md).

12. **0.5, Boundary:** the runtime's border with the outside world,
    specified in [`spec/boundary.md`](spec/boundary.md). Everything the
    release includes is implemented in the TypeScript implementation, and
    the Rust compiler gives every fixture the same hashes and diagnostics.

    - **Language and lock.** In language 0.5 `net.https` may allow only some
      methods (`methods: [GET]`, E1801), narrowing holds by them, and a
      program of 0.1 to 0.4 cannot import a limit without it (E1804). Lock
      format 0.5 adds `host`, `isolation` and `egress` (E1802, E1803), and
      `view --against` shows their changes. A 0.5 program gets sandbox
      requirement 0.2.
    - **The egress proxy.** The reference proxy (`mandate egress serve`) is
      the only way out. It puts a credential into a request on its way, so a
      sandbox sees a placeholder. The runtime's own model and GitHub
      adapters go through it holding placeholders (the gateways). A sandbox
      on Linux reaches its agent's hosts through it, only those, with only
      the methods its capability allows, and what the proxy denies a tool
      call is a violation. A host that does not reach the proxy (Windows, or
      Linux without MXC's proxy enforcement) refuses by name a requirement
      with hosts, method limits or credentials.
    - **Isolation and hosts.** A sandbox host reports the isolation level it
      gives and whether it may share its machine, and the adapter refuses by
      name a requirement whose level or no-sharing the host does not give
      (every host here gives `process`, shared). A run whose lock names
      least tool versions starts and resumes only on a host that meets them
      (`unfit_host`); under Temporal that host is the worker's, not the
      caller's. The attestation a check needs is read from the program
      and the configuration, not from the record, and the processes the
      runtime starts get a filtered environment.
    - **The journal.** It is hash-chained, with an anchor signed at every
      state change. `mandate journal export` and `verify` check it without
      the runtime, and `crates/verify-journal`, written in Rust from
      [`spec/journal.md`](spec/journal.md), does too.
    - **Violations and halt.** An agent's tool call refused for its
      authority, or a request the proxy denied, is a `violation` event, once
      per step, and a run stops at its limit (3 for a 0.5 package).
      `mandate halt` ends every open run of a tenant, or of all, in one
      transaction, cuts the proxy's sessions when the configuration names
      one, and refuses starts and resumes until `mandate halt --lift`.
    - **Views and telemetry.** `mandate show --role R` shows a run as one of
      its program's roles may see it, and `--audit` everything, with its
      events and the chain's status. `mandate otel export` posts a run's
      journal to an OpenTelemetry collector as spans without content.

    Left out by decision: a command line, the envelope card, the ACS/Rego
    target and the MCP server in Rust (see [Rust](#rust)), new isolation
    backends, sandbox egress on Windows, TLS interception, `git`, database
    and container-engine traffic through the proxy, and masking by data class
    in views.

Start with [`spec/core.md`](spec/core.md): the language on one page, small
enough for an agent's context.

## Layout

```text
spec/        core spec, IR schema and rules, static checks, diagnostic codes, the lock, runtime,
             sandboxes, executors, views, the compiler's MCP server, the system model (0.3),
             the envelope (0.4), and the boundary, egress and journal (0.5)
compiler/    reference compiler (TypeScript)
runtime/     reference runtime (TypeScript, PostgreSQL or in-process PGlite)
crates/      the Rust compiler as a library, and verify-journal (below)
fixtures/    the tests' programs: fixbug/ is the design document's §20 workflow,
             fixbug-target/ the same workflow bound to a seeded test project,
             system/ a fictional system's model (Acme) and programs over it,
             envelope/ the 0.4 migration, boundary/ a 0.5 agent that may only GET
conformance/ language-independent compile and journal cases
vectors/     what the TypeScript reader, canonical text and hashes give, for
             other implementations to match
```

## Rust

The repository is also a Cargo workspace (`Cargo.toml`, `crates/`): a Rust
port of the compiler, and an independent journal verifier. The compiler is
a library; it has no command line.

- [`crates/mandate-ir`](crates/mandate-ir/README.md): the IR as a value in
  JavaScript's member order, the strict JSON reader, canonical JSON (RFC
  8785) and the program, definition and package hashes, the schema
  validator for the IR and the lock with the version gates, and the
  diagnostic type.
- `crates/mandate-syntax`: the lexer, the parser, the source map and the
  printer (`fmt`).
- `crates/mandate-check`: modules and linking, name resolution, roles,
  capabilities and the standard library's tables, the static checks (types,
  cost, authority, the system model), the lock checks, the Managed Agents
  binding checks, the sandbox requirements, structural patches, the
  semantic diff, and the front doors `check`, `check_patch`,
  `check_subprogram` and `check_amendment`.
- `crates/mandate-views`: the document model with Markdown and HTML, the
  views of a program (architecture, authority, cost, system) and the diff
  view.
- `crates/mandate-lib`, `crates/mandate-doors`, `crates/mandate-wasm` and
  `crates/mandate-cli`: empty for now, the places release 0.6 fills: the
  model of a library (its manifest, its digest and its version rules), the
  JSON doors (one dispatcher over the compiler's functions), the compiler as
  a `wasm32-wasip1` command module for the Node runtime to call, and the
  native command line.
- `crates/mandate-testkit`: tests only, the gates that hold the crates
  above to the TypeScript compiler.

The Rust compiler is held to the TypeScript one byte for byte, by tests
that run in CI natively and as WebAssembly (`wasm32-wasip1`, under Node's
WASI):

- all 231 pinned outputs of `compiler/test/golden/outputs.json` (21
  programs, ten to twelve outputs each), by `sha256`;
- all 125 `compile` cases of `conformance/`;
- the stored results in [`vectors/`](vectors/README.md): the syntax and
  span vectors, the schema vectors, 193 diagnostic vectors, 183 diff
  vectors, and the compiled corpus (1,226 calls the TypeScript tests make
  to the compiler's front doors; 1,224 are replayed, the 2 of the ACS/Rego
  target are not);
- written inputs for branches no stored result reaches, answered by the
  built TypeScript compiler in CI on every run (`scripts/*-vectors.mjs`).

A diagnostic is the same when its code, severity, message, location,
`docs`, `facts` and `repair` are the same and it is in the same place in
the order. A few written inputs are known to differ; the tests list them by
name, and [`vectors/README.md`](vectors/README.md) lists them too ("Where
the Rust compiler is not held to the TypeScript").

What stays in TypeScript, and starts the plan for 0.6: the runtime and the
`mandate` CLI use the TypeScript compiler, and the envelope card
(`mandate view --card`), the ACS/Rego target and the MCP server are not
ported.

`crates/verify-journal` verifies an exported run journal from the file and
public keys alone, written from [`spec/journal.md`](spec/journal.md) rather
than from the TypeScript: the export's reading rules and limits, the
canonical form of runtime values (numbers as ECMAScript writes them), the
event hashes, Ed25519 anchors and the package hashes (through `mandate-ir`).
It prints the same report as `mandate journal verify --json`, byte for byte,
and exits as it does (0 verified, 1 broken or unchained, 2 nothing checked).
It runs every journal case (J01–J16), and CI also has it verify a fresh
export of a real run of the TypeScript runtime, and the same export with one
event changed. Its one dependency beyond `sha2` is `ed25519-compact` (pure
Rust, no dependencies of its own, no build script).

```sh
cargo run -p verify-journal -- run.json --key cp.pub.pem
```

The stored results in `vectors/` and the cases in `conformance/` hold the
crates to the TypeScript. `compiler/test/vectors.test.ts` writes the
vectors and fails when the committed ones differ; the Rust tests read them and need no Node.

```sh
cargo test --locked                       # where native executables may run
node scripts/wasi-test.mjs -p mandate-check -- --nocapture   # anywhere: as WebAssembly under Node
MANDATE_UPDATE_VECTORS=1 npm test         # write vectors/ again after a change
```

The second form needs the `wasm32-wasip1` target of the pinned toolchain
(`rust-toolchain.toml` lists it); `scripts/wasi-test.mjs` takes any `cargo
test` arguments before `--` and libtest arguments after it.

CI's `rust` job runs `cargo fmt --check`, `cargo clippy --all-targets
--locked -- -D warnings`, the native tests, the WebAssembly builds and
tests, steps that fail when committed expectations are not what the
TypeScript compiler gives now, and the fresh export check
(`runtime/scripts/journal-fresh.mjs`). A `parity` job writes both
compilers' golden output texts into two directories and fails on any
difference.

## Using the compiler

```sh
npm install
npm run build
node compiler/dist/cli.js check fixtures/fixbug/fixbug.mdt
node compiler/dist/cli.js check fixtures/fixbug/fixbug.ir.json --json
node compiler/dist/cli.js fmt fixtures/fixbug/fixbug.ir.json
node compiler/dist/cli.js sandbox fixtures/fixbug/fixbug.mdt --agent Implementer
node compiler/dist/cli.js explain E0320
npm test
```

| Command | Does |
|---|---|
| `check <file> [--json] [--module <file>]…` | Validate, resolve and statically check a `.mdt` or `.json` program, with the modules it imports (a system model); print its diagnostics and hash |
| `ir <file> [--canonical]` | Print the canonical IR (pretty, or exact JCS bytes) |
| `fmt <file>` | Print the `.mdt` projection of a program |
| `hash <file>` | Print the program hash and one hash per definition |
| `patch <program> <patch.json> [--json]` | Apply `{ "base": "sha256:…", "ops": [ … ] }` |
| `sandbox <file> [--agent <name>]` | Print each local agent's sandbox requirement, or one agent's |
| `explain <code>` | Explain a diagnostic code |
| `test <file> [--json]` | Run the program's tests against their effect handlers (§6.4) |
| `mcp` | Serve `check`, `explain`, `apply_patch`, authority and views to agents over MCP on stdio ([`spec/mcp.md`](spec/mcp.md)) |
| `target acs <file> [--out <dir>]` | Each agent's ACS manifest, Rego policy and sandbox requirement, for an AGT host ([`spec/executors.md`](spec/executors.md)) |
| `view <file> [--against <old>] [--format md\|html\|json]` | The program's views: architecture, authority, cost; with `--against`, what changed ([`spec/views.md`](spec/views.md)) |

Exit status is 1 when an error diagnostic is reported and 2 on usage errors.
Warnings do not change the exit status. FixBug checks with two W0601
warnings: two of its `static` acceptance criteria become run-time checks.

## Conformance

Tests live in `compiler/test`. These conformance cases from the design
document's §25 are covered. The last column names the case files in
[`conformance/`](conformance/README.md) that say the claim for any
implementation. The vitest tests stay, and say more where a claim is about a
message, a position or an API:

| Case | Rule | Code | Case files |
|---|---|---|---|
| S01 | Duplicate JSON keys are rejected before schema validation | E0102 | `S01` |
| S02 | Unknown fields and language versions are rejected | E0103, E0104 | `S02a`–`S02e` |
| S03 | References to missing nodes are rejected | E0120 | `S03a`–`S03i` |
| S04 | Call cycles are rejected | E0502 | `S04a` |
| S05 | A switch must handle every variant | E0230 | `S05a`, `S05b` |
| S06 | Unbounded iteration is rejected | E0502 | `S06a`, `S06b` |
| S07 | No external write inside a function or skill | E0408 | `S07a`, `S07b` |
| S08 | Programs cannot produce Evidence, Authorization, Receipt or Verified | E0213 | `S08a`–`S08d` |
| S10 | Key order does not change the hash | — | `S10a`–`S10d` |
| S11 | No silent Unicode or number normalization | E0106, E0107 | `S11a`–`S11m` |
| S12 | A patch against a stale base is rejected | E0130 | `S12a`–`S12d` |
| V01 | `Inferred<T>` cannot reach a critical effect | E0210 | `V01a`–`V01e` |
| V02 | `Untrusted<T>` cannot reach the instruction part of a prompt | E0215 | `V02a`, `V02b` |
| V03 | `par` branches cannot write overlapping scopes | E0320 | `V03`, `V03b`–`V03d` |
| V04 | Restricted data cannot reach a model that may not receive it | E0220 | `V04a`–`V04c` |
| V05 | No dynamic `spawn` in 0.1 | E0711 | `V05a` |
| V06 | `UnknownOutcome` is reconciled, never restarted | E0712 | `V06a`, `V06b` |
| V07 | A switch on a decision handles `Uncertain` | E0230 | `V07a` |
| V08 | A decision cannot reach a critical effect directly | E0210 | `V08a` |
| V20 | A text literal stands for a `Path` only if it is relative and normalized (K68) | E0204 | `V20a`–`V20e` |

S09 (load-time verification) is covered by the runtime, below.
`compiler/test/mcp.test.ts` checks the compiler's MCP server (§14): its
tools, a patch whose budget raise is flagged for approval, a stale base,
MCP 2026-07-28 discovery and version errors, a legacy `initialize`
client, and `mandate mcp` on stdio.
`compiler/test/views.test.ts` checks the views of FixBug (architecture,
authority, cost) against §15, and the semantic diff between two versions:
governance apart from behavior, and a new network target shown as a
governance change (G11).
`compiler/test/system.test.ts` checks the system model (design doc 9 §2):
Acme's model and its view, one mutation per rule (E1001–E1005), programs
that import it and write capabilities over its components, C5 across
components, the lock's pin (E0142), and changes to the model reported as
governance changes.
`compiler/test/changeset.test.ts` checks change sets (design doc 9 §3):
the order against the interface graph (E1101), the order and its members
(E1102), breaking changes (E1103), critical members (E1104), a verified
plan (E1105), and each member's repository held by the workflow (E0301).
`compiler/test/reads.test.ts` checks declared reads (design doc 9 §5):
a read of the environment's, its parameters by name (E1201), masking
by class (E0220 without it, E0201 for a field needed unmasked), and
data.read authority (E0301).
`compiler/test/executors.test.ts` checks executor bindings in the lock
([`spec/executors.md`](spec/executors.md)): strict reading (E0140), X01 a
binding that no longer fits (E0903), X02 the output ceiling (E0904), and
X03 the data class (E0905).
`compiler/test/acs.test.ts` checks the ACS target (X05): one manifest and
bundle per agent bound to the package hash, W0907 and E0906, and, with
`MANDATE_OPA`, the generated Rego on a real OPA. The CI job `test` sets it
to OPA 1.4.2, the static Linux binary of the release, checked against its
published sha256, and fails the step if any test of the file was skipped.
`compiler/test/static.test.ts` also checks the §20 FixBug table: 49.28 USD of
child budgets inside 50 USD, delegated capabilities inside the workflow's,
disjoint writes for the two parallel agents, step limits, review never
counted alone, and a verified, idempotent PR. It also applies one mutation
per rule to FixBug and checks that the rule fires.
`compiler/test/surface05.test.ts` checks the compile-time surface of 0.5
([`spec/boundary.md`](spec/boundary.md)): `methods` read from 0.5 only,
the 0.1 fixture that writes them included, narrowing by them, E1801 to
E1803, lock format 0.5 and its changes in `view --against`, sandbox
requirement 0.2 and its byte-identity below 0.5, and a 0.5 parent's
sub-programs. The cases `E1801` to `E1804` in `conformance/` say the
compile-time rules for any implementation.

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
  - the budget table: 49.28 USD of agent budgets reserved within 50 USD,
    and 11 USD settled;
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
  asks a person. A person raises the limit from 12 to 50 USD (a governance
  change, never past the workflow's own budget) and answers. The run then
  goes on from the Implementer to the PR. Answered without a raise, it
  asks again.

`temporal.test.ts` runs the same workflow under Temporal. The approval
wakes the run, and a worker that crashes after commit still opens one PR.
A restart's backoff waits on a durable Temporal timer, not in an activity,
and a run that waits many times continues as a new execution without
losing anything.

`loop.test.ts` runs bodiless skills as agent loops (0.2) against a scripted
model and a simulated sandbox. It checks:

- the tools derived from the grant;
- every turn and tool call journaled and charged to the delegation;
- the progress checks (V11 and `stall`);
- schema repair and the steps limit;
- `plan_execute` (V16);
- recovery after a crash, and replay with no adapter call.

`anthropic.test.ts` checks the Anthropic model adapter against a fake
client: the locked model and effort it sends, the reservation from a
counted input, the settlement from the reported usage, and the journaled
snapshot. `live.test.ts` makes one real call, and only runs with
`MANDATE_LIVE=1` (see below).

`mxc.test.ts` checks the real sandbox host, MXC with Bubblewrap. Against a
fake SDK it checks what the host asks MXC for and what it refuses. On Linux
with `MANDATE_MXC=1` (the CI job `sandbox`, on Ubuntu 22.04 and 24.04), it
checks the blocking itself: writes outside the grant, reads outside it,
network, the environment, no service socket of the host, and an agent loop
working through the sandbox.

`container.test.ts` checks the container sandbox host: against a fake
Docker everywhere, and, with `MANDATE_CONTAINER=1` and a Linux Docker
engine, against a real one (the tools inside the grant, a read-only part of
it that cannot be written, no network, a hung process killed at its
timeout). The CI job `sandbox` runs it on the runner's Docker, with the two
images named by digest in the test. Known limit, not fixed: the container's
process is root with every capability dropped, so on a native Linux engine
it cannot write a write path that only its owner may write; the test gives
its scratch write path mode 777 and pins the refusal in a test of its own,
which is skipped on Docker Desktop and rootless engines. An operator today
gives the container a workspace its process can write
([`spec/runtime.md`](spec/runtime.md)).

`artifacts.test.ts` checks the artifact store and the binding of evidence
to what it checked: a test records the files it ran against, an action
applies the files frozen at prepare, and a file changed after its test is
never committed on the old evidence (G01). Another run's or tenant's
artifact is refused like a missing one (G08).

`enforce.test.ts` checks what 0.1 only checked statically: a delegation's
`timeout`, in a loop and in a single call, with a restart that gets a
deadline of its own, and a workflow's `ensures`. `tests.test.ts` runs
FixBug's own tests (§6.4) against recorded answers, an in-memory working
copy, a fake git and an automatic code owner, and fails a test whose
handler is unknown.

`supervision.test.ts` checks `escalate(human)` (a person answers `retry`
or lets the failure stand) and `degrade(to: F)` (the job handed once to a
narrower fallback), and `Throttled` (V14): a throttled call waits and is
sent again without counting as an attempt, without holding its
reservation and without a `BudgetExceeded`; a shared token bucket makes a
second run wait, and refuses outright when its queue is full.

`gate4.test.ts` lists Gate 4's thirteen cases (§25, G01–G13) and G14, and
where each is tested, and holds those without a home of their own: G02,
G03, G04, G12, G13 and G14's type layer. G14 (K68) is that a path an agent
names cannot take the control plane out of the working copy, in two lines:
the `Path` type (a model's answer, a run's input and a text literal keep
the rule; [`spec/core.md`](spec/core.md#paths)) and the check where the
runtime uses a path (`paths.ts`).

`views.test.ts` checks a run's views (§15): status, evidence and cost
under the program's hash; a reviewer's markup shown as plain text (G09);
and a view the run has moved past, whose decision is refused (G10).

`evidence.test.ts` checks the signed evidence records (§10.3): who
produced each, what it ran against, its logs as artifacts, a valid
signature by the control plane's key, a record changed after signing shown
as invalid, and a Verified value whose evidence no longer verifies refused
before anything is prepared. `verifier.test.ts` checks the runtime's
verifier, including a pinned acceptance suite an agent tried to weaken
(G06). `verifier-process.test.ts` runs the verifier as a process of its
own: each check comes back signed by the verifier's key, and a result
changed on the way or signed by an untrusted key is not met. A record the
runtime's key signed again after its content was changed, after its
attestation was taken out, or after its method was changed to `static` or
to one the runtime checks itself, is invalid, and the effect resting on it
is refused (`forged_evidence`); so is a criterion `a and b` whose verifier
part has no record of its own. An attestation names the run, contract,
criterion, method and part it was made for: one copied onto a record of
another criterion, of the other part of `m(a) and m(b)`, or of a later
run is invalid, and so is one in the format before 0.2; a verifier that
signs for another part, or in the old format, does not meet the
criterion. Evidence made before the verifier had a process of its own, or
attested before 0.2, shows as invalid once it has. The verifier process
gets none of the runtime's secrets, and the model's key only when the
configuration has a model and no model gateway (with one, a gateway
session's address and placeholder). `audience.test.ts` lands a change set on
boundary checks the runtime makes itself with a verifier key trusted, and
`child-env.test.ts` checks that `docker` gets none of the runtime's
secrets.
`evidence.test.ts` also rotates the evidence key: what the old key signed
still verifies.

`loop.test.ts` also cancels a run while its agent's process hangs: the
sandbox is stopped at once (§16.1 Stop), not left to the process's timeout.

`mxc-windows.test.ts` checks the Windows sandbox host, MXC with the
AppContainer process container (P2-27). Against a fake SDK it checks the
build thresholds, session isolation refused by name, the request MXC gets,
and learning mode's denials carried from a run to W0311. On Windows with
`MANDATE_MXC=1` (the CI job `sandbox-windows`) it repeats the Linux
blocking tests against a real AppContainer, and also checks the clipboard
and learning mode. It also measures from inside the AppContainer that a
named pipe and a TCP listener on the loopback address (IPv4 and IPv6), both
served by the test process, cannot be reached, each against the same attempt
from outside the sandbox, which does reach them. That job also runs
`paths.test.ts`, `child-env.test.ts` and `egress-cli.test.ts`, whose Windows
branches run only there.

`mandate egress serve --config mandate.egress.json` runs the reference
egress proxy of 0.5 ([`spec/egress.md`](spec/egress.md)). The operator
starts it with the secrets in its own environment; a session gets
placeholders, and the proxy swaps one for its secret only in the
configured header, toward the hosts its configuration binds the credential
to, over TLS. It needs no database and no runtime configuration.
`egress-*.test.ts` check each of its rules against an in-process upstream;
on Linux with `openssl`, `egress-tls.test.ts` also goes through real TLS
with a certificate made when it runs.

The runtime's own adapters go through it when `mandate.runtime.json` turns
its gateways on:

```json
"egress": { "admin": "/run/mandate/egress.sock", "gateways": { "model": "anthropic", "github": "github" } }
```

Each gateway names the credential the proxy holds for it: for `model`,
sent in `x-api-key` as `{secret}`, toward `api.anthropic.com`; for
`github`, in `authorization` as `Bearer {secret}`, toward `api.github.com`.
The model adapter, the Managed Agents executor, `git.open_pr`, `git.merge`
and the boundary verifier's CI source then hold a placeholder, never the
secret, and a command that can run an adapter refuses to start while the
gateway's secret is in its own environment (`credential_in_environment`:
`CLAUDE_API_KEY` or `ANTHROPIC_API_KEY`; `MANDATE_GITHUB_TOKEN`). `status`,
`show`, `denials`, `artifact`, `decision`, `shadow-diff` and `replay` hold no
adapter that could use it and run with the secret in the environment, as
`halt` does; `cancel` is refused, and its message points to `mandate halt`.
The verifier process gets a
session of its own and its placeholder. A start is refused when the proxy
does not answer or lacks a gateway's credential (`egress_unavailable`); a
cancelled run's sessions are revoked; `status`, `show` and `replay` never
reach the proxy. `egress-gateways.test.ts` checks it against the
in-process proxy and upstream ([`spec/boundary.md`](spec/boundary.md#the-control-planes-gateways)).

With `egress.admin` set, a sandbox on Linux reaches its agent's hosts
through the proxy too, in a forward session of its own for exactly those
hosts, their methods and the credentials the lock's `egress` binds. The
sandbox's processes find each credential's placeholder in
`MANDATE_EGRESS_PLACEHOLDER_<NAME>`, and reach a host with a credential or
a method limit as `http://host/…`, which the proxy sends on over TLS. A
package whose lock binds a credential does not start without a proxy
(`no_egress_proxy`), nor when the proxy does not answer or lacks the
credential (`egress_unavailable`)
([`spec/boundary.md`](spec/boundary.md#sandbox-egress)).

`github.test.ts` checks the `git.open_pr` adapter for GitHub against an
in-memory GitHub:

- FixBug opens one pull request with the verified files;
- a lost response is reconciled to that one pull request;
- a request that never arrived is sent again without opening a second one;
- a cancelled run resolves an action that never took effect;
- the pull request carries the files frozen at prepare, even if the working
  copy changes while the action waits for authorization;
- a program bound to another repository does not start.

`live.test.ts` repeats the lost response against the real test repository
when `MANDATE_GITHUB_TOKEN` is set.

The brownfield tests run on the Acme fixture, a fictional system of six
components (design doc 9 §12):

- `system.test.ts` and `workspace.test.ts` (B2, B3): the run manifest, and
  two components written in parallel, each agent seeing only its own. On
  CI, the sandbox jobs repeat this in real Bubblewrap and AppContainer
  sandboxes.
- `changeset.test.ts` (B4): owners, then the set digest; an ordered commit;
  an unknown middle member stops the set as `changeset_partial`, and
  reconciliation continues it. The change set view (B8): plan, changes,
  evidence matrix, order and why, in live, read_only and design runs.
- `specdiff.test.ts`, `boundary.test.ts` and `audience.test.ts` (B5):
  task class 3, caught only end to end. An interface change the plan
  does not name is an `unplanned_change` (B8).
- `broker.test.ts` (B6): the incident review, read_only and masked, with
  a replay that never asks the broker; and `shadow-diff`.
- `onboard.test.ts` (B7): Acme's model drafted from generated
  repositories, checked and landed; the fixture model's deliberate drift
  found by `mandate drift` and by `test.consumes`.
- `environment.test.ts` (B9): an environment's tier is never lowered;
  prod_sim's deploy waits for the release manager although the run's
  policy says policy.
- `governance.test.ts` (K70, item 46): a change that loosens core's CI does
  not land until core's owner approves it, although the run's policy
  authorizes `git.merge`. The owner decides before a member's own approver,
  for core's own `deploy/**` too. A pull request that changes agent
  settings waits for the owner outside any system model. The change set
  view shows governance-class files as a class of their own.

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
| G01 | A file changed after its test cannot be committed on the old evidence | `artifacts` |
| G02 | A decision or authorization applies only to the digest of what was shown | `gate4`, `effects`, `fixbug` |
| G03 | An agent that says "approved" creates no authorization; a Verified value whose evidence does not verify is refused | `gate4`, `evidence` |
| G04 | A sub-agent gets no more than it is handed: its sandbox and tools are narrowed to the grant | `gate4` (and E0701 statically) |
| G05 | A host that cannot enforce the sandbox refuses the agent; no permissive fallback | `sandbox`, `loop`, `mxc`, `mxc-windows` |
| G06 | A pinned acceptance suite runs as the base commit has it, whatever the agents changed; a check its verifier did not sign is not met, and with a verifier process configured, a record of a verifier check without that verifier's attestation for that run, criterion and part, or with a method its criterion does not declare, is invalid, whatever key signed it | `verifier`, `verifier-process`, `audience` |
| G07 | A sandboxed process reaches no host (on Linux, not through a service socket of the host either), and gets none of the runtime's credentials | `mxc` (Bubblewrap, CI job `sandbox`), `mxc-windows` (AppContainer, CI job `sandbox-windows`) |
| G08 | Another tenant's or run's artifact is refused like a missing one | `artifacts` |
| G09 | A model's markup is shown as plain text in every view, never as a control: an agent's output, a name somebody typed, a lead's sub-program and its reason for an amendment | `views`, `views-envelope`, `cli-amend` |
| G10 | A view the run has moved past says so, and a decision taken on it is refused | `views` |
| G11 | A new network target shows in the semantic diff as a governance change | `views` (compiler) |
| G12 | A remote agent without idempotent delivery: refused if required, else sent at most once | `gate4` |
| G13 | One authorization is consumed by one commit; a second is refused | `gate4`, `effects` |
| G14 | A path an agent names that leaves the working copy, is absolute or is not portable is refused: as a model's answer, a skill's result or a run's input by its type, and where the runtime uses it, without following a link | `gate4`, `loop` (the type); `paths`, `verifier`, `boundary` (the use site) |
| G15 | An agent that may GET a host gets its GET through the egress proxy; its POST there, and any request to another host, are denied and are one violation of the tool call; a host that does not reach the proxy refuses method limits by name | `sandbox-egress`, `boundary-acceptance` (and on the runner's Bubblewrap, CI job `sandbox`), `fail-closed` |
| G16 | A sandbox's environment and requests hold the placeholder, never the secret, and the upstream gets the secret; a placeholder outside its header is denied; a credential the proxy does not hold for the host is refused by name | `sandbox-egress`, `boundary-acceptance` (and on the runner's Bubblewrap, CI job `sandbox`) |
| G17 | A host that resolves to a private, loopback, link-local or metadata address is refused when any of its addresses is one, and the connection goes to the address that was checked; a redirect is returned, not followed | `egress-forward`, `egress-gateway` |
| G18 | With a gateway on, a runtime with that gateway's credential in its environment is refused, naming the variable and never its value; its adapters hold a placeholder and the upstream gets the secret; the verifier's process gets a session of its own and no key | `egress-gateways` |
| G19 | A host below the lock's least tool versions, with a tool it cannot read, or with a setuid `bwrap`, starts and resumes nothing of the package: refused before the lease, and the run is left as it was | `fitness`, `mxc` (the runner's Bubblewrap, CI job `sandbox`) |
| G20 | A requirement whose isolation level or no-sharing the host does not give is refused by name, and the agent is not started | `isolation`, `mxc`, `mxc-windows`, `container` |
| V11 | The same tool call three times in the window stops the loop with `Stuck` before it runs again | `loop` |
| V14 | A throttled call waits and is sent again; no restart is counted and no BudgetExceeded is raised | `supervision`, `anthropic` |
| V16 | A `plan_execute` plan with a tool the agent does not have is never run | `loop` |
| X01 | A package whose executor binding no longer fits its lock is refused at load; a changed agent or environment fails ValidateBinding; a bound agent never runs without its executor | `managed-agents` (and E0903 in the compiler) |
| X04 | A bound agent's turns run in its delegation's session and its tools in the runtime's sandbox, journaled; replay calls neither | `managed-agents` |
| R11 | A map's results are in input order, whatever order its items finish in | `map` |
| R12 | A failed map item is that item's outcome, and the others go on | `map` |
| N01 | A sub-program whose capabilities or budget exceed what is left of the envelope is not admitted, and nothing of it runs | `plan`, `demo` (and E1706 in the compiler, `subprogram`, and the cases `N01`, `N01a`, `N01b`) |
| N02 | A delegation or a sub-program that does not fit what is left is refused at reservation, and two siblings cannot both reserve what only one fits: the envelope's last agent, or what is left of a sub-program's own reservation | `envelope`, `plan`, `ledger` |
| N03 | Map items with `par > 1` cannot write overlapping scopes: scopes the map does not hand per item are refused by the compiler, and scopes the elements choose are compared before any item is dispatched | `map` (and E0320 in the compiler, `map-rules`) |
| N04 | An amendment is a new package and only widens the envelope; the owner's signed decision moves the run to it, and an envelope approval, a decision or an authorization given for the old package authorizes nothing under the new one | `amend`, `cli-amend`, `temporal` (and E1709 in the compiler, `amendment`, and the cases `N04`, `E1709`, `E1709a`, `E1709b`, `E1709c`) |
| N05 | A critical effect in a sub-program needs its own authorization, and one under `approve` needs that role's signed decision; admission authorizes nothing | `plan`, `demo`, `temporal` |
| N06 | Replay reads an admitted sub-program from the artifact store, holds it to the hash it was admitted with, runs it against the journal, and calls no model, adapter or checker | `plan`, `demo` |
| N07 | Two sub-programs of one plan with the same effect and business key are one action, and the same key over other parameters is refused | `plan` |
| N08 | A list longer than a map's bound is refused before any item is dispatched | `map` (and E1702 in the compiler, `map-rules`) |
| N09 | A sub-program that defines a contract, an effect, an extern, a role, a remote agent or a system model definition is refused, and nothing of it runs | `plan` (and E1705 in the compiler, `subprogram`, and the cases `N09`, `E1705`, `E1705a`) |
| N10 | A lead's check that runs over a limit in time, memory, size, nesting or operations, or a checker that fails, admits nothing and does not stop the run | `plan` |
| H01 | A decision with no valid signature, an unknown key, or a member outside the role is refused and recorded as `decision_refused`; the wait stays open | `decisions`, `cli-decisions` |
| H02 | `distinct_from` refuses a second approval by the same member, whichever key signs it | `decisions`, `cli-decisions` (and E1503 in the compiler) |
| H03 | A run of an envelope workflow does not start without an approval of its package hash by a member of the envelope's owner role | `envelope`, `cli-envelope` |
| H04 | Evidence for `human.approve` whose decision record was changed after signing shows as invalid, and a `Verified` value resting on it is refused | `decisions` |
| H05 | A changed member, key or role binding in the lock is a new package and shows as a governance change | `lock-diff` (compiler) |
| J01 | A closed run's journal verifies from its export and the public key alone, also over fractions, exponents and keys that sort differently by UTF-16 code units and by code points | `journal-verify`, `cli-journal`, `journal-hash`, `boundary-acceptance` (and the case `J01`) |
| J02 | An event edited in the database breaks the chain at that event | `journal-verify`, `cli-journal`, `boundary-acceptance` (and the case `J02`) |
| J03 | An event deleted from the database leaves a gap and breaks the chain after it | `journal-verify` (and the case `J03`) |
| J04 | A tail cut from the database while its anchors stay names events past the last one | `journal-verify` (and the case `J04`) |
| J05 | An open run with events after its last anchor verifies, and the report says no signature covers them | `journal-verify` (and the case `J05`) |
| J06 | An anchor by a key not given, or whose signature does not verify, is refused | `journal-verify`, `cli-journal` (and the case `J06`) |
| J07 | A manifest or a package that is not the one the first event names is refused | `journal-verify` (and the case `J07`) |
| J08 | A run begun before the chain is reported unchained, never verified | `journal-verify`, `journal-hash` (and the case `J08`) |
| J09 | An export spelled otherwise, with the same values, verifies: the verifier hashes values, not spellings | the case `J09` |
| J10 | An event whose hash was removed is `hash_missing` | `journal-verify` (and the case `J10`) |
| J11 | An anchor over a hash its event does not have is `anchor_mismatch`, however its signature holds | `journal-verify` (and the case `J11`) |
| J12 | A state event without its anchor is `anchor_missing`: removing anchors never makes a run clean | `journal-verify` (and the case `J12`) |
| J13 | Events moved in the export are `seq_gap` and `chain_broken` | the case `J13` |
| J14 | An anchor names the first event with its seq in the export's order | `journal-verify` (and the case `J14`) |
| J15 | An export that is not JSON by the rules is `unreadable`, never `broken` | `journal-verify`, `cli-journal` (and the case `J15`) |
| J16 | A run nested deeper than a verifier reads is journaled, and its export is `unreadable` | `journal-verify`, `cli-journal` (and the case `J16`) |
| G21 | A tool call refused for its authority is one `violation`, malformed input none; the limit stops a 0.5 run at 3, an earlier one only when configured; a resumed run does not count a violation twice and stops again at its next new one | `violations`, `violation-seam`, `tools` |
| G22 | A halt ends every open run of its scope in one transaction, in every state; a result in flight is not written; a start or a resume in the scope is refused before a lease; the adapters revoke after; a lift is recorded with who and brings no run back | `halt`, `cli-halt`, `halt-revoke` |
| G23 | A role's view holds what was asked of that role, how the run ended and its progress, and no other role's decision, no step's request or result and no trace; the audit view shows everything and alone verifies the chain; `mandate show` without options prints what it printed before | `views-role`, `views-default`, `cli-views`, `classes` |
| G24 | The OpenTelemetry export carries no content: its spans are built from an allow-list of identifiers, types, classes, counts, hashes and times; no span is sent twice, and a failed export leaves the run and its cursor as they were | `otel`, `otel-collector` (a real collector, CI job `test`) |
| G25 | Evidence whose required attestation is missing, or was taken out or changed and signed again by the runtime's key, is invalid, whatever its record says; which checks need one is read from the program and the configuration, not from the record | `verifier-process`, `audience` |

The journal is chained ([`spec/journal.md`](spec/journal.md)): each event
carries a hash over its contents and the one before it, and the evidence key
signs an anchor at every state change. `mandate journal export` writes a
run's journal with its manifest and package, `mandate journal key` the
public keys, and `mandate journal verify` checks the export with those
alone. J01–J16 are also cases in `conformance/` that any verifier can run;
the Rust verifier, `crates/verify-journal`, runs every one of them
(`crates/verify-journal/tests/conformance.rs`), so what each row says of a
verifier holds for two implementations.
It is evidence against someone who holds the database but not the key.

`halt.test.ts` halts a tenant with a run in every state a run is in before
it ends: accepted, running with a live lease, waiting for an answer, for a
decision and on a timer, needing attention for an unknown outcome, and
inside a lead's sub-program. Each ends with its journal verifiable, another
tenant's run goes on, a worker that was mid-step cannot write its result,
an action in flight keeps its run `attention_required` (INV-12), starts
and resumes are refused, and the adapters revoke only after the runs have
ended. `mandate halt --tenant T | --all`, `--lift … --by WHO` and `--list`
are the operator's commands ([`spec/boundary.md`](spec/boundary.md#halt)).
`halt-revoke.test.ts` holds the halt to the egress proxy named in
`egress.admin`, with or without gateways, against an in-process proxy: a
halt of a tenant cuts that tenant's sessions and another's keep working, a
halt of every tenant cuts all, the command holds no secret, opens no session
and is not refused for a credential in its environment, `--lift` and
`--list` never connect, and a proxy that is dead or does not answer leaves the
halt in force and the exit 1.

`violations.test.ts` and `violation-seam.test.ts` hold violations
([`spec/boundary.md`](spec/boundary.md#violations)): a tool call refused for
an authority reason, or a step of a plan outside the grant, is one
`violation` event with its kind, delegation, agent, step, detail and count,
for a package of every language; malformed input and the interpreter's
`PolicyDenied` are none; a 0.5 package's run stops at its third as
`attention_required` with `violation_limit`, an earlier package's run only
when `violations.limit` is configured; and a resumed run neither writes nor
counts a violation twice, and stops again at its next new one. The seam an
egress denial is written through is held the same way.

`views-role.test.ts`, `views-default.test.ts`, `cli-views.test.ts` and
`classes.test.ts` hold the views by role and the audit view
([`spec/boundary.md`](spec/boundary.md#views-by-role-and-the-audit-view)). A
role sees what was asked of it, how the run ended and what stopped it, and
its progress, and nothing else: words planted where only a step's result, a
trace or another role's decision can carry them are not in its JSON,
Markdown or HTML. The audit view shows everything, with every event and the
chain's status (verified, broken or unchained), and is the one view that
verifies the chain. `mandate show` without options prints what it printed
before, byte for byte, held by digests taken before the new views were
written. The class table has a class for every event type the runtime
writes, read from its sources, and what it does not name is S4.

`otel.test.ts` holds the OpenTelemetry export
([`spec/boundary.md`](spec/boundary.md#the-opentelemetry-projection))
against a collector in the test's own process: what leaves holds no content
and is built from an allow-list; a run is a trace of event, command and run
spans with the ids the specification gives, each sent once; an export
resumes from a cursor kept per endpoint and run, in windows of at most 500
spans; a failure, a redirect or a collector that does not answer leaves the
cursor and the run as they were; `--follow` picks up new events and stops on
SIGINT; and `mandate otel export` exits 1 for a failed post and 2 for a usage
error.

`otel-collector.test.ts` shows the same export against a real OpenTelemetry
Collector. It runs only when `MANDATE_OTEL_COLLECTOR` names a collector and
`MANDATE_OTEL_COLLECTOR_OUT` the file its `file` exporter writes. The CI job
`test` starts the collector's core distribution in a container pinned by
digest (its configuration is `runtime/test/otel-collector.yaml`), runs the
export of a finished run to it, and compares what the collector wrote with
the run's journal: the trace, a span for each event with its hash and time,
the command spans and the run's span, each once.

`map.test.ts` also runs the map of the migration example
(`fixtures/envelope/migrate-all.mdt`) over 24 repositories: 24 migrators,
at most 16 at once, each with its own repository as its write scope, the
outcomes in input order, and a replay that gives the same result.

`demo.test.ts` runs the whole example with every agent as a loop: the
envelope's approval, the map, a lead whose first sub-program is refused
for asking more agents than are left and whose second is admitted, a
merge the release manager signs as evidence and as authorization, 26
agents in the ledger, and the replay. The example has no contract, so the
test adds one: a sub-program can define none, and a merge needs a value a
contract verified. The test also reads the run's view: the envelope's
remainder, the two submissions, the 24 items and the three signed
decisions.

`views-envelope.test.ts` holds the 0.4 parts of a run's view to the
journal: a map with a failed item, one that still runs and one that
`fail_fast` failed; a refused and an admitted submission; a declined, an
approved and an unanswered amendment; and decisions whose stored record
was changed or removed.

`fail-closed.test.ts` holds what 0.5 asks and a host does not enforce to
its refusals: a requirement 0.2 that limits methods or carries
credentials, refused by the adapter on a host that enforces all of 0.1
and reaches no egress proxy, and planned on one that does; a 0.5 run
whose agent may only GET, which is not started; and a lock with all three
0.5 fields, which loads, and whose binding refuses a start on a runtime
that names no proxy (`no_egress_proxy`).

`sandbox-egress.test.ts` holds sandbox egress to the egress proxy
([`spec/boundary.md`](spec/boundary.md#sandbox-egress)), against a fake
MXC SDK whose processes send their requests to the in-process proxy: the
host reports an outbound host list only while MXC's proxy enforcement is
supported and the proxy answers, and a configured proxy that does not
answer stops a run that needs a host for a person (`egress_unavailable`),
to go on when it is resumed; each sandbox's session has exactly its
hosts, methods and credentials, for its run and tenant, and closes with
it; MXC gets the session's address and the placeholders, never a secret,
and the upstream gets the secret; a credential the proxy does not hold or
bind, and a host that is not a host name, are refused by name; a 0.4
program's hosts go through with any method; a session near its end is
replaced; what the proxy denies a tool call is one `egress_denied`
violation of its step, counted once on resume and stopping the run at
its limit; a cancel's and a halt's revoke cut the session; a start is
refused `no_egress_proxy` or `egress_unavailable`; and Windows refuses it
all by name. On Linux with `MANDATE_MXC=1` (the `sandbox` job) it runs
real Bubblewrap sandboxes with `curl`: the SDK reports that it can hold a
sandbox to its proxy; the placeholder is in the sandbox's environment and
no secret; an allowed request reaches the upstream with the secret put in;
another host, a method not allowed and a tunnel to a host with a credential
are denied; a request around the proxy reaches nothing, on the sandbox's own
loopback and at the address it sees its proxy at; the denials of a run are
violations in its journal; and an HTTPS tunnel to a host without a
credential, to a TLS server whose certificate is made when it runs, works
with the sandbox's own TLS.

`boundary-acceptance.test.ts` is 0.5's acceptance from end to end, for the
agent of `fixtures/boundary/reach.mdt` and `reach.lock.json` (the proxy
configuration it needs is `reach.egress.json`): its environment holds the
placeholder and not the secret, its allowed GET reaches the upstream with
the secret, a request to another host is a violation the audit view shows
(a role's view without its detail), and `mandate journal export` and
`mandate journal key` give an export that verifies and, with one event
changed in the database, is `chain_broken` at that event; it runs against a
fake sandbox everywhere and in a real Bubblewrap sandbox in the `sandbox`
job, which hands those exports to `verify-journal`. By hand, with the
secret in the proxy's environment and a `mandate.runtime.json` that names
the model, the `mxc` sandbox and `egress.admin` (`/run/mandate/egress.sock`):

```sh
MANDATE_EGRESS_GITHUB=<token> mandate egress serve --config fixtures/boundary/reach.egress.json
mandate run fixtures/boundary/reach.mdt --lock fixtures/boundary/reach.lock.json --workflow Reach --input '{"task": "reach what you are granted"}' --run-id reach1
mandate show reach1 --audit
mandate journal export reach1 --out run.json ; mandate journal key --out cp.pub.pem
cargo run -p verify-journal -- run.json --key cp.pub.pem
```

The workflow `.github/workflows/boundary-live.yml` runs these steps on a
GitHub runner, with a real model, a real Bubblewrap sandbox and the real
`api.github.com`. It is started by hand only (`gh workflow run
boundary-live.yml`, or "Run workflow" on the Actions tab), because it spends
a few model calls. It reads the repository secret `CLAUDE_API_KEY` (and
`CLAUDE_WORKSPACE_ID` for a key not scoped to a workspace) in the step that
runs the runtime, and the job's own `GITHUB_TOKEN`, which can only read the
repository, in the proxy's step and in the step that checks the run. The
runtime never has the token. Its first step fails, before anything is
built, when `CLAUDE_API_KEY` is not set (`gh secret set CLAUDE_API_KEY`
sets it). Its task, from
`runtime/scripts/boundary-live-check.mjs input`, names the calls the model
is to make. The same script then reads what the tools returned, from the
audit view, and fails naming each claim the run does not show:

1. the agent's environment holds the placeholder and not the token;
2. GitHub's answer to the GET shows the request arrived authenticated. It
   has an `x-ratelimit-limit` above 60, the limit GitHub
   [documents](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
   for unauthenticated requests (1,000 for a `GITHUB_TOKEN`);
3. the request to `example.org` is an `egress_denied` violation in the
   audit view;
4. `verify-journal` reports the export `verified`.

The script is given the token only to compare against. It searches every
file the run left for the token before it prints any of them, and it does
not print a file that holds it. `boundary-live-check.test.ts` runs the
script on what a scripted run of the same program leaves, and again with
the evidence of each claim changed.

`isolation.test.ts` holds a requirement 0.2's `isolation` to the level and
sharing a host reports: a level above the host's, or no sharing on a host
that may share, is refused by name and the agent is not started; what the
host gives is planned with the policy of 0.1, byte for byte; a 0.1
requirement is planned as before whatever the host reports; and a lock's
`isolation` with a program before 0.5 is refused at load (E1803).
`fitness.test.ts` holds a lock's `host` to the host's tools, read through
a probe the test gives: versions compared by number, a suffix read as just
below its numbers, what cannot be compared refused; each `unfit_host` text;
a start on an unfit host that writes nothing, and a resume that takes no
lease and leaves the run as it was. On Linux it also runs the real probe
against stand-ins for `bwrap`: its environment, its 5 second limit, an
error exit, and the setuid bit.

## Live runs

Tests that call a real model run only with `MANDATE_LIVE=1`, never in PR
CI. They read `CLAUDE_API_KEY`, and `CLAUDE_WORKSPACE_ID` (or
`anthropic-workspace-id`) when the key is not scoped to a workspace, from
the environment or from `.env` (gitignored):

```sh
MANDATE_LIVE=1 npx vitest run test/live.test.ts     # from runtime/
```

The migration example runs with a real model as its lead when
`MANDATE_ENVELOPE=1` is set as well. Its migrators stay scripted. The lead
may spend up to its budget of 10 USD. The test holds the run to the
envelope whatever the lead writes, and prints what it did:

```sh
MANDATE_LIVE=1 MANDATE_ENVELOPE=1 npx vitest run test/demo.test.ts
```

The Managed Agents trial deploys one agent and runs one delegation on Claude
Managed Agents (a 2 USD run) when `MANDATE_MA=1` is set as well:

```sh
MANDATE_LIVE=1 MANDATE_MA=1 npx vitest run test/live-managed-agents.test.ts
```

The workflow `.github/workflows/live.yml` runs `test/live.test.ts` when it
is started by hand. Two inputs, both off by default, add the other two
tests. Each one runs in a step of its own that has only the model's secrets.
The workflow needs the repository secret `CLAUDE_API_KEY`, and its first
step fails when that is not set; without `MANDATE_GITHUB_TOKEN` the test
that opens a pull request is skipped, and the step says so:

```sh
gh workflow run live.yml                                          # test/live.test.ts
gh workflow run live.yml -f managed_agents=true -f envelope=true  # and the two others
```

Models, efforts, token limits and prices come from the lock file
([`spec/lock.md`](spec/lock.md)).

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
