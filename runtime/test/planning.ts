// A program whose lead plans, and what a test needs to play its lead: the
// sub-programs it sends, written as text, and a scripted model for the lead
// and its workers. Shared by the tests of `plan` (plan.test.ts) and of the
// schedulers that drive a run through one (temporal.test.ts).

import { load, type Program } from "@mandate/compiler";
import { expect } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { baseOf, type ProgramChecker } from "../src/plan.js";
import type { RuntimeOptions } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, SimSandboxHost, toolUse, type SimModel, type SimTool, type SimTurn } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { world, type World } from "./helpers.js";

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

/**
 * A 0.4 program over two components the release manager owns, with a contract a change to one is verified against:
 * what a change set needs. A test gives the envelope's budget and the workflow's body where they matter.
 */
export const landing = (o: { budget?: string; body?: string } = {}): string => `mandate @ 0.4

module ${MODULE} @ 0.1

use std.{component, fs, git, model}

role platform_lead   "Platform lead"
role release_manager "Release manager"

type Item = { name: Text }
type Change = { files: List<Text> }

contract ChangeAccepted(change: Change) {
  accept listed "The change names its files" by static len(change.files) >= 1
}

component left {
  repo  "acme/left"
  root  "/work/left"
  lang  ts
  owner role "release_manager"
}

component right {
  repo  "acme/right"
  root  "/work/right"
  lang  ts
  owner role "release_manager"
}

capability Repos    = component.repo(left, right)
capability RepoRead = fs.read("/work")
capability ModelStd = model.infer(tier: standard)

agent Lead {
  role   "Plans what is left."
  caps   RepoRead, ModelStd
  budget { tokens: 60k, steps: 30 }
  skill finish(items: List<Item>) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow W(items: List<Item>) -> Inferred<Text>
  envelope {
    owner   platform_lead
    caps    RepoRead, ModelStd, Repos
    budget  ${o.budget ?? "{ tokens: 200k, steps: 400, agents: 12 }"}
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

// ── the people and the model ────────────────────────────────────────────

export interface Planned extends World {
  chat: SimChat;
  host: SimSandboxHost;
  alice: EvidenceSigner;
  bob: EvidenceSigner;
  /** What each of the lead's tool calls answered, in order. */
  told: Obj[];
}

/**
 * The program on a runtime where Alice, the platform lead, has approved its envelope, and Bob is the release
 * manager. `lead` is the lead's turns in order; a worker finishes at once, saying which item it fixed.
 */
export async function planned(checker: ProgramChecker, lead: Turn[], o: { src?: string; worker?: (req: TurnRequest) => SimTurn | Promise<SimTurn>; plan?: RuntimeOptions["plan"]; tools?: SimTool[]; model?: SimModel } = {}): Promise<Planned> {
  const alice = EvidenceSigner.generate();
  const bob = EvidenceSigner.generate();
  const lock = { modules: {}, members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } }, roles: { platform_lead: ["alice"], release_manager: ["bob"] } };
  const w = await world(o.src ?? program(), { lock, decisions: { keys: new TrustedKeys([alice.publicKey, bob.publicKey]) }, plan: o.plan ?? { checker }, ...(o.tools ? { tools: o.tools } : {}), ...(o.model ? { model: o.model } : {}) });
  const host = new SimSandboxHost();
  const { chat, told } = leadChat(lead, o.worker);
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
  return { ...w, chat, host, alice, bob, told };
}

export const ITEMS: Obj[] = [{ name: "a" }, { name: "b" }];

export const run = (w: World, runId: string, o: Partial<Parameters<World["rt"]["startRun"]>[0]> = {}): Promise<RunRow> => w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { items: ITEMS }, runId, ...o });

export const events = async (w: World, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);

/** The diagnostics a tool call answered with, as code, path and facts. */
export const refusals = (answer: Obj | undefined): unknown[] => ((answer?.["diagnostics"] ?? []) as Obj[]).filter((d) => d["severity"] === "error").map((d) => [d["code"], d["path"] ?? null, d["facts"] ?? null]);

export const state = (r: RunRow): string => `${r.state} ${JSON.stringify(r.error ?? r.attention ?? r.waiting ?? null)}`;

export async function sign(w: Planned, runId: string, who: "alice" | "bob", kind: "approve" | "decline") {
  return signDecision(w[who], await w.rt.shown(runId, "wait"), { kind, member: who, at: new Date(w.adapters.clock.now()) });
}
let n = 0;
export const msg = (): { sender: string; messageId: string } => ({ sender: "test", messageId: `m${++n}` });

/** A workflow whose two branches each run a lead. */
export const BRANCHES = `  par {\n    one = plan Lead.finish(items) within envelope\n    two = plan Lead.finish(items) within envelope\n  }\n  one`;
export const ONE = "/defs/W/body/0/branches/one";
export const TWO = "/defs/W/body/0/branches/two";

/**
 * Plays the leads of a run by where each one runs: `turns` gives each lead's turns in order, under a prefix of
 * its command. Returns what each lead's tool calls answered. Any other agent is a worker.
 */
export function leads(w: Planned, turns: Record<string, Turn[]>, worker: (req: TurnRequest) => SimTurn | Promise<SimTurn> = fixed): Record<string, Obj[]> {
  const told: Record<string, Obj[]> = Object.fromEntries(Object.keys(turns).map((at) => [at, []]));
  w.chat["script" as never] = (async (req: TurnRequest) => {
    if (req.agent !== "Lead") return worker(req);
    const at = Object.keys(turns).find((prefix) => req.commandId.startsWith(prefix))!;
    const answer = answered(req);
    if (answer) told[at]!.push(answer);
    const turn = turns[at]!.shift()!;
    return typeof turn === "function" ? turn(req) : turn;
  }) as never;
  return told;
}
