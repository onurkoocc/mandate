// A program whose lead plans, and what a test needs to play its lead: the
// sub-programs it sends, written as text, and a scripted model for the lead
// and its workers. Shared by the tests of `plan` (plan.test.ts) and of the
// schedulers that drive a run through one (temporal.test.ts).

import { load, type Program } from "@mandate/compiler";
import { expect } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { baseOf } from "../src/plan.js";
import { SimChat, toolUse, type SimTurn } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";

export const MODULE = "test.plan";

/**
 * A 0.4 workflow whose envelope lets it read and write below /work/repos, and whose lead plans what to do with a
 * list of items. A test gives the envelope's budget, its other lines and the workflow's body where they matter.
 */
export const program = (o: { budget?: string; spawn?: string; approve?: string; body?: string } = {}): string => `mandate @ 0.4

module ${MODULE} @ 0.1

use std.{fs, git, model}

role platform_lead   "Platform lead"
role release_manager "Release manager"

type Item = { name: Text }

capability RepoRead = fs.read("/work/repos")
capability SrcWrite = fs.write("/work/repos")
capability ModelStd = model.infer(tier: standard)
capability Merge    = git.pr("company/backend")

agent Worker {
  role   "Fixes one item."
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 3k, steps: 4 }
  skill fix(i: Item) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

agent Lead {
  role   "Plans what is left."
  caps   RepoRead, ModelStd
  budget { tokens: 60k, steps: 30 }
  skill finish(items: List<Item>) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow W(items: List<Item>) -> Inferred<Text>
  envelope {
    owner   platform_lead
    caps    RepoRead, SrcWrite, ModelStd, Merge
    budget  ${o.budget ?? "{ tokens: 200k, steps: 400, agents: 12 }"}${o.spawn ? `\n    spawn   ${o.spawn}` : ""}${o.approve ? `\n    approve ${o.approve}` : ""}
  }
{
${o.body ?? "  plan Lead.finish(items) within envelope"}
}
`;

export const PLAN = "/defs/W/body/0/value";
export const programAt = (n: number, plan = PLAN): string => `${plan}/program/${n}`;
/** The step of the lead's loop that its `turn`th turn's tool call is, counting turns from 1. */
export const toolStep = (turn: number, plan = PLAN): string => `${plan}/step/${turn - 1}/tool/0`;

/** The definitions of a sub-program, written as text, as the operations a lead sends. */
export function ops(defs: string): Value[] {
  const r = load(`mandate @ 0.4\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries((r.program as Program).defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
}

/** The base of the lead's `n`th sub-program. */
export const base = (n: number): string => baseOf(MODULE, n);

export const CAPS = "RepoRead, SrcWrite, ModelStd";
export const BUDGET = "{ tokens: 20k, steps: 40, agents: 4 }";

/** A sub-program whose workflow has this body. */
export const sub = (body: string, budget = BUDGET, caps = CAPS, name = "Fix"): string => `workflow ${name}() -> Inferred<Text>\n  caps   ${caps}\n  budget ${budget}\n{\n${body}\n}`;

/** A sub-program that hands each named item to a worker, one after the other. */
export const fixes = (names: string[], budget = BUDGET, caps = CAPS): string => sub(names.map((n) => `  delegate Worker.fix(Item { name: "${n}" })`).join("\n"), budget, caps);

/** A sub-program that fixes an item and then comments on it: a critical effect, with a business key. */
export const commenting = (item: string, text: string, key = `"${item}"`): string =>
  sub(`  let note = delegate Worker.fix(Item { name: "${item}" })\n  effect git.comment(Item { name: "${item}" }, "${text}")\n    idempotent_by ${key}\n  note`, BUDGET, `${CAPS}, Merge`);

// ── the model ───────────────────────────────────────────────────────────

/** One turn of the lead: what it says, or what it does to find out. */
export type Turn = SimTurn | ((req: TurnRequest) => SimTurn | Promise<SimTurn>);

export const submit = (n: number, defs: string): SimTurn => [toolUse(`s${n}`, "submit_program", { base: base(n), ops: ops(defs) })];
export const check = (n: number, defs: string): SimTurn => [toolUse(`c${n}`, "check_program", { base: base(n), ops: ops(defs) })];
export const finish = (result = "done"): SimTurn => [toolUse("done", "finish", { result })];

/** The item a worker was handed. */
export const itemOf = (req: TurnRequest): string => /\\"name\\":\\"([^"\\]+)\\"/.exec(JSON.stringify(req.messages[0]))?.[1] ?? "?";
/** A worker's one turn: it says which item it fixed. */
export const fixed = (req: TurnRequest): SimTurn => [toolUse("w1", "finish", { result: `fixed ${itemOf(req)}` })];

/** What the lead's last tool call answered, when the turn before this one made one. */
export function answered(req: TurnRequest): Obj | undefined {
  const last = req.messages.at(-1) as { role: string; content: Array<{ type: string; content?: string }> };
  const result = last.role === "user" ? last.content.find((b) => b.type === "tool_result") : undefined;
  return result?.content?.startsWith("{") ? (JSON.parse(result.content) as Obj) : undefined;
}

/**
 * The model of a run with one lead: `lead` is the lead's turns in order, and `told` is filled with what each of
 * its tool calls answered. Any other agent is a worker, which finishes at once unless the test says what it does.
 */
export function leadChat(lead: Turn[], worker: (req: TurnRequest) => SimTurn | Promise<SimTurn> = fixed): { chat: SimChat; told: Obj[] } {
  const told: Obj[] = [];
  let turns = 0;
  const chat = new SimChat((req) => {
    if (req.agent !== "Lead") return worker(req);
    const answer = answered(req);
    if (answer) told.push(answer);
    const turn = lead[turns++];
    if (turn === undefined) throw new Error(`the lead has no turn ${turns}`);
    return typeof turn === "function" ? turn(req) : turn;
  });
  return { chat, told };
}
