# Sandboxes, 0.1

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

When the host cannot enforce the requirement, the agent is never started.
The delegate fails with this fault, and nothing is spent:

```text
PolicyDenied({ reason: "unsupported_sandbox_profile", code: "MDT-E0902", agent, adapter, unsupported: [...] })
```

The workflow can handle or escalate it like any other fault; unhandled, it
fails the run (INV-11, G05).

## Not in 0.1 yet

- **The rest of the sandbox adapter contract.** §16.1 also names
  `Execute`, `Collect` and `Stop`. Running pinned commands and collecting
  their artifacts belongs to the agent loop, which simulated agents stand
  in for.
- **Learning-mode feedback.** Blocked operations are not fed back to the
  compiler as W0311 yet.
- **An AX adapter.**
