# Mandate

Mandate is an agent-native coordination and contract language. Agents write
and edit programs; people review them through generated views; the compiler
checks capabilities, effects, budgets, contracts and delegation before
anything runs. This repository holds the 0.1 reference implementation.

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

Start with [`spec/core.md`](spec/core.md): the language on one page, small
enough for an agent's context.

## Layout

```text
spec/        core spec, IR schema and rules, static checks, diagnostic codes, runtime, sandboxes,
             executors, views, the compiler's MCP server
compiler/    reference compiler (TypeScript)
runtime/     reference runtime (TypeScript, PostgreSQL or in-process PGlite)
fixtures/    the tests' programs: fixbug/ is the design document's §20 workflow,
             fixbug-target/ the same workflow bound to a seeded test project,
             system/ a fictional system's model (Acme) and programs over it
```

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
| V20 | A text literal stands for a `Path` only if it is relative and normalized (K68) | E0204 |

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
`MANDATE_OPA`, the generated Rego on a real OPA.
`compiler/test/static.test.ts` also checks the §20 FixBug table: 49.28 USD of
child budgets inside 50 USD, delegated capabilities inside the workflow's,
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
with `MANDATE_MXC=1` (the CI job `sandbox`), it checks the blocking itself:
writes outside the grant, reads outside it, network, the environment, and
an agent loop working through the sandbox.

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
own: each check comes back signed by the verifier's key, a result changed
on the way or signed by an untrusted key is not met, and a record the
runtime's key re-signed without the verifier's attestation is invalid.
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
and learning mode.

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
| G06 | A pinned acceptance suite runs as the base commit has it, whatever the agents changed; a check its verifier did not sign is not met | `verifier`, `verifier-process` |
| G07 | A sandboxed process reaches no host, and gets none of the runtime's credentials | `mxc` (Bubblewrap, CI job `sandbox`), `mxc-windows` (AppContainer, CI job `sandbox-windows`) |
| G08 | Another tenant's or run's artifact is refused like a missing one | `artifacts` |
| G09 | A model's markup is shown as plain text in every view, never as a control | `views` |
| G10 | A view the run has moved past says so, and a decision taken on it is refused | `views` |
| G11 | A new network target shows in the semantic diff as a governance change | `views` (compiler) |
| G12 | A remote agent without idempotent delivery: refused if required, else sent at most once | `gate4` |
| G13 | One authorization is consumed by one commit; a second is refused | `gate4`, `effects` |
| G14 | A path an agent names that leaves the working copy, is absolute or is not portable is refused: as a model's answer, a skill's result or a run's input by its type, and where the runtime uses it, without following a link | `gate4`, `loop` (the type); `paths`, `verifier`, `boundary` (the use site) |
| V11 | The same tool call three times in the window stops the loop with `Stuck` before it runs again | `loop` |
| V14 | A throttled call waits and is sent again; no restart is counted and no BudgetExceeded is raised | `supervision`, `anthropic` |
| V16 | A `plan_execute` plan with a tool the agent does not have is never run | `loop` |
| X01 | A package whose executor binding no longer fits its lock is refused at load; a changed agent or environment fails ValidateBinding; a bound agent never runs without its executor | `managed-agents` (and E0903 in the compiler) |
| X04 | A bound agent's turns run in its delegation's session and its tools in the runtime's sandbox, journaled; replay calls neither | `managed-agents` |

R11 and R12 are about `map`, which the 0.1 IR does not have yet; `budget`
tests that `par` results are bound by branch name instead.

## Live runs

Tests that call a real model run only with `MANDATE_LIVE=1`, never in PR
CI. They read `CLAUDE_API_KEY`, and `CLAUDE_WORKSPACE_ID` (or
`anthropic-workspace-id`) when the key is not scoped to a workspace, from
the environment or from `.env` (gitignored):

```sh
MANDATE_LIVE=1 npx vitest run test/live.test.ts     # from runtime/
```

Models, efforts, token limits and prices come from the lock file
([`spec/lock.md`](spec/lock.md)).

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
