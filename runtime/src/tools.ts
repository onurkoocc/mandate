// An agent's tools, derived one to one from the capabilities its delegation
// was granted (Doc 4 §8.2 step 2; BACKLOG K8):
//
//   fs.read(P…)   read_file, list_dir, grep
//   fs.write(P…)  write_file, only inside P
//   exec(…)       run, only the listed commands and argument prefixes
//
// plus `finish`, which hands back the skill's result. The tools are defined
// here, in the runtime, and each one runs as a process inside the agent's
// sandbox (`SandboxHost.execute`), so the sandbox enforces the same scope a
// second time. The runtime checks scope first only to give the model a clear
// answer; the sandbox is what holds.

import { posix } from "node:path";
import type { CapVal } from "@mandate/compiler";
import type { ToolSpec } from "./adapters.js";
import type { ExecRequest, ExecResult } from "./sandbox.js";
import type { JsonSchema } from "./schema.js";
import { canonical, type Value } from "./values.js";

/** Longest tool output a model sees; the rest is cut and marked. */
export const MAX_TOOL_OUTPUT = 20_000;

/** The shell script `write_file` runs: `sh -c WRITE_SCRIPT sh <path>`, with the content on stdin. */
export const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

export const FINISH = "finish";
export const SUBMIT_PLAN = "submit_plan";

export interface Scope {
  read: string[];
  write: string[];
  exec: Array<{ command: string; argsPrefix?: string[][] }>;
}

export interface AgentTools {
  scope: Scope;
  /** What the model is offered, `finish` included. */
  specs: ToolSpec[];
  /** The tools that act on the world (not `finish` or `submit_plan`), by name. */
  names: Set<string>;
  /** Working directory of `run`: the first path the agent may read. */
  cwd: string | undefined;
}

export function scopeOf(grants: CapVal[]): Scope {
  const read = grants.filter((c) => c.ctor === "fs.read" || c.ctor === "fs.write").flatMap((c) => c.scope ?? []).map(norm);
  const write = grants.filter((c) => c.ctor === "fs.write").flatMap((c) => c.scope ?? []).map(norm);
  const exec = grants.filter((c) => c.ctor === "exec").flatMap((c) => (c.scope ?? []).map((command) => ({ command, ...(c.argsPrefix ? { argsPrefix: c.argsPrefix } : {}) })));
  return { read: [...new Set(read)].sort(), write: [...new Set(write)].sort(), exec };
}

const STR = { type: "string" };
const obj = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

export function toolsFor(grants: CapVal[], result: JsonSchema): AgentTools {
  const scope = scopeOf(grants);
  const specs: ToolSpec[] = [];
  const list = (xs: string[]): string => xs.join(", ");
  if (scope.read.length) {
    specs.push(
      { name: "read_file", description: `Read a text file. You may read under: ${list(scope.read)}.`, input_schema: obj({ path: STR }, ["path"]) as Value },
      { name: "list_dir", description: `List a directory. You may read under: ${list(scope.read)}.`, input_schema: obj({ path: STR }, ["path"]) as Value },
      {
        name: "grep",
        description: `Search files under a path for a regular expression (grep -rn). You may read under: ${list(scope.read)}.`,
        input_schema: obj({ pattern: STR, path: STR }, ["pattern", "path"]) as Value,
      },
    );
  }
  if (scope.write.length) {
    specs.push({
      name: "write_file",
      description: `Write a whole text file, creating directories as needed. You may write only under: ${list(scope.write)}.`,
      input_schema: obj({ path: STR, content: STR }, ["path", "content"]) as Value,
    });
  }
  if (scope.exec.length) {
    const allowed = scope.exec.map((e) => (e.argsPrefix ? e.argsPrefix.map((p) => [e.command, ...p].join(" ")).join("; ") : `${e.command} …`)).join("; ");
    specs.push({
      name: "run",
      description: `Run a command and get its exit code and output. Allowed: ${allowed} (further arguments may follow).`,
      input_schema: obj({ command: STR, args: { type: "array", items: STR } }, ["command", "args"]) as Value,
    });
  }
  const names = new Set(specs.map((s) => s.name));
  // A named result type is a `$ref` into `$defs`, which must sit at the root of the tool's schema to resolve.
  const { $defs, ...resultRoot } = result;
  const finish = { ...obj({ result: resultRoot }, ["result"]), ...($defs ? { $defs } : {}) };
  specs.push({ name: FINISH, description: "Hand back your result as a JSON value of the schema, not as a string. Call it once, when you are done; nothing after it runs.", input_schema: finish as Value });
  return { scope, specs, names, cwd: scope.read[0] };
}

/** A tool call the runtime refuses without running it, with the reason the model is told. */
export class Denied {
  constructor(readonly reason: string) {}
}

/**
 * The process a tool call runs, or why it is refused. Paths are resolved and
 * checked against the grant first; the sandbox checks them again.
 */
export function commandFor(tools: AgentTools, name: string, input: Record<string, unknown>): ExecRequest | Denied {
  const s = tools.scope;
  const path = (): string | Denied => {
    const p = input["path"];
    if (typeof p !== "string" || !p) return new Denied("path must be a non-empty string");
    return norm(posix.isAbsolute(p) ? p : posix.join(tools.cwd ?? "/", p));
  };
  switch (name) {
    case "read_file":
    case "list_dir":
    case "grep": {
      const p = path();
      if (p instanceof Denied) return p;
      if (!inside(p, s.read)) return new Denied(`${p} is outside what you may read (${s.read.join(", ")})`);
      if (name === "read_file") return { argv: ["cat", "--", p] };
      if (name === "list_dir") return { argv: ["ls", "-1Ap", "--", p] };
      const pattern = input["pattern"];
      if (typeof pattern !== "string") return new Denied("pattern must be a string");
      return { argv: ["grep", "-rnI", "--", pattern, p] };
    }
    case "write_file": {
      const p = path();
      if (p instanceof Denied) return p;
      if (!inside(p, s.write)) return new Denied(`${p} is outside what you may write (${s.write.join(", ")})`);
      const content = input["content"];
      if (typeof content !== "string") return new Denied("content must be a string");
      return { argv: ["sh", "-c", WRITE_SCRIPT, "sh", p], stdin: content };
    }
    case "run": {
      const command = input["command"];
      const args = input["args"];
      if (typeof command !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return new Denied("command must be a string and args a list of strings");
      const allowed = s.exec.filter((e) => e.command === command);
      if (!allowed.length) return new Denied(`${command} is not a command you may run (${s.exec.map((e) => e.command).join(", ")})`);
      const ok = allowed.some((e) => !e.argsPrefix || e.argsPrefix.some((p) => p.every((x, i) => args[i] === x)));
      if (!ok) return new Denied(`${[command, ...args].join(" ")} does not start with an allowed argument prefix`);
      return { argv: [command, ...(args as string[])], ...(tools.cwd ? { cwd: tools.cwd } : {}) };
    }
  }
  return new Denied(`there is no tool ${name}`);
}

/** What the model is told a tool did. `grep` finding nothing is not an error. */
export function toolResult(name: string, r: ExecResult): { content: string; isError: boolean } {
  if (name === "run") {
    return { content: cut(`exit code ${r.exitCode}${r.timedOut ? " (timed out)" : ""}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`), isError: false };
  }
  if (name === "grep" && r.exitCode === 1 && !r.stderr) return { content: "no matches", isError: false };
  if (r.exitCode !== 0 || r.timedOut) return { content: cut(r.stderr || `exit code ${r.exitCode}${r.timedOut ? " (timed out)" : ""}`), isError: true };
  if (name === "write_file") return { content: "written", isError: false };
  return { content: cut(r.stdout), isError: false };
}

function cut(text: string): string {
  return text.length > MAX_TOOL_OUTPUT ? `${text.slice(0, MAX_TOOL_OUTPUT)}\n[… ${text.length - MAX_TOOL_OUTPUT} more characters cut]` : text;
}

function norm(p: string): string {
  const n = posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** Whether `p` is one of `roots` or below one, compared by path segment. */
export function inside(p: string, roots: string[]): boolean {
  return roots.some((r) => p === r || p.startsWith(r === "/" ? "/" : `${r}/`));
}

/** The repetition key of a tool call (§8.2): the tool and the canonical form of its arguments. */
export function callKey(name: string, input: Value): string {
  return `${name} ${canonical(input)}`;
}
