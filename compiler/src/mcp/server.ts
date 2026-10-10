// The compiler as an MCP server (Doc 4 §14): agents ask the compiler
// directly, as tools, instead of going through a shell.
//
//   mandate.check        program text or IR → diagnostics and hashes
//   mandate.explain      a diagnostic code → what it means
//   mandate.apply_patch  a program, the hash a patch was written against, RFC 6902 operations
//                        → the new program and hash, diagnostics, and the governance changes it makes
//   mandate.caps_of      a program and an agent or workflow → what it may do (the authority view)
//   mandate.project      a program → a human view: architecture, authority, cost, or a diff
//   mandate.spec         the core specification, or one of its sections
//
// The server only computes. It reads no file and writes none, runs nothing
// and holds no credentials: a patch's result is returned, never saved. A
// patch that widens authority, raises a budget, removes a criterion or adds
// an irreversible effect is reported as needing a person's approval (§13.2);
// the server cannot grant it.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdio. The server is dual-era
// (MCP 2026-07-28, "Versioning and Compatibility"):
//
//   modern   every request names its protocol version in
//            _meta["io.modelcontextprotocol/protocolVersion"]; `server/discover`
//            advertises the versions; an unknown version gets
//            UnsupportedProtocolVersionError (-32022) with the supported list
//   legacy   an `initialize` request (2025-11-25 and earlier) opens a session
//            for this process, served per the negotiated revision

import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import { check, load, loadModules, type SourceKind } from "../check.js";
import type { Modules } from "../modules.js";
import { CODES } from "../codes.js";
import type { Lock } from "../lock.js";
import { hasErrors } from "../diag.js";
import type { Program } from "../ir/types.js";
import { applyPatch, type PatchOp } from "../patch/patch.js";
import { architecture, authority, cost, programRef, semanticDiff } from "../views/views.js";

export const MODERN_VERSIONS = ["2026-07-28"];
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const META = "io.modelcontextprotocol/";
const SERVER_INFO = { name: "mandate-compiler", version: "0.2.0" };
const INSTRUCTIONS =
  "Mandate's compiler. Check a program before proposing it, read a diagnostic's code and repair, and change programs with apply_patch against the hash you read. A patch that widens authority, raises a budget, removes a criterion or adds an irreversible effect needs a person's approval; you cannot grant it.";

interface Request {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type Response = { jsonrpc: "2.0"; id: string | number | null; result: unknown } | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string; data?: unknown } };

const SOURCE = { type: "string", description: "The program: .mdt text or canonical JSON IR." };
const KIND = { type: "string", enum: ["mdt", "json"], description: "What `source` is. Default: json if it starts with '{', else mdt." };
const MODULES = {
  type: "array",
  items: { type: "string" },
  description: "Modules the program imports with `use` (e.g. a system model), each as .mdt text or JSON IR. Added to the modules the server was started with (`mandate mcp --module <file>`).",
};

/** The tools, as `tools/list` gives them. Input schemas are JSON Schema 2020-12. */
export const TOOLS = [
  {
    name: "mandate.check",
    title: "Check a program",
    description: "Validates a Mandate program (text or IR), resolves names and runs every static check. Returns ok, the program and definition hashes, and the diagnostics with their codes, facts and repair patches.",
    inputSchema: { type: "object", properties: { source: SOURCE, kind: KIND, modules: MODULES, lock: { type: "object", description: "The lock file (mandate.lock.json), to check model tiers and W0504." } }, required: ["source"], additionalProperties: false },
  },
  {
    name: "mandate.explain",
    title: "Explain a diagnostic code",
    description: "What a diagnostic code such as MDT-E0320 or E0320 means and how to fix it.",
    inputSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"], additionalProperties: false },
  },
  {
    name: "mandate.apply_patch",
    title: "Apply an IR patch",
    description:
      "Applies RFC 6902 operations (add, remove, replace) to a program's canonical IR, against the program hash they were written for. A stale base is refused (MDT-E0130). Returns the new program and hash, its diagnostics, and the governance changes it makes; those need a person's approval. Nothing is saved.",
    inputSchema: {
      type: "object",
      properties: {
        source: SOURCE,
        kind: KIND,
        modules: MODULES,
        base: { type: "string", description: "The program hash the patch was written against, sha256:…" },
        ops: { type: "array", items: { type: "object", properties: { op: { enum: ["add", "remove", "replace"] }, path: { type: "string" }, value: {} }, required: ["op", "path"], additionalProperties: false } },
      },
      required: ["source", "base", "ops"],
      additionalProperties: false,
    },
  },
  {
    name: "mandate.caps_of",
    title: "Authority of an agent or workflow",
    description: "The paths, hosts, model tiers, commands, repositories, money and external effects an agent or workflow may use, and each of its delegations' grants.",
    inputSchema: { type: "object", properties: { source: SOURCE, kind: KIND, modules: MODULES, name: { type: "string" } }, required: ["source", "name"], additionalProperties: false },
  },
  {
    name: "mandate.project",
    title: "A human view of a program",
    description: "A view people review (§15): architecture, authority or cost of a program, or the semantic diff from `before` (governance changes, behavior changes, what stayed the same).",
    inputSchema: {
      type: "object",
      properties: { source: SOURCE, kind: KIND, modules: MODULES, view: { enum: ["architecture", "authority", "cost", "diff"] }, before: { type: "string", description: "For diff: the earlier program." }, before_kind: KIND, lock: { type: "object" } },
      required: ["source", "view"],
      additionalProperties: false,
    },
  },
  {
    name: "mandate.spec",
    title: "The core specification",
    description: "Mandate's core specification (spec/core.md), whole or one numbered section, e.g. 4 for capabilities.",
    inputSchema: { type: "object", properties: { section: { type: "string", description: "A section number such as 4 or 7.2." } }, additionalProperties: false },
  },
] as const;

class ToolError extends Error {}

function kindFor(source: string, kind: unknown): SourceKind {
  if (kind === "mdt" || kind === "json") return kind;
  return source.trimStart().startsWith("{") ? "json" : "mdt";
}

function str(args: Record<string, unknown>, k: string): string {
  const v = args[k];
  if (typeof v !== "string") throw new ToolError(`${k} must be a string`);
  return v;
}

/** A program that passes its checks, or a ToolError with the diagnostics. */
function program(source: string, kind: unknown, modules: Modules, lock?: Lock): Program {
  const r = check(source, kindFor(source, kind), { modules, ...(lock ? { lock } : {}) });
  if (!r.ok) throw new ToolError(`the program does not check: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return r.program!;
}

function specText(section: unknown): string {
  const text = readFileSync(new URL("../../../spec/core.md", import.meta.url), "utf8");
  if (section === undefined) return text;
  const want = String(section).trim();
  const lines = text.split("\n");
  const start = lines.findIndex((l) => new RegExp(`^#{2,3} ${want.replace(/\./g, "\\.")}\\.? `).test(l));
  if (start < 0) throw new ToolError(`no section ${want} in the core specification`);
  const depth = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= depth);
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** The server's modules and the call's own: what a program's `use` may import. */
function modulesFor(args: Record<string, unknown>, base: Modules): Modules {
  const given = args["modules"];
  if (given === undefined) return base;
  if (!Array.isArray(given) || !given.every((m) => typeof m === "string")) throw new ToolError("modules must be a list of module sources");
  const { modules, problems } = loadModules(given.map((text, i) => ({ file: `modules[${i}]`, text, kind: kindFor(text, undefined) })));
  if (problems.length) throw new ToolError(`a module does not load: ${problems.flatMap((p) => p.diagnostics.map((d) => `${p.file}: ${d.code} ${d.message}`)).join("; ")}`);
  return { ...base, ...modules };
}

/** Runs one tool; the structured result, or a ToolError for a call the tool cannot serve. */
export function callTool(name: string, args: Record<string, unknown>, serverModules: Modules = {}): unknown {
  const modules = modulesFor(args, serverModules);
  switch (name) {
    case "mandate.check": {
      const source = str(args, "source");
      const r = check(source, kindFor(source, args["kind"]), { modules, ...(args["lock"] ? { lock: args["lock"] as Lock } : {}) });
      return { ok: r.ok, ...(r.hashes ? { hashes: r.hashes } : {}), diagnostics: r.diagnostics };
    }
    case "mandate.explain": {
      const raw = str(args, "code");
      const code = raw.startsWith("MDT-") ? raw : `MDT-${raw}`;
      const entry = CODES[code];
      if (!entry) throw new ToolError(`unknown code ${raw}`);
      return { code, ...entry };
    }
    case "mandate.apply_patch": {
      const source = str(args, "source");
      const loaded = load(source, kindFor(source, args["kind"]));
      if (!loaded.program || hasErrors(loaded.diagnostics)) return { ok: false, diagnostics: loaded.diagnostics, governance: [] };
      if (!Array.isArray(args["ops"])) throw new ToolError("ops must be a list of RFC 6902 operations");
      const r = applyPatch(loaded.program, str(args, "base"), args["ops"] as PatchOp[]);
      // The patched program's own checks, so the agent sees what it would be asked to fix next.
      const checked = r.program ? check(JSON.stringify(r.program), "json", { modules }) : undefined;
      return {
        ok: r.ok && !!checked?.ok,
        ...(r.hash ? { hash: r.hash } : {}),
        diagnostics: [...r.diagnostics, ...(checked?.diagnostics ?? [])],
        governance: r.governance,
        requires_approval: r.governance.length > 0,
        ...(r.program ? { program: r.program } : {}),
      };
    }
    case "mandate.caps_of": {
      const p = program(str(args, "source"), args["kind"], modules);
      const who = str(args, "name");
      const rows = authority(p).rows.filter((r) => r.who === who || r.who === `${who} (remote)` || r.who.startsWith(`${who} → `));
      if (!rows.length) throw new ToolError(`${who} is not an agent or workflow of this program`);
      return { program: programRef(p), rows };
    }
    case "mandate.project": {
      const lock = args["lock"] as Lock | undefined;
      const p = program(str(args, "source"), args["kind"], modules, lock);
      switch (args["view"]) {
        case "architecture":
          return architecture(p);
        case "authority":
          return authority(p);
        case "cost":
          return cost(p, lock);
        case "diff":
          return semanticDiff(program(str(args, "before"), args["before_kind"], modules), p);
      }
      throw new ToolError("view must be architecture, authority, cost or diff");
    }
    case "mandate.spec":
      return { text: specText(args["section"]) };
  }
  throw new ToolError(`no tool ${name}`);
}

/** One server: one process, which may open a legacy session with `initialize`. */
export class McpServer {
  private legacy: string | undefined;

  /** `modules`: what every call's program may import, e.g. the system model (`mandate mcp --module <file>`). */
  constructor(private readonly modules: Modules = {}) {}

  /** Answers one JSON-RPC message; undefined for a notification. */
  handle(msg: unknown): Response | undefined {
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } };
    const req = msg as Request;
    const id = req.id ?? null;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    const notification = req.id === undefined;
    const params = (req.params && typeof req.params === "object" ? req.params : {}) as Record<string, unknown>;
    const meta = (params["_meta"] && typeof params["_meta"] === "object" ? params["_meta"] : {}) as Record<string, unknown>;
    const ok = (result: Record<string, unknown>, modern: boolean): Response => ({
      jsonrpc: "2.0",
      id,
      result: modern ? { resultType: "complete", ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } } : result,
    });
    const fail = (code: number, message: string, data?: unknown): Response => ({ jsonrpc: "2.0", id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

    // Legacy era: the handshake opens a session for this process.
    if (req.method === "initialize") {
      const asked = String(params["protocolVersion"] ?? "");
      const version = LEGACY_VERSIONS.includes(asked) ? asked : LEGACY_VERSIONS[0]!;
      this.legacy = version;
      return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, false);
    }
    if (notification) return undefined;

    const requested = meta[`${META}protocolVersion`];
    let modern: boolean;
    if (typeof requested === "string") {
      if (!MODERN_VERSIONS.includes(requested)) return fail(-32022, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested });
      modern = true;
    } else if (this.legacy) modern = false;
    else if (req.method === "server/discover") modern = true;
    else return fail(-32022, "Unsupported protocol version", { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested: null });

    switch (req.method) {
      case "server/discover":
        return ok({ supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "public" }, true);
      case "ping":
        return ok({}, modern);
      case "tools/list":
        return ok({ tools: TOOLS, ...(modern ? { ttlMs: 3_600_000, cacheScope: "public" } : {}) }, modern);
      case "tools/call": {
        const name = params["name"];
        const args = (params["arguments"] && typeof params["arguments"] === "object" ? params["arguments"] : {}) as Record<string, unknown>;
        if (typeof name !== "string" || !TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
        try {
          const structured = callTool(name, args, this.modules);
          return ok({ content: [{ type: "text", text: JSON.stringify(structured, null, 2) }], structuredContent: structured, isError: false }, modern);
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          // A call the tool cannot serve is a tool result the model can read and act on, not a protocol error.
          return ok({ content: [{ type: "text", text: e.message }], isError: true }, modern);
        }
      }
    }
    return fail(-32601, `Method not found: ${req.method}`);
  }
}

/** Serves newline-delimited JSON-RPC on a pair of streams until the input ends. */
export async function serveStdio(input: Readable = process.stdin, output: Writable = process.stdout, modules: Modules = {}): Promise<void> {
  const server = new McpServer(modules);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    let res: Response | undefined;
    try {
      res = server.handle(msg);
    } catch (e) {
      const id = msg && typeof msg === "object" && "id" in msg ? ((msg as { id: string | number | null }).id ?? null) : null;
      res = { jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${(e as Error).message}` } };
    }
    if (res) output.write(JSON.stringify(res) + "\n");
  }
}
