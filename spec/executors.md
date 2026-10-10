# Executors

An executor runs a program's agents somewhere other than the reference
runtime's own agent loop, while the runtime keeps everything the guarantees
rest on. Mandate compiles onto existing executors; it does not replace them.

This page covers the one executor so far, **Claude Managed Agents**, in the
form called *Form A* (design doc 10 §3.1, decision K45):

- The workflow body, the journal, the budget ledger, the evidence and the
  approvals stay in the Mandate runtime.
- Each delegation to a bound agent is one Managed Agents **session**.
- Every tool is a **custom tool** that the runtime runs in the agent's own
  sandbox. This is the **bridge** (K79).

The service hosts the agent loop's model side: it keeps the conversation and
calls the model. It never runs a tool, never holds a credential (K7), and
never sees a file the agent did not read.

## How the bridge works

A custom tool call stops a Managed Agents session until the client answers
it. So every tool call comes back to the runtime's agent loop
([`runtime.md`](runtime.md), "Agent loops"), which handles it exactly as for
a local loop:

1. it checks the call against the delegation's grant;
2. it runs the call in the agent's MXC sandbox;
3. it journals the call as `<delegate>/step/<n>/tool/<k>`.

The loop's own checks therefore hold unchanged: the progress checks (V11 and
`stall`), the steps limit, repairs, and the result schema of `finish`. Each
turn is a journaled command, `<delegate>/step/<n>`. The session itself has
two journaled steps of the delegation:

| Command | What it does |
|---|---|
| `<delegate>/session` | Creates the session. It is pinned to the deployed agent version and gets the delegation's system prompt and tools as session-local overrides. |
| `<delegate>/step/<n>` | Sends the loop's last message and waits until the session stops. The message is either the tool results (`user.custom_tool_result`) or text (`user.message`). The turn's result is the agent's message: its text and its custom tool calls. |
| `<delegate>/session/close` | Archives the session. |

Replay calls neither the service nor the sandbox (INV-09).

**After a crash.** A turn that runs again finds its message already in the
session's events and waits for the answer instead of sending it twice.

**Tool names.** `grep` is the name of one of the service's own tools, so it
travels as `mandate_grep`; the loop still sees `grep`.

**Tool schemas.** The service refuses `$ref` in a custom tool's input
schema. This was seen in the live trial. So every reference into `$defs`,
such as the result type of `finish`, is written out in place. A recursive
type cannot be written out that way, and is refused by name
(`unsupported_schema`).

## Deploy and the binding

```sh
mandate deploy <program> --target managed-agents [--lock FILE] [--agents A,B] [--name PREFIX] [--harness-tokens N]
```

`deploy` needs `CLAUDE_API_KEY` and no runtime configuration. It creates two
kinds of resource:

- **One Managed Agents agent per bound Mandate agent.**
  - Its model and effort come from the lock's tier. Effort is always sent
    (K10).
  - It has no tools, MCP servers, skills or roster of its own, and
    `multiagent` stays off (K46).
- **One cloud environment.**
  - Its networking is `limited` with no hosts, no package managers and no
    MCP servers.
  - The bridge runs nothing in it.

`deploy` then writes the binding into the lock under
`bindings["managed-agents"]`, so the lock is `mandate/lock/0.3`. The lock is
part of the package hash. A deployment is therefore a new package, and a
person approves the binding with it (INV-02).

Deploying again updates the agents the binding already names: their ids
stay and their versions move on.

```json
"bindings": {
  "managed-agents": {
    "format": "mandate/binding/managed-agents/0.1",
    "beta": "managed-agents-2026-04-01",
    "tools": "bridge",
    "environment": { "id": "env_…", "config": "sha256:…" },
    "session_fee": { "currency": "USD", "micros_per_hour": 80000 },
    "harness_tokens": 4096,
    "agents": {
      "Fixer": { "id": "agent_…", "version": 1, "tier": "standard", "model": "claude-opus-5-5",
                 "effort": "high", "max_output_tokens": 128000, "config": "sha256:…" }
    },
    "profile": { "caps.paths_commands": "full", "…": "…" }
  }
}
```

| Field | Holds |
|---|---|
| `agents.*.id`, `version` | The deployed agent, and the version every session pins |
| `agents.*.max_output_tokens` | The model's output ceiling, from the Models API (K80) |
| `agents.*.config`, `environment.config` | A digest of the configuration the service reported at deploy |
| `session_fee` | The price of a session's running time |
| `harness_tokens` | An allowance for the context the service adds to each request. Default 4096. The live trial (10 October 2026, `claude-sonnet-5-5`) measured about 630 |
| `profile` | The guarantee profile, below |

**ValidateBinding.** The service has no content hash, so identity is kept on
Mandate's side. Before every run, the runtime reads back each pinned agent
version and the environment and compares them with the digests in the
binding. Environments are not versioned, so the environment is read on
every run too. The run does not start (`unsupported_binding`) if any of these
holds:

- an agent or the environment changed;
- an agent or the environment was archived;
- an agent or the environment cannot be read.

**A bound agent never runs anywhere else.** A runtime without the Managed
Agents executor does not start a run whose lock binds agents to it
(`no_executor`). The executor is configured in `mandate.runtime.json`:

```json
{ "executor": { "managed-agents": { "pollMs": 1000, "maxTurnMs": 3600000 } }, "sandbox": { "host": "mxc" } }
```

The sandbox is required, because every tool of a bound agent runs in it.

## What the compiler checks

When the lock has a binding, `mandate check` and load-time verification also
run these checks:

| Code | Case | Rule |
|---|---|---|
| `MDT-E0140` | — | The binding is read strictly: closed schema, lock format `0.3` |
| `MDT-E0903` | X01 | The binding still fits. Every bound agent is a local agent with exactly one model tier. The lock still maps that tier to the deployed model and effort. The binding is for the beta this implementation speaks. Its profile claims no more than the bridge gives and lists every guarantee. |
| `MDT-E0904` | X02 | The service cannot cap one request's output, so for a bound tier the lock's `max_output_tokens` is at least the model's ceiling (K80). The upper bound of a call ([`lock.md`](lock.md)) then stays true. |
| `MDT-E0905` | X03 | A bound agent may send its model at most `internal` data. The service keeps session history and is not zero-retention (K46). |

`deploy` runs the same checks before it creates anything.

## Budget

A turn reserves, before it is sent, the sum of:

- the counted conversation plus `harness_tokens`, priced as if nothing hits
  the cache;
- the locked output limit, which on this executor is the model's ceiling;
- the session fee for the longest a turn may run (`maxTurnMs`) plus five
  minutes for the session to stop after an interrupt.

When the counted input plus `harness_tokens` is over `max_input_tokens`, the
skill stops with `ContextExhausted`.

A turn is settled at:

- the model usage the session's `span.model_request_end` events report,
  priced at the lock's tariff;
- the session fee for the turn's running time. That time runs from the
  service's echo of the message to the event that stopped the session.

Both come from the service's events, so a turn re-run after a crash is
priced the same.

**The live trial.** `runtime/test/live-managed-agents.test.ts` runs with
`MANDATE_LIVE=1 MANDATE_MA=1`. On 10 October 2026 one delegation on
`economy` took three turns and two tool calls. Its result was correct, it
cost 0.005–0.010 USD, and replay made no call to the service.

**The service's own cap.** A session is also capped at the delegation's
`spend` budget (`budget.max_list_cost`). It is a second line behind the
runtime's reservation of every turn. A session that reaches it ends the skill
with `StepLimit`.

## Guarantee profile

Levels:

- **Full:** the guarantee is enforced.
- **Partial:** enforced with the limit named.
- **None:** the guarantee is not given, and a program that needs it is
  refused by name (INV-11).

The profile is written into the binding and checked against this table.

| Guarantee | Bridge | How |
|---|---|---|
| `package.identity` | Full | Binding digests and ValidateBinding before every run |
| `static.checks` | Full | The compiler is unchanged; E0903–E0905 on top |
| `caps.paths_commands` | Full | Every tool runs in the runtime's MXC sandbox, checked against the grant |
| `caps.network` | Full | The sandbox has no network; the environment has none either |
| `parallel.isolation` | Full | One session per delegation, one sandbox per delegation (C5, INV-14) |
| `model.pinning` | Full | Model and effort on the pinned agent version, checked against the lock |
| `model.max_class` | Partial | At most `internal` (E0905); `confidential` and above run on the local runtime |
| `budget.tokens_spend` | Full | Every turn reserved and settled by the runtime; the session cap as a second line |
| `budget.steps` | Full | One turn is one step; the loop stops before a turn that does not fit |
| `budget.time` | Full | The delegation's deadline and the turn limit, enforced by the runtime |
| `loop.progress` | Full | The loop sees every tool call (V11, `stall`) |
| `journal.turns` | Full | Every turn and tool call is a journaled command |
| `replay.no_adapter` | Full | Replay reads the journal (INV-09) |
| `evidence.verifier` | Full | The verifier runs in the runtime (INV-04) |
| `effects.prepare_authorize_commit` | Full | Critical effects never run in the service (INV-03, INV-05) |
| `credentials.control_plane` | Full | The service gets no write credential and no repository mount (K7) |
| `cancel` | Partial | The running turn is interrupted (`user.interrupt`), and no step follows (R08). A turn already answering stops at the service's pace. |

Design doc 10's profile for its first design, with the service's own tools
in a cloud sandbox, was mostly "output" or "none" for paths, progress and the
turn journal. The bridge lifts those to full: the service no longer runs the
tools.

**Not supported.**

- **Dynamic workflows inside a delegation (K47).** They need the service's
  own tools and sandbox, which a bridge binding does not have.
- **Compiling the workflow body into the service (design doc 10, Form B).**
  It is not offered.

## Core check (K72)

*Does this executor exclude the local, serverless Core mode?* No:

- It is optional. A lock without a binding runs on the local loop, as
  before.
- A binding adds no construct to the IR. It lives in the lock, so a Core
  implementation reads it and either serves it or refuses it by name.
- The runtime side needs nothing that Core lacks: PGlite works, Temporal is
  not needed, and the tools still run in the local MXC sandbox.
- The guarantee floor (ARCHITECTURE §4, principles 1–5) is the same on both
  paths.

What the executor adds is the service's hosted loop, not a second set of
rules.
