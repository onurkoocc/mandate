# Sandboxes

Agents run inside sandboxes that the runtime builds from their authority.
This follows design doc 4 §7.3, §11.3 and §16.1. There are two halves:

- **The compiler** states, for each local agent, what its sandbox must
  enforce. This is the *sandbox requirement*, and it names no platform.
- **A sandbox adapter**, pinned and versioned, turns a requirement into one
  platform's policy. It first probes the host for what the host can
  really enforce.

The compiler never writes MXC or AX policy itself. Support differs by
backend and OS build, and only the host knows what it can enforce.

## The requirement

`mandate sandbox <file> [--agent <name>]` prints one requirement per local
agent. Remote agents run elsewhere, bound over A2A, and get none.

```json
{
  "format": "mandate/sandbox-requirement/0.1",
  "subject": { "agent": "Explorer", "def": "sha256:…" },
  "filesystem": { "read": ["/work/repo"], "write": [] },
  "exec": [],
  "network": { "hosts": [] },
  "models": [{ "tier": "standard", "max_class": "internal" }],
  "ui": { "desktop": false, "clipboard": false },
  "limits": { "timeout_ms": 900000 },
  "unbounded": []
}
```

| Field | From |
|---|---|
| `filesystem.read`, `filesystem.write` | `fs.read(P)` and `fs.write(P)`, normalized by segment; a path inside another listed path folds into it |
| `exec` | `exec(commands: […], args_prefix: […])`; one entry per command |
| `network.hosts` | `net.https(hosts: […])` |
| `models` | `model.infer(tier: …, max_class: …)`; the adapter maps a tier to its endpoint's hosts |
| `ui` | Always off in 0.1 |
| `limits.timeout_ms` | The agent's `time` budget, else the longest of its skills' when every skill has one, else `null` |
| `unbounded` | Capabilities whose scope is not statically known |

A capability whose scope is not static is listed in `unbounded`. It is
never dropped and never widened.

External effects such as `git.pr` and `money.spend` are not part of a
sandbox. The runtime commits them through prepare → authorize → commit
(see [`runtime.md`](runtime.md)).

The static requirement is the upper bound for the agent. At run time each
delegation carries its own requirement in `DelegateRequest.sandbox`, built
the same way from what that delegation was actually granted (§7.5): the
agent's capabilities inside the workflow's, narrowed by `with caps`, and the
delegate's `time` budget. Without `with caps`, the two are equal.

## The MXC adapter

`MxcAdapter` (`runtime/src/sandbox.ts`) is pinned as `mandate-mxc@0.1`. It
writes the representative policy of §11.3:

| Policy field | From the requirement |
|---|---|
| `filesystem.readOnly`, `readWrite` | `filesystem.read`, `filesystem.write` |
| `network.allowedHosts` | `network.hosts` plus the configured hosts of each model tier; `allowOutbound` only when that list is non-empty |
| `process.allowedCommands` | `exec`, with `argsPrefix` |
| `ui` | Desktop and clipboard off |
| `timeoutSeconds` | `limits.timeout_ms`, else the adapter's default |
| `isolation`, `mode` | The adapter's configuration: `process` and `enforcement` by default |

A real host binds only paths that exist. Before it starts a sandbox, it
creates a writable path that is missing when that path's parent exists,
such as a component's `test` beside its `src`. The path is inside the
grant, so creating it adds no authority. A path whose parent is missing
is not created.

Before translating, the adapter probes the host (`Probe`, §16.1). It
refuses the requirement when any of these holds:

- the configured isolation backend is missing; another one is never
  chosen in its place, because backends are not equivalent guarantees;
- the mode is unavailable, or is `permissive`, which is always refused;
- the host cannot enforce path lists, cannot block outbound connections,
  or cannot allow listed hosts when there are any;
- the host cannot limit which commands start, or their arguments when an
  `args_prefix` is given;
- the host cannot enforce a timeout when one applies, or cannot turn off
  the desktop and the clipboard;
- a model tier has no configured endpoint;
- `unbounded` is not empty.

A refusal lists every missing guarantee. `learning` mode is allowed: it
blocks like `enforcement` and also reports what it blocked.

## Running agents in sandboxes

`SandboxedAgents` wraps an agent adapter. For each delegation it plans a
policy, creates the sandbox, runs the agent in it and destroys it.

### Stop (§16.1)

When a run is cancelled while one of its agents' processes runs, the
sandbox is stopped; the process does not run on to its own timeout. While
a tool call runs, the agent loop asks the run's row whether it was
cancelled, every `stopPollMs` (1 s by default; PostgreSQL is
authoritative, so a cancel from another process counts). Then it calls the
host's `stop(handle)`:

| Host | What `stop` does | Answer |
|---|---|---|
| Linux, Bubblewrap | kills every process running in the sandbox; starts no more | `stopped` |
| Windows, AppContainer | starts no more; the SDK's `run` cannot be killed, so a running process ends at its timeout | `uncertain` while one runs, else `stopped` |

The run's journal records `sandbox_stopped` with the delegation, the agent,
the handle and the answer. The tool call's result says `stopped: true`. The
loop's next step is refused because the run is cancelled (R08), and the
sandbox is destroyed as always. A host without `stop` leaves the process to
its timeout, which every agent's policy sets.

When the host cannot enforce the requirement, the agent is never started.
The delegate fails with this fault, and nothing is spent:

```text
PolicyDenied({ reason: "unsupported_sandbox_profile", code: "MDT-E0902", agent, adapter, unsupported: [...] })
```

The workflow can handle or escalate it like any other fault; unhandled, it
fails the run (INV-11, G05).

## Executing in a sandbox

An agent loop ([`runtime.md`](runtime.md#agent-loops-82)) runs each tool
call as one process: `SandboxHost.execute(handle, { argv, stdin, cwd,
timeoutMs })`. This is §16.1's `Execute` with its output collected. `argv`
is an argument vector, never a shell line.

With `modelsInControlPlane` set, the model calls are made by the runtime,
so a model capability asks the sandbox for no network (BACKLOG K7). An
agent with no `net.https` capability then has none at all.

## The MXC host on Linux

`MxcHost` (`runtime/src/mxc.ts`) is the real host: `@microsoft/mxc-sdk/v1`
with its Bubblewrap backend (BACKLOG K16). Each process runs in its own
`bwrap` sandbox:

| Guarantee | How |
|---|---|
| Filesystem | MXC's deny-by-default baseline (system binaries and `/etc` read-only), the policy's read-only and read-write paths, and nothing else |
| Network | Egress and ingress denied: `--unshare-net`, no network at all |
| Commands | Checked by the host before a process starts. Either a helper the runtime's tools use (`cat`, `ls`, `grep`, the `write_file` script) on a path inside the policy, or an allowed command with an allowed argument prefix. Bubblewrap cannot limit commands inside the sandbox |
| Environment | None of the runtime's: the process gets MXC's default `PATH` and `TERM`, so no API key or token reaches it |
| Time | The policy's timeout, per process |

The probe asks the SDK whether Bubblewrap can run: is `bwrap` installed,
and are user namespaces enabled? Where it cannot, the host enforces
nothing, so every agent is refused by name (G05). Nothing falls back to a
weaker isolation.

The host refuses by name what it does not support:

- an outbound host allow-list (`network: deny_all`);
- `learning` mode, because Bubblewrap has none.

`baseline` adds read-only paths every sandbox sees, such as a toolchain
under `/opt`. These paths appear in the request MXC gets.

The `sandbox` CI job runs the enforcement tests (`runtime/test/mxc.test.ts`,
with `MANDATE_MXC=1`) on Ubuntu with Bubblewrap installed and unprivileged
user namespaces allowed. The tests check that:

- a process reads and writes inside its paths;
- a write outside the write paths does not reach the host, even from a
  shell the agent was allowed to start;
- nothing outside the paths is visible;
- no host can be reached (G07), while the CI host itself reaches it;
- the runtime's environment is absent;
- an agent loop does its work through the sandbox.

## The MXC host on Windows

`WindowsMxcHost` (`runtime/src/mxc-windows.ts`) uses the same SDK with the
AppContainer process container (BACKLOG P2-27). Each process runs in a
container of its own:

| Guarantee | How |
|---|---|
| Filesystem | The policy's read-only and read-write paths, the toolchain (node.exe's directory) and the runtime's tool helper read-only, and a fresh scratch directory for the process's temporary files; nothing else |
| Network | Egress and ingress denied, host loopback too |
| UI | An isolated desktop of its own: no clipboard, no input injection, no access to the user's desktop |
| Commands | Checked by the host before a process starts, as on Linux |
| Environment | Only what Windows needs to start a process (`SystemRoot`, `windir`, `SystemDrive`, `ComSpec`, `PATHEXT`), `PATH` over the toolchain, the scratch directory as `TEMP`, `TMP` and `LOCALAPPDATA`, and `NODE_OPTIONS`. Nothing of the runtime's own environment, so no key reaches it |
| Time | The policy's timeout, per process |

- **Tools.** An AppContainer has no `cat`, `ls`, `grep` or `sh`, so the
  runtime's file tools run as `node sandbox-helper.mjs <op>`
  (`runtime/src/sandbox-helper.ts`), with the results the Linux tools
  give. The helper is plain JavaScript that the host writes to a directory
  of its own, so Node needs nothing outside the granted paths to run it. A write's content is staged in a read-only file that the helper
  copies into place, under the sandbox's write policy.
- **Node.** Two adjustments are set through `NODE_OPTIONS`. Module paths are
  not resolved through `realpath`, which would read every parent directory
  of the program, and the policy grants none. And `node --test` runs test
  files in-process, because a container cannot start a child process.
- **Builds.** The probe checks the Windows build. Process isolation needs
  26100.9278 or later, and session isolation 26100.9550 (design doc 4,
  §7.3). On an older build the host enforces nothing, and every agent is
  refused by name (G05).
- **Session isolation** is refused by name for agents
  (`blocking outbound network`), because MXC requires a session's egress
  to be allowed. It is never run with the network open (INV-11).
- **Learning mode** (`mode: "learning"`) is supported where MXC can
  capture denials. Accesses the policy denies stay denied, and are
  recorded. The host hands them over at the end of the sandbox (`Collect`).
  The loop journals them with the delegation's result.
  `mandate denials <run>` exports the run's report, and
  `mandate check <program> --denials <report>` turns it into W0311 warnings
  (policy and real use disagree). The toolchain's own start-up accesses
  are left out.

On Windows, `mandate.runtime.json`'s `sandbox` takes `toolchain`,
`isolation` and `mode`. Paths in a program keep their drive letter
(`C:/work/repo`).

The `sandbox-windows` CI job, and a run with `MANDATE_MXC=1` on Windows,
repeat the Linux enforcement tests against a real AppContainer
(`runtime/test/mxc-windows.test.ts`). They also check that:

- the user's clipboard stays out;
- learning mode keeps a denied read denied, and records it.

## Not yet

- **Learning mode on Linux.** Bubblewrap has none; a requirement for it is
  refused there.
- **An outbound host allow-list.** MXC offers one through a proxy. It is
  not wired up, so a requirement with `net.https` hosts is refused.
- **An AX adapter.**
