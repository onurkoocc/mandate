// What a package of 0.7 does differently with connectors (spec/attention.md "Carry-over from 0.6"), and what a package
// of 0.6 keeps doing:
//
// - the runtime binds the connectors the compiler says can be called (the `callable_connectors` door) and no others:
//   one that is declared and cannot be called needs no lock entry and no adapter, and a call of it is refused;
// - the digest of a tool a server lists is the compiler's (`tool_schema_digest`), and a tool the door refuses refuses
//   the connector's binding, with no fallback to the runtime's own function;
// - the runtime's `schemaDigest` and the door give the same digest for every tool of vectors/tool-digest and of the
//   test servers, which is what licenses the switch.
//
// Each test names the language it holds for; a package of 0.6 is the same package with its header read as 0.6. The
// servers are the fakes of fake-mcp.ts, reached through a transport the test gives in place of the egress proxy's
// gateways. No network; no secret.

import { CompilerFailure, withCompiler } from "@mandate/bridge/mode";
import { callableConnectors, check, load, toolSchemaDigest, type LibrarySource, type Lock, type Program } from "@mandate/bridge";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { baseOf, type WorkerChecker } from "../src/plan.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost, toolUse } from "../src/sim.js";
import { Connectors } from "../src/connectors.js";
import { McpClient, schemaDigest, type McpFetch } from "../src/mcp-client.js";
import { buildPackage, verifyPackage } from "../src/runtime.js";
import { Violation } from "../src/signals.js";
import type { Obj, Value } from "../src/values.js";
import { MODULES } from "../../bridge/test/wasm-bytes.js";
import { declaredErp, declaredMailbox, fakeErp, fakeMailbox, FakeMcp } from "./fake-mcp.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { leadChat } from "./planning.js";

afterAll(closeAll);

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const ERP = "acme.connectors.erp";
const MAIL = "acme.connectors.mailbox";
const KV = "example.kv.kv";
const KV_PLAN = "test.plan.kv";
const ZERO = `sha256:${"0".repeat(64)}`;

/** A program's text as the language says: its header. */
const as = (language: "0.6" | "0.7", text: string): string => text.replace(/^mandate @ 0\.[67]/m, `mandate @ ${language}`);

// ── a connector of the program's own module ─────────────────────────────

const KV_HEAD = `mandate @ 0.6

module example.kv @ 0.1

use std.{model, tool}

capability ModelStd = model.infer(tier: standard)

/// A store of words.
connector kv = mcp("https://kv.example.com/mcp")
  version "1.0"
  class   internal
{
  tool all() -> Untrusted<Map<Text, Text>>
    read_only
}
`;

/** A connector that nothing in the program can call: no capability names it. */
const UNCALLED = `${KV_HEAD}
/// Does nothing with the store.
workflow Hello() -> Int
  caps   ModelStd
  budget { time: 10m }
{
  1
}
`;

/** The same connector, called by the workflow through a capability. */
const CALLED = `${KV_HEAD}
capability Kv = tool.call(kv, all)

/// Reads the store.
workflow Read() -> Untrusted<Map<Text, Text>>
  caps   Kv
  budget { time: 10m }
{
  kv.all()
}
`;

const lockOf = (connectors: Record<string, { tools: Record<string, string> }> = {}): Lock =>
  ({ modules: {}, connectors: Object.fromEntries(Object.entries(connectors).map(([id, c]) => [id, { credential: "made-up", url: "https://kv.example.com/mcp", ...c }])) }) as unknown as Lock;

async function outcome(p: Promise<unknown>): Promise<{ ok: true; run: { state: string } } | { ok: false; code: string; message: string }> {
  try {
    return { ok: true, run: (await p) as { state: string } };
  } catch (e) {
    if (e instanceof Violation) return { ok: false, code: e.code, message: e.message };
    throw e;
  }
}

describe("a connector nothing can call", () => {
  it("(0.7) needs no lock entry and no adapter: the run starts and runs", async () => {
    const w = await world(as("0.7", UNCALLED), { lock: lockOf(), decisions: { mode: "signed" } });
    expect(w.adapters.connectors).toBeUndefined();
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "u7" });
    expect(r.state).toBe("succeeded");
    expect(r.result).toBe(1);
    // Nor does an entry for it, that nothing asks, need an adapter.
    const w2 = await world(as("0.7", UNCALLED), { lock: lockOf({ [KV]: { tools: { all: ZERO } } }), decisions: { mode: "signed" } });
    expect((await w2.rt.startRun({ pkg: w2.pkg, workflow: "Hello", input: {}, runId: "u7b" })).state).toBe("succeeded");
  });

  it("(0.6) is bound all the same, so the run is refused for its missing lock entry (bad_connector), as before", async () => {
    const w = await world(as("0.6", UNCALLED), { lock: lockOf(), decisions: { mode: "signed" } });
    const r = await outcome(w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "u6" }));
    expect(r).toMatchObject({ ok: false, code: "bad_connector" });
    expect((r as { message: string }).message).toContain("the package's lock has no connectors entry for it (MDT-E1407)");
    // With an entry it is bound, and the run then wants a way out for the connector's requests.
    const w2 = await world(as("0.6", UNCALLED), { lock: lockOf({ [KV]: { tools: { all: ZERO } } }), decisions: { mode: "signed" } });
    expect(await outcome(w2.rt.startRun({ pkg: w2.pkg, workflow: "Hello", input: {}, runId: "u6b" }))).toMatchObject({ ok: false, code: "no_egress_for_connector" });
  });

  it("(0.7) a connector that can be called and has no lock entry is refused, as in 0.6", async () => {
    const refused: Array<{ code: string; message: string }> = [];
    for (const language of ["0.6", "0.7"] as const) {
      const w = await world(as(language, CALLED), { lock: lockOf(), decisions: { mode: "signed" } });
      const r = await outcome(w.rt.startRun({ pkg: w.pkg, workflow: "Read", input: {}, runId: `c${language}` }));
      expect(r.ok).toBe(false);
      refused.push(r as { code: string; message: string });
    }
    // The check of the package refuses it, as it does a package of 0.6: the lock binds no connector it can call (E1407).
    expect(refused[0]!.code).toBe("load_verification_failed");
    expect(refused[0]!.message).toContain("MDT-E1407");
    expect(refused[1]).toEqual(refused[0]);
  });

  it("(0.7) a design run of one that can be called is as before: nothing is reached", async () => {
    const w = await world(as("0.7", CALLED), { lock: lockOf({ [KV]: { tools: { all: ZERO } } }), decisions: { mode: "signed" } });
    w.adapters.samples = { tool: () => ({ result: { a: "x" } }) } as never;
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Read", input: {}, runId: "d7", mode: "design" });
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
  });
});

describe("a call of a connector that was not bound (0.7)", () => {
  /** The runtime believes nothing can be called, as a compiler that disagreed with itself would have it say. */
  const nothingCallable = (w: World): void => void vi.spyOn(w.rt as unknown as { callableOf(): ReadonlySet<string> }, "callableOf").mockReturnValue(new Set());

  it("stops the run with a violation (bad_connector): not a crash, not a late binding, and no request is sent", async () => {
    const w = await world(as("0.7", CALLED), { lock: lockOf({ [KV]: { tools: { all: ZERO } } }), decisions: { mode: "signed" } });
    nothingCallable(w);
    let reached = 0;
    w.adapters.connectors = { fetch: () => async () => ((reached += 1), new Response("{}")) } as never;
    w.adapters.samples = { tool: () => ({ result: { a: "x" } }) } as never;
    const live = await outcome(w.rt.startRun({ pkg: w.pkg, workflow: "Read", input: {}, runId: "n1" }));
    const design = await outcome(w.rt.startRun({ pkg: w.pkg, workflow: "Read", input: {}, runId: "n2", mode: "design" }));
    // The run stops at the call, as a violation (it is neither a crash nor a binding made late), in a live run and in a design one, whose sample is not given in its place.
    for (const r of [live, design]) {
      expect(r.ok).toBe(true);
      const run = (r as unknown as { run: { state: string; result: unknown; attention: { violation: string; message: string } } }).run;
      expect(run.state).toBe("attention_required");
      expect(run.result).toBeNull();
      expect(run.attention.violation).toBe("bad_connector");
      expect(run.attention.message).toContain("nothing in the package can call it");
    }
    expect(reached).toBe(0);
  });

  it("is refused by the connectors: a tool, a write and a name that is declared are not bound", async () => {
    const r = check(as("0.7", CALLED), "mdt", { linked: true });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const c = new Connectors({ program: r.linked as unknown as Program, lock: lockOf(), callable: new Set() });
    expect(c.any).toBe(false);
    expect(c.names()).toEqual([]);
    expect(c.credentials()).toEqual([]);
    // It is a name the program declares, so that a call of it is not read as anything else (a configured adapter's).
    expect(c.has("kv")).toBe(true);
    expect(c.splits("kv.all")).toEqual({ connector: "kv", tool: "all" });
    for (const f of [() => c.tool("kv", "all"), () => c.write("kv.all")]) expect(f).toThrow(expect.objectContaining({ code: "bad_connector" }));
    expect(c.offered([])).toEqual({ specs: [], byName: new Map(), refused: [] });
    expect(() => c.bindAll()).not.toThrow();
    // A connector that is not declared at all is as it was.
    expect(c.has("other")).toBe(false);
    expect(() => c.tool("other", "all")).toThrow(/No connector 'other'/);
    // The same program with it named binds it.
    const bound = new Connectors({ program: r.linked as unknown as Program, lock: lockOf({ [KV]: { tools: { all: ZERO } } }), callable: new Set([KV]) });
    expect(bound.names()).toEqual([KV]);
    expect(bound.tool("kv", "all").full).toBe(KV);
  });
});

// ── connectors of another module, and which the compiler names ──────────

const fixtureLibrary = (): LibrarySource => {
  const manifest = read("fixtures/library/acme.connectors/mandate.library.json");
  return { manifest, files: Object.fromEntries((JSON.parse(manifest).modules as string[]).map((f) => [f, read(`fixtures/library/acme.connectors/${f}`)])) };
};

const LIBRARY_HEAD = `mandate @ 0.7

module acme.finance.run @ 0.1

use std.{model, tool}
use acme.connectors.{erp, mailbox}
use acme.connectors.types.{Invoice, Match}

capability Inbox    = tool.call(mailbox, list_invoices)
capability ErpRead  = tool.call(erp, list_open_orders)
capability ModelStd = model.infer(tier: standard, max_class: confidential)
`;

/** Only a workflow holds a capability of a connector of another module: the mailbox. */
const BY_WORKFLOW = `${LIBRARY_HEAD}
/// Lists the invoices in the mailbox.
workflow Waiting() -> Untrusted<List<Invoice>>
  caps   Inbox
  budget { time: 10m }
{
  mailbox.list_invoices()
}
`;

/** Only an agent holds one, the ERP's; the workflow holds none and never delegates. */
const BY_AGENT = `${LIBRARY_HEAD}
agent Matcher {
  role   "Matches one invoice to an open order of its vendor. Writes nothing."
  caps   ErpRead, ModelStd
  budget { tokens: 60k, spend: 0.30 USD, steps: 6 }
  skill match(inv: Untrusted<Invoice>) -> Inferred<Match> ! {Tool, Model}
}

/// Does nothing.
workflow Hello() -> Int
  caps   ModelStd
  budget { time: 10m }
{
  1
}
`;

interface Hosts {
  erp: ReturnType<typeof declaredErp>;
  mailbox: ReturnType<typeof declaredMailbox>;
  /** The hosts a `tools/list` was sent to, in order. */
  listed: string[];
  transport: { fetch(gateway: { spec: { host: string } }): McpFetch };
}

function hosts(): Hosts {
  const erp = declaredErp();
  const mailbox = declaredMailbox();
  const h: Hosts = {
    erp,
    mailbox,
    listed: [],
    transport: {
      fetch: (gateway) => async (url, init) => {
        const server = gateway.spec.host === erp.host ? erp : mailbox;
        if (typeof init.body === "string" && init.body.includes('"method":"tools/list"')) h.listed.push(gateway.spec.host);
        return server.fetch(url, init);
      },
    },
  };
  return h;
}

const digestsOf = async (f: FakeMcp): Promise<Record<string, string>> => Object.fromEntries((await new McpClient({ url: `https://${f.host}/mcp`, fetch: f.fetch as McpFetch }).listTools()).map((t) => [t.name, t.digest]));

async function libraryWorld(src: string, h: Hosts, entries: Array<"erp" | "mailbox">): Promise<World> {
  const fixture = JSON.parse(read("fixtures/library/invoices.lock.json")) as Lock;
  const lock = {
    modules: {},
    libraries: { "acme.connectors": fixture.libraries!["acme.connectors"]! },
    connectors: {
      ...(entries.includes("erp") ? { [ERP]: { credential: "acme_erp", url: "https://erp.acme.example/mcp", tools: await digestsOf(h.erp) } } : {}),
      ...(entries.includes("mailbox") ? { [MAIL]: { credential: "acme_mail", url: "https://mail.acme.example/mcp", header: "x-api-key", template: "{secret}", tools: await digestsOf(h.mailbox) } } : {}),
    },
  } as unknown as Lock;
  const w = await world(src, { libraries: [fixtureLibrary()], lock, decisions: { mode: "signed" } });
  w.adapters.connectors = h.transport as never;
  return w;
}

describe("a connector of another module (0.7)", () => {
  it("is bound when a workflow's tool.call capability names it, and the one nothing names is not", async () => {
    const h = hosts();
    const w = await libraryWorld(BY_WORKFLOW, h, ["mailbox"]);
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Waiting", input: {}, runId: "m1" });
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
    // The ERP is declared in the running program (the program imports it) and has no lock entry; only the mailbox was asked.
    expect(verifyPackage(w.pkg).running.defs["erp"]).toMatchObject({ kind: "connector" });
    expect([...new Set(h.listed)]).toEqual([h.mailbox.host]);
  });

  it("is bound when an agent's tool.call capability names it, though no workflow's does", async () => {
    const h = hosts();
    const w = await libraryWorld(BY_AGENT, h, ["erp"]);
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "m2" });
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
    expect([...new Set(h.listed)]).toEqual([h.erp.host]);
  });

  it("is refused when it can be called and has no entry, and in 0.6 so is the one nothing can call", async () => {
    const h = hosts();
    const none = await libraryWorld(BY_WORKFLOW, h, []);
    expect(await outcome(none.rt.startRun({ pkg: none.pkg, workflow: "Waiting", input: {}, runId: "m3" }))).toMatchObject({ ok: false, code: "load_verification_failed", message: expect.stringContaining("MDT-E1407") });
    const agent = await libraryWorld(BY_AGENT, h, []);
    expect(await outcome(agent.rt.startRun({ pkg: agent.pkg, workflow: "Hello", input: {}, runId: "m4" }))).toMatchObject({ ok: false, code: "load_verification_failed", message: expect.stringContaining("MDT-E1407") });
    // As a package of 0.6: both connectors are bound, and the one only the mailbox's workflow leaves alone needs its entry.
    const old = await libraryWorld(as("0.6", BY_WORKFLOW), h, ["mailbox"]);
    const r = await outcome(old.rt.startRun({ pkg: old.pkg, workflow: "Waiting", input: {}, runId: "m5" }));
    expect(r).toMatchObject({ ok: false, code: "bad_connector", message: expect.stringContaining(ERP) });
    expect(h.listed).toEqual([]);
  });

  it("is named by the compiler as the package has it: the program and its modules, not the running program", async () => {
    const h = hosts();
    const w = await libraryWorld(BY_AGENT, h, ["erp"]);
    const running = verifyPackage(w.pkg);
    const modules = running.modules;
    expect(callableConnectors(w.pkg.program, modules)).toEqual([{ id: ERP, name: "erp" }]);
    // The running program holds the library's own workflows, agents and capabilities too, which the check does not count.
    expect(Object.keys(running.running.defs).length).toBeGreaterThan(Object.keys(w.pkg.program.defs).length);
    expect(callableConnectors(running.running, modules).map((c) => c.id).sort()).not.toEqual([]);
  });
});

// ── the digest ──────────────────────────────────────────────────────────

/** `n` levels of `{ "type": "object", "properties": { "k": … } }`. */
function nested(n: number): Value {
  let v: Value = { type: "string" };
  for (let i = 0; i < n; i++) v = { type: "object", properties: { k: v } };
  return v;
}

const QUIET_AGENT = `${LIBRARY_HEAD}
agent Matcher {
  role   "Matches one invoice to an open order of its vendor. Writes nothing."
  caps   ErpRead, ModelStd
  budget { tokens: 60k, spend: 0.30 USD, steps: 6 }
  skill match(inv: Untrusted<Invoice>) -> Inferred<Match> ! {Tool, Model}
}

/// Does nothing.
workflow Hello() -> Int
  caps   ModelStd
  budget { time: 10m }
{
  1
}
`;

describe("the digest of a tool a server lists", () => {
  /** A tool the door refuses: what it says for one that nests deeper than 512 levels. The client reads no answer deeper than 128, so a test double stands for the server that cannot be made to list one. */
  const REFUSES = MODULES.answering(JSON.stringify({ ok: false, error: { kind: "bad_input", message: "`tool` is not the JSON text of a tool: it nests deeper than 512 levels" } }));

  async function agentWorld(language: "0.6" | "0.7", more: (h: Hosts) => void = () => undefined) {
    const h = hosts();
    more(h);
    // The lock pins what the runtime's own function gives for the tools, as `mandate connector pin` of 0.6 wrote it (a package of 0.6 binds the mailbox too).
    return { h, w: await libraryWorld(as(language, QUIET_AGENT), h, language === "0.6" ? ["erp", "mailbox"] : ["erp"]) };
  }

  it("(0.7) refuses the binding of a connector when the door refuses a tool it lists, and never falls back to the runtime's own digest", async () => {
    const { h, w } = await agentWorld("0.7");
    // The lock pins the runtime's digest of every tool: a fallback to the runtime's function would match it and start the run.
    expect(w.pkg.lock.connectors![ERP]!.tools).toEqual(await digestsOf(h.erp));
    const refused = await withCompiler(() => outcome(w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "g1" })), { doors: { tool_schema_digest: REFUSES } });
    expect(refused).toMatchObject({ ok: false, code: "tool_schema_mismatch" });
    const message = (refused as { message: string }).message;
    expect(message).toContain(ERP);
    expect(message).toMatch(/list_open_orders|find_draft_invoice|post_draft_invoice/);
    expect(message).toContain("nests deeper than 512 levels");
    expect(message).toContain("so it cannot be pinned or matched");
    expect(await w.db.query("select 1 as x from runs where run_id = 'g1'")).toEqual([]);
    // The same package, the door answering, starts.
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "g1b" })).state).toBe("succeeded");
  });

  it("(0.7) a failure of the compiler on the door is not read as a pass either, nor as a refusal of the tool: it goes up as the failure it is", async () => {
    const { w } = await agentWorld("0.7");
    await expect(withCompiler(() => w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "g4" }), { doors: { tool_schema_digest: MODULES.trap() } })).rejects.toBeInstanceOf(CompilerFailure);
    expect(await w.db.query("select 1 as x from runs where run_id = 'g4'")).toEqual([]);
  });

  it("(0.6) takes the runtime's own digest: the door is not asked, and the run starts", async () => {
    const { w } = await agentWorld("0.6");
    const r = await withCompiler(() => w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "g2" }), { doors: { tool_schema_digest: REFUSES, callable_connectors: REFUSES } });
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
  });

  it("(0.7) a large tool the door takes is digested by the compiler, and the lock's digest is the one both give", async () => {
    const { w } = await agentWorld("0.7", (h) => h.erp.changeSchema("list_open_orders", (schema) => ({ ...schema, "x-pad": "a".repeat(900_000) })));
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Hello", input: {}, runId: "g3" });
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
  });

  it("(0.7) a tool nested deeper than 512 levels is refused by the door, and by the binding; the client's own limit of 128 stops one before it", () => {
    expect(() => toolSchemaDigest(JSON.stringify({ name: "t", inputSchema: nested(600) }))).toThrow(/512/);
    const r = check(as("0.7", CALLED), "mdt", { linked: true });
    const c = new Connectors({ program: r.linked as unknown as Program, lock: lockOf({ [KV]: { tools: { all: ZERO } } }), callable: new Set([KV]) });
    const digest = (t: unknown): string => (c as unknown as { compilerDigest(b: { full: string }, t: unknown): string }).compilerDigest({ full: KV }, t);
    expect(digest({ name: "all", inputSchema: nested(100) })).toBe(schemaDigest({ name: "all", inputSchema: nested(100) }));
    let thrown: unknown;
    try {
      digest({ name: "all", inputSchema: nested(600) });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Violation);
    expect(thrown).toMatchObject({ code: "tool_schema_mismatch", message: expect.stringContaining("nests deeper than 512 levels") });
  });
});

// ── what licenses the switch ────────────────────────────────────────────

describe("the runtime's schemaDigest and the compiler's door give the same digest", () => {
  const vectors = JSON.parse(read("vectors/tool-digest/tool-schema-digest.json")) as {
    vectors: Array<{ name: string; tool: string; canonical: string; digest: string }>;
    refused: Array<{ name: string; tool: string; why: string }>;
  };

  it("for every tool of vectors/tool-digest, as the runtime holds it (the text parsed, written again, and digested)", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(34);
    for (const v of vectors.vectors) {
      const held = JSON.parse(v.tool) as { name: string; inputSchema: Value; outputSchema?: Value };
      expect(toolSchemaDigest(JSON.stringify(held)), v.name).toBe(schemaDigest(held));
      expect(schemaDigest(held), v.name).toBe(v.digest);
      // The text as the server wrote it gives it too.
      expect(toolSchemaDigest(v.tool), v.name).toBe(v.digest);
    }
  });

  it("refuses each text the vectors say must be refused", () => {
    expect(vectors.refused.length).toBeGreaterThanOrEqual(29);
    for (const r of vectors.refused) expect(() => toolSchemaDigest(r.tool), `${r.name}: ${r.why}`).toThrow(Error);
  });

  it("for every tool the test servers of the suite list", async () => {
    let compared = 0;
    for (const server of [declaredErp(), declaredMailbox(), fakeErp(), fakeMailbox(), new FakeMcp("x.example").tool({ name: "t", title: "T", description: "d", inputSchema: { type: "object", properties: { é: { type: "number", minimum: 1.5 }, a: { type: "string" } } }, outputSchema: { type: "object" }, annotations: { readOnlyHint: true }, write: false, run: () => ({ structured: {}, text: "" }) })]) {
      const listed = await new McpClient({ url: `https://${server.host}/mcp`, fetch: server.fetch as McpFetch }).listTools();
      expect(listed.length).toBeGreaterThan(0);
      for (const t of listed) {
        const { digest, ...held } = t;
        expect(toolSchemaDigest(JSON.stringify(held)), `${server.host} ${t.name}`).toBe(digest);
        expect(digest).toBe(schemaDigest(held));
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThanOrEqual(10);
  });

  it("when a client is given the compiler's digest it lists the same digests, and never calls the runtime's function", async () => {
    const server = declaredErp();
    const asked: string[] = [];
    const listed = await new McpClient({ url: `https://${server.host}/mcp`, fetch: server.fetch as McpFetch, digest: (t) => (asked.push(t.name), toolSchemaDigest(JSON.stringify(t))) }).listTools();
    expect(asked).toEqual(listed.map((t) => t.name));
    expect(listed.map((t) => t.digest)).toEqual((await new McpClient({ url: `https://${server.host}/mcp`, fetch: server.fetch as McpFetch }).listTools()).map((t) => t.digest));
  });
});

// A package of 0.6 is built with no door: its binding does not ask the compiler anything.
describe("a package of 0.6", () => {
  it("binds as before: the compiler's doors are not asked", async () => {
    const w = await world(as("0.6", CALLED), { lock: lockOf({ [KV]: { tools: { all: ZERO } } }), decisions: { mode: "signed" } });
    const asked = vi.spyOn(w.rt as unknown as { callableOf(): unknown }, "callableOf");
    w.adapters.samples = { tool: () => ({ result: { a: "x" } }) } as never;
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Read", input: {}, runId: "z6", mode: "design" });
    expect(r.state, JSON.stringify(r.error)).toBe("succeeded");
    expect(asked).toHaveBeenCalled();
    expect(asked.mock.results.every((x) => x.type === "return" && x.value === undefined)).toBe(true);
    expect(buildPackage(w.pkg.program as never, w.pkg.lock).hash).toBe(w.pkg.hash);
  });
});

// ── a lead's sub-program ────────────────────────────────────────────────

/**
 * A parent whose envelope grants the connector's tool and whose workflow has no `caps` of its own: the connector can be
 * called only through the envelope's capability, by a sub-program its lead submits (`plan … within envelope`).
 */
const PLANNING = `mandate @ 0.7

module test.plan @ 0.1

use std.{model, tool}

role platform_lead "Platform lead"

type Item = { name: Text }

/// A store of words.
connector kv = mcp("https://kv.example.com/mcp")
  version "1.0"
  class   internal
{
  tool all() -> Untrusted<Map<Text, Text>>
    read_only
}

capability Kv       = tool.call(kv, all)
capability ModelStd = model.infer(tier: standard)

agent Lead {
  role   "Plans what is left."
  caps   ModelStd
  budget { tokens: 60k, steps: 30 }
  skill finish(items: List<Item>) -> Inferred<Text> ! {Model}
}

workflow W(items: List<Item>) -> Inferred<Text>
  envelope {
    owner   platform_lead
    caps    ModelStd, Kv
    budget  { tokens: 200k, steps: 400, agents: 12 }
  }
{
  plan Lead.finish(items) within envelope
}
`;

/** The sub-program the lead sends: a workflow that reads the store. */
const SUB = `mandate @ 0.7

module test.plan.plan_1 @ 0.1

use test.plan

workflow Read() -> Untrusted<Map<Text, Text>>
  caps   Kv
  budget { tokens: 20k, steps: 40, agents: 4, time: 10m }
{
  kv.all()
}
`;

describe("a lead's sub-program (0.7)", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(async () => {
    await checker.close();
  });

  it("calls a connector the parent's envelope grants: the door counts the envelope's capability, so the connector is bound", async () => {
    const alice = EvidenceSigner.generate();
    const lock = { modules: {}, members: { alice: { keys: [alice.keyId] } }, roles: { platform_lead: ["alice"] }, connectors: { [KV_PLAN]: { credential: "made-up", url: "https://kv.example.com/mcp", tools: { all: ZERO } } } } as unknown as Lock;
    const w = await world(PLANNING, { lock, decisions: { keys: new TrustedKeys([alice.publicKey]) }, plan: { checker } });
    // The compiler counts it, though no workflow's own `caps` and no agent's names it.
    expect(callableConnectors(w.pkg.program, w.pkg.modules)).toEqual([{ id: KV_PLAN, name: "kv" }]);
    const ops = Object.entries(load(SUB, "mdt").program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
    const { chat } = leadChat([[toolUse("s1", "submit_program", { base: baseOf("test.plan", 1, "mandate/0.7" as never), ops })], [toolUse("done", "finish", { result: "done" })]]);
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    w.adapters.samples = { tool: () => ({ result: { a: "x" } }) } as never;
    await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "W", input: { items: [{ name: "a" }] }, runId: "p7", mode: "design" });
    expect(r.state, JSON.stringify(r.error ?? r.attention)).toBe("succeeded");
    // The sub-program's read of the store ran, from the sample: its tool is in the journal.
    const reads = (await w.db.query("select command_id, label, result, inside from commands where run_id = 'p7' and kind = 'read'")) as Array<{ command_id: string; label: string; result: unknown; inside: string | null }>;
    expect(reads).toEqual([expect.objectContaining({ label: "tool kv.all", result: { a: "x" }, inside: "/defs/W/body/0/value/program/1" })]);
  });
});
