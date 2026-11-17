// The bridge's MCP server (bridge/src/mcp.ts) and the compiler's (compiler/src/mcp/server.ts) give the same answers
// to the same messages: the tools, the two protocol eras, the limits on a line, and the lines it reads.

import { readFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, type Modules } from "../src/index.js";
import * as bridge from "../src/mcp.js";
import * as compiler from "../../compiler/src/mcp/server.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string): string => readFileSync(root + p, "utf8");
const FIXBUG = read("fixtures/fixbug/fixbug.mdt");
const SYSTEM = read("fixtures/system/acme.system.mdt");
const AUDIENCE = read("fixtures/system/audience.mdt");
const MIGRATE = read("fixtures/envelope/migrate-all.mdt");
const DOMAIN = read("fixtures/envelope/domain.mdt");
const V = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };

const FIXBUG_IR = JSON.stringify(check(FIXBUG, "mdt").program);
const FIXBUG_BASE = check(FIXBUG, "mdt").hashes!.program;
const AUDIENCE_BASE = check(AUDIENCE, "mdt", { modules: { "acme.system": check(SYSTEM, "mdt").program! } }).hashes!.program;

const modern = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: V } });
const tool = (id: number, name: string, args: Record<string, unknown>) => modern(id, "tools/call", { name, arguments: args });

/** Messages that stand alone (a fresh server for each), in the modern era. */
const SINGLE: unknown[] = [
  modern(1, "server/discover"),
  modern(2, "tools/list"),
  modern(3, "ping"),
  modern(4, "resources/list"),
  modern(5, "prompts/list"),
  { jsonrpc: "2.0", id: 6, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } },
  { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
  { jsonrpc: "2.0", id: 8, method: "server/discover" },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 9, method: 5 },
  { jsonrpc: "1.0", id: 10, method: "ping" },
  [],
  "text",
  null,
  7,
  { id: 11 },
  // mandate.check
  tool(20, "mandate.check", { source: FIXBUG }),
  tool(21, "mandate.check", { source: FIXBUG_IR }),
  tool(22, "mandate.check", { source: FIXBUG.replace("tests = delegate TestWriter.regression(issue)", "tests = delegate TestWriter.regression(issue) with caps SrcWrite") }),
  tool(23, "mandate.check", { source: "mandate @ 0.5\n\nnot a program\n" }),
  tool(24, "mandate.check", { source: AUDIENCE }),
  tool(25, "mandate.check", { source: AUDIENCE, modules: [SYSTEM] }),
  tool(26, "mandate.check", { source: AUDIENCE, modules: ["not a module"] }),
  tool(27, "mandate.check", { source: MIGRATE, modules: [DOMAIN] }),
  tool(28, "mandate.check", { source: FIXBUG, lock: { lock: "mandate/lock/0.5", modules: {} } }),
  tool(29, "mandate.check", { source: FIXBUG, lock: "text" }),
  tool(30, "mandate.check", {}),
  tool(31, "mandate.check", { source: 5 }),
  tool(32, "mandate.check", { source: FIXBUG, kind: "json" }),
  tool(33, "mandate.check", { source: "{ not json", kind: "json" }),
  tool(34, "mandate.check", { source: FIXBUG, kind: "yaml" }),
  // mandate.explain
  tool(40, "mandate.explain", { code: "E0320" }),
  tool(41, "mandate.explain", { code: "MDT-E0130" }),
  tool(42, "mandate.explain", { code: "E9999" }),
  tool(43, "mandate.explain", {}),
  tool(44, "mandate.explain", { code: 7 }),
  // mandate.apply_patch
  tool(50, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "replace", path: "/defs/FixBug/budget/spend/micros", value: 60_000_000 }] }),
  tool(51, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "replace", path: "/defs/RepoRead/value/args/0/value/value", value: "/work/repo/src" }] }),
  tool(52, "mandate.apply_patch", { source: FIXBUG_IR, base: "sha256:0000", ops: [] }),
  tool(53, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [] }),
  tool(54, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "remove", path: "/no/such/path" }] }),
  tool(55, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: "none" }),
  tool(56, "mandate.apply_patch", { source: AUDIENCE, base: AUDIENCE_BASE, ops: [{ op: "replace", path: "/version", value: "0.2" }], modules: [SYSTEM] }),
  tool(57, "mandate.apply_patch", { source: AUDIENCE, base: AUDIENCE_BASE, ops: [{ op: "replace", path: "/version", value: "0.2" }] }),
  tool(58, "mandate.apply_patch", {}),
  // mandate.caps_of
  tool(60, "mandate.caps_of", { source: FIXBUG, name: "Implementer" }),
  tool(61, "mandate.caps_of", { source: FIXBUG, name: "FixBug" }),
  tool(62, "mandate.caps_of", { source: FIXBUG, name: "NoSuchName" }),
  tool(63, "mandate.caps_of", { source: FIXBUG }),
  tool(64, "mandate.caps_of", { source: "mandate @ 0.5\n\nnot a program\n", name: "X" }),
  // mandate.project
  ...["architecture", "authority", "cost"].map((view, i) => tool(70 + i, "mandate.project", { source: FIXBUG, view })),
  tool(73, "mandate.project", { source: FIXBUG, view: "diff" }),
  tool(74, "mandate.project", { source: FIXBUG, view: "diff", before: read("fixtures/fixbug-target/fixbug.mdt") }),
  tool(75, "mandate.project", { source: FIXBUG, view: "nonsense" }),
  tool(76, "mandate.project", { source: AUDIENCE, modules: [SYSTEM], view: "authority" }),
  tool(77, "mandate.project", { source: MIGRATE, modules: [DOMAIN], view: "architecture" }),
  tool(78, "mandate.project", {}),
  // mandate.spec
  tool(80, "mandate.spec", {}),
  tool(81, "mandate.spec", { section: "4" }),
  tool(82, "mandate.spec", { section: "999" }),
  tool(83, "mandate.spec", { section: 4 }),
  // not tools
  tool(90, "mandate.nothing", {}),
  modern(91, "tools/call", { arguments: {} }),
  modern(92, "tools/call", { name: "mandate.explain", arguments: "text" }),
  modern(93, "tools/call", { name: "mandate.explain" }),
  modern(94, "no/such/method"),
];

/** Sequences that need a session: the legacy handshake in each of its versions. */
const SESSIONS: unknown[][] = [
  ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2020-01-01", undefined].map((protocolVersion, i) => ({ jsonrpc: "2.0", id: i, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "old", version: "1" } } })),
  [
    { jsonrpc: "2.0", id: 0, method: "tools/list", params: {} },
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "ping" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mandate.check", arguments: { source: FIXBUG } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mandate.explain", arguments: { code: "E9999" } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mandate.spec", arguments: { section: "4" } } },
    { jsonrpc: "2.0", id: 7, method: "server/discover" },
    { jsonrpc: "2.0", id: 8, method: "resources/list" },
    modern(9, "tools/list"),
    tool(10, "mandate.explain", { code: "E0130" }),
    { jsonrpc: "2.0", id: 11, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } },
  ],
];

const same = (v: unknown): unknown => JSON.parse(JSON.stringify(v ?? null));

describe("the bridge's MCP server equals the compiler's", () => {
  it("has the same tools, versions, limits and constants", () => {
    expect(same(bridge.TOOLS)).toEqual(same(compiler.TOOLS));
    expect(bridge.MODERN_VERSIONS).toEqual(compiler.MODERN_VERSIONS);
    expect(bridge.LEGACY_VERSIONS).toEqual(compiler.LEGACY_VERSIONS);
    expect(bridge.MESSAGE_LIMITS).toEqual(compiler.MESSAGE_LIMITS);
    expect(Object.keys(bridge).sort()).toEqual(Object.keys(compiler).sort());
  });

  it(`answers ${SINGLE.length} single messages as the compiler's does`, () => {
    for (const msg of SINGLE) {
      const a = new compiler.McpServer().handle(msg);
      const b = new bridge.McpServer().handle(msg);
      expect(same(b), JSON.stringify(msg).slice(0, 120)).toEqual(same(a));
    }
  });

  it("answers the same with the server's own modules (mandate mcp --module)", () => {
    const modules: Modules = { "acme.system": check(SYSTEM, "mdt").program! };
    for (const msg of [tool(1, "mandate.check", { source: AUDIENCE }), tool(2, "mandate.apply_patch", { source: AUDIENCE, base: AUDIENCE_BASE, ops: [{ op: "replace", path: "/version", value: "0.2" }] }), tool(3, "mandate.project", { source: AUDIENCE, view: "authority" })]) {
      const a = new compiler.McpServer(modules).handle(msg);
      const b = new bridge.McpServer(modules).handle(msg);
      expect(same(b)).toEqual(same(a));
      expect((b as { result: { isError: boolean } }).result.isError).toBe(false);
    }
  });

  it(`answers ${SESSIONS.length} sessions (the legacy handshake in each version, then calls) as the compiler's does`, () => {
    for (const messages of SESSIONS) {
      const a = new compiler.McpServer();
      const b = new bridge.McpServer();
      for (const msg of messages) expect(same(b.handle(msg)), JSON.stringify(msg).slice(0, 120)).toEqual(same(a.handle(msg)));
    }
  });

  it("finds a section of the specification by its text, where the compiler's server reads it as a regular expression", () => {
    // The one place the two servers part (vectors/README.md, "mcp/"): the reference compiler's server, frozen,
    // escapes only `.`, so that `(` is an Internal error there and `\d` or `4+` another section.
    for (const section of ["(", "\\d", "1|x", "4+", "[4]", "4\\b", "4.*", "^4", "$"]) {
      const b = new bridge.McpServer().handle(tool(1, "mandate.spec", { section })) as { result: { isError: boolean; content: Array<{ text: string }> } };
      expect(b.result.isError, section).toBe(true);
      expect(b.result.content[0]!.text).toBe(`no section ${section} in the core specification`);
    }
    for (const section of ["4", "4.", " 7.2 "]) {
      const b = new bridge.McpServer().handle(tool(2, "mandate.spec", { section })) as { result: { isError: boolean } };
      expect(b.result.isError, section).toBe(false);
      expect(same(b)).toEqual(same(new compiler.McpServer().handle(tool(2, "mandate.spec", { section }))));
    }
  });

  it("calls the tools directly the same way, and refuses the same arguments", () => {
    for (const msg of SINGLE) {
      const params = (msg as { params?: { name?: unknown; arguments?: unknown } } | null)?.params;
      if (typeof params?.name !== "string" || !params.arguments || typeof params.arguments !== "object") continue;
      const attempt = (call: typeof compiler.callTool) => {
        try {
          return { ok: same(call(params.name as string, params.arguments as Record<string, unknown>)) };
        } catch (e) {
          return { threw: (e as Error).constructor.name + ": " + (e as Error).message };
        }
      };
      expect(attempt(bridge.callTool), JSON.stringify(msg).slice(0, 100)).toEqual(attempt(compiler.callTool));
    }
  });

  /** Everything a server writes for these input chunks, as bytes. */
  async function serve(mod: typeof compiler, chunks: Array<string | Buffer>, modules?: Modules): Promise<string> {
    const output = new PassThrough();
    const out: Buffer[] = [];
    output.on("data", (c: Buffer) => out.push(c));
    await mod.serveStdio(Readable.from(chunks), output, modules);
    return Buffer.concat(out).toString("utf8");
  }
  const line = (m: unknown): string => JSON.stringify(m) + "\n";

  it("speaks the same lines on stdio: bad JSON, blank lines, CRLF, lone CR, a last line without a break, split characters", async () => {
    const g = Buffer.from("ğ", "utf8");
    const scripts: Array<Array<string | Buffer>> = [
      [line(modern(1, "server/discover")), "not json\n", "\n", line(tool(2, "mandate.explain", { code: "E0130" })), "[1,2]\n", "42\n"],
      [line(modern(1, "ping")).replace("\n", "\r\n"), line(modern(2, "ping")).replace("\n", "\r"), JSON.stringify(modern(3, "ping"))],
      [Buffer.from(JSON.stringify(modern(1, "ping")).slice(0, 30)), Buffer.from(JSON.stringify(modern(1, "ping")).slice(30) + "\n")],
      [Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mandate.explain","arguments":{"code":"f'), g.subarray(0, 1)]), Buffer.concat([g.subarray(1), Buffer.from('"},"_meta":{}}}\n')])],
      [],
      [line(tool(1, "mandate.check", { source: FIXBUG })), line(tool(2, "mandate.spec", {}))],
    ];
    for (const script of scripts) expect(await serve(bridge as unknown as typeof compiler, script)).toBe(await serve(compiler, script));
    // And the server's modules are the ones every call is checked against.
    const withModules = [line(tool(1, "mandate.check", { source: AUDIENCE }))];
    const modules: Modules = { "acme.system": check(SYSTEM, "mdt").program! };
    const bytes = await serve(bridge as unknown as typeof compiler, withModules, modules);
    expect(bytes).toBe(await serve(compiler, withModules, modules));
    expect(JSON.parse(bytes)).toMatchObject({ result: { isError: false, structuredContent: { ok: true } } });
  });

  it("refuses the same oversized lines, arrays and nestings, and goes on to the next line", async () => {
    const limits = compiler.MESSAGE_LIMITS;
    let deep: unknown = {};
    for (let i = 0; i < limits.depth; i++) deep = { a: deep };
    const padded = (id: number, bytes: number): string => {
      const bare = JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: { _meta: V, pad: "" } });
      return bare.replace('"pad":""', `"pad":"${"p".repeat(bytes - Buffer.byteLength(bare))}"`);
    };
    const script = [
      line(tool(1, "mandate.check", { source: "a".repeat(2 * 1024 * 1024) })),
      line(tool(2, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: new Array(1_000_000).fill(0) })),
      line(tool(3, "mandate.check", { source: "x", modules: new Array(limits.arrayItems + 1).fill("") })),
      line(tool(4, "mandate.check", { source: "x", lock: deep })),
      line(tool(5, "mandate.explain", { code: "E0130", pad: new Array(limits.arrayItems).fill(0) })),
      padded(6, limits.bytes) + "\r\n",
      padded(7, limits.bytes + 1) + "\r\n",
      line(modern(8, "ping")),
    ];
    const a = await serve(compiler, script);
    const b = await serve(bridge as unknown as typeof compiler, script);
    expect(b).toBe(a);
    const replies = b.trim().split("\n").map((l) => JSON.parse(l) as { id: unknown; error?: { code: number; data?: { reason?: string } } });
    expect(replies.map((r) => [r.id, r.error?.code ?? "ok", r.error?.data?.reason ?? null])).toEqual([
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [3, -32600, "E_ARRAY_TOO_LONG"],
      [4, -32600, "E_INPUT_TOO_DEEP"],
      [5, "ok", null],
      [6, "ok", null],
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [8, "ok", null],
    ]);
  }, 60_000);

  it("splits lines as the compiler's reader does", async () => {
    const g = Buffer.from("ğ", "utf8");
    const chunks = [Buffer.from("one\r"), Buffer.from("\ntwo\rthree\n\n"), Buffer.concat([Buffer.from("f"), g.subarray(0, 1)]), Buffer.concat([g.subarray(1), Buffer.from("our\r\n\r\nfive")])];
    const lines = async (mod: typeof compiler, max: number) => {
      const out: Array<string | object> = [];
      for await (const l of mod.readLines(Readable.from(chunks), max)) out.push(l);
      return out;
    };
    expect(await lines(bridge as unknown as typeof compiler, 1024)).toEqual(await lines(compiler, 1024));
    expect(await lines(bridge as unknown as typeof compiler, 3)).toEqual(await lines(compiler, 3));
    expect(await lines(bridge as unknown as typeof compiler, 1024)).toEqual(["one", "two", "three", "", "fğour", "", "five"]);
  });
});
