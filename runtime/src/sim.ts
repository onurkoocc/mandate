// Simulated adapters for Gate 2 (Doc 4 §21.2: journal, state machine and
// supervision against simulated adapters). Each one records its calls, so a
// test can assert what reached the "outside world", and can be scripted to
// fail, hang, or lose its response at a chosen moment.

import type { RetryClass } from "@mandate/compiler";
import type {
  Adapters,
  AgentAdapter,
  AuthorizationContext,
  Clock,
  Cost,
  DelegateRequest,
  InferRequest,
  ModelAdapter,
  Outcome,
  PreparedAction,
  ReadAdapter,
  ToolAdapter,
  ToolContract,
  VerifierAdapter,
  VerifyRequest,
} from "./adapters.js";
import { digest, type Value } from "./values.js";

export class SimClock implements Clock {
  constructor(public t = 1_800_000_000_000) {}
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/** A promise the test resolves when it chooses: an adapter call "in flight". */
export interface Deferred<T> {
  promise: Promise<T>;
  resolve(v: T): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

type Script<Req> = (req: Req, call: number) => Outcome | Promise<Outcome>;

export class SimAgents implements AgentAdapter {
  readonly calls: DelegateRequest[] = [];
  constructor(private readonly scripts: Record<string, Script<DelegateRequest>> = {}) {}

  on(agentSkill: string, script: Script<DelegateRequest>): this {
    this.scripts[agentSkill] = script;
    return this;
  }

  async run(req: DelegateRequest): Promise<Outcome> {
    this.calls.push(req);
    const key = `${req.agent}.${req.skill}`;
    const script = this.scripts[key];
    if (!script) return { ok: { agent: key, args: req.args }, cost: { steps: 1 } };
    return script(req, this.calls.filter((c) => `${c.agent}.${c.skill}` === key).length);
  }

  count(agentSkill?: string): number {
    return agentSkill ? this.calls.filter((c) => `${c.agent}.${c.skill}` === agentSkill).length : this.calls.length;
  }
}

export class SimModel implements ModelAdapter {
  readonly calls: InferRequest[] = [];
  constructor(
    private script: Script<InferRequest> = () => ({ ok: "model output", cost: { tokens: 100 } }),
    /** Upper bound reserved per call: maximum tokens × pinned tariff (§8.6). */
    readonly tariff: { maxTokens: number; microsPerToken?: number; currency?: string } = { maxTokens: 1000 },
  ) {}

  respond(script: Script<InferRequest>): this {
    this.script = script;
    return this;
  }

  async infer(req: InferRequest): Promise<Outcome> {
    this.calls.push(req);
    return this.script(req, this.calls.length);
  }

  upperBound(): Cost {
    const t = this.tariff;
    return {
      tokens: t.maxTokens,
      ...(t.microsPerToken ? { spend: { micros: t.maxTokens * t.microsPerToken, currency: t.currency ?? "USD" } } : {}),
    };
  }
}

export class SimVerifier implements VerifierAdapter {
  readonly calls: VerifyRequest[] = [];
  /** Results by criterion name or method; anything unlisted passes. */
  constructor(readonly results: Record<string, boolean> = {}) {}

  async check(req: VerifyRequest): Promise<{ passed: boolean; detail?: Value }> {
    this.calls.push(req);
    const r = this.results[req.criterion] ?? this.results[req.method] ?? true;
    return { passed: r, detail: { method: req.method } };
  }
}

export class SimReads implements ReadAdapter {
  readonly calls: Array<{ name: string; args: Value[] }> = [];
  constructor(private readonly values: Record<string, Value> = {}) {}
  async call(name: string, args: Value[]): Promise<Outcome> {
    this.calls.push({ name, args });
    return { ok: this.values[name] ?? null };
  }
}

/**
 * What the simulated remote system does with one `execute` call:
 *   confirm             applies and answers
 *   reject              refuses, nothing applied
 *   lose_response       applies, but the answer is lost (a timeout to the caller)
 *   timeout             nothing applied, and the caller cannot tell (unknown)
 *   hold                waits until the test releases it, then confirms
 */
export type ToolBehavior = "confirm" | "reject" | "lose_response" | "timeout" | { hold: Deferred<void> };

export class SimTool implements ToolAdapter {
  readonly executions: Array<{ operationKey: string; params: Value; authorization: string }> = [];
  readonly prepares: Value[] = [];
  readonly reconciles: string[] = [];
  /** What the remote system holds, keyed by operation key: the system of record. */
  readonly applied = new Map<string, Value>();
  private readonly plan: ToolBehavior[] = [];

  constructor(
    readonly name: string,
    readonly retryClass: RetryClass = "idempotent",
  ) {}

  /** Behaviors for the next execute calls, in order; afterwards it confirms. */
  then(...b: ToolBehavior[]): this {
    this.plan.push(...b);
    return this;
  }

  describe(): ToolContract {
    return { id: `sim/${this.name}`, digest: digest("request", { adapter: this.name, retry: this.retryClass }), retryClass: this.retryClass };
  }

  async prepare(params: Value): Promise<{ prepared: true }> {
    this.prepares.push(params);
    return { prepared: true };
  }

  async execute(action: PreparedAction, auth: AuthorizationContext, operationKey: string): Promise<{ confirmed: Value } | { rejected: string } | { unknown: string }> {
    this.executions.push({ operationKey, params: action.params, authorization: auth.authorizationId });
    // An idempotent system ties one key to one result (§8.9).
    if (this.retryClass === "idempotent" && this.applied.has(operationKey)) return { confirmed: this.applied.get(operationKey)! };
    const b = this.plan.shift() ?? "confirm";
    const receipt = { system: this.name, operation: operationKey, n: this.applied.size + 1 };
    if (b === "reject") return { rejected: "refused by the remote system" };
    if (b === "timeout") return { unknown: "timeout" };
    if (b === "lose_response") {
      this.applied.set(operationKey, receipt);
      return { unknown: "timeout after send" };
    }
    if (typeof b === "object") await b.hold.promise;
    this.applied.set(operationKey, receipt);
    return { confirmed: receipt };
  }

  async reconcile(operationKey: string): Promise<{ applied: Value } | { notApplied: string }> {
    this.reconciles.push(operationKey);
    const r = this.applied.get(operationKey);
    return r !== undefined ? { applied: r } : { notApplied: `no operation ${operationKey} in the system of record` };
  }

  /** Distinct operations the remote system applied. */
  appliedCount(): number {
    return this.applied.size;
  }
}

export interface Sim {
  adapters: Adapters;
  clock: SimClock;
  agents: SimAgents;
  model: SimModel;
  verifier: SimVerifier;
  reads: SimReads;
  tools: Record<string, SimTool>;
}

export function simulate(o: { tools?: SimTool[]; agents?: SimAgents; model?: SimModel; verifier?: SimVerifier; reads?: SimReads; seed?: number } = {}): Sim {
  const clock = new SimClock();
  const agents = o.agents ?? new SimAgents();
  const model = o.model ?? new SimModel();
  const verifier = o.verifier ?? new SimVerifier();
  const reads = o.reads ?? new SimReads();
  const tools = Object.fromEntries((o.tools ?? []).map((t) => [t.name, t]));
  let seed = o.seed ?? 42;
  const random = (): number => {
    // Deterministic for tests; the runtime journals every draw anyway.
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  return { adapters: { agents, model, verifier, reads, tools, clock, random }, clock, agents, model, verifier, reads, tools };
}
