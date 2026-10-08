import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SimAgents, SimTool } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";

afterAll(closeAll);

const FIXBUG = readFileSync(new URL("../../examples/fixbug/fixbug.mdt", import.meta.url), "utf8");

describe("FixBug on simulated adapters", () => {
  it("runs to an opened PR", async () => {
    const usd = (n: number) => ({ micros: n * 1_000_000, currency: "USD" });
    const agents = new SimAgents()
      .on("Explorer.locate", () => ({ ok: [{ file: "src/a.ts", line: 3, claim: "off by one", evidence: "e1" }], cost: { spend: usd(2), tokens: 1000, steps: 5 } }))
      .on("Planner.plan", () => ({ ok: { steps: ["fix bound"], touches: ["src/a.ts"], risks: [] }, cost: { spend: usd(1) } }))
      .on("Implementer.apply", () => ({ ok: { files: ["src/a.ts"], diff: "-<\n+<=" }, cost: { spend: usd(5) } }))
      .on("TestWriter.regression", () => ({ ok: { tests: ["a.test.ts"] }, cost: { spend: usd(2) } }))
      .on("Reviewer.counterexamples", () => ({ ok: { counterexamples: [], blocking: false }, cost: { spend: usd(1) } }));
    const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: { issue: { id: "BUG-7", reproducible: true, scope: ["src/a.ts"] } } });
    expect(run.state).toBe("succeeded");
  });
});
