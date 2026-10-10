# Mandate 0.1 runtime

This is the reference runtime in `runtime/`. It runs a checked package
against adapters and keeps every decision that must survive a crash in
PostgreSQL. Section numbers refer to the design document (Doc 4).

## Scope

The runtime has two parts:

- **The PostgreSQL-backed core.** A worker drives a run, and
  `Runtime.resume` starts a new worker after a crash.
- **Temporal scheduling** (`@mandate/runtime/temporal`). Temporal decides
  when `resume` runs: it starts and retries workers, holds deadline timers,
  and wakes a run after a control call.

PostgreSQL stays the authority for the journal, authorizations, the budget
ledger and actions. So the scheduler changes who calls `resume`, not what a
run may do. Without Temporal, the caller's process drives a run inline.

Two database drivers share one interface (`runtime/src/db.ts`):

- **node-postgres** for a PostgreSQL server.
- **PGlite**, PostgreSQL compiled to WebAssembly, for in-process tests and
  local runs.

## Storage

| Table | Holds |
|---|---|
| `packages` | Content-addressed packages: program, lock, and the imported modules it was checked with |
| `runs` | State, revision, lease fence, cancel flag, waiting / attention / result / error / summary; the manifest and its hash R |
| `workspace_claims` | Which run holds each component's working copy (B3) |
| `events` | The run's append-only event log |
| `commands` | One row per nondeterministic step: request digest, state, result or error, cost |
| `budgets` | Limit and settled amount per dimension (`tokens`, `steps`, `spend:<currency>`) |
| `reservations` | Upper-bound reservations per command and dimension |
| `actions` | External actions: digest, frozen parameters, retry class, state, receipt |
| `authorizations` | Bound to one action digest, with an expiry; `consumed_by` is unique |
| `evidence` | Contract criteria results that back a `Verified` value |
| `inbox` | Inbound message keys with their payload digests |
| `outbox` | Committed actions waiting for, or past, delivery |
| `artifacts` | Which run (and tenant) recorded which artifact digest; the bytes live in the artifact store |

Every write that must be atomic runs in one transaction that first locks the
run's row (`select … for update`). This covers reserve plus dispatch,
consuming an authorization plus writing the outbox, cancel against dispatch,
and recording a result. Writers of one run are serialized that way.

## Commands and replay (§8.3)

The workflow body is deterministic. Each step that is not deterministic is
a command: delegates, model calls, verifier calls, reads, time, randomness
and waits for people. A command's id is the IR path of the node that issued
it. Three suffixes extend the path:

- `@i` for a loop iteration;
- `#n` for a restart attempt;
- `>fn/body` for an inlined function.

Before a command runs, the journal is asked for its result. Recovering from
a crash means running the same body again, and so does `ReplayRun`. If the
journal recorded a command with a different request digest, the run stops
with the violation `nondeterministic_replay`.

A command is at least once. A crash between the call and its record sends
the call again. External effects are protected separately, as described
below.

## Artifacts (§16.1)

Large data stays out of events and commands. The artifact store keeps it
by content: an artifact is named by the SHA-256 of its bytes,
`blob:sha256:<hex>` (`runtime/src/artifacts.ts`). It holds:

- the files an action will apply, frozen when the action is prepared;
- what a check ran against: the working copy's tree, a manifest of
  `path → sha256` (`mandate/tree/0.1`).

The bytes are kept once, in a content-addressed directory
(`<dir>/sha256/<2 hex>/<hex>`), or in memory for in-process runs. Access is
not shared. The `artifacts` table records which tenant and run stored which
digest, and a run reads only its own artifacts:

- A digest recorded by another tenant or another run is refused exactly
  like one nobody stored (`artifact_not_found`), so a refusal does not say
  whether the artifact exists (G08).
- Reading hashes the bytes again; bytes that no longer match their digest
  are refused (`artifact_corrupt`).

`Runtime.artifact(run, ref)` reads one, and `mandate artifact <run> <ref>`
prints it.

## Budget (§8.6)

A command reserves its upper-bound cost when it is dispatched, in the same
transaction:

```text
available = limit − settled − active reservations
```

If the reservation does not fit, the command is refused with
`BudgetExceeded`. A known cost settles and closes the reservation. If the
cost is `"unknown"`, the reservation stays active until `settleCharge`
reports the real charge (R16). Run limits are the minimum of the
workflow's budget and the caller's limits.

A delegate reserves the budget written at the call, else the skill's, else
the agent's: the same budget the compiler adds up for E0501. `time` is a
deadline, not a ledger dimension, so it is not reserved.

When a reservation does not fit, the run does not fail. Each time this
happens is a numbered episode, recorded as a `budget_exceeded` event:

1. The workflow's `on budget_exceeded` handler runs. Without a handler,
   the run pauses. FixBug's handler, `pause and human.ask(…)`, opens an
   input wait. Its command id carries the episode: `/defs/FixBug/on/0@0/…`.
2. The run is `waiting` with
   `{ kind: "budget_exceeded", detail, handler, episode, command, request }`.
   The `command` is the wait to answer with `SubmitInput`.
3. `raiseLimits` raises the run's limits. It is a governance change
   (§13.2), recorded as `limits_raised` with who made it and the limits
   before and after. It can only raise a limit that exists (`not_a_raise`),
   never above the workflow's own budget (`above_program_budget`; that
   needs a new program version). Like a decision, it names the revision it
   was made on and is deduplicated by message.
4. Answering the question resumes the run. The body runs again against the
   journal, so finished commands are not called again. The command that
   did not fit is dispatched again. If it still does not fit, the next
   episode asks again.

A handler that asks nobody leaves the run failed with `BudgetExceeded`.

`budgetReport` returns the run's budget table:

- per dimension: limit, settled, active reservations and what is available;
- per command that reserved or spent anything: its label (`Agent.skill`
  for a delegate), what it reserved, which reservations are still open, and
  the cost it reported (`"unknown"` until a late charge is settled).

## Models (§5.2, §8.6)

`AnthropicModel` (`runtime/src/anthropic.ts`) is the model adapter for real
calls. It runs in the runtime process, so the API key never reaches an
agent's sandbox. Everything it sends is pinned by the package's lock file
([`lock.md`](lock.md)):

- **Model and effort.** A call runs under a model tier: the capability
  named by `using`, or else the only model tier in scope. The tier's model
  and effort are sent with every request. Effort is always explicit.
- **Reservation.** Before the call is dispatched, its input is counted with
  the token-counting endpoint. The reservation is that input plus the
  output limit, priced as if nothing hits the cache. The count is made only
  for a call that will really be sent: a call already in the journal is not
  counted again. A call whose input is over the locked limit is not sent.
- **Settlement.** The call settles at the usage the API reported:
  - `tokens`: every token the model processed;
  - `spend`: each kind of token at its own price;
  - `steps`: one.
- **Snapshot.** The model id that answered, the locked id, the effort,
  the stop reason, the usage and the request id are journaled with the
  result, in the `command_completed` event's `meta`.
- **Failures.**
  - A request the API rejected with a status is not billed. A 429 or
    5xx is a `Timeout`; any other status is `Rejected`. Either way the
    command settles at zero.
  - A broken or timed-out connection may have been billed, so its cost is
    `"unknown"` and the reservation stays (R16).
  - A refusal is `Rejected("refusal")`.
- **No fallback.** No refusal fallback is configured, because a fallback
  would answer with a model the lock does not name.

`infer T from e` asks for `T` through structured output: the JSON Schema
of `T` (`runtime/src/schema.ts`), with the input in a `<data>` block that
the system prompt marks as data only.

## External effects (§8.5, §8.8, §8.9)

1. **Prepare.** The adapter validates the parameters and reads the files
   the action will apply. The runtime stores the files in the artifact
   store, and prepare is a journaled command (`<node>/prepare`) whose result
   keeps their digests, so a resumed worker finds the same action. The
   runtime then freezes everything into an action digest. The digest covers
   the package, run, node, effect, adapter id, adapter contract digest,
   parameters, evidence, idempotency key and the files' digests. The
   operation key is derived from the tenant, run, node and action digest.
   Execute later gets the files from the store: it sends the bytes that
   were frozen, whatever happened to the working copy since.
2. **Authorize.** By default, policy authorizes the action, and a person
   authorizes an irreversible one; `StartRun` can override this per effect.
   A person's approval applies only to the digest they saw, and only before
   the wait's deadline (R15).
3. **Commit.** One transaction does four things:
   - checks that the authorization exists and matches the digest (E0406);
   - checks that it was not consumed by another action (E0407) and has not
     expired;
   - checks that the run was not cancelled (R08);
   - consumes the authorization and writes the outbox record.

   Only after that is the adapter called.

At run time, a parameter declared `Verified<T, C>` must carry evidence for
`C` (INV-13). Without it the effect fails with `PolicyDenied`.

Evidence is bound to what it checked (G01, INV-05). A test records the
working copy's files with their digests. Before an action is created, every
file it will apply must appear, with the same digest, in each such piece of
evidence the action's parameters carry. A file changed since the check, or
one the check never saw, makes the evidence stale: the run stops with the
violation `stale_evidence` (`attention_required`), and nothing is
prepared or sent.

A worker may find an action already dispatched, because the previous worker
died after commit. The adapter's retry class then decides what happens:

| Retry class | On resume |
|---|---|
| `idempotent` | Sent again under the same operation key; the remote system applies it once |
| `reconcilable` | The system of record is asked first; sent only with proof it was not applied |
| `non_retryable` | Never sent again; the action becomes `unknown_outcome` |

An `unknown_outcome` is never retried blindly. The run needs attention
until `ReconcileAction` resolves it (R04, R05).

Two more operations of the adapter contract (§16.1) are optional on an
adapter:

- **`ValidateBinding`.** Before a run starts, the runtime asks each adapter
  of an effect the workflow can reach whether it serves the program's
  binding. For `git.*`, the binding is the repositories of the workflow's
  `git.pr(…)` capabilities. A run an adapter cannot serve does not start
  (`unsupported_binding`).
- **`Cancel`.** `CancelAction`, which `CancelRun` also calls for every
  action with an unknown outcome, asks the adapter to stop it:
  - Cancelled, with the adapter's proof: the action is resolved as never
    applied.
  - Too late: it was applied, and its receipt is recorded.
  - Unknown: nothing changes.
- **`Stop`.** A cancelled run's agent processes are stopped in their
  sandboxes, not left to their timeouts (`sandbox_stopped`; see
  `spec/sandbox.md`).

### `git.open_pr` on GitHub

`GitHubPullRequests` (`runtime/src/github.ts`) opens a pull request in one
repository, through GitHub's REST API. Its token is a fine-grained one for
that repository only (BACKLOG K18). It is held in the runtime process and
never reaches a sandbox.

`git.open_pr(checked)` opens one pull request with the files the checked
draft names (`patch.files` and `tests.files`), read from the working copy
the agents changed:

- one commit on top of the base branch;
- on the branch `mandate/<issue>-<op>`;
- `<op>` is derived from the operation key, so the same operation always
  names the same branch.

The pull request body names the operation, the action digest and the
authorization.

The effect is `reconcilable`:

- `Reconcile` looks for a pull request from a branch of the operation, and
  reports it applied, or proves it was not.
- Sending the action again reuses the branch, and finds an existing pull
  request instead of opening a second one.
- After a lost response there is one pull request.

`Prepare` refuses a file outside the working copy, or one that is not in
it. `Cancel` is too late once a pull request exists.

## Contracts and evidence (§10)

`verify x against C(…)` checks C's `require` clauses, then its criteria
in order of their method: static checks, tests, evals and reviews, then
people; by name within each group. A criterion that combines methods runs
with its last one. Each check records one evidence row: contract,
criterion, method, passed, detail, and its subject. The subject is a
digest of the contract's arguments; a check of the working copy adds its
files by digest, and the tree as an artifact. A criterion that names several checks (`static … and
review(…)`) records one row per check, so a review is never the only
evidence for it. Only when every criterion passed does the value become
`Verified<T, C>`, carrying the ids of its evidence. The ids also enter the
action digest of any effect that receives the value.

A criterion `human.approve(role: r)` is a wait for a person, not a
verifier call:

- It is asked last, and only once every other criterion has passed. Nobody
  is asked to approve a change whose checks already failed; the criterion
  is then reported unmet without asking.
- The wait's request names the contract, the criterion, the role and the
  contract's arguments, and a `subject_digest` over them. `DecideAction`
  must name that digest, so a decision applies only to what the person was
  shown (G02).
- An approval is evidence for the criterion, with who decided as its
  detail. It authorizes no action; external effects are still authorized
  on their own (below).
- `human.approve(role: r, deadline: d)` waits at most `d`. The deadline is
  fixed when the wait opens, and a new worker does not move it. Past it,
  the criterion is unmet and recorded with `expired: true`. That holds
  whether `tick` (under Temporal, a durable timer) gets there first or a
  late `DecideAction` does. The run then goes to `on unmet` like any other
  unmet criterion.

### Evidence records (§10.3)

Every check writes one evidence record, and the runtime signs it with the
control plane's ed25519 key (`runtime/src/evidence.ts`). The agent never
produces evidence. A record names:

- **What was checked:** the run, the package, the contract and the hash of
  its definition, the criterion, the method, and whether it passed.
- **Against what (`subject`):** a digest of the contract's arguments; for a
  check of the working copy, its files by digest and the tree as an
  artifact.
- **By whom (`producer`):** the runtime for a static criterion; the person,
  their role and the channel for `human.approve`; for a verifier call, the
  verifier's handler, the sandbox its tests ran in, and for a review the
  judge's model snapshot and prompt digest.
- **With which outputs (`artifacts`):** test logs by phase and result, the
  diff and the review, each a reference into the artifact store.
- **When (`at`).**

The signature covers `mandate/evidence/0.1\n` followed by the record's JCS
bytes. It is stored with the key's id, the SHA-256 of its public key. A
runtime trusts its own key and the public keys it is given.

`verifyEvidence(run)` checks every record against its signature. The
runtime also checks before an effect uses a `Verified` value (G03). The
value's evidence ids are looked up in the run's store, never taken on the
value's word. Each must:

- be evidence of this run, for the value's contract;
- have passed;
- be signed by a trusted key, exactly as recorded;
- if it claims a verifier attestation, carry one that holds (below).

Together they must cover every criterion of the contract. Otherwise the
run stops with the violation `forged_evidence`, before anything is
prepared.

### The runtime's verifier

`SandboxVerifier` (`runtime/src/verifier.ts`) checks test criteria in the
runtime process, where the agents cannot reach. Every test runs in a new,
read-only sandbox of its own, over a copy of the working copy:

- **`test.suite([names])`.** Each named suite must pass. A suite is pinned
  by default: its files are taken from the base commit, before any agent
  ran, and run over a copy of the working copy. An agent that weakens,
  deletes or adds a test file changes nothing about what runs. The record
  lists the pinned files by digest, and the ones the agents changed (G06).
  `{ "files": "…", "pinned": false }` runs the working copy's files instead.
- **`test.red_then_green(patch, tests)`.** The new tests must fail with
  the patched files as they were at the base commit, and pass as the
  agents left them.
- **`review(model: tier, isolated)`.** A model reviews the diff in a fresh
  context. It is reserved and settled like any model call, and never
  enough on its own (E0603).

### A verifier of its own

With `verifier.process` in `mandate.runtime.json`, the checks run in a
separate process (`runtime/src/verifier-main.ts`), which the runtime
starts and talks to over stdio, one JSON-RPC 2.0 message per line
(`open`, `key`, `upperBound`, `check`; `runtime/src/verifier-service.ts`).
It runs the same `SandboxVerifier`, and signs each result with its own
ed25519 key, which the runtime process never reads. What it signs, its
*check attestation*, is:

```json
{
  "format": "mandate/check-attestation/0.1",
  "request": "sha256:…",
  "passed": true, "detail": { … },
  "subject": { "src/a.ts": "sha256:…" },
  "producer": { "kind": "runtime", "handler": "mandate-sandbox-verifier@0.2", "sandbox": "mxc:process" },
  "logs": [ { "kind": "test_log", "phase": "after", "result": "pass", "digest": "sha256:…" } ],
  "cost": null
}
```

The signature covers `mandate/check-attestation/0.1
` followed by the
statement's JCS bytes. `ProcessVerifier`, on the runtime's side, computes
the same statement from the request and the result it received, and
accepts the result only when the signature verifies against a pinned
verifier key. Otherwise the criterion is not met, with the detail
`unattested_check`: a result the verifier did not sign never passes.

An accepted result's `producer` carries `process: "separate"` and the
attestation (statement, key id, signature) into the evidence record.
`verifyEvidence` and the `Verified` check (G03) then also require the
attestation to verify under a trusted verifier key, and to say what the
record says: passed, detail, the files checked, and each output's digest.
So the runtime's key alone cannot make a check pass.

The verifier creates its key on first use (`.mandate/verifier.key` by
default) and writes its public half to `<key>.pub`, which the runtime
trusts unless `verifier.process.trusted` names other public keys.

Unmet criteria go to `on unmet(c)`, or else fail the verify with
`Rejected`. An answer to an `escalate` there is the escalation's value,
never a `Verified` one, so an effect that requires the contract still
refuses it (INV-13).

## Agent loops (§8.2)

With `Adapters.loop` set (`{ chat, sandbox }`), a skill without a body of a
local agent runs as an agent loop in the runtime process
(`runtime/src/loop.ts`). Without it, `Adapters.agents` answers a delegation
in a single call (the Gate 2 simulation).

The loop runs in the control plane (BACKLOG K7):

- The model is called from the runtime, so the API key never enters the
  sandbox.
- Each tool call runs as a process in the agent's sandbox
  (`SandboxHost.execute`).
- The sandbox is built from the delegation's grant
  ([`sandbox.md`](sandbox.md)). Its network is closed: model calls need
  none from inside (`modelsInControlPlane`).

**Tools.** They come from the grant (K8, `runtime/src/tools.ts`):

| Capability | Tools | Process in the sandbox |
|---|---|---|
| `fs.read(P…)` | `read_file`, `list_dir`, `grep` | `cat`, `ls -1Ap`, `grep -rnI` |
| `fs.write(P…)` | `write_file`, only below P | `sh -c 'mkdir -p … && cat > "$1"'`, the content on stdin |
| `exec(…)` | `run`, only the listed commands and argument prefixes | the command itself, in the first readable path |
| — | `finish`, which hands back the result | — |

The runtime checks every path and command against the grant before it
starts a process. This only gives the model a clear refusal; the sandbox
enforces the same limits again. Tool output is cut at 20,000 characters.

**Journal.** Every step is a command below the delegation's own:

```text
<delegate>/step/<n>               a model turn
<delegate>/step/<n>/tool/<k>      a tool call of that turn
<delegate>/plan/<i>               a step of a checked plan
```

The conversation is rebuilt from the journal, so recovery sends nothing
already recorded again, and replay calls neither the model nor the
sandbox.

**Budget.** The delegation reserves the agent's budget, less what its
finished steps already spent. A turn is charged to that reservation:

- It must fit in what is left (else `SkillFailed(StepLimit)`).
- Its cost is settled at once.
- The reservation shrinks by the same amount.

A dimension the agent's budget leaves out is reserved from the run as
usual. A turn reserves its counted input plus the output limit (see
[Models](#models-52-86)) and one step. A call whose input is over the
locked limit is not sent (`ContextExhausted`).

**Ending.** The model calls `finish` with a value. The value is checked
against the skill's result type (`runtime/src/schema.ts`):

- A result that does not fit goes back to the model to repair.
- So do a tool the agent does not have, and arguments outside the schema
  or the grant.
- The model may repair at most twice (`MAX_REPAIRS`). A third time ends
  the loop.

The loop stops with `SkillFailed(kind, detail, partial)` (§8.7):

| `kind` | When |
|---|---|
| `Stuck` | The same tool and arguments `repeats` times in the last `window` calls; the call is not run (V11). Or `stall` turns in a row that observed nothing new |
| `StepLimit` | The agent's steps, tokens or spend cannot cover another turn |
| `SchemaMismatch`, `InvalidTool`, `InvalidArguments` | Still wrong after the repairs |
| `ContextExhausted` | The conversation is over the locked input limit |
| `Refused` | The model declined |

When a parallel branch fails (fail_fast), a loop stops before its next
step, and leaves its delegation in flight, as after a crash. If the run goes
on, for example after a person raised its budget, the loop resumes from
the journal. The block fails with the fault that stopped the others.

`partial` lists the files the loop wrote. A turn observed something new
when one of its tool calls returned something the loop had not seen from
that tool with those arguments. The thresholds come from the agent's
`progress`, defaulting to 8, 3 and 5 ([`ir.md`](ir.md#what-02-adds)).

**plan_execute.** The model is first offered only `submit_plan`, the list
of tool calls it needs. The runtime checks the whole plan before running
any of it:

- every tool is one the agent has;
- every argument fits the tool's schema and the grant;
- the plan is no longer than the agent's `steps` limit.

A rejected plan never runs (V16). The model may repair it; a third rejected
plan ends the loop. A checked plan then runs step by step. The model sees
the results, and is offered only `finish`.

## Supervision and `par` (§7.4, §8.7)

- **Restart.** `supervise restart(max, backoff)` restarts a delegate on
  `Timeout` or `SkillFailed`, and never on other faults. Backoff is
  exponential with jitter. The jitter is a journaled command, so replay
  neither draws it again nor waits.
- **Timers.** Who waits out a backoff depends on the runtime. Inline, the
  worker sleeps. With durable timers (`{ durableTimers: true }`, which a
  Temporal worker's runtime must use):
  - the start of the wait is a journaled `time` command, so its end is
    fixed;
  - until the end, the run is `waiting` with
    `{ kind: "timer", request: { reason, until, deadline } }`, and no
    worker holds its lease;
  - `tick` resumes the run once the end has come. A worker that resumes it
    earlier waits again, for the same end.
- **Escalate.** `supervise escalate(human)` (optionally `role: "…"`) asks a
  person when the delegate fails with `Timeout`, `SkillFailed`,
  `PolicyDenied` or `Rejected`. The run waits for input
  (`<delegate>/escalate`) with the fault, the attempt and the options
  `retry` and `fail`. The answer `retry` runs a new attempt; any other
  answer lets the fault stand. A person may be asked at most 5 times.
- **Degrade.** `supervise degrade(to: F)` hands the job once to the
  fallback agent `F` on `Timeout` or `SkillFailed`: the same skill with the
  same arguments, as the command `<delegate>~F`, under `F`'s own grant. `F`
  does the same job with no more authority (E0715). Its fault, if any, is
  the delegation's.
- **Not handled by supervision.** `BudgetExceeded` goes to the run's
  budget handler, `Throttled` to the rate limiter, and `UnknownOutcome` to
  reconciliation.
- **Branch results.** `par` branches start together, and their results are
  bound by branch name, never by completion order.
- **`fail_fast`.** Under `fail_fast` (the default), the first fault stops
  the other branches before their next dispatch. The block still ends only
  when every branch has settled, so an external action already in flight is
  followed to its result (R10).

## Remote agents and delivery (§9.6, G12)

A2A does not require a server to deduplicate messages by id, so a task sent
twice may run twice. A delegation to a remote agent is sent at most once
unless its adapter says the partner's server deduplicates messages
(`AgentAdapter.remoteProfile`):

- **Required.** A remote binding with `require idempotent_messages` does
  not start against an adapter without that guarantee
  (`unsupported_binding`).
- **Lowered.** Otherwise the run records `guarantee_lowered` when it
  starts. A task found in flight after a crash is not sent again: the run
  needs attention (`delivery_unknown`), and a person decides.
- **Deduplicated.** For a server that deduplicates, a task in flight after
  a crash is sent again under the same command, as for any other command.

## Timeouts and postconditions (§4.6, §8.7, §9.1)

- **`delegate … timeout d`.** Each attempt must finish within `d` of its
  start. The start is a journaled `time` command (`<delegate>/started`), so a
  resumed worker keeps the same deadline, and a restart gets a deadline of
  its own.
  - An agent loop is stopped before its next step once the deadline has
    passed. A step not sent by then is never sent.
  - An adapter that answers in one call gets the deadline in its request. A
    result that arrives after it is discarded; what the call spent is
    settled.
  - Either way the attempt fails with `Timeout({ delegate, after_ms })`. A
    loop's fault keeps the files it wrote (`partial`). `Timeout` can be
    restarted.
- **`ensures e`.** After the body returns, `e` is evaluated with `result`
  bound to the result. A run whose result breaks it fails with
  `Rejected({ reason: "ensures" })`, or needs attention if one of its
  actions is still unresolved.

## Tests (§6.4)

A program's `test` blocks run with `mandate test <program>`
(`runtime/src/testing.ts`). Each runs workflows against deterministic
handlers, on an in-process database of its own:

| Handler | Stands for |
|---|---|
| `Time = fixed_clock("<ISO time>")` | The clock; it starts there and moves only when the run waits |
| `Model = replay("<file.jsonl>")` | Recorded answers, one JSON object per line: `{ "for": "Agent.skill" \| "infer", "ok": … }` or `"error"`, with an optional `"cost"`; each key's answers are used in order |
| `Fs = memfs("<dir>")` | The working copy: `fs.read_text` and `fs.list` read it, and checks and git effects see its files |
| `Verify = pass_all()`, `results(criterion: Bool, …)` | Contract checks |
| `git = fake_git()` | Every `git.*` effect, applied in memory |
| `Human = auto_approve(role: r)`, `auto_decline(role: r)`, `answer("<text>")` | A person who decides every wait for role `r` (any role without it), or answers every question |

- **Arguments.** `run W(args) expect e` runs `W`. `fixtures.<name>` is the
  JSON file `fixtures/<name>.json` next to the program.
- **Expectations.** `expect ok` means the run succeeded. `failed`,
  `waiting`, `attention_required` and `cancelled` name the state it must
  end in.
- **Files.** Handler files and fixtures must be inside the program's
  directory.
- **Unknown handlers.** A handler the runner does not know fails the test
  by name. An effect with no handler stops the run, as an unconfigured
  adapter does (`no_handler`).

Swapping handlers is possible only in tests. In a real run, the runtime
picks every handler (INV-03).

## Rate limits and `Throttled` (§8.6, V14)

A budget says how much in total; a rate limit says how much per unit of
time, and they are kept apart (`runtime/src/ratelimit.ts`).

- **Shared buckets.** Token buckets live in PostgreSQL (`rate_buckets`), so
  every run and every worker draws from the same ones:
  - `model`: every model call, meaning `infer`, an agent loop's turns and a
    review;
  - `model:<tier>`: model calls of one tier;
  - `tool`: an agent loop's tool calls.

  A bucket holds up to `capacity` tokens and refills at `perSecond`. A call
  takes one token from each bucket that applies, or from none.
- **Throttled.** A call is `Throttled({ retry_after_ms })` when a bucket is
  empty, or when the provider says so (the Anthropic adapter maps 429 and
  529, with `retry-after`). Then:
  - it is not a `BudgetExceeded`;
  - it is not an attempt a supervisor counts;
  - its reservation is released (`command_throttled`), so nothing is held
    while it waits;
  - it waits `retry_after_ms`, on a durable timer when the runtime has
    them, and is sent again under the same command id.

  After 20 throttles the `Throttled` fault reaches the program.
- **Back pressure.** At most `queue` calls (default 100) may wait on a
  bucket. Past that, a call fails at once with
  `Throttled({ …, queue_full: true })`. It is never queued silently.
- **Configuration.** `rateLimits` in `mandate.runtime.json`, or
  `RuntimeOptions.rateLimits`.

- **Priority classes.** A run is `high` (work a person waits for) or
  `normal` (batch; the default), set at `StartRun` or with
  `mandate run --priority high`. A bucket may keep `reserve` tokens that
  only `high` calls may take, so batch runs cannot drain it while a person
  waits.

## Run states

| State | Meaning |
|---|---|
| `accepted`, `running` | Created; a worker holds the lease |
| `waiting` | For input, a decision, or a person after `budget_exceeded` |
| `attention_required` | An action has an unknown outcome, or an invariant was violated |
| `succeeded`, `failed`, `cancelled` | Terminal |

No run reaches a clean terminal state while one of its actions is
`dispatched` or `unknown_outcome` (INV-12). Cancelling a run records the
request; it does not erase anything. A dispatch after the cancel request is
refused. An action already in flight is followed to its real result and
listed in the run's summary (R09).

## Load-time verification (§3.5, S09)

`StartRun` does not trust whoever built the package. It:

- recomputes the program and package hashes;
- requires every imported non-std module to be pinned in the lock, and every
  module the package carries (a system model) to hash to its pin and pass
  the checks itself (`module_hash_mismatch`);
- when the lock pins models, requires it to be well formed
  (`malformed_lock`) and to pin every model tier the program names
  (`unlocked_model_tier`);
- runs the compiler's checks on the canonical IR again.

## Control API (§16.1)

| Operation | `Runtime` method |
|---|---|
| `StartRun` | `startRun` (and `resume` for a new worker) |
| `GetRun` | `getRun`, with `budgetReport` and `evidence` |
| `SubmitInput` | `submitInput` |
| `DecideAction` | `decideAction`: an action's approval, or a contract's `human.approve` |

`SubmitInput` and `DecideAction` carry the run revision the person saw, as
`GetRun` returned it. Every state change and every cancel request raises
the revision. An answer given on an older revision is refused with
`stale_revision` and records nothing: the wait stays open and the person
has to look again. The check comes after deduplication, so a resent copy of
an accepted message is still a no-op.
| `CancelRun` | `cancelRun` |
| `ReconcileAction` | `reconcileAction` |
| `ReplayRun` | `replayRun` (adapters that refuse every call) |
| (governance) | `raiseLimits`: a person raises the run's limits after `budget_exceeded` |

`tick` expires decision waits whose deadline passed. `settleCharge` records
a late charge, and `purgePayloads` applies retention, after which a replay
reports `incomplete_replay` (R14). Inbound messages are deduplicated by
`(tenant, sender, message_id)`. The same key with a different payload is
refused, never silently chosen (R03).

Simulated adapters (`runtime/src/sim.ts`) can confirm, reject, lose a
response, time out, or hold a call until the test releases it. Fault
injection (`runtime/src/faults.ts`) can stop a worker at any of these
points:

- after dispatch;
- before the result is recorded;
- after it is recorded;
- after commit;
- after the adapter returned.

## Control CLI

A person runs a program, and answers it, from a terminal (BACKLOG K19). The
commands are in the runtime (`@mandate/runtime/cli`) and are reached
through the compiler's `mandate` command:

```sh
mandate run <program> --workflow W --input <json|file> [--run-id ID] [--limit spend=20USD] [--module FILE]…
mandate status <run> [--json]
mandate approve <run> --revision N --by NAME
mandate decline <run> --revision N --by NAME
mandate answer <run> --revision N --by NAME <text>
mandate cancel <run>
mandate reconcile <run> <operation>
mandate raise-limits <run> --revision N --by NAME --limit spend=30USD
mandate replay <run>
mandate artifact <run> <blob:sha256:…>
mandate show <run> [--format md|html|json]
mandate onboard --component NAME=DIR… [--host HOST=NAME]… [--repo NAME=OWNER/REPO]… [--name MODULE]
mandate drift --module MODEL --component NAME=DIR… [--json]
```

**Configuration.** Each call reads `mandate.runtime.json`, or the file
`--config` names. It holds the database and the adapters:

```json
{
  "database": "pglite:.mandate/db",
  "artifacts": ".mandate/artifacts",
  "evidence": { "key": ".mandate/evidence.key" },
  "rateLimits": { "model": { "capacity": 50, "perSecond": 1 } },
  "model": { "provider": "anthropic" },
  "sandbox": { "host": "mxc", "baseline": ["/usr/local"] },
  "github": { "repo": "owner/name", "base": "main", "workdir": "/work/repo" },
  "verifier": { "workdir": "/work/repo", "base": "seed", "suites": { "unit": "test/**/*.test.ts" }, "command": ["node", "--test"], "process": { "key": ".mandate/verifier.key" } }
}
```

- **Database.** `pglite:<dir>` keeps the database in a directory, so a run
  outlives each call; `postgresql://…` uses a server.
- **Artifacts.** The artifact store's directory, `.mandate/artifacts` next
  to the configuration by default.
- **Evidence key.** The control plane's ed25519 key, `.mandate/evidence.key`
  by default, created on first use and readable by its owner only.
  `"trusted": ["old.pem"]` names other public keys whose evidence counts.
  `mandate rotate-key` replaces the key: the new one signs from then on,
  and the old one's public half is kept in `trusted-keys/<key id>.pem`
  next to the key, where every later call loads it, so evidence it signed
  still verifies. Its private half is gone. To stop trusting an old key,
  remove its file: what it signed then shows `SIGNATURE INVALID`.
- **Verifier process.** `verifier.process` runs the checks in a process of
  their own with their own key (`key`, default `.mandate/verifier.key`;
  `trusted`, default the key's `.pub` file). See "A verifier of its own".
- **Secrets.** They come only from the environment: `CLAUDE_API_KEY` (and
  `CLAUDE_WORKSPACE_ID` for a key that is not scoped to a workspace), and
  `MANDATE_GITHUB_TOKEN`.
- **Missing adapters.** An adapter the configuration leaves out is refused
  when a run reaches it, and never simulated.
- **Strict reading.** Unknown fields in the file are an error.

**`status`.** It shows what the run waits for:

- for an approval: the contract, criterion, role, subject and digest;
- for an answer: the question;
- in both cases, the command to answer it at the current revision.

It also shows the budget table, the evidence with whether its signature
holds, and the actions. `mandate show` prints the run's views
([`views.md`](views.md)), as Markdown, a self-contained HTML page, or JSON.

**Decisions and revisions.** A decision names the revision the person saw.
If the run has moved since, the decision is refused (`stale_revision`) and
nothing is recorded. What a person approves is bound to the digest that
`status` showed.

`fixtures/fixbug-target/` holds FixBug bound to a seeded test project,
with its lock and input. `runtime/test/gate3.test.ts`
rehearses the acceptance run with a scripted model, on Linux with
Bubblewrap:

- every agent and every test runs in a real sandbox;
- red-then-green fails at the base commit and passes after the fix;
- the code owner approves;
- one pull request is opened.

## Temporal scheduling (§16.1)

Temporal's history holds only scheduling. There is no distributed
transaction between it and PostgreSQL. Each run has one workflow, with the
id `mandate-run/<run id>`, and the workflow loops:

1. It calls the `drive` activity, which runs `Runtime.resume`.
2. If the run is terminal, the workflow ends with the run's state.
3. If the run is waiting or needs attention, the workflow sleeps until a
   `wake` signal arrives, or until the deadline of the wait the run is in.
4. On a signal it drives the run again. When the deadline passes, the
   `expire` activity runs `Runtime.tick`. That expires a decision's wait
   (R15), or resumes a run whose timer is due (a restart's backoff); either
   way the run goes on. A backoff is a Temporal timer, never a sleep inside
   an activity.
5. **Continue-as-new.** After 200 waits, or sooner when Temporal suggests
   it, the workflow continues as a new execution with an empty history
   (`TemporalDriver(client, queue, { waitsPerHistory })`). Nothing is lost:
   the run's state is in PostgreSQL, and the new execution drives the run
   first. A wake sent meanwhile reaches the new execution.

Activities heartbeat. When a worker dies, Temporal retries the activity on
another worker, which takes a new lease and resumes from the journal. The
lease fence stops the old attempt from writing. An activity retry is never
the business idempotency: commands and actions are deduplicated in
PostgreSQL.

With a `TemporalDriver`, the control API only records decisions:
- `StartRun` starts the run's workflow.
- `SubmitInput`, `DecideAction`, `CancelRun`, `ReconcileAction` and `tick`
  record their decision in PostgreSQL and signal the workflow.

The worker's own `Runtime` has no driver, because it is the one that
drives runs.

The same mechanisms are tested under Temporal against a local dev server:
- a crash after a recorded result (R01) and after commit (R02);
- input and approval;
- a deadline timer (R15);
- a restart's backoff on a durable timer;
- continue-as-new after several waits;
- cancel;
- reconciliation (R04).

## Not in this runtime yet

- **`map`, and so R11 by input index and R12.** The 0.1 IR has no `map`.
  `par` results are bound by name, and that binding is tested in its place.
- **Automatic compensation.** 0.1 offers it to a person and never runs it.

## Workspace and run manifest (design doc 9 §12, B3)

A program that works on components of a system model starts from one base
commit per component.

- **Before the run.** `StartRun` finds the components the program refers
  to. It claims their roots in `workspace_claims`; a root that another
  unfinished run holds is refused with `workspace_busy` before anything in
  it is touched. The workspace adapter then checks each one out at its base
  commit. A finished run (`succeeded`, `failed`, `cancelled`) releases its
  claims. A program that works on components and a runtime without a
  workspace adapter do not start (`no_workspace`, INV-11).
- **The manifest.** The run records what it started from:
  `{ format: "mandate/run-manifest/0.1", package, workflow, tenant, input:
  <digest>, components: { name: { repo, root, base } } }`. Its hash, R, is
  `digest("run", manifest)`. The same program from another base commit is
  another R. `mandate show` lists R and each component at its commit;
  verifier calls are told the components (`VerifyRequest.workspace`).
- **`GitWorkspace`** (configuration `"workspace": { "components": { "<name>":
  { "url": …, "ref": "main" } } }`). It clones a missing root, fetches the
  ref, and checks out the fetched commit, detached and byte for byte
  (`core.autocrlf=false`). It removes untracked work an earlier run left
  and keeps ignored files (dependencies). Its credentials stay in the
  control plane.
- **Sandboxes.** Each delegation's sandbox is built from its grant, so it
  sees only its components' roots: an agent working on `mcp` cannot read
  or write `core` (`runtime/test/workspace.test.ts`, also on a real
  Bubblewrap and AppContainer host).

## Change sets (design doc 9 §3, B4)

`changeset` extends prepare → authorize → commit to one action per
component; [`system.md`](system.md#change-sets-b4) has the semantics.

- **Storage.** The `changesets` table holds the set digest S, the members
  in commit order (component, effect, operation, action digest, approver,
  and the evidence ids the member's change carries), a summary (the plan,
  its digest and evidence, the order, the declared changes, the approver)
  for the change set view, and the state. A read_only run records its set
  as `would_apply`, and a design run as `simulated`. Otherwise the state
  is `prepared`, `committing` (the first member's commit
  consumed S's authorization), `committed`, `partial` (some members landed)
  or `failed` (none did). Events `changeset_prepared`,
  `changeset_committed`, `changeset_partial` and `changeset_failed`.
- **Commit.** `Journal.commit` takes the set's authorization as well. In the
  same transaction it checks that the authorization exists, is for S, and
  was not consumed by another set (E0406, E0407), and that it has not
  expired.
- **Waits.** A member's approval is a `decision` wait at
  `<changeset>/members/<component>/authorize`, with the member's
  `action_digest`, `changeset` (S) and `component`. The set's approval is
  one at `<changeset>/authorize` with `action_digest` = S. `mandate approve`
  answers both.
- **Partial set.** The run's `attention` is
  `{ changeset_partial: { set, applied, stopped_at, not_sent, compensation } }`.
  `mandate reconcile` (ReconcileAction) on the stopped member's operation
  resumes the run.
- **`git.merge`** (`GitHubMerges`): configured with `"github": { "repos": […] }`
  and MANDATE_GITHUB_TOKEN. Its retry class is `reconcilable`.

## Boundary verifier (design doc 9 §4, B5)

`BoundaryVerifier` answers `test.suite_each`, `test.contract`,
`test.integration`, `test.ci` and `test.planned` (B8), and passes every other method to the
verifier it wraps. Verify requests carry the system
(`VerifyRequest.system`): every component with its repository, root, base
commit, language, commands and interfaces, and every interface with its
protocol, spec and provider.

Configuration (`mandate.runtime.json`):

```json
"boundary": {
  "integration": { "dir": "../acme-system/compose", "files": ["base.yml", "staging.yml", "integration.yml"], "service": "e2e" },
  "ci": { "mode": "rerun", "workflow": "ci" },
  "pinned": { "mcp": ["test/**"] },
  "extraRead": { "core": ["/root/.m2"] }
}
```

- `integration` writes an override that builds each of the run's components
  from its working copy and makes the default network internal. It reads
  the resolved configuration back (`docker compose config`) and refuses
  published ports and networks that are not internal. Each overridden
  service gets an image name of the project's, so candidate images never
  replace others. It runs `build`, then `run --rm <service>` (which starts
  what the service depends on), and then `down -v --rmi local`.
- `suite_each` runs a component's tests as its change left them and lists
  the test files that differ from the base commit (`tests_changed`). Files
  `pinned` names run as they were at the base commit.
- A component's toolchain (a JDK, an interpreter) may live in a container:
  `ContainerHost` is a sandbox host for the same contract. It runs each
  command in its configured image with `--network none`, all capabilities
  dropped, a read-only root file system and a tmpfs `/tmp`. Only the
  policy's paths are mounted, read-only unless writable, and the
  allow-list is enforced before start. A linked dependency directory is
  mounted in its place, read-only, with tmpfs cache directories. It is
  probed and planned like MXC (isolation `container`).
- `ci` reads GitHub Actions (MANDATE_GITHUB_TOKEN). Attestation
  verification is a pluggable hook (`GitHubCi.attest`); without one, every
  result is unattested.
- Evidence records name the producer `mandate-boundary-verifier@0.3`.

## Read broker and run modes (design doc 9 §5, B6)

- **`ReadBroker`** (`adapters.broker`): `query(ReadRequest)` →
  `{ rows, masked, as_of, truncated, row_count }`. The request carries the
  environment, the read, its component, the query or log filter from the
  IR, the parameters, `max_rows`, every field's data class and the caller's
  `max_class`.
- **`DeclaredReads`** is configured per `<environment>/<component>`:
  `"broker": { "prod_sim/core": { "url_env": "MANDATE_PROD_SIM_CORE_URL" }, "prod_sim/mcp": { "logs": "data/prod_sim/logs" } }`.
  Database URLs come from the environment only. SQL `:name` placeholders
  become `$n` and run as `select * from (<query>) limit max_rows + 1` in a
  `read only` transaction with a statement timeout. Logs are
  `<component>.jsonl` filtered by the read's expression (comparisons,
  `and`, `or`, `not`, literals, fields, parameters; nothing else runs).
- **`SampleReads`** (`adapters.samples`, `"samples": "samples.json"`)
  answers design runs from rows by `<environment>.<read>`. A design run
  without samples fails the read with `PolicyDenied(no_samples)`; a run
  without a broker, with `no_broker`.
- **Modes.** `StartRun({ mode })` / `mandate run --mode design|read_only|live`.
  The manifest records the mode. A read_only effect is prepared and then
  recorded `would_apply` (an action state that is never open); it returns
  `{ would_apply, effect, action_digest, operation }`. A design effect is
  a `simulate` command. Evidence records of non-live runs carry `mode`.
- **`shadowDiff(rt, a, b)`** / `mandate shadow-diff`: see
  [`system.md`](system.md#reads-and-run-modes-b6).

## Onboarding verifier and drift (design doc 9 §7, B7)

- **`OnboardVerifier`** (`runtime/src/onboard.ts`; configured by
  `"onboard": { "hosts": {…}, "extraRead": {…}, "timeoutMs": n }`) answers
  `test.system_specs`, `test.consumes` and `test.commands`, and hands
  every other method to the verifier it wraps. Each takes the draft's path
  and `at:`, the component whose working copy holds it. Its evidence
  names the draft, binds to every component's working copy, and comes from
  handler `mandate-onboard-verifier@0.3`.
- Repositories are read at the run's base commit (`git archive`), never
  as the working copy left them. `test.commands` runs each component's
  build and test commands in the sandbox, writable only in that tree.
  Linked dependency directories are readable and never writable. With no
  network (K7), a build that fetches dependencies needs a cache that
  `extraRead` makes readable. A command that cannot run fails the
  criterion; it is not skipped (INV-11).
- `hosts` maps a network name to a component (by default, each
  component's own name). The scanner matches `http(s)://<host>` URLs, and
  a quoted host as the default of a `*HOST*`, `*URL*`, `*ISSUER*` or
  `*ENDPOINT*` setting. It skips tests, `docs`, dependency and build
  directories.
- `scan`, `draft` and `drift` are exported. `mandate onboard` and
  `mandate drift` (no configuration needed) print a draft module, or the
  findings (`--json`). `drift` exits 1 on drift, and 0 when there are only
  warnings.
