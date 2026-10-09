// Sandbox requirements (Doc 4 §7.3, §11.2). For each local agent the
// compiler states, independently of any platform, the upper bound of what
// the agent's process may touch: paths it reads and writes, commands it may
// run, hosts it may reach, models it may call, and how long it may run.
//
// The compiler does not write MXC or AX policy itself. A pinned, versioned
// sandbox adapter translates a requirement into its platform's policy after
// probing what the host can enforce, and refuses to run when a requirement
// cannot be enforced (INV-11). External effects such as `git.pr` are not
// part of a sandbox: they go through the runtime's effect broker (§8.8).

import { hashProgram } from "../hash.js";
import type { AgentDef, Budget, Expr, Program } from "../ir/types.js";
import type { Json } from "../json/strict-json.js";
import { DEFAULT_MODEL_MAX_CLASS, type DataClass } from "../std/std.js";
import { capFromCall, segments, showCap, within, type CapVal } from "../check/caps.js";

export const SANDBOX_REQUIREMENT_FORMAT = "mandate/sandbox-requirement/0.1";

export interface SandboxRequirement {
  format: typeof SANDBOX_REQUIREMENT_FORMAT;
  /** The agent that runs inside, and the hash of its definition. */
  subject: { agent: string; def: string };
  /** Absolute paths, normalized by segment. A write path may also be read. */
  filesystem: { read: string[]; write: string[] };
  /** Commands the agent may start, each optionally limited to argument prefixes. */
  exec: Array<{ command: string; args_prefix?: string[][] }>;
  /** Hosts reachable over HTTPS. Model endpoints are not listed: the adapter maps `models` to them. */
  network: { hosts: string[] };
  models: Array<{ tier: string | null; max_class: DataClass }>;
  /** 0.1 agents never get the desktop or the clipboard. */
  ui: { desktop: false; clipboard: false };
  /** Wall-clock limit from the agent's `time` budget; null when it has none. */
  limits: { timeout_ms: number | null };
  /**
   * Capabilities whose scope is not statically known. They are listed, never
   * dropped or widened: an adapter must refuse a requirement that has any.
   */
  unbounded: string[];
}

/** The requirement for a set of capabilities, such as an agent's or a delegate's grant. */
export function requirementFor(subject: SandboxRequirement["subject"], caps: CapVal[], timeoutMs: number | null): SandboxRequirement {
  const read: string[] = [];
  const write: string[] = [];
  const exec = new Map<string, { command: string; args_prefix?: string[][] }>();
  const hosts: string[] = [];
  const models = new Map<string, { tier: string | null; max_class: DataClass }>();
  const unbounded: string[] = [];
  for (const c of caps) {
    switch (c.ctor) {
      case "fs.read":
      case "fs.write":
        if (!c.scope) unbounded.push(showCap(c));
        else (c.ctor === "fs.read" ? read : write).push(...c.scope.map(normalize));
        break;
      case "exec":
        if (!c.scope) unbounded.push(showCap(c));
        else {
          for (const command of c.scope) {
            const prev = exec.get(command);
            // Two grants of the same command: the union of what they allow.
            // A grant without prefixes allows any arguments, so it absorbs any other grant of the command.
            const prefixes = prev ? (prev.args_prefix && c.argsPrefix ? [...prev.args_prefix, ...c.argsPrefix] : undefined) : c.argsPrefix;
            exec.set(command, prefixes ? { command, args_prefix: uniqueLists(prefixes) } : { command });
          }
        }
        break;
      case "net.https":
        if (!c.scope) unbounded.push(showCap(c));
        else hosts.push(...c.scope);
        break;
      case "model.infer": {
        const m = { tier: c.tier ?? null, max_class: c.maxClass ?? DEFAULT_MODEL_MAX_CLASS };
        models.set(JSON.stringify(m), m);
        break;
      }
      // git.pr, money.spend: external effects, committed by the runtime's broker, not inside the sandbox.
    }
  }
  return {
    format: SANDBOX_REQUIREMENT_FORMAT,
    subject,
    filesystem: { read: outermost(read), write: outermost(write) },
    exec: [...exec.values()].sort((a, b) => cmp(a.command, b.command)),
    network: { hosts: [...new Set(hosts)].sort(cmp) },
    models: [...models.values()].sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b))),
    ui: { desktop: false, clipboard: false },
    limits: { timeout_ms: timeoutMs },
    unbounded: [...new Set(unbounded)].sort(cmp),
  };
}

/**
 * One requirement per local agent, keyed by agent name. Remote agents run
 * elsewhere and are bound over A2A, so they get none. The program should
 * already pass `check`.
 */
export function sandboxRequirements(program: Program): Record<string, SandboxRequirement> {
  const hashes = hashProgram(program as unknown as Json).defs;
  const capOf = (e: Expr): CapVal | undefined => {
    if (e.op === "var") {
      const d = program.defs[e.name];
      const c = d?.kind === "capability" ? capOf(d.value) : undefined;
      return c && { ...c, name: e.name };
    }
    if (e.op === "call" && e.callee.op === "field" && e.callee.name === "narrow") {
      // C3: a narrowed capability keeps its kind and takes the narrower scope.
      const base = capOf(e.callee.of);
      const scope = e.args.flatMap((a) => (a.value.op === "text" ? [a.value.value] : []));
      if (!base) return undefined;
      if (scope.length === e.args.length) return { ...base, scope };
      // A scope that is not literal is not statically known: unbounded, never the base's.
      const { scope: _dropped, ...unknown } = base;
      return unknown;
    }
    return capFromCall(e);
  };
  const out: Record<string, SandboxRequirement> = {};
  for (const name of Object.keys(program.defs).sort()) {
    const d = program.defs[name]!;
    if (d.kind !== "agent" || d.remote) continue;
    const held = d.caps.map(capOf).filter((c): c is CapVal => c !== undefined);
    out[name] = requirementFor({ agent: name, def: hashes[name]! }, held, agentTimeout(d));
  }
  return out;
}

/** The agent's `time` budget, or the longest of its skills' when every skill has one. */
function agentTimeout(a: AgentDef): number | null {
  const ms = (b?: Budget) => b?.time?.ms;
  if (ms(a.budget) !== undefined) return ms(a.budget)!;
  const skills = Object.values(a.skills).map((s) => ms(s.budget));
  return skills.length && skills.every((t) => t !== undefined) ? Math.max(...(skills as number[])) : null;
}

function normalize(path: string): string {
  return "/" + segments(path).join("/");
}

/** Sorted, without duplicates, and without paths that lie inside another one. */
function outermost(paths: string[]): string[] {
  const unique = [...new Set(paths)].sort(cmp);
  return unique.filter((p) => !unique.some((q) => q !== p && within(p, q)));
}

function uniqueLists(lists: string[][]): string[][] {
  const seen = new Map(lists.map((l) => [JSON.stringify(l), l]));
  return [...seen.keys()].sort(cmp).map((k) => seen.get(k)!);
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
