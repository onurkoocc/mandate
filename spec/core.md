# Mandate core, 0.1 and 0.2

Mandate is a coordination and contract language for agents. Agents write
programs. People review them through generated views. The compiler checks
authority, effects, budgets, contracts and delegation before anything runs.

This page is the compact core of the language, meant to fit in an agent's
context (design doc 4, G8: under 8,000 tokens). It says what a program
means. The detailed rules are on the other pages:

- [`ir.md`](ir.md) and [`ir.schema.json`](ir.schema.json): the IR, its schema and hashing;
- [`checks.md`](checks.md): the static checks;
- [`runtime.md`](runtime.md): execution;
- [`sandbox.md`](sandbox.md): sandboxes;
- [`diagnostics.md`](diagnostics.md): diagnostic codes.

*Must* marks a rule that every conforming implementation follows.

## 1. Programs

A program is one module: a canonical JSON IR document, closed by
[`ir.schema.json`](ir.schema.json).

```json
{ "language": "mandate/0.2", "module": "company.devflow", "version": "0.1",
  "uses": [ … ], "defs": { "<Name>": { "kind": "…", … } }, "tests": { … } }
```

- The IR is the source of truth. The `.mdt` text form is a projection:
  text lowers into IR and IR prints back as text, and both keep the hash.
- `language` is `mandate/0.1` or `mandate/0.2`; 0.2 adds an agent's
  `loop` and `progress` (§5). In text, a 0.2 file starts with
  `mandate @ 0.2`.
- A reader must reject, not repair, any of these: another `language`, an
  unknown field, a duplicate key, a non-integer or out-of-range number, a
  lone surrogate, or input over the limits (1 MiB of source, nesting 64,
  64 definitions, 1000 expanded nodes per workflow).
- Order carries no meaning in definitions, record fields, criteria and
  `par` branches; these are objects keyed by name. Sets such as `uses`,
  `caps` and effect lists are sorted arrays. Parameters, statements and
  arguments keep their order.
- The program hash is
  `SHA256("mandate/program/<v>\n" ‖ JCS(program))`, written
  `sha256:<hex>`, where `<v>` is the language version. Each definition is
  hashed the same way under the domain `def`. A patch names the hash it was written against; if the program
  has changed since, it is refused (`stale_base`).

Definition kinds:

| Kind | Declares |
|---|---|
| `type` | A named type, optionally with a data class |
| `capability` | A named authority value, e.g. `fs.write("/work/repo/src")` |
| `const` | A pure constant |
| `fn` | A function: parameters, return type, effects, optional budget, body |
| `extern` | A host function (`py`, `ts`, `java`) with declared effects |
| `effect` | A user effect: parameters, the capability it requires, and whether it is critical or irreversible, with its retry class |
| `agent` | A role, capabilities, a budget and skills; or a remote A2A binding |
| `workflow` | An entry point: parameters, capabilities, budget, body, event handlers |
| `contract` | Acceptance criteria over its parameters |

## 2. Types

Base types are `Bool`, `Int`, `Dec`, `Text`, `Bytes`, `Path`, `Url`,
`Time`, `Duration` and `Money`. Generic types are `List<T>`, `Set<T>`,
`Map<K,V>`, `Option<T>` and `Result<T,E>`. A type can also be:

- a record, `{ f: T, … }`;
- an enum;
- a union of tagged variants;
- a refinement, `T where e`.

Money is integer micro-units plus an ISO 4217 code. Amounts in different
currencies are never added implicitly. A duration is milliseconds. A
`Budget` is `{ tokens?, spend?, time?, steps? }`.

### 2.1 How a value is known

A type also records how its value is known:

```text
Verified<T, C>  <:  T  <:  Inferred<T>  <:  Untrusted<T>
```

| Type | Comes from |
|---|---|
| `T` | Deterministic computation or trusted input |
| `Inferred<T>` | Model output: `infer`, a skill's result, a remote agent |
| `Untrusted<T>` | Outside content: files, the network, people's text |
| `Verified<T, C>` | `verify x against C(…)` when every criterion of `C` was met |

The rules:

- **R1.** An `Inferred` or `Untrusted` value cannot be used where `T` is
  expected.
- **R2.** A `Verified<T, C>` value is accepted only where contract `C` is
  expected.
- **R3.** Taint is contagious. Fields of, operators over and records built
  from an `Inferred` value are `Inferred`. Only `verify` removes the taint.
- **R4.** The parameters of a critical effect accept only `T` or
  `Verified` values.
- **R5.** A prompt has an instruction region and a data region. `Untrusted`
  and `Inferred` values enter it only through `quote(…)`.
- **R6.** `peek(v)` reads model output as a plain value, and the compiler
  warns about it.
- **R7.** `Evidence`, `Authorization`, `Receipt` and `Verified` are
  protected. Only the runtime produces them; a program, a model or a record
  literal cannot.

### 2.2 Data classes

A value has a data class: `public < internal < confidential <
restricted`. It takes the highest class of what it came from, and model
output inherits the highest class of its input. A program cannot lower a
class. A model capability states the highest class the model may receive,
`internal` by default.

### 2.3 Decisions

A model asked to choose from a closed set returns
`Inferred<Decision<T>>`.

- A policy function (`threshold`, `top_margin` or `abstain_if`) turns it
  into `Confident(T) | Uncertain`.
- A `switch` on that result must handle `Uncertain`.
- A raw decision cannot steer control flow, and cannot reach a critical
  effect.

## 3. Effects

Each step that touches the world is an effect. The built-in effects are
`Fs.Read`, `Fs.Write`, `Net`, `Model`, `Tool`, `Exec`, `Human`,
`Delegate`, `Spend`, `Time` and `Random`. External effects carry their
declared name, e.g. `git.open_pr`.

- A function or skill must declare every effect it uses, including those of
  the functions it calls. A public function must declare its effects.
- A **critical** effect is one that changes shared state outside the run.
  It must declare `idempotency required`, must be called with
  `idempotent_by <business key>`, and may run only in a workflow body:
  never in a function, a skill or a contract.
- An **irreversible** effect also needs one of these: an earlier
  `human.approve` in the same body, or an argument verified by a contract
  that has a `human.approve` criterion.
- A **retry class** is declared, not inferred from a name. It is one of
  `read_only`, `idempotent`, `reconcilable` or `non_retryable`.

## 4. Capabilities

A capability is the authority to use an effect over a scope. A program
cannot create authority. Capabilities are granted at the entry point,
passed explicitly, and can only shrink.

| Constructor | Authorizes | Scope |
|---|---|---|
| `fs.read(P…)`, `fs.write(P…)` | `Fs.Read`, `Fs.Write` | Paths, compared by segment after resolving `.` and `..` |
| `net.https(hosts: […])` | `Net` | Hosts |
| `model.infer(tier: t, max_class: c)` | `Model` | A model tier and the highest data class |
| `exec(commands: […], args_prefix: […])` | `Exec` | Commands and their argument prefixes |
| `git.pr(repo)` | `git.*` | Repositories |
| `money.spend(…)` | `Spend` | — |

`Human`, `Time`, `Random` and `Delegate` need no capability. The rules:

| Rule | Says |
|---|---|
| C1 | Every effect a workflow body or skill uses is covered by a capability in scope |
| C2 | A delegate gets the agent's capabilities that lie inside the context's (`A.caps ∩ avail(ctx)`). `with caps K` replaces the kinds it names, and K must lie inside both |
| C3 | `c.narrow(…)` is always inside `c`; nothing widens a capability |
| C4 | A workflow's `caps` are the upper bound of what its entry point may be granted |
| C5 | The write capabilities (`fs.write`, `git.*`) of different `par` branches do not overlap |

A capability that nothing uses is reported, because the sandbox it
produces is the upper bound of real use.

## 5. Agents, skills and workflows

- **Functions.** A `fn` body is deterministic. Its effects are recorded.
- **Skills.** A skill without a body runs as an agent loop. Its result is
  `Inferred<T>`, and it needs a `steps` limit in its own or its agent's
  budget.
- **Agent loops (0.2).** The loop runs in the runtime, outside the sandbox:
  - The agent's tools come from its grant and run inside its sandbox.
  - Every model turn and tool call is a recorded command, charged to the
    delegation's budget.
  - It ends when the model hands back a value that fits the result type.
  - It stops with `SkillFailed(kind)` when it repeats a call
    (`progress { window, repeats }`) or observes nothing new for `stall`
    turns, or runs out of steps.
  - `loop plan_execute` checks the whole plan before any tool runs.
- **Workflows.** A `workflow` body is deterministic orchestration. Every
  nondeterministic step in it is a recorded command (§7). Functions and
  workflows cannot call each other in a cycle.

### 5.1 Statements and expressions

| Form | Meaning |
|---|---|
| `let x = e` | Binds a value. Names are immutable |
| `if c { … } else { … }` | Branches on a plain `Bool`, never on model output |
| `loop max_iter n { … } until c` | Bounded iteration; a loop needs `max_iter` or `until` |
| `par { a = e₁ ; b = e₂ }` | Runs branches together. Results are bound by branch name, never by finishing order |
| `switch e { P => e, … }` | Must cover every variant |
| `delegate A.s(args) [with caps K] [budget b] [isolated] [supervise …]` | Runs agent A's skill s with the granted authority and budget; `isolated` passes nothing implicitly |
| `infer T from e [using m]` | Asks a model for a `T`; the result is `Inferred<T>` |
| `verify x against C(args) [on unmet(c) => e]` | Checks contract C (§6) |
| `effect E(args) idempotent_by k [compensate F]` | An external effect (§7.2) |
| `escalate human(msg)`, `human.ask(q)`, `pause` | Waits for a person; `human.ask` returns `Untrusted<Text>` |
| `e?` | Propagates a `Result`'s error |
| `s` then `on error(P) => h` | Handles the faults of statement `s` that match P |

### 5.2 Faults and supervision

Expected failures are values that a program can match:

- `Timeout`
- `BudgetExceeded`
- `SkillFailed(…)`
- `Rejected(…)`
- `PolicyDenied(…)`
- `UnknownOutcome(…)`

There are no exceptions. A broken invariant is never handed to the
program: the run stops for a person (`attention_required`).

| Strategy | Where | Allowed on |
|---|---|---|
| `restart(max: n ≤ 5, backoff: d)` | `delegate` | `Timeout` and `SkillFailed`; the same input again, exponential backoff with recorded jitter |
| `fail_fast` (default) | `par` | The first fault stops the other branches before their next dispatch; the block still waits for work already in flight |
| `restart_all` | `par` | Only when no branch has external effects |
| `reconcile` | `on error(UnknownOutcome)` | The only way to handle an unknown outcome |

### 5.3 Budgets

- **Static.** The checker adds up what a workflow hands out and compares
  it with the workflow's own budget. Sequences and `par` add up money and
  tokens; `par` takes the longest time; `if` and `switch` take the larger
  branch; `loop` multiplies by `max_iter`. Upper bounds are used, never
  averages.
- **Run time.** Every command reserves its upper-bound cost when it is
  dispatched, atomically with the dispatch record. It is refused when
  `limit − settled − active reservations` cannot cover it. A run's limits
  are the minimum of the workflow's budget and the caller's limits.
- **Exhaustion.** `BudgetExceeded` runs the workflow's
  `on budget_exceeded` handler; with no handler, the run pauses for a
  person. A person may raise the run's limits, up to the workflow's own
  budget. This is a governance change. Once the handler's question is
  answered, the run tries again from the command that did not fit.

## 6. Contracts and evidence

```mandate
contract FixAccepted(issue: Issue, pr: PullRequestDraft) {
  require issue.reproducible
  accept suite_green "The existing test suite passes" by test.suite(["unit", "integration"])
  accept owner_approved "The code owner approved"     by human.approve(role: "code_owner")
}
```

- **Methods.** A criterion is met `by static e`, by a verifier call
  (`test.*`, `eval`, `review(…)`), by `human.approve(role)`, or by several
  of these joined with `and`.
- **Review alone.** `review(…)` alone never meets a criterion.
- **Static criteria.** A `static` criterion the compiler cannot prove is
  checked at run time, with a warning.
- **Order.** `verify` checks `require`, then the criteria in order of
  their method: static, then tests, then evals and reviews, then people.
  A person is asked only once every other criterion is met. With
  `human.approve(role: r, deadline: d)`, an approval not given within `d`
  is unmet.
- **Evidence.** Each check records evidence. The verifier produces the
  evidence, never the agent. When every criterion is met, the value
  becomes `Verified<T, C>`, carrying the ids of its evidence.
- **Unmet criteria.** They go to `on unmet(c)`, or else the verify fails
  with `Rejected`. An answer to an escalation is never `Verified`.

## 7. Execution

### 7.1 Durable, deterministic runs

- **Commands.** Every nondeterministic step of a workflow is a command
  with a stable id, the IR path of the node that issued it: delegates,
  model calls, verifier calls, reads, time, randomness and waits for
  people. Its result is recorded before the program sees it.
- **Recovery and replay.** Recovering from a crash, and replaying a run,
  both re-run the body against the record. A command already recorded is
  never sent again, and replay calls no adapter (INV-09).
- **A changed request.** If a recorded command is found with a different
  request, the run stops (`nondeterministic_replay`).
- **Pinned package.** A running run keeps its package. Before a run
  starts, the runtime recomputes the package's hashes, requires every
  imported module to be locked, and re-runs the checks.

### 7.2 External effects: prepare → authorize → commit

A critical effect runs in three steps:

1. **Prepare.** The parameters are frozen into an action digest. The digest
   covers the package, run, node, effect, adapter and its contract,
   parameters, evidence and business key.
2. **Authorize.**
   - By default, policy authorizes, and a person must authorize an
     irreversible effect.
   - A person's approval is bound to the digest they saw and applies only
     before the wait's deadline.
   - A model or a program cannot authorize.
3. **Commit.** One atomic step checks that the authorization exists,
   matches the digest, is unused and unexpired, and that the run was not
   cancelled. It then consumes the authorization and records the dispatch.
   Only then is the adapter called.

On recovery, an action that was already dispatched follows its retry class:

| Retry class | On recovery |
|---|---|
| `idempotent` | Sent again under the same operation key |
| `reconcilable` | The system of record is asked first; sent again only with proof it was not applied |
| `non_retryable` | Never sent again; the action becomes `unknown_outcome` |

An unknown outcome is never retried blindly. It waits for reconciliation,
and no run ends cleanly while an action is unresolved (INV-12). Automatic
compensation does not exist in 0.1; it is only offered to a person.

### 7.3 People and cancellation

- **Inbound messages.** They are deduplicated by sender and message id.
  The same id with a different payload is refused.
- **Cancellation.** It is an event, not erasure. A dispatch after the cancel
  request is refused. An action already in flight is followed to its real
  result and reported.
- **Run states.** `accepted`, `running`, `waiting`, `attention_required`,
  `succeeded`, `failed` and `cancelled`.

### 7.4 Sandboxes

Each local agent runs in a sandbox. The sandbox is built from the
authority its delegation was actually granted:

- read and write paths;
- commands with their argument prefixes;
- hosts and model tiers;
- no desktop and no clipboard;
- its `time` budget as a timeout.

A sandbox adapter probes the host first. A requirement the host cannot
enforce refuses the agent's start with
`PolicyDenied(unsupported_sandbox_profile)`. It is never run with less
isolation or in a permissive mode (INV-11).

## 8. Invariants

Every conforming implementation keeps these:

| Id | Invariant | Where 0.1 keeps it |
|---|---|---|
| INV-01 | An agent cannot grant itself authority | C1–C3; capabilities only shrink |
| INV-02 | A running run's package does not change | Content-addressed packages; load-time verification |
| INV-03 | External effects go only through the runtime's broker | E0408; prepare → authorize → commit |
| INV-04 | Model output is never proof or permission | R1, R4, R7 |
| INV-05 | Evidence and authorization match the action they allow | Action digest; evidence ids in the digest |
| INV-06 | A retry or a duplicate message is not a new action | Operation keys; inbox deduplication |
| INV-07 | An unknown outcome is neither success nor failure until reconciled | `unknown_outcome` |
| INV-08 | A budget covers the whole run | One ledger per run; atomic reservations |
| INV-09 | Replay makes no model call and no external effect | Replay reads the record only |
| INV-10 | Views of authority, effects and state come from the program and the record | Not yet: 0.1 generates no views (§9) |
| INV-11 | An unsupported security requirement is never dropped silently | Sandbox probe; E0902 |
| INV-12 | No clean end while an external effect is unresolved | `attention_required` |
| INV-13 | `Inferred` and `Untrusted` values do not reach a critical effect or an instruction unverified | R1, R4, R5; runtime check of `Verified` parameters |
| INV-14 | Parallel branches do not share a writable resource | C5 |

## 9. Not yet

- **Not in the IR:** `map`, dynamic `spawn` and `await`.
- **Agent loops:** these strategies are not implemented yet:
  - `degrade` and `escalate` as supervision strategies;
  - `Throttled` and shared rate limits.
- **Not enforced yet:** a delegate's `timeout`, a workflow's `ensures`, and
  running `tests`. All three are checked, not enforced.
- **Not generated yet:** these targets: host code, MCP, A2A, AX and
  views.
