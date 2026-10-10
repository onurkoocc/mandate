// The Managed Agents executor binding (BACKLOG item 39; decisions K45–K47,
// K79, K80). A program whose agents run as Claude Managed Agents sessions
// records what they were deployed as in its lock file, under
// `bindings["managed-agents"]`. The lock is part of the package hash, so the
// binding is part of what a person approves (INV-02): the deployed agents
// and their pinned versions, the environment, the session fee that prices a
// session's running time, and the guarantee profile the executor gives.
//
// The binding is "bridge" (K79): the workflow body, the journal, the budget,
// the evidence and the approvals stay in Mandate, each delegation is one
// session (K45), and every tool is a custom tool that Mandate runs in its own
// sandbox. The service hosts the agent loop and the model calls; it never
// runs a tool, holds a credential, or sees a file the agent was not shown.
//
// The checks here need only the program and the lock. `ValidateBinding`
// (in the runtime) compares the binding with what the service reports before
// every run.

import { capFromCall, type CapVal } from "../check/caps.js";
import { diag, type Diagnostic, type Span } from "../diag.js";
import type { AgentDef, Expr, Program } from "../ir/types.js";
import { classRank, DEFAULT_MODEL_MAX_CLASS, type DataClass } from "../std/std.js";
import type { Lock } from "../lock.js";

export const MA_BINDING_FORMAT = "mandate/binding/managed-agents/0.1";
/** The beta the binding was deployed under; a binding for another beta is refused, not translated. */
export const MA_BETA = "managed-agents-2026-04-01";

/** The highest data class an agent bound to a cloud executor may send to its model (K46). */
export const MA_MAX_CLASS: DataClass = "internal";

/** How a guarantee holds on an executor (design doc 10 §4). */
export type ProfileLevel = "full" | "partial" | "none";

/**
 * The guarantee profile of a bridge binding, by guarantee. It is written into
 * the binding, so a person approves it with the package, and checked against
 * this table: a binding that claims more than this implementation gives is
 * refused (E0903).
 */
export const MA_BRIDGE_PROFILE: Record<string, ProfileLevel> = {
  "package.identity": "full",
  "static.checks": "full",
  "caps.paths_commands": "full",
  "caps.network": "full",
  "parallel.isolation": "full",
  "model.pinning": "full",
  "model.max_class": "partial",
  "budget.tokens_spend": "full",
  "budget.steps": "full",
  "budget.time": "full",
  "loop.progress": "full",
  "journal.turns": "full",
  "replay.no_adapter": "full",
  "evidence.verifier": "full",
  "effects.prepare_authorize_commit": "full",
  "credentials.control_plane": "full",
  "cancel": "partial",
};

export interface ManagedAgentsAgentBinding {
  /** The Managed Agents agent and the version the run pins its sessions to. */
  id: string;
  version: number;
  tier: string;
  /** The model and effort the agent was deployed with: the lock's, for its tier, at deploy time. */
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** The model's output ceiling on Managed Agents, which cannot cap a request's output (K80). */
  max_output_tokens: number;
  /** Digest of the agent configuration the service reported at deploy. */
  config: string;
}

export interface ManagedAgentsBinding {
  format: typeof MA_BINDING_FORMAT;
  beta: string;
  tools: "bridge";
  environment: { id: string; config: string };
  /** The price of a session's running time (design doc 10 §1), in micro-units per hour. */
  session_fee: { currency: string; micros_per_hour: number };
  /** Input tokens the service adds to every model request beyond the conversation the runtime sees. */
  harness_tokens: number;
  agents: Record<string, ManagedAgentsAgentBinding>;
  profile: Record<string, ProfileLevel>;
}

/** The capabilities an agent declares, opened up through capability definitions. */
function agentCaps(program: Program, agent: AgentDef): CapVal[] {
  const resolve = (e: Expr): CapVal | undefined => {
    if (e.op === "var") {
      const d = program.defs[e.name];
      return d?.kind === "capability" ? resolve(d.value) : undefined;
    }
    return capFromCall(e);
  };
  return agent.caps.map(resolve).filter((c): c is CapVal => c !== undefined);
}

/** The model tiers an agent may call, and the highest data class it may send them. */
export function agentModels(program: Program, agent: AgentDef): { tiers: string[]; maxClass: DataClass } {
  const models = agentCaps(program, agent).filter((c) => c.ctor === "model.infer");
  const tiers = [...new Set(models.flatMap((c) => (c.tier ? [c.tier] : [])))].sort();
  const maxClass = models.map((c) => c.maxClass ?? DEFAULT_MODEL_MAX_CLASS).reduce<DataClass>((a, b) => (classRank(b) > classRank(a) ? b : a), "public");
  return { tiers, maxClass };
}

/**
 * The checks a Managed Agents binding needs: every bound agent is a local
 * agent of the program with one model tier (E0903); the binding still matches
 * the lock's model and effort for that tier, so a changed lock needs a new
 * deployment (E0903); the lock's output limit is at least the executor's
 * ceiling, which the service cannot lower (E0904, K80); and no bound agent
 * may send its model data above `internal`, since the service keeps session
 * history and is not zero-retention (E0905, K46).
 */
export function bindingChecks(program: Program, lock: Lock, spans?: Map<string, Span>): Diagnostic[] {
  const b = lock.bindings?.["managed-agents"];
  if (!b) return [];
  const out: Diagnostic[] = [];
  const at = (path: string): { path: string; span?: Span } => {
    const span = spans?.get(path);
    return span ? { path, span } : { path };
  };
  const lockAt = (path: string): { path: string } => ({ path: `lock:/bindings/managed-agents${path}` });
  if (b.beta !== MA_BETA) out.push(diag("E0903", `The Managed Agents binding was deployed under ${b.beta}; this runtime speaks ${MA_BETA}. Deploy again.`, lockAt("/beta"), { facts: { beta: b.beta, supported: MA_BETA } }));
  for (const [g, level] of Object.entries(b.profile).sort(([x], [y]) => (x < y ? -1 : 1))) {
    const real = MA_BRIDGE_PROFILE[g];
    if (real === undefined || rank(level) > rank(real)) {
      out.push(diag("E0903", `The binding claims ${g} is ${level}; a bridge binding gives ${real ?? "no such guarantee"}.`, lockAt(`/profile/${g}`), { facts: { guarantee: g, claimed: level, actual: real ?? null } }));
    }
  }
  for (const g of Object.keys(MA_BRIDGE_PROFILE)) {
    if (!Object.hasOwn(b.profile, g)) out.push(diag("E0903", `The binding's profile leaves out ${g}; every guarantee is listed, so none is dropped silently (INV-11).`, lockAt("/profile"), { facts: { guarantee: g } }));
  }
  for (const [name, a] of Object.entries(b.agents).sort(([x], [y]) => (x < y ? -1 : 1))) {
    const def = Object.hasOwn(program.defs, name) ? program.defs[name] : undefined;
    if (!def || def.kind !== "agent" || def.remote) {
      out.push(diag("E0903", `The Managed Agents binding names ${name}, which is not a local agent of this program.`, lockAt(`/agents/${name}`), { facts: { agent: name } }));
      continue;
    }
    const { tiers, maxClass } = agentModels(program, def);
    if (tiers.length !== 1 || tiers[0] !== a.tier) {
      out.push(diag("E0903", `${name} is bound to tier ${a.tier}, but its capabilities name ${tiers.length ? tiers.join(", ") : "no model tier"}. A bound agent has exactly one tier.`, at(`/defs/${name}/caps`), { facts: { agent: name, bound: a.tier, tiers } }));
      continue;
    }
    const m = lock.models?.[a.tier];
    if (!m || m.model !== a.model || m.effort !== a.effort) {
      out.push(
        diag("E0903", `${name} was deployed with ${a.model} at effort ${a.effort}; the lock maps ${a.tier} to ${m ? `${m.model} at effort ${m.effort}` : "nothing"}. Deploy again.`, lockAt(`/agents/${name}`), {
          facts: { agent: name, tier: a.tier, deployed: { model: a.model, effort: a.effort }, locked: m ? { model: m.model, effort: m.effort } : null },
        }),
      );
      continue;
    }
    if (m.max_output_tokens < a.max_output_tokens) {
      out.push(
        diag(
          "E0904",
          `${name} runs on Managed Agents, which cannot cap a request's output below ${a.model}'s ceiling of ${a.max_output_tokens} tokens; the lock's max_output_tokens for ${a.tier} is ${m.max_output_tokens}. Lock the ceiling, so the upper bound of a call stays true (K80).`,
          { path: `lock:/models/${a.tier}/max_output_tokens` },
          { facts: { agent: name, tier: a.tier, locked: m.max_output_tokens, ceiling: a.max_output_tokens } },
        ),
      );
    }
    if (classRank(maxClass) > classRank(MA_MAX_CLASS)) {
      out.push(
        diag("E0905", `${name} may send ${maxClass} data to its model, and Managed Agents keeps session history and is not zero-retention: a bound agent may send at most ${MA_MAX_CLASS} (K46). Run it on the local runtime.`, at(`/defs/${name}/caps`), {
          facts: { agent: name, max_class: maxClass, allowed: MA_MAX_CLASS },
        }),
      );
    }
  }
  return out;
}

function rank(l: ProfileLevel): number {
  return l === "full" ? 2 : l === "partial" ? 1 : 0;
}
