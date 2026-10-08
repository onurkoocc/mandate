// What the runtime asks of the outside world (Doc 4 §16, §16.1). Every
// nondeterministic step goes through one of these, and its result is journaled
// before the program sees it, so replay never calls them again (INV-09).

import type { Budget, RetryClass, SandboxRequirement, TypeExpr } from "@mandate/compiler";
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
export type Outcome = { ok: Value; cost?: Cost } | { error: FaultValue; cost?: Cost | "unknown" };

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
  commandId: string;
}

export interface ModelAdapter {
  infer(req: InferRequest): Promise<Outcome>;
  /** Upper-bound cost reserved before the call (§8.6: never the average). */
  upperBound(req: InferRequest): Cost;
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

export interface Adapters {
  agents: AgentAdapter;
  model: ModelAdapter;
  verifier: VerifierAdapter;
  reads: ReadAdapter;
  /** External effects by name, e.g. `git.open_pr`. */
  tools: Record<string, ToolAdapter>;
  clock: Clock;
  random(): number;
}
