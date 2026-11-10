// The compiler as an MCP server (P2-15, Doc 4 §14): agents check programs,
// read diagnostic codes, apply patches against a base hash and read views,
// as tools. Dual-era: MCP 2026-07-28 per-request versions and server/discover,
// and the legacy initialize handshake.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { McpServer, MESSAGE_LIMITS, readLines, serveStdio } from "../src/mcp/server.js";
import { readRepo } from "./helpers.js";

const FIXBUG = readRepo("fixtures/fixbug/fixbug.mdt");
const V = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };

function call(s: McpServer, name: string, args: Record<string, unknown>, id = 1) {
  const r = s.handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: V } }) as { result: { isError: boolean; structuredContent?: Record<string, unknown>; content: Array<{ text: string }> } };
  return r.result;
}

describe("the compiler's MCP server (§14)", () => {
  it("discovers, lists its tools, and refuses a version it does not speak", () => {
    const s = new McpServer();
    const d = s.handle({ jsonrpc: "2.0", id: "d", method: "server/discover", params: { _meta: V } }) as { result: Record<string, unknown> };
    expect(d.result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"], capabilities: { tools: {} }, _meta: { "io.modelcontextprotocol/serverInfo": { name: "mandate-compiler" } } });
    const list = s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: V } }) as { result: { tools: Array<{ name: string }>; ttlMs: number } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["mandate.check", "mandate.explain", "mandate.apply_patch", "mandate.caps_of", "mandate.project", "mandate.spec"]);
    expect(list.result.ttlMs).toBeGreaterThan(0);
    expect(s.handle({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } })).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"], requested: "1900-01-01" } },
    });
    expect(s.handle({ jsonrpc: "2.0", id: 4, method: "resources/list", params: { _meta: V } })).toMatchObject({ error: { code: -32601 } });
  });

  it("checks a program and explains a code", () => {
    const s = new McpServer();
    const ok = call(s, "mandate.check", { source: FIXBUG });
    expect(ok.isError).toBe(false);
    expect(ok.structuredContent).toMatchObject({ ok: true, hashes: { program: check(FIXBUG, "mdt").hashes!.program } });
    const bad = call(s, "mandate.check", { source: FIXBUG.replace("tests = delegate TestWriter.regression(issue)", "tests = delegate TestWriter.regression(issue) with caps SrcWrite") });
    expect(bad.structuredContent).toMatchObject({ ok: false });
    expect((bad.structuredContent!["diagnostics"] as Array<{ code: string }>).map((d) => d.code)).toContain("MDT-E0701");
    expect(call(s, "mandate.explain", { code: "E0320" }).structuredContent).toMatchObject({ code: "MDT-E0320", title: "Overlapping writes in par" });
    expect(call(s, "mandate.explain", { code: "E9999" })).toMatchObject({ isError: true, content: [{ text: "unknown code E9999" }] });
  });

  it("checks a program over a system model: the server's modules, or the call's own", () => {
    const system = readRepo("fixtures/system/acme.system.mdt");
    const program = readRepo("fixtures/system/audience.mdt");
    // Without the module its `use` cannot resolve.
    expect(call(new McpServer(), "mandate.check", { source: program }).structuredContent).toMatchObject({ ok: false });
    const fromServer = new McpServer({ "acme.system": check(system, "mdt").program! });
    expect(call(fromServer, "mandate.check", { source: program }).structuredContent).toMatchObject({ ok: true });
    expect(call(new McpServer(), "mandate.check", { source: program, modules: [system] }).structuredContent).toMatchObject({ ok: true });
    expect(call(new McpServer(), "mandate.project", { source: program, modules: [system], view: "authority" }).isError).toBe(false);
    expect(call(new McpServer(), "mandate.check", { source: program, modules: ["not a module"] })).toMatchObject({ isError: true });
  });

  it("applies a patch against its base, flags governance changes, and refuses a stale base", () => {
    const s = new McpServer();
    const ir = JSON.stringify(check(FIXBUG, "mdt").program);
    const base = check(FIXBUG, "mdt").hashes!.program;
    // Raising a budget is a governance change: computed and returned, never granted by the server.
    const raise = call(s, "mandate.apply_patch", { source: ir, base, ops: [{ op: "replace", path: "/defs/FixBug/budget/spend/micros", value: 60_000_000 }] });
    expect(raise.structuredContent).toMatchObject({ ok: true, requires_approval: true, governance: [{ kind: "budget_increased" }] });
    expect(raise.structuredContent!["hash"]).not.toBe(base);
    const stale = call(s, "mandate.apply_patch", { source: ir, base: "sha256:0000", ops: [] });
    expect(stale.structuredContent).toMatchObject({ ok: false, diagnostics: [{ code: "MDT-E0130" }] });
  });

  it("answers authority, views and the specification", () => {
    const s = new McpServer();
    const caps = call(s, "mandate.caps_of", { source: FIXBUG, name: "Implementer" });
    expect(caps.structuredContent).toMatchObject({ rows: [{ who: "Implementer", write: ["/work/repo/src"] }] });
    expect(call(s, "mandate.project", { source: FIXBUG, view: "architecture" }).structuredContent).toMatchObject({ kind: "architecture" });
    const spec = call(s, "mandate.spec", { section: "4" }).structuredContent as { text: string };
    expect(spec.text.startsWith("## 4. Capabilities")).toBe(true);
    expect(spec.text).not.toContain("## 5.");
  });

  it("serves a legacy client that opens with initialize", () => {
    const s = new McpServer();
    expect(s.handle({ jsonrpc: "2.0", id: 0, method: "tools/list", params: {} })).toMatchObject({ error: { code: -32022 } });
    const init = s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "old", version: "1" } } });
    expect(init).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "mandate-compiler" } } });
    expect(s.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    const list = s.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }) as { result: Record<string, unknown> };
    expect(list.result["tools"]).toHaveLength(6);
    expect(list.result["resultType"]).toBeUndefined();
  });

  it("speaks newline-delimited JSON-RPC on stdio", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.on("data", (c: Buffer) => chunks.push(c.toString()));
    const done = serveStdio(input, output);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: V } }) + "\n");
    input.write("not json\n");
    input.end(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "mandate.explain", arguments: { code: "E0130" }, _meta: V } }) + "\n");
    await done;
    const replies = chunks.join("").trim().split("\n").map((l) => JSON.parse(l) as { id: unknown; error?: { code: number } });
    expect(replies.map((r) => [r.id, r.error?.code ?? "ok"])).toEqual([
      [1, "ok"],
      [null, -32700],
      [2, "ok"],
    ]);
  });

  it.runIf(existsSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url))))("runs as `mandate mcp`", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mandate.check", arguments: { source: FIXBUG }, _meta: V } }) + "\n");
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(JSON.parse(out.trim())).toMatchObject({ id: 7, result: { isError: false, structuredContent: { ok: true } } });
  });
});

// CVE review K1: a message is bounded before it is handled, and its size while it is read.
describe("the MCP server's message limits (K1)", () => {
  type Reply = { id: unknown; result?: unknown; error?: { code: number; message: string; data?: { reason?: string; path?: string; limit?: number; bytes?: number } } };
  const ping = (id: number) => JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: { _meta: V } });
  const toolCall = (id: number, name: string, args: Record<string, unknown>) => JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args, _meta: V } });

  /** Every reply the server writes for these input chunks, in order. */
  async function serve(chunks: Iterable<string | Buffer> | AsyncIterable<string | Buffer>): Promise<Reply[]> {
    const output = new PassThrough();
    const out: Buffer[] = [];
    output.on("data", (c: Buffer) => out.push(c));
    await serveStdio(Readable.from(chunks), output);
    return Buffer.concat(out).toString("utf8").trim().split("\n").map((l) => JSON.parse(l) as Reply);
  }
  const summary = (r: Reply) => [r.id, r.error ? r.error.code : "ok", r.error?.data?.reason ?? null];

  it("refuses a 2 MB request and a 1 000 000-element array, and answers the next request", async () => {
    const big = toolCall(1, "mandate.check", { source: "a".repeat(2 * 1024 * 1024) });
    const million = toolCall(2, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: new Array(1_000_000).fill(0) });
    expect(Buffer.byteLength(big)).toBeGreaterThan(2 * 1024 * 1024);
    const replies = await serve([big + "\n", million + "\n", ping(3) + "\n"]);
    expect(replies.map(summary)).toEqual([
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [3, "ok", null],
    ]);
    expect(replies[0]!.error!.data).toEqual({ reason: "E_INPUT_TOO_LARGE", limit: MESSAGE_LIMITS.bytes, bytes: Buffer.byteLength(big) });
  });

  it("refuses an array or a nesting over the limit in a message that fits, with the request's id", async () => {
    const long = toolCall(1, "mandate.check", { source: "x", modules: new Array(MESSAGE_LIMITS.arrayItems + 1).fill("") });
    let deep: unknown = {};
    for (let i = 0; i < MESSAGE_LIMITS.depth; i++) deep = { a: deep };
    const nested = toolCall(2, "mandate.check", { source: "x", lock: deep });
    const atLimit = toolCall(3, "mandate.explain", { code: "E0130", pad: new Array(MESSAGE_LIMITS.arrayItems).fill(0) });
    expect(Buffer.byteLength(long)).toBeLessThan(MESSAGE_LIMITS.bytes);
    const replies = await serve([long + "\n", nested + "\n", atLimit + "\n", ping(4) + "\n"]);
    expect(replies.map(summary)).toEqual([
      [1, -32600, "E_ARRAY_TOO_LONG"],
      [2, -32600, "E_INPUT_TOO_DEEP"],
      [3, "ok", null],
      [4, "ok", null],
    ]);
    expect(replies[0]!.error!.data).toEqual({ reason: "E_ARRAY_TOO_LONG", limit: MESSAGE_LIMITS.arrayItems, path: "/params/arguments/modules" });
    expect(replies[1]!.error!.data).toMatchObject({ reason: "E_INPUT_TOO_DEEP", limit: MESSAGE_LIMITS.depth });
    // A tool's own argument errors are unchanged: the padded explain call is a tool result.
    expect(replies[2]!.result).toMatchObject({ isError: false });
  });

  it("serves a line of exactly the byte limit and refuses one byte more", async () => {
    const padded = (id: number, bytes: number) => {
      const bare = JSON.stringify({ jsonrpc: "2.0", id, method: "ping", params: { _meta: V, pad: "" } });
      return bare.replace('"pad":""', `"pad":"${"p".repeat(bytes - Buffer.byteLength(bare))}"`);
    };
    const exact = padded(1, MESSAGE_LIMITS.bytes);
    const over = padded(2, MESSAGE_LIMITS.bytes + 1);
    expect([Buffer.byteLength(exact), Buffer.byteLength(over)]).toEqual([MESSAGE_LIMITS.bytes, MESSAGE_LIMITS.bytes + 1]);
    // CRLF line breaks do not count against the limit.
    const replies = await serve([exact + "\r\n", over + "\r\n", ping(3) + "\r\n"]);
    expect(replies.map(summary)).toEqual([
      [1, "ok", null],
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [3, "ok", null],
    ]);
  });

  it("splits lines exactly as readline did, across chunk boundaries", async () => {
    // "\r\n" split over two chunks, a lone "\r", a blank line, a two-byte character split over two chunks, no final break.
    const g = Buffer.from("ğ", "utf8");
    const chunks = [Buffer.from("one\r"), Buffer.from("\ntwo\rthree\n\n"), Buffer.concat([Buffer.from("f"), g.subarray(0, 1)]), Buffer.concat([g.subarray(1), Buffer.from("our\r\n\r\nfive")])];
    const viaReadline: string[] = [];
    for await (const l of createInterface({ input: Readable.from(chunks), crlfDelay: Infinity })) viaReadline.push(l);
    const viaReader: Array<string | object> = [];
    for await (const l of readLines(Readable.from(chunks), MESSAGE_LIMITS.bytes)) viaReader.push(l);
    expect(viaReader).toEqual(viaReadline);
    expect(viaReader).toEqual(["one", "two", "three", "", "fğour", "", "five"]);
  });

  it("does not hold an oversized line in memory while it reads it", async () => {
    // A 64 MiB line, sent as one 64 KiB buffer over and over, then a ping. Halfway through it,
    // readline would have kept 32 MiB of it; the reader keeps none.
    const block = Buffer.alloc(64 * 1024, 0x61);
    let halfway = 0;
    async function* input() {
      const before = process.memoryUsage();
      for (let i = 0; i < 1024; i++) {
        if (i === 512) {
          const now = process.memoryUsage();
          halfway = now.heapUsed + now.arrayBuffers - (before.heapUsed + before.arrayBuffers);
        }
        yield block;
      }
      yield Buffer.from("\n" + ping(9) + "\n");
    }
    const replies = await serve(input());
    expect(replies.map(summary)).toEqual([
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [9, "ok", null],
    ]);
    expect(replies[0]!.error!.data!.bytes).toBe(64 * 1024 * 1024);
    expect(halfway).toBeLessThan(16 * 1024 * 1024);
  });

  it.runIf(existsSync(fileURLToPath(new URL("../dist/cli.js", import.meta.url))))("keeps `mandate mcp` up after refusing them", async () => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("../dist/cli.js", import.meta.url)), "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stdin.write(toolCall(1, "mandate.check", { source: "a".repeat(2 * 1024 * 1024) }) + "\n");
    child.stdin.write(toolCall(2, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: new Array(1_000_000).fill(0) }) + "\n");
    child.stdin.end(toolCall(3, "mandate.check", { source: FIXBUG }) + "\n");
    const code = await new Promise<number | null>((r) => child.on("close", r));
    expect(code).toBe(0);
    const replies = out.trim().split("\n").map((l) => JSON.parse(l) as Reply);
    expect(replies.map(summary)).toEqual([
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [null, -32600, "E_INPUT_TOO_LARGE"],
      [3, "ok", null],
    ]);
    expect(replies[2]!.result).toMatchObject({ isError: false, structuredContent: { ok: true } });
  });
});
