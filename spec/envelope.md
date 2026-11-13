# Envelopes and signed decisions (0.4)

**Status: implemented in the TypeScript implementation.** The page
specifies language version 0.4 so that this implementation and, later, the
Rust one are held to the same cases.

| Part | State |
|---|---|
| The language surface: `role`, `envelope`, `map`, `plan`, `agents`, `Outcome` in the IR, the schema, the text form and the views | implemented |
| Roles: E1501, E1502, E1503; lock format 0.4 with `members` and `roles` | implemented |
| Signed decisions: the record, the members' keys, acceptance and `decision_refused`, the evidence of `human.approve`, unsigned mode, the CLI, lock changes in `view --against` (H01, H02, H04, H05) | implemented |
| The envelope's own rules: E1701, E1704 and E1707; E0501 with `steps` and `agents`; E0220 with `spawn.max_class` | implemented |
| The envelope at run time: its approval (H03), the `agents` ledger for delegations (N02), `spawn.max_concurrent`, `approve E by r`; the card | implemented |
| `map`: its rules (E1702, E1703, E1708, E0320 and E0501 at the map) and its run (R11, R12, N03, N08) | implemented |
| `plan` and sub-programs: their rules (E1705, E1706) and their run, with the ledger under a sub-program, the bounded check and replay (N01, N02, N05, N06, N07, N09, N10) | implemented |
| Amendments: `request_amendment`, E1709, the owner's signed decision, `mandate amend`, and what ran before the amendment (N04) | implemented |
| Run views of 0.4: the envelope's remainder and amendments, submissions with each admitted sub-program's text, map items and their outcomes, each decision's member, role and signature | implemented |

The runtime runs a 0.4 package that uses roles, signed decisions,
envelopes, `map`, `plan` and amendments. It refuses one that has `agents`
in a budget that is not an envelope's, when it loads it
(`unsupported_language`, naming what it found). That is not run yet, and a
version is never run on a best-effort basis. Such a program can be read,
checked, hashed, printed and viewed today, and not run.

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
  Its decision record names no role.
- **A question's role.** From 0.4, a question that names a role
  (`human.ask`, `escalate human(…)`, `supervise escalate(human, …)`) is
  answered only by a member who holds it. An earlier program's question
  records no role, as before, and takes any member.
- **`owner`.** An irreversible effect that no policy assigns asks the role
  `owner`, as before. The lock binds it like any other role.
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
  public keys themselves are files `<key id>.pem` (the id without
  `sha256:`) in the directory that `decisions.keys` names in
  `mandate.runtime.json`, by default `.mandate/decision-keys` next to it.
  A file whose public key does not hash to its name is refused, and every
  command with it (`bad_decision_key`): under another key's name it would
  stand for that key.
- A lock that lists members or roles is well formed when a package is
  loaded (`malformed_lock`): a key is under one member, and a role lists
  only members.
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
bytes, and is written `ed25519:<base64>`. The record's digest is the
SHA-256 of the same bytes. `kind` is one of `approve`, `decline`, `answer`,
`raise_limits`, `reconcile`, `envelope`, `amend` and `cancel`. `subject`
is the digest the wait shows: a contract's `subject_digest`, an action
digest, a change set's digest S, or a package hash. `payload` is the digest
of the answer, the new limits or the reconciliation; it is absent for an
approval or a decline. A record has these fields and no others.

What a record names, by kind:

| Decision | `command` | `subject` | `payload` |
|---|---|---|---|
| `approve`, `decline` of a criterion | the approval's wait | its `subject_digest` | none |
| `approve`, `decline` of an action or a change set | the authorization's wait | the action digest, or the set's digest S | none |
| `answer` | the question's wait | the digest of the question as it was recorded | the answer |
| `raise_limits` | none | the run's package hash | the new limits by dimension, as `limits_raised` records them |
| `reconcile` | the action's command | the action digest | `{ "reconcile": "<operation key>" }` |
| `cancel` | none | the run's package hash | none |
| `envelope` | none, and no run or revision | the package hash | none |
| `amend`, `decline` of an amendment | the amendment's wait | the hash of the package with the new envelope | none |

A payload is the request digest of its value: the SHA-256 of
`mandate/request/0.1\n` and the value's JCS bytes. `role` is the role the
wait asks; a raise, a reconciliation and a cancel ask none, so any member
may make them. An envelope approval names the envelope's `owner`.

The runtime accepts a decision only when all of these hold. Otherwise it is
refused with `invalid_decision` and a reason, nothing is recorded, and the
wait stays open:

1. The signature verifies under the named key.
2. The key belongs to the named member, and the member holds the wait's
   role, in the lock of the run's package.
3. The package, run, revision, command and subject are the ones the wait
   shows now, the kind is one that answers it, and the payload is the
   digest of what came with it. A decision on another revision is
   `stale_revision`, as before (G10); on another subject it is refused
   (G02).
4. For `human.approve(role: r, distinct_from: q)`, the member is not the one
   who decided `q` in the same criterion.

They are checked in the order: who signed (1, and that the lock lists the
key under the member), what the record is for (3), the role (2), then
`distinct_from` (4). So a refusal names the person whenever the signature
holds.

A refused decision leaves one trace, a `decision_refused` event with the
reason, the member, the key and the role the record names. Everything
else is as it was: the revision, the wait, and the inbox, so the same
message id can carry the corrected decision. `invalid_decision` carries the
reason first in its message; a decision on another revision keeps the code
it had before 0.4, `stale_revision`.

**A cancel** is taken whether or not it is signed, and on any revision:
stopping needs nobody's authority. A signature that holds is stored and
`cancel_requested` names the member. One that does not is recorded as
`decision_refused`, and the run is cancelled all the same.

An accepted record is stored with its signature, under its digest. The
events it causes name the member, the role, the key and that digest. The
evidence record of a `human.approve` criterion names them too (in
`producer` and `detail`), and `verifyEvidence` checks the decision as well
as the evidence: the record it names is stored, still hashes to its digest,
carries a signature by a key the lock binds to its member and role, and is
the decision of that criterion with that result. A record changed after
signing shows as invalid, as evidence does, and a `Verified` value that
rests on it is refused (`forged_evidence`, H04). Where decisions are
signed, an approval that names no decision record is not evidence.

The first signer is a key per operator, created with `mandate key new`.
OIDC and passkeys are later signers of the same record; they need no change
to the format. Mandate does not run an identity provider.

**Signed is the default**, for every package. A program of 0.1 to 0.3 names
its roles with text, and its lock binds those names like any others.

**Unsigned mode.** A package of 0.1 to 0.3 may run with
`decisions: { "mode": "unsigned" }` in `mandate.runtime.json`, and then
`--by NAME` works as before. Its views mark each decision `unsigned`. A
signed record sent in this mode is still held to the rules above, and
stored when it passes. A 0.4 package never runs in unsigned mode: a
runtime in that mode does not start it (`signed_decisions_required`), and
its decisions are signed whatever the mode says. A 0.4 package is one whose
program, or a module packaged with it, is written in 0.4.

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
mandate reconcile    <run> <operation> --key FILE [--member NAME]
mandate cancel       <run> [--key FILE]
mandate decision     <run> <digest>                            # a decision the run took, as its signed record
mandate verify-decision <record.json> --key <public key.pem> [--lock FILE]
mandate approve-envelope <program> --key FILE [--member NAME] [--workflow W]
mandate amend        <run> --revision N --key FILE [--member NAME] (approve | decline)
```

`amend` decides an amendment a lead asked for
([below](#amendments-n04)). `approve` signs a decision of kind `amend`
and `decline` one of kind `decline`, for the package hash `mandate status`
shows. It is always signed: only a 0.4 run has an amendment.

`--member` is needed only when a key id is listed under more than one
member, which the lock forbids, so in practice never. The CLI finds the
member from the lock of the run's package, by the key's id; a key the lock
lists under nobody is refused there (`unknown_key`).

- **`key new`** writes the private key to `--out` (default `mandate.key`),
  never over an existing file, and its public half next to it as
  `<key id>.pem`, the name the runtime's `decisions.keys` directory
  expects.
- **A private key file** must be readable by its owner only; the CLI
  refuses one that is not (`key_not_private`). This is checked by POSIX
  mode. Windows has no such modes and the CLI does not read ACLs, so there
  the file is as private as the directory it is in.
- **`approve-envelope`** signs for the package hash the card shows, in the
  `owner` role of the program's envelope, and hands the approval to the
  runtime ([below](#approving-an-envelope)). It reads the program, its
  lock and its modules as `mandate run` does. `--workflow` names the
  workflow whose envelope is meant; it is needed only when the program's
  envelopes have different owners. `--json` prints the package hash and
  the decision's digest with the record and its signature.
- **`status`** lists each decision the run took with its member, role and
  digest, and whether its signature still holds. For a run under an
  envelope, the approval it started under comes first.
- **`verify-decision`** checks a record without the runtime: it reads the
  record file (`{ "record": …, "signature": … }`, as `mandate decision`
  prints it) and a public key, and no configuration or database. It exits
  0 when the record names that key and the signature verifies, and 1
  otherwise. With `--lock` it also requires that lock to list the key
  under the record's member, and the member under the record's role.

An auditor needs nothing of Mandate's for the same check: the bytes are
`mandate/decision/0.1\n` and the record's JCS (RFC 8785) form, the
signature is ed25519 over them, the key id is the SHA-256 of the public
key's SPKI DER encoding, and the record's digest is the SHA-256 of the
bytes.

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

contract Moved(repo: Repo, s: Summary) {
  accept moved "The migrator reports what it moved"
    by static len(s.migrated) >= 1
  accept nothing_left "Nothing of the repository is left to move"
    by static len(s.left) == 0
  accept release_approved "The release manager accepts the change"
    by human.approve(role: release_manager)
}

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

`Moved` is there for the sub-programs. `git.merge` takes a verified value
and, being irreversible, one a person approved (E0405), and a sub-program
may use its parent's contracts but define none (E1705): without a contract in
the parent, nothing a lead plans could ever merge. Its two `static` criteria
read the summary, which exists only in a run, so they are run-time checks
and `mandate check` says so of each with a warning (W0601); the example has
no other diagnostic.

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

`approve E by r` says who authorizes `E`, and it holds against what is
configured outside the program: the runtime's policy for the effect can
neither hand it to policy nor name another role. A deadline the runtime
sets for that approval still applies, since a deadline only takes
authority away. Where the program itself names another role for the same
action, two rules contradict each other and neither gives way. That is an
environment whose tier asks a person of another role, or a change set
member whose approver (its `approved_by`, or else its component's owner)
is another role. The run then stops as `attention_required` with
`approval_conflict`, before anyone is asked and before anything is sent.
Name the same role in both. A governance-class file still asks its owner
first, as before (K70).

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

- **The record.** Its `kind` is `envelope`, its `package` and its
  `subject` are the package hash, and its `role` is the envelope's
  `owner`. It is about the package and no run, so it names no run,
  revision, command or payload. It names no workflow either: it approves
  every envelope in the package that the role owns. A package whose
  envelopes have two owners needs an approval in each role before the
  workflows of both start.
- **Acceptance.** The approval is held to the rules of every decision, in
  their order: who signed, what the record is for, then the role. The role
  must own an envelope in the package, and the member must hold it in the
  package's lock. A refused approval is `invalid_decision` with its
  reason. Nothing is stored and no event is written, since there is no run
  whose log could record it. A package without an envelope has nothing to
  approve (`no_envelope`).
- **At the start of a run.** The approval is stored with the package.
  `StartRun` takes the oldest stored one in the envelope's owner role that
  still holds, and checks it again as when it arrived: the record is
  unchanged, names this package, and is signed by a key the lock lists
  under a member of the role. The run's manifest lists it as
  `envelope_approval` (`decision`, `member`, `role`, `key`), and the run's
  log records `envelope_approved`. `mandate status` and `verifyDecisions`
  show it first among the run's decisions.
- **Tests.** `mandate test` makes up the people of a 0.4 program
  ([`runtime.md`](runtime.md#tests-64)), and its member of the owner role
  approves the test's package before the run starts.

### The ledger

`agents` is a ledger dimension like `steps`. Every delegation attempt
reserves one when it is dispatched: a first attempt, each restart, and a
degrade fallback. A delegation that does not fit is `BudgetExceeded` and
goes to the run's budget handler, as today. Two siblings cannot both
reserve the last one (R07, N02).

- **Spent when sent.** An attempt's agent is settled when the attempt
  ends, whatever came of it: a result, a failure or a timeout. No adapter
  reports it as a cost.
- **Only under an envelope.** A run of a workflow without an envelope
  reserves no agents, and its events and budget table are as they were.
- **The run's limit** is the envelope's `agents`, or less when the caller
  gives the run less (`mandate run --limit agents=N`), as in every
  dimension.
- **A raise** (`raise-limits`) may bring a run's limit up to the
  envelope's budget and no further, in any dimension
  (`above_program_budget`). More than the envelope gives needs an
  amendment. A raise asks no role, as before.
- **`time`** is a deadline, not a ledger dimension, so nothing reserves
  it. E0501 holds the static part to the envelope's `time`. The runtime
  does not stop a run at it today. With `plan`, a sub-program's `time` is
  held to what is left of it, counted from the run's start.

`max_concurrent` is not a ledger. A delegation that would exceed it waits
until another one in the run settles. The wait is not an attempt, holds no
reservation and is not a fault, and nothing of it is journaled. Delegations
that wait go on in the order they came. A place is held for one attempt and
given back when the attempt ends, however it ends. Replay sends nothing, so
it never waits.

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
  other items go on (R12). With `supervise fail_fast` a fault stops the
  items not yet started, the map waits for those in flight, and it fails
  with the fault of the first failed item in the order of `xs`.
  `restart_all` is not allowed on a map (E0714).
- **What is not an item's outcome.** A `BudgetExceeded` goes to the run's
  budget handler, as it does outside a map: the run waits for a raise, and
  after one the map goes on with the items that have no result yet. A
  wait, a stop for attention and a crash of the worker are not an item's
  to keep either. No further item starts, and the map is left once the
  items in flight have settled.
- **Decided in input order.** What a map does is decided by its items in
  the order of `xs`, never by which one ended first: the first item that
  did not end with a value decides. So a resumed run and a replay decide
  as the first run did.
- **Bound.** `max n` is the most elements the map accepts. A list longer
  than `n` is `Rejected(over_limit)` before any item is dispatched (N08).
  Outside an envelope, `max` is required (E1702). Inside one it may be left
  out when the body starts at least one delegation, itself or in a function
  it calls; the bound is then the envelope's `agents` (E1702 otherwise).
- **Concurrency.** At most `k` items run at once; `par` absent means one at
  a time. Inside an envelope, `k ≤ max_concurrent` (E1703), and each
  delegation of an item still takes one of the run's `max_concurrent`
  places.
- **Authority.** `with caps K` applies to each item's body: inside it, K
  replaces the capability kinds it names in what delegations can be
  granted. A delegation in the body is granted K as if it had written
  `with caps K` itself, for each kind its agent holds at least as widely
  and for which it names no capability of its own; what it names itself
  lies inside K. Each capability in K lies inside the context (E0701), and
  its scope may depend on `x`. A value that chooses a scope is never
  `Inferred` or `Untrusted` (E0215, R5). A map inside a map item starts
  from what that item was handed.
- **Scopes chosen at run time.** `C.narrow(v)` over a value is evaluated
  when the capability is needed: for a map's `with caps`, for every item
  before any item is dispatched; for a delegation's own, when it is
  dispatched, in a map or outside one. The value is a text or a list of
  texts. A `Path` is relative, so over an `fs.*` capability a relative
  value names that path below each path of C:
  `fs.write("/work/repos").narrow("billing")` is
  `fs.write("/work/repos/billing")`. The result lies inside C, or it is
  `PolicyDenied(outside_capability)`: an absolute path elsewhere, or a
  relative one that climbs out with `..`. A file scope with `\`, `:` or
  NUL is inside nothing, since a host may read it another way (K68). A
  capability of K outside what the map's context holds, and a
  delegation's own outside what its item was handed, are
  `PolicyDenied(outside_authority)`. Either one in a map's `with caps`
  refuses the map before any item is dispatched.
- **Disjoint writes (C5).** When `k > 1` the items run side by side, and
  what an item may write is the same for every item unless the map hands
  each one a scope its element chooses. So every write capability the
  body can use is of a kind that `with caps` hands narrowed by `x`, as in
  `with caps W.narrow(x.root)`. That holds for what a delegation is
  granted, in the body or in a function the body calls, and for what an
  effect of the body uses itself. Any other is E0320, at the map. The
  runtime then compares the write scopes the items are handed, two by
  two, before it dispatches any item, and refuses the map with
  `Rejected(overlapping_scopes)` when two overlap (N03).
- **People.** Nothing in a map body waits for a person (E1708): no
  `human.*` step, no `escalate`, no `pause` (a `pause and S` is judged by
  `S`), no `supervise escalate` on a delegation, no `verify` against a
  contract with a criterion a person approves, and no call of a function
  that holds one of these, through any number of calls. Each item would
  wait on its own. A batch asks a person once, after the map, about the
  list (0.6 adds `human.review` for that).
- **No critical effect inside a map body.** Each item's critical effect
  would be its own action, authorized one by one. 0.4 refuses it, and a
  change set in a map body with it (E1708); a change set after the map or
  a later version handles a batch of effects.
- **Budget.** With `budget b`, the body's static cost fits in `b` in every
  dimension `b` names, steps and agents among them, in an envelope and
  outside one (E0501 at the map's budget, E0504 for a spend in another
  currency). One item then counts `b` in the dimensions it names and the
  body in the others; without `budget` one item counts the body. The map
  counts `n ×` one item in money, tokens, steps and agents, and
  `⌈n / k⌉ ×` one item's time. Without `max`, `n` is the envelope's
  `agents`. The runtime reserves nothing for an item: each delegation of
  the body reserves its own budget, which the check has added up.
- **Commands.** Item `i` runs under `<map>[i]`: its commands are
  `<map>[i]/body/…`. The list itself is a value of the workflow, so a
  replay sees the same items in the same order. `map_started` is written
  once for a map, after the checks above and before its first item, and
  not again when the run is resumed. `map_ended` is written once when the
  map has ended, with each item's outcome by input index. A map that
  something stopped has no end to record: a run-level `BudgetExceeded`, a
  cancel, a failed sibling branch. A replay writes neither.
- **A failed sibling.** A failed branch of a `par` around the map stops an
  item at its next command, like any other command of that branch, and
  the map starts no further item.
- **Nodes.** The body counts once toward the 1000-node limit (E0105); the
  map is not unrolled.

## `plan`

```mandate
plan Lead.finish(repos, done) [budget b] within envelope
```

In IR: `{ "op": "plan", "agent": "Lead", "skill": "finish", "args": [ … ],
"budget": { … } }`.

`plan` runs a bodiless skill of a local agent as an agent loop, like a
delegation, with three more tools. It is allowed only in the body of a
workflow that has an envelope (E1707), and the skill's own effects are
checked as for any delegation (C1, C2). The lead's delegation runs under
the `plan` node's path. A runtime without an agent loop does not run a
`plan` (`no_agent_loop`).

| Tool | Does |
|---|---|
| `check_program(base, ops)` | Applies an IR patch to the sub-program skeleton and returns the diagnostics, as `mandate.apply_patch` does, with the envelope's remainder as facts. Admits nothing |
| `submit_program(base, ops)` | The same check. If the sub-program fits, it is admitted, run to its end, and its result returned to the lead. If not, the diagnostics are returned and nothing runs |
| `request_amendment(envelope, reason)` | Asks the envelope's owner for a wider envelope, and waits for the decision ([Amendments](#amendments-n04)) |

Each tool call is a step of the lead's loop, charged to its budget and
journaled like any tool call. The lead submits one sub-program at a time;
parallel work goes inside a sub-program, in `par` and `map`.

- **What the lead sends.** `ops` is the whole patch each time: `add`,
  `remove` and `replace` operations against the skeleton whose hash is
  `base`. A patch against another base is stale (E0130).
- **What the lead is told.** Every answer names the sub-program the next
  patch is for (`number`, `base`) and what is left for it (`room`): the
  envelope's remainder per dimension, the time left before the run's
  deadline, and the write capabilities in flight. `check_program` adds
  `ok` and `diagnostics`. `submit_program` answers `admitted: false` with
  the diagnostics, as an error to the model, or `admitted: true` with the
  sub-program's `hash`, its `result` or its `error`, and `next`: the
  number and base of the sub-program after it. Errors come first, and at
  most 40 diagnostics are shown.
- **Numbers.** `n` counts the sub-programs this `plan` node has admitted,
  from 1. A refused submission does not advance it. Two `plan` nodes
  number their sub-programs separately.

### The sub-program

A sub-program is a module the runtime starts for the lead:

```json
{ "language": "mandate/0.4", "module": "<parent module>.plan_<n>", "version": "0.1",
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
  governance change (G11). So an effect that takes a verified value, as
  `git.merge` does, is verified against a contract of the parent. The
  workflow takes no parameters. A capability of the sub-program may narrow
  one of its parent's, under any name.
- **The checks.** All of `mandate check` runs on the sub-program, with its
  parent linked as a module. Its workflow's `caps` and `budget` are its
  claim on the envelope.
- **Containment (N01).** The sub-program is admitted only when:
  - every capability of its workflow lies inside a capability of the
    envelope (the C2 test), and does not overlap a write scope that a
    sub-program or map item still in flight holds (C5 across the run). A
    sub-program is in flight from its admission until it has ended, also
    while it waits for a person or for the run to be resumed. A map holds
    the scope of every item from before its first item is dispatched; an
    item's scope is free when the item has ended, and all of them when
    the map has failed. The test is made at admission: a map that starts
    while a sub-program in flight holds an overlapping scope is not
    refused in 0.4;
  - its workflow's budget names every dimension the run is limited in and
    fits in what the envelope has left, per dimension: `limit − settled −
    active reservations`, `agents` included. When the envelope names a
    `time`, the sub-program names one that fits before the run's deadline,
    which is the run's start plus the envelope's `time`;
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
  its base. A check and the admission it leads to are one step among the
  leads of a run, so two leads are never given the same remainder or the
  same place to write. If a delegation outside any sub-program reserved
  what the check saw as left, the admission is refused as E1706 with the
  ledger's numbers. `program_submitted` is written for every submission
  once it was checked, and `program_refused` for one that is not admitted.
- **The ledger (N02).** A command inside a sub-program takes its
  reservation out of the sub-program's, in every dimension the run is
  limited in, and gives back what it did not spend when it settles. A
  sub-program that asked for nothing of a dimension has nothing of it to
  give: nothing inside a sub-program is taken from the run. What it
  spent beyond its share comes out of the sub-program's reservation too.
  So the sub-program and its commands never hold more of the run than it
  was admitted with. A command that does not fit what the sub-program has
  left is `BudgetExceeded` naming the program. That is the sub-program's
  fault and goes to the lead, not to the run's budget handler. When the
  sub-program ends, what is left of its reservation is released.
- **Running.** Its workflow runs inside the run, under `<plan>/program/<n>`.
  Every command, sandbox, reservation and effect works as in the parent.
  A critical effect still goes through prepare → authorize → commit (N05);
  admission authorizes nothing. The envelope's `approve` and
  `spawn.max_concurrent` hold inside it. The lead gives up its place among
  the run's delegations while its sub-program runs and takes one again
  after, so a sub-program runs even where only one delegation may be in
  flight. A map without `max` is bounded by the sub-program's own
  `agents`. Neither the envelope's `time` nor a sub-program's is a timer
  in 0.4: they bound what is admitted.
- **Business keys.** A sub-program's effect keeps one action per business
  key across the whole `plan`: the operation key of an effect in a
  sub-program is derived from the run, the `plan` node, the effect and its
  `idempotent_by` key, not from the sub-program. A second sub-program that
  opens the same pull request finds the first one's action (INV-06, N07).
  The same key over other parameters is neither that action nor a new
  one: the effect fails with `Rejected(idempotency_conflict)`. A member of
  a change set in a sub-program keeps the key of its place in the set.
- **Its result** is returned to the lead as a tool result. A value it
  returns keeps its type: what an agent made is `Inferred`, and only a
  `verify` in the sub-program makes it `Verified`. A fault of the
  sub-program is returned too, as `error`, and the lead may plan again.
- **Its text.** A sub-program's literals (agent roles, prompts, messages)
  are the lead's output. They may instruct its agents, since that is what
  a plan is. They cannot widen authority, which containment bounds. Views
  show them as model output (G09).

### Limits

A sub-program has the 0.1 limits (1 MiB, nesting 64, 64 definitions, 1000
expanded nodes), and a patch has at most 256 operations. A patch over a
limit in size, nesting or operations is refused before anything is built
from it. The checker then runs in a worker of its own, with a time limit
(2 s by default, `plan.checkMs` in `mandate.runtime.json`) and a heap of
its own (256 MB). A check that runs over a limit is a diagnostic to the
lead, `check_limit`, whose facts name the limit (`time`, `memory`, `size`,
`depth` or `operations`) and its value, and the runtime goes on.

A checker that fails on what it was given is a diagnostic to the lead as
well, `check_failed`. A sub-program is a model's writing, and nothing in
it stops the run. Neither diagnostic admits anything, and neither is an
`MDT-` code: they say that no check was made. Only a checker that is not
installed is the runtime's own failure (`no_checker`).

An amendment's envelope is checked in the same worker, under the same
limits of size, nesting, time and heap.

### Amendments (N04)

When a sub-program needs more than the envelope allows, the lead may ask
for an amendment with a third tool, `request_amendment(envelope, reason)`:
a new envelope for the run's workflow, as JSON IR, and nothing else. The
lead's brief carries the envelope the lead started under, to ask from.

- **The check.** The runtime builds the program with that envelope, which
  is a new program and so a new package hash. The program is checked as
  any program is, and its package is verified as at load. So a role that
  nobody holds or a model tier the lock does not bind refuses it
  (`unbound_role`, `unlocked_model_tier`). An amendment equal to the
  envelope the run has is refused as `unchanged`.
- **Only wider (E1709).** The new envelope holds every capability the old
  one held, by the C2 test. Its budget names the dimensions the old one
  named and no other, `time` included, each with at least the old amount.
  `spawn.max_concurrent` is no lower, and is not added where there was
  none. `spawn.max_class` is no lower. `owner` and `approve` may change.
  So what ran under the old envelope lies inside the new one (INV-15),
  and a check that passed before the amendment passes after it. The facts
  name the `dimension` (`capability`, a budget dimension,
  `max_concurrent` or `max_class`), what the envelope gave (`was`) and
  what the amendment asks (`asked`); for a capability, the `capability`
  left out.
- **What refuses it** is returned to the lead as diagnostics with
  `amended: false`, as an error to the model. Nobody is asked, nothing is
  stored, and the run goes on.
- **The wait.** Otherwise the new package is stored, `amendment_requested`
  is recorded, and the run waits for a member of the `owner` role of the
  envelope it has now. The lead's tool call waits with it: the wait is a
  command of kind `amendment` at `<the tool's step>/amendment`. Its
  request names the `plan` node, the lead, both package hashes, the role,
  the lead's reason (a model's text, at most 2000 characters), the new
  envelope and what it changes, line by line. It also names the digest of
  the semantic diff between the two programs (`mandate view --against`),
  where the change is one governance change, `envelope_changed`. The
  wait's deadline is the run's own, its start plus the envelope's `time`;
  without a `time` it has none.
- **The decision** is a signed record of kind `amend`, or `decline`. Its
  `command` is the wait, its `subject` the new package hash, its `package`
  the one the run has now, and its `role` the owner's. It has no payload.
- **On approval** the run goes on under the new package, in the
  transaction that takes the decision. In each dimension the amendment
  raises, the run's limit becomes the new envelope's amount. No other
  limit changes, and none is added: a limit the caller set below the
  envelope stays, and a raise may lift it. `package_amended` records both
  hashes, the diff, the limits that rose and the decision. Every other
  amendment the run still waits for was asked of the old package, and
  ends unanswered (`superseded`); its lead may ask again. A worker that
  was driving the run under the old package loses its lease (R06).
- **Nothing carries over.** An approval of the old package's envelope and
  an authorization for an action of the old package are for the old hash.
  Action digests name the package, so a new action needs a new
  authorization (E0406), and a decision signed for the old package is
  refused once the run is under the new one (`subject_mismatch`). The
  amended package has no envelope approval of its own: it runs this run
  on its owner's decision about this run, and another run of it needs
  `approve-envelope` (`unapproved_envelope`).
- **What ran before stands.** Every command records the package the run
  had when the command was first recorded. A command the journal holds is
  read under that package, whatever the envelope is now: a delegation
  keeps the grant it was sent with, an action its digest and the role
  that authorizes it, a change set its digest. So a resumed run and a
  replay find each command as it was recorded, and an effect done before
  the amendment is not done again. Evidence already recorded keeps the
  package it was recorded under. An `infer` records its request, which
  names no tier: one that was sent and has no answer yet is sent again
  with the tier the envelope gives now.
- **What was refused stays refused.** Since an amendment only widens, one
  refusal could turn into a pass: a map without `max` that was longer
  than the envelope's `agents`. In a run whose program has a `plan`, that
  refusal is recorded as a failed command, `<map>/refused`, and a resumed
  run and a replay read it there.
- **On a decline, or past the deadline,** the tool answers `amended:
  false` with `declined`: the reason (`declined`, `approval_expired` or
  `superseded`) and who declined. The envelope stays as it was.
- **What the lead is told.** Every answer carries the envelope as it is
  now, and the number, base and room of the next sub-program, as the
  other tools' answers do. An approval adds the new package hash.

This refines INV-02: a running run's package changes only by an amendment
of its envelope that the envelope's owner signed, recorded with both
hashes.

### Replay (N06)

Replay reads each admitted sub-program from the artifact store by the hash
its `program_admitted` event names, and runs it against the journal. It
calls no model, no adapter and no checker that could answer differently: a
recorded admission is not checked again. A refused submission is a
recorded tool result.

The lead's loop is not run again, since its result and every tool result
are in the journal. The sub-programs a `plan` admitted are run in the
order they were admitted. Each is held to the hash it was admitted with
(`program_hash_mismatch`), and must end as the journal says it ended
(`nondeterministic_replay`).

A run that is resumed does the same for a step whose sub-program was
admitted: it finds the admission, checks nothing again, and runs the
sub-program on from the journal.

## Static checks

`mandate check` adds these for 0.4 programs. The family E17xx is assigned
here (Appendix B has none for envelopes), E15xx for roles and people.

| Code | Title | Rule |
|---|---|---|
| MDT-E1501 | Role not declared | A role named in a 0.4 module is a `role` definition, local or imported |
| MDT-E1502 | Role not bound | With a lock: every role the package names has a member (`unbound_role` at load) |
| MDT-E1503 | `distinct_from` without an earlier approval | It names a role approved earlier in the same criterion |
| MDT-E1701 | Malformed envelope | `owner`, `caps` and `budget` with `agents` are given; the workflow has no `caps` or `budget` of its own |
| MDT-E1702 | Unbounded map | `max` is given, or the map is inside an envelope and its body starts a delegation, itself or in a function it calls |
| MDT-E1703 | Map concurrency above the envelope | `par k` is at most `spawn.max_concurrent` |
| MDT-E1704 | Envelope approval names a non-critical or uncovered effect | Every effect under `approve` is critical and covered by the envelope's `caps` |
| MDT-E1705 | Not allowed in a sub-program | A sub-program defines only types, constants, capabilities, functions, local agents and one workflow |
| MDT-E1706 | Sub-program does not fit the envelope | Capabilities inside the envelope and clear of writes in flight; budget within what is left; data class; approvals kept. Facts name the dimension |
| MDT-E1707 | `plan` outside an envelope | `plan` is only in the body of a workflow with an envelope |
| MDT-E1708 | Person or critical effect in a map body | Nothing in a map body waits for a person (`human.*`, `escalate`, `pause`, `supervise escalate`, a `verify` a person approves, a function that holds one), and it has no critical effect and no change set. Facts name the map, the kind and the step |
| MDT-E1709 | Amendment narrows the envelope | An amendment's envelope holds every capability of the old one, gives each budget dimension at least what it gave and names no other, and bounds delegations no more tightly. Facts name the dimension. Returned to the lead, never by `mandate check` |

Existing checks extend to the new forms:

- **E0501** counts `agents` with the other dimensions. A static delegation
  counts its attempts (`restart(max: n)` is `n + 1`, `degrade` one more), a
  map `n ×` its body, and a `plan` its lead's own delegation. What
  sub-programs use is bounded at run time by reservation, not statically.
  So for an envelope, the check proves that the static part fits; the
  runtime proves that each sub-program fits what is left. For an envelope
  it compares `steps` as well. A workflow's own budget is compared as
  before 0.4, in money, tokens and time, so an earlier program's
  diagnostics do not change. A map's `budget` is compared with its body
  in every dimension it names, at the map's budget.
- **E0220** applies `spawn.max_class` to every delegation and `infer` in
  the run, and `internal` when the envelope names no class. One in the
  workflow's body is reported where it stands. One inside a function the
  body calls is reported at the call, with at least the class of what the
  call hands the function. One in the body of a skill the workflow
  reaches, through any number of delegations, is reported where it stands
  in the skill: what enters a skill was held to the class where it was
  delegated, so this finds data that first has a higher class inside it.
  The skills are the program's own. An imported agent's body was checked
  in its module, without this envelope.
- **E0320** is reported at a map with `par > 1` for each write capability
  its body can use that the map does not hand per item, as above. Facts
  name `par`, the capability and the kinds handed by item.
- **W0310** counts a capability of an envelope as used when a delegation
  inside a function the body calls is granted it. A workflow's own
  capabilities are reported as before 0.4.
- **E0711** stays: there is no `spawn`. Its message names `plan … within
  envelope` as the dynamic form (V05).
- **Capabilities that name capabilities.** From 0.4 a capability may
  narrow another whatever their names are. Before, the checker evaluated
  capabilities in name order, and one that names a later one came out
  empty; a program of 0.1 to 0.3 is checked as it was. A capability that
  names itself, directly or through another, is nothing in every version.

## Runtime

### Events

| Event | Data |
|---|---|
| `envelope_approved` | package, member, role, key, decision digest. Written to a run's log when it starts, naming the approval it starts under; the approval itself is stored with the package and listed in the run's manifest |
| `map_started` | map node, number of items, `par` |
| `map_ended` | map node; each item's outcome by input index, `Ok` or its fault's tag, and null for an item a failed map did not start or did not let end; under `fail_fast`, the fault that failed the map |
| `program_submitted` | plan node, number, the step of the lead's loop, the lead (`Agent.skill`), base, patch digest, whether it checked; for one that did, its hash and the kinds of governance change in it |
| `program_refused` | plan node, number, step, diagnostics digest, the codes of the errors |
| `program_admitted` | plan node, number, step, the command it runs under, hash, base, where its IR is in the artifact store, its workflow, reservation |
| `amendment_requested` | plan node, the step of the lead's loop, the lead, old and new package hashes, diff digest |
| `package_amended` | old and new package hashes, diff digest, plan node, the wait, the limits that rose (from, to), the waits it superseded, and the member, role, key and decision digest |
| `decision_refused` | command, reason (`invalid_signature`, `unknown_key`, `not_in_role`, `same_member`, `stale_revision`, `subject_mismatch`), and the kind, member, role and key the record names |
| `reconcile_requested` | operation, member, role, key, decision digest (a signed reconciliation) |

The events of an accepted decision (`criterion_approved`, `criterion_denied`,
`governance_approved`, `governance_denied`, `action_authorized`,
`limits_raised`, `input_received`, `decision_received`, `cancel_requested`)
carry `member`, `role`, `key` and `decision`, the record's digest, when the
decision was signed. An unsigned one records what it did before 0.4.

`decision_refused` is the one event a refused decision records: who tried,
with which key, and why. It changes nothing else and raises no revision.

### Refusals

| Code | When |
|---|---|
| `unapproved_envelope` | `StartRun` of a workflow with an envelope, when no stored approval of the package in the envelope's owner role holds (H03) |
| `no_envelope` | An envelope approval of a package that has no envelope |
| `approval_conflict` | An effect under `approve` whose environment or change set member names another role. The run is `attention_required` |
| `above_program_budget` | A raise above the envelope's budget; it needs an amendment |
| `unsupported_language` | At load: a package with `agents` in a budget that is not an envelope's |
| `no_agent_loop` | A `plan` on a runtime that has no agent loop, or whose lead is not a bodiless skill of a local agent |
| `no_checker` | A submission on a runtime whose checker is not installed, or an amendment on one whose checker checks none |
| `stale_amendment` | An approval of an amendment that was asked of a package the run no longer has |
| `program_hash_mismatch` | A stored sub-program that does not hash to what `program_admitted` names |

A map is refused with a fault, before any of its items is dispatched. Like
any fault it can be an outer map item's outcome.

| Fault | When |
|---|---|
| `Rejected(over_limit)` | The list is longer than the map's bound: `max`, or without it the envelope's `agents`, or in a sub-program its own (N08). Names the map, the number of items and the bound |
| `Rejected(overlapping_scopes)` | With `par > 1`, two items are handed write scopes that overlap (N03). Names the map, the two items and the two capabilities |
| `PolicyDenied(outside_capability)` | A scope chosen at run time does not lie inside the capability it narrows. Names the capability and the scope asked for. Also for a delegation outside a map |
| `PolicyDenied(outside_authority)` | A map's `with caps` outside what its context holds (names the map and the item), or a delegation's own outside what it can be granted (names the delegate) |

Two faults belong to a sub-program. Each is returned to its lead.

| Fault | When |
|---|---|
| `BudgetExceeded` naming a `program` | A command inside a sub-program asks for more than the sub-program has left (N02). Names the dimension, what was asked and what is left |
| `Rejected(idempotency_conflict)` | An effect whose business key another effect of the same `plan` used with other parameters (N07). Names the effect, the operation and the first one's command |

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
- **Run views** (`mandate show`; [`views.md`](views.md#views-of-a-run))
  add, per `plan`: each submission with its number, whether it was
  admitted, its hash, its reservation against the envelope, and for a
  refused one the codes; each admitted sub-program as text, shown as a
  model's writing; and the amendments its lead asked for, with how each
  ended. They add the envelope's remainder per dimension, the run's
  deadline and the amendments its owner approved. A `map` shows its items
  by index with their outcome. Every decision shows its member, role and
  whether its signature holds, or `unsigned`.

## Invariants

| Id | Invariant | Where 0.4 keeps it |
|---|---|---|
| INV-02 (refined) | A running run's package does not change, except by an amendment of its envelope signed by the envelope's owner and recorded with both hashes | `package_amended`; action digests name the package; a command is read under the package it was recorded under |
| INV-15 | A sub-program does not run until it is shown to fit what is left of the envelope: authority, budget, agents and data class | Containment at admission; one reservation per sub-program |
| INV-16 | A decision whose signature does not verify against a key the lock binds to its role is not a decision | Decision records; `invalid_decision` |

## Conformance cases

| Case | Rule | Code or event |
|---|---|---|
| N01 | A sub-program whose capabilities or budget exceed what is left of the envelope is not admitted, and nothing of it runs | E1706 |
| N02 | A delegation or a sub-program that does not fit the remaining budget is refused at reservation; two siblings cannot both reserve what only one fits | `BudgetExceeded`, E1706 (R07 generalized) |
| N03 | Map items with `par > 1` cannot write overlapping scopes: statically when the scopes do not depend on the item, before any dispatch when they do | E0320, `Rejected(overlapping_scopes)` |
| N04 | An amendment is a new package hash and only widens the envelope; an envelope approval or an authorization given for the old hash does not authorize the new scope | E1709, `unapproved_envelope`, E0406 |
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
- An egress proxy for sub-programs that need the network: 0.5
  ([`boundary.md`](boundary.md#the-egress-proxy)). On a host that does not
  reach one, a sub-program with `net.https` is refused like any sandbox that
  needs it.
- A critical effect inside a `map` body.
- `await` and a lead that runs several sub-programs at once.
