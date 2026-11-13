# The boundary with the outside world (0.5)

**Status: in progress.** The page specifies release 0.5 so that the
TypeScript implementation, and later the Rust one, are held to the same
rules and cases. Everything the release includes is implemented in the
TypeScript implementation, and the table says where each part is shown;
what it leaves out by decision is under [Not in 0.5](#not-in-05). The page
stays in progress because one criterion of the release is not met: the Rust
compiler does not yet give every fixture the same hashes and diagnostics,
and that port is planned on its own. The Rust workspace today reads and
hashes IR and verifies journals; it does not check programs.

**A note on the name.** Release 0.5 is called Boundary. In the code and in
the earlier specs, "boundary" already means *boundary evidence*: the
verifier of [`system.md`](system.md#boundary-evidence-b5)
(`runtime/src/boundary.ts`, `BoundaryVerifier`, the `boundary` key of the
runtime's configuration). That meaning stays. What 0.5 adds is named
`egress`, `host`, `journal`, `halt`, `violations` and `otel` in the code,
the configuration and the CLI.

| Part | Change | State |
|---|---|---|
| Language 0.5: `net.https(…, methods: […])`, E1801, E1804, its views and diff | PR 2 | implemented; `compiler/test/surface05.test.ts`, the cases E1801 to E1804 |
| Lock 0.5: `host`, `isolation`, `egress`; E1802, E1803; their changes in `view --against` | PR 2 | implemented; `compiler/test/surface05.test.ts`, the cases E1802 and E1803 |
| Sandbox requirement 0.2, for a 0.5 program; a 0.5 parent's sub-programs in 0.5 | PR 2 | implemented. The MXC adapter holds its `isolation` to what the host reports (`isolation.test.ts`), and its method limits and credentials to the egress proxy, refusing them by name on a host that does not reach its hosts through one (`fail-closed.test.ts`, `sandbox-egress.test.ts`) |
| At load, a lock field the runtime does not enforce is refused by its name (`unsupported_lock`) | PR 2 | implemented; no field is refused today, since `host`, `isolation` and `egress` are each enforced (`fail-closed.test.ts`) |
| The attestation a check needs is read from the program, not the record; child processes get a filtered environment (B20) | PR 1 (#34) | implemented (INV-27; [`runtime.md`](runtime.md); `verifier-process.test.ts`, `child-env.test.ts`) |
| The chained journal: event hashes, signed anchors, export, verification (J01–J16) | PR 3 | implemented ([`journal.md`](journal.md); `journal-hash.test.ts`, `journal-verify.test.ts`, `journal-cases.test.ts`, `cli-journal.test.ts`) |
| Isolation levels of hosts; host fitness (`unfit_host`) | PR 4 | implemented (`isolation.test.ts`, `fitness.test.ts`); shown on the CI runner's Bubblewrap (`mxc.test.ts`) |
| Violations and the violation limit; a hard halt | PR 5 | implemented (`violations.test.ts`, `halt.test.ts`, `cli-halt.test.ts`, `halt-revoke.test.ts`); `egress_denied` is written by sandbox egress, through the same seam (`violation-seam.test.ts`) |
| The reference egress proxy and its admin channel ([`egress.md`](egress.md)) | PR 6 | implemented; `egress-admin.test.ts`, `egress-forward.test.ts`, `egress-gateway.test.ts`, `egress-tls.test.ts`, `egress-cli.test.ts` |
| The control plane's adapters through gateways; `credential_in_environment` | PR 7 | implemented (`egress-gateways.test.ts`) |
| Sandbox egress on Linux through the proxy; `no_egress_proxy` and `egress_unavailable` for a package | PR 8 | implemented (`sandbox-egress.test.ts`); enforced where the sandbox SDK reports it and the proxy answers; shown on the CI runner's Bubblewrap |
| Sandbox egress on Windows | — | not implemented, by decision: refused by name |
| Views by role and the audit view | PR 9 | implemented (`views-role.test.ts`, `views-default.test.ts`, `classes.test.ts`, `cli-views.test.ts`) |
| The OpenTelemetry projection | PR 9 | implemented (`otel.test.ts`) |
| An independent journal verifier, `verify-journal`, in Rust | R3 | implemented (`crates/verify-journal`: every journal case, and a fresh export of a real run on CI) |
| The Rust compiler: the same hashes and diagnostics on every fixture | — | not implemented; a later plan. Until it is, release 0.5 is not closed |

A sandbox that needs outbound network runs only on a host that reaches its
hosts through the egress proxy; every other host refuses it by name, as
before 0.5. Nothing a lock or a requirement asks of a sandbox or a host is
dropped because the host cannot enforce it.

0.5 is about the runtime's border. Outbound network goes only through an
egress proxy, and the credential a request needs is put in there: a
sandbox sees a placeholder. A sandbox requirement says how strongly it
must be isolated, and the lock sets the floors. The lock pins the host's
least tool versions. The journal is hash-chained, with signed anchors and
an export a verifier checks without the runtime. Refused attempts are
counted, and a run that reaches the limit stops. An operator can halt a
tenant, hard. People see a run through a view of their role, and an
OpenTelemetry export carries what happened without any content.

## What 0.5 adds

| Addition | Where | Meaning |
|---|---|---|
| `methods` | `net.https` | The HTTP methods a capability allows of its hosts |
| `host` | lock | The least versions of the host's tools |
| `isolation` | lock | Isolation floors by data class and for an untrusted network; where a sandbox may not share its host |
| `egress` | lock | Per agent, the credential each host's requests carry, by name |
| Requirement 0.2 | sandbox | `network.methods`, `isolation`, `egress.credentials` |
| The egress proxy | runtime | The only way out of a sandbox and, with gateways, of the control plane |
| Chained events, anchors | journal | Evidence that the journal was not rewritten |
| `violation`, `halt` | runtime | Counting refused attempts; stopping a tenant |
| `--role`, `--audit` | `mandate show` | Views by role; everything with the chain's status |
| `mandate otel export` | CLI | A projection of runs to OpenTelemetry, without content |

A file names the version first: `mandate @ 0.5`. A program of 0.1 to 0.4
reads, checks, hashes and prints exactly as before, a `methods` it writes
included.

## Language 0.5

```mandate
mandate @ 0.5

capability GitHubRead = net.https(hosts: ["api.github.com"], methods: [GET])
```

`methods` is an argument of the call, so the IR has no new shape:
`{ "name": "methods", "value": { "op": "list", "items": [{ "op": "var", "name": "GET" }] } }`.

- **The methods.** `methods` is a non-empty list of bare names from `GET`,
  `HEAD`, `POST`, `PUT`, `PATCH` and `DELETE`. Anything else is E1801, at
  the item or the value that is wrong: a name the language does not know
  (`FETCH`, `get`), a name written as text (`"GET"`) or an expression, an
  empty list, a value that is not a list. A name written twice counts once.
- **Without `methods`**, a capability allows any method of its hosts.
- **Before 0.5** `methods` is parsed, kept in the IR and hashed, and means
  nothing, as it always did: the capability allows any method, and an
  unknown method is not an error. The 0.1 fixture
  `compiler/test/fixtures/syntax/capabilities.mdt` writes one.
- **Which language reads it.** A capability is read in the language of the
  program that is checked or run, a definition it imports from a module
  included. A lead's sub-program is written in its parent's language (its
  skeleton's, never below 0.4), so it reads the parent's capabilities as
  the parent does.
- **An earlier program that imports a limit.** A program of 0.1 to 0.4
  that reaches, through an import, a `net.https` capability written with
  `methods` in a module of 0.5 or later would read it without the limit.
  It is refused, E1804, at the import that brings the definition in,
  whether the program imports the capability itself or a definition that
  refers to it, such as an agent. A `methods` the program writes itself,
  or a module below 0.5 writes, is read as nothing and not looked at, as
  before. The runtime checks a package again at load, so it refuses such
  a package too (`load_verification_failed`).
- **Narrowing (C3).** A capability with methods covers another only when
  its hosts cover the other's and every method of the other is one of its
  own. One without `methods` covers every method set. One with `methods`
  never covers one without. So `with caps`, a map's `with caps`, an
  envelope's containment of a sub-program (E1706) and an amendment
  (E1709) hold methods as they hold hosts.
- **Views.** The authority view shows a host with the methods it is
  allowed: `api.github.com (GET)`. A capability shows them after its hosts:
  `GitHubRead = net.https("api.github.com", methods: [GET])`.
- **Changes.** In `mandate view --against` and `mandate patch`, a method
  added to a capability's set, or `methods` taken away, is a governance
  change (`capability_added`) and counts as authority added. A method
  taken out, or `methods` added, is a narrowing. A 0.4 program's
  `methods` is read as nothing, so a change to it shows as a capability
  changed in a way the diff cannot read.
- **At run time** a method is enforced only by the egress proxy
  ([Sandbox egress](#sandbox-egress)). On a host that does not send a
  sandbox's requests through it, a requirement that limits a host's methods
  is refused by name (`method limits on outbound hosts: …`,
  `unsupported_sandbox_profile`, E0902). It is never run with any method.

## Lock 0.5

```json
{
  "lock": "mandate/lock/0.5",
  "host": { "node": "22.23.4", "bwrap": "0.11.0" },
  "isolation": {
    "floor": { "restricted": "microvm" },
    "untrusted_network": "process",
    "co_tenancy": { "restricted": "forbidden" }
  },
  "egress": { "Fixer": { "api.github.com": "github" } }
}
```

The compiler writes format `mandate/lock/0.5` and reads 0.2 to 0.4. The
three fields are optional, closed by [`lock.schema.json`](lock.schema.json),
and exist only in format 0.5: in a 0.2 to 0.4 lock each is E0140, as
`members` is in a lock older than 0.4.

| Field | Says |
|---|---|
| `host` | The least versions of `node` and `bwrap` on the runtime's host, as `major[.minor[.patch]]`, compared by number ([host fitness](#host-fitness)). When `bwrap` is given, a setuid `bwrap` is unfit too. At least one tool |
| `isolation.floor` | Per data class, the least isolation level of a sandbox whose models may receive data of that class or a more sensitive one |
| `isolation.untrusted_network` | The least isolation level of a sandbox that reaches any host |
| `isolation.co_tenancy` | Per data class, `forbidden` when a sandbox with data of that class or a more sensitive one may not share its host with other tenants; `allowed`, or no entry, says nothing |
| `egress` | Per agent, per host, the name of the credential the egress proxy puts into that agent's requests to that host. A name, never a secret: `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |

Isolation levels, weakest first: `process`, `user_kernel`, `microvm`,
`dedicated_host`. There is **no built-in floor**, for isolation or for a
host's versions: every floor comes from the lock. A distribution may carry
a fix back without raising a version, so a floor written into the runtime
could refuse a patched host.

- **Floors are monotone.** A floor holds for the data class it names and
  for every more sensitive class, in the order `public`, `internal`,
  `confidential`, `restricted`. The floor a class has in effect is the
  highest among its own and those of the classes below it, so a lock that
  sets `confidential: user_kernel` and says nothing of `restricted` keeps
  restricted data at `user_kernel` at least. `co_tenancy: forbidden` holds
  the same way; `allowed` never lifts a lower class's `forbidden`.
- **The package.** The lock is part of the package hash. A raised floor, a
  new binding or a new least version is a new package, and a workflow
  with an envelope needs a new approval of it
  ([`envelope.md`](envelope.md#approving-an-envelope)).
- **The packaged lock** does not carry its format (`packagedLock`), so the
  runtime knows these fields by their presence.

With the lock, `mandate check` also reports:

- **E1802** when an `egress` binding names something other than a local
  agent of the program (`not_an_agent`), a remote agent (`remote`), an
  agent the lock binds to an executor such as Managed Agents
  (`executor`), or a host none of the agent's own `net.https`
  capabilities holds (`host_not_held`). The tools of an agent bound to an
  executor also run in the runtime's sandbox and reach its `net.https` hosts
  through the proxy session, but the lock cannot bind a credential to such an
  agent, so a binding naming one is refused. The path is into
  the lock: `/egress/<agent>`, or `/egress/<agent>/<host>` for a host.
- **E1803** when `isolation` or `egress` is in a lock checked with a
  program of 0.1 to 0.4. Only a 0.5 program has requirement 0.2, so the
  field would not apply, silently. `host` applies to a program of any
  version. The runtime checks E1803 again at load, so it refuses such a
  package too (`load_verification_failed`).

`mandate view --against` (with `--against-lock`) compares what the two
locks ask, after their members and roles. Floors and sharing are compared
per data class, as each class has them in effect, so a change that lowers
what any class gets is a governance change, a class the lock does not name
included:

| Change | Kind |
|---|---|
| A credential bound to an agent's requests to a host, or another credential for it | governance (counts as authority added) |
| The floor a data class has in effect, or the untrusted network's floor, lowered or taken away | governance |
| A data class whose sandboxes may share their host again, in effect (`forbidden` → `allowed`) | governance |
| A least version of a host's tool lowered or taken away | governance |
| A binding taken away, a floor or least version raised or added, sharing forbidden | behavior |

A value written another way with the same meaning (`22.23` and `22.23.0`,
a floor of `process` and none, `allowed` and no entry, a floor that a
lower class already gives) is no change.

## Sandbox requirement 0.2

A 0.5 program's agents get requirement `mandate/sandbox-requirement/0.2`.
Every other program's get `mandate/sandbox-requirement/0.1`, byte for byte
as before ([`sandbox.md`](sandbox.md#the-requirement)), whatever the lock
says. So does every requirement the runtime builds for its own verifiers.

```json
{
  "format": "mandate/sandbox-requirement/0.2",
  "subject": { "agent": "Fixer", "def": "sha256:…" },
  "filesystem": { "read": [], "write": [] },
  "exec": [],
  "network": { "hosts": ["api.github.com"], "methods": { "api.github.com": ["GET"] } },
  "models": [{ "tier": "standard", "max_class": "restricted" }],
  "ui": { "desktop": false, "clipboard": false },
  "limits": { "timeout_ms": 600000 },
  "unbounded": [],
  "isolation": { "min": "microvm", "co_tenancy": "forbidden", "data_class": "restricted", "untrusted_network": true },
  "egress": { "credentials": { "api.github.com": "github" } }
}
```

Every field of 0.1 is in its place and means what it meant. The new ones:

| Field | From |
|---|---|
| `network.methods` | Each host of `network.hosts` that only some methods are allowed for, with them, sorted. A host it does not list allows any method. Two grants of one host allow the union of their methods, and any method once one of them has no `methods` |
| `isolation.data_class` | The highest `max_class` among `models`; `public` with no model |
| `isolation.untrusted_network` | `network.hosts` is not empty |
| `isolation.min` | The higher of the floor `data_class` has in effect (the highest of the lock's `isolation.floor` for `data_class` and every less sensitive class) and, when `untrusted_network`, the lock's `isolation.untrusted_network`. With neither, `process` |
| `isolation.co_tenancy` | `forbidden` when the lock's `isolation.co_tenancy` forbids sharing for `data_class` or any less sensitive class, else `allowed` |
| `egress.credentials` | The lock's `egress` of the subject agent, for the hosts of `network.hosts`: host → credential name. Never a secret |

`mandate sandbox <file> [--lock <lock.json>]` prints it. At run time each
delegation's requirement is built the same way from what it was granted,
with the package's lock.

What the MXC adapter does with it:

- a requirement that asks nothing beyond 0.1 (`process`, sharing allowed,
  no method limits, no credentials), or whose level and sharing the host
  gives, gets the policy the 0.1 requirement gets, byte for byte
  (`MxcPolicy` has no new field);
- `isolation` is held to what the host reports, and refused by name where
  the host gives less ([below](#isolation-level-and-host-fitness));
- method limits and credentials are held to the egress proxy on a host
  that reaches its hosts through one ([Sandbox egress](#sandbox-egress)):
  the policy then lists the methods and the credential of each host that
  has them (`network.methods`, `network.credentials`, each only when it is
  not empty), and a credential the proxy does not hold is refused by name,
  `credential <name> for <host>`. On any other host they are refused by
  name, among the requirement's other refusals: `method limits on outbound
  hosts: <hosts>`, `credentials for outbound hosts: <hosts>`.

## Isolation level and host fitness

*Implemented by PR 4.*

### Levels

- **What a host reports.** A sandbox host's probe reports the level its
  sandboxes give (`Enforceable.level`, `process` when it does not say)
  and whether they may share the machine with other tenants' work
  (`Enforceable.co_tenancy`, `shared` or `exclusive`, `shared` when it
  does not say). A host reports what it gives, never more.
- **The hosts of today** (`MxcHost` with Bubblewrap, `WindowsMxcHost` with
  an AppContainer or a session, `ContainerHost`) report `process` and
  `shared`: each runs a sandbox on the host's own kernel, beside whatever
  else runs there. No new backend comes with 0.5.
- **Refusal.** For a requirement 0.2, the adapter adds to its list of what
  the host cannot enforce, after the reasons a 0.1 requirement can have
  and the method limits, and before the credentials:
  - `isolation <min> (this host gives <level>)` when the host's level is
    below `isolation.min`, in the order `process`, `user_kernel`,
    `microvm`, `dedicated_host`, or when either is a level the runtime
    does not know;
  - `co_tenancy forbidden (this host may share)` when `isolation.co_tenancy`
    is `forbidden` and the host does not report `exclusive`.

  The path is the one every unenforceable requirement takes:
  `PolicyDenied(unsupported_sandbox_profile)`, E0902, and the agent is not
  started. A weaker level is never chosen silently. A requirement 0.1 has
  no `isolation`, and is planned as before, whatever the host reports.
- **At load.** A lock's `isolation` no longer refuses a package. It applies
  only to a 0.5 program, whose requirements carry it: the runtime checks
  E1803 again at load, and refuses the package of an earlier program whose
  lock sets it (`load_verification_failed`), since the floor would not
  hold.

### Host fitness

- **What is read.** When the package's lock has `host`, the runtime reads
  each tool it names, and only those:
  - `node`: the version of the runtime's own process;
  - `bwrap`: the first executable file named `bwrap` on the runtime's
    `PATH`, the one the sandbox SDK starts. It is asked `bwrap --version`,
    with the filtered environment of every process the runtime starts
    (none of the runtime's secrets; [`runtime.md`](runtime.md)) and a 5
    second limit, and is expected to print `bubblewrap <version>`. A
    `bwrap` whose file has the setuid bit is unfit whatever its version,
    and is not started.
- **What a version is.** One to four decimal components without leading
  zeros, separated by dots. A missing component reads as 0, so `22.23` and
  `22.23.0` are the same. Versions are compared component by component as
  numbers, never as text: `0.10` is above `0.9`. A version found on the
  host may end in a suffix that starts with `-`, `+` or `~` (a
  pre-release, a build, a distribution's revision). Whether a suffix puts
  it before or after its numbers cannot be known, so it reads as just
  below them: `0.11.0-rc1`, like `0.11.0+deb1`, meets `0.10` and not
  `0.11.0`. A least version in the lock has no suffix
  ([`lock.schema.json`](lock.schema.json)).
- **Unfit.** A tool that is not found, cannot be started, gives no version
  within the limit, exits with an error, prints what is not a version that
  can be compared, or is below the lock's least version. And a setuid
  `bwrap`, once the lock names a least `bwrap`.
- **Refusal.** `unfit_host`, naming each tool that falls short, what was
  found and what the lock asks, in the order `bwrap`, `node`:

  ```
  unfit_host: This host does not meet the package's lock: bwrap: 0.9.0 found, the lock asks 0.11.0 or later, not setuid. Nothing of the package runs here (spec/boundary.md).
  ```

  A tool's part is `<tool>: <found>, the lock asks <least> or later`,
  followed by `, not setuid` for `bwrap`, and parts are joined by `; `.
  `<found>` is one of `<version> found`, `not found on the runtime's PATH`,
  `<path> is setuid`, `printed "<output>", which is not a version that can
  be compared`, `could not be started (<code>)`, `gave no version within 5
  s`, `exited with code <n> on --version`, `was stopped by <signal> on
  --version`.
- **When.** At `StartRun`, once the package is verified and before
  anything else of the run: an unfit host claims no working copy and
  writes no package, run or event. At every resume, before the lease is
  taken: an unfit host takes no lease and writes nothing, and the run stays
  as it was, for a fit host to resume. A control call that records an
  answer or a decision and then resumes the run (`SubmitInput`,
  `DecideAction`, …) keeps what it recorded; its resume is refused, and the
  run moves on when a fit host resumes it. A run that has ended is not
  checked, since resuming it runs nothing; nor is a replay.
- **No floor is built in.** Without `host` nothing is read and nothing
  changes. `host` applies to a package of any language.
- **How the tools are read** is the runtime's `hostProbe` option, so tests
  give their own and need no `bwrap`.
- **CI.** The `sandbox` job reads the runner's real `bwrap`: a lock that
  asks `bwrap` 0.1 and `node` 22 starts a run, and one that asks `bwrap`
  99.0 is refused, `unfit_host`, naming the version found.
- **Limits.** The host is read when a run starts or resumes, not while it
  runs. What is read is the `bwrap` on the runtime's `PATH`; a sandbox SDK
  configured to start another one is not covered.

## The egress proxy

*The proxy (PR 6), the control plane's gateways (PR 7) and sandbox egress
(PR 8) are implemented.*

This section states the rules. The byte-exact contract of the proxy, its
configuration and its admin channel is [`egress.md`](egress.md).

The proxy is the only way a sandbox, and with gateways the control plane's
own adapters, reach a host. It holds the secrets; nothing else does.

### Where secrets live

- Secrets live only in the proxy's configuration and its own environment.
  The **operator** starts the proxy (`mandate egress serve --config
  mandate.egress.json`); the runtime does not, since a child would inherit
  the runtime's environment.
- A sandbox sees **placeholders**, never secrets: the proxy puts the secret
  into a request on its way out.
- With a gateway on, the runtime refuses to start when it finds that
  gateway's credential in its own environment, `credential_in_environment`,
  naming the variable and never its value: `CLAUDE_API_KEY` or
  `ANTHROPIC_API_KEY` for the model gateway, `MANDATE_GITHUB_TOKEN` for the
  GitHub one. The refusal is per gateway: a gateway that is off refuses
  nothing, so with only the model gateway on, `MANDATE_GITHUB_TOKEN` is
  the GitHub adapter's as before. A variable set to the empty string holds
  nothing and is not refused; on Windows a name matches in any case, as
  Windows reads it. Through the model gateway, the SDK client is given no
  token from `ANTHROPIC_AUTH_TOKEN`, which it would otherwise read itself.
  A runtime that can read a secret makes its placeholder prove nothing.
  The verifier's process gets a placeholder and a gateway's address only.
- The proxy refuses a credential its own configuration does not bind to
  the host it is asked for: the root of the secrets is the proxy's
  configuration, not the lock and not the runtime.

### Configuration

The proxy's configuration is read strictly; an unknown field is an error.

```json
{
  "admin": "/run/mandate/egress.sock",
  "listen": "127.0.0.1",
  "credentials": {
    "github": { "env": "MANDATE_EGRESS_GITHUB", "hosts": ["api.github.com"], "header": "authorization", "template": "Bearer {secret}" }
  },
  "allow_private": false,
  "ca": "roots.pem"
}
```

| Field | Means |
|---|---|
| `admin` | The admin channel: a Unix socket path, created owner-only, or a named pipe `\\.\pipe\…` on Windows |
| `listen` | The loopback address every session listens on, a port each: `127.0.0.1` by default, or another loopback address, never a name |
| `credentials.<name>` | Where the secret is (`env`, a variable of the proxy's own environment), the only hosts it may go to, the header it goes in, and the header's value with `{secret}` in it |
| `allow_private` | `false`: a host that resolves to a private, loopback, link-local, unique-local, multicast or metadata address is refused. `true` only for tests and private upstreams |
| `ca` | Optional: a PEM file of certificate authorities to trust for upstream TLS, beside the system's |

The runtime's configuration names the proxy (`mandate.runtime.json`):
`egress { admin, gateways: { model, github } }`, read as strictly as the
rest of it.

```json
"egress": { "admin": "/run/mandate/egress.sock", "gateways": { "model": "anthropic", "github": "github" } }
```

| Field | Means |
|---|---|
| `egress.admin` | The proxy's admin channel: a Unix socket path, relative to the configuration, or a named pipe `\\.\pipe\…` |
| `egress.gateways.model` | The model gateway is on: the credential the proxy holds for `api.anthropic.com`, configured with header `x-api-key` and template `{secret}` |
| `egress.gateways.github` | The GitHub gateway is on: the credential the proxy holds for `api.github.com`, configured with header `authorization` and template `Bearer {secret}` |

A gateway's credential is a name, as the proxy's configuration names it
(`^[A-Za-z][A-Za-z0-9_-]{0,63}$`). The header and template are what the
API expects; the runtime sends exactly that with the placeholder, so a
proxy configured with another header refuses it (`placeholder_misuse`).

### The admin channel

One JSON object per line, each way, over `admin`: a request carries an
`id` and an `op`, and its answer the same `id` with `ok` and either a
`result` or an `error` with its code. Only the runtime speaks it. At most
64 requests wait on one connection; past that the connection is answered
`too_many_pending` and closed.

| Request | Answer |
|---|---|
| `hello` | `{ "format": "mandate/egress/0.1", "credentials": [<names>] }` |
| `open_session { session, tenant, run, command, kind, destinations, ttl_ms }` | `{ proxy_url \| base_url, placeholders: { <name>: "mdt-ph-<128-bit random>" } }` |
| `close_session { session }` | `{ closed: <session> }`; the port stops listening, and the session's denials go with it |
| `revoke { session \| run \| tenant \| all: true }`, exactly one | `{ revoked: [<sessions>] }`; their connections are cut at once, and later requests on them are refused (`session_revoked`). A halt revokes its tenant or all; a cancelled run, its run |
| `denials { session, after?, limit? }` | `{ denials: [{ id, host, method, why, path_digest, at }], dropped }`: those after the denial `after`, oldest first, at most `limit` (100 unless given); `path_digest` is a SHA-256 of the path, never the path |

`kind` is `forward` for a sandbox (the answer has `proxy_url`) or `gateway`
for one of the control plane's adapters (`base_url`). Each destination is
`{ host, methods | null, credential | null }`. Each session has its own
short-lived port on the loopback address, since MXC opens one local
endpoint to a sandbox: one session, one port. A placeholder is fresh per
session. A session ends after `ttl_ms` (`session_expired`) or when it is
revoked; either way its port answers denials for ten minutes more, then
closes.

### The data path

- **No TLS interception.** A destination that has a credential or a method
  limit is reached in absolute form, `http://host/…`, through the proxy,
  which replaces the placeholder and connects upstream over TLS. `CONNECT
  host:443` is allowed only for a destination with neither. The hop
  between a sandbox and the proxy is local.
- A request's host and method are among its session's destinations.
- A placeholder is replaced only in the configured header of a destination
  bound to that credential, and only when the header's value is exactly the
  template with this session's placeholder. A placeholder seen anywhere
  else in the request line or the headers (another header, the path,
  another host) is a denial. Request bodies are not scanned.
- A request whose length is ambiguous is refused, and no upstream
  connection is shared, so a request cannot be smuggled.
- `Upgrade`, HTTP/2, and a host that resolves to a private, loopback,
  link-local, unique-local, multicast or metadata address are refused. The
  address a host resolved to is pinned for the request.
- A redirect is not followed; it is returned.
- The exact bytes of the secret are scrubbed from responses.
- Only the proxy's own denials carry `x-mandate-egress-denied`: an
  upstream's is removed, so a client can tell a request that was not sent
  upstream from one the upstream answered.
- Each denial is recorded with its reason:

| Reason | When |
|---|---|
| `host_not_allowed` | The host is not a destination of the session |
| `method_not_allowed` | The method is not one the destination allows |
| `placeholder_misuse` | A placeholder outside the configured header of a destination bound to its credential, or in that header when `Connection` names it |
| `connect_not_allowed` | `CONNECT` to a destination that has a credential or a method limit, to a port other than 443, or on a gateway session |
| `resolved_private` | The host resolved to, or is, a private, loopback, link-local, unique-local, multicast or metadata address |
| `session_revoked` | The session was revoked |
| `session_expired` | The session outlived its `ttl_ms` |
| `port_not_allowed` | An `http://` URL names a port other than 80 or 443 |
| `upgrade_not_allowed` | `Upgrade`, h2c or HTTP/2 |
| `malformed_request` | A request that cannot be read in exactly one way, or is not in the form its session takes. Answered 400; the others 403 |

A closed session's port does not answer, so nothing is recorded for it.

- **Runtime refusals.** A package whose lock binds a credential needs the
  proxy: on a runtime that names none it is refused at `StartRun`,
  `no_egress_proxy`, naming each binding. With a sandbox configured, a
  package whose sandboxes reach a host, or whose lock binds a credential,
  is refused at `StartRun` when the proxy does not answer `hello`, or does
  not hold a credential the lock binds, `egress_unavailable`, naming the
  proxy and the binding. A sandbox requirement whose credential the proxy
  does not hold, or does not bind to the host, is E0902, `credential
  <name> for <host>`. For the gateways, see below.
- **Earlier programs.** With a proxy configured, an agent of a 0.1 to 0.4
  program that holds `net.https` hosts reaches them through it: hosts only,
  any method, no credential. Binding a credential needs lock 0.5.
- **Replay** never touches the proxy.

### The control plane's gateways

With a gateway on, the runtime's own adapters reach their API through a
gateway session ([`egress.md`](egress.md#gateway-sessions)): the model
gateway carries the Anthropic model adapter, the Managed Agents executor
and the verifier process's model client; the GitHub gateway carries
`git.open_pr`, `git.merge` and the boundary verifier's CI source. Such an
adapter holds no secret: it sends to the session's base URL with the
session's placeholder in the gateway's header, and its SDK client reads no
credential of its own from the environment.

- **Refusals at start.** `adaptersFor`, which every command that builds a
  runtime calls, refuses a gateway when `egress.admin` names no proxy
  (`no_egress_proxy`), and a gateway whose secret is in the runtime's
  environment (`credential_in_environment`). `StartRun`, before anything
  else that reaches out (the bindings, the executor), asks the proxy
  `hello`: a proxy that does not answer, speaks another format, or does not
  hold a gateway's credential refuses the start, `egress_unavailable`,
  naming the proxy and the credential. A resume is not checked: a proxy
  that is gone stops the run at its next request (below).
- **Sessions.** A runtime opens one session per gateway, at the gateway's
  first request, never before, so a status, a view or a replay never
  reaches the proxy. Its `run` and `tenant` are those of the run the
  runtime was built for (each CLI command is for one run), so `revoke
  { run }` and `revoke { tenant }` cut it. Its `command` is
  `gateway:<gateway>`, its destination the gateway's host with any method
  and the gateway's credential, its `ttl_ms` one hour. A session is replaced
  by a new one before a request when it has less than 15 minutes left, so a
  request in flight is not cut by its expiry; one the proxy answered
  `session_expired` is replaced and the request sent again, once, since
  nothing of a denied request went upstream. A session replaced, and every
  session a runtime opened, is closed (`close_session`) when its requests
  are done and when the runtime closes.
- **A revoked session is not replaced.** Once the proxy answers a gateway
  `session_revoked`, every later request of that gateway in that runtime is
  refused before it is sent, by name. A session port that does not take a
  connection (the proxy closed the session, or stopped) is
  `egress_unavailable`, and no other session is opened for it either, since
  the cause may be a revocation the runtime was not told of. New work after
  a cancel or a halt is refused by the journal, not by the proxy.
- **How a refusal surfaces.** A request the proxy denied (403, or 400
  `malformed_request`, with `x-mandate-egress-denied`, which the proxy
  removes from every upstream answer) was not sent upstream. A gateway's
  `fetch` takes a URL and its init, and refuses a `Request`, whose method,
  headers and body it would not carry. For the model and Managed Agents it is a violation,
  `egress_denied`, with the reason: the run stops for a person, the call is
  not handed to the program, and it is not retried as a transient error.
  For GitHub it is not a definite answer: it says this request was not
  sent and nothing of those an operation sent before it, so an action is
  left `unknown_outcome`, to be reconciled, never `rejected`; its detail
  names the reason. A proxy that is gone is `egress_unavailable` the same
  ways. The proxy's own `502` and `504` (`egress_upstream`) are an upstream
  that could not be reached, and are treated as the provider's 5xx.
- **The verifier's process** gets a gateway session of its own, opened
  when the process starts, for the same run: its environment holds that
  session's base URL (`MANDATE_EGRESS_MODEL_URL`) and placeholder
  (`MANDATE_EGRESS_MODEL_PLACEHOLDER`), the workspace id, and none of the
  model's key, address or proxy variables. It cannot open a session. The
  runtime starts it again with a new session before a check that finds it
  idle with less than 15 minutes left on its session.
- **Revocation.** A runtime with `egress` configured has
  `Adapters.revoke(scope)`, for `{ run }`, `{ tenant }` or `{ all: true }`,
  which sends `revoke` over the admin channel and rejects, naming the proxy,
  when it could not. A cancel calls it for its run once the cancel is
  recorded, wherever the run's sessions were opened; a proxy that did not
  revoke is reported to whoever cancelled, and the cancel stands. A halt
  calls it for its tenant or all; `mandate halt` has it from `egress.admin`
  alone, as "Halt" says, and `mandate cancel` from the same configuration
  as every command that builds a runtime for a run.

### Sandbox egress

*Implemented by PR 8, on Linux with MXC's Bubblewrap backend. It was first
shown by an experiment on GitHub's `ubuntu-latest` runner; CI's `sandbox`
job shows it there on every run (`runtime/test/sandbox-egress.test.ts`).*

- **Whether it can be enforced.** The MXC SDK reports
  `getPlatformSupport().bubblewrapNetwork.proxyEnforcement`. It is
  `"supported"` on a host with `slirp4netns`, `iptables` and unprivileged
  user and network namespaces, and otherwise `"unsupported"`, with the
  reason. Where it is unsupported, starting a proxied sandbox fails; it
  never falls back to the host's network.
- **What the host reports.** `MxcHost` reports that it can enforce an
  outbound host list (`network: host_allow_list`), with the names of the
  credentials the proxy holds (`Enforceable.egress`), only when the SDK
  says `supported` and the proxy answers `hello`. Both are asked at every
  probe, so before every sandbox is planned: either can change while the
  runtime runs. Where no proxy is configured, or the SDK cannot hold a
  sandbox to one, it reports `deny_all`, and a requirement with outbound
  hosts is refused by name, `an outbound host allow-list`, as before 0.5;
  `create` asks the SDK again and refuses such a policy the same way.
  Where a proxy is configured and the SDK can hold a sandbox to it, but
  the proxy does not answer, nothing about the requirement or the host is
  wrong: a requirement with an outbound host is `egress_unavailable`,
  when it is planned and when its session is opened alike, and the run
  stops for a person, to be resumed once the proxy answers. A requirement
  with no outbound host is planned and run whatever the proxy's state.
  What one sandbox's probe found decides nothing for another; the host
  keeps why for the operator only (`egressUnavailable`). A host that does
  not report `egress` enforces no method limit and puts in no credential,
  so the adapter refuses both by name there, whatever else the host
  gives.
- **Hosts.** The proxy takes a host name in lower case and without a port
  ([`egress.md`](egress.md#host-names)). A host with a character outside
  ASCII is refused by name, since one may lower-case into an ASCII name it
  is not; any other is read in lower case, and one that then is not a host
  name or an IP address is refused by name, `an outbound host that is not
  a host name the egress proxy takes: <host>`. Hosts that are one name in
  lower case are one destination: the union of their methods (any method
  once one of them allows any) and their credential; two different
  credentials for one host are refused by name.
- **A session per sandbox.** Creating a sandbox whose policy lists hosts
  opens a forward session ([`egress.md`](egress.md#forward-sessions))
  whose destinations are exactly those hosts, each with its methods, or
  `null`, and its credential, or `null`. It is opened for the run, the
  tenant and the delegation the sandbox is for (`run`, `tenant`,
  `command`; a command id longer than 256 characters is given by its
  SHA-256), so a cancel's `revoke { run }` and a halt's `revoke { tenant }`
  or `revoke { all: true }` cut it. Destroying the sandbox closes the
  session. A sandbox whose policy lists no host has no session, and what
  MXC is asked for it is what it was before 0.5.
- **The session's life.** A session is opened for six hours. Before each
  process the host replaces it with a new one, for the same destinations,
  when it has less left than the process's timeout and a minute (half its
  life, for a process without a timeout). The new session has a new port
  and new placeholders, which that process and every later one get; the
  old one is closed once nothing runs on it. A process that outlives its
  session has its later requests denied `session_expired`. A replaced
  session is a new one: a revoke that lands just before the replacement
  does not reach it, and the process is then ended by the cancel's own
  stop (or a halt's fence), not by the proxy.
- **Credentials.** The proxy's configuration is the root of the secrets. A
  binding to a credential the proxy does not hold, by its `hello`, or whose
  name is not one a lock may bind (`^[A-Za-z][A-Za-z0-9_-]{0,63}$`), is
  refused by name when the sandbox is planned, `credential <name> for
  <host>`; one it holds and does not bind to that host
  (`credential_not_allowed`) is refused the same way when the session is
  opened. Either way the agent is not started (E0902). The runtime holds
  no secret. TLS is never intercepted: a destination with a credential or
  a method limit is reached as `http://host/…`, through the proxy, which
  replaces the placeholder and goes out over TLS; `CONNECT host:443`
  reaches only a destination with neither.
- **Placeholders.** Each process of the sandbox gets, in its environment,
  the session's placeholder of each credential its destinations carry, in
  `MANDATE_EGRESS_PLACEHOLDER_<NAME>`: the credential's name in upper case,
  with `-` as `_`. Two credentials of one sandbox whose placeholders would
  share a variable are refused by name. The variables are laid over the
  backend's default environment, where the SDK sets the proxy variables;
  nothing of the runtime's own environment, and no secret, is in it.
- **One endpoint.** A proxied sandbox reaches exactly one endpoint: its
  session's proxy port. Every other loopback port, the host's own address,
  external addresses, DNS over TCP and over UDP, IPv6 and ICMP are closed,
  and the sandbox's processes have no capability to change that. So names
  are resolved by the proxy, never in the sandbox, and enforcement does
  not rest on the proxy variables a process may ignore.
- **The proxy's address.** Inside the sandbox the proxy is not at
  `127.0.0.1`: it is at the sandbox's gateway address, on the same port,
  and the SDK sets the proxy variables itself. The runtime gives the SDK
  the session's loopback address and port, as the proxy answered them
  (`network.runtimeConfig.networkProxy`), and does not assume that the
  sandbox's processes see the same address. That address is
  `http://127.0.0.1:<port>`, with nothing else in it: a session at any
  other (another scheme or address, no port, a user, a path, a query, a
  fragment, or what is not a URL) is closed and refused by name, since a
  sandbox is shown to reach its proxy there only. A session answered
  without a placeholder it was asked for is closed and is
  `egress_unavailable`: the proxy does not answer in the protocol's
  format.
- **No crossing.** Two sandboxes with two proxy ports do not reach each
  other's proxy. That separation is the sandbox's network, not the proxy:
  on the host itself any local process can connect to any session's port,
  and there only the placeholder stands between it and the credential
  ([`egress.md`](egress.md), its limits).
- **Denials are violations.** After a tool call's process ends, within its
  step, the host reads what the proxy has recorded on the session since it
  last asked (`denials`) into the process's result, `egress_denials`: the
  first 100 denials as the proxy reports them (`id`, `host`, `method`,
  `why`, `path_digest`, `at`; never a path or a header); how many more
  there were (`more`), those the proxy did not keep included; and how many
  of them all count as crossing the grant (`counted`). The host reads the
  reason of every denial it pages past, so `counted` holds each denial,
  listed or not, whose reason is not the session's end, and each the proxy
  did not keep (it keeps at most 10 000 per session), whose reason is no
  longer recorded. The result is journaled with its step. The agent loop
  then writes one violation for the step, `egress_denied`, whose detail is
  that object, before the model is told, when a listed denial or
  `counted` says one crossed the grant: one tool call is one attempt,
  however many requests it made, as a refused tool call is. The loop
  decides from the recorded result alone and asks no proxy, so a resumed
  run finds the same denials, and the step's violation is not written or
  counted again (INV-28). A denial whose reason is `session_revoked` or
  `session_expired` says that the session ended (by a cancel, a halt or
  its expiry), not that a request reached outside the grant: a tool call
  whose denials are all listed and all of these is no violation.
- **What a process's result holds.** What the proxy has recorded by the
  time the process ends is in that process's result. A denial it records
  later, of a request still in flight when the process ended, is in the
  result of the sandbox's next process, or in none if the sandbox is
  destroyed first.
- **A failed read.** When the proxy does not answer the read of a
  session's denials, the step is left unfinished and the run stops for a
  person, `egress_unavailable`; the sandbox and its session are gone. On
  resume the step's process runs again, in a new sandbox, as after a
  crash, so a request that the first process got through is sent again.
- **Earlier programs.** With a proxy configured, the `net.https` hosts of a
  0.1 to 0.4 program are reached the same way: a requirement 0.1 has no
  methods and no credentials, so each of its hosts is a destination with
  any method and none, reached through a tunnel too.
- **What is counted that the agent did not mean as crossing.** A denial is
  counted for the sandbox whose session recorded it, whatever made the
  request; these are limits, not exceptions:
  - an `https://` request to a host with a credential or a method limit is
    a `CONNECT`, which is denied (`connect_not_allowed`) and counted. The
    runtime does not tell the model how its hosts are reached: a program's
    own instructions to its agent have to say `http://` for such a host;
  - anything that connects to a session's local port, which other local
    processes on the host can (No crossing, above), has its denied
    requests counted against that sandbox;
  - a host the grant allows that resolves to a private, loopback or
    metadata address is denied (`resolved_private`) and counted.
- **What CI shows.** The `sandbox` job runs real Bubblewrap sandboxes held
  to an in-process proxy, with `curl` inside them, and the proxy's
  connections going to local servers through the resolver and dialer the
  test gives it: the SDK reports that it can hold a sandbox to its proxy,
  and the host reports an outbound host list and the proxy's credentials;
  the sandbox's environment holds the placeholder and the
  proxy variables, and neither the secret nor the runtime's environment;
  an allowed request reaches the upstream with the secret put in, and the
  echoed secret comes back as the placeholder; another host, a method not
  allowed and a tunnel to a host with a credential are denied; a request
  around the proxy reaches neither the upstream's port on the sandbox's
  loopback nor that port at the address the sandbox sees its proxy at,
  where the session's port does answer; a run's denied tool calls are
  violations in its journal; and an HTTPS tunnel to a local TLS server,
  whose certificate `openssl` makes when the test runs, succeeds, with the
  sandbox's own TLS.
- **Not shown yet:** other distributions and kernels than that runner's.
  Until a test shows a host, it is not said to support sandbox egress.
- **On Windows** sandbox egress stays refused by name: AppContainer's proxy
  is best effort, so it cannot be enforced. The Windows host is given no
  proxy, reports `deny_all`, and so refuses outbound hosts, method limits
  and credentials by name.

### What stays outside it

- The `git` CLI the runtime runs (its inherited environment and credential
  helpers), PostgreSQL connection strings, the read broker's database
  logins, and Temporal's workers.
- `mandate deploy`, which reads no runtime configuration and talks to
  Managed Agents with `CLAUDE_API_KEY` from its own environment.
- Docker traffic of the boundary verifier.
- The proxy is a reference proxy: its own surface (request smuggling, DNS
  rebinding, local ports any process on the machine can reach, an encoded
  secret in a response) is bounded by the rules above and their tests, and
  it is not offered as a production proxy.

## The chained journal

*Implemented by PR 3; checked independently by R3.*

This section states the rules. The byte-exact contract an independent
verifier is written from (the canonical form, the event hash, the anchor
statement and what is signed, the export, how an export is read, the
verification steps, the report and the exit codes) is
[`journal.md`](journal.md).

- **Event hash.** Each event of a chained run has a hash:
  `events.hash = digest("event", { run, seq, type, data, at, prev })`,
  where `digest(domain, v) = sha256("mandate/<domain>/0.1\n" ‖ canonical(v))`
  is the runtime's ([`values.ts`](../runtime/src/values.ts)), `data` is in
  its stored form (what the database gives back), and `prev` is the
  previous event's hash, `null` at `seq` 1.
- **Chained runs.** A run is chained when its first event has a hash. A
  run begun before the upgrade stays unchained, and is reported so; it is
  never chained after the fact.
- **Anchors.** At every change of a run's state, its creation included, in
  the same transaction, the runtime signs an anchor with its evidence key
  and keeps it in a table of its own (`journal_anchors`), not among the
  events: `{ "format": "mandate/journal-anchor/0.1", run, seq, hash, at }`.
- **Export.** `mandate journal export <run> [--out <file>]` writes
  `mandate/journal-export/0.1`, one snapshot of the run: `run`, `tenant`,
  `manifest_hash`, `manifest`, `package`,
  `events [{ seq, type, data, at, hash }]`, `anchors`, and `keys`, the key
  ids that signed them, which are advisory. It does not carry decision or
  evidence records. `mandate journal key [--out <file>]` writes the public
  keys the runtime trusts, which anchors are verified against; it never
  makes a key.
- **Verification.** `Runtime.verifyJournal`, `mandate journal verify` and
  `verify-journal` read an export and public keys and write
  `mandate/journal-verification/0.1`: a `status`, how far the signatures
  reach (`anchored_through`, the events after it), and the findings, each
  with a code and, where it has one, a `seq`.

| Status | Means |
|---|---|
| `verified` | The chain holds, every state event is anchored, and the signatures cover the events through `anchored_through` |
| `broken` | The export was read, and the chain or the anchors do not hold |
| `unchained` | No event has a hash and nothing is anchored: a run begun before the upgrade; nothing is said either way |
| `unreadable` | The export could not be read, or is beyond the limits every verifier holds to; nothing is said about the journal |

| Finding | When |
|---|---|
| `malformed_export` | The export is not JSON by the reading rules, or does not have its shape (`unreadable`) |
| `export_over_limit` | The export is larger than 64 MiB or nests deeper than 256 (`unreadable`) |
| `seq_gap` | The events are not numbered 1, 2, 3, … in the export's order |
| `hash_missing` | An event of a chained run has no hash |
| `chain_broken` | An event's hash is not the digest of its content and its predecessor's hash |
| `manifest_mismatch` | The manifest is not the one the first event names |
| `package_mismatch` | The package is not the one the first event names |
| `anchor_unknown_key` | An anchor is signed by a key the verifier was not given |
| `anchor_signature_invalid` | An anchor's signature does not verify |
| `anchor_beyond_end` | An anchor names an event past the last one: the tail was cut |
| `anchor_mismatch` | An anchor names a hash or a time other than its event's |
| `anchor_missing` | A state event has no anchor |
| `unanchored_tail` | Events after the last anchor that holds; reported, and the status stays `verified` |

- **Never on a read path.** The chain is checked by `verifyJournal` and the
  verifiers only, never by `events()`, replay, the run's view or a role's:
  existing tests change and delete events on purpose. The audit view calls
  `verifyJournal` as a step of its own and shows its report.
- **Limits.** The chain is evidence against someone who holds the database
  but not the key. The tail after the last anchor can be cut until the next
  state change anchors it, and newer events can be cut with their anchors.
  Someone who holds both the key and the database can rewrite the journal.
  Anchors bind the run id, not the database. The export and the
  OpenTelemetry projection, once they have left, are the outside witnesses.

## Violations and halt

*Implemented by PR 5.*

### Violations

A violation is the journal's record that an agent tried to cross what it
was granted, and the runtime refused.

- **The event.** `violation`, `{ kind, delegate, agent, step, detail,
  count }`:

  | Field | Holds |
  |---|---|
  | `kind` | `authority_denied`: a tool call the runtime refused because the grant does not give what it asks, a path outside what the agent may read or write, a command or an argument prefix it may not run, a working copy it was not given. `egress_denied`: a tool call whose process the egress proxy denied a request ([Sandbox egress](#sandbox-egress)) |
  | `delegate` | The delegation's command id |
  | `agent` | The agent's name |
  | `step` | Where it was refused: `<delegate>/step/<n>/tool/<k>` for a tool call; `<delegate>/step/<n>/plan/<i>` for step `i` of a plan submitted at turn `n` (`plan_execute`), which never runs; for an egress denial, the step of the tool call it was made in |
  | `detail` | For `authority_denied`, the tool and the reason the model is told, `"<tool>: <reason>"`; for `egress_denied`, what the proxy reported it denied the process, `{ denials, more, counted }` |
  | `count` | The run's violations with this one |

- **What is not one.** A tool call refused for its input: an argument
  missing or of the wrong type, a working copy it must name and did not,
  arguments outside the tool's schema, a tool the agent does not have. It
  is only repaired, as before. Nor is the interpreter's `PolicyDenied`
  (a sandbox the host cannot enforce, a scope outside a capability): that
  is the program's error, not the agent's attempt. A call outside the
  grant and malformed besides is `authority_denied`: the grant is checked
  first.
- **Once per step (INV-28).** It is written under the run's row lock and
  the worker's fence, only when the run has no violation at that `step`,
  and `count` is taken under the same lock. A resumed run that comes to the
  same refusal again writes and counts nothing; a replay writes nothing.
- **When.** Before the model is told, and before the refusal counts as one
  of the loop's repairs (`MAX_REPAIRS`).
- **Every language.** It is written for a package of every language
  version.
- **The limit.** `violations.limit` in the runtime's configuration, a whole
  number, at least 1. A 0.5 package's run has the limit 3 when the
  configuration names none; an earlier package's run has a limit only
  when the configuration names one. The package is the run's package at
  the time, its amended one after an amendment.
- **Reaching it.** The limit is checked only when a new violation is
  written: when its `count` is the limit or more, the run stops,
  `attention_required` with `{ "violation": "violation_limit", "message" }`.
  The delegation is left in flight, as after a crash. A resumed run comes to
  its earlier violations again without counting them, goes on, and stops
  again at its next new one.

### Halt

A halt is the operator's hard stop of a tenant, or of every tenant
(`--all`). `cancel`, the soft stop of one run, is what it was.

`mandate halt (--tenant <T> | --all) [--reason <text>] [--by <who>]`
(`Runtime.halt`) does this **in one transaction**:

1. It takes the halt lock of its scope, exclusive (see "The race" below).
2. It records the halt in `halts`: its id `halt-<uuid>`, the tenant (none
   for every tenant), the reason, who halted when `--by` says, and when.
3. For every run of the scope that has not ended (`accepted`, `running`,
   `waiting` for anything, a timer included, `cancelling`,
   `attention_required`), in run id order, it locks the run and
   - sets its cancel flag;
   - drops its lease: the fence goes up, so a worker that was driving the
     run writes nothing after this, a result in flight included (each of
     its writes checks the fence, R06);
   - writes `cancel_requested { halt, reason, by }` (`reason` and `by` when
     given) and `lease_revoked { halt, fence }`, `fence` being the one
     revoked;
   - ends the run `cancelled`, with the summary
     `{ effects_completed_before_or_during_cancel, halt }`, or
     `attention_required`, with `{ halted, open_actions }`, while an action
     is dispatched or its outcome is unknown (INV-12). Each state change is
     anchored as any other, so a halted run's journal verifies.
4. A second sweep ends any run of the scope the first did not end.

A run inside a lead's sub-program is one run: the sub-program's commands
run under the run's lease, and end with it.

**After the commit**, as a cancel does, an action whose outcome is unknown
is asked to stop (`Cancel`), and a run whose actions are all resolved by
that ends `cancelled`. The scheduler is woken for each run that ended, and
`Adapters.revoke` is called with the scope, `{ tenant }` or `{ all: true }`,
so what the runtime holds open outside itself (the egress proxy's sessions,
sandboxes) is cut. A failure of any of these undoes nothing, since the runs
have ended; it is reported (`HaltReport.revoke`, `problems`), and
`mandate halt` exits 1.

`mandate halt` revokes through the egress proxy whenever the configuration
names one (`egress.admin`, with or without `gateways`; see
[The control plane's gateways](#the-control-planes-gateways)). It sends
`revoke { tenant }` or `revoke { all: true }` once, after the commit, and
that cuts the sessions open at the proxy at that moment whose tenant it is
(or all of them), whichever process opened them, and every later request on
them is refused (`session_revoked`). A session opened after the revoke is
not cut by it: the proxy's `revoke` does not prevent new sessions, and what
stops new work in the scope is the halt itself, which the journal enforces.
Without `egress.admin` there is nothing to revoke, and the report says so.
The command holds no secret, opens no session and reads no credential from
its environment, so a credential there does not refuse it
(`credential_in_environment` is a refusal of the commands that run
adapters). It connects only for the revoke: `--lift` and `--list` never reach
the proxy, and the connection is closed when the command ends. The proxy has
10 seconds to take the connection and 10 seconds to answer; a proxy that does
neither is reported as a failed revoke (`egress_unavailable`, naming the
proxy), the halt stands, and the exit is 1.

`mandate halt` prints the halt's id, scope and reason, each run it ended
with its tenant and state (and, for one left `attention_required`, that an
action is open), the command that lifts the halt, and whether revoking was
done, failed, or had nothing to revoke. `--json` prints the report.

**In a halted scope** (a halt of the tenant, or of every tenant, that was
not lifted):

- `StartRun` is refused, `halted`, before anything is prepared, and again
  in the transaction that would create the run. No run is created.
- Every lease is refused, `halted`, for a run that has not ended: `resume`,
  a scheduler's worker, the drive after a decision. It is refused in the
  transaction that would take the lease, before the fence goes up, so
  nothing is written. A run that has ended is leased as before, and finds
  itself ended.
- A reconciliation of an action of a run the halt left
  `attention_required` records what the system of record says; once no
  action of the run is open, the run ends `cancelled`. It is not driven.
- A Temporal worker reports such a run as it is, and does not retry.

**The race between a start and a halt is closed** for this runtime. A
start takes, in the transaction that creates its run, and a lease, in the
transaction that takes it, the halt lock of every tenant and the halt lock
of the run's tenant, both shared, before any row lock, and then read the
halt in force. A halt takes the lock of its scope, exclusive, before it
records anything. So a start or a lease either committed before the halt
had its lock, and the halt's sweep, which reads after that, ends its run;
or it waits for the halt to commit, then reads the halt and is refused. On
PostgreSQL these are advisory transaction locks:
`pg_advisory_xact_lock(1835296876, 0)` for every tenant and
`pg_advisory_xact_lock(1835296884, hashtext(<tenant>))` for one (`_shared`
for a start or a lease). The second sweep is for a writer that takes no
such lock, a runtime of an earlier version during an upgrade: it ends what
that writer committed before the sweep read, and nothing the writer does
after the halt's transaction.

**Lifting.** `mandate halt --lift (--tenant <T> | --all) --by <who>`
(`Runtime.liftHalt`) is not signed. It records `lifted_by` and `lifted_at`
on every halt in force of exactly that scope: a lift of every tenant leaves
a tenant's own halt in force, and a lift of a tenant leaves a halt of every
tenant in force (the command says the tenant is still halted, and by
which). A lift where none is in force is refused, `not_halted`; one that
does not say who, `invalid_lift`. **Lifting brings no run back**: a run the
halt ended stays ended. One it left `attention_required` keeps its cancel
flag: resumed after the lift, it goes on as a cancelled run does, and no
command or action is dispatched for it again (R08).

`mandate halt --list [--json]` lists every halt, in force or lifted.

**Views.** A halt's `cancel_requested` is an operator's stop, not a
member's decision: the run's view lists no decision for it.

### Events

| Event | Data |
|---|---|
| `violation` | kind, delegate, agent, step, detail, count (above) |
| `cancel_requested` | Written by a halt with `halt`, the halt's id, and `reason` and `by` when given. Written by a cancel as before |
| `lease_revoked` | `halt`, and `fence`, the fence the halt revoked |

## Views by role and the audit view

*Implemented by PR 9 (`runtime/src/classes.ts`, `runtime/src/views.ts`).*

```sh
mandate show <run> [--format md|html|json] --role <R>
mandate show <run> [--format md|html|json] --audit
```

- `--role R` (`runView(rt, run, { role })`) shows the run as the role `R`
  may see it: the decisions asked of `R`, how the run ended and what
  stopped it, and its progress. `R` is a role the run's program names: a
  `role` definition, or a role it names anywhere a role is named (an
  envelope's owner, `human.approve(role: …)`, a component's owner, …),
  with the modules it imports. Any other is refused, `unknown_role`, with
  the roles the program names.
- `--audit` (`runView(rt, run, { audit: true })`) shows everything: the
  run's view whole, what the run was started with, each command's request
  digest and result, every event, the halts that cover the run's tenant,
  and the journal's chain as `Runtime.verifyJournal` reports it.
- The two together are refused as a usage error. Each takes `--format`,
  as `show` does.
- With neither, `mandate show` and `runView(rt, run)` print what they
  printed before, byte for byte (`views-default.test.ts` holds the digests
  of the view tests' runs in each format).

### Classes

Each event is in one class by its type, each part of a run's view by its
section, and each command by its kind, and by nothing else (INV-17): no
projection reads an event's data, a section's content or a command's result
to decide what may be shown. A type, a section or a command kind the table
does not name is S4, which no role sees.

| Class | Holds |
|---|---|
| S0 | A decision: what was asked of whom, and how it was decided |
| S1 | An outcome or an exception: how the run ended, a fault, a violation, a halt |
| S2 | Progress: steps begun and ended, budget left |
| S3 | A step's detail: its request and result |
| S4 | A trace: an agent loop's turns, tool calls and outputs |

A role's view shows S1, S2, and S0 where it was asked of that role. The
audit view shows S0 to S4. There is no masking by data class in 0.5 (INV-20
is a later release's).

**Events.** The class of every event type the runtime writes
(`EVENT_CLASSES`). A test reads every place the runtime writes an event and
fails on a type without a class, and on a class of a type nothing writes.

| Class | Event types |
|---|---|
| S0 | `wait_opened`, `wait_expired`, `decision_received`, `input_received`, `decision_refused`, `criterion_approved`, `criterion_denied`, `governance_approved`, `governance_denied`, `action_authorized`, `envelope_approved`, `amendment_requested`, `package_amended`, `limits_raised`, `reconcile_requested` |
| S1 | `run_succeeded`, `run_failed`, `run_cancelled`, `run_cancelling`, `run_attention_required`, `cancel_requested`, `lease_revoked`, `violation`, `budget_exceeded`, `guarantee_lowered` |
| S2 | `run_accepted`, `run_running`, `run_waiting`, `lease_acquired`, `command_dispatched`, `command_completed`, `command_throttled`, `charge_pending`, `charge_settled`, `map_started`, `map_ended` |
| S3 | `action_prepared`, `action_committed`, `action_confirmed`, `action_rejected`, `action_unknown_outcome`, `action_cancelled`, `action_would_apply`, `changeset_prepared`, `changeset_would_apply`, `changeset_simulated`, `changeset_committed`, `changeset_partial`, `changeset_failed` |
| S4 | `program_submitted`, `program_refused`, `program_admitted`, `sandbox_stopped` |

An event's class says which projections may draw on it. None shows an
event's data whole except the audit view: a role's view takes from an event
of its classes the fields its section names, and the OpenTelemetry
projection takes none.

**Sections.** A section is in the most restricted class of what it can
hold. The run's result, a fault with its arguments and the `attention` of a
run that needs a person can each hold a step's result, so each is S3 whole;
what a role sees of them is in a section of its own, `exceptions`.

| Section | Class | Holds |
|---|---|---|
| `format`, `kind`, `role`, `program`, `package`, `manifest`, `modules`, `as_of`; the program's architecture and authority | S2 | What names the run and the view |
| `run` | S1 | The run's id, workflow, tenant and state |
| `waiting` | S0 | The wait the run is in, whole, with its request |
| `decisions` | S0 | Each decision a person made on the run |
| `exceptions` | S1 | How the run ended and what stopped it (below) |
| `exceptions.violations.detail` | S4 | What the agent asked for that was refused |
| `budget` | S2 | The dimensions; each command's row in its step's class |
| `envelope` | S2 | Its owner, deadline and what is left |
| `envelope.amendments` | S0 | Its owner's decisions |
| `maps` | S2 | Each map's items with their outcome: `Ok` or a fault's tag |
| `result`, `error`, `attention`, `evidence`, `actions`, `changesets`, `input`, `steps` | S3 | A step's request or result, whole |
| `plans`, `trace`, `events` | S4 | What a lead wrote; an agent loop's commands; every event with its data |
| `halts`, `chain` | S1 | The audit view's own: the halts over the run's tenant; the journal's status |

**Commands.** A command of kind `session`, `turn` or `tool` is a step of an
agent loop: its trace, S4. One of kind `input`, `decision` or `amendment`
waits for a person: S0, asked of the role its `wait_opened` names. Any
other is a step: its row in the budget (id, kind, label, state, reservation
and cost) is S2, its request and result S3.

### A role's view

The sections of the run's view in S1 and S2, as they are, and of S0 what
was asked of the role:

- **What it waits for**, whole, when the wait is asked of `R`: the role
  its request names. What `R` is asked to decide on is shown to it as
  `mandate status` shows it, the subject or the question included: the
  program put that before `R`. This and the halt below (its reason and who
  halted) are the two places a role's view shows what a person wrote. A wait asked of another role, or of none, shows that the run
  waits, and nothing else. A question of a program before 0.4 names no
  role in its wait, so it is asked of no role this view can name.
- **The decisions asked of `R`**: each decision whose wait was asked of
  `R` (`wait_opened`), and each decision on no wait made in `R`'s role (the
  envelope's approval, a cancel, a raise of the limits), with its member,
  role and signature. An unsigned decision whose wait named no role is
  asked of no role. A halt's cancel is no decision.
- **Exceptions**, by the fields named and nothing else:
  - the fault the run failed with, or that left it `attention_required`:
    its tag, never its arguments;
  - while it is `attention_required`, why: of `attention`, the code of the
    invariant violation (`violation_limit` among them), the halt that left
    an action open, a reason's code and the command it is about, whether
    a change set stopped part applied, and each open action's operation,
    effect and state. Never a message;
  - each violation: its kind, delegation, agent, step and count, and its
    event's sequence number and time. Never its `detail`, which names what
    the agent asked for (a path, a command, what the proxy saw);
  - the halt that ended the run, from `cancel_requested` and
    `lease_revoked`: the halt's id, who halted, its reason, and the fence
    revoked. The operator wrote the reason; no step did.
- **Progress**: the budget's dimensions, and of its commands each one's
  step that is not an agent loop's, nor a wait asked of another role; the
  envelope's owner, deadline and what is left, with its amendments only
  for the role that owns it; each map's items and outcomes.
- Never the run's result or error whole, its evidence, its actions, its
  change sets, its plans, its input, any command's result, the trace or
  the events.
- In Markdown and HTML the document ends with the program's architecture
  and authority views (S2, made from its IR alone), as the run's own
  document does. The JSON has neither.

### The audit view

The run's view whole, kind `run_audit`, and:

- `input`: what the run was started with;
- `exceptions`, as a role's, with each violation's `detail`;
- `steps` and `trace`: each command in command-id order, by its kind: its
  label, state, request digest, and its result or error (`purged` when
  retention took them);
- `events`: every event the view reaches (`as_of`), each with its sequence
  number, type, class, time, hash and data;
- `halts`: every halt of the run's tenant or of every tenant, in force or
  lifted, oldest first;
- `chain`: `Runtime.verifyJournal`'s report (`verified`, `broken`,
  `unchained` or `unreadable`), with its findings and how far the
  signatures reach.

In Markdown and HTML the audit document opens with the chain's status and
then holds the run's sections, the input, the exceptions, the halts, the
steps, the trace, the events and the program's architecture and authority
views.

**The read path stays free of the chain check.** The audit view verifies
the chain as a step of its own, after everything it shows has been read.
`events()`, replay, the default view and a role's view never do: they read
the journal as it is, a journal tests change on purpose included.

## The OpenTelemetry projection

*Implemented (`runtime/src/otel.ts`, `runtime/test/otel.test.ts`).*

- `mandate otel export --endpoint <url> [--run <R> | --tenant <T>] [--follow] [--json]`
  runs outside every run: an export that fails does not touch one. The
  journal stays the authority. It reads the database, takes no lease and
  writes no event; the only table it writes is `otel_cursors`. With neither
  `--run` nor `--tenant` it exports every run; the two together are a usage
  error (exit 2).
- OTLP/HTTP with JSON bodies, written by hand: no new dependency. A post is
  `POST <url>/v1/traces` with `content-type: application/json`, and with
  no other header: the export sends no credential, and there is no option
  to give it one.
- **No content, ever**: no argument, result, prompt, output, file or
  decision text leaves. What leaves is identifiers, types, classes, model
  ids, counts, sequence numbers, hashes and times.
- **An allow-list (INV-17, G24).** Every span is built from the fixed set
  of fields below. Nothing is copied from an event's `data`, and the loader
  reads two members of it only: the `command` it names, and the
  `meta.locked` the model adapter reports, used only when the lock pins that
  very model id. A new event type exports its type, class, sequence number
  and hash, and nothing else, until a field is added for it here, on
  purpose.
- **The journal stays the authority; a collector is an outside witness of
  sequence numbers and hashes.** Each event's sequence number and hash leave
  promptly, once, and in order, whatever happens to the run's own span.
- **Spans.** A run is a trace of three kinds of span, and none is ever sent
  twice.
  - An **event span** for every event of the journal: of no duration (its
    start and end are the event's time), named by the event's type when the
    type is shaped like one the runtime writes (lower-case letters, digits
    and `_`, at most 48), else `mandate.event`. It is sent in the pass that
    reads the event, in sequence order. Its parent is the command span of the
    command the event's data names, when that is a command of the run, and
    the run's span otherwise. It has no status.
  - A **command span**, named `mandate.<kind>` (`infer`, `turn`, `tool`,
    `delegate`, `read`, `time` and the rest; `mandate.command` for a kind not
    shaped as above), a child of the run's span. It is
    sent once, in the pass that reads the event that ends it: the command's
    first `command_completed` event or, for a command that never completed,
    the event that ends the run. It starts at the command's first event and
    ends at its ending event, and carries no span events. A completion that
    comes after the run's end ends nothing: the span left with the run's.
  - The **run span**, named `mandate.run`, with no parent. It is sent once, in
    the pass that reads the event that ends the run, and spans from the run's
    first event to it. The events that end a run are `run_succeeded`,
    `run_failed` and `run_cancelled`, written when a run enters a state of
    `TERMINAL` in `runtime/src/journal.ts`; a run a halt ended, and a
    cancelled run, end with `run_cancelled`. `run_attention_required` and the
    waiting states are not ends: a run leaves them. The first ending event is
    the end: a finished run is not resumed, and a cancel and a halt leave one
    as it is, but were a run to end again, its span is not sent again, and
    the event of that second end is an event span.
  - After a span was sent, nothing of it is sent again. An event that comes
    after the run ended, a lease taken by resuming a finished run for one, or
    a charge settled after its command completed, is its own event span with
    its command's span, or the run's, as parent.
  - Spans are of kind internal. While a run is open, its event spans and
    the spans of its finished commands are in the collector and its own span
    is not, so their parent id is not there yet; it arrives with the event
    that ends the run, and a run that never ends never sends it.
- **Identifiers.** The trace id is the first 16 bytes of
  `sha256("mandate/otel-trace/0.1\n" ‖ run)`, a command span's id the first 8
  bytes of `sha256("mandate/otel-span/0.1\n" ‖ run ‖ "\n" ‖ command)`, an
  event span's id the first 8 bytes of
  `sha256("mandate/otel-event/0.1\n" ‖ run ‖ "\n" ‖ seq)`, with `seq` in
  decimal, all as lower-case hex. The run span is the span of the empty
  command, so its id is the first 8 bytes of
  `sha256("mandate/otel-span/0.1\n" ‖ run ‖ "\n")`; no command has an empty
  id. An export run twice gives the same ids, and the same bodies.
- **Attributes.** GenAI: `gen_ai.operation.name` of a command span, `chat`
  for `infer` and `turn`, `execute_tool` for `tool` and `invoke_agent` for
  `delegate`, and none for the other kinds; and `gen_ai.request.model` of
  an `infer` or a `turn`, the model the lock maps the call's tier to. A
  call's tier is not in the journal. The model is the one the adapter
  reported for the call when the lock pins it, else the model of the one
  tier the program names, and absent when the program names several and
  the adapter reported none, or the lock pins none. Mandate's own, under
  `mandate.*`:

  | Span | Attribute | Value |
  |---|---|---|
  | every span | `mandate.run`, `mandate.tenant` | The run and its tenant |
  | every span | `mandate.package` | The hash of the package: the run's, or for a command and its events the one the command was first recorded under |
  | event, command | `mandate.command` | The command's id, when it is shaped like one the runtime builds (letters, digits and `_ . : / @ # > [ ] -`, at most 200); otherwise `sha256:` and 16 hex digits of its hash. An event span has it when the event names a command of the run |
  | command | `mandate.command.kind` | The command's kind, when it is lower-case letters and `_`, at most 32; otherwise `other` |
  | command, run | `mandate.span.events` | An integer: the events of the command, or of the run, up to the span's end |
  | event | `mandate.event.type`, `mandate.event.class` | The event's type, and its class (S0 to S4) assigned from the type alone |
  | event | `mandate.event.seq`, `mandate.event.hash` | The event's sequence number, an integer, and its hash, when it has one |

  A command span has a status of OK or ERROR when it ended with its own
  `command_completed` event and its row says `succeeded` or `failed`, and none
  when it ended with the run. The run span has OK for `run_succeeded`, ERROR
  for `run_failed`, and none for `run_cancelled`: a stopped run did not fail
  and did not succeed. Times are unix nanoseconds as decimal strings,
  integers are decimal strings, ids are lower-case hex. The resource is
  `service.name` `mandate`; the scope is `mandate.otel` `0.1`. The semantic
  conventions' schema URL is pinned, on the resource and on the scope:
  `https://opentelemetry.io/schemas/1.37.0`.
- **Resuming.** A cursor per endpoint and run (`otel_cursors`: the
  endpoint, the run, the last sequence number exported and when) records
  what was exported, so an export resumes where it stopped. An export
  sends the events after the cursor, and a second one when nothing has been
  written sends nothing. The endpoint is the key as the command normalises
  it: no trailing slash.
- **Batches.** The events after the cursor go in windows, each of at most
  500 spans: its events, and the command and run spans that end with them,
  at least one event. A body is a function of the journal and of its window,
  the events after one sequence number up to another: their event spans,
  and the command and run spans whose ending event is among them. A window
  is one post, unless one event ends more spans than a post holds (the end
  of a run with many commands open), and then it is several. The cursor
  moves, in its own statement, after the collector has accepted the whole
  window, and never back. An export is therefore at least once: a crash
  between a post and the cursor, or a window of several posts that failed
  after the first, sends identical bodies again.
- **Failure.** A post that is not answered 2xx, a connection that fails, a
  redirect (which is never followed, so the spans go where the operator said)
  and a collector that does not answer within 10 seconds are
  `otel_export_failed`: the command says so on stderr, naming the status or
  the cause and never what was sent, and exits 1. The cursor stays where the
  last accepted post left it; no run is touched. A 2xx that reports rejected
  spans (`partialSuccess`) is accepted, and the count is reported: sending the
  same spans again would be rejected the same way.
- **The endpoint** is an `http://` or `https://` URL with a host. It has no
  user or password, query or fragment, and does not end in `/v1/traces`,
  which is added to it: each of these is a usage error (exit 2). `http` is
  allowed, for a collector on a trusted network; what it carries is no
  content.
- **`--follow`** exports what there is, waits two seconds, and exports what
  was written since, until SIGINT or SIGTERM, which stop it cleanly
  (a post in flight is abandoned, its cursor not moved). A failed pass is
  reported on stderr and tried again at the next; it exits 1 only when it was
  stopped while the collector was failing, 0 otherwise. Runs of `--tenant`,
  or of every tenant, begun after it started are exported too.
- **The classes** are those of the role views: the export takes an event's
  class from `eventClass` (`runtime/src/classes.ts`), by its type alone, and a
  type the table does not name is S4.

## Invariants

| Id | Invariant | Where 0.5 keeps it |
|---|---|---|
| INV-11 (refined) | An unsupported security requirement is never dropped silently: a method limit, an isolation floor, a credential binding or a least host version is enforced, or nothing it applies to starts | `unsupported_lock` at load; the adapter's refusals (E0902); `unfit_host`; E1803, also at load |
| INV-17 | A projection (a role view, an OpenTelemetry export) is derived from event type, view section and command kind, never from content | The class table (`runtime/src/classes.ts`); the export's attributes |
| INV-23 | A secret never enters a sandbox, nor the runtime's environment when gateways are on; what enters is its placeholder | The proxy's configuration; `credential_in_environment` |
| INV-24 | A sandbox reaches no host and uses no method its grant does not list | The proxy's data path; requirement 0.2; the denial reasons |
| INV-25 | Every event of a chained run is covered by the chain, and every state change of it by a signed anchor | `events.hash`; `journal_anchors`; the verifier |
| INV-26 | A halted scope starts and resumes nothing, and no result in flight at the halt is written | `halts`; the halt lock a start and a lease take; the fence; `halted` |
| INV-27 | Whether a check needs an attestation is read from the program and the configuration, never from the record being checked | B20 |
| INV-28 | A violation is counted once: a replay or a resume never counts it again | One `violation` event per step |
| INV-29 | A floor, a least version and a credential binding come from the lock alone, inside the package hash: changing one is a new package | Lock 0.5; no built-in floor |

INV-18 to INV-22 are kept for later releases.

## Diagnostics and conformance cases

E18xx is this release's family ([`diagnostics.md`](diagnostics.md)):

| Code | Title | Reported by |
|---|---|---|
| MDT-E1801 | Unknown method | `mandate check` |
| MDT-E1802 | Credential bound outside the sandbox | `mandate check` with the lock |
| MDT-E1803 | Lock field does not apply to the program's language | `mandate check` with the lock |
| MDT-E1804 | Imported method limit read without it | `mandate check`; at load, `load_verification_failed` |

Refusals of the runtime that 0.5 adds:

| Code | When |
|---|---|
| `unsupported_lock` | At load: the lock sets a field the runtime does not enforce yet, named; none today |
| `unsupported_sandbox_profile` (E0902) | A requirement 0.2 asks for what the host cannot give: method limits or credentials on a host that does not reach its hosts through the egress proxy, an isolation level above the host's, no sharing on a host that may share; or a credential the proxy does not hold or does not bind to the host (`credential <name> for <host>`), a host that is not a host name, two credentials of one host or of one placeholder variable, a session not at `http://127.0.0.1:<port>` |
| `unfit_host` | At a start or a resume, before the lease: a tool the lock names is missing, cannot be read, or is below the lock's least version, or the `bwrap` is setuid |
| `credential_in_environment` | With a gateway on, its credential is in the runtime's environment |
| `no_egress_proxy`, `egress_unavailable` | A package or a gateway needs the proxy and none is named, or it does not answer or lacks a credential; a sandbox that needs a host is planned while a configured proxy does not answer, or its session cannot be opened, renewed or asked what it denied, or lacks a placeholder |
| `egress_denied` | Through the model gateway, the proxy refused the runtime's own request; the run stops for a person, the reason named. From a sandbox, the kind of the violation a denied tool call is |
| `violation_limit` | The run reached its violation limit; it is `attention_required` |
| `halted` | A start, or the lease of a run that has not ended, in a halted scope |
| `not_halted` | A lift of a scope where no halt is in force |
| `invalid_lift` | A lift that does not say who lifts it |
| `unknown_role` | `mandate show --role R`, or `runView` for a role, where `R` is no role the run's program names |
| `invalid_run_id`, `invalid_tenant` | A start with a run id that is empty, is not well-formed Unicode or holds U+0000, or a tenant that is not well-formed Unicode or holds U+0000, since the chain hashes what the database stores ([`journal.md`](journal.md#the-event-hash)); a halt or a lift of an empty tenant or one such |
| `no_evidence_key` | `mandate journal key` where the runtime has signed nothing yet: it reads the evidence key and never makes one |
| `invalid_endpoint` | `mandate otel export` with an endpoint that is not an `http://` or `https://` URL, or has a user, a password, a query, a fragment or the path `/v1/traces`; a usage error, exit 2 |
| `otel_export_failed` | A post of the export was not answered 2xx, could not be made or was not answered within 10 seconds; the cursor stays where it was; exit 1 |
| `bad_egress_config`, `egress_secret_missing`, `egress_secret_invalid`, `egress_admin_unavailable` | `mandate egress serve` does not start ([`egress.md`](egress.md#running-the-proxy)); exit 1 |

Compile cases in [`conformance/`](../conformance/README.md):

| Case | Rule |
|---|---|
| E1801, E1801a, E1801b | An unknown method, one written as text, an empty list |
| E1801c, E1801d | A 0.5 program with `methods`, and without |
| E1801e | A 0.4 program with an unknown method checks |
| E0701 | A capability with methods does not cover one without them |
| E1802, E1802a, E1802b, E1802c | A host the agent does not hold; a binding to a workflow, to a remote agent, to an agent bound to Managed Agents |
| E1802d | The 0.5 fixture checks with its lock |
| E1803 | `isolation` and `egress` with a 0.4 program |
| E1804, E1804a | A 0.4 program that imports a 0.5 capability with `methods`; the same program in 0.5 checks |

Runtime cases continue from G14:

| Case | Rule | Code or event |
|---|---|---|
| G15 | An agent that may GET a host gets its GET through; its POST there, and any request to another host, are denied and counted | `method_not_allowed`, `host_not_allowed`, `violation` |
| G16 | A sandbox's environment and requests hold the placeholder, never the secret; a placeholder outside its header is denied | INV-23, `placeholder_misuse` |
| G17 | A host that resolves to a private or metadata address is refused; a redirect is not followed | `resolved_private` |
| G18 | With gateways on, a runtime with a credential in its environment does not start, and the verifier's process has none | `credential_in_environment` |
| G19 | A host below the lock's least versions, or with a setuid `bwrap`, is refused before the lease | `unfit_host` |
| G20 | A requirement whose isolation level or no-sharing the host cannot give is refused | E0902 |
| G21 | The violation limit stops the run; a resumed run does not count a violation twice | `violation_limit`, INV-28 |
| G22 | A halt ends every open run in scope in one transaction; a result in flight is not written; a start or resume is refused; a lift brings no run back | `halted`, INV-26 |
| G23 | A role view shows only its classes; `show` without options is unchanged | INV-17 |
| G24 | The OpenTelemetry export carries no content | INV-17 |
| G25 | Evidence whose required attestation is missing or was rewritten is invalid, whatever its record says | INV-27 |

Journal cases, `kind: "journal"`, are made from real runs by a script and
shared with `verify-journal`:

| Case | Rule | Problem |
|---|---|---|
| J01 | A closed chained run verifies, also over fractions, exponents, escapes and keys whose UTF-16 and code point orders differ | — (`verified`) |
| J02 | An event changed after it was written | `chain_broken` at its `seq` |
| J03 | An event deleted | `seq_gap`, `chain_broken` |
| J04 | The tail cut while its anchors stay | `anchor_beyond_end`, `unanchored_tail` |
| J05 | An open run with events after its last anchor | `unanchored_tail` (`verified`) |
| J06 | An anchor whose signature does not verify, one signed by another key | `anchor_signature_invalid`, `anchor_unknown_key` |
| J07 | A manifest and a package other than the run's | `manifest_mismatch`, `package_mismatch` |
| J08 | A run begun before the upgrade | — (`unchained`) |
| J09 | The same values spelled otherwise | — (`verified`) |
| J10 | An event without its hash | `hash_missing`, `chain_broken` |
| J11 | An anchor that names another hash | `anchor_mismatch` |
| J12 | A state event without its anchor | `anchor_missing` |
| J13 | Events moved in the export | `seq_gap`, `chain_broken` |
| J14 | Two events with one seq; the anchor names the first | `seq_gap`, `chain_broken` |
| J15 | An export that is not one | `malformed_export` (`unreadable`) |
| J16 | A run whose data nests deeper than a verifier reads | `export_over_limit` (`unreadable`) |

The letters P, T and L are kept for later releases.

## Not in 0.5

- **The Rust compiler.** Release 0.5 is not closed until the Rust compiler
  gives every fixture the same hashes and diagnostics; that port is
  planned on its own. The Rust workspace has no `.mdt` parser, no schema
  validation and no checks yet.
- **New isolation backends.** 0.5 adds the level and the refusal, not a
  host that gives more than `process`.
- **Sandbox egress on Windows**, TLS interception, and `git`, PostgreSQL
  and Docker traffic through the proxy.
- **A reader for `net.https.get`.**
- **Decision and evidence records in the export**, and anchoring to a
  tenant-wide or outside log.
- **Masking by data class** in views; `WatchRun`, `ListWaits`, `stage`,
  `report` and notifications (0.7).
- **What stays open.** MXC's proxy enforcement, a tunnel through it
  included, is shown on CI's Ubuntu runner and nowhere else yet; a host is
  said to support sandbox egress only where a test shows it. The race
  between a start and a halt is closed by the halt lock for runtimes that
  take it; a writer that does not, a runtime of an earlier version, is
  caught only by the halt's second sweep, and only for what it wrote
  before the sweep. Someone who holds the
  runtime's key and its database can rewrite the journal. Linux sandbox
  tests, PostgreSQL, Node 22 and 24, and Rust run on CI.
