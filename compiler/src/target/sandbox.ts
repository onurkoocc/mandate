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
//
// A 0.5 program's requirement has format 0.2 (spec/boundary.md): the methods
// each host is limited to, the isolation level the sandbox needs and whether
// it may share its host, and the credential each host's requests carry, by
// name. The level and the credentials come from the lock; nothing here sets a
// floor of its own. Every other program's requirement is format 0.1, as it was.

import { diag, type Diagnostic } from "../diag.js";
import { hashProgram } from "../hash.js";
import { atLeast, type AgentDef, type Budget, type LanguageVersion, type Program } from "../ir/types.js";
import type { Json } from "../json/strict-json.js";
import { classRank, DATA_CLASSES, DEFAULT_MODEL_MAX_CLASS, type DataClass } from "../std/std.js";
import { capsOf, segments, showCap, within, type CapVal } from "../check/caps.js";
import type { Lock } from "../lock.js";
import { link, type Modules } from "../modules.js";

export const SANDBOX_REQUIREMENT_FORMAT = "mandate/sandbox-requirement/0.1";
/** The requirement of a 0.5 program (spec/boundary.md "Sandbox requirement 0.2"). */
export const SANDBOX_REQUIREMENT_FORMAT_0_2 = "mandate/sandbox-requirement/0.2";

/** Isolation levels, weakest first (spec/boundary.md "Isolation level and host fitness"). */
export const ISOLATION_LEVELS = ["process", "user_kernel", "microvm", "dedicated_host"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];
export type CoTenancy = "allowed" | "forbidden";

export interface SandboxRequirement {
  format: typeof SANDBOX_REQUIREMENT_FORMAT | typeof SANDBOX_REQUIREMENT_FORMAT_0_2;
  /** The agent that runs inside, and the hash of its definition. */
  subject: { agent: string; def: string };
  /** Absolute paths, normalized by segment. A write path may also be read. */
  filesystem: { read: string[]; write: string[] };
  /** Commands the agent may start, each optionally limited to argument prefixes. */
  exec: Array<{ command: string; args_prefix?: string[][] }>;
  /**
   * Hosts reachable over HTTPS. Model endpoints are not listed: the adapter maps `models` to them. In 0.2,
   * `methods` lists each host that only some methods are allowed for, with them; a host it does not list
   * allows any method.
   */
  network: { hosts: string[]; methods?: Record<string, string[]> };
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
  /**
   * 0.2: the least isolation the sandbox needs (the lock's floor for `data_class` and, when it reaches a host,
   * the lock's floor for an untrusted network), whether it may share its host with other tenants, the highest
   * data class its models may receive, and whether it reaches any host.
   */
  isolation?: { min: IsolationLevel; co_tenancy: CoTenancy; data_class: DataClass; untrusted_network: boolean };
  /** 0.2: the credential each host's requests carry, by the name the lock binds; never a secret. */
  egress?: { credentials: Record<string, string> };
}

/** What a requirement is read with: the language of the program it is for, and the lock it is packaged with. */
export interface RequirementOptions {
  language?: LanguageVersion;
  lock?: Lock;
}

/**
 * The requirement for a set of capabilities, such as an agent's or a delegate's grant. With a language of 0.5
 * or later it has format 0.2; otherwise, or without options, it is format 0.1, byte for byte as before.
 */
export function requirementFor(subject: SandboxRequirement["subject"], caps: CapVal[], timeoutMs: number | null, opts: RequirementOptions = {}): SandboxRequirement {
  const read: string[] = [];
  const write: string[] = [];
  const exec = new Map<string, { command: string; args_prefix?: string[][] }>();
  const hosts: string[] = [];
  /** Per host, the methods it is allowed, or "any" once one capability allows it without methods. */
  const methods = new Map<string, Set<string> | "any">();
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
        else {
          hosts.push(...c.scope);
          // Two grants of the same host: the union of what they allow; one without methods allows any.
          for (const h of c.scope) {
            const prev = methods.get(h);
            methods.set(h, prev === "any" || !c.methods ? "any" : new Set([...(prev ?? []), ...c.methods]));
          }
        }
        break;
      case "model.infer": {
        const m = { tier: c.tier ?? null, max_class: c.maxClass ?? DEFAULT_MODEL_MAX_CLASS };
        models.set(JSON.stringify(m), m);
        break;
      }
      // git.pr, money.spend: external effects, committed by the runtime's broker, not inside the sandbox.
    }
  }
  const req: SandboxRequirement = {
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
  if (!opts.language || !atLeast(opts.language, "mandate/0.5")) return req;

  // Format 0.2: the fields of 0.1 in their places, then isolation and egress.
  const limited: Record<string, string[]> = {};
  for (const h of req.network.hosts) {
    const m = methods.get(h);
    if (m && m !== "any") limited[h] = [...m].sort(cmp);
  }
  const dataClass = req.models.reduce<DataClass>((a, m) => (classRank(m.max_class) > classRank(a) ? m.max_class : a), "public");
  const untrusted = req.network.hosts.length > 0;
  const iso = opts.lock?.isolation;
  // Floors come from the lock alone; with none, the level is process.
  const floor = floorFor(iso, dataClass);
  const network = untrusted ? (iso?.untrusted_network ?? "process") : "process";
  const bound = own(opts.lock?.egress, subject.agent);
  const credentials: Record<string, string> = {};
  for (const h of req.network.hosts) {
    const name = own(bound, h);
    if (name !== undefined) credentials[h] = name;
  }
  return {
    ...req,
    format: SANDBOX_REQUIREMENT_FORMAT_0_2,
    network: { hosts: req.network.hosts, methods: limited },
    isolation: { min: higher(floor, network), co_tenancy: coTenancyFor(iso, dataClass), data_class: dataClass, untrusted_network: untrusted },
    egress: { credentials },
  };
}

/**
 * The isolation floor a lock's `isolation` gives data of class `c`: the highest floor it sets for `c` or any less
 * sensitive class, since a floor holds for every class above the one it names. `process` when it sets none.
 */
export function floorFor(iso: Lock["isolation"] | undefined, c: DataClass): IsolationLevel {
  return DATA_CLASSES.filter((x) => classRank(x) <= classRank(c)).reduce<IsolationLevel>((a, x) => higher(a, own(iso?.floor, x) ?? "process"), "process");
}

/** Whether a sandbox with data of class `c` may share its host: not when the lock forbids it for `c` or any less sensitive class. */
export function coTenancyFor(iso: Lock["isolation"] | undefined, c: DataClass): CoTenancy {
  return DATA_CLASSES.some((x) => classRank(x) <= classRank(c) && own(iso?.co_tenancy, x) === "forbidden") ? "forbidden" : "allowed";
}

/** The stronger of two isolation levels. */
function higher(a: IsolationLevel, b: IsolationLevel): IsolationLevel {
  return ISOLATION_LEVELS.indexOf(b) > ISOLATION_LEVELS.indexOf(a) ? b : a;
}

/** `o[k]` when `k` is a key of `o` itself: a lock read with JSON.parse has a prototype, and an agent may be named `constructor`. */
function own<T>(o: Partial<Record<string, T>> | undefined, k: string): T | undefined {
  return o !== undefined && Object.hasOwn(o, k) ? o[k] : undefined;
}

/**
 * One requirement per local agent, keyed by agent name. Remote agents run
 * elsewhere and are bound over A2A, so they get none. The program should
 * already pass `check`. `lock` is the lock it is packaged with: a 0.5
 * program's requirement reads its isolation floors and credential bindings.
 */
export function sandboxRequirements(program: Program, modules: Modules = {}, lock?: Lock): Record<string, SandboxRequirement> {
  const hashes = hashProgram(program as unknown as Json).defs;
  // Capabilities over components open into paths and commands of the imported system model (doc 9 §2.2).
  const defs = link(program, modules).defs;
  const out: Record<string, SandboxRequirement> = {};
  for (const name of Object.keys(program.defs).sort()) {
    const d = program.defs[name]!;
    if (d.kind !== "agent" || d.remote) continue;
    const held = d.caps.flatMap((c) => capsOf(defs, c, { language: program.language }));
    out[name] = requirementFor({ agent: name, def: hashes[name]! }, held, agentTimeout(d), { language: program.language, ...(lock ? { lock } : {}) });
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

/** A path by its segments; a Windows path keeps its drive (`C:/work/repo`), any other is rooted at `/`. */
function normalize(path: string): string {
  const s = segments(path);
  return /^[A-Za-z]:$/.test(s[0] ?? "") ? s.join("/") : "/" + s.join("/");
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

export const SANDBOX_DENIALS_FORMAT = "mandate/sandbox-denials/0.1";

/** What sandboxes in learning mode denied during a run, as `mandate denials <run>` exports it. */
export interface DenialReport {
  format: typeof SANDBOX_DENIALS_FORMAT;
  /** The program the run ran. */
  program: string;
  denials: Array<{ agent: string; resource: string; access: string }>;
}

/**
 * W0311 (§11.3, §12.2): what an agent's sandbox denied in learning mode, as
 * feedback on its policy. One warning per agent, access and resource. A
 * report made for another program is refused, since its agents' policies
 * may differ.
 */
export function denialDiagnostics(program: Program, report: DenialReport): Diagnostic[] {
  const hash = hashProgram(program as unknown as Json).program;
  if (report.format !== SANDBOX_DENIALS_FORMAT) return [diag("E0104", `A denial report must have format ${SANDBOX_DENIALS_FORMAT}.`, { path: "" })];
  if (report.program !== hash) return [diag("E0104", `The denial report is for program ${report.program}, not ${hash}.`, { path: "" }, { facts: { report: report.program, program: hash } })];
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of report.denials) {
    const key = `${d.agent} ${d.access} ${d.resource}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const agent = program.defs[d.agent];
    out.push(
      diag("W0311", `In learning mode, ${d.agent}'s sandbox denied ${d.access} of ${d.resource}: its policy does not allow it. If ${d.agent} needs it, its capability must grow (a governance change); if not, it reached too far.`, { path: agent?.kind === "agent" ? `/defs/${d.agent}/caps` : "" }, {
        facts: { agent: d.agent, access: d.access, resource: d.resource },
      }),
    );
  }
  return out;
}
