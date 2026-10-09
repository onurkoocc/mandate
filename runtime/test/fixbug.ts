// The FixBug workflow of Doc 4 §20, with scripted agents. Shared by the
// direct end-to-end test and the one scheduled by Temporal.

import { readFileSync } from "node:fs";
import type { Outcome } from "../src/adapters.js";
import { SimAgents } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";

export const FIXBUG = readFileSync(new URL("../../examples/fixbug/fixbug.mdt", import.meta.url), "utf8");

export const BUG: Obj = { issue: { id: "BUG-7", reproducible: true, scope: ["src/a.ts"] } };

export const USD = 1_000_000;

const usd = (n: number) => ({ micros: n * USD, currency: "USD" });

/** What each agent returns and reports spending. Together 11 USD. */
export const RESULTS: Record<string, Outcome> = {
  "Explorer.locate": { ok: [{ file: "src/a.ts", line: 3, claim: "off by one", evidence: "e1" }], cost: { spend: usd(2), tokens: 1000, steps: 5 } },
  "Planner.plan": { ok: { steps: ["fix bound"], touches: ["src/a.ts"], risks: [] }, cost: { spend: usd(1) } },
  "Implementer.apply": { ok: { files: ["src/a.ts"], diff: "-<\n+<=" }, cost: { spend: usd(5) } },
  "TestWriter.regression": { ok: { tests: ["a.test.ts"] }, cost: { spend: usd(2) } },
  "Reviewer.counterexamples": { ok: { counterexamples: [], blocking: false }, cost: { spend: usd(1) } },
};

/**
 * Each agent's budget, which the runtime reserves when it delegates: 49.28 of
 * the workflow's 50 USD. Each is its steps × the per-call bound of the lock
 * file, 0.88 USD (W0504, BACKLOG K13).
 */
export const RESERVED: Record<string, number> = {
  "Explorer.locate": 10_560_000,
  "Planner.plan": 3_520_000,
  "Implementer.apply": 17_600_000,
  "TestWriter.regression": 10_560_000,
  "Reviewer.counterexamples": 7_040_000,
};

/** Agents that answer with RESULTS; `hold` delays the named ones until the returned promise is resolved. */
export function fixbugAgents(hold: Record<string, Promise<void>> = {}): SimAgents {
  const agents = new SimAgents();
  for (const [skill, outcome] of Object.entries(RESULTS)) {
    agents.on(skill, async () => {
      await hold[skill];
      return outcome;
    });
  }
  return agents;
}

export interface Wait {
  command: string;
  request: Obj;
}

/** The wait a run is in, with its request. */
export function waitOf(waiting: Value): Wait {
  if (!isObj(waiting) || !isObj(waiting["request"])) throw new Error(`not waiting for a person: ${JSON.stringify(waiting)}`);
  return { command: String(waiting["command"]), request: waiting["request"] };
}
