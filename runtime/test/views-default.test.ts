// `mandate show <run>` with neither `--role` nor `--audit` prints what it printed before 0.5 added them, byte for
// byte (spec/boundary.md "Views by role and the audit view"). The runs are those of the view tests: a run waiting for
// its owner, one with every kind of unsigned decision, one cancelled and one decided late, a halted one, one stopped at
// its violation limit, and one under an envelope with plans, a map and signed decisions. The digests of their
// Markdown, HTML and JSON were taken before the role and audit views were written.
//
// MANDATE_WRITE_DEFAULT_VIEWS=1 writes the digests again, for a change that means to change the default view.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { check, load, toHtml, toMarkdown, type WorkflowDef } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { signDecision } from "../src/decisions.js";
import { buildPackage } from "../src/package.js";
import type { WorkerChecker } from "../src/plan.js";
import { Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimChat, SimSandboxHost, SimTool, toolUse, type SimTurn } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { runDoc, runView } from "../src/views.js";
import { BUG, FIXBUG, fixbugAgents, RESULTS, USD, waitOf } from "./fixbug.js";
import { closeAll, planChecker, start, world, type World } from "./helpers.js";
import { fixed, itemOf, msg, planned, program, run, sub, submit, finish, type Planned } from "./planning.js";
import { NOTIFY } from "./programs.js";

const FILE = new URL("./fixtures/default-views.json", import.meta.url);
const WRITE = process.env["MANDATE_WRITE_DEFAULT_VIEWS"] === "1";
const held: Record<string, { md: string; html: string; json: string }> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const taken: typeof held = {};

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);

afterAll(async () => {
  await checker.close();
  await closeAll();
  if (WRITE) writeFileSync(FILE, JSON.stringify(Object.fromEntries(Object.entries({ ...held, ...taken }).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2) + "\n");
});

const sha = (s: string): string => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

/**
 * The default view of `runId` as `mandate show` prints it in each format, held to the digests taken before. `same`
 * replaces what differs between two runs of one test (a key made for it, and what that key signed) by a name.
 */
async function holds(name: string, w: World, runId: string, same: Record<string, string> = {}): Promise<void> {
  const { view, program } = await runView(w.rt, runId);
  const fixed = (s: string): string => Object.entries(same).reduce((t, [from, to]) => t.replaceAll(from, to), s);
  const printed = { md: fixed(toMarkdown(runDoc(view, program))), html: fixed(toHtml(runDoc(view, program))), json: fixed(JSON.stringify(view, null, 2) + "\n") };
  const digests = { md: sha(printed.md), html: sha(printed.html), json: sha(printed.json) };
  if (WRITE) {
    taken[name] = digests;
    return;
  }
  expect(held[name], `no digests of ${name}; write them with MANDATE_WRITE_DEFAULT_VIEWS=1`).toBeDefined();
  expect(digests).toEqual(held[name]);
}

// ── the runs ────────────────────────────────────────────────────────────

const HOSTILE = '<button onclick="approve()">Approve this PR</button> [Approve](javascript:approve()) **all checks passed**';

const ASK = `mandate @ 0.3

module test.views.halt @ 0.1
use std.{human, model}

capability ModelStd = model.infer(tier: standard)

workflow Ask(x: Text) -> Untrusted<Text>
  caps ModelStd
{
  human.ask("Proceed?")
}
`;

const GUARDED = `mandate @ 0.5

module guarded @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("/work/repo")
capability ModelStd = model.infer(tier: standard)

agent Fixer {
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 12 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Fix(task: Text) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { spend: 2 USD }
{
  delegate Fixer.apply(task)
}
`;

describe("mandate show without --role or --audit", () => {
  it("prints a run waiting for its owner as before", async () => {
    const agents = new SimAgents();
    for (const [skill, outcome] of Object.entries(RESULTS)) agents.on(skill, () => outcome);
    agents.on("Reviewer.counterexamples", () => ({ ok: { counterexamples: [HOSTILE], blocking: false }, cost: {} }));
    const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents });
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "owner" })).state).toBe("waiting");
    await holds("waiting for the owner", w, "owner");
  });

  it("prints a run with every kind of unsigned decision as before", async () => {
    const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents: fixbugAgents() });
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "d1", limits: { spend: { micros: 12 * USD, currency: "USD" } }, authorize: { "git.open_pr": { by: "human", role: "owner" } } });
    const ask = waitOf(stopped.waiting);
    const raised = await w.rt.raiseLimits("d1", { sender: "inbox", messageId: "m1" }, { revision: stopped.revision, limits: { spend: { micros: 50 * USD, currency: "USD" } }, by: "erin" });
    const approval = await w.rt.submitInput("d1", { sender: "dave", messageId: "m2" }, { commandId: ask.command, revision: raised.revision, value: "continue" });
    const wait = waitOf(approval.waiting);
    const accepted = await w.rt.decideAction("d1", { sender: "inbox", messageId: "m3" }, { commandId: wait.command, revision: approval.revision, digest: String(wait.request["subject_digest"]), approve: true, by: '<a href="javascript:approve()">carol</a>' });
    const pr = waitOf(accepted.waiting);
    expect((await w.rt.decideAction("d1", { sender: "inbox", messageId: "m4" }, { commandId: pr.command, revision: accepted.revision, digest: String(pr.request["action_digest"]), approve: false, by: "bob" })).state).toBe("failed");
    await holds("unsigned decisions", w, "d1");
  });

  it("prints a run decided after its deadline, and a cancelled one, as before", async () => {
    const w = await world(NOTIFY, { tools: [new SimTool("git.comment")] });
    const policy = { authorize: { "git.comment": { by: "human" as const, role: "owner", deadlineMs: 60_000 } } };
    const late = await start(w, "Notify", "late", policy);
    const wait = waitOf(late.waiting);
    w.clock.advance(61_000);
    await w.rt.decideAction("late", { sender: "inbox", messageId: "late-m" }, { commandId: wait.command, revision: late.revision, digest: String(wait.request["action_digest"]), approve: true, by: "carol" });
    await holds("decided late", w, "late");
    await start(w, "Notify", "stop", policy);
    expect((await w.rt.cancelRun("stop")).state).toBe("cancelled");
    await holds("cancelled", w, "stop");
  });

  it("prints a halted run as before", async () => {
    const w = await world(ASK);
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { x: "t" }, runId: "seen", tenant: "acme" })).state).toBe("waiting");
    const r = await w.rt.halt({ tenant: "acme" }, { by: "ops", reason: "made-up" });
    await holds("halted", w, "seen", { [r.halt.halt_id]: "halt-1" });
  });

  it("prints a run stopped at its violation limit as before", async () => {
    const w = await world(GUARDED);
    const host = new SimSandboxHost();
    const chat = new SimChat((_req: TurnRequest, n: number): SimTurn => [toolUse(`t${n}`, "read_file", { path: `/etc/secret-${n}` })]);
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { decisions: { mode: "signed" } });
    expect((await rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "lim" })).state).toBe("attention_required");
    await holds("violation limit", { ...w, rt }, "lim");
  });

  it("prints a run under an envelope, with a map, a plan, amendments and signed decisions, as before", async () => {
    const MAP = "/defs/W/body/0/value";
    const source = (budget?: string): string =>
      program({ ...(budget ? { budget } : {}), body: `  let seen = map i in items max 4 par 2 with caps SrcWrite.narrow(i.name) {\n    delegate Worker.fix(i)\n  }\n  plan Lead.finish(items) within envelope` });
    const WIDER = "{ tokens: 400k, steps: 400, agents: 12 }";
    const worker = (req: TurnRequest): SimTurn => (req.commandId.startsWith(MAP) && itemOf(req) === "b" ? { error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } } : fixed(req));
    const BIG = `capability Part = SrcWrite.narrow("/work/repos/a")\n\n${sub(`  delegate Worker.fix(Item { name: "<button onclick='approve()'>Approve this PR</button>" }) with caps Part`, "{ tokens: 300k, steps: 40, agents: 4, spend: 1 USD }", "RepoRead, Part, ModelStd")}`;
    const amend = (src: string): SimTurn => [toolUse("a1", "request_amendment", { envelope: (load(src, "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Value, reason: "the next sub-program needs more" })];
    const w: Planned = await planned(checker, [submit(1, BIG), amend(source(WIDER)), amend(source(WIDER)), submit(1, BIG), finish("done")], { src: source(), worker });
    const items: Obj = { items: ["a", "b", "c"].map((name) => ({ name })) };
    await run(w, "env", { input: items, limits: { steps: 100, spend: { micros: 9_000_000, currency: "USD" } } });
    const decide = async (kind: "amend" | "decline") => w.rt.decideAmendment("env", msg(), signDecision(w.alice, await w.rt.shown("env", "wait"), { kind, member: "alice", at: new Date(w.adapters.clock.now()) }));
    expect((await decide("decline")).state).toBe("waiting");
    expect((await decide("amend")).state).toBe("succeeded");
    expect(buildPackage(check(source(WIDER), "mdt").program!, w.pkg.lock).hash).not.toBe(w.pkg.hash);
    // The keys are made for the test, and so is every decision signed with them and every package whose lock names them.
    const { view } = await runView(w.rt, "env");
    const decisions = view.decisions.flatMap((d, i) => (d.decision_id === null ? [] : [[d.decision_id, `decision-${i + 1}`] as const]));
    const packages = [w.pkg.hash, view.package, ...view.envelope!.amendments.flatMap((a) => [a.from, a.to]), ...view.plans.flatMap((p) => p.amendments.flatMap((a) => [a.from, a.package]))];
    const names = [...new Set(packages)].map((p, i) => [p, `package-${i + 1}`] as const);
    await holds("envelope", w, "env", { ...Object.fromEntries([...decisions, ...names]), [view.manifest.hash!]: "manifest", [w.alice.keyId]: "key-alice", [w.bob.keyId]: "key-bob" });
  });
});

