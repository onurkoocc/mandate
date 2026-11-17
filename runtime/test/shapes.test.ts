// `shapes` in a run of 0.6 (spec/library.md "`shapes`", "Runtime"; slice B12). An envelope's `shapes [P, …]` lists the
// patterns a lead's sub-programs may apply. The compiler's check refuses a sub-program that is not one (E1710) and names
// the shape of one it admits; the runtime holds the rule itself: under such an envelope a sub-program is admitted only
// when its check named a listed shape, journals the shape (`program_submitted`, `program_admitted`), and shows its
// run's sub-programs by shape. An amendment that drops a shape, or adds `shapes` where there were none, is E1709.
//
// Two worlds: the 0.6 migration of fixtures/library/migrate-all.mdt with a scripted lead that writes the sub-programs of
// fixtures/library/migrate-all.plans/ (an application of FanOutMerge of std.patterns, of MakerChecker, and one written
// out), and the plan program of planning.ts in 0.6 with patterns of its own, for the amendments (a package that pins a
// library, as the migration does with std.patterns, is not amended yet: its run runs the expansion it stored).
//
// Only the Rust compiler reads 0.6, so every test that needs a program of 0.6 checked is skipped by name in `ts` mode.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, load, toMarkdown, type Program } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { checkAmended, NOT_RUN_YET_06 } from "../src/package.js";
import { baseOf, planBrief, shapeProblem, shapesOf, type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import type { Lock } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { Crash } from "../src/signals.js";
import { SimChat, SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { runDoc, runView } from "../src/views.js";
import { closeAll, commandIds, planChecker, world, type World } from "./helpers.js";
import { BUDGET, CAPS, finish, leadChat, MODULE, msg, planned, program as planProgram, refusals, run, state, type Planned, type Turn } from "./planning.js";

afterAll(closeAll);

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8");

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(() => checker.close());

// ── what the mechanism holds, with no compiler ──────────────────────────

describe("what the runtime holds of a check's shape", () => {
  const listed = ["FanOutMerge", "MakerChecker"];
  it("admits a shape the envelope lists, and only that", () => {
    expect(shapeProblem(listed, { pattern: "FanOutMerge", module: "std.patterns" })).toBeUndefined();
    expect(shapeProblem(listed, { pattern: "MakerChecker", module: "std.patterns" })).toBeUndefined();
    expect(shapeProblem(listed, undefined)).toContain("named no shape");
    expect(shapeProblem(listed, { pattern: "Other", module: "std.patterns" })).toContain("does not list");
    expect(shapeProblem(listed, { pattern: "FanOutMerge" } as never)).toContain("not a pattern and its module");
    expect(shapeProblem(listed, { pattern: "FanOutMerge", module: "" })).toContain("not a pattern and its module");
    expect(shapeProblem(listed, "FanOutMerge" as never)).toContain("not a pattern and its module");
  });

  it("takes no shape from the check of an envelope that lists none", () => {
    expect(shapeProblem(undefined, undefined)).toBeUndefined();
    expect(shapeProblem(undefined, { pattern: "FanOutMerge", module: "std.patterns" })).toContain("lists none");
  });

  it("reads an envelope's shapes, and tells the lead of them in its brief only then", () => {
    expect(shapesOf(undefined)).toBeUndefined();
    expect(shapesOf({ owner: "o" } as never)).toBeUndefined();
    expect(shapesOf({ owner: "o", shapes: ["A", "B"] } as never)).toEqual(["A", "B"]);
    const parent = { language: "mandate/0.6", module: "m", version: "0.1", defs: {} } as unknown as Program;
    expect(planBrief(parent, { owner: "o", shapes: ["A", "B"] } as never)).toContain("The envelope lists shapes: A, B.");
    expect(planBrief(parent, { owner: "o" } as never)).not.toContain("shapes");
  });

  it("has no line left in the table of what 0.6 has that this runtime does not run yet", () => {
    expect(NOT_RUN_YET_06.map((r) => [r.name, r.slice])).toEqual([]);
  });
});

// ── the migration of fixtures/library, with a lead that writes sub-programs ──

const MIGRATION = "fixtures/library/migrate-all.mdt";
const PLAN = "/defs/MigrateAll/body/1/value";
const PROGRAM = `${PLAN}/program/1`;
const REPOS = [
  { name: "alpha", root: "alpha" },
  { name: "beta", root: "beta" },
];

/** The operations of a sub-program of migrate-all.plans/, as a lead sends them: its definitions, each added. */
function opsOf(file: string): Value[] {
  const r = load(read(`fixtures/library/migrate-all.plans/${file}`), "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries(r.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
}

const BASE = baseOf("company.migrations", 1, "mandate/0.6" as never);
const submitting = (file: string, id = "s1"): SimTurn => [toolUse(id, "submit_program", { base: BASE, ops: opsOf(file) })];
const checking = (file: string): SimTurn => [toolUse("c1", "check_program", { base: BASE, ops: opsOf(file) })];

const SUMMARY = { migrated: ["alpha", "beta"], left: [], notes: "" };
const ending = (result: Value): SimTurn => [toolUse("done", "finish", { result })];
const MERGED = { migrated: ["billing", "search"], left: [], notes: "merged" };

interface Migration extends Planned {
  ana: EvidenceSigner;
  ben: EvidenceSigner;
}

/**
 * The 0.6 migration on a runtime whose lock is the fixture's, with the members' keys made for the test: Ana, the
 * platform lead, has approved its envelope; Ben is the release manager. `lead` is the lead's turns in order; a migrator
 * says which repository it migrated, a merger gives `MERGED`, and an auditor gives what it was handed.
 */
async function migration(lead: Turn[], o: { checker?: ProgramChecker } = {}): Promise<Migration> {
  const ana = EvidenceSigner.generate();
  const ben = EvidenceSigner.generate();
  const { lock: _format, ...fixture } = JSON.parse(read("fixtures/library/migrate-all.lock.json")) as Lock & { lock?: string };
  const lock = { ...fixture, members: { ana: { keys: [ana.keyId] }, ben: { keys: [ben.keyId] } } } as Lock;
  const w = await world(read(MIGRATION), { lock, decisions: { keys: new TrustedKeys([ana.publicKey, ben.publicKey]) }, plan: { checker: o.checker ?? checker } });
  const worker = (req: TurnRequest): SimTurn => {
    const result = req.agent === "Merger" ? MERGED : req.agent === "Auditor" ? { migrated: ["billing"], left: [], notes: "audited" } : { migrated: [/\\"name\\":\\"([^"\\]+)\\"/.exec(JSON.stringify(req.messages[0]))?.[1] ?? "?"], left: [], notes: "" };
    return [toolUse("w1", "finish", { result })];
  };
  const { chat, told } = leadChat(lead, worker);
  const host = new SimSandboxHost();
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  await w.rt.approveEnvelope(w.pkg, signDecision(ana, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "ana", at: new Date(w.adapters.clock.now()) }));
  return { ...w, chat, host, alice: ana, bob: ben, ana, ben, told };
}

const start = (w: World, runId: string) => w.rt.startRun({ pkg: w.pkg, workflow: "MigrateAll", input: { repos: REPOS }, runId });
const eventsOf = async (w: World, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);
const FAN_OUT = { pattern: "FanOutMerge", module: "std.patterns" };
const MAKER_CHECKER = { pattern: "MakerChecker", module: "std.patterns" };

describe("a lead of the 0.6 migration, whose envelope lists FanOutMerge and MakerChecker", () => {
  it("applies FanOutMerge: the sub-program is admitted with its shape, runs to its end over simulated agents, and replays", async () => {
    const w = await migration([submitting("fan-out.mdt"), ending(SUMMARY)]);
    const r = await start(w, "fan");
    expect(r.state, state(r)).toBe("succeeded");
    expect(r.result).toEqual(SUMMARY);
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, result: MERGED });
    // The journal: the shape on the submission and the admission, which also names the running program it runs as.
    const [submitted] = await eventsOf(w, "fan", "program_submitted");
    const [admitted] = await eventsOf(w, "fan", "program_admitted");
    expect(submitted).toMatchObject({ number: 1, ok: true, shape: FAN_OUT });
    expect(admitted).toMatchObject({ number: 1, workflow: "Rest", shape: FAN_OUT, running: { hash: expect.stringMatching(/^sha256:/) } });
    expect(Object.keys(admitted!).sort()).toEqual(["artifact", "base", "command", "hash", "number", "plan", "reservation", "running", "shape", "step", "workflow"]);
    // It ran as its expansion: two migrators side by side and the merger, under the command it was admitted as.
    const delegates = (await commandIds(w, "fan", "delegate")).filter((id) => id.startsWith(PROGRAM));
    expect(delegates).toHaveLength(3);
    expect(w.chat.calls.filter((c) => c.agent === "Migrator" && c.commandId.startsWith(PROGRAM))).toHaveLength(2);
    expect(w.chat.calls.filter((c) => c.agent === "Merger")).toHaveLength(1);
    // A replay runs the stored running program against the journal, with no model, and ends as the run did.
    const calls = w.chat.calls.length;
    expect(await w.rt.replayRun("fan")).toEqual({ status: "complete", value: SUMMARY });
    expect(w.chat.calls).toHaveLength(calls);
  });

  it("shows the sub-program by its shape in the run view: beside the sub-program, and as a line per shape", async () => {
    const w = await migration([submitting("written-out.mdt", "s0"), submitting("fan-out.mdt", "s1"), ending(SUMMARY)]);
    const r = await start(w, "view");
    expect(r.state, state(r)).toBe("succeeded");
    const { view, program } = await runView(w.rt, "view");
    expect(view.plans).toMatchObject([
      {
        node: PLAN,
        submissions: [
          { number: 1, outcome: "refused", codes: ["MDT-E1710"], hash: null },
          { number: 1, outcome: "admitted", shape: FAN_OUT, command: PROGRAM, state: "succeeded", stored: "kept" },
        ],
      },
    ]);
    // A submission that was refused names no shape: the key is not there, not null.
    expect(view.plans[0]!.submissions[0]).not.toHaveProperty("shape");
    const md = toMarkdown(runDoc(view, program));
    expect(md).toContain("| Number | Outcome | Shape |");
    expect(md).toContain("FanOutMerge (std.patterns)");
    expect(md).toContain("Sub-programs by shape: FanOutMerge (std.patterns) 1.");
    // The run's own JSON view carries it as `{ pattern, module }`.
    expect(JSON.parse(JSON.stringify(view)).plans[0].submissions[1].shape).toEqual(FAN_OUT);
  });

  it("applies MakerChecker: admitted with its shape, and held for the release manager whom Moved asks", async () => {
    const w = await migration([submitting("maker-checker.mdt"), ending(SUMMARY)]);
    const r = await start(w, "maker");
    expect(r.state, state(r)).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "decision", request: { role: "release_manager", criterion: "release_approved" } });
    expect(await eventsOf(w, "maker", "program_submitted")).toMatchObject([{ number: 1, ok: true, shape: MAKER_CHECKER }]);
    expect(await eventsOf(w, "maker", "program_admitted")).toMatchObject([{ number: 1, workflow: "Billing", shape: MAKER_CHECKER }]);
    // The release manager accepts; the sub-program ends, and the lead is told.
    const done = await w.rt.decideAction("maker", msg(), { signed: signDecision(w.ben, await w.rt.shown("maker", "wait"), { kind: "approve", member: "ben", at: new Date(w.adapters.clock.now()) }) });
    expect(state(done)).toBe("succeeded null");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1 });
    const { view } = await runView(w.rt, "maker");
    expect(view.plans[0]!.submissions[0]).toMatchObject({ outcome: "admitted", shape: MAKER_CHECKER, state: "succeeded" });
  });

  it("refuses a sub-program written out (E1710) as any failed check is: the lead sees the diagnostic, and nothing of it runs", async () => {
    const w = await migration([checking("written-out.mdt"), submitting("written-out.mdt"), ending(SUMMARY)]);
    const r = await start(w, "written");
    expect(r.state, state(r)).toBe("succeeded");
    // The check tells the lead it does not pass; so does the submission, with the diagnostic at the workflow.
    expect(w.told[0]).toMatchObject({ ok: false });
    expect(refusals(w.told[0])).toEqual([["MDT-E1710", "/defs/Rest", { workflow: "Rest", problem: "not_an_application", shapes: ["FanOutMerge", "MakerChecker"] }]]);
    expect(w.told[1]).toMatchObject({ admitted: false, number: 1 });
    expect(refusals(w.told[1])).toEqual(refusals(w.told[0]));
    expect(await eventsOf(w, "written", "program_refused")).toMatchObject([{ number: 1, codes: ["MDT-E1710"] }]);
    expect(await eventsOf(w, "written", "program_admitted")).toEqual([]);
    expect((await eventsOf(w, "written", "program_submitted"))[0]).not.toHaveProperty("shape");
    expect((await commandIds(w, "written", "delegate")).filter((id) => id.includes("/program/"))).toEqual([]);
    expect(await commandIds(w, "written", "program")).toEqual([]);
  });

  it("tells the lead of the shapes in its brief", async () => {
    const w = await migration([ending(SUMMARY)]);
    await start(w, "brief");
    const lead = w.chat.calls.find((c) => c.agent === "Lead")!;
    expect(JSON.stringify(lead.messages[0])).toContain("The envelope lists shapes: FanOutMerge, MakerChecker.");
  });

  it("resumes after a stop in the middle of the sub-program from the running program stored at its admission, and replays as it ended", async () => {
    const w = await migration([submitting("fan-out.mdt"), ending(SUMMARY)]);
    w.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.includes("/program/1/"));
    await expect(start(w, "crash")).rejects.toBeInstanceOf(Crash);
    const [admitted] = await eventsOf(w, "crash", "program_admitted");
    expect(admitted).toMatchObject({ shape: FAN_OUT, running: { hash: expect.stringMatching(/^sha256:/) } });
    const resumed = await w.rt.resume("crash");
    expect(resumed.state, state(resumed)).toBe("succeeded");
    expect(resumed.result).toEqual(SUMMARY);
    // Admitted once, however often the run came back to its step; the shape is the one first journaled.
    expect(await eventsOf(w, "crash", "program_admitted")).toEqual([admitted]);
    expect(await eventsOf(w, "crash", "program_submitted")).toMatchObject([{ shape: FAN_OUT }]);
    expect(await w.rt.replayRun("crash")).toEqual({ status: "complete", value: SUMMARY });
    // What it ran as is what was stored then: another running program under that name is not run.
    const v = await migration([submitting("fan-out.mdt"), ending(SUMMARY)]);
    v.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.includes("/program/1/"));
    await expect(start(v, "tampered")).rejects.toBeInstanceOf(Crash);
    await v.db.query(`update events set data = jsonb_set(data, '{running,hash}', '"sha256:00"') where run_id = 'tampered' and type = 'program_admitted'`);
    const stopped = await v.rt.resume("tampered");
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "expansion_mismatch" });
  });

  /** A checker that gives the check's result, changed by `forge`. */
  const forging = (forge: (r: Obj) => Obj): ProgramChecker => ({
    check: async (i, ms) => {
      const r = await checker.check(i, ms);
      return "ok" in r && r.ok ? (forge(r as unknown as Obj) as never) : r;
    },
  });
  const without = (key: string) => (r: Obj): Obj => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key));

  it("refuses a check that is ok without a shape, however the compiler said: a compiler failure is never a pass", async () => {
    const w = await migration([checking("fan-out.mdt"), submitting("fan-out.mdt"), ending(SUMMARY)], { checker: forging(without("shape")) });
    const r = await start(w, "noshape");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ ok: false });
    expect(w.told[1]).toMatchObject({ admitted: false });
    expect(JSON.stringify(w.told[1])).toContain("and named no shape");
    expect(refusals(w.told[1])).toEqual([["check_failed", null, expect.objectContaining({ reason: expect.stringContaining("named no shape") })]]);
    expect(await eventsOf(w, "noshape", "program_admitted")).toEqual([]);
    expect(await commandIds(w, "noshape", "program")).toEqual([]);
    expect(w.chat.calls.filter((c) => c.commandId.startsWith(PROGRAM))).toHaveLength(0);
  });

  it("refuses a check that names a shape the envelope does not list", async () => {
    const w = await migration([submitting("fan-out.mdt"), ending(SUMMARY)], { checker: forging((r) => ({ ...r, shape: { pattern: "BatchWithExceptions", module: "std.patterns" } })) });
    const r = await start(w, "unlisted");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false });
    expect(JSON.stringify(w.told[0])).toContain("the shape BatchWithExceptions, which the envelope does not list (FanOutMerge, MakerChecker)");
    expect(await eventsOf(w, "unlisted", "program_admitted")).toEqual([]);
    expect(w.chat.calls.filter((c) => c.commandId.startsWith(PROGRAM))).toHaveLength(0);
  });

  it("refuses a check that names a shape that is not a pattern and its module", async () => {
    const w = await migration([submitting("fan-out.mdt"), ending(SUMMARY)], { checker: forging((r) => ({ ...r, shape: { pattern: "FanOutMerge" } })) });
    expect((await start(w, "bare")).state).toBe("succeeded");
    expect(JSON.stringify(w.told[0])).toContain("not a pattern and its module");
    expect(await eventsOf(w, "bare", "program_admitted")).toEqual([]);
  });

  it("amends nothing of it yet: a package that pins a library is not amended, and an amendment of this migration is refused by name", () => {
    const lock = JSON.parse(read("fixtures/library/migrate-all.lock.json")) as Lock & { lock?: string };
    const program = check(read(MIGRATION), "mdt", { lock }).program!;
    const { lock: _format, ...packaged } = lock;
    const envelope = (program.defs["MigrateAll"] as unknown as { envelope: Obj }).envelope;
    const amended = checkAmended({ parent: program, modules: {}, workflow: "MigrateAll", envelope: { ...envelope, shapes: ["FanOutMerge", "MakerChecker", "BatchWithExceptions"] } as never, lock: packaged as Lock });
    expect(amended.ok).toBe(false);
    expect(amended.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_language", message: expect.stringContaining("std.patterns") })]);
  });
});

// ── a parent whose envelope has no shapes is as it was ──────────────────

/** A pattern the plan program's sub-programs may apply, and one that asks twice: the two shapes of the amendments. */
const PATTERNS = `/// Asks once, about one item.
pattern Ask(
  work: skill(Item) -> Inferred<Text>
) () -> Inferred<Text>
{
  delegate work(Item { name: "a" })
}

/// Asks twice, about one item each time.
pattern AskTwice(
  work: skill(Item) -> Inferred<Text>
) () -> Inferred<Text>
{
  let first = delegate work(Item { name: "a" })
  let second = delegate work(Item { name: "b" })
  second
}

`;

/** The plan program of planning.ts in 0.6, with the two patterns and, in its envelope, the shapes given. */
function src(shapes?: string[]): string {
  const text = planProgram().replace("mandate @ 0.4", "mandate @ 0.6").replace("workflow W(items", `${PATTERNS}workflow W(items`);
  return shapes ? text.replace("agents: 12 }", `agents: 12 }\n    shapes  [${shapes.join(", ")}]`) : text;
}

const BASE_1 = baseOf(MODULE, 1, "mandate/0.6" as never);
const header = `mandate @ 0.6\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n`;
const opsFrom = (defs: string): Value[] => {
  const r = load(`${header}${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries(r.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
};
const applying = (pattern: string): string => `workflow Fix = ${pattern}(work: Worker.fix)\n  caps   ${CAPS}\n  budget ${BUDGET}\n`;
const writtenOut = `workflow Fix() -> Inferred<Text>\n  caps   ${CAPS}\n  budget ${BUDGET}\n{\n  delegate Worker.fix(Item { name: "a" })\n}`;
const submitOps = (defs: string, id = "s1"): SimTurn => [toolUse(id, "submit_program", { base: BASE_1, ops: opsFrom(defs) })];

/** The envelope of workflow W in a program written as text, as IR: what a lead sends to `request_amendment`. */
function envelopeOf(text: string): Value {
  const r = load(text, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return (r.program!.defs["W"] as unknown as { envelope: Value }).envelope;
}
const asking = (text: string, reason = "the next sub-program needs another shape"): SimTurn => [toolUse("a1", "request_amendment", { envelope: envelopeOf(text), reason })];

const admissions = async (w: World, runId: string): Promise<Obj[]> => eventsOf(w, runId, "program_admitted");

describe("a lead under an envelope with shapes, and one without", () => {
  const planWith = (lead: Turn[], text: string, c: ProgramChecker = checker): Promise<Planned> => planned(c, lead, { src: text });

  it("admits a sub-program that applies a listed pattern of the parent's own, with its shape, and one under no shapes with none", async () => {
    const w = await planWith([submitOps(applying("Ask")), finish("planned")], src(["Ask"]));
    const r = await run(w, "own");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    expect(await eventsOf(w, "own", "program_submitted")).toMatchObject([{ ok: true, shape: { pattern: "Ask", module: MODULE } }]);
    expect(await admissions(w, "own")).toMatchObject([{ shape: { pattern: "Ask", module: MODULE }, running: { hash: expect.stringMatching(/^sha256:/) } }]);
    // The same sub-program under an envelope with no shapes: the events are what they were, with no `shape`.
    const v = await planWith([submitOps(applying("Ask")), finish("planned")], src());
    expect((await run(v, "none")).state).toBe("succeeded");
    expect((await eventsOf(v, "none", "program_submitted"))[0]).not.toHaveProperty("shape");
    expect(Object.keys((await admissions(v, "none"))[0]!).sort()).toEqual(["artifact", "base", "command", "hash", "number", "plan", "reservation", "running", "step", "workflow"]);
    const { view } = await runView(v.rt, "none");
    expect(view.plans[0]!.submissions[0]).not.toHaveProperty("shape");
    const md = toMarkdown(runDoc(view, (await runView(v.rt, "none")).program));
    expect(md).not.toContain("| Shape |");
    expect(md).not.toContain("by shape");
  });

  it("refuses a pattern the envelope does not list (E1710), and a workflow written out; under no shapes the written-out one runs as in 0.4", async () => {
    const w = await planWith([submitOps(applying("AskTwice"), "s0"), submitOps(writtenOut, "s1"), submitOps(applying("Ask"), "s2"), finish("planned")], src(["Ask"]));
    const r = await run(w, "only");
    expect(r.state, state(r)).toBe("succeeded");
    expect(refusals(w.told[0])).toEqual([["MDT-E1710", "/defs/Fix/apply/pattern", expect.objectContaining({ pattern: "AskTwice", problem: "not_listed" })]]);
    expect(refusals(w.told[1])).toEqual([["MDT-E1710", "/defs/Fix", expect.objectContaining({ problem: "not_an_application" })]]);
    expect(w.told[2]).toMatchObject({ admitted: true });
    expect(await eventsOf(w, "only", "program_refused")).toMatchObject([{ codes: ["MDT-E1710"] }, { codes: ["MDT-E1710"] }]);
    expect(await admissions(w, "only")).toHaveLength(1);
    const v = await planWith([submitOps(writtenOut), finish("planned")], src());
    expect((await run(v, "written")).state).toBe("succeeded");
    expect(v.told[0]).toMatchObject({ admitted: true, result: "fixed a" });
    expect(await admissions(v, "written")).toHaveLength(1);
  });

  it("refuses a shape in the result of a check of an envelope that lists none", async () => {
    const forged: ProgramChecker = {
      check: async (i, ms) => {
        const r = await checker.check(i, ms);
        return "ok" in r && r.ok ? ({ ...r, shape: { pattern: "Ask", module: MODULE } } as never) : r;
      },
    };
    const w = await planWith([submitOps(applying("Ask")), finish("planned")], src(), forged);
    expect((await run(w, "forged")).state).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false });
    expect(JSON.stringify(w.told[0])).toContain("named a shape for a sub-program of an envelope that lists none");
    expect(await admissions(w, "forged")).toEqual([]);
  });

  // ── amendments ────────────────────────────────────────────────────────

  const decide = async (w: Planned, runId: string, kind: "amend" | "decline" = "amend") => w.rt.decideAmendment(runId, msg(), signDecision(w.alice, await w.rt.shown(runId, "wait"), { kind, member: "alice", at: new Date(w.adapters.clock.now()) }));

  it("refuses an amendment that drops a shape (E1709), end to end: the lead is told, nobody is asked, the envelope stays", async () => {
    const w = await planWith([asking(src(["Ask"])), submitOps(applying("AskTwice")), finish("planned")], src(["Ask", "AskTwice"]));
    const r = await run(w, "drop");
    expect(r.state, state(r)).toBe("succeeded");
    // What the lead was told by the amendment's answer, which the next turn's tool result carries.
    expect(w.told[0]).toMatchObject({ amended: false });
    expect(refusals(w.told[0])).toEqual([["MDT-E1709", "/defs/W/envelope/shapes", expect.objectContaining({ dimension: "shapes", shape: "AskTwice", was: ["Ask", "AskTwice"], asked: ["Ask"] })]]);
    expect(await eventsOf(w, "drop", "amendment_requested")).toEqual([]);
    expect(await eventsOf(w, "drop", "package_amended")).toEqual([]);
    // The envelope is as it was: the shape that was to be dropped still admits.
    expect(w.told[1]).toMatchObject({ admitted: true, result: expect.any(String) });
    expect(await admissions(w, "drop")).toMatchObject([{ shape: { pattern: "AskTwice", module: MODULE } }]);
  });

  it("refuses an amendment that adds shapes to an envelope that had none (E1709)", async () => {
    const w = await planWith([asking(src(["Ask"])), submitOps(writtenOut), finish("planned")], src());
    const r = await run(w, "add");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ amended: false });
    expect(refusals(w.told[0])).toEqual([["MDT-E1709", "/defs/W/envelope/shapes", expect.objectContaining({ dimension: "shapes", was: null, asked: ["Ask"] })]]);
    expect(await eventsOf(w, "add", "amendment_requested")).toEqual([]);
    // No shapes still: a workflow written out is admitted, with no shape.
    expect(w.told[1]).toMatchObject({ admitted: true });
    expect((await admissions(w, "add"))[0]).not.toHaveProperty("shape");
  });

  it("takes the owner's decision to add a shape: the run waits, a decline leaves the envelope, an approval admits the new shape", async () => {
    const lead = (): Turn[] => [submitOps(applying("AskTwice"), "s0"), asking(src(["Ask", "AskTwice"])), submitOps(applying("AskTwice"), "s1"), finish("planned")];
    const w = await planWith(lead(), src(["Ask"]));
    const r = await run(w, "widen");
    // The lead's first try applied a pattern the envelope does not list; it then asked for it.
    expect(refusals(w.told[0])).toEqual([["MDT-E1710", "/defs/Fix/apply/pattern", expect.objectContaining({ problem: "not_listed" })]]);
    expect(r.state, state(r)).toBe("waiting");
    expect(r.waiting).toMatchObject({ kind: "amendment", request: { role: "platform_lead", workflow: "W" } });
    expect(((r.waiting as Obj)["request"] as Obj)["changes"]).toEqual([{ path: "/defs/W/envelope/shapes", text: "+ W.envelope.shapes: AskTwice" }]);
    expect(await admissions(w, "widen")).toEqual([]);
    const done = await decide(w, "widen");
    expect(state(done)).toBe("succeeded null");
    expect(await eventsOf(w, "widen", "package_amended")).toMatchObject([{ by: "alice", role: "platform_lead" }]);
    expect(w.told[1]).toMatchObject({ amended: true });
    expect(w.told[2]).toMatchObject({ admitted: true });
    expect(await admissions(w, "widen")).toMatchObject([{ shape: { pattern: "AskTwice", module: MODULE } }]);
    // Declined, the envelope stays: the lead's next try with the shape is refused again.
    const v = await planWith([asking(src(["Ask", "AskTwice"])), submitOps(applying("AskTwice")), finish("planned")], src(["Ask"]));
    await run(v, "declined");
    await decide(v, "declined", "decline");
    expect(v.told[0]).toMatchObject({ amended: false, declined: { reason: "declined" } });
    expect(refusals(v.told[1])).toEqual([["MDT-E1710", "/defs/Fix/apply/pattern", expect.objectContaining({ problem: "not_listed" })]]);
    expect(await admissions(v, "declined")).toEqual([]);
  });

  it("takes the owner's decision to take the list of shapes away, which widens: the sub-programs after it carry no shape", async () => {
    const w = await planWith([asking(src()), submitOps(writtenOut), finish("planned")], src(["Ask"]));
    const r = await run(w, "away");
    expect(r.state, state(r)).toBe("waiting");
    expect(((r.waiting as Obj)["request"] as Obj)["changes"]).toEqual([{ path: "/defs/W/envelope/shapes", text: "~ W.envelope.shapes: Ask → any workflow" }]);
    expect(state(await decide(w, "away"))).toBe("succeeded null");
    expect(w.told[1]).toMatchObject({ admitted: true, result: "fixed a" });
    expect((await admissions(w, "away"))[0]).not.toHaveProperty("shape");
    expect((await eventsOf(w, "away", "program_submitted"))[0]).not.toHaveProperty("shape");
  });
});
