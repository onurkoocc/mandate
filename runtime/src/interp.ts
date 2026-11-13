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
  atLeast,
  BUDGET_DIMENSIONS,
  budgetAmount,
  calleePath,
  capCovers,
  capsOf,
  classRank,
  type DataClass,
  DECISION_POLICIES,
  governanceFiles,
  hashProgram,
  leadClasses,
  modelTiers,
  PROGRESS_DEFAULTS,
  requirementFor,
  scopeWithin,
  showCap,
  STD_EFFECTS,
  STD_FNS,
  subprogramLinked,
  workflowBounds,
  writesOverlap,
  type Arg,
  type Tier,
  type Budget,
  type CapVal,
  type ChangesetExpr,
  type ContractDef,
  type Def,
  type EffectDef,
  type Envelope,
  type Expr,
  type Json,
  type Lock,
  type MapExpr,
  type Modules,
  type Pattern,
  type PlanExpr,
  type Program,
  type Stmt,
  type TypeExpr,
  type Verifier,
  type WorkflowDef,
} from "@mandate/compiler";
import type { ActionArtifact, Adapters, CheckSubject, Cost, Outcome, ReadRequest, RunComponents, RunMode, SystemFacts, ToolAdapter } from "./adapters.js";
import type { ArtifactStore } from "./artifacts.js";
import { attestationsRequired, recordProblem, type AttestationRule } from "./attestation.js";
import { criterionMethods, evidenceIdOf, needsPerson, partMethod, uncovered } from "./criteria.js";
import { approvalProblem, type StoredDecision } from "./decisions.js";
import { EVIDENCE_FORMAT, type EvidenceRecord, type EvidenceSigner, type TrustedKeys } from "./evidence.js";
import type { RateLimiter } from "./ratelimit.js";
import type { Faults } from "./faults.js";
import { runAgentLoop, type LoopTask } from "./loop.js";
import { PLAN_TOOLS, planBrief, Planner, Shared, type PlanHost, type ProgramChecker } from "./plan.js";
import { schemaErrors, typeSchema } from "./schema.js";
import type { ActionRow, Admission, CommandRow, Journal, ViolationKind } from "./journal.js";
import { Attention, Cancelled, Fault, Suspend, Violation } from "./signals.js";
import {
  canonical,
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
  /**
   * The workflow whose body this is, through any function it calls and any contract it verifies against. Its
   * capabilities are the context a delegation is granted from (C2), and its model tiers are a model call's. It is
   * read from here and never from a command's path, which names where a command stands and not whose authority it has.
   */
  workflow: string;
  /**
   * Inside a map's body, for one item (spec/envelope.md "map"): `given` holds the `with caps` of each map around
   * it, outermost first, each of which stands in the context in place of the kinds it names; `handed` is what the
   * maps hand each delegation of the body.
   */
  item?: { given: CapVal[][]; handed: CapVal[] };
}

/**
 * A package a run stands under, or stood under before an amendment (spec/envelope.md "Amendments"): its hash, and
 * the envelope the run's workflow has in it.
 */
export interface Epoch {
  hash: string;
  envelope?: Envelope;
}

/** How one item of a map ended: with its value, with a fault, or with something that is not the item's to keep. */
type ItemEnd = { ok: Value } | { fault: Fault } | { stop: unknown };

/** What a delegation and a `plan` both say of the skill they run. */
type Delegation = { skill: string; budget?: Budget; isolated?: boolean };

/** What makes a delegation a lead's (`plan`): its tools for sub-programs, and how it steps aside while one runs. */
interface Lead {
  planner: (step: PlanHost["step"], aside: Lead["aside"]) => Planner;
  /** Runs `fn` with the lead's place among the run's delegations given up, and takes a place again after. */
  aside<T>(fn: () => Promise<T>): Promise<T>;
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
  /** The methods checked in the runtime's process, whose evidence carries no verifier attestation (RuntimeOptions). */
  inProcess?: ReadonlySet<string>;
  /**
   * What a person's approval is checked against (spec/envelope.md "Signed decisions"): the members' public keys, the
   * package's lock, and whether an approval must rest on a signed decision (signed mode, and every 0.4 package).
   */
  decisions?: { keys: TrustedKeys; lock: Lock; required: boolean };
  /** The package's lock. A 0.5 package's sandbox requirements read their isolation floors and credentials from it. */
  lock?: Lock;
  /**
   * The envelope of the run's workflow, when it has one (spec/envelope.md): every delegation attempt reserves one of
   * its `agents`, at most `spawn.max_concurrent` delegations are in flight, and an effect under `approve` is
   * authorized only by that role's decision.
   */
  envelope?: Envelope;
  /** The components the run works on, at their base commits (B3); verifier calls are told. */
  workspace?: RunComponents;
  /** How the run touches the outside world (B6); `live` when absent. */
  mode?: RunMode;
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
  /**
   * What a `plan` needs (spec/envelope.md "plan"): the package's program and modules as they were packaged, which
   * a sub-program is checked and linked against, the package's lock, which an amended package keeps, the checker,
   * how long a check may take, and when the run started, which with the envelope's `time` is its deadline.
   */
  plan?: { parent: Program; modules: Modules; lock: Lock; checker: ProgramChecker; checkMs: number; startedAt: number };
  /**
   * The packages the run had before its envelope was amended, oldest first (spec/envelope.md "Amendments"). A
   * command the journal holds stands under the package it was first recorded under: its grant, its action's digest
   * and who approves its effect are derived under that one again, so a resumed run and a replay find what the
   * journal recorded. Absent or empty for a run nobody amended.
   */
  earlier?: Epoch[];
  /**
   * Set for the interpreter of a sub-program: the command it was admitted as, under which its commands run and
   * from whose reservation they draw, and the `plan` node it belongs to, which names its effects' operations (N07).
   */
  sub?: { command: string; plan: string };
  /** What the interpreters of one run share. The run's own interpreter makes it. */
  shared?: Shared;
  /**
   * How many violations stop the run (spec/boundary.md "Violations and halt"): a new violation that brings the run's
   * count to it, or past it, stops the run with `violation_limit`. Absent: violations are recorded and counted, and
   * nothing stops the run for them.
   */
  violationLimit?: number;
}

const RESTARTABLE = new Set(["Timeout", "SkillFailed"]);

/** Faults a person may be asked about under escalate(human) (§8.7), and how often. */
const ESCALATABLE = new Set(["Timeout", "SkillFailed", "PolicyDenied", "Rejected"]);
const MAX_ESCALATIONS = 5;

/** The runtime itself, as the producer of the evidence it checks without a verifier (static criteria). */
const RUNTIME_HANDLER = "mandate-runtime@0.2";

export class Interpreter {
  private readonly defs: Record<string, Def>;
  private readonly shared: Shared;
  /**
   * Whether a lead may amend the run's envelope: the run's own interpreter, of a program with a `plan`. A
   * sub-program's interpreter is given no `plan`, and what `held` guards is reached only under an envelope.
   */
  private readonly amendable: boolean;

  constructor(private readonly o: InterpOptions) {
    this.defs = o.program.defs;
    this.shared = o.shared ?? new Shared();
    this.amendable = !!o.plan && Object.keys(leadClasses(o.plan.parent, o.program.defs)).length > 0;
  }

  /**
   * The package a command stands under (spec/envelope.md "Amendments"): the one the run had when the command was
   * first recorded, and for a command the journal has not seen, the run's package now. A run nobody amended has
   * one package, and nothing is read.
   */
  private async under(id: string): Promise<Epoch> {
    const now: Epoch = { hash: this.o.packageHash, ...(this.o.envelope ? { envelope: this.o.envelope } : {}) };
    const earlier = this.o.earlier;
    if (!earlier?.length) return now;
    const row = await this.o.journal.command(this.o.runId, id);
    if (!row) return now;
    // A row without a package was written before amendments were recorded: under the run's first package.
    const hash = row.package ?? earlier[0]!.hash;
    return earlier.find((e) => e.hash === hash) ?? now;
  }

  /**
   * A check against a number the envelope gives, made before anything is sent, at `id`. An amendment only widens
   * the envelope (E1709), so what passed before it passes after it; what it refused might not. So in a run a lead
   * may amend, a refusal is recorded, as the failed command `<id>/refused`, and a resumed run and a replay read it
   * there: what the envelope refused stays refused, whatever the envelope is now. Any other run records nothing,
   * and checks again each time, as it always did.
   */
  private async held(id: string, check: () => void): Promise<void> {
    if (!this.amendable) return check();
    const at = `${id}/refused`;
    if (this.o.replay || this.o.earlier?.length) {
      const row = await this.o.journal.command(this.o.runId, at);
      if (row) return void replayed(row, at);
    }
    try {
      check();
    } catch (f) {
      if (!(f instanceof Fault) || this.o.replay) throw f;
      await this.command(at, "refusal", { refused: f.tag }, undefined, async () => ({ error: { tag: f.tag, args: f.args }, cost: {} }));
    }
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
    const ctx: Ctx = { scope: { vars }, where: "workflow", workflow: name };
    // A sub-program's workflow runs under the command it was admitted as (spec/envelope.md "Running").
    const at = `${this.o.sub?.command ?? ""}/defs/${name}`;
    let result: Value;
    try {
      result = await this.block(wf.body, ctx, `${at}/body`);
    } catch (e) {
      if (!(e instanceof Return)) throw e;
      result = e.value;
    }
    // `ensures e` (§4.6): the workflow's postcondition over its result. A run whose result breaks it does not succeed.
    if (wf.ensures) {
      const held = truthy(unwrap(await this.expr(wf.ensures, { ...ctx, scope: { vars: new Map([["result", result]]), parent: ctx.scope } }, `${at}/ensures`)));
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
    return this.expr(wf.on![i]!.then, { scope: { vars }, where: "workflow", workflow: name }, `/defs/${name}/on/${i}@${episode}/then`);
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
      case "changeset":
        return this.changeset(e, ctx, path);
      case "escalate": {
        const person = e.to.op === "call" && calleePath(e.to.callee) === "human" ? e.to : undefined;
        const message = person?.args[0] ? await this.expr(person.args[0].value, ctx, `${path}/to/args/0/value`) : await this.expr(e.to, ctx, `${path}/to`);
        return this.wait(path, "input", { escalation: message, ...this.asked(person?.args.find((a) => a.name === "role")?.value) });
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
      case "map":
        return this.map(e, ctx, path);
      case "plan":
        return this.plan(e, ctx, path);
    }
  }

  /**
   * `map x in xs … { body }` (spec/envelope.md "map"): the body once for each element, at most `par` at a time,
   * with the results in the order of `xs` (R11).
   *
   * Before any item is dispatched: a list longer than the bound is `Rejected(over_limit)` (N08); each item's
   * `with caps` is evaluated, and must lie inside the context; and with `par > 1` no two items may write
   * overlapping scopes, or the map is `Rejected(overlapping_scopes)` (N03, C5).
   *
   * A fault in an item is that item's `Failed` outcome, and the others go on (R12). Under `fail_fast` it stops the
   * items not yet started, those in flight are waited for, and the map fails with it. Anything else that ends an
   * item is not the item's to keep: a wait, a stop for a person, a crash, and the run's own `BudgetExceeded`, which
   * goes to the run's budget handler as it does anywhere. No further item starts, and it leaves the map once the
   * items in flight have settled.
   *
   * What the map does is decided by the items in input order, never by which one ended first, so a resumed run and
   * a replay decide as the first run did: the first item that did not end with a value decides.
   */
  private async map(e: MapExpr, ctx: Ctx, path: string): Promise<Value> {
    const over = unwrap(await this.expr(e.over, ctx, `${path}/over`));
    if (!Array.isArray(over)) throw new Violation("not_a_list", `map runs its body over a list, and ${path}/over is not one.`);
    // Without `max` the bound is the envelope's `agents`: every item starts a delegation, so no more could run (E1702).
    const bound = e.max ?? this.o.envelope?.budget?.agents;
    if (bound === undefined) throw new Violation("unbounded_map", `The map at ${path} has no 'max' and the run has no envelope (MDT-E1702).`);
    const tooLong = (): void => {
      if (over.length > bound) throw new Fault("Rejected", ["over_limit", { map: path, items: over.length, max: bound }]);
    };
    // A bound that is the envelope's `agents` rises with an amendment: a map it refused before stays refused (`held`).
    if (e.max === undefined) await this.held(path, tooLong);
    else tooLong();
    const par = Math.max(1, e.par ?? 1);

    const outer = this.available(ctx);
    const items: Ctx[] = [];
    const writes: CapVal[][] = [];
    for (let i = 0; i < over.length; i++) {
      let item: Ctx = { ...ctx, scope: { vars: new Map([[e.bind, over[i]!]]), parent: ctx.scope } };
      const given: CapVal[] = [];
      for (let j = 0; j < (e.caps ?? []).length; j++) given.push(...(await this.capsAt(e.caps![j]!, item, `${path}[${i}]/caps/${j}`)));
      for (const g of given) {
        if (!outer.some((a) => capCovers(a, g))) throw new Fault("PolicyDenied", [{ reason: "outside_authority", map: path, item: i, capability: showCap(g) }]);
      }
      if (given.length) {
        const kinds = new Set(given.map((g) => g.ctor));
        item = { ...item, item: { given: [...(ctx.item?.given ?? []), given], handed: [...(ctx.item?.handed ?? []).filter((c) => !kinds.has(c.ctor)), ...given] } };
      }
      items.push(item);
      writes.push(given.filter((c) => c.write));
    }
    if (par > 1) {
      for (let i = 0; i < writes.length; i++) {
        for (let j = i + 1; j < writes.length; j++) {
          for (const a of writes[i]!) {
            const b = writes[j]!.find((c) => writesOverlap(a, c));
            if (b) throw new Fault("Rejected", ["overlapping_scopes", { map: path, items: [i, j], left: showCap(a), right: showCap(b) }]);
          }
        }
      }
    }
    if (!this.o.replay) await this.o.journal.mapStarted(this.o.runId, this.o.fence, { map: path, items: over.length, par });

    const failFast = e.supervise?.name === "fail_fast";
    const ends: Array<ItemEnd | undefined> = new Array<ItemEnd | undefined>(over.length).fill(undefined);
    let stopped = false;
    let next = 0;
    // What an item may write is held from here until the item has ended, also by an item that has not started
    // yet: a sub-program admitted meanwhile is kept clear of every place the map still writes (C5 across the run).
    const holder = (i: number): string => `${path}[${i}]`;
    writes.forEach((held, i) => void (held.length && this.shared.writes.set(holder(i), held)));
    const worker = async (): Promise<void> => {
      // A failed branch of a `par` around the map stops an item at its next command, like any command of that
      // branch, and that stop ends the map here.
      while (!stopped && next < over.length) {
        const i = next++;
        try {
          ends[i] = { ok: await this.block(e.body, items[i]!, `${holder(i)}/body`) };
        } catch (x) {
          if (x instanceof Fault && x.tag !== "BudgetExceeded") {
            ends[i] = { fault: x };
            if (failFast) stopped = true;
          } else {
            ends[i] = { stop: x };
            stopped = true;
          }
        } finally {
          this.shared.writes.delete(holder(i));
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(par, over.length) }, () => worker()));

    // How the map ended, for the run's views: each item's outcome by index. It is written when the map has an end
    // the journal decided, with all its outcomes or as failed, and not when something stopped the run inside it.
    const ended = async (failed?: string): Promise<void> => {
      if (this.o.replay) return;
      const outcomes = ends.map((end) => (!end || "stop" in end ? null : "ok" in end ? "Ok" : end.fault.tag));
      await this.o.journal.mapEnded(this.o.runId, this.o.fence, { map: path, outcomes, ...(failed !== undefined ? { failed } : {}) });
    };
    const out: Value[] = [];
    for (const [i, end] of ends.entries()) {
      // Items start in input order, so one that never started comes after the one that stopped the map, which
      // has decided by now.
      if (!end) throw new Error(`map ${path}: item ${i} did not run, and no earlier item stopped the map`);
      if ("stop" in end) throw end.stop;
      if ("fault" in end && failFast) {
        // The map has failed: the items it did not start will not run, and hold nothing.
        for (let j = next; j < over.length; j++) this.shared.writes.delete(holder(j));
        await ended(end.fault.tag);
        throw end.fault;
      }
      out.push("ok" in end ? tag("Ok", end.ok) : tag("Failed", end.fault.value()));
    }
    await ended();
    return out;
  }

  /**
   * What a capability expression stands for at run time. `c.narrow(v)` over a value is c with the scope the value
   * names. A `Path` is relative, and so may a text be: over files it names that path below each path of c. The
   * checker bounded the result by c without knowing the value (C3); what the value turns out to be is held to c
   * here, and a scope outside c is `PolicyDenied`. So is a file scope with `\`, `:` or NUL: a host may read it
   * another way than this comparison does, so it is not known to lie inside anything (K68). Anything else is what
   * it is statically (capsOf).
   */
  private async capsAt(e: Expr, ctx: Ctx, path: string): Promise<CapVal[]> {
    if (!(e.op === "call" && e.callee.op === "field" && e.callee.name === "narrow") || e.args.every((a) => a.value.op === "text")) return this.caps(e);
    const bases = await this.capsAt(e.callee.of, ctx, `${path}/callee/of`);
    const base = bases[0];
    // A capability that stands for several cannot be narrowed as one (MDT-E1002): it stays without a scope, which no sandbox accepts.
    if (!base || bases.length !== 1) return this.caps(e);
    const scope: string[] = [];
    for (let i = 0; i < e.args.length; i++) {
      const v = unwrap(await this.expr(e.args[i]!.value, ctx, `${path}/args/${i}/value`));
      const named = Array.isArray(v) ? v.map(unwrap) : [v];
      for (const s of named) {
        if (typeof s !== "string") throw new Violation("bad_scope", `narrow takes text or a path, and ${path}/args/${i}/value is ${show(v)}.`);
        const files = base.ctor.startsWith("fs.");
        if (files && /[\\:\0]/.test(s)) throw new Fault("PolicyDenied", [{ reason: "outside_capability", capability: showCap(base), requested: [s] }]);
        if (files && !s.startsWith("/") && base.scope) scope.push(...base.scope.map((b) => `${b.replace(/\/+$/, "")}/${s}`));
        else scope.push(s);
      }
    }
    if (!scopeWithin(base.ctor, scope, base.scope)) {
      throw new Fault("PolicyDenied", [{ reason: "outside_capability", capability: showCap(base), requested: scope }]);
    }
    return [{ ...base, scope, name: `${base.name ?? base.ctor}.narrow` }];
  }

  private variable(name: string, ctx: Ctx): Value {
    for (let s: Scope | undefined = ctx.scope; s; s = s.parent) {
      if (s.vars.has(name)) return s.vars.get(name)!;
    }
    const d = this.def(name);
    if (d?.kind === "const") return this.constant(name, d.value);
    if (d?.kind === "capability") return { $capability: name };
    if (d?.kind === "type") return tag(name);
    // A component, interface or environment stands for its name, e.g. `test.integration(env: staging, …)`.
    if (d?.kind === "component" || d?.kind === "interface" || d?.kind === "environment") return name;
    // A role (0.4) is named where a person is asked: `human.approve(role: code_owner)`.
    if (d?.kind === "role") return name;
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
        return canonical(l) === canonical(r);
      case "!=":
        return canonical(l) !== canonical(r);
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
        return Array.isArray(r) && r.some((x) => canonical(x) === canonical(l));
      case "subseteq":
        return Array.isArray(l) && Array.isArray(r) && l.every((x) => r.some((y) => canonical(x) === canonical(y)));
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
      return this.wait(path, "input", { question: pos[0] ?? null, ...this.asked(e.args.find((a) => a.name === "role")?.value) });
    }
    if (p === "time.now") return this.command(path, "time", {}, undefined, async () => ({ ok: this.o.adapters.clock.now() }));
    if (p === "data.read") return this.dataRead(e, ctx, path);
    if (p && STD_FNS[p]) {
      const { pos, named } = await this.args(e.args, ctx, path);
      return this.command(path, "read", { call: p, args: pos, named }, undefined, () => this.o.adapters.reads.call(p, pos, named));
    }
    if (e.callee.op === "field" && e.callee.name === "narrow") return { $capability: path };
    throw new Violation("unsupported_call", `The runtime cannot call ${p ?? "this expression"} at ${path}.`);
  }

  /**
   * `data.read(env.read, p: v, …, max_class: c)` (design doc 9 §5.1): a
   * journaled read through the broker; replay reads the journal. A `design`
   * run reads sample rows instead. The program gets the rows.
   */
  private async dataRead(e: Extract<Expr, { op: "call" }>, ctx: Ctx, path: string): Promise<Value> {
    const first = e.args[0]!.value as Extract<Expr, { op: "field" }>;
    const envName = (first.of as Extract<Expr, { op: "var" }>).name;
    const env = this.def(envName);
    const src = env?.kind === "environment" ? env.reads?.[first.name] : undefined;
    if (!src || env?.kind !== "environment") throw new Violation("unknown_read", `No read ${envName}.${first.name}.`);
    const params: Obj = {};
    let maxClass: DataClass = env.class;
    for (let i = 1; i < e.args.length; i++) {
      const a = e.args[i]!;
      if (a.name === "max_class") maxClass = (a.value as Extract<Expr, { op: "var" }>).name as DataClass;
      else if (a.name) params[a.name] = plain(await this.expr(a.value, ctx, `${path}/args/${i}/value`));
    }
    const mode = this.o.mode ?? "live";
    const broker = mode === "design" ? this.o.adapters.samples : this.o.adapters.broker;
    const req: ReadRequest = { environment: envName, read: first.name, from: src.from, query: "sql" in src.query ? { sql: src.query.sql } : { logs: src.query.logs as unknown as Value }, params, maxRows: src.max_rows, fields: this.fieldClasses(src.returns), maxClass, commandId: path };
    const r = await this.command(path, "read", { read: `${envName}.${first.name}`, params, max_class: maxClass, mode }, undefined, async () => {
      if (!broker) return { error: { tag: "PolicyDenied", args: [{ reason: mode === "design" ? "no_samples" : "no_broker", read: `${envName}.${first.name}` }] }, cost: {} };
      return broker.query(req);
    }, { siblings: ctx.siblings, label: `read ${envName}.${first.name}` });
    return isObj(r) && Array.isArray(r["rows"]) ? r["rows"] : [];
  }

  /** The data class of each field of a row type (§5.5): its named type's class, the highest along the way. */
  private fieldClasses(t: TypeExpr): Record<string, DataClass> {
    const resolve = (x: TypeExpr, seen: Set<string>): TypeExpr | undefined => {
      if ("record" in x) return x;
      if ("refine" in x) return resolve(x.refine, seen);
      if ("ref" in x && !seen.has(x.ref)) {
        const d = this.def(x.ref);
        if (d?.kind === "type") return resolve(d.type, new Set([...seen, x.ref]));
      }
      return undefined;
    };
    const classOf = (x: TypeExpr, seen: Set<string>): DataClass => {
      let best: DataClass = "public";
      const bump = (c: DataClass): void => {
        if (classRank(c) > classRank(best)) best = c;
      };
      if ("ref" in x && !seen.has(x.ref)) {
        const d = this.def(x.ref);
        if (d?.kind === "type") {
          if (d.class) bump(d.class);
          bump(classOf(d.type, new Set([...seen, x.ref])));
        }
        for (const a of x.args ?? []) bump(classOf(a, seen));
      } else if ("record" in x) for (const f of Object.values(x.record)) bump(classOf(f, seen));
      else if ("refine" in x) bump(classOf(x.refine, seen));
      return best;
    };
    const rec = resolve(t, new Set());
    return rec && "record" in rec ? Object.fromEntries(Object.entries(rec.record).map(([f, ft]) => [f, classOf(ft, new Set())])) : {};
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
      const prior = await journal.dispatch(runId, fence, { id, kind, digest: requestDigest, ...(label ? { label } : {}) }, bound, within, this.o.sub?.command);
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

  /**
   * The role a question asks, as the wait's request names it: from 0.4 a role is a definition, and only a member who
   * holds it may answer (spec/envelope.md "Roles"). An earlier program's question names none, as before.
   */
  private asked(role: Expr | undefined): { role: string } | Record<string, never> {
    if (!role || !atLeast(this.o.program.language, "mandate/0.4")) return {};
    const name = role.op === "var" ? role.name : role.op === "text" ? role.value : undefined;
    return name === undefined ? {} : { role: name };
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
    // The tier is read from the envelope the run has now. An `infer` records its request, which names no tier.
    const tier = this.tierFor(e.using, ctx);
    const req = { type: e.type, input, commandId: path, ...(using !== undefined ? { using } : {}), ...(tier ? { tier } : {}) };
    return this.command(path, "infer", { type: e.type as unknown as Value, input, using: using ?? null }, async () => this.o.adapters.model.upperBound(req), () => this.checkedInfer(req), { siblings: ctx.siblings, label: "infer", ...this.limits("infer", tier) });
  }

  /** A model's answer to `infer`, checked against the type it was asked for: its word that it fits is not taken (INV-04, G14). */
  private async checkedInfer(req: Parameters<Adapters["model"]["infer"]>[0]): Promise<Outcome> {
    const out = await this.o.adapters.model.infer(req);
    if (!("ok" in out)) return out;
    const problems = schemaErrors(typeSchema(this.o.program, req.type), out.ok);
    if (!problems.length) return out;
    return { error: { tag: "Rejected", args: ["schema_mismatch", problems as unknown as Value] }, ...(out.cost ? { cost: out.cost } : {}), ...(out.meta ? { meta: out.meta } : {}) };
  }

  /**
   * The model tier a model call runs under: the capability named by `using`,
   * else the only tier among the workflow's model capabilities,
   * else the only tier the program names. The lock file maps it to a model.
   */
  private tierFor(using: Expr | undefined, ctx: Ctx): string | undefined {
    const tierOf = (e: Expr): string | undefined => this.caps(e).find((c) => c.tier)?.tier;
    if (using) return tierOf(using);
    const own = [...new Set(this.available(ctx).flatMap((c) => (c.tier ? [c.tier] : [])))];
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
    // `with caps`, with a scope a value names evaluated now: the same for every attempt.
    const given: CapVal[] = [];
    for (let i = 0; i < (e.caps ?? []).length; i++) given.push(...(await this.capsAt(e.caps![i]!, ctx, `${path}/caps/${i}`)));
    for (let attempt = 0; ; attempt++) {
      const id = attempt ? `${path}#${attempt}` : path;
      try {
        return await this.attempt(e.agent, e, pos, given, ctx, id, attempt, timeoutMs);
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
          return await this.attempt(fallback, e, pos, given, ctx, `${path}~${fallback}`, 0, timeoutMs);
        }
        if (sup?.name === "escalate" && ESCALATABLE.has(f.tag) && attempt < MAX_ESCALATIONS) {
          const role = arg("role");
          const answer = await this.wait(`${id}/escalate`, "input", {
            escalation: { delegate: `${e.agent}.${e.skill}`, fault: f.value(), attempt },
            question: `${e.agent}.${e.skill} failed with ${show(f.value())}. Answer "retry" to run it again, or anything else to let the failure stand.`,
            options: ["retry", "fail"],
            ...(role?.op === "text" ? { role: role.value } : this.asked(role)),
          });
          if (String(unwrap(answer)).trim().toLowerCase() === "retry") continue;
        }
        throw f;
      }
    }
  }

  /**
   * A place among the run's delegations in flight (spec/envelope.md "The ledger"). `spawn.max_concurrent` is not a
   * ledger: a delegation that would exceed it waits here until another one settles. The wait is not an attempt,
   * holds no reservation and is not a fault. Nothing of it is journaled, and replay, which sends nothing, never
   * waits. One worker drives a run at a time (R06), so the count is kept in memory, by the run's interpreter and
   * those of its sub-programs together.
   *
   * Returns what gives the place back; it goes to whoever waited longest.
   */
  private async place(): Promise<() => void> {
    const max = this.o.envelope?.spawn?.max_concurrent;
    const s = this.shared;
    if (max === undefined || this.o.replay) return () => {};
    if (s.inFlight < max) s.inFlight++;
    else await new Promise<void>((go) => s.waiting.push(go));
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const next = s.waiting.shift();
      // Handed on, the place stays taken; otherwise it is free again.
      if (next) next();
      else s.inFlight--;
    };
  }

  /**
   * One attempt of a delegation, once the run has a place for it (`spawn.max_concurrent`). A lead gives its place
   * up while a sub-program of its runs, since the sub-program's delegations take places of their own, and takes
   * one again when the sub-program has ended.
   */
  private async attempt(agentName: string, e: Delegation, pos: Value[], given: CapVal[], ctx: Ctx, id: string, attempt: number, timeoutMs: number | undefined, planner?: Lead["planner"]): Promise<Value> {
    let leave = await this.place();
    const aside = async <T>(fn: () => Promise<T>): Promise<T> => {
      leave();
      try {
        return await fn();
      } finally {
        leave = await this.place();
      }
    };
    try {
      return await this.send(agentName, e, pos, given, ctx, id, attempt, timeoutMs, planner ? { planner, aside } : undefined);
    } finally {
      leave();
    }
  }

  /**
   * `plan A.s(args) within envelope` (spec/envelope.md "plan"): A's bodiless skill as an agent loop, like a
   * delegation, with `check_program` and `submit_program` beside its tools. A sub-program the lead submits is
   * checked against what is left of the envelope, admitted with its whole budget reserved, and run to its end
   * inside the lead's tool call; its result goes back to the lead.
   *
   * A replay does not run the lead again. It runs each admitted sub-program against the journal, from the IR the
   * artifact store holds, and then takes the lead's recorded result (N06).
   */
  private async plan(e: PlanExpr, ctx: Ctx, path: string): Promise<Value> {
    const p = this.o.plan;
    const envelope = this.o.envelope;
    const run = this.o.program.defs;
    // The checker refuses a `plan` outside an envelope (E1707) and in a sub-program (E1705).
    if (!p || !envelope || this.o.sub) throw new Violation("unsupported", `The plan at ${path} is not in a workflow with an envelope that this runtime can run sub-programs for.`);
    const cls = leadClasses(p.parent, run)[staticPath(path)];
    if (cls === undefined) throw new Violation("unknown_plan", `The checker knows no plan at ${staticPath(path)}.`);
    const { pos } = await this.args(e.args, ctx, path);
    const time = envelope.budget?.time?.ms;
    const planner: Lead["planner"] = (step, aside) =>
      new Planner({
        journal: this.o.journal,
        runId: this.o.runId,
        fence: this.o.fence,
        replay: this.o.replay,
        artifacts: this.o.artifacts,
        scope: this.scope(),
        now: () => this.o.adapters.clock.now(),
        parent: p.parent,
        modules: p.modules,
        package: this.o.packageHash,
        lock: p.lock,
        workflow: ctx.workflow,
        plan: path,
        lead: `${e.agent}.${e.skill}`,
        leadClass: cls,
        ...(time !== undefined ? { deadline: p.startedAt + time } : {}),
        checker: p.checker,
        checkMs: p.checkMs,
        shared: this.shared,
        step,
        // The lead holds no place among the run's delegations while its sub-program runs: the sub-program's own do.
        run: (a, sub) => aside(() => this.subprogram(a, sub)),
      });
    if (this.o.replay) {
      await planner(
        () => Promise.reject(new Error("a replay runs no step")),
        (fn) => fn(),
      ).replay();
      return replayed(await this.o.journal.command(this.o.runId, path), path);
    }
    if (!this.o.adapters.loop) throw new Violation("no_agent_loop", `The plan at ${path} runs ${e.agent}.${e.skill} as an agent loop, and this runtime has none (adapters.loop).`);
    return this.attempt(e.agent, e, pos, [], ctx, path, 0, undefined, planner);
  }

  /**
   * Runs an admitted sub-program's workflow to its end (spec/envelope.md "Running"), in the same run: under the
   * command it was admitted as, with its own definitions and all its parent sees, and from its own reservation.
   * The envelope's rules hold inside it: who approves an effect, and how many delegations are in flight at once.
   * A map without `max` is bounded by the sub-program's own `agents`.
   */
  private subprogram(a: Admission, sub: Program): Promise<Value> {
    const { plan, ...o } = this.o;
    const program = subprogramLinked(sub, plan!.parent, plan!.modules);
    const wf = Object.hasOwn(program.defs, a.workflow) ? program.defs[a.workflow] : undefined;
    if (wf?.kind !== "workflow") throw new Violation("unknown_workflow", `Sub-program ${a.number} of ${a.plan} has no workflow '${a.workflow}'.`);
    const inner = new Interpreter({ ...o, program, envelope: { ...o.envelope!, budget: wf.budget ?? {} }, sub: { command: a.command, plan: a.plan }, shared: this.shared });
    return inner.runWorkflow(a.workflow, {});
  }

  /** One attempt of a delegation, by `agentName` (the called agent, or a degrade fallback), as command `id`. */
  private async send(agentName: string, e: Delegation, pos: Value[], given: CapVal[], ctx: Ctx, id: string, attempt: number, timeoutMs: number | undefined, lead?: Lead): Promise<Value> {
    const agent = this.def(agentName);
    if (!agent || agent.kind !== "agent") throw new Violation("unknown_agent", `No agent '${agentName}'.`);
    const skill = Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill]! : undefined;
    if (!skill) throw new Violation("unknown_skill", `No skill '${agentName}.${e.skill}'.`);
    // A delegation the journal holds keeps the grant it was sent with: it is derived under the package it was
    // recorded under, whatever the envelope is now.
    const under = await this.under(id);
    const granted = this.grants(agentName, given, ctx, under);
    const caps = granted.map((c) => (c.scope ? { ctor: c.ctor, scope: c.scope } : { ctor: c.ctor }));
    const budget = e.budget ?? skill.budget ?? agent.budget;
    // Under an envelope every attempt is one of its `agents`: a first attempt, each restart and a degrade fallback
    // each reserve one when they are dispatched, with their budget, in one transaction (spec/envelope.md "The ledger").
    const one = this.o.envelope ? { agents: 1 } : undefined;
    const sandbox = agent.remote ? undefined : requirementFor({ agent: agentName, def: this.defHash(agentName) }, granted, budget?.time?.ms ?? null, { language: this.o.program.language, ...(this.o.lock ? { lock: this.o.lock } : {}) });
    const request = { agent: agentName, skill: e.skill, args: pos, caps: caps as unknown as Value, isolated: !!e.isolated };
    const loop = this.o.adapters.loop;
    const deadline = timeoutMs === undefined ? undefined : Number(await this.command(`${id}/started`, "time", {}, undefined, async () => ({ ok: this.o.adapters.clock.now() }))) + timeoutMs;
    const timedOut = (late?: true): Fault => new Fault("Timeout", [{ delegate: `${agentName}.${e.skill}`, after_ms: timeoutMs ?? 0, ...(late ? { late_result: true } : {}) }]);
    const overdue = deadline === undefined ? undefined : (): void => {
      if (this.o.adapters.clock.now() >= deadline) throw timedOut();
    };
    const label = `${agentName}.${e.skill}`;
    if (lead && !(loop && sandbox && !skill.body)) throw new Violation("no_agent_loop", `${label} cannot lead: a plan runs a bodiless skill of a local agent as an agent loop.`);
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
        ...(budget?.spend ? { spend: budget.spend } : {}),
        sandbox,
        program: this.o.program,
        ...(lead ? { extra: PLAN_TOOLS, brief: planBrief(this.o.plan!.parent, under.envelope!) } : {}),
      };
      const planner = lead?.planner(
        (cid, req, call, stepLabel) => this.command(cid, "tool", req, undefined, call, { siblings: ctx.siblings, label: stepLabel, within: id, ...(overdue ? { guard: overdue } : {}), ...this.limits("tool", task.tier) }),
        lead.aside,
      );
      return this.command(
        id,
        "delegate",
        request,
        async () => {
          const left = subtractCost(budget, await this.o.journal.childCost(this.o.runId, id));
          return one ? { ...left, ...one } : left;
        },
        async () => {
          if (tiers.length !== 1) {
            return { error: { tag: "PolicyDenied", args: [{ reason: "model_tier", detail: `the agent loop needs exactly one model tier in its grant, not ${tiers.length}` }] }, cost: {} };
          }
          return runAgentLoop(task, {
            step: (cid, kind, req, reserve, call, stepLabel) =>
              this.command(cid, kind, req, reserve, call, { siblings: ctx.siblings, label: stepLabel, within: id, ...(overdue ? { guard: overdue } : {}), ...this.limits(kind, task.tier) }),
            // An agent the lock binds to an executor talks to its chat; its tools still run in this sandbox (K79).
            chat: loop.executor?.chats[agentName] ?? loop.chat,
            sandbox: loop.sandbox,
            stopped: (x) => x instanceof SiblingStopped,
            cancelled: async () => (await this.o.journal.run(this.o.runId)).cancel_requested,
            ...(loop.stopPollMs !== undefined ? { pollMs: loop.stopPollMs } : {}),
            sandboxStopped: (handle, result) =>
              this.o.journal.db.tx(async (tx) => {
                await this.o.journal.lock(tx, this.o.runId);
                await this.o.journal.event(tx, this.o.runId, "sandbox_stopped", { delegate: id, agent: agentName, handle, result });
              }),
            ...(planner && lead ? { extra: (cid, name, input, stepLabel) => planner.call(cid, name, input, stepLabel) } : {}),
            violation: (kind, step, detail) => this.violation({ kind, delegate: id, agent: agentName, step, detail }),
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
      one ? { ...budget, ...one } : budget,
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

  /**
   * Records a violation of a delegation's agent (spec/boundary.md "Violations and halt"), once for its step, and stops
   * the run when a new one reaches the run's limit. The limit is checked only when a violation is written, so a
   * resumed run that comes to an earlier one again goes on, and stops at its next new one. A replay writes nothing.
   */
  private async violation(v: { kind: ViolationKind; delegate: string; agent: string; step: string; detail: Value }): Promise<void> {
    if (this.o.replay) return;
    const count = await this.o.journal.violation(this.o.runId, this.o.fence, v);
    const limit = this.o.violationLimit;
    if (count === undefined || limit === undefined || count < limit) return;
    throw new Violation("violation_limit", `The run reached its limit of ${limit} violation${limit === 1 ? "" : "s"}: ${v.agent} at ${v.step} (${v.kind}) is violation ${count}.`);
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

  /**
   * Capabilities handed to a delegate: A.caps ∩ avail(ctx), with `with caps` narrowing its own kinds (C2, §9.1).
   * An agent capability is in avail(ctx) when one of the workflow's (its envelope's, when it has one) covers it, as the compiler reads it
   * (capCovers): its scope by segment after `.` and `..`, and no higher data class, other tier or wider arguments.
   *
   * `own` is the delegation's `with caps`. Inside a map's body the map's `with caps` is handed to the delegation as
   * if it had named it: for each kind the agent holds at least as widely and the delegation names none of its own
   * (spec/envelope.md "map"). What the delegation names itself lies inside the context, which for a map item is what
   * the map handed that item; a scope chosen at run time is held to that here, since the checker could only hold it
   * to the capability it narrows.
   */
  private grants(agentName: string, own: CapVal[], ctx: Ctx, under?: Epoch): CapVal[] {
    const agent = this.def(agentName) as Extract<Def, { kind: "agent" }>;
    const avail = this.available(ctx, under);
    const inside = (c: CapVal): boolean => avail.some((a) => capCovers(a, c));
    const held = agent.caps.flatMap((c) => this.caps(c));
    let out = held.filter(inside);
    for (const g of own) {
      if (!inside(g)) throw new Fault("PolicyDenied", [{ reason: "outside_authority", delegate: agentName, capability: showCap(g) }]);
    }
    const named = new Set(own.map((g) => g.ctor));
    const given = [...own, ...(ctx.item?.handed ?? []).filter((k) => !named.has(k.ctor) && (!!agent.remote || held.some((a) => capCovers(a, k))))];
    if (given.length) {
      const kinds = new Set(given.map((g) => g.ctor));
      out = [...out.filter((c) => !kinds.has(c.ctor)), ...given];
    }
    const key = (c: CapVal): string => JSON.stringify(c.scope ? { ctor: c.ctor, scope: c.scope } : { ctor: c.ctor });
    return out.sort((a, b) => (key(a) < key(b) ? -1 : 1));
  }

  /**
   * avail(ctx): the capabilities of the workflow whose body is running, its envelope's when it has one (C2). Inside
   * a map's body, what the maps around the item left of them: each map's `with caps` stand in place of the kinds
   * they name. `under` is the package to read the run's envelope from, when it is not the run's package now: an
   * amendment replaces that envelope and nothing else, and a sub-program is bounded by its own capabilities.
   */
  private available(ctx: Ctx, under?: Epoch): CapVal[] {
    const bounds = under?.envelope && !this.o.sub ? (under.envelope.caps ?? []) : workflowBounds(this.workflowDef(ctx.workflow)).caps;
    let avail = bounds.flatMap((c) => this.caps(c));
    for (const given of ctx.item?.given ?? []) {
      const kinds = new Set(given.map((g) => g.ctor));
      avail = [...avail.filter((c) => !kinds.has(c.ctor)), ...given];
    }
    return avail;
  }

  /** What a capability expression stands for, over the program's definitions and its linked system model. */
  private caps(e: Expr): CapVal[] {
    return capsOf(this.defs, e, { language: this.o.program.language });
  }

  // ── contracts (§10) ───────────────────────────────────────────────────

  private async verify(e: Extract<Expr, { op: "verify" }>, ctx: Ctx, path: string): Promise<Value> {
    const subject = await this.expr(e.value, ctx, `${path}/value`);
    const { pos } = await this.args(e.args, ctx, path);
    const c = this.def(e.contract);
    if (!c || c.kind !== "contract") throw new Violation("unknown_contract", `No contract '${e.contract}'.`);
    const vars = new Map<string, Value>();
    c.params.forEach((p, i) => vars.set(p.name, pos[i] ?? null));
    const cctx: Ctx = { scope: { vars }, where: "contract", workflow: ctx.workflow };
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

  /** One criterion of a contract, or one part of it under `and`; `root` is the criterion's own path, whichever part `path` is. */
  private async criterion(v: Verifier, contract: string, name: string, ctx: Ctx, path: string, evidence: string[], root = path): Promise<boolean> {
    if ("all" in v) {
      let ok = true;
      for (let i = 0; i < v.all.length; i++) ok = (await this.criterion(v.all[i]!, contract, name, ctx, `${path}/all/${i}`, evidence, root)) && ok;
      return ok;
    }
    let passed: boolean;
    // The method the record names, as the checks of evidence read it from the program (criteria.ts).
    const method = partMethod(v);
    let detail: Value = null;
    let files: Obj | undefined;
    let producer: Value = { kind: "runtime", handler: RUNTIME_HANDLER };
    let outputs: Value[] = [];
    if ("static" in v) {
      // A static criterion the compiler could not prove is checked here (W0601).
      passed = truthy(unwrap(await this.expr(v.static, ctx, `${path}/static`)));
    } else if (needsPerson(v)) {
      const r = await this.approval((v as { call: Extract<Expr, { op: "call" }> }).call, contract, name, ctx, `${path}/call`, root);
      passed = r["approved"] === true;
      // A signed decision is named by its digest, with the member and the key that signed it (spec/envelope.md).
      const signed: Obj = typeof r["decision"] === "string" ? { member: r["member"] ?? null, key: r["key"] ?? null, decision: r["decision"] } : {};
      detail = { by: r["by"] ?? null, role: r["role"] ?? null, ...(r["expired"] === true ? { expired: true } : {}), ...signed };
      producer = { kind: "person", by: r["by"] ?? null, role: r["role"] ?? null, via: "DecideAction", ...signed };
    } else {
      const call = v.call;
      // Verifier options such as `review(model: standard, isolated)` name
      // settings, not variables: an unbound bare name is passed as its text.
      const symbolic = call.op === "call" ? call.args.map((a) => (a.value.op === "var" && this.isModulePath(a.value, ctx) ? { ...a, value: { op: "text" as const, value: a.value.name } } : a)) : [];
      const { pos, named } = call.op === "call" ? await this.args(symbolic, ctx, `${path}/call`) : { pos: [], named: {} };
      const system = this.systemFacts();
      const req = { method, args: pos, named, contract, criterion: name, ...(system ? { system } : {}) };
      const verifier = this.o.adapters.verifier;
      const r = await this.command(
        `${path}/call`,
        "verify",
        req as unknown as Value,
        verifier.upperBound ? () => verifier.upperBound!(req) : undefined,
        async () => {
          // Beside the request, not in it: which run and which part of the criterion this check is for (CheckBinding).
          const res = await verifier.check(req, { run: this.o.runId, part: path });
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
    const id = evidenceIdOf(this.o.runId, path, method, passed);
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
        // Evidence from a design or read_only run says so (doc 9 §5.2); it never stands for a live one.
        ...(this.o.mode && this.o.mode !== "live" ? { mode: this.o.mode } : {}),
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
  private async approval(call: Extract<Expr, { op: "call" }>, contract: string, criterion: string, ctx: Ctx, id: string, root: string): Promise<Obj> {
    const { named } = await this.args(call.args, ctx, id);
    const c = this.def(contract) as ContractDef;
    const subject = plain(c.params.map((p) => this.variable(p.name, ctx)));
    const role = named["role"] ?? null;
    const within = named["deadline"];
    // `distinct_from: q` (0.4): the wait says which earlier approval of this criterion its decider must differ from.
    const other = atLeast(this.o.program.language, "mandate/0.4") ? named["distinct_from"] : undefined;
    let decision: Value;
    try {
      decision = await this.wait(id, "decision", {
        contract,
        criterion,
        role,
        subject,
        subject_digest: digest("request", { contract, criterion, subject }),
        deadline: typeof within === "number" ? this.o.adapters.clock.now() + within : null,
        ...(typeof other === "string" ? { distinct_from: other, criterion_path: root } : {}),
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
    const key = e.idempotent_by ? plain(await this.expr(e.idempotent_by, ctx, `${path}/idempotent_by`)) : null;
    const mode = this.o.mode ?? "live";
    // A design run touches nothing: the effect is recorded as what it would have been (doc 9 §5.2).
    if (mode === "design") return this.simulated(e.name, plain(pos), path);
    const p = await this.prepareAction(e.name, info, pos, plain(pos), key, ctx, path);
    if (!p.action) return p.receipt;
    // A read_only run goes as far as prepare: the action is frozen and recorded as what would apply, never committed.
    if (mode === "read_only") return this.wouldApply(p.action);
    let action = p.action;
    const { journal, runId, fence } = this.o;
    let justCommitted = false;
    if (action.state === "prepared") {
      const authId = await this.authorization(e.name, info, action, path, undefined, this.environmentTier(e.name, e.args), this.governanceOf(action));
      action = await journal.commit(runId, fence, action.operation_key, authId);
      justCommitted = true;
      this.o.faults.check("after_commit", { id: path, kind: "effect" });
    }
    if (action.state === "dispatched") return this.dispatchAction(p.tool, action, justCommitted);
    return this.settledAction(action);
  }

  /**
   * Prepare (§8.8) for one external action at `path`: the adapter checks the
   * parameters and reads the files the action will apply; they are frozen
   * into the artifact store and the action digest, and the action is
   * recorded. In replay, the confirmed action's receipt (or ReplayEnd).
   * `extra` joins the digest: a change set member's set.
   */
  private async prepareAction(
    name: string,
    info: { params: TypeExpr[]; retryClass?: string },
    pos: Value[],
    params: Value,
    key: Value,
    ctx: Ctx,
    path: string,
    extra: Obj = {},
    /** A change set member's component: its files are checked against evidence keyed `<component>/<path>`. */
    component?: string,
  ): Promise<{ tool: ToolAdapter; action: ActionRow; receipt?: undefined } | { tool: ToolAdapter; action?: undefined; receipt: Value }> {
    // INV-13: a parameter declared Verified<T, C> must carry evidence for C at run time too.
    for (const [i, t] of info.params.entries()) {
      if (!("ref" in t) || t.ref !== "Verified") continue;
      const v = pos[i];
      const want = t.args?.[1] && "ref" in t.args[1] ? t.args[1].ref : undefined;
      if (!isObj(v) || !("$verified" in v) || (want && v["$contract"] !== want)) {
        throw new Fault("PolicyDenied", [{ effect: name, parameter: i, reason: "unverified_parameter" }]);
      }
      if (!this.o.replay) await this.checkVerified(name, v);
    }
    const tool = this.o.adapters.tools[name];
    if (!tool) throw new Violation("no_adapter", `No adapter for effect ${name}.`);
    const contract = tool.describe();
    // Prepare (§8.8): the adapter checks the parameters and reads the files the action will apply. They are frozen
    // into the artifact store, and the journaled command keeps their digests, so a resumed worker or a replay finds
    // the same action; execute later sends exactly these bytes.
    if (ctx.siblings?.failed && !this.o.replay && !(await this.o.journal.command(this.o.runId, `${path}/prepare`))) throw new SiblingStopped();
    const prepared = await this.command(`${path}/prepare`, "prepare", { effect: name, params }, undefined, async () => {
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
    if (Object.keys(files).length && !this.o.replay) await this.checkEvidenceFresh(name, files, evidence, component);
    // An action names the package it was prepared under (N04): the one its `prepare` command was recorded under, so
    // that an action prepared before an amendment is found again after it, and not prepared and run a second time.
    const actionDigest = digest("action", {
      package: (await this.under(`${path}/prepare`)).hash,
      run: this.o.runId,
      node: path,
      effect: name,
      adapter: contract.id,
      adapter_contract: contract.digest,
      params,
      evidence,
      idempotency_key: key,
      ...(Object.keys(files).length ? { artifacts: files } : {}),
      ...extra,
    });
    // In a sub-program an effect with a business key is one action across the whole `plan` (N07, INV-06): its
    // operation is named by the run, the plan, the effect and the key, and not by where the sub-program stands. A
    // second sub-program with the same effect and key finds the first one's action.
    const sub = this.o.sub;
    const shared = sub !== undefined && key !== null && !component;
    const operationKey = shared
      ? digest("operation", { tenant: this.o.policy.tenant, run: this.o.runId, node: sub.plan, effect: name, key })
      : digest("operation", { tenant: this.o.policy.tenant, run: this.o.runId, node: path, action: actionDigest });
    const { journal, runId, fence } = this.o;

    const action = await journal.action(operationKey);
    // The key names one action. The same key over other parameters is not that action and not a new one.
    if (shared && action && (action.effect !== name || canonical(action.params) !== canonical(params))) {
      throw new Fault("Rejected", ["idempotency_conflict", { effect: name, operation: operationKey, command: action.command_id }]);
    }
    if (this.o.replay) {
      if (action?.state === "confirmed") return { tool, receipt: action.receipt };
      throw new ReplayEnd(path, "no_result");
    }
    if (ctx.siblings?.failed && (!action || action.state === "prepared")) throw new SiblingStopped();
    if (action) return { tool, action };
    return {
      tool,
      action: await journal.prepare(runId, fence, {
        operationKey,
        commandId: path,
        effect: name,
        actionDigest,
        params,
        retryClass: info.retryClass ?? contract.retryClass,
        ...(Object.keys(frozen).length ? { artifacts: frozen } : {}),
      }),
    };
  }

  // ── change sets (0.3; design doc 9 §3) ────────────────────────────────

  /**
   * `changeset`: prepare → authorize → commit over one action per component.
   *
   *   prepare    each member in order, its files frozen and its digest bound
   *              to the component and the run's base commit; the set digest S
   *              covers the plan, the members' digests in order, the declared
   *              interface changes and the approver
   *   authorize  each component's owner approves its member (bound to the
   *              member's digest), then the set approver approves S
   *   commit     members in order; each needs its own authorization and S's,
   *              which the first commit consumes for this set only
   *
   * A member that is refused or whose outcome is unknown stops the set: the
   * members after it are not sent, and with any member already applied the
   * run stops for a person as `changeset_partial`, with the applied members
   * and the compensations they offer (§8.5: offered, never run). After
   * reconciliation the run goes on from where it stopped.
   */
  private async changeset(e: ChangesetExpr, ctx: Ctx, path: string): Promise<Value> {
    const plan = await this.expr(e.plan, ctx, `${path}/plan`);
    // INV-13 at run time: the plan was verified, and its evidence holds.
    if (!isObj(plan) || !("$verified" in plan)) throw new Fault("PolicyDenied", [{ changeset: path, reason: "unverified_plan" }]);
    if (!this.o.replay) await this.checkVerified("changeset", plan);
    const key = e.idempotent_by ? plain(await this.expr(e.idempotent_by, ctx, `${path}/idempotent_by`)) : null;
    const mode = this.o.mode ?? "live";
    // What the set lands and why, for its view (doc 9 §3.4, §8.2): recorded with the set in every mode.
    const summary: Obj = { plan: plain(plan), plan_digest: digest("request", plain(plan)), plan_evidence: evidenceOf(plan), order: e.order, changes: (e.changes ?? {}) as Value, approver: e.approver };
    // The set names the package its first member was prepared under, as each member's action does.
    const setOf = async (members: Value[]): Promise<{ setDigest: string; setKey: string }> => {
      const setDigest = digest("action", {
        changeset: path,
        package: (await this.under(`${path}/members/${e.order[0] ?? ""}/prepare`)).hash,
        run: this.o.runId,
        plan: summary["plan_digest"]!,
        plan_evidence: summary["plan_evidence"]!,
        members,
        changes: summary["changes"]!,
        approver: e.approver,
        idempotency_key: key,
      });
      return { setDigest, setKey: digest("operation", { tenant: this.o.policy.tenant, run: this.o.runId, node: path, set: setDigest }) };
    };
    if (mode === "design") {
      const sim: Obj = {};
      const recorded: Obj[] = [];
      for (const m of e.order) {
        const mem = e.members[m]!;
        const comp = this.def(m);
        const { pos } = await this.args(mem.args, ctx, `${path}/members/${m}`);
        sim[m] = await this.simulated(mem.effect, plain(pos), `${path}/members/${m}`);
        recorded.push({ component: m, effect: mem.effect, approver: mem.approver ?? (comp?.kind === "component" ? comp.owner : ""), evidence: evidenceOf(pos) });
      }
      if (!this.o.replay) {
        const { setDigest, setKey } = await setOf(recorded.map((r) => ({ component: r["component"]!, effect: r["effect"]! })));
        await this.o.journal.prepareChangeset(this.o.runId, this.o.fence, { setKey, commandId: path, setDigest, members: recorded, summary, state: "simulated" });
      }
      return { simulated: true, members: sim };
    }
    const members: Array<{ component: string; effect: string; approver: string; evidence: string[]; tool: ToolAdapter; action?: ActionRow; receipt?: Value }> = [];
    for (const m of e.order) {
      const mem = e.members[m]!;
      const comp = this.def(m);
      if (comp?.kind !== "component") throw new Violation("unknown_component", `No component '${m}'.`);
      const mp = `${path}/members/${m}`;
      const { pos } = await this.args(mem.args, ctx, mp);
      // The member names its component and the commit the run started from: an approval is for this change to this base.
      const target: Obj = { component: m, repo: comp.repo, root: comp.root, base: this.o.workspace?.[m]?.base ?? null };
      const p = await this.prepareAction(mem.effect, this.effectInfo(mem.effect), pos, [target, ...(plain(pos) as Value[])], key, ctx, mp, { changeset: path }, m);
      members.push({ component: m, effect: mem.effect, approver: mem.approver ?? comp.owner, evidence: evidenceOf(pos), tool: p.tool, ...(p.action ? { action: p.action } : { receipt: p.receipt }) });
    }
    const recorded = (): Value => members.map((m) => ({ component: m.component, effect: m.effect, operation: m.action!.operation_key, action_digest: m.action!.action_digest, approver: m.approver, evidence: m.evidence }));
    const { setDigest, setKey } = this.o.replay ? { setDigest: "", setKey: "" } : await setOf(members.map((m) => ({ component: m.component, effect: m.effect, action: m.action!.action_digest })));
    if (mode === "read_only") {
      // What the set would land: each member prepared and frozen, nothing approved or committed.
      const would: Obj = {};
      for (const m of members) would[m.component] = this.o.replay ? { would_apply: true, effect: m.effect } : await this.wouldApply(m.action!);
      if (!this.o.replay) await this.o.journal.prepareChangeset(this.o.runId, this.o.fence, { setKey, commandId: path, setDigest, members: recorded(), summary, state: "would_apply" });
      return { would_apply: true, members: would };
    }
    if (this.o.replay) return { members: Object.fromEntries(members.map((m) => [m.component, m.receipt ?? null])) };
    const { journal, runId, fence } = this.o;
    await journal.prepareChangeset(runId, fence, { setKey, commandId: path, setDigest, members: recorded(), summary });

    // Authorize: the owners, member by member, then the set approver.
    const memberAuth = new Map<string, string>();
    for (const m of members) {
      if (m.action!.state !== "prepared") continue;
      memberAuth.set(m.component, await this.authorization(m.effect, { irreversible: true }, m.action!, `${path}/members/${m.component}`, { role: m.approver, changeset: setDigest, component: m.component }, this.environmentTier(m.effect, e.members[m.component]!.args), this.governanceOf(m.action!, m.component)));
    }
    let setAuth: string | undefined;
    if (members.some((m) => m.action!.state === "prepared")) {
      const decision = await this.wait(`${path}/authorize`, "decision", {
        changeset: path,
        action_digest: setDigest,
        role: e.approver,
        order: e.order,
        changes: (e.changes ?? {}) as Value,
        members: members.map((m) => ({ component: m.component, effect: m.effect, action_digest: m.action!.action_digest, approver: m.approver, files: Object.keys(isObj(m.action!.artifacts ?? null) ? (m.action!.artifacts as Obj) : {}), governance: (this.governanceOf(m.action!, m.component)?.files ?? []) as unknown as Value })),
        deadline: null,
      });
      if (!isObj(decision) || decision["approved"] !== true) throw new Fault("Rejected", [{ changeset: path, denied_by: isObj(decision) ? (decision["by"] ?? null) : null }]);
      setAuth = String(decision["authorization_id"]);
    }

    // Commit, in order. What is already settled is not sent again.
    const receipts: Obj = {};
    for (let i = 0; i < members.length; i++) {
      const m = members[i]!;
      let action = m.action!;
      try {
        let fresh = false;
        if (action.state === "prepared") {
          action = await journal.commit(runId, fence, action.operation_key, memberAuth.get(m.component)!, { key: setKey, digest: setDigest, authorizationId: setAuth! });
          fresh = true;
          this.o.faults.check("after_commit", { id: `${path}/members/${m.component}`, kind: "changeset" });
        }
        receipts[m.component] = action.state === "dispatched" ? await this.dispatchAction(m.tool, action, fresh) : this.settledAction(action);
      } catch (f) {
        if (!(f instanceof Fault) && !(f instanceof Attention)) throw f;
        const applied = members.slice(0, i).map((x) => x.component);
        const now = (await journal.action(action.operation_key)) ?? action;
        const detail: Obj = {
          set: setDigest,
          applied: applied.map((c) => ({ component: c, receipt: receipts[c] ?? null })),
          stopped_at: { component: m.component, effect: m.effect, operation: now.operation_key, state: now.state, detail: now.detail ?? null },
          not_sent: members.slice(i + 1).map((x) => x.component),
          // §8.5: compensation is offered to a person, each its own prepare → authorize → commit; never run here.
          compensation: applied.flatMap((c) => {
            const offer = this.compensationOf(members.find((x) => x.component === c)!.effect);
            return offer ? [{ component: c, effect: offer, undoes: members.find((x) => x.component === c)!.action!.operation_key }] : [];
          }),
        };
        const unresolved = now.state === "unknown_outcome" || now.state === "dispatched";
        if (!applied.length && !unresolved) {
          // Nothing landed: the set simply failed.
          await journal.changesetState(runId, fence, setKey, "failed", detail);
          throw f;
        }
        await journal.changesetState(runId, fence, setKey, "partial", detail);
        throw new Attention({ changeset_partial: detail });
      }
    }
    await journal.changesetState(runId, fence, setKey, "committed", { set: setDigest });
    return { set_digest: setDigest, members: receipts };
  }

  private facts?: SystemFacts | null;

  /** The system model the program sees, with each component at the run's base commit; none without one. */
  private systemFacts(): SystemFacts | undefined {
    if (this.facts === undefined) {
      const components: SystemFacts["components"] = {};
      const interfaces: SystemFacts["interfaces"] = {};
      for (const [name, d] of Object.entries(this.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (d.kind === "component") {
          components[name] = { repo: d.repo, root: d.root, base: this.o.workspace?.[name]?.base ?? null, lang: d.lang, build: d.build ?? [], test: d.test ?? [], provides: d.provides ?? [], consumes: d.consumes ?? [] };
        }
      }
      for (const [name, d] of Object.entries(this.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (d.kind === "interface") interfaces[name] = { protocol: d.protocol, spec: d.spec, provider: Object.entries(components).find(([, c]) => c.provides.includes(name))?.[0] ?? null };
      }
      this.facts = Object.keys(components).length ? { components, interfaces } : null;
    }
    return this.facts ?? undefined;
  }

  /** A `design` run's effect: recorded as a command, nothing prepared, authorized or sent. */
  private simulated(effect: string, params: Value, path: string): Promise<Value> {
    return this.command(`${path}/simulated`, "simulate", { effect, params }, undefined, async () => ({ ok: { simulated: true, effect, params_digest: digest("request", params) }, cost: {} }));
  }

  /** A `read_only` run's effect: prepared and frozen, then recorded as what would apply. */
  private async wouldApply(action: ActionRow): Promise<Value> {
    if (action.state === "prepared") await this.o.journal.finishAction(this.o.runId, this.o.fence, action.operation_key, "would_apply", { detail: { mode: "read_only" } });
    return { would_apply: true, effect: action.effect, action_digest: action.action_digest, operation: action.operation_key };
  }

  /** The compensation an effect offers (§8.5), if it declares one. */
  private compensationOf(effect: string): string | undefined {
    const d = this.def(effect);
    if (d?.kind === "effect") return d.compensation;
    return STD_EFFECTS[effect]?.compensation;
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
   * the contract. With a verifier of its own, each must also be a check the
   * program declares for its criterion, attested by the verifier unless the
   * configuration checks its method here, and every part of a criterion
   * needs a record of its own method. A model or an agent can produce JSON
   * that looks like a Verified value; it never has such evidence.
   */
  private async checkVerified(effect: string, v: Obj): Promise<void> {
    const contract = String(v["$contract"] ?? "");
    const ids = Array.isArray(v["$evidence"]) ? v["$evidence"].map(String) : [];
    const rows = ids.length ? await this.o.journal.evidence(this.o.runId, ids) : [];
    // A person's approval holds only while the decision it names is the one they signed (H04).
    const approved = this.o.decisions;
    const decisions = approved && rows.some((r) => r.method === "human.approve") ? new Map((await this.o.journal.decisions(this.o.runId)).map((d) => [d.decision_id, d])) : new Map<string, StoredDecision>();
    const problems: string[] = [];
    const found = new Set(rows.map((r) => r.evidence_id));
    for (const id of ids) if (!found.has(id)) problems.push(`${id} is not evidence of this run`);
    const c = this.def(contract);
    // Which checks need their verifier's attestation is the configuration's to say, and which methods a criterion
    // uses is the program's: never the record's (attestation.ts recordProblem).
    const rule: AttestationRule = { keys: this.o.verifiers, inProcess: this.o.inProcess ?? new Set() };
    for (const r of rows) {
      const record = r.record as unknown as EvidenceRecord | null;
      if (!r.passed) problems.push(`${r.evidence_id} did not pass`);
      if (r.contract !== contract) problems.push(`${r.evidence_id} is evidence for ${r.contract}`);
      if (!record || !r.key_id || !r.signature || !this.o.trusted.verify(record, { key_id: r.key_id, signature: r.signature })) problems.push(`${r.evidence_id} is not signed by a trusted key`);
      else if (record.evidence_id !== r.evidence_id || record.passed !== r.passed || record.contract !== r.contract || record.criterion !== r.criterion) problems.push(`${r.evidence_id} does not match its signed record`);
      else {
        const why = recordProblem(record, { ...r, run: this.o.runId }, criterionMethods(c, record.criterion), rule) ?? (approved ? approvalProblem(record, decisions, approved.keys, approved.lock, approved.required) : undefined);
        if (why) problems.push(`${r.evidence_id}: ${why}`);
      }
    }
    const criteria = c?.kind === "contract" ? [...Object.keys(c.accept), ...Object.keys(c.invariant ?? {})] : [];
    if (c?.kind !== "contract") problems.push(`${contract} is not a contract of this program`);
    const covered = new Set(rows.filter((r) => r.passed).map((r) => r.criterion));
    for (const k of criteria) {
      if (!covered.has(k)) problems.push(`no evidence for ${contract}.${k}`);
      // With a verifier of its own, every part of a criterion needs a passing record of its own method: under `and`,
      // a static part's record does not stand for the verifier's check beside it.
      else if (attestationsRequired(rule)) {
        const passed = rows.filter((r) => r.passed && r.criterion === k).map((r) => r.method);
        for (const m of uncovered(criterionMethods(c, k) ?? [], passed)) problems.push(`no evidence by ${m} for ${contract}.${k}`);
      }
    }
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
  private async checkEvidenceFresh(effect: string, files: Record<string, string>, ids: string[], component?: string): Promise<void> {
    const rows = ids.length ? await this.o.journal.evidence(this.o.runId, ids) : [];
    const stale: string[] = [];
    for (const r of rows) {
      const checked = isObj(r.subject) && isObj(r.subject["files"] ?? null) ? (r.subject["files"] as Obj) : undefined;
      if (!checked) continue;
      for (const [file, d] of Object.entries(files)) {
        // Evidence about several components names each file under its component (boundary checks, B5).
        const p = component ? `${component}/${file}` : file;
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

  /**
   * authorize p by policy | human(role) (§8.8). A model or a program cannot
   * produce this. A change set member (`member`) is approved by its
   * component's owner unless the run's policy authorizes the effect itself.
   */
  /** The environment an effect's arguments name, and the tier it sets for that effect (doc 9 §5.3). */
  private environmentTier(effect: string, args: Arg[]): { environment: string; tier: Tier } | undefined {
    for (const a of args) {
      if (a.value.op !== "var") continue;
      const d = this.def(a.value.name);
      const tier = d?.kind === "environment" ? d.authorize?.[effect] : undefined;
      if (tier) return { environment: a.value.name, tier };
    }
    return undefined;
  }

  /**
   * The governance-class files an action carries (K70): CI workflows,
   * lockfiles, agent settings, the Mandate lock, CODEOWNERS, and a
   * component's own patterns. Their owner is the component's owner, or the
   * runtime's `owner` for an action outside a change set.
   */
  private governanceOf(action: ActionRow, component?: string): { files: Array<{ file: string; kind: string }>; owner: string } | undefined {
    const files = isObj(action.artifacts ?? null) ? Object.keys(action.artifacts as Obj) : [];
    if (!files.length) return undefined;
    const d = component ? this.def(component) : undefined;
    const c = d?.kind === "component" ? d : undefined;
    const found = governanceFiles(files, c?.governance ?? []);
    return found.length ? { files: found, owner: c?.owner ?? "owner" } : undefined;
  }

  private async authorization(
    effect: string,
    info: { irreversible: boolean },
    action: ActionRow,
    path: string,
    member?: { role: string; changeset: string; component: string },
    env?: { environment: string; tier: Tier },
    gov?: { files: Array<{ file: string; kind: string }>; owner: string },
  ): Promise<string> {
    const configured = this.o.policy.authorize?.[effect];
    // `approve E by r` in the run's envelope (spec/envelope.md): E is authorized only by a decision of role r, never by
    // policy, wherever in the run it happens. The runtime's configuration cannot name another role or hand it to
    // policy; a deadline it sets for the effect still applies, since a deadline only takes authority away.
    // The envelope is the one the action was prepared under: an action that waited for its role before an amendment
    // still waits for that role after it.
    const approve = (await this.under(`${path}/prepare`)).envelope?.approve;
    const owed = approve && Object.hasOwn(approve, effect) ? approve[effect] : undefined;
    // Who else the program names for this action: an environment's tier, and the approver of a change set's member.
    const named = [
      ...(env?.tier.by === "human" ? [{ role: env.tier.role, who: `environment ${env.environment}` }] : []),
      ...(member ? [{ role: member.role, who: `the change set's member ${member.component}` }] : []),
    ];
    const other = owed === undefined ? undefined : named.find((x) => x.role !== owed);
    if (other) {
      // Two rules name who decides, and neither gives way: the run stops for a person rather than pick one.
      throw new Violation("approval_conflict", `The envelope asks ${owed} to approve ${effect}, and ${other.who} asks ${other.role}. Name the same role in both.`);
    }
    const base: AuthorizePolicy =
      owed !== undefined
        ? { by: "human", role: owed, ...(configured?.by === "human" && configured.deadlineMs !== undefined ? { deadlineMs: configured.deadlineMs } : {}) }
        : (configured ?? (member ? { by: "human" as const, role: member.role } : info.irreversible ? { by: "human" as const, role: "owner" } : { by: "policy" as const }));
    // The environment's tier is the least that applies: a person's tier names who decides, and a policy tier never lowers the runtime's.
    let pol: AuthorizePolicy = env?.tier.by === "human" ? { ...base, by: "human" as const, role: env.tier.role } : base;
    // A governance-class file needs its owner (K70), and is never lowered: a policy becomes the owner's decision, and
    // another person's decision comes after the owner's own, both bound to the same action digest.
    const governance = gov ? (gov.files as unknown as Value) : undefined;
    if (gov && pol.by === "policy") pol = { by: "human", role: gov.owner };
    else if (gov && pol.by === "human" && pol.role !== gov.owner) {
      const gate = await this.wait(`${path}/governance`, "decision", {
        gate: "governance",
        effect,
        action_digest: action.action_digest,
        params: action.params,
        role: gov.owner,
        governance: governance!,
        then: pol.role,
        ...(member ? { changeset: member.changeset, component: member.component } : {}),
        deadline: null,
      });
      if (!isObj(gate) || gate["approved"] !== true) throw new Fault("Rejected", [{ denied_by: isObj(gate) ? (gate["by"] ?? null) : null, governance: governance! }]);
    }
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
      ...(member ? { changeset: member.changeset, component: member.component } : {}),
      ...(env ? { environment: env.environment, tier: env.tier as unknown as Value } : {}),
      ...(governance ? { governance } : {}),
      deadline: pol.deadlineMs === undefined ? null : this.o.adapters.clock.now() + pol.deadlineMs,
    });
    if (!isObj(decision) || decision["approved"] !== true) throw new Fault("Rejected", [{ denied_by: isObj(decision) ? (decision["by"] ?? null) : null, ...(governance ? { governance } : {}) }]);
    return String(decision["authorization_id"]);
  }
}

/**
 * The IR path of the node a command path stands at: the path without what a run adds to it, a loop's iteration
 * (`@i`), a restarted `par` round (`#allN`) and a map's item (`[i]`).
 */
function staticPath(path: string): string {
  return path.replace(/@\d+|#all\d+|\[\d+\]/g, "");
}

/** A delegation's budget less what its finished steps spent; dimensions never go below zero. */
function subtractCost(budget: Budget | undefined, spent: Record<string, number>): Budget | undefined {
  if (!budget) return undefined;
  const out: Budget = {};
  for (const dim of BUDGET_DIMENSIONS) {
    const amount = budgetAmount(budget, dim);
    // `time` is not reserved: a deadline holds it.
    if (amount === undefined || dim === "time") continue;
    const left = Math.max(amount - (spent[dim === "spend" ? `spend:${budget.spend!.currency}` : dim] ?? 0), 0);
    if (dim === "spend") out.spend = { micros: left, currency: budget.spend!.currency };
    else out[dim] = left;
  }
  return out;
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
