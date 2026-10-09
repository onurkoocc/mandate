// The lock file, mandate.lock.json (BACKLOG K11; Doc 4 §19, §8.6). It pins
// what the program itself does not name:
//
//   - modules: the version of every imported non-std module (S09);
//   - models: for each model tier, the model id, its effort and the per-call
//     input and output token limits the runtime enforces (K10);
//   - tariffs: each locked model's price per million tokens, in integer
//     micro-units of one currency, with the date it was read (K11).
//
// The lock is part of the package hash, so a price change is a new package.
// The compiler reads it for W0504: a declared agent budget below the upper
// bound `steps × per-call bound` it can compute (§8.6).

import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { capFromCall, type CapVal } from "./check/caps.js";
import { diag, type Diagnostic, type Span } from "./diag.js";
import type { Budget, Def, Expr, Program } from "./ir/types.js";

export const LOCK_FORMAT = "mandate/lock/0.2";

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
  lock?: typeof LOCK_FORMAT;
  modules: Record<string, string>;
  models?: Record<string, ModelLock>;
  tariffs?: Record<string, Tariff>;
}

let validator: ValidateFunction | undefined;

export function lockSchema(): object {
  return JSON.parse(readFileSync(new URL("../../spec/lock.schema.json", import.meta.url), "utf8")) as object;
}

/** Validates a parsed lock file against spec/lock.schema.json; E0140 for each problem. */
export function validateLock(value: unknown): Diagnostic[] {
  validator ??= new Ajv2020({ allErrors: true, strict: true }).compile(lockSchema());
  if (validator(value)) {
    const lock = value as Lock;
    const out: Diagnostic[] = [];
    for (const [tier, m] of Object.entries(lock.models ?? {})) {
      if (!lock.tariffs?.[m.model]) {
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
  const m = lock.models?.[tier];
  const t = m && lock.tariffs?.[m.model];
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
      const c = capFromCall(v as Expr);
      if (c?.ctor === "model.infer" && c.tier) tiers.add(c.tier);
      Object.values(v).forEach(visit);
    }
  };
  visit(program.defs);
  return tiers;
}

/**
 * The checks that need the lock: every model tier the program names is
 * locked (E0141), and every agent's declared budget covers the upper bound
 * of its agent loop, `steps × per-call bound` (W0504, §8.6).
 */
export function lockChecks(program: Program, lock: Lock, spans?: Map<string, Span>): Diagnostic[] {
  const at = (path: string): { path: string; span?: Span } => {
    const span = spans?.get(path);
    return span ? { path, span } : { path };
  };
  const out: Diagnostic[] = [];
  for (const tier of [...modelTiers(program)].sort()) {
    if (!lock.models?.[tier]) out.push(diag("E0141", `Model tier ${tier} is not in the lock file.`, at("/defs"), { facts: { tier, locked: Object.keys(lock.models ?? {}).sort() } }));
  }
  for (const [name, def] of Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (def.kind !== "agent" || def.remote) continue;
    const tiers = agentTiers(program, def);
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
  return out;
}

function agentTiers(program: Program, agent: Extract<Def, { kind: "agent" }>): string[] {
  const resolve = (e: Expr): CapVal | undefined => {
    if (e.op === "var") {
      const d = program.defs[e.name];
      return d?.kind === "capability" ? resolve(d.value) : undefined;
    }
    return capFromCall(e);
  };
  return [...new Set(agent.caps.map(resolve).flatMap((c) => (c?.ctor === "model.infer" && c.tier ? [c.tier] : [])))].sort();
}
