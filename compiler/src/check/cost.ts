// The static upper bound of what a body hands out (§8.6; spec/envelope.md
// "Static checks"). One model for the checker's E0501 and for the views, so
// that the number a person reads on an envelope's card is the number the
// check compared.
//
// Sequential statements add up. `par` branches add money, tokens, steps and
// agents and take the longest time. `if` and `switch` take the larger branch
// in each dimension. A loop multiplies by `max_iter`, and a map by `max`,
// with `⌈max / par⌉ ×` one item's time.
//
// `agents` counts delegation attempts: a delegation is one, `restart(max: n)`
// makes it `n + 1`, `degrade(to: F)` adds one for F, and a `plan` is its
// lead's own delegation. What a lead's sub-programs start is not known here;
// the runtime holds each one to what is left (spec/envelope.md "plan").
//
// Where a function's own budget stands in for its body, money, tokens and
// time are the budget's, as they have been since 0.1. Steps and agents are
// the budget's when it names them and the body's when it does not, so that
// neither is ever undercounted. A map's `budget` stands in for one item in
// the dimensions it names, and the body counts in every other one.

import { atLeast, type Budget, type BudgetDimension, type Def, type Expr, type Program, type Stmt } from "../ir/types.js";
import { children } from "./static.js";

export interface CostPart {
  from: string;
  at: string;
  budget: Record<string, unknown>;
}

/** An upper bound in every budget dimension (`BUDGET_DIMENSIONS`), with the delegations it is made of. */
export interface StaticCost extends Record<BudgetDimension, number | Record<string, number>> {
  /** Micro-units by currency. */
  spend: Record<string, number>;
  tokens: number;
  /** Wall-clock milliseconds. */
  time: number;
  steps: number;
  /** Delegation attempts. */
  agents: number;
  parts: CostPart[];
}

export interface CostEnv {
  def(name: string): Def | undefined;
  /** Functions on a call cycle, which E0502 reports: their bodies are not counted. */
  recursive: ReadonlySet<string>;
  /**
   * Counting for an envelope, whose budget bounds steps and agents too: a
   * part's budget then shows them, and a delegation with no budget is still a
   * part. Without it the parts are what they were before 0.4.
   */
  envelope: boolean;
  /** The envelope's `agents`: how many items a map with no `max` accepts at most (spec/envelope.md "map"). */
  agents?: number;
}

export function zeroCost(): StaticCost {
  return { spend: {}, tokens: 0, time: 0, steps: 0, agents: 0, parts: [] };
}

export function microsText(micros: number, currency: string): string {
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${currency}`;
}

function shownBudget(b: Budget | undefined): Record<string, unknown> {
  const shown: Record<string, unknown> = {};
  if (b?.spend) shown["spend"] = microsText(b.spend.micros, b.spend.currency);
  if (b?.tokens !== undefined) shown["tokens"] = b.tokens;
  if (b?.time) shown["time_ms"] = b.time.ms;
  return shown;
}

/** What a budget bounds, as a cost. */
function budgetCost(env: CostEnv, b: Budget, from: string, at: string): StaticCost {
  const c = zeroCost();
  if (b.spend) c.spend[b.spend.currency] = b.spend.micros;
  c.tokens = b.tokens ?? 0;
  c.time = b.time?.ms ?? 0;
  c.steps = b.steps ?? 0;
  c.agents = b.agents ?? 0;
  const shown = shownBudget(b);
  if (env.envelope) {
    if (b.steps !== undefined) shown["steps"] = b.steps;
    if (b.agents !== undefined) shown["agents"] = b.agents;
  }
  c.parts.push({ from, at, budget: shown });
  return c;
}

/** One attempt of a delegation: its budget, if it has one, and one agent. */
function attemptCost(env: CostEnv, b: Budget | undefined, from: string, at: string): StaticCost {
  const c = zeroCost();
  if (b?.spend) c.spend[b.spend.currency] = b.spend.micros;
  c.tokens = b?.tokens ?? 0;
  c.time = b?.time?.ms ?? 0;
  c.steps = b?.steps ?? 0;
  c.agents = 1;
  const shown = shownBudget(b);
  if (env.envelope) {
    if (b?.steps !== undefined) shown["steps"] = b.steps;
    shown["agents"] = 1;
  }
  if (b || env.envelope) c.parts.push({ from, at, budget: shown });
  return c;
}

/**
 * A budget that stands in for a body. Steps and agents the budget does not
 * name are the body's; for an envelope they are a part of their own. With
 * `every`, so are money, tokens and time (a map's budget): the body's parts
 * then stand beside the budget's.
 */
function standIn(env: CostEnv, b: Budget, from: string, at: string, body: () => StaticCost, every = false): StaticCost {
  const c = budgetCost(env, b, from, at);
  if (b.steps !== undefined && b.agents !== undefined && !every) return c;
  const inside = body();
  const more: Record<string, unknown> = {};
  if (b.steps === undefined && inside.steps) more["steps"] = c.steps = inside.steps;
  if (b.agents === undefined && inside.agents) more["agents"] = c.agents = inside.agents;
  if (every) {
    for (const [currency, micros] of Object.entries(inside.spend)) {
      if (b.spend?.currency === currency || !micros) continue;
      c.spend[currency] = micros;
      more[`spend_${currency}`] = microsText(micros, currency);
    }
    if (b.tokens === undefined && inside.tokens) more["tokens"] = c.tokens = inside.tokens;
    if (b.time === undefined && inside.time) more["time_ms"] = c.time = inside.time;
  }
  if ((env.envelope || every) && Object.keys(more).length) c.parts.push({ from: `${from} (its body)`, at, budget: more });
  return c;
}

export function addSeq(into: StaticCost, c: StaticCost): void {
  for (const [k, v] of Object.entries(c.spend)) into.spend[k] = (into.spend[k] ?? 0) + v;
  into.tokens += c.tokens;
  into.time += c.time;
  into.steps += c.steps;
  into.agents += c.agents;
  into.parts.push(...c.parts);
}

/** Parallel branches: everything adds up but wall-clock time, which is the longest branch's. */
function parallel(cs: StaticCost[]): StaticCost {
  const out = zeroCost();
  for (const c of cs) {
    for (const [k, v] of Object.entries(c.spend)) out.spend[k] = (out.spend[k] ?? 0) + v;
    out.tokens += c.tokens;
    out.time = Math.max(out.time, c.time);
    out.steps += c.steps;
    out.agents += c.agents;
    out.parts.push(...c.parts);
  }
  return out;
}

/** Alternatives (if/else, switch arms): the upper bound is the larger branch in each dimension. */
function alternative(cs: StaticCost[]): StaticCost {
  const out = zeroCost();
  for (const c of cs) {
    for (const [k, v] of Object.entries(c.spend)) out.spend[k] = Math.max(out.spend[k] ?? 0, v);
    out.tokens = Math.max(out.tokens, c.tokens);
    out.time = Math.max(out.time, c.time);
    out.steps = Math.max(out.steps, c.steps);
    out.agents = Math.max(out.agents, c.agents);
    out.parts.push(...c.parts);
  }
  return out;
}

function scale(c: StaticCost, n: number): StaticCost {
  const out = zeroCost();
  for (const [k, v] of Object.entries(c.spend)) out.spend[k] = v * n;
  out.tokens = c.tokens * n;
  out.time = c.time * n;
  out.steps = c.steps * n;
  out.agents = c.agents * n;
  out.parts = c.parts.map((p) => ({ ...p, from: `${p.from} ×${n}` }));
  return out;
}

/**
 * Upper bound of a block. Inside a called function, costs are reported at
 * the call site (`base`).
 */
export function blockCost(env: CostEnv, stmts: Stmt[], base: string, inFns: ReadonlySet<string> = new Set()): StaticCost {
  const total = zeroCost();
  const at = (p: string): string => (inFns.size ? base : p);
  const ec = (e: Expr, p: string): StaticCost => exprCost(env, e, at(p), inFns);
  stmts.forEach((s, i) => {
    const path = `${base}/${i}`;
    switch (s.op) {
      case "let":
        addSeq(total, ec(s.value, `${path}/value`));
        break;
      case "expr":
        addSeq(total, ec(s.value, `${path}/value`));
        break;
      case "return":
        if (s.value) addSeq(total, ec(s.value, `${path}/value`));
        break;
      case "par": {
        const branches = Object.entries(s.branches).map(([bn, e]) => ec(e, `${path}/branches/${bn}`));
        addSeq(total, parallel(branches));
        break;
      }
      case "if":
        addSeq(total, alternative([blockCost(env, s.then, at(`${path}/then`), inFns), blockCost(env, s.else ?? [], at(`${path}/else`), inFns)]));
        break;
      case "loop": {
        const once = blockCost(env, s.body, at(`${path}/body`), inFns);
        if (s.max_iter !== undefined) addSeq(total, scale(once, s.max_iter));
        else addSeq(total, once);
        break;
      }
      default:
        break;
    }
  });
  return total;
}

/** Upper bound of what an expression hands out: delegates and budgeted functions it runs. */
export function exprCost(env: CostEnv, e: Expr, path: string, inFns: ReadonlySet<string> = new Set()): StaticCost {
  const c = zeroCost();
  // Costs are reported at the enclosing statement (or switch arm).
  const sub = (x: Expr): StaticCost => exprCost(env, x, path, inFns);
  if (e.op === "switch") {
    // Only one arm runs.
    addSeq(c, sub(e.on));
    addSeq(c, alternative(e.cases.map((k, i) => exprCost(env, k.then, inFns.size ? path : `${path}/cases/${i}/then`, inFns))));
    return c;
  }
  if (e.op === "block") return blockCost(env, e.body, inFns.size ? path : `${path}/body`, inFns);
  for (const k of children(e)) addSeq(c, sub(k));
  if (e.op === "map") {
    // `n ×` the map's budget, or its body: money, tokens, steps and agents add up over items, and time is
    // `⌈n / k⌉ ×` one item's (spec/envelope.md "map"). A map with no `max` accepts as many items as the
    // envelope has `agents`. Outside an envelope it has no bound, which E1702 reports; it counts once here.
    const body = (): StaticCost => blockCost(env, e.body, inFns.size ? path : `${path}/body`, inFns);
    const once = e.budget ? standIn(env, e.budget, "map", path, body, true) : body();
    const n = e.max ?? env.agents;
    if (n === undefined) addSeq(c, once);
    else {
      const all = scale(once, n);
      all.time = once.time * Math.ceil(n / (e.par ?? 1));
      addSeq(c, all);
    }
    return c;
  }
  if (e.op === "plan") {
    // The lead's own delegation; its sub-programs are held to what is left when they are submitted.
    const lead = env.def(e.agent);
    if (lead?.kind !== "agent") return c;
    const skill = Object.hasOwn(lead.skills, e.skill) ? lead.skills[e.skill] : undefined;
    addSeq(c, attemptCost(env, e.budget ?? skill?.budget ?? lead.budget, `${e.agent}.${e.skill}`, path));
    return c;
  }
  if (e.op === "delegate") {
    const agent = env.def(e.agent);
    if (agent?.kind !== "agent") return c;
    const skill = Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill] : undefined;
    const b = e.budget ?? skill?.budget ?? agent.budget;
    // Every attempt reserves again: restart(max: n) runs up to n + 1 times, and degrade(to: F) may run F after it.
    const sup = e.supervise;
    const maxArg = sup?.name === "restart" ? sup.args?.find((a) => a.name === "max")?.value : undefined;
    const attempts = sup?.name === "restart" ? (maxArg?.op === "int" ? maxArg.value : 1) + 1 : 1;
    const one = attemptCost(env, b, `${e.agent}.${e.skill}`, path);
    addSeq(c, attempts > 1 ? scale(one, attempts) : one);
    const to = sup?.name === "degrade" ? sup.args?.find((a) => a.name === "to")?.value : undefined;
    const fb = to?.op === "var" ? env.def(to.name) : undefined;
    if (fb?.kind === "agent") {
      const fbSkill = Object.hasOwn(fb.skills, e.skill) ? fb.skills[e.skill] : undefined;
      addSeq(c, attemptCost(env, e.budget ?? fbSkill?.budget ?? fb.budget, `${to!.op === "var" ? to.name : ""}.${e.skill}`, path));
    }
  } else if (e.op === "call" && e.callee.op === "var") {
    const name = e.callee.name;
    const f = env.def(name);
    if (f?.kind !== "fn") return c;
    const counted = !inFns.has(name) && !env.recursive.has(name);
    const body = (): StaticCost => (counted ? blockCost(env, f.body, path, new Set([...inFns, name])) : zeroCost());
    // A function's own budget bounds everything it runs; without one, count its body.
    if (f.budget) addSeq(c, standIn(env, f.budget, name, path, body));
    else addSeq(c, body());
  }
  return c;
}

/**
 * The static upper bound of what a workflow's body hands out, for a program
 * that passed the checks. `linked` is the table of definitions it sees with
 * its imported modules loaded. Undefined when `workflow` is not a workflow.
 */
export function staticCost(program: Program, workflow: string, linked?: Record<string, Def>): StaticCost | undefined {
  const defs = linked ? { ...linked, ...program.defs } : program.defs;
  const def = (name: string): Def | undefined => (Object.hasOwn(defs, name) ? defs[name] : undefined);
  const wf = def(workflow);
  if (wf?.kind !== "workflow") return undefined;
  const enveloped = atLeast(program.language, "mandate/0.4") && !!wf.envelope;
  const agents = enveloped ? wf.envelope?.budget?.agents : undefined;
  const env: CostEnv = { def, recursive: new Set(), envelope: enveloped, ...(agents !== undefined ? { agents } : {}) };
  return blockCost(env, wf.body, `/defs/${workflow}/body`);
}
