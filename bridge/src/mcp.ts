// The compiler as an MCP server (Doc 4 §14), written over the bridge's entry point (./index.js): agents ask the compiler
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
// Which tools there are, and what each takes, depends on the language the server serves (`language`, McpServer). The
// list is not kept here: for a language given it is the Rust compiler's door `mcp_tools`, which the native `mandate mcp`
// takes its list from too, so that the two servers cannot drift. Up to language 0.6 it is the frozen list (TOOLS, which
// the reference compiler's server has) and nothing changes. For 0.7 (spec/attention.md "The MCP server") `check`,
// `apply_patch`, `caps_of` and `project` take the libraries a lock pins (`apply_patch` and `caps_of` the lock too),
// `project` shows the card and the attention view, and `spec` serves the sections `patterns` and `attention`. No tool
// of any language signs, approves, decides or promotes.
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
//
// A message is bounded before it is handled (MESSAGE_LIMITS): its size while
// it is read, so an oversized line is never held in memory, then its arrays
// and nesting once it is parsed. A message over a limit gets an Invalid
// Request error, and the server goes on to the next line.

import { readFileSync } from "node:fs";
import type { Readable, Writable } from "node:stream";
import { architecture, atLeast, attentionView, authority, card, check, checkPatch, CODES, cost, hasErrors, isProgram07OrLater, LANGUAGE_07, LIMITS, load, loadModules, mcpTools, programRef, semanticDiff, type LanguageVersion, type LibrarySource, type Lock, type Modules, type PatchOp, type Program, type SourceKind } from "./index.js";
import { modulesOf } from "./libraries.js";
import { ptrToken, viewModules } from "./util.js";
import { CompilerFailure } from "./wasm/errors.js";

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
function program(source: string, kind: unknown, modules: Modules, lock?: Lock, libraries?: LibrarySource[]): Program {
  const r = check(source, kindFor(source, kind), { modules, ...(lock ? { lock } : {}), ...(libraries ? { libraries } : {}) });
  if (!r.ok) throw new ToolError(`the program does not check: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join("; ")}`);
  return r.program!;
}

/** 0.7: the sections that are a specification of their own, whole: `patterns` (spec/library.md) and `attention` (spec/attention.md). */
const SPEC_FILES: Record<string, string> = { patterns: "library.md", attention: "attention.md" };

function specText(section: unknown, v07 = false): string {
  const text = readFileSync(new URL("../../spec/core.md", import.meta.url), "utf8");
  if (section === undefined) return text;
  const want = String(section).trim();
  if (v07 && Object.hasOwn(SPEC_FILES, want)) return readFileSync(new URL(`../../spec/${SPEC_FILES[want]}`, import.meta.url), "utf8");
  const lines = text.split("\n");
  // The section is matched as the text it is, with no regular expression made of it (the reference compiler's server
  // makes one, escaping only `.`, so that there `(` is an error, `4+` or `\d` another section, and a section of more
  // than 32 765 characters too large an expression): a heading of two or three `#`, a space, the section, and then a
  // space, or a `.` and a space.
  const heads = (l: string): boolean => {
    const n = l.match(/^#*/)![0].length;
    const after = n + 1 + want.length;
    return (n === 2 || n === 3) && l.startsWith(` ${want}`, n) && (l.startsWith(" ", after) || l.startsWith(". ", after));
  };
  const start = lines.findIndex(heads);
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

/** A facade function called with an argument its TypeScript signature has not (the Rust's alone: 0.7's `std_patterns`, `opts`). */
type Loose = (...args: unknown[]) => any;

/** 0.7: whether a value is a library as a call gives one: a text `manifest` and `files`, an object of texts. What else it holds is the compiler's to refuse. */
function isLibrary(v: unknown): v is LibrarySource {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const { manifest, files } = v as { manifest?: unknown; files?: unknown };
  return typeof manifest === "string" && typeof files === "object" && files !== null && !Array.isArray(files) && Object.values(files).every((t) => typeof t === "string");
}

/** 0.7: the call's `libraries` when it has a non-empty list of them; a ToolError when it is not a list of libraries. */
function librariesArg(args: Record<string, unknown>): LibrarySource[] | undefined {
  if (!Object.hasOwn(args, "libraries")) return undefined;
  const given = args["libraries"];
  if (!Array.isArray(given) || !given.every(isLibrary)) throw new ToolError("libraries must be a list of libraries, each { manifest, files }");
  return given.length ? given : undefined;
}

/** 0.7: the version of `std.patterns` the lock pins, when it pins one: what a view is given, so that it shows the version the check read. */
function pinOf(lock: unknown): string | undefined {
  const version = (lock as { libraries?: { "std.patterns"?: { version?: unknown } } } | null | undefined)?.libraries?.["std.patterns"]?.version;
  return typeof version === "string" ? version : undefined;
}

/** 0.7: the call's modules and, when it gives libraries, theirs after them: what a view is given. */
function linkedModules(modules: Modules, libraries: LibrarySource[] | undefined): Modules {
  return libraries ? { ...modules, ...modulesOf(libraries) } : modules;
}

/** 0.7: `mandate.project`: a view of the program, its card, its attention view, or the diff from `before`. */
function project07(args: Record<string, unknown>, modules: Modules): unknown {
  const lock = args["lock"] ? (args["lock"] as Lock) : undefined;
  const source = str(args, "source");
  const libraries = librariesArg(args);
  const p = program(source, args["kind"], modules, lock, libraries);
  const linked = linkedModules(modules, libraries);
  const pin = pinOf(args["lock"]);
  switch (args["view"]) {
    case "architecture":
      return (architecture as Loose)(p, viewModules(linked, p), undefined, pin);
    case "authority":
      return (authority as Loose)(p, viewModules(linked, p), pin);
    case "cost":
      return (cost as Loose)(p, args["lock"], viewModules(linked, p), pin);
    case "diff": {
      const before = program(str(args, "before"), args["before_kind"], modules, undefined, libraries);
      return (semanticDiff as Loose)(before, p, undefined, viewModules(linked, before, p), pin);
    }
    // The envelope card of one workflow. A card of 0.7 is made by a check given the libraries; the door refuses, with
    // what is missing, a program that does not check with what it is given, and that is the tool's error.
    case "card": {
      const workflow = str(args, "workflow");
      let made: unknown;
      try {
        made = card(p, workflow, { modules: linked, ...(lock ? { lock } : {}), ...(libraries ? { libraries } : {}) });
      } catch (e) {
        if (e instanceof Error && !(e instanceof CompilerFailure)) throw new ToolError(e.message);
        throw e;
      }
      if (made === undefined) throw new ToolError(`${workflow} is not a workflow with an envelope of this program`);
      return made;
    }
    // The attention view of one workflow, or of each.
    case "attention": {
      if (!isProgram07OrLater(p)) throw new ToolError("view attention is of a program of language 0.7 or later");
      const opts = { modules, ...(lock ? { lock } : {}), ...(libraries ? { libraries } : {}), ...(lock && pin !== undefined ? { std_patterns: pin } : {}) };
      const kind = kindFor(source, args["kind"]);
      const ask = (workflow: string): { format: unknown; program: unknown } | null => attentionView({ text: source, kind, opts, workflow, format: "json" }) as { format: unknown; program: unknown } | null;
      if (args["workflow"] !== undefined && args["workflow"] !== null) {
        const workflow = str(args, "workflow");
        const view = ask(workflow);
        if (view === null) throw new ToolError(`${workflow} is not a workflow of this program`);
        return view;
      }
      const views = Object.entries(p.defs).filter(([, d]) => d.kind === "workflow").map(([name]) => ask(name));
      const first = views[0];
      if (first === undefined) throw new ToolError("this program has no workflow, so it has no attention view");
      return { format: first?.format, kind: "attention", program: first?.program, workflows: views };
    }
  }
  throw new ToolError("view must be architecture, authority, cost, diff, card or attention");
}

/**
 * Runs one tool; the structured result, or a ToolError for a call the tool cannot serve. `language` is the language the
 * server serves (McpServer): from 0.7 on a tool takes what the list of 0.7 says it takes; before it, or with none, it
 * is the frozen tool, unchanged.
 */
export function callTool(name: string, args: Record<string, unknown>, serverModules: Modules = {}, language?: string): unknown {
  const v07 = language !== undefined && atLeast(language as LanguageVersion, LANGUAGE_07);
  const modules = modulesFor(args, serverModules);
  switch (name) {
    case "mandate.check": {
      const source = str(args, "source");
      const libraries = v07 ? librariesArg(args) : undefined;
      const r = check(source, kindFor(source, args["kind"]), { modules, ...(args["lock"] ? { lock: args["lock"] as Lock } : {}), ...(libraries ? { libraries } : {}) });
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
      const base = str(args, "base");
      if (v07) {
        // The lock and the libraries, as `check` takes them: the door checks the patched program with them.
        const libraries = librariesArg(args);
        const lock = args["lock"] ? (args["lock"] as Lock) : undefined;
        const opts = lock || libraries ? [{ ...(lock ? { lock } : {}), ...(libraries ? { libraries } : {}) }] : [];
        return (checkPatch as Loose)(loaded.program, base, args["ops"] as PatchOp[], modules, ...opts);
      }
      return checkPatch(loaded.program, base, args["ops"] as PatchOp[], modules);
    }
    case "mandate.caps_of": {
      // 0.7: the lock and the libraries, as `check` and `project` take them.
      const libraries = v07 ? librariesArg(args) : undefined;
      const lock = v07 ? (args["lock"] as Lock | undefined) : undefined;
      const p = program(str(args, "source"), args["kind"], modules, lock, libraries);
      const who = str(args, "name");
      const shown = v07 ? ((authority as Loose)(p, viewModules(linkedModules(modules, libraries), p), pinOf(lock)) as ReturnType<typeof authority>) : authority(p, viewModules(modules, p));
      const rows = shown.rows.filter((r) => r.who === who || r.who === `${who} (remote)` || r.who.startsWith(`${who} → `));
      if (!rows.length) throw new ToolError(`${who} is not an agent or workflow of this program`);
      return { program: programRef(p), rows };
    }
    case "mandate.project": {
      if (v07) return project07(args, modules);
      const lock = args["lock"] as Lock | undefined;
      const p = program(str(args, "source"), args["kind"], modules, lock);
      switch (args["view"]) {
        // 0.6: a workflow that applies a pattern of a module is shown, and compared, as its expansion.
        case "architecture":
          return architecture(p, viewModules(modules, p));
        case "authority":
          return authority(p, viewModules(modules, p));
        case "cost":
          return cost(p, lock, viewModules(modules, p));
        case "diff": {
          const before = program(str(args, "before"), args["before_kind"], modules);
          return semanticDiff(before, p, undefined, viewModules(modules, before, p));
        }
      }
      throw new ToolError("view must be architecture, authority, cost or diff");
    }
    case "mandate.spec":
      return { text: specText(args["section"], v07) };
  }
  throw new ToolError(`no tool ${name}`);
}

/** One server: one process, which may open a legacy session with `initialize`. */
export class McpServer {
  private legacy: string | undefined;
  /** What `tools/list` gives: the tools, and what the modern era adds beside them. */
  private readonly list: { tools: ReadonlyArray<{ readonly name: string }>; modern: Record<string, unknown> };

  /**
   * `modules`: what every call's program may import, e.g. the system model (`mandate mcp --module <file>`).
   * `language`: the language whose tools the server serves, `mandate/0.1` to `mandate/0.7`, as the Rust compiler's door
   * `mcp_tools` lists them (a language it does not know is an Error). Left out, the frozen list (TOOLS), which is the
   * door's for each language up to 0.6 (test/mcp-0-7.test.ts).
   */
  constructor(private readonly modules: Modules = {}, private readonly language?: string) {
    if (language === undefined) this.list = { tools: TOOLS, modern: { ttlMs: 3_600_000, cacheScope: "public" } };
    else {
      const { tools, modern } = mcpTools(language);
      this.list = { tools, modern };
    }
  }

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
        return ok({ tools: this.list.tools, ...(modern ? this.list.modern : {}) }, modern);
      case "tools/call": {
        const name = params["name"];
        const args = (params["arguments"] && typeof params["arguments"] === "object" ? params["arguments"] : {}) as Record<string, unknown>;
        if (typeof name !== "string" || !this.list.tools.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
        try {
          const structured = callTool(name, args, this.modules, this.language);
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

/** What one JSON-RPC message may hold (CVE review K1). */
export const MESSAGE_LIMITS = {
  /** Bytes in one line, its line break not counted: as large as a program may be. */
  bytes: 1024 * 1024,
  /** Elements in any one array. */
  arrayItems: 10_000,
  /** Nesting depth: the IR's limit, with room for the request around an IR fragment (a patch op's value). */
  depth: LIMITS.jsonDepth + 8,
} as const;

/** A line longer than the limit: only its length was kept. */
export interface OversizedLine {
  tooLarge: number;
}

/**
 * The lines of a stream, decoded as UTF-8 and split where readline splits
 * them: at "\n", "\r\n" or a lone "\r". A line over `maxBytes` is read
 * through to its end without being kept, and comes out as its byte count.
 */
export async function* readLines(input: Readable, maxBytes: number): AsyncGenerator<string | OversizedLine> {
  let parts: Buffer[] = [];
  let size = 0;
  let afterCR = false;
  const take = (buf: Buffer, from: number, to: number) => {
    if (to <= from) return;
    size += to - from;
    if (size > maxBytes) parts = [];
    else parts.push(buf.subarray(from, to));
  };
  const finish = (): string | OversizedLine => {
    const line = size > maxBytes ? { tooLarge: size } : Buffer.concat(parts, size).toString("utf8");
    parts = [];
    size = 0;
    return line;
  };
  for await (const chunk of input) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    let from = 0;
    for (let i = 0; i < buf.length; i++) {
      const b = buf[i];
      if (afterCR) {
        afterCR = false;
        if (b === 0x0a) {
          from = i + 1;
          continue;
        }
      }
      if (b === 0x0a || b === 0x0d) {
        take(buf, from, i);
        yield finish();
        from = i + 1;
        afterCR = b === 0x0d;
      }
    }
    take(buf, from, buf.length);
  }
  if (size > 0) yield finish();
}

interface LimitBreach {
  reason: "E_ARRAY_TOO_LONG" | "E_INPUT_TOO_DEEP";
  message: string;
  limit: number;
  path: string;
}

/** The first array or nesting limit a parsed message breaks, if any. */
function overLimit(v: unknown, path = "", depth = 1): LimitBreach | undefined {
  if (depth > MESSAGE_LIMITS.depth) return { reason: "E_INPUT_TOO_DEEP", message: `Request nesting exceeds the depth limit of ${MESSAGE_LIMITS.depth}`, limit: MESSAGE_LIMITS.depth, path };
  if (v === null || typeof v !== "object") return undefined;
  if (Array.isArray(v)) {
    if (v.length > MESSAGE_LIMITS.arrayItems) return { reason: "E_ARRAY_TOO_LONG", message: `Request has an array of ${v.length} elements; the limit is ${MESSAGE_LIMITS.arrayItems}`, limit: MESSAGE_LIMITS.arrayItems, path };
    for (let i = 0; i < v.length; i++) {
      const r = overLimit(v[i], `${path}/${i}`, depth + 1);
      if (r) return r;
    }
    return undefined;
  }
  for (const [k, x] of Object.entries(v)) {
    const r = overLimit(x, `${path}/${ptrToken(k)}`, depth + 1);
    if (r) return r;
  }
  return undefined;
}

/** A parsed message's id, if it has one a response may carry. */
function idOf(msg: unknown): string | number | null {
  const id = msg && typeof msg === "object" && !Array.isArray(msg) ? (msg as { id?: unknown }).id : undefined;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

/** Serves newline-delimited JSON-RPC on a pair of streams until the input ends. */
export async function serveStdio(input: Readable = process.stdin, output: Writable = process.stdout, modules: Modules = {}, language?: string): Promise<void> {
  const server = new McpServer(modules, language);
  for await (const line of readLines(input, MESSAGE_LIMITS.bytes)) {
    if (typeof line !== "string") {
      const data = { reason: "E_INPUT_TOO_LARGE", limit: MESSAGE_LIMITS.bytes, bytes: line.tooLarge };
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `Request exceeds the ${MESSAGE_LIMITS.bytes}-byte message limit`, data } }) + "\n");
      continue;
    }
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n");
      continue;
    }
    const breach = overLimit(msg);
    if (breach) {
      const { message, ...data } = breach;
      output.write(JSON.stringify({ jsonrpc: "2.0", id: idOf(msg), error: { code: -32600, message, data } }) + "\n");
      continue;
    }
    let res: Response | undefined;
    try {
      res = server.handle(msg);
    } catch (e) {
      const id = msg && typeof msg === "object" && "id" in msg ? ((msg as { id: string | number | null }).id ?? null) : null;
      res = { jsonrpc: "2.0", id, error: { code: -32603, message: `Internal error: ${e instanceof CompilerFailure ? e.shown : (e as Error).message}` } };
    }
    if (res) output.write(JSON.stringify(res) + "\n");
  }
}
