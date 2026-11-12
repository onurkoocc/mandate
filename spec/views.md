# Human views

People review a Mandate program through views, not through its text (design
doc 4, §15). A view is a projection: it is computed from the canonical IR,
and for a run also from the run's journal, and from nothing else (INV-10).
It is read-only. Every view names the program hash it shows, so a view and
the program it claims to show cannot drift apart.

## Views of a program

`mandate view <program> [--format md|html|json] [--lock <lock.json>]`
(`compiler/src/views/`) prints three views.

**Architecture.** Each workflow as a graph, in the order its body runs
(§15.1):

- delegations, each with the grant it really gets: the agent's capabilities
  inside the workflow's, after `with caps`; and `isolated`, the supervision
  strategy and the timeout;
- `par` branches side by side;
- `verify` with its criteria and methods;
- the person an unmet contract escalates to;
- external effects, with whether they are critical or irreversible,
  idempotent, and their compensation.

It is given as a Mermaid flowchart and as a table.

**Authority.** For every agent, workflow and delegation (§15.2):

- paths it may read and write;
- network hosts;
- model tiers, with the highest data class each may receive;
- commands and argument prefixes;
- repositories it may open pull requests in;
- money;
- the external effects a workflow commits, and how each is authorized by
  default;
- any capability whose scope is not statically known.

**Cost.** For every workflow:

- its limit;
- every delegation with the budget it reserves (from the call, the skill or
  the agent);
- how many times it may run: loops `max_iter` times, `restart(max: n)`
  `n + 1` times, a `degrade` fallback once;
- with a lock file, the per-call bound of a model turn and `steps ×` that
  bound (W0504);
- the static upper bound of everything the workflow hands out. For a
  workflow with an envelope it counts the agents the static part starts
  too, as the checker counts them.

## The envelope's card

A person approves an envelope once, before any run (spec/envelope.md,
"Approving an envelope"). The card is what they read first.
`mandate view <program> --card [--workflow W] [--format md|html|json]
[--lock <lock.json>] [--module <file>]…` prints it for one workflow with an
envelope. `--workflow` names the workflow; it is needed only when the
program has more than one with an envelope, and without it the command
lists them and stops. A program with none has no card, and the command
exits with status 1.

The card answers five questions, from the IR and the lock only:

- **What it does:** the steps the architecture view draws; each `map` with
  what it runs over, its `max` and `par`, the delegations of its body and
  what its `with caps` hands each item; each `plan` with its lead and the
  budget the lead's own delegation reserves.
- **What it can touch:** the envelope's capabilities, opened as the
  authority view opens them into paths read and written, hosts, commands,
  model tiers and repositories; `spawn.max_class`, `internal` when the
  envelope does not say; and `spawn.max_concurrent`.
- **The most it spends:** per dimension (spend, tokens, time, steps,
  agents), the envelope's budget, the static part's upper bound and what is
  left for sub-programs. The upper bound is the one the checker compares for
  E0501 (`compiler/src/check/cost.ts`), so the card and the check agree.
- **When it asks whom:** every wait for a person by role that the workflow
  can reach, in its body, in the functions it calls and in the contracts it
  verifies against (`human.approve`, `human.ask`, `escalate human(…)`,
  `supervise escalate(…)`, a change set's approvers); and each effect under
  the envelope's `approve` with its role. Each role shows the members the
  lock binds to it.
- **Who approves it, and who may amend it:** the `owner` role and the
  members the lock binds to it, with how many keys each has. With no lock,
  or a lock that binds nobody to the role, the card says that nobody can
  approve it yet.

The card names the package hash: the program hash and the lock as the
package carries it, without its format field (`packageHash` in
`compiler/src/hash.ts`). It is the hash the runtime checks when it loads
the package and the one `mandate approve-envelope` signs, so a changed
program, lock or imported module shows a new hash on the card. In JSON
every number is given as a number and as the text the document shows.

## What changed between two versions

`mandate view <new> --against <old>` shows the semantic diff of §15.3 in
three parts.

**Governance changes**, which a person must approve (§13.2):

- authority widened: a new capability; a new path, host, command or
  repository in one; a new model tier or a higher data class; a capability
  added to an agent or a workflow; a capability changed in a way the diff
  cannot read as a narrowing, such as the amount `money.spend` allows;
- a budget raised or a limit removed;
- an acceptance criterion removed, or its method changed; a `require`
  changed;
- an effect made irreversible;
- a remote agent added or rebound;
- a definition replaced by one of another kind.

A new network target always shows here (G11).

`mandate patch` and `mandate.apply_patch` ([`mcp.md`](mcp.md)) report the
same governance changes for a patch, computed by the same code, but not the
locks' (a patch changes the program, not its lock). Each comes with a kind,
its path, and as `detail` the text shown here:

| Kind | The change |
|---|---|
| `capability_added` | A capability added or widened (a scope, a model tier, a data class, argument prefixes), one changed in a way its scopes do not show (what `money.spend` allows), or one more held by an agent or a workflow |
| `budget_increased` | A workflow's, agent's, skill's or function's budget raised, or a limit removed |
| `criterion_removed` | A criterion removed; for a removed contract, one change at the contract's path |
| `criterion_changed` | A criterion checked by another method |
| `require_changed` | A contract's `require` changed |
| `irreversible_added` | An effect made irreversible, or a new irreversible effect |
| `system_model_changed` | A component, interface or environment added, changed or removed ([`system.md`](system.md)) |
| `envelope_changed` | A workflow's envelope added, changed or removed ([`envelope.md`](envelope.md)) |
| `remote_agent_added` | A new remote agent |
| `remote_binding_changed` | A remote agent rebound |
| `kind_changed` | A definition replaced by one of another kind under the same name |

The diff also compares the two versions' locks: a member added or removed,
a key added to or removed from a member, a member added to or removed from
a role. Each such change is a governance change, since it changes who can
decide (spec/envelope.md, "The lock: members and roles"; case H05). The new
version's lock is read from `--lock`, else `mandate.lock.json` next to the
new file; the old version's from `--against-lock`, else `mandate.lock.json`
next to the old file. Without an old lock, the old version binds no one.

**Behavior changes:**

- steps added or removed, a step's grant or supervision changed;
- agents, skills and effects added or removed;
- criteria added;
- authority narrowed, budgets lowered.

**Unchanged:** the external effects, the contracts, that no authority was
added, that no budget was raised, when each holds.

## Views of a run

`mandate show <run> [--format md|html|json]` (`runtime/src/views.ts`)
shows a run with the views of its program, under the program and package
hashes:

- **Status:** the run's state. If it waits for a person, it shows what for,
  the exact subject or parameters a decision binds to with their digest,
  and the command that answers at this revision.
- **Evidence:** each criterion's records (§15.4): method, result, who
  produced it, whether its signature holds, and its outputs as artifact
  references.
- **Cost:** limit, settled, reserved and available per dimension, and each
  command's reservation and cost.
- **External actions:** state, operation and receipt.
- **Decisions:** each decision a person made on the run, in the order the
  run took them: its kind, who made it, the role, whether its signature
  holds, the wait it answered and the record's digest.
  - A signed record is read from the store and checked again when the
    view is made (INV-16). One that was changed after it was signed, or
    whose key the lock does not bind to its member and role, shows
    `INVALID` with the reason. So does one the journal names and the store
    no longer has; its kind then shows as `decision`. A decision is listed
    where the first event that names it is, and a stored record that no
    event names is listed last.
  - A decision the runtime took in unsigned mode shows `unsigned`, with
    the name the caller gave as untrusted text. An answer is given with no
    name, and shows the sender of its message.
  - Which way an unsigned decision went is read from the journal's events,
    not from the wait's result, which retention may purge: the event that
    names the same wait, or the authorization whose id names the message
    that carried the approval. One that came after its wait's deadline
    decided nothing and shows as `decision`: the journal does not say
    which way it went.
  - An unsigned reconciliation leaves no event, and is not listed.
- **Envelope** (0.4), for a run of a workflow that has one:
  - its owner, and the run's deadline: its start plus the envelope's
    `time`;
  - per dimension: what the envelope gives, the run's limit, and what is
    settled, reserved and left. A dimension the caller limited and the
    envelope does not name shows `no limit` for the envelope;
  - each amendment its owner approved: the package before and after, who
    approved it, and the limits it raised.
- **Plans** (0.4), one section per `plan` node whose lead submitted or
  asked for something:
  - each submission in order: its number, whether it was admitted or
    refused and with which codes, the sub-program's hash, what its
    admission reserved of the envelope, the kinds of governance change in
    it (§13.2), the command it runs as and that command's state. A refused
    submission takes no number, so the next one has the same. One that did
    not check has no hash. One the journal has neither admitted nor
    refused yet shows as `submitted`;
  - each admitted sub-program as text, read from the artifact store and
    shown as untrusted content: a model wrote it (G09). It is shown only
    when what is stored hashes to what was admitted. Otherwise the view
    says that it is gone, or that it does not match;
  - the amendments the lead asked for, each with both package hashes and
    how it ended: `waiting`, `approved` or `declined` with the member, or
    why its wait ended unanswered (`approval_expired`, `superseded`).
- **Maps** (0.4), one section per map that began to run its items: the
  number of items, its `par`, and each item by input index with its
  outcome.
  - Once the map has ended: `Ok` or the item's fault, from `map_ended`.
  - A map that `fail_fast` failed: the fault that failed it, and
    `no outcome` for an item it did not start or did not let end.
  - While the map runs: `not started`, `in flight`, or `settled` for an
    item whose commands have all ended.
- **Change sets** (design doc 9 §8.2), one section per set:
  - the approved plan, its digest, and who approved it;
  - each component's change: its files, each interface it provides with
    the declared kind and the measured kind (`understated` when the
    measured change exceeds the declared one), and whether the change
    is the plan's;
  - the evidence matrix: the criteria of the members' evidence by
    component, each cell passed, failed or unknown, with its evidence
    id;
  - the order, with the interface each member waits for;
  - what was real: live, read_only (prepared, never committed) or design
    (simulated), and each member's action state;
  - its governance-class files (CI, lockfiles, agent settings, the
    Mandate lock, CODEOWNERS, a component's own patterns), each with its
    class and the owner who must approve it (K70;
    [`system.md`](system.md#governance-class-files-k70));
  - what it changes in authority. A member that lands a Mandate module
    is diffed against the version the run's package pins (§15.3
    governance changes), or reported as new; a lock file is named.

The header lists every imported module, such as the system model, by
program hash.

In JSON the 0.4 parts are `decisions`, `envelope` (null without one),
`plans` and `maps`. A run that has none of a part has no section for it.

Every run view names the revision and the last event it shows (`as_of`).
`freshness(run, as_of)` says how many events the run has moved since. A
decision taken on an older revision is refused (`stale_revision`), so a
person acting on a stale view is told to look again (G10).

## Untrusted content

A model's output, a tool's output and a person's answer are shown as plain,
quoted text: in a fenced block or a code span in Markdown, and escaped in
HTML. They are never markup, a link or a control. A model can write
`<button>Approve</button>`; a view shows those characters and nothing more
(G09).

The HTML page is self-contained. Its content security policy allows no
scripts, frames, forms or remote resources.

## The system

A module that defines or imports a system model (0.3) also gets a system
view: the consumption graph, components with owners, commands and their
own governance-class patterns,
interfaces with provider and consumers, environments with reads and
authorization tiers, and the hash of each module the model comes from
(design doc 9 §8.1; [`system.md`](system.md#the-system-view)). Every
change to the model is shown under governance in the semantic diff.
