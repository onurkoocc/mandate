// An amendment of the envelope (0.4; spec/envelope.md "Amendments"; case N04;
// INV-02 as 0.4 refines it). A lead asks for a wider envelope with
// `request_amendment`. The run waits for a member of the envelope's owner
// role, whose signed decision names the hash of the package with the new
// envelope. On approval the run goes on under that package; on a decline, or
// past the wait's deadline, the envelope stays as it was. What ran before
// the amendment stands as the journal recorded it. Each rule is shown by one
// run that keeps it and one that breaks it.

import { check, load, type WorkflowDef } from "@mandate/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { shownPackage, signDecision, type DecisionKind, type Shown } from "../src/decisions.js";
import type { RunRow } from "../src/journal.js";
import { buildPackage } from "../src/package.js";
import { type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import { Cancelled, StaleFence } from "../src/signals.js";
import { SimTool, toolUse, type SimTurn } from "../src/sim.js";
import { digest, type Obj, type Value } from "../src/values.js";
import { closeAll, commandIds, planChecker } from "./helpers.js";
import { base, BRANCHES, BUDGET, CAPS, commenting, events, finish, fixed, fixes, itemOf, landing, leads, msg, ONE, PLAN, planned as plannedWith, program, programAt, refusals, run, sign, state, sub, submit, toolStep, TWO, type Planned, type Turn } from "./planning.js";

let checker: WorkerChecker;
let stuck: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
  stuck = await planChecker("./fixtures/stuck-plan-worker.ts");
}, 60_000);

afterAll(async () => {
  for (const c of [checker, stuck]) await c.close();
  await closeAll();
});

const planned = (lead: Turn[], o: Parameters<typeof plannedWith>[2] = {}): Promise<Planned> => plannedWith(checker, lead, o);

// ── what a lead sends, and what a person signs ──────────────────────────

/** The envelope of workflow W in a program written as text, as IR: what a lead sends to `request_amendment`. */
function envelopeOf(src: string): Obj {
  const r = load(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return (r.program!.defs["W"] as WorkflowDef).envelope as unknown as Obj;
}

const amend = (envelope: Value, reason = "the next sub-program needs more"): SimTurn => [toolUse("a1", "request_amendment", { envelope, reason })];

/** The envelope's budget with twice the tokens: what the lead of these tests asks for. */
const WIDER = "{ tokens: 400k, steps: 400, agents: 12 }";

/** The hash of the package a person would build from `src` with the run's lock. */
const hashOf = (w: Planned, src: string): string => buildPackage(check(src, "mdt").program!, w.pkg.lock).hash;

/** The wait of the amendment the lead asked for in its `turn`th turn. */
const waitAt = (turn: number, plan = PLAN): string => `${toolStep(turn, plan)}/amendment`;

/** A member's signed decision on what the run shows now, or on `shown`. */
async function signed(w: Planned, runId: string, who: "alice" | "bob", kind: DecisionKind, shown?: Partial<Shown>) {
  return signDecision(w[who], { ...(await w.rt.shown(runId, "wait")), ...shown }, { kind, member: who, at: new Date(w.adapters.clock.now()) });
}

const decide = async (w: Planned, runId: string, kind: "amend" | "decline", who: "alice" | "bob" = "alice"): Promise<RunRow> => w.rt.decideAmendment(runId, msg(), await signed(w, runId, who, kind));

const limits = async (w: Planned, runId: string): Promise<Record<string, number>> => Object.fromEntries(Object.entries(await w.rt.journal.budget(runId)).map(([dim, b]) => [dim, b.limit]));

/** A sub-program that needs more tokens than the envelope has left, and fits the wider one. */
const BIG = fixes(["a"], "{ tokens: 300k, steps: 40, agents: 4 }");

// ── the request ─────────────────────────────────────────────────────────

describe("N04: a lead asks for an amendment", () => {
  it("the run waits for the envelope's owner, the package with the new envelope is stored, and nothing of the run has changed", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([amend(envelopeOf(wider), "three more repositories"), finish("went on")]);
    const r = await run(w, "ask");
    const to = hashOf(w, wider);
    expect(to).not.toBe(w.pkg.hash);
    expect(r.state).toBe("waiting");
    expect(r.waiting).toMatchObject({
      kind: "amendment",
      command: waitAt(1),
      request: { plan: PLAN, workflow: "W", lead: "Lead.finish", from: w.pkg.hash, package: to, role: "platform_lead", reason: "three more repositories", envelope: envelopeOf(wider), diff: expect.stringMatching(/^sha256:/), deadline: null },
    });
    // The owner is shown the new envelope whole, and what it changes line by line: here, twice the tokens.
    expect(((r.waiting as Obj)["request"] as Obj)["changes"]).toEqual([{ path: "/defs/W/envelope/budget", text: "~ W.envelope.budget.tokens: 200000 → 400000" }]);
    const [asked] = await events(w, "ask", "amendment_requested");
    expect(asked).toEqual({ plan: PLAN, step: toolStep(1), lead: "Lead.finish", from: w.pkg.hash, package: to, diff: ((r.waiting as Obj)["request"] as Obj)["diff"] });
    // The package is stored: the program with the new envelope and nothing else changed, under the run's lock.
    const [stored] = await w.db.query("select program, lock from packages where package_hash = $1", [to]);
    expect(buildPackage(stored!["program"] as never, stored!["lock"] as never).hash).toBe(to);
    // What a member signs: the run's package now, the wait, and the new package's hash as the subject, in the owner's role.
    expect(await w.rt.shown("ask", "wait")).toEqual({ package: w.pkg.hash, run: "ask", revision: r.revision, command: waitAt(1), subject: to, role: "platform_lead" });
    // Nothing of the run has changed.
    expect(r.package_hash).toBe(w.pkg.hash);
    expect(await limits(w, "ask")).toEqual({ tokens: 200_000, steps: 400, agents: 12 });
    expect(await events(w, "ask", "package_amended")).toEqual([]);
    expect(w.told).toEqual([]);
  });

  it("keeps the first 2000 characters of the lead's reason: it is a model's text, for a person to read", async () => {
    const long = "because ".repeat(1000);
    const w = await planned([amend(envelopeOf(program({ budget: WIDER })), long), finish()]);
    const r = await run(w, "long");
    const reason = String(((r.waiting as Obj)["request"] as Obj)["reason"]);
    expect(reason).toHaveLength(2000);
    expect(long.startsWith(reason)).toBe(true);
  });

  it("on approval the run goes on under the new package: its limits rise, the lead is told, and a sub-program that did not fit is admitted", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([submit(1, BIG), amend(envelopeOf(wider)), submit(1, BIG), finish("fixed after all")]);
    const stopped = await run(w, "ok");
    expect(stopped.state).toBe("waiting");
    expect(refusals(w.told[0])).toEqual([["MDT-E1706", "/defs/Fix/budget/tokens", { dimension: "tokens", asked: 300_000, left: 140_000 }]]);
    const to = hashOf(w, wider);
    const sandboxes = w.host.created.length;

    const done = await decide(w, "ok", "amend");
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("fixed after all");
    expect(done.package_hash).toBe(to);
    expect(await limits(w, "ok")).toEqual({ tokens: 400_000, steps: 400, agents: 12 });
    expect(await events(w, "ok", "package_amended")).toEqual([
      {
        from: w.pkg.hash,
        to,
        diff: ((stopped.waiting as Obj)["request"] as Obj)["diff"],
        plan: PLAN,
        command: waitAt(2),
        limits: { from: { tokens: 200_000 }, to: { tokens: 400_000 } },
        superseded: [],
        by: "alice",
        member: "alice",
        role: "platform_lead",
        key: w.alice.keyId,
        decision: expect.stringMatching(/^sha256:/),
      },
    ]);
    // The lead is told the envelope as it is now and what is left of it, and plans on.
    expect(w.told[1]).toEqual({ amended: true, package: to, envelope: envelopeOf(wider), number: 1, base: base(1), room: { left: { tokens: 340_000, steps: 370, agents: 11 }, writes_in_flight: [] } });
    expect(w.told[2]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    expect(await events(w, "ok", "program_admitted")).toMatchObject([{ number: 1, reservation: { tokens: 300_000 } }]);
    // The lead's loop went on from the journal in a sandbox of its own: its earlier turns were not asked again.
    expect(w.chat.calls.filter((c) => c.agent === "Lead")).toHaveLength(4);
    expect(w.host.created.length).toBeGreaterThan(sandboxes);
    // The decision is a signed record of kind `amend`, kept with the run's others, and it still verifies.
    const decisions = await w.rt.verifyDecisions("ok");
    expect(decisions.map((d) => [d.record.kind, d.record.member, d.record.subject, d.valid])).toEqual([
      ["envelope", "alice", w.pkg.hash, true],
      ["amend", "alice", to, true],
    ]);
    expect(decisions[1]!.record).toMatchObject({ package: w.pkg.hash, run: "ok", command: waitAt(2), role: "platform_lead" });
  });

  it("raises a limit only where the amendment raises the envelope: a limit the caller set lower stays", async () => {
    // The caller gave this run 100 steps and 100k tokens of the envelope's 400 and 200k. The amendment raises tokens and agents.
    const wider = program({ budget: "{ tokens: 400k, steps: 400, agents: 20 }" });
    const w = await planned([amend(envelopeOf(wider)), finish("amended")]);
    await run(w, "less", { limits: { steps: 100, tokens: 100_000 } });
    expect(await limits(w, "less")).toEqual({ tokens: 100_000, steps: 100, agents: 12 });
    const done = await decide(w, "less", "amend");
    expect(state(done)).toBe("succeeded null");
    // Tokens and agents are the new envelope's. Steps are what the caller gave: the amendment said nothing of them.
    expect(await limits(w, "less")).toEqual({ tokens: 400_000, steps: 100, agents: 20 });
    expect(await events(w, "less", "package_amended")).toMatchObject([{ limits: { from: { agents: 12, tokens: 100_000 }, to: { agents: 20, tokens: 400_000 } } }]);
  });

  it("on a decline the envelope stays as it was, and the lead is told who declined", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([amend(envelopeOf(wider)), submit(1, BIG), finish("did less")]);
    await run(w, "no");
    const done = await decide(w, "no", "decline");
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("did less");
    expect(done.package_hash).toBe(w.pkg.hash);
    expect(await limits(w, "no")).toEqual({ tokens: 200_000, steps: 400, agents: 12 });
    expect(await events(w, "no", "package_amended")).toEqual([]);
    expect(w.told[0]).toEqual({ amended: false, declined: { reason: "declined", by: "alice" }, envelope: envelopeOf(program()), number: 1, base: base(1), room: { left: { tokens: 140_000, steps: 370, agents: 11 }, writes_in_flight: [] } });
    // It is an error to the model, and what did not fit still does not.
    const result = (w.chat.calls.filter((c) => c.agent === "Lead")[1]!.messages.at(-1) as { content: Obj[] }).content[0]!;
    expect(result["is_error"]).toBe(true);
    expect(refusals(w.told[1])).toEqual([["MDT-E1706", "/defs/Fix/budget/tokens", { dimension: "tokens", asked: 300_000, left: 140_000 }]]);
    expect((await w.rt.verifyDecisions("no")).map((d) => [d.record.kind, d.valid])).toEqual([
      ["envelope", true],
      ["decline", true],
    ]);
  });

  it("past the wait's deadline, which is the run's own, the wait ends unanswered and the envelope stays", async () => {
    const timed = (tokens: string): string => program({ budget: `{ tokens: ${tokens}, steps: 400, agents: 12, time: 1h }` });
    for (const [runId, late] of [
      ["late-tick", false],
      ["late-decision", true],
    ] as const) {
      const w = await planned([amend(envelopeOf(timed("400k"))), finish("ran out of time to ask")], { src: timed("200k") });
      const started = w.adapters.clock.now();
      const r = await run(w, runId);
      expect(((r.waiting as Obj)["request"] as Obj)["deadline"]).toBe(started + 3_600_000);
      w.clock.advance(3_600_000);
      // The scheduler finds the wait overdue; or the owner's approval arrives too late, and is no approval.
      const done = late ? await decide(w, runId, "amend") : await w.rt.tick(runId);
      expect(state(done)).toBe("succeeded null");
      expect(done.package_hash).toBe(w.pkg.hash);
      expect(await events(w, runId, "package_amended")).toEqual([]);
      expect(w.told[0]).toMatchObject({ amended: false, declined: { reason: "approval_expired", by: null } });
      expect((await limits(w, runId))["tokens"]).toBe(200_000);
    }
  });
});

// ── what is refused before anybody is asked ─────────────────────────────

describe("an amendment that is refused before anybody is asked", () => {
  const WITH_AUDITOR = program().replace('role release_manager "Release manager"', 'role release_manager "Release manager"\nrole auditor         "Auditor"');

  it("takes something away (E1709), is no envelope (E1701), changes nothing, names a role nobody holds, or is over a limit", async () => {
    const now = envelopeOf(WITH_AUDITOR);
    let deep: Value = "x";
    for (let i = 0; i < 70; i++) deep = [deep];
    const w = await planned(
      [
        amend(envelopeOf(program({ budget: "{ tokens: 100k, steps: 400, agents: 12 }" }))),
        amend({}),
        amend(now),
        amend({ ...now, owner: "auditor" }),
        amend({ ...now, caps: deep }),
        finish("asked nobody"),
      ],
      { src: WITH_AUDITOR },
    );
    const r = await run(w, "refused");
    expect(state(r)).toBe("succeeded null");
    expect(r.result).toBe("asked nobody");
    // An envelope with no caps is also one the workflow's body does not fit (E0301): the lead is told that too.
    expect(w.told.map((t) => [t["amended"], refusals(t).filter((d) => (d as unknown[])[0] !== "MDT-E0301")])).toEqual([
      [false, [["MDT-E1709", "/defs/W/envelope/budget/tokens", { dimension: "tokens", was: 200_000, asked: 100_000 }]]],
      [false, [["MDT-E1701", "/defs/W/envelope", { missing: ["owner", "caps", "budget"] }]]],
      [false, [["unchanged", null, { package: w.pkg.hash }]]],
      [false, [["unbound_role", null, null]]],
      [false, [["check_limit", null, { limit: "depth", max: 64 }]]],
    ]);
    // Each answer carries the envelope as it is, to ask again from, and is an error to the model.
    for (const t of w.told) expect(t).toMatchObject({ envelope: now, number: 1, base: base(1) });
    const lead = w.chat.calls.filter((c) => c.agent === "Lead");
    for (const call of lead.slice(1)) expect(((call.messages.at(-1) as { content: Obj[] }).content[0] as Obj)["is_error"]).toBe(true);
    // Nobody was asked, and nothing was stored.
    expect(await commandIds(w, "refused", "amendment")).toEqual([]);
    expect(await events(w, "refused", "amendment_requested")).toEqual([]);
    expect(await w.db.query("select package_hash from packages")).toHaveLength(1);
    expect(r.package_hash).toBe(w.pkg.hash);
  });

  it("N10: a check that takes too long is stopped, the lead is told, and the run goes on", async () => {
    const w = await planned([amend(envelopeOf(program({ budget: WIDER }))), finish("went on")], { plan: { checker: stuck, checkMs: 150 } });
    const r = await run(w, "stuck");
    expect(state(r)).toBe("succeeded null");
    expect(refusals(w.told[0])).toEqual([["check_limit", null, { limit: "time", max: 150 }]]);
    expect(await commandIds(w, "stuck", "amendment")).toEqual([]);
  });

  it("stops the run on a runtime whose checker checks no amendments", async () => {
    const only: ProgramChecker = { check: (input, ms) => checker.check(input, ms) };
    const w = await planned([amend(envelopeOf(program({ budget: WIDER }))), finish()], { plan: { checker: only } });
    const r = await run(w, "none");
    expect(r.state).toBe("attention_required");
    expect(r.attention).toMatchObject({ violation: "no_checker" });
  });
});

// ── who may decide, and what a decision is for ──────────────────────────

describe("N04, INV-16: the decision on an amendment", () => {
  it("is the owner's, of kind amend or decline, on this wait and for this package, and anything else changes nothing", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([amend(envelopeOf(wider)), finish("amended")]);
    const r = await run(w, "who");
    const to = hashOf(w, wider);
    const refused = async (decision: Promise<RunRow>, reason: string): Promise<void> => {
      await expect(decision).rejects.toMatchObject({ code: reason === "stale_revision" ? "stale_revision" : "invalid_decision", reason });
    };
    // The release manager holds no part of the envelope.
    await refused(decide(w, "who", "amend", "bob"), "not_in_role");
    // An approval is the answer to another kind of wait, by whichever door it comes.
    await refused(w.rt.decideAmendment("who", msg(), await signed(w, "who", "alice", "approve")), "subject_mismatch");
    await refused(w.rt.decideAction("who", msg(), { signed: await signed(w, "who", "alice", "approve") }), "subject_mismatch");
    // The decision names the package it is for: another hash is another amendment.
    await refused(w.rt.decideAmendment("who", msg(), await signed(w, "who", "alice", "amend", { subject: w.pkg.hash })), "subject_mismatch");
    // The approval of the old package's envelope is about that package and no run: it amends nothing.
    await refused(w.rt.decideAmendment("who", msg(), signDecision(w.alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) })), "stale_revision");
    await refused(w.rt.decideAmendment("who", msg(), signDecision(w.alice, shownPackage(to, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) })), "stale_revision");

    const still = await w.rt.getRun("who");
    expect(still.state).toBe("waiting");
    expect(still.package_hash).toBe(w.pkg.hash);
    expect(still.revision).toBe(r.revision);
    expect((await events(w, "who", "decision_refused")).map((e) => e["reason"])).toEqual(["not_in_role", "subject_mismatch", "subject_mismatch", "subject_mismatch", "stale_revision", "stale_revision"]);
    expect(await events(w, "who", "package_amended")).toEqual([]);

    const done = await decide(w, "who", "amend");
    expect(state(done)).toBe("succeeded null");
    expect(done.package_hash).toBe(to);
  });

  it("is made by the owner of the envelope the run has, also when the amendment names another owner", async () => {
    const handed = program().replace("owner   platform_lead", "owner   release_manager");
    const w = await planned([amend(envelopeOf(handed)), finish("handed over")]);
    const r = await run(w, "owner");
    expect(r.waiting).toMatchObject({ kind: "amendment", request: { role: "platform_lead", changes: [{ path: "/defs/W/envelope/owner", text: "~ W.envelope.owner: platform_lead → release_manager" }] } });
    // Bob would own the new envelope, and does not own the one the run has: it is that one's owner who gives it away.
    await expect(decide(w, "owner", "amend", "bob")).rejects.toMatchObject({ code: "invalid_decision", reason: "not_in_role" });
    const done = await decide(w, "owner", "amend");
    expect(state(done)).toBe("succeeded null");
    expect(done.package_hash).toBe(hashOf(w, handed));
  });

  it("an approval of an amendment that was asked of another package than the run has moves nothing (stale_amendment)", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([amend(envelopeOf(wider)), finish("asked in vain")]);
    const r = await run(w, "stale");
    // An approved amendment ends every other one the run waits for, so no wait is left that names an earlier
    // package. The approval checks it all the same: here on a wait whose row was changed by hand, to say it was
    // asked of a package the run is not under.
    await w.db.query("update commands set result = jsonb_set(result, '{from}', to_jsonb($1::text)) where run_id = 'stale' and kind = 'amendment'", [hashOf(w, wider)]);
    await expect(decide(w, "stale", "amend")).rejects.toMatchObject({ code: "stale_amendment" });
    const still = await w.rt.getRun("stale");
    expect([still.state, still.package_hash, still.revision]).toEqual(["waiting", w.pkg.hash, r.revision]);
    expect(await events(w, "stale", "package_amended")).toEqual([]);
    expect(await limits(w, "stale")).toEqual({ tokens: 200_000, steps: 400, agents: 12 });
    // A decline moves the run to no package, and is taken.
    const done = await decide(w, "stale", "decline");
    expect(state(done)).toBe("succeeded null");
    expect(done.package_hash).toBe(w.pkg.hash);
  });

  it("N04: the approval of the old package starts no run of the new one, and neither does the amendment", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([amend(envelopeOf(wider)), finish("amended")]);
    await run(w, "first");
    const done = await decide(w, "first", "amend");
    expect(state(done)).toBe("succeeded null");
    // The amended package ran this run on its owner's decision about this run. As a package of its own it has no approval.
    const amended = buildPackage(check(wider, "mdt").program!, w.pkg.lock);
    expect(amended.hash).toBe(done.package_hash);
    await expect(w.rt.startRun({ pkg: amended, workflow: "W", input: { items: [] }, runId: "second" })).rejects.toMatchObject({ code: "unapproved_envelope" });
  });

  it("N04: a decision signed for the old package answers nothing once the run is under the new one", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const src = (budget?: string): string => program({ approve: "git.comment by release_manager", ...(budget ? { budget } : {}) });
    const w = await planned([amend(envelopeOf(src(WIDER))), submit(1, commenting("a", "fixed")), finish("commented")], { src: src(), tools: [tool] });
    await run(w, "old");
    const waiting = await decide(w, "old", "amend");
    expect(waiting.waiting).toMatchObject({ kind: "decision", request: { effect: "git.comment", role: "release_manager" } });
    // Bob approves the action, but in a record that names the package the run had before.
    await expect(w.rt.decideAction("old", msg(), { signed: await signed(w, "old", "bob", "approve", { package: w.pkg.hash }) })).rejects.toMatchObject({ code: "invalid_decision", reason: "subject_mismatch" });
    expect(tool.executions).toHaveLength(0);
    const done = await w.rt.decideAction("old", msg(), { signed: await sign(w, "old", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(tool.executions).toHaveLength(1);
  });
});

// ── what ran before the amendment stands ────────────────────────────────

describe("what the journal holds stands under the package it was recorded under", () => {
  const BODY = `  effect git.comment(Item { name: "first" }, "starting")\n    idempotent_by "first"\n  plan Lead.finish(items) within envelope`;
  const AT = "/defs/W/body/1/value";

  it("N04, E0406: an effect done before the amendment is not done again, a new action names the new package, and an authorization for the old one commits nothing", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const src = (budget?: string): string => program({ body: BODY, approve: "git.comment by release_manager", ...(budget ? { budget } : {}) });
    const w = await planned([amend(envelopeOf(src(WIDER))), submit(1, commenting("b", "fixed")), finish("commented twice")], { src: src(), tools: [tool] });
    // The workflow's own comment waits for the release manager, and is made before the lead ever runs.
    await run(w, "twice");
    const asked = await w.rt.decideAction("twice", msg(), { signed: await sign(w, "twice", "bob", "approve") });
    expect(tool.executions).toHaveLength(1);
    expect(asked.waiting).toMatchObject({ kind: "amendment", command: waitAt(1, AT) });
    const to = hashOf(w, src(WIDER));

    // The run goes on under the new package, from the top of its body: the first comment is found, not made again.
    const waiting = await decide(w, "twice", "amend");
    expect(waiting.package_hash).toBe(to);
    expect(tool.executions).toHaveLength(1);
    expect(waiting.waiting).toMatchObject({ kind: "decision", command: `${programAt(1, AT)}/defs/Fix/body/1/value/authorize` });

    // Each action's digest names the package it was prepared under.
    const actions = await w.rt.journal.actions("twice");
    const contract = tool.describe();
    const digestOf = (a: (typeof actions)[number], pkg: string, key: string): string =>
      digest("action", { package: pkg, run: "twice", node: a.command_id, effect: a.effect, adapter: contract.id, adapter_contract: contract.digest, params: a.params, evidence: [], idempotency_key: key });
    const first = actions.find((a) => a.command_id === "/defs/W/body/0/value")!;
    const second = actions.find((a) => a.command_id !== first.command_id)!;
    expect(first.action_digest).toBe(digestOf(first, w.pkg.hash, "first"));
    expect(second.action_digest).toBe(digestOf(second, to, "b"));
    expect(second.state).toBe("prepared");

    // An authorization for the same action under the old package's hash is for another digest, and commits nothing (E0406).
    await w.rt.journal.authorize("twice", { id: "auth-for-the-old-package", actionDigest: digestOf(second, w.pkg.hash, "b"), decidedBy: "bob", expiresAt: w.adapters.clock.now() + 60_000 });
    await expect(w.rt.journal.commit("twice", waiting.fence, second.operation_key, "auth-for-the-old-package")).rejects.toMatchObject({ code: "MDT-E0406" });
    expect(tool.executions).toHaveLength(1);

    const done = await w.rt.decideAction("twice", msg(), { signed: await sign(w, "twice", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("commented twice");
    expect(tool.executions).toHaveLength(2);
    // A replay finds both actions under the packages they were recorded under, and calls nothing.
    expect(await w.rt.replayRun("twice")).toEqual({ status: "complete", value: "commented twice" });
    expect(tool.executions).toHaveLength(2);
    // Every command names the package the run had when it was first recorded: a wait and a sub-program as well.
    const under = async (id: string): Promise<string | null> => (await w.rt.journal.command("twice", id))!.package;
    expect(await under(`${first.command_id}/authorize`)).toBe(w.pkg.hash);
    expect(await under(waitAt(1, AT))).toBe(w.pkg.hash);
    expect(await under(programAt(1, AT))).toBe(to);
    expect(await under(`${programAt(1, AT)}/defs/Fix/body/1/value/authorize`)).toBe(to);
    expect(await w.db.query("select command_id from commands where run_id = 'twice' and package is null")).toEqual([]);
  });

  it("a change set landed before the amendment is found as it was recorded: the set keeps its digest, and nothing lands twice", async () => {
    // The workflow lands a change to two components as one set, and then its lead plans.
    const body = [
      `  let a = verify Change { files: ["a.ts"] } against ChangeAccepted(Change { files: ["a.ts"] })`,
      `  let b = verify Change { files: ["b.ts"] } against ChangeAccepted(Change { files: ["b.ts"] })`,
      `  let landed = changeset(a) {\n    member left = git.merge(a)\n    member right = git.merge(b)\n    order left, right\n    approve role "release_manager"\n  } idempotent_by "k"`,
      `  plan Lead.finish(items) within envelope`,
    ].join("\n");
    const src = (budget?: string): string => landing({ body, ...(budget ? { budget } : {}) });
    const merge = new SimTool("git.merge", "reconcilable");
    const w = await planned([amend(envelopeOf(src(WIDER))), finish("landed and planned")], { src: src(), tools: [merge] });
    let r = await run(w, "set");
    // Each member's owner and then the set's approver: the release manager, three times. Then the lead asks.
    for (let i = 0; i < 3; i++) {
      expect(r.waiting).toMatchObject({ kind: "decision" });
      r = await w.rt.decideAction("set", msg(), { signed: await sign(w, "set", "bob", "approve") });
    }
    expect(r.waiting).toMatchObject({ kind: "amendment" });
    expect(merge.executions).toHaveLength(2);
    const sets = await w.rt.journal.changesets("set");
    expect(sets.map((s) => s.state)).toEqual(["committed"]);

    const done = await decide(w, "set", "amend");
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("landed and planned");
    expect(done.package_hash).toBe(hashOf(w, src(WIDER)));
    // The run went over the change set again under the new package, and found the set it had landed.
    expect(await w.rt.journal.changesets("set")).toEqual(sets);
    expect(merge.executions).toHaveLength(2);
    expect(merge.prepares).toHaveLength(2);
    expect(await w.rt.replayRun("set")).toEqual({ status: "complete", value: "landed and planned" });
  });

  it("an action that waited for its role before the amendment still waits for it after, whatever the new envelope says", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const src = (approve?: string): string => program({ body: BRANCHES, ...(approve ? { approve } : {}) });
    const w = await planned([], { src: src("git.comment by release_manager"), tools: [tool] });
    // One lead's sub-program comments, which waits for the release manager. The other asks for an envelope without that rule.
    const told = leads(w, { [ONE]: [submit(1, commenting("a", "fixed")), finish("one")], [TWO]: [amend(envelopeOf(src())), finish("two")] });
    const r = await run(w, "role");
    expect(r.state).toBe("waiting");
    const authorize = `${programAt(1, ONE)}/defs/Fix/body/1/value/authorize`;
    expect(await commandIds(w, "role", "amendment")).toEqual([waitAt(1, TWO)]);
    const to = hashOf(w, src());
    const shown: Shown = { package: w.pkg.hash, run: "role", revision: r.revision, command: waitAt(1, TWO), subject: to, role: "platform_lead" };
    const after = await w.rt.decideAmendment("role", msg(), signDecision(w.alice, shown, { kind: "amend", member: "alice", at: new Date(w.adapters.clock.now()) }));
    // The run is under an envelope that asks nobody to approve a comment. The action was prepared under one that does.
    expect(after.package_hash).toBe(to);
    expect(after.waiting).toMatchObject({ kind: "decision", command: authorize, request: { role: "release_manager" } });
    expect(tool.executions).toHaveLength(0);
    const done = await w.rt.decideAction("role", msg(), { signed: await sign(w, "role", "bob", "approve") });
    expect(state(done)).toBe("succeeded null");
    expect(tool.executions).toHaveLength(1);
    expect(told[TWO]![0]).toMatchObject({ amended: true, package: to });
  });

  it("a delegation sent before the amendment keeps the grant it was sent with, and one sent after it has the new envelope's", async () => {
    const docs = (envelope: string): string =>
      program({ body: `  let before = delegate Worker.fix(Item { name: "before" })\n  let done = plan Lead.finish(items) within envelope\n  delegate Worker.fix(Item { name: "after" })` })
        .replace('capability Merge    = git.pr("company/backend")', 'capability Merge    = git.pr("company/backend")\ncapability Docs     = fs.write("/work/docs")')
        .replace("caps   RepoRead, SrcWrite, ModelStd\n", "caps   RepoRead, SrcWrite, ModelStd, Docs\n")
        .replace("caps   RepoRead, ModelStd\n", "caps   RepoRead, ModelStd, Docs\n")
        .replace("caps    RepoRead, SrcWrite, ModelStd, Merge", envelope);
    const narrow = docs("caps    RepoRead, SrcWrite, ModelStd, Merge");
    const wide = docs("caps    RepoRead, SrcWrite, ModelStd, Merge, Docs");
    const AT2 = "/defs/W/body/1/value";
    const w = await planned([amend(envelopeOf(wide)), finish("planned")], { src: narrow });
    const r = await run(w, "grant");
    expect(r.waiting).toMatchObject({ kind: "amendment", command: waitAt(1, AT2) });
    const done = await decide(w, "grant", "amend");
    // The worker sent before and the lead in flight were recorded with grants that left Docs out. They are found as recorded.
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("fixed after");
    const writable = (item: string): string[] => {
      const i = w.chat.calls.filter((c) => c.agent === "Worker").findIndex((c) => itemOf(c as TurnRequest) === item);
      const sandbox = w.host.created.filter((c) => c.policy.filesystem.readWrite.some((p) => p.startsWith("/work/")) && !c.policy.filesystem.readWrite.includes("/never"))[i]!;
      return sandbox.policy.filesystem.readWrite.filter((p) => p.startsWith("/work/")).sort();
    };
    expect(writable("before")).toEqual(["/work/repos"]);
    expect(writable("after")).toEqual(["/work/docs", "/work/repos"]);
    const to = hashOf(w, wide);
    const under = async (id: string): Promise<string | null> => (await w.rt.journal.command("grant", id))!.package;
    expect(await under("/defs/W/body/0/value")).toBe(w.pkg.hash);
    expect(await under(AT2)).toBe(w.pkg.hash);
    expect(await under("/defs/W/body/2/value")).toBe(to);
    expect(await w.rt.replayRun("grant")).toEqual({ status: "complete", value: "fixed after" });
  });

  it("a map the envelope refused before the amendment stays refused after it, in a resumed run and in a replay", async () => {
    // Four items and three agents: the map has no `max`, so the envelope's agents bound it, and it is refused. The
    // workflow hands what the map would have done to a lead, and the lead asks for more agents.
    const body = `  let early = map i in items {\n    delegate Worker.fix(i)\n  }\n  on error(Rejected(why, detail)) => plan Lead.finish(items) within envelope\n  "ended"`;
    const src = (agents: number): string => program({ body, budget: `{ tokens: 200k, steps: 400, agents: ${agents} }` });
    const HANDLER = "/defs/W/body/1/then";
    const w = await planned([amend(envelopeOf(src(12))), finish("planned")], { src: src(3) });
    const items = [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }];
    const r = await run(w, "map", { input: { items } });
    expect(r.waiting).toMatchObject({ kind: "amendment", command: waitAt(1, HANDLER) });
    expect(await commandIds(w, "map", "refusal")).toEqual(["/defs/W/body/0/value/refused"]);
    const done = await decide(w, "map", "amend");
    expect(state(done)).toBe("succeeded null");
    expect(done.result).toBe("ended");
    expect((await limits(w, "map"))["agents"]).toBe(12);
    // Twelve agents would have let the map run its four items. It was refused, and it stays so: no worker ever ran,
    // and the lead that planned in its place went on from where it asked.
    expect(w.chat.calls.filter((c) => c.agent === "Worker")).toEqual([]);
    expect(await events(w, "map", "map_started")).toEqual([]);
    expect(w.chat.calls.filter((c) => c.agent === "Lead")).toHaveLength(2);
    expect(await commandIds(w, "map", "refusal")).toEqual(["/defs/W/body/0/value/refused"]);
    expect(await w.rt.replayRun("map")).toEqual({ status: "complete", value: "ended" });
  });

  it("a run no lead can amend records no refusal: its map is checked again each time, as it always was", async () => {
    const body = `  let early = map i in items {\n    delegate Worker.fix(i)\n  }\n  on error(Rejected(why, detail)) => map i in items max 9 {\n    "left"\n  }\n  "no plan"`;
    const w = await planned([], { src: program({ body, budget: "{ tokens: 200k, steps: 400, agents: 3 }" }) });
    const r = await run(w, "plain", { input: { items: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }] } });
    expect(state(r)).toBe("succeeded null");
    expect(await commandIds(w, "plain", "refusal")).toEqual([]);
  });
});

// ── more than one amendment ─────────────────────────────────────────────

describe("more than one amendment", () => {
  it("an amendment asked of the old package ends unanswered when another is approved, and its lead may ask again", async () => {
    const src = (budget?: string): string => program({ body: BRANCHES, ...(budget ? { budget } : {}) });
    const tokens = src(WIDER);
    const steps = src("{ tokens: 200k, steps: 800, agents: 12 }");
    const both = src("{ tokens: 400k, steps: 800, agents: 12 }");
    const w = await planned([], { src: src() });
    const told = leads(w, { [ONE]: [amend(envelopeOf(tokens)), finish("one")], [TWO]: [amend(envelopeOf(steps)), amend(envelopeOf(steps)), amend(envelopeOf(both)), finish("two")] });
    const r = await run(w, "two");
    expect(await commandIds(w, "two", "amendment")).toEqual([waitAt(1, ONE), waitAt(1, TWO)]);
    expect(r.waiting).toMatchObject({ kind: "amendment", command: waitAt(1, ONE) });

    const next = await decide(w, "two", "amend");
    // The second lead's request was for the old package with more steps: approving it now would take the tokens back.
    expect(await events(w, "two", "package_amended")).toMatchObject([{ from: w.pkg.hash, to: hashOf(w, tokens), superseded: [waitAt(1, TWO)] }]);
    expect(told[TWO]![0]).toMatchObject({ amended: false, declined: { reason: "superseded", by: null }, envelope: envelopeOf(tokens) });
    // Asked again as it was, it would narrow the envelope the run has now (E1709). With both, it is a new amendment.
    expect(refusals(told[TWO]![1])).toEqual([["MDT-E1709", "/defs/W/envelope/budget/tokens", { dimension: "tokens", was: 400_000, asked: 200_000 }]]);
    expect(next.waiting).toMatchObject({ kind: "amendment", command: waitAt(3, TWO), request: { from: hashOf(w, tokens), package: hashOf(w, both) } });
    const done = await decide(w, "two", "amend");
    expect(state(done)).toBe("succeeded null");
    expect(done.package_hash).toBe(hashOf(w, both));
    expect(await limits(w, "two")).toEqual({ tokens: 400_000, steps: 800, agents: 12 });
    expect((await events(w, "two", "package_amended")).map((e) => [e["from"], e["to"]])).toEqual([
      [w.pkg.hash, hashOf(w, tokens)],
      [hashOf(w, tokens), hashOf(w, both)],
    ]);
    expect(await w.rt.replayRun("two")).toEqual({ status: "complete", value: "one" });
  });
});

// ── the journal ─────────────────────────────────────────────────────────

describe("the journal of an amendment", () => {
  it("moves the run in one step: limits only rise, none is added, and the lease of the old package's worker ends", async () => {
    const w = await planned([amend(envelopeOf(program({ budget: WIDER }))), finish()]);
    const r = await run(w, "j");
    const to = hashOf(w, program({ budget: WIDER }));
    const moved = await w.db.tx((tx) => w.rt.journal.amendRun(tx, "j", "elsewhere", to, { tokens: 400_000, steps: 100, agents: 12, "spend:USD": 5_000_000 }));
    // Tokens rise. Steps would be lowered, agents are as they were, and the run has no limit on money to raise.
    expect(moved).toEqual({ limits: { tokens: 200_000 }, superseded: [waitAt(1)] });
    expect(await limits(w, "j")).toEqual({ tokens: 400_000, steps: 400, agents: 12 });
    const now = await w.rt.getRun("j");
    expect(now.package_hash).toBe(to);
    expect(now.fence).toBe(r.fence + 1);
    // The worker that held the lease writes nothing more.
    await expect(w.rt.journal.dispatch("j", r.fence, { id: "late", kind: "tool", digest: "sha256:0" }, undefined)).rejects.toBeInstanceOf(StaleFence);
  });

  it("asks nobody in a run that somebody asked to cancel, and stores nothing", async () => {
    const w = await planned([amend(envelopeOf(program({ budget: WIDER }))), finish()]);
    const r = await run(w, "c");
    await w.db.query("update runs set cancel_requested = true where run_id = 'c'");
    const pkg = { hash: "sha256:new", program: {}, lock: {}, modules: {} };
    await expect(w.rt.journal.openAmendment("c", r.fence, { id: "another/amendment", digest: "sha256:1" }, {}, pkg, {})).rejects.toBeInstanceOf(Cancelled);
    expect(await w.db.query("select 1 from packages where package_hash = 'sha256:new'")).toEqual([]);
    expect(await events(w, "c", "amendment_requested")).toHaveLength(1);
  });

  it("opens a wait once: a resumed run that comes to it again finds it as it is, and asks nobody twice", async () => {
    const wider = program({ budget: WIDER });
    const w = await planned([amend(envelopeOf(wider)), finish("amended")]);
    await run(w, "again");
    const asked = w.chat.calls.length;
    // The worker is gone and another takes the run: it comes to the same step, and waits where the first one did.
    const resumed = await w.rt.resume("again");
    expect(resumed.waiting).toMatchObject({ kind: "amendment", command: waitAt(1) });
    expect(await events(w, "again", "amendment_requested")).toHaveLength(1);
    expect(await events(w, "again", "wait_opened")).toHaveLength(1);
    expect(w.chat.calls.length).toBe(asked);
    expect(state(await decide(w, "again", "amend"))).toBe("succeeded null");
  });
});

void fixed;
