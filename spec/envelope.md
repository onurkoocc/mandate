# Envelopes and signed decisions (0.4)

**Status: being implemented.** The page specifies language version 0.4 so
that the TypeScript implementation and, later, the Rust one are held to the
same cases.

| Part | State |
|---|---|
| The language surface: `role`, `envelope`, `map`, `plan`, `agents`, `Outcome` in the IR, the schema, the text form and the views | implemented |
| Roles: E1501, E1502, E1503; lock format 0.4 with `members` and `roles` | implemented |
| The envelope's own rules (E1701 to E1708) | not yet; `mandate explain` knows the codes, `mandate check` does not report them |
| Signed decisions, the envelope's ledger and approval, running `map` and `plan`, amendments, the card | not yet |

Until the runtime runs 0.4, it refuses a 0.4 package when it loads one
(`unsupported_language`): a version is never run on a best-effort basis.
So a 0.4 program can be read, checked, hashed, printed and viewed today,
and not run.

0.4 lets an agent plan work while a run is going, without a person approving
every step. A person approves an **envelope** once: the most authority,
budget, agents and data the run may use, and the effects that still need a
person. A lead agent then writes sub-programs. The compiler checks each one
against what is left of the envelope, and only a sub-program that fits runs.
Critical effects still go through prepare → authorize → commit.

0.4 also makes a person's decision verifiable. A role is a definition, the
lock binds it to people and their keys, and every decision is a signed
record. A decision whose signature does not verify is not a decision.

The page follows the continuation analysis of 26 October 2026 (§4.2, §5):
its acceptance cases E-01 to E-06 are N01 to N06 here.

## What 0.4 adds

| Addition | Where | Meaning |
|---|---|---|
| `role` | definition | A role people hold; the lock says who |
| `envelope` | workflow | The upper bound of a run: authority, budget, agents, data class, effects a person authorizes, who approves it |
| `map` | expression | Runs a body once per element of a list, with a bound and a concurrency |
| `plan` | expression | Runs a lead agent that may submit sub-programs within the envelope |
| `distinct_from` | `human.approve` | Two approvals that must come from different people |
| `agents` | budget dimension | Delegation attempts a run may start |
| `members`, `roles` | lock | People, their public keys, and the roles they hold |

A file names the version first: `mandate @ 0.4`. A 0.4 field or definition
in an older program is E0104. An older program reads, checks and hashes
exactly as before.

## Roles

```mandate
role code_owner      "Code owner of company/backend"
role release_manager "Release manager"
```

In IR: `"code_owner": { "kind": "role", "description": "Code owner of company/backend" }`.

- **Where a role is named.** `human.approve(role: …)`, `human.ask(…, role: …)`,
  `escalate human(…, role: …)`, `supervise escalate(human, role: …)`, a
  change set's `approve role` and `approved_by role`, a component's `owner`,
  an environment's `authorize … by human(role: …)`, and an envelope's
  `owner` and `approve`. In a 0.4 module each of these must name a `role`
  defined in the module or imported with `use` (E1501). The text form
  `role: "code_owner"` still parses and resolves by name. A role is a
  name or that text, never a computed value (E1501). A role imported from
  a module that is not loaded is taken on trust, as any imported name is.
- **An older module** names a role with any text and defines none. E1501
  does not apply to it, and it checks as before.
- **A wait with no role** accepts a decision from any member the lock lists.
- **The `role "…"` line of an agent** is a description for its model, as
  before. It is not a role.

## The lock: members and roles

The lock format becomes `mandate/lock/0.4`. A `0.3` lock is still read; a
0.4 package needs a `0.4` lock when it names a role.

```json
{
  "lock": "mandate/lock/0.4",
  "members": {
    "alice": { "keys": ["sha256:3f1c…"] },
    "bob":   { "keys": ["sha256:9a07…"] }
  },
  "roles": {
    "code_owner":      ["alice"],
    "release_manager": ["bob"]
  }
}
```

- A key is named by its id: the SHA-256 of its ed25519 public key, as for
  evidence keys ([`runtime.md`](runtime.md#evidence-records-103)). The
  public keys themselves are files `<key id>.pem` in the directory that
  `decisions.keys` names in `mandate.runtime.json`. A file whose public key
  does not hash to its name is refused.
- Every role a 0.4 package names is bound to at least one member (E1502
  when `mandate check` is given the lock; `unbound_role` at load time).
  The roles a package names are those of its own definitions and of the
  definitions it imports, so the owner of an imported component counts
  (E1502 is then reported at the import). A
  `0.3` lock has no `roles`, so with one every role is unbound.
- A member may hold several keys, so a lost key can be replaced. One person
  is one member: `distinct_from` compares members, not keys.
- The lock is part of the package hash, so a changed binding is a new
  package. `mandate view --against` shows an added member, an added key or
  a member added to a role as a governance change.

## Signed decisions

Every message by which a person changes a run is a signed **decision
record**: an approval or a decline (`DecideAction`), an answer
(`SubmitInput`), a raise of the limits, a reconciliation, an envelope
approval and an amendment. A cancel request may be signed and is always
accepted.

```json
{
  "format": "mandate/decision/0.1",
  "kind": "approve",
  "package": "sha256:…",
  "run": "run_7c…",
  "revision": 41,
  "command": "/defs/FixBug/body/6/value",
  "subject": "sha256:…",
  "role": "code_owner",
  "member": "alice",
  "key": "sha256:3f1c…",
  "payload": "sha256:…",
  "at": "2026-11-10T14:02:11Z"
}
```

The signature covers `mandate/decision/0.1\n` followed by the record's JCS
bytes. `kind` is one of `approve`, `decline`, `answer`, `raise_limits`,
`reconcile`, `envelope`, `amend` and `cancel`. `subject` is the digest the
wait shows: a contract's `subject_digest`, an action digest, a change set's
digest S, or a package hash. `payload` is the digest of the answer, the new
limits or the reconciliation; it is absent for an approval or a decline.

The runtime accepts a decision only when all of these hold. Otherwise it is
refused with `invalid_decision` and a reason, nothing is recorded, and the
wait stays open:

1. The signature verifies under the named key.
2. The key belongs to the named member, and the member holds the wait's
   role, in the lock of the run's package.
3. The package, run, revision, command and subject are the ones the wait
   shows now. A decision on another revision is `stale_revision`, as before
   (G10); on another subject it is refused (G02).
4. For `human.approve(role: r, distinct_from: q)`, the member is not the one
   who decided `q` in the same criterion.

An accepted record is stored with its signature. The evidence record of a
`human.approve` criterion names the member, the role, the key and the
decision record's digest, and `verifyEvidence` checks the decision's
signature too. A record changed after signing shows as invalid, as evidence
does.

The first signer is a key per operator, created with `mandate key new`.
OIDC and passkeys are later signers of the same record; they need no change
to the format. Mandate does not run an identity provider.

**Unsigned mode.** A package of 0.1 to 0.3 may run with
`decisions: { "mode": "unsigned" }` in `mandate.runtime.json`, and then
`--by NAME` works as before. Its views mark each decision `unsigned`. A 0.4
package never runs in unsigned mode.

### `distinct_from`

```mandate
accept two_people "Two different people approved"
  by human.approve(role: accountant)
     and human.approve(role: finance_lead, distinct_from: accountant)
```

`distinct_from` names a role approved earlier in the same criterion
(E1503). The two waits open one after the other. The second refuses a
decision by the member who made the first (`invalid_decision`,
`same_member`). An approval that is not part of a contract criterion has
no earlier approval to compare with, so `distinct_from` on it is E1503
too.

### The CLI

```sh
mandate key new [--out FILE]                                  # prints the key id and the public key
mandate approve      <run> --revision N --key FILE [--member NAME]
mandate decline      <run> --revision N --key FILE [--member NAME]
mandate answer       <run> --revision N --key FILE [--member NAME] <text>
mandate raise-limits <run> --revision N --key FILE [--member NAME] --limit spend=30USD
mandate approve-envelope <program> --key FILE [--member NAME]
mandate amend        <run> --revision N --key FILE [--member NAME] (approve | decline)
```

`--member` is needed only when a key id is listed under more than one
member, which the lock forbids, so in practice never. A private key file
must be readable by its owner only; the CLI refuses one that is not.

## The envelope

```mandate
mandate @ 0.4

module company.migrations @ 0.1

use std.{fs, exec, model, git, human}
use company.domain.{Repo, Summary}

role platform_lead   "Platform lead"
role release_manager "Release manager"

capability RepoRead = fs.read("/work/repos")
capability SrcWrite = fs.write("/work/repos")
capability Build    = exec(commands: ["npm"], args_prefix: [["ci"], ["test"]])
capability ModelStd = model.infer(tier: standard)
capability Merge    = git.pr("company/backend", "company/frontend")

agent Migrator {
  role   "Moves one repository to the new logging API."
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget { tokens: 400k, time: 20m, spend: 0.5 USD, steps: 12 }
  skill migrate(repo: Repo) -> Inferred<Summary> ! {Fs.Read, Fs.Write, Exec, Model}
}

agent Lead {
  role   "Plans what is left after the bulk migration and writes sub-programs for it."
  caps   RepoRead, ModelStd
  budget { tokens: 2000k, spend: 10 USD, steps: 40 }
  skill finish(repos: List<Repo>, done: List<Outcome<Inferred<Summary>>>) -> Inferred<Summary> ! {Fs.Read, Model}
}

workflow MigrateAll(repos: List<Repo>) -> Inferred<Summary>
  envelope {
    owner   platform_lead
    caps    RepoRead, SrcWrite, Build, ModelStd, Merge
    budget  { tokens: 80000k, time: 6h, spend: 120 USD, steps: 2000, agents: 200 }
    spawn   { max_concurrent: 16, max_class: internal }
    approve git.merge by release_manager
  }
{
  let done = map repo in repos max 150 par 16 with caps SrcWrite.narrow(repo.root) {
    delegate Migrator.migrate(repo)
  }
  plan Lead.finish(repos, done) within envelope
}
```

### What it declares

| Field | Meaning |
|---|---|
| `owner` | The role that approves the envelope before a run starts, and every amendment. Required |
| `caps` | The upper bound of authority for everything the run does: the body, every delegation, every sub-program. It takes the place of the workflow's `caps` (C4) |
| `budget` | The upper bound of the whole run, sub-programs included. It takes the place of the workflow's `budget`. `agents` is the most delegation attempts the run may start |
| `spawn.max_concurrent` | The most delegations in flight at once, in the whole run |
| `spawn.max_class` | The highest data class any delegation in the run may receive; `internal` when absent |
| `approve E by r` | Effect `E` is authorized only by a decision of role `r`, never by policy, wherever in the run it happens. One line per effect |

The static part of this example fits: 150 items of Migrator and one Lead
are 151 agents, 75 + 10 = 85 USD, 60,000k + 2,000k tokens, 1,800 + 40 steps,
and ⌈150 / 16⌉ × 20 min = 3 h 20 min. What is left (49 agents, 35 USD, …)
is what sub-programs may claim. `Merge` is used by no static step: it is
there for sub-programs, so W0310 does not report a capability of an
envelope whose workflow has a `plan`.

A workflow with an envelope writes no `caps` or `budget` of its own (E1701).
An envelope needs `owner`, `caps` and `budget` with `agents` (E1701). Every
effect under `approve` is critical, and a capability in `caps` covers it
(E1704).

In IR the envelope is a field of the workflow. The workflow's own `caps`
stays in the IR, as the empty list, and the text form does not write it:
the field is required of every workflow since 0.1, and an older reader's
diagnostics for it do not change.

```json
"envelope": {
  "owner": "platform_lead",
  "caps": [ { "op": "var", "name": "Build" }, … ],
  "budget": { "tokens": 80000000, "spend": { "micros": 120000000, "currency": "USD" },
              "time": { "ms": 21600000 }, "steps": 2000, "agents": 200 },
  "spawn": { "max_concurrent": 16, "max_class": "internal" },
  "approve": { "git.merge": "release_manager" }
}
```

### Approving an envelope

A run of a workflow with an envelope starts only once a member of its
`owner` role has approved the package: a signed decision of kind `envelope`
whose subject is the package hash. `StartRun` refuses a run without one
(`unapproved_envelope`). The approval is for that package hash only: a
changed program, lock or imported module is a new package and needs a new
approval (N04).

A person approves the envelope from its card, `mandate view <program>
--card` ([below](#views)), and signs it with `mandate approve-envelope`. One
approval serves every run of that package.

### The ledger

`agents` is a ledger dimension like `steps`. Every delegation attempt
reserves one when it is dispatched: a first attempt, each restart, and a
degrade fallback. A delegation that does not fit is `BudgetExceeded` and
goes to the run's budget handler, as today. Two siblings cannot both
reserve the last one (R07, N02).

`max_concurrent` is not a ledger. A delegation that would exceed it waits
until another one in the run settles. The wait is not an attempt, holds no
reservation and is not a fault.

## `map`

```mandate
let results = map x in xs [max n] [par k] [with caps K] [budget b] [supervise fail_fast] {
  body
}
```

In IR: `{ "op": "map", "bind": "x", "over": <expr>, "max": n, "par": k,
"caps": [ … ], "budget": { … }, "supervise": { … }, "body": [ … ] }`.

- **Result.** A `List<Outcome<T>>` in the order of `xs`, never in the order
  items finish (R11). `Outcome<T>` is `Ok(T) | Failed(fault)`, where `T` is
  the body's type and taint (an item whose body returns `Inferred<U>` gives
  `Ok(Inferred<U>)`). A `switch` on an outcome handles both (E0230).
  `Outcome` is a built-in type name from 0.4; an older program that names
  it gets E0120, as before.
- **Elements.** `x` is known as the list is: an element of a model's list
  is model output.
- **Faults.** By default a fault in one item is that item's outcome, and the
  other items go on (R12). With `supervise fail_fast` the first fault stops
  items not yet dispatched, waits for those in flight, and fails the map
  with that fault. `restart_all` is not allowed on a map (E0714).
- **Bound.** `max n` is the most elements the map accepts. A list longer
  than `n` is `Rejected(over_limit)` before any item is dispatched. Outside
  an envelope, `max` is required (E1702). Inside one it may be left out
  when the body starts at least one delegation; the bound is then the
  envelope's `agents` (E1702 otherwise).
- **Concurrency.** At most `k` items run at once; `par` absent means one at
  a time. Inside an envelope, `k ≤ max_concurrent` (E1703).
- **Authority.** `with caps K` applies to each item's body: inside it, K
  replaces the capability kinds it names in what delegations can be
  granted. A delegation in the body is granted K as if it had written
  `with caps K` itself, for each kind its agent holds at least as widely
  and for which it names no capability of its own; what it names itself
  lies inside K. Each capability in K lies inside the context (E0701), and
  its scope may depend on `x`. A value that chooses a scope is never
  `Inferred` or `Untrusted` (E0215, R5).
- **Disjoint writes (C5).** When `k > 1` and the body writes:
  - if the write scopes do not depend on `x`, every item writes the same
    scope, which is E0320;
  - if they do, the runtime evaluates every item's write scopes before it
    dispatches any item and refuses the map with
    `Rejected(overlapping_scopes)` when two items' scopes overlap (N03).
- **People.** No `human.*` step and no `escalate` inside a map body (E1708).
  A batch asks a person once, after the map, about the list (0.6 adds
  `human.review` for that).
- **No critical effect inside a map body.** Each item's critical effect
  would be its own action, authorized one by one. 0.4 refuses it (E1708);
  a change set or a later version handles a batch of effects.
- **Budget.** If `budget b` is given, the body's static cost fits in `b`
  (E0501, at the map) and the map counts `n × b`; otherwise it counts
  `n × body`. Money, tokens, steps and agents add up over items; time is
  `⌈n / k⌉ ×` the body's time. Without `max`, `n` is the envelope's
  `agents`.
- **Commands.** Item `i` runs under `<map>[i]`: its commands are
  `<map>[i]/body/…`. The list itself is a value of the workflow, so a
  replay sees the same items in the same order.
- **Nodes.** The body counts once toward the 1000-node limit (E0105); the
  map is not unrolled.

## `plan`

```mandate
plan Lead.finish(repos, done) [budget b] within envelope
```

In IR: `{ "op": "plan", "agent": "Lead", "skill": "finish", "args": [ … ],
"budget": { … } }`.

`plan` runs a bodiless skill of a local agent as an agent loop, like a
delegation, with two more tools. It is allowed only in the body of a
workflow that has an envelope (E1707), and the skill's own effects are
checked as for any delegation (C1, C2).

| Tool | Does |
|---|---|
| `check_program(base, ops)` | Applies an IR patch to the sub-program skeleton and returns the diagnostics, as `mandate.apply_patch` does, with the envelope's remainder as facts. Admits nothing |
| `submit_program(base, ops)` | The same check. If the sub-program fits, it is admitted, run to its end, and its result returned to the lead. If not, the diagnostics are returned and nothing runs |

Each tool call is a step of the lead's loop, charged to its budget. The
lead submits one sub-program at a time; parallel work goes inside a
sub-program, in `par` and `map`.

### The sub-program

A sub-program is a module the runtime starts for the lead:

```json
{ "language": "mandate/0.4", "module": "<parent module>.plan.<n>", "version": "0.1",
  "uses": [ { "module": "<parent module>" } ], "defs": {} }
```

Its hash is the `base` of the lead's patch. The lead adds definitions with
`add` operations. The sub-program may use every definition of its parent:
agents, capabilities, contracts, types, functions, effects.

- **What it may define.** `type`, `const`, `capability`, `fn`, local `agent`s,
  and exactly one `workflow`, whose name is free. It may not define a
  `contract`, `effect`, `extern`, `role`, `component`, `interface`,
  `environment`, remote agent, envelope or `plan` (E1705). Acceptance
  criteria, external effects, host code, people and the system model
  belong to the program a person approved; a network binding is a
  governance change (G11).
- **The checks.** All of `mandate check` runs on the sub-program, with its
  parent linked as a module. Its workflow's `caps` and `budget` are its
  claim on the envelope.
- **Containment (N01).** The sub-program is admitted only when:
  - every capability of its workflow lies inside a capability of the
    envelope (the C2 test), and does not overlap a write scope that a
    sub-program or map item still in flight holds (C5 across the run);
  - its workflow's budget fits in what the envelope has left, per
    dimension: `limit − settled − active reservations`, `agents`
    included; its `time` fits before the run's deadline;
  - every model of its agents may receive the class of what the lead
    received, and that class is at most the envelope's `max_class`. A
    sub-program is the lead's output, so it has the lead's class (§2.2);
  - every effect under the envelope's `approve` keeps its role.
  A sub-program that does not fit gets `MDT-E1706` with the dimension and
  the numbers as facts, and the lead may change it or stop.
- **Admission.** Admitting reserves the sub-program's whole budget at once,
  in the same transaction that records it, like a delegation's
  reservation; its own commands draw from it. Its IR goes to the artifact
  store, and the event `program_admitted` records its number, its hash and
  its base.
- **Running.** Its workflow runs inside the run, under `<plan>/program/<n>`.
  Every command, sandbox, reservation and effect works as in the parent.
  A critical effect still goes through prepare → authorize → commit (N05);
  admission authorizes nothing.
- **Business keys.** A sub-program's effect keeps one action per business
  key across the whole `plan`: the operation key of an effect in a
  sub-program is derived from the run, the `plan` node, the effect and its
  `idempotent_by` key, not from the sub-program. A second sub-program that
  opens the same pull request finds the first one's action (INV-06, N07).
- **Its result** is returned to the lead as a tool result. A value it
  returns keeps its type: what an agent made is `Inferred`, and only a
  `verify` in the sub-program makes it `Verified`.
- **Its text.** A sub-program's literals (agent roles, prompts, messages)
  are the lead's output. They may instruct its agents, since that is what
  a plan is. They cannot widen authority, which containment bounds. Views
  show them as model output (G09).

### Limits

A sub-program has the 0.1 limits (1 MiB, nesting 64, 64 definitions, 1000
expanded nodes). The checker runs on it with a time limit (2 s by default,
`plan.checkMs` in `mandate.runtime.json`) in a worker of its own. A check
that takes longer is a diagnostic to the lead (`check_limit`), and the
runtime goes on. Input over a limit is refused before it is parsed.

### Amendments (N04)

When a sub-program needs more than the envelope allows, the lead may ask
for an amendment with a third tool, `request_amendment(envelope, reason)`:
a new envelope, nothing else.

- The runtime builds the program with that envelope, which is a new
  program and so a new package hash, and the semantic diff between the two
  (`mandate view --against`). Raising a budget or widening authority shows
  as a governance change, as always.
- The run waits for a member of the envelope's `owner` role: a signed
  decision of kind `amend` whose subject is the new package hash. The lead's
  tool call waits with it.
- On approval the run goes on under the new package. The event
  `package_amended` records both hashes, the diff and the decision. An
  authorization given before carries over to nothing new: action digests
  name the package, so a new action needs a new authorization. Evidence
  already recorded keeps the package it was recorded under.
- On a decline, or past the wait's deadline, the tool returns the decline
  and the envelope stays as it was.

This refines INV-02: a running run's package changes only by an amendment
of its envelope that the envelope's owner signed, recorded with both
hashes.

### Replay (N06)

Replay reads each admitted sub-program from the artifact store by the hash
its `program_admitted` event names, and runs it against the journal. It
calls no model, no adapter and no checker that could answer differently: a
recorded admission is not checked again. A refused submission is a
recorded tool result.

## Static checks

`mandate check` adds these for 0.4 programs. The family E17xx is assigned
here (Appendix B has none for envelopes), E15xx for roles and people.

| Code | Title | Rule |
|---|---|---|
| MDT-E1501 | Role not declared | A role named in a 0.4 module is a `role` definition, local or imported |
| MDT-E1502 | Role not bound | With a lock: every role the package names has a member (`unbound_role` at load) |
| MDT-E1503 | `distinct_from` without an earlier approval | It names a role approved earlier in the same criterion |
| MDT-E1701 | Malformed envelope | `owner`, `caps` and `budget` with `agents` are given; the workflow has no `caps` or `budget` of its own |
| MDT-E1702 | Unbounded map | `max` is given, or the map is inside an envelope and its body starts a delegation |
| MDT-E1703 | Map concurrency above the envelope | `par k` is at most `spawn.max_concurrent` |
| MDT-E1704 | Envelope approval names a non-critical or uncovered effect | Every effect under `approve` is critical and covered by the envelope's `caps` |
| MDT-E1705 | Not allowed in a sub-program | A sub-program defines only types, constants, capabilities, functions, local agents and one workflow |
| MDT-E1706 | Sub-program does not fit the envelope | Capabilities inside the envelope and clear of writes in flight; budget within what is left; data class; approvals kept. Facts name the dimension |
| MDT-E1707 | `plan` outside an envelope | `plan` is only in the body of a workflow with an envelope |
| MDT-E1708 | Person or critical effect in a map body | A map body has no `human.*`, `escalate` or critical effect |

Existing checks extend to the new forms:

- **E0501** counts `agents` with the other dimensions. A static delegation
  counts its attempts (`restart(max: n)` is `n + 1`, `degrade` one more), a
  map `n ×` its body, and a `plan` its lead's own delegation. What
  sub-programs use is bounded at run time by reservation, not statically.
  So for an envelope, the check proves that the static part fits; the
  runtime proves that each sub-program fits what is left.
- **E0220** applies `spawn.max_class` to every delegation and `infer` in
  the run.
- **E0320** applies to map items as above.
- **E0711** stays: there is no `spawn`. Its message names `plan … within
  envelope` as the dynamic form (V05).

## Runtime

### Events

| Event | Data |
|---|---|
| `envelope_approved` | package, member, role, decision digest (recorded on the package, listed in each run's manifest) |
| `map_started` | map node, number of items, `par` |
| `program_submitted` | plan node, number, base, patch digest |
| `program_refused` | plan node, number, diagnostics digest |
| `program_admitted` | plan node, number, hash, base, reservation |
| `amendment_requested` | plan node, new package hash, diff digest |
| `package_amended` | old and new package hashes, diff digest, decision digest |
| `decision_refused` | command, reason (`invalid_signature`, `unknown_key`, `not_in_role`, `same_member`, `stale_revision`, `subject_mismatch`) |

`decision_refused` is the one event a refused decision records: who tried,
with which key, and why. It changes nothing else and raises no revision.

### Executors

A lead may be bound to Claude Managed Agents like any agent
([`executors.md`](executors.md)). `check_program`, `submit_program` and
`request_amendment` are then custom tools that run in the runtime, like the
others, and sub-programs run here. The service's own dynamic workflows
(`multiagent`) stay unsupported (K47): their threads share one sandbox and
one set of credentials, so `parallel.isolation` and delegation narrowing
would be None, and a program with an envelope needs both (INV-11).

## Views

- **The card.** `mandate view <program> --card` answers five questions from
  the IR and the lock, for a workflow with an envelope:
  - what it does: its static steps, its maps with their bounds, and each
    `plan` with its lead;
  - what it can touch: the envelope's capabilities, opened into paths,
    commands, hosts, repositories and model tiers, and `max_class`;
  - the most it spends: the envelope's budget, with the static part's
    upper bound beside it;
  - when it asks whom: every wait by role, and each effect under `approve`
    with its role;
  - who approves it, and who may amend it: the `owner` role and its
    members.
  It names the package hash a signature would bind to.
- **Authority and cost views** show the envelope instead of the workflow's
  caps and budget, and `agents` as a dimension.
- **Changes.** Any change to an envelope is a governance change: it is what
  a person approved for the run. `mandate patch` reports it as
  `envelope_changed` and `mandate view --against` lists it under
  governance.
- **Run views** add, per `plan`: each submission with its number, whether it
  was admitted, its hash, its reservation against the envelope, and for a
  refused one the codes; and the envelope's remainder per dimension. A
  `map` shows its items by index with their outcome. Every decision shows
  its member, role and whether its signature holds, or `unsigned`.

## Invariants

| Id | Invariant | Where 0.4 keeps it |
|---|---|---|
| INV-02 (refined) | A running run's package does not change, except by an amendment of its envelope signed by the envelope's owner and recorded with both hashes | `package_amended`; action digests name the package |
| INV-15 | A sub-program does not run until it is shown to fit what is left of the envelope: authority, budget, agents and data class | Containment at admission; one reservation per sub-program |
| INV-16 | A decision whose signature does not verify against a key the lock binds to its role is not a decision | Decision records; `invalid_decision` |

## Conformance cases

| Case | Rule | Code or event |
|---|---|---|
| N01 | A sub-program whose capabilities or budget exceed what is left of the envelope is not admitted, and nothing of it runs | E1706 |
| N02 | A delegation or a sub-program that does not fit the remaining budget is refused at reservation; two siblings cannot both reserve what only one fits | `BudgetExceeded`, E1706 (R07 generalized) |
| N03 | Map items with `par > 1` cannot write overlapping scopes: statically when the scopes do not depend on the item, before any dispatch when they do | E0320, `Rejected(overlapping_scopes)` |
| N04 | An amendment is a new package hash; an envelope approval or an authorization given for the old hash does not authorize the new scope | `unapproved_envelope`, E0406 |
| N05 | A critical effect in a sub-program needs its own authorization, and one under `approve` needs that role's signed decision | E0406, `invalid_decision` |
| N06 | Replay reads admitted sub-programs from the journal and calls no adapter and no checker | — (INV-09) |
| N07 | Two sub-programs of one plan with the same effect and business key are one action | INV-06 |
| N08 | A list longer than a map's `max` is refused before any item is dispatched | `Rejected(over_limit)` |
| N09 | A sub-program that defines a contract, an effect, an extern, a role, a remote agent or a system model definition is refused | E1705 |
| N10 | A lead's checks that run over the limits are refused without stopping the run | `check_limit` |
| R11 | A map's results are in input order, whatever order items finish in | — |
| R12 | A failed item is that item's outcome; the others go on | — |
| H01 | A decision with no valid signature, an unknown key, or a member outside the role is refused and recorded as `decision_refused` | `invalid_decision` |
| H02 | `distinct_from` refuses a second approval by the same member, whichever key signs it | `same_member` |
| H03 | A run of an envelope workflow does not start without an envelope approval for its package hash | `unapproved_envelope` |
| H04 | Evidence for `human.approve` whose decision record was changed after signing shows as invalid, and a `Verified` value resting on it is refused | `forged_evidence` (G03) |
| H05 | A changed role binding in the lock is a new package and shows as a governance change | — |

## Not in 0.4

- `shapes` (the patterns a lead may apply), `human.review`, `waive by`,
  libraries, patterns and connectors: 0.6.
- `stage`, `report`, the attention view and `asks`: 0.7.
- An egress proxy for sub-programs that need the network: 0.5. Until then a
  sub-program with `net.https` is refused like any sandbox that needs it.
- A critical effect inside a `map` body.
- `await` and a lead that runs several sub-programs at once.
