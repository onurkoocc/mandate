// `asks` at run time (spec/attention.md "`asks` at run time", "The attention bound"; slice B3): a run of 0.7 holds the
// most questions it may put to people.
//
// - the limit: the declared `asks` and the caller's `--limit asks=N`, the smaller of the two, kept as the budget's row
//   `asks`; none without either, and a run of 0.6 never has one;
// - the bound under the runtime's configuration at the start: the static total and the effect sites `authorize` hands
//   to a person; above the limit, or unbounded, the start is refused (`attention_above_asks`) before anything is written;
// - counting: each question once, when its wait opens, in its transaction; a resume finds the wait and counts nothing,
//   a replay counts nothing;
// - exhaustion: the question is not asked, its command fails `Rejected(asks_exhausted)`, one `asks_exhausted` is
//   written, and what it guarded does not happen, for every kind of the closed list;
// - the test of the sources: every place the runtime opens a wait for a person carries a site tag of the closed list;
// - an approval's role read as the program names it (D2), and `raise-limits` and `--limit asks=N`.
//
// The fixture is the compiler's (fixtures/attention/asks.mdt): a workflow for each kind of question, each declaring as
// `asks` exactly the bound the compiler computes. To run a site out of `asks` a test stands in facts whose total is
// smaller (`Runtime.attentionFacts`): the runtime holds the limit whatever the bound says, and nothing passes on its
// own. Every rule holds on PGlite and on PostgreSQL (helpers.ts, MANDATE_TEST_DATABASE_URL; counts are read with
// Number). The hook of asks-hook.ts holds every run here to its bound as well.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { attentionFacts, hashProgram, load, type AttentionFacts, type AttentionFactsInput, type Json, type Program } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { ASKS, SITE_KINDS, SUPERVISE_ESCALATIONS } from "../src/asks.js";
import { limits } from "../src/cli.js";
import { payloadOf, signDecision, type DecisionKind } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { SimAgents, SimTool, type SimTool as Tool } from "../src/sim.js";
import type { RunRow } from "../src/journal.js";
import type { Obj } from "../src/values.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const read = (rel: string): string => readFileSync(here(`../../${rel}`), "utf8");

/** The compiler's fixture of every kind of question, each workflow's `asks` its bound. */
const ASKS_MDT = read("fixtures/attention/asks.mdt");

const ROLES = ["accountant", "finance_lead", "code_owner", "release_manager", "platform_lead", "api_owner", "web_owner", "architect", "owner"];

/** Ana holds every role. */
const ana = EvidenceSigner.generate();
const LOCK = { modules: {}, members: { ana: { keys: [ana.keyId] } }, roles: Object.fromEntries(ROLES.map((r) => [r, ["ana"]])) } as never;

interface AWorld extends World {
  writer: SimAgents;
}

/** A world of `src` (the fixture by default) where Ana decides, and the Writer writes (or fails, with `fails`). */
async function aworld(src = ASKS_MDT, o: { fails?: boolean; tools?: Tool[] } = {}): Promise<AWorld> {
  const writer = new SimAgents().on("Writer.write", () => (o.fails ? { error: { tag: "SkillFailed", args: [{ kind: "made-up" }] }, cost: { steps: 1 } } : { ok: "a note", cost: { steps: 1 } }));
  const w = await world(src, { agents: writer, lock: LOCK, decisions: { keys: new TrustedKeys([ana.publicKey]) }, ...(o.tools ? { tools: o.tools } : {}) });
  return { ...w, writer };
}

let n = 0;
const msg = () => ({ sender: "asks", messageId: `m${++n}` });

/** Ana's signed decision of `kind` on the wait the run shows now. */
async function sign(w: World, runId: string, kind: DecisionKind, payload?: string) {
  return signDecision(ana, await w.rt.shown(runId, "wait"), { kind, member: "ana", ...(payload !== undefined ? { payload } : {}), at: new Date(w.adapters.clock.now()) });
}

/** Answers the wait the run stops at: an input with `value`, a decision with an approval. */
async function answer(w: World, runId: string, value = "yes"): Promise<RunRow> {
  const run = await w.rt.getRun(runId);
  const kind = (run.waiting as Obj | null)?.["kind"];
  if (kind === "input") return w.rt.submitInput(runId, msg(), { value, signed: await sign(w, runId, "answer", payloadOf.answer(value)) });
  if (kind === "decision") return w.rt.decideAction(runId, msg(), { signed: await sign(w, runId, "approve") });
  throw new Error(`run ${runId} waits on ${String(kind)}`);
}

/** Answers waits until the run stops waiting, or `k` of them. */
async function drive(w: World, runId: string, k = 20, value = "yes"): Promise<RunRow> {
  let run = await w.rt.getRun(runId);
  for (let i = 0; i < k && run.state === "waiting"; i++) run = await answer(w, runId, value);
  return run;
}

/** The run's events of `type`, their data. */
async function eventsOf(w: World, runId: string, type: string): Promise<Obj[]> {
  return (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);
}

/** The run's `asks` row: limit, settled, reserved; undefined without one. */
async function asksRow(w: World, runId: string): Promise<{ limit: number; settled: number; reserved: number } | undefined> {
  return (await w.rt.journal.budget(runId))[ASKS];
}

/** The facts the door gives, with the static total of the questions set to `total`: a bound smaller than the program's. */
function understated(total: number): (i: AttentionFactsInput) => AttentionFacts | null {
  return (i) => {
    const f = attentionFacts(i)!;
    return { ...f, totals: { ...f.totals!, questions: total }, effects: (f.effects ?? []).map((e) => ({ ...e, multiplicity: 0 })) };
  };
}

const state = (r: RunRow): string => `${r.state} ${JSON.stringify(r.error ?? r.attention ?? r.waiting ?? null)}`;

// ── the test of the sources ─────────────────────────────────────────────

/** The runtime's sources, by file name. */
function sources(): Array<{ file: string; text: string }> {
  const dir = here("../src");
  const out: Array<{ file: string; text: string }> = [];
  const walk = (d: string, rel: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name), `${rel}${e.name}/`);
      else if (e.name.endsWith(".ts")) out.push({ file: `${rel}${e.name}`, text: readFileSync(join(d, e.name), "utf8") });
    }
  };
  walk(dir, "");
  return out.sort((a, b) => (a.file < b.file ? -1 : 1));
}

/** The text of the call that opens at `start` (the index of its `(`), to its matching `)`. */
function callAt(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("an unclosed call");
}

/** Every call that opens a wait for a person, by file, with the kinds its site tag names (`*` for a tag passed through). */
function waitSites(): string[] {
  const out: string[] = [];
  for (const { file, text } of sources()) {
    for (const m of text.matchAll(/(?:this\.wait|\.openWait|\.openReview|\.openAmendment)\(/g)) {
      // A method's own definition is no call.
      if (/(?:async|private)\s+$/.test(text.slice(Math.max(0, m.index - 20), m.index + 1).replace(/\.\w+\($/, ""))) continue;
      const before = text.slice(Math.max(0, m.index - 30), m.index);
      if (/async\s+$|private\s+async\s+$/.test(before)) continue;
      const call = callAt(text, m.index + m[0].length - 1);
      const kinds = [...call.matchAll(/\{\s*kind:\s*([^,]+?),\s*path:/g)].flatMap((k) => [...k[1]!.matchAll(/"([a-z_]+)"/g)].map((s) => s[1]!));
      const through = /this\.asking\(ctx, tag\)|,\s*site\s*,|,\s*site\)/.test(call);
      out.push(`${file} ${m[0].slice(0, -1)} ${kinds.length ? kinds.join("|") : through ? "*" : "NONE"}`);
    }
  }
  return out;
}

describe("the test of the sources: every place the runtime opens a wait for a person carries a site tag", () => {
  it("lists every such place, each with a kind of the closed list", () => {
    expect(waitSites()).toEqual([
      // A wait the journal opens: the definition passes the tag of its caller through, as its wrappers do.
      "interp.ts this.wait pause", // the default pause of `on budget_exceeded`, tagged `only: budget_exceeded` (D7)
      "interp.ts this.wait escalate",
      "interp.ts this.wait pause",
      "interp.ts this.wait ask",
      "interp.ts .openWait *", // Interpreter.wait: `this.asking(ctx, tag)`
      "interp.ts this.wait supervise_escalate",
      "interp.ts this.wait verify",
      "interp.ts .openReview review",
      "interp.ts this.wait changeset", // the set's approver
      "interp.ts this.wait governance", // the owner's gate before another role's decision
      "interp.ts this.wait governance|changeset|effect", // the authorization: the owner's in the place of a policy, a member's, an effect's
      "journal.ts .openWait *", // openReview
      "journal.ts .openWait *", // openAmendment
      "plan.ts .openAmendment plan",
    ]);
    for (const site of waitSites()) {
      const kinds = site.split(" ")[2]!;
      if (kinds === "*") continue;
      for (const k of kinds.split("|")) expect(SITE_KINDS, site).toContain(k);
    }
  });

  it("counts a review's escalation in the transaction that escalates it, on both paths", () => {
    const writes = sources().flatMap(({ file, text }) => [...text.matchAll(/\.event\(tx, [\w.]+, "review_escalated"/g)].map((m) => ({ file, before: text.slice(Math.max(0, m.index - 700), m.index) })));
    expect(writes.map((w) => w.file)).toEqual(["runtime.ts", "tick.ts"]);
    for (const w of writes) expect(w.before, w.file).toMatch(/escalationRefused\(/);
  });

  it("would find a wait without a tag (the test of the test)", () => {
    const text = `x;\n  const a = await this.wait(id, "input", { q: 1 });\n  await journal.openReview(runId, fence, c, r, q, this.asking(ctx, { kind: "nope", path: at, wait: at }));\n`;
    const calls = [...text.matchAll(/(?:this\.wait|\.openReview)\(/g)].map((m) => callAt(text, m.index + m[0].length - 1));
    expect(calls.map((c) => [...c.matchAll(/\{\s*kind:\s*([^,]+?),\s*path:/g)].map((k) => k[1]))).toEqual([[], ['"nope"']]);
  });

  it("holds the closed list of kinds to the compiler's, and the escalations of supervise escalate to its constant", () => {
    const asksRs = read("crates/mandate-check/src/asks.rs");
    const block = asksRs.slice(asksRs.indexOf("site_kinds! {"), asksRs.indexOf("}", asksRs.indexOf("site_kinds! {")));
    expect([...block.matchAll(/= "([a-z_]+)",/g)].map((m) => m[1])).toEqual([...SITE_KINDS]);
    expect(Number(/pub const SUPERVISE_ESCALATIONS: u64 = (\d+);/.exec(asksRs)![1])).toBe(SUPERVISE_ESCALATIONS);
    expect(Number(/const MAX_ESCALATIONS = (\d+);/.exec(read("runtime/src/interp.ts"))![1])).toBe(SUPERVISE_ESCALATIONS);
  });
});

// ── the limit ───────────────────────────────────────────────────────────

describe("the limit", () => {
  it("is the declared asks alone, kept as the budget's row, with the run's own bound reserved", async () => {
    const w = await aworld(ASKS_MDT, { fails: true });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Asking", runId: "d", input: { note: "long note" } });
    expect(r.state).toBe("waiting");
    // One question asked: settled 1, and 8 still reserved for the run's own of its 9.
    expect(await asksRow(w, "d")).toEqual({ limit: 9, settled: 1, reserved: 8 });
    expect((await eventsOf(w, "d", "run_accepted"))[0]).toMatchObject({ limits: { asks: 9 } });
  });

  it("is the smaller of the declared asks and the caller's, and the caller's alone when none is declared", async () => {
    const w = await aworld(ASKS_MDT, { fails: true });
    await w.rt.startRun({ pkg: w.pkg, workflow: "Asking", runId: "both", input: { note: "long note" }, limits: { asks: 12 } });
    expect((await asksRow(w, "both"))!.limit).toBe(9);
    // The fixture's components are claimed by one run at a time.
    await w.rt.cancelRun("both");
    // Handling declares 1 and asks 1: the caller's 1 is as small.
    await w.rt.startRun({ pkg: w.pkg, workflow: "Handling", runId: "same", input: { note: "x" }, limits: { asks: 1 } });
    expect((await asksRow(w, "same"))!.limit).toBe(1);
    await w.rt.cancelRun("same");
    // Endless declares none, and its bound is unbounded: with the caller's limit it does not start; without one it runs.
    const v = await aworld();
    await expect(v.rt.startRun({ pkg: v.pkg, workflow: "Endless", runId: "endless", input: { note: "x" }, limits: { asks: 3 } })).rejects.toMatchObject({ code: "attention_above_asks" });
    const free = await v.rt.startRun({ pkg: v.pkg, workflow: "Endless", runId: "free", input: { note: "x" } });
    expect(free.state, state(free)).toBe("waiting");
    expect(await asksRow(v, "free")).toBeUndefined();
  });

  it("is the caller's alone when the workflow declares none, and none with neither: no row, nothing refused", async () => {
    const src = ASKS_MDT.replace("budget { steps: 2, asks: 1 }", "budget { steps: 2 }");
    const w = await aworld(src);
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Handling", runId: "caller", input: { note: "x" }, limits: { asks: 4 } });
    expect(r.state, state(r)).toBe("waiting");
    expect(await asksRow(w, "caller")).toEqual({ limit: 4, settled: 1, reserved: 0 });
    await w.rt.cancelRun("caller");
    const none = await w.rt.startRun({ pkg: w.pkg, workflow: "Handling", runId: "none", input: { note: "x" } });
    expect(none.state).toBe("waiting");
    expect(await asksRow(w, "none")).toBeUndefined();
    const rows = await w.db.query<{ n: unknown }>("select count(*) as n from reservations where run_id = $1 and dimension = 'asks'", ["none"]);
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("is refused for a package of 0.6, which counts no questions, and a run of 0.6 has no asks row", async () => {
    const six = ASKS_MDT.replace("mandate @ 0.7", "mandate @ 0.6").replace(/, asks: \d+/g, "").replace(/^\s*stage .*$/gm, "");
    const w = await aworld(six);
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Handling", runId: "six", input: { note: "x" }, limits: { asks: 1 } })).rejects.toMatchObject({ code: "unsupported_limit" });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Handling", runId: "six2", input: { note: "x" } });
    expect(r.state).toBe("waiting");
    expect(Object.keys(await w.rt.journal.budget("six2"))).not.toContain(ASKS);
    const opened = await eventsOf(w, "six2", "wait_opened");
    expect(opened.map((d) => Object.keys(d).sort())).toEqual([["command", "kind", "request"]]);
  });
});

// ── the bound under the runtime's configuration ─────────────────────────

/** A pull request the configuration may hand to a person: the static total does not count its authorization. */
const OPENING = `mandate @ 0.7

module test.asks.opening @ 0.1

use std.{git, human}

role code_owner "Code owner"
role owner      "Owner"

type Change = { files: List<Text> }

capability Pr = git.pr("example/api")

contract Listed(c: Change) {
  accept listed "The change names its files" by static true
}

workflow Opening(c: Change) -> Text
  caps   Pr
  budget { steps: 4, asks: 2 }
{
  let ok = verify c against Listed(c)
  let pr = effect git.open_pr(ok) idempotent_by "pr"
  let said = human.ask("Is the pull request right?", role: code_owner)
  "opened"
}
`;

describe("the bound under the runtime's configuration", () => {
  it("adds the effect sites authorize hands to a person, and refuses a start above the limit before anything is written", async () => {
    const pr = new SimTool("git.open_pr");
    const w = await aworld(OPENING, { tools: [pr] });
    const c = { c: { files: ["a.ts"] } };
    // As the program stands: the pull request is authorized by policy, and the bound is the static total, 2.
    const plain = await w.rt.startRun({ pkg: w.pkg, workflow: "Opening", runId: "plain", input: c });
    expect(plain.state, state(plain)).toBe("waiting");
    expect((await asksRow(w, "plain"))!.reserved + (await asksRow(w, "plain"))!.settled).toBe(2);
    // The configuration hands it to the code owner: 3 questions, above asks: 2.
    const authorize = { "git.open_pr": { by: "human" as const, role: "code_owner" } };
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Opening", runId: "above", input: c, authorize })).rejects.toThrow(/attention_above_asks: The run can ask 3 questions under the runtime's configuration \(2 in the program, and 1 the configuration hands to a person\), above its asks limit of 2/);
    const rows = await w.db.query<{ n: unknown }>("select count(*) as n from runs where run_id = $1", ["above"]);
    expect(Number(rows[0]!.n)).toBe(0);
    // One that hands it to policy leaves it as it is.
    const policy = await w.rt.startRun({ pkg: w.pkg, workflow: "Opening", runId: "policy", input: c, authorize: { "git.open_pr": { by: "policy" } } });
    expect(policy.state).toBe("waiting");
  });

  it("starts with the configuration's site counted when asks leaves room for it, and asks the code owner for it", async () => {
    const pr = new SimTool("git.open_pr");
    const w = await aworld(OPENING.replace("asks: 2", "asks: 3"), { tools: [pr] });
    const authorize = { "git.open_pr": { by: "human" as const, role: "code_owner" } };
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Opening", runId: "r", input: { c: { files: ["a.ts"] } }, authorize });
    expect(r.state, state(r)).toBe("waiting");
    expect(await asksRow(w, "r")).toEqual({ limit: 3, settled: 1, reserved: 2 });
    const opened = await eventsOf(w, "r", "wait_opened");
    expect(opened[0]).toMatchObject({ command: "/defs/Opening/body/1/value/authorize", site: { kind: "effect", path: "/defs/Opening/body/1/value", wait: "/defs/Opening/body/1/value/authorize" } });
    const done = await drive(w, "r");
    expect(done.state, state(done)).toBe("succeeded");
    expect(await asksRow(w, "r")).toEqual({ limit: 3, settled: 2, reserved: 1 });
  });
});

// ── counting ────────────────────────────────────────────────────────────

describe("counting", () => {
  it("counts each question once when its wait opens: a resume counts nothing again, a replay nothing at all", async () => {
    const w = await aworld(ASKS_MDT, { fails: true });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Asking", runId: "c", input: { note: "long note" } });
    expect(r.state).toBe("waiting");
    expect((await asksRow(w, "c"))!.settled).toBe(1);
    // Resumed while it waits: the wait is found, and nothing is counted.
    await w.rt.resume("c");
    await w.rt.resume("c");
    expect((await asksRow(w, "c"))!.settled).toBe(1);
    // ask, escalate, pause, then the delegation fails and is escalated: retried four times, the fifth lets it stand.
    let run = await drive(w, "c", 3);
    for (let i = 0; i < SUPERVISE_ESCALATIONS; i++) run = await answer(w, "c", i < SUPERVISE_ESCALATIONS - 1 ? "retry" : "fail");
    expect(run.state, state(run)).toBe("failed");
    const settled = (await asksRow(w, "c"))!.settled;
    expect(settled).toBe(3 + SUPERVISE_ESCALATIONS);
    const events = await w.rt.journal.events("c");
    const replay = await w.rt.replayRun("c");
    expect(replay.status).toBe("failed");
    expect(await w.rt.journal.events("c")).toEqual(events);
    expect((await asksRow(w, "c"))!.settled).toBe(settled);
    // Each wait is tagged with its static site: an escalation of an attempt (`#k`) with the delegation's.
    const tags = (await eventsOf(w, "c", "wait_opened")).map((d) => [d["command"], (d["site"] as Obj)["kind"], (d["site"] as Obj)["wait"]]);
    expect(tags.slice(0, 5)).toEqual([
      ["/defs/Asking/body/1/value", "ask", "/defs/Asking/body/1/value"],
      ["/defs/Asking/body/2/value", "escalate", "/defs/Asking/body/2/value"],
      ["/defs/Asking/body/4/value", "pause", "/defs/Asking/body/4/value"],
      ["/defs/Asking/body/5/value/escalate", "supervise_escalate", "/defs/Asking/body/5/value/escalate"],
      ["/defs/Asking/body/5/value#1/escalate", "supervise_escalate", "/defs/Asking/body/5/value/escalate"],
    ]);
  });

  it("tags a function's question with its definition's site, and a contract's approvals under their verify", async () => {
    const w = await aworld();
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Approving", runId: "a", input: { n: { text: "x" } } });
    expect(r.state, state(r)).toBe("waiting");
    const done = await drive(w, "a");
    expect(done.state, state(done)).toBe("succeeded");
    const tags = (await eventsOf(w, "a", "wait_opened")).map((d) => [d["command"], (d["site"] as Obj)["kind"], (d["site"] as Obj)["wait"]]);
    expect(tags).toEqual([
      ["/defs/Approving/body/1/value>confirm/body/0/value", "ask", "/defs/confirm/body/0/value"],
      ["/defs/Approving/body/2/value>confirm/body/0/value", "ask", "/defs/confirm/body/0/value"],
      ["/defs/Approving/body/3/body@0/0/value", "ask", "/defs/Approving/body/3/body/0/value"],
      ["/defs/Approving/body/3/body@1/0/value", "ask", "/defs/Approving/body/3/body/0/value"],
      ["/defs/Approving/body/4/value/contract/accept/both/all/0/call", "verify", "/defs/Approving/body/4/value/contract/accept/both/all/0/call"],
      ["/defs/Approving/body/4/value/contract/accept/both/all/1/call", "verify", "/defs/Approving/body/4/value/contract/accept/both/all/1/call"],
      ["/defs/Approving/body/4/value/contract/accept/checked/call", "verify", "/defs/Approving/body/4/value/contract/accept/checked/call"],
      ["/defs/Approving/body/4/value/contract/invariant/kept/call", "verify", "/defs/Approving/body/4/value/contract/invariant/kept/call"],
    ]);
    expect(await asksRow(w, "a")).toEqual({ limit: 8, settled: 8, reserved: 0 });
  });

  it("does not count the questions of the on budget_exceeded handler, which come again in each episode (D7)", async () => {
    const w = await aworld();
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Handling", runId: "h", input: { note: "x" }, limits: { steps: 0 } });
    expect(r.state, state(r)).toBe("waiting");
    expect((r.waiting as Obj)["kind"]).toBe("budget_exceeded");
    const opened = await eventsOf(w, "h", "wait_opened");
    // `pause and human.ask(…)` is a pause whose `then` asks: the handler's question, in episode 0.
    expect(opened.map((d) => [d["command"], d["site"]])).toEqual([["/defs/Handling/on/0@0/then/then", { kind: "ask", path: "/defs/Handling/on/0/then/then", wait: "/defs/Handling/on/0/then/then", only: "budget_exceeded" }]]);
    expect(await asksRow(w, "h")).toEqual({ limit: 1, settled: 0, reserved: 1 });
  });
});

// ── the role of an approval (D2) ────────────────────────────────────────

describe("the role an approval asks is the one the program names (D2)", () => {
  it("asks the role definition a contract's parameter of the same name shadows, in a contract of an imported module of 0.6", async () => {
    const lib = load(LIB_06, "mdt").program!;
    const lock = { ...(LOCK as object), modules: { "example.lib": hashOf(lib) } } as never;
    const w = await world(IMP_07, { lock, modules: { "example.lib": lib }, decisions: { keys: new TrustedKeys([ana.publicKey]) } });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "W", runId: "d2", input: { n: { text: "x" } } });
    expect(r.state, state(r)).toBe("waiting");
    const opened = await eventsOf(w, "d2", "wait_opened");
    expect((opened[0]!["request"] as Obj)["role"]).toBe("accountant");
  });
});

/** The reviewer's probe pair (D2): a 0.6 module whose contract's parameter has a role's name, and a 0.7 program that verifies against it. */
const LIB_06 = `mandate @ 0.6

module example.lib @ 0.1

use std.{human}

pub role accountant "Accountant"

pub type Note = { text: Text }

/// The role that approves is named by a parameter of a role's name.
pub contract C(n: Note, accountant: Text) {
  accept ok "approved" by human.approve(role: accountant)
}
`;

const IMP_07 = `mandate @ 0.7

module example.probe.imp @ 0.1

use std.{human, model}
use example.lib.{C, Note, accountant}

role finance_lead "Finance lead"

capability ModelStd = model.infer(tier: standard, max_class: internal)

workflow W(n: Note) -> Verified<Note, C>
  caps   ModelStd
  budget { steps: 2 }
{
  verify n against C(n, "finance_lead")
}
`;

function hashOf(p: Program): string {
  return hashProgram(p as unknown as Json).program;
}

// ── raise-limits and --limit asks=N ─────────────────────────────────────

describe("raise-limits and --limit asks=N", () => {
  it("reads asks=N as a whole number of questions, beside the other limits, and refuses anything else", () => {
    expect(limits("asks=2")).toEqual({ asks: 2 });
    expect(limits("spend=20USD,asks=0,steps=4")).toEqual({ spend: { micros: 20_000_000, currency: "USD" }, asks: 0, steps: 4 });
    expect(() => limits("asks=1.5")).toThrow("cannot read the limit asks=1.5; asks is a whole number of questions, e.g. asks=2");
    expect(() => limits("asks=2USD")).toThrow("asks is a whole number of questions");
    expect(() => limits("asks=x")).toThrow("cannot read the limit asks=x");
    expect(() => limits("questions=2")).toThrow("unknown limit questions; use spend, tokens, steps, agents or asks");
  });

  it("raises a run's asks up to the declared value and no further, and a run with none has nothing to raise", async () => {
    const w = await aworld(ASKS_MDT, { fails: true });
    // The caller limits Handling to 1 of its 1; Asking is limited by its own 9.
    await w.rt.startRun({ pkg: w.pkg, workflow: "Asking", runId: "r", input: { note: "long note" } });
    const run = await w.rt.getRun("r");
    await expect(w.rt.raiseLimits("r", msg(), { limits: { asks: 10 }, signed: signDecision(ana, { package: run.package_hash, run: "r", revision: run.revision, subject: run.package_hash }, { kind: "raise_limits", member: "ana", payload: payloadOf.limits({ asks: 10 }), at: new Date(w.adapters.clock.now()) }) })).rejects.toThrow(/Asking declares asks: 9; raising the run to 10 needs a new program version/);
    const v = await aworld();
    const free = await v.rt.startRun({ pkg: v.pkg, workflow: "Endless", runId: "free", input: { note: "x" } });
    expect(free.state).toBe("waiting");
    const f = await v.rt.getRun("free");
    await expect(v.rt.raiseLimits("free", msg(), { limits: { asks: 1 }, signed: signDecision(ana, { package: f.package_hash, run: "free", revision: f.revision, subject: f.package_hash }, { kind: "raise_limits", member: "ana", payload: payloadOf.limits({ asks: 1 }), at: new Date(v.adapters.clock.now()) }) })).rejects.toMatchObject({ code: "not_a_raise" });
  });

  it("raises a caller's limit below the declared value up to it", async () => {
    const src = ASKS_MDT.replace("budget { steps: 8, asks: 9 }", "budget { steps: 8, asks: 12 }");
    const w = await aworld(src, { fails: true });
    await w.rt.startRun({ pkg: w.pkg, workflow: "Asking", runId: "low", input: { note: "long note" }, limits: { asks: 9 } });
    const run = await w.rt.getRun("low");
    const raised = await w.rt.raiseLimits("low", msg(), { limits: { asks: 12 }, signed: signDecision(ana, { package: run.package_hash, run: "low", revision: run.revision, subject: run.package_hash }, { kind: "raise_limits", member: "ana", payload: payloadOf.limits({ asks: 12 }), at: new Date(w.adapters.clock.now()) }) });
    expect(raised.state).toBe("waiting");
    expect((await asksRow(w, "low"))!.limit).toBe(12);
    expect((await eventsOf(w, "low", "limits_raised"))[0]).toMatchObject({ from: { asks: 9 }, to: { asks: 12 } });
  });
});
