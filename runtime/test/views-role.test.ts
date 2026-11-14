// Views by role and the audit view (spec/boundary.md "Views by role and the audit view"; G23, INV-17). A role sees
// what was asked of it, how the run ended and what stopped it, and its progress, and nothing else: no other role's
// decision, no step's request or result, no trace. Words planted where only those can carry them show it. The audit
// view shows everything, with every event and the chain's status, and is the one view that verifies the chain.

import { load, toHtml, toMarkdown, type WorkflowDef } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { eventClass, EVENT_CLASSES, SECTION_CLASSES } from "../src/classes.js";
import { payloadOf, signDecision, type DecisionKind } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { Runtime, type RuntimeOptions } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import type { WorkerChecker } from "../src/plan.js";
import { SimChat, SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { auditDoc, roleDoc, runView, type AuditView, type RoleView } from "../src/views.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { finish, msg as planMsg, planned, program, run } from "./planning.js";

afterAll(closeAll);

// ── the program and its people ──────────────────────────────────────────

const PROGRAM = `mandate @ 0.5

module test.views.roles @ 0.1

use std.{fs, human, model}

role approver "Approves the change"
role reviewer "Reviews the change"

capability RepoRead = fs.read("/work/repo")
capability SrcWrite = fs.write("/work/repo/src")
capability ModelStd = model.infer(tier: standard)

agent Fixer {
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 12 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

workflow W(task: Text, question: Text) -> Text
  caps   RepoRead, SrcWrite, ModelStd
  budget { spend: 2 USD }
{
  let fixed = delegate Fixer.apply(task)
  let heard = human.ask(question, role: reviewer)
  let go = human.ask("Ship it?", role: approver)
  "done"
}
`;

/** Words only a step's request or result, a trace, or the reviewer's decision can carry. */
const CANARY = {
  args: "canaryinargs",
  output: "canaryinoutput",
  result: "canaryinresult",
  violation: "canaryinviolation",
  other: "canaryinreviewerquestion",
  answer: "canaryinrevieweranswer",
  fault: "canaryinfault",
  input: "canaryininput",
};

const D = "/defs/W/body/0/value";

interface Roles extends World {
  chat: SimChat;
  alice: EvidenceSigner;
  bob: EvidenceSigner;
}

/** Alice approves, Bob reviews. The agent writes a file, reads one, and tries to read outside its grant, then finishes. */
async function roles(script?: (n: number) => SimTurn, options: RuntimeOptions = {}): Promise<Roles> {
  const alice = EvidenceSigner.generate();
  const bob = EvidenceSigner.generate();
  const lock = { modules: {}, members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } }, roles: { approver: ["alice"], reviewer: ["bob"] } };
  const keys = new TrustedKeys([alice.publicKey, bob.publicKey]);
  const w = await world(PROGRAM, { lock, decisions: { keys } });
  const host = new SimSandboxHost();
  host.files.set("/work/repo/src/b.ts", CANARY.output);
  const turns = (n: number): SimTurn =>
    n === 1
      ? [toolUse("t1", "write_file", { path: "/work/repo/src/a.ts", content: CANARY.args }), toolUse("t2", "read_file", { path: "/work/repo/src/b.ts" }), toolUse("t3", "read_file", { path: `/etc/${CANARY.violation}` })]
      : [toolUse("f", "finish", { result: CANARY.result })];
  const chat = new SimChat((_req: TurnRequest, n: number) => (script ?? turns)(n));
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { decisions: { keys }, ...options });
  return { ...w, rt, chat, alice, bob };
}

let n = 0;
const msg = () => ({ sender: "test", messageId: `m${++n}` });
const input = { task: `fix it ${CANARY.input}`, question: `${CANARY.other}: may it go on?` };

async function answer(w: Roles, runId: string, who: "alice" | "bob", text: string): Promise<RunRow> {
  const kind: DecisionKind = "answer";
  const signed = signDecision(w[who], await w.rt.shown(runId, "wait"), { kind, member: who, payload: payloadOf.answer(text), at: new Date(w.adapters.clock.now()) });
  return w.rt.submitInput(runId, msg(), { value: text, signed });
}

/** Every way a view is printed: its JSON, Markdown and HTML. */
async function printed(w: World, runId: string, audience: { role: string } | { audit: true }): Promise<string> {
  if ("role" in audience) {
    const { view, program } = await runView(w.rt, runId, audience);
    return [JSON.stringify(view), toMarkdown(roleDoc(view, program)), toHtml(roleDoc(view, program))].join("\n");
  }
  const { view, program } = await runView(w.rt, runId, audience);
  return [JSON.stringify(view), toMarkdown(auditDoc(view, program)), toHtml(auditDoc(view, program))].join("\n");
}

const role = async (w: World, runId: string, r: string): Promise<RoleView> => (await runView(w.rt, runId, { role: r })).view;
const audit = async (w: World, runId: string): Promise<AuditView> => (await runView(w.rt, runId, { audit: true })).view;

/** The run the tests share: the agent's trace and violation, the reviewer's answer, and the approver's question open. */
async function asked(runId: string): Promise<Roles> {
  const w = await roles();
  const first = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input, runId });
  expect(first.state).toBe("waiting");
  expect((await answer(w, runId, "bob", CANARY.answer)).state).toBe("waiting");
  return w;
}

// ── a role's view ───────────────────────────────────────────────────────

describe("a role's view (G23)", () => {
  it("shows the decision asked of the role, and none asked of another", async () => {
    const w = await asked("r1");
    const a = await role(w, "r1", "approver");
    expect(a).toMatchObject({ kind: "run_role", role: "approver", run: { id: "r1", state: "waiting" } });
    // The approver's question is open: it sees it whole, as it is asked.
    expect(a.waiting).toMatchObject({ kind: "input", request: { question: "Ship it?", role: "approver" } });
    // The reviewer's answer was asked of the reviewer.
    expect(a.decisions).toEqual([]);
    const r = await role(w, "r1", "reviewer");
    expect(r.waiting).toBeNull();
    expect(r.decisions).toMatchObject([{ kind: "answer", by: "bob", role: "reviewer", signature: "valid" }]);
    expect(toMarkdown(roleDoc(r, (await runView(w.rt, "r1")).program))).toContain("It waits for nothing asked of reviewer.");
    // Once the approver answers, each sees its own decision only.
    await answer(w, "r1", "alice", "yes");
    expect((await role(w, "r1", "approver")).decisions.map((d) => [d.kind, d.by, d.role])).toEqual([["answer", "alice", "approver"]]);
    expect((await role(w, "r1", "reviewer")).decisions.map((d) => [d.kind, d.by, d.role])).toEqual([["answer", "bob", "reviewer"]]);
  });

  it("carries no step's request or result, no trace, and nothing of another role's decision, in JSON, Markdown or HTML", async () => {
    const w = await asked("r2");
    const seen = await printed(w, "r2", { role: "approver" });
    for (const [where, word] of Object.entries(CANARY)) expect(seen, `the approver's view carries the word planted in the ${where}`).not.toContain(word);
    // The reviewer's view carries none of them either: its own question was the program's input, and is not open.
    const reviewer = await printed(w, "r2", { role: "reviewer" });
    for (const word of Object.values(CANARY)) expect(reviewer).not.toContain(word);
    // The words are there, and the audit view shows each.
    const all = await printed(w, "r2", { audit: true });
    for (const [where, word] of Object.entries(CANARY).filter(([k]) => k !== "fault")) expect(all, `the audit view carries the word planted in the ${where}`).toContain(word);
  });

  it("has the sections in S0 to S2 and no other, and of the budget's rows none of an agent loop's", async () => {
    const w = await asked("r3");
    const a = await role(w, "r3", "approver");
    expect(Object.keys(a)).toEqual(["format", "kind", "role", "program", "package", "run", "manifest", "modules", "as_of", "waiting", "decisions", "exceptions", "budget", "envelope", "maps"]);
    for (const section of Object.keys(a)) expect(["S0", "S1", "S2"]).toContain(SECTION_CLASSES[section]);
    for (const absent of ["result", "error", "attention", "evidence", "actions", "changesets", "plans", "input", "steps", "trace", "events", "chain", "halts"]) expect(a).not.toHaveProperty(absent);
    // The delegation's step is progress; its turns and tool calls are its trace.
    const kinds = (await runView(w.rt, "r3")).view.budget.commands.map((c) => c.kind);
    expect(kinds).toEqual(expect.arrayContaining(["turn", "tool"]));
    expect(a.budget.commands.map((c) => [c.command, c.kind])).toEqual([[D, "delegate"]]);
    expect(a.budget.dimensions).toEqual((await runView(w.rt, "r3")).view.budget.dimensions);
  });

  it("shows a violation by its kind, agent, step and count, never its detail", async () => {
    const w = await asked("r4");
    const a = await role(w, "r4", "approver");
    expect(a.exceptions.violations).toEqual([{ seq: expect.any(Number), at: expect.any(Number), kind: "authority_denied", delegate: D, agent: "Fixer", step: `${D}/step/0/tool/2`, count: 1 }]);
    expect((await audit(w, "r4")).exceptions.violations[0]!.detail).toBe(`read_file: /etc/${CANARY.violation} is outside what you may read (/work/repo, /work/repo/src)`);
  });

  it("shows the fault a run failed with by its tag, never its arguments", async () => {
    const w = await roles(() => ({ error: { tag: "SkillFailed", args: [CANARY.fault] }, cost: { steps: 1 } }));
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "W", input, runId: "r5" })).state).toBe("failed");
    const a = await role(w, "r5", "approver");
    expect(a.exceptions).toMatchObject({ fault: "SkillFailed", attention: null, halt: null });
    expect(await printed(w, "r5", { role: "approver" })).not.toContain(CANARY.fault);
    expect(toMarkdown(roleDoc(a, (await runView(w.rt, "r5")).program))).toContain("The fault: SkillFailed.");
    expect(JSON.stringify((await audit(w, "r5")).error)).toContain(CANARY.fault);
  });

  it("shows why a run needs attention by its codes, never its message", async () => {
    const w = await roles(undefined, { violations: { limit: 1 } });
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input, runId: "r6" });
    expect(stopped.attention).toMatchObject({ violation: "violation_limit" });
    const a = await role(w, "r6", "reviewer");
    expect(a.exceptions.attention).toEqual({ violation: "violation_limit", halted: null, reason: null, command: null, changeset_partial: false, actions: [] });
    const seen = await printed(w, "r6", { role: "reviewer" });
    expect(seen).not.toContain("reached its limit");
    expect(seen).toContain("It needs a person: the invariant violation violation\\_limit.");
  });

  it("shows the halt that ended the run: its id, who halted it, why, and the fence it revoked", async () => {
    const w = await roles();
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "W", input, runId: "r7", tenant: "acme" })).state).toBe("waiting");
    const fence = (await w.rt.getRun("r7")).fence;
    const h = await w.rt.halt({ tenant: "acme" }, { reason: "a made-up drill", by: "ops" });
    const a = await role(w, "r7", "approver");
    expect(a.run.state).toBe("cancelled");
    expect(a.exceptions.halt).toEqual({ halt: h.halt.halt_id, reason: "a made-up drill", by: "ops", fence, seq: expect.any(Number), at: h.halt.halted_at });
    // The halt's cancel is no member's decision.
    expect(a.decisions).toEqual([]);
    const md = toMarkdown(roleDoc(a, (await runView(w.rt, "r7")).program));
    expect(md).toContain(`The run was halted by ${h.halt.halt_id}, which ops made`);
    expect(md).toContain("a made-up drill");
  });

  it("is refused for a role the program does not name, by name", async () => {
    const w = await asked("r8");
    await expect(runView(w.rt, "r8", { role: "owner" })).rejects.toMatchObject({ code: "unknown_role", message: "unknown_role: Run r8's program names no role owner; it names approver, reviewer." });
  });
});

describe("a role's view of a run under an envelope", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(() => checker.close());

  it("shows the envelope's amendments, and its approval, to the role that owns it alone", async () => {
    const wider = program({ budget: "{ tokens: 400k, steps: 400, agents: 12 }" });
    const envelope = (load(wider, "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Value;
    const w = await planned(checker, [[toolUse("a1", "request_amendment", { envelope, reason: "more" })], finish("done")], { src: program({ body: "  plan Lead.finish(items) within envelope" }) });
    expect((await run(w, "env1")).state).toBe("waiting");
    const decided = await w.rt.decideAmendment("env1", planMsg(), signDecision(w.alice, await w.rt.shown("env1", "wait"), { kind: "amend", member: "alice", at: new Date(w.adapters.clock.now()) }));
    expect(decided.state).toBe("succeeded");
    const owner = await role(w, "env1", "platform_lead");
    expect(owner.envelope!.amendments).toHaveLength(1);
    expect(owner.decisions.map((d) => [d.kind, d.by, d.role])).toEqual([
      ["envelope", "alice", "platform_lead"],
      ["amend", "alice", "platform_lead"],
    ]);
    const other = await role(w, "env1", "release_manager");
    expect(other.envelope).toMatchObject({ workflow: "W", owner: "platform_lead", amendments: [] });
    expect(other.envelope!.remainder).toEqual(owner.envelope!.remainder);
    expect(other.decisions).toEqual([]);
    // What the lead wrote is a trace: no role sees the plan, nor the reason it gave.
    expect(owner).not.toHaveProperty("plans");
    expect(await printed(w, "env1", { role: "platform_lead" })).not.toContain('"reason"');
  });
});

// ── the audit view ──────────────────────────────────────────────────────

describe("the audit view", () => {
  it("shows the run's view whole, with its input, steps, trace, events and the halts over its tenant", async () => {
    const w = await asked("a1");
    const v = await audit(w, "a1");
    const { view } = await runView(w.rt, "a1");
    expect({ ...v, kind: "run" }).toMatchObject(JSON.parse(JSON.stringify(view)));
    expect(v.input).toEqual(input);
    expect(v.steps.map((c) => c.kind)).toEqual(expect.arrayContaining(["delegate", "input"]));
    expect(v.trace.map((c) => c.kind).sort()).toEqual(["tool", "tool", "turn", "turn"]);
    expect(JSON.stringify(v.steps.find((c) => c.command === D)!.result)).toContain(CANARY.result);
    // Every event the view reaches, in order, with its class, time and hash.
    const events = await w.db.query<{ seq: number; type: string; hash: string }>("select seq, type, hash from events where run_id = 'a1' order by seq");
    expect(v.events.map((e) => [e.seq, e.type, e.hash])).toEqual(events.map((e) => [Number(e.seq), e.type, e.hash]));
    for (const e of v.events) expect(e.class).toBe(eventClass(e.type));
    expect(v.halts).toEqual([]);
    const md = toMarkdown(auditDoc(v, (await runView(w.rt, "a1")).program));
    for (const heading of ["## Journal", "## Status", "## Input", "## Exceptions", "## Halts", "## Steps", "## Trace", "## Events", "## Decisions", "## Cost"]) expect(md).toContain(heading);
  });

  it("lists the halts in force and lifted that cover the run's tenant, and no other's", async () => {
    const w = await roles();
    await w.rt.startRun({ pkg: w.pkg, workflow: "W", input, runId: "a2", tenant: "acme" });
    const mine = await w.rt.halt({ tenant: "acme" }, { by: "ops" });
    await w.rt.liftHalt({ tenant: "acme" }, "ops");
    // Halts are listed oldest first.
    w.clock.advance(1000);
    await w.rt.halt({ tenant: "other" }, { by: "ops" });
    w.clock.advance(1000);
    const all = await w.rt.halt({ all: true }, { reason: "made-up" });
    expect((await audit(w, "a2")).halts.map((h) => [h.halt_id, h.lifted_by])).toEqual([
      [mine.halt.halt_id, "ops"],
      [all.halt.halt_id, null],
    ]);
  });

  it("says a clean run's chain is verified, and how far its signatures reach", async () => {
    const w = await asked("a3");
    const v = await audit(w, "a3");
    // The run waits: its last event is the state change, and anchored.
    expect(v.chain).toMatchObject({ run: "a3", status: "verified", anchored_through: v.as_of.event, unanchored: 0, findings: [] });
    expect(v.chain).toEqual(await w.rt.verifyJournal("a3"));
    const md = toMarkdown(auditDoc(v, (await runView(w.rt, "a3")).program));
    expect(md).toContain("verified: the chain holds and every state change is anchored.");
    expect(md).toContain(`Signed through event ${v.chain.anchored_through} by`);
  });

  it("says a tampered run's chain is broken, where", async () => {
    const w = await asked("a4");
    const seq = (await w.db.query<{ seq: number }>("select seq from events where run_id = 'a4' and type = 'wait_opened' order by seq limit 1"))[0]!.seq;
    await w.db.query("update events set data = jsonb_set(data, '{kind}', '\"edited\"') where run_id = 'a4' and seq = $1", [seq]);
    const v = await audit(w, "a4");
    expect(v.chain.status).toBe("broken");
    expect(v.chain.findings).toContainEqual({ code: "chain_broken", seq: Number(seq) });
    expect(toMarkdown(auditDoc(v, (await runView(w.rt, "a4")).program))).toContain("broken: the chain or its anchors do not hold.");
    // The other views read the run as it is, and say nothing of the chain.
    expect((await runView(w.rt, "a4")).view.run.state).toBe("waiting");
    expect((await role(w, "a4", "approver")).waiting).not.toBeNull();
  });

  it("says a run begun before the chain is unchained", async () => {
    const w = await asked("a5");
    await w.db.query("update events set hash = null where run_id = 'a5'");
    await w.db.query("delete from journal_anchors where run_id = 'a5'");
    const v = await audit(w, "a5");
    expect(v.chain).toMatchObject({ status: "unchained", anchored_through: null, findings: [] });
    expect(v.events.every((e) => e.hash === null)).toBe(true);
    expect(toMarkdown(auditDoc(v, (await runView(w.rt, "a5")).program))).toContain("unchained: the run began before its journal was chained");
  });
});

// ── the read path ───────────────────────────────────────────────────────

describe("the chain on the read path", () => {
  it("is verified by the audit view alone: the default view, a role's view, the events and a replay never check it", async () => {
    const w = await asked("p1");
    let verified = 0;
    const verify = w.rt.verifyJournal.bind(w.rt);
    w.rt.verifyJournal = async (runId: string) => {
      verified++;
      return verify(runId);
    };
    await runView(w.rt, "p1");
    await runView(w.rt, "p1", { role: "approver" });
    await w.rt.journal.events("p1");
    await w.rt.replayRun("p1");
    expect(verified).toBe(0);
    await runView(w.rt, "p1", { audit: true });
    expect(verified).toBe(1);
  });
});

// ── the events of real runs ─────────────────────────────────────────────

describe("the events of these runs", () => {
  it("each have a class of their own in the table", async () => {
    const w = await asked("e1");
    await answer(w, "e1", "alice", "yes");
    const types = new Set((await w.db.query<{ type: string }>("select distinct type from events")).map((r) => r.type));
    expect([...types].filter((t) => !Object.hasOwn(EVENT_CLASSES, t))).toEqual([]);
    expect(types).toContain("violation");
    expect(types).toContain("wait_opened");
  });
});


