// What the runtime asks of the outside world (Doc 4 §16, §16.1). Every
// nondeterministic step goes through one of these, and its result is journaled
// before the program sees it, so replay never calls them again (INV-09).

import type { Budget, Command, DataClass, RetryClass, SandboxRequirement, TypeExpr } from "@mandate/compiler";
import type { MxcAdapter } from "./sandbox.js";
import type { WorkspaceAdapter } from "./workspace.js";
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
  /** With `delegate … timeout d`: when the attempt must have finished (epoch ms). A later result is discarded. */
  deadline?: number;
  commandId: string;
  /**
   * What the agent's sandbox must enforce, built from this delegation's grant
   * and time budget (§7.3, §7.5). Absent for remote agents, which run elsewhere.
   */
  sandbox?: SandboxRequirement;
}

export interface AgentAdapter {
  run(req: DelegateRequest): Promise<Outcome>;
  /**
   * What delivery a remote agent's server guarantees (§9.6, G12). A2A does
   * not require a server to deduplicate messages by id; unless the adapter
   * says its server does, a task sent twice may run twice. Absent: no such
   * guarantee.
   */
  remoteProfile?(agent: string): { idempotentMessages: boolean };
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
  /**
   * The system the run works on (design doc 9 §2, §4): its components, with
   * the commit the run started from, and its interfaces. Boundary checks
   * (test.suite_each, test.contract, test.integration, test.ci) read it.
   */
  system?: SystemFacts;
}

export interface SystemFacts {
  components: Record<string, { repo: string; root: string; base: string | null; lang: string; build: Command[]; test: Command[]; provides: string[]; consumes: string[] }>;
  interfaces: Record<string, { protocol: string; spec: string; provider: string | null }>;
}

/** A run's components by name: repository, working copy root, and the base commit the run started from. */
export type RunComponents = Record<string, { repo: string; root: string; base: string }>;

/**
 * What a check ran against (§10.3 `subject`): the files of the working copy
 * by path and content digest. Evidence is bound to it: an action that would
 * apply a file with other bytes than the ones tested is refused (G01).
 */
export interface CheckSubject {
  files: Record<string, string>;
}

/** An output of a check, kept as an artifact of the run and listed in its evidence (§10.3). */
export interface CheckLog {
  /** e.g. `test_log`, `review`, `diff`. */
  kind: string;
  /** e.g. `before` / `after` for red-then-green, a suite's name for a suite. */
  phase?: string;
  /** e.g. `pass` / `fail`. */
  result?: string;
  content: string;
  mediaType?: string;
}

export interface CheckResult {
  passed: boolean;
  detail?: Value;
  cost?: Cost;
  subject?: CheckSubject;
  /** Who checked and where, e.g. `{ kind: "runtime", handler: "…@0.2", sandbox: "mxc:process" }`. */
  producer?: Value;
  logs?: CheckLog[];
}

export interface VerifierAdapter {
  /** A check that costs something (a model review) is reserved first, like any model call (§8.6). */
  upperBound?(req: VerifyRequest): Promise<Cost | undefined>;
  check(req: VerifyRequest): Promise<CheckResult>;
}

/** How a run touches the outside world (design doc 9 §5.2): recorded in its manifest. */
export type RunMode = "design" | "read_only" | "live";

/** One declared read (design doc 9 §5.1): the query and the row's fields with their classes come from the program. */
export interface ReadRequest {
  environment: string;
  read: string;
  /** The component whose data it reads. */
  from: string;
  query: { sql: string } | { logs: Value };
  params: Record<string, Value>;
  maxRows: number;
  /** Every field of the row type and its data class. */
  fields: Record<string, DataClass>;
  /** The highest class the caller may receive; fields above it come back masked. */
  maxClass: DataClass;
  commandId: string;
}

/**
 * The read broker (doc 9 §5.1). Its result is
 * `{ rows, masked, as_of, truncated, row_count }`; rows hold only the
 * declared fields, masked ones as `{ $masked: class }`.
 */
export interface ReadBroker {
  describe(): { id: string; digest: string };
  query(req: ReadRequest): Promise<Outcome>;
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

/** A file an action will apply, as its adapter's `prepare` read it. */
export interface PreparedFile {
  path: string;
  content: string;
  mediaType?: string;
}

/** A frozen file of a prepared action: stored at prepare, sent from the store at execute (§8.8). */
export interface ActionArtifact {
  path: string;
  ref: string;
  digest: string;
  content: Uint8Array;
}

export interface PreparedAction {
  effect: string;
  params: Value;
  actionDigest: string;
  operationKey: string;
  /** The files the action applies, exactly as they were frozen at prepare. */
  artifacts?: ActionArtifact[];
}

export interface AuthorizationContext {
  authorizationId: string;
  decidedBy: string;
}

/** What a program binds an effect to: for `git.*`, the repositories of its `git.pr(…)` capabilities. */
export interface Binding {
  repos: string[];
}

/** Tool adapter contract (§16.1). Silence, a timeout or an HTTP 500 is `unknown`, never `notApplied`. */
export interface ToolAdapter {
  describe(): ToolContract;
  /** Whether this adapter can serve the program's binding; asked before a run starts. */
  validateBinding?(binding: Binding): Promise<{ supported: true } | { unsupported: string }>;
  /**
   * Checks the parameters and reads what the action will apply. Files it
   * returns are frozen into the artifact store and the action digest (§8.8),
   * so `execute` sends those bytes, whatever happens to the working copy.
   */
  prepare(params: Value): Promise<{ prepared: true; artifacts?: PreparedFile[] } | { rejected: string }>;
  execute(action: PreparedAction, auth: AuthorizationContext, operationKey: string): Promise<{ confirmed: Value } | { rejected: string } | { unknown: string }>;
  reconcile(operationKey: string): Promise<{ applied: Value } | { notApplied: string } | { unknown: string }>;
  /** Stops an operation if it has not taken effect: Cancelled with proof, or TooLate with its receipt. */
  cancel?(operationKey: string): Promise<{ cancelled: string } | { tooLate: Value } | { unknown: string }>;
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
  /** How often a running tool call checks whether its run was cancelled, to stop the sandbox (§16.1 Stop). Default 1000 ms. */
  stopPollMs?: number;
}

export interface Adapters {
  agents: AgentAdapter;
  loop?: LoopAdapters;
  model: ModelAdapter;
  verifier: VerifierAdapter;
  reads: ReadAdapter;
  /** External effects by name, e.g. `git.open_pr`. */
  tools: Record<string, ToolAdapter>;
  /** Working copies of a system model's components (design doc 9 §12, B3); needed by a run that works on components. */
  workspace?: WorkspaceAdapter;
  /** Declared reads of an environment (design doc 9 §5.1, B6), for `read_only` and `live` runs. */
  broker?: ReadBroker;
  /** Sample rows answering declared reads in `design` runs (B6). */
  samples?: ReadBroker;
  clock: Clock;
  random(): number;
}
