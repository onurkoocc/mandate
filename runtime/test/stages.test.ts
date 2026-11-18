// `stage` and `report` at run time (spec/attention.md "`stage`", "`report`", "Run time": "Events", "The stored facts";
// slice B2). A stage is a marker: the run writes `stage_started` once for its node, with the end of the stage before
// it, and `stage_ended` of the last before `run_succeeded`. A report evaluates its fields and writes `report` once for
// its command id, each field with the class, the level (`known`) and the type the attention facts give at its node:
// the facts the compiler gave at the run's start, stored with the run, and read back by every resume and replay. Facts
// that are missing, changed, or without the report's node stop the run (`facts_mismatch`). A report is addressed: a
// role sees one only when it is to that role; the audit view sees each; nothing carries its values out.
//
// Only the Rust compiler reads 0.7. Every rule holds on PGlite and on PostgreSQL (helpers.ts, MANDATE_TEST_DATABASE_URL).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { attentionFacts, libraryVerify, load, type AttentionFacts, type AttentionFactsInput, type LibraryPin, type LibrarySource, type Lock } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MemoryBlobs } from "../src/artifacts.js";
import { ATTENTION_MEDIA_TYPE, MAX_REPORT_VALUE, reportValue } from "../src/attention.js";
import { addressee, EVENT_CLASSES, shows } from "../src/classes.js";
import { signDecision, payloadOf } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { RunRow } from "../src/journal.js";
import { otelEndpoint, otelExport } from "../src/otel.js";
import { baseOf, type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import { RUN_MANIFEST_FORMAT } from "../src/runtime.js";
import { Crash } from "../src/signals.js";
import { SimAgents, toolUse, type SimTurn } from "../src/sim.js";
import { digest, type Obj, type Value } from "../src/values.js";
import { runView } from "../src/views.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { BUDGET, CAPS, finish, MODULE, planned, program as planProgram, run as runPlan, state, type Planned, type Turn } from "./planning.js";

afterAll(closeAll);

// ── the people ──────────────────────────────────────────────────────────

interface Person {
  member: string;
  key: EvidenceSigner;
}

/** Ana is the reviewer, Ben the auditor. */
function people() {
  const ana: Person = { member: "ana", key: EvidenceSigner.generate() };
  const ben: Person = { member: "ben", key: EvidenceSigner.generate() };
  return { ana, ben, lock: { modules: {}, members: { ana: { keys: [ana.key.keyId] }, ben: { keys: [ben.key.keyId] } }, roles: { reviewer: ["ana"], auditor: ["ben"] } } as Lock, keys: new TrustedKeys([ana.key.publicKey, ben.key.publicKey]) };
}

let n = 0;
const msg = () => ({ sender: "test", messageId: `m${++n}` });

/** `who`'s signed answer to the question the run waits on. */
async function answer(w: World, runId: string, who: Person, value: Value): Promise<RunRow> {
  const shown = await w.rt.shown(runId, "wait");
  return w.rt.submitInput(runId, msg(), { value, signed: signDecision(who.key, shown, { kind: "answer", member: who.member, payload: payloadOf.answer(value), at: new Date(w.adapters.clock.now()) }) });
}

// ── a workflow written out ──────────────────────────────────────────────

/**
 * Two stages; a report to the reviewer of a model's line, a count, what the run was given, a template over the
 * model's line, a record and a confidential value; a question to the reviewer in the second stage; a report to the
 * auditor in each round of a loop; and one to the reviewer of a verified value and the person's answer.
 */
const PROGRAM = `mandate @ 0.7

module example.attention.run @ 0.1

use std.{human, model}

role reviewer "Reviewer"
role auditor  "Auditor"

type Secret = Text classified confidential
type Note = { text: Text, words: Int }

capability ModelStd = model.infer(tier: standard, max_class: confidential)

contract Said(name: Text, line: Text) {
  accept said "The greeting is not empty"
    by static line != ""
}

agent Greeter {
  role   "Writes one line of greeting."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill greet(name: Text) -> Inferred<Text> ! {Model}
}

workflow Greet(name: Text, secret: Secret) -> Verified<Text, Said>
  caps   ModelStd
  budget { time: 5m, steps: 8 }
{
  stage draft "Write the greeting"
  let line = delegate Greeter.greet(name)
  report to reviewer "Greeting drafted" {
    draft: line, words: len(line), name: name, both: "{line} for {name}", note: Note { text: name, words: len(line) }, secret: secret
  }

  stage check "Check the greeting"
  let ok = verify line against Said(name, line)
  let why = human.ask("Why this greeting?", role: reviewer)
  loop max_iter 2 {
    report to auditor "One round" { greeting: ok, why: why }
  }
  report to reviewer "Greeting checked" { greeting: ok, why: why }
  ok
}

/// A report of one large value, and how long it is.
workflow Big(text: Text) -> Int
  caps   ModelStd
  budget { time: 5m, steps: 1 }
{
  stage only "Count the text"
  report to reviewer "Counted" { text: text, chars: len(text) }
  len(text)
}

/// A report of a field of what the greeter gave, which it may not have.
workflow Field(name: Text) -> Int
  caps   ModelStd
  budget { time: 5m, steps: 2 }
{
  let note = delegate Greeter.note(name)
  report to reviewer "Noted" { words: note.words }
  1
}

/// A stage, and a step in it that fails.
workflow Fails(name: Text) -> Inferred<Text>
  caps   ModelStd
  budget { time: 5m, steps: 2 }
{
  stage try "Try once"
  delegate Greeter.fail(name)
}

/// The same field, read by a statement that is not a report.
workflow Plain(name: Text) -> Int
  caps   ModelStd
  budget { time: 5m, steps: 2 }
{
  let note = delegate Greeter.note(name)
  let words = note.words
  1
}
`.replace("  skill greet(name: Text) -> Inferred<Text> ! {Model}", "  skill greet(name: Text) -> Inferred<Text> ! {Model}\n  skill note(name: Text) -> Inferred<Note> ! {Model}\n  skill fail(name: Text) -> Inferred<Text> ! {Model}");

const SECRET = "the-vault-word";
const INPUT = { name: "ana", secret: SECRET };
const LINE = "hello, ana";
const WHY = "it is short";

/** A world of PROGRAM: signed decisions, a greeter that says hello, and one whose note lacks its count. */
async function greeting(o: { src?: string } = {}): Promise<World & ReturnType<typeof people>> {
  const who = people();
  const agents = new SimAgents()
    .on("Greeter.greet", (req) => ({ ok: `hello, ${String((req.args as unknown[])[0])}`, cost: { steps: 1 } }))
    .on("Greeter.note", () => ({ ok: { text: "a note" }, cost: { steps: 1 } }))
    .on("Greeter.fail", () => ({ error: { tag: "SkillFailed", args: ["no greeting"] }, cost: { steps: 1 } }));
  const w = await world(o.src ?? PROGRAM, { agents, lock: who.lock, decisions: { keys: who.keys } });
  return { ...w, ...who };
}

const start = (w: World, runId: string, workflow = "Greet", input: Obj = INPUT): Promise<RunRow> => w.rt.startRun({ pkg: w.pkg, workflow, input, runId });

/** The run's events of the attention types, in order, each as `[type, data]`. */
async function attentionEvents(w: World, runId: string): Promise<Array<[string, Obj]>> {
  return (await w.rt.journal.events(runId)).filter((e) => ["stage_started", "stage_ended", "report"].includes(e.type)).map((e) => [e.type, e.data as Obj]);
}

/** Every event type of the run, in order. */
const types = async (w: World, runId: string): Promise<string[]> => (await w.rt.journal.events(runId)).map((e) => e.type);

const DRAFT = "/defs/Greet/body/0";
const CHECK = "/defs/Greet/body/3";
const DRAFTED = "/defs/Greet/body/2";
const ROUND = "/defs/Greet/body/6/body/0";
const CHECKED = "/defs/Greet/body/7";

describe("a 0.7 workflow written out, with stages and reports", () => {
  it("writes each stage and each report in order, with their data, and ends the last stage before run_succeeded", async () => {
    const w = await greeting();
    const waiting = await start(w, "g");
    expect(waiting.state, state(waiting)).toBe("waiting");
    // Up to the question: the first stage, its report, and the second stage with the end of the first.
    expect(await attentionEvents(w, "g")).toEqual([
      ["stage_started", { node: DRAFT, stage: "draft", title: "Write the greeting", index: 0 }],
      ["report", expect.objectContaining({ node: DRAFTED, command: DRAFTED, role: "reviewer", title: "Greeting drafted" })],
      ["stage_ended", { node: DRAFT, stage: "draft" }],
      ["stage_started", { node: CHECK, stage: "check", title: "Check the greeting", index: 1 }],
    ]);
    const done = await answer(w, "g", w.ana, WHY);
    expect(done.state, state(done)).toBe("succeeded");
    const all = await attentionEvents(w, "g");
    expect(all.map(([t, d]) => [t, d["node"], d["command"] ?? null])).toEqual([
      ["stage_started", DRAFT, null],
      ["report", DRAFTED, DRAFTED],
      ["stage_ended", DRAFT, null],
      ["stage_started", CHECK, null],
      // A loop's report, once for each iteration: its command id names the iteration, its node the statement.
      ["report", ROUND, "/defs/Greet/body/6/body@0/0"],
      ["report", ROUND, "/defs/Greet/body/6/body@1/0"],
      ["report", CHECKED, CHECKED],
      ["stage_ended", CHECK, null],
    ]);
    // The last stage ends directly before the run succeeds, in its transaction.
    const t = await types(w, "g");
    expect(t.slice(-2)).toEqual(["stage_ended", "run_succeeded"]);
    // The report to the reviewer, with every field as the run evaluated it and labelled from the stored facts.
    const drafted = all.find(([type, d]) => type === "report" && d["node"] === DRAFTED)![1];
    expect(drafted["fields"]).toEqual([
      { name: "draft", value: LINE, class: "public", known: "model", type: "Inferred<Text>" },
      { name: "words", value: LINE.length, class: "public", known: "plain", type: "Int" },
      { name: "name", value: "ana", class: "public", known: "plain", type: "Text" },
      // A template that interpolates a model's output is a model's output.
      { name: "both", value: `${LINE} for ana`, class: "public", known: "model", type: "Text" },
      { name: "note", value: { text: "ana", words: LINE.length }, class: "public", known: "plain", type: "Note" },
      // A value of a class above internal is written as it is: masking is the projection's (B4), never the journal's.
      { name: "secret", value: SECRET, class: "confidential", known: "plain", type: "Secret" },
    ]);
    // A verified value, and a person's answer, which is outside content.
    const checked = all.find(([type, d]) => type === "report" && d["node"] === CHECKED)![1];
    expect(checked).toMatchObject({ role: "reviewer", title: "Greeting checked" });
    expect(checked["fields"]).toEqual([
      { name: "greeting", value: expect.objectContaining({ $verified: LINE, $contract: "Said" }), class: "public", known: "verified", type: "Verified<Text, Said>" },
      { name: "why", value: WHY, class: "public", known: "external", type: "Untrusted<Text>" },
    ]);
    const round = all.find(([type, d]) => type === "report" && d["node"] === ROUND)![1];
    expect(round).toMatchObject({ role: "auditor", title: "One round" });
    // A report changes no value: the workflow's value is its last statement's that is not a report.
    expect(done.result).toMatchObject({ $verified: LINE, $contract: "Said" });
  });

  it("writes no stage and no report twice, however often the run is resumed, and costs nothing", async () => {
    const w = await greeting();
    expect((await start(w, "r")).state).toBe("waiting");
    const before = await attentionEvents(w, "r");
    // A resume of the waiting run comes to the first stage, its report and the second stage again: nothing is written.
    expect((await w.rt.resume("r")).state).toBe("waiting");
    expect((await w.rt.resume("r")).state).toBe("waiting");
    expect(await attentionEvents(w, "r")).toEqual(before);
    // A crash after the first report of the loop is written: the resumed run writes the rest, and none twice.
    const report = w.rt.journal.report.bind(w.rt.journal);
    let reported = 0;
    w.rt.journal.report = async (...a: Parameters<typeof report>) => {
      await report(...a);
      if (++reported === 1) throw new Crash("after the first report");
    };
    await expect(answer(w, "r", w.ana, WHY)).rejects.toBeInstanceOf(Crash);
    w.rt.journal.report = report;
    expect((await w.rt.resume("r")).state).toBe("succeeded");
    const all = await attentionEvents(w, "r");
    expect(all.filter(([t]) => t === "report").map(([, d]) => d["command"])).toEqual([DRAFTED, "/defs/Greet/body/6/body@0/0", "/defs/Greet/body/6/body@1/0", CHECKED]);
    expect(all.filter(([t]) => t === "stage_started")).toHaveLength(2);
    expect(all.filter(([t]) => t === "stage_ended")).toHaveLength(2);
    // Neither is a command: nothing reserved, nothing counted, no row.
    const commands = await w.db.query<{ command_id: string }>("select command_id from commands where run_id = $1", ["r"]);
    expect(commands.map((c) => c.command_id).filter((id) => [DRAFT, CHECK, DRAFTED, CHECKED].includes(id) || id.includes("/body/6/body@"))).toEqual([]);
  });

  it("writes nothing in a replay, which gives the same result, from the stored facts", async () => {
    const w = await greeting();
    await start(w, "p");
    const done = await answer(w, "p", w.ana, WHY);
    expect(done.state).toBe("succeeded");
    const events = await w.rt.journal.events("p");
    let asked = 0;
    w.rt.attentionFacts = (i) => {
      asked++;
      return attentionFacts(i);
    };
    expect(await w.rt.replayRun("p")).toEqual({ status: "complete", value: done.result });
    expect(await w.rt.journal.events("p")).toEqual(events);
    expect(asked).toBe(0);
  });

  it("leaves the open stage open when the run waits, fails or is cancelled: only success ends it", async () => {
    const w = await greeting();
    await start(w, "c");
    expect((await attentionEvents(w, "c")).at(-1)).toEqual(["stage_started", expect.objectContaining({ node: CHECK })]);
    const cancelled = await w.rt.cancelRun("c");
    expect(cancelled.state).toBe("cancelled");
    expect((await attentionEvents(w, "c")).filter(([t, d]) => t === "stage_ended" && d["node"] === CHECK)).toEqual([]);
    // A run that fails in a stage leaves it open as well.
    const failed = await start(w, "fails", "Fails", { name: "ana" });
    expect(failed.state, state(failed)).toBe("failed");
    expect(await attentionEvents(w, "fails")).toEqual([["stage_started", { node: "/defs/Fails/body/0", stage: "try", title: "Try once", index: 0 }]]);
  });

  it("writes a value whose canonical form is longer than 64 KiB as omitted, with its size", async () => {
    const w = await greeting();
    const text = "x".repeat(MAX_REPORT_VALUE);
    const r = await start(w, "big", "Big", { text });
    expect(r.state, state(r)).toBe("succeeded");
    const report = (await attentionEvents(w, "big")).find(([t]) => t === "report")![1];
    // The canonical form of the text is its characters and two quotes.
    expect(report!["fields"]).toEqual([
      { name: "text", value: { $omitted: { bytes: MAX_REPORT_VALUE + 2 } }, class: "public", known: "plain", type: "Text" },
      { name: "chars", value: MAX_REPORT_VALUE, class: "public", known: "plain", type: "Int" },
    ]);
    // At the limit, a value is written whole.
    expect(reportValue("y".repeat(MAX_REPORT_VALUE - 2))).toBe("y".repeat(MAX_REPORT_VALUE - 2));
    expect(reportValue("y".repeat(MAX_REPORT_VALUE - 1))).toEqual({ $omitted: { bytes: MAX_REPORT_VALUE + 1 } });
  });

  it("fails as the same expression fails anywhere else when a field cannot be evaluated, and writes no report", async () => {
    const w = await greeting();
    const field = await start(w, "f", "Field", { name: "ana" });
    const plain = await start(w, "f2", "Plain", { name: "ana" });
    expect(field.state, state(field)).toBe(plain.state);
    expect(field.attention).toEqual(JSON.parse(JSON.stringify(plain.attention).replaceAll("/defs/Plain/body/1/value", "/defs/Field/body/1/fields/0/value")));
    expect(await attentionEvents(w, "f")).toEqual([]);
  });
});

// ── the stored facts ────────────────────────────────────────────────────

/** The digest the run's manifest names its facts by, and the facts stored under it. */
async function storedOf(w: World, runId: string): Promise<{ named: string; facts: AttentionFacts }> {
  const run = await w.rt.getRun(runId);
  const named = (run.manifest as Obj)["attention"] as string;
  return { named, facts: (await w.rt.storedFacts(run))! };
}

describe("the attention facts a run of 0.7 stores at its start", () => {
  it("are the door's for the workflow, stored as an artifact of the run and named in its manifest by their digest", async () => {
    const w = await greeting();
    await start(w, "s");
    const { named, facts } = await storedOf(w, "s");
    expect(named).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(facts).toMatchObject({ format: "mandate/attention/0.1", workflow: "Greet" });
    expect(facts.stages.map((s) => s.path)).toEqual([DRAFT, CHECK]);
    expect(facts.reports.map((r) => r.path)).toEqual([DRAFTED, ROUND, CHECKED]);
    const stored = (await w.rt.artifactList("s")).filter((a) => a.media_type === ATTENTION_MEDIA_TYPE);
    expect(stored.map((a) => a.digest)).toEqual([named]);
    // The manifest names them beside what it named before, and the run's first event names the manifest.
    const run = await w.rt.getRun("s");
    expect(Object.keys(run.manifest as Obj).sort()).toEqual(["attention", "components", "format", "input", "mode", "package", "tenant", "workflow"]);
  });

  it("are kept whole, with members a later compiler adds, and a resume reads them and never asks again", async () => {
    const w = await greeting();
    // The compiler at the start gives a member this runtime does not read (as a later slice's will): stored and hashed with the rest.
    w.rt.attentionFacts = (i) => ({ ...attentionFacts(i)!, later: { all: 1 } });
    await start(w, "u");
    expect((await storedOf(w, "u")).facts["later"]).toEqual({ all: 1 });
    // An upgraded compiler, while the run waits, labels the fields otherwise: the run shows what it stored.
    let asked = 0;
    w.rt.attentionFacts = (i: AttentionFactsInput) => {
      asked++;
      const f = attentionFacts(i)!;
      return { ...f, reports: f.reports.map((r) => ({ ...r, fields: r.fields.map((x) => ({ ...x, class: "restricted" as const, known: "model" as const })) })) };
    };
    expect((await answer(w, "u", w.ana, WHY)).state).toBe("succeeded");
    expect(asked).toBe(0);
    const checked = (await attentionEvents(w, "u")).find(([t, d]) => t === "report" && d["node"] === CHECKED)![1];
    expect((checked["fields"] as Obj[]).map((f) => [f["class"], f["known"]])).toEqual([
      ["public", "verified"],
      ["public", "external"],
    ]);
  });

  it("stop the run for a person when they are missing (facts_mismatch), at a resume and at a replay", async () => {
    const w = await greeting();
    await start(w, "m");
    await w.db.query("delete from artifacts where run_id = $1 and media_type = $2", ["m", ATTENTION_MEDIA_TYPE]);
    const stopped = await answer(w, "m", w.ana, WHY);
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "facts_mismatch", message: expect.stringContaining("none are stored with it") });
    expect(await w.rt.replayRun("m")).toMatchObject({ status: "attention_required", reason: { violation: "facts_mismatch" } });
  });

  it("stop the run when the stored bytes are changed, and do not hash to what the manifest names (facts_mismatch)", async () => {
    const w = await greeting();
    await start(w, "x");
    const { named, facts } = await storedOf(w, "x");
    const changed = { ...facts, reports: facts.reports.map((r) => ({ ...r, fields: r.fields.map((f) => ({ ...f, class: "public" as const })) })) };
    (w.rt.artifacts.blobs as MemoryBlobs).tamper(named, new TextEncoder().encode(JSON.stringify(changed)));
    const stopped = await answer(w, "x", w.ana, WHY);
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "facts_mismatch", message: expect.stringContaining("do not hash to it") });
    expect(await w.rt.replayRun("x")).toMatchObject({ status: "attention_required", reason: { violation: "facts_mismatch" } });
  });

  it("stop the run at a report the stored facts hold no entry for, or whose fields they give otherwise (facts_mismatch)", async () => {
    const w = await greeting();
    w.rt.attentionFacts = (i) => {
      const f = attentionFacts(i)!;
      return { ...f, reports: f.reports.filter((r) => r.path !== DRAFTED) };
    };
    const r = await start(w, "n");
    expect(r.state).toBe("attention_required");
    expect(r.attention).toMatchObject({ violation: "facts_mismatch", message: expect.stringContaining(`has no entry in the stored facts (${DRAFTED})`) });
    expect((await attentionEvents(w, "n")).filter(([t]) => t === "report")).toEqual([]);
    // Fields renamed: no report is written without the labels of its own fields.
    w.rt.attentionFacts = (i) => {
      const f = attentionFacts(i)!;
      return { ...f, reports: f.reports.map((x) => (x.path === DRAFTED ? { ...x, fields: x.fields.slice(1) } : x)) };
    };
    const s = await start(w, "n2");
    expect(s.attention).toMatchObject({ violation: "facts_mismatch", message: expect.stringContaining("has the fields draft, words") });
    // A stage the facts do not have is the same.
    w.rt.attentionFacts = (i) => ({ ...attentionFacts(i)!, stages: [] });
    expect((await start(w, "n3")).attention).toMatchObject({ violation: "facts_mismatch", message: expect.stringContaining(`has no entry in the stored facts (${DRAFT})`) });
  });

  it("refuse the start when the door gives none, or refuses: no run without its facts", async () => {
    const w = await greeting();
    w.rt.attentionFacts = () => null;
    await expect(start(w, "none")).rejects.toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("no attention facts") });
    w.rt.attentionFacts = () => {
      throw new Error("the door refused");
    };
    await expect(start(w, "refused")).rejects.toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("the door refused") });
    w.rt.attentionFacts = (i) => ({ ...attentionFacts(i)!, workflow: "Big" });
    await expect(start(w, "other")).rejects.toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("the attention facts of Big") });
    const rows = await w.db.query<{ n: unknown }>("select count(*) as n from runs");
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("are not asked for, and nothing is stored, in a run of 0.6, whose manifest is as it was", async () => {
    const six = `mandate @ 0.6\n\nmodule example.attention.six @ 0.1\n\nuse std.{model}\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\nagent Greeter {\n  role   "Writes one line of greeting."\n  caps   ModelStd\n  budget { time: 2m, steps: 2 }\n  skill greet(name: Text) -> Inferred<Text> ! {Model}\n}\n\nworkflow Greet(name: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  delegate Greeter.greet(name)\n}\n`;
    const agents = new SimAgents().on("Greeter.greet", () => ({ ok: LINE, cost: { steps: 1 } }));
    const w = await world(six, { agents, decisions: { mode: "signed" }, lock: { modules: {} } });
    let asked = 0;
    w.rt.attentionFacts = (i) => {
      asked++;
      return attentionFacts(i);
    };
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { name: "ana" }, runId: "six" });
    expect(r.state, state(r)).toBe("succeeded");
    expect(asked).toBe(0);
    const manifest = { format: RUN_MANIFEST_FORMAT, package: w.pkg.hash, workflow: "Greet", tenant: "default", input: digest("request", { name: "ana" }), mode: "live", components: {} };
    expect(r.manifest).toEqual(manifest);
    expect(r.manifest_hash).toBe(digest("run", manifest));
    expect((await w.rt.artifactList("six")).filter((a) => a.media_type === ATTENTION_MEDIA_TYPE)).toEqual([]);
    expect(await attentionEvents(w, "six")).toEqual([]);
  });
});

// ── a report is addressed ───────────────────────────────────────────────

describe("a report is addressed", () => {
  it("is shown, of the roles, to the one it is to alone; the audit view shows each", () => {
    const report = { node: DRAFTED, command: DRAFTED, role: "reviewer", title: "t", fields: [] };
    expect(EVENT_CLASSES["report"]).toBe("S2");
    expect([EVENT_CLASSES["stage_started"], EVENT_CLASSES["stage_ended"]]).toEqual(["S2", "S2"]);
    expect(addressee("report", report)).toEqual({ to: "reviewer" });
    expect(shows({ role: "reviewer" }, "S2", undefined, addressee("report", report))).toBe(true);
    expect(shows({ role: "auditor" }, "S2", undefined, addressee("report", report))).toBe(false);
    expect(shows({ audit: true }, "S2", undefined, addressee("report", report))).toBe(true);
    // One that names no role is shown to none; an event of another type is not addressed, whatever its data says.
    expect(shows({ role: "reviewer" }, "S2", undefined, addressee("report", { node: DRAFTED }))).toBe(false);
    expect(addressee("stage_started", { role: "reviewer" })).toBeUndefined();
    expect(addressee("map_started", report)).toBeUndefined();
    expect(shows({ role: "auditor" }, "S2", undefined, addressee("stage_started", {}))).toBe(true);
  });

  it("is in no role's view but that of the role it is to, masked by its cap (B4), in no projection that leaves the machine, and in the audit view with its values", async () => {
    const w = await greeting();
    await start(w, "v");
    expect((await answer(w, "v", w.ana, WHY)).state).toBe("succeeded");
    const values = [SECRET, LINE, WHY];
    const titles: Record<string, string[]> = { reviewer: ["Greeting drafted", "Greeting checked"], auditor: ["One round", "One round"] };
    for (const role of ["reviewer", "auditor"]) {
      const { view } = await runView(w.rt, "v", { role });
      // A role's view of 0.7 shows the reports to it (`reports`), each field above its cap (`internal`) masked.
      expect(view.reports!.map((r) => r.title), role).toEqual(titles[role]);
      expect(JSON.stringify(view), `${role}: ${SECRET}`).not.toContain(SECRET);
      for (const other of Object.values(titles).flat().filter((t) => !titles[role]!.includes(t))) expect(JSON.stringify(view)).not.toContain(other);
    }
    const { view: audit } = await runView(w.rt, "v", { audit: true });
    const reports = audit.events.filter((e) => e.type === "report");
    expect(reports.map((e) => [e.class, (e.data as Obj)["role"]])).toEqual([
      ["S2", "reviewer"],
      ["S2", "auditor"],
      ["S2", "auditor"],
      ["S2", "reviewer"],
    ]);
    expect(JSON.stringify(reports)).toContain(SECRET);
    // The OpenTelemetry export: the report's type, class, sequence number and hash leave, none of its values.
    const posts: string[] = [];
    const server: Server = createServer((req, res) => {
      let text = "";
      req.on("data", (c: Buffer) => (text += c.toString("utf8")));
      req.on("end", () => {
        posts.push(text);
        res.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      await otelExport(w.db, { endpoint: otelEndpoint(`http://127.0.0.1:${(server.address() as AddressInfo).port}`), scope: { run: "v" }, timeoutMs: 5000 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
    const sent = posts.join("\n");
    expect(sent).toContain('"report"');
    expect(sent).toContain('"stage_started"');
    for (const v of [...values, "Greeting drafted", "Write the greeting"]) expect(sent, v).not.toContain(v);
  });
});

// ── a pattern of a library, with stages and a report to a role slot ─────

/** A library of 0.7 with one pattern: two stages, and a report to its role slot of what its work gave. */
const LIBRARY: LibrarySource = {
  manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.attn", version: "1.0.0", modules: ["attn.mdt"] }),
  files: {
    "attn.mdt": `mandate @ 0.7

module acme.attn @ 1.0

/// Asks once, tells its reviewer what came back, and gives it.
pub pattern Once(
  work:     skill(Text) -> Inferred<Text>,
  reviewer: role
) (name: Text) -> Inferred<Text>
{
  stage ask "Ask once"
  let out = delegate work(name)
  report to reviewer "Asked" { answer: out, chars: len(out) }

  stage give "Give it back"
  out
}
`,
  },
};

const APPLYING = `mandate @ 0.7

module example.attention.applied @ 0.1

use std.{model}
use acme.attn.{Once}

role auditor "Auditor"

capability ModelStd = model.infer(tier: standard, max_class: internal)

agent Greeter {
  role   "Writes one line of greeting."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill greet(name: Text) -> Inferred<Text> ! {Model}
}

/// Greets once, and tells the auditor.
workflow Greet = Once(work: Greeter.greet, reviewer: auditor)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`;

const pinOf = (l: LibrarySource): LibraryPin => libraryVerify(l).pin!;

describe("a workflow that applies a pattern with stages and a report to a role slot", () => {
  it("runs the expansion's stages and report: the paths of the running program, and the role the application binds", async () => {
    const who = people();
    const agents = new SimAgents().on("Greeter.greet", () => ({ ok: LINE, cost: { steps: 1 } }));
    const lock = { ...who.lock, roles: { auditor: ["ben"] }, libraries: { "acme.attn": pinOf(LIBRARY) } } as Lock;
    const w = await world(APPLYING, { agents, lock, decisions: { keys: who.keys }, libraries: [LIBRARY] });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { name: "ana" }, runId: "a" });
    expect(r.state, state(r)).toBe("succeeded");
    expect(r.result).toBe(LINE);
    expect(await attentionEvents(w, "a")).toEqual([
      ["stage_started", { node: "/defs/Greet/body/0", stage: "ask", title: "Ask once", index: 0 }],
      [
        "report",
        {
          node: "/defs/Greet/body/2",
          command: "/defs/Greet/body/2",
          role: "auditor",
          title: "Asked",
          fields: [
            { name: "answer", value: LINE, class: "public", known: "model", type: "Inferred<Text>" },
            { name: "chars", value: LINE.length, class: "public", known: "plain", type: "Int" },
          ],
        },
      ],
      ["stage_ended", { node: "/defs/Greet/body/0", stage: "ask" }],
      ["stage_started", { node: "/defs/Greet/body/3", stage: "give", title: "Give it back", index: 1 }],
      ["stage_ended", { node: "/defs/Greet/body/3", stage: "give" }],
    ]);
    // Its facts are of the running program: the paths of the expansion, where the pattern's role slot is the auditor.
    const { facts } = await storedOf(w, "a");
    expect(facts.reports).toEqual([expect.objectContaining({ path: "/defs/Greet/body/2", role: "auditor" })]);
    expect(await w.rt.replayRun("a")).toEqual({ status: "complete", value: LINE });
  });
});

// ── a lead's sub-program that applies a listed shape with stages and a report ──

/** A pattern the parent's envelope lists as a shape: two stages, and a report to its role slot. */
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

/** The plan program of planning.ts in 0.7, with the pattern, and `shapes [Ask]` in its envelope. */
const PARENT = planProgram().replace("mandate @ 0.4", "mandate @ 0.7").replace("workflow W(items", `${PATTERNS}workflow W(items`).replace("agents: 12 }", "agents: 12 }\n    shapes  [Ask]");
const PLAN = "/defs/W/body/0/value";
const SUB = `${PLAN}/program/1`;
const BASE = baseOf(MODULE, 1, "mandate/0.7" as never);
const opsOf = (defs: string): Value[] => {
  const r = load(`mandate @ 0.7\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries(r.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
};
const submitting = (defs: string, id = "s1"): SimTurn => [toolUse(id, "submit_program", { base: BASE, ops: opsOf(defs) })];
const APPLIED = `workflow Fix = Ask(work: Worker.fix, reviewer: release_manager)\n  caps   ${CAPS}\n  budget ${BUDGET}\n`;
const WRITTEN = `workflow Fix() -> Inferred<Text>\n  caps   ${CAPS}\n  budget ${BUDGET}\n{\n  stage one "Fix it"\n  delegate Worker.fix(Item { name: "a" })\n}`;

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(() => checker.close());

describe("a lead's sub-program of a 0.7 parent", () => {
  const lead = (turns: Turn[], c: ProgramChecker = checker): Promise<Planned> => planned(c, turns, { src: PARENT });

  it("runs the stages and the report of a listed shape it applies, labelled from the facts stored at its admission", async () => {
    const w = await lead([submitting(APPLIED), finish("planned")]);
    const r = await runPlan(w, "sub");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    const program = { plan: PLAN, number: 1 };
    expect(await attentionEvents(w, "sub")).toEqual([
      ["stage_started", { node: "/defs/Fix/body/0", stage: "ask", title: "Ask about the item", index: 0, program }],
      ["report", { node: "/defs/Fix/body/2", command: `${SUB}/defs/Fix/body/2`, role: "release_manager", title: "Asked", fields: [{ name: "answer", value: "fixed a", class: "public", known: "model", type: "Inferred<Text>" }] }],
      ["stage_ended", { node: "/defs/Fix/body/0", stage: "ask", program }],
      ["stage_started", { node: "/defs/Fix/body/3", stage: "give", title: "Give it back", index: 1, program }],
      // The sub-program's last stage ends when it ends with its value; the run's own workflow has none.
      ["stage_ended", { node: "/defs/Fix/body/3", stage: "give", program }],
    ]);
    // The admission names the facts, stored with the sub-program, of its workflow.
    const [admitted] = (await w.rt.journal.events("sub")).filter((e) => e.type === "program_admitted").map((e) => e.data as Obj);
    expect(admitted!["attention"]).toMatch(/^sha256:[0-9a-f]{64}$/);
    const stored = (await w.rt.artifactList("sub")).filter((a) => a.media_type === ATTENTION_MEDIA_TYPE).map((a) => a.digest);
    expect(stored).toContain(admitted!["attention"]);
    // A replay reads them, writes nothing, and ends as the run did.
    const events = await w.rt.journal.events("sub");
    expect(await w.rt.replayRun("sub")).toEqual({ status: "complete", value: "planned" });
    expect(await w.rt.journal.events("sub")).toEqual(events);
  });

  it("stops the run when the facts its admission names are missing (facts_mismatch)", async () => {
    const w = await lead([submitting(APPLIED), finish("planned")]);
    expect((await runPlan(w, "gone")).state).toBe("succeeded");
    const [admitted] = (await w.rt.journal.events("gone")).filter((e) => e.type === "program_admitted").map((e) => e.data as Obj);
    await w.db.query("delete from artifacts where run_id = $1 and digest = $2", ["gone", admitted!["attention"]]);
    expect(await w.rt.replayRun("gone")).toMatchObject({ status: "attention_required", reason: { violation: "facts_mismatch", message: expect.stringContaining("Sub-program 1") } });
  });

  it("is refused by name when the checker gives no facts of a sub-program whose workflow runs a stage or a report", async () => {
    const bare: ProgramChecker = {
      check: async (input, ms) => {
        const r = await checker.check(input, ms);
        if ("ok" in r) {
          const { attention: _facts, ...rest } = r as typeof r & { attention?: unknown };
          return rest;
        }
        return r;
      },
    };
    const w = await lead([submitting(APPLIED), finish("planned")], bare);
    const r = await runPlan(w, "bare");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false, diagnostics: [expect.objectContaining({ code: "check_failed", facts: { reason: expect.stringContaining("no attention facts") } })] });
    expect(await attentionEvents(w, "bare")).toEqual([]);
  });

  it("is refused by the compiler when the lead writes a stage in its own text (E1705)", async () => {
    const w = await lead([submitting(WRITTEN), finish("planned")]);
    const r = await runPlan(w, "own");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false });
    expect(JSON.stringify(w.told[0])).toContain("MDT-E1705");
    expect(await attentionEvents(w, "own")).toEqual([]);
  });
});
