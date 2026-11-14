# Libraries, patterns and connectors (0.6)

**Status: specified, not implemented.** Nothing on this page is
implemented yet. The page specifies release 0.6 so that the implementing
changes, all in the Rust compiler and the runtime, are written against
the same rules and cases. Each part lands with the slice named in the
table, which refines its section here. Until then neither compiler reads
`mandate @ 0.6` (E0103), and the runtime refuses a 0.6 package when it
loads it (`unsupported_language`).

| Part | Slice | State |
|---|---|---|
| The 0.6 surface: `pub` on every definition kind, `///` doc lines, closed imports; E1602, E1603, E1604 | RL4 | specified; not implemented |
| Patterns: `pattern`, application, expansion, limits under expansion, `expanded`; E1301 to E1307 | RL7 | specified; not implemented |
| The stored expansion at run time; `expansion_mismatch` | B7 | specified; not implemented |
| Libraries: the manifest, the digest, lock format 0.6, the local directory, the authority signature, versions, the waiting period and revocation; E1601, E1605 to E1608 | RL3, RL8 | specified; not implemented |
| `mandate add`, `upgrade`, `publish`; the `libraries` configuration; `library_digest_mismatch`, `library_revoked` | RL8, B7, B8, RP5 | specified; not implemented |
| `std.patterns`: `BatchWithExceptions`, `FanOutMerge`, `MakerChecker` | RL8 | specified; not implemented |
| Connectors in the language: `connector`, tool classes, `tool.call` and its coverage, the fix of `requires caps` (B12); E1401 to E1408 | RL5 | specified; not implemented |
| What is sent to a connector: E0220 for a tool's arguments and for what an agent that holds tools receives; held at run time by the check at load | RL5 | specified; not implemented |
| Connectors at run time: the MCP client, connector gateways, schema digests at start and resume, samples in design runs, `mandate connector pin` | B6, B9 | specified; not implemented |
| `human.review` and `waive by` in the language; E1504 to E1508 | RL6 | specified; not implemented |
| The review wait and decision, escalation and expiry, waiver evidence, what `Verified` accepts, the value binding (B25); `mandate review` | B10 | specified; not implemented |
| The batch commit step: E1708 in a 0.6 program, the operation key of a map, `person_in_map` | RL6, B9 | specified; not implemented |
| `shapes` in an envelope; E1709 for shapes, E1710, E1711; `shape` in a sub-program's events | RL9, B12 | specified; not implemented |
| Views and the card of a 0.6 program | RP4 | specified; not implemented |
| The bridge: the runtime and the CLI call the Rust compiler as an in-process WebAssembly module | B1 to B5, RP3 | specified; not implemented |
| The Rust command line | RP5 | specified; not implemented |
| The acceptance program and its three criteria | RL8, B11 | specified; not implemented |

0.6 gives a workflow a shape it can share, gives programs definitions they
can share, and gives agents typed access to business systems. A
**pattern** is a workflow with compile-time parameters; a program applies
it, and the compiler checks the expanded body as if it had been written
out. A **library** is a set of 0.6 modules with a manifest, pinned in the
lock by a digest. A **connector** declares an MCP server's tools with what
MCP does not say reliably: whether a tool writes, how it is retried, and
the class of the data it returns. A batch asks a person once, about the
list (`human.review`), and a contract says beforehand which of its
criteria a person may waive, and who (`waive by`).

What a 0.6 package may do is still bounded as before: authority by
capabilities, money and time by budgets, effects by prepare → authorize
→ commit. A pattern brings no authority and a library runs no code when it
is installed (INV-21). A connector's tool is called only with the schema
the lock pins, and only through the egress proxy (INV-22).

## What 0.6 adds

| Addition | Where | Meaning |
|---|---|---|
| `pub` | every definition | What another module may name |
| `///` | before a definition | A doc line, kept in the IR as `doc` |
| `pattern` | definition | A workflow with slots, applied by a workflow |
| `workflow W = P<…>(…)` | definition | An application of a pattern |
| `mandate.library.json` | library | A library's manifest |
| `libraries`, `connectors` | lock | Each library's version, digest and modules; each connector's credential and tool schemas |
| `std.patterns` | library | Three patterns, built into the compiler |
| `connector` | definition | An MCP server's tools, each `read_only` or of a write class |
| `tool.call(c, t…)` | capability | The authority to call tools of a connector |
| `human.review` | expression | One wait for a person about a verified list |
| `waive by` | criterion | The roles that may waive the criterion |
| `shapes` | envelope | The patterns a lead's sub-programs may apply |
| `mandate add`, `upgrade`, `publish`, `connector pin`, `review` | CLI | Libraries, schema pins, review decisions |

A file names the version first: `mandate @ 0.6`. Everything on this page
is read only under that header. A 0.6 field or definition in an older
program is E0104, as a 0.4 one is (case E0104d). A program of 0.1 to 0.5
reads, checks, hashes and prints exactly as before, with the same
diagnostics: every rule this page relaxes or tightens holds for 0.6
programs alone, and the page says so where it does. The new words
(`pattern`, `connector`, `tool`, `waive`, `shapes`, `read_only` and the
tool classes) are contextual; the list of reserved words does not change.

The IR of a 0.6 program is closed by its own schema,
`spec/ir-0.6.schema.json`, and a 0.6 lock by `spec/lock-0.6.schema.json`
(both written with their implementation, RL3). The schemas of 0.1 to 0.5,
and what they accept, do not change. When the Rust compiler reads 0.6,
the list of known versions in E0103's message and facts grows by one; the
stored results of earlier programs are compared without that one entry
(`vectors/README.md`).

## The 0.6 surface

### `pub` and visibility

```mandate
mandate @ 0.6

module acme.connectors.types @ 2.3

/// An invoice as the mailbox holds it.
pub type Invoice = { invoice_no: Text, vendor_id: Text, total_cents: Int }
pub type Order   = { order_no: Text, vendor_id: Text, total_cents: Int }
pub type Match   = { invoice_no: Text, order: Order }
pub type DraftId = Text
```

- **Every kind.** In a 0.6 module `pub` may stand before every definition
  kind: `type`, `capability`, `const`, `fn`, `extern`, `effect`, `agent`,
  `workflow`, `contract`, `component`, `interface`, `environment`, `role`,
  `pattern` and `connector`. In IR it is `"pub": true` on the definition,
  absent otherwise, as on a `fn` today.
- **Visibility (E1602).** Another module may name only the `pub`
  definitions of a 0.6 module, in a `use` list or wherever it names an
  imported definition. Naming any other is E1602, at the name. A module
  names its own definitions freely.
- **Older modules.** In a module of 0.1 to 0.5, `pub` is read as before:
  on a `fn` only, with no effect on what may be named. Every definition of
  an older module may still be named from any program, a 0.6 one
  included.
- **An earlier program importing 0.6 (E1603).** A program or module of 0.1
  to 0.5 that imports a module written in 0.6 is E1603, at the `use`. It
  would read the 0.6 definitions with its own rules, and those rules do
  not know what 0.6 adds. The runtime checks a package again at load, so
  it refuses such a package too (`load_verification_failed`).

### Doc lines

A line that starts with `///` directly before a definition, or before the
`pub` of one, is a doc line of that definition. Its text is what follows
`///`, less one space when there is one. Consecutive doc lines are joined
with `\n`, in order, into the definition's `doc` field.

- **Only before definitions.** A `///` line anywhere else (inside a body,
  before `use` or `module`, at the end of the file, or followed by a
  blank line before the definition) is E0101.
- **In the hash.** `doc` is part of the definition, so it is part of the
  definition's hash and the program hash: a changed doc line is a new
  program. The semantic diff does not count it as a governance change.
- **Kept by the formatter.** `mandate fmt` and the printer write `doc` back
  as `///` lines before the definition. `//` comments are still dropped,
  as before.
- **Older programs.** In a program of 0.1 to 0.5, `///` is a comment, as
  it is today: the lexer drops it and nothing changes.

The views and the card show a definition's `doc` as the program's text,
not as a model's: a person wrote it, and the package hash covers it.

### Closed imports

Before 0.6 an imported name whose module is not loaded is taken on trust:
its type is unknown and accepted wherever it is used. A 0.6 program closes
that hole. Every `use` of a 0.6 program or module names one of these, or
it is E1604, at the `use`:

- `std` itself (`use std.{fs, model, tool, …}`), or `std.decision`;
- `std.patterns`, which is built into the compiler;
- a module the check was given (`--module`, the modules of the MCP server
  or of a call, the modules a package carries);
- a module of a library the lock pins under `libraries`.

Inside a library, a module may also import the other modules of its own
library, and the modules of the libraries its manifest `requires`, and no
others (E1604). A program of 0.1 to 0.5 keeps the old rule, unknown types
and all.

## Patterns

A pattern is a workflow with compile-time parameters, called **slots**. A
workflow that applies it names a value for every slot, and the compiler
replaces the application with the pattern's body, the slots filled in.
Every check runs on that expanded body. The runtime never sees a pattern.

### Declaration

```mandate
pub pattern Name<T1, T2>(slot: kind, …) [(param: Type, …)] -> Type {
  body
}
```

- `<T1, T2>` are type parameters, given in that order where the pattern is
  applied. 0.6 does not infer them.
- The slots are listed in order, each with a name and a kind (below).
- An optional second list declares run parameters: the parameters of the
  workflow an application becomes, in order.
- The return type may use the type parameters and the type slots. The
  body is a block, as a workflow's, and its value is that of its last
  expression.
- Names in the body and the signature that are not slots, type parameters,
  run parameters or local bindings resolve in the pattern's own module, as
  if the body were written there. Its other definitions need not be `pub`
  for that; a type the applying program must name, such as the return
  type, does.

In IR a pattern is a definition of kind `pattern` with `slots`, and its
type parameters, run parameters, return type and body. A workflow that
applies one carries `apply`: `{ pattern, types, args, params? }`. The
exact shapes are those of `spec/ir-0.6.schema.json`.

### Slots

| Kind | Takes | Used in the body as |
|---|---|---|
| `type` | A type | That type, by the slot's name |
| `skill(sig) [read_only]` | A skill `Agent.skill` whose signature fits `sig`; with `read_only`, of an agent that holds no write capability | `delegate slot(args)` |
| `tool(sig)` | A read-only tool of a connector, `connector.tool` | A call, `slot(args)` |
| `effect(sig)` | A user effect, a std effect, or a write tool of a connector | `effect slot(args) idempotent_by k` |
| `contract(sig)` | A contract whose parameters fit `sig` | `verify x against slot(args)`; in a type, `Verified<T, slot>` |
| `role` | A role definition | Wherever a role is named |
| `capability` | A capability definition | Wherever a capability is named (`with caps`, `.narrow(…)`) |
| `const T` | A constant expression of type `T` | Wherever a constant is needed (`max`, `par`, a deadline) |
| `field(T)` | The name of a field of the record type `T` | `v.slot`, which reads that field of `v` |

All of them are known at compile time. A write capability is one of
`fs.write`, `git.pr`, `component.write`, `component.repo`, `env.deploy`,
`env.migrate`, or a `tool.call` that names a tool that is not read-only.

A signature fits when each parameter type of the slot is accepted where
the argument's parameter is expected, and the argument's result is
accepted where the slot's result is expected, in the order of
[how a value is known](core.md#21-how-a-value-is-known). A tool's
parameter `Verified<T>`, with one argument, accepts a `Verified<T, C>` of
any contract `C` (see [Tool classes](#tool-classes)). The parameter a
write tool names in `idempotency key` is not part of its signature: the
runtime fills it.

### Application

```mandate
workflow MatchInvoices = BatchWithExceptions<Invoice, Match, DraftId>(
    source: mailbox.list_invoices, work: Matcher.match, accepted: Matched,
    reviewer: accountant, escalate_to: finance_lead,
    commit: erp.post_draft_invoice, key: invoice_no,
    max_items: 60, concurrency: 6, deadline: 1d)
  caps   Inbox, ErpRead, ErpDraft, ModelStd
  budget { spend: 20 USD, time: 2h }
```

An application is the whole definition of a workflow: the pattern's name,
its type arguments, one named argument per slot, then the workflow's
`caps` and `budget`, as a workflow without an envelope writes them. The
workflow's parameters are the pattern's run parameters, and its return
type is the pattern's, with the type arguments put in.

- The name applied is a pattern, local or imported (E1303); an imported
  one is `pub` (E1602).
- Every slot has exactly one argument, every argument names a slot, the
  type arguments are as many as the type parameters, and every argument is
  of its slot's kind (E1304).
- Every argument fits its slot's signature: a skill's, tool's or effect's
  parameters and result, a contract's parameters, a constant's type, a
  field of the named type (E1305). A `skill(…) read_only` slot given a
  skill of an agent that holds a write capability is E1305 too.
- A pattern is applied only as the definition of a workflow: an
  application in a body, as a slot's argument, in a pattern's body (a
  pattern does not apply another), or as the definition of anything but a
  workflow is E1307. So is an application with an `envelope`.

### Expansion

The compiler expands every application after the role checks and the
check of imported method limits (E1804), and before the static checks.
The expansion is an ordinary workflow body: each use of a slot replaced
by its argument, each type parameter by its type argument, each `v.slot`
of a `field` slot by that field.

- **Every check runs on the expansion.** Capabilities C1 to C5, effects,
  budgets (E0501, against the applying workflow's `budget`), contracts,
  taint, data classes, E1702, E1708 and every other rule hold for the
  expanded body as if it had been written in the applying workflow.
- **Diagnostics come back to the program.** A diagnostic found in the
  expanded body is reported at the slot argument whose value it is about,
  through an origin map the expansion keeps; one about the body itself is
  reported at the application, with the pattern's own path in its facts.
  `at.path` always points into the program that was checked.
- **Limits.** The expanded body counts toward the 1000 expanded nodes of a
  workflow (E0105). A map's body still counts once.
- **The result.** `check` returns the expanded program as `expanded`
  beside the program, when the program applies a pattern: the program
  with every application replaced by its expansion. It is a 0.6 program
  with no `apply` in it.

A pattern definition on its own is checked for E1301, E1302 and E1306.
Its body is type-checked only through its applications, since a slot has
no value until then.

### What a pattern may not do

| Code | When |
|---|---|
| MDT-E1301 | Malformed pattern: a slot of an unknown kind or named twice, a type parameter named twice, a slot signature that is not a signature, a body that is not a block |
| MDT-E1302 | The pattern brings authority: it declares `caps`, `budget` or an `envelope`, or its body or signature names a capability (a definition or a constructor), an agent, a connector or its tool, an effect it calls with `effect`, or a role, other than through a slot. What its body uses forms a requirement that the applying workflow's `caps` must cover (C1) |
| MDT-E1303 | The name applied is not a pattern |
| MDT-E1304 | Slots and arguments do not match: a slot without an argument, an argument for no slot, an argument of another kind, or another number of type arguments |
| MDT-E1305 | An argument does not fit its slot's signature |
| MDT-E1306 | Name collision: a slot, type parameter or run parameter named like another of them, or like a definition the pattern's module defines or imports |
| MDT-E1307 | Nested or misplaced application: anywhere but as the definition of a workflow, inside a pattern's body, as a slot argument, or with an envelope |

So a pattern cannot grant itself anything. The applying workflow's `caps`
bound everything the expansion does, and the applying program names every
agent, tool, effect, role and capability the expansion reaches (INV-21).

### Hashes, and what the runtime stores

- **The program hash** covers the `apply` node, its type arguments and its
  slot arguments, not the expansion. The expansion is a function of the
  program and the pattern's module.
- **The package hash** covers the pattern through the lock: the lock pins
  the digest of the library the pattern comes from (`std.patterns`
  included), and the lock is part of the package. A changed pattern is a
  changed library digest, so a new package (INV-02).
- **The runtime stores the expansion.** When a run of a package whose
  program applies a pattern starts, the runtime stores `expanded` in the
  artifact store, and the run's manifest names it: `expanded: <hash>`, the
  program hash of the expanded program. A resume and a replay load that
  stored expansion and run it; they do not expand again. A command's id is
  the IR path of its node in the expansion, so a compiler that expands the
  same package otherwise, after an upgrade, cannot move the ids of a run
  that is going on.
- **`expansion_mismatch`.** A stored expansion that is missing, or does
  not hash to what the manifest names, is not run. A resume stops the run
  as `attention_required` with `expansion_mismatch`; a replay reports it
  and runs nothing.

Two runs of one package started under two compilers may differ in their
expansion; each records its own.

## Libraries

A library is one or more 0.6 modules and a manifest. In the code and the
specs a *package* is the unit that runs (program and lock), so the unit
that is shared is called a library.

### The manifest

```json
{
  "library": "mandate/library/0.6",
  "name": "acme.connectors",
  "version": "2.3.0",
  "modules": ["connectors.mdt", "types.mdt"],
  "requires": { "std.patterns": "^1.0" }
}
```

`mandate.library.json` is strict JSON: a duplicate key or a field not
listed here is an error.

| Field | Meaning |
|---|---|
| `library` | The format, `mandate/library/0.6` |
| `name` | Dot-separated lower-case names, as a module's name |
| `version` | `MAJOR.MINOR.PATCH`, decimal numbers without leading zeros, no pre-release or build part |
| `modules` | The module files, relative to the manifest, `.mdt` text or JSON IR; at least one |
| `requires` | For each library its modules import, a version range ([Versions](#versions)) |

A library is malformed (E1601) when its manifest is, when a module is not
written in 0.6, when a module's name is neither the library's name nor
begins with it and a dot, when two modules have one name, and when a
module defines an `extern`: a library is data, IR and a manifest, and runs
no code, at install or after. Every module of a library checks without an
error, its imports resolved as [above](#closed-imports).

### The digest

A library's digest is computed over its manifest and the program hashes
of its modules:

```text
digest = SHA256("mandate/library/0.6\n" ‖ JCS({ name, version, requires, modules: { <module name>: <program hash> } }))
```

written `sha256:<hex>`. A module's program hash covers its `doc` lines,
so a changed doc line is a new digest. Trust is in the digest, not in a
name or a version: a version republished with other content has another
digest, and the lock refuses it. Nobody signs a library in 0.6.

### Lock 0.6

```json
{
  "lock": "mandate/lock/0.6",
  "modules": {},
  "libraries": {
    "std.patterns":    { "version": "1.0.0", "digest": "sha256:…",
                         "modules": { "std.patterns": "sha256:…" } },
    "acme.connectors": { "version": "2.3.0", "digest": "sha256:…",
                         "modules": { "acme.connectors": "sha256:…", "acme.connectors.types": "sha256:…" } }
  },
  "connectors": {
    "acme.connectors.erp":     { "credential": "acme_erp",
                                 "tools": { "list_open_orders": "sha256:…", "find_draft_invoice": "sha256:…",
                                            "post_draft_invoice": "sha256:…", "delete_draft_invoice": "sha256:…" } },
    "acme.connectors.mailbox": { "credential": "acme_mail", "header": "x-api-key", "template": "{secret}",
                                 "tools": { "list_invoices": "sha256:…" } }
  }
}
```

The compiler writes format `mandate/lock/0.6` and reads 0.2 to 0.5 as
before. A 0.6 lock has every field of a 0.5 lock, and two more, which
exist only in format 0.6: in an older lock each is E0140.

| Field | Says |
|---|---|
| `libraries.<name>.version` | The version the lock resolved |
| `libraries.<name>.digest` | The library's digest |
| `libraries.<name>.modules` | Each of its modules by name, with its program hash |
| `connectors.<module>.<connector>.credential` | The name of the credential the egress proxy puts into the connector's requests: a name, never a secret (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`) |
| `connectors.<…>.header`, `.template` | The header the credential goes in and its value with `{secret}` once, as the proxy's configuration has them; `authorization` and `Bearer {secret}` when absent |
| `connectors.<…>.tools.<tool>` | For every tool the connector declares, the digest of its schema as the server lists it ([below](#the-lock-binding-and-schema-digests)) |

- **Pins.** A module of a library is pinned by its library's entry; the
  top-level `modules` keeps pinning the modules a check is given as
  files, as before (E0142). A module pinned in both places is E1605.
  `std.patterns` is pinned like any library: a 0.6 program that imports it
  needs its entry, with the digest of the copy built into the compiler.
- **With the lock, `mandate check`** resolves each library of `libraries`
  from the [local directory](#the-local-directory) at its version and
  reports:
  - **E1605** when what it finds does not match the lock: another digest,
    a module that hashes otherwise or is missing, a module the lock does
    not list, a library the program imports that the lock does not pin,
    or a module pinned twice;
  - **E1606** when a library's `requires` is not met: a library it
    requires that the lock does not pin, or one the lock pins at a version
    outside the range;
  - **E1608** when, given the runtime's configuration (`--config`), the
    digest of a pinned library is revoked;
  - **E1407** and **E1408** for the `connectors` binding ([below](#the-lock-binding-and-schema-digests)).
- **The package.** The lock is part of the package hash, so a new version,
  a new digest, a new credential or a new schema digest is a new package,
  and a workflow with an envelope needs a new approval of it.
- **The diff.** `mandate view --against` shows a library whose pin changed
  as `mandate upgrade` shows it ([below](#mandate-add-upgrade-and-publish)).
  A credential bound to a connector, or another credential for it, and a
  tool's schema digest changed, are governance changes; a binding taken
  away is a behavior change.

### The local directory

Libraries are resolved from one local directory, which the operator
controls. Nothing is fetched from git, OCI or a registry in 0.6.

```text
<dir>/<name>/<version>/mandate.library.json
<dir>/<name>/<version>/<the module files the manifest lists>
<dir>/<name>/<version>/index.json            { "published_at": "2026-11-14T09:30:00Z" }
```

The runtime's configuration names the directory, the waiting period and
the revoked digests, and every command that resolves a library reads it
(`mandate.runtime.json`, or `--config`):

```json
"libraries": { "dir": "/srv/mandate/libraries", "wait_days": 7, "revoked": ["sha256:…"] }
```

| Field | Means |
|---|---|
| `libraries.dir` | The directory, relative to the configuration; `--libraries DIR` takes its place for one command |
| `libraries.wait_days` | Days a published version waits before `add` or `upgrade` resolves it; 0 when absent |
| `libraries.revoked` | Digests that are never resolved or loaded |

`published_at` is written by `mandate publish`, an RFC 3339 time in UTC.
It is not part of the digest: the directory is the operator's, and so is
the date. The compiler's library crates read no clock: the time a
resolution compares with is an input of the door that resolves.

### `mandate add`, `upgrade` and `publish`

```sh
mandate add     <library>[@<range>] [--lock FILE] [--libraries DIR] [--config FILE]
mandate upgrade <library>[@<range>] [--lock FILE] [--libraries DIR] [--config FILE] [--accept-governance]
mandate publish <source dir> [--libraries DIR] [--config FILE]
```

- **`add`** resolves the highest version of the library in the directory
  that is within the range (any version when none is given), whose
  waiting period is over and whose digest is not revoked. It checks the
  library (E1601, E1605, E1606), prints its version, digest and
  [authority signature](#the-authority-signature), and writes its entry
  into the lock. `mandate add std.patterns` pins the copy built into the
  compiler. A version within its waiting period, or revoked, is never
  resolved (E1608, naming the version and the day it may be).
- **`upgrade`** resolves a new version as `add` does and compares it with
  the version the lock pins: the semantic diff of each module, as
  `mandate view --against` gives it, and the change of the authority
  signature. It prints both. It writes the new entry into the lock only
  when the comparison holds no governance change, or with
  `--accept-governance`. A widened authority signature is a governance
  change, and so are the governance changes of the diff (a capability
  added, a budget raised, a criterion removed or changed, a waiver added
  or removed, an effect made irreversible, …). Patches and upgrades of 0.6
  are classified by one rule set, the semantic diff's (B13).
- **`publish`** reads the manifest in the source directory, checks the
  library (E1601), computes its digest, and copies the manifest and its
  modules into `<dir>/<name>/<version>/` with `index.json`. It refuses,
  E1607, a version already published, and a version that is not a major
  one above the highest published version below it when, against that
  version, it widens the authority signature, removes a criterion, or
  adds a waiver. A major version is one whose `MAJOR` is greater. The
  first version of a library is any version.

### The authority signature

For each `pub` workflow, pattern and connector of a library's modules, the
compiler computes an authority signature (`authority_signature`):

- **a workflow or a pattern:** the effects it needs, with the capability
  kinds and scopes that cover them; its static budget, as an upper bound
  per dimension for a workflow and as a formula in its slots for a
  pattern (`max_items ×` the budget of `work`, …); the roles it waits for;
  the highest data class a model in it may receive; its critical effects,
  and which are irreversible;
- **a connector:** its server's URL, its class, and each tool with its
  class: `read_only`, or its write class and retry class.

A signature widens when the new version of a definition needs an effect,
a kind or a scope the old one's did not cover; has a higher bound in a
dimension, a dimension it no longer bounds, or another budget formula;
waits for a role the old one did not; lets a model receive a higher
class; has a critical effect the old one did not, or makes one
irreversible. A connector's widens when it has another URL or a higher
class, a write tool it did not have, or a tool that was read-only and
writes. A `pub` workflow, pattern, connector or tool that the old version
did not have widens the signature too.

### Versions

A version range is `^MAJOR`, `^MAJOR.MINOR`, `^MAJOR.MINOR.PATCH`, or an
exact `MAJOR.MINOR.PATCH`. A caret range holds the versions from the one
it names up to, and not including, the next change of its first nonzero
component: `^1.0` is `>= 1.0.0, < 2.0.0`, `^0.3` is `>= 0.3.0, < 0.4.0`,
`^0.0.3` is `0.0.3` alone. Versions are compared by number, component by
component.

### Waiting period and revocation

- **Waiting.** A version is resolved by `add` or `upgrade` only once
  `wait_days` days have passed since its `published_at` (E1608). A version
  the lock already pins is not held to the wait again.
- **Revocation.** A digest in `libraries.revoked` is never resolved
  (E1608), and the runtime does not load a package that carries it: a
  start is refused with `library_revoked`, and a resume of a run whose
  package carries it stops the run as `attention_required` with
  `library_revoked`. A compromised version is an incident, not an upgrade.

### At load

The package carries the manifest and the modules of every library its
lock pins. At `StartRun` the runtime computes each library's digest from
what the package carries, and refuses a package where one differs from
the lock's (`library_digest_mismatch`), and one that carries a revoked
digest (`library_revoked`). It then runs the compiler's checks again, so
E1603, E1604, E1605 and E1606 refuse a package at load too
(`load_verification_failed`).

## `std.patterns`

`std.patterns` 1.0.0 is a library like any other, whose source is in
`lib/std.patterns/` (`mandate.library.json` and `patterns.mdt`). It is
built into the compiler, so a program may import it with no directory,
and the lock pins its digest. It holds three patterns. Each is documented
by what it is for, its slots, what the compiler proves at every
application, and what a person sees. The other seven patterns of the
design's catalogue are not in 0.6.

### `BatchWithExceptions`

Every item of a list is worked on and checked. What passes goes on; what
does not is asked about once, as one list, and what the person accepts
goes on too. Each item that goes on is committed as an action of its own.

```mandate
/// The result of a batch: each commit's outcome, what was declined, and the
/// indices of the items whose work failed.
pub type Batch<Out, R> = {
  posted:   List<Outcome<Receipt<R>>>,
  declined: List<Declined<Out>>,
  failed:   List<Int>
}

/// Works on every item of a list. What passes goes on; what does not is
/// asked about once, as one list.
pub pattern BatchWithExceptions<Item, Out, R>(
  source:      tool() -> Untrusted<List<Item>>,
  work:        skill(Untrusted<Item>) -> Inferred<Out>,
  accepted:    contract(Item, Out),
  reviewer:    role,
  escalate_to: role,
  commit:      effect(Verified<Out, accepted>) -> Receipt<R>,
  key:         field(Out),
  max_items:   const Int,
  concurrency: const Int,
  deadline:    const Duration
) -> Batch<Out, R>
{
  let items    = source()
  let checked  = map it in items max max_items par concurrency {
    let out = delegate work(it)
    verify out against accepted(it, out)
  }
  let reviewed = human.review(checked, role: reviewer, deadline: deadline, escalate_to: escalate_to)
  let posted   = map v in reviewed.accepted max max_items {
    effect commit(v) idempotent_by v.key
  }
  Batch { posted, declined: reviewed.declined, failed: reviewed.failed }
}
```

- **The compiler proves:** `max_items ×` the budget of one item fits the
  applying workflow's budget (E0501); the review is one wait, outside
  every map body (E1708, INV-18); each commit is idempotent by the item's
  key, and the commit map is a [batch commit step](#the-batch-commit-step)
  (E1708 in 0.6).
- **A person sees:** at most one decision, for the reviewer, about the
  items that did not pass and may be waived; after the deadline, the same
  decision for `escalate_to`; then the result.

`stage` and `report` are 0.7; the body has neither.

### `FanOutMerge`

Work on disjoint parts side by side, then merge the results. Type
parameters `<Item, Out, M>`; slots `items`, `work`, `scope` and `merge`
of the design's catalogue, with the bound and concurrency of its map.

- **The compiler proves:** the items' write scopes do not overlap (E0320,
  and `Rejected(overlapping_scopes)` at run time, N03): `scope` is a
  `capability` slot the map hands each item narrowed by it; the budget of
  every item and of the merge fits the workflow's.
- **A person sees:** nothing, unless something fails.

### `MakerChecker`

One agent makes, an isolated other looks for a counterexample. Type
parameters `<In, Out>`; slots `make`, `check`, `accepted` and `owner` of
the design's catalogue.

- **The compiler proves:** `check` is a `skill(…) read_only` slot,
  delegated `isolated`, so the checker holds no write capability; a review
  alone never meets a criterion (E0603).
- **A person sees:** only the criteria left open.

The exact slot signatures and bodies of `FanOutMerge` and `MakerChecker`
are fixed by `lib/std.patterns/patterns.mdt` when it is written (RL8), and
this section is brought to them. They hold to everything above.

## Connectors

MCP says what a tool does. It does not say reliably whether the tool
writes, whether a call may be sent again, or which data class it carries.
A connector adds that declaration, and the server's own text is never
trusted for it.

### Declaration

```mandate
mandate @ 0.6

module acme.connectors @ 2.3

use acme.connectors.types.{Invoice, Order, Match, DraftId}

/// The ERP. Reads open orders; posts draft invoices, which a person still
/// finalizes in the ERP.
pub connector erp = mcp("https://erp.acme.example/mcp")
  version "2.3"
  class   confidential
{
  tool list_open_orders(vendor_id: Text) -> Untrusted<List<Order>>
    read_only

  tool find_draft_invoice(key: Text) -> Untrusted<Option<DraftId>>
    read_only

  tool post_draft_invoice(m: Verified<Match>, key: Text) -> Receipt<DraftId>
    critical
    idempotency key key
    retry_class reconcilable
    reconcile by find_draft_invoice
    compensation delete_draft_invoice

  tool delete_draft_invoice(id: DraftId, key: Text) -> Receipt<DraftId>
    critical
    idempotency key key
    retry_class idempotent
}

pub connector mailbox = mcp("https://mail.acme.example/mcp")
  version "1.4"
  class   confidential
{
  tool list_invoices() -> Untrusted<List<Invoice>>
    read_only
}
```

- **The server.** `mcp("…")` is one absolute `https://` URL, with no user,
  password, port, query or fragment; its path is where requests go. The
  runtime speaks MCP over HTTP only ([below](#the-mcp-the-runtime-speaks)).
- **`version`** is a text the program records and the views show. Nothing
  compares it at run time: the schema digests are what is checked.
- **`class`** is the data class of everything the connector's tools
  return. A result reaching a model that may not receive that class is
  E0220, as for any value. What is sent to the connector is held to it too
  ([below](#what-is-sent-to-a-connector)).
- **Closed.** Only the tools a connector declares can be called. A tool
  the server lists and the connector does not declare does not exist for
  the program.

A connector is malformed (E1402) when its URL is not as above, when
`version` or `class` is missing or `class` is not a data class, when it
declares no tool, and when it declares a tool twice.

### Tool classes

Every tool is either `read_only` or of a write class, never both and never
neither (E1401).

- **`read_only`.** The tool changes nothing. Its result is
  `Untrusted<T>` (E1403): outside content.
- **A write class.** The tool changes shared state outside the run, so it
  is a critical effect, named `<connector>.<tool>`, and it declares:
  - `critical`;
  - `idempotency key p`: the tool's parameter, of type `Text`, in which the
    runtime sends the action's operation key, so that the server applies
    one operation once. The program does not pass it;
  - `retry_class` `idempotent`, `reconcilable` or `non_retryable`
    (`read_only` is not a write's class);
  - with `reconcilable`, and only then, `reconcile by r`: a read-only tool
    of the same connector that takes one `Text` parameter, the key, and
    returns `Untrusted<Option<T>>` where the write returns `Receipt<T>`:
    a value when the operation was applied, none when it was not;
  - optionally `compensation c`: a write tool of the same connector,
    offered to a person after a partial failure and never run on its own,
    as every compensation.

  A write tool's result is `Receipt<T>` (E1403). A write class that lacks
  `critical`, `idempotency key` or `retry_class`, whose key names no `Text`
  parameter, whose `reconcile by` is missing, given with another class, or
  names no fitting read-only tool, or whose `compensation` names no write
  tool of the connector, is E1401. A connector's tool is never
  irreversible in 0.6.

A write tool's parameter may be `Verified<T>` with one argument: a value
verified against any contract (R4 still holds, it is verified). A
connector's module cannot know the contracts of the programs that will
call it.

### `tool.call`

```mandate
use std.{tool}
use acme.connectors.{erp, mailbox}

capability Inbox    = tool.call(mailbox, list_invoices)
capability ErpRead  = tool.call(erp, list_open_orders)
capability ErpDraft = tool.call(erp, post_draft_invoice)
```

`tool.call(c, t…)` is a capability constructor (`CAP_CTORS`). Its first
argument is a connector, local or imported; then at least one tool the
connector declares, by name. A name written twice counts once. Anything
else is E1404.

- **Coverage.** A read-only tool is the effect `Tool` with the scope
  (connector, tool); a write tool is its own effect, whose requirement is
  `tool.call(c, t)`. A `tool.call` capability covers a use of tool `t` of
  connector `c` exactly when it names the same connector (the same
  definition of the same module) and lists `t`.
- **Narrowing.** One `tool.call` lies inside another when it names the
  same connector and its tools are among the other's (C2, C3). It has no
  `.narrow(…)`: a narrower one is written with fewer tools.
- **Writes.** A `tool.call` that lists a write tool is a write capability:
  two `par` branches that may call one write tool overlap (E0320, C5).
- **Agents (E1406).** An agent never holds a write tool: a `tool.call`
  naming a tool that is not read-only in an agent's `caps`, or in what a
  delegation or a map's `with caps` hands an agent, is E1406. A write tool
  is called only by a workflow's body, as a critical effect, through
  prepare → authorize → commit.
- **Where a tool is called (E1405).** A read-only tool is called as an
  expression in a workflow's body, or by an agent's loop; a write tool
  only by `effect c.t(…) idempotent_by k` in a workflow's body. A
  read-only tool called through `effect`, a write tool called as an
  expression, and a tool called in a `fn`, a contract or a skill's body
  are E1405.

### `requires caps` (B12)

Before 0.6 the checker compares only the constructor of the first
capability an effect's `requires caps` names: any `git.pr(…)` meets
`requires caps git.pr(repo)`, and a second line is not looked at. For
`tool.call` that would let `tool.call(erp, list_open_orders)` meet a
requirement of `post_draft_invoice`. In a 0.6 program every capability of
every `requires caps` is compared, each by coverage, scope included: an
effect is covered only by capabilities that cover each of its
requirements (E0301 otherwise; case E0301a). A program of 0.1 to 0.5 is
checked as before.

### Three uses

1. **A read in a workflow.** `let orders = erp.list_open_orders(v)` is a
   command at its node, recorded with its request and result like every
   nondeterministic step (INV-09). Its value is `Untrusted<T>` of the
   connector's class.
2. **Read tools in an agent's loop.** The read-only tools in a
   delegation's grant are offered to the agent's loop as tools, beside
   those of its other capabilities. They run in the control plane, not in
   the agent's sandbox: the loop calls them through the egress proxy, and
   each call is a command `<delegate>/step/<n>/tool/<k>`, charged to the
   delegation's budget, as every tool call.
3. **A write in a workflow.** `effect erp.post_draft_invoice(v)
   idempotent_by v.invoice_no` is a critical effect: prepare → authorize
   → commit. The connector's adapter calls the tool with the frozen
   parameters and the operation key in the `idempotency key` parameter. On
   a resume it follows the tool's retry class: an `idempotent` tool is sent
   again with the same key; a `reconcilable` one is first asked about with
   its `reconcile by` tool and the key, and sent again only when that tool
   answers that it was not applied; a `non_retryable` one becomes
   `unknown_outcome`.

### What reaches a model

A model sees a connector's tool only as its declared name, with its
connector's, and the JSON schema the runtime makes from its declared
parameter types, as for every tool of a loop. The result reaches the
model as data, `Untrusted<T>`, through the quoted region of its prompt
(R5), never as instructions.

Never reaches a model: the server's tool descriptions and titles, its
annotations, its instructions and server information, the text content of
a result, the text of an error, and the server's resources and prompts. A
result that is an error (`isError`) reaches the model as the call's
failure, by its code, without the server's text. In a 0.6 package the
runtime escapes `<` and `>` in the data a task hands a model, a tool's
result included (B28); a package of 0.1 to 0.5 sends the bytes it sent
before, so that a replay of a run that is going on does not change.

### What is sent to a connector

*This rule is this page's, beyond the design document: the design classes
what a connector returns, and says nothing of what is sent to it.* A
connector's `class` bounds what goes to it as a model capability's
`max_class` bounds what goes to a model. In a 0.6 program:

- **A tool's arguments.** An argument of a tool call, a read as an
  expression or a write as an `effect`, may not carry data of a class
  above its connector's `class`: sending more is E0220, at the argument,
  with the facts `data_class` and `allowed` as for a model.
- **What an agent is handed.** A delegation, or a `map` that delegates,
  hands an agent data of a class; what an agent receives can reach the
  arguments of the tools its loop calls. So what an agent receives is held
  to the `class` of every connector whose tools its grant holds, as it is
  held to its model capability's `max_class`: an agent that receives data
  of a class above one of them is E0220, at the delegation. In a
  sub-program, a class that comes from what the lead received is E1706,
  `dimension: "data_class"`, as for a model.
- **At run time** the rule is held as E0220 is held for a model today:
  the runtime runs the compiler's checks again when it loads the package,
  and refuses one that breaks it (`load_verification_failed`). The runtime
  does not track the class of a value as it runs, for a model or for a
  connector, so there is no refusal of one call by its class; 0.6 adds
  none.

The acceptance program keeps the rule: both its connectors are
`confidential`, the invoices come from the mailbox as `confidential` data,
the matcher's model may receive `confidential` data, and what the matcher
makes and the commit sends to the ERP is of that class.

### The lock binding and schema digests

Every connector a 0.6 package can call is bound in the lock under its
module and name, with a credential and a digest for every tool it
declares.

- **E1407** with the lock: a connector the package can call has no
  `connectors` entry, or its entry has no digest for one of its tools.
- **E1408** with the lock: an entry names a connector that no module of
  the package defines, or a tool the connector does not declare.
- **The digest** of a tool's schema is `sha256:<hex>` of the JCS bytes of
  `{ "name", "inputSchema", "outputSchema" }` as the server's `tools/list`
  gives that tool. Its title, description and annotations are not in it:
  they never reach a model.
- **`mandate connector pin <program> [--lock FILE] [--config FILE]`** asks
  each connector's server, through the egress proxy, for its tools, and
  writes the digest of every declared tool into the lock entry the
  connector already has. A connector without an entry is E1407; a
  declared tool the server does not list is refused,
  `tool_schema_mismatch`. It prints each digest that changed.
- **At start and at resume.** Before a `read_only` or `live` run starts,
  `StartRun` asks each connector's server for its tools and compares each
  digest with the lock's: a tool whose schema differs, or that the server
  does not list, refuses the start (`tool_schema_mismatch`, naming the
  connector and the tool), and so does a server that does not answer as
  [below](#the-mcp-the-runtime-speaks) (`connector_protocol`). Every
  resume asks again before the run goes on, and a difference stops the
  run as `attention_required` with `tool_schema_mismatch`. A `design` run
  reaches no server, and a replay reaches none.

### Egress

A connector's calls leave only through the egress proxy, in a gateway
session of the connector's own ([`egress.md`](egress.md#gateway-sessions)):
its destination is the URL's host with the method `POST` and the lock's
credential, and the runtime sends its requests to the session's base
URL, the URL's path in origin form, with the placeholder in the lock's
header and template. The proxy puts the secret in; the runtime and the
adapter hold the placeholder only (INV-23). A session is opened at a
connector's first request, as a gateway's is ([`boundary.md`](boundary.md#the-control-planes-gateways)).

- **`no_egress_for_connector`.** A package that can call a connector does
  not start on a runtime whose configuration names no egress proxy. The
  one exception is a runtime built in code with a `fetch` of its own for
  connectors, as tests build one; the CLI never builds such a runtime.
- **A refused call.** A request the proxy denied was not sent upstream.
  It is a violation, `egress_denied`, with the reason, counted as every
  violation, and the run stops for a person, as through the model
  gateway. A write tool's action is then left `unknown_outcome`, never
  `rejected`, since a request the same operation sent before may have
  reached the server.

### The MCP the runtime speaks

The runtime's MCP client (`runtime/src/mcp-client.ts`) speaks a narrow
part of MCP over HTTP, and refuses the rest by name.

- **Requests.** Each is one JSON-RPC 2.0 request, `POST`ed alone to the
  server's URL, with `content-type: application/json` and `accept:
  application/json, text/event-stream`. Each names its protocol version
  in `_meta["io.modelcontextprotocol/protocolVersion"]`, as MCP
  `2026-07-28` has it ([`mcp.md`](mcp.md#protocol)), so no session is
  opened. Only `tools/list` and `tools/call` are sent. A `tools/list`
  answer with `nextCursor` is followed; a cursor seen twice is
  `connector_protocol`.
- **Answers.** One JSON-RPC response to the request's id: a `200` with
  `application/json`, or `text/event-stream` with exactly one event that
  carries it. Anything else (another status, more events, a notification
  or a request from the server, another id, a body that is not JSON) is
  `connector_protocol`, naming what came.
- **Results.** A `tools/call` result carries `structuredContent`, which
  the runtime checks against the tool's declared result type, with the
  schema it makes from it. A result without it, one that does not fit,
  and one with `isError: true` are `tool_result_mismatch`. The text
  `content` of a result is never read.
- **What a failure is.** A read that fails, for one of these reasons or
  because the server could not be reached, fails its command with
  `Rejected(connector_protocol)` or `Rejected(tool_result_mismatch)`. A
  write whose answer is not definite is `unknown_outcome`, resolved by its
  retry class as above.

MCP resources, prompts, sampling and servers started over stdio are not
in 0.6.

### Run modes and samples

A run's mode applies to connectors as to declared reads
([`system.md`](system.md#reads-and-run-modes-b6)):

| Mode | Read tools | Write tools |
|---|---|---|
| `design` | Answered from samples, never by the server | Simulated: recorded, nothing prepared or sent |
| `read_only` | Through the server | Prepared and frozen, then recorded `would_apply` |
| `live` | Through the server | prepare → authorize → commit |

Samples come from the samples file (`adapters.samples`) by
`<module>.<connector>.<tool>`, each a result as `structuredContent` would
carry it, checked against the declared type. A design run whose read tool
has no sample fails the call with `PolicyDenied(no_samples)`, as a
declared read does.

## `human.review` and waivers

### `waive by`

```mandate
contract Matched(inv: Invoice, m: Match) {
  accept vendor "The invoice's vendor is the order's vendor"
    by static inv.vendor_id == m.order.vendor_id
  accept totals "The total is within 2% of the order's"
    by static near(inv.total_cents, m.order.total_cents, 2)
    waive by accountant, finance_lead
}
```

`waive by r1, r2` after a criterion's method names the roles that may
waive that criterion. In IR it is the criterion's `"waive": ["accountant",
"finance_lead"]`, a sorted set of role names; each is a role definition
(E1501), and a role written twice counts once.

- **Not what a person approves (E1504).** A criterion whose method is or
  includes `human.approve` cannot be waived: the person who would waive it
  is the one it asks.
- **Not toward an irreversible effect (E1505).** A `Verified<T, C>` whose
  contract `C` has a criterion with `waive by` is never an argument of an
  irreversible effect, nor what makes one allowed (E0405).
- **A governance change.** Adding a waiver, and taking one away, are
  governance changes in `mandate patch` and `mandate view --against`
  (`waiver_added`, `waiver_removed`), and a published library that adds
  one is a major version (E1607).

"An answer to an escalation is never `Verified`" still holds. A waiver is
not an answer: it is declared in the program, before any run, and
approved with its package.

### `human.review`

```mandate
let reviewed = human.review(checked, role: accountant, deadline: 1d, escalate_to: finance_lead)
```

`human.review(results, role: r, deadline: d [, escalate_to: r2])` opens
one wait for a whole list, and returns `Review<T, C>`:

```text
Review<T, C>  = { accepted: List<Verified<T, C>>, declined: List<Declined<T>>, failed: List<Int> }
Declined<T>   = { index: Int, value: Inferred<T>, unmet: List<Text>, by: Option<Text> }
```

- **The source (E1506).** `results` is a name bound by `let` to a `map`
  whose body ends with `verify x against C(…)`, with no `on unmet`. So
  `results` is a `List<Outcome<Verified<T, C>>>`, and the process that ran
  the map knows which item was verified, which failed which criteria, and
  which failed for another fault. The language gets no filter, no
  concatenation and no lambda for it. Any other argument is E1506.
- **Roles and deadline (E1507).** `role` and `deadline` are required:
  `role` names a role definition, `deadline` is a constant `Duration`
  above zero. `escalate_to`, when given, names a role definition other
  than `role`. Anything else is E1507.
- **Who may decide (E1508).** `role`, and `escalate_to` when given, are
  among the `waive by` roles of every criterion of `C` that has one, and
  `C` has at least one. A role that could waive nothing is E1508.
- **Never in a map body.** `human.review` is a `human.*` step, so a map's
  body holds none (E1708, INV-18). A batch asks once, after its map.
- **Not counted against `time`.** A review's wait is counted against no
  budget's `time`, as a `human.approve`'s `deadline` is not today: the
  static bound adds up the time of what delegations and functions reserve,
  and a wait for a person reserves nothing (`compiler/src/check/cost.ts`;
  the checker only requires a deadline to be a `Duration`). What bounds the
  wait is its own deadline, fixed when the wait opens, and with
  `escalate_to` one more: at most twice `deadline` in all. The card shows
  that bound beside the budget's `time`.
- `Review` and `Declined` are built-in type names from 0.6; an earlier
  program that names one gets E0120, as before.

### The wait and the decision

In a 0.6 run, a `verify` against a contract with a `waive by` criterion
checks every criterion that does not ask a person, even after one is
unmet, so that what an item failed is known whole. A criterion that asks
a person is asked last, as before, and only when every other one passed.

The review splits the map's outcomes by input index:

- an item whose verify passed is in `accepted` as it is;
- an item whose verify failed only on criteria that `role` may waive, every
  other criterion having passed, is **open**: it is asked about;
- an item whose verify failed on any other criterion, or on a `require`,
  is in `declined` with `by` absent, without being asked;
- an item whose outcome is another fault (`Timeout`, `SkillFailed`, …) is
  in `failed`, by its index.

When an item is open, one wait of kind `review` opens for the role, with
the deadline from when it opens. Its request lists each open item: its
index, its value as the map recorded it (a model's output, shown as
such), each unmet criterion with its name, its description and the id of
its failed evidence record, and the roles that may waive it. With no open
item no wait opens.

The decision is a signed record of kind `review`
([`envelope.md`](envelope.md#signed-decisions)): its `command` is the
review's wait, its `subject` the digest of the request as it was
recorded, its `role` the role the wait asks, and its `payload` the request
digest of `{ "waive": [indices], "decline": [indices] }`. It decides
every open item, each once, in one list or the other; one that leaves an
open item out, names one twice or in both lists, or names an item that is
not open, is refused, `incomplete_review`, and the wait stays open. It is
held to every rule of a decision, in their order: who signed, what the
record is for, the role (`invalid_decision` otherwise). A waive is whole:
it waives every unmet criterion of that item, and 0.6 has no waiver of
part of an item.

```sh
mandate review <run> --revision N --key FILE [--member NAME] --waive 2,5 --decline 7
```

The indices are the map's input indices, from 0, as `map_ended` and the
views give them. `mandate status` shows the open items with their
indices.

After the decision, a waived item is in `accepted`, a `Verified<T, C>`
whose evidence holds a waiver ([below](#waiver-evidence)); a declined one
is in `declined` with `by` the member who declined it.

### Escalation and expiry

Nothing passes on its own. When the deadline passes with no decision:

- with `escalate_to`, the same question is asked once of that role: the
  wait asks `escalate_to`, with a new deadline of the same `deadline` from
  when it was escalated (`review_escalated`). A decision for the first role
  is then refused (`invalid_decision`, `not_in_role`);
- when that deadline passes too, or with no `escalate_to` the first one,
  every open item is declined, `by` absent (`review_expired`).

### Waiver evidence

A waived criterion keeps its failed evidence record. The waiver is a
second record beside it, in the evidence format `mandate/evidence/0.1`:

- `method: "waiver"`, `passed: true`, for the same contract, criterion and
  subject as the failed record;
- `detail.waives`: the id of the failed record it waives;
- `producer`: the member, role and key of the `review` decision and its
  digest, as a `human.approve` record names its decision;
- signed by the runtime like every record.

One record is written for each waived criterion of each waived item, and
`criterion_waived` names it. "Passed" and "waived" are two methods, so an
audit sees them apart.

**The value binding (B25).** In a 0.6 run every evidence record's
`subject` also carries `value`, the request digest of the value that was
verified. A waived item's value is read from the journal: the input of
that item's `verify` step, never a value the decision carries.

### What `Verified` accepts

Before an effect uses a `Verified<T, C>` value, the runtime looks up its
evidence as before ([`runtime.md`](runtime.md#evidence-records-103)). In a
0.6 run, a criterion of `C` is also covered by a waiver record, and only
when all of these hold:

1. the criterion has `waive by`, and the decision's role is one of its
   roles;
2. the record names a stored `review` decision of this run that still
   hashes to its digest, carries a signature by a key the lock binds to
   its member and that role, decided that review's wait, and waives that
   item's index;
3. `detail.waives` names a failed record of this run for the same
   contract, criterion and subject;
4. every record the value rests on names in `subject.value` the digest of
   the value the effect is given.

Otherwise the run stops with the violation `forged_evidence` before
anything is prepared: a waiver from a role the criterion does not name, a
changed or missing decision, or a value that is not the one verified. A
run of a package of 0.1 to 0.5 has no waivers, and a waiver record in it
covers nothing.

## The batch commit step

0.4 refuses a critical effect in a `map` body (E1708): each item's effect
would be an action of its own, authorized one by one. 0.6 allows one, in
a 0.6 program, under narrow conditions, because `BatchWithExceptions`
ends with such a step. Each item's action still goes through prepare →
authorize → commit; a batch is never one effect whose partial failure an
adapter would have to carry.

A critical effect in a map body is allowed when all of these hold, and
E1708 otherwise, at the effect, with the map and the condition in its
facts:

- the effect is not irreversible;
- the workflow's envelope, when it has one, does not name the effect under
  `approve`;
- no environment tier of the program's system model asks a person for it
  (`authorize E by human(…)`);
- its `idempotent_by` key reads the map's item variable: a key that is
  the same for every item is refused;
- it is not a member of a change set;
- the map runs its items one at a time: it writes no `par` above 1;
- the map is not itself in the body of another map.

The rest of E1708 is as in 0.4: nothing in a map body waits for a person.
A program of 0.1 to 0.5 keeps E1708 exactly (cases E1708, E1708a); the
0.6 cases are E1708b (a commit step that checks) and E1708c (each refused
condition).

- **The operation key.** An item's action is named by the map, not by the
  item: `digest("operation", { tenant, run, node: <the map's node>,
  effect, key })`, where `key` is the value of `idempotent_by`. Two items
  with the same key are one action (INV-06); the same key over other
  parameters is neither that action nor a new one, and the item fails
  with `Rejected(idempotency_conflict)`. In a sub-program the rule of
  `plan` holds instead: the key names one action across the plan (N07).
- **Policy, never a person.** Every item's action is authorized by
  policy. When the runtime's policy for the effect would ask a person (an
  override given to `StartRun`, or a governance-class file of K70), the
  item is not asked about: it fails with `PolicyDenied(person_in_map)`,
  and the other items go on (R12). `StartRun` refuses a run at once,
  `person_in_map`, when its policy hands a person an effect that a map
  body commits.
- **Modes.** In a `read_only` run each item's action is `would_apply`; in
  a `design` run it is simulated.

A batch of effects that a person authorizes as one decision is not in
0.6.

## `shapes`

```mandate
envelope {
  owner   platform_lead
  caps    RepoRead, SrcWrite, Build, ModelStd, Merge
  budget  { tokens: 80000k, time: 6h, spend: 120 USD, steps: 2000, agents: 200 }
  spawn   { max_concurrent: 16, max_class: internal }
  approve git.merge by release_manager
  shapes  [FanOutMerge, MakerChecker]
}
```

`shapes [P, …]` lists the patterns a lead's sub-programs may apply. In IR
it is the envelope's `"shapes"`, a sorted set of names.

- **E1711.** Every name in `shapes` is a pattern, local or imported.
- **E1710.** When the envelope has `shapes`, a sub-program's one workflow
  is an application of a pattern the list names (`check_subprogram`). Its
  containment in the envelope (E1706) is proven over the expansion, as
  every other check. Returned to the lead, never to the run, as E1705.
  Without `shapes`, a sub-program's workflow is any workflow, as in 0.4.
- **E1709, `dimension: "shapes"`.** An amendment keeps every shape the
  envelope has, and does not add `shapes` to an envelope that had none:
  either would narrow what the lead may submit. Adding a shape, or taking
  the list away, widens it.
- **The journal and the views.** `program_submitted` and
  `program_admitted` name the pattern a sub-program applies, as `shape`,
  and the views show a plan's sub-programs by their shape.

A 0.6 version of the MigrateAll fixture names `FanOutMerge` and
`MakerChecker` (RL9).

## The bridge

In 0.6 the runtime and the `mandate` CLI call the Rust compiler for every
language version. The TypeScript compiler is frozen at 0.5 and stays in
the repository as the reference for 0.1 to 0.5; its executable is called
`mandate-ts`. The MCP server stays the TypeScript one, and calls the
compiler through the bridge too ([`mcp.md`](mcp.md#06)). Only `bridge/`
(`@mandate/bridge`) touches a compiler; the runtime imports nothing of
`@mandate/compiler`.

The compiler runs in the runtime's process as a WebAssembly module
(`wasm32-wasip1`), behind **doors**:

- **A door is a pure function from JSON to JSON.** A request names a door
  and its input, `{ "door": "<name>", "input": <JSON> }`; the answer is
  `{ "ok": true, "output": <JSON> }`, or `{ "ok": false, "error": { "kind":
  "unknown_door" | "bad_input" | "too_large", "message": "…" } }`. For a
  door that stands for a function of 0.5, the output is the object that
  function returns today. A door's answer depends on its input alone: the
  same request gives the same answer, every time.
- **The families.** Loading and checking (`load`, `check`, the module
  loader, linking, hashes, the lock checks); sub-programs and patches;
  the diffs; the sandbox requirement; the views, the card and the ACS
  target; the code tables and their explanations; the run-time authority
  doors (`grant`, `narrow`, `map_scopes`, `in_flight_overlap`), which take
  the interpreter's authority decisions so that the new coverage rule of
  `tool.call` has one implementation; and, from 0.6, the library and
  connector doors (`library_verify`, `library_add`, `library_upgrade`,
  `library_publish`, `authority_signature`, `tool_schema_digest`). A value
  such as the current time is an input of the door that needs it.
- **Nothing outside.** The module has no filesystem, no network, no clock,
  no environment and no arguments; a request for random bytes gets zeros.
  It reads its request and writes its answer, and nothing else crosses.
  The list of what it imports is fixed, and a test fails on a new one.
- **A fixed ceiling.** Its memory ceiling, 256 MiB, and its stack, 4 MiB,
  are fixed when it is linked; nothing at run time raises them. A request
  over 32 MiB is refused (`too_large`).
- **A failure is never a pass.** A trap, the memory ceiling, an answer
  that cannot be read and a missing module are each named, never taken as
  an empty or passing result. At load they refuse the package
  (`load_verification_failed`); in a lead's sub-program check they are
  `check_failed`, or `check_limit` with `{ limit: "memory", max: 256 }`
  for the ceiling, returned to the lead as before; the CLI exits with
  status 2. A sub-program's check still runs in a worker of its own that
  is stopped after its time limit ([`envelope.md`](envelope.md#limits)).

Whether a module instance serves one call or many is not part of this
contract: every rule above holds either way.

## Runtime

### Events

| Event | Data | Class |
|---|---|---|
| `review_requested` | the review's node, role, deadline, the open items by index, and the items declined without being asked | S0 |
| `review_decided` | the waived and the declined indices; member, role, key, decision digest | S0 |
| `review_escalated` | the role it was asked of, the role it is asked of now, the new deadline | S0 |
| `review_expired` | the role, and the open items it declined | S0 |
| `criterion_waived` | item index, contract, criterion, the waiver record's id, the failed record's id, the decision digest | S0 |

The review's wait is a wait like any other: `wait_opened` and
`wait_expired` are written for it as well. Its command is of kind
`review`, S0, asked of the role its `wait_opened` names. `program_submitted`
and `program_admitted` carry `shape`; the run's manifest carries
`expanded`. The class table of [`boundary.md`](boundary.md#classes) gains
these rows with their implementation.

### Refusals

| Code | When |
|---|---|
| `unsupported_language` | At load, until each part lands: a 0.6 package that uses a construct the runtime does not run yet, naming it |
| `library_digest_mismatch` | At load: a library the package carries does not hash to the lock's digest |
| `library_revoked` | At load: the package carries a revoked library digest. At a resume: the run stops as `attention_required` |
| `expansion_mismatch` | At a resume or a replay: the stored expansion is missing or does not hash to the manifest's `expanded` |
| `tool_schema_mismatch` | At a start: a tool's schema differs from the lock's digest, or the server does not list it. At a resume: the run stops as `attention_required`. Also `mandate connector pin` for a declared tool the server does not list |
| `no_egress_for_connector` | At a start: the package can call a connector and no egress proxy is configured |
| `connector_protocol` | The server's answer is not what the narrow protocol allows; at a start it refuses the start |
| `tool_result_mismatch` | A tool's result has no `structuredContent`, does not fit the declared type, or is an error |
| `egress_denied` | The proxy denied a connector's request: a violation; the run stops for a person |
| `PolicyDenied(no_samples)` | A design run's read tool has no sample |
| `PolicyDenied(person_in_map)` | An item's action in a batch commit step would need a person; at `StartRun`, `person_in_map` refuses the run |
| `Rejected(idempotency_conflict)` | Two items of a commit step with one key and other parameters |
| `incomplete_review` | A review decision that does not decide every open item exactly once |
| `invalid_decision` | A review decision that fails the rules of every decision |
| `forged_evidence` | A `Verified` value whose waiver does not hold ([above](#what-verified-accepts)) |
| `load_verification_failed` | At load: every check of the compiler, run again, E1603 to E1606 among them; a failure of the compiler itself ([The bridge](#the-bridge)) |

## Views

- **The card of a workflow without an envelope.** In a 0.6 program,
  `mandate view <program> --card` makes a card for a workflow with no
  envelope too: its `caps` and `budget` take the envelope's place. It
  answers the same five questions; for the fifth it says that no envelope
  is approved before a run, and that nobody may amend it. A program of
  0.1 to 0.5 without an envelope still has no card.
- **What a 0.6 card adds:** the pattern a workflow applies, with its
  library and version (`BatchWithExceptions (std.patterns 1.0.0)`); the
  workflow's `doc`; the most items of each map and the proof of the
  budget (`60 × 0.30 USD = 18 USD ≤ 20 USD`); each review as one decision
  of its role, at most so many items, with its deadline and the role it is
  escalated to, and that nothing passes on its own; each criterion with
  `waive by` and its roles; the tools by connector, split into those that
  read and those that write, with the connector's class; and each batch
  commit step, as an action per item, authorized by policy, idempotent by
  its key, with no person asked about one item.
- **Architecture and authority.** The architecture view names an applied
  pattern and its library's version, and draws the expansion. The
  authority view shows each `tool.call` as its connector's tools, read and
  write apart.
- **Run views.** A review shows its items by index, open, waived or
  declined, with who decided and whether the signature holds; a waived
  criterion shows its failed record and its waiver apart. A sub-program
  shows its shape.

## Invariants

| Id | Invariant | Where 0.6 keeps it |
|---|---|---|
| INV-18 | A batch produces a batch decision: there is no person's step in a `map` body | E1708, unchanged for people; `human.review`, one wait for the list; `person_in_map` at run time for a commit step |
| INV-21 | An imported definition uses no more authority than its caller grants, and runs no code when it is installed. An upgrade that widens the authority signature is a governance change | C1 to C4 over the expansion; E1302; E1601 (no `extern`); the authority signature; `upgrade` without `--accept-governance`; E1607 |
| INV-22 | A connector's tool is called only with the schema the lock pins, and only through the egress proxy. A tool that is not declared cannot be called | Closed declarations (E1404); schema digests at start and resume (`tool_schema_mismatch`); `no_egress_for_connector`; E1406 |
| INV-02 (kept) | A running run's package does not change | The lock pins every library's digest; the stored expansion keeps a run's command ids |

INV-19 and INV-20 are kept for a later release.

## Diagnostics and conformance cases

E13xx (patterns), E14xx (connectors) and E16xx (libraries) are this
release's families, and E15xx and E17xx grow. Each code gets its entry in
[`diagnostics.md`](diagnostics.md) with its implementation, and every 0.6
code has at least one conformance case: a passing program, one operation
of patch, and the one code expected.

| Code | Title | Reported by |
|---|---|---|
| MDT-E1301 | Malformed pattern | `mandate check` |
| MDT-E1302 | Pattern brings authority | `mandate check` |
| MDT-E1303 | Not a pattern | `mandate check` |
| MDT-E1304 | Slots and arguments do not match | `mandate check` |
| MDT-E1305 | Argument does not fit its slot | `mandate check` |
| MDT-E1306 | Name collision in a pattern | `mandate check` |
| MDT-E1307 | Nested or misplaced application | `mandate check` |
| MDT-E1401 | Tool without a closed class | `mandate check` |
| MDT-E1402 | Malformed connector | `mandate check` |
| MDT-E1403 | Tool result of the wrong kind | `mandate check` |
| MDT-E1404 | Malformed `tool.call` | `mandate check` |
| MDT-E1405 | Tool called where it cannot be | `mandate check` |
| MDT-E1406 | Agent holds a write tool | `mandate check` |
| MDT-E1407 | Connector not bound in the lock | `mandate check` with the lock; `mandate connector pin` |
| MDT-E1408 | Lock binds no connector of the package | `mandate check` with the lock |
| MDT-E1504 | Waiver of a criterion a person approves | `mandate check` |
| MDT-E1505 | Waivable value reaches an irreversible effect | `mandate check` |
| MDT-E1506 | Review of a list that is not a verifying map's | `mandate check` |
| MDT-E1507 | Malformed review | `mandate check` |
| MDT-E1508 | Review role cannot waive | `mandate check` |
| MDT-E1601 | Malformed library | `mandate check`, `add`, `upgrade`, `publish` |
| MDT-E1602 | Definition not public | `mandate check` |
| MDT-E1603 | 0.6 module imported by an earlier program | `mandate check`; at load, `load_verification_failed` |
| MDT-E1604 | Import not closed | `mandate check`; at load, `load_verification_failed` |
| MDT-E1605 | Library does not match the lock | `mandate check` with the lock, `add`, `upgrade`; at load, `load_verification_failed` |
| MDT-E1606 | Library requirement not met | `mandate check` with the lock, `add`, `upgrade` |
| MDT-E1607 | Publication breaks the version rule | `mandate publish` |
| MDT-E1608 | Library within its waiting period or revoked | `add`, `upgrade`; `mandate check` with the configuration |
| MDT-E1708 | Person or critical effect in a map body (0.6: the [commit step](#the-batch-commit-step)) | `mandate check` |
| MDT-E1709 | Amendment narrows the envelope (0.6: `dimension: "shapes"`) | returned to the lead |
| MDT-E1710 | Sub-program is not one of the envelope's shapes | returned to the lead |
| MDT-E1711 | Shape is not a pattern | `mandate check` |

Compile cases, `"language": "mandate/0.6"` in their `case.json`, with the
expected output written by hand. The TypeScript runner skips them and
checks how many it skipped:

| Case | Rule | Code |
|---|---|---|
| P01 | A 0.6 module with `pub` on every kind and doc lines checks; `doc` is in the hash; `fmt` keeps it | — |
| E1602, E1603, E1604 | A non-`pub` name of a 0.6 module; a 0.5 program importing a 0.6 module; a `use` of a module nobody gave | E1602, E1603, E1604 |
| E0104d | A 0.6 field in a 0.5 program | E0104 |
| P02 | An application expands and checks; a diagnostic in the expansion is reported at its slot argument | — |
| P03 | A pattern that declares `caps`, or names a capability outside a slot | E1302 |
| P04 | An expansion over 1000 nodes | E0105 |
| P05 | The program hash covers the `apply` node; `expanded` is the expansion | — |
| E1301 to E1307 | One mutation each | each code |
| T01 | `tool.call(erp, list_open_orders)` does not cover `post_draft_invoice` (B12) | E0301 (E0301a) |
| T02 | An agent holding a write tool | E1406 |
| T06 | A mutation that raises the class of a tool's argument above its connector's `class`, and one that raises the class of what an agent holding a tool receives | E0220 |
| E1401 to E1405, E1407, E1408 | One mutation each | each code |
| H06 | A review over a verifying map checks; one wait | — |
| H07 | A review role outside the `waive by` roles | E1508 |
| E1504 to E1507 | One mutation each | each code |
| E1708b, E1708c | A batch commit step checks; each refused condition | —, E1708 |
| L01 | A library whose digest differs from the lock's | E1605 |
| L02 | An upgrade that widens a workflow's and a connector's authority signature is a governance change | — (`upgrade` writes no lock) |
| L03 | A minor version that widens the signature | E1607 |
| L04 | A revoked digest, and a version within its waiting period | E1608 |
| E1601, E1606 | One mutation each | each code |
| N11 | A sub-program that is not an application of a listed shape; a shape that is not a pattern; an amendment that drops a shape | E1710, E1711, E1709 |

Runtime cases:

| Case | Rule | Code or event |
|---|---|---|
| T03 | A tool's schema changed on the server: the start is refused, and a resume stops | `tool_schema_mismatch` |
| T04 | A connector's call leaves only through the proxy; one the proxy refuses is a violation | `no_egress_for_connector`, `egress_denied` |
| T05 | The model sees only the declared name and schema; after a lost response, each draft is posted once | INV-22, INV-06 |
| H08 | Past the deadline the review goes once to `escalate_to`; past the second, every open item is declined | `review_escalated`, `review_expired` |
| H09 | A decision that leaves an open item out; a waiver from a role the criterion does not name, or with a changed decision | `incomplete_review`, `invalid_decision`, `forged_evidence` |
| — | An item's action that needs a person | `person_in_map` |
| — | A stored expansion that does not hash to the manifest | `expansion_mismatch` |
| — | A revoked library, at a start and at a resume | `library_revoked` |

## The acceptance program

`fixtures/library/invoices.mdt`, 45 lines. Its connectors and types come
from the `acme.connectors` library ([Declaration](#declaration-1), [The
0.6 surface](#pub-and-visibility)), and its pattern from `std.patterns`.
The types module also defines `pub fn near(a: Int, b: Int, pct: Int) ->
Bool`: whether `a` is within `pct` percent of `b`.

```mandate
mandate @ 0.6

module acme.finance.invoices @ 1.0

use std.{model, tool}
use std.patterns.{BatchWithExceptions}
use acme.connectors.{erp, mailbox}
use acme.connectors.types.{Invoice, Match, DraftId, near}

role accountant   "Accountant"
role finance_lead "Finance lead"

capability Inbox    = tool.call(mailbox, list_invoices)
capability ErpRead  = tool.call(erp, list_open_orders)
capability ErpDraft = tool.call(erp, post_draft_invoice)
capability ModelStd = model.infer(tier: standard, max_class: confidential)

/// An invoice is matched when the match is for it, names its vendor's order,
/// and its total is within 2% of the order's; a larger gap may be accepted.
contract Matched(inv: Invoice, m: Match) {
  accept same_invoice "The match is for this invoice"
    by static m.invoice_no == inv.invoice_no
  accept vendor "The invoice's vendor is the order's vendor"
    by static inv.vendor_id == m.order.vendor_id
  accept totals "The total is within 2% of the order's"
    by static near(inv.total_cents, m.order.total_cents, 2)
    waive by accountant, finance_lead
}

agent Matcher {
  role   "Matches one invoice to an open order of its vendor. Writes nothing."
  caps   ErpRead, ModelStd
  budget { tokens: 60k, spend: 0.30 USD, steps: 4 }
  skill match(inv: Untrusted<Invoice>) -> Inferred<Match> ! {Tool, Model}
}

/// Matches the invoices in the mailbox to open orders and posts each match to
/// the ERP as a draft. Asks the accountant once about the rest.
workflow MatchInvoices = BatchWithExceptions<Invoice, Match, DraftId>(
    source: mailbox.list_invoices, work: Matcher.match, accepted: Matched,
    reviewer: accountant, escalate_to: finance_lead,
    commit: erp.post_draft_invoice, key: invoice_no,
    max_items: 60, concurrency: 6, deadline: 1d)
  caps   Inbox, ErpRead, ErpDraft, ModelStd
  budget { spend: 20 USD, time: 2h }
```

What its card can say: at most 60 items; 60 × 0.30 USD = 18 USD ≤
20 USD; 2 hours for the work, while the review waits apart from that, at
most one day and one more after the escalation (a review is counted
against no `time`, [above](#humanreview)); at most one decision for the
accountant, about the invoices whose total is off by more than 2%, and
after a day the same decision for the finance lead; an invoice whose vendor is not the order's is declined
without asking; every accepted invoice posted as a draft, as its own
action, authorized by policy and idempotent by `invoice_no`; nobody asked
about one invoice.

The text is the plan's. The slice that implements patterns (RL7) checks
four things it assumes, and corrects the text here and in the fixture
where one does not hold: that a block's value is its last expression;
that a record literal of a generic type (`Batch { … }`) checks; that a
static criterion may call a `pub fn`; and that `Verified<T>` with one
argument is accepted in a tool's parameter.

The three acceptance criteria of 0.6:

1. **The invoice flow checks in under 50 lines, and runs end to end with
   a simulated ERP connector.** `fixtures/library/invoices.mdt` is under 50
   lines and checks clean, its outputs are in the 0.6 golden file, and
   `runtime/test/library-acceptance.test.ts` runs it over 60 invoices
   (those that pass, those off by more than 2%, those of another vendor)
   in `design`, then `read_only`, then `live`: one signed batch decision,
   the escalation after the deadline, each draft posted once after a lost
   response, the adapter seeing placeholders only, and a replay at the end
   that gives the same result.
2. **An upgrade's diff catches widened authority.** `fixtures/library/upgrade/`
   holds versions that widen a workflow's and a connector's authority.
   `mandate upgrade` shows each as a governance change and does not write
   the lock without `--accept-governance`; publishing one as a minor
   version is E1607.
3. **A mutation gives the right code for every new rule.** Every 0.6 code
   has a conformance case, and a test fails on a code without one; the
   run-time refusals (`tool_schema_mismatch`, `library_revoked`,
   `person_in_map`, a waiver that is forged or from the wrong role,
   `expansion_mismatch`) each have a test.

## Not in 0.6

- `stage`, `report`, the attention view, `asks`, `WatchRun`, `ListWaits`
  and masking by data class: 0.7.
- Fetching a library from git or OCI, a registry service, signed
  publication, an organization's policy module, and `extern` in a
  library.
- An MCP server that needs `initialize` and a session: the runtime speaks
  only the stateless revision the repository's own server calls modern
  (`2026-07-28`), so such a server is not reached in 0.6.
- MCP servers started over stdio; MCP resources, prompts and sampling;
  showing a server's tool descriptions to a model; `mandate connector
  draft`; an ACS declaration for connector tools (`mandate target acs`
  writes none).
- The seven patterns of the catalogue besides these three; a pattern
  inside a pattern; inferring type parameters.
- An effect in a batch that a person authorizes; an irreversible effect in
  a `map`.
- Waiving a criterion a person approves; a waiver that reaches an
  irreversible effect; waiving part of an item.
- `human.review` over any list but the result of a map that verifies.
- A language server, a native `mandate mcp`, and a formatter that keeps
  `//` comments.
- 0.6 in the TypeScript compiler.
