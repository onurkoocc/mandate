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
import type { CapVal, SandboxRequirement } from "@mandate/bridge";
import type { ToolSpec } from "./adapters.js";
import type { ExecRequest, ExecResult } from "./sandbox.js";
import type { JsonSchema } from "./schema.js";
import { canonical, type Value } from "./values.js";

/** Longest tool output a model sees; the rest is cut and marked. */
export const MAX_TOOL_OUTPUT = 20_000;

/** The shell script `write_file` runs: `sh -c WRITE_SCRIPT sh <path>`, with the content on stdin. */
export const WRITE_SCRIPT = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';

/** Directories `grep` does not descend into: version control, dependencies and build output, never what an agent changes. */
export const GREP_SKIP = [".git", "node_modules", "target", "dist", "build", "__pycache__", ".venv"];

export const FINISH = "finish";
export const SUBMIT_PLAN = "submit_plan";

export interface Scope {
  read: string[];
  write: string[];
  /** A command and its argument prefixes; `root`, for a component's command, is where it runs. */
  exec: Array<{ command: string; argsPrefix?: string[][]; root?: string }>;
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
  const exec = grants.filter((c) => c.ctor === "exec").flatMap((c) => (c.scope ?? []).map((command) => ({ command, ...(c.argsPrefix ? { argsPrefix: c.argsPrefix } : {}), ...(c.root ? { root: norm(c.root) } : {}) })));
  return { read: [...new Set(read)].sort(), write: [...new Set(write)].sort(), exec };
}

const STR = { type: "string" };
const obj = (properties: Record<string, unknown>, required: string[]): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });

/**
 * The hosts a sandbox reaches only with `http://` URLs: the ones its requirement binds a credential to or restricts
 * the methods of. The egress proxy adds the credential and checks the method on a request it can read, which an
 * `https://` URL is not (it arrives as a CONNECT tunnel, which the proxy refuses for such a host). Each host once, in
 * the order of JavaScript's `<` on strings, which compares UTF-16 code units: the same on every machine, with no
 * locale in it, and the order the compiler sorts a requirement's hosts in. Empty for a requirement of format 0.1,
 * which has neither field.
 */
export function plainHttpHosts(requirement: Pick<SandboxRequirement, "network" | "egress">): string[] {
  const hosts = new Set([...Object.keys(requirement.network.methods ?? {}), ...Object.keys(requirement.egress?.credentials ?? {})]);
  return [...hosts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The tools an agent is offered. `requirement` is the sandbox requirement it runs under; it adds one sentence to
 * `run`, and only for an agent that has a host `plainHttpHosts` names. A tool's description is part of the digest of
 * the request a model call is journaled under, so for every other agent the text of every tool must stay exactly what
 * it was before the sentence existed (runtime/test/tools.test.ts pins it).
 */
export function toolsFor(grants: CapVal[], result: JsonSchema, requirement?: Pick<SandboxRequirement, "network" | "egress">): AgentTools {
  const scope = scopeOf(grants);
  const specs: ToolSpec[] = [];
  const list = (xs: string[]): string => xs.join(", ");
  if (scope.read.length) {
    specs.push(
      { name: "read_file", description: `Read a text file. You may read under: ${list(scope.read)}.`, input_schema: obj({ path: STR }, ["path"]) as Value },
      { name: "list_dir", description: `List a directory. You may read under: ${list(scope.read)}.`, input_schema: obj({ path: STR }, ["path"]) as Value },
      {
        name: "grep",
        description: `Search files under a path for a regular expression (grep -rnE, extended syntax; ${GREP_SKIP.join(", ")} are skipped). You may read under: ${list(scope.read)}.`,
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
    const allowed = scope.exec.map((e) => (e.argsPrefix ? e.argsPrefix.map((p) => [e.command, ...p].join(" ")).join("; ") : `${e.command} …`) + (e.root ? ` (in ${e.root})` : "")).join("; ");
    const roots = [...new Set(scope.exec.flatMap((e) => (e.root ? [e.root] : [])))];
    const plain = requirement ? plainHttpHosts(requirement) : [];
    specs.push({
      name: "run",
      description:
        `Run a command and get its exit code and output. Allowed: ${allowed} (further arguments may follow).` +
        (roots.length > 1 ? ` Name the working copy it runs in with cwd: one of ${list(roots)}.` : "") +
        (plain.length ? ` Reach ${list(plain)} with http:// URLs, not https://: the connection is made over TLS for you, and an https:// URL to such a host is refused and counted as a violation.` : ""),
      input_schema: obj({ command: STR, args: { type: "array", items: STR }, ...(roots.length > 1 ? { cwd: STR } : {}) }, ["command", "args"]) as Value,
    });
  }
  const names = new Set(specs.map((s) => s.name));
  // A named result type is a `$ref` into `$defs`, which must sit at the root of the tool's schema to resolve.
  const { $defs, ...resultRoot } = result;
  const finish = { ...obj({ result: resultRoot }, ["result"]), ...($defs ? { $defs } : {}) };
  specs.push({ name: FINISH, description: "Hand back your result as a JSON value of the schema, not as a string. Call it once, when you are done; nothing after it runs.", input_schema: finish as Value });
  return { scope, specs, names, cwd: scope.read[0] };
}

/**
 * Why a tool call is refused: `authority`, the call asks for what the grant does not give (a path outside what the
 * agent may read or write, a command or argument prefix it may not run, a working copy it was not given); or
 * `malformed`, its input is not one the tool takes (an argument missing or of the wrong type, a choice it must make
 * and did not, a tool there is not). Only the first is an attempt to cross what the agent was granted.
 */
export type DenialKind = "authority" | "malformed";

/** A tool call the runtime refuses without running it, with the reason the model is told and its kind. */
export class Denied {
  constructor(
    readonly reason: string,
    readonly kind: DenialKind,
  ) {}
}

/**
 * The process a tool call runs, or why it is refused. Paths are resolved and
 * checked against the grant first; the sandbox checks them again.
 */
export function commandFor(tools: AgentTools, name: string, input: Record<string, unknown>): ExecRequest | Denied {
  const s = tools.scope;
  const path = (): string | Denied => {
    const p = input["path"];
    if (typeof p !== "string" || !p) return new Denied("path must be a non-empty string", "malformed");
    return norm(posix.isAbsolute(p) ? p : posix.join(tools.cwd ?? "/", p));
  };
  switch (name) {
    case "read_file":
    case "list_dir":
    case "grep": {
      const p = path();
      if (p instanceof Denied) return p;
      if (!inside(p, s.read)) return new Denied(`${p} is outside what you may read (${s.read.join(", ")})`, "authority");
      if (name === "read_file") return { argv: ["cat", "--", p] };
      if (name === "list_dir") return { argv: ["ls", "-1Ap", "--", p] };
      const pattern = input["pattern"];
      if (typeof pattern !== "string") return new Denied("pattern must be a string", "malformed");
      return { argv: ["grep", "-rnIE", ...GREP_SKIP.map((d) => `--exclude-dir=${d}`), "--", pattern, p] };
    }
    case "write_file": {
      const p = path();
      if (p instanceof Denied) return p;
      if (!inside(p, s.write)) return new Denied(`${p} is outside what you may write (${s.write.join(", ")})`, "authority");
      const content = input["content"];
      if (typeof content !== "string") return new Denied("content must be a string", "malformed");
      return { argv: ["sh", "-c", WRITE_SCRIPT, "sh", p], stdin: content };
    }
    case "run": {
      const command = input["command"];
      const args = input["args"];
      if (typeof command !== "string" || !Array.isArray(args) || !args.every((a) => typeof a === "string")) return new Denied("command must be a string and args a list of strings", "malformed");
      const allowed = s.exec.filter((e) => e.command === command);
      if (!allowed.length) return new Denied(`${command} is not a command you may run (${s.exec.map((e) => e.command).join(", ")})`, "authority");
      const fits = allowed.filter((e) => !e.argsPrefix || e.argsPrefix.some((p) => p.every((x, i) => args[i] === x)));
      if (!fits.length) return new Denied(`${[command, ...args].join(" ")} does not start with an allowed argument prefix`, "authority");
      // A component's command runs in that component's root; with several, the call names which.
      const roots = [...new Set(fits.flatMap((e) => (e.root ? [e.root] : [])))];
      const asked = input["cwd"];
      let cwd = tools.cwd;
      if (typeof asked === "string" && asked) {
        const c = norm(posix.isAbsolute(asked) ? asked : posix.join(tools.cwd ?? "/", asked));
        if (!roots.includes(c)) return new Denied(`${command} may run in ${roots.length ? roots.join(", ") : "its default working directory"}, not ${c}`, "authority");
        cwd = c;
      } else if (roots.length === 1) {
        cwd = roots[0];
      } else if (roots.length > 1) {
        return new Denied(`${command} is allowed in several working copies; name one with cwd: ${roots.join(", ")}`, "malformed");
      }
      return { argv: [command, ...(args as string[])], ...(cwd ? { cwd } : {}) };
    }
  }
  return new Denied(`there is no tool ${name}`, "malformed");
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
