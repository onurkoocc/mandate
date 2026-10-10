// The Claude Managed Agents executor (BACKLOG item 39; design doc 10, Form A;
// decisions K45–K47, K79, K80). The workflow body, the journal, the budget,
// the evidence and the approvals stay here. Each delegation to a bound agent
// is one Managed Agents session (K45), and the service runs the agent loop's
// model side: it holds the conversation and calls the model.
//
// Every tool is a custom tool (K79, the "bridge"). A custom tool call stops
// the session until the client answers, so each one comes back to the
// runtime's agent loop (loop.ts), which checks it against the grant, runs it
// in the agent's own MXC sandbox and journals it, exactly as for a local
// loop. The loop's progress checks, steps limit and repairs therefore hold
// unchanged, and every turn is a journaled command: replay calls nothing here
// (INV-09). The service never runs a tool, holds a credential (K7) or sees a
// file the agent did not read.
//
//   deploy          one Managed Agents agent per bound Mandate agent (model and
//                   effort from the lock, no tools of its own, no multiagent),
//                   one environment with no network; the binding goes into the lock
//   ValidateBinding before every run: the pinned agent versions and the
//                   environment still have the configuration that was deployed
//   open            a session per delegation, pinned to the agent's version, with
//                   the delegation's system prompt and custom tools as overrides
//   turn            sends the loop's last message (tool results or text), waits
//                   until the session stops, and hands back the agent's message;
//                   priced from the session's model usage and the turn's running time
//   close           archives the session
//
// Managed Agents cannot cap one request's output, so a bound tier's lock
// states the model's ceiling (E0904, K80), and the upper bound of a turn is
// still true. The service also adds context of its own to every request; the
// binding's `harness_tokens` allows for it.

import Anthropic from "@anthropic-ai/sdk";
import { bindingChecks, canonicalize, MA_BETA, MA_BINDING_FORMAT, MA_BRIDGE_PROFILE, type Json, type Lock, type ManagedAgentsBinding, type ModelLock, type Program, type Tariff, agentModels } from "@mandate/compiler";
import type { ChatModel, Cost, Executor, OpenRequest, Outcome, ToolSpec, TurnBound, TurnRequest } from "./adapters.js";
import { boundOf, failure, priceUsage } from "./anthropic.js";
import { Violation } from "./signals.js";
import { digest, isObj, type Value } from "./values.js";

// ── the service, as far as this executor uses it ─────────────────────────

export interface MaAgent {
  id: string;
  version: number;
  archived_at: string | null;
  model: unknown;
  tools?: unknown[];
  mcp_servers?: unknown[];
  skills?: unknown[];
  multiagent?: unknown;
}

export interface MaEnvironment {
  id: string;
  archived_at: string | null;
  config: unknown;
}

export interface MaSession {
  id: string;
  status: string;
  usage?: { active_seconds?: number };
}

export type MaEvent = { id: string; type: string } & Record<string, unknown>;

/** The calls the executor makes; `sdkApi` wraps the SDK client, tests pass a fake. */
export interface ManagedAgentsApi {
  /** The model's output ceiling (`max_tokens` from the Models API). */
  modelMaxOutput(model: string): Promise<number>;
  countTokens(params: { model: string; system: string; tools: ToolSpec[]; messages: Value[] }): Promise<number>;
  createAgent(body: Record<string, unknown>): Promise<MaAgent>;
  updateAgent(id: string, body: Record<string, unknown>): Promise<MaAgent>;
  retrieveAgent(id: string, version: number): Promise<MaAgent>;
  createEnvironment(body: Record<string, unknown>): Promise<MaEnvironment>;
  retrieveEnvironment(id: string): Promise<MaEnvironment>;
  createSession(body: Record<string, unknown>): Promise<MaSession>;
  retrieveSession(id: string): Promise<MaSession>;
  updateSession(id: string, body: Record<string, unknown>): Promise<MaSession>;
  archiveSession(id: string): Promise<MaSession>;
  sendEvents(id: string, events: Array<Record<string, unknown>>): Promise<void>;
  /** All of a session's events, oldest first. */
  listEvents(id: string): Promise<MaEvent[]>;
}

/** The SDK client as a `ManagedAgentsApi`. The SDK sets the beta header on `client.beta.*` itself. */
export function sdkApi(client: Anthropic): ManagedAgentsApi {
  const b = client.beta;
  const any = <T>(p: unknown): Promise<T> => p as Promise<T>;
  return {
    modelMaxOutput: async (model) => {
      const m = await client.models.retrieve(model);
      const max = (m as unknown as { max_tokens?: number | null }).max_tokens;
      if (typeof max !== "number") throw new Violation("unknown_model_ceiling", `The Models API reports no max_tokens for ${model}.`);
      return max;
    },
    countTokens: async (p) => (await client.messages.countTokens({ model: p.model, system: p.system, tools: p.tools as unknown as Anthropic.Tool[], messages: p.messages as unknown as Anthropic.MessageParam[] })).input_tokens,
    createAgent: (body) => any(b.agents.create(body as never)),
    updateAgent: (id, body) => any(b.agents.update(id, body as never)),
    retrieveAgent: (id, version) => any(b.agents.retrieve(id, { version })),
    createEnvironment: (body) => any(b.environments.create(body as never)),
    retrieveEnvironment: (id) => any(b.environments.retrieve(id)),
    createSession: (body) => any(b.sessions.create(body as never)),
    retrieveSession: (id) => any(b.sessions.retrieve(id)),
    updateSession: (id, body) => any(b.sessions.update(id, body as never)),
    archiveSession: (id) => any(b.sessions.archive(id)),
    sendEvents: async (id, events) => {
      await b.sessions.events.send(id, { events } as never);
    },
    listEvents: async (id) => {
      const out: MaEvent[] = [];
      for await (const e of b.sessions.events.list(id, { order: "asc" } as never)) out.push(e as unknown as MaEvent);
      return out;
    },
  };
}

// ── names and configurations ─────────────────────────────────────────────

/** The service's own tools; a custom tool may not take one of their names. */
const BUILTIN = new Set(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"]);

/** A loop tool's name on the service: `grep` is a built-in tool's name there, so it travels as `mandate_grep`. */
export function maToolName(name: string): string {
  return BUILTIN.has(name) ? `mandate_${name}` : name;
}

function loopToolName(name: string): string {
  return name.startsWith("mandate_") && BUILTIN.has(name.slice("mandate_".length)) ? name.slice("mandate_".length) : name;
}

function customTools(tools: ToolSpec[]): Array<Record<string, unknown>> {
  return tools.map((t) => ({ type: "custom", name: maToolName(t.name), description: t.description, input_schema: inlineRefs(t.input_schema) }));
}

/**
 * A tool schema without `$ref`: the service refuses `$ref` in a custom
 * tool's input schema (seen in the live trial), so every reference into
 * `$defs` is replaced by the definition it names. A recursive type cannot be
 * written out that way, and is refused by name rather than cut short.
 */
export function inlineRefs(schema: Value): Value {
  const root = isObj(schema) ? schema : {};
  const defs = (isObj((root["$defs"] ?? null) as Value) ? root["$defs"] : {}) as Record<string, Value>;
  const walk = (v: Value, path: string[]): Value => {
    if (Array.isArray(v)) return v.map((x) => walk(x, path));
    if (!isObj(v)) return v;
    const ref = v["$ref"];
    if (typeof ref === "string") {
      const name = ref.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
      if (name === undefined || !Object.hasOwn(defs, name)) throw new Violation("unsupported_schema", `A tool schema refers to ${ref}, which cannot be written out for Managed Agents.`);
      if (path.includes(name)) throw new Violation("unsupported_schema", `Type ${name} is recursive; Managed Agents takes no $ref in a tool schema, so it cannot be written out (INV-11).`);
      const { $ref: _ref, ...rest } = v;
      return { ...(walk(defs[name]!, [...path, name]) as Record<string, Value>), ...walk(rest, path) as Record<string, Value> };
    }
    const out: Record<string, Value> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "$defs") out[k] = walk(x, path);
    return out;
  };
  return walk(root, []);
}

/** What the binding fixes of a deployed agent: its model and effort, and that it has no tools, servers, skills or roster of its own. */
function agentProjection(a: MaAgent): Value {
  const m = (typeof a.model === "string" ? { id: a.model } : (a.model ?? {})) as { id?: unknown; effort?: unknown };
  const effort = typeof m.effort === "string" ? m.effort : isObj((m.effort ?? null) as Value) ? ((m.effort as { type?: string }).type ?? null) : null;
  return {
    id: a.id,
    version: a.version,
    model: { id: String(m.id ?? ""), effort },
    tools: (a.tools ?? []) as Value,
    mcp_servers: (a.mcp_servers ?? []) as Value,
    skills: (a.skills ?? []) as Value,
    multiagent: (a.multiagent ?? null) as Value,
  };
}

function environmentProjection(e: MaEnvironment): Value {
  const c = (e.config ?? {}) as { type?: unknown; networking?: unknown };
  return { id: e.id, type: (c.type ?? null) as Value, networking: (c.networking ?? null) as Value };
}

/** The environment of a bridge binding: a cloud container with no network. The bridge runs no tool in it. */
export const BRIDGE_NETWORKING = { type: "limited", allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false };

/** Price of a session's running time, from the service's price list (design doc 10 §1): 0.08 USD an hour. */
export const SESSION_FEE = { currency: "USD", micros_per_hour: 80_000 };

/** The default allowance for the context the service adds to each request; the live trial measures it. */
export const DEFAULT_HARNESS_TOKENS = 4_096;

// ── deploy and ValidateBinding ───────────────────────────────────────────

export interface DeployOptions {
  program: Program;
  lock: Lock;
  api: ManagedAgentsApi;
  /** The agents to bind; default every local agent with exactly one model tier. */
  agents?: string[];
  /** A name prefix for the agents and the environment. */
  name?: string;
  harnessTokens?: number;
  /** For the environment's unique name. */
  now?: () => number;
}

/**
 * Deploys the program's agents and writes the binding (K45). A binding that
 * would not pass the compiler's checks (the lock's output limit below the
 * model's ceiling, an agent that may send `confidential` data) is refused
 * before anything is created. An agent or environment the lock already binds
 * is updated, so its id stays and its version moves on.
 */
export async function deployManagedAgents(o: DeployOptions): Promise<ManagedAgentsBinding> {
  const prev = o.lock.bindings?.["managed-agents"];
  const agents = o.agents ?? Object.entries(o.program.defs).filter(([, d]) => d.kind === "agent" && !d.remote && agentModels(o.program, d).tiers.length === 1).map(([n]) => n).sort();
  if (!agents.length) throw new Violation("nothing_to_deploy", "No local agent with exactly one model tier to deploy.");
  const plan: Record<string, { tier: string; model: ModelLock; ceiling: number }> = {};
  for (const name of agents) {
    const d = o.program.defs[name];
    if (!d || d.kind !== "agent" || d.remote) throw new Violation("not_deployable", `${name} is not a local agent of the program.`);
    const { tiers } = agentModels(o.program, d);
    const tier = tiers[0];
    const model = tier === undefined ? undefined : o.lock.models?.[tier];
    if (tiers.length !== 1 || !model) throw new Violation("not_deployable", `${name} needs exactly one locked model tier, not ${tiers.join(", ") || "none"}.`);
    plan[name] = { tier: tier!, model, ceiling: await o.api.modelMaxOutput(model.model) };
  }
  // The checks first, against a binding with what is known before anything is created.
  const draft = bindingOf(prev?.environment ?? { id: "pending", config: digest("binding", null) }, Object.fromEntries(agents.map((n) => [n, { id: "pending", version: 1, ...pick(plan[n]!), config: digest("binding", null) }])), o.harnessTokens ?? prev?.harness_tokens);
  const refused = bindingChecks(o.program, { ...o.lock, bindings: { "managed-agents": draft } }).filter((d) => d.severity === "error");
  if (refused.length) throw new Violation("not_deployable", refused.map((d) => `${d.code} ${d.message}`).join(" "));

  const prefix = o.name ?? "mandate";
  const env = prev
    ? await o.api.retrieveEnvironment(prev.environment.id)
    : await o.api.createEnvironment({ name: `${prefix}-${(o.now ?? Date.now)().toString(36)}`, description: "Mandate bridge: tools run in the Mandate runtime's sandbox, none here.", config: { type: "cloud", networking: BRIDGE_NETWORKING } });
  if (env.archived_at) throw new Violation("not_deployable", `Environment ${env.id} is archived.`);
  const out: ManagedAgentsBinding["agents"] = {};
  for (const name of agents) {
    const p = plan[name]!;
    const body = {
      name: `${prefix} ${name}`,
      description: `Mandate agent ${name}. Its system prompt and tools are set per delegation; it has none of its own.`,
      // Effort is part of the model binding and always sent (K10).
      model: { id: p.model.model, effort: p.model.effort },
      tools: [],
      mcp_servers: [],
      skills: [],
      metadata: { mandate_agent: name },
    };
    const was = prev?.agents[name];
    const a = was ? await o.api.updateAgent(was.id, { ...body, version: was.version }) : await o.api.createAgent(body);
    const proj = agentProjection(a) as { tools: Value[]; mcp_servers: Value[]; skills: Value[]; multiagent: Value };
    if (proj.tools.length || proj.mcp_servers.length || proj.skills.length || proj.multiagent !== null) {
      throw new Violation("not_deployable", `Agent ${a.id} came back with tools, servers, skills or a roster of its own; a bridge agent has none (K46, K79).`);
    }
    out[name] = { id: a.id, version: a.version, ...pick(p), config: digest("binding", agentProjection(a)) };
  }
  return bindingOf({ id: env.id, config: digest("binding", environmentProjection(env)) }, out, o.harnessTokens ?? prev?.harness_tokens);
}

function pick(p: { tier: string; model: ModelLock; ceiling: number }): Pick<ManagedAgentsBinding["agents"][string], "tier" | "model" | "effort" | "max_output_tokens"> {
  return { tier: p.tier, model: p.model.model, effort: p.model.effort, max_output_tokens: p.ceiling };
}

function bindingOf(environment: ManagedAgentsBinding["environment"], agents: ManagedAgentsBinding["agents"], harness?: number): ManagedAgentsBinding {
  return {
    format: MA_BINDING_FORMAT,
    beta: MA_BETA,
    tools: "bridge",
    environment,
    session_fee: SESSION_FEE,
    harness_tokens: harness ?? DEFAULT_HARNESS_TOKENS,
    agents,
    profile: { ...MA_BRIDGE_PROFILE },
  };
}

/**
 * ValidateBinding (§16.1, design doc 10 §3.1). The service has no content
 * hash, so identity is kept here: every pinned agent version and the
 * environment, read back, must have the configuration the binding recorded.
 * An environment is not versioned, so it is read on every run.
 */
export async function validateManagedAgentsBinding(binding: ManagedAgentsBinding, api: ManagedAgentsApi): Promise<{ supported: true } | { unsupported: string }> {
  for (const [name, a] of Object.entries(binding.agents).sort(([x], [y]) => (x < y ? -1 : 1))) {
    let got: MaAgent;
    try {
      got = await api.retrieveAgent(a.id, a.version);
    } catch (e) {
      return { unsupported: `agent ${name} (${a.id} v${a.version}) cannot be read: ${(e as Error).message}` };
    }
    if (got.archived_at) return { unsupported: `agent ${name} (${a.id}) is archived` };
    const now = digest("binding", agentProjection(got));
    if (got.version !== a.version || now !== a.config) return { unsupported: `agent ${name} (${a.id} v${a.version}) is not configured as deployed (${now}, deployed ${a.config})` };
  }
  let env: MaEnvironment;
  try {
    env = await api.retrieveEnvironment(binding.environment.id);
  } catch (e) {
    return { unsupported: `environment ${binding.environment.id} cannot be read: ${(e as Error).message}` };
  }
  if (env.archived_at) return { unsupported: `environment ${env.id} is archived` };
  const now = digest("binding", environmentProjection(env));
  if (now !== binding.environment.config) return { unsupported: `environment ${env.id} is not configured as deployed (${now}, deployed ${binding.environment.config})` };
  return { supported: true };
}

// ── the chat ─────────────────────────────────────────────────────────────

export interface ManagedAgentsOptions {
  binding: ManagedAgentsBinding;
  lock: Lock;
  api: ManagedAgentsApi;
  /** How often a waiting turn reads the session's events. Default 1000 ms. */
  pollMs?: number;
  /** The longest a turn may run before it is interrupted; with a grace for stopping, it bounds the turn's session fee. Default one hour. */
  maxTurnMs?: number;
  /** A title prefix for sessions, e.g. the run id. */
  title?: string;
  clock?: { now(): number; sleep(ms: number): Promise<void> };
}

/** How long a turn's fee bound allows for the session to stop after an interrupt. */
const STOP_GRACE_MS = 300_000;

const SYSTEM_CLOCK = { now: () => Date.now(), sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };

/** The executor for a package whose lock binds agents to Managed Agents. */
export function managedAgentsExecutor(o: ManagedAgentsOptions): Executor {
  const chats: Record<string, ChatModel> = {};
  for (const name of Object.keys(o.binding.agents)) chats[name] = new ManagedAgentsChat(o, name);
  return { name: "managed-agents", chats, validateBinding: () => validateManagedAgentsBinding(o.binding, o.api) };
}

/** What `open` journals: the session, and the agent version it is pinned to. */
interface Opened {
  session: string;
  agent: string;
  version: number;
}

export class ManagedAgentsChat implements ChatModel {
  private readonly model: ModelLock;
  private readonly tariff: Tariff;
  private readonly clock: NonNullable<ManagedAgentsOptions["clock"]>;
  private readonly counted = new Map<string, number>();
  /** The tools each open session has now, by digest, so a turn with other tools updates them first (plan_execute). */
  private readonly toolsOf = new Map<string, string>();

  constructor(
    private readonly o: ManagedAgentsOptions,
    private readonly agent: string,
  ) {
    const a = o.binding.agents[agent]!;
    const model = o.lock.models?.[a.tier];
    const tariff = model && o.lock.tariffs?.[model.model];
    if (!model || !tariff) throw new Violation("unlocked_model_tier", `Model tier ${a.tier} of ${agent} is not in the lock file (MDT-E0141).`);
    if (tariff.currency !== o.binding.session_fee.currency) throw new Violation("bad_binding", `${model.model} is priced in ${tariff.currency}, the session fee in ${o.binding.session_fee.currency}.`);
    this.model = model;
    this.tariff = tariff;
    this.clock = o.clock ?? SYSTEM_CLOCK;
  }

  private get maxTurnMs(): number {
    return this.o.maxTurnMs ?? 3_600_000;
  }

  /** The session fee of `ms` of running time, rounded up to a whole micro-unit. */
  private fee(ms: number): number {
    return Math.ceil((ms * this.o.binding.session_fee.micros_per_hour) / 3_600_000);
  }

  async open(req: OpenRequest): Promise<Outcome> {
    const a = this.o.binding.agents[this.agent]!;
    // The service's cap, in cents, is a second line behind the runtime's own reservation of every turn.
    const cents = req.spend && req.spend.currency === "USD" ? Math.floor(req.spend.micros / 10_000) : 0;
    try {
      const s = await this.o.api.createSession({
        agent: { type: "agent_with_overrides", id: a.id, version: a.version, system: req.system, tools: customTools(req.tools) },
        environment_id: this.o.binding.environment.id,
        title: `${this.o.title ? `${this.o.title} ` : ""}${req.agent}.${req.skill}`.slice(0, 200),
        metadata: { mandate_delegation: req.commandId.slice(0, 512) },
        ...(cents > 0 ? { budget: { type: "limit", max_list_cost: { amount: String(cents), currency: "USD" } } } : {}),
      });
      this.toolsOf.set(s.id, toolsDigest(req.tools));
      return { ok: { session: s.id, agent: a.id, version: a.version } satisfies Opened as unknown as Value, cost: {} };
    } catch (e) {
      return failure(e);
    }
  }

  async close(session: Value): Promise<Outcome> {
    const id = (session as unknown as Opened).session;
    try {
      await this.o.api.archiveSession(id);
      this.toolsOf.delete(id);
      return { ok: { archived: id }, cost: {} };
    } catch (e) {
      return failure(e);
    }
  }

  async turnBound(req: TurnRequest): Promise<TurnBound> {
    const key = canonicalize({ system: req.system, tools: req.tools, messages: req.messages } as unknown as Json);
    let n = this.counted.get(key);
    if (n === undefined) {
      n = await this.o.api.countTokens({ model: this.model.model, system: req.system, tools: req.tools, messages: req.messages });
      this.counted.set(key, n);
    }
    const inputTokens = n + this.o.binding.harness_tokens;
    const b = boundOf(this.tariff, this.model, inputTokens);
    // A turn also pays for the session's running time: at most the longest a turn may run, and the stop that follows an interrupt.
    return { cost: { ...b, spend: { micros: b.spend!.micros + this.fee(this.maxTurnMs + STOP_GRACE_MS), currency: this.tariff.currency } }, inputTokens, maxInputTokens: this.model.max_input_tokens };
  }

  async turn(req: TurnRequest): Promise<Outcome> {
    const opened = req.session as unknown as Opened | undefined;
    if (!opened?.session) throw new Violation("no_session", `${req.commandId}: a Managed Agents turn needs the delegation's session.`);
    const id = opened.session;
    try {
      const last = req.messages.at(-1) as { role?: string; content?: unknown } | undefined;
      if (last?.role !== "user") throw new Violation("bad_turn", `${req.commandId}: the conversation does not end with the runtime's message.`);
      // The session keeps the conversation; only what the loop added since the last turn is sent, and only once:
      // a turn re-run after a crash finds its message already there and waits for the answer instead.
      let events = await this.o.api.listEvents(id);
      const wanted = userEvents(last.content, req.messages);
      if (!wanted.length) throw new Violation("bad_turn", `${req.commandId}: the runtime's message has neither tool results nor text.`);
      const missing = wanted.filter((w) => !sent(w, events));
      const tools = toolsDigest(req.tools);
      if (this.toolsOf.get(id) !== tools && missing.length) {
        await this.o.api.updateSession(id, { agent: { tools: customTools(req.tools) } });
        this.toolsOf.set(id, tools);
      }
      if (missing.length) await this.o.api.sendEvents(id, missing.map((w) => w.event));
      const started = this.clock.now();
      let interrupted = false;
      for (;;) {
        events = await this.o.api.listEvents(id);
        const from = Math.max(...wanted.map((w) => sentAt(w, events)));
        if (from >= 0) {
          const end = events.findIndex((e, i) => i > from && (e.type === "session.status_idle" || e.type === "session.status_terminated"));
          if (end >= 0) {
            // The session ran from the service's echo of the message to its stop: that is what the turn's fee is for.
            // Both times come from the service's events, so a turn re-run after a crash is priced the same.
            const ms = Math.max(0, Date.parse(String(events[end]!["processed_at"])) - Date.parse(String(events[from]!["processed_at"])));
            return this.answer(events.slice(from + 1, end + 1), Number.isFinite(ms) ? ms : this.maxTurnMs, interrupted);
          }
        }
        if (!interrupted && (this.clock.now() - started >= this.maxTurnMs || (await req.cancelled?.()))) {
          // The turn stops where it is; the loop sees what the agent said so far, and a cancelled run takes no next step (R08).
          await this.o.api.sendEvents(id, [{ type: "user.interrupt" }]);
          interrupted = true;
        }
        await this.clock.sleep(this.o.pollMs ?? 1000);
      }
    } catch (e) {
      if (e instanceof Violation) throw e;
      return failure(e);
    }
  }

  /** The agent's message for one turn, from the session's events, priced at the lock's tariff and the session fee. */
  private answer(events: MaEvent[], runMs: number, interrupted: boolean): Outcome {
    const content: Value[] = [];
    let usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    let requests = 0;
    const errors: Value[] = [];
    for (const e of events) {
      if (e.type === "agent.message") {
        for (const b of (e["content"] ?? []) as Array<{ type?: string; text?: string }>) if (b.type === "text" && typeof b.text === "string") content.push({ type: "text", text: b.text });
      } else if (e.type === "agent.custom_tool_use") {
        content.push({ type: "tool_use", id: e.id, name: loopToolName(String(e["name"])), input: (isObj((e["input"] ?? null) as Value) ? e["input"] : {}) as Value });
      } else if (e.type === "span.model_request_end") {
        const u = (e["model_usage"] ?? {}) as Partial<typeof usage>;
        requests++;
        usage = {
          input_tokens: usage.input_tokens + (u.input_tokens ?? 0),
          output_tokens: usage.output_tokens + (u.output_tokens ?? 0),
          cache_creation_input_tokens: usage.cache_creation_input_tokens + (u.cache_creation_input_tokens ?? 0),
          cache_read_input_tokens: usage.cache_read_input_tokens + (u.cache_read_input_tokens ?? 0),
        };
      } else if (e.type === "session.error") {
        errors.push((e["error"] ?? e["message"] ?? null) as Value);
      }
    }
    const priced = priceUsage(this.tariff, usage);
    const cost: Cost = { tokens: priced.tokens!, steps: 1, spend: { micros: priced.spend!.micros + this.fee(runMs), currency: this.tariff.currency } };
    const end = events.at(-1)!;
    const stop = (end["stop_reason"] ?? {}) as { type?: string };
    const meta: Value = { executor: "managed-agents", locked: this.model.model, effort: this.model.effort, requests, usage, run_ms: runMs, stop: stop.type ?? end.type, ...(interrupted ? { interrupted: true } : {}), ...(errors.length ? { errors } : {}) };
    if (end.type === "session.status_terminated") return { error: { tag: "Rejected", args: [{ reason: "session_terminated", errors }] }, cost, meta };
    switch (stop.type) {
      case "requires_action":
        return { ok: { content, stop_reason: "tool_use" }, cost, meta };
      case "end_turn":
        return { ok: { content, stop_reason: "end_turn" }, cost, meta };
      case "refusal":
        return { ok: { content, stop_reason: "refusal" }, cost, meta };
      case "budget_reached":
        // The service's cap sits at the delegation's own budget, so reaching it is the delegation running out.
        return { error: { tag: "SkillFailed", args: [{ kind: "StepLimit", detail: "the Managed Agents session reached its spend cap" }] }, cost, meta };
      default:
        return { error: { tag: "Timeout", args: [{ reason: stop.type ?? "unknown_stop", errors }] }, cost, meta };
    }
  }
}

function toolsDigest(tools: ToolSpec[]): string {
  return digest("binding", tools as unknown as Value);
}

/** One event the loop's message becomes, and how to tell it was already sent. */
interface Wanted {
  event: Record<string, unknown>;
  /** A tool result: the tool call it answers. */
  answers?: string;
  /** A text message: which user text message of the conversation it is, from 1. */
  ordinal?: number;
}

function userEvents(content: unknown, messages: Value[]): Wanted[] {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
  const out: Wanted[] = [];
  for (const b of blocks) {
    if (b["type"] !== "tool_result") continue;
    const text = typeof b["content"] === "string" ? b["content"] : JSON.stringify(b["content"] ?? "");
    const toolUse = String(b["tool_use_id"]);
    out.push({ event: { type: "user.custom_tool_result", custom_tool_use_id: toolUse, content: [{ type: "text", text }], is_error: b["is_error"] === true }, answers: toolUse });
  }
  const texts = blocks.filter((b) => b["type"] === "text" && typeof b["text"] === "string").map((b) => ({ type: "text", text: b["text"] as string }));
  if (texts.length) {
    const ordinal = messages.filter((m) => isObj(m) && m["role"] === "user" && hasText(m["content"] ?? null)).length;
    out.push({ event: { type: "user.message", content: texts }, ordinal });
  }
  return out;
}

function hasText(content: Value): boolean {
  return typeof content === "string" || (Array.isArray(content) && content.some((b) => isObj(b) && b["type"] === "text"));
}

/** Where the session's echo of a sent event is, or -1. */
function sentAt(w: Wanted, events: MaEvent[]): number {
  if (w.answers !== undefined) return events.findIndex((e) => e.type === "user.custom_tool_result" && e["custom_tool_use_id"] === w.answers);
  let seen = 0;
  for (let i = 0; i < events.length; i++) if (events[i]!.type === "user.message" && ++seen === w.ordinal) return i;
  return -1;
}

function sent(w: Wanted, events: MaEvent[]): boolean {
  return sentAt(w, events) >= 0;
}
