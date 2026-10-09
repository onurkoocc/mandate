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

## Boundary evidence (B5)

In a change across components, the most valuable evidence is that the
components work together (doc 9 §4). Four verifier methods check it, in the
control plane, never in an agent's sandbox:

| Method | Checks | Met when |
|---|---|---|
| `test.suite_each(components)` | Each component's declared `test` commands, in a read-only sandbox over a copy of its working copy, as the change left them; the evidence names the test files the change touched. Files a configuration pins run as they were at the base commit (K22) | Every component's tests pass |
| `test.contract(changes)` | Every interface whose provider the run works on: its spec at the base commit against the working copy, diffed by protocol (`openapi`, `mcp_tools`, `oauth`, `event`; `db_schema` by a migration heuristic) | No measured change exceeds the declared one. Undeclared counts as `none`; `breaking_change_undeclared` and `change_undeclared` are unmet |
| `test.integration(env: e, components)` | The system built from the candidate working copies with docker compose, its end-to-end service run on networks that are all `internal` | The end-to-end service exits 0 |
| `test.ci({ component: commit })` | The component's existing CI on that commit | The result is attested and the attestation verified; or, in `rerun` mode (the default), the verifier's own run of the component's tests at that commit passes |
| `test.planned(plan)` | What the change touched against the approved plan's `components`, `changes` and, if given, `paths` (component → globs) | No component outside the plan changed, no file outside its paths, and no interface whose spec changed is missing from the plan's changes. Anything else is an `unplanned_change` (B8) |

- **Who is on which side.** The diff takes the consumer's side. What a
  consumer receives (responses, tool outputs, metadata) may gain but not
  lose. What it sends (requests, tool inputs) may loosen but not tighten.
- **Isolation (K43).** Before the first integration check, the host is
  probed: a container on a fresh internal network tries to reach a public
  address and to resolve a name. If either works, or compose's resolved
  configuration publishes a port or has a network that is not internal,
  the check is refused by name (`integration_isolation`) and nothing runs
  (INV-11). Candidate code is built with dependencies fetched from lock
  files only, and runs with no network (examples/kervan/SPEC.md §11).
- **What the evidence is about.** Each check's subject is every component's
  working copy, keyed `<component>/<path>`. A change set member's frozen
  files are checked against it, so a file changed after a check is not
  landed (`stale_evidence`, G01).
- **CI's word.** A CI result is untrusted by default (K21, §4.3). An
  unattested result is shown, and counts only through the verifier's
  re-run. The default when no attestation exists is `rerun` (doc 9 §14
  question 4).

A component's own tests are part of its change: a requested behavior
change updates them, so `test.suite_each` runs them as changed and names
them. What an agent cannot touch are the boundary checks: interface specs
are diffed against the base commit, and the end-to-end scenarios live in
another repository (kervan-system). Tests that state what must not change
can be pinned per component (`pinned`).

Kervan's design task of class 3 shows why the boundary matters. A change
moves only kervan-mcp's side of the token-audience agreement. Its own tests
pass, no interface spec changes, and only `test.integration` fails
This is shown in `runtime/test/audience.test.ts` and against the real system
in `runtime/test/kervan-live.test.ts` (`MANDATE_KERVAN=1`, Docker). There,
kervan-mcp's own tests pass in a container sandbox with no network, every
spec diff is empty, and the real end-to-end check fails; restored, it
passes.

## The change set view (B8)

A person accepts a change set from one view (doc 9 §8.2). It is made from
the IR and the journal, under the program's hash and each module's hash,
at a revision; a decision on an older revision is refused (INV-10, G10):

| Part | Shows |
|---|---|
| Plan | The approved plan, its digest, and who approved it (from its evidence) |
| Per component | Files; each interface it provides, the kind declared (set or plan) and the kind measured (`test.contract`); `UNPLANNED` with why |
| Evidence matrix | Criteria by component: passed, failed or unknown, with the evidence id. A check that reports per component (`suite_each`, `contract`, `planned`) fills each cell from that component's own part |
| Order | Each member with the interfaces it waits for: "after auth: mcp consumes TokenIssuance, which auth provides and this set changes it (additive)" |
| Reality | The mode; in a live run, each member's action state |
| Authority | A member that lands a Mandate module, such as the system model, diffed against the version the run's package pins; governance changes listed. A new module, or the lock, is named |

**Plan ↔ change.** The set digest S covers the plan's digest and evidence.
`test.planned(plan)` checks the change against the plan: a component, a
path or an interface outside it is an `unplanned_change`, and the criterion
is unmet. Read_only and design runs record their sets too, as
`would_apply` and `simulated`, so the view says what would have landed.

## Reads and run modes (B6)

Production is read through the read broker in the control plane, never
from an agent's sandbox: agents have no network and no credential (K7).
Writes go through the effect broker.

```mandate
use std.{data, model}
use kervan.system.{prod_sim}

capability Reads = data.read(prod_sim, mcp_errors, shipment_overview)

let rows = data.read(prod_sim.shipment_overview, tracking_no: t, max_class: internal)
```

- **Declared only (K43).** A read names one the environment declares, and
  passes each of its parameters once, by name (E1201). Values, including a
  model's, are bound parameters, never query text. The broker runs the SQL
  in a read-only transaction with a statement timeout, through a read-only
  login only it holds, or filters log files by the declared expression.
- **Masking.** Only the row type's fields come back. A field of a class
  above `max_class` (the environment's class when absent) comes back as
  `{ "$masked": "<class>" }` and is typed `Masked`. Rows are `Untrusted`,
  with the class of what is left. A confidential row cannot reach a model
  limited to internal data (E0220). A field the program needs unmasked does
  not check (E0201): a class is never lowered.
- **Authority.** `data.read(env, read…)` (all the environment's reads
  without names). Each call needs one covering its read (E0301).
- **Recorded.** Each read is a journaled command with its `as_of`; replay
  reads the journal and never asks the broker (INV-09).

A run's **mode** is part of its manifest (R), and its views show it:

| Mode | Reads | Critical effects | Evidence |
|---|---|---|---|
| `design` | Sample rows (`samples`), never production | Simulated: recorded, nothing prepared or sent | Carries `mode: "design"` |
| `read_only` | Through the broker | Prepared and frozen, then recorded `would_apply`: never authorized or committed. A change set prepares its members and stops | Carries `mode: "read_only"` |
| `live` | Through the broker | prepare → authorize → commit | As before |

A read_only run is the **shadow run** of Doc 4 §8.3 (old item 22).
`mandate shadow-diff <a> <b>` compares what two runs prepared, node by node,
by what each action would do: effect, parameters, frozen files and business
key. It reports `same`, `differs`, `only_a` or `only_b`, with how many
actions each run committed (V19; a read_only run commits none).

## Onboarding and drift (B7)

Taking an existing system into Mandate means describing it, not rewriting
it, and the description is checked like any other agent output. Onboarding
starts from what is certain, the repositories
([`kervan.repos`](../examples/kervan/programs/repos.mdt): components with
`lang other` and an unassigned owner), and is a program of its own
([`onboard.mdt`](../examples/kervan/programs/onboard.mdt)):

1. An agent reads the repositories and writes the model into the working
   copy of the repository that will hold it. Its result is `Inferred`: an
   agent saying a service consumes another is not the system's truth
   (INV-04).
2. The runtime checks the draft against the repositories:

   | Method | Checks | Met when |
   |---|---|---|
   | `test.system_specs(path, at: c)` | The draft module checks clean and defines only components, interfaces, environments and the types their reads return. It describes every other repository of the run, by name and repository, and nothing else. Each interface's spec is in its provider's repository at the base commit, and parses | No problem |
   | `test.consumes(path, at: c)` | Each repository at its base commit is scanned for calls to the other components: a URL to a component's host, or a host as the default of a host, URL, issuer or endpoint setting, outside tests | Every call is a `consumes` of the model. A `consumes` the code does not show is a warning (best effort) |
   | `test.commands(path, at: c)` | Every component's `build` and `test` commands, in a sandbox over its base commit, with no network | Every command exits 0 |

   A person accepts it: `human.approve(role: "architect")`.
3. The accepted model lands in that repository as a change set of one
   member: the first version of the system model.

The evidence binds to the draft's bytes, so the file that lands is the file
that was checked (G01).

`mandate onboard --component name=dir…` drafts a model from working copies
without a model or a run. It infers each component's language and commands
from `package.json`, `pom.xml` or `pyproject.toml`, and its interfaces from
spec files by convention: `docs/openapi.json`, `docs/mcp-tools.json`,
`docs/oauth-metadata.json` and a Flyway migration directory. Consumption
comes from calls in the code, each listed with its file and line, and
owners from `CODEOWNERS`. The draft checks clean. It is a start, not the
model: interface names are made up, and a person names them.

**Drift** is the same comparison against an accepted model:
`mandate drift --module model.mdt --component name=dir…`. It reports, as
drift (exit 1):

- a component whose working copy is missing;
- a language that differs;
- a spec that is missing or does not parse;
- a spec no interface names;
- a call the model does not declare, with where it is.

As warnings, it reports a `consumes` the code does not show and test
commands other than the convention. Running the onboarding program again
on the accepted model finds the same drift as unmet evidence. Updating the
model is an approved change, as before.

Kervan's committed model leaves one dependency out on purpose: kervan-auth
fetches the client metadata kervan-voice publishes (`CIMD_ALLOWED_HOSTS`,
`src/config.ts`), and the model has auth consume nothing. `mandate drift`
finds it, as does `test.consumes` on that model. Both also report auth's
reference to mcp, the resource it issues tokens for, which the model leaves
out as well: a reference is not always a call, and a person decides what
the model says. A model drafted from the
repositories is accepted and lands (`runtime/test/onboard.test.ts`).
