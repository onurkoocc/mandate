# Existing systems (0.3)

Most engineering work changes systems that already run: several
repositories, several languages, a CI that already exists, people who own
each part. Mandate does not rewrite such a system; it describes it. This page
is how (design doc 9). The reference system is Kervan
([`examples/kervan`](../examples/kervan/SPEC.md)).

## The system model

Three definition kinds describe a system. They run nothing. They are
ordinary IR, so the same hash, checks and views apply to them.

| Kind | Declares |
|---|---|
| `component` | A deployable unit: its repository (`owner/name`), the root of its working copy, its language, the role that owns it, its `build` and `test` commands, and the interfaces it `provides` and `consumes` |
| `interface` | A contract between components: its `protocol` (`openapi`, `mcp_tools`, `oauth`, `event`, `db_schema`) and the path of its spec file in the provider's repository |
| `environment` | An environment: the highest data `class` it holds, its declared `read`s, and for each effect the weakest authorization it accepts there (`authorize deploy by human(role: "release_manager")`) |

```mandate
mandate @ 0.3
module kervan.system @ 0.1

interface CoreApi {
  protocol openapi
  spec     "docs/openapi.json"
}

component core {
  repo     "onurkoocc/kervan-core"
  root     "/work/kervan-core"
  lang     java
  owner    role "core_owner"
  test     exec("mvn", ["-B", "-q", "-o", "test"])
  provides CoreApi
}

environment prod_sim {
  class confidential
  read shipment_events from core
    sql "select tracking_no, at, description from shipment_events where tracking_no = :tracking_no order by at"
    params (tracking_no: Text)
    returns EventRow
    max_rows 200
  authorize deploy by human(role: "release_manager")
}
```

Rules:

- Every interface has exactly one provider (E1001). The provider answers for
  a change to it, and its spec is read at the provider's base commit.
- No two components share a working copy: roots never overlap (E1003).
- A read is one SELECT statement (or a log filter) whose values come only
  from its parameters. Every `:name` placeholder is a parameter, every
  parameter is used, and parameters are scalars (E1004). Model output can be
  a parameter value, never query text (K43).
- A read never returns data above its environment's class (E1005).
- Adding, changing or removing a component, interface or environment is a
  governance change: `mandate patch` reports `system_model_changed`, and
  `mandate view --against` lists it under governance. The model belongs to
  the institution, not to a program.

## Importing the model

A system model is a module. A program imports what it works on:

```mandate
use std.{component, model}
use kervan.system.{mcp, core}
```

- The compiler loads imported modules given with `--module <file>`
  (`mandate check`, `sandbox`, `view`, `run`). An imported name means that
  module's definition; what it refers to in its module (a component's
  interfaces, a read's row type) comes with it. A name that collides with
  a local one is refused (E0121); a name the module lacks is unresolved
  (E0120). A module that is not loaded stays opaque, as before.
- The lock pins every imported module by its program hash (E0142 at check
  time, `module_hash_mismatch` at load time). A run's package carries the
  modules it was checked with, so its system model never changes under it
  (INV-02, S09).

## Capabilities over components

A capability can name components instead of paths. It opens into exactly
what the model declares, so every check (C1–C5) and every sandbox treats it
like the capability written out:

| Written | Stands for |
|---|---|
| `component.read(c…)` | `fs.read(c.root…)` |
| `component.write(c, p…)` | `fs.write(c.root/p…)`, or `c.root` without paths |
| `component.exec(c, build \| test)` | `exec(command, args_prefix)` for each declared command, one capability per command |
| `component.repo(c…)` | `git.pr(c.repo…)` |

A component that is not one, a path outside the component, or a command
kind it does not declare is refused (E1002). So is narrowing a capability
that stands for several commands as one. Two `par` branches may write two
components; writing the same component from both is E0320 (C5).

Doc 9 §2.2 proposed that `component.write` also carries `git.pr` of the
repository. It does not: agents never hold `git.*` (E0408), so `git.pr`
would be authority no agent may use (W0310). A workflow that lands changes
holds `component.repo(c)`.

## The system view

`mandate view` shows a module that defines or imports a system model as a
system (doc 9 §8.1):

- the consumption graph (consumer → provider, labelled with the interface);
- components with repository, root, language, owner, build and test
  commands;
- interfaces with protocol, spec, provider and consumers;
- environments with their class, declared reads and authorization tiers;
- the modules the model comes from, by hash.

## The workspace (B3)

A run that works on components starts from one base commit per component.
The runtime checks each component out at its root before the run starts,
and records `{ repo, root, base }` per component in the run's manifest,
whose hash R the run views show. One live run holds a working copy at a
time. Each delegation's sandbox sees only the components its grant names, so
two agents writing two components in parallel cannot touch each other's
work (C5 across components, enforced by the sandbox too). See
[`runtime.md`](runtime.md#workspace-and-run-manifest-design-doc-9-12-b3).

## Change sets (B4)

A change across several components is one change set: prepare → authorize
→ commit over one external action per component (doc 9 §3, K42).

```mandate
let landed = changeset(plan) {
  member auth = git.merge(auth_change)
  member core = git.merge(core_change)
  member mcp  = git.merge(mcp_change)
  order  auth, core, mcp
  change TokenIssuance additive
  change CoreApi additive
  approve role "architect"
} idempotent_by task.id
```

Checks:

- The plan is a verified value (E1105).
- Every member is a component and a critical effect (E1104). The workflow
  holds each member's repository, e.g. `component.repo(auth, core, mcp)`
  (E0301).
- `order` lists every member once (E1102).
- For each declared `additive` change, the interface's provider is a member
  and lands before every member that consumes it (E1101). No order may be
  needed that the graph cannot give (a cycle, E1101). A `breaking` change is
  never one set: expand → migrate → contract (E1103). `none` sets no order.
- Only in a workflow body (E0408), with `idempotent_by` (E0403).

At run time:

1. **Prepare.** Each member, in order, is prepared like any external
   action. Its parameters name its component (repository, root, and the
   base commit the run started from), and its files are frozen. The set
   digest S covers the plan and its evidence, the members' action digests in
   order, the declared changes, the approver and the business key.
2. **Authorize.** Each component's owner (or the member's `approved_by`)
   approves its member, bound to the member's digest. Then the set approver
   approves S (owners first: doc 9 §14 question 2). The approver sees the
   order, the declared changes, and each member with its approver, digest and
   files. Another member is another S; an approval of one set never applies
   to another.
3. **Commit.** Members commit in order. Each needs its own authorization
   and S's; the first commit consumes S's authorization for this set only
   (G13).
4. **Partial.** A member that is refused, or whose outcome is unknown,
   stops the set: the members after it are not sent. If nothing landed,
   the set failed (`Rejected`). Otherwise the run stops for a person with
   `changeset_partial`: the applied members with their receipts, where it
   stopped, what was not sent, and the compensations the applied members
   offer (`git.merge` offers `git.revert`). Compensation is offered, never
   run (§8.5). After reconciliation the run goes on from where it stopped:
   an applied member is not sent again; one proven not applied is sent again
   under the same operation key.

`git.merge` on GitHub lands a member as a commit on top of the run's base
commit. It opens a pull request from `mandate/<component>-<op>` and merges
it, pinned to that head commit (a moved head is refused, 409). It is
reconcilable from the pull request's state.
