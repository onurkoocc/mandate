// The Node MCP server of language 0.7 (bridge/src/mcp.ts, slice B9): the tool list is the Rust door `mcp_tools`'s, as the
// native `mandate mcp` serves it; up to 0.6 it is the frozen list, byte for byte; no tool signs, approves, decides or
// promotes (an allow-list test, for every language); and the tools do what language 0.7 adds. The conversations
// `vectors/mcp/*-0.7.json` (written by scripts/mcp-vectors.mjs from this server) are replayed by the native server's tests,
// which holds the two servers to each other.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, hashProgram, load, mcpTools, type LibrarySource } from "../src/index.js";
import { McpServer, TOOLS, callTool } from "../src/mcp.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string): string => readFileSync(root + p, "utf8");
const json = (p: string): Record<string, unknown> => JSON.parse(read(p)) as Record<string, unknown>;
const V = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
const modern = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: V } });
const tool = (id: number, name: string, args: Record<string, unknown>) => modern(id, "tools/call", { name, arguments: args });

const CONNECTORS = "fixtures/library/acme.connectors/";
const ACME: LibrarySource = { manifest: read(`${CONNECTORS}mandate.library.json`), files: { "connectors.mdt": read(`${CONNECTORS}connectors.mdt`), "types.mdt": read(`${CONNECTORS}types.mdt`) } };
const INVOICES = read("fixtures/attention/invoices.mdt");
const LOCK = json("fixtures/attention/invoices.lock.json");
const DRAFT = INVOICES.replace("asks: 2", "asks: 1");

const LANGUAGES_UP_TO_06 = ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4", "mandate/0.5", "mandate/0.6"];
const ALL_LANGUAGES = [...LANGUAGES_UP_TO_06, "mandate/0.7"];

type Tool = { name: string; title?: string; description?: string; inputSchema?: Record<string, unknown> };

/** What the server of `language` answers to `tools/list`, in the modern era. */
function listed(language: string | undefined): { tools: Tool[]; ttlMs: unknown; cacheScope: unknown } {
  const r = new McpServer({}, language).handle(modern(1, "tools/list")) as { result: { tools: Tool[]; ttlMs: unknown; cacheScope: unknown } };
  return r.result;
}

/** What one call answers: the structured content, or the text of a tool error, or the protocol error's message. */
function call(language: string, name: string, args: Record<string, unknown>): { ok: unknown } | { toolError: string } | { error: string } {
  const r = new McpServer({}, language).handle(tool(1, name, args)) as { result?: { structuredContent?: unknown; isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
  if (r.error) return { error: r.error.message };
  if (r.result!.isError) return { toolError: r.result!.content[0]!.text };
  return { ok: r.result!.structuredContent };
}

// The tools of the allow-list, and for each the parameters it may take, by language. A tool or a parameter that is not
// here is not allowed: adding one means changing this table, in review.
const READ = ["source", "kind", "modules"];
const ALLOWED_UP_TO_06: Record<string, string[]> = {
  "mandate.check": [...READ, "lock"],
  "mandate.explain": ["code"],
  "mandate.apply_patch": [...READ, "base", "ops"],
  "mandate.caps_of": [...READ, "name"],
  "mandate.project": [...READ, "view", "before", "before_kind", "lock"],
  "mandate.spec": ["section"],
};
const ALLOWED_0_7: Record<string, string[]> = {
  "mandate.check": [...READ, "lock", "libraries"],
  "mandate.explain": ["code"],
  "mandate.apply_patch": [...READ, "base", "ops", "lock", "libraries"],
  "mandate.caps_of": [...READ, "name", "lock", "libraries"],
  "mandate.project": [...READ, "view", "before", "before_kind", "workflow", "lock", "libraries"],
  "mandate.spec": ["section"],
};
const allowedFor = (language: string): Record<string, string[]> => (language === "mandate/0.7" ? ALLOWED_0_7 : ALLOWED_UP_TO_06);

/** Words no tool's name, title or description (but for the one sentence that says a person approves) may hold: a tool authors and checks, it never decides for anyone. */
const FORBIDDEN_WORDS = /\b(sign|signs|signed|signing|signature|approve|approves|approved|approval|approvals|decide|decides|decided|decision|decisions|promote|promotes|promoted|promotion|endorse|endorses)\b/i;
const THE_ONE_SENTENCE = "those need a person's approval";
/** Substrings no parameter's name may hold: no tool takes a key, a secret or a credential. */
const FORBIDDEN_PARAMETERS = ["key", "secret", "credential", "password", "signature", "private", "token", "approv", "sign"];
/** The enumerations that are the model's to extend: the views. */
const VIEWS_0_7 = ["architecture", "authority", "cost", "diff", "card", "attention"];

/** What is wrong with `tools` as the list of `language`: empty when nothing is. */
function problemsWith(tools: Tool[], language: string): string[] {
  const allowed = allowedFor(language);
  const problems: string[] = [];
  const names = tools.map((t) => t.name);
  for (const n of names) if (!(n in allowed)) problems.push(`tool ${n} is not allowed`);
  for (const n of Object.keys(allowed)) if (!names.includes(n)) problems.push(`tool ${n} is missing`);
  if (new Set(names).size !== names.length) problems.push("a tool is listed twice");
  for (const t of tools) {
    const text = `${t.name} ${t.title ?? ""} ${(t.description ?? "").replace(THE_ONE_SENTENCE, "")}`;
    const bad = FORBIDDEN_WORDS.exec(text);
    if (bad) problems.push(`${t.name}: its name, title or description says "${bad[0]}"`);
    const schema = t.inputSchema as { type?: unknown; properties?: Record<string, { enum?: string[] }>; required?: string[]; additionalProperties?: unknown } | undefined;
    if (!schema || schema.type !== "object") {
      problems.push(`${t.name}: no object schema`);
      continue;
    }
    if (schema.additionalProperties !== false) problems.push(`${t.name}: the schema takes properties it does not name`);
    const props = Object.keys(schema.properties ?? {});
    const may = allowed[t.name] ?? [];
    for (const p of props) {
      if (!may.includes(p)) problems.push(`${t.name}: parameter ${p} is not allowed`);
      const found = FORBIDDEN_PARAMETERS.find((w) => p.toLowerCase().includes(w));
      if (found) problems.push(`${t.name}: parameter ${p} holds "${found}"`);
    }
    for (const p of may) if (!props.includes(p)) problems.push(`${t.name}: parameter ${p} is missing`);
    for (const r of schema.required ?? []) if (!props.includes(r)) problems.push(`${t.name}: required ${r} is not a parameter`);
    const view = schema.properties?.["view"]?.enum;
    if (t.name === "mandate.project" && language === "mandate/0.7" && JSON.stringify(view) !== JSON.stringify(VIEWS_0_7)) problems.push(`${t.name}: the views are ${JSON.stringify(view)}`);
  }
  return problems;
}

describe("the tool list of each language", () => {
  it("is the frozen list, byte for byte, for every language up to 0.6, and the door's", () => {
    for (const language of LANGUAGES_UP_TO_06) {
      const door = mcpTools(language);
      expect(door.language).toBe(language);
      expect(JSON.stringify(door.tools), language).toBe(JSON.stringify(TOOLS));
      expect(JSON.stringify(listed(language)), language).toBe(JSON.stringify(listed(undefined)));
    }
    // With no language, the server serves the frozen list as it always did.
    const bare = listed(undefined);
    expect(JSON.stringify(bare.tools)).toBe(JSON.stringify(TOOLS));
    expect(bare.ttlMs).toBe(3_600_000);
    expect(bare.cacheScope).toBe("public");
  });

  it("is the door's list for 0.7, in both eras, and it is not the frozen list", () => {
    const door = mcpTools("mandate/0.7");
    expect(JSON.stringify(door.tools)).not.toBe(JSON.stringify(TOOLS));
    expect(door.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    const m = listed("mandate/0.7");
    expect(JSON.stringify(m.tools)).toBe(JSON.stringify(door.tools));
    expect(m.ttlMs).toBe(door.modern.ttlMs);
    expect(m.cacheScope).toBe(door.modern.cacheScope);
    const s = new McpServer({}, "mandate/0.7");
    s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const legacy = s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: Record<string, unknown> };
    expect(JSON.stringify(legacy.result)).toBe(JSON.stringify({ tools: door.tools }));
  });

  it("is refused for a language the compiler does not know", () => {
    expect(() => new McpServer({}, "mandate/9.9")).toThrow();
  });
});

describe("the allow-list", () => {
  it("holds for the tools of every language, as the server lists them", () => {
    for (const language of ALL_LANGUAGES) expect(problemsWith(listed(language).tools, language), language).toEqual([]);
    expect(problemsWith(TOOLS as unknown as Tool[], "mandate/0.6")).toEqual([]);
  });

  it("fails on a tool, a parameter or a word that is not allowed (the test tests itself)", () => {
    const base = (): Tool[] => JSON.parse(JSON.stringify(listed("mandate/0.7").tools)) as Tool[];
    const withTool = (t: Tool): Tool[] => [...base(), t];
    const schema = (props: string[]): Record<string, unknown> => ({ type: "object", properties: Object.fromEntries(props.map((p) => [p, { type: "string" }])), additionalProperties: false });
    for (const name of ["mandate.sign", "mandate.approve", "mandate.approve_envelope", "mandate.decide", "mandate.promote", "mandate.run", "mandate.publish"]) {
      expect(problemsWith(withTool({ name, title: "x", description: "x", inputSchema: schema([]) }), "mandate/0.7"), name).not.toEqual([]);
    }
    const drop = base().filter((t) => t.name !== "mandate.spec");
    expect(problemsWith(drop, "mandate/0.7")).toContain("tool mandate.spec is missing");
    const extra = base();
    (extra[0]!.inputSchema as { properties: Record<string, unknown> }).properties["approved_by"] = { type: "string" };
    expect(problemsWith(extra, "mandate/0.7")).toContain("mandate.check: parameter approved_by is not allowed");
    const key = base();
    (key[0]!.inputSchema as { properties: Record<string, unknown> }).properties["signing_key"] = { type: "string" };
    expect(problemsWith(key, "mandate/0.7").join("\n")).toContain('parameter signing_key holds "key"');
    const open = base();
    (open[1]!.inputSchema as { additionalProperties: unknown }).additionalProperties = true;
    expect(problemsWith(open, "mandate/0.7")).toContain("mandate.explain: the schema takes properties it does not name");
    const words = base();
    words[2]!.description += " The result is approved and signed by the server.";
    expect(problemsWith(words, "mandate/0.7").join("\n")).toContain("says");
    const promote = base();
    promote[3]!.title = "Promote an agent";
    expect(problemsWith(promote, "mandate/0.7").join("\n")).toContain('says "Promote"');
    // A parameter of 0.7 is not allowed for a language before it.
    expect(problemsWith(listed("mandate/0.7").tools, "mandate/0.6")).not.toEqual([]);
    // The views of 0.7 are the six, in this order.
    const views = base();
    ((views[4]!.inputSchema as { properties: Record<string, { enum: string[] }> }).properties["view"]!.enum).push("promote");
    expect(problemsWith(views, "mandate/0.7").join("\n")).toContain("the views are");
  });

  it("is also what a call of a tool that is not listed gets: an unknown tool (-32602), in every language", () => {
    for (const language of ALL_LANGUAGES) {
      for (const name of ["mandate.sign", "mandate.approve", "mandate.approve_envelope", "mandate.decide", "mandate.promote", "mandate.run", "sign", "approve"]) {
        expect(call(language, name, {}), `${language} ${name}`).toEqual({ error: `Unknown tool: ${name}` });
      }
    }
  });

  it("names no tool the 0.7 server runs beyond the six", () => {
    expect(listed("mandate/0.7").tools.map((t) => t.name).sort()).toEqual(["mandate.apply_patch", "mandate.caps_of", "mandate.check", "mandate.explain", "mandate.project", "mandate.spec"]);
  });
});

describe("what the tools of 0.7 do", () => {
  it("check takes the libraries a lock pins, and without them the pin is E1605", () => {
    const withLibraries = call("mandate/0.7", "mandate.check", { source: INVOICES, lock: LOCK, libraries: [ACME] }) as { ok: { ok: boolean } };
    expect(withLibraries.ok.ok).toBe(true);
    const without = call("mandate/0.7", "mandate.check", { source: INVOICES, lock: LOCK }) as { ok: { ok: boolean; diagnostics: Array<{ code: string }> } };
    expect(without.ok.ok).toBe(false);
    expect(without.ok.diagnostics.map((d) => d.code)).toContain("MDT-E1605");
    // The same check as the library function the CLI uses.
    expect((withLibraries.ok as unknown as { hashes: unknown }).hashes).toEqual(check(INVOICES, "mdt", { lock: LOCK as never, libraries: [ACME] }).hashes);
  });

  it("refuses what is not a list of libraries, in each tool that takes them", () => {
    const hash = hashProgram(load(INVOICES, "mdt").program as never).program;
    const args: Array<[string, Record<string, unknown>]> = [
      ["mandate.check", { source: INVOICES, lock: LOCK }],
      ["mandate.apply_patch", { source: INVOICES, base: hash, ops: [] }],
      ["mandate.caps_of", { source: INVOICES, name: "MatchInvoices" }],
      ["mandate.project", { source: INVOICES, view: "cost" }],
    ];
    for (const [name, a] of args) {
      for (const bad of ["none", [{ manifest: 1, files: {} }], [{ manifest: "{}", files: { "a.mdt": 1 } }], [null]]) {
        expect(call("mandate/0.7", name, { ...a, libraries: bad }), `${name} ${JSON.stringify(bad)}`).toEqual({ toolError: "libraries must be a list of libraries, each { manifest, files }" });
      }
    }
  });

  it("is, for a language before 0.7, what it was: libraries are not looked at", () => {
    // The 0.6 server ignores a member that is not in its schema, as it always did (it gives no library either).
    const a = call("mandate/0.6", "mandate.check", { source: INVOICES, lock: LOCK, libraries: [ACME] }) as { ok: { ok: boolean } };
    const b = call("mandate/0.6", "mandate.check", { source: INVOICES, lock: LOCK }) as { ok: { ok: boolean } };
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("project gives the card and the attention view of the workflow, and of every workflow", () => {
    const base = { source: INVOICES, lock: LOCK, libraries: [ACME] };
    const card = call("mandate/0.7", "mandate.project", { ...base, view: "card", workflow: "MatchInvoices" }) as { ok: { kind: string } };
    expect(card.ok.kind).toBe("card");
    const one = call("mandate/0.7", "mandate.project", { ...base, view: "attention", workflow: "MatchInvoices" }) as { ok: { kind: string; workflow: string } };
    expect(one.ok.kind).toBe("attention");
    expect(one.ok.workflow).toBe("MatchInvoices");
    const all = call("mandate/0.7", "mandate.project", { ...base, view: "attention" }) as { ok: { workflows: Array<{ workflow: string }> } };
    expect(all.ok.workflows.map((w) => w.workflow)).toContain("MatchInvoices");
    expect(call("mandate/0.7", "mandate.project", { ...base, view: "attention", workflow: "Nope" })).toEqual({ toolError: "Nope is not a workflow of this program" });
    expect(call("mandate/0.7", "mandate.project", { ...base, view: "summary" })).toEqual({ toolError: "view must be architecture, authority, cost, diff, card or attention" });
    // No lock and no libraries: the program does not check, and the answer says why.
    const bad = call("mandate/0.7", "mandate.project", { source: INVOICES, view: "attention" }) as { toolError: string };
    expect(bad.toolError).toContain("the program does not check");
  });

  it("an agent's session, draft to card: E1906, a patch, a clean check, and no tool that signs or approves it", () => {
    const hash = hashProgram(load(DRAFT, "mdt").program as never).program;
    const drafted = call("mandate/0.7", "mandate.check", { source: DRAFT, lock: LOCK, libraries: [ACME] }) as { ok: { ok: boolean; diagnostics: Array<{ code: string }> } };
    expect(drafted.ok.ok).toBe(false);
    expect(drafted.ok.diagnostics.map((d) => d.code)).toContain("MDT-E1906");
    const patch = [{ op: "replace", path: "/defs/MatchInvoices/budget/asks", value: 2 }];
    const patched = callTool("mandate.apply_patch", { source: DRAFT, base: hash, ops: patch, lock: LOCK, libraries: [ACME] }, {}, "mandate/0.7") as { ok: boolean; program: unknown };
    expect(patched.ok).toBe(true);
    const checked = call("mandate/0.7", "mandate.check", { source: JSON.stringify(patched.program), kind: "json", lock: LOCK, libraries: [ACME] }) as { ok: { ok: boolean } };
    expect(checked.ok.ok).toBe(true);
    // Without the libraries the patch is checked with none: the module the lock pins is not known to the check.
    const bare = callTool("mandate.apply_patch", { source: DRAFT, base: hash, ops: patch, lock: LOCK }, {}, "mandate/0.7") as { ok: boolean; diagnostics: Array<{ code: string }> };
    expect(bare.ok).toBe(false);
    expect(bare.diagnostics.map((d) => d.code)).toContain("MDT-E1604");
  });

  it("spec serves the specifications of patterns and of attention", () => {
    for (const section of ["patterns", "attention"]) {
      const r = call("mandate/0.7", "mandate.spec", { section }) as { ok: { text: string } };
      // The whole file, as it is (the recorded conversations hold no digest of it: it changes with every edit of its status rows).
      expect(r.ok.text, section).toBe(read(`spec/${section === "patterns" ? "library" : section}.md`));
      expect(call("mandate/0.7", "mandate.spec", { section: ` ${section} ` }), section).toEqual(r);
    }
  });
});

describe("the recorded conversations of 0.7", () => {
  it("are in vectors/mcp/, name their language, and hold the authoring session", () => {
    const files = readdirSync(root + "vectors/mcp").filter((f) => f.endsWith("-0.7.json"));
    expect(files).toContain("authoring-0.7.json");
    for (const f of files) expect((JSON.parse(read(`vectors/mcp/${f}`)) as { language: string }).language, f).toBe("mandate/0.7");
    for (const f of readdirSync(root + "vectors/mcp").filter((n) => !n.endsWith("-0.7.json"))) expect("language" in (JSON.parse(read(`vectors/mcp/${f}`)) as object), f).toBe(false);
  });
});
