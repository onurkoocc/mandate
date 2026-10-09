// The workflow interpreter (Doc 4 §8.1–§8.9).
//
// A workflow body is deterministic: everything nondeterministic (models,
// delegates, tools, people, time, randomness) is a command whose id is the
// IR path of the node that issued it, plus loop iterations and restart
// attempts. Before a command runs, the journal is asked whether it already
// has a result; if so, that result is used. So recovering from a crash, or
// replaying a finished run, is re-running the same body (§8.3).
//
// External effects go through prepare → authorize → commit (§8.8): the
// parameters are frozen into an action digest, an authorization is bound to
// that digest, and commit consumes it once and records the dispatch before
// the adapter is called.

import {
  calleePath,
  capsOf,
  DECISION_POLICIES,
  hashProgram,
  modelTiers,
  PROGRESS_DEFAULTS,
  requirementFor,
  STD_EFFECTS,
  STD_FNS,
  type Arg,
  type Budget,
  type CapVal,
  type ContractDef,
  type Def,
  type EffectDef,
  type Expr,
  type Json,
  type Pattern,
  type Program,
  type Stmt,
  type TypeExpr,
  type Verifier,
  type WorkflowDef,
} from "@mandate/compiler";
import type { ActionArtifact, Adapters, CheckSubject, Cost, Outcome, ToolAdapter } from "./adapters.js";
import type { ArtifactStore } from "./artifacts.js";
import { attestationProblem } from "./attestation.js";
import { EVIDENCE_FORMAT, type EvidenceRecord, type EvidenceSigner, type TrustedKeys } from "./evidence.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Faults } from "./faults.js";
import { runAgentLoop, type LoopTask } from "./loop.js";
import type { ActionRow, CommandRow, Journal } from "./journal.js";
import { Attention, Cancelled, Fault, Suspend, Violation } from "./signals.js";
import {
  digest,
  evidenceOf,
  isObj,
  money,
  plain,
  show,
  tag,
  tagOf,
  unwrap,
  verified,
  type Obj,
  type Value,
} from "./values.js";

/** What a command reserves when it is sent: a fixed bound, or one measured just before sending. */
type Reserve = Cost | Budget | undefined | (() => Promise<Cost | Budget | undefined>);

interface CommandOptions {
  /** The par block's shared state: a failed sibling stops this command before it is sent (fail_fast). */
  siblings?: Siblings | undefined;
  label?: string;
  /** The command whose reservation pays for this one: the steps of an agent loop are charged to their delegation. */
  within?: string;
  /** Called before a command that is not in the journal yet is sent; it may refuse it with a fault (a deadline). */
  guard?: () => void;
  /** The rate-limit buckets the command draws from (§8.6). */
  buckets?: string[];
  /**
   * The command must not be sent twice: found in flight after a crash, it is
   * not sent again, and the run stops for a person (a remote agent whose
   * server does not deduplicate messages, G12).
   */
  atMostOnce?: boolean;
}

/** How often one command may be throttled before the Throttled fault reaches the program. */
const MAX_THROTTLES = 20;

export type AuthorizePolicy = { by: "policy" } | { by: "human"; role: string; deadlineMs?: number };

export interface Policy {
  tenant: string;
  /** How each external effect is authorized (§8.8, approval tiers). Default: policy, or a human for irreversible effects. */
  authorize?: Record<string, AuthorizePolicy>;
  /** How long a policy authorization stays valid. */
  authorizationTtlMs?: number;
  /** The run's priority class in shared rate limits (§8.6): `high` for work a person waits for. Default `normal`. */
  priority?: "high" | "normal";
}

/** Replay reached a command whose result is not in the journal. */
export class ReplayEnd extends Error {
  constructor(
    readonly commandId: string,
    readonly reason: "no_result" | "payload_purged",
  ) {
    super(`replay stopped at ${commandId}: ${reason}`);
  }
}

class Return {
  constructor(readonly value: Value) {}
}

interface Scope {
  vars: Map<string, Value>;
  parent?: Scope;
}

/** Cancellation shared by the branches of one `par` block (fail_fast, §8.7). */
interface Siblings {
  failed: boolean;
  /** The fault that stopped the siblings: what the block fails with. */
  first?: Fault;
}

interface Ctx {
  scope: Scope;
  siblings?: Siblings;
  /** Path prefix for the contract or function being evaluated. */
  where: "workflow" | "contract";
}

export interface InterpOptions {
  journal: Journal;
  adapters: Adapters;
  program: Program;
  packageHash: string;
  runId: string;
  fence: number;
  policy: Policy;
  faults: Faults;
  /** Where an action's files and a check's outputs are kept (§16.1). */
  artifacts: ArtifactStore;
  /** Signs every evidence record (§10.3); `trusted` decides which signatures count. */
  signer: EvidenceSigner;
  trusted: TrustedKeys;
  /** Verifier keys whose check attestations count (P2-11). */
  verifiers?: TrustedKeys;
  /** Shared rate limits (§8.6); none when absent. */
  limiter?: RateLimiter;
  /** Replay reads the journal only and never calls an adapter (R13). */
  replay: boolean;
  /**
   * Who keeps a wait's timer (a restart's backoff, §8.7). Inline, this worker
   * sleeps. Durable, the run waits and its scheduler (Temporal) wakes it with
   * `tick` when the time comes, so no worker holds a lease while it waits.
   */
  durableTimers?: boolean;
}

const RESTARTABLE = new Set(["Timeout", "SkillFailed"]);

/** Faults a person may be asked about under escalate(human) (§8.7), and how often. */
const ESCALATABLE = new Set(["Timeout", "SkillFailed", "PolicyDenied", "Rejected"]);
const MAX_ESCALATIONS = 5;

/** The runtime itself, as the producer of the evidence it checks without a verifier (static criteria). */
const RUNTIME_HANDLER = "mandate-runtime@0.2";

export class Interpreter {
  private readonly defs: Record<string, Def>;

  constructor(private readonly o: InterpOptions) {
    this.defs = o.program.defs;
  }

  private def(name: string): Def | undefined {
    return Object.hasOwn(this.defs, name) ? this.defs[name] : undefined;
  }

  async runWorkflow(name: string, input: Obj): Promise<Value> {
    const wf = this.def(name);
    if (!wf || wf.kind !== "workflow") throw new Violation("unknown_workflow", `No workflow '${name}'.`);
    const vars = new Map<string, Value>();
    for (const p of wf.params) {
      if (!Object.hasOwn(input, p.name)) throw new Violation("missing_input", `Workflow ${name} needs input '${p.name}'.`);
      vars.set(p.name, input[p.name]!);
    }
    const ctx: Ctx = { scope: { vars }, where: "workflow" };
    let result: Value;
    try {
      result = await this.block(wf.body, ctx, `/defs/${name}/body`);
    } catch (e) {
      if (!(e instanceof Return)) throw e;
      result = e.value;
    }
    // `ensures e` (§4.6): the workflow's postcondition over its result. A run whose result breaks it does not succeed.
    if (wf.ensures) {
      const held = truthy(unwrap(await this.expr(wf.ensures, { scope: { vars: new Map([["result", result]]), parent: ctx.scope }, where: "workflow" }, `/defs/${name}/ensures`)));
      if (!held) throw new Fault("Rejected", [{ reason: "ensures", workflow: name }]);
    }
    return result;
  }

  workflowDef(name: string): WorkflowDef {
    return this.def(name) as WorkflowDef;
  }

  /**
   * Runs the workflow's `on budget_exceeded` handler for one episode: one
   * time the run's budget ran out (§8.6). Without a handler the default is
   * to pause for a person. Its waits are keyed by the episode (`@n`), so a
   * person is asked again each time the budget runs out.
   */
  async onBudgetExceeded(name: string, input: Obj, episode: number): Promise<Value> {
    const wf = this.workflowDef(name);
    const i = (wf.on ?? []).findIndex((h) => h.event === "budget_exceeded");
    if (i < 0) return this.wait(`/defs/${name}/on/budget_exceeded@${episode}`, "input", { pause: true });
    const vars = new Map<string, Value>(wf.params.map((p) => [p.name, input[p.name] ?? null]));
    return this.expr(wf.on![i]!.then, { scope: { vars }, where: "workflow" }, `/defs/${name}/on/${i}@${episode}/then`);
  }

  // ── statements ────────────────────────────────────────────────────────

  private async block(stmts: Stmt[], outer: Ctx, base: string): Promise<Value> {
    let ctx: Ctx = { ...outer, scope: { vars: new Map(), parent: outer.scope } };
    let last: Value = null;
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i]!;
      if (s.op === "on_error") continue;
      // `on error(…) => h` right after a statement handles that statement's errors (§8.7).
      const handlers: Array<{ s: Extract<Stmt, { op: "on_error" }>; path: string }> = [];
      for (let j = i + 1; j < stmts.length && stmts[j]!.op === "on_error"; j++) {
        handlers.push({ s: stmts[j] as Extract<Stmt, { op: "on_error" }>, path: `${base}/${j}` });
      }
      const path = `${base}/${i}`;
      try {
        const r = await this.stmt(s, ctx, path);
        last = r.value;
        if (r.bind) ctx = { ...ctx, scope: { vars: r.bind, parent: ctx.scope } };
      } catch (e) {
        if (!(e instanceof Fault)) throw e;
        const h = handlers.find((x) => matches(x.s.pattern, e.value()));
        if (!h) throw e;
        const binds = new Map<string, Value>();
        bind(h.s.pattern, e.value(), binds);
        last = await this.expr(h.s.then, { ...ctx, scope: { vars: binds, parent: ctx.scope } }, `${h.path}/then`);
        if (s.op === "let") ctx = { ...ctx, scope: { vars: new Map([[s.name, last]]), parent: ctx.scope } };
      }
    }
    return last;
  }

  private async stmt(s: Stmt, ctx: Ctx, path: string): Promise<{ value: Value; bind?: Map<string, Value> }> {
    switch (s.op) {
      case "let": {
        const v = await this.expr(s.value, ctx, `${path}/value`);
        return { value: v, bind: new Map([[s.name, v]]) };
      }
      case "expr":
        return { value: await this.expr(s.value, ctx, `${path}/value`) };
      case "return":
        throw new Return(s.value ? await this.expr(s.value, ctx, `${path}/value`) : null);
      case "if": {
        const c = await this.expr(s.cond, ctx, `${path}/cond`);
        if (truthy(c)) return { value: await this.block(s.then, ctx, `${path}/then`) };
        if (s.else) return { value: await this.block(s.else, ctx, `${path}/else`) };
        return { value: null };
      }
      case "loop": {
        const max = s.max_iter ?? 10_000;
        let last: Value = null;
        for (let i = 0; i < max; i++) {
          last = await this.block(s.body, ctx, `${path}/body@${i}`);
          if (s.until && truthy(await this.expr(s.until, ctx, `${path}/until@${i}`))) break;
        }
        return { value: last };
      }
      case "par":
        return this.par(s, ctx, path);
      case "on_error":
        return { value: null };
      case "run":
        throw new Violation("unsupported", "`run` belongs to tests, not workflows.");
    }
  }

  /**
   * Branches start together and see the scope before the block. Results are
   * bound by branch name, never by completion order (R11). Under fail_fast
   * (the 0.1 default) the first failure stops siblings before their next
   * dispatch, but the block only ends when every branch has settled, so an
   * external request already in flight is followed to its result (R10).
   */
  private async par(s: Extract<Stmt, { op: "par" }>, ctx: Ctx, path: string): Promise<{ value: Value; bind: Map<string, Value> }> {
    const strategy = s.supervise?.name ?? "fail_fast";
    const rounds = strategy === "restart_all" ? 2 : 1;
    let lastError: unknown;
    for (let round = 0; round < rounds; round++) {
      const siblings: Siblings = { failed: false };
      const names = Object.keys(s.branches).sort();
      const settled = await Promise.allSettled(
        names.map(async (bn) => {
          try {
            const p = round ? `${path}/branches/${bn}#all${round}` : `${path}/branches/${bn}`;
            return await this.expr(s.branches[bn]!, { ...ctx, siblings }, p);
          } catch (e) {
            if (e instanceof Fault) {
              siblings.first ??= e;
              siblings.failed = true;
            }
            throw e;
          }
        }),
      );
      const failures = settled.flatMap((r) => (r.status === "rejected" ? [r.reason as unknown] : []));
      if (!failures.length) {
        const out = new Map<string, Value>();
        names.forEach((bn, i) => out.set(bn, (settled[i] as PromiseFulfilledResult<Value>).value));
        return { value: null, bind: out };
      }
      // Anything other than a recoverable fault (attention, suspension, cancellation, a crash) wins.
      const hard = failures.find((f) => !(f instanceof Fault) && !(f instanceof SiblingStopped));
      if (hard) throw hard;
      lastError = siblings.first ?? failures.find((f) => f instanceof Fault) ?? failures[0];
    }
    throw lastError;
  }

  // ── expressions ───────────────────────────────────────────────────────

  async expr(e: Expr, ctx: Ctx, path: string): Promise<Value> {
    switch (e.op) {
      case "int":
        return e.value;
      case "dec":
        return Number(e.value);
      case "text":
        return e.value;
      case "bool":
        return e.value;
      case "money":
        return money(e.micros, e.currency);
      case "duration":
        return e.ms;
      case "list":
      case "set": {
        const out: Value[] = [];
        for (let i = 0; i < e.items.length; i++) out.push(await this.expr(e.items[i]!, ctx, `${path}/items/${i}`));
        return out;
      }
      case "template": {
        let s = "";
        for (let i = 0; i < e.parts.length; i++) {
          const p = e.parts[i]!;
          s += "text" in p ? p.text : show(await this.expr(p.expr, ctx, `${path}/parts/${i}/expr`));
        }
        return s;
      }
      case "prompt": {
        // Instruction text and quoted data stay apart for the model adapter (§5.4).
        const parts: Value[] = [];
        for (let i = 0; i < e.parts.length; i++) {
          const p = e.parts[i]!;
          if ("text" in p) parts.push({ text: p.text });
          else if (p.expr.op === "call" && calleePath(p.expr.callee) === "quote") {
            parts.push({ data: await this.expr(p.expr.args[0]!.value, ctx, `${path}/parts/${i}/expr/args/0/value`) });
          } else parts.push({ text: show(await this.expr(p.expr, ctx, `${path}/parts/${i}/expr`)) });
        }
        return { $prompt: parts };
      }
      case "var":
        return this.variable(e.name, ctx);
      case "field": {
        const p = calleePath(e);
        if (p && this.isModulePath(e, ctx)) throw new Violation("unsupported", `${p} is not a value.`);
        const base = unwrap(await this.expr(e.of, ctx, `${path}/of`));
        if (isObj(base) && Object.hasOwn(base, e.name)) return base[e.name]!;
        if (Array.isArray(base) && e.name === "length") return base.length;
        throw new Violation("no_field", `Value has no field '${e.name}' at ${path}.`);
      }
      case "call":
        return this.call(e, ctx, path);
      case "unary": {
        const v = unwrap(await this.expr(e.of, ctx, `${path}/of`));
        return e.uop === "not" ? !truthy(v) : -Number(v);
      }
      case "binary":
        return this.binary(e, ctx, path);
      case "range":
        return { $range: [await this.expr(e.from, ctx, `${path}/from`), await this.expr(e.to, ctx, `${path}/to`)] };
      case "record": {
        const out: Obj = {};
        for (const k of Object.keys(e.fields).sort()) out[k] = await this.expr(e.fields[k]!, ctx, `${path}/fields/${k}`);
        return out;
      }
      case "infer":
        return this.infer(e, ctx, path);
      case "delegate":
        return this.delegate(e, ctx, path);
      case "verify":
        return this.verify(e, ctx, path);
      case "effect":
        return this.effect(e, ctx, path);
      case "escalate": {
        const message = e.to.op === "call" && calleePath(e.to.callee) === "human" && e.to.args[0] ? await this.expr(e.to.args[0].value, ctx, `${path}/to/args/0/value`) : await this.expr(e.to, ctx, `${path}/to`);
        return this.wait(path, "input", { escalation: message });
      }
      case "pause":
        if (e.then) return this.expr(e.then, ctx, `${path}/then`);
        return this.wait(path, "input", { pause: true });
      case "switch":
        return this.switch(e, ctx, path);
      case "try": {
        const v = await this.expr(e.of, ctx, `${path}/of`);
        const t = tagOf(unwrap(v));
        if (t?.tag === "Err") throw new Fault(String(tagOf(t.args[0] ?? null)?.tag ?? "Rejected"), t.args);
        if (t?.tag === "Ok") return t.args[0] ?? null;
        return v;
      }
      case "block":
        return this.block(e.body, ctx, `${path}/body`);
      case "spawn":
      case "await":
        throw new Violation("unsupported", `${e.op} is not available in 0.1 (E0711).`);
    }
  }

  private variable(name: string, ctx: Ctx): Value {
    for (let s: Scope | undefined = ctx.scope; s; s = s.parent) {
      if (s.vars.has(name)) return s.vars.get(name)!;
    }
    const d = this.def(name);
    if (d?.kind === "const") return this.constant(name, d.value);
    if (d?.kind === "capability") return { $capability: name };
    if (d?.kind === "type") return tag(name);
    // A bare variant name such as `Uncertain` or `Refund`.
    if (/^[A-Z]/.test(name)) return tag(name);
    throw new Violation("unbound", `Unbound name '${name}'.`);
  }

  private readonly consts = new Map<string, Value>();

  private constant(name: string, e: Expr): Value {
    if (this.consts.has(name)) return this.consts.get(name)!;
    // Constants are pure: literals, records, and calls such as DecisionModel(…) kept as descriptors.
    const v = constValue(e);
    this.consts.set(name, v);
    return v;
  }

  private isModulePath(e: Expr, ctx: Ctx): boolean {
    let cur = e;
    while (cur.op === "field") cur = cur.of;
    if (cur.op !== "var") return false;
    for (let s: Scope | undefined = ctx.scope; s; s = s.parent) if (s.vars.has(cur.name)) return false;
    return !this.def(cur.name);
  }

  private async args(args: Arg[], ctx: Ctx, path: string): Promise<{ pos: Value[]; named: Record<string, Value> }> {
    const pos: Value[] = [];
    const named: Record<string, Value> = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      const v = await this.expr(a.value, ctx, `${path}/args/${i}/value`);
      if (a.name === undefined) pos.push(v);
      else named[a.name] = v;
    }
    return { pos, named };
  }

  private async binary(e: Extract<Expr, { op: "binary" }>, ctx: Ctx, path: string): Promise<Value> {
    if (e.bop === "and") return truthy(unwrap(await this.expr(e.left, ctx, `${path}/left`))) && truthy(unwrap(await this.expr(e.right, ctx, `${path}/right`)));
    if (e.bop === "or") return truthy(unwrap(await this.expr(e.left, ctx, `${path}/left`))) || truthy(unwrap(await this.expr(e.right, ctx, `${path}/right`)));
    const l = plain(await this.expr(e.left, ctx, `${path}/left`));
    const r = plain(await this.expr(e.right, ctx, `${path}/right`));
    switch (e.bop) {
      case "==":
        return JSON.stringify(l) === JSON.stringify(r);
      case "!=":
        return JSON.stringify(l) !== JSON.stringify(r);
      case "<":
        return Number(l) < Number(r);
      case "<=":
        return Number(l) <= Number(r);
      case ">":
        return Number(l) > Number(r);
      case ">=":
        return Number(l) >= Number(r);
      case "in":
        if (isObj(r) && Array.isArray(r["$range"])) {
          const [lo, hi] = r["$range"] as number[];
          return Number(l) >= Number(lo) && Number(l) <= Number(hi);
        }
        return Array.isArray(r) && r.some((x) => JSON.stringify(x) === JSON.stringify(l));
      case "subseteq":
        return Array.isArray(l) && Array.isArray(r) && l.every((x) => r.some((y) => JSON.stringify(x) === JSON.stringify(y)));
      case "+":
        if (isObj(l) && "$money" in l && isObj(r) && "$money" in r) {
          if (l["$currency"] !== r["$currency"]) throw new Violation("currency_mismatch", "Money in different currencies is never converted implicitly.");
          return money(Number(l["$money"]) + Number(r["$money"]), String(l["$currency"]));
        }
        return typeof l === "string" || typeof r === "string" ? show(l) + show(r) : Number(l) + Number(r);
      case "-":
        return Number(l) - Number(r);
      case "*":
        return Number(l) * Number(r);
      case "/":
        return Number(l) / Number(r);
    }
  }

  private async switch(e: Extract<Expr, { op: "switch" }>, ctx: Ctx, path: string): Promise<Value> {
    const v = unwrap(await this.expr(e.on, ctx, `${path}/on`));
    for (let i = 0; i < e.cases.length; i++) {
      const c = e.cases[i]!;
      if (!matches(c.pattern, v)) continue;
      const binds = new Map<string, Value>();
      bind(c.pattern, v, binds);
      return this.expr(c.then, { ...ctx, scope: { vars: binds, parent: ctx.scope } }, `${path}/cases/${i}/then`);
    }
    throw new Violation("no_case", `No switch arm matched ${show(v)} at ${path}.`);
  }

  // ── calls ─────────────────────────────────────────────────────────────

  private async call(e: Extract<Expr, { op: "call" }>, ctx: Ctx, path: string): Promise<Value> {
    const p = calleePath(e.callee);
    const local = p && !p.includes(".") ? this.def(p) : undefined;
    if (local?.kind === "fn") {
      const { pos } = await this.args(e.args, ctx, path);
      const vars = new Map<string, Value>();
      local.params.forEach((param, i) => vars.set(param.name, pos[i] ?? null));
      try {
        return await this.block(local.body, { ...ctx, scope: { vars } }, `${path}>${p}/body`);
      } catch (r) {
        if (r instanceof Return) return r.value;
        throw r;
      }
    }
    if (p === "quote" || p === "peek") return this.expr(e.args[0]!.value, ctx, `${path}/args/0/value`);
    if (p === "len") {
      const v = unwrap(await this.expr(e.args[0]!.value, ctx, `${path}/args/0/value`));
      return Array.isArray(v) ? v.length : typeof v === "string" ? v.length : 0;
    }
    if (p && DECISION_POLICIES.has(p)) {
      const { pos, named } = await this.args(e.args, ctx, path);
      return decide(p, unwrap(pos[0] ?? null), named);
    }
    if (p === "human.ask") {
      const { pos } = await this.args(e.args, ctx, path);
      return this.wait(path, "input", { question: pos[0] ?? null });
    }
    if (p === "time.now") return this.command(path, "time", {}, undefined, async () => ({ ok: this.o.adapters.clock.now() }));
    if (p && STD_FNS[p]) {
      const { pos, named } = await this.args(e.args, ctx, path);
      return this.command(path, "read", { call: p, args: pos, named }, undefined, () => this.o.adapters.reads.call(p, pos, named));
    }
    if (e.callee.op === "field" && e.callee.name === "narrow") return { $capability: path };
    throw new Violation("unsupported_call", `The runtime cannot call ${p ?? "this expression"} at ${path}.`);
  }

  // ── commands ──────────────────────────────────────────────────────────

  /**
   * Runs one journaled command: replayed if the journal has its result,
   * otherwise dispatched (with its upper-bound cost reserved), called, and
   * recorded. Fault-injection points sit between the steps.
   */
  /**
   * `within` names the command whose reservation pays for this one: the steps
   * of an agent loop are charged to their delegation (Journal.dispatch).
   */
  private async command(id: string, kind: string, request: Value, reserve: Reserve, call: () => Promise<Outcome>, opts: CommandOptions = {}): Promise<Value> {
    const { siblings, label, within, guard } = opts;
    const requestDigest = digest("request", { kind, request });
    const { journal, runId, fence, faults } = this.o;
    if (this.o.replay) return replayed(await journal.command(runId, id), id);
    // The throttle wait this worker already sat through, so it is not waited twice.
    let waited = -1;
    for (;;) {
      if (siblings?.failed) throw new SiblingStopped();
      const earlier = await journal.command(runId, id);
      const settled = earlier && (earlier.state === "succeeded" || earlier.state === "failed");
      let bound: Cost | Budget | undefined;
      if (!settled) {
        if (opts.atMostOnce && earlier?.state === "dispatched") {
          throw new Attention({ command: id, reason: "delivery_unknown", detail: "this task was sent to a remote agent whose server does not deduplicate messages; sending it again could run it twice" });
        }
        // A command throttled before waits out its retry_after first (§8.6); the wait is not an attempt.
        if (earlier?.state === "throttled" && earlier.throttled !== waited) await this.pause(`${id}/throttled@${earlier.throttled}`, retryAfter(earlier.error), "throttled");
        // A guard (a deadline) applies only to what is still to be sent, and measuring the bound may call out
        // (a token count): neither happens for a command the journal already has a result for.
        guard?.();
        bound = typeof reserve === "function" ? await reserve() : reserve;
      }
      const prior = await journal.dispatch(runId, fence, { id, kind, digest: requestDigest, ...(label ? { label } : {}) }, bound, within);
      if (prior) return replayed(prior, id);
      faults.check("after_dispatch", { id, kind });
      const limited = opts.buckets?.length && this.o.limiter ? await this.o.limiter.take(opts.buckets, this.o.policy.priority ?? "normal") : undefined;
      const outcome = limited ?? (await call());
      faults.check("before_record", { id, kind });
      if ("error" in outcome && outcome.error.tag === "Throttled" && !queueFull(outcome.error)) {
        // Not now, says a rate limit or the provider: release the reservation, wait, and send the same command again.
        const n = await journal.throttle(runId, fence, id, outcome.error as unknown as Value);
        if (n <= MAX_THROTTLES) {
          await this.pause(`${id}/throttled@${n}`, retryAfter(outcome.error as unknown as Value), "throttled");
          waited = n;
          continue;
        }
      }
      await journal.complete(runId, fence, id, outcome, within);
      faults.check("after_record", { id, kind });
      if ("ok" in outcome) return outcome.ok;
      throw new Fault(outcome.error.tag, outcome.error.args ?? []);
    }
  }

  /** A wait for a person. The journal holds the answer once it arrives. */
  private async wait(id: string, kind: "input" | "decision", request: Value): Promise<Value> {
    const { journal, runId, fence } = this.o;
    const row = this.o.replay ? await journal.command(runId, id) : await journal.openWait(runId, fence, { id, kind, digest: digest("request", { kind, request }) }, request);
    if (!row || row.state === "waiting") {
      if (this.o.replay) throw new ReplayEnd(id, "no_result");
      // The request as first recorded: a resumed worker must not move its deadline.
      throw new Suspend({ kind, command: id, request: row?.result ?? request });
    }
    return replayed(row, id);
  }

  /**
   * Waits `ms` before going on (§8.7 backoff, §8.6 Throttled). Inline, the
   * worker sleeps. With durable timers the start is journaled, so the end is
   * fixed; until it comes the run waits (`kind: "timer"`, with the end as its
   * deadline), and its scheduler resumes it then. Replay never waits.
   */
  private async pause(id: string, ms: number, reason: string): Promise<void> {
    if (this.o.replay || ms <= 0) return;
    if (!this.o.durableTimers) return this.o.adapters.clock.sleep(ms);
    const started = Number(await this.command(id, "time", {}, undefined, async () => ({ ok: this.o.adapters.clock.now() })));
    const until = started + ms;
    if (this.o.adapters.clock.now() >= until) return;
    throw new Suspend({ kind: "timer", command: id, request: { reason, until, deadline: until } });
  }

  private async random(id: string): Promise<number> {
    return Number(await this.command(id, "random", {}, undefined, async () => ({ ok: this.o.adapters.random() })));
  }

  private async infer(e: Extract<Expr, { op: "infer" }>, ctx: Ctx, path: string): Promise<Value> {
    const input = await this.expr(e.from, ctx, `${path}/from`);
    const using = e.using ? await this.expr(e.using, ctx, `${path}/using`) : undefined;
    const tier = this.tierFor(e.using, path);
    const req = { type: e.type, input, commandId: path, ...(using !== undefined ? { using } : {}), ...(tier ? { tier } : {}) };
    return this.command(path, "infer", { type: e.type as unknown as Value, input, using: using ?? null }, async () => this.o.adapters.model.upperBound(req), () => this.o.adapters.model.infer(req), { siblings: ctx.siblings, label: "infer", ...this.limits("infer", tier) });
  }

  /**
   * The model tier a model call runs under: the capability named by `using`,
   * else the only tier among the enclosing definition's model capabilities,
   * else the only tier the program names. The lock file maps it to a model.
   */
  private tierFor(using: Expr | undefined, path: string): string | undefined {
    const tierOf = (e: Expr): string | undefined => this.caps(e).find((c) => c.tier)?.tier;
    if (using) return tierOf(using);
    const def = this.def(path.split("/")[2]!);
    const caps = def?.kind === "workflow" || def?.kind === "agent" ? def.caps : [];
    const own = [...new Set(caps.map(tierOf).filter((t): t is string => !!t))];
    if (own.length === 1) return own[0];
    const all = [...modelTiers(this.o.program)];
    return all.length === 1 ? all[0] : undefined;
  }

  /**
   * `delegate A.s(args)` under its supervision strategy (§8.7):
   *
   *   restart(max, backoff)   Timeout or SkillFailed: the same operation again, as a new attempt, after a
   *                           backoff with journaled jitter; at most `max` times
   *   escalate(human)         Timeout, SkillFailed, PolicyDenied or Rejected: a person decides, answering
   *                           "retry" (a new attempt) or anything else (the fault goes on); at most 5 times
   *   degrade(to: F)          Timeout or SkillFailed: once, F does the same skill with the same arguments; F does
   *                           the same job with no more authority (E0715)
   *
   * BudgetExceeded, Throttled and UnknownOutcome are never handled here: the run's budget handler, the rate
   * limiter and reconciliation own them.
   */
  private async delegate(e: Extract<Expr, { op: "delegate" }>, ctx: Ctx, path: string): Promise<Value> {
    const { pos } = await this.args(e.args, ctx, path);
    const sup = e.supervise;
    const arg = (name: string): Expr | undefined => sup?.args?.find((a) => a.name === name)?.value;
    const max = sup?.name === "restart" ? Number(constValue(arg("max") ?? { op: "int", value: 1 })) : 0;
    const backoff = sup?.name === "restart" ? Number(constValue(arg("backoff") ?? { op: "duration", ms: 0 })) : 0;
    const to = arg("to");
    const fallback = sup?.name === "degrade" && to?.op === "var" ? to.name : undefined;
    // `timeout d` (§8.7, §9.1): each attempt must finish within d of its start. The start is journaled, so a resumed
    // worker keeps the deadline; a step not sent by then is refused, and a result that comes later is discarded.
    const timeoutMs = e.timeout ? Number(unwrap(await this.expr(e.timeout, ctx, `${path}/timeout`))) : undefined;
    for (let attempt = 0; ; attempt++) {
      const id = attempt ? `${path}#${attempt}` : path;
      try {
        return await this.attempt(e.agent, e, pos, ctx, id, attempt, timeoutMs);
      } catch (f) {
        if (!(f instanceof Fault)) throw f;
        if (sup?.name === "restart" && RESTARTABLE.has(f.tag) && attempt < max) {
          // restart reruns the same operation with the same input; never on UnknownOutcome (§8.7).
          // Exponential backoff with jitter; the jitter is journaled so replay waits the same.
          const jitter = await this.random(`${id}/jitter`);
          await this.pause(`${id}/backoff`, Math.round(backoff * 2 ** attempt * (0.5 + jitter)), "restart_backoff");
          continue;
        }
        if (fallback && RESTARTABLE.has(f.tag)) {
          // degrade (§8.7): the fallback, once, with the same arguments; its own fault is the delegation's.
          return await this.attempt(fallback, e, pos, ctx, `${path}~${fallback}`, 0, timeoutMs);
        }
        if (sup?.name === "escalate" && ESCALATABLE.has(f.tag) && attempt < MAX_ESCALATIONS) {
          const role = arg("role");
          const answer = await this.wait(`${id}/escalate`, "input", {
            escalation: { delegate: `${e.agent}.${e.skill}`, fault: f.value(), attempt },
            question: `${e.agent}.${e.skill} failed with ${show(f.value())}. Answer "retry" to run it again, or anything else to let the failure stand.`,
            options: ["retry", "fail"],
            ...(role?.op === "text" ? { role: role.value } : {}),
          });
          if (String(unwrap(answer)).trim().toLowerCase() === "retry") continue;
        }
        throw f;
      }
    }
  }

  /** One attempt of a delegation, by `agentName` (the called agent, or a degrade fallback), as command `id`. */
  private async attempt(agentName: string, e: Extract<Expr, { op: "delegate" }>, pos: Value[], ctx: Ctx, id: string, attempt: number, timeoutMs: number | undefined): Promise<Value> {
    const agent = this.def(agentName);
    if (!agent || agent.kind !== "agent") throw new Violation("unknown_agent", `No agent '${agentName}'.`);
    const skill = Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill]! : undefined;
    if (!skill) throw new Violation("unknown_skill", `No skill '${agentName}.${e.skill}'.`);
    const granted = this.grants(agentName, e.caps ?? [], id);
    const caps = granted.map((c) => (c.scope ? { ctor: c.ctor, scope: c.scope } : { ctor: c.ctor }));
    const budget = e.budget ?? skill.budget ?? agent.budget;
    const sandbox = agent.remote ? undefined : requirementFor({ agent: agentName, def: this.defHash(agentName) }, granted, budget?.time?.ms ?? null);
    const request = { agent: agentName, skill: e.skill, args: pos, caps: caps as unknown as Value, isolated: !!e.isolated };
    const loop = this.o.adapters.loop;
    const deadline = timeoutMs === undefined ? undefined : Number(await this.command(`${id}/started`, "time", {}, undefined, async () => ({ ok: this.o.adapters.clock.now() }))) + timeoutMs;
    const timedOut = (late?: true): Fault => new Fault("Timeout", [{ delegate: `${agentName}.${e.skill}`, after_ms: timeoutMs ?? 0, ...(late ? { late_result: true } : {}) }]);
    const overdue = deadline === undefined ? undefined : (): void => {
      if (this.o.adapters.clock.now() >= deadline) throw timedOut();
    };
    const label = `${agentName}.${e.skill}`;
    if (loop && sandbox && !skill.body) {
      // A bodiless skill runs as an agent loop in this process (§8.2, K7). The delegation reserves the
      // agent's budget less what its finished steps already spent, so a resumed loop is not charged twice.
      const tiers = [...new Set(granted.filter((c) => c.ctor === "model.infer" && c.tier).map((c) => c.tier!))];
      const task: LoopTask = {
        id,
        agent: agentName,
        skill: e.skill,
        ...(agent.role !== undefined ? { role: agent.role } : {}),
        params: skill.params,
        args: pos,
        returns: unwrapInferred(skill.returns),
        grants: granted,
        tier: tiers[0] ?? "",
        strategy: agent.loop ?? "react",
        progress: { ...PROGRESS_DEFAULTS, ...agent.progress },
        ...(budget?.steps !== undefined ? { maxSteps: budget.steps } : {}),
        sandbox,
        program: this.o.program,
      };
      return this.command(
        id,
        "delegate",
        request,
        async () => subtractCost(budget, await this.o.journal.childCost(this.o.runId, id)),
        async () => {
          if (tiers.length !== 1) {
            return { error: { tag: "PolicyDenied", args: [{ reason: "model_tier", detail: `the agent loop needs exactly one model tier in its grant, not ${tiers.length}` }] }, cost: {} };
          }
          return runAgentLoop(task, {
            step: (cid, kind, req, reserve, call, stepLabel) =>
              this.command(cid, kind, req, reserve, call, { siblings: ctx.siblings, label: stepLabel, within: id, ...(overdue ? { guard: overdue } : {}), ...this.limits(kind, task.tier) }),
            chat: loop.chat,
            sandbox: loop.sandbox,
            stopped: (x) => x instanceof SiblingStopped,
            cancelled: async () => (await this.o.journal.run(this.o.runId)).cancel_requested,
            ...(loop.stopPollMs !== undefined ? { pollMs: loop.stopPollMs } : {}),
            sandboxStopped: (handle, result) =>
              this.o.journal.db.tx(async (tx) => {
                await this.o.journal.lock(tx, this.o.runId);
                await this.o.journal.event(tx, this.o.runId, "sandbox_stopped", { delegate: id, agent: agentName, handle, result });
              }),
          });
        },
        { siblings: ctx.siblings, label, ...(overdue ? { guard: overdue } : {}) },
      );
    }
    // A remote agent whose server does not deduplicate messages gets each task at most once (§9.6, G12).
    const atMostOnce = !!agent.remote && !this.o.adapters.agents.remoteProfile?.(agentName)?.idempotentMessages;
    return this.command(
      id,
      "delegate",
      request,
      budget,
      async (): Promise<Outcome> => {
        const out = await this.o.adapters.agents.run({
          agent: agentName,
          skill: e.skill,
          args: pos,
          caps,
          isolated: !!e.isolated,
          attempt,
          commandId: id,
          ...(budget ? { budget } : {}),
          ...(sandbox ? { sandbox } : {}),
          ...(deadline !== undefined ? { deadline } : {}),
        });
        if (deadline === undefined || this.o.adapters.clock.now() <= deadline) return out;
        // Past the deadline: what it spent is settled, the result is not used.
        const t = timedOut(true);
        return { error: { tag: t.tag, args: t.args }, ...(out.cost !== undefined ? { cost: out.cost } : {}), ...(out.meta !== undefined ? { meta: out.meta } : {}) };
      },
      { siblings: ctx.siblings, label, ...(overdue ? { guard: overdue } : {}), ...(atMostOnce ? { atMostOnce } : {}) },
    );
  }

  /** The rate-limit buckets a command of `kind` draws from, as command options. */
  private limits(kind: string, tier?: string): { buckets?: string[] } {
    const keys = this.o.limiter?.keys(kind, tier) ?? [];
    return keys.length ? { buckets: keys } : {};
  }

  private hashes?: Record<string, string>;

  private defHash(name: string): string {
    this.hashes ??= hashProgram(this.o.program as unknown as Json).defs;
    return this.hashes[name]!;
  }

  /** Capabilities handed to a delegate: A.caps ∩ avail(ctx), with `with caps` narrowing its own kinds (C2, §9.1). */
  private grants(agentName: string, withCaps: Expr[], path: string): CapVal[] {
    const agent = this.def(agentName) as Extract<Def, { kind: "agent" }>;
    const wfName = path.split("/")[2]!;
    const wf = this.def(wfName);
    const avail = wf?.kind === "workflow" ? wf.caps.flatMap((c) => this.caps(c)) : undefined;
    const inside = (c: CapVal): boolean => !avail || avail.some((a) => a.ctor === c.ctor && scopeInside(c, a));
    let out = agent.caps.flatMap((c) => this.caps(c)).filter(inside);
    if (withCaps.length) {
      const given = withCaps.flatMap((c) => this.caps(c));
      const kinds = new Set(given.map((g) => g.ctor));
      out = [...out.filter((c) => !kinds.has(c.ctor)), ...given];
    }
    const key = (c: CapVal): string => JSON.stringify(c.scope ? { ctor: c.ctor, scope: c.scope } : { ctor: c.ctor });
    return out.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  }

  /** What a capability expression stands for, over the program's definitions and its linked system model. */
  private caps(e: Expr): CapVal[] {
    return capsOf(this.defs, e);
  }

  // ── contracts (§10) ───────────────────────────────────────────────────

  private async verify(e: Extract<Expr, { op: "verify" }>, ctx: Ctx, path: string): Promise<Value> {
    const subject = await this.expr(e.value, ctx, `${path}/value`);
    const { pos } = await this.args(e.args, ctx, path);
    const c = this.def(e.contract);
    if (!c || c.kind !== "contract") throw new Violation("unknown_contract", `No contract '${e.contract}'.`);
    const vars = new Map<string, Value>();
    c.params.forEach((p, i) => vars.set(p.name, pos[i] ?? null));
    const cctx: Ctx = { scope: { vars }, where: "contract" };
    const unmet: string[] = [];
    const evidence: string[] = [];
    for (let i = 0; i < (c.require ?? []).length; i++) {
      if (!truthy(unwrap(await this.expr(c.require![i]!, cctx, `${path}/contract/require/${i}`)))) unmet.push(`require/${i}`);
    }
    // Criteria run in order of their method (§10.4): static, then tests,
    // then evals and reviews, then people; by name within each. A person is
    // asked only once every other criterion is met: nobody approves a change
    // whose checks already failed.
    const criteria = (["accept", "invariant"] as const)
      .flatMap((group) => Object.keys(c[group] ?? {}).map((name) => ({ name, by: c[group]![name]!.by, path: `${path}/contract/${group}/${name}` })))
      .sort((a, b) => methodRank(a.by) - methodRank(b.by) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const k of criteria) {
      if (methodRank(k.by) === HUMAN_RANK && unmet.length) unmet.push(k.name);
      else if (!(await this.criterion(k.by, e.contract, k.name, cctx, k.path, evidence))) unmet.push(k.name);
    }
    if (!unmet.length) return verified(subject, e.contract, evidence.sort());
    if (e.on_unmet) {
      return this.expr(e.on_unmet.then, { ...ctx, scope: { vars: new Map([[e.on_unmet.bind, unmet]]), parent: ctx.scope } }, `${path}/on_unmet/then`);
    }
    throw new Fault("Rejected", [{ contract: e.contract, unmet }]);
  }

  private async criterion(v: Verifier, contract: string, name: string, ctx: Ctx, path: string, evidence: string[]): Promise<boolean> {
    if ("all" in v) {
      let ok = true;
      for (let i = 0; i < v.all.length; i++) ok = (await this.criterion(v.all[i]!, contract, name, ctx, `${path}/all/${i}`, evidence)) && ok;
      return ok;
    }
    let passed: boolean;
    let method: string;
    let detail: Value = null;
    let files: Obj | undefined;
    let producer: Value = { kind: "runtime", handler: RUNTIME_HANDLER };
    let outputs: Value[] = [];
    if ("static" in v) {
      // A static criterion the compiler could not prove is checked here (W0601).
      method = "static";
      passed = truthy(unwrap(await this.expr(v.static, ctx, `${path}/static`)));
    } else if (needsPerson(v)) {
      method = "human.approve";
      const r = await this.approval((v as { call: Extract<Expr, { op: "call" }> }).call, contract, name, ctx, `${path}/call`);
      passed = r["approved"] === true;
      detail = { by: r["by"] ?? null, role: r["role"] ?? null, ...(r["expired"] === true ? { expired: true } : {}) };
      producer = { kind: "person", by: r["by"] ?? null, role: r["role"] ?? null, via: "DecideAction" };
    } else {
      const call = v.call;
      method = call.op === "call" ? (calleePath(call.callee) ?? "call") : "call";
      // Verifier options such as `review(model: standard, isolated)` name
      // settings, not variables: an unbound bare name is passed as its text.
      const symbolic = call.op === "call" ? call.args.map((a) => (a.value.op === "var" && this.isModulePath(a.value, ctx) ? { ...a, value: { op: "text" as const, value: a.value.name } } : a)) : [];
      const { pos, named } = call.op === "call" ? await this.args(symbolic, ctx, `${path}/call`) : { pos: [], named: {} };
      const req = { method, args: pos, named, contract, criterion: name };
      const verifier = this.o.adapters.verifier;
      const r = await this.command(
        `${path}/call`,
        "verify",
        req,
        verifier.upperBound ? () => verifier.upperBound!(req) : undefined,
        async () => {
          const res = await verifier.check(req);
          // The check's outputs (test logs, a review) are artifacts of the run; the journal keeps their references.
          const logs: Value[] = [];
          for (const l of res.logs ?? []) {
            const a = await this.o.artifacts.put(this.scope(), l.content, l.mediaType ?? "text/plain; charset=utf-8");
            logs.push({ kind: l.kind, ...(l.phase !== undefined ? { phase: l.phase } : {}), ...(l.result !== undefined ? { result: l.result } : {}), ref: a.ref });
          }
          return {
            ok: {
              passed: res.passed,
              detail: res.detail ?? null,
              ...(res.subject ? { subject: { files: res.subject.files } } : {}),
              artifacts: logs,
              producer: res.producer ?? { kind: "verifier", handler: "unspecified" },
            },
            ...(res.cost ? { cost: res.cost } : {}),
          };
        },
        { label: `${contract}.${name}`, ...(method === "review" ? this.limits("review", typeof named["model"] === "string" ? named["model"] : undefined) : {}) },
      );
      passed = isObj(r) && r["passed"] === true;
      detail = isObj(r) ? (r["detail"] ?? null) : null;
      const checked = isObj(r) && isObj(r["subject"] ?? null) ? (r["subject"] as Obj) : undefined;
      if (checked && isObj(checked["files"] ?? null)) files = checked["files"] as Obj;
      if (isObj(r) && Array.isArray(r["artifacts"])) outputs = r["artifacts"];
      if (isObj(r) && r["producer"] !== undefined) producer = r["producer"]!;
    }
    // What the check was about: the contract's arguments, and for a check of the working copy, its files (§10.3).
    const subject: Obj = { contract_args: this.subjectDigest(contract, ctx), ...(files ? { files } : {}) };
    if (files && !this.o.replay) subject["tree"] = (await this.o.artifacts.putTree(this.scope(), { format: "mandate/tree/0.1", files: files as Record<string, string> })).ref;
    const id = digest("request", { run: this.o.runId, criterion: path, method, passed });
    if (!this.o.replay) {
      // The control plane signs what was checked, against what, by whom and when (§10.3).
      const record: EvidenceRecord = {
        format: EVIDENCE_FORMAT,
        evidence_id: id,
        run: this.o.runId,
        package: this.o.packageHash,
        contract,
        contract_hash: this.defHash(contract),
        criterion: name,
        method,
        passed,
        subject,
        producer,
        artifacts: outputs,
        detail,
        at: this.o.adapters.clock.now(),
      };
      await this.o.journal.recordEvidence(this.o.runId, { record, ...this.o.signer.sign(record) });
    }
    if (passed) evidence.push(id);
    return passed;
  }

  /** A digest of a contract's arguments: what its evidence is about. */
  private subjectDigest(contract: string, ctx: Ctx): string {
    const c = this.def(contract) as ContractDef;
    return digest("request", { contract, subject: plain(c.params.map((p) => this.variable(p.name, ctx))) });
  }

  private scope(): { tenant: string; runId: string } {
    return { tenant: this.o.policy.tenant, runId: this.o.runId };
  }

  /**
   * `human.approve(role: r)` as an acceptance criterion: a wait for a person.
   * The request names a digest of the contract's arguments, so a decision
   * applies only to the subject the person was shown (G02). An approval here
   * is evidence for the criterion; it authorizes no action.
   */
  private async approval(call: Extract<Expr, { op: "call" }>, contract: string, criterion: string, ctx: Ctx, id: string): Promise<Obj> {
    const { named } = await this.args(call.args, ctx, id);
    const c = this.def(contract) as ContractDef;
    const subject = plain(c.params.map((p) => this.variable(p.name, ctx)));
    const role = named["role"] ?? null;
    const within = named["deadline"];
    let decision: Value;
    try {
      decision = await this.wait(id, "decision", {
        contract,
        criterion,
        role,
        subject,
        subject_digest: digest("request", { contract, criterion, subject }),
        deadline: typeof within === "number" ? this.o.adapters.clock.now() + within : null,
      });
    } catch (f) {
      // Past its deadline the approval was not given: the criterion is unmet, and `on unmet` decides (§8.8, R15).
      if (f instanceof Fault && f.tag === "Rejected" && f.args[0] === "approval_expired") return { approved: false, by: null, role, expired: true };
      throw f;
    }
    return isObj(decision) ? { ...decision, role } : { approved: false, role };
  }

  // ── external effects: prepare → authorize → commit (§8.8) ─────────────

  private effectInfo(name: string): { critical: boolean; irreversible: boolean; params: TypeExpr[]; retryClass?: string } {
    const d = this.def(name);
    if (d?.kind === "effect") {
      const ed = d as EffectDef;
      return { critical: !!(ed.critical || ed.irreversible), irreversible: !!ed.irreversible, params: ed.params.map((p) => p.type), ...(ed.retry_class ? { retryClass: ed.retry_class } : {}) };
    }
    const std = STD_EFFECTS[name];
    if (std) return { critical: !!std.critical, irreversible: !!std.irreversible, params: std.params };
    throw new Violation("unknown_effect", `No effect '${name}'.`);
  }

  private async effect(e: Extract<Expr, { op: "effect" }>, ctx: Ctx, path: string): Promise<Value> {
    const info = this.effectInfo(e.name);
    const { pos } = await this.args(e.args, ctx, path);
    // INV-13: a parameter declared Verified<T, C> must carry evidence for C at run time too.
    for (const [i, t] of info.params.entries()) {
      if (!("ref" in t) || t.ref !== "Verified") continue;
      const v = pos[i];
      const want = t.args?.[1] && "ref" in t.args[1] ? t.args[1].ref : undefined;
      if (!isObj(v) || !("$verified" in v) || (want && v["$contract"] !== want)) {
        throw new Fault("PolicyDenied", [{ effect: e.name, parameter: i, reason: "unverified_parameter" }]);
      }
      if (!this.o.replay) await this.checkVerified(e.name, v);
    }
    const key = e.idempotent_by ? plain(await this.expr(e.idempotent_by, ctx, `${path}/idempotent_by`)) : null;
    const tool = this.o.adapters.tools[e.name];
    if (!tool) throw new Violation("no_adapter", `No adapter for effect ${e.name}.`);
    const contract = tool.describe();
    const params = plain(pos);
    // Prepare (§8.8): the adapter checks the parameters and reads the files the action will apply. They are frozen
    // into the artifact store, and the journaled command keeps their digests, so a resumed worker or a replay finds
    // the same action; execute later sends exactly these bytes.
    if (ctx.siblings?.failed && !this.o.replay && !(await this.o.journal.command(this.o.runId, `${path}/prepare`))) throw new SiblingStopped();
    const prepared = await this.command(`${path}/prepare`, "prepare", { effect: e.name, params }, undefined, async () => {
      const pre = await tool.prepare(params);
      if ("rejected" in pre) return { error: { tag: "Rejected", args: [pre.rejected] }, cost: {} };
      const frozen: Obj = {};
      for (const f of [...(pre.artifacts ?? [])].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
        const a = await this.o.artifacts.put(this.scope(), f.content, f.mediaType ?? "text/plain; charset=utf-8");
        frozen[f.path] = { ref: a.ref, digest: a.digest };
      }
      return { ok: { artifacts: frozen }, cost: {} };
    });
    const frozen = isObj(prepared) && isObj(prepared["artifacts"] ?? null) ? (prepared["artifacts"] as Obj) : {};
    const files = Object.fromEntries(Object.entries(frozen).map(([p, a]) => [p, isObj(a) ? String(a["digest"]) : ""]));
    const evidence = evidenceOf(pos);
    // Evidence is bound to what it checked: an action that would apply other bytes is refused (G01, INV-05).
    if (Object.keys(files).length && !this.o.replay) await this.checkEvidenceFresh(e.name, files, evidence);
    const actionDigest = digest("action", {
      package: this.o.packageHash,
      run: this.o.runId,
      node: path,
      effect: e.name,
      adapter: contract.id,
      adapter_contract: contract.digest,
      params,
      evidence,
      idempotency_key: key,
      ...(Object.keys(files).length ? { artifacts: files } : {}),
    });
    const operationKey = digest("operation", { tenant: this.o.policy.tenant, run: this.o.runId, node: path, action: actionDigest });
    const { journal, runId, fence } = this.o;

    let action = await journal.action(operationKey);
    if (this.o.replay) {
      if (action?.state === "confirmed") return action.receipt;
      throw new ReplayEnd(path, "no_result");
    }
    if (ctx.siblings?.failed && (!action || action.state === "prepared")) throw new SiblingStopped();
    if (!action) {
      action = await journal.prepare(runId, fence, {
        operationKey,
        commandId: path,
        effect: e.name,
        actionDigest,
        params,
        retryClass: info.retryClass ?? contract.retryClass,
        ...(Object.keys(frozen).length ? { artifacts: frozen } : {}),
      });
    }
    let justCommitted = false;
    if (action.state === "prepared") {
      const authId = await this.authorization(e.name, info, action, path);
      action = await journal.commit(runId, fence, operationKey, authId);
      justCommitted = true;
      this.o.faults.check("after_commit", { id: path, kind: "effect" });
    }
    if (action.state === "dispatched") return this.dispatchAction(tool, action, justCommitted);
    return this.settledAction(action);
  }

  private settledAction(action: ActionRow): Value {
    switch (action.state) {
      case "confirmed":
        return action.receipt;
      case "rejected":
        throw new Fault("Rejected", [action.detail]);
      case "cancelled":
        throw new Fault("Rejected", ["cancelled"]);
      default:
        // unknown_outcome: never retried blindly; the run needs attention (R04, R05).
        throw new Attention({ operation: action.operation_key, effect: action.effect, state: action.state });
    }
  }

  /**
   * Sends a committed action. Found already dispatched (the worker died after
   * the outbox record, R02), what happens depends on the adapter's retry class
   * (§8.9): idempotent adapters get the same operation key again, reconcilable
   * ones are asked first, non-retryable ones become unknown_outcome.
   */
  private async dispatchAction(tool: ToolAdapter, action: ActionRow, fresh: boolean): Promise<Value> {
    const { journal, runId, fence, faults } = this.o;
    const op = action.operation_key;
    if (!fresh) {
      if (action.retry_class === "non_retryable") {
        await journal.finishAction(runId, fence, op, "unknown_outcome", { detail: "dispatched before a crash; not retryable" });
        return this.settledAction({ ...action, state: "unknown_outcome" });
      }
      if (action.retry_class === "reconcilable") {
        const r = await tool.reconcile(op);
        if ("applied" in r) {
          await journal.finishAction(runId, fence, op, "confirmed", { receipt: r.applied });
          return r.applied;
        }
        if ("unknown" in r) {
          await journal.finishAction(runId, fence, op, "unknown_outcome", { detail: r.unknown });
          return this.settledAction({ ...action, state: "unknown_outcome" });
        }
      }
    }
    const auth = await this.authRow(action);
    const artifacts = await this.actionArtifacts(action);
    const res = await tool.execute({ effect: action.effect, params: action.params, actionDigest: action.action_digest, operationKey: op, ...(artifacts.length ? { artifacts } : {}) }, auth, op);
    faults.check("after_execute", { id: action.command_id, kind: "effect" });
    if ("confirmed" in res) {
      await journal.finishAction(runId, fence, op, "confirmed", { receipt: res.confirmed });
      return res.confirmed;
    }
    if ("rejected" in res) {
      await journal.finishAction(runId, fence, op, "rejected", { detail: res.rejected });
      throw new Fault("Rejected", [res.rejected]);
    }
    await journal.finishAction(runId, fence, op, "unknown_outcome", { detail: res.unknown });
    return this.settledAction({ ...action, state: "unknown_outcome" });
  }

  /**
   * A Verified value is a protected type: its evidence is resolved from the
   * control plane's store, never taken from the value (§5.2, G03). Each id
   * must name evidence of this run that passed, for the value's contract,
   * signed by a trusted key; together they must cover every criterion of
   * the contract. A model or an agent can produce JSON that looks like a
   * Verified value; it never has such evidence.
   */
  private async checkVerified(effect: string, v: Obj): Promise<void> {
    const contract = String(v["$contract"] ?? "");
    const ids = Array.isArray(v["$evidence"]) ? v["$evidence"].map(String) : [];
    const rows = ids.length ? await this.o.journal.evidence(this.o.runId, ids) : [];
    const problems: string[] = [];
    const found = new Set(rows.map((r) => r.evidence_id));
    for (const id of ids) if (!found.has(id)) problems.push(`${id} is not evidence of this run`);
    for (const r of rows) {
      const record = r.record as unknown as EvidenceRecord | null;
      if (!r.passed) problems.push(`${r.evidence_id} did not pass`);
      if (r.contract !== contract) problems.push(`${r.evidence_id} is evidence for ${r.contract}`);
      if (!record || !r.key_id || !r.signature || !this.o.trusted.verify(record, { key_id: r.key_id, signature: r.signature })) problems.push(`${r.evidence_id} is not signed by a trusted key`);
      else if (record.evidence_id !== r.evidence_id || record.passed !== r.passed || record.contract !== r.contract || record.criterion !== r.criterion) problems.push(`${r.evidence_id} does not match its signed record`);
      else {
        const why = attestationProblem(record, this.o.verifiers);
        if (why) problems.push(`${r.evidence_id}: ${why}`);
      }
    }
    const c = this.def(contract);
    const criteria = c?.kind === "contract" ? [...Object.keys(c.accept), ...Object.keys(c.invariant ?? {})] : [];
    if (c?.kind !== "contract") problems.push(`${contract} is not a contract of this program`);
    const covered = new Set(rows.filter((r) => r.passed).map((r) => r.criterion));
    for (const k of criteria) if (!covered.has(k)) problems.push(`no evidence for ${contract}.${k}`);
    if (problems.length) throw new Violation("forged_evidence", `${effect} received a Verified value whose evidence does not hold: ${[...new Set(problems)].sort().join("; ")}.`);
  }

  /** The files frozen at prepare, read back from the artifact store (which checks their digests). */
  private async actionArtifacts(action: ActionRow): Promise<ActionArtifact[]> {
    const frozen = isObj(action.artifacts ?? null) ? (action.artifacts as Obj) : {};
    const out: ActionArtifact[] = [];
    for (const [path, a] of Object.entries(frozen)) {
      if (!isObj(a)) continue;
      const got = await this.o.artifacts.get(this.scope(), String(a["ref"]));
      out.push({ path, ref: String(a["ref"]), digest: got.digest, content: got.bytes });
    }
    return out;
  }

  /**
   * G01: every file the action applies must have the bytes the run's checks
   * saw. Each piece of evidence that names the working copy's files (a test)
   * must list the file with the same digest; a file changed or added since
   * the check makes the evidence stale, and the action is refused.
   */
  private async checkEvidenceFresh(effect: string, files: Record<string, string>, ids: string[]): Promise<void> {
    const rows = ids.length ? await this.o.journal.evidence(this.o.runId, ids) : [];
    const stale: string[] = [];
    for (const r of rows) {
      const checked = isObj(r.subject) && isObj(r.subject["files"] ?? null) ? (r.subject["files"] as Obj) : undefined;
      if (!checked) continue;
      for (const [p, d] of Object.entries(files)) {
        if (checked[p] !== d) stale.push(`${p} (${r.criterion}: ${checked[p] === undefined ? "not in what was checked" : "changed since the check"})`);
      }
    }
    if (stale.length) throw new Violation("stale_evidence", `${effect} would apply files other than the ones its evidence checked (G01): ${[...new Set(stale)].sort().join(", ")}.`);
  }

  private async authRow(action: ActionRow): Promise<{ authorizationId: string; decidedBy: string }> {
    const [row] = await this.o.journal.db.query("select authorization_id, decided_by from authorizations where consumed_by = $1", [action.operation_key]);
    if (!row) throw new Violation("MDT-E0406", `Action ${action.operation_key} was dispatched without an authorization.`);
    return { authorizationId: String(row["authorization_id"]), decidedBy: String(row["decided_by"]) };
  }

  /** authorize p by policy | human(role) (§8.8). A model or a program cannot produce this. */
  private async authorization(effect: string, info: { irreversible: boolean }, action: ActionRow, path: string): Promise<string> {
    const pol = this.o.policy.authorize?.[effect] ?? (info.irreversible ? { by: "human" as const, role: "owner" } : { by: "policy" as const });
    if (pol.by === "policy") {
      const id = digest("operation", { authorize: action.action_digest, by: "policy" });
      const ttl = this.o.policy.authorizationTtlMs ?? 15 * 60_000;
      await this.o.journal.authorize(this.o.runId, { id, actionDigest: action.action_digest, decidedBy: "policy", expiresAt: this.o.adapters.clock.now() + ttl });
      return id;
    }
    const decision = await this.wait(`${path}/authorize`, "decision", {
      effect,
      action_digest: action.action_digest,
      params: action.params,
      role: pol.role,
      deadline: pol.deadlineMs === undefined ? null : this.o.adapters.clock.now() + pol.deadlineMs,
    });
    if (!isObj(decision) || decision["approved"] !== true) throw new Fault("Rejected", [{ denied_by: isObj(decision) ? (decision["by"] ?? null) : null }]);
    return String(decision["authorization_id"]);
  }
}

/** A delegation's budget less what its finished steps spent; dimensions never go below zero. */
function subtractCost(budget: Budget | undefined, spent: Record<string, number>): Cost | undefined {
  if (!budget) return undefined;
  const left = (dim: string, v: number): number => Math.max(v - (spent[dim] ?? 0), 0);
  return {
    ...(budget.tokens !== undefined ? { tokens: left("tokens", budget.tokens) } : {}),
    ...(budget.steps !== undefined ? { steps: left("steps", budget.steps) } : {}),
    ...(budget.spend ? { spend: { micros: left(`spend:${budget.spend.currency}`, budget.spend.micros), currency: budget.spend.currency } } : {}),
  };
}

/** The result type a loop asks the model for: a skill returns `Inferred<T>`, and the model is asked for a `T`. */
function unwrapInferred(t: TypeExpr): TypeExpr {
  return "ref" in t && t.ref === "Inferred" && t.args?.[0] ? t.args[0] : t;
}

/** A sibling failed under fail_fast; this branch stops before its next dispatch. */
export class SiblingStopped extends Error {
  constructor() {
    super("stopped: a sibling branch failed");
  }
}

/** A criterion satisfied by a person: `human.approve(…)` (§10). */
function needsPerson(v: Verifier): boolean {
  return "call" in v && v.call.op === "call" && calleePath(v.call.callee) === "human.approve";
}

const HUMAN_RANK = 3;

/** Where a criterion runs in `verify` (§10.4): static 0, test 1, eval and review 2, human 3; `all` runs with its last part. */
function methodRank(v: Verifier): number {
  if ("all" in v) return Math.max(0, ...v.all.map(methodRank));
  if ("static" in v) return 0;
  if (needsPerson(v)) return HUMAN_RANK;
  const m = v.call.op === "call" ? calleePath(v.call.callee) : undefined;
  return m?.startsWith("test.") ? 1 : 2;
}

/** How long a Throttled fault asks to wait. */
function retryAfter(fault: Value): number {
  const a = isObj(fault) && Array.isArray(fault["args"]) && isObj(fault["args"][0] ?? null) ? (fault["args"][0] as Obj) : {};
  const ms = Number(a["retry_after_ms"]);
  return Number.isFinite(ms) && ms > 0 ? ms : 1000;
}

/** A Throttled refusal because too many calls already wait on the bucket: back pressure, not a wait (§8.6). */
function queueFull(fault: { args?: Value[] }): boolean {
  const a = fault.args?.[0];
  return isObj(a ?? null) && (a as Obj)["queue_full"] === true;
}

function replayed(row: CommandRow | undefined, id: string): Value {
  if (!row || row.state === "dispatched" || row.state === "waiting" || row.state === "throttled") throw new ReplayEnd(id, "no_result");
  if (row.payload_purged) throw new ReplayEnd(id, "payload_purged");
  if (row.state === "failed") {
    const err = row.error as { tag?: string; args?: Value[] } | null;
    throw new Fault(String(err?.tag ?? "SkillFailed"), err?.args ?? []);
  }
  return row.result;
}

export function truthy(v: Value): boolean {
  return v !== null && v !== false && v !== 0 && v !== "";
}

function matches(p: Pattern, v: Value): boolean {
  if (p.p === "wild" || p.p === "bind") return true;
  const t = tagOf(v) ?? (typeof v === "string" ? { tag: v, args: [] } : undefined);
  if (!t) {
    // A plain error value (e.g. from a fault) is matched on its tag only.
    return false;
  }
  if (t.tag !== p.tag) return false;
  return (p.args ?? []).every((a, i) => matches(a, t.args[i] ?? null));
}

function bind(p: Pattern, v: Value, into: Map<string, Value>): void {
  if (p.p === "bind") into.set(p.name, v);
  else if (p.p === "tag") {
    const t = tagOf(v);
    (p.args ?? []).forEach((a, i) => bind(a, t?.args[i] ?? null, into));
  }
}

function scopeInside(inner: CapVal, outer: CapVal): boolean {
  if (!outer.scope) return true;
  if (!inner.scope) return false;
  const seg = (s: string): string[] => s.split("/").filter((x) => x && x !== ".");
  const within = (a: string, b: string): boolean => {
    if (!inner.ctor.startsWith("fs.")) return a === b;
    const x = seg(a);
    const y = seg(b);
    return y.length <= x.length && y.every((s, i) => x[i] === s);
  };
  return inner.scope.every((i) => outer.scope!.some((o) => within(i, o)));
}

/** Pure evaluation of a constant or supervision argument. */
function constValue(e: Expr): Value {
  switch (e.op) {
    case "int":
      return e.value;
    case "dec":
      return Number(e.value);
    case "text":
      return e.value;
    case "bool":
      return e.value;
    case "duration":
      return e.ms;
    case "money":
      return money(e.micros, e.currency);
    case "list":
    case "set":
      return e.items.map(constValue);
    case "record":
      return Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, constValue(v)]));
    case "call": {
      const named: Obj = {};
      const pos: Value[] = [];
      for (const a of e.args) {
        if (a.name === undefined) pos.push(constValue(a.value));
        else named[a.name] = constValue(a.value);
      }
      return { $call: calleePath(e.callee) ?? "?", args: pos, named };
    }
    case "var":
      return e.name;
    default:
      throw new Violation("unsupported", `Not a constant expression: ${e.op}.`);
  }
}

/** std.decision policies (§8.10): turn a model's Decision into Confident(option) | Uncertain. */
function decide(policy: string, d: Value, named: Record<string, Value>): Value {
  if (!isObj(d)) throw new Violation("not_a_decision", "A decision policy needs a Decision value.");
  const option = d["option"] ?? null;
  const confidence = Number(d["confidence"] ?? 0);
  if (policy === "threshold") return confidence >= Number(named["min_confidence"] ?? 1) ? tag("Confident", option) : tag("Uncertain");
  if (policy === "top_margin") {
    const dist = (isObj(d["distribution"]) ? Object.values(d["distribution"]) : []).map(Number).sort((a, b) => b - a);
    return (dist[0] ?? 0) - (dist[1] ?? 0) >= Number(named["margin"] ?? 1) ? tag("Confident", option) : tag("Uncertain");
  }
  throw new Violation("unsupported", `Decision policy ${policy} is not implemented in the 0.1 runtime.`);
}

export { Cancelled };
