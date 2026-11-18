// What a person is shown of a run of 0.7 (spec/attention.md "Masking and how a value is known", "A role's view",
// "`WatchRun`", "`ListWaits`"; slice B4): every value a role is shown of a wait or a report is masked when its data
// class is above the role's cap (`role_classes` in the lock, else `internal`) or is not known, and labelled with its
// class and how it is known either way; the audit audience sees every value. The role view gains `stages`, `reports`
// (those addressed to the role) and `programs`; `WatchRun` gives each event through a fixed allow-list of its fields;
// `ListWaits` lists the open questions across runs. A run of 0.1 to 0.6 is shown as it always was.
//
// Every rule holds on PGlite and on PostgreSQL (helpers.ts, MANDATE_TEST_DATABASE_URL).

import { load, toMarkdown, type Lock } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTENTION_MEDIA_TYPE } from "../src/attention.js";
import { payloadOf, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { capOf, labelOf, maskRequest, maskValue, UNKNOWN } from "../src/mask.js";
import { baseOf, type WorkerChecker } from "../src/plan.js";
import { NOTHING, PROJECTIONS } from "../src/projection.js";
import { buildPackage } from "../src/runtime.js";
import { SimAgents, toolUse, type SimTurn } from "../src/sim.js";
import { digest, type Obj, type Value } from "../src/values.js";
import { auditDoc, roleDoc, runDoc, runView } from "../src/views.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { BUDGET, CAPS, finish, fixes, MODULE, planned, program as planProgram, run as runPlan, state, submit, type Turn } from "./planning.js";

afterAll(closeAll);

// ── the mask ────────────────────────────────────────────────────────────

describe("the mask", () => {
  it("shows a value at or below the role's cap, masks one above it, and labels it either way", () => {
    const label = { class: "confidential", known: "model" } as const;
    expect(maskValue("made-up", label, "confidential")).toEqual({ masked: false, value: "made-up", class: "confidential", known: "model" });
    expect(maskValue("made-up", label, "restricted")).toEqual({ masked: false, value: "made-up", class: "confidential", known: "model" });
    expect(maskValue("made-up", label, "internal")).toEqual({ masked: true, class: "confidential", known: "model" });
    expect(maskValue("made-up", label, "public")).toEqual({ masked: true, class: "confidential", known: "model" });
    expect(maskValue("made-up", { class: "public", known: "plain" }, "public")).toEqual({ masked: false, value: "made-up", class: "public", known: "plain" });
  });

  it("masks a value whose class is not known for every role, and shows the audit audience every value, labelled", () => {
    for (const cap of ["public", "internal", "confidential", "restricted"] as const) expect(maskValue("made-up", undefined, cap)).toEqual({ masked: true, class: "restricted", known: "external" });
    expect(UNKNOWN).toEqual({ class: "restricted", known: "external" });
    expect(maskValue("made-up", undefined, "audit")).toEqual({ masked: false, value: "made-up", class: "restricted", known: "external" });
    expect(maskValue("made-up", { class: "restricted", known: "verified" }, "audit")).toEqual({ masked: false, value: "made-up", class: "restricted", known: "verified" });
    // A class or a level the runtime does not know is no label.
    expect(labelOf("secret", "plain")).toBeUndefined();
    expect(labelOf("public", "guessed")).toBeUndefined();
    expect(labelOf("internal", "verified")).toEqual({ class: "internal", known: "verified" });
  });

  it("caps a role at its role_classes entry, else internal; an entry that is no class shows the least", () => {
    const lock = { modules: {}, role_classes: { reviewer: "confidential", odd: "secret" } } as unknown as Lock;
    expect(capOf(lock, "reviewer")).toBe("confidential");
    expect(capOf(lock, "auditor")).toBe("internal");
    expect(capOf(lock, "odd")).toBe("public");
    expect(capOf({ modules: {} } as Lock, "reviewer")).toBe("internal");
    expect(capOf(lock, "toString")).toBe("internal");
  });

  it("masks every member of a request that is not the runtime's own, a member it does not know among them", () => {
    const label = { class: "confidential", known: "plain" } as const;
    const request = { role: "reviewer", question: "made-up", deadline: 5, novel: "made-up too" };
    const { request: masked, shown } = maskRequest("input", request, label, "internal");
    expect(masked).toEqual({ role: "reviewer", deadline: 5, question: { masked: true, class: "confidential", known: "plain" }, novel: { masked: true, class: "confidential", known: "plain" } });
    expect(shown.map((s) => s.name)).toEqual(["question", "novel"]);
    expect(JSON.stringify(masked)).not.toContain("made-up");
    // A kind it does not know keeps nothing as it is.
    expect(JSON.stringify(maskRequest("timer_of_a_later_release", request, label, "internal").request)).not.toContain("reviewer");
  });

  it("keeps a review's items by index and what they did not meet, and masks each item's value and digest", () => {
    const request = {
      question: { review: "/r", contract: "Fits", map: "/m", role: "reviewer", escalate_to: null, deadline_ms: 1, declined: [], failed: [], accepted: [0], items: [{ index: 1, value: "made-up", value_digest: "sha256:x", unmet: [{ criterion: "same" }] }] },
      subject_digest: "sha256:s",
      role: "reviewer",
      escalate_to: null,
      deadline: 2,
      deadline_ms: 1,
    } as unknown as Value;
    const { request: masked, shown } = maskRequest("review", request, { class: "restricted", known: "model" }, "confidential");
    const item = ((masked as Obj)["question"] as Obj)["items"] as Obj[];
    expect(item[0]).toEqual({ index: 1, unmet: [{ criterion: "same" }], value: { masked: true, class: "restricted", known: "model" }, value_digest: { masked: true, class: "restricted", known: "model" } });
    expect(shown.map((s) => s.name)).toEqual(["question.items[0].value", "question.items[0].value_digest"]);
    expect(JSON.stringify(masked)).not.toContain("made-up");
  });
});

// ── a run of 0.7 ────────────────────────────────────────────────────────

/** A secret stand-in: no part of what a capped role is shown may hold it. */
const MARK = "made-up-marker";

const SRC = `mandate @ 0.7

module example.attention.mask @ 0.1

use std.{human}

role reviewer "Reviewer"
role auditor  "Auditor"

type Secret = Text classified confidential

/// Asks the reviewer about a secret, tells the auditor, then asks anyone.
workflow Ask(name: Text, secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  stage first "Ask about it"
  let a = human.ask("Is {secret} right for {name}?", role: reviewer)
  report to auditor "Told" { secret: secret, n: len(name) }

  stage second "Ask anyone"
  let b = human.ask("Anything else?")
  a
}

/// Asks two roles at once.
workflow Both(name: Text) -> Int
  caps   []
  budget { time: 5m, steps: 4 }
{
  par {
    one = human.ask("First about {name}?", role: reviewer)
    two = human.ask("Second about {name}?", role: auditor)
  }
  1
}
`;

interface Person {
  member: string;
  key: EvidenceSigner;
}

function people(classes?: Record<string, string>) {
  const ana: Person = { member: "ana", key: EvidenceSigner.generate() };
  const ben: Person = { member: "ben", key: EvidenceSigner.generate() };
  const lock = { modules: {}, members: { ana: { keys: [ana.key.keyId] }, ben: { keys: [ben.key.keyId] } }, roles: { reviewer: ["ana"], auditor: ["ben"] }, ...(classes ? { role_classes: classes } : {}) } as unknown as Lock;
  return { ana, ben, lock, keys: new TrustedKeys([ana.key.publicKey, ben.key.publicKey]) };
}

let n = 0;
async function answer(w: World, runId: string, who: Person, value: Value): Promise<RunRow> {
  const shown = await w.rt.shown(runId, "wait");
  return w.rt.submitInput(runId, { sender: "test", messageId: `m${++n}` }, { value, signed: signDecision(who.key, shown, { kind: "answer", member: who.member, payload: payloadOf.answer(value), at: new Date(w.adapters.clock.now()) }) });
}

async function masking(o: { classes?: Record<string, string>; src?: string } = {}) {
  const who = people(o.classes);
  const w = await world(o.src ?? SRC, { lock: who.lock, decisions: { keys: who.keys } });
  return { ...w, ...who };
}

const start = (w: World, runId: string, workflow = "Ask", input: Obj = { name: "ana", secret: MARK }, pkg = w.pkg): Promise<RunRow> => w.rt.startRun({ pkg, workflow, input, runId });

describe("a role's view of a run of 0.7", () => {
  it("masks the wait's question above the role's cap, labels it, and leaves the marker out of every place a role is shown it", async () => {
    const w = await masking();
    expect((await start(w, "a")).state).toBe("waiting");
    const { view, program, modules } = await runView(w.rt, "a", { role: "reviewer" });
    expect(view.waiting).toEqual({ kind: "input", command: "/defs/Ask/body/1/value", request: { role: "reviewer", question: { masked: true, class: "confidential", known: "plain" } } });
    expect(JSON.stringify(view)).not.toContain(MARK);
    const doc = toMarkdown(roleDoc(view, program, modules));
    expect(doc).not.toContain(MARK);
    expect(doc).toContain("Masked: its class is confidential");
    // WatchRun and ListWaits, for the role asked and for every other.
    for (const role of ["reviewer", "auditor"]) expect(JSON.stringify(await w.rt.watchRun("a", { role }))).not.toContain(MARK);
    const waits = await w.rt.listWaits({ role: "reviewer" });
    expect(waits.map((x) => [x.command, x.asked_of, x.stage, x.on_no_answer, x.shown])).toEqual([["/defs/Ask/body/1/value", "reviewer", "first", "waits", [{ name: "question", masked: true, class: "confidential", known: "plain" }]]]);
    expect(JSON.stringify(await w.rt.listWaits({ member: "ana" }))).not.toContain(MARK);
    // The audit audience sees the value, labelled.
    const audit = await w.rt.watchRun("a", { audit: true });
    const opened = audit.events.find((e) => e.type === "wait_opened")!;
    expect(opened.data!["request"]).toEqual({ role: "reviewer", question: `Is ${MARK} right for ana?` });
    expect(JSON.stringify((await runView(w.rt, "a", { audit: true })).view)).toContain(MARK);
  });

  it("shows the role at or above the class, labelled, once role_classes gives it that class", async () => {
    const w = await masking({ classes: { reviewer: "confidential" } });
    await start(w, "a");
    const { view } = await runView(w.rt, "a", { role: "reviewer" });
    expect((view.waiting as Obj)["request"]).toEqual({ role: "reviewer", question: { masked: false, value: `Is ${MARK} right for ana?`, class: "confidential", known: "plain" } });
    expect((await w.rt.listWaits({ role: "reviewer" }))[0]!.shown).toEqual([{ name: "question", masked: false, value: `Is ${MARK} right for ana?`, class: "confidential", known: "plain" }]);
  });

  it("masks for every role when the facts are missing: a class that is not known is never shown", async () => {
    const w = await masking({ classes: { reviewer: "restricted" } });
    await start(w, "a");
    await w.db.query("delete from artifacts where run_id = $1 and media_type = $2", ["a", ATTENTION_MEDIA_TYPE]);
    const { view } = await runView(w.rt, "a", { role: "reviewer" });
    expect((view.waiting as Obj)["request"]).toEqual({ role: "reviewer", question: { masked: true, class: "restricted", known: "external" } });
    expect(JSON.stringify(await w.rt.listWaits({ role: "reviewer" }))).not.toContain(MARK);
    expect(JSON.stringify(await w.rt.watchRun("a", { role: "reviewer" }))).not.toContain(MARK);
  });

  it("shows a report only to the role it is addressed to, each field masked by its own class, with the stages and the programs", async () => {
    const w = await masking();
    await start(w, "a");
    await answer(w, "a", w.ana, "yes");
    const auditor = (await runView(w.rt, "a", { role: "auditor" })).view;
    expect(auditor.reports).toEqual([
      expect.objectContaining({ title: "Told", fields: [{ name: "secret", type: "Secret", masked: true, class: "confidential", known: "plain" }, { name: "n", type: "Int", masked: false, value: 3, class: "public", known: "plain" }] }),
    ]);
    expect(JSON.stringify(auditor)).not.toContain(MARK);
    expect(auditor.stages).toEqual([
      expect.objectContaining({ stage: "first", title: "Ask about it", state: "done" }),
      expect.objectContaining({ stage: "second", title: "Ask anyone", state: "current", ended_at: null }),
    ]);
    expect(auditor.programs).toEqual({ started: 0, ended: 0 });
    const reviewer = (await runView(w.rt, "a", { role: "reviewer" })).view;
    expect(reviewer.reports).toEqual([]);
    // WatchRun gives the report to the auditor alone, masked; the reviewer is not given it at all.
    const told = (await w.rt.watchRun("a", { role: "auditor" })).events.filter((e) => e.type === "report");
    expect(told).toHaveLength(1);
    expect(JSON.stringify(told)).not.toContain(MARK);
    expect((await w.rt.watchRun("a", { role: "reviewer" })).events.filter((e) => e.type === "report")).toEqual([]);
    // Once the auditor may be shown confidential, the field is shown.
    const w2 = await masking({ classes: { auditor: "confidential" } });
    await start(w2, "a");
    await answer(w2, "a", w2.ana, "yes");
    expect((await runView(w2.rt, "a", { role: "auditor" })).view.reports![0]!.fields[0]).toMatchObject({ value: MARK, class: "confidential" });
  });
});

describe("WatchRun", () => {
  it("gives each event through its allow-list, after a cursor, and nothing of a field it does not name", async () => {
    const w = await masking();
    await start(w, "a");
    await answer(w, "a", w.ana, "yes");
    const all = await w.rt.watchRun("a", { role: "reviewer" }, { limit: 500 });
    for (const e of all.events) {
      const entry = PROJECTIONS[e.type];
      if (entry === undefined || entry === NOTHING) expect(e.data, e.type).toBeUndefined();
      else expect(Object.keys(e.data ?? {}).every((k) => entry.includes(k)), e.type).toBe(true);
    }
    // The answer's event names who decided, and never the key, the sender or the message.
    const received = all.events.find((e) => e.type === "input_received")!;
    expect(Object.keys(received.data!).sort()).toEqual(["command", "decision", "member", "role"]);
    // S3 and S4 are never given; S0 only where it was asked of the role.
    expect(all.events.every((e) => e.class !== "S3" && e.class !== "S4")).toBe(true);
    expect((await w.rt.watchRun("a", { role: "auditor" })).events.filter((e) => e.class === "S0")).toEqual([]);
    // Pages of two, from the cursor each gives: the same events, in order.
    const paged: number[] = [];
    let next = 0;
    for (let i = 0; i < 50; i++) {
      const page = await w.rt.watchRun("a", { role: "reviewer" }, { afterSeq: next, limit: 2 });
      paged.push(...page.events.map((e) => e.seq));
      if (page.next === next) break;
      next = page.next;
    }
    expect(paged).toEqual(all.events.map((e) => e.seq));
    expect(all.ended).toBe(false);
    await expect(w.rt.watchRun("a", { role: "nobody" })).rejects.toMatchObject({ code: "unknown_role" });
    await expect(w.rt.watchRun("a", { role: "reviewer" }, { limit: 501 })).rejects.toMatchObject({ code: "bad_limit" });
    await expect(w.rt.watchRun("a", { role: "reviewer" }, { afterSeq: -1 })).rejects.toMatchObject({ code: "bad_cursor" });
  });
});

describe("ListWaits", () => {
  it("lists a wait that asks no role once for each role the lock binds, masked by each one's cap", async () => {
    const w = await masking({ classes: { auditor: "public" } });
    await start(w, "a");
    await answer(w, "a", w.ana, "yes");
    const forAuditor = await w.rt.listWaits({ role: "auditor" });
    expect(forAuditor.map((x) => [x.command, x.asked_of, x.role, x.stage])).toEqual([["/defs/Ask/body/4/value", null, "auditor", "second"]]);
    expect(forAuditor[0]!.shown).toEqual([{ name: "question", masked: false, value: "Anything else?", class: "public", known: "plain" }]);
    expect((await w.rt.listWaits({ member: "ana" })).map((x) => x.role)).toEqual(["reviewer"]);
    expect(await w.rt.listWaits({ member: "nobody" })).toEqual([]);
    expect(await w.rt.listWaits({ role: "auditor" }, { tenant: "another" })).toHaveLength(0);
    expect(await w.rt.listWaits({ role: "auditor" }, { tenant: "default" })).toHaveLength(1);
  });

  it("lists every wait a par leaves open, and the waits of runs of two packages, each by its own lock", async () => {
    const w = await masking();
    expect((await start(w, "p", "Both", { name: MARK })).state).toBe("waiting");
    const open = await w.rt.listWaits({ member: "ana" });
    expect(open.map((x) => x.role)).toEqual(["reviewer"]);
    expect((await w.rt.listWaits({ role: "auditor" })).map((x) => x.asked_of)).toEqual(["auditor"]);
    // A second package of the same program, whose lock lets the reviewer be shown confidential.
    const other = buildPackage(w.pkg.program, { ...w.lock, role_classes: { reviewer: "confidential" } } as unknown as Lock);
    await start(w, "q", "Ask", { name: "ana", secret: MARK }, other);
    const both = await w.rt.listWaits({ role: "reviewer" });
    expect(both.map((x) => [x.run, x.package === other.hash])).toEqual([["p", false], ["q", true]]);
    expect(JSON.stringify(both.find((x) => x.run === "q")!.shown)).toContain(MARK);
  });

  it("reads the open waits through the partial index commands_waiting", async () => {
    const w = await masking();
    const [index] = await w.db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'commands_waiting'");
    expect(index!.indexdef).toMatch(/ON .*commands USING btree \(run_id\) WHERE \(state = 'waiting'::text\)/);
    const plan = await w.db.tx(async (tx) => {
      await tx.query("set local enable_seqscan = off");
      return tx.query<{ "QUERY PLAN": string }>("explain select c.run_id, c.command_id from commands c join runs r on r.run_id = c.run_id where c.state = 'waiting' and c.kind in ('input', 'decision', 'review', 'amendment') and r.state not in ('succeeded', 'failed', 'cancelled')");
    });
    expect(plan.map((r) => Object.values(r)[0]).join("\n")).toContain("commands_waiting");
  });
});

// ── a run of 0.6, as before ─────────────────────────────────────────────

const SRC06 = `mandate @ 0.6

module example.attention.before @ 0.1

use std.{human}

role reviewer "Reviewer"
role auditor  "Auditor"

workflow Ask(name: Text, secret: Text) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  let a = human.ask("Is {secret} right for {name}?", role: reviewer)
  a
}
`;

describe("a run of 0.6", () => {
  it("is shown as it always was: no section of 0.7, nothing masked or labelled", async () => {
    const w = await masking({ src: SRC06 });
    await start(w, "a");
    const { view } = await runView(w.rt, "a", { role: "reviewer" });
    expect(view.waiting).toEqual({ kind: "input", command: "/defs/Ask/body/0/value", request: { role: "reviewer", question: `Is ${MARK} right for ana?` } });
    expect(Object.keys(view)).not.toContain("stages");
    expect(Object.keys(view)).not.toContain("reports");
    expect(Object.keys(view)).not.toContain("programs");
    expect((await w.rt.listWaits({ role: "reviewer" }))[0]!.shown).toEqual([{ name: "question", value: `Is ${MARK} right for ana?`, class: null, known: null }]);
    const opened = (await w.rt.watchRun("a", { role: "reviewer" })).events.find((e) => e.type === "wait_opened")!;
    expect(opened.data!["request"]).toEqual({ role: "reviewer", question: `Is ${MARK} right for ana?` });
  });
});

// ── a sub-program's start and end ───────────────────────────────────────

const PATTERNS = `/// Asks once, about one item, and tells its reviewer.
pattern Ask(
  work:     skill(Item) -> Inferred<Text>,
  reviewer: role
) () -> Inferred<Text>
{
  stage ask "Ask about the item"
  let out = delegate work(Item { name: "a" })
  report to reviewer "Asked" { answer: out }

  stage give "Give it back"
  out
}

`;
const PARENT = planProgram().replace("mandate @ 0.4", "mandate @ 0.7").replace("workflow W(items", `${PATTERNS}workflow W(items`).replace("agents: 12 }", "agents: 12 }\n    shapes  [Ask]");
const PLAN = "/defs/W/body/0/value";
const BASE = baseOf(MODULE, 1, "mandate/0.7" as never);
const opsOf = (defs: string): Value[] => {
  const r = load(`mandate @ 0.7\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries(r.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
};
const submitting = (defs: string, id = "s1"): SimTurn => [toolUse(id, "submit_program", { base: BASE, ops: opsOf(defs) })];
const APPLIED = `workflow Fix = Ask(work: Worker.fix, reviewer: release_manager)\n  caps   ${CAPS}\n  budget ${BUDGET}\n`;

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(() => checker.close());

const programEvents = async (w: World, runId: string): Promise<Array<[string, Obj]>> =>
  (await w.rt.journal.events(runId)).filter((e) => e.type === "program_started" || e.type === "program_ended").map((e) => [e.type, e.data as Obj]);

describe("program_started and program_ended", () => {
  const lead = (turns: Turn[], src = PARENT) => planned(checker, turns, { src });

  it("are written once each for a sub-program of a 0.7 parent, nothing in a replay, and counted in the role's view", async () => {
    const w = await lead([submitting(APPLIED), finish("planned")]);
    const r = await runPlan(w, "sub");
    expect(r.state, state(r)).toBe("succeeded");
    const command = `${PLAN}/program/1`;
    expect(await programEvents(w, "sub")).toEqual([
      ["program_started", { plan: PLAN, number: 1, command, workflow: "Fix", shape: expect.objectContaining({ pattern: "Ask" }), class: "public" }],
      ["program_ended", { plan: PLAN, number: 1, ok: true }],
    ]);
    // Each is written in order with the sub-program's own events: started before its first stage, ended with its command.
    const types = (await w.rt.journal.events("sub")).map((e) => e.type);
    expect(types.indexOf("program_started")).toBeLessThan(types.indexOf("stage_started"));
    expect(types[types.indexOf("program_ended") - 1]).toBe("command_completed");
    const events = await w.rt.journal.events("sub");
    expect(await w.rt.replayRun("sub")).toEqual({ status: "complete", value: "planned" });
    expect(await w.rt.journal.events("sub")).toEqual(events);
    const view = (await runView(w.rt, "sub", { role: "release_manager" })).view;
    expect(view.programs).toEqual({ started: 1, ended: 1 });
    // A sub-program's stage names are what its lead wrote: a model's values, of the class of what the lead received.
    const byLead = (value: Value) => ({ masked: false, value, class: "public", known: "model" });
    expect(view.stages!.flatMap((s) => [s, ...(s.stages ?? [])]).filter((s) => s.program).map((s) => [s.stage, s.state])).toEqual([[byLead("ask"), "done"], [byLead("give"), "done"]]);
    // WatchRun gives both to a role, by their fields.
    const given = (await w.rt.watchRun("sub", { role: "release_manager" }, { limit: 500 })).events.filter((e) => e.type.startsWith("program_"));
    expect(given.map((e) => [e.type, e.data])).toEqual([
      ["program_started", { plan: PLAN, number: 1, command, workflow: byLead("Fix"), shape: { ...byLead(null), value: expect.objectContaining({ pattern: "Ask" }) }, class: "public" }],
      ["program_ended", { plan: PLAN, number: 1, ok: true }],
    ]);
  });

  it("give what a lead wrote into its sub-program as a model's values of the class of what the lead received, masked by the role's cap, on each path", async () => {
    const TITLE = "made-up-title-marker";
    // The lead receives an internal name (the most its model may); the stage and report titles of what it applies are its own.
    const src = PARENT.replace("type Item = { name: Text }", "type Name = Text classified internal\n\ntype Item = { name: Name }").replace('stage ask "Ask about the item"', `stage ask "${TITLE}"`).replace('report to reviewer "Asked"', `report to reviewer "${TITLE} report"`);
    for (const [classes, hidden] of [[{ release_manager: "public" }, true], [undefined, false]] as const) {
      const w = await planned(checker, [submitting(APPLIED), finish("planned")], { src, ...(classes ? { lock: { role_classes: classes } } : {}) });
      const r = await runPlan(w, "lt");
      expect(r.state, state(r)).toBe("succeeded");
      expect((await programEvents(w, "lt"))[0]![1]["class"]).toBe("internal");
      const { view, program, modules } = await runView(w.rt, "lt", { role: "release_manager" });
      const watched = await w.rt.watchRun("lt", { role: "release_manager" }, { limit: 500 });
      const doc = toMarkdown(roleDoc(view, program, modules));
      for (const [where, text] of <Array<[string, string]>>[["view", JSON.stringify(view)], ["watchRun", JSON.stringify(watched)], ["document", doc]]) expect(text.includes(TITLE), `${where}, hidden ${hidden}`).toBe(!hidden);
      const as = (value: Value) => (hidden ? { masked: true, class: "internal", known: "model" } : { masked: false, value, class: "internal", known: "model" });
      expect(view.stages!.flatMap((s) => [s, ...(s.stages ?? [])]).find((s) => s.program)!.title).toEqual(as(TITLE));
      expect(view.reports![0]!.title).toEqual(as(`${TITLE} report`));
      expect(watched.events.find((e) => e.type === "stage_started" && e.data?.["program"] !== undefined)!.data!["title"]).toEqual(as(TITLE));
      expect(watched.events.find((e) => e.type === "report")!.data!["title"]).toEqual(as(`${TITLE} report`));
      expect(watched.events.find((e) => e.type === "program_started")!.data!["workflow"]).toEqual(as("Fix"));
      // The audit audience is given them as the lead wrote them.
      expect(JSON.stringify((await w.rt.watchRun("lt", { audit: true }, { limit: 500 })).events)).toContain(TITLE);
    }
  });

  it("are not written for a sub-program of a parent before 0.7", async () => {
    const w = await lead([submit(1, fixes(["a"])), finish("planned")], planProgram());
    const r = await runPlan(w, "old");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1 });
    expect((await w.rt.journal.events("old")).map((e) => e.type)).toContain("program_admitted");
    expect(await programEvents(w, "old")).toEqual([]);
  });
});

// ── digests, and what a document is told it holds ──────────────────────

describe("a digest over a wait's values", () => {
  it("is masked with the request's values when the wait is masked, and kept when it is not", () => {
    const request = { contract: "Fits", criterion: "same", role: "reviewer", subject: "made-up", subject_digest: "sha256:s", action_digest: "sha256:a", changeset: "sha256:c" };
    const hidden = maskRequest("decision", request, { class: "confidential", known: "plain" }, "internal").request as Obj;
    for (const k of ["subject", "subject_digest", "action_digest", "changeset"]) expect(hidden[k], k).toEqual({ masked: true, class: "confidential", known: "plain" });
    const shown = maskRequest("decision", request, { class: "confidential", known: "plain" }, "confidential").request as Obj;
    expect([shown["subject_digest"], shown["action_digest"], shown["changeset"]]).toEqual(["sha256:s", "sha256:a", "sha256:c"]);
    expect((maskRequest("review", { subject_digest: "sha256:s", role: "r" }, undefined, "restricted").request as Obj)["subject_digest"]).toEqual({ masked: true, class: "restricted", known: "external" });
  });

  it("is absent from every path for a role the wait is masked from, so trying values against it finds none; a role it is not masked from gets it", async () => {
    // The probe: the subject is the digest of the request, whose every part but the secret the role is shown.
    const subjectOf = (c: string): string => digest("request", { kind: "input", request: { role: "reviewer", question: `Is ${c} right for ana?` } });
    const guesses = ["red", "green", "blue", "black"];
    const ASKED = "/defs/Ask/body/1/value";
    for (const [classes, hidden] of [[undefined, true], [{ reviewer: "confidential" }, false]] as const) {
      const w = await masking(classes ? { classes } : {});
      await start(w, "g", "Ask", { name: "ana", secret: "blue" });
      const [row] = await w.db.query<{ request_digest: string }>("select request_digest from commands where run_id = $1 and command_id = $2", ["g", ASKED]);
      expect(row!.request_digest).toBe(subjectOf("blue"));
      // ListWaits.
      const item = (await w.rt.listWaits({ role: "reviewer" }))[0]!;
      expect(item.subject).toEqual(hidden ? { masked: true, class: "confidential", known: "plain" } : subjectOf("blue"));
      expect(guesses.filter((c) => JSON.stringify(item).includes(subjectOf(c)))).toEqual(hidden ? [] : ["blue"]);
      // The role view and WatchRun, once the reviewer answered: the decision's id, whose record holds the subject.
      await answer(w, "g", w.ana, "yes");
      const id = String((await w.rt.watchRun("g", { audit: true }, { limit: 500 })).events.find((e) => e.type === "input_received")!.data!["decision"]);
      const view = (await runView(w.rt, "g", { role: "reviewer" })).view;
      const watched = await w.rt.watchRun("g", { role: "reviewer" }, { limit: 500 });
      expect(view.decisions.find((d) => d.about === ASKED)!.decision_id).toEqual(hidden ? { masked: true, class: "confidential", known: "plain" } : id);
      expect(watched.events.find((e) => e.type === "input_received")!.data!["decision"]).toEqual(hidden ? { masked: true, class: "confidential", known: "plain" } : id);
      for (const [where, text] of <Array<[string, string]>>[["view", JSON.stringify(view)], ["watchRun", JSON.stringify(watched)]]) {
        expect(text.includes(id), `${where}, hidden ${hidden}`).toBe(!hidden);
        expect(guesses.filter((c) => text.includes(subjectOf(c))), where).toEqual([]);
      }
    }
  });
});

describe("the document of a view", () => {
  it("prints a value a program holds as it is, whatever its members, in a view of 0.6 and in the operator's and the audit's view of 0.7", async () => {
    const values: Value[] = [
      { value: "made-up", class: "public", known: "verified" },
      { masked: true, class: "public", known: "verified" },
      { masked: false, value: "made-up", class: "public", known: "verified" },
    ];
    const asked = (v: Obj, question: Value): Obj => ({ ...v, waiting: { ...((v["waiting"] as Obj) ?? {}), request: { role: "reviewer", question } } });
    const w6 = await masking({ src: SRC06 });
    await start(w6, "a");
    const r6 = await runView(w6.rt, "a", { role: "reviewer" });
    const o6 = await runView(w6.rt, "a");
    const w7 = await masking();
    await start(w7, "a");
    const o7 = await runView(w7.rt, "a");
    const a7 = await runView(w7.rt, "a", { audit: true });
    for (const v of values) {
      const docs = [
        toMarkdown(roleDoc(asked(r6.view as unknown as Obj, v) as never, r6.program, r6.modules)),
        toMarkdown(runDoc(asked(o6.view as unknown as Obj, v) as never, o6.program, o6.modules)),
        toMarkdown(runDoc(asked(o7.view as unknown as Obj, v) as never, o7.program, o7.modules)),
        toMarkdown(auditDoc(asked(a7.view as unknown as Obj, v) as never, a7.program, a7.modules)),
      ];
      for (const doc of docs) {
        expect(doc).not.toContain("Masked: its class");
        expect(doc).not.toContain("Its class public");
        expect(doc).toContain('"known"');
      }
    }
    // And a value of 0.6 is printed byte for byte as by the view of a role as by the operator's.
    const plainDoc = (d: string): string => d.slice(d.indexOf("Waiting for an answer"), d.indexOf("\n\n", d.indexOf("Waiting for an answer") + 40));
    expect(plainDoc(toMarkdown(roleDoc(asked(r6.view as unknown as Obj, values[0]!) as never, r6.program, r6.modules)))).toBe(plainDoc(toMarkdown(runDoc(asked(o6.view as unknown as Obj, values[0]!) as never, o6.program, o6.modules))));
  });
});

describe("a review's waivers in a role's view", () => {
  /** A review whose items are model's values: item 1's total does not match, and the reviewer waives it. */
  const WAIVED = `mandate @ 0.7

module example.attention.waive @ 0.1

use std.{human, model}

role reviewer "Reviewer"

type No    = Text classified internal
type Item  = { no: No, total: Int }
type Batch = { accepted: Int, failed: List<Int> }

capability ModelStd = model.infer(tier: standard, max_class: internal)

/// A match names its item; its total may differ when the reviewer waives it.
contract Fits(it: Item, m: Item) {
  accept same "The match is for this item"
    by static m.no == it.no
  accept totals "The totals are equal"
    by static m.total == it.total
    waive by reviewer
}

agent Matcher {
  role   "Matches one item."
  caps   ModelStd
  budget { tokens: 6k, steps: 2 }
  skill match(it: Item) -> Inferred<Item> ! {Model}
}

/// Matches each item and asks the reviewer about the rest.
workflow Waive(items: List<Item>) -> Batch
  caps   ModelStd
  budget { time: 2h }
{
  let checked = map it in items max 4 par 2 {
    let out = delegate Matcher.match(it)
    verify out against Fits(it, out)
  }
  let reviewed = human.review(checked, role: reviewer, deadline: 1d)
  Batch { accepted: len(reviewed.accepted), failed: reviewed.failed }
}
`;

  it("masks the evidence a waiver is and the failure it waives with the review's values from a role they are masked from, and gives them to one they are not", async () => {
    for (const [classes, hidden] of [[{ reviewer: "public" }, true], [undefined, false]] as const) {
      const who = people(classes);
      const agents = new SimAgents().on("Matcher.match", (req) => {
        const it = req.args[0] as Obj;
        return { ok: it["no"] === "I1" ? { ...it, total: 11 } : it, cost: { steps: 1 } };
      });
      const w = await world(WAIVED, { agents, lock: who.lock, decisions: { keys: who.keys } });
      const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Waive", input: { items: [{ no: "I0", total: 10 }, { no: "I1", total: 10 }] }, runId: "v" });
      expect(r.state).toBe("waiting");
      const shown = await w.rt.shown("v", "wait");
      const d = { waive: [1], decline: [] };
      const signed = signDecision(who.ana.key, shown, { kind: "review", member: "ana", payload: payloadOf.review(d), at: new Date(w.adapters.clock.now()) });
      expect((await w.rt.decideReview("v", { sender: "test", messageId: `m${++n}` }, { signed, ...d })).state).toBe("succeeded");
      const [waiver] = (await runView(w.rt, "v")).view.reviews![0]!.items[1]!.waivers;
      expect(waiver).toMatchObject({ criterion: "totals", signature_valid: true });
      const { view, program, modules } = await runView(w.rt, "v", { role: "reviewer" });
      const masked = view.reviews![0]!.items[1]!.waivers[0]!;
      const label = { masked: true, class: "internal", known: "model" };
      expect([masked.failed, masked.waiver], `hidden ${hidden}`).toEqual(hidden ? [label, label] : [waiver!.failed, waiver!.waiver]);
      expect(masked.signature_valid).toBe(true);
      // The same ids, by the same rule, in WatchRun.
      const watched = (await w.rt.watchRun("v", { role: "reviewer" }, { limit: 500 })).events.find((e) => e.type === "criterion_waived")!;
      expect([watched.data!["failed"], watched.data!["waiver"]]).toEqual(hidden ? [label, label] : [waiver!.failed, waiver!.waiver]);
      // And the role's document prints them so: a masked one as masked, a shown one as its first 19 characters.
      const doc = toMarkdown(roleDoc(view, program, modules));
      expect(doc).toContain(hidden ? "totals: masked (internal) waived by masked (internal)" : `totals: ${waiver!.failed.slice(0, 19)} waived by ${waiver!.waiver.slice(0, 19)}`);
      for (const [where, text] of <Array<[string, string]>>[["view", JSON.stringify(view)], ["watchRun", JSON.stringify(watched)], ["document", doc]]) {
        expect([waiver!.failed, waiver!.waiver].some((id) => text.includes(id.slice(0, 19))), `${where}, hidden ${hidden}`).toBe(!hidden);
      }
    }
  });
});
