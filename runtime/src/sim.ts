// Simulated adapters for Gate 2 (Doc 4 §21.2: journal, state machine and
// supervision against simulated adapters). Each one records its calls, so a
// test can assert what reached the "outside world", and can be scripted to
// fail, hang, or lose its response at a chosen moment.

import type { RetryClass } from "@mandate/compiler";
import type {
  Adapters,
  AgentAdapter,
  AuthorizationContext,
  ChatModel,
  CheckResult,
  CheckSubject,
  Clock,
  Cost,
  DelegateRequest,
  InferRequest,
  ModelAdapter,
  Outcome,
  PreparedAction,
  PreparedFile,
  ReadAdapter,
  ToolAdapter,
  ToolContract,
  TurnBound,
  TurnRequest,
  VerifierAdapter,
  VerifyRequest,
} from "./adapters.js";
import type { Enforceable, ExecRequest, ExecResult, MxcPolicy, SandboxHost } from "./sandbox.js";
import { sha256Of } from "./artifacts.js";
import { inside, WRITE_SCRIPT } from "./tools.js";
import type { WorkspaceAdapter, WorkspaceComponent } from "./workspace.js";
import { digest, isObj, type Value } from "./values.js";

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
  /** Remote agents whose simulated servers deduplicate messages by id. */
  readonly idempotentRemotes = new Set<string>();
  constructor(private readonly scripts: Record<string, Script<DelegateRequest>> = {}) {}

  remoteProfile(agent: string): { idempotentMessages: boolean } {
    return { idempotentMessages: this.idempotentRemotes.has(agent) };
  }

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

/** One scripted model turn: content blocks, or a whole outcome. */
export type SimTurn = Value[] | Outcome;

/**
 * A scripted chat model for agent loops. `script(req, n)` answers the n-th
 * turn (from 1). A turn's bound is its input, estimated at four characters a
 * token, plus `maxOutputTokens`, at `microsPerToken`; each turn reports
 * `tokensPerTurn` tokens and their price.
 */
export class SimChat implements ChatModel {
  readonly calls: TurnRequest[] = [];
  readonly bounds: TurnRequest[] = [];

  constructor(
    private script: (req: TurnRequest, n: number) => SimTurn | Promise<SimTurn>,
    readonly o: { maxOutputTokens?: number; maxInputTokens?: number; microsPerToken?: number; tokensPerTurn?: number } = {},
  ) {}

  async turnBound(req: TurnRequest): Promise<TurnBound> {
    this.bounds.push(req);
    const inputTokens = Math.ceil(JSON.stringify([req.system, req.tools, req.messages]).length / 4);
    const tokens = inputTokens + (this.o.maxOutputTokens ?? 1000);
    const per = this.o.microsPerToken ?? 1;
    return { cost: { tokens, steps: 1, spend: { micros: tokens * per, currency: "USD" } }, inputTokens, maxInputTokens: this.o.maxInputTokens ?? 100_000 };
  }

  async turn(req: TurnRequest): Promise<Outcome> {
    this.calls.push(req);
    const r = await this.script(req, this.calls.length);
    if (!Array.isArray(r)) return r;
    const tokens = this.o.tokensPerTurn ?? 100;
    const stop = r.some((b) => isObj(b) && b["type"] === "tool_use") ? "tool_use" : "end_turn";
    return { ok: { content: r, stop_reason: stop }, cost: { tokens, steps: 1, spend: { micros: tokens * (this.o.microsPerToken ?? 1), currency: "USD" } } };
  }
}

/** A tool_use block, as a model turn would contain it. */
export function toolUse(id: string, name: string, input: Value): Value {
  return { type: "tool_use", id, name, input };
}

/** A working copy for simulated checks and actions: file contents by path. */
export class SimWorkspace {
  readonly files = new Map<string, string>();
  constructor(files: Record<string, string> = {}) {
    for (const [p, c] of Object.entries(files)) this.files.set(p, c);
  }
  write(path: string, content: string): void {
    this.files.set(path, content);
  }
  snapshot(): CheckSubject {
    return { files: Object.fromEntries([...this.files.keys()].sort().map((p) => [p, sha256Of(this.files.get(p)!)])) };
  }
}

export class SimVerifier implements VerifierAdapter {
  readonly calls: VerifyRequest[] = [];
  /**
   * Results by criterion name or method; anything unlisted passes. With a
   * workspace, a test check (`test.*`) reports the files it ran against.
   */
  constructor(
    readonly results: Record<string, boolean> = {},
    readonly workspace?: SimWorkspace,
  ) {}

  async check(req: VerifyRequest): Promise<CheckResult> {
    this.calls.push(req);
    const r = this.results[req.criterion] ?? this.results[req.method] ?? true;
    const test = req.method.startsWith("test.");
    return {
      passed: r,
      detail: { method: req.method },
      producer: { kind: "verifier", handler: "sim-verifier" },
      ...(test ? { logs: [{ kind: "test_log", result: r ? "pass" : "fail", content: `sim: ${req.contract}.${req.criterion} ${r ? "passed" : "failed"}\n` }] } : {}),
      ...(this.workspace && test ? { subject: this.workspace.snapshot() } : {}),
    };
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

  /** Applied files by operation key, as `execute` received them from the artifact store. */
  readonly sent = new Map<string, Record<string, string>>();

  constructor(
    readonly name: string,
    readonly retryClass: RetryClass = "idempotent",
    /** With a workspace, `prepare` reads the files the draft names (`patch.files`, `tests.files`), as git.open_pr does. */
    readonly workspace?: SimWorkspace,
  ) {}

  /** Behaviors for the next execute calls, in order; afterwards it confirms. */
  then(...b: ToolBehavior[]): this {
    this.plan.push(...b);
    return this;
  }

  describe(): ToolContract {
    return { id: `sim/${this.name}`, digest: digest("request", { adapter: this.name, retry: this.retryClass }), retryClass: this.retryClass };
  }

  async prepare(params: Value): Promise<{ prepared: true; artifacts?: PreparedFile[] } | { rejected: string }> {
    this.prepares.push(params);
    if (!this.workspace) return { prepared: true };
    const artifacts: PreparedFile[] = [];
    for (const f of draftFiles(params)) {
      const content = this.workspace.files.get(f);
      if (content === undefined) return { rejected: `${f} does not exist in the working copy` };
      artifacts.push({ path: f, content });
    }
    return { prepared: true, artifacts };
  }

  async execute(action: PreparedAction, auth: AuthorizationContext, operationKey: string): Promise<{ confirmed: Value } | { rejected: string } | { unknown: string }> {
    this.executions.push({ operationKey, params: action.params, authorization: auth.authorizationId });
    if (action.artifacts) this.sent.set(operationKey, Object.fromEntries(action.artifacts.map((a) => [a.path, new TextDecoder().decode(a.content)])));
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

/** Everything MXC can enforce on a current Windows 11 or Linux host; tests take parts away. */
export const FULL_SANDBOX: Enforceable = {
  backends: ["process", "session"],
  modes: ["enforcement", "learning", "permissive"],
  filesystem: true,
  network: "host_allow_list",
  exec: "args_prefix",
  timeout: true,
  ui: true,
};

/** A program a simulated sandbox can run, e.g. `mvn`: it sees the request and the sandbox's file system. */
export type SimProgram = (req: ExecRequest, fs: SimFs, handle: string) => ExecResult | Promise<ExecResult>;

/** The file system one simulated sandbox sees: reads and writes go through its policy's path lists. */
export interface SimFs {
  read(path: string): string | undefined;
  write(path: string, content: string): boolean;
}

/**
 * A sandbox host that enforces what `can` says and records what it was asked
 * to create. `execute` runs against an in-memory file system and enforces
 * each sandbox's path lists the way MXC does: what the policy does not allow
 * fails inside the process (exit code 1, "Permission denied"). It understands
 * the processes the runtime's tools start (`cat`, `ls`, `grep`, the
 * `write_file` script); any other program must be scripted in `programs`.
 */
export class SimSandboxHost implements SandboxHost {
  readonly created: Array<{ handle: string; policy: MxcPolicy }> = [];
  readonly destroyed: string[] = [];
  readonly executions: Array<{ handle: string; req: ExecRequest; result: ExecResult }> = [];
  readonly stopped: string[] = [];
  /** What `stop` answers; a host that cannot kill a running process says `uncertain`. */
  stopResult: "stopped" | "uncertain" = "stopped";
  private readonly waiting = new Map<string, Array<() => void>>();
  /** The host's files, by absolute path. */
  readonly files = new Map<string, string>();
  readonly programs: Record<string, SimProgram> = {};
  probes = 0;

  constructor(readonly can: Enforceable = FULL_SANDBOX) {}

  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    const sbx = this.created.find((c) => c.handle === handle);
    const gone = !sbx || this.destroyed.includes(handle) || this.stopped.includes(handle);
    const result = gone ? fail(126, `no sandbox ${handle}`) : await this.run(sbx.policy, req, handle);
    this.executions.push({ handle, req, result });
    return result;
  }

  /** Kills what runs in the sandbox: a program waiting in `untilStopped` ends with exit code 137. */
  async stop(handle: string): Promise<"stopped" | "uncertain"> {
    this.stopped.push(handle);
    if (this.stopResult === "stopped") for (const wake of this.waiting.get(handle) ?? []) wake();
    this.waiting.delete(handle);
    return this.stopResult;
  }

  /** For a scripted program that runs until its sandbox is stopped, like a hung test run. */
  untilStopped(handle: string): Promise<ExecResult> {
    return new Promise((resolve) => {
      const list = this.waiting.get(handle) ?? [];
      list.push(() => resolve({ stdout: "", stderr: "Killed\n", exitCode: 137, timedOut: false, stopped: true }));
      this.waiting.set(handle, list);
    });
  }

  private async run(policy: MxcPolicy, req: ExecRequest, handle: string): Promise<ExecResult> {
    const readable = (p: string) => inside(p, [...policy.filesystem.readOnly, ...policy.filesystem.readWrite]);
    const writable = (p: string) => inside(p, policy.filesystem.readWrite);
    const fs: SimFs = {
      read: (p) => (readable(p) ? this.files.get(p) : undefined),
      write: (p, c) => {
        if (!writable(p)) return false;
        this.files.set(p, c);
        return true;
      },
    };
    const [cmd, ...args] = req.argv;
    const path = args[args.length - 1] ?? "";
    switch (cmd) {
      case "cat":
        if (!readable(path)) return fail(1, `cat: ${path}: Permission denied`);
        return this.files.has(path) ? ok(this.files.get(path)!) : fail(1, `cat: ${path}: No such file or directory`);
      case "ls": {
        if (!readable(path)) return fail(2, `ls: cannot open directory '${path}': Permission denied`);
        const below = [...this.files.keys()].filter((f) => f.startsWith(`${path}/`)).map((f) => f.slice(path.length + 1));
        if (!below.length) return fail(2, `ls: cannot access '${path}': No such file or directory`);
        return ok([...new Set(below.map((f) => (f.includes("/") ? `${f.split("/")[0]}/` : f)))].sort().join("\n") + "\n");
      }
      case "grep": {
        if (!readable(path)) return fail(2, `grep: ${path}: Permission denied`);
        const re = new RegExp(args[args.length - 2] ?? "");
        const hits = [...this.files.entries()]
          .filter(([f]) => f === path || f.startsWith(`${path}/`))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .flatMap(([f, text]) => text.split("\n").flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}:${line}`] : [])));
        return hits.length ? ok(hits.join("\n") + "\n") : { stdout: "", stderr: "", exitCode: 1, timedOut: false };
      }
      case "sh":
        if (args[1] === WRITE_SCRIPT) {
          const target = args[3] ?? "";
          return fs.write(target, req.stdin ?? "") ? ok("") : fail(1, `sh: 1: cannot create ${target}: Permission denied`);
        }
        return fail(126, "sh: only the write_file script is simulated");
    }
    const program = cmd ? this.programs[cmd] : undefined;
    return program ? program(req, fs, handle) : fail(127, `${cmd}: command not found`);
  }

  async probe(): Promise<Enforceable> {
    this.probes++;
    return this.can;
  }

  async create(policy: MxcPolicy): Promise<string> {
    const handle = `sbx-${this.created.length + 1}`;
    this.created.push({ handle, policy });
    return handle;
  }

  async destroy(handle: string): Promise<"destroyed"> {
    this.destroyed.push(handle);
    return "destroyed";
  }

  /** Sandboxes created and not destroyed yet. */
  open(): string[] {
    return this.created.map((c) => c.handle).filter((h) => !this.destroyed.includes(h));
  }
}

/**
 * A simulated workspace (B3): every component is "checked out" at a commit
 * named after it and the number of times it was prepared, so a test can make
 * a base move with `advance`.
 */
export class SimCheckouts implements WorkspaceAdapter {
  readonly prepared: WorkspaceComponent[][] = [];
  private readonly heads = new Map<string, number>();

  async prepare(components: WorkspaceComponent[]): Promise<Record<string, { base: string }>> {
    this.prepared.push(components);
    return Object.fromEntries(components.map((c) => [c.name, { base: `${c.name}-commit-${this.heads.get(c.name) ?? 1}` }]));
  }

  /** A new commit lands on the component's branch. */
  advance(component: string): void {
    this.heads.set(component, (this.heads.get(component) ?? 1) + 1);
  }
}

export interface Sim {
  adapters: Adapters;
  workspace: SimCheckouts;
  /** The simulated clock; unused when `simulate` was given another clock. */
  clock: SimClock;
  agents: SimAgents;
  model: SimModel;
  verifier: SimVerifier;
  reads: SimReads;
  tools: Record<string, SimTool>;
}

/** The wall clock, for runs whose timers a real scheduler (Temporal) keeps. */
export const wallClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export function simulate(o: { tools?: SimTool[]; agents?: SimAgents; model?: SimModel; verifier?: SimVerifier; reads?: SimReads; seed?: number; clock?: Clock } = {}): Sim {
  const clock = new SimClock();
  const workspace = new SimCheckouts();
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
  return { adapters: { agents, model, verifier, reads, tools, workspace, clock: o.clock ?? clock, random }, clock, agents, model, verifier, reads, tools, workspace };
}

/** The files a pull request draft names: `patch.files` and `tests.files`. */
function draftFiles(params: Value): string[] {
  const d = Array.isArray(params) ? params[0] : params;
  if (!isObj(d ?? null)) return [];
  const files = (k: string): string[] => {
    const part = (d as Record<string, Value>)[k];
    const list = isObj(part ?? null) ? (part as Record<string, Value>)["files"] : undefined;
    return Array.isArray(list) ? list.filter((f): f is string => typeof f === "string") : [];
  };
  return [...new Set([...files("patch"), ...files("tests")])].sort();
}

function ok(stdout: string): ExecResult {
  return { stdout, stderr: "", exitCode: 0, timedOut: false };
}

function fail(exitCode: number, stderr: string): ExecResult {
  return { stdout: "", stderr: stderr + "\n", exitCode, timedOut: false };
}
