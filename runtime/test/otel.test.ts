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
import { eventClass } from "../src/classes.js";
import { eventSpanId, otelEndpoint, otelExport, project, spanId, traceId, windows, type CommandFact, type EventFact, type OtelOptions, type OtlpBody, type OtlpSpan } from "../src/otel.js";
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

  /** The spans of one post. */
  static spansOf(p: Post): OtlpSpan[] {
    return p.body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
  }

  /** The spans that are an event's: those with a sequence number. */
  get eventSpans(): OtlpSpan[] {
    return this.spans.filter((s) => attr(s.attributes, "mandate.event.seq") !== undefined);
  }

  /** The sequence numbers of the events posted, in the order they came. */
  get seqs(): number[] {
    return this.eventSpans.map((s) => Number(attr(s.attributes, "mandate.event.seq")));
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
    const spanKeys = new Set(["traceId", "spanId", "parentSpanId", "name", "kind", "startTimeUnixNano", "endTimeUnixNano", "attributes", "status"]);
    const spanAttrs = new Set(["mandate.run", "mandate.tenant", "mandate.package", "mandate.command", "mandate.command.kind", "mandate.span.events", "mandate.event.type", "mandate.event.class", "mandate.event.seq", "mandate.event.hash", "gen_ai.operation.name", "gen_ai.request.model"]);
    expect(c.spans.length).toBeGreaterThan(5);
    for (const s of c.spans) {
      expect(Object.keys(s).every((k) => spanKeys.has(k))).toBe(true);
      expect(s.attributes.map((a) => a.key).filter((k) => !spanAttrs.has(k))).toEqual([]);
    }
    // An event's span has the event's attributes and none of a command's or the run's own; no span but an event's has them.
    for (const s of c.spans) {
      const keys = s.attributes.map((a) => a.key);
      const event = keys.includes("mandate.event.seq");
      expect(keys.some((k) => k.startsWith("mandate.event.")), s.name).toBe(event);
      expect(keys.includes("mandate.span.events"), s.name).toBe(!event);
      if (event) expect(s.status).toBeUndefined();
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
    // Every event is a span of its own, once, in order, of no duration, named by its type.
    expect(c.seqs).toEqual(rows.map((r) => Number(r.seq)));
    for (const [i, r] of rows.entries()) {
      const s = c.eventSpans[i]!;
      expect([attr(s.attributes, "mandate.event.type"), s.name, attr(s.attributes, "mandate.event.hash")]).toEqual([r.type, r.type, r.hash]);
      expect(attr(s.attributes, "mandate.event.hash")).toMatch(/^sha256:/);
      expect(attr(s.attributes, "mandate.event.class")).toBe(eventClass(r.type));
      expect(s.startTimeUnixNano).toBe(s.endTimeUnixNano);
      expect(s.status).toBeUndefined();
      expect([attr(s.attributes, "mandate.run"), attr(s.attributes, "mandate.tenant"), attr(s.attributes, "mandate.package")]).toEqual(["fix", "acme", w.pkg.hash]);
    }
    const roots = c.spans.filter((s) => s.name === "mandate.run");
    expect(roots).toHaveLength(1);
    const root = roots[0]!;
    expect(root.parentSpanId).toBeUndefined();
    expect([attr(root.attributes, "mandate.run"), attr(root.attributes, "mandate.tenant"), attr(root.attributes, "mandate.package")]).toEqual(["fix", "acme", w.pkg.hash]);
    expect(root.status).toEqual({ code: 1 });
    expect(attr(root.attributes, "mandate.span.events")).toBe(String(rows.length));
    // The commands: the delegation, the model turns and the tool calls, each a child of the run's span, once.
    const commands = c.spans.filter((s) => attr(s.attributes, "mandate.command.kind") !== undefined);
    const kinds = commands.map((s) => attr(s.attributes, "mandate.command.kind"));
    for (const k of ["delegate", "turn", "tool"]) expect(kinds).toContain(k);
    for (const s of commands) expect(s.parentSpanId).toBe(root.spanId);
    expect(new Set(commands.map((s) => s.spanId)).size).toBe(commands.length);
    // An event's parent is its command's span when its data names one of the run, and the run's span otherwise.
    const dispatched = c.eventSpans.find((s) => attr(s.attributes, "mandate.event.type") === "command_dispatched")!;
    expect(commands.map((s) => s.spanId)).toContain(dispatched.parentSpanId);
    expect(c.eventSpans.find((s) => attr(s.attributes, "mandate.event.type") === "run_accepted")!.parentSpanId).toBe(root.spanId);
    // The violation is an event of the run, with the class of an exception.
    const violation = c.eventSpans.filter((s) => attr(s.attributes, "mandate.event.type") === "violation");
    expect(violation.length).toBeGreaterThan(0);
    expect(violation.every((s) => attr(s.attributes, "mandate.event.class") === "S1")).toBe(true);
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
    expect(c.eventSpans.length).toBeGreaterThan(5);
    for (const s of c.eventSpans) expect(attr(s.attributes, "mandate.event.class")).toBe(`class-of-${attr(s.attributes, "mandate.event.type")!.length}`);
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

  it("bounds a post: no post carries more spans than the batch, the events and the spans that end with them", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c, { batch: 4 });
    const total = (await w.db.query("select seq from events where run_id = 'fix'")).length;
    for (const p of c.posts) expect(Collector.spansOf(p).length).toBeLessThanOrEqual(4);
    expect(c.posts.length).toBeGreaterThan(Math.ceil(total / 4) - 1);
    expect(c.seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
  });

  it("bounds a post when one event ends more spans than a post holds: the run's end ends every command left open", async () => {
    await ask(w);
    // The run ends with a command still open: its wait for the person. A batch of 2 cannot hold the end's three spans.
    await w.rt.cancelRun("ask");
    const c = await collector();
    await exporting(w, c, { batch: 2 });
    for (const p of c.posts) expect(Collector.spansOf(p).length).toBeLessThanOrEqual(2);
    const ids = c.spans.map((s) => s.spanId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(c.spans.filter((s) => s.name === "mandate.run")).toHaveLength(1);
    const total = (await w.db.query("select seq from events where run_id = 'ask'")).length;
    expect(c.seqs).toEqual(Array.from({ length: total }, (_, i) => i + 1));
    expect((await cursors(w.db))[0]!.seq).toBe(total);
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
    const root = hex("mandate/otel-span/0.1\nask\n", 16);
    // A command's span: its own id, a child of the run's span.
    const mine = spans.find((s) => attr(s.attributes, "mandate.command") === infer!.command_id && attr(s.attributes, "mandate.command.kind") === "infer")!;
    expect(mine.spanId).toBe(hex(`mandate/otel-span/0.1\nask\n${infer!.command_id}`, 16));
    expect(mine.parentSpanId).toBe(root);
    // An event's span: the id of its sequence number in decimal, a child of its command's span or of the run's.
    const events = spans.filter((s) => attr(s.attributes, "mandate.event.seq") !== undefined);
    expect(events.length).toBeGreaterThan(5);
    for (const s of events) {
      const seq = attr(s.attributes, "mandate.event.seq")!;
      expect(s.spanId).toBe(hex(`mandate/otel-event/0.1\nask\n${seq}`, 16));
      const command = attr(s.attributes, "mandate.command");
      expect(s.parentSpanId).toBe(command === undefined ? root : hex(`mandate/otel-span/0.1\nask\n${command}`, 16));
    }
    expect(mine.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(mine.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(traceId("ask")).toBe(mine.traceId);
    expect(spanId("ask", infer!.command_id)).toBe(mine.spanId);
    expect(eventSpanId("ask", 3)).toBe(hex("mandate/otel-event/0.1\nask\n3", 16));
    // The run's own span is the span of the empty command; the run is waiting, so it has not ended and is not sent yet.
    expect(spanId("ask", "")).toBe(root);
    expect(spans.some((s) => s.name === "mandate.run")).toBe(false);
  });

  it("writes times as unix nanoseconds, in decimal strings, from the events' times", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c);
    const rows = await w.db.query<{ seq: number; at: string }>("select seq, at from events where run_id = 'fix' order by seq");
    const root = c.spans.find((s) => s.name === "mandate.run")!;
    expect(root.startTimeUnixNano).toBe((BigInt(rows[0]!.at) * 1_000_000n).toString());
    expect(root.endTimeUnixNano).toBe((BigInt(rows.at(-1)!.at) * 1_000_000n).toString());
    for (const s of c.spans) {
      expect(s.startTimeUnixNano).toMatch(/^\d+$/);
      expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
    }
    for (const s of c.eventSpans) expect(s.startTimeUnixNano).toBe((BigInt(rows[Number(attr(s.attributes, "mandate.event.seq")) - 1]!.at) * 1_000_000n).toString());
  });
});

describe("no span is sent twice", () => {
  /** The spans of every body, with the number of the body each was in. */
  const placed = (c: Collector) => c.posts.flatMap((p, i) => Collector.spansOf(p).map((s) => ({ s, post: i })));

  it("holds over a whole export in passes and small batches, on a run that waits for a person in the middle and then finishes", async () => {
    await ask(w);
    const c = await collector();
    const sent = async (): Promise<void> => void (await exporting(w, c, { batch: 3 }));
    await sent();
    // The run waits: its events are out, and the commands that finished; the run's span is not.
    expect(c.spans.some((s) => s.name === "mandate.run")).toBe(false);
    expect(c.spans.some((s) => attr(s.attributes, "mandate.command.kind") === "infer")).toBe(true);
    await sent();
    expect(c.posts.length).toBeGreaterThan(0);
    await answer(w);
    await sent();
    await sent();

    const all = placed(c);
    // Every span id in exactly one posted body, and once.
    const ids = all.map(({ s }) => s.spanId);
    expect(new Set(ids).size).toBe(ids.length);
    // Every event's sequence number exactly once.
    const events = await w.db.query<{ seq: number; type: string; data_command: string | null }>("select seq, type, data->>'command' as data_command from events where run_id = 'ask' order by seq");
    expect(c.seqs).toEqual(events.map((e) => Number(e.seq)));
    // The run's span once, in the body that holds the run's last event.
    const last = events.length;
    const bodyOf = (seq: number): number => all.find(({ s }) => attr(s.attributes, "mandate.event.seq") === String(seq))!.post;
    const roots = all.filter(({ s }) => s.name === "mandate.run");
    expect(roots).toHaveLength(1);
    expect(roots[0]!.post).toBe(bodyOf(last));
    expect(roots[0]!.s.spanId).toBe(spanId("ask", ""));
    // A command's span in the body that holds the event that ends it: its completion.
    const commands = all.filter(({ s }) => attr(s.attributes, "mandate.command.kind") !== undefined);
    expect(commands.length).toBeGreaterThan(2);
    const rows = await w.db.query<{ command_id: string }>("select command_id from commands where run_id = 'ask' order by command_id");
    for (const { command_id: id } of rows) {
      const done = events.find((e) => e.type === "command_completed" && e.data_command === id);
      const at = commands.filter(({ s }) => s.spanId === spanId("ask", id));
      expect(at, id).toHaveLength(1);
      expect(at[0]!.post, id).toBe(bodyOf(done ? Number(done.seq) : last));
    }
    // Bodies hold at most the batch.
    for (const p of c.posts) expect(Collector.spansOf(p).length).toBeLessThanOrEqual(3);
  });

  it("ends a cancelled run's trace: its span is sent, with no status", async () => {
    await ask(w);
    await w.rt.cancelRun("ask");
    expect((await w.rt.getRun("ask")).state).toBe("cancelled");
    const c = await collector();
    await exporting(w, c);
    const roots = c.spans.filter((s) => s.name === "mandate.run");
    expect(roots).toHaveLength(1);
    expect(roots[0]!.status).toBeUndefined();
    expect(c.eventSpans.at(-1)!.name).toBe("run_cancelled");
    // The command that was open ends with the run, with no status either.
    const open = c.spans.filter((s) => attr(s.attributes, "mandate.command.kind") !== undefined && s.status === undefined);
    expect(open.length).toBeGreaterThan(0);
  });

  it("ends a halted run's trace: its span is sent", async () => {
    await ask(w);
    const r = await w.rt.halt({ tenant: "acme" }, { reason: "drill", by: "ops" });
    expect(r.ended.map((x) => [x.run, x.state])).toEqual([["ask", "cancelled"]]);
    const c = await collector();
    await exporting(w, c);
    expect(c.spans.filter((s) => s.name === "mandate.run")).toHaveLength(1);
    expect(c.eventSpans.map((s) => s.name)).toContain("cancel_requested");
    expect(c.eventSpans.at(-1)!.name).toBe("run_cancelled");
  });

  it("sends an event after the run ended as its own span, and the run's span is not sent again", async () => {
    await fix(w);
    const c = await collector();
    await exporting(w, c);
    const before = c.spans.length;
    expect(c.spans.filter((s) => s.name === "mandate.run")).toHaveLength(1);
    // Resuming a finished run takes a lease, and writes the event of it: an event after the run's end.
    const total = (await w.db.query("select seq from events where run_id = 'fix'")).length;
    expect((await w.rt.resume("fix")).state).toBe("succeeded");
    const events = await w.db.query<{ seq: number; type: string }>("select seq, type from events where run_id = 'fix' and seq > $1 order by seq", [total]);
    expect(events.map((e) => e.type)).toEqual(["lease_acquired"]);
    await exporting(w, c);
    const late = c.spans.slice(before);
    expect(late.map((s) => [s.name, attr(s.attributes, "mandate.event.seq")])).toEqual([["lease_acquired", String(total + 1)]]);
    expect(late[0]!.parentSpanId).toBe(spanId("fix", ""));
    expect(c.spans.filter((s) => s.name === "mandate.run")).toHaveLength(1);
  });
});

describe("the projection, given facts", () => {
  const facts = (events: EventFact[], commands: CommandFact[] = []) => ({ run: "r", tenant: "t", package: "sha256:p", events, commands, models: new Map() });
  const ev = (seq: number, type: string, command: string | null = null): EventFact => ({ seq, type, at: 1000 + seq, hash: `sha256:${seq}`, command, locked: null });
  const cmd = (id: string, kind = "tool", state = "succeeded"): CommandFact => ({ id, kind, state, package: null });
  const named = (spans: OtlpSpan[]): string[] => spans.map((s) => (s.name === "mandate.run" || s.name.startsWith("mandate.") ? `${s.name}` : `${s.name}#${attr(s.attributes, "mandate.event.seq")}`));

  it("sends a type it has never seen as its type, class, sequence number and hash, and nothing else", () => {
    const spans = project(facts([ev(1, "run_accepted"), ev(2, "an_event_added_next_year")]), 0, 2, eventClass);
    const event = spans[1]!;
    expect(event.name).toBe("an_event_added_next_year");
    expect(event.parentSpanId).toBe(spanId("r", ""));
    expect(event.attributes).toEqual([
      { key: "mandate.run", value: { stringValue: "r" } },
      { key: "mandate.tenant", value: { stringValue: "t" } },
      { key: "mandate.package", value: { stringValue: "sha256:p" } },
      { key: "mandate.event.type", value: { stringValue: "an_event_added_next_year" } },
      { key: "mandate.event.class", value: { stringValue: "S4" } },
      { key: "mandate.event.seq", value: { intValue: "2" } },
      { key: "mandate.event.hash", value: { stringValue: "sha256:2" } },
    ]);
  });

  it("names an event's span by its type when the type is shaped like one, and mandate.event when it is not", () => {
    const spans = project(facts([ev(1, "run_accepted"), ev(2, "Not A Type: with customer text")]), 0, 2, eventClass);
    expect(spans.map((s) => s.name)).toEqual(["run_accepted", "mandate.event"]);
    expect(attr(spans[1]!.attributes as Attrs, "mandate.event.type")).toBe("Not A Type: with customer text");
  });

  it("does not take a command id for an identifier unless it is shaped like one", () => {
    const hostile = "the customer's name is Jane Doe";
    const spans = project(facts([ev(1, "run_accepted"), ev(2, "command_dispatched", hostile), ev(3, "command_completed", hostile)], [cmd(hostile)]), 0, 3, eventClass);
    expect(JSON.stringify(spans)).not.toContain("Jane");
    for (const s of spans.filter((x) => attr(x.attributes as Attrs, "mandate.command") !== undefined)) expect(attr(s.attributes as Attrs, "mandate.command")).toMatch(/^sha256:[0-9a-f]{16}$/);
    // The span's id is still the spec's, of the command as it is, and the event spans are its children.
    const command = spans.find((s) => s.name === "mandate.tool")!;
    expect(command.spanId).toBe(spanId("r", hostile));
    expect(spans[1]!.parentSpanId).toBe(spanId("r", hostile));
  });

  it("takes the model an adapter reported only when the lock pins that model id, else the program's one tier's, else none", () => {
    const model = (locked: string | null, known: { sole: string | null; ids: string[] }) => {
      const events = [ev(1, "run_accepted"), { ...ev(2, "command_completed", "main/0"), locked }];
      const spans = project({ ...facts(events, [cmd("main/0", "turn", "dispatched")]), models: new Map([["sha256:p", { sole: known.sole, ids: new Set(known.ids) }]]) }, 0, 2, eventClass);
      return attr(spans.find((s) => s.name === "mandate.turn")!.attributes as Attrs, "gen_ai.request.model");
    };
    expect(model("claude-a", { sole: "claude-b", ids: ["claude-a", "claude-b", "claude-c"] })).toBe("claude-a");
    expect(model("a customer's secret text", { sole: "claude-b", ids: ["claude-b"] })).toBe("claude-b");
    expect(model("a customer's secret text", { sole: null, ids: ["claude-b", "claude-c"] })).toBeUndefined();
    expect(model(null, { sole: null, ids: [] })).toBeUndefined();
  });

  it("sends nothing for a window with no events, and no span of the run or a command before the event that ends it", () => {
    const f = facts([ev(1, "run_accepted"), ev(2, "command_dispatched", "c"), ev(3, "run_running")], [cmd("c")]);
    expect(project(f, 3, 3, eventClass)).toEqual([]);
    expect(named(project(f, 0, 3, eventClass))).toEqual(["run_accepted#1", "command_dispatched#2", "run_running#3"]);
  });

  it("sends a command's span once, in the window of its completion, from its first event to it, with its status", () => {
    const f = facts([ev(1, "run_accepted"), ev(2, "command_dispatched", "c"), ev(3, "command_throttled", "c"), ev(4, "command_completed", "c"), ev(5, "charge_settled", "c")], [cmd("c")]);
    const [one, two, three] = [project(f, 0, 2, eventClass), project(f, 2, 4, eventClass), project(f, 4, 5, eventClass)];
    expect(named(one)).toEqual(["run_accepted#1", "command_dispatched#2"]);
    expect(named(two)).toEqual(["command_throttled#3", "command_completed#4", "mandate.tool"]);
    // After it went out, an event that names the command is its own span, with the command's span as parent.
    expect(named(three)).toEqual(["charge_settled#5"]);
    expect(three[0]!.parentSpanId).toBe(spanId("r", "c"));
    const span = two[2]!;
    expect([span.startTimeUnixNano, span.endTimeUnixNano, span.status]).toEqual([String(1002n * 1_000_000n), String(1004n * 1_000_000n), { code: 1 }]);
    expect(attr(span.attributes as Attrs, "mandate.span.events")).toBe("3");
    expect(two[0]!.parentSpanId).toBe(span.spanId);
  });

  it("ends a command that never completed with the run, and the run's span with the event that ends it", () => {
    const f = facts([ev(1, "run_accepted"), ev(2, "command_dispatched", "c"), ev(3, "run_failed")], [cmd("c", "read", "dispatched")]);
    expect(named(project(f, 0, 2, eventClass))).toEqual(["run_accepted#1", "command_dispatched#2"]);
    const end = project(f, 2, 3, eventClass);
    expect(named(end)).toEqual(["run_failed#3", "mandate.read", "mandate.run"]);
    // No status for a command that did not complete; ERROR for a run that failed.
    expect(end[1]!.status).toBeUndefined();
    expect(end[2]!.status).toEqual({ code: 2 });
    expect(end[2]!.parentSpanId).toBeUndefined();
    expect(attr(end[2]!.attributes as Attrs, "mandate.span.events")).toBe("3");
  });

  it("ends a run with a terminal state and with no other: waiting, and attention required, are not ends", () => {
    for (const state of ["accepted", "running", "waiting", "cancelling", "attention_required"]) {
      expect(named(project(facts([ev(1, "run_accepted"), ev(2, `run_${state}`)]), 0, 2, eventClass)).includes("mandate.run"), state).toBe(false);
    }
    const status = (type: string) => project(facts([ev(1, "run_accepted"), ev(2, type)]), 0, 2, eventClass).find((s) => s.name === "mandate.run")?.status;
    expect(status("run_succeeded")).toEqual({ code: 1 });
    expect(status("run_failed")).toEqual({ code: 2 });
    // A cancelled run was stopped: it ends, and its status is left unset.
    expect(project(facts([ev(1, "run_accepted"), ev(2, "run_cancelled")]), 0, 2, eventClass).filter((s) => s.name === "mandate.run")).toHaveLength(1);
    expect(status("run_cancelled")).toBeUndefined();
  });

  it("sends the run's span once if the run were to end again, and a completion after the run's end is only an event", () => {
    const f = facts([ev(1, "run_accepted"), ev(2, "command_dispatched", "c"), ev(3, "run_succeeded"), ev(4, "run_running"), ev(5, "command_completed", "c"), ev(6, "run_failed")], [cmd("c")]);
    const all = [project(f, 0, 3, eventClass), project(f, 3, 6, eventClass)];
    expect(named(all[0]!)).toEqual(["run_accepted#1", "command_dispatched#2", "run_succeeded#3", "mandate.tool", "mandate.run"]);
    expect(named(all[1]!)).toEqual(["run_running#4", "command_completed#5", "run_failed#6"]);
    // The command ended with the run, as the first end it had.
    expect(all[0]![3]!.status).toBeUndefined();
    expect(all[0]![4]!.status).toEqual({ code: 1 });
  });

  it("puts the windows of an export at most `batch` spans each, and one event at least", () => {
    const f = facts([ev(1, "run_accepted"), ev(2, "command_dispatched", "a"), ev(3, "command_dispatched", "b"), ev(4, "run_succeeded")], [cmd("a", "read", "dispatched"), cmd("b", "read", "dispatched")]);
    // The end of the run is three more spans than its event.
    expect(windows(f, 0, 100)).toEqual([{ after: 0, upTo: 4 }]);
    expect(windows(f, 0, 4)).toEqual([{ after: 0, upTo: 3 }, { after: 3, upTo: 4 }]);
    expect(windows(f, 0, 1)).toEqual([{ after: 0, upTo: 1 }, { after: 1, upTo: 2 }, { after: 2, upTo: 3 }, { after: 3, upTo: 4 }]);
    expect(windows(f, 2, 100)).toEqual([{ after: 2, upTo: 4 }]);
    expect(windows(f, 4, 100)).toEqual([]);
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
    // The run's span went out once, with the event that ended the run, and not before.
    const roots = c.spans.filter((s) => s.name === "mandate.run");
    expect(roots).toHaveLength(1);
    expect(roots[0]!.status).toEqual({ code: 1 });
    expect(c.posts.slice(0, posts).some((p) => Collector.spansOf(p).some((s) => s.name === "mandate.run"))).toBe(false);
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
    const first = Collector.spansOf(c.posts[0]!).flatMap((s) => (attr(s.attributes, "mandate.event.seq") === undefined ? [] : [Number(attr(s.attributes, "mandate.event.seq"))]));
    expect(row!.seq).toBe(Math.max(...first));    c.answer = accept;
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
    expect(first.out).toMatch(/^run c1: events 1 to (\d+) sent in \1 spans\n$/);
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
