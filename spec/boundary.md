# The boundary with the outside world (0.5)

**Status: in progress.** The page specifies release 0.5 so that the
TypeScript implementation, and later the Rust one, are held to the same
rules and cases. Its compile-time surface is implemented, and of the
runtime the chained journal, the isolation levels of hosts, host fitness,
and the reference egress proxy, which nothing in the runtime uses yet; what
the runtime does not enforce yet, it refuses by name. Each part that is
not implemented lands with the change named in the table, which refines
its section here.

**A note on the name.** Release 0.5 is called Boundary. In the code and in
the earlier specs, "boundary" already means *boundary evidence*: the
verifier of [`system.md`](system.md#boundary-evidence-b5)
(`runtime/src/boundary.ts`, `BoundaryVerifier`, the `boundary` key of the
runtime's configuration). That meaning stays. What 0.5 adds is named
`egress`, `host`, `journal`, `halt`, `violations` and `otel` in the code,
the configuration and the CLI.

| Part | Change | State |
|---|---|---|
| Language 0.5: `net.https(…, methods: […])`, E1801, E1804, its views and diff | PR 2 | implemented |
| Lock 0.5: `host`, `isolation`, `egress`; E1802, E1803; their changes in `view --against` | PR 2 | implemented |
| Sandbox requirement 0.2, for a 0.5 program; a 0.5 parent's sub-programs in 0.5 | PR 2 | implemented. The MXC adapter holds its `isolation` to what the host reports (PR 4), and refuses method limits and credentials, which no host enforces yet, by name |
| At load, a lock that sets `egress` is refused by its name (`unsupported_lock`) | PR 2 | implemented; `host` and `isolation`, refused the same way before, were lifted by PR 4, which enforces them; `egress` is lifted by the change that enforces it |
| The attestation a check needs is read from the program, not the record; child processes get a filtered environment (B20) | PR 1 (#34) | implemented (INV-27; [`runtime.md`](runtime.md)) |
| The chained journal: event hashes, signed anchors, export, verification (J01–J16) | PR 3 | implemented ([`journal.md`](journal.md)) |
| Isolation levels of hosts; host fitness (`unfit_host`) | PR 4 | implemented; shown on the CI runner's Bubblewrap |
| Violations and the violation limit; a hard halt | PR 5 | specified |
| The reference egress proxy and its admin channel ([`egress.md`](egress.md)) | PR 6 | implemented; nothing in the runtime uses it until PR 7 and PR 8 |
| The control plane's adapters through gateways; `credential_in_environment` | PR 7 | specified |
| Sandbox egress on Linux through the proxy | PR 8 | specified; enforceable where the sandbox SDK reports it, shown on the CI runner |
| Sandbox egress on Windows | — | refused by name |
| Views by role and the audit view; the OpenTelemetry projection | PR 9 | specified |
| An independent journal verifier, `verify-journal`, in Rust | R3 | implemented (`crates/verify-journal`: every journal case, and a fresh export of a real run on CI) |

Until a part lands, nothing it would enforce runs. A 0.5 package whose lock
asks nothing of it runs as far as today's hosts allow: a sandbox that needs
outbound network is still refused by the hosts, as before 0.5.

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
- **At run time** a method is enforced only by the egress proxy. Until a
  host sends a sandbox's requests through it, a requirement that limits a
  host's methods is refused by name (`method limits on outbound hosts: …`,
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
  capabilities holds (`host_not_held`). Only an agent that runs in the
  runtime's sandbox reaches a host through the proxy. The path is into
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
- method limits and credentials, which no host enforces yet, are refused
  by name, among the requirement's other refusals: `method limits on
  outbound hosts: <hosts>`, `credentials for outbound hosts: <hosts>`.

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
  s`, `exited with code <n> on --version`.
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

*The proxy is implemented (PR 6); the control plane's gateways are
specified for PR 7, sandbox egress for PR 8.*

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
- With gateways on, the runtime refuses to start when it finds a credential
  in its own environment, `credential_in_environment`
  (`CLAUDE_API_KEY`, `ANTHROPIC_API_KEY`, `MANDATE_GITHUB_TOKEN`). A
  runtime that can read a secret makes its placeholder prove nothing. The
  verifier's process gets placeholders and the gateway's address only.
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
`egress { admin, gateways: { model, github } }`.

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

- **Runtime refusals.** A package that needs the proxy on a runtime that
  names none is refused, `no_egress_proxy`; a proxy that does not answer
  `hello`, or does not hold a credential the package binds, is
  `egress_unavailable`. A sandbox requirement whose credential the proxy
  does not know is E0902, `credential <name> for <host>`.
- **Earlier programs.** With a proxy configured, an agent of a 0.1 to 0.4
  program that holds `net.https` hosts reaches them through it: hosts only,
  any method, no credential. Binding a credential needs lock 0.5.
- **Replay** never touches the proxy.

### Sandbox egress

What PR 8 is held to. It was shown by an experiment on GitHub's
`ubuntu-latest` runner, with MXC's Bubblewrap backend.

- **Whether it can be enforced.** The MXC SDK reports
  `getPlatformSupport().bubblewrapNetwork.proxyEnforcement`. It is
  `"supported"` on a host with `slirp4netns`, `iptables` and unprivileged
  user and network namespaces, and otherwise `"unsupported"`, with the
  reason. Where it is unsupported, starting a proxied sandbox fails; it
  never falls back to the host's network.
- **What the host reports.** `MxcHost` reports that it can enforce an
  outbound host list (`network: host_allow_list`) only when the SDK says
  `supported` and the proxy answers `hello`. Otherwise a requirement with
  outbound hosts is refused by name, as before 0.5.
- **One endpoint.** A proxied sandbox reaches exactly one endpoint: its
  session's proxy port. Every other loopback port, the host's own address,
  external addresses, DNS over TCP and over UDP, IPv6 and ICMP are closed,
  and the sandbox's processes have no capability to change that. So names
  are resolved by the proxy, never in the sandbox, and enforcement does
  not rest on the proxy variables a process may ignore.
- **The proxy's address.** Inside the sandbox the proxy is not at
  `127.0.0.1`: it is at the sandbox's gateway address, on the same port,
  and the SDK sets the proxy variables itself. The runtime gives the SDK
  the proxy's loopback address and port, and does not assume that the
  sandbox's processes see the same address.
- **No crossing.** Two sandboxes with two proxy ports do not reach each
  other's proxy. That separation is the sandbox's network, not the proxy:
  on the host itself any local process can connect to any session's port,
  and there only the placeholder stands between it and the credential
  ([`egress.md`](egress.md), its limits).
- **Each session** opens with its sandbox and closes with it; the sandbox
  gets its placeholders in its environment. After every tool call, within
  the step, the session's denials are read into the journal.
- **Not shown yet:** a successful HTTPS tunnel (`CONNECT`) from a sandbox,
  and other distributions and kernels. Until a test shows a host, it is not
  said to support sandbox egress.
- **On Windows** sandbox egress stays refused by name: AppContainer's proxy
  is best effort, so it cannot be enforced.

### What stays outside it

- The `git` CLI the runtime runs (its inherited environment and credential
  helpers), PostgreSQL connection strings and Temporal's workers.
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
  verifiers only, never by `events()`, replay or a view: existing tests
  change and delete events on purpose.
- **Limits.** The chain is evidence against someone who holds the database
  but not the key. The tail after the last anchor can be cut until the next
  state change anchors it, and newer events can be cut with their anchors.
  Someone who holds both the key and the database can rewrite the journal.
  Anchors bind the run id, not the database. The export and the
  OpenTelemetry projection, once they have left, are the outside witnesses.

## Violations and halt

*Specified; implemented by PR 5.*

- **A violation** is a `violation` event, `{ kind, delegate, agent, step,
  detail, count }`, written once per step: a resumed run that computes the
  same refusal again does not write it again. It is written for a tool
  call refused for an authority reason (`authority_denied`; not for
  malformed input, and not for the interpreter's `PolicyDenied`, which is
  the program's error, not the agent's attempt) and for an egress denial
  (`egress_denied`). `count` is the run's count with it.
- **The limit** is checked only when a new violation is written: by default
  3, configured as `violations.limit`. It applies to a 0.5 package, and to
  an older one only when configured. Reaching it stops the run as
  `attention_required` with `violation_limit`; a resumed run stops again at
  its next new violation.
- **Halt is hard.** `mandate halt --tenant <T> | --all [--reason <text>]`
  records a halt (`halts`) and, for every open run in its scope, in one
  transaction: locks the run, records that it was cancelled and its lease
  revoked, drops the lease and ends the run, `cancelled`, or
  `attention_required` when an action is open (INV-12). A second pass ends
  runs that started meanwhile. A result in flight cannot be written: its
  worker no longer holds the lease. Adapters and the proxy are told to
  revoke.
- **In a halted scope** `StartRun` and every resume are refused, `halted`.
- **Lifting.** `mandate halt --lift --tenant <T> | --all --by <who>` is not
  signed; it is recorded with `--by`. Lifting brings no run back.
- A soft stop is what it was: `cancel`.

## Views by role and the audit view

*Specified; implemented by PR 9.*

- `mandate show <run> --role <R>`, for a role the program names: the
  decisions asked of that role, the run's outcome and exceptions, and its
  progress.
- `mandate show <run> --audit`: everything, the event list, and the chain's
  status as `verifyJournal` reports it.
- With neither option, `mandate show` prints what it prints today, byte for
  byte.
- **Classes.** Each event and each section of a run's view is in one class,
  assigned from its event type and its view section and nothing else:

| Class | Holds |
|---|---|
| S0 | A decision: what was asked of whom, and how it was decided |
| S1 | An outcome or an exception: how the run ended, a fault, a violation, a halt |
| S2 | Progress: steps begun and ended, budget left |
| S3 | A step's detail: its request and result |
| S4 | A trace: an agent loop's turns, tool calls and outputs |

- A role view shows S0 for that role and S1 and S2. The audit view shows
  S0 to S4.
- There is no masking by data class in 0.5 (INV-20 is a later release's).

## The OpenTelemetry projection

*Specified; implemented by PR 9.*

- `mandate otel export --endpoint <url> [--run <R> | --tenant <T>] [--follow]`
  runs outside every run: an export that fails does not touch one. The
  journal stays the authority.
- OTLP/HTTP with JSON bodies, written by hand: no new dependency.
- **No content, ever**: no argument, result, prompt, output, file or
  decision text leaves. What leaves is identifiers, types, classes, model
  ids, counts, sequence numbers and hashes.
- **Identifiers.** The trace id is the first 16 bytes of
  `sha256("mandate/otel-trace/0.1\n" ‖ run)`, a span's id the first 8 bytes
  of `sha256("mandate/otel-span/0.1\n" ‖ run ‖ "\n" ‖ command)`. An export
  run twice gives the same ids.
- **Attributes.** GenAI: `gen_ai.operation.name`, and
  `gen_ai.request.model`, the model the lock maps the call's tier to.
  Mandate's own under `mandate.*`: the run, tenant, package, command,
  event type, class, sequence number and hash. The semantic conventions'
  schema URL is pinned.
- **Resuming.** A cursor per endpoint and run (`otel_cursors`) records what
  was exported, so an export resumes where it stopped.

## Invariants

| Id | Invariant | Where 0.5 keeps it |
|---|---|---|
| INV-11 (refined) | An unsupported security requirement is never dropped silently: a method limit, an isolation floor, a credential binding or a least host version is enforced, or nothing it applies to starts | `unsupported_lock` at load; the adapter's refusals (E0902); `unfit_host`; E1803, also at load |
| INV-17 | A projection (a role view, an OpenTelemetry export) is derived from event type and view section, never from content | The class table; the export's attributes |
| INV-23 | A secret never enters a sandbox, nor the runtime's environment when gateways are on; what enters is its placeholder | The proxy's configuration; `credential_in_environment` |
| INV-24 | A sandbox reaches no host and uses no method its grant does not list | The proxy's data path; requirement 0.2; the denial reasons |
| INV-25 | Every event of a chained run is covered by the chain, and every state change of it by a signed anchor | `events.hash`; `journal_anchors`; the verifier |
| INV-26 | A halted scope starts and resumes nothing, and no result in flight at the halt is written | `halts`; the lease; `halted` |
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
| `unsupported_lock` | At load: the lock sets `egress`, named, before the change that enforces it |
| `unsupported_sandbox_profile` (E0902) | A requirement 0.2 asks for what the host cannot give: method limits, an isolation level above the host's, no sharing on a host that may share, credentials |
| `unfit_host` | At a start or a resume, before the lease: a tool the lock names is missing, cannot be read, or is below the lock's least version, or the `bwrap` is setuid |
| `credential_in_environment` | With gateways on, a credential is in the runtime's environment |
| `no_egress_proxy`, `egress_unavailable` | A package needs the proxy and none is named, or it does not answer or lacks a credential |
| `violation_limit` | The run reached its violation limit; it is `attention_required` |
| `halted` | A start or a resume in a halted scope |

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
| J06 | An anchor signed by another key, one whose signature does not verify | `anchor_unknown_key`, `anchor_signature_invalid` |
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
  planned on its own. B7 too.
- **New isolation backends.** 0.5 adds the level and the refusal, not a
  host that gives more than `process`.
- **Sandbox egress on Windows**, TLS interception, and `git`, PostgreSQL
  and Docker traffic through the proxy.
- **A reader for `net.https.get`.**
- **Decision and evidence records in the export**, and anchoring to a
  tenant-wide or outside log.
- **Masking by data class** in views; `WatchRun`, `ListWaits`, `stage`,
  `report` and notifications (0.7).
- **What stays open.** MXC's proxy enforcement is shown on CI's Ubuntu
  runner and nowhere else yet, and a tunnel through it is not; a host is
  said to support sandbox egress only where a test shows it. The race between a start and a halt is narrowed by the second
  pass and the check at resume, not closed. Someone who holds the
  runtime's key and its database can rewrite the journal. Linux sandbox
  tests, PostgreSQL, Node 22 and 24, and Rust run on CI.
