// The lock file (spec/lock.md, BACKLOG K11): strict reading, locked model
// tiers (E0141) and the budget upper bound W0504 (§8.6).

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { LOCK_FORMAT, MA_BRIDGE_PROFILE, type ManagedAgentsBinding } from "../src/index.js";
import { perCallBound, validateLock, type Lock } from "../src/lock.js";
import { codes, readRepo } from "./helpers.js";

const LOCK = JSON.parse(readRepo("fixtures/fixbug/mandate.lock.json")) as Lock;

const agent = (budget: string) => `mandate @ 0.2

module m @ 0.1

use std.{model}

capability M = model.infer(tier: standard)

agent A {
  caps M
  budget ${budget}
  skill s(x: Text) -> Inferred<Text> ! {Model}
}
`;

describe("lock file", () => {
  it("reads FixBug's lock", () => {
    expect(validateLock(LOCK)).toEqual([]);
  });

  it("rejects unknown fields, fractional prices and a model without a tariff (E0140)", () => {
    expect(codes(validateLock({ ...LOCK, extra: 1 }))).toEqual(["MDT-E0140"]);
    const fractional = structuredClone(LOCK);
    (fractional.tariffs!["claude-opus-5-5"]!.micros_per_mtok as { input: number }).input = 4.5;
    expect(codes(validateLock(fractional))).toEqual(["MDT-E0140"]);
    const noTariff = structuredClone(LOCK);
    delete noTariff.tariffs!["claude-opus-5-5"];
    expect(codes(validateLock(noTariff))).toEqual(["MDT-E0140"]);
  });

  it("finds no tariff and no tier under a name only Object.prototype has, in a lock read by JSON.parse", () => {
    // LOCK is read with JSON.parse, as `mandate mcp` and the API read a lock: its objects have a prototype.
    for (const model of ["constructor", "toString", "__proto__"]) {
      const lock = structuredClone(LOCK);
      lock.models!["standard"]!.model = model;
      expect(codes(validateLock(lock)), model).toEqual(["MDT-E0140"]);
      expect(perCallBound(lock, "standard"), model).toBeUndefined();
      const r = check(agent("{ tokens: 280k, spend: 1 USD, steps: 2 }"), "mdt", { lock });
      expect(r.diagnostics.map((d) => [d.code, d.message]), model).toEqual([["MDT-E0140", `The lock maps tier standard to ${model}, which has no tariff.`]]);
    }
    const tier = agent("{ tokens: 280k, spend: 1 USD, steps: 2 }").replace("tier: standard", "tier: constructor");
    expect(check(tier, "mdt", { lock: LOCK }).diagnostics.map((d) => [d.code, d.facts?.["tier"]])).toEqual([["MDT-E0141", "constructor"]]);
    expect(perCallBound(LOCK, "constructor")).toBeUndefined();
  });

  it("bounds one call by the locked limits, priced with no cache hit (K12)", () => {
    // 128k input at the cache-write price (5 USD/MTok) + 12k output at 20 USD/MTok.
    expect(perCallBound(LOCK, "standard")).toEqual({ tokens: 140_000, spend: { micros: 880_000, currency: "USD" } });
    // Sonnet 5.5: 128k × 2.5 + 12k × 10.
    expect(perCallBound(LOCK, "economy")).toEqual({ tokens: 140_000, spend: { micros: 440_000, currency: "USD" } });
    expect(perCallBound(LOCK, "decision")).toBeUndefined();
  });

  it("warns when an agent loop's budget is below steps × the per-call bound (W0504)", () => {
    const r = check(agent("{ tokens: 280k, spend: 1 USD, steps: 2 }"), "mdt", { lock: LOCK });
    expect(r.ok).toBe(true);
    const w = r.diagnostics.find((d) => d.code === "MDT-W0504")!;
    expect(w.facts).toMatchObject({ agent: "A", skill: "s", steps: 2, short: { "spend:USD": { declared: 1_000_000, bound: 1_760_000 } } });
    expect(codes(check(agent("{ tokens: 280k, spend: 1.76 USD, steps: 2 }"), "mdt", { lock: LOCK }).diagnostics)).toEqual([]);
  });

  it("does not compute the bound without a lock", () => {
    expect(codes(check(agent("{ tokens: 1k, spend: 1 USD, steps: 2 }"), "mdt").diagnostics)).toEqual([]);
  });

  it("refuses a model tier the lock does not name (E0141)", () => {
    const src = agent("{ steps: 2 }").replace("tier: standard", "tier: decision");
    expect(codes(check(src, "mdt", { lock: LOCK }).diagnostics)).toEqual(["MDT-E0141"]);
  });

  it("refuses a budget in another currency than the tier's tariff (E0504)", () => {
    expect(codes(check(agent("{ spend: 1 EUR, steps: 2 }"), "mdt", { lock: LOCK }).diagnostics)).toEqual(["MDT-E0504"]);
  });

  it("checks FixBug without warnings about its budgets (K13)", () => {
    const r = check(readRepo("fixtures/fixbug/fixbug.mdt"), "mdt", { lock: LOCK });
    expect(r.ok).toBe(true);
    expect(codes(r.diagnostics).filter((c) => c !== "MDT-W0601")).toEqual([]);
  });
});

describe("lock format 0.4: members and roles", () => {
  const K1 = `sha256:${"1".repeat(64)}`;
  const K2 = `sha256:${"2".repeat(64)}`;
  const K3 = `sha256:${"3".repeat(64)}`;
  const V04 = (change: Partial<Lock> = {}): Lock => ({
    ...structuredClone(LOCK),
    lock: "mandate/lock/0.4",
    members: { alice: { keys: [K1] }, bob: { keys: [K2, K3] } },
    roles: { code_owner: ["alice"], release_manager: ["bob", "alice"] },
    ...change,
  });
  const said = (v: unknown) => validateLock(v).map((d) => [d.code, d.message, d.at.path]);
  const binding: ManagedAgentsBinding = {
    format: "mandate/binding/managed-agents/0.1",
    beta: "managed-agents-2026-04-01",
    tools: "bridge",
    environment: { id: "env_1", config: K1 },
    session_fee: { currency: "USD", micros_per_hour: 80_000 },
    harness_tokens: 4096,
    agents: { Reader: { id: "agent_1", version: 1, tier: "standard", model: "claude-opus-5-5", effort: "high", max_output_tokens: 12_000, config: K1 } },
    profile: { ...MA_BRIDGE_PROFILE },
  };

  it("reads a 0.4 lock with members and roles, and writes 0.5", () => {
    expect(LOCK_FORMAT).toBe("mandate/lock/0.5");
    expect(validateLock(V04())).toEqual([]);
    expect(validateLock({ ...V04(), members: undefined, roles: undefined })).toEqual([]);
  });

  it("refuses members or roles in a lock older than 0.4 (E0140)", () => {
    for (const lock of ["mandate/lock/0.3", "mandate/lock/0.2"] as const) {
      const members = validateLock(V04({ lock, roles: undefined }));
      expect(members.map((d) => [d.code, d.message, d.at.path]), lock).toEqual([["MDT-E0140", `Lock field members needs lock format mandate/lock/0.4, not ${lock}.`, "/members"]]);
      expect(members[0]!.facts, lock).toEqual({ field: "members", lock });
      const roles = validateLock(V04({ lock, members: undefined, roles: { code_owner: ["alice"] } }));
      // Without members, the role's member is unknown too.
      expect(roles.map((d) => [d.code, d.message, d.at.path]), lock).toEqual([
        ["MDT-E0140", `Lock field roles needs lock format mandate/lock/0.4, not ${lock}.`, "/roles"],
        ["MDT-E0140", "Role code_owner lists member alice, which is not in members.", "/roles/code_owner/0"],
      ]);
      expect(roles[0]!.facts, lock).toEqual({ field: "roles", lock });
      expect(said(V04({ lock })).map((d) => d[2]), lock).toEqual(["/members", "/roles"]);
    }
  });

  it("refuses a role that lists a member not in members (E0140)", () => {
    const r = validateLock(V04({ roles: { code_owner: ["alice"], release_manager: ["bob", "carol"] } }));
    expect(r.map((d) => [d.code, d.message, d.at.path])).toEqual([["MDT-E0140", "Role release_manager lists member carol, which is not in members.", "/roles/release_manager/1"]]);
    expect(r[0]!.facts).toEqual({ role: "release_manager", member: "carol" });
    expect(codes(validateLock(V04({ members: undefined })))).toEqual(["MDT-E0140", "MDT-E0140", "MDT-E0140"]);
  });

  it("refuses one key under two members (E0140)", () => {
    const r = validateLock(V04({ members: { alice: { keys: [K1] }, bob: { keys: [K2, K1] } } }));
    expect(r.map((d) => [d.code, d.message, d.at.path])).toEqual([["MDT-E0140", `Key ${K1} is listed under members alice and bob; one key belongs to one member.`, "/members/bob/keys/1"]]);
    expect(r[0]!.facts).toEqual({ key: K1, members: ["alice", "bob"] });
  });

  it("refuses a malformed key id, an empty or repeated key list, an empty or repeated role and a malformed name (E0140)", () => {
    const schema = (v: unknown) => validateLock(v).map((d) => [d.code, d.at.path, d.facts?.["keyword"]]);
    for (const key of ["sha256:3f1c", `sha256:${"A".repeat(64)}`, K1.slice(7)]) {
      expect(schema(V04({ members: { alice: { keys: [key] } }, roles: {} })), key).toEqual([["MDT-E0140", "/members/alice/keys/0", "pattern"]]);
    }
    expect(schema(V04({ members: { alice: { keys: [] } }, roles: {} }))).toEqual([["MDT-E0140", "/members/alice/keys", "minItems"]]);
    expect(schema(V04({ members: { alice: { keys: [K1, K1] } }, roles: {} }))).toEqual([["MDT-E0140", "/members/alice/keys", "uniqueItems"]]);
    expect(schema(V04({ members: { alice: {} } as never, roles: {} }))).toEqual([["MDT-E0140", "/members/alice", "required"]]);
    expect(schema(V04({ members: { alice: { keys: [K1], name: "Alice" } } as never, roles: {} }))).toEqual([["MDT-E0140", "/members/alice", "additionalProperties"]]);
    expect(schema(V04({ roles: { code_owner: [] } }))).toEqual([["MDT-E0140", "/roles/code_owner", "minItems"]]);
    expect(schema(V04({ roles: { code_owner: ["alice", "alice"] } }))).toEqual([["MDT-E0140", "/roles/code_owner", "uniqueItems"]]);
    expect(schema(V04({ roles: { "code-owner": ["alice"] } }))).toContainEqual(["MDT-E0140", "/roles", "propertyNames"]);
    expect(schema(V04({ members: { "a b": { keys: [K1] } }, roles: {} }))).toContainEqual(["MDT-E0140", "/members", "propertyNames"]);
  });

  it("finds a member or a role named constructor or __proto__ only when the lock names it, in a lock read by JSON.parse", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      const text = (members: string) => `{ "lock": "mandate/lock/0.4", "modules": {}, "members": { ${members} }, "roles": { "${name}": ["${name}"] } }`;
      expect(validateLock(JSON.parse(text(`"${name}": { "keys": ["${K1}"] }`))), name).toEqual([]);
      expect(said(JSON.parse(text(`"alice": { "keys": ["${K1}"] }`))), name).toEqual([["MDT-E0140", `Role ${name} lists member ${name}, which is not in members.`, `/roles/${name}/0`]]);
    }
  });

  it("keeps bindings valid in a 0.3 and a 0.4 lock, and refuses them in a 0.2 lock with the same message as before", () => {
    const withBindings = (lock: Lock["lock"]) => ({ ...structuredClone(LOCK), lock, bindings: { "managed-agents": binding } });
    expect(validateLock(withBindings("mandate/lock/0.3"))).toEqual([]);
    expect(validateLock(withBindings("mandate/lock/0.4"))).toEqual([]);
    expect(validateLock({ ...V04(), bindings: { "managed-agents": binding } })).toEqual([]);
    const r = validateLock(withBindings("mandate/lock/0.2"));
    expect(r.map((d) => [d.code, d.message, d.at.path])).toEqual([["MDT-E0140", "Executor bindings need lock format mandate/lock/0.3, not mandate/lock/0.2.", "/lock"]]);
    expect(r[0]!.facts).toEqual({ lock: "mandate/lock/0.2" });
  });
});
