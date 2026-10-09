// The lock file (spec/lock.md, BACKLOG K11): strict reading, locked model
// tiers (E0141) and the budget upper bound W0504 (§8.6).

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
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
