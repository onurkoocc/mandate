// The lock file, mandate.lock.json (BACKLOG K11; Doc 4 §19, §8.6). It pins
// what the program itself does not name:
//
//   - modules: the version of every imported non-std module (S09);
//   - models: for each model tier, the model id, its effort and the per-call
//     input and output token limits the runtime enforces (K10);
//   - tariffs: each locked model's price per million tokens, in integer
//     micro-units of one currency, with the date it was read (K11);
//   - bindings: what the program's agents were deployed as on an executor,
//     such as Claude Managed Agents (K45; target/managed-agents.ts);
//   - members: each person who signs decisions, with the ids of their keys.
//     A member may hold several keys; one key belongs to one member;
//   - roles: the members each role the program names is bound to
//     (spec/envelope.md). Members and roles need format 0.4;
//   - host: the least versions of the tools the runtime's host runs;
//   - isolation: the least isolation level of a sandbox, by the data class of
//     its models and for one that reaches an untrusted network, and the data
//     classes whose sandboxes may not share their host;
//   - egress: per agent, the credential each host's requests carry, by name
//     (spec/boundary.md). These three need format 0.5.
//
// The lock is part of the package hash, so a price change is a new package,
// and so is a raised floor: it needs a new approval of an envelope.
// The compiler reads it for W0504: a declared agent budget below the upper
// bound `steps × per-call bound` it can compute (§8.6).

import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { capFromCall, capsOf } from "./check/caps.js";
import { roleSites } from "./check/roles.js";
import { diag, ptr, type Diagnostic, type Span } from "./diag.js";
import { hashProgram } from "./hash.js";
import { atLeast as languageAtLeast, type Budget, type Def, type Expr, type Program } from "./ir/types.js";
import type { Json } from "./json/strict-json.js";
import type { Modules } from "./modules.js";
import type { DataClass } from "./std/std.js";
import { agentModels, bindingChecks, type ManagedAgentsBinding } from "./target/managed-agents.js";
import type { CoTenancy, IsolationLevel } from "./target/sandbox.js";

/**
 * The lock format this compiler writes. It reads 0.2, which has no bindings, 0.3, which has no members or roles,
 * and 0.4, which has no host, isolation or egress.
 */
export const LOCK_FORMAT = "mandate/lock/0.5";
export const LOCK_FORMATS = ["mandate/lock/0.2", "mandate/lock/0.3", "mandate/lock/0.4", "mandate/lock/0.5"] as const;

/** The lock fields of format 0.5 (spec/boundary.md "Lock 0.5"). */
export const LOCK_FIELDS_0_5 = ["host", "isolation", "egress"] as const;

/** A lock's format is `format` or later. */
function atLeast(lock: Lock, format: (typeof LOCK_FORMATS)[number]): boolean {
  return lock.lock !== undefined && LOCK_FORMATS.indexOf(lock.lock) >= LOCK_FORMATS.indexOf(format);
}

export interface ModelLock {
  provider: "anthropic";
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_input_tokens: number;
  max_output_tokens: number;
}

export interface Tariff {
  currency: string;
  /** The day the prices were read, YYYY-MM-DD. */
  as_of: string;
  /** Price per million tokens in micro-units of `currency`. */
  micros_per_mtok: { input: number; output: number; cache_read: number; cache_write: number };
}

export interface Lock {
  lock?: (typeof LOCK_FORMATS)[number];
  modules: Record<string, string>;
  models?: Record<string, ModelLock>;
  tariffs?: Record<string, Tariff>;
  bindings?: { "managed-agents"?: ManagedAgentsBinding };
  /** Each member's key ids, `sha256:<hex>` of an ed25519 public key. */
  members?: Record<string, { keys: string[] }>;
  /** Each role's members. */
  roles?: Record<string, string[]>;
  /** 0.5: the least versions of the tools the runtime's host runs (spec/boundary.md "Lock 0.5"). */
  host?: { node?: string; bwrap?: string };
  /** 0.5: isolation floors by data class and for an untrusted network, and where a sandbox may not share its host. */
  isolation?: {
    floor?: Partial<Record<DataClass, IsolationLevel>>;
    untrusted_network?: IsolationLevel;
    co_tenancy?: Partial<Record<DataClass, CoTenancy>>;
  };
  /** 0.5: per agent, the credential each host's requests carry, by name. Never a secret. */
  egress?: Record<string, Record<string, string>>;
}

/**
 * The lock as a package carries it: without its format field. A program with
 * no lock file is packaged with no pins.
 */
export function packagedLock(lock: Lock | undefined): Lock {
  const { lock: _format, ...pinned } = lock ?? { modules: {} };
  return pinned;
}

let validator: ValidateFunction | undefined;

/** `o[k]` when `k` is a key of `o` itself: a lock read with JSON.parse has a prototype, and a model may be named `constructor`. */
export function own<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o !== undefined && Object.hasOwn(o, k) ? o[k] : undefined;
}

export function lockSchema(): object {
  return JSON.parse(readFileSync(new URL("../../spec/lock.schema.json", import.meta.url), "utf8")) as object;
}

/** Validates a parsed lock file against spec/lock.schema.json; E0140 for each problem. */
export function validateLock(value: unknown): Diagnostic[] {
  validator ??= new Ajv2020({ allErrors: true, strict: true }).compile(lockSchema());
  if (validator(value)) {
    const lock = value as Lock;
    const out: Diagnostic[] = [];
    if (lock.bindings && !atLeast(lock, "mandate/lock/0.3")) out.push(diag("E0140", `Executor bindings need lock format mandate/lock/0.3, not ${String(lock.lock)}.`, { path: "/lock" }, { facts: { lock: lock.lock ?? null } }));
    for (const field of ["members", "roles"] as const) {
      if (lock[field] && !atLeast(lock, "mandate/lock/0.4")) {
        out.push(diag("E0140", `Lock field ${field} needs lock format mandate/lock/0.4, not ${String(lock.lock)}.`, { path: `/${field}` }, { facts: { field, lock: lock.lock ?? null } }));
      }
    }
    for (const field of LOCK_FIELDS_0_5) {
      if (lock[field] && !atLeast(lock, "mandate/lock/0.5")) {
        out.push(diag("E0140", `Lock field ${field} needs lock format mandate/lock/0.5, not ${String(lock.lock)}.`, { path: `/${field}` }, { facts: { field, lock: lock.lock ?? null } }));
      }
    }
    const holder = new Map<string, string>();
    for (const [member, m] of Object.entries(lock.members ?? {})) {
      m.keys.forEach((key, i) => {
        const first = holder.get(key);
        if (first === undefined) holder.set(key, member);
        else out.push(diag("E0140", `Key ${key} is listed under members ${first} and ${member}; one key belongs to one member.`, { path: `/members/${member}/keys/${i}` }, { facts: { key, members: [first, member] } }));
      });
    }
    for (const [role, members] of Object.entries(lock.roles ?? {})) {
      members.forEach((member, i) => {
        if (!own(lock.members, member)) out.push(diag("E0140", `Role ${role} lists member ${member}, which is not in members.`, { path: `/roles/${role}/${i}` }, { facts: { role, member } }));
      });
    }
    for (const [tier, m] of Object.entries(lock.models ?? {})) {
      if (!own(lock.tariffs, m.model)) {
        out.push(diag("E0140", `The lock maps tier ${tier} to ${m.model}, which has no tariff.`, { path: `/models/${tier}/model` }, { facts: { tier, model: m.model } }));
      }
    }
    return out;
  }
  return (validator.errors ?? []).map((e) =>
    diag("E0140", `The lock file does not match spec/lock.schema.json: ${e.instancePath || "/"} ${e.message ?? ""}`.trim(), { path: e.instancePath }, { facts: { keyword: e.keyword, params: e.params as never } }),
  );
}

/**
 * Upper bound of one model call at `tier` (§8.6): the locked input and output
 * limits, the input priced as if nothing hits the cache (the higher of the
 * input and cache-write prices, K12), rounded up to a whole micro-unit.
 */
export function perCallBound(lock: Lock, tier: string): { tokens: number; spend: { micros: number; currency: string } } | undefined {
  const m = own(lock.models, tier);
  const t = m && own(lock.tariffs, m.model);
  if (!m || !t) return undefined;
  const p = t.micros_per_mtok;
  const micros = Math.ceil((m.max_input_tokens * Math.max(p.input, p.cache_write) + m.max_output_tokens * p.output) / 1_000_000);
  return { tokens: m.max_input_tokens + m.max_output_tokens, spend: { micros, currency: t.currency } };
}

/** Model tiers a program's capabilities name, by the definition they appear in. */
export function modelTiers(program: Program): Set<string> {
  const tiers = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const c = capFromCall(v as Expr, { language: program.language });
      if (c?.ctor === "model.infer" && c.tier) tiers.add(c.tier);
      Object.values(v).forEach(visit);
    }
  };
  visit(program.defs);
  return tiers;
}

/**
 * The checks that need the lock: every model tier the program names is
 * locked (E0141), every agent's declared budget covers the upper bound of
 * its agent loop, `steps × per-call bound` (W0504, §8.6), and an executor
 * binding still fits the program and the lock (E0903–E0905).
 */
export function lockChecks(program: Program, lock: Lock, spans?: Map<string, Span>): Diagnostic[] {
  const at = (path: string): { path: string; span?: Span } => {
    const span = spans?.get(path);
    return span ? { path, span } : { path };
  };
  const out: Diagnostic[] = [];
  for (const tier of [...modelTiers(program)].sort()) {
    if (!own(lock.models, tier)) out.push(diag("E0141", `Model tier ${tier} is not in the lock file.`, at("/defs"), { facts: { tier, locked: Object.keys(lock.models ?? {}).sort() } }));
  }
  for (const [name, def] of Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (def.kind !== "agent" || def.remote) continue;
    const tiers = agentModels(program, def).tiers;
    const bounds = tiers.map((t) => perCallBound(lock, t)).filter((b) => b !== undefined);
    if (!bounds.length) continue;
    const worst = { tokens: Math.max(...bounds.map((b) => b.tokens)), micros: Math.max(...bounds.map((b) => b.spend.micros)), currency: bounds[0]!.spend.currency };
    for (const [skillName, skill] of Object.entries(def.skills)) {
      if (skill.body) continue;
      const path = skill.budget ? `/defs/${name}/skills/${skillName}/budget` : `/defs/${name}/budget`;
      const budget: Budget | undefined = skill.budget ?? def.budget;
      const steps = budget?.steps;
      if (steps === undefined) continue; // E0503 already reports it
      const need = { tokens: steps * worst.tokens, micros: steps * worst.micros };
      if (budget?.spend && budget.spend.currency !== worst.currency) {
        out.push(
          diag("E0504", `${name}.${skillName} budgets ${budget.spend.currency}, but tier ${tiers.join(", ")} is priced in ${worst.currency}.`, at(path), {
            facts: { agent: name, skill: skillName, budget: budget.spend.currency, tariff: worst.currency },
          }),
        );
        continue;
      }
      const short: Record<string, { declared: number; bound: number }> = {};
      if (budget?.tokens !== undefined && budget.tokens < need.tokens) short["tokens"] = { declared: budget.tokens, bound: need.tokens };
      if (budget?.spend && budget.spend.micros < need.micros) short[`spend:${worst.currency}`] = { declared: budget.spend.micros, bound: need.micros };
      if (Object.keys(short).length) {
        out.push(
          diag(
            "W0504",
            `${name}.${skillName} declares less than its loop can use: ${Object.entries(short)
              .map(([d, v]) => `${d} ${v.declared} < ${v.bound}`)
              .join(", ")} (${steps} steps × the per-call bound of tier ${tiers.join(", ")}). The skill may not be able to finish.`,
            at(path),
            { facts: { agent: name, skill: skillName, steps, per_call: { tokens: worst.tokens, spend_micros: worst.micros, currency: worst.currency }, short } },
          ),
        );
      }
    }
  }
  out.push(...bindingChecks(program, lock, spans));
  out.push(...sandboxLockChecks(program, lock));
  return out;
}

/**
 * What the lock adds to sandbox requirements (spec/boundary.md "Lock 0.5"). Only a 0.5 program's requirement has
 * an isolation level and credentials, so a lock packaged with an earlier program that sets `isolation` or `egress`
 * would not apply, and is refused (E1803); `host` applies to every program. A credential is bound to an agent that
 * runs in the runtime's sandbox, for a host one of its net.https capabilities holds (E1802). `program` has its
 * imported definitions linked. Paths are into the lock.
 */
export function sandboxLockChecks(program: Program, lock: Lock): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (!languageAtLeast(program.language, "mandate/0.5")) {
    for (const field of ["isolation", "egress"] as const) {
      if (!lock[field]) continue;
      const what = field === "isolation" ? "isolation level" : "credentials";
      out.push(
        diag("E1803", `Lock field ${field} applies to a program of mandate/0.5 or later. This program is ${program.language}: its sandbox requirements have no ${what}, so ${field} would not apply. Write the program in mandate/0.5, or take ${field} out of the lock.`, { path: `/${field}` }, {
          facts: { field, language: program.language },
        }),
      );
    }
    return out;
  }
  const executor = lock.bindings?.["managed-agents"]?.agents;
  const sorted = (o: object): string[] => Object.keys(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const agent of sorted(lock.egress ?? {})) {
    const hosts = lock.egress![agent]!;
    const d = Object.hasOwn(program.defs, agent) ? program.defs[agent] : undefined;
    if (d?.kind !== "agent" || d.remote || (executor && Object.hasOwn(executor, agent))) {
      const why = d?.kind !== "agent" ? "not_an_agent" : d.remote ? "remote" : "executor";
      const what = why === "not_an_agent" ? "which is not an agent of the program" : why === "remote" ? "a remote agent" : "an agent the lock binds to Managed Agents";
      out.push(
        diag("E1802", `The lock binds credentials to the requests of ${agent}, ${what}. A credential is bound only to an agent that runs in the runtime's sandbox, whose requests go through the egress proxy.`, { path: ptr("egress", agent) }, {
          facts: { agent, reason: why, hosts: sorted(hosts) },
        }),
      );
      continue;
    }
    const held = d.caps.flatMap((c) => capsOf(program.defs, c, { language: program.language })).filter((c) => c.ctor === "net.https").flatMap((c) => c.scope ?? []);
    for (const host of sorted(hosts)) {
      if (held.includes(host)) continue;
      const credential = hosts[host]!;
      out.push(
        diag("E1802", `The lock binds credential ${credential} to ${agent}'s requests to ${host}, a host none of ${agent}'s net.https capabilities holds.`, { path: ptr("egress", agent, host) }, {
          facts: { agent, reason: "host_not_held", host, credential, held: [...new Set(held)].sort() },
        }),
      );
    }
  }
  return out;
}

/**
 * E1502: a decision in a 0.4 package is signed by a member, so every role the
 * package names is held by at least one (spec/envelope.md). `linked` is the
 * program's definitions with its imported modules loaded (modules.ts). A role
 * named only by an imported definition, such as the owner of an imported
 * component, counts, and is reported at the import that brings it in.
 */
export function roleLockChecks(program: Program, linked: { defs: Record<string, Def>; origin: Record<string, string> }, lock: Lock, spans?: Map<string, Span>): Diagnostic[] {
  if (!languageAtLeast(program.language, "mandate/0.4")) return [];
  const out: Diagnostic[] = [];
  const sites = roleSites(linked.defs).filter((s) => s.role !== undefined);
  const mine = (def: string): boolean => Object.hasOwn(program.defs, def);
  const older = atLeast(lock, "mandate/lock/0.4") ? "" : " A 0.4 package needs a mandate/lock/0.4 lock, with members and roles.";
  for (const role of new Set(sites.map((s) => s.role!))) {
    if (own(lock.roles, role)?.length) continue;
    const named = sites.filter((s) => s.role === role);
    const site = named.find((s) => mine(s.def)) ?? named[0]!;
    const facts: Record<string, unknown> = { role, lock: lock.lock ?? null, bound: Object.keys(lock.roles ?? {}).sort() };
    let path = site.path;
    if (!mine(site.def)) {
      const module = own(linked.origin, site.def);
      const i = (program.uses ?? []).findIndex((u) => u.module === module);
      path = i < 0 ? "/uses" : ptr("uses", i);
      facts["named_by"] = site.def;
      if (module !== undefined) facts["module"] = module;
    }
    const span = spans?.get(path);
    const by = mine(site.def) ? "" : ` (${site.where} of the imported ${site.def} names it)`;
    out.push(diag("E1502", `Role ${role} has no member in the lock file, so nobody could decide for it${by}.${older}`, span ? { path, span } : { path }, { facts }));
  }
  return out;
}

/**
 * Every imported module the caller loaded is pinned in the lock by its
 * program hash (S09, INV-02): a system model that changed since the lock was
 * written is a different program, not the one the run was approved with
 * (E0142). A module that is imported but not loaded must still be locked.
 */
export function moduleLockChecks(program: Program, lock: Lock, modules: Modules = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  (program.uses ?? []).forEach((u, i) => {
    if (u.module === "std" || u.module.startsWith("std.")) return;
    const pinned = Object.hasOwn(lock.modules, u.module) ? lock.modules[u.module] : undefined;
    const m = Object.hasOwn(modules, u.module) ? modules[u.module] : undefined;
    if (pinned === undefined) {
      out.push(diag("E0142", `Module ${u.module} is imported but not in the lock file.`, { path: `/uses/${i}` }, { facts: { module: u.module } }));
      return;
    }
    if (!m) return;
    const hash = hashProgram(m as unknown as Json).program;
    if (hash !== pinned) out.push(diag("E0142", `Module ${u.module} hashes to ${hash}, but the lock pins ${pinned}.`, { path: `/uses/${i}` }, { facts: { module: u.module, pinned, hash } }));
  });
  return out;
}
