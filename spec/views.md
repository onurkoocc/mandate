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
- the static upper bound of everything the workflow hands out.

## What changed between two versions

`mandate view <new> --against <old>` shows the semantic diff of §15.3 in
three parts.

**Governance changes**, which a person must approve (§13.2):

- authority widened: a new capability; a new path, host, command or
  repository in one; a new model tier or a higher data class; a capability
  added to an agent or a workflow;
- a budget raised or a limit removed;
- an acceptance criterion removed, or its method changed; a `require`
  changed;
- an effect made irreversible;
- a remote agent added or rebound.

A new network target always shows here (G11).

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
view: the consumption graph, components with owners and commands,
interfaces with provider and consumers, environments with reads and
authorization tiers, and the hash of each module the model comes from
(design doc 9 §8.1; [`system.md`](system.md#the-system-view)). Every
change to the model is shown under governance in the semantic diff.
