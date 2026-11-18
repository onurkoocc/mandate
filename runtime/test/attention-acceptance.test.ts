// The acceptance rehearsal of 0.7 (spec/attention.md "Acceptance"; slice B10): the acceptance table of the plan, a case
// per row, over fixtures/attention/invoices.mdt as a deployment holds it.
//
// One story carries the rows that follow each other: an authoring agent drafts the workflow with `asks: 1` over the
// MCP server, live, is told E1906, patches the budget and reads the card and the attention view (the answers are the
// recorded conversation's, byte for byte); a run before the card is approved is refused; the accountant approves the
// card; a design run, a promotion, a read_only run, a promotion with its shadow diff, a live run whose review the
// accountant answers with `mandate decide`; what the persons were shown (`mandate waits`, `mandate watch`, the pages)
// and what the notification sink holds; and the replay of each run. Short cases beside it hold the refusals and the
// escalations.
//
// The persons' side is the command line itself (`main` of src/cli.ts, in this process), over the world's database and
// its simulators: `vi.mock` of src/control.js hands every command the world's database (PGlite here, or the
// PostgreSQL server of MANDATE_TEST_DATABASE_URL) and the world's adapters (the SimClock, the matcher, the simulated
// mailbox and ERP), and keeps the rest of the configuration's reading as it is (its stores, its decision keys, its
// notifications). Keys are made at run time with `mandate key new`. Nothing waits on real time: a deadline passes on
// the SimClock, and `mandate tick` is given the SimClock's time for `Date.now`.
//
// With B10_ARTIFACTS set to a directory, the live run's page for the accountant and the notification sink are saved
// there as they are, for the pull request. The rows "mutation per rule" and "0.1–0.6 unchanged" are held elsewhere.

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attentionFacts, classRank, hashProgram, load, type AttentionFacts, type AttentionFactsInput, type DataClass, type Json } from "@mandate/bridge";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Adapters } from "../src/adapters.js";
import { eventClass } from "../src/classes.js";
import { readConfig, runtimeOptions } from "../src/control.js";
import type { Db } from "../src/db.js";
import { promotionSubject, readDecisionKey, signDecision } from "../src/decisions.js";
import { NOTIFICATION_FORMAT, NOTIFICATION_MEMBERS, NOTIFIED } from "../src/notify.js";
import { Runtime } from "../src/runtime.js";
import { digest, isObj, type Obj, type Value } from "../src/values.js";
import { runView, shadowDiff } from "../src/views.js";
import { ACME, ALL, DAY, deploymentLock, FIXTURE_LOCK, invoiceNo, libraryDir, mandate, McpSession, matcher, OBSERVER_SOURCE, PASSED, personKey, samples, simulators, SOURCE, TOTALS, VENDOR, type PersonKey, type Said, type Simulators } from "./attention-world.js";
import { closeAll, world, type World } from "./helpers.js";

// Every command's database and adapters are the world's (see the header); the rest of src/control.js is its own.
const held = vi.hoisted(() => ({ db: undefined as unknown, adapters: undefined as unknown }));
vi.mock("../src/control.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/control.js")>();
  const adapters = (): Adapters => held.adapters as Adapters;
  return {
    ...real,
    // The command closes its database when it ends; the world's stays open for the next command.
    connect: async () => new Proxy(held.db as Db, { get: (t, k) => (k === "close" ? async () => undefined : Reflect.get(t, k)) }),
    adaptersFor: adapters,
    operatorAdapters: adapters,
    replayAdapters: adapters,
  };
});

afterAll(closeAll);

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const AUTHORING = JSON.parse(read("vectors/mcp/authoring-0.7.json")) as { input: Part[]; output: Array<string | { sha256: string; bytes: number }>; language: string };
const hashOf = (text: string): string => hashProgram(load(text, "mdt").program as unknown as Json).program;
const WORKFLOW = "MatchInvoices";
/** The data class each role of the fixture's lock may be shown; `observer`, of the variant, `public`. */
const CAPS: Record<string, DataClass> = { ...(FIXTURE_LOCK["role_classes"] as Record<string, DataClass>), observer: "public" };
const keep = process.env["B10_ARTIFACTS"];
const LONG = { timeout: 240_000 };

/** A deployment: its directory, its configuration, the persons' keys, the world it runs over, and a runtime of the configuration's own stores. */
interface Deployment {
  dir: string;
  config: string;
  program: string;
  lock: string;
  sims: Simulators;
  keys: Record<string, PersonKey>;
  w: World;
  rt: Runtime;
  sink: string;
  /** One command, with `--config`; `input` is what the person types. */
  cli(args: string[], input?: string[]): Promise<Said>;
  /** `mandate run` of the deployment's program. */
  run(runId: string, mode: string, extra?: string[]): Promise<Said>;
  /** `mandate tick`, its `Date.now` the SimClock's. */
  tick(): Promise<Said>;
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * A deployment of the fixture: the program and its lock as files (the lock with the persons' keys and the tools'
 * digests), the library in a directory, a configuration with signed decisions, the members' public keys and a file
 * sink for the notifications of both roles, and a world over the shared database with the simulators.
 */
async function deploy(o: { observer?: boolean } = {}): Promise<Deployment> {
  const dir = mkdtempSync(join(tmpdir(), "mandate-b10-"));
  dirs.push(dir);
  const config = join(dir, "mandate.runtime.json");
  writeFileSync(
    config,
    JSON.stringify({
      // Never opened: every command is handed the world's database (vi.mock above).
      database: "pglite:unused",
      decisions: { keys: "decision-keys", mode: "signed" },
      libraries: { dir: "libraries" },
      notifications: {
        channels: { sink: { file: "out/notifications.jsonl" } },
        roles: { accountant: { channels: ["sink"], outcomes: true }, finance_lead: { channels: ["sink"], outcomes: false } },
      },
    }),
  );
  libraryDir(join(dir, "libraries"));
  const keys: Record<string, PersonKey> = {};
  for (const m of o.observer ? ["ana", "ben", "cy"] : ["ana", "ben"]) keys[m] = await personKey(config, join(dir, "home", m), m, join(dir, "decision-keys"));
  const sims = simulators();
  const lockValue = await deploymentLock(sims, Object.fromEntries(Object.entries(keys).map(([m, k]) => [m, k.id])), o);
  const source = o.observer ? OBSERVER_SOURCE : SOURCE;
  const program = join(dir, "invoices.mdt");
  const lock = join(dir, "invoices.lock.json");
  writeFileSync(program, source);
  writeFileSync(lock, JSON.stringify(lockValue, null, 2));
  // The package carries the lock without its format, as the command line's reading of the file gives it.
  const { lock: _format, ...packaged } = lockValue as unknown as Obj;
  const w = await world(source, { libraries: [ACME], lock: packaged as never, agents: matcher() });
  w.adapters.connectors = sims.transport as never;
  w.adapters.samples = samples() as never;
  held.db = w.db;
  held.adapters = w.adapters;
  const rt = new Runtime(w.db, w.adapters, undefined, undefined, runtimeOptions(readConfig(config), w.db));
  const cli = (args: string[], input?: string[]): Promise<Said> => mandate(config, args, input);
  return {
    dir,
    config,
    program,
    lock,
    sims,
    keys,
    w,
    rt,
    sink: join(dir, "out", "notifications.jsonl"),
    cli,
    run: (runId, mode, extra = []) => cli(["run", program, "--workflow", WORKFLOW, "--input", "{}", "--run-id", runId, "--lock", lock, "--mode", mode, ...extra]),
    tick: async () => {
      // The driver loop asks `Date.now` which waits are due (src/tick.ts): here it is the SimClock's time.
      const realNow = Date.now.bind(Date);
      const t0 = realNow();
      const spy = vi.spyOn(Date, "now").mockImplementation(() => w.clock.now() + (realNow() - t0));
      try {
        return await cli(["tick"]);
      } finally {
        spy.mockRestore();
      }
    },
  };
}

/** The state `mandate run` or `mandate decide` printed for a run. */
function stateIn(said: Said, runId: string): string {
  expect(said.code, said.err).toBe(0);
  const m = new RegExp(`^run ${runId}  ${WORKFLOW}  (\\w+)  revision \\d+$`, "m").exec(said.out) ?? new RegExp(`run ${runId} is now (\\w+), revision`).exec(said.out);
  expect(m, said.out).not.toBeNull();
  return m![1]!;
}

/** `mandate decide` by `member`: the only open decision, its items waived and declined as `line` says, then signed. */
async function decide(d: Deployment, member: string, line: string): Promise<Said> {
  return d.cli(["decide", "--key", d.keys[member]!.file], ["1", line, "y"]);
}

/** The events of a run as `mandate watch <run> --role R --jsonl` prints them. */
async function watched(d: Deployment, runId: string, role: string): Promise<Obj[]> {
  const said = await d.cli(["watch", runId, "--role", role, "--jsonl"]);
  expect(said.code, said.err).toBe(0);
  return said.out.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Obj);
}

/** The notification sink's lines. */
function notifications(d: Deployment): Obj[] {
  if (!existsSync(d.sink)) return [];
  return readFileSync(d.sink, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Obj);
}

/** Every number in `v`, at any depth. */
function numbersIn(v: unknown): number[] {
  if (typeof v === "number") return [v];
  if (Array.isArray(v)) return v.flatMap(numbersIn);
  return isObj(v as Value) ? Object.values(v as Obj).flatMap(numbersIn) : [];
}

/** Every labelled value (`{ masked, class, known }`) in `v`, with where it stands. */
function labelled(v: unknown, at = ""): Array<{ at: string; shown: Obj }> {
  if (Array.isArray(v)) return v.flatMap((x, i) => labelled(x, `${at}/${i}`));
  if (!isObj(v as Value)) return [];
  const o = v as Obj;
  if (typeof o["masked"] === "boolean") return [{ at, shown: o }];
  return Object.entries(o).flatMap(([k, x]) => labelled(x, `${at}/${k}`));
}

/**
 * What a role's stream may hold (spec/attention.md "What a person sees"): events of S0 to S2 only, and every value of
 * what a person is asked or reported (a wait's request, a report's fields) labelled with its class and how it is
 * known, shown only when its class is at most the role's cap.
 */
function heldToRole(events: Obj[], role: string): number {
  expect(events.length).toBeGreaterThan(0);
  for (const e of events) {
    const type = String(e["type"]);
    expect(["S0", "S1", "S2"], type).toContain(e["class"]);
    expect(["S0", "S1", "S2"], type).toContain(eventClass(type));
  }
  const values = events.filter((e) => e["type"] === "wait_opened" || e["type"] === "report").flatMap((e) => labelled((e["data"] as Obj | undefined) ?? {}, `${String(e["seq"])}:${String(e["type"])}`));
  capped(values, role);
  return values.length;
}

/** Each value carries its class and how it is known, and is shown only when its class is at most the role's cap. */
function capped(values: Array<{ at: string; shown: Obj }>, role: string): void {
  for (const { at, shown } of values) {
    expect(typeof shown["class"], at).toBe("string");
    expect(typeof shown["known"], at).toBe("string");
    if (shown["masked"] === false) expect(classRank(shown["class"] as DataClass), `${at} shown to ${role}`).toBeLessThanOrEqual(classRank(CAPS[role]!));
  }
}

type Part = { line?: string; text?: string; hex?: string; repeat?: string; count?: number };
/** The bytes of a recorded conversation's input, as bridge/test/mcp-replay.test.ts reads them. */
function bytesOf(parts: Part[]): string {
  return Buffer.concat(parts.map((p) => (p.line !== undefined ? Buffer.from(`${p.line}\n`, "utf8") : p.text !== undefined ? Buffer.from(p.text, "utf8") : p.hex !== undefined ? Buffer.from(p.hex, "hex") : Buffer.from(p.repeat!.repeat(p.count!), "utf8")))).toString("utf8");
}

/** One answer of the recorded conversation: the line itself, or the digest and length of a long one. */
function recorded(got: string, want: string | { sha256: string; bytes: number }): boolean {
  if (typeof want === "string") return got === want;
  return Buffer.byteLength(got, "utf8") === want.bytes && `sha256:${createHash("sha256").update(got, "utf8").digest("hex")}` === want.sha256;
}

/** The facts as the compiler gives them, with the run's question total said to be `total` (asks.test.ts). */
function understated(total: number): (i: AttentionFactsInput) => AttentionFacts | null {
  return (i) => {
    const f = attentionFacts(i)!;
    return { ...f, totals: { ...f.totals!, questions: total }, effects: (f.effects ?? []).map((e) => ({ ...e, multiplicity: 0 })) };
  };
}

/** The accountant's card approval, by the command line. */
async function approved(d: Deployment): Promise<string> {
  const said = await d.cli(["approve-envelope", d.program, "--key", d.keys["ana"]!.file, "--lock", d.lock]);
  expect(said.code, said.err).toBe(0);
  expect(said.out).toContain("approved by ana as accountant");
  return /^package {2}(sha256:[0-9a-f]{64})$/m.exec(said.out)![1]!;
}

/** The waits of a role's member, as `mandate waits --member M --json` lists them. */
async function waitsOf(d: Deployment, member: string): Promise<Obj[]> {
  const said = await d.cli(["waits", "--member", member, "--json"]);
  expect(said.code, said.err).toBe(0);
  const v = JSON.parse(said.out) as Obj | Obj[];
  return Array.isArray(v) ? v : ((v["waits"] ?? []) as Obj[]);
}

describe("the acceptance of 0.7, row by row", () => {
  it("authoring agent builds the workflow; the accountant approves its card; design, read_only and live; a person sees S0 to S2 only; notifications S0 and S1; replay", LONG, async () => {
    const d = await deploy();

    // ── Authoring agent builds the workflow: live over the MCP server, its answers the recorded conversation's.
    const mcp = new McpSession(AUTHORING.language);
    const draft = SOURCE.replace("asks: 2", "asks: 1");
    const args = (extra: Obj): Obj => ({ ...extra, lock: FIXTURE_LOCK, libraries: [ACME as unknown as Value] });
    await mcp.request("server/discover");
    const tools = (((await mcp.request("tools/list")).message["result"] as Obj)["tools"] as Obj[]).map((t) => t["name"]);
    expect(tools).toEqual(expect.arrayContaining(["mandate.check", "mandate.explain", "mandate.apply_patch", "mandate.project"]));
    const checked = await mcp.tool("mandate.check", args({ source: draft }));
    expect(checked.result["ok"]).toBe(false);
    // The agent reads the error the check gave, and what it says to change.
    const error = (checked.result["diagnostics"] as Obj[]).find((x) => x["severity"] === "error")!;
    expect(error["code"]).toBe("MDT-E1906");
    const explained = await mcp.tool("mandate.explain", { code: String(error["code"]).replace(/^MDT-/, "") });
    expect(explained.result["title"]).toBe("Attention above asks");
    const facts = error["facts"] as Obj;
    const patched = await mcp.tool("mandate.apply_patch", { source: draft, base: hashOf(draft), ops: [{ op: "replace", path: (error["at"] as Obj)["path"]!, value: facts["total"]! }], ...args({}) });
    expect(patched.result["ok"]).toBe(true);
    // The patch is the fixture: the program the deployment runs.
    expect(patched.result["hash"]).toBe(hashOf(SOURCE));
    const fixed = JSON.stringify(patched.result["program"]);
    const clean = await mcp.tool("mandate.check", args({ source: fixed, kind: "json" }));
    expect(clean.result["ok"]).toBe(true);
    expect((clean.result["diagnostics"] as Obj[]).filter((x) => x["severity"] === "error")).toEqual([]);
    const card = await mcp.tool("mandate.project", { ...args({ source: fixed, kind: "json" }), view: "card", workflow: WORKFLOW });
    const view = await mcp.tool("mandate.project", { ...args({ source: fixed, kind: "json" }), view: "attention", workflow: WORKFLOW });
    expect(card.result["package"]).toBe("sha256:1c66f5d7190e83df56f1501201bfe17a6b4f225af21b693c6d5ba466e24c387e");
    expect(view.result["kind"]).toBe("attention");
    // What the agent sent and what it was answered are the recorded conversation, byte for byte.
    expect(mcp.sent.map((l) => `${l}\n`).join("")).toBe(bytesOf(AUTHORING.input));
    expect(mcp.received.length).toBe(AUTHORING.output.length);
    mcp.received.forEach((got, i) => expect(recorded(got, AUTHORING.output[i]!), `answer ${i}: ${got.slice(0, 200)}`).toBe(true));
    // The card under the deployment's lock: the package the accountant signs for.
    const deployed = await mcp.tool("mandate.project", { source: fixed, kind: "json", view: "card", workflow: WORKFLOW, lock: JSON.parse(readFileSync(d.lock, "utf8")) as Value, libraries: [ACME as unknown as Value] });
    await mcp.close();
    expect(deployed.result["package"]).toBe(d.w.pkg.hash);

    // ── The person approves the card: without it, no run starts.
    const unapproved = await d.run("d0", "design");
    expect(unapproved.code).toBe(1);
    expect(unapproved.err).toContain("unapproved_envelope");
    expect(await approved(d)).toBe(deployed.result["package"]);

    // ── design → read_only → live.
    expect(stateIn(await d.run("d1", "design"), "d1")).toBe("waiting");
    expect(stateIn(await decide(d, "ana", `waive ${TOTALS[0]} decline ${TOTALS[1]}`), "d1")).toBe("succeeded");
    expect(d.sims.erp.drafts.size, "a design run writes nothing").toBe(0);
    for (const mode of ["read_only", "live"]) {
      const refused = await d.run(`u-${mode}`, mode);
      expect(refused.code, mode).toBe(1);
      expect(refused.err, mode).toContain("unpromoted");
    }
    const toReadOnly = await d.cli(["promote", "d1", "--to", "read_only", "--key", d.keys["ana"]!.file, "--yes"]);
    expect(toReadOnly.code, toReadOnly.err).toBe(0);
    expect(stateIn(await d.run("r1", "read_only"), "r1")).toBe("waiting");
    expect(stateIn(await decide(d, "ana", `waive ${TOTALS[0]} decline ${TOTALS[1]}`), "r1")).toBe("succeeded");
    expect(d.sims.erp.drafts.size, "a read_only run writes nothing").toBe(0);
    const liveRefused = await d.run("u-live2", "live");
    expect(liveRefused.err).toContain("unpromoted");

    // The live promotion signs the shadow diff's digest: the subject the runtime shows is computed from it, and one
    // signed on another diff is refused.
    const shown = await d.rt.promotionShown("r1", "live");
    const r1 = await d.rt.getRun("r1");
    const diff = await shadowDiff(d.rt, "d1", "r1");
    const subject = (shadow: string): string => promotionSubject({ package: shown.package, workflow: WORKFLOW, from: { run: "r1", mode: "read_only", manifest: r1.manifest_hash! }, to: "live", shadow });
    expect(shown.subject).toBe(subject(digest("request", diff as unknown as Value)));
    const ana = readDecisionKey(d.keys["ana"]!.file);
    const stale = signDecision(ana, { ...shown, subject: subject(digest("request", { ...diff, rows: [] } as unknown as Value)) }, { kind: "promote", member: "ana", payload: digest("request", { to: "live" }), at: new Date(d.w.clock.now()) });
    await expect(d.rt.promote(await d.rt.storedPackage(shown.package), stale)).rejects.toMatchObject({ code: "invalid_decision", reason: "subject_mismatch" });
    const toLive = await d.cli(["promote", "r1", "--to", "live", "--key", d.keys["ana"]!.file, "--yes"]);
    expect(toLive.code, toLive.err).toBe(0);
    expect(toLive.out).toContain("shadow diff against design run d1:");

    // ── The live run: the review is answered with `mandate decide`, from what the accountant is shown.
    expect(stateIn(await d.run("l1", "live"), "l1")).toBe("waiting");
    expect((await d.tick()).code).toBe(0);
    const waits = await d.cli(["waits", "--member", "ana"]);
    expect(waits.out).toContain("run l1  MatchInvoices");
    expect(waits.out).toContain(invoiceNo(TOTALS[0]!));
    const pages = join(d.dir, "pages");
    const wrote = await d.cli(["watch", "--member", "ana", "--out", pages]);
    expect(wrote.code, wrote.err).toBe(0);
    const page = readFileSync(join(pages, "l1.accountant.html"), "utf8");
    expect(page).not.toMatch(/<script|\son[a-z]+\s*=|javascript:|href=|src=/i);
    expect(page).toContain(invoiceNo(TOTALS[0]!));
    expect(stateIn(await decide(d, "ana", `waive ${TOTALS[0]} decline ${TOTALS[1]}`), "l1")).toBe("succeeded");
    expect((await d.tick()).code).toBe(0);
    // What was written: each invoice that passed, and the one the accountant waived; not the declined one, nor the other vendor's.
    expect([...d.sims.erp.drafts.keys()].sort()).toEqual([...PASSED, TOTALS[0]!].sort().map(invoiceNo));
    for (const i of [TOTALS[1]!, ...VENDOR]) expect(d.sims.erp.drafts.has(invoiceNo(i))).toBe(false);

    // ── `asks` bound: the questions the live run paid are at most the program's two, and each is a wait it opened.
    const asks = (await d.rt.budgetReport("l1")).dimensions.find((x) => x.dimension === "asks")!;
    expect(asks.limit).toBe(2);
    expect(asks.settled).toBeLessThanOrEqual(2);
    const opened = await d.w.db.query<{ n: unknown }>("select count(*) as n from events where run_id = $1 and type in ('wait_opened', 'review_escalated')", ["l1"]);
    expect(Number(opened[0]!.n)).toBe(asks.settled);

    // ── Finishes seeing only S0–S2: the roles' streams, their views, their waits.
    for (const role of ["accountant", "finance_lead"]) {
      const events = await watched(d, "l1", role);
      const values = heldToRole(events, role);
      // The accountant is asked and reported to: what they were shown is labelled, value by value.
      if (role === "accountant") expect(values).toBeGreaterThan(0);
      // The command prints the role's projection as the runtime gives it, every event of it.
      expect((await d.rt.watchRun("l1", { role }, { limit: 500 })).events.map((e) => e.seq)).toEqual(events.map((e) => e["seq"]));
      capped(labelled((await runView(d.rt, "l1", { role })).view), role);
    }
    const reports = (await watched(d, "l1", "accountant")).filter((e) => e["type"] === "report");
    expect(reports).toHaveLength(2);

    // ── Notifications only S0/S1: their types, their fields, and nothing a server returned.
    const sent = notifications(d);
    expect(sent.length).toBeGreaterThan(0);
    const returned = d.sims.returned();
    expect(returned.texts).toEqual(expect.arrayContaining(ALL.map(invoiceNo)));
    for (const n of sent) {
      expect(Object.keys(n)).toEqual([...NOTIFICATION_MEMBERS]);
      expect(n["format"]).toBe(NOTIFICATION_FORMAT);
      expect(Object.keys(NOTIFIED)).toContain(n["event"]);
      expect(["S0", "S1"]).toContain(n["class"]);
      const line = JSON.stringify(n);
      for (const t of returned.texts) expect(line.includes(t), `${t} in ${line}`).toBe(false);
      for (const x of numbersIn(n)) expect(returned.numbers, `${x} in ${line}`).not.toContain(x);
    }
    const events = new Set(sent.map((n) => `${String(n["run"])} ${String(n["event"])}`));
    expect(events).toContain("l1 review_requested");
    expect(events).toContain("l1 run_succeeded");

    // ── Replay gives the same result: the live run's, and the design run's. (A read_only run's replay stops at its
    // first write, which would apply and was never confirmed: interp.ts `prepareAction` replays a confirmed action only.)
    for (const runId of ["d1", "l1"]) {
      const run = await d.rt.getRun(runId);
      const said = await d.cli(["replay", runId, "--json"]);
      expect(said.code, said.err).toBe(0);
      expect(JSON.parse(said.out), runId).toEqual({ status: "complete", value: run.result });
      expect(await d.rt.replayRun(runId), runId).toEqual({ status: "complete", value: run.result });
    }

    if (keep) {
      mkdirSync(keep, { recursive: true });
      writeFileSync(join(keep, "b10-page.html"), page);
      writeFileSync(join(keep, "b10-notifications.jsonl"), readFileSync(d.sink, "utf8"));
    }
  });

  it("a role that is bound and never asked sees no value above its class, and no wait or report", LONG, async () => {
    const d = await deploy({ observer: true });
    await approved(d);
    expect(stateIn(await d.run("o1", "design"), "o1")).toBe("waiting");
    expect(await waitsOf(d, "cy")).toEqual([]);
    const events = await watched(d, "o1", "observer");
    heldToRole(events, "observer");
    for (const e of events) {
      expect(e["class"], String(e["type"])).not.toBe("S0");
      expect(e["type"]).not.toBe("report");
    }
    const view = (await runView(d.rt, "o1", { role: "observer" })).view as unknown as Obj;
    expect(view["waiting"]).toBeNull();
    capped(labelled(view), "observer");
    const pages = join(d.dir, "pages-cy");
    expect((await d.cli(["watch", "--member", "cy", "--out", pages])).code).toBe(0);
    const texts = [JSON.stringify(events), JSON.stringify(view), ...(existsSync(pages) ? readdirSync(pages).map((f) => readFileSync(join(pages, f), "utf8")) : [])];
    for (const t of texts) for (const i of ALL) expect(t.includes(invoiceNo(i)), `invoice ${i}`).toBe(false);
  });

  it("asks bound: a run whose limit is below the program's questions is refused at its start", LONG, async () => {
    const d = await deploy();
    await approved(d);
    const said = await d.run("a1", "design", ["--limit", "asks=1"]);
    expect(said.code).toBe(1);
    expect(said.err).toMatch(/attention_above_asks: The run can ask 2 questions under the runtime's configuration \(2 in the program, and 0 the configuration hands to a person\), above its asks limit of 1/);
    expect(Number((await d.w.db.query<{ n: unknown }>("select count(*) as n from runs where run_id = $1", ["a1"]))[0]!.n)).toBe(0);
  });

  it("asks bound: a question past the run's bound is not asked, and asks_exhausted is shown", LONG, async () => {
    const d = await deploy();
    await approved(d);
    d.rt.attentionFacts = understated(1);
    const run = await d.rt.startRun({ pkg: d.w.pkg, workflow: WORKFLOW, input: {}, runId: "x1", mode: "design" });
    expect(run.state).toBe("waiting");
    // The sink is in use from the first pass on: a channel that is new is told no history (src/notify.ts).
    expect((await d.tick()).code).toBe(0);
    d.w.clock.advance(DAY + 1);
    const after = await d.rt.tick("x1");
    const types = (await d.rt.journal.events("x1")).map((e) => e.type);
    expect(types).toContain("asks_exhausted");
    expect(types).not.toContain("review_escalated");
    expect(types).toContain("review_expired");
    expect(after.state).toBe("succeeded");
    const seen = await watched(d, "x1", "accountant");
    expect(seen.map((e) => e["type"]), JSON.stringify(seen)).toContain("asks_exhausted");
    expect((await d.tick()).code).toBe(0);
    expect(notifications(d).map((n) => n["event"])).toContain("asks_exhausted");
  });

  it("missed deadline escalates: a day passes, mandate tick escalates the review, and the finance lead decides", LONG, async () => {
    const d = await deploy();
    await approved(d);
    expect(stateIn(await d.run("e1", "design"), "e1")).toBe("waiting");
    d.w.clock.advance(DAY + 1);
    const ticked = await d.tick();
    expect(ticked.out).toContain("run e1: waiting -> waiting");
    const types = (await d.rt.journal.events("e1")).map((e) => e.type);
    expect(types).toContain("review_escalated");
    expect(await waitsOf(d, "ana")).toEqual([]);
    expect(await waitsOf(d, "ben")).toHaveLength(1);
    expect(stateIn(await decide(d, "ben", `waive ${TOTALS[0]} decline ${TOTALS[1]}`), "e1")).toBe("succeeded");
    expect((await d.tick()).code).toBe(0);
    expect(notifications(d).map((n) => `${String(n["event"])} ${String(n["role"])}`)).toContain("review_escalated finance_lead");
  });

  it("missed deadline escalates: when both deadlines pass, nobody's open items are declined and the run goes on with what was accepted", LONG, async () => {
    const d = await deploy();
    await approved(d);
    expect(stateIn(await d.run("e2", "design"), "e2")).toBe("waiting");
    d.w.clock.advance(DAY + 1);
    expect((await d.tick()).code).toBe(0);
    d.w.clock.advance(DAY + 1);
    expect((await d.tick()).code).toBe(0);
    const run = await d.rt.getRun("e2");
    expect(run.state).toBe("succeeded");
    const types = (await d.rt.journal.events("e2")).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(["review_escalated", "review_expired"]));
    expect(await d.rt.replayRun("e2")).toEqual({ status: "complete", value: run.result });
  });
});
