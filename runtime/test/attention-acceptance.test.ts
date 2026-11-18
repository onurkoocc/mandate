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
import { readConfig, runtimeOptions } from "../src/control.js";
import type { Db } from "../src/db.js";
import { promotionSubject, readDecisionKey, signDecision } from "../src/decisions.js";
import { Runtime } from "../src/runtime.js";
import { digest, isObj, type Obj, type Value } from "../src/values.js";
import { runView, shadowDiff } from "../src/views.js";
import { ACME, ALL, book, DAY, deploymentLock, FIXTURE_LOCK, invoice, invoiceNo, libraryDir, mandate, McpSession, matcher, OBSERVER_SOURCE, order, PASSED, personKey, samples, simulators, SOURCE, TOTALS, VENDOR, type PersonKey, type Said, type Simulators } from "./attention-world.js";
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
/** The data class each role may be shown: the fixture's lock (fixtures/attention/invoices.lock.json) and `observer`, of the variant. */
const CAPS: Record<string, DataClass> = { accountant: "confidential", finance_lead: "confidential", observer: "public" };
const keep = process.env["B10_ARTIFACTS"];

// What the spec says, copied here as literals so that no check below compares the runtime with itself; the first case
// reads the three tables out of the spec and finds them equal to these.
/** The class of every event type: spec/boundary.md "Events", the table after "The class of every event type the runtime writes". */
const SPEC_CLASSES: Record<string, string[]> = {
  S0: ["wait_opened", "wait_expired", "decision_received", "input_received", "decision_refused", "criterion_approved", "criterion_denied", "governance_approved", "governance_denied", "action_authorized", "envelope_approved", "amendment_requested", "package_amended", "limits_raised", "reconcile_requested", "review_requested", "review_decided", "review_escalated", "review_expired", "criterion_waived", "promotion_accepted"],
  S1: ["run_succeeded", "run_failed", "run_cancelled", "run_cancelling", "run_attention_required", "cancel_requested", "lease_revoked", "violation", "budget_exceeded", "guarantee_lowered", "asks_exhausted"],
  S2: ["run_accepted", "run_running", "run_waiting", "lease_acquired", "command_dispatched", "command_completed", "command_throttled", "charge_pending", "charge_settled", "map_started", "map_ended", "stage_started", "stage_ended", "report", "program_started", "program_ended"],
  S3: ["action_prepared", "action_committed", "action_confirmed", "action_rejected", "action_unknown_outcome", "action_cancelled", "action_would_apply", "changeset_prepared", "changeset_would_apply", "changeset_simulated", "changeset_committed", "changeset_partial", "changeset_failed"],
  S4: ["program_submitted", "program_refused", "program_admitted", "sandbox_stopped"],
};
const CLASS_OF: Record<string, string> = Object.fromEntries(Object.entries(SPEC_CLASSES).flatMap(([c, types]) => types.map((t) => [t, c])));
/** The events notified, by class: spec/attention.md "Notifications", "What is sent". Nothing of S2 to S4. */
const SPEC_NOTIFIED: Record<string, string[]> = {
  S0: ["wait_opened", "review_requested", "review_escalated", "amendment_requested"],
  S1: ["run_succeeded", "run_failed", "run_cancelled", "run_attention_required", "budget_exceeded", "asks_exhausted"],
};
/** A notification's members, in order: spec/attention.md "Notifications", the payload's `interface Notification`. */
const SPEC_MEMBERS = ["format", "id", "kind", "event", "class", "tenant", "run", "workflow", "package", "seq", "at", "role", "command", "deadline", "as_of", "link"];
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
  cli(args: string[], input?: Typed): Promise<Said>;
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
  const cli = (args: string[], input?: Typed): Promise<Said> => mandate(config, args, input);
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

/** What a person types, a line per prompt (`mandate` in attention-world.ts). */
type Typed = Array<string | ((printed: string) => string)>;

/** An open item of a review as `mandate decide` printed it: its index, what it failed, and the invoice and order total its value shows. */
interface Read {
  index: number;
  unmet: string;
  invoice: string | undefined;
  order: number | undefined;
}

/** The open items `mandate decide` printed (person.ts `openItemLines`): each `item N: unmet …` line and its value line. */
function itemsIn(printed: string): Read[] {
  const out: Read[] = [];
  const lines = printed.split("\n");
  lines.forEach((l, k) => {
    const m = /^ {2}item (\d+): unmet (.*)$/.exec(l);
    if (!m) return;
    const value = /^ {4}value: (.*) {2}\[class /.exec(lines[k + 1] ?? "")?.[1] ?? "";
    out.push({ index: Number(m[1]), unmet: m[2]!, invoice: /"invoice_no":"([^"]+)"/.exec(value)?.[1], order: Number(/"total_cents":(\d+)/.exec(value)?.[1] ?? Number.NaN) || undefined });
  });
  return out;
}

/**
 * The scripted person's answer to a review: they read the open items `mandate decide` shows, each a match of an
 * invoice to an order, and hold each against the invoice in their mailbox. They waive the first item that failed
 * `totals` and whose order total shown differs from the invoice's (the gap they know of), and decline every other
 * open item. `chosen` gets what they read.
 */
function person(chosen: Read[]): (printed: string) => string {
  const mailbox = new Map(ALL.map(invoice).map((v) => [v["invoice_no"], v["total_cents"]]));
  return (printed) => {
    const items = itemsIn(printed);
    chosen.push(...items);
    const differ = items.filter((i) => i.unmet.startsWith("totals ") && i.order !== undefined && mailbox.get(i.invoice) !== undefined && mailbox.get(i.invoice) !== i.order);
    const waived = differ[0]?.index;
    const declined = items.map((i) => i.index).filter((i) => i !== waived);
    return `waive ${String(waived)}${declined.length ? ` decline ${declined.join(" ")}` : ""}`;
  };
}

/**
 * `mandate decide` by `member`: the only open decision, answered by the scripted person from what the command showed,
 * then signed. What they read gives them TOTALS, each with its invoice and its order's total; they waive TOTALS[0].
 */
async function decide(d: Deployment, member: string): Promise<Said> {
  const chosen: Read[] = [];
  const said = await d.cli(["decide", "--key", d.keys[member]!.file], ["1", person(chosen), "y"]);
  expect(chosen.map((i) => [i.index, i.invoice, i.order]), said.out).toEqual(TOTALS.map((i) => [i, invoiceNo(i), order(i)["total_cents"]]));
  expect(said.out).toContain(`waive ${TOTALS[0]!} decline ${TOTALS[1]!}`);
  return said;
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
    // The spec's class of the type, not the runtime's: a type of S3 or S4 given the class S2 is still refused here.
    expect(["S0", "S1", "S2"], `${type} in ${role}'s stream`).toContain(CLASS_OF[type]);
    expect(e["class"], type).toBe(CLASS_OF[type]);
  }
  for (const r of events.filter((e) => e["type"] === "report")) {
    // A report's fields: each one a labelled value, never a raw one.
    const fields = ((r["data"] as Obj | undefined)?.["fields"] ?? []) as Obj[];
    expect(fields.length, `report ${String(r["seq"])}`).toBeGreaterThan(0);
    for (const f of fields) {
      expect(typeof f["masked"], `report ${String(r["seq"])} field ${String(f["name"])}`).toBe("boolean");
      expect(typeof f["class"], `report ${String(r["seq"])} field ${String(f["name"])}`).toBe("string");
      expect(typeof f["known"], `report ${String(r["seq"])} field ${String(f["name"])}`).toBe("string");
    }
  }
  bare(events, `${role}'s stream`);
  const values = events.filter((e) => e["type"] === "wait_opened" || e["type"] === "report").flatMap((e) => labelled((e["data"] as Obj | undefined) ?? {}, `${String(e["seq"])}:${String(e["type"])}`));
  capped(values, role);
  return values.length;
}

/** Every text and number in `v` that no labelled value (`{ masked, class, known }`) wraps. */
function unwrapped(v: unknown, out: { texts: string[]; numbers: number[] } = { texts: [], numbers: [] }): { texts: string[]; numbers: number[] } {
  if (typeof v === "string") out.texts.push(v);
  else if (typeof v === "number") out.numbers.push(v);
  else if (Array.isArray(v)) v.forEach((x) => unwrapped(x, out));
  else if (isObj(v as Value) && typeof (v as Obj)["masked"] !== "boolean") Object.values(v as Obj).forEach((x) => unwrapped(x, out));
  return out;
}

/** No value of the book stands in `v` outside a labelled value: no invoice or order number, vendor, or total. */
function bare(v: unknown, where: string): void {
  const b = book();
  const { texts, numbers } = unwrapped(v);
  for (const t of texts) for (const x of b.texts) expect(t.includes(x), `${x} bare in ${where}: ${t.slice(0, 200)}`).toBe(false);
  for (const n of numbers) expect(b.numbers, `${n} bare in ${where}`).not.toContain(n);
}

/**
 * The notification sink, held to the spec: at least `min` lines, each with the payload's members in order, of an
 * event the spec notifies and of that event's class, and nothing of the book nor anything a server returned.
 */
function notifiedOnly(d: Deployment, min: number): Obj[] {
  const sent = notifications(d);
  expect(sent.length, JSON.stringify(sent)).toBeGreaterThanOrEqual(min);
  const returned = d.sims.returned();
  const b = book();
  for (const n of sent) {
    const line = JSON.stringify(n);
    expect(Object.keys(n), line).toEqual(SPEC_MEMBERS);
    expect(n["format"]).toBe("mandate/notification/0.1");
    const cls = Object.keys(SPEC_NOTIFIED).find((c) => SPEC_NOTIFIED[c]!.includes(String(n["event"])));
    expect(cls, `${String(n["event"])} notified`).toBeDefined();
    expect(n["class"], line).toBe(cls);
    expect(n["kind"], line).toBe(cls === "S0" ? "decision" : "outcome");
    for (const t of [...returned.texts, ...b.texts]) expect(line.includes(t), `${t} in ${line}`).toBe(false);
    for (const x of numbersIn(n)) expect([...returned.numbers, ...b.numbers], `${x} in ${line}`).not.toContain(x);
  }
  return sent;
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

/**
 * The accountant's card approval, by the command line; then a pass of `mandate tick`, so that the notification sink
 * is in use before the first run, and is told each run from its first event (a channel that is new is told no
 * history, src/notify.ts).
 */
async function approved(d: Deployment): Promise<string> {
  const said = await d.cli(["approve-envelope", d.program, "--key", d.keys["ana"]!.file, "--lock", d.lock]);
  expect(said.code, said.err).toBe(0);
  expect(said.out).toContain("approved by ana as accountant");
  expect((await d.tick()).code).toBe(0);
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

    // ── The person approves the card: without it, no run starts. The finance lead's signature is not the owner role's:
    // it is refused, and the run is still not started.
    const byBen = await d.cli(["approve-envelope", d.program, "--key", d.keys["ben"]!.file, "--lock", d.lock]);
    expect(byBen.code, byBen.out).toBe(1);
    expect(byBen.err).toContain("not_in_role");
    const unapproved = await d.run("d0", "design");
    expect(unapproved.code).toBe(1);
    expect(unapproved.err).toContain("unapproved_envelope");
    expect(await approved(d)).toBe(deployed.result["package"]);

    // ── design → read_only → live.
    expect(stateIn(await d.run("d1", "design"), "d1")).toBe("waiting");
    expect(stateIn(await decide(d, "ana"), "d1")).toBe("succeeded");
    expect(d.sims.erp.drafts.size, "a design run writes nothing").toBe(0);
    // A promotion is the owner role's: the finance lead's is refused, and stores nothing.
    const promotedByBen = await d.cli(["promote", "d1", "--to", "read_only", "--key", d.keys["ben"]!.file, "--yes"]);
    expect(promotedByBen.code, promotedByBen.out).toBe(1);
    expect(promotedByBen.err).toContain("not_in_role");
    expect(Number((await d.w.db.query<{ n: unknown }>("select count(*) as n from decisions where kind = 'promote'"))[0]!.n)).toBe(0);
    for (const mode of ["read_only", "live"]) {
      const refused = await d.run(`u-${mode}`, mode);
      expect(refused.code, mode).toBe(1);
      expect(refused.err, mode).toContain("unpromoted");
    }
    const toReadOnly = await d.cli(["promote", "d1", "--to", "read_only", "--key", d.keys["ana"]!.file, "--yes"]);
    expect(toReadOnly.code, toReadOnly.err).toBe(0);
    expect(stateIn(await d.run("r1", "read_only"), "r1")).toBe("waiting");
    expect(stateIn(await decide(d, "ana"), "r1")).toBe("succeeded");
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
    const answered = await decide(d, "ana");
    expect(stateIn(answered, "l1")).toBe("succeeded");
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
      const roleView = (await runView(d.rt, "l1", { role })).view;
      capped(labelled(roleView), role);
      bare(roleView, `${role}'s view`);
    }
    const reports = (await watched(d, "l1", "accountant")).filter((e) => e["type"] === "report");
    expect(reports).toHaveLength(2);

    // ── Notifications only S0/S1: their types, their fields, and nothing a server returned. The sink was in use before
    // the first run, so it was told every run from its first event: the outcome of each, and the live run's review
    // (the design and read_only runs' were answered before the pump reached them, and are passed over).
    const returned = d.sims.returned();
    expect(returned.texts).toEqual(expect.arrayContaining(ALL.map(invoiceNo)));
    const sent = notifiedOnly(d, 4);
    const events = new Set(sent.map((n) => `${String(n["run"])} ${String(n["event"])}`));
    for (const e of ["d1 run_succeeded", "r1 run_succeeded", "l1 review_requested", "l1 run_succeeded"]) expect(events).toContain(e);

    // ── Replay gives the same result: the live run's, and the design run's.
    for (const runId of ["d1", "l1"]) {
      const run = await d.rt.getRun(runId);
      const said = await d.cli(["replay", runId, "--json"]);
      expect(said.code, said.err).toBe(0);
      expect(JSON.parse(said.out), runId).toEqual({ status: "complete", value: run.result });
      expect(await d.rt.replayRun(runId), runId).toEqual({ status: "complete", value: run.result });
    }
    // A known limit, awaiting the owner's decision (pr-b10.md "Not in this slice"): the replay of a read_only run is
    // partial. Its writes would have applied and were never confirmed; in replay, interp.ts `prepareAction` takes only
    // a confirmed action, a changeset's members included, so the replay stops at the first one. Pinned as it is today.
    const r1Replay = await d.rt.replayRun("r1");
    expect(r1Replay).toEqual({ status: "partial", stoppedAt: "/defs/MatchInvoices/body/8/value[0]/body/0/value" });

    // ── The live promotion holds while its evidence does: once the read_only run's actions change, the shadow diff
    // the start computes again is another, and no live run starts (spec/attention.md "Promotion", "How the runtime
    // holds this").
    await d.w.db.query(`update actions set params = '{"changed": true}'::jsonb where run_id = $1`, ["r1"]);
    const l2 = await d.run("l2", "live");
    expect(l2.code, l2.out).toBe(1);
    expect(l2.err).toContain("unpromoted");
    expect(Number((await d.w.db.query<{ n: unknown }>("select count(*) as n from runs where run_id = $1", ["l2"]))[0]!.n)).toBe(0);

    if (keep) {
      mkdirSync(keep, { recursive: true });
      writeFileSync(join(keep, "b10-page.html"), page);
      writeFileSync(join(keep, "b10-notifications.jsonl"), readFileSync(d.sink, "utf8"));
    }
  });

  it("masking: a lock that caps an asked role below what it is shown is refused at load; a role that is bound and never asked is given nothing of the book; an asked role nothing above its cap", LONG, async () => {
    const d = await deploy({ observer: true });

    // The accountant capped at `internal`, below the confidential totals the review shows it: the package is refused
    // at load (E1909), before any run, command or call of a tool.
    const low = join(d.dir, "invoices.low.lock.json");
    const keyIds = Object.fromEntries(Object.entries(d.keys).map(([m, k]) => [m, k.id]));
    writeFileSync(low, JSON.stringify(await deploymentLock(d.sims, keyIds, { observer: true, classes: { accountant: "internal" } }), null, 2));
    for (const args of [["approve-envelope", d.program, "--key", d.keys["ana"]!.file, "--lock", low], ["run", d.program, "--workflow", WORKFLOW, "--input", "{}", "--run-id", "m0", "--lock", low, "--mode", "design"]]) {
      const refused = await d.cli(args);
      expect(refused.code, refused.out).toBe(1);
      expect(refused.err).toContain("load_verification_failed");
      expect(refused.err).toContain("MDT-E1909");
    }
    expect(await d.w.db.query("select run_id from runs where run_id = $1", ["m0"])).toEqual([]);
    expect(await d.w.db.query("select command_id from commands where run_id = $1", ["m0"])).toEqual([]);
    expect([d.sims.answered.length, d.sims.calls(d.sims.erp).length, d.sims.calls(d.sims.mailbox).length]).toEqual([0, 0, 0]);

    // The observer is bound and never asked: of the book, nothing reaches it on any path, while the run waits on the
    // accountant and once it has reported and ended.
    await approved(d);
    expect(stateIn(await d.run("o1", "design"), "o1")).toBe("waiting");
    const b = book();
    expect(b.texts.length).toBeGreaterThanOrEqual(3 * ALL.length);
    expect(b.numbers.length).toBeGreaterThanOrEqual(ALL.length);
    const observed = async (when: string): Promise<void> => {
      const events = await watched(d, "o1", "observer");
      heldToRole(events, "observer");
      for (const e of events) {
        expect(e["class"], String(e["type"])).not.toBe("S0");
        expect(e["type"]).not.toBe("report");
      }
      expect(await waitsOf(d, "cy")).toEqual([]);
      const view = (await runView(d.rt, "o1", { role: "observer" })).view as unknown as Obj;
      expect(view["waiting"]).toBeNull();
      capped(labelled(view), "observer");
      const pages = join(d.dir, `pages-cy-${when}`);
      expect((await d.cli(["watch", "--member", "cy", "--out", pages])).code).toBe(0);
      const got = [
        JSON.stringify(events),
        JSON.stringify(await d.rt.watchRun("o1", { role: "observer" }, { limit: 500 })),
        (await d.cli(["watch", "o1", "--role", "observer"])).out,
        (await d.cli(["waits", "--member", "cy"])).out,
        (await d.cli(["waits", "--member", "cy", "--json"])).out,
        JSON.stringify(view),
        ...(existsSync(pages) ? readdirSync(pages).map((f) => readFileSync(join(pages, f), "utf8")) : []),
      ];
      for (const t of got) {
        for (const x of b.texts) expect(t.includes(x), `${x} given to the observer (${when})`).toBe(false);
        for (const n of b.numbers) expect(new RegExp(`\\b${n}\\b`).test(t), `${n} given to the observer (${when})`).toBe(false);
      }
    };
    await observed("waiting");
    expect(stateIn(await decide(d, "ana"), "o1")).toBe("succeeded");
    await observed("ended");
    // The accountant, asked and reported to: every value it was shown labelled, none above its cap.
    expect(heldToRole(await watched(d, "o1", "accountant"), "accountant")).toBeGreaterThan(0);

    // Tampered facts, which no run under a lock has by itself: the stored facts of a run say its review shows `restricted` data, above the accountant's
    // cap (B3's facts door, as the asks case below uses it). The accountant is asked and shown every value masked,
    // labelled `restricted`, on its waits, its view and its stream; nothing of the book reaches it there.
    d.rt.attentionFacts = (i) => {
      const f = attentionFacts(i)!;
      return { ...f, questions: (f.questions ?? []).map((q) => ({ ...q, shown: "restricted" as DataClass })) };
    };
    expect((await d.rt.startRun({ pkg: d.w.pkg, workflow: WORKFLOW, input: {}, runId: "m1", mode: "design" })).state).toBe("waiting");
    const asked = (await waitsOf(d, "ana")).filter((w) => JSON.stringify(w).includes('"m1"'));
    expect(asked).toHaveLength(1);
    const streamed = await watched(d, "m1", "accountant");
    // (The run's reports keep their own fields' classes: only what the review shows is said to be restricted.)
    const anaView = (await runView(d.rt, "m1", { role: "accountant" })).view as unknown as Obj;
    capped(labelled(anaView), "accountant");
    const shownAna = [...labelled(asked), ...labelled(anaView["waiting"]), ...labelled(streamed.filter((e) => e["type"] === "wait_opened"))];
    expect(shownAna.length).toBeGreaterThan(0);
    capped(shownAna, "accountant");
    for (const { at, shown } of shownAna) expect([shown["masked"], shown["class"]], at).toEqual([true, "restricted"]);
    heldToRole(streamed, "accountant");
    for (const t of [JSON.stringify(asked), (await d.cli(["waits", "--member", "ana"])).out, JSON.stringify(streamed)]) {
      for (const x of b.texts) expect(t.includes(x), `${x} shown to the accountant above its cap`).toBe(false);
      for (const n of b.numbers) expect(new RegExp(`\\b${n}\\b`).test(t), `${n} shown to the accountant above its cap`).toBe(false);
    }
    await d.rt.cancelRun("m1");
  });

  it("asks bound: a run whose limit is below the program's questions is refused at its start", LONG, async () => {
    const d = await deploy();
    await approved(d);
    const said = await d.run("a1", "design", ["--limit", "asks=1"]);
    expect(said.code).toBe(1);
    expect(said.err).toMatch(/attention_above_asks: The run can ask 2 questions under the runtime's configuration \(2 in the program, and 0 the configuration hands to a person\), above its asks limit of 1/);
    expect(Number((await d.w.db.query<{ n: unknown }>("select count(*) as n from runs where run_id = $1", ["a1"]))[0]!.n)).toBe(0);
    expect((await d.tick()).code).toBe(0);
    expect(notifications(d).filter((n) => n["run"] === "a1")).toEqual([]);
  });

  it("asks bound: a question past the run's bound is not asked, and asks_exhausted is shown", LONG, async () => {
    const d = await deploy();
    await approved(d);
    d.rt.attentionFacts = understated(1);
    const run = await d.rt.startRun({ pkg: d.w.pkg, workflow: WORKFLOW, input: {}, runId: "x1", mode: "design" });
    expect(run.state).toBe("waiting");
    expect((await d.tick()).code).toBe(0);
    d.w.clock.advance(DAY + 1);
    const after = await d.rt.tick("x1");
    const types = (await d.rt.journal.events("x1")).map((e) => e.type);
    expect(types).toContain("asks_exhausted");
    expect(types).not.toContain("review_escalated");
    expect(types).toContain("review_expired");
    expect(after.state).toBe("succeeded");
    // Expired, not escalated: every open item declined by nobody.
    const expired = (await d.rt.journal.events("x1")).find((e) => e.type === "review_expired")!;
    expect(expired.data).toMatchObject({ role: "accountant", declined: TOTALS });
    const outcome = (await d.w.db.query<{ result: Obj }>("select result from commands where run_id = $1 and command_id = $2", ["x1", (expired.data as Obj)["command"]]))[0]!.result;
    expect(outcome).toMatchObject({ waive: [], decline: TOTALS, by: null, role: "accountant", expired: true });
    const seen = await watched(d, "x1", "accountant");
    expect(seen.map((e) => e["type"]), JSON.stringify(seen)).toContain("asks_exhausted");
    heldToRole(seen, "accountant");
    expect((await d.tick()).code).toBe(0);
    const sent = notifiedOnly(d, 3).filter((n) => n["run"] === "x1").map((n) => `${String(n["event"])} ${String(n["role"])}`);
    expect(sent).toEqual(expect.arrayContaining(["review_requested accountant", "asks_exhausted accountant", "run_succeeded accountant"]));
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
    // The finance lead, asked once the review escalated: every value its wait and its view show labelled, none above
    // its cap; its stream holds none (the review was opened for the accountant, and the reports are the accountant's).
    const asked = await waitsOf(d, "ben");
    expect(asked).toHaveLength(1);
    const shownBen = [...labelled(asked), ...labelled((await runView(d.rt, "e1", { role: "finance_lead" })).view)];
    expect(shownBen.length).toBeGreaterThan(0);
    capped(shownBen, "finance_lead");
    bare(asked, "the finance lead's waits");
    expect(stateIn(await decide(d, "ben"), "e1")).toBe("succeeded");
    heldToRole(await watched(d, "e1", "finance_lead"), "finance_lead");
    expect((await d.tick()).code).toBe(0);
    // The accountant's request was replaced by the escalation before the pump reached it: it is passed over.
    const sent = notifiedOnly(d, 2).filter((n) => n["run"] === "e1").map((n) => `${String(n["event"])} ${String(n["role"])}`);
    expect(sent).toContain("review_escalated finance_lead");
    expect(sent).toContain("run_succeeded accountant");
    expect(sent).not.toContain("review_requested accountant");
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
    const events = await d.rt.journal.events("e2");
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(["review_escalated", "review_expired"]));
    // Every open item declined, by nobody, in the role the review last asked.
    const expired = events.filter((e) => e.type === "review_expired");
    expect(expired).toHaveLength(1);
    expect(expired[0]!.data).toMatchObject({ role: "finance_lead", declined: TOTALS });
    const outcome = (await d.w.db.query<{ result: Obj }>("select result from commands where run_id = $1 and command_id = $2", ["e2", (expired[0]!.data as Obj)["command"]]))[0]!.result;
    expect(outcome).toMatchObject({ waive: [], decline: TOTALS, by: null, role: "finance_lead", expired: true });
    expect(events.filter((e) => e.type === "review_decided" || e.type === "criterion_waived")).toEqual([]);
    // The result: what passed is written (simulated, a design run), and each open item is declined by nobody, beside
    // the other vendor's match, which no one may waive.
    expect(run.result).toEqual({
      failed: [],
      posted: PASSED.map(() => ({ $tag: "Ok", $args: [{ effect: "erp.post_draft_invoice", simulated: true, params_digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) }] })),
      declined: [...TOTALS, ...VENDOR].sort().map((i) => ({ by: null, index: i, unmet: [VENDOR.includes(i) ? "vendor" : "totals"], value: { invoice_no: invoiceNo(i), order: order(i) } })),
    });
    expect(await d.rt.replayRun("e2")).toEqual({ status: "complete", value: run.result });
    const sent = notifiedOnly(d, 2).filter((n) => n["run"] === "e2").map((n) => `${String(n["event"])} ${String(n["role"])}`);
    expect(sent).toEqual(expect.arrayContaining(["review_escalated finance_lead", "run_succeeded accountant"]));
  });

  it("the literals the cases hold the runtime to are the spec's tables", () => {
    const boundary = read("spec/boundary.md");
    const table = boundary.slice(boundary.indexOf("**Events.** The class of every event type"), boundary.indexOf("An event's class says which projections"));
    const classes = Object.fromEntries([...table.matchAll(/^\| (S[0-4]) \| (.*) \|$/gm)].map((m) => [m[1]!, [...m[2]!.matchAll(/`(\w+)`/g)].map((x) => x[1]!)]));
    expect(classes).toEqual(SPEC_CLASSES);
    const attention = read("spec/attention.md");
    const what = attention.slice(attention.indexOf("- **What is sent.**"), attention.indexOf("- **The id**"));
    const named = (re: RegExp): string[] => [...re.exec(what)![1]!.matchAll(/`(\w+)`/g)].map((x) => x[1]!);
    expect({ S0: named(/S0 events \(([^)]*)\)/), S1: named(/S1\s+events \(([^)]*)\)/) }).toEqual(SPEC_NOTIFIED);
    const payload = attention.slice(attention.indexOf("interface Notification {"), attention.indexOf("interface Notifier"));
    const body = payload.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^interface Notification \{/, "").replace(/\}\s*$/, "").replace(/\{[^{}]*\}/g, "X");
    expect(body.split(";").map((m) => /^\s*(\w+)/.exec(m)?.[1]).filter((m) => m !== undefined)).toEqual(SPEC_MEMBERS);
  });
});
