// The programs of the version-gate vectors (compiler/test/schema-vectors.test.ts): one for each row of the SINCE
// tables in src/ir/validate.ts, and for each rule that checks a language version without being a row of a table.

import type { Json } from "../src/json/strict-json.js";
import { V } from "./schema-vector-cases.js";

type Program = { [k: string]: Json };

export interface GateProgram {
  /** Tells the placements apart where one row has several (a budget is written in five places). */
  variant: string;
  program: (language: string) => Program;
}

const wrap = (language: string, defs: Program): Program => ({ language, module: "vectors.gate", version: "0.1", defs });
const gate = (variant: string, def: Json): GateProgram => ({ variant, program: (language) => wrap(language, { Gate: def }) });
const constOf = (value: Json): Json => ({ kind: "const", value });
const agentOf = (extra: Program): Json => ({ kind: "agent", caps: [], skills: {}, ...extra });
const workflowOf = (extra: Program): Json => ({ kind: "workflow", params: [], returns: { ref: "Bool" }, caps: [], body: [], ...extra });
const skillOf = (extra: Program): Json => ({ params: [], returns: { ref: "Bool" }, effects: [], ...extra });

/** A program for each row of the SINCE tables, by `table.key`. A row without an entry here fails the test. */
export const GATE_PROGRAMS: Record<string, GateProgram[]> = {
  "kinds.component": [gate("", { kind: "component", repo: "acme/core", root: "/work/core", lang: "other", owner: "unassigned" })],
  "kinds.interface": [gate("", { kind: "interface", protocol: "openapi", spec: "docs/openapi.json" })],
  "kinds.environment": [gate("", { kind: "environment", class: "internal" })],
  "kinds.role": [gate("", { kind: "role", description: "Platform lead" })],
  "ops.changeset": [gate("", constOf({ op: "changeset", plan: V("p"), members: { core: { effect: "git.merge", args: [] } }, order: ["core"], approver: "architect" }))],
  "ops.map": [gate("", constOf({ op: "map", bind: "r", over: V("rs"), body: [] }))],
  "ops.plan": [gate("", constOf({ op: "plan", agent: "Lead", skill: "finish", args: [] }))],
  "agentFields.loop": [gate("", agentOf({ loop: "react" }))],
  "agentFields.progress": [gate("", agentOf({ progress: { window: 4, repeats: 2 } }))],
  "workflowFields.envelope": [gate("", workflowOf({ envelope: { owner: "lead" } }))],
  "budgetFields.agents": [
    gate("workflow budget", workflowOf({ budget: { agents: 3 } })),
    gate("agent budget", agentOf({ budget: { agents: 3 } })),
    gate("skill budget", agentOf({ skills: { run: skillOf({ budget: { agents: 3 } }) } })),
    gate("delegation budget", constOf({ op: "delegate", agent: "Worker", skill: "go", args: [], budget: { agents: 3 } })),
    gate("envelope budget", workflowOf({ envelope: { budget: { agents: 3 } } })),
  ],
};

/** A rule of validate.ts that is not a row of a table: programs, and the languages it refuses them in and accepts them in. */
export interface RuleGate {
  rule: string;
  cases: Array<{ label: string; program: (language: string) => Program; refused: string[]; accepted: string[] }>;
}

const ALL = ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4", "mandate/0.5"];
const progress = (window: number, repeats: number): ((l: string) => Program) => (l) => wrap(l, { Gate: agentOf({ progress: { window, repeats } }) });
const literal = (value: Json): ((l: string) => Program) => (l) => wrap(l, { Gate: constOf(value) });
/** Refused from 0.5, accepted before. */
const FROM_0_5 = { refused: ["mandate/0.5"], accepted: ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4"] };

export const RULE_GATES: RuleGate[] = [
  {
    rule: "agent progress.repeats over progress.window",
    cases: [
      { label: "repeats equal to window", program: progress(4, 4), refused: [], accepted: ["mandate/0.5", "mandate/0.2"] },
      { label: "repeats 5 over window 4", program: progress(4, 5), refused: ["mandate/0.5", "mandate/0.4", "mandate/0.2", "mandate/0.1"], accepted: [] },
    ],
  },
  {
    rule: "negative int literal",
    cases: [
      { label: "1", program: literal({ op: "int", value: 1 }), refused: [], accepted: ALL },
      { label: "-1", program: literal({ op: "int", value: -1 }), ...FROM_0_5 },
    ],
  },
  {
    rule: "negative dec literal",
    cases: [
      { label: "1.5", program: literal({ op: "dec", value: "1.5" }), refused: [], accepted: ALL },
      { label: "-1.5", program: literal({ op: "dec", value: "-1.5" }), ...FROM_0_5 },
      { label: "-0.0, which is zero but starts with a minus sign", program: literal({ op: "dec", value: "-0.0" }), refused: ["mandate/0.5"], accepted: ["mandate/0.4"] },
    ],
  },
  {
    rule: "negative money literal",
    cases: [
      { label: "1 micro", program: literal({ op: "money", micros: 1, currency: "USD" }), refused: [], accepted: ALL },
      { label: "-1 micro", program: literal({ op: "money", micros: -1, currency: "USD" }), ...FROM_0_5 },
    ],
  },
  {
    rule: "negative literal, written as a negation and deep in an expression",
    cases: [
      { label: "unary neg of 1", program: literal({ op: "unary", uop: "neg", of: { op: "int", value: 1 } }), refused: [], accepted: ["mandate/0.5"] },
      {
        label: "-3 as an operand in a list",
        program: literal({ op: "list", items: [{ op: "binary", bop: "+", left: { op: "int", value: 2 }, right: { op: "int", value: -3 } }] }),
        refused: ["mandate/0.5"],
        accepted: ["mandate/0.4"],
      },
    ],
  },
];
