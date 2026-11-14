// The runtime's MCP client against the fake MCP server (spec/library.md "The
// MCP the runtime speaks"): what it sends, what it takes, and each answer it
// refuses, with the kind of the refusal and whether it is definite.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_ANSWER_BYTES, MAX_LIST_PAGES, MCP_PROTOCOL_VERSION, McpClient, McpDenied, McpError, schemaDigest, type McpErrorKind, type McpRule } from "../src/mcp-client.js";
import { Violation } from "../src/signals.js";
import { fakeErp, fakeMailbox, FakeMcp, INJECTION, type McpFault } from "./fake-mcp.js";

const ERP = "https://erp.acme.example/mcp";
const MATCH = { invoice_no: "INV-1", order: { order_no: "PO-1", vendor_id: "V1", total_cents: 10_000 } };

function erp(): { fake: FakeMcp; client: McpClient } {
  const fake = fakeErp();
  fake.orders.push({ order_no: "PO-1", vendor_id: "V1", total_cents: 10_000 }, { order_no: "PO-2", vendor_id: "V2", total_cents: 5_000 });
  return { fake, client: new McpClient({ url: ERP, fetch: fake.fetch }) };
}

/** The error a promise rejects with, which must be the client's own. */
async function refusal(p: Promise<unknown>): Promise<McpError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(McpError);
    const err = e as McpError;
    // Bounded, and nothing of the server's own text.
    expect(err.message).not.toContain(INJECTION);
    expect(err.message.length).toBeLessThan(300);
    return err;
  }
  throw new Error("expected a refusal");
}

describe("requests", () => {
  it("are one JSON-RPC request each, POSTed alone with the two headers and the protocol version, and nothing else", async () => {
    const { fake, client } = erp();
    await client.listTools();
    await client.callTool("list_open_orders", { vendor_id: "V1" });
    expect(fake.received).toHaveLength(2);
    for (const r of fake.received) {
      expect(r.method).toBe("POST");
      expect(r.url).toBe("/mcp");
      expect(r.headers).toEqual({ "content-type": "application/json", accept: "application/json, text/event-stream" });
    }
    expect(fake.received[0]!.body).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    expect(fake.received[1]!.body).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_open_orders", arguments: { vendor_id: "V1" }, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
    });
    expect(MCP_PROTOCOL_VERSION).toBe("2026-07-28");
  });
});

describe("tools/list", () => {
  it("gives each tool's name, schemas and digest, and never its description, title or annotations", async () => {
    const { client } = erp();
    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(["list_open_orders", "find_draft_invoice", "post_draft_invoice"]);
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(["digest", "inputSchema", "name", "outputSchema"]);
      expect(t.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(t.digest).toBe(schemaDigest(t));
    }
    const text = JSON.stringify(tools);
    expect(text).not.toContain(INJECTION);
    expect(text).not.toContain("description");
    expect(text).not.toContain("annotations");
    expect(text).not.toContain("readOnlyHint");
    expect(text).not.toContain("List open orders");
  });

  it("digests a tool as sha256 of the JCS bytes of { name, inputSchema, outputSchema }, computed here by hand", async () => {
    const fake = new FakeMcp("x.example").tool({
      name: "t",
      title: "T",
      description: "d",
      // Keys out of order, a non-ASCII key and a fractional number: JCS sorts by code unit and prints 1.5 as ECMAScript does.
      inputSchema: { type: "object", properties: { é: { type: "number", minimum: 1.5 }, a: { type: "string" } } },
      outputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
      write: false,
      run: () => ({ structured: {}, text: "" }),
    });
    const [tool] = await new McpClient({ url: "https://x.example/mcp", fetch: fake.fetch }).listTools();
    const jcs = '{"inputSchema":{"properties":{"a":{"type":"string"},"é":{"minimum":1.5,"type":"number"}},"type":"object"},"name":"t","outputSchema":{"type":"object"}}';
    expect(tool!.digest).toBe(`sha256:${createHash("sha256").update(Buffer.from(jcs, "utf8")).digest("hex")}`);
    // Without an outputSchema, the digest is of the two members there are.
    expect(schemaDigest({ name: "t", inputSchema: { type: "object" } })).toBe(`sha256:${createHash("sha256").update('{"inputSchema":{"type":"object"},"name":"t"}').digest("hex")}`);
  });

  it("follows nextCursor across pages", async () => {
    const { fake, client } = erp();
    fake.pageSize = 1;
    expect((await client.listTools()).map((t) => t.name)).toEqual(["list_open_orders", "find_draft_invoice", "post_draft_invoice"]);
    expect(fake.received.map((r) => ((r.body as { params: { cursor?: string } }).params.cursor ?? null))).toEqual([null, "p1", "p2"]);
  });

  it("refuses a cursor seen twice: connector_protocol", async () => {
    const { fake, client } = erp();
    fake.repeatCursor = true;
    const e = await refusal(client.listTools());
    expect([e.kind, e.rule, e.definite]).toEqual(["connector_protocol", "cursor_repeated", false]);
    expect(fake.received).toHaveLength(2);
  });

  it(`refuses more than ${MAX_LIST_PAGES} pages: connector_protocol`, async () => {
    const fake = fakeMailbox();
    for (let i = 0; i < MAX_LIST_PAGES + 5; i++) fake.tool({ ...fake.tools[0]!, name: `filler_${i}` });
    fake.pageSize = 1;
    const e = await refusal(new McpClient({ url: "https://mail.acme.example/mcp", fetch: fake.fetch }).listTools());
    expect([e.kind, e.rule, e.definite]).toEqual(["connector_protocol", "too_many_pages", false]);
    expect(fake.received).toHaveLength(MAX_LIST_PAGES);
  });

  it("sees a changed schema as another digest, and a dropped tool as not listed", async () => {
    const { fake, client } = erp();
    const before = new Map((await client.listTools()).map((t) => [t.name, t.digest]));
    fake.changeSchema("post_draft_invoice", (s) => ({ ...s, properties: { ...(s["properties"] as object), note: { type: "string" } } }));
    fake.dropTool("find_draft_invoice");
    const after = new Map((await client.listTools()).map((t) => [t.name, t.digest]));
    expect(after.get("post_draft_invoice")).not.toBe(before.get("post_draft_invoice"));
    expect(after.get("list_open_orders")).toBe(before.get("list_open_orders"));
    expect(after.has("find_draft_invoice")).toBe(false);
  });

  it("refuses a tool listed twice, and one that is not { name, inputSchema, outputSchema? }", async () => {
    const { fake, client } = erp();
    fake.tool({ ...fake.tools[0]! });
    expect((await refusal(client.listTools())).rule).toBe("duplicate_tool");
    fake.tools.pop();
    fake.tools[0]!.name = "has a space";
    expect((await refusal(client.listTools())).rule).toBe("bad_result");
  });
});

describe("tools/call", () => {
  it("answers structuredContent, and never reads the text content", async () => {
    const { client } = erp();
    const seen: unknown[] = [];
    const v = await client.callTool("list_open_orders", { vendor_id: "V1" }, { validate: (x) => (seen.push(x), true) });
    expect(v).toEqual({ orders: [{ order_no: "PO-1", vendor_id: "V1", total_cents: 10_000 }] });
    expect(seen).toEqual([v]);
    expect(JSON.stringify(v)).not.toContain(INJECTION);
  });

  it("posts a draft once per invoice: the same invoice posted again gives the same draft", async () => {
    const { fake, client } = erp();
    expect(await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    expect(await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    expect(fake.posted).toBe(1);
    expect(fake.applied.get("post_draft_invoice")).toBe(2);
    expect(await client.callTool("find_draft_invoice", { key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    expect(await client.callTool("find_draft_invoice", { key: "op-2" })).toEqual({ draft_id: null });
  });

  it("takes an answer as an event stream of one event, a priming event with no data not counted", async () => {
    const { fake, client } = erp();
    fake.answerAs = "event_stream";
    expect((await client.listTools()).map((t) => t.name)).toContain("post_draft_invoice");
    expect(await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    fake.prime = true;
    expect(await client.callTool("list_open_orders", { vendor_id: "V2" })).toEqual({ orders: [{ order_no: "PO-2", vendor_id: "V2", total_cents: 5_000 }] });
  });
});

/** Each answer the client refuses, as the next write's: the kind, the rule, and whether it proves nothing was done. */
const REFUSALS: Array<[McpFault, McpErrorKind, McpRule, boolean]> = [
  ["network", "connector_protocol", "network", false],
  ["lose_response", "connector_protocol", "network", false],
  [500, "connector_protocol", "status", false],
  ["redirect", "connector_protocol", "status", false],
  ["status_202", "connector_protocol", "status", false],
  ["content_type", "connector_protocol", "content_type", false],
  ["not_json", "connector_protocol", "not_json", false],
  ["not_utf8", "connector_protocol", "not_json", false],
  ["too_large", "connector_protocol", "too_large", false],
  ["too_deep", "connector_protocol", "too_deep", false],
  ["batch", "connector_protocol", "not_response", false],
  ["notification", "connector_protocol", "server_message", false],
  ["server_request", "connector_protocol", "server_message", false],
  ["wrong_id", "connector_protocol", "wrong_id", false],
  ["string_id", "connector_protocol", "wrong_id", false],
  ["two_events", "connector_protocol", "events", false],
  ["other_event", "connector_protocol", "events", false],
  ["no_events", "connector_protocol", "events", false],
  ["incomplete", "connector_protocol", "incomplete_result", false],
  // The fake's default code is -32603, internal error, which does not prove the method never ran.
  ["jsonrpc_error", "connector_protocol", "jsonrpc_error", false],
  ["no_structured_content", "tool_result_mismatch", "no_structured_content", false],
  ["is_error", "tool_result_mismatch", "is_error", false],
  ["denied", "egress_denied", "denied", true],
];

describe("refusals", () => {
  for (const [fault, kind, rule, definite] of REFUSALS) {
    it(`${String(fault)}: ${kind} (${rule}), definite ${definite}`, async () => {
      const { fake, client } = erp();
      fake.faults.push(fault);
      const e = await refusal(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }));
      expect({ kind: e.kind, rule: e.rule, definite: e.definite }).toEqual({ kind, rule, definite });
      // A definite answer is one after which the server has done nothing.
      if (definite) expect(fake.posted).toBe(0);
      // The client is usable after a refusal.
      expect(await client.callTool("list_open_orders", { vendor_id: "V2" })).toEqual({ orders: [{ order_no: "PO-2", vendor_id: "V2", total_cents: 5_000 }] });
    });
  }

  it("names what came: the status, the media type, a JSON-RPC error's code, the events counted, the proxy's reason", async () => {
    const { fake, client } = erp();
    fake.faults.push(500, "content_type", "jsonrpc_error", "two_events", "denied");
    const call = () => refusal(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }));
    expect((await call()).status).toBe(500);
    expect((await call()).contentType).toBe("text/html");
    expect((await call()).code).toBe(-32603);
    expect((await call()).events).toBe(2);
    const denied = await call();
    expect(denied).toBeInstanceOf(McpDenied);
    expect([denied.reason, denied.status]).toEqual(["host_not_allowed", 403]);
    expect(denied.message).toBe("egress_denied: tools/call post_draft_invoice: denied: the egress proxy denied the request; it was not sent upstream (HTTP 403, host_not_allowed)");
  });

  // A JSON-RPC error is definite only when its code says the request was refused before its method ran.
  const CODES: Array<[string, number, boolean]> = [
    ["parse error", -32700, true],
    ["invalid request", -32600, true],
    ["method not found", -32601, true],
    ["invalid params", -32602, true],
    ["internal error", -32603, false],
    ["implementation-defined, top of the range", -32000, false],
    ["implementation-defined, inside the range", -32050, false],
    ["implementation-defined, bottom of the range", -32099, false],
    ["outside every range", 1, false],
    ["reserved but undefined", -32650, false],
  ];
  for (const [what, code, definite] of CODES) {
    it(`a JSON-RPC error ${code} (${what}) is definite ${definite}, for a read and for a write`, async () => {
      for (const call of [(c: McpClient) => c.callTool("list_open_orders", { vendor_id: "V1" }), (c: McpClient) => c.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })]) {
        const { fake, client } = erp();
        fake.errorCode = code;
        fake.faults.push("jsonrpc_error");
        const e = await refusal(call(client));
        expect({ kind: e.kind, rule: e.rule, code: e.code, definite: e.definite }).toEqual({ kind: "connector_protocol", rule: "jsonrpc_error", code, definite });
        expect(e.message).toBe(`connector_protocol: tools/call ${e.tool}: jsonrpc_error: the server answered with a JSON-RPC error (code ${code})`);
      }
    });
  }

  it("a write the server applied and then answered -32603 is not definite, and the draft was in fact posted", async () => {
    const { fake, client } = erp();
    fake.faults.push("jsonrpc_error_after_run");
    const e = await refusal(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }));
    expect([e.kind, e.rule, e.code, e.definite]).toEqual(["connector_protocol", "jsonrpc_error", -32603, false]);
    expect(fake.posted).toBe(1);
    expect(fake.drafts.get("INV-1")).toMatchObject({ draft_id: "D-INV-1", key: "op-1" });
    // So it is reconciled, not rejected: the reconciling read finds the draft.
    expect(await client.callTool("find_draft_invoice", { key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
  });

  it("a write whose response was lost was applied, and its refusal says the outcome is not definite", async () => {
    const { fake, client } = erp();
    fake.writeFaults.push("lose_response");
    // The fault waits for a write, past a read.
    expect(await client.callTool("list_open_orders", { vendor_id: "V1" })).toBeDefined();
    const e = await refusal(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }));
    expect([e.kind, e.rule, e.definite]).toEqual(["connector_protocol", "network", false]);
    expect(fake.posted).toBe(1);
    // Sent again with the same invoice: the same draft, counted once.
    expect(await client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" })).toEqual({ draft_id: "D-INV-1" });
    expect(fake.posted).toBe(1);
  });

  it("a write answered 500 is not definite", async () => {
    const { fake, client } = erp();
    fake.writeFaults.push(500);
    const e = await refusal(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }));
    expect([e.kind, e.rule, e.definite, e.status]).toEqual(["connector_protocol", "status", false, 500]);
  });

  it("a result the caller's validator refuses, or throws on, is tool_result_mismatch", async () => {
    const { client } = erp();
    const no = await refusal(client.callTool("list_open_orders", { vendor_id: "V1" }, { validate: () => false }));
    expect([no.kind, no.rule, no.definite]).toEqual(["tool_result_mismatch", "validator", false]);
    const thrown = await refusal(
      client.callTool("list_open_orders", { vendor_id: "V1" }, {
        validate: () => {
          throw new Error("boom");
        },
      }),
    );
    expect([thrown.kind, thrown.rule]).toEqual(["tool_result_mismatch", "validator"]);
  });

  it("a tool's own error result is tool_result_mismatch, without its text; an unknown tool is the server's JSON-RPC error", async () => {
    const { fake, client } = erp();
    const e = await refusal(client.callTool("list_open_orders", {}));
    expect([e.kind, e.rule]).toEqual(["tool_result_mismatch", "is_error"]);
    fake.dropTool("find_draft_invoice");
    const unknown = await refusal(client.callTool("find_draft_invoice", { key: "k" }));
    expect([unknown.kind, unknown.rule, unknown.definite, unknown.code]).toEqual(["connector_protocol", "jsonrpc_error", true, -32602]);
  });

  it("a listing the client refuses is refused whole", async () => {
    for (const fault of ["two_events", "not_json", "notification", "wrong_id", "incomplete"] as McpFault[]) {
      const { fake, client } = erp();
      fake.faults.push(fault);
      expect((await refusal(client.listTools())).kind).toBe("connector_protocol");
    }
  });

  it("stops at the caller's signal: aborted, not definite, with no timer of its own", async () => {
    const { fake, client } = erp();
    fake.faults.push("stall");
    const ac = new AbortController();
    const p = refusal(client.callTool("post_draft_invoice", { m: MATCH, key: "op-1" }, { signal: ac.signal }));
    ac.abort();
    const e = await p;
    expect([e.kind, e.rule, e.definite]).toEqual(["connector_protocol", "aborted", false]);
    // A signal aborted before the call sends nothing.
    const before = fake.received.length;
    const pre = await refusal(client.listTools({ signal: AbortSignal.abort() }));
    expect(pre.rule).toBe("aborted");
    expect(fake.received).toHaveLength(before);
  });

  it("reads no more than MAX_ANSWER_BYTES of an answer that says it is longer", async () => {
    let pulled = 0;
    const client = new McpClient({
      url: ERP,
      fetch: async () =>
        new Response(
          new ReadableStream({
            pull(c) {
              pulled++;
              c.enqueue(new Uint8Array(1 << 20));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    });
    expect((await refusal(client.listTools())).rule).toBe("too_large");
    expect(pulled).toBeLessThanOrEqual(MAX_ANSWER_BYTES / (1 << 20) + 2);
    const declared = new McpClient({ url: ERP, fetch: async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(MAX_ANSWER_BYTES + 1) } }) });
    expect((await refusal(declared.listTools())).rule).toBe("too_large");
  });

  it("throws only its own errors for what the server or the network did; the runtime's own refusals pass through", async () => {
    const odd = new McpClient({
      url: ERP,
      fetch: async () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
    });
    expect((await refusal(odd.listTools())).rule).toBe("network");
    const gated = new McpClient({
      url: ERP,
      fetch: async () => {
        throw new Violation("egress_denied", "session_revoked: the egress proxy revoked the gateway's session");
      },
    });
    await expect(gated.listTools()).rejects.toThrow(Violation);
  });
});
