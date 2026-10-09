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
| `packages` | Content-addressed packages: program and lock |
| `runs` | State, revision, lease fence, cancel flag, waiting / attention / result / error / summary |
| `events` | The run's append-only event log |
| `commands` | One row per nondeterministic step: request digest, state, result or error, cost |
| `budgets` | Limit and settled amount per dimension (`tokens`, `steps`, `spend:<currency>`) |
| `reservations` | Upper-bound reservations per command and dimension |
| `actions` | External actions: digest, frozen parameters, retry class, state, receipt |
| `authorizations` | Bound to one action digest, with an expiry; `consumed_by` is unique |
| `evidence` | Contract criteria results that back a `Verified` value |
| `inbox` | Inbound message keys with their payload digests |
| `outbox` | Committed actions waiting for, or past, delivery |

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

`budgetReport` returns the run's budget table:

- per dimension: limit, settled, active reservations and what is available;
- per command that reserved or spent anything: its label (`Agent.skill`
  for a delegate), what it reserved, which reservations are still open, and
  the cost it reported (`"unknown"` until a late charge is settled).

## External effects (§8.5, §8.8, §8.9)

1. **Prepare.** The adapter validates the parameters. The runtime then
   freezes them into an action digest. The digest covers the package, run,
   node, effect, adapter id, adapter contract digest, parameters, evidence
   and idempotency key. The operation key is derived from the tenant, run,
   node and action digest.
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

A worker may find an action already dispatched, because the previous worker
died after commit. The adapter's retry class then decides what happens:

| Retry class | On resume |
|---|---|
| `idempotent` | Sent again under the same operation key; the remote system applies it once |
| `reconcilable` | The system of record is asked first; sent only with proof it was not applied |
| `non_retryable` | Never sent again; the action becomes `unknown_outcome` |

An `unknown_outcome` is never retried blindly. The run needs attention
until `ReconcileAction` resolves it (R04, R05).

## Contracts and evidence (§10)

`verify x against C(…)` checks C's `require` clauses, then its criteria
in order of their method: static checks, tests, evals and reviews, then
people; by name within each group. A criterion that combines methods runs
with its last one. Each check records one evidence row: contract, criterion, method, passed,
and detail. A criterion that names several checks (`static … and
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

Unmet criteria go to `on unmet(c)`, or else fail the verify with
`Rejected`. An answer to an `escalate` there is the escalation's value,
never a `Verified` one, so an effect that requires the contract still
refuses it (INV-13).

## Supervision and `par` (§7.4, §8.7)

- **Restart.** `supervise restart(max, backoff)` restarts a delegate on
  `Timeout` or `SkillFailed`, and never on other faults. Backoff is
  exponential with jitter. The jitter is a journaled command, so replay
  neither draws it again nor waits.
- **Branch results.** `par` branches start together, and their results are
  bound by branch name, never by completion order.
- **`fail_fast`.** Under `fail_fast` (the default), the first fault stops
  the other branches before their next dispatch. The block still ends only
  when every branch has settled, so an external action already in flight is
  followed to its result (R10).

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
- requires every imported non-std module to be pinned in the lock;
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

## Temporal scheduling (§16.1)

Temporal's history holds only scheduling. There is no distributed
transaction between it and PostgreSQL. Each run has one workflow, with the
id `mandate-run/<run id>`, and the workflow loops:

1. It calls the `drive` activity, which runs `Runtime.resume`.
2. If the run is terminal, the workflow ends with the run's state.
3. If the run is waiting or needs attention, the workflow sleeps until a
   `wake` signal arrives, or until the deadline of the wait the run is in.
4. On a signal it drives the run again. When the deadline passes, the
   `expire` activity runs `Runtime.tick`, which expires the wait and drives
   the run on (R15).

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
- cancel;
- reconciliation (R04).

## Not in this runtime yet

- **Continue-as-new.** A run that waits very many times grows its workflow
  history; the workflow does not yet start a fresh history.
- **Restart backoff as a durable timer.** The backoff wait happens inside
  the `drive` activity, not on a Temporal timer.
- **`map`, and so R11 by input index and R12.** The 0.1 IR has no `map`.
  `par` results are bound by name, and that binding is tested in its place.
- **Continuing after `budget_exceeded`.** The control API has no operation
  that raises a run's limits, so the run waits and can be cancelled.
- **The adapter contract's `ValidateBinding` and `Cancel`.**
- **Automatic compensation.** 0.1 offers it to a person and never runs it.
