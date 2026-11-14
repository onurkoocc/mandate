// The runtime's MCP client (spec/library.md "The MCP the runtime speaks"): a
// narrow part of MCP over HTTP, and the rest refused by name.
//
// - Each request is one JSON-RPC 2.0 request, POSTed alone, with
//   `content-type: application/json`, `accept: application/json,
//   text/event-stream`, and the protocol version in its `_meta`, as the
//   stateless revision 2026-07-28 has it: no `initialize`, no session, and
//   only `tools/list` and `tools/call`.
// - An answer is a 200 with one JSON-RPC response to the request's id, as
//   `application/json` or as a `text/event-stream` of exactly one event.
//   Anything else is `connector_protocol`.
// - A `tools/call` result carries `structuredContent`; one without it, or
//   with `isError: true`, or that the caller's validator refuses, is
//   `tool_result_mismatch`. The text `content` of a result is never read.
// - What comes from the server is untrusted: an error names what came by a
//   bounded, classified description (the status, the media type, the rule it
//   broke, a JSON-RPC error's code), never by the server's own text. Tool
//   descriptions, titles and annotations are dropped here: a listed tool is
//   its name, its two schemas and their digest.
//
// The client gets its `fetch` from outside: in production a connector
// gateway's, which sends through the egress proxy with a placeholder where
// the credential goes (gateway.ts); in tests a fake's. It holds no secret.

import { DENIAL_REASONS, type DenialReason } from "./egress/proxy.js";
import { sha256Of } from "./artifacts.js";
import { denialOf } from "./gateway.js";
import { Violation } from "./signals.js";
import { canonical, isObj, type Value } from "./values.js";

/** The one MCP revision the client speaks: the stateless one (spec/mcp.md "Protocol"). */
export const MCP_PROTOCOL_VERSION = "2026-07-28";
/** Where a request names its protocol version. */
export const PROTOCOL_VERSION_META = "io.modelcontextprotocol/protocolVersion";

/** The most bytes of one answer read into memory; a longer one is refused, `too_large`. */
export const MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** The most `tools/list` pages followed; a server that has more is refused, `too_many_pages`. */
export const MAX_LIST_PAGES = 32;
/** The deepest nesting of an answer's JSON; a deeper one is refused, `too_deep`. */
export const MAX_JSON_DEPTH = 128;
/** The longest tool name taken from `tools/list` (MCP's own bound), of its characters only. */
export const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;

/** What a client refuses: the code of `spec/library.md` "Refusals", or the proxy's denial. */
export type McpErrorKind = "connector_protocol" | "tool_result_mismatch" | "egress_denied";

/** Which rule an answer broke. */
export type McpRule =
  // connector_protocol
  | "network"
  | "aborted"
  | "status"
  | "content_type"
  | "too_large"
  | "not_json"
  | "too_deep"
  | "events"
  | "not_response"
  | "server_message"
  | "wrong_id"
  | "jsonrpc_error"
  | "bad_result"
  | "incomplete_result"
  | "duplicate_tool"
  | "cursor_repeated"
  | "too_many_pages"
  // tool_result_mismatch
  | "no_structured_content"
  | "is_error"
  | "validator"
  // egress_denied
  | "denied";

const DESCRIBE: Record<McpRule, string> = {
  network: "the request failed at the network level, or its answer was cut",
  aborted: "the caller's signal aborted it",
  status: "the answer's status is not 200",
  content_type: "the answer is neither application/json nor text/event-stream",
  too_large: `the answer is longer than ${MAX_ANSWER_BYTES} bytes`,
  not_json: "the answer is not UTF-8 JSON",
  too_deep: `the answer's JSON is nested deeper than ${MAX_JSON_DEPTH}`,
  events: "the event stream does not carry exactly one message event",
  not_response: "the answer is not one JSON-RPC 2.0 response",
  server_message: "the server sent a request or a notification instead of a response",
  wrong_id: "the response is to another request",
  jsonrpc_error: "the server answered with a JSON-RPC error",
  bad_result: "the result is not of the form the method returns",
  incomplete_result: "the result is not complete",
  duplicate_tool: "tools/list lists a tool twice",
  cursor_repeated: "tools/list gave a cursor it gave before",
  too_many_pages: `tools/list has more than ${MAX_LIST_PAGES} pages`,
  no_structured_content: "the result carries no structuredContent",
  is_error: "the result is an error (isError)",
  validator: "the result does not fit the tool's declared type",
  denied: "the egress proxy denied the request; it was not sent upstream",
};

/** The fields an error carries: each classified or bounded, none the server's own text. */
export interface McpErrorFields {
  kind: McpErrorKind;
  rule: McpRule;
  /**
   * Whether the answer proves the server did not apply the request: true for the proxy's denial and for a JSON-RPC
   * error response; false whenever the request may have reached the server and done what it asked (a network
   * failure after it was sent, an abort, another status, a lost, malformed or mismatched answer). A write whose error
   * is not definite is `unknown_outcome`, to be reconciled.
   */
  definite: boolean;
  method: "tools/list" | "tools/call";
  /** The tool called, as the caller named it. */
  tool?: string;
  status?: number;
  /** The answer's media type, lower case, when it is a well-formed one; `other` when it is not. */
  contentType?: string;
  /** A JSON-RPC error's code. */
  code?: number;
  /** How many message events an event stream carried. */
  events?: number;
  /** The proxy's reason, when it denied the request: one of its reasons, or `other`. */
  reason?: DenialReason | "other";
}

/** A refusal of the client: what the server or the network did, by kind and rule, never in the server's words. */
export class McpError extends Error implements McpErrorFields {
  readonly kind: McpErrorKind;
  readonly rule: McpRule;
  readonly definite: boolean;
  readonly method: "tools/list" | "tools/call";
  readonly tool?: string;
  readonly status?: number;
  readonly contentType?: string;
  readonly code?: number;
  readonly events?: number;
  readonly reason?: DenialReason | "other";

  constructor(f: McpErrorFields) {
    const what = [f.status !== undefined ? `HTTP ${f.status}` : "", f.contentType ? f.contentType : "", f.code !== undefined ? `code ${f.code}` : "", f.events !== undefined ? `${f.events} events` : "", f.reason ? f.reason : ""].filter(Boolean).join(", ");
    super(`${f.kind}: ${f.method}${f.tool ? ` ${f.tool}` : ""}: ${f.rule}: ${DESCRIBE[f.rule]}${what ? ` (${what})` : ""}`);
    this.kind = f.kind;
    this.rule = f.rule;
    this.definite = f.definite;
    this.method = f.method;
    if (f.tool !== undefined) this.tool = f.tool;
    if (f.status !== undefined) this.status = f.status;
    if (f.contentType !== undefined) this.contentType = f.contentType;
    if (f.code !== undefined) this.code = f.code;
    if (f.events !== undefined) this.events = f.events;
    if (f.reason !== undefined) this.reason = f.reason;
  }
}

/** The proxy's denial of a request (spec/egress.md "Denials"): nothing of it was sent upstream. */
export class McpDenied extends McpError {
  declare readonly reason: DenialReason | "other";
  constructor(f: Omit<McpErrorFields, "kind" | "rule" | "definite"> & { reason: DenialReason | "other" }) {
    super({ ...f, kind: "egress_denied", rule: "denied", definite: true });
  }
}

/** A tool as `tools/list` gives it, without its description, title or annotations. */
export interface ListedTool {
  name: string;
  inputSchema: Value;
  outputSchema?: Value;
  /** `sha256:<hex>` of the JCS bytes of `{ name, inputSchema, outputSchema }` as listed. */
  digest: string;
}

/** The `fetch` the client sends with: a gateway's, or a test's. */
export type McpFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface McpClientOptions {
  /** The server's URL: what each request is POSTed to. */
  url: string;
  fetch: McpFetch;
}

export interface CallOptions {
  /** Aborts the request, and the reading of its answer: the caller's timeout. */
  signal?: AbortSignal;
}

export interface ToolCallOptions extends CallOptions {
  /** Whether `structuredContent` fits the tool's declared type; false, or a throw, is `tool_result_mismatch`. */
  validate?: (structuredContent: Value) => boolean;
}

/**
 * The schema digest of a tool (spec/library.md "The lock binding and schema digests"): `sha256:<hex>` of the JCS
 * bytes of `{ "name", "inputSchema", "outputSchema" }` as `tools/list` gives them, with the runtime's own canonical
 * JSON. A tool that lists no `outputSchema` is digested without it.
 */
export function schemaDigest(tool: { name: string; inputSchema: Value; outputSchema?: Value }): string {
  const v: Record<string, Value> = { name: tool.name, inputSchema: tool.inputSchema };
  if (tool.outputSchema !== undefined) v["outputSchema"] = tool.outputSchema;
  return sha256Of(canonical(v));
}

type Method = McpErrorFields["method"];
type Where = { method: Method; tool?: string };

/** The narrow MCP client: `tools/list` and `tools/call`, one request at a time, each POSTed alone. */
export class McpClient {
  private next = 0;

  constructor(private readonly o: McpClientOptions) {}

  /** Every tool the server lists, following `nextCursor`, as its name, schemas and digest. */
  async listTools(opts: CallOptions = {}): Promise<ListedTool[]> {
    const where: Where = { method: "tools/list" };
    const tools = new Map<string, ListedTool>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_LIST_PAGES) throw this.refuse(where, "too_many_pages");
      const r = await this.request(where, cursor === undefined ? {} : { cursor }, opts.signal);
      const listed = r["tools"];
      if (!Array.isArray(listed)) throw this.refuse(where, "bad_result");
      for (const t of listed) {
        if (!isObj(t)) throw this.refuse(where, "bad_result");
        const name = t["name"];
        const inputSchema = t["inputSchema"];
        const outputSchema = t["outputSchema"];
        if (typeof name !== "string" || !TOOL_NAME.test(name) || !isObj(inputSchema ?? null) || (outputSchema !== undefined && !isObj(outputSchema))) throw this.refuse(where, "bad_result");
        if (tools.has(name)) throw this.refuse(where, "duplicate_tool");
        const tool: Omit<ListedTool, "digest"> = { name, inputSchema: inputSchema!, ...(outputSchema !== undefined ? { outputSchema } : {}) };
        tools.set(name, { ...tool, digest: schemaDigest(tool) });
      }
      const nextCursor = r["nextCursor"];
      if (nextCursor === undefined) return [...tools.values()];
      if (typeof nextCursor !== "string") throw this.refuse(where, "bad_result");
      if (cursors.has(nextCursor)) throw this.refuse(where, "cursor_repeated");
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  /** Calls `tool` with `args`, and answers its `structuredContent`; its text `content` is never read. */
  async callTool(tool: string, args: Record<string, Value>, opts: ToolCallOptions = {}): Promise<Value> {
    const where: Where = { method: "tools/call", tool };
    const r = await this.request(where, { name: tool, arguments: args }, opts.signal);
    if (r["isError"] === true) throw this.refuse(where, "is_error", "tool_result_mismatch");
    if (!("structuredContent" in r) || r["structuredContent"] === undefined) throw this.refuse(where, "no_structured_content", "tool_result_mismatch");
    const value = r["structuredContent"] as Value;
    if (opts.validate) {
      let fits: boolean;
      try {
        fits = opts.validate(value) === true;
      } catch {
        fits = false;
      }
      if (!fits) throw this.refuse(where, "validator", "tool_result_mismatch");
    }
    return value;
  }

  private refuse(where: Where, rule: McpRule, kind: McpErrorKind = "connector_protocol", more: Partial<McpErrorFields> = {}): McpError {
    return new McpError({ kind, rule, definite: rule === "jsonrpc_error", ...where, ...more });
  }

  /** One request and its answer's `result`, an object; every other answer is refused. */
  private async request(where: Where, params: Record<string, Value>, signal: AbortSignal | undefined): Promise<Record<string, Value>> {
    const id = ++this.next;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method: where.method, params: { ...params, _meta: { [PROTOCOL_VERSION_META]: MCP_PROTOCOL_VERSION } } });
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body,
      // A redirect is an answer like another status: followed, it would leave the gateway's session.
      redirect: "manual",
      ...(signal ? { signal } : {}),
    };
    if (signal?.aborted) throw this.refuse(where, "aborted");
    let res: Response;
    try {
      res = await this.o.fetch(this.o.url, init);
    } catch (e) {
      throw this.failed(where, e, signal);
    }
    const why = denialOf(res.headers);
    if (why !== undefined) {
      await discard(res);
      throw new McpDenied({ ...where, status: res.status, reason: (DENIAL_REASONS as readonly string[]).includes(why) ? (why as DenialReason) : "other" });
    }
    const contentType = mediaType(res.headers.get("content-type"));
    if (res.status !== 200) {
      await discard(res);
      throw this.refuse(where, "status", "connector_protocol", { status: res.status, ...(contentType ? { contentType } : {}) });
    }
    if (contentType !== "application/json" && contentType !== "text/event-stream") {
      await discard(res);
      throw this.refuse(where, "content_type", "connector_protocol", { status: 200, ...(contentType ? { contentType } : {}) });
    }
    const bytes = await this.read(where, res, signal);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw this.refuse(where, "not_json", "connector_protocol", { contentType });
    }
    let message: string = text;
    if (contentType === "text/event-stream") {
      const events = messageEvents(text);
      if (events === undefined || events.length !== 1) throw this.refuse(where, "events", "connector_protocol", { contentType, ...(events ? { events: events.length } : {}) });
      message = events[0]!;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      throw this.refuse(where, "not_json", "connector_protocol", { contentType });
    }
    if (tooDeep(parsed)) throw this.refuse(where, "too_deep", "connector_protocol", { contentType });
    return this.resultOf(where, parsed as Value, id);
  }

  /** The `result` of a JSON-RPC response to `id`, which must be a complete object. */
  private resultOf(where: Where, v: Value, id: number): Record<string, Value> {
    if (!isObj(v)) throw this.refuse(where, "not_response");
    if ("method" in v) throw this.refuse(where, "server_message");
    if (v["jsonrpc"] !== "2.0" || !("id" in v)) throw this.refuse(where, "not_response");
    if (v["id"] !== id) throw this.refuse(where, "wrong_id");
    const hasResult = "result" in v;
    const hasError = "error" in v;
    if (hasResult === hasError) throw this.refuse(where, "not_response");
    if (hasError) {
      const err = v["error"];
      const code = isObj(err ?? null) ? (err as Record<string, Value>)["code"] : undefined;
      if (typeof code !== "number" || !Number.isSafeInteger(code)) throw this.refuse(where, "not_response");
      throw this.refuse(where, "jsonrpc_error", "connector_protocol", { code });
    }
    const result = v["result"];
    if (!isObj(result ?? null)) throw this.refuse(where, "bad_result");
    const r = result as Record<string, Value>;
    if (r["resultType"] !== undefined && r["resultType"] !== "complete") throw this.refuse(where, "incomplete_result");
    return r;
  }

  /** The answer's body, at most `MAX_ANSWER_BYTES`; a longer one is refused before it is all read. */
  private async read(where: Where, res: Response, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > MAX_ANSWER_BYTES) {
      await discard(res);
      throw this.refuse(where, "too_large", "connector_protocol", { status: res.status });
    }
    if (!res.body) return new Uint8Array(0);
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ANSWER_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw this.refuse(where, "too_large", "connector_protocol", { status: res.status });
        }
        parts.push(value);
      }
    } catch (e) {
      if (e instanceof McpError) throw e;
      throw this.failed(where, e, signal);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  }

  /**
   * What a `fetch` that threw, or a body that could not be read, is. The runtime's own refusals (a gateway's
   * `Violation`, such as a session it will not replace) pass through unchanged; a caller's abort is `aborted`; every
   * other failure is the network's.
   */
  private failed(where: Where, e: unknown, signal: AbortSignal | undefined): Error {
    if (e instanceof McpError || e instanceof Violation) return e;
    if (signal?.aborted) return this.refuse(where, "aborted");
    return this.refuse(where, "network");
  }
}

/** Cancels a body the client will not read. */
async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/** A content type's media type, lower case; `other` for one that is not of the form `type/subtype`. */
function mediaType(header: string | null): string | undefined {
  if (header === null) return undefined;
  const t = header.split(";")[0]!.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(t) ? t : "other";
}

/**
 * The data of each message event of an event stream (the WHATWG event-stream format): blocks ended by a blank line,
 * `data` lines joined. An event of another type makes the stream undefined. An event whose data is empty carries no
 * message (a server's priming event, which names only an id) and is not counted; nor is a block the stream ended in
 * the middle of, which the format discards.
 */
function messageEvents(text: string): string[] | undefined {
  const lines = (text.startsWith("﻿") ? text.slice(1) : text).split(/\r\n|\r|\n/);
  // The last element follows the stream's last line break: an unfinished line, which ends no block.
  lines.pop();
  const out: string[] = [];
  let data: string[] = [];
  let type = "";
  let other = false;
  for (const line of lines) {
    if (line === "") {
      if (data.length) {
        if (type !== "" && type !== "message") other = true;
        const d = data.join("\n");
        if (d !== "") out.push(d);
      }
      data = [];
      type = "";
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") type = value;
  }
  return other ? undefined : out;
}

/** Whether a parsed JSON value nests deeper than `MAX_JSON_DEPTH`, walked without recursion. */
function tooDeep(v: unknown): boolean {
  const stack: Array<[unknown, number]> = [[v, 1]];
  while (stack.length) {
    const [x, d] = stack.pop()!;
    if (typeof x !== "object" || x === null) continue;
    if (d > MAX_JSON_DEPTH) return true;
    for (const y of Array.isArray(x) ? x : Object.values(x)) stack.push([y, d + 1]);
  }
  return false;
}
