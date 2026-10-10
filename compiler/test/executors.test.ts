// Executor bindings in the lock (spec/executors.md; BACKLOG item 39, K45,
// K46, K80): the cases X01–X03. A binding that no longer fits the program and
// the lock is an error, never adjusted.

import { describe, expect, it } from "vitest";
import { check, MA_BRIDGE_PROFILE, type Lock, type ManagedAgentsBinding } from "../src/index.js";

const SRC = (maxClass = "", remote = false) => `mandate @ 0.3

module bridge @ 0.1

use std.{fs, model, net}

capability RepoRead = fs.read("/work/repo")
capability ModelStd = model.infer(tier: standard${maxClass})

type Note = { text: Text }

${remote ? `agent remote Billing = a2a("https://billing.example.com/.well-known/agent-card.json")
  version "1.0"
  trust   untrusted
  caps    net.https(hosts: ["billing.example.com"])
  skills {
    quote(task: Text) -> Note
  }

` : ""}agent Reader {
  caps   RepoRead, ModelStd
  budget { tokens: 2M, spend: 20 USD, steps: 6 }
  skill look(task: Text) -> Inferred<Note> ! {Fs.Read, Model}
}

workflow Look(task: Text) -> Inferred<Note>
  caps   RepoRead, ModelStd
  budget { spend: 30 USD }
{
  delegate Reader.look(task)
}
`;

const DIGEST = `sha256:${"0".repeat(64)}`;

function binding(change: Partial<ManagedAgentsBinding> = {}, agent: Partial<ManagedAgentsBinding["agents"][string]> = {}): ManagedAgentsBinding {
  return {
    format: "mandate/binding/managed-agents/0.1",
    beta: "managed-agents-2026-04-01",
    tools: "bridge",
    environment: { id: "env_1", config: DIGEST },
    session_fee: { currency: "USD", micros_per_hour: 80_000 },
    harness_tokens: 4096,
    agents: { Reader: { id: "agent_1", version: 1, tier: "standard", model: "claude-opus-5-5", effort: "high", max_output_tokens: 128_000, config: DIGEST, ...agent } },
    profile: { ...MA_BRIDGE_PROFILE },
    ...change,
  };
}

function lock(b: ManagedAgentsBinding = binding(), maxOutput = 128_000): Lock {
  return {
    lock: "mandate/lock/0.3",
    modules: {},
    models: { standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", max_input_tokens: 100_000, max_output_tokens: maxOutput } },
    tariffs: { "claude-opus-5-5": { currency: "USD", as_of: "2026-10-10", micros_per_mtok: { input: 4_000_000, output: 20_000_000, cache_read: 200_000, cache_write: 5_000_000 } } },
    bindings: { "managed-agents": b },
  };
}

const codes = (src: string, l: Lock): string[] => check(src, "mdt", { lock: l }).diagnostics.map((d) => d.code);

describe("executor bindings (spec/executors.md)", () => {
  it("a binding that fits the program and the lock checks clean", () => {
    expect(codes(SRC(), lock())).toEqual([]);
  });

  it("is read strictly: bindings need lock format 0.3, and an unknown field is refused (E0140)", () => {
    expect(codes(SRC(), { ...lock(), lock: "mandate/lock/0.2" })).toEqual(["MDT-E0140"]);
    expect(codes(SRC(), lock({ ...binding(), extra: 1 } as unknown as ManagedAgentsBinding))).toEqual(["MDT-E0140"]);
    expect(codes(SRC(), lock({ ...binding(), tools: "builtin" } as unknown as ManagedAgentsBinding))).toEqual(["MDT-E0140"]);
  });

  it("X01: a binding that no longer fits is refused (E0903)", () => {
    // The lock maps the tier to another effort than the one deployed.
    expect(codes(SRC(), lock(binding({}, { effort: "max" })))).toEqual(["MDT-E0903"]);
    // The binding names an agent the program does not have, or a remote one.
    expect(codes(SRC(), lock(binding({ agents: { ...binding().agents, Ghost: binding().agents["Reader"]! } })))).toEqual(["MDT-E0903"]);
    expect(codes(SRC("", true), lock(binding({ agents: { ...binding().agents, Billing: binding().agents["Reader"]! } })))).toEqual(["MDT-E0903"]);
    // Another API beta.
    expect(codes(SRC(), lock(binding({ beta: "managed-agents-2027-01-01" })))).toEqual(["MDT-E0903"]);
    // A profile that claims more than the bridge gives, or leaves a guarantee out.
    expect(codes(SRC(), lock(binding({ profile: { ...MA_BRIDGE_PROFILE, cancel: "full" } })))).toEqual(["MDT-E0903"]);
    const { "journal.turns": _left, ...short } = MA_BRIDGE_PROFILE;
    expect(codes(SRC(), lock(binding({ profile: short })))).toEqual(["MDT-E0903"]);
  });

  it("X02: the lock states the model's output ceiling for a bound tier (E0904, K80)", () => {
    const r = check(SRC(), "mdt", { lock: lock(binding(), 32_000) });
    expect(r.diagnostics.map((d) => d.code)).toEqual(["MDT-E0904"]);
    expect(r.diagnostics[0]!.facts).toMatchObject({ locked: 32_000, ceiling: 128_000 });
  });

  it("X03: a bound agent may send its model at most internal data (E0905, K46)", () => {
    expect(codes(SRC(", max_class: confidential"), lock())).toEqual(["MDT-E0905"]);
    expect(codes(SRC(", max_class: internal"), lock())).toEqual([]);
  });
});
