// The OpenTelemetry projection (spec/boundary.md "The OpenTelemetry projection"; INV-17, G24): a run is a trace, its
// commands are spans, its events are span events; what leaves is built from an allow-list, none of a run's content
// among it; an export resumes from a cursor and fails without touching a run. The collector is in this process, on
// the loopback address: no test contacts a network.

import type { Lock } from "@mandate/compiler";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { main } from "../src/cli.js";
import type { Db } from "../src/db.js";
import { defaultClassOf, otelEndpoint, otelExport, project, spanId, traceId, type CommandFact, type EventFact, type OtelOptions, type OtlpBody, type OtlpSpan } from "../src/otel.js";
import { Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, SimModel, SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { closeAll, flush, until, world, type World } from "./helpers.js";

// ── a collector in this process ─────────────────────────────────────────

interface Post {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  text: string;
  body: OtlpBody;
}

class Collector {
  readonly posts: Post[] = [];
  /** What the collector does with the next post; the default accepts it. */
  answer: (req: IncomingMessage, res: ServerResponse, post: Post) => void = (_q, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end("{}");
  };
  private constructor(
    private readonly server: Server,
    readonly url: string,
  ) {}

  static async start(): Promise<Collector> {
    let self!: Collector;
    const server = createServer((req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (c: string) => (text += c));
      req.on("end", () => {
        const post: Post = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, text, body: JSON.parse(text || "{}") as OtlpBody };
        self.posts.push(post);
        self.answer(req, res, post);
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    self = new Collector(server, `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    return self;
  }

  get spans(): OtlpSpan[] {
    return this.posts.flatMap((p) => p.body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
  }

  /** The sequence numbers of the span events posted: those of one post in order, the posts in the order they came. */
  get seqs(): number[] {
    return this.posts.flatMap((p) => p.body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.flatMap((x) => x.events.map((e) => Number(attr(e.attributes, "mandate.event.seq")))))).sort((a, b) => a - b));
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

type Attrs = Array<{ key: string; value: Record<string, string> }>;

/** An attribute's value as written, or undefined. */
function attr(a: Attrs, key: string): string | undefined {
  const v = a.find((x) => x.key === key)?.value;
  return v === undefined ? undefined : (v["stringValue"] ?? v["intValue"]);
}

// ── a world with runs that carry content ────────────────────────────────

const PROGRAM = `mandate @ 0.2

module test.otel @ 0.1

use std.{fs, model, human}

capability RepoRead = fs.read("/work/repo")
capability SrcWrite = fs.write("/work/repo/src")
capability ModelStd = model.infer(tier: standard)

type Answer = { capital: Text }

agent Fixer {
  caps   RepoRead, SrcWrite, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 12 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

workflow Fix(task: Text) -> Inferred<Text>
  caps   RepoRead, SrcWrite, ModelStd
  budget { spend: 2 USD }
{
  delegate Fixer.apply(task)
}

workflow Ask(country: Text) -> Inferred<Answer>
  caps   ModelStd
  budget { spend: 1 USD, tokens: 200k }
{
  let first = infer Answer from quote(country)
  let more = human.ask("Again?")
  infer Answer from quote(more)
}
`;

const LOCK = {
  modules: {},
  models: { standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", max_input_tokens: 2000, max_output_tokens: 500 } },
  tariffs: { "claude-opus-5-5": { currency: "USD", as_of: "2026-10-09", micros_per_mtok: { input: 4_000_000, output: 20_000_000, cache_read: 200_000, cache_write: 5_000_000 } } },
};

/** Words that stand for content. None of them may appear in anything an export sends. */
const CANARIES = { prompt: "prompt-canary", argument: "tool-argument-canary", output: "tool-output-canary", result: "step-result-canary", decision: "decision-canary", model: "model-output-canary", path: "violating-path-canary" };

interface Otel extends World {
  host: SimSandboxHost;
  chat: SimChat;
}

async function setup(): Promise<Otel> {
  const w = await world(PROGRAM, { lock: LOCK as Lock, model: new SimModel(() => ({ ok: { capital: CANARIES.model }, cost: { tokens: 100 } })) });
  const host = new SimSandboxHost();
  host.files.set("/work/repo/src/a.ts", CANARIES.output);
  const script = (n: number): SimTurn =>
    n === 1
      ? [toolUse("a", "read_file", { path: "/work/repo/src/a.ts" }), toolUse("b", "write_file", { path: "/work/repo/src/b.ts", content: CANARIES.argument }), toolUse("c", "write_file", { path: `/etc/${CANARIES.path}`, content: "x" })]
      : [toolUse("f", "finish", { result: CANARIES.result })];
  const chat = new SimChat((_req: TurnRequest, n: number) => script(n));
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { decisions: { mode: "unsigned" } });
  return { ...w, rt, host, chat };
}

/** A run that fixes, with a model turn, three tool calls, a violation and a result: tenant `acme`. */
async function fix(w: Otel, runId = "fix", tenant = "acme"): Promise<void> {
  const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: CANARIES.prompt }, runId, tenant });
  expect(run.state).toBe("succeeded");
}

/** A run that asks the model, then a person; it waits for the answer. */
async function ask(w: Otel, runId = "ask", tenant = "acme"): Promise<void> {
  const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: { country: CANARIES.prompt }, runId, tenant });
  expect(run.state).toBe("waiting");
}

/** The person's answer, which carries the decision's text; the run ends. */
async function answer(w: Otel, runId = "ask"): Promise<void> {
  const run = await w.rt.getRun(runId);
  const command = String((run.waiting as { command: string }).command);
  const done = await w.rt.submitInput(runId, { sender: "erin", messageId: `m-${runId}` }, { commandId: command, revision: run.revision, value: CANARIES.decision });
  expect(done.state).toBe("succeeded");
}

/** Everything of the run that an export must leave as it was: the run, its events, commands, anchors. */
async function stateOf(db: Db): Promise<string> {
  const read = async (t: string, order: string): Promise<unknown> => db.query(`select * from ${t} order by ${order}`);
  return JSON.stringify([await read("runs", "run_id"), await read("events", "run_id, seq"), await read("commands", "run_id, command_id"), await read("journal_anchors", "run_id, seq"), await read("budgets", "run_id, dimension")]);
}

const cursors = (db: Db) => db.query<{ endpoint: string; run_id: string; seq: number }>("select endpoint, run_id, seq from otel_cursors order by endpoint, run_id");

let collectors: Collector[] = [];
const collector = async (): Promise<Collector> => {
  const c = await Collector.start();
  collectors.push(c);
  return c;
};

afterEach(async () => {
  await Promise.all(collectors.map((c) => c.stop()));
  collectors = [];
});
afterAll(closeAll);

/** Exports with the options a test gives; short intervals and timeouts. */
const exporting = (w: Otel, c: Collector, o: Partial<OtelOptions> = {}) => otelExport(w.db, { endpoint: otelEndpoint(c.url), timeoutMs: 3000, ...o });

let w: Otel;
beforeEach(async () => {
  w = await setup();
});

describe("what leaves", () => {
  it("holds no content: no prompt, argument, output, step result, decision text or violating path, in any body", async () => {
    await fix(w);
    await ask(w);
    await answer(w);
    const c = await collector();
    await exporting(w, c);
    expect(c.posts.length).toBeGreaterThan(0);
    // The canaries are in the journal (or the run's rows): the test is not vacuous.
    const stored = JSON.stringify([await w.db.query("select * from events"), await w.db.query("select * from commands"), await w.db.query("select * from runs")]);
    for (const [what, canary] of Object.entries(CANARIES)) {
      expect(stored, `${what} is stored`).toContain(canary);
      for (const p of c.posts) expect(p.text, `${what} is not sent`).not.toContain(canary);
    }
    // Nor the question the program asks, nor any file path.
    for (const p of c.posts) {
      expect(p.text).not.toContain("Again?");
      expect(p.text).not.toContain("/work/repo");
    }
  });

  it("is made of an allow-list: the span, event and attribute names are a fixed set", async () => {
    await fix(w);
    await ask(w);
    await answer(w);
    const c = await collector();
    await exporting(w, c);
    const spanKeys = new Set(["traceId", "spanId", "parentSpanId", "name", "kind", "startTimeUnixNano", "endTimeUnixNano", "attributes", "events", "status"]);
    const spanAttrs = new Set(["mandate.run", "mandate.tenant", "mandate.package", "mandate.command", "mandate.command.kind", "mandate.span.events", "gen_ai.operation.name", "gen_ai.request.model"]);
    const eventAttrs = new Set(["mandate.event.type", "mandate.event.class", "mandate.event.seq", "mandate.event.hash"]);
    expect(c.spans.length).toBeGreaterThan(5);
    for (const s of c.spans) {
      expect(Object.keys(s).every((k) => spanKeys.has(k))).toBe(true);
      expect(s.attributes.map((a) => a.key).filter((k) => !spanAttrs.has(k))).toEqual([]);
      for (const e of s.events) {
        expect(Object.keys(e).sort()).toEqual(["attributes", "name", "timeUnixNano"]);
        expect(e.attributes.map((a) => a.key).filter((k) => !eventAttrs.has(k))).toEqual([]);
      }
    }
    for (const p of c.posts) {
      expect(Object.keys(p.body)).toEqual(["resourceSpans"]);
      expect(p.body.resourceSpans[0]!.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "mandate" } }]);
      expect(p.body.resourceSpans[0]!.schemaUrl).toBe("https://opentelemetry.io/schemas/1.37.0");
      expect(p.body.resourceSpans[0]!.scopeSpans[0]!.schemaUrl).toBe("https://opentelemetry.io/schemas/1.37.0");
    }
  });

  it("carries the run, the tenant, the package, each event's type, class, sequence number and hash, and the commands", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c, { scope: { run: "fix" } });
    const rows = await w.db.query<{ seq: number; type: string; hash: string }>("select seq, type, hash from events where run_id = 'fix' order by seq");
    const sent = c.spans.flatMap((s) => s.events.map((e) => ({ seq: Number(attr(e.attributes, "mandate.event.seq")), type: attr(e.attributes, "mandate.event.type"), hash: attr(e.attributes, "mandate.event.hash"), class: attr(e.attributes, "mandate.event.class"), name: e.name })));
    expect(sent.map((e) => e.seq).sort((x, y) => x - y)).toEqual(rows.map((r) => Number(r.seq)));
    for (const r of rows) {
      const e = sent.find((x) => x.seq === Number(r.seq))!;
      expect([e.type, e.name, e.hash]).toEqual([r.type, r.type, r.hash]);
      expect(e.hash).toMatch(/^sha256:/);
      expect(e.class).toBe(defaultClassOf(r.type));
    }
    const root = c.spans.find((s) => s.name === "mandate.run")!;
    expect(root.parentSpanId).toBeUndefined();
    expect(attr(root.attributes, "mandate.run")).toBe("fix");
    expect(attr(root.attributes, "mandate.tenant")).toBe("acme");
    expect(attr(root.attributes, "mandate.package")).toBe(w.pkg.hash);
    expect(root.status).toEqual({ code: 1 });
    // The commands: the delegation, the model turns and the tool calls, each a child of the run's span.
    const kinds = c.spans.filter((s) => s.name !== "mandate.run").map((s) => attr(s.attributes, "mandate.command.kind"));
    for (const k of ["delegate", "turn", "tool"]) expect(kinds).toContain(k);
    for (const s of c.spans.filter((x) => x.name !== "mandate.run")) expect(s.parentSpanId).toBe(root.spanId);
    // The violation is an event of the run, with the class of an exception.
    const violation = sent.filter((e) => e.type === "violation");
    expect(violation.length).toBeGreaterThan(0);
    expect(violation.every((e) => e.class === "S1")).toBe(true);
  });

  it("names the GenAI operation of a command, and the model the lock maps the call's tier to", async () => {
    await fix(w);
    await ask(w);
    const c = await collector();
    await exporting(w, c);
    const by = (kind: string) => c.spans.filter((s) => attr(s.attributes, "mandate.command.kind") === kind);
    for (const [kind, op] of [["infer", "chat"], ["turn", "chat"], ["tool", "execute_tool"], ["delegate", "invoke_agent"]] as const) {
      expect(by(kind).length, kind).toBeGreaterThan(0);
      for (const s of by(kind)) expect(attr(s.attributes, "gen_ai.operation.name"), kind).toBe(op);
    }
    for (const s of [...by("infer"), ...by("turn")]) expect(attr(s.attributes, "gen_ai.request.model")).toBe("claude-opus-5-5");
    for (const s of [...by("tool"), ...by("delegate")]) expect(attr(s.attributes, "gen_ai.request.model")).toBeUndefined();
    // A command that is no model call has no GenAI operation.
    for (const s of by("time")) expect(attr(s.attributes, "gen_ai.operation.name")).toBeUndefined();
  });

  it("names no model when the lock pins none", async () => {
    const bare = await world(PROGRAM, { lock: { modules: {} } });
    await bare.rt.startRun({ pkg: bare.pkg, workflow: "Ask", input: { country: "x" }, runId: "bare" });
    const c = await collector();
    await otelExport(bare.db, { endpoint: otelEndpoint(c.url) });
    expect(c.spans.filter((s) => attr(s.attributes, "mandate.command.kind") === "infer").length).toBeGreaterThan(0);
    expect(c.spans.some((s) => attr(s.attributes, "gen_ai.request.model") !== undefined)).toBe(false);
  });

  it("takes each event's class from the function it is given", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c, { classOf: (t) => `class-of-${t.length}` });
    const classes = c.spans.flatMap((s) => s.events.map((e) => [attr(e.attributes, "mandate.event.type")!, attr(e.attributes, "mandate.event.class")!]));
    expect(classes.length).toBeGreaterThan(5);
    for (const [type, cls] of classes) expect(cls).toBe(`class-of-${type!.length}`);
  });

  it("sends a post of spans to <endpoint>/v1/traces with a JSON body, and no credential", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c);
    for (const p of c.posts) {
      expect([p.method, p.url]).toEqual(["POST", "/v1/traces"]);
      expect(p.headers["content-type"]).toBe("application/json");
      expect(Object.keys(p.headers).filter((h) => /auth|cookie|key|token/i.test(h))).toEqual([]);
    }
  });

  it("bounds a post: no post carries more events than the batch", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c, { batch: 4 });
    const total = (await w.db.query("select seq from events where run_id = 'fix'")).length;
    expect(c.posts.length).toBe(Math.ceil(total / 4));
    for (const p of c.posts) expect(p.body.resourceSpans[0]!.scopeSpans[0]!.spans.reduce((n, s) => n + s.events.length, 0)).toBeLessThanOrEqual(4);
    expect(c.seqs).toEqual([...c.seqs].sort((x, y) => x - y).filter((x, i, a) => a.indexOf(x) === i));
    expect(c.seqs.length).toBe(total);
  });

  it("is the same body when exported twice to two endpoints, with the spec's ids", async () => {
    await fix(w);
    await ask(w);
    const [one, two] = [await collector(), await collector()];
    await exporting(w, one);
    await exporting(w, two);
    expect(two.posts.map((p) => p.text)).toEqual(one.posts.map((p) => p.text));
    expect(await cursors(w.db)).toHaveLength(4);
    // The ids, derived by hand.
    const hex = (s: string, n: number): string => createHash("sha256").update(s, "utf8").digest("hex").slice(0, n);
    const [infer] = await w.db.query<{ command_id: string }>("select command_id from commands where run_id = 'ask' and kind = 'infer' order by command_id");
    const spans = one.spans.filter((s) => attr(s.attributes, "mandate.run") === "ask");
    expect(spans.length).toBeGreaterThan(1);
    for (const s of spans) expect(s.traceId).toBe(hex("mandate/otel-trace/0.1\nask", 32));
    const mine = spans.find((s) => attr(s.attributes, "mandate.command") === infer!.command_id)!;
    expect(mine.spanId).toBe(hex(`mandate/otel-span/0.1\nask\n${infer!.command_id}`, 16));
    expect(mine.parentSpanId).toBe(hex("mandate/otel-span/0.1\nask\n", 16));
    expect(spans.find((s) => s.name === "mandate.run")!.spanId).toBe(hex("mandate/otel-span/0.1\nask\n", 16));
    expect(mine.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(mine.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId("ask")).toBe(mine.traceId);
    expect(spanId("ask", infer!.command_id)).toBe(mine.spanId);
  });

  it("writes times as unix nanoseconds, in decimal strings, from the events' times", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c);
    const [first] = await w.db.query<{ at: string }>("select at from events where run_id = 'fix' order by seq limit 1");
    const root = c.spans.find((s) => s.name === "mandate.run")!;
    expect(root.startTimeUnixNano).toBe((BigInt(first!.at) * 1_000_000n).toString());
    for (const s of c.spans) {
      expect(s.startTimeUnixNano).toMatch(/^\d+$/);
      expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
    }
  });
});

describe("the projection, given facts", () => {
  const facts = (events: EventFact[], commands: CommandFact[] = []) => ({ run: "r", tenant: "t", package: "sha256:p", events, commands, models: new Map() });
  const ev = (seq: number, type: string, command: string | null = null): EventFact => ({ seq, type, at: 1000 + seq, hash: `sha256:${seq}`, command, locked: null });

  it("sends a type it has never seen as its type, class, sequence number and hash, and nothing else", () => {
    const body = project(facts([ev(1, "run_accepted"), ev(2, "an_event_added_next_year")]), 0, 2, defaultClassOf)!;
    const [root] = body.resourceSpans[0]!.scopeSpans[0]!.spans;
    const event = root!.events[1]!;
    expect(event.name).toBe("an_event_added_next_year");
    expect(event.attributes).toEqual([
      { key: "mandate.event.type", value: { stringValue: "an_event_added_next_year" } },
      { key: "mandate.event.class", value: { stringValue: "S4" } },
      { key: "mandate.event.seq", value: { intValue: "2" } },
      { key: "mandate.event.hash", value: { stringValue: "sha256:2" } },
    ]);
  });

  it("does not take a command id for an identifier unless it is shaped like one", () => {
    const hostile = "the customer's name is Jane Doe";
    const body = project(facts([ev(1, "run_accepted"), ev(2, "command_dispatched", hostile)], [{ id: hostile, kind: "tool", state: "dispatched", package: null }]), 0, 2, defaultClassOf)!;
    const text = JSON.stringify(body);
    expect(text).not.toContain("Jane");
    const span = body.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
    expect(attr(span.attributes as Attrs, "mandate.command")).toMatch(/^sha256:[0-9a-f]{16}$/);
    // The span's id is still the spec's, of the command as it is.
    expect(span.spanId).toBe(spanId("r", hostile));
  });

  it("takes the model an adapter reported only when the lock pins that model id, else the program's one tier's, else none", () => {
    const command: CommandFact = { id: "main/0", kind: "turn", state: "dispatched", package: null };
    const model = (locked: string | null, known: { sole: string | null; ids: string[] }) => {
      const events = [ev(1, "run_accepted"), { ...ev(2, "command_completed", "main/0"), locked }];
      const body = project({ ...facts(events, [command]), models: new Map([["sha256:p", { sole: known.sole, ids: new Set(known.ids) }]]) }, 0, 2, defaultClassOf)!;
      return attr(body.resourceSpans[0]!.scopeSpans[0]!.spans[1]!.attributes as Attrs, "gen_ai.request.model");
    };
    expect(model("claude-a", { sole: "claude-b", ids: ["claude-a", "claude-b", "claude-c"] })).toBe("claude-a");
    expect(model("a customer's secret text", { sole: "claude-b", ids: ["claude-b"] })).toBe("claude-b");
    expect(model("a customer's secret text", { sole: null, ids: ["claude-b", "claude-c"] })).toBeUndefined();
    expect(model(null, { sole: null, ids: [] })).toBeUndefined();
  });

  it("sends no body for no events, and an event after the range is not in it", () => {
    expect(project(facts([ev(1, "run_accepted")]), 1, 1, defaultClassOf)).toBeUndefined();
    const body = project(facts([ev(1, "run_accepted"), ev(2, "run_running"), ev(3, "run_failed")]), 0, 2, defaultClassOf)!;
    const root = body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(root.events.map((e) => e.name)).toEqual(["run_accepted", "run_running"]);
    expect(root.status).toBeUndefined();
    expect(attr(root.attributes as Attrs, "mandate.span.events")).toBe("2");
  });

  it("gives a span that continues in a later body the same id and start, and its end so far", () => {
    const events = [ev(1, "run_accepted"), ev(2, "command_dispatched", "main/0"), ev(3, "command_completed", "main/0")];
    const commands: CommandFact[] = [{ id: "main/0", kind: "tool", state: "succeeded", package: null }];
    const early = project(facts(events, commands), 0, 2, defaultClassOf)!.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
    const late = project(facts(events, commands), 2, 3, defaultClassOf)!.resourceSpans[0]!.scopeSpans[0]!.spans[1]!;
    expect([late.spanId, late.startTimeUnixNano]).toEqual([early.spanId, early.startTimeUnixNano]);
    expect(late.endTimeUnixNano > early.endTimeUnixNano).toBe(true);
    expect(early.status).toBeUndefined();
    expect(late.status).toEqual({ code: 1 });
    expect(late.events.map((e) => e.name)).toEqual(["command_completed"]);
  });
});

describe("the cursor", () => {
  it("sends nothing the second time, and only the new events after more are written", async () => {
    await ask(w);
    const c = await collector();
    const first = await exporting(w, c);
    const sent = c.seqs.length;
    expect(sent).toBeGreaterThan(5);
    const last = Math.max(...c.seqs);
    expect(await cursors(w.db)).toEqual([{ endpoint: otelEndpoint(c.url), run_id: "ask", seq: last }]);
    expect(first.runs).toEqual([{ run: "ask", events: sent, posts: c.posts.length, cursor: last }]);

    const posts = c.posts.length;
    const again = await exporting(w, c);
    expect(c.posts.length).toBe(posts);
    expect(again.runs).toEqual([{ run: "ask", events: 0, posts: 0, cursor: last }]);

    await answer(w);
    await exporting(w, c);
    const fresh = c.seqs.slice(sent);
    expect(fresh.length).toBeGreaterThan(0);
    expect(Math.min(...fresh)).toBe(last + 1);
    // Every event once, in order.
    expect(c.seqs).toEqual(Array.from({ length: c.seqs.length }, (_, i) => i + 1));
    expect(c.posts.slice(posts).every((p) => p.body.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.name === "mandate.run")).toBe(true);
    // The run's span ends later than it did, with the same id.
    const roots = c.spans.filter((s) => s.name === "mandate.run");
    expect(roots.at(-1)!.spanId).toBe(roots[0]!.spanId);
    expect(roots.at(-1)!.status).toEqual({ code: 1 });
  });

  it("is kept for each endpoint and each run", async () => {
    await fix(w);
    await ask(w);
    const [one, two] = [await collector(), await collector()];
    await exporting(w, one, { scope: { run: "fix" } });
    await exporting(w, two);
    expect(one.posts.length).toBeGreaterThan(0);
    expect(new Set(two.spans.map((s) => attr(s.attributes, "mandate.run")))).toEqual(new Set(["fix", "ask"]));
    expect((await cursors(w.db)).map((c) => [c.endpoint === otelEndpoint(one.url) ? "one" : "two", c.run_id]).sort()).toEqual([["one", "fix"], ["two", "ask"], ["two", "fix"]]);
    // Exporting everything to the first endpoint sends the run it has not had, and not the one it has.
    const before = one.posts.length;
    await exporting(w, one);
    expect(one.posts.length).toBeGreaterThan(before);
    expect(one.posts.slice(before).every((p) => p.body.resourceSpans[0]!.scopeSpans[0]!.spans.every((s) => attr(s.attributes, "mandate.run") === "ask"))).toBe(true);
  });

  it("is where the last accepted post left it, when a later post fails; the next export goes on from there", async () => {
    await fix(w);
    const c = await collector();
    let n = 0;
    const accept = c.answer;
    c.answer = (req, res, post) => (++n === 2 ? res.writeHead(503).end("down") : accept(req, res, post));
    await expect(exporting(w, c, { batch: 4 })).rejects.toMatchObject({ code: "otel_export_failed", message: expect.stringContaining("503") });
    const [row] = await cursors(w.db);
    expect(row!.seq).toBe(Math.max(...c.posts[0]!.body.resourceSpans[0]!.scopeSpans[0]!.spans.flatMap((s) => s.events.map((e) => Number(attr(e.attributes as Attrs, "mandate.event.seq"))))));
    c.answer = accept;
    c.posts.length = 0;
    await exporting(w, c, { batch: 4 });
    const total = (await w.db.query("select seq from events where run_id = 'fix'")).length;
    expect(c.seqs).toEqual(Array.from({ length: total - row!.seq }, (_, i) => row!.seq + i + 1));
  });
});

describe("a failure", () => {
  it("leaves the cursor and every row of the run as they were, and says so, when the collector answers 500", async () => {
    await fix(w);
    await ask(w);
    const before = await stateOf(w.db);
    const c = await collector();
    c.answer = (_q, res) => res.writeHead(500).end("boom");
    await expect(exporting(w, c)).rejects.toMatchObject({ code: "otel_export_failed", message: expect.stringMatching(/answered 500; nothing was marked as exported/) });
    expect(c.posts).toHaveLength(1);
    expect(await cursors(w.db)).toEqual([]);
    expect(await stateOf(w.db)).toBe(before);
    expect((await w.rt.verifyJournal("fix")).status).toBe("verified");
  });

  it("leaves them as they were when the collector never answers, within the timeout", async () => {
    await fix(w);
    const before = await stateOf(w.db);
    const c = await collector();
    c.answer = () => undefined;
    const began = Date.now();
    await expect(exporting(w, c, { timeoutMs: 300 })).rejects.toMatchObject({ code: "otel_export_failed", message: expect.stringContaining("no answer within 300 ms") });
    expect(Date.now() - began).toBeLessThan(2500);
    expect(await cursors(w.db)).toEqual([]);
    expect(await stateOf(w.db)).toBe(before);
  });

  it("leaves them as they were when nothing listens at the endpoint", async () => {
    await fix(w);
    const before = await stateOf(w.db);
    const c = await collector();
    const url = otelEndpoint(c.url);
    await c.stop();
    await expect(otelExport(w.db, { endpoint: url, timeoutMs: 1000 })).rejects.toMatchObject({ code: "otel_export_failed", message: expect.stringContaining("could not be reached") });
    expect(await cursors(w.db)).toEqual([]);
    expect(await stateOf(w.db)).toBe(before);
  });

  it("does not follow a redirect: the spans go where the operator said", async () => {
    await fix(w);
    const [target, c] = [await collector(), await collector()];
    c.answer = (_q, res) => res.writeHead(307, { location: `${target.url}/v1/traces` }).end();
    await expect(exporting(w, c)).rejects.toMatchObject({ code: "otel_export_failed" });
    expect(target.posts).toEqual([]);
    expect(await cursors(w.db)).toEqual([]);
  });

  it("counts the spans a collector says it rejected, and moves on", async () => {
    await fix(w);
    const c = await collector();
    c.answer = (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ partialSuccess: { rejectedSpans: "2", errorMessage: "no" } }));
    const r = await exporting(w, c);
    expect(r.rejected).toBe(2 * c.posts.length);
    expect((await cursors(w.db))[0]!.seq).toBeGreaterThan(0);
  });
});

describe("what is exported", () => {
  it("is one tenant's runs for --tenant, and no other's", async () => {
    await fix(w, "a1", "acme");
    await ask(w, "a2", "acme");
    await fix(w, "o1", "other");
    const c = await collector();
    const r = await exporting(w, c, { scope: { tenant: "acme" } });
    expect(r.runs.map((x) => x.run)).toEqual(["a1", "a2"]);
    expect(new Set(c.spans.map((s) => attr(s.attributes, "mandate.run")))).toEqual(new Set(["a1", "a2"]));
    expect(new Set(c.spans.map((s) => attr(s.attributes, "mandate.tenant")))).toEqual(new Set(["acme"]));
    expect((await cursors(w.db)).map((x) => x.run_id)).toEqual(["a1", "a2"]);
  });

  it("is one run for --run, every run when neither is given, and an unknown run is refused", async () => {
    await fix(w, "a1", "acme");
    await fix(w, "o1", "other");
    const c = await collector();
    await exporting(w, c, { scope: { run: "o1" } });
    expect(new Set(c.spans.map((s) => attr(s.attributes, "mandate.run")))).toEqual(new Set(["o1"]));
    await exporting(w, c);
    expect(new Set(c.spans.map((s) => attr(s.attributes, "mandate.run")))).toEqual(new Set(["o1", "a1"]));
    await expect(exporting(w, c, { scope: { run: "nope" } })).rejects.toMatchObject({ code: "unknown_run" });
  });

  it("leaves a run whose journal verifies, in the state it was", async () => {
    await fix(w);
    await ask(w);
    const before = await stateOf(w.db);
    const c = await collector();
    await exporting(w, c);
    expect(await stateOf(w.db)).toBe(before);
    for (const run of ["fix", "ask"]) expect((await w.rt.verifyJournal(run)).status).toBe("verified");
    expect((await w.rt.getRun("ask")).state).toBe("waiting");
  });
});

describe("--follow", () => {
  it("picks up an event written after it started, and stops cleanly when told to", async () => {
    await ask(w);
    const c = await collector();
    const stop = new AbortController();
    const running = exporting(w, c, { follow: true, intervalMs: 5, signal: stop.signal });
    await until(() => c.posts.length > 0, "the first post");
    const first = c.seqs.length;
    await answer(w);
    await until(() => c.spans.some((s) => s.name === "mandate.run" && s.status?.code === 1), "the events written later");
    stop.abort();
    const report = await running;
    expect(report.failed).toBeUndefined();
    expect(c.seqs.length).toBeGreaterThan(first);
    expect(c.seqs).toEqual(Array.from({ length: c.seqs.length }, (_, i) => i + 1));
    expect((await cursors(w.db))[0]!.seq).toBe(c.seqs.length);
    // Nothing more is sent after it stopped.
    const posts = c.posts.length;
    await flush();
    await new Promise((r) => setTimeout(r, 30));
    expect(c.posts.length).toBe(posts);
  });

  it("exports a run of its tenant that was begun after it started, and not another tenant's", async () => {
    const c = await collector();
    const stop = new AbortController();
    const running = exporting(w, c, { follow: true, intervalMs: 5, signal: stop.signal, scope: { tenant: "acme" } });
    await flush();
    await fix(w, "late", "acme");
    await fix(w, "elsewhere", "other");
    await until(() => c.spans.some((s) => attr(s.attributes, "mandate.run") === "late" && s.status?.code === 1), "the late run");
    stop.abort();
    await running;
    expect(new Set(c.spans.map((s) => attr(s.attributes, "mandate.run")))).toEqual(new Set(["late"]));
  });

  it("stops at once when it is told to before it begins, and when it is told during a post that is not answered", async () => {
    await ask(w);
    const c = await collector();
    const before = new AbortController();
    before.abort();
    expect((await exporting(w, c, { follow: true, intervalMs: 5, signal: before.signal })).runs).toEqual([]);
    expect(c.posts).toEqual([]);

    c.answer = () => undefined;
    const stop = new AbortController();
    const running = exporting(w, c, { follow: true, intervalMs: 5, signal: stop.signal, timeoutMs: 60_000 });
    await until(() => c.posts.length > 0, "a post that is not answered");
    stop.abort();
    await running;
    expect(await cursors(w.db)).toEqual([]);
  });

  it("reports a failed pass and tries again at the next, so a collector that comes back is caught up", async () => {
    await ask(w);
    const c = await collector();
    const accept = c.answer;
    c.answer = (_q, res) => res.writeHead(500).end();
    const failures: string[] = [];
    const stop = new AbortController();
    const running = exporting(w, c, { follow: true, intervalMs: 5, signal: stop.signal, onFailure: (m) => failures.push(m) });
    await until(() => failures.length >= 2, "two failed passes");
    expect(await cursors(w.db)).toEqual([]);
    c.answer = accept;
    const failed = c.posts.length;
    await until(() => c.posts.length > failed, "a post after the collector's return");
    stop.abort();
    const report = await running;
    expect(report.failed).toBeUndefined();
    const total = (await w.db.query("select seq from events where run_id = 'ask'")).length;
    expect(await cursors(w.db)).toEqual([{ endpoint: otelEndpoint(c.url), run_id: "ask", seq: total }]);
  });
});

describe("the endpoint", () => {
  it("is an http or https URL, without credential, query, fragment or the traces path, and is kept without a trailing slash", () => {
    expect(otelEndpoint("http://127.0.0.1:4318")).toBe("http://127.0.0.1:4318");
    expect(otelEndpoint("https://collector.example/otel/")).toBe("https://collector.example/otel");
    for (const bad of ["collector:4318", "ftp://collector", "file:///tmp/x", "http://user:made-up@collector", "http://user@collector", "https://collector/?x=1", "https://collector/#a", "https://collector/v1/traces", "https://collector/otel/v1/traces/", "", "http://"]) {
      expect(() => otelEndpoint(bad), bad).toThrow(expect.objectContaining({ code: "invalid_endpoint" }));
    }
  });
});

// ── the command ─────────────────────────────────────────────────────────

describe("mandate otel export", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-otel-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "ask.mdt"),
    `mandate @ 0.2

module cli.otel @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Ask() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Ship it?")
}
`,
  );
  writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: `pglite:${join(dir, "db").replaceAll("\\", "/")}`, decisions: { mode: "unsigned" } }));

  async function mandate(args: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
    try {
      const code = await main([...args, "--config", join(dir, "mandate.runtime.json")], (s) => (out += s), {});
      return { code, out, err };
    } finally {
      process.stderr.write = write;
    }
  }

  it("exports a run, says what it sent, resumes, and exports a tenant, as JSON when asked", async () => {
    expect((await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "c1"])).out).toContain("waiting");
    const c = await collector();
    const first = await mandate(["otel", "export", "--endpoint", c.url, "--run", "c1"]);
    expect(first.code, first.err).toBe(0);
    expect(first.out).toMatch(/^run c1: events 1 to \d+ sent in 2 spans\n$/);
    expect(c.posts).toHaveLength(1);
    const again = await mandate(["otel", "export", "--endpoint", `${c.url}/`, "--run", "c1"]);
    expect([again.code, again.out]).toEqual([0, "nothing to export\n"]);
    expect(c.posts).toHaveLength(1);
    const json = await mandate(["otel", "export", "--endpoint", c.url, "--tenant", "default", "--json"]);
    expect(JSON.parse(json.out)).toEqual({ endpoint: c.url, runs: [{ run: "c1", events: 0, posts: 0, cursor: expect.any(Number) }], rejected: 0 });
  });

  it("exits 1 and says why when a post fails, and 2 for a usage error", async () => {
    const c = await collector();
    c.answer = (_q, res) => res.writeHead(500).end();
    await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "c2"]);
    const bad = await mandate(["otel", "export", "--endpoint", c.url, "--run", "c2"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("otel_export_failed");
    expect(bad.err).toContain("answered 500");
    const unknown = await mandate(["otel", "export", "--endpoint", c.url, "--run", "no-such-run"]);
    expect([unknown.code, unknown.err]).toEqual([1, expect.stringContaining("unknown_run")]);
    for (const args of [["otel"], ["otel", "export"], ["otel", "import", "--endpoint", c.url], ["otel", "export", "--endpoint", c.url, "--run", "a", "--tenant", "b"], ["otel", "export", "--endpoint", "ftp://x"], ["otel", "export", "--endpoint", "http://user:made-up@x"], ["otel", "export", "--endpoint", c.url, "extra"]]) {
      expect((await mandate(args)).code, args.join(" ")).toBe(2);
    }
  });

  it("follows until SIGINT, then stops and exits 0", async () => {
    await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "c3"]);
    const c = await collector();
    const running = mandate(["otel", "export", "--endpoint", c.url, "--run", "c3", "--follow"]);
    await until(() => c.posts.length > 0, "the first post");
    // The collector has the post; the command writes the cursor once it has read the answer. A stop before that abandons the post.
    await new Promise((r) => setTimeout(r, 500));
    process.emit("SIGINT");
    const r = await running;
    expect([r.code, r.err]).toEqual([0, ""]);
    expect(r.out).toMatch(/^run c3: events 1 to \d+ sent/);
  });
});
