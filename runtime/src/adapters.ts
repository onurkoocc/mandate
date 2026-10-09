// What the runtime asks of the outside world (Doc 4 §16, §16.1). Every
// nondeterministic step goes through one of these, and its result is journaled
// before the program sees it, so replay never calls them again (INV-09).

import type { Budget, RetryClass, SandboxRequirement, TypeExpr } from "@mandate/compiler";
import type { MxcAdapter } from "./sandbox.js";
import type { Value } from "./values.js";

export interface Cost {
  tokens?: number;
  steps?: number;
  spend?: { micros: number; currency: string };
}

export interface FaultValue {
  tag: string;
  args?: Value[];
}

/**
 * Result of a call that may cost money. `cost: "unknown"` means the provider
 * has not reported a charge yet (a timeout or cancellation): the reservation
 * then stays in place until the charge is settled (R16).
 */
export type Outcome = ({ ok: Value; cost?: Cost } | { error: FaultValue; cost?: Cost | "unknown" }) & {
  /** What produced the result, e.g. the model snapshot that answered (§5.2); journaled with the result. */
  meta?: Value;
};

/** A capability as handed to a delegate: constructor and scope. */
export interface CapGrant {
  ctor: string;
  scope?: string[];
}

export interface DelegateRequest {
  agent: string;
  skill: string;
  args: Value[];
  caps: CapGrant[];
  budget?: Budget;
  isolated: boolean;
  /** 0 for the first try; restarts reuse the operation and raise the attempt (§8.7). */
  attempt: number;
  commandId: string;
  /**
   * What the agent's sandbox must enforce, built from this delegation's grant
   * and time budget (§7.3, §7.5). Absent for remote agents, which run elsewhere.
   */
  sandbox?: SandboxRequirement;
}

export interface AgentAdapter {
  run(req: DelegateRequest): Promise<Outcome>;
}

export interface InferRequest {
  type: TypeExpr;
  input: Value;
  using?: Value;
  /** The model tier of the capability the call runs under; the lock file maps it to a model. */
  tier?: string;
  commandId: string;
}

export interface ModelAdapter {
  infer(req: InferRequest): Promise<Outcome>;
  /** Upper-bound cost reserved before the call (§8.6: never the average). */
  upperBound(req: InferRequest): Cost | Promise<Cost>;
}

/** A tool an agent may call, as the model sees it (K8). */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Value;
}

/**
 * One turn of an agent loop (§8.2, K7): the conversation so far, which only
 * ever grows, and the tools. The result is the model's message:
 * `{ content: [ … blocks ], stop_reason }`.
 */
export interface TurnRequest {
  tier: string;
  system: string;
  tools: ToolSpec[];
  messages: Value[];
  commandId: string;
}

export interface TurnBound {
  /** What the turn reserves: its counted input and the output limit, priced with no cache hit. */
  cost: Cost;
  inputTokens: number;
  maxInputTokens: number;
}

/** The model side of an agent loop. Its calls are made from the runtime process, never from a sandbox (K7). */
export interface ChatModel {
  turnBound(req: TurnRequest): Promise<TurnBound>;
  turn(req: TurnRequest): Promise<Outcome>;
}

export interface VerifyRequest {
  method: string;
  args: Value[];
  named: Record<string, Value>;
  contract: string;
  criterion: string;
}

export interface VerifierAdapter {
  check(req: VerifyRequest): Promise<{ passed: boolean; detail?: Value }>;
}

/** Read-only std calls (fs.read_text, net.https.get, …). */
export interface ReadAdapter {
  call(name: string, args: Value[], named: Record<string, Value>): Promise<Outcome>;
}

export interface ToolContract {
  id: string;
  /** Digest of the adapter's immutable contract; part of every action digest. */
  digest: string;
  retryClass: RetryClass;
}

export interface PreparedAction {
  effect: string;
  params: Value;
  actionDigest: string;
  operationKey: string;
}

export interface AuthorizationContext {
  authorizationId: string;
  decidedBy: string;
}

/** Tool adapter contract (§16.1). Silence, a timeout or an HTTP 500 is `unknown`, never `notApplied`. */
export interface ToolAdapter {
  describe(): ToolContract;
  prepare(params: Value): Promise<{ prepared: true } | { rejected: string }>;
  execute(action: PreparedAction, auth: AuthorizationContext, operationKey: string): Promise<{ confirmed: Value } | { rejected: string } | { unknown: string }>;
  reconcile(operationKey: string): Promise<{ applied: Value } | { notApplied: string } | { unknown: string }>;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Agent loops (§8.2, K7). When present, a bodiless skill of a local agent runs
 * as a loop in the runtime process: the model through `chat`, each tool call
 * in a sandbox from `sandbox`. Without it, `agents` answers a delegation in one
 * call (the simulation of Gate 2).
 */
export interface LoopAdapters {
  chat: ChatModel;
  sandbox: MxcAdapter;
}

export interface Adapters {
  agents: AgentAdapter;
  loop?: LoopAdapters;
  model: ModelAdapter;
  verifier: VerifierAdapter;
  reads: ReadAdapter;
  /** External effects by name, e.g. `git.open_pr`. */
  tools: Record<string, ToolAdapter>;
  clock: Clock;
  random(): number;
}
