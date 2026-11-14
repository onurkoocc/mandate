// Envelopes at run time (0.4; spec/envelope.md "Approving an envelope" and
// "The ledger"; cases H03 and the first half of N02). A workflow with an
// envelope starts only on its owner's signed approval of the package. Every
// delegation attempt is one of the envelope's agents, reserved when it is
// dispatched. At most `max_concurrent` delegations are in flight. An effect
// under `approve` is authorized only by a decision of the role named there.
// Each rule is shown by one run or one record that breaks it.

import { card, check, link, LOCK_FORMAT, rolesNamed, type Lock as LockFile } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { DECISION_FORMAT, payloadOf, shownPackage, signDecision, type DecisionKind, type DecisionRecord, type SignedDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { buildPackage, Runtime, type Package } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimChat, SimSandboxHost, SimTool, toolUse } from "../src/sim.js";
import { isObj, type Obj, type Value } from "../src/values.js";
import { acmeModules, lockFor } from "./acme.js";
import { LAND } from "./acme-changeset.js";
import { closeAll, until, world, type World } from "./helpers.js";
import { FIX, ISSUE as DOMAIN_ISSUE } from "./programs.js";

afterAll(closeAll);

// ── the program ─────────────────────────────────────────────────────────

/** A 0.4 workflow with an envelope of five agents, and the body, spawn and approve lines a test gives it. */
const program = (o: { body: string; agents?: number; spawn?: string; approve?: string; returns?: string }): string => `mandate @ 0.4

module test.envelope @ 0.1

use std.{git, model}

role platform_lead   "Platform lead"
role release_manager "Release manager"

capability PR       = git.pr("company/backend")
capability ModelStd = model.infer(tier: standard)

type Issue = { id: Text }

agent Worker {
  caps   ModelStd
  budget { tokens: 1k, steps: 5 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Model}
  skill test(issue: Issue) -> Inferred<Text> ! {Model}
  skill lint(issue: Issue) -> Inferred<Text> ! {Model}
}

agent Spare {
  caps   ModelStd
  budget { tokens: 1k, steps: 5 }
  skill test(issue: Issue) -> Inferred<Text> ! {Model}
}

workflow W(issue: Issue) -> ${o.returns ?? "Inferred<Text>"}
  envelope {
    owner   platform_lead
    caps    PR, ModelStd
    budget  { tokens: 10k, steps: 40, agents: ${o.agents ?? 5} }${o.spawn ? `\n    spawn   ${o.spawn}` : ""}${o.approve ? `\n    approve ${o.approve}` : ""}
  }
{
${o.body}
}
`;

const ONE = program({ body: "  delegate Worker.fix(issue)" });

const PAR = `  par {
    tests = delegate Worker.test(issue)
    patch = delegate Worker.fix(issue)
  }
  patch + tests`;

const ISSUE = { issue: { id: "BUG-7" } };

// ── the people ──────────────────────────────────────────────────────────

interface Person {
  member: string;
  key: EvidenceSigner;
}

/**
 * Alice is the platform lead, who owns the envelope. Bob is the release
 * manager. Carol is a member with no role. Mallory has a key the runtime
 * knows and the lock lists under nobody; nobody has heard of the stranger's.
 */
function people() {
  const key = () => EvidenceSigner.generate();
  const alice = { member: "alice", key: key() };
  const bob = { member: "bob", key: key() };
  const carol = { member: "carol", key: key() };
  const mallory = { member: "mallory", key: key() };
  const stranger = { member: "alice", key: key() };
  const members = { alice: { keys: [alice.key.keyId] }, bob: { keys: [bob.key.keyId] }, carol: { keys: [carol.key.keyId] } };
  const roles = { platform_lead: ["alice"], release_manager: ["bob"] };
  const keys = new TrustedKeys([alice, bob, carol, mallory].map((p) => p.key.publicKey));
  return { alice, bob, carol, mallory, stranger, members, roles, keys };
}

type People = ReturnType<typeof people>;

interface Enveloped extends World {
  who: People;
}

/** The program on a runtime that knows the people's keys, packaged with a lock that binds them. Nothing is approved yet. */
async function setup(src: string, o: Parameters<typeof world>[1] = {}): Promise<Enveloped> {
  const who = people();
  const w = await world(src, { ...o, lock: { modules: {}, members: who.members, roles: who.roles }, decisions: { keys: who.keys } });
  return { ...w, who };
}

/** `who`'s signed approval of the package's envelope; `change` makes the record say something else before it is signed. */
function approval(w: { pkg: Package; adapters: World["adapters"] }, who: Person, o: { role?: string; kind?: DecisionKind; change?: (r: DecisionRecord) => DecisionRecord } = {}): SignedDecision {
  const signed = signDecision(who.key, shownPackage(w.pkg.hash, o.role ?? "platform_lead"), { kind: o.kind ?? "envelope", member: who.member, at: new Date(w.adapters.clock.now()) });
  if (!o.change) return signed;
  const record = o.change(signed.record);
  return { record, signature: who.key.signStatement(DECISION_FORMAT, record as unknown as Value).signature };
}

/** The program with its envelope approved by Alice. */
async function approved(src: string, o: Parameters<typeof world>[1] = {}): Promise<Enveloped> {
  const w = await setup(src, o);
  await w.rt.approveEnvelope(w.pkg, approval(w, w.who.alice));
  return w;
}

const run = (w: World, runId: string, o: Partial<Parameters<Runtime["startRun"]>[0]> = {}): Promise<RunRow> => w.rt.startRun({ pkg: w.pkg, workflow: "W", input: ISSUE, runId, ...o });

const count = async (w: World, table: string): Promise<number> => Number((await w.db.query<{ n: number }>(`select count(*) as n from ${table}`))[0]!.n);

const events = async (w: World, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);

let n = 0;
const msg = (sender = "cli") => ({ sender, messageId: `e${++n}` });

/** `who`'s signed record of a decision on what the run shows now. */
async function sign(w: World, runId: string, who: Person, kind: DecisionKind, o: { payload?: string; about?: "wait" | "run" } = {}): Promise<SignedDecision> {
  return signDecision(who.key, await w.rt.shown(runId, o.about ?? "wait"), { kind, member: who.member, ...(o.payload !== undefined ? { payload: o.payload } : {}), at: new Date(w.adapters.clock.now()) });
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const text = (s: string) => () => ({ ok: s, cost: { steps: 1 } });

// ── H03 ─────────────────────────────────────────────────────────────────

describe("H03: a run under an envelope starts only on its owner's approval of the package", () => {
  it("does not start without an approval, and leaves nothing behind (unapproved_envelope)", async () => {
    const w = await setup(ONE);
    await expect(run(w, "h3-none")).rejects.toMatchObject({ code: "unapproved_envelope" });
    expect(await count(w, "runs")).toBe(0);
    expect(await count(w, "events")).toBe(0);
    expect(w.agents.count()).toBe(0);
  });

  it("starts once a member of the owner role approved, says under which approval, and one approval serves every run", async () => {
    const w = await setup(ONE);
    const { alice } = w.who;
    const decision = await w.rt.approveEnvelope(w.pkg, approval(w, alice));
    // The approval is about the package and no run.
    expect(await w.db.query("select package_hash, run_id, command_id, kind, member, role from decisions")).toEqual([
      { package_hash: w.pkg.hash, run_id: null, command_id: null, kind: "envelope", member: "alice", role: "platform_lead" },
    ]);

    const first = await run(w, "h3-a");
    expect(first.state, JSON.stringify(first.error ?? first.attention)).toBe("succeeded");
    const under = { decision, member: "alice", role: "platform_lead", key: alice.key.keyId };
    expect(first.manifest).toMatchObject({ package: w.pkg.hash, envelope_approval: under });
    expect(await events(w, "h3-a", "envelope_approved")).toEqual([{ package: w.pkg.hash, ...under }]);
    // The run's decisions begin with the approval it started under, checked again.
    expect((await w.rt.verifyDecisions("h3-a")).map((d) => [d.decision_id, d.record.kind, d.valid])).toEqual([[decision, "envelope", true]]);

    const second = await run(w, "h3-b");
    expect(second.state).toBe("succeeded");
    expect((second.manifest as Obj)["envelope_approval"]).toEqual(under);
    // Approving again with the same record stores nothing new.
    expect(await count(w, "decisions")).toBe(1);
  });

  // [what is wrong with the approval, who signs it, how the record differs, the reason it is refused for]
  const REFUSED: Array<[string, keyof People & ("alice" | "bob" | "carol" | "mallory" | "stranger"), Parameters<typeof approval>[2], string]> = [
    ["a member who does not hold the owner role", "carol", {}, "not_in_role"],
    ["a member deciding in a role that owns no envelope", "bob", { role: "release_manager" }, "not_in_role"],
    ["an approval made in no role", "alice", { change: ({ role: _role, ...r }) => r }, "not_in_role"],
    ["a key the lock lists under nobody", "mallory", {}, "unknown_key"],
    ["a key the runtime does not know", "stranger", {}, "unknown_key"],
    ["an approval of another package", "alice", { change: (r) => ({ ...r, package: `sha256:${"ab".repeat(32)}`, subject: `sha256:${"ab".repeat(32)}` }) }, "subject_mismatch"],
    ["a subject that is not the package hash", "alice", { change: (r) => ({ ...r, subject: `sha256:${"cd".repeat(32)}` }) }, "subject_mismatch"],
    ["a decision of another kind", "alice", { kind: "approve" }, "subject_mismatch"],
    ["a record that names a run", "alice", { change: (r) => ({ ...r, run: "some-run" }) }, "subject_mismatch"],
    ["a record that names a revision", "alice", { change: (r) => ({ ...r, revision: 1 }) }, "subject_mismatch"],
    ["a record that names a command", "alice", { change: (r) => ({ ...r, command: "/defs/W/body/0" }) }, "subject_mismatch"],
    ["a record that carries a payload", "alice", { change: (r) => ({ ...r, payload: payloadOf.answer("yes") }) }, "subject_mismatch"],
  ];

  it.each(REFUSED)("refuses %s, and stores nothing", async (_what, signer, change, reason) => {
    const w = await setup(ONE);
    const e = await w.rt.approveEnvelope(w.pkg, approval(w, w.who[signer], change)).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: "invalid_decision", reason });
    expect(await count(w, "decisions")).toBe(0);
    await expect(run(w, "h3-refused")).rejects.toMatchObject({ code: "unapproved_envelope" });
  });

  it("refuses a record that was changed after it was signed (invalid_signature)", async () => {
    const w = await setup(ONE);
    const signed = approval(w, w.who.alice);
    const forged = { record: { ...signed.record, at: "2031-01-01T00:00:00Z" }, signature: signed.signature };
    await expect(w.rt.approveEnvelope(w.pkg, forged)).rejects.toMatchObject({ code: "invalid_decision", reason: "invalid_signature" });
    await expect(w.rt.approveEnvelope(w.pkg, { ...signed, extra: true } as unknown as SignedDecision)).rejects.toMatchObject({ code: "invalid_decision", reason: "invalid_signature" });
    expect(await count(w, "decisions")).toBe(0);
  });

  it("takes an approval for one package as none for another: a changed program or lock is a new hash (N04)", async () => {
    const w = await approved(ONE);
    const again = check(program({ body: "  delegate Worker.fix(issue)", agents: 6 }), "mdt");
    expect(again.ok).toBe(true);
    const grown = buildPackage(again.program!, w.pkg.lock);
    const dave = EvidenceSigner.generate();
    const relocked = buildPackage(w.pkg.program, { ...w.pkg.lock, members: { ...w.who.members, dave: { keys: [dave.keyId] } } });
    for (const other of [grown, relocked]) {
      expect(other.hash).not.toBe(w.pkg.hash);
      await expect(w.rt.startRun({ pkg: other, workflow: "W", input: ISSUE })).rejects.toMatchObject({ code: "unapproved_envelope" });
      // Alice's approval of the first package, sent for this one, is about something else.
      await expect(w.rt.approveEnvelope(other, approval(w, w.who.alice))).rejects.toMatchObject({ code: "invalid_decision", reason: "subject_mismatch" });
    }
    expect((await run(w, "n4-first")).state).toBe("succeeded");
    // Her approval of the new package starts it.
    await w.rt.approveEnvelope(grown, approval({ pkg: grown, adapters: w.adapters }, w.who.alice));
    expect((await w.rt.startRun({ pkg: grown, workflow: "W", input: ISSUE, runId: "n4-grown" })).state).toBe("succeeded");
  });

  it("does not start on a stored approval that no longer holds", async () => {
    const w = await approved(ONE);
    // A runtime that does not hold the approver's public key cannot check her signature.
    const others = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { keys: new TrustedKeys([w.who.bob.key.publicKey]) } });
    await expect(others.startRun({ pkg: w.pkg, workflow: "W", input: ISSUE })).rejects.toMatchObject({ code: "unapproved_envelope" });
    // The stored record changed after it was signed.
    await w.db.query(`update decisions set record = jsonb_set(record, '{at}', '"2031-01-01T00:00:00Z"')`);
    await expect(run(w, "h3-changed")).rejects.toMatchObject({ code: "unapproved_envelope" });
    expect(await count(w, "runs")).toBe(0);
  });

  it("does not take a stored decision of another role or kind for the approval", async () => {
    const w = await setup(ONE);
    // Rows as a changed store might hold them: validly signed records that are not the owner's approval of this package.
    const asManager = approval(w, w.who.bob, { role: "release_manager" });
    const otherKind = approval(w, w.who.alice, { kind: "amend" });
    await w.db.tx(async (tx) => {
      for (const d of [asManager, otherKind]) {
        const id = await w.rt.journal.recordDecision(tx, d);
        await tx.query("update decisions set kind = 'envelope', role = 'platform_lead' where decision_id = $1", [id]);
      }
    });
    expect(await count(w, "decisions")).toBe(2);
    await expect(run(w, "h3-other")).rejects.toMatchObject({ code: "unapproved_envelope" });
  });

  it("has nothing to approve in a package without an envelope (no_envelope)", async () => {
    const w = await setup(program({ body: "  delegate Worker.fix(issue)" }).replace(/  envelope \{[\s\S]*?\n  \}\n/, "  caps    PR, ModelStd\n  budget  { tokens: 10k, steps: 40 }\n"));
    await expect(w.rt.approveEnvelope(w.pkg, approval(w, w.who.alice))).rejects.toMatchObject({ code: "no_envelope" });
    // And it starts without one, as a workflow without an envelope always did.
    expect((await run(w, "h3-plain")).state).toBe("succeeded");
    expect((await w.rt.getRun("h3-plain")).manifest).not.toHaveProperty("envelope_approval");
    expect(await events(w, "h3-plain", "envelope_approved")).toEqual([]);
  });

  it("is signed for the hash the card shows", async () => {
    const w = await setup(ONE);
    const lock: LockFile = { lock: LOCK_FORMAT, ...w.pkg.lock };
    expect(card(w.pkg.program, "W", { lock })!.package).toBe(w.pkg.hash);
  });

  it("does not run in unsigned mode, approved or not (signed_decisions_required)", async () => {
    const w = await approved(ONE);
    const lax = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "unsigned", keys: w.who.keys } });
    await expect(lax.startRun({ pkg: w.pkg, workflow: "W", input: ISSUE })).rejects.toMatchObject({ code: "signed_decisions_required" });
  });
});

// ── the ledger ──────────────────────────────────────────────────────────

describe("the agents ledger", () => {
  it("reserves one agent for every attempt when it is dispatched, and has spent it when it settles: a first attempt, a restart and a degrade fallback", async () => {
    const failed = { error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } };
    const agents = new SimAgents()
      .on("Worker.fix", (_req, call) => (call === 1 ? failed : { ok: "patch;", cost: { steps: 1 } }))
      .on("Worker.test", () => failed)
      .on("Spare.test", text("tests;"));
    const body = "  let patch = delegate Worker.fix(issue) supervise restart(max: 2)\n  let tests = delegate Worker.test(issue) supervise degrade(to: Spare)\n  patch + tests";
    const w = await approved(program({ body }), { agents });
    const done = await run(w, "led-1");
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(done.result).toBe("patch;tests;");
    // Four attempts: Worker.fix twice, Worker.test once, and its fallback.
    expect(w.agents.count()).toBe(4);
    const sent = (await events(w, "led-1", "command_dispatched")).filter((e) => e["kind"] === "delegate");
    expect(sent.map((e) => [String(e["command"]).replace("/defs/W/body/", ""), (e["reserved"] as Obj)["agents"]])).toEqual([
      ["0/value", 1],
      ["0/value#1", 1],
      ["1/value", 1],
      ["1/value~Spare", 1],
    ]);
    // A failed attempt is spent like one that succeeded.
    expect((await w.rt.journal.budget("led-1"))["agents"]).toEqual({ limit: 5, settled: 4, reserved: 0 });
  });

  it("gives the run the envelope's agents, or the caller's when that is fewer", async () => {
    const w = await approved(ONE);
    await run(w, "led-2a", { limits: { agents: 2 } });
    await run(w, "led-2b", { limits: { agents: 99 } });
    await run(w, "led-2c");
    const limit = async (id: string) => (await w.rt.journal.budget(id))["agents"]!.limit;
    expect([await limit("led-2a"), await limit("led-2b"), await limit("led-2c")]).toEqual([2, 5, 5]);
  });

  it("counts an attempt that runs as an agent loop in this process like one sent to an adapter", async () => {
    // A loop's step costs more tokens than Worker's own budget gives, so the delegation brings a budget of its own.
    const w = await approved(program({ body: "  delegate Worker.fix(issue) budget { tokens: 5k, steps: 5 }" }));
    const chat = new SimChat(() => [toolUse("t1", "finish", { result: "patch;" })]);
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const done = await run(w, "led-loop");
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(done.result).toBe("patch;");
    // The skill has no body, so it ran here as a loop and no adapter was asked.
    expect(w.agents.count()).toBe(0);
    const sent = (await events(w, "led-loop", "command_dispatched")).filter((e) => e["kind"] === "delegate");
    expect(sent.map((e) => (e["reserved"] as Obj)["agents"])).toEqual([1]);
    expect((await w.rt.journal.budget("led-loop"))["agents"]).toEqual({ limit: 5, settled: 1, reserved: 0 });
  });

  it("reserves no agents in a run without an envelope, as before 0.4", async () => {
    const w = await world(FIX);
    const done = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: DOMAIN_ISSUE, runId: "led-3" });
    expect(done.state).toBe("succeeded");
    const sent = (await events(w, "led-3", "command_dispatched")).filter((e) => e["kind"] === "delegate");
    expect(sent.map((e) => e["reserved"])).toEqual([{ tokens: 1000, steps: 5 }]);
    expect(Object.keys(await w.rt.journal.budget("led-3")).sort()).toEqual(["steps", "tokens"]);
    expect(done.manifest).not.toHaveProperty("envelope_approval");
  });

  it("N02: two siblings cannot both reserve the last agent, and the run goes on once a person raised the limit", async () => {
    const gate = deferred<void>();
    const held = (s: string) => async () => {
      await gate.promise;
      return { ok: s, cost: { steps: 1 } };
    };
    const w = await approved(program({ body: PAR, agents: 3 }), { agents: new SimAgents().on("Worker.fix", held("patch;")).on("Worker.test", held("tests;")) });
    let refusedDispatches = 0;
    const dispatch = w.rt.journal.dispatch.bind(w.rt.journal);
    w.rt.journal.dispatch = async (...a) => {
      try {
        return await dispatch(...a);
      } catch (e) {
        refusedDispatches++;
        throw e;
      }
    };
    // The envelope allows three agents; the caller allows this run one.
    const p = run(w, "n2", { limits: { agents: 1 } });
    await until(() => refusedDispatches === 1 && w.agents.count() === 1, "one dispatch refused, one in flight");
    gate.resolve();
    const stopped = await p;
    expect(w.agents.count()).toBe(1);
    expect(stopped.state).toBe("waiting");
    expect(stopped.waiting).toMatchObject({ kind: "budget_exceeded", detail: { $tag: "BudgetExceeded", $args: [{ dimension: "agents", requested: 1, available: 0 }] } });
    expect((await w.rt.journal.budget("n2"))["agents"]).toEqual({ limit: 1, settled: 1, reserved: 0 });

    // A raise stops at the envelope: more than it gives needs an amendment, which is its owner's to approve.
    const { carol } = w.who;
    const raise = async (agents: number) => w.rt.raiseLimits("n2", msg(), { limits: { agents }, signed: await sign(w, "n2", carol, "raise_limits", { about: "run", payload: payloadOf.limits({ agents }) }) });
    await expect(raise(4)).rejects.toMatchObject({ code: "above_program_budget" });
    await raise(2);
    const done = await w.rt.submitInput("n2", msg(), { value: "continue", signed: await sign(w, "n2", carol, "answer", { payload: payloadOf.answer("continue") }) });
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    // The branch that ran is not sent again; the other is the run's second agent.
    expect(w.agents.count()).toBe(2);
    expect((await w.rt.journal.budget("n2"))["agents"]).toEqual({ limit: 2, settled: 2, reserved: 0 });
  });
});

// ── max_concurrent ──────────────────────────────────────────────────────

describe("spawn.max_concurrent", () => {
  const THREE = `  par {
    lint  = delegate Worker.lint(issue)
    patch = delegate Worker.fix(issue)
    tests = delegate Worker.test(issue)
  }
  patch + tests + lint`;

  it.each([
    ["1", 1],
    ["2", 2],
    [undefined, 3],
  ])("with max_concurrent %s, at most %i of three delegations are in flight, and one that waits holds no command and no reservation", async (max, most) => {
    let w!: Enveloped;
    let inFlight = 0;
    let peak = 0;
    let arrived = 0;
    // A delegation stays in flight until as many are as the bound lets in, or until the last one has come, so the
    // peak does not depend on how fast the machine is. The pause after that is what lets one too many show.
    const full: Array<() => void> = [];
    const gather = async (): Promise<void> => {
      if (inFlight < most && arrived < 3) await new Promise<void>((r) => full.push(r));
      for (const r of full.splice(0)) r();
      await new Promise((r) => setTimeout(r, 15));
    };
    // What the journal holds while a delegation runs: the delegations sent and not yet settled, and the agents reserved.
    const seen: Array<{ dispatched: number; reserved: number }> = [];
    const slow = (s: string) => async () => {
      inFlight++;
      arrived++;
      peak = Math.max(peak, inFlight);
      await gather();
      // One statement, so both are read from one snapshot: between two, another delegation may settle.
      const [now] = await w.db.query<{ c: number; r: number }>(
        "select (select count(*) from commands where kind = 'delegate' and state = 'dispatched') as c, (select coalesce(sum(amount), 0) from reservations where dimension = 'agents' and state = 'active') as r",
      );
      seen.push({ dispatched: Number(now!.c), reserved: Number(now!.r) });
      inFlight--;
      return { ok: s, cost: { steps: 1 } };
    };
    const agents = new SimAgents().on("Worker.fix", slow("patch;")).on("Worker.test", slow("tests;")).on("Worker.lint", slow("lint;"));
    w = await approved(program({ body: THREE, ...(max ? { spawn: `{ max_concurrent: ${max} }` } : {}) }), { agents });
    const done = await run(w, `mc-${max ?? "none"}`);
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(done.result).toBe("patch;tests;lint;");
    expect(peak).toBe(most);
    expect(seen).toHaveLength(3);
    for (const s of seen) {
      expect(s.dispatched).toBeLessThanOrEqual(most);
      expect(s.reserved).toBe(s.dispatched);
    }
    // Waiting is not an attempt: three delegations are three agents, however many waited.
    expect((await w.rt.journal.budget(`mc-${max ?? "none"}`))["agents"]).toEqual({ limit: 5, settled: 3, reserved: 0 });
    expect(await count(w, "commands where kind = 'delegate'")).toBe(3);
  });

  it("keeps a place taken when it goes to a delegation that waited, so a later one waits in turn", async () => {
    let inFlight = 0;
    let peak = 0;
    const during = (ms: number, out: (call: number) => ReturnType<ReturnType<typeof text>> | { error: { tag: string; args: Value[] }; cost: { steps: number } }) => async (_req: unknown, call: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, ms));
      inFlight--;
      return out(call);
    };
    const agents = new SimAgents()
      .on("Worker.fix", during(5, (call) => (call === 1 ? { error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } } : { ok: "patch;", cost: { steps: 1 } })))
      .on("Worker.test", during(40, () => ({ ok: "tests;", cost: { steps: 1 } })));
    const body = "  par {\n    patch = delegate Worker.fix(issue) supervise restart(max: 1)\n    tests = delegate Worker.test(issue)\n  }\n  patch + tests";
    const w = await approved(program({ body, spawn: "{ max_concurrent: 1 }" }), { agents });
    const done = await run(w, "mc-hand");
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(done.result).toBe("patch;tests;");
    // Worker.fix's first attempt left its place to Worker.test, which had waited. Its restart came while that one ran.
    expect(w.agents.count()).toBe(3);
    expect(peak).toBe(1);
  });

  it("gives a place back when a delegation fails, so the next one runs", async () => {
    const agents = new SimAgents().on("Worker.fix", () => ({ error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } })).on("Worker.test", text("tests;"));
    const body = "  let patch = delegate Worker.fix(issue) supervise restart(max: 1)\n  delegate Worker.test(issue)";
    const w = await approved(program({ body, spawn: "{ max_concurrent: 1 }" }), { agents });
    const done = await run(w, "mc-fail");
    // Both attempts of Worker.fix failed, each after the other had left its place; the fault is the run's.
    expect(done.state).toBe("failed");
    expect(w.agents.count("Worker.fix")).toBe(2);
  });
});

// ── approve E by r ──────────────────────────────────────────────────────

describe("approve E by r", () => {
  const COMMENT = `  let note = delegate Worker.fix(issue)
  effect git.comment(issue, "fixed")
    idempotent_by issue.id
  note`;
  const waitOf = (r: RunRow): { kind: string; command: string; request: Obj } => {
    const w = r.waiting as Obj;
    return { kind: String(w["kind"]), command: String(w["command"]), request: (isObj(w["request"] ?? null) ? w["request"] : {}) as Obj };
  };

  it("authorizes the effect by policy when the envelope names nobody for it", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await approved(program({ body: COMMENT }), { tools: [tool], agents: new SimAgents().on("Worker.fix", text("patch;")) });
    const done = await run(w, "ap-policy");
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it.each([
    ["the runtime's own default", undefined],
    ["a runtime configured to let policy authorize it", { "git.comment": { by: "policy" as const } }],
    ["a runtime configured to ask another role", { "git.comment": { by: "human" as const, role: "platform_lead" } }],
  ])("waits for the role the envelope names, whatever %s says, and takes only that role's decision", async (_what, authorize) => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await approved(program({ body: COMMENT, approve: "git.comment by release_manager" }), { tools: [tool], agents: new SimAgents().on("Worker.fix", text("patch;")) });
    const stopped = await run(w, "ap-role", authorize ? { authorize } : {});
    expect(stopped.state, JSON.stringify(stopped.error ?? stopped.attention)).toBe("waiting");
    expect(waitOf(stopped)).toMatchObject({ kind: "decision", request: { effect: "git.comment", role: "release_manager" } });
    expect(tool.executions).toHaveLength(0);

    // The envelope's owner is not the release manager: her approval is no decision here (N05, INV-16).
    await expect(w.rt.decideAction("ap-role", msg(), { signed: await sign(w, "ap-role", w.who.alice, "approve") })).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    expect(tool.executions).toHaveLength(0);
    const done = await w.rt.decideAction("ap-role", msg(), { signed: await sign(w, "ap-role", w.who.bob, "approve") });
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
    expect(await events(w, "ap-role", "action_authorized")).toMatchObject([{ by: "bob", member: "bob", role: "release_manager", key: w.who.bob.key.keyId }]);
  });

  it("keeps the deadline the runtime sets for the effect", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await approved(program({ body: COMMENT, approve: "git.comment by release_manager" }), { tools: [tool], agents: new SimAgents().on("Worker.fix", text("patch;")) });
    const stopped = await run(w, "ap-deadline", { authorize: { "git.comment": { by: "human", role: "platform_lead", deadlineMs: 60_000 } } });
    expect(waitOf(stopped).request).toMatchObject({ role: "release_manager", deadline: w.adapters.clock.now() + 60_000 });
  });

  it("sends nothing when that role declines", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const w = await approved(program({ body: COMMENT, approve: "git.comment by release_manager" }), { tools: [tool], agents: new SimAgents().on("Worker.fix", text("patch;")) });
    await run(w, "ap-no");
    const done = await w.rt.decideAction("ap-no", msg(), { signed: await sign(w, "ap-no", w.who.bob, "decline") });
    expect(done.state).toBe("failed");
    expect(tool.executions).toHaveLength(0);
  });
});

// ── approve, where the program names who decides as well ────────────────

/** `src` on a runtime with Acme's system model and `tool`, every role the package names held by Alice, and its envelope approved by her. */
async function onAcme(src: string, tool: SimTool): Promise<{ w: World; alice: Person }> {
  const modules = acmeModules();
  const checked = check(src, "mdt", { modules });
  expect(checked.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  const alice = { member: "alice", key: EvidenceSigner.generate() };
  const roles = Object.fromEntries(rolesNamed(link(checked.program!, modules).defs).map((r) => [r, ["alice"]]));
  const lock = { ...lockFor(modules), members: { alice: { keys: [alice.key.keyId] } }, roles };
  const w = await world(src, { modules, lock, tools: [tool], decisions: { keys: new TrustedKeys([alice.key.publicKey]) } });
  await w.rt.approveEnvelope(w.pkg, approval(w, alice));
  return { w, alice };
}

describe("approve E by r, in an environment that names who decides", () => {
  /** A release deployed to one of Acme's environments: staging's tier is policy, prod_sim's asks the release manager. */
  const ship = (role: string, environment: string): string => `mandate @ 0.4
module acme.tasks.ship @ 0.1
use std.{env, human}
use acme.system.{staging, prod_sim}

role platform_lead   "Platform lead"
role release_manager "Release manager"
role sre             "Site reliability"

capability Deploys = env.deploy(staging, prod_sim)

type Release = { version: Text }

contract Tagged(r: Release) {
  accept tagged "The release names its version" by static len(r.version) >= 1
  accept approved "A person approved the release" by human.approve(role: platform_lead)
}

workflow W(version: Text) -> Text
  envelope {
    owner   platform_lead
    caps    Deploys
    budget  { steps: 10, agents: 1 }
    approve deploy by ${role}
  }
{
  let r = verify Release { version: version } against Tagged(Release { version: version })
  let p = effect deploy(r, ${environment}) idempotent_by version
  "shipped"
}
`;

  /**
   * The program with Acme's system model, every role it names held by Alice, and its envelope approved; run `runId`
   * has the release approved (the contract's criterion, which an irreversible effect needs) and stands at the deploy.
   */
  async function shipping(src: string, runId: string, o: Partial<Parameters<Runtime["startRun"]>[0]> = {}): Promise<{ w: World; alice: Person; tool: SimTool; at: RunRow }> {
    const tool = new SimTool("deploy", "reconcilable");
    const { w, alice } = await onAcme(src, tool);
    const asked = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { version: "1.4.0" }, runId, ...o });
    expect(((asked.waiting as Obj)["request"] as Obj)).toMatchObject({ criterion: "approved", role: "platform_lead" });
    const at = await w.rt.decideAction(runId, msg(), { signed: await sign(w, runId, alice, "approve") });
    return { w, alice, tool, at };
  }

  it("asks the envelope's role where the environment's tier is policy: never by policy", async () => {
    const { tool, at: stopped } = await shipping(ship("release_manager", "staging"), "env-staging", { authorize: { deploy: { by: "policy" } } });
    expect(stopped.state, JSON.stringify(stopped.error ?? stopped.attention)).toBe("waiting");
    expect(((stopped.waiting as Obj)["request"] as Obj)["role"]).toBe("release_manager");
    expect(tool.executions).toHaveLength(0);
  });

  it("asks once where the environment names the same role", async () => {
    const { w, alice, tool, at: stopped } = await shipping(ship("release_manager", "prod_sim"), "env-same");
    expect(((stopped.waiting as Obj)["request"] as Obj)).toMatchObject({ effect: "deploy", role: "release_manager", environment: "prod_sim" });
    const done = await w.rt.decideAction("env-same", msg(), { signed: await sign(w, "env-same", alice, "approve") });
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it("stops for a person where the environment names another role: neither rule gives way (approval_conflict)", async () => {
    const { w, tool, at: stopped } = await shipping(ship("sre", "prod_sim"), "env-conflict");
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "approval_conflict" });
    expect(tool.executions).toHaveLength(0);
    expect(await count(w, "authorizations")).toBe(0);
  });
});

describe("approve E by r, on a member of a change set", () => {
  /**
   * Acme's change set (fixtures/system/land.mdt) as a 0.4 workflow with an envelope that asks the release manager to
   * approve every merge. A member is approved by its component's owner, or by the role `by` names for it.
   */
  const land = (by = ""): string => {
    const changes: Array<[string, string]> = [
      ["mandate @ 0.3", "mandate @ 0.4"],
      ["capability Repos", `role platform_lead   "Platform lead"\nrole release_manager "Release manager"\nrole architect       "Architect"\n\ncapability Repos`],
      ["workflow Land(task: Text) -> Text", "workflow W(task: Text) -> Text"],
      ["  caps Repos", "  envelope {\n    owner   platform_lead\n    caps    Repos\n    budget  { steps: 10, agents: 1 }\n    approve git.merge by release_manager\n  }"],
      ["member auth = git.merge(a)", `member auth = git.merge(a)${by}`],
      ["member core = git.merge(c)", `member core = git.merge(c)${by}`],
      ["member mcp = git.merge(m)", `member mcp = git.merge(m)${by}`],
    ];
    return changes.reduce((src, [from, to]) => {
      expect(src.split(from), from).toHaveLength(2);
      return src.replace(from, to);
    }, LAND);
  };

  async function landing(src: string, runId: string): Promise<{ w: World; alice: Person; merge: SimTool; at: RunRow }> {
    const merge = new SimTool("git.merge", "reconcilable");
    const { w, alice } = await onAcme(src, merge);
    return { w, alice, merge, at: await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { task: "add scope" }, runId }) };
  }

  it("asks the envelope's role for each member that names it, then the set's approver", async () => {
    const { w, alice, merge, at } = await landing(land(` approved_by role "release_manager"`), "cs-same");
    const asked: string[] = [];
    let r = at;
    while (r.state === "waiting" && isObj(r.waiting) && r.waiting["kind"] === "decision") {
      asked.push(String((r.waiting["request"] as Obj)["role"]));
      r = await w.rt.decideAction("cs-same", msg(), { signed: await sign(w, "cs-same", alice, "approve") });
    }
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    expect(asked).toEqual(["release_manager", "release_manager", "release_manager", "architect"]);
    expect(merge.executions).toHaveLength(3);
  });

  it("stops for a person where a member is its component owner's to approve: the owner is not passed over (approval_conflict)", async () => {
    const { w, merge, at: stopped } = await landing(land(), "cs-conflict");
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "approval_conflict" });
    expect(merge.executions).toHaveLength(0);
    expect(await count(w, "authorizations")).toBe(0);
  });
});
