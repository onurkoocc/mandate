// The run views of 0.4 (spec/envelope.md "Views", spec/views.md "Views of a
// run"; INV-10). A run under an envelope shows what is left of the envelope
// and how it was amended; per `plan`, what its lead submitted, with each
// admitted sub-program as text; per map, its items by index with their
// outcome; and each decision with its member, its role and whether its
// signature holds. What a model wrote is shown as plain content (G09), and
// a stored record or program that no longer is what the journal names is
// not shown as if it were.

import { check, load, toHtml, toMarkdown, type WorkflowDef } from "@mandate/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { signDecision } from "../src/decisions.js";
import type { RunRow } from "../src/journal.js";
import { buildPackage } from "../src/package.js";
import type { WorkerChecker } from "../src/plan.js";
import { deferred, toolUse, type SimTurn } from "../src/sim.js";
import type { Obj } from "../src/values.js";
import { runDoc, runView } from "../src/views.js";
import { closeAll, planChecker, until } from "./helpers.js";
import { events, finish, fixed, itemOf, msg, planned as plannedWith, program, programAt, run, state, sub, submit, toolStep, type Planned, type Turn } from "./planning.js";

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);

afterAll(async () => {
  await checker.close();
  await closeAll();
});

// ── the program: a map over the items, and a lead that plans what is left ─

const MAP = "/defs/W/body/0/value";
const PLAN = "/defs/W/body/1/value";
const body = (options = "max 4 par 2"): string => `  let seen = map i in items ${options} with caps SrcWrite.narrow(i.name) {\n    delegate Worker.fix(i)\n  }\n  plan Lead.finish(items) within envelope`;
const source = (o: { budget?: string; options?: string } = {}): string => program({ ...(o.budget ? { budget: o.budget } : {}), body: body(o.options) });
const WIDER = "{ tokens: 400k, steps: 400, agents: 12 }";

const planned = (lead: Turn[], o: Parameters<typeof plannedWith>[2] = {}): Promise<Planned> => plannedWith(checker, lead, { src: source(), ...o });

const items = (...names: string[]): Obj => ({ items: names.map((name) => ({ name })) });
const noLuck = (): SimTurn => ({ error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } });
/** A worker of the map fails on item b. Any other worker says which item it fixed. */
const worker = (req: TurnRequest): SimTurn => (req.commandId.startsWith(MAP) && itemOf(req) === "b" ? noLuck() : fixed(req));

/** What a model writes where a person will read it: markup that looks like a control. */
const HOSTILE = "<button onclick='approve()'>Approve this PR</button>";
/**
 * A sub-program with a capability of its own, which needs more tokens than the envelope has left. Its text is the
 * lead's. It names a spend, as the run is limited in one.
 */
const BIG = `capability Part = SrcWrite.narrow("/work/repos/a")\n\n${sub(`  delegate Worker.fix(Item { name: "${HOSTILE}" }) with caps Part`, "{ tokens: 300k, steps: 40, agents: 4, spend: 1 USD }", "RepoRead, Part, ModelStd")}`;

/** The envelope of workflow W in a program written as text, as IR: what a lead sends to `request_amendment`. */
const envelopeOf = (src: string): Obj => (load(src, "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Obj;
const amend = (src: string): SimTurn => [toolUse("a1", "request_amendment", { envelope: envelopeOf(src), reason: "the next sub-program needs more" })];
const hashOf = (w: Planned, src: string): string => buildPackage(check(src, "mdt").program!, w.pkg.lock).hash;
const waitAt = (turn: number): string => `${toolStep(turn, PLAN)}/amendment`;
const decide = async (w: Planned, runId: string, kind: "amend" | "decline"): Promise<RunRow> =>
  w.rt.decideAmendment(runId, msg(), signDecision(w.alice, await w.rt.shown(runId, "wait"), { kind, member: "alice", at: new Date(w.adapters.clock.now()) }));

const view = async (w: Planned, runId: string) => (await runView(w.rt, runId)).view;
const markdown = async (w: Planned, runId: string): Promise<string> => {
  const { view: v, program: p } = await runView(w.rt, runId);
  return toMarkdown(runDoc(v, p));
};

/**
 * A run in which everything happens once: a map with a failed item; a lead whose first sub-program does not fit,
 * whose first amendment the owner declines and whose second the owner approves, and whose sub-program then runs.
 */
async function whole(runId: string): Promise<{ w: Planned; to: string }> {
  const w = await planned([submit(1, BIG), amend(source({ budget: WIDER })), amend(source({ budget: WIDER })), submit(1, BIG), finish("done")], { worker });
  // The caller gives this run fewer steps than the envelope does, and a spend limit, of which the envelope says nothing.
  const asked = await run(w, runId, { input: items("a", "b", "c"), limits: { steps: 100, spend: { micros: 9_000_000, currency: "USD" } } });
  expect(state(asked)).toContain("waiting");
  return { w, to: hashOf(w, source({ budget: WIDER })) };
}

async function finished(runId: string): Promise<{ w: Planned; to: string }> {
  const { w, to } = await whole(runId);
  expect((await decide(w, runId, "decline")).state).toBe("waiting");
  expect(state(await decide(w, runId, "amend"))).toBe("succeeded null");
  return { w, to };
}

// ── the envelope ────────────────────────────────────────────────────────

describe("a run's view under an envelope: what is left of it, and how it was amended", () => {
  it("shows in each dimension what the envelope gives, the run's limit and what is left, and each amendment with both packages", async () => {
    const { w, to } = await whole("env");
    const before = (await view(w, "env")).envelope!;
    expect(before).toMatchObject({ workflow: "W", owner: "platform_lead", deadline: null, amendments: [] });
    expect(await markdown(w, "env")).toContain("The envelope has not been amended.");

    await decide(w, "env", "decline");
    await decide(w, "env", "amend");
    const report = await w.rt.budgetReport("env");
    const gives: Record<string, number | null> = { agents: 12, "spend:USD": null, steps: 400, tokens: 400_000 };
    const v = (await view(w, "env")).envelope!;
    // The envelope's amounts are the amended ones. The run's limits are its own: 100 steps, as its caller said.
    expect(v.remainder).toEqual(report.dimensions.map((d) => ({ dimension: d.dimension, envelope: gives[d.dimension], limit: d.limit, settled: d.settled, reserved: d.reserved, left: d.available })));
    expect(v.remainder.map((d) => [d.dimension, d.envelope, d.limit])).toEqual([
      ["agents", 12, 12],
      ["spend:USD", null, 9_000_000],
      ["steps", 400, 100],
      ["tokens", 400_000, 400_000],
    ]);
    // Two workers of the map that ended, one that failed, the lead, and the sub-program's one.
    expect(v.remainder[0]).toMatchObject({ settled: 5, reserved: 0, left: 7 });
    expect(v.amendments).toEqual([{ from: w.pkg.hash, to, by: "alice", role: "platform_lead", command: waitAt(3), limits: { tokens: { from: 200_000, to: 400_000 } } }]);

    const md = await markdown(w, "env");
    expect(md).toContain("## Envelope");
    expect(md).toContain("W runs under an envelope that platform\\_lead owns. It sets no time, so the run has no deadline.");
    expect(md).toContain("| spend:USD | no limit | 9.0000 USD |");
    expect(md).toContain("| steps | 400 | 100 |");
    expect(md).toContain(`| 1 | \` ${w.pkg.hash} \` | \` ${to} \` | alice (platform\\_lead) | tokens: 200000 → 400000 |`);
  });

  it("shows the run's deadline, its start plus the envelope's time, and why an amendment nobody answered ended", async () => {
    const timed = (tokens: string): string => source({ budget: `{ tokens: ${tokens}, steps: 400, agents: 12, time: 1h }` });
    const w = await planned([amend(timed("400k")), finish("ran out of time to ask")], { src: timed("200k"), worker });
    const started = w.adapters.clock.now();
    await run(w, "timed", { input: items("a") });
    expect((await view(w, "timed")).envelope!.deadline).toBe(started + 3_600_000);
    expect(await markdown(w, "timed")).toContain(`The run's deadline is ${new Date(started + 3_600_000).toISOString()}, its start plus the envelope's time.`);
    w.clock.advance(3_600_000);
    expect(state(await w.rt.tick("timed"))).toBe("succeeded null");
    // The lead submitted nothing: the plan's section is there for what it asked, and names it.
    expect((await view(w, "timed")).plans).toEqual([
      { node: PLAN, lead: "Lead.finish", submissions: [], amendments: [{ step: toolStep(1, PLAN), from: w.pkg.hash, package: hashOf(w, timed("400k")), outcome: "approval_expired", by: null }] },
    ]);
  });

});

// ── plans ───────────────────────────────────────────────────────────────

describe("a run's view of a plan: what its lead submitted", () => {
  it("lists each submission in order with its number, its outcome, its hash, its reservation and the codes that refused it, and the amendments asked", async () => {
    const { w, to } = await whole("plan");
    // While the first amendment waits: one refused submission, and an amendment nobody has decided.
    const early = await view(w, "plan");
    expect(early.plans).toEqual([
      {
        node: PLAN,
        lead: "Lead.finish",
        submissions: [{ step: toolStep(1, PLAN), number: 1, outcome: "refused", hash: null, codes: ["MDT-E1706"], governance: [], reservation: {}, command: null, state: null, text: null, stored: null }],
        amendments: [{ step: toolStep(2, PLAN), from: w.pkg.hash, package: to, outcome: "waiting", by: null }],
      },
    ]);

    await decide(w, "plan", "decline");
    await decide(w, "plan", "amend");
    const [admitted] = await events(w, "plan", "program_admitted");
    const late = await view(w, "plan");
    expect(late.plans).toEqual([
      {
        node: PLAN,
        lead: "Lead.finish",
        submissions: [
          early.plans[0]!.submissions[0],
          // The second fits the amended envelope, and was admitted under the number the first did not take.
          {
            step: toolStep(4, PLAN),
            number: 1,
            outcome: "admitted",
            hash: admitted!["hash"],
            codes: [],
            governance: ["capability_added"],
            reservation: { tokens: 300_000, steps: 40, agents: 4, "spend:USD": 1_000_000 },
            command: programAt(1, PLAN),
            state: "succeeded",
            text: expect.stringContaining("capability Part = SrcWrite.narrow(\"/work/repos/a\")"),
            stored: "kept",
          },
        ],
        amendments: [
          { step: toolStep(2, PLAN), from: w.pkg.hash, package: to, outcome: "declined", by: "alice" },
          { step: toolStep(3, PLAN), from: w.pkg.hash, package: to, outcome: "approved", by: "alice" },
        ],
      },
    ]);

    const md = await markdown(w, "plan");
    expect(md).toContain(`## Plan at ${PLAN}`);
    expect(md).toContain("Lead.finish submitted 2 sub-programs: 1 admitted, 1 refused.");
    expect(md).toContain("| 1 | refused: MDT-E1706 | — | — | — | — | — |");
    expect(md).toContain(`| 1 | admitted | \` ${String(admitted!["hash"])} \` | agents: 4, spend:USD: 1.0000 USD, steps: 40, tokens: 300000 | capability\\_added | \` ${programAt(1, PLAN)} \` | succeeded |`);
    expect(md).toContain("A refused submission takes no number: the next one is checked under the same number.");
    expect(md).toContain(`| \` ${w.pkg.hash} \` | \` ${to} \` | declined by alice |`);
    expect(md).toContain(`| \` ${w.pkg.hash} \` | \` ${to} \` | approved by alice |`);
  });

  it("names the lead of a plan that submitted and asked for no amendment", async () => {
    const w = await planned([submit(1, BIG), finish("gave up")], { worker });
    expect(state(await run(w, "lead", { input: items("a") }))).toBe("succeeded null");
    expect((await view(w, "lead")).plans).toMatchObject([{ node: PLAN, lead: "Lead.finish", submissions: [{ number: 1, outcome: "refused" }], amendments: [] }]);
  });

  it("shows an admitted sub-program as the lead wrote it: as plain content, never as a control (G09)", async () => {
    const { w } = await finished("g09");
    const { view: v, program: p } = await runView(w.rt, "g09");
    const text = v.plans[0]!.submissions[1]!.text!;
    expect(text).toContain(`delegate Worker.fix(Item { name: "${HOSTILE}" })`);
    const html = toHtml(runDoc(v, p));
    expect(html).not.toMatch(/<button/i);
    expect(html).toContain("&lt;button onclick=");
    const md = toMarkdown(runDoc(v, p));
    const at = md.indexOf("<button");
    expect(at).toBeGreaterThan(0);
    expect(md.lastIndexOf("```text", at)).toBeGreaterThan(md.lastIndexOf("\n```\n", at));
    expect(md.slice(0, at)).toContain("Sub-program 1, as the lead wrote it:");
  });

  it("does not show what is stored as a sub-program when it is gone, or does not hash to what was admitted", async () => {
    const { w } = await finished("stored");
    const [admitted] = await events(w, "stored", "program_admitted");
    // Another program is stored where the journal says the admitted one is.
    const other = await w.rt.artifacts.put({ tenant: "default", runId: "stored" }, JSON.stringify(check(source(), "mdt").program));
    await w.db.query("update events set data = jsonb_set(data, '{artifact}', to_jsonb($2::text)) where run_id = $1 and type = 'program_admitted'", ["stored", other.ref]);
    expect((await view(w, "stored")).plans[0]!.submissions[1]).toMatchObject({ outcome: "admitted", hash: admitted!["hash"], text: null, stored: "mismatch" });
    expect(await markdown(w, "stored")).toContain("What is stored as sub-program 1 does not hash to what was admitted, and is not shown.");
    // Nothing is stored there any more.
    await w.db.query("update events set data = jsonb_set(data, '{artifact}', to_jsonb($2::text)) where run_id = $1 and type = 'program_admitted'", ["stored", `blob:sha256:${"0".repeat(64)}`]);
    expect((await view(w, "stored")).plans[0]!.submissions[1]).toMatchObject({ outcome: "admitted", hash: admitted!["hash"], text: null, stored: "gone" });
    expect(await markdown(w, "stored")).toContain("Sub-program 1 is not kept any more; its hash names what ran.");
  });

  it("shows a submission the journal has neither admitted nor refused yet as submitted", async () => {
    const { w } = await finished("between");
    const [admitted] = await events(w, "between", "program_admitted");
    // As the journal stands between the record of what the lead sent and its admission.
    await w.db.query("delete from events where run_id = $1 and type = 'program_admitted'", ["between"]);
    expect((await view(w, "between")).plans[0]!.submissions[1]).toMatchObject({ number: 1, outcome: "submitted", hash: admitted!["hash"], reservation: {}, command: null, state: null, text: null, stored: null });
    expect(await markdown(w, "between")).toContain("Lead.finish submitted 2 sub-programs: 0 admitted, 1 refused.");
  });
});

// ── maps ────────────────────────────────────────────────────────────────

describe("a run's view of a map: its items by index, with their outcome", () => {
  it("shows each item's outcome once the map has ended: Ok, or the item's fault", async () => {
    const { w } = await whole("map");
    expect((await view(w, "map")).maps).toEqual([{ node: MAP, items: 3, par: 2, state: "ended", failed: null, outcomes: ["Ok", "SkillFailed", "Ok"] }]);
    const md = await markdown(w, "map");
    expect(md).toContain(`## Map at ${MAP}`);
    expect(md).toContain("3 items, at most 2 at once. It has ended.");
    expect(md).toContain("| 1 | SkillFailed |");
  });

  it("shows where each item stands while the map runs: in flight, or settled once its commands have ended, whether they succeeded or failed", async () => {
    const gate = deferred<void>();
    const arrived = new Set<string>();
    const w = await planned([finish("done")], {
      worker: async (req) => {
        const name = itemOf(req);
        arrived.add(name);
        if (name === "a" || name === "d") await gate.promise;
        return name === "b" ? noLuck() : fixed(req);
      },
    });
    const p = run(w, "running", { input: items("a", "b", "c", "d") });
    // Two at a time: a is held. In the other place b fails, c ends, and d is taken up and held.
    await until(() => arrived.has("d"), "the fourth item in flight");
    expect((await view(w, "running")).maps).toEqual([{ node: MAP, items: 4, par: 2, state: "running", failed: null, outcomes: ["in flight", "settled", "settled", "in flight"] }]);
    expect(await markdown(w, "running")).toContain("4 items, at most 2 at once. It has not ended.");
    gate.resolve();
    expect(state(await p)).toBe("succeeded null");
    expect((await view(w, "running")).maps).toEqual([{ node: MAP, items: 4, par: 2, state: "ended", failed: null, outcomes: ["Ok", "SkillFailed", "Ok", "Ok"] }]);
  });

  it("tells one map from another: a map that has ended says nothing of one that still runs", async () => {
    const SECOND = "/defs/W/body/1/value";
    const two = program({ body: `${body().split("\n").slice(0, 3).join("\n")}\n  let again = map i in items max 4 with caps SrcWrite.narrow(i.name) {\n    delegate Worker.fix(i)\n  }\n  plan Lead.finish(items) within envelope` });
    const gate = deferred<void>();
    let held = false;
    const w = await planned([finish("done")], {
      src: two,
      worker: async (req) => {
        if (req.commandId.startsWith(SECOND)) {
          held = true;
          await gate.promise;
        }
        return fixed(req);
      },
    });
    const p = run(w, "two", { input: items("a", "b") });
    await until(() => held, "the second map's first item in flight");
    expect((await view(w, "two")).maps).toEqual([
      { node: MAP, items: 2, par: 2, state: "ended", failed: null, outcomes: ["Ok", "Ok"] },
      { node: SECOND, items: 2, par: 1, state: "running", failed: null, outcomes: ["in flight", "not started"] },
    ]);
    gate.resolve();
    expect(state(await p)).toBe("succeeded null");
    // Each map records its own end: the first one's is not the second's.
    expect((await view(w, "two")).maps.map((m) => [m.node, m.state, m.outcomes])).toEqual([
      [MAP, "ended", ["Ok", "Ok"]],
      [SECOND, "ended", ["Ok", "Ok"]],
    ]);
  });

  it("shows a map that fail_fast failed, with the fault, and no outcome for the items it did not start", async () => {
    const w = await planned([], { src: source({ options: "max 4 supervise fail_fast" }), worker: (req) => (itemOf(req) === "b" ? noLuck() : fixed(req)) });
    const r = await run(w, "ff", { input: items("a", "b", "c") });
    expect(r.state).toBe("failed");
    const v = await view(w, "ff");
    expect(v.maps).toEqual([{ node: MAP, items: 3, par: 1, state: "failed", failed: "SkillFailed", outcomes: ["Ok", "SkillFailed", "no outcome"] }]);
    // The lead never ran: the view has no plan to show.
    expect(v.plans).toEqual([]);
    const md = await markdown(w, "ff");
    expect(md).toContain("3 items, at most 1 at once. It failed with SkillFailed, and started no further item.");
    expect(md).toContain("| 2 | no outcome |");
  });
});

// ── decisions ───────────────────────────────────────────────────────────

describe("a run's view of its decisions: the member, the role, and whether the signature holds", () => {
  const rows = async (w: Planned, runId: string) => (await view(w, runId)).decisions.map((d) => [d.kind, d.by, d.role, d.signature, d.about]);

  it("lists each signed decision in the order the run took it, checked again when the view is made", async () => {
    const { w } = await finished("signed");
    expect(await rows(w, "signed")).toEqual([
      ["envelope", "alice", "platform_lead", "valid", null],
      ["decline", "alice", "platform_lead", "valid", waitAt(2)],
      ["amend", "alice", "platform_lead", "valid", waitAt(3)],
    ]);
    const stored = await w.rt.verifyDecisions("signed");
    const v = await view(w, "signed");
    expect(v.decisions.map((d) => [d.decision_id, d.problem])).toEqual(stored.map((d) => [d.decision_id, null]));
    const md = await markdown(w, "signed");
    expect(md).toContain("## Decisions");
    expect(md).toContain(`| envelope | alice | platform\\_lead | valid | — | \` ${stored[0]!.decision_id} \` |`);
    expect(md).toContain(`| amend | alice | platform\\_lead | valid | \` ${waitAt(3)} \` | \` ${stored[2]!.decision_id} \` |`);
  });

  it("says of a record that was changed after it was signed that its signature does not hold, and why (INV-16)", async () => {
    const { w } = await finished("forged");
    // The stored decline is rewritten as an approval.
    await w.db.query("update decisions set record = jsonb_set(record, '{kind}', '\"amend\"') where run_id = $1 and kind = 'decline'", ["forged"]);
    const v = await view(w, "forged");
    expect(v.decisions.map((d) => [d.kind, d.signature, d.problem])).toEqual([
      ["envelope", "valid", null],
      ["amend", "invalid", "its record was changed after it was signed"],
      ["amend", "valid", null],
    ]);
    const md = await markdown(w, "forged");
    // The member's name is the lock's only while the signature holds: here it is shown as what somebody wrote.
    expect(md).toContain("| amend | ` alice ` | platform\\_lead | INVALID: its record was changed after it was signed |");
  });

  it("says of a decision whose record is not stored any more that it cannot be checked, and leaves out no stored record the journal does not name", async () => {
    const { w } = await finished("gone");
    const [envelope, decline] = await w.rt.verifyDecisions("gone");
    await w.db.query("delete from decisions where decision_id = $1", [decline!.decision_id]);
    await w.db.query("delete from events where run_id = $1 and type = 'envelope_approved'", ["gone"]);
    const v = await view(w, "gone");
    expect(v.decisions.map((d) => [d.kind, d.by, d.role, d.signature, d.problem, d.decision_id])).toEqual([
      // What the journal's event says of it: the kind of the event, and the member and role it names.
      ["decision", "alice", "platform_lead", "invalid", "the record the journal names is not stored", decline!.decision_id],
      ["amend", "alice", "platform_lead", "valid", null, expect.any(String)],
      // The approval the run started on is stored, and no event names it now: it is listed all the same.
      ["envelope", "alice", "platform_lead", "valid", null, envelope!.decision_id],
    ]);
    // Two events name the owner's approval of the amendment: the decision, and the move to the new package. With
    // its record gone too it is still one decision, listed once.
    const amend = v.decisions[1]!.decision_id!;
    await w.db.query("delete from decisions where decision_id = $1", [amend]);
    expect((await view(w, "gone")).decisions.map((d) => [d.kind, d.signature, d.decision_id])).toEqual([
      ["decision", "invalid", decline!.decision_id],
      ["decision", "invalid", amend],
      ["envelope", "valid", envelope!.decision_id],
    ]);
  });
});
