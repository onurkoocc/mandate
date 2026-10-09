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
