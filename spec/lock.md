# The lock file

A program names what it needs in general terms: a model *tier*, an imported
*module*. The lock file, `mandate.lock.json` next to the program, pins what
those names mean for one deployment. It is closed by
[`lock.schema.json`](lock.schema.json) and read as strictly as the IR:

- an unknown field is an error;
- a fractional number is an error;
- a locked model without a tariff is an error.

All of these are reported as `MDT-E0140`.

```json
{
  "lock": "mandate/lock/0.5",
  "modules": { "company.domain": "sha256:0f1e" },
  "models": {
    "standard": { "provider": "anthropic", "model": "claude-opus-5-5", "effort": "high",
                  "max_input_tokens": 128000, "max_output_tokens": 12000 }
  },
  "tariffs": {
    "claude-opus-5-5": { "currency": "USD", "as_of": "2026-10-09",
      "micros_per_mtok": { "input": 4000000, "output": 20000000, "cache_read": 200000, "cache_write": 5000000 } }
  }
}
```

| Field | Pins |
|---|---|
| `modules` | The version of every imported module other than `std` (S09) |
| `models` | For each tier: the model id and the effort sent with every call, and the input and output token limits of one call |
| `tariffs` | Each locked model's prices per million tokens, in integer micro-units of one currency, with the day they were read |
| `bindings` | What the program's agents were deployed as on an executor (`managed-agents`), written by `mandate deploy`; see [`executors.md`](executors.md). Needs format `0.3` or later |
| `members` | Each person who signs decisions, with the ids of their keys (`sha256:<hex>` of an ed25519 public key). Needs format `0.4` |
| `roles` | For each role the program names, the members bound to it; see [`envelope.md`](envelope.md#the-lock-members-and-roles). Needs format `0.4` |
| `host` | The least versions of the runtime's host's tools, `node` and `bwrap`; see [below](#host-isolation-and-egress-05). Needs format `0.5` |
| `isolation` | Isolation floors by data class and for an untrusted network, and the data classes whose sandboxes may not share their host. Needs format `0.5` |
| `egress` | Per agent, the credential each host's requests carry, by name. Needs format `0.5` |
| `libraries` | 0.6: each library's version, digest and modules; see [below](#libraries-and-connectors-06). Needs format `0.6` |
| `connectors` | 0.6: each connector's credential, the URL it goes to and the digest of each tool's schema. Needs format `0.6` |
| `role_classes` | 0.7, not implemented yet: each role's highest data class; see [below](#role-classes-and-promotion-07). Needs format `0.7` |
| `promotion` | 0.7, not implemented yet: `"required"`, the promotion ladder. Needs format `0.7` |

The format is `mandate/lock/0.5` below 0.6, and `mandate/lock/0.6` for a program of 0.6. A `0.4` lock, which has no host,
isolation or egress, a `0.3` lock, which has no members or roles either,
and a `0.2` lock, which has no bindings either, are still read. Format
`0.6` is specified in [`library.md`](library.md#lock-06) and implemented: the
Rust compiler writes and reads it, and the TypeScript compiler does not.

## Members and roles

```json
{
  "lock": "mandate/lock/0.4",
  "modules": {},
  "members": {
    "alice": { "keys": ["sha256:3f1c…"] },
    "bob":   { "keys": ["sha256:9a07…", "sha256:51d2…"] }
  },
  "roles": {
    "code_owner":      ["alice"],
    "release_manager": ["bob"]
  }
}
```

- A member holds at least one key, and may hold several, so a lost key can
  be replaced.
- One key belongs to one member: a key listed under two members is an
  error.
- A role lists at least one member, and only members in `members`.

These are reported as `MDT-E0140` too.

## Host, isolation and egress (0.5)

```json
{
  "lock": "mandate/lock/0.5",
  "modules": {},
  "host": { "node": "22.23.4", "bwrap": "0.11.0" },
  "isolation": {
    "floor": { "restricted": "microvm" },
    "untrusted_network": "process",
    "co_tenancy": { "restricted": "forbidden" }
  },
  "egress": { "Fixer": { "api.github.com": "github" } }
}
```

- `host` names `node`, `bwrap` or both, each `major[.minor[.patch]]`,
  decimal numbers without leading zeros. The runtime compares the
  versions it finds on the host with them by number, a missing component
  reading as 0; how it reads a found version, and its suffix, is in
  [`boundary.md`](boundary.md#host-fitness).
- A floor is one of `process`, `user_kernel`, `microvm`, `dedicated_host`,
  for a data class (`floor`) or for a sandbox that reaches any host
  (`untrusted_network`). `co_tenancy` is `allowed` or `forbidden`.
- A floor, and `co_tenancy: forbidden`, hold for the class they name and
  every more sensitive one.
- An `egress` binding names an agent, a host and a credential: a name the
  egress proxy's own configuration binds to that host, never a secret.
- No floor and no least version is built in: all of them come from here.

Each is closed, and in a lock older than `0.5` each is `MDT-E0140`. What
they mean is in [`boundary.md`](boundary.md#lock-05).

## Libraries and connectors (0.6)

*Specified in [`library.md`](library.md#lock-06); implemented.*

Format `mandate/lock/0.6` has every field of `0.5` and two more, closed by
its own schema, `lock-0.6.schema.json`. In a lock older than `0.6` each of
them is `MDT-E0140`, reported at the lock's root.

```json
{
  "lock": "mandate/lock/0.6",
  "modules": {},
  "libraries": {
    "acme.connectors": { "version": "2.3.0", "digest": "sha256:…",
                         "modules": { "acme.connectors": "sha256:…", "acme.connectors.types": "sha256:…" } }
  },
  "connectors": {
    "acme.connectors.erp": { "credential": "acme_erp", "url": "https://erp.acme.example/mcp", "tools": { "list_open_orders": "sha256:…" } }
  }
}
```

- `libraries` pins each library a 0.6 program imports, `std.patterns`
  included: the version resolved, its digest, and each of its modules by
  program hash. A library module is pinned there, not under `modules`.
- `connectors` binds each connector a 0.6 package can call, under
  `<module>.<connector>`: the name of the credential the egress proxy
  puts into its requests, the `url` it goes to (required, and the URL the
  connector declares, `MDT-E1407`), the header and template (both or
  neither; `authorization` and `Bearer {secret}` when absent), and the
  schema digest of every tool it declares (the member is required, and may
  be empty). `mandate connector pin` writes the digests.
- With the lock, `mandate check` adds `MDT-E1605`, `MDT-E1606`,
  `MDT-E1608` (with the configuration), `MDT-E1407` and `MDT-E1408`. The
  runtime refuses a package whose carried library does not hash to its
  pin (`library_digest_mismatch`) or is revoked (`library_revoked`), and a
  run whose server lists another schema than a pinned digest
  (`tool_schema_mismatch`).

## Role classes and promotion (0.7)

*Added 2026-11-17. Specified in [`attention.md`](attention.md#lock-07);
0.7, not implemented yet. Everything above holds as it is.*

Format `mandate/lock/0.7` has every field of `0.6` and two more, closed by
its own schema, `lock-0.7.schema.json`. In a lock older than `0.7` each of
them is `MDT-E0140`, reported at the lock's root. `roles` and `members` do
not change.

```json
{
  "lock": "mandate/lock/0.7",
  "modules": {},
  "role_classes": { "accountant": "confidential" },
  "promotion": "required"
}
```

- `role_classes` gives a role the highest data class it may be shown; a role
  it does not name may be shown `internal`. A role that `roles` does not
  name is `MDT-E0140`. With the lock, `mandate check` adds `MDT-E1909`: a
  question, an escalation or a report that would show a role data above its
  class. The runtime masks such data as well.
- `promotion: "required"` (its one value) makes a `read_only` or `live` run
  wait for a signed promotion by the workflow's owner role, and makes
  `MDT-E1910` require an `owner` or an envelope of every workflow.
- A lock is read by the schema of its own format, whatever the program's
  language. A 0.7 program accepts an older lock: every role may then be
  shown `internal`, and there is no ladder. For a program older than 0.7 the
  two fields would not apply, and the check refuses them (`MDT-E1911`), as
  `MDT-E1803` refuses `isolation` and `egress` for a program before 0.5.
- Both are in the package hash, as every field is: raising a role's class is
  a new package. Where notifications go is not in the lock, but in the
  runtime's configuration ([`attention.md`](attention.md#notifications)).

## What reads it

- **The package.** The lock is part of the package hash:
  `SHA256("mandate/package/0.1\n" ‖ JCS({program: <program hash>, lock}))`. A changed
  price or model is a new package, and so is a raised floor or a new
  credential binding, which a workflow's envelope then needs approved
  again. A running run keeps the package it started with (INV-02).
- **The compiler.** `mandate check` reads `--lock <file>`, or else
  `mandate.lock.json` next to the program. With a lock it adds these checks:
  - `MDT-E0141`: every model tier the program names is locked.
  - `MDT-E1502`: every role a 0.4 program names has a member under `roles`
    ([`envelope.md`](envelope.md)).
  - `MDT-W0504`: every agent loop's declared budget covers its upper bound.
  - `MDT-E0903`–`MDT-E0905`: an executor binding still fits the program
    and the lock ([`executors.md`](executors.md)).
  - `MDT-E1802`: every `egress` binding names a local agent that no executor
    runs, and a host that agent's own `net.https` capabilities hold.
  - `MDT-E1803`: `isolation` and `egress` are only in a lock checked with a
    0.5 program.
- **The runtime.** It refuses to load a package whose lock pins models but is
  malformed (`malformed_lock`) or leaves a named tier unlocked
  (`unlocked_model_tier`). It holds every sandbox of a 0.5 program to the
  lock's `isolation`, refusing an agent whose host gives less (E0902), and
  checks E1803 again at load. It puts the credentials `egress` binds into
  an agent's requests only through the egress proxy: a package whose lock
  binds one does not start on a runtime that names no proxy
  (`no_egress_proxy`), and an agent whose binding the proxy does not hold
  is not started (E0902; [`boundary.md`](boundary.md#sandbox-egress)). It
  starts or resumes a run whose lock sets `host` only on a host that
  meets it (`unfit_host`). Its model adapter sends each tier's model and
  effort, and prices every call from the tariff. A lock without `models` is
  for simulated models: the Anthropic adapter refuses to run without one.

## The upper bound of a call

A call's upper bound uses the locked limits, priced as if nothing hits the
cache:

```text
tokens = max_input_tokens + max_output_tokens
spend  = ⌈ (max_input_tokens × max(input, cache_write) + max_output_tokens × output) / 10⁶ ⌉
```

`cache_write` is the higher input price: a prompt that is written to the
cache costs more than one that is not. An agent loop of `steps` calls is
bounded by `steps ×` that. `MDT-W0504` warns when an agent's declared
`tokens` or `spend` is below it, because the skill may then run out of
budget before it can finish (design doc 4 §8.6).

At run time a call reserves less than this static bound:

- its input token count, measured before the call (not the input limit);
- plus the output limit.

Both are priced the same way. It is settled at its real cost:

| Dimension | Settled at |
|---|---|
| `tokens` | Input + cache reads + cache writes + output: every token the model processed |
| `spend` | Each kind of token at its own price, cache discount included |

A call whose counted input exceeds `max_input_tokens` is not sent; the
skill fails with `SkillFailed(context_exhausted)`.
