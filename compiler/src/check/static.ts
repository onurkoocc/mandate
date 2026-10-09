// Static checks for Mandate 0.1 (Doc 4 §5–§10; Gate 1).
//
// Runs after name resolution on a program whose names all resolve. One pass
// per definition types every expression, tracking for each value its type,
// how it is known (§5.2) and its data class (§5.5), and records which effects
// it uses. From that it checks:
//
//   types and epistemic rules   E0201–E0233   R1–R7, D1–D8, protected types
//   capabilities                E0301–E0320   coverage, narrowing, C5 disjoint writes
//   effects                     E0401–E0408   declared ⊇ used, critical, irreversible
//   budgets                     E0501–E0504   static upper bounds, bounded loops, step limits
//   contracts                   W0601, E0603  runtime fallback, review never alone
//   delegation                  E0701–E0713   C2, dynamic spawn, supervision
//
// Std calls the checker does not describe have unknown type and no effects,
// so missing knowledge never produces an error.

import { diag, ptr, type Diagnostic, type Span } from "../diag.js";
import type {
  AgentDef,
  Budget,
  ContractDef,
  Def,
  EffectDef,
  EffectRef,
  Expr,
  FnDef,
  Pattern,
  Program,
  Skill,
  Stmt,
  TypeExpr,
  Verifier,
  WorkflowDef,
} from "../ir/types.js";
import { nearestSpan } from "../ir/validate.js";
import { canonicalize } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import { LIMITS } from "../limits.js";
import {
  BUILTIN_EFFECTS,
  classRank,
  DATA_CLASSES,
  DECISION_POLICIES,
  MAX_CHOICE_OPTIONS,
  MAX_RESTARTS,
  OUT_OF_SCOPE_OPTIONS,
  PROTECTED_TYPES,
  STD_EFFECTS,
  STD_FNS,
  UNGATED_EFFECTS,
  type DataClass,
} from "../std/std.js";
import {
  calleePath,
  capAuthorizes,
  capCovers,
  capFromCall,
  scopeWithin,
  showCap,
  writesOverlap,
  type CapVal,
} from "./caps.js";
import {
  assignable,
  BOOL,
  epistemic,
  fieldsOf,
  fromTypeExpr,
  joinLevel,
  mentions,
  named,
  show,
  TEXT,
  UNKNOWN,
  unalias,
  withLevel,
  type Level,
  type Ty,
  type TypeEnv,
} from "./ty.js";

interface Val {
  ty: Ty;
  cls: DataClass;
}

interface Usage {
  effect: string;
  scope?: string[];
  /** For Model: the data class sent to the model. */
  cls?: DataClass;
  path: string;
}

interface Scope {
  vars: Map<string, Val>;
  parent?: Scope;
}

type Where = "workflow" | "fn" | "skill" | "contract" | "const" | "handler";

interface Frame {
  where: Where;
  def: string;
  scope: Scope;
  usages: Usage[];
  /** Capabilities available in this context; undefined in functions (checked at the call site). */
  avail?: CapVal[];
  /** Declared return type of the enclosing body. */
  returns?: Ty;
  /** A `human.approve` has run earlier in this body (E0405). */
  approved: boolean;
  /** Effective capabilities handed to delegates in this body (for W0310 and C5). */
  delegated: Array<{ caps: CapVal[]; path: string; external: boolean }>;
}

const PUBLIC: DataClass = "public";

export function staticCheck(program: Program, spans?: Map<string, Span>): Diagnostic[] {
  // Check the canonical form so that .mdt and .ir.json inputs of the same IR
  // report the same diagnostics in the same order.
  const canonical = JSON.parse(canonicalize(program as unknown as Json)) as Program;
  return new Checker(canonical, spans).run();
}

class Checker implements TypeEnv {
  private readonly out: Diagnostic[] = [];
  private readonly defs: Record<string, Def>;
  private readonly capDefs = new Map<string, CapVal>();
  private readonly fnUsage = new Map<string, Usage[] | "pending">();
  private readonly constVals = new Map<string, Val | "pending">();
  private readonly recursive = new Set<string>();

  constructor(
    private readonly program: Program,
    private readonly spans?: Map<string, Span>,
  ) {
    this.defs = program.defs;
  }

  // ── TypeEnv ────────────────────────────────────────────────────────────

  typeDef(name: string): Extract<Def, { kind: "type" }> | undefined {
    const d = this.def(name);
    return d && d.kind === "type" ? d : undefined;
  }
  isContract(name: string): boolean {
    return this.def(name)?.kind === "contract";
  }

  private def(name: string): Def | undefined {
    return Object.hasOwn(this.defs, name) ? this.defs[name] : undefined;
  }

  private ty(t: TypeExpr): Ty {
    return fromTypeExpr(t, this);
  }

  private report(code: string, message: string, path: string, facts?: Record<string, unknown>): void {
    const span = nearestSpan(this.spans, path);
    this.out.push(diag(code, message, span ? { path, span } : { path }, facts ? { facts } : {}));
  }

  private problem(p: { code: string; message: string } | undefined, path: string, facts?: Record<string, unknown>): void {
    if (p) this.report(p.code, p.message, path, facts);
  }

  // ── driver ─────────────────────────────────────────────────────────────

  run(): Diagnostic[] {
    for (const [name, d] of Object.entries(this.defs)) {
      if (d.kind === "capability") {
        const c = this.evalCap(d.value, ptr("defs", name, "value"));
        if (c) this.capDefs.set(name, { ...c, name });
      }
    }
    this.findRecursion();
    for (const [name, d] of Object.entries(this.defs)) {
      const base = ptr("defs", name);
      switch (d.kind) {
        case "type":
          break;
        case "const":
          this.constVal(name);
          break;
        case "fn":
          this.fnUsages(name);
          break;
        case "extern":
          this.checkExtern(name, d, base);
          break;
        case "effect":
          this.checkEffectDecl(name, d, base);
          break;
        case "agent":
          this.checkAgent(name, d, base);
          break;
        case "workflow":
          this.checkWorkflow(name, d, base);
          break;
        case "contract":
          this.checkContract(name, d, base);
          break;
        case "capability":
          break;
      }
    }
    return this.out;
  }

  // ── capabilities ───────────────────────────────────────────────────────

  /** Evaluates a capability expression: a name, a constructor call, or `cap.narrow(…)`. */
  private evalCap(e: Expr, path: string, frame: Frame = this.constFrame()): CapVal | undefined {
    if (e.op === "var") return this.capDefs.get(e.name);
    if (e.op === "call" && e.callee.op === "field" && e.callee.name === "narrow") {
      const base = this.evalCap(e.callee.of, `${path}/callee/of`, frame);
      if (!base) return undefined;
      const scope: string[] = [];
      let known = true;
      e.args.forEach((a, i) => {
        if (a.value.op === "text") scope.push(a.value.value);
        else {
          known = false;
          this.untrustedInCapArg(a.value, `${path}/args/${i}/value`, frame);
        }
      });
      // A scope known only at run time is intersected with the base then, so it
      // cannot widen; statically it is bounded by the base scope.
      if (!known) return { ...base };
      const narrowed: CapVal = { ...base, scope };
      if (!scopeWithin(base.ctor, narrowed.scope, base.scope)) {
        this.report("E0305", `narrow(${scope.map((s) => JSON.stringify(s)).join(", ")}) is not inside ${showCap(base)}; capabilities can only be narrowed.`, path, {
          base: showCap(base),
          requested: narrowed.scope ?? null,
        });
        return base;
      }
      return narrowed;
    }
    if (e.op === "call") {
      e.args.forEach((a, i) => this.untrustedInCapArg(a.value, `${path}/args/${i}/value`, frame));
      return capFromCall(e);
    }
    return undefined;
  }

  /** R5: untrusted content cannot pick a capability's scope. */
  private untrustedInCapArg(e: Expr, path: string, frame: Frame): void {
    if (e.op === "var" || e.op === "field") {
      const v = this.tryVal(e, frame);
      const lvl = v && epistemic(v.ty).level;
      if (lvl === "untrusted" || lvl === "inferred") {
        this.report("E0215", `${lvl === "untrusted" ? "Untrusted content" : "Model output"} cannot choose a capability's scope (R5).`, path, { level: lvl });
      }
    }
  }

  private tryVal(e: Expr, frame: Frame): Val | undefined {
    if (e.op === "var" && !this.lookup(e.name, frame.scope) && !this.def(e.name)) return undefined;
    return this.expr(e, frame, "");
  }

  private capList(list: Expr[], base: string): CapVal[] {
    const out: CapVal[] = [];
    list.forEach((c, i) => {
      const v = this.evalCap(c, `${base}/${i}`);
      if (v) out.push(v);
    });
    return out;
  }

  // ── definitions ────────────────────────────────────────────────────────

  private constFrame(): Frame {
    return { where: "const", def: "", scope: { vars: new Map() }, usages: [], approved: false, delegated: [] };
  }

  private constVal(name: string): Val {
    const cached = this.constVals.get(name);
    if (cached === "pending") return { ty: UNKNOWN, cls: PUBLIC };
    if (cached) return cached;
    this.constVals.set(name, "pending");
    const d = this.def(name) as Extract<Def, { kind: "const" }>;
    const base = ptr("defs", name);
    const v = this.expr(d.value, { ...this.constFrame(), def: name }, `${base}/value`);
    let out = v;
    if (d.type) {
      const t = this.ty(d.type);
      this.problem(assignable(v.ty, t, this), `${base}/value`);
      out = { ty: t, cls: v.cls };
    }
    this.constVals.set(name, out);
    return out;
  }

  private checkExtern(name: string, d: Extract<Def, { kind: "extern" }>, base: string): void {
    const p = mentions(this.ty(d.returns), PROTECTED_TYPES);
    if (p) this.report("E0213", `Host code cannot produce ${p}; only the runtime does (§12.3).`, `${base}/returns`, { type: p });
    this.effectNames(d.effects, `${base}/effects`);
  }

  private checkEffectDecl(name: string, d: EffectDef, base: string): void {
    if (d.critical && !d.idempotency_required) {
      this.report("E0403", `Critical effect '${name}' must declare 'idempotency required'.`, base);
    }
    if (d.critical || d.irreversible) {
      d.params.forEach((p, i) => {
        const lvl = epistemic(this.ty(p.type)).level;
        if (lvl === "inferred" || lvl === "untrusted") {
          this.report("E0210", `Critical effect '${name}' cannot take ${show(this.ty(p.type))}; critical parameters take only T or Verified<T> (R4).`, `${base}/params/${i}/type`);
        }
      });
    }
  }

  private effectNames(effects: EffectRef[], base: string): void {
    effects.forEach((e, i) => {
      if (BUILTIN_EFFECTS.has(e.effect) || STD_EFFECTS[e.effect] || this.def(e.effect)?.kind === "effect") return;
      this.report("E0402", `Unknown effect '${e.effect}'.`, `${base}/${i}/effect`, { known: [...BUILTIN_EFFECTS] });
    });
  }

  private effectScope(e: EffectRef): string[] | undefined {
    if (!e.args?.length) return undefined;
    const out: string[] = [];
    for (const a of e.args) {
      if (a.value.op !== "text") return undefined;
      out.push(a.value.value);
    }
    return out;
  }

  private isCriticalEffect(name: string): boolean {
    const d = this.def(name);
    if (d?.kind === "effect") return !!(d.critical || d.irreversible);
    return !!STD_EFFECTS[name]?.critical;
  }

  private checkAgent(name: string, d: AgentDef, base: string): void {
    const caps = this.capList(d.caps, `${base}/caps`);
    const used = new Set<CapVal>();
    for (const [sn, s] of Object.entries(d.skills)) {
      const sb = `${base}/skills/${sn}`;
      const ret = this.ty(s.returns);
      const p = mentions(ret, PROTECTED_TYPES);
      if (p) this.report("E0213", `Skill '${name}.${sn}' cannot return ${p}; a model cannot produce ${p} (§5.2, S08).`, `${sb}/returns`, { type: p });
      this.effectNames(s.effects, `${sb}/effects`);
      if (d.remote) continue;
      s.effects.forEach((e, i) => {
        if (UNGATED_EFFECTS.has(e.effect)) return;
        if (this.isCriticalEffect(e.effect)) {
          this.report("E0408", `Skill '${name}.${sn}' declares the critical effect '${e.effect}'. External writes happen only in a workflow's commit step, never inside a delegated task.`, `${sb}/effects/${i}`);
          return;
        }
        const need = this.requiredCap(e.effect);
        const scope = this.effectScope(e);
        const by = caps.filter((c) => (need ? c.ctor === need : capAuthorizes(c, e.effect, scope)));
        by.forEach((c) => used.add(c));
        if (!by.length) {
          this.report("E0301", `${name}.${sn} uses ${e.effect}${scope ? `(${scope.join(", ")})` : ""}, but ${name} holds no capability for it.`, `${sb}/effects/${i}`, {
            required: e.effect,
            available: caps.map(showCap),
          });
        }
      });
      if (!s.body) {
        if (s.budget?.steps === undefined && d.budget?.steps === undefined) {
          this.report("E0503", `Skill '${name}.${sn}' runs as an agent loop but neither it nor ${name} sets a 'steps' budget (§8.2).`, sb);
        }
      } else {
        const frame = this.bodyFrame("skill", `${name}.${sn}`, s.params, caps, ret);
        this.body(s.body, frame, `${sb}/body`, true);
        this.checkUsagesDeclared(frame.usages, s.effects, `${name}.${sn}`);
        frame.usages.forEach((u) => this.capsFor(u, caps).forEach((c) => used.add(c)));
      }
    }
    if (!d.remote) {
      caps.forEach((c, i) => {
        if (!used.has(c)) this.report("W0310", `${name} holds ${showCap(c)} but no skill uses it.`, `${base}/caps/${i}`);
      });
    }
  }

  private requiredCap(effect: string): string | undefined {
    const d = this.def(effect);
    if (d?.kind === "effect") {
      const req = d.requires_caps?.[0];
      if (req && req.op === "call") return calleePath(req.callee);
      return undefined;
    }
    return STD_EFFECTS[effect]?.cap;
  }

  private capsFor(u: Usage, caps: CapVal[]): CapVal[] {
    const need = this.requiredCap(u.effect);
    return caps.filter((c) => (need ? c.ctor === need : capAuthorizes(c, u.effect, u.scope)));
  }

  private checkUsagesDeclared(usages: Usage[], declared: EffectRef[], who: string): void {
    for (const u of usages) {
      if (u.effect === "Delegate") continue;
      const ok = declared.some(
        (d) => d.effect === u.effect && (u.scope === undefined || this.effectScope(d) === undefined || scopeWithin("fs.", u.scope, this.effectScope(d))),
      );
      if (!ok) {
        this.report("E0401", `${who} uses effect ${u.effect} but does not declare it.`, u.path, {
          used: u.effect,
          declared: declared.map((d) => d.effect),
        });
      }
    }
  }

  private bodyFrame(where: Where, def: string, params: { name: string; type: TypeExpr }[], avail: CapVal[] | undefined, returns?: Ty): Frame {
    const vars = new Map<string, Val>();
    params.forEach((p) => {
      const ty = this.ty(p.type);
      vars.set(p.name, { ty, cls: this.typeClass(ty) });
    });
    const f: Frame = { where, def, scope: { vars }, usages: [], approved: false, delegated: [] };
    if (avail) f.avail = avail;
    if (returns) f.returns = returns;
    return f;
  }

  /** Effects a function uses, typing its body on first request. */
  private fnUsages(name: string): Usage[] {
    const cached = this.fnUsage.get(name);
    if (cached === "pending") return [];
    if (cached) return cached;
    this.fnUsage.set(name, "pending");
    const d = this.def(name) as FnDef;
    const base = ptr("defs", name);
    const frame = this.bodyFrame("fn", name, d.params, undefined, this.ty(d.returns));
    this.body(d.body, frame, `${base}/body`, true);
    if (d.effects) {
      this.effectNames(d.effects, `${base}/effects`);
      this.checkUsagesDeclared(frame.usages, d.effects, `fn ${name}`);
    } else if (d.pub) {
      this.report("E0401", `Public function '${name}' must declare its effects with '! { … }' (§6.2).`, base);
    }
    this.fnUsage.set(name, frame.usages);
    return frame.usages;
  }

  private checkWorkflow(name: string, d: WorkflowDef, base: string): void {
    const caps = this.capList(d.caps, `${base}/caps`);
    const frame = this.bodyFrame("workflow", name, d.params, caps, this.ty(d.returns));
    if (d.ensures) {
      this.expectBool(this.expr(d.ensures, this.child(frame, new Map([["result", { ty: frame.returns!, cls: PUBLIC }]])), `${base}/ensures`), `${base}/ensures`);
    }
    this.body(d.body, frame, `${base}/body`, true);
    (d.on ?? []).forEach((h, i) => this.expr(h.then, { ...frame, where: "handler" }, `${base}/on/${i}/then`));

    // Every effect the body uses directly must be authorized by the workflow's capabilities.
    const used = new Set<CapVal>();
    for (const u of frame.usages) {
      if (UNGATED_EFFECTS.has(u.effect)) continue;
      const by = this.capsFor(u, caps);
      by.forEach((c) => used.add(c));
      if (!by.length) {
        this.report("E0301", `${name} uses ${u.effect}${u.scope ? `(${u.scope.join(", ")})` : ""}, but no capability in its caps authorizes it.`, u.path, {
          required: u.effect,
          available: caps.map(showCap),
        });
        continue;
      }
      if (u.effect === "Model" && u.cls) {
        const best = Math.max(...by.map((c) => classRank(c.maxClass ?? "internal")));
        if (classRank(u.cls) > best) {
          this.report("E0220", `${u.cls} data is sent to a model whose capability allows at most ${DATA_CLASSES[best]}.`, u.path, {
            data_class: u.cls,
            allowed: DATA_CLASSES[best],
          });
        }
      }
    }
    for (const dl of frame.delegated) for (const c of dl.caps) for (const w of caps) if (capCovers(w, c)) used.add(w);
    caps.forEach((c, i) => {
      if (!used.has(c)) this.report("W0310", `${name} holds ${showCap(c)} but neither its body nor its delegates use it.`, `${base}/caps/${i}`);
    });

    this.checkBudget(name, d, base);
    const nodes = this.countNodes(d.body, new Set());
    if (nodes > LIMITS.expandedNodes) {
      this.report("E0105", `${name} expands to ${nodes} static nodes; the 0.1 limit is ${LIMITS.expandedNodes}.`, base, { nodes, limit: LIMITS.expandedNodes });
    }
  }

  private checkContract(name: string, d: ContractDef, base: string): void {
    // Contract parameters are the subjects under test: they may hold unverified values.
    const frame = this.bodyFrame("contract", name, d.params, undefined);
    (d.require ?? []).forEach((r, i) => this.expectBool(this.expr(r, frame, `${base}/require/${i}`), `${base}/require/${i}`));
    for (const group of ["accept", "invariant"] as const) {
      for (const [cn, c] of Object.entries(d[group] ?? {})) this.verifier(c.by, frame, `${base}/${group}/${cn}/by`, `${name}.${cn}`);
    }
  }

  private verifier(v: Verifier, frame: Frame, path: string, who: string): void {
    const parts = "all" in v ? v.all : [v];
    const reviews = parts.filter((p) => "call" in p && p.call.op === "call" && calleePath(p.call.callee) === "review").length;
    if (reviews === parts.length) {
      this.report("E0603", `${who} is satisfied only by review(…). A second model agreeing is not evidence; pair it with a static check, a test or a human (§10.2).`, path);
    }
    parts.forEach((p, i) => {
      const pp = "all" in v ? `${path}/all/${i}` : path;
      if ("static" in p) {
        this.expectBool(this.expr(p.static, frame, `${pp}/static`), `${pp}/static`);
        if (p.static.op !== "bool") {
          this.report("W0601", `${who}: this static criterion cannot be proved at compile time; it becomes a run-time check (§10.2).`, `${pp}/static`);
        }
      } else if ("call" in p) {
        this.expr(p.call, frame, `${pp}/call`);
      }
    });
  }

  // ── recursion (S04) ────────────────────────────────────────────────────

  private findRecursion(): void {
    const calls = new Map<string, Set<string>>();
    for (const [name, d] of Object.entries(this.defs)) {
      if (d.kind !== "fn" && d.kind !== "workflow") continue;
      const set = new Set<string>();
      walkExprs(d.body, (e) => {
        if (e.op === "call" && e.callee.op === "var") {
          const t = this.def(e.callee.name);
          if (t && (t.kind === "fn" || t.kind === "workflow")) set.add(e.callee.name);
        }
      });
      calls.set(name, set);
    }
    const state = new Map<string, "open" | "done">();
    const visit = (n: string, stack: string[]): void => {
      if (state.get(n) === "done") return;
      if (state.get(n) === "open") {
        const cycle = stack.slice(stack.indexOf(n));
        for (const c of cycle) this.recursive.add(c);
        this.report("E0502", `Recursive call cycle ${[...cycle, n].join(" → ")}; static node and budget bounds need an acyclic call graph.`, ptr("defs", n), { cycle });
        return;
      }
      state.set(n, "open");
      for (const m of calls.get(n) ?? []) visit(m, [...stack, n]);
      state.set(n, "done");
    };
    for (const n of calls.keys()) visit(n, []);
  }

  // ── statements ─────────────────────────────────────────────────────────

  private child(frame: Frame, vars = new Map<string, Val>()): Frame {
    return { ...frame, scope: { vars, parent: frame.scope } };
  }

  private lookup(name: string, scope: Scope | undefined): Val | undefined {
    for (let s = scope; s; s = s.parent) {
      const v = s.vars.get(name);
      if (v) return v;
    }
    return undefined;
  }

  /**
   * Types a block and returns the value of its last expression statement.
   * When `result` is set the block is a definition's body, so that value is
   * what the definition returns and must match its declared return type.
   */
  private body(stmts: Stmt[], outer: Frame, base: string, result = false): Val {
    let frame = this.child(outer);
    let last: Val = { ty: UNKNOWN, cls: PUBLIC };
    stmts.forEach((s, i) => {
      const path = `${base}/${i}`;
      last = { ty: UNKNOWN, cls: PUBLIC };
      switch (s.op) {
        case "let": {
          const v = this.expr(s.value, frame, `${path}/value`);
          let bound = v;
          if (s.type) {
            const t = this.ty(s.type);
            this.problem(assignable(v.ty, t, this), `${path}/value`);
            bound = { ty: t, cls: v.cls };
          }
          frame = this.child(frame, new Map([[s.name, bound]]));
          break;
        }
        case "par":
          frame = this.child(frame, this.par(s, frame, path));
          break;
        case "if": {
          this.expectBool(this.expr(s.cond, frame, `${path}/cond`), `${path}/cond`);
          this.body(s.then, frame, `${path}/then`);
          if (s.else) this.body(s.else, frame, `${path}/else`);
          break;
        }
        case "loop":
          if (s.max_iter === undefined && s.until === undefined) {
            this.report("E0502", "A loop needs 'max_iter' or 'until' (§8.6).", path);
          }
          if (s.until) this.expectBool(this.expr(s.until, frame, `${path}/until`), `${path}/until`);
          this.body(s.body, frame, `${path}/body`);
          break;
        case "return": {
          const v = s.value ? this.expr(s.value, frame, `${path}/value`) : { ty: UNKNOWN, cls: PUBLIC };
          if (frame.returns && s.value) this.problem(assignable(v.ty, frame.returns, this), `${path}/value`);
          break;
        }
        case "on_error": {
          if (s.pattern.p === "tag" && s.pattern.tag === "UnknownOutcome") {
            const strategy = s.then.op === "call" ? calleePath(s.then.callee) : s.then.op === "var" ? s.then.name : undefined;
            if (strategy !== "reconcile") {
              this.report("E0712", "UnknownOutcome can only be handled with reconcile; restarting could repeat an external effect (§8.7, V06).", `${path}/then`);
            }
          }
          const binds = new Map<string, Val>();
          patternVars(s.pattern).forEach((n) => binds.set(n, { ty: UNKNOWN, cls: PUBLIC }));
          this.expr(s.then, this.child(frame, binds), `${path}/then`);
          break;
        }
        case "run":
          this.expr(s.target, frame, `${path}/target`);
          break;
        case "expr":
          last = this.expr(s.value, frame, `${path}/value`);
          break;
      }
    });
    const tail = stmts[stmts.length - 1];
    if (result && tail && tail.op === "expr" && outer.returns) {
      this.problem(assignable(last.ty, outer.returns, this), `${base}/${stmts.length - 1}/value`);
    }
    return last;
  }

  private par(s: Extract<Stmt, { op: "par" }>, frame: Frame, path: string): Map<string, Val> {
    const out = new Map<string, Val>();
    const writes: Array<{ branch: string; caps: CapVal[] }> = [];
    let external = false;
    for (const [bn, e] of Object.entries(s.branches)) {
      const before = frame.delegated.length;
      const usagesBefore = frame.usages.length;
      // Each branch sees the scope before the par, never a sibling's result.
      out.set(bn, this.expr(e, frame, `${path}/branches/${bn}`));
      const delegated = frame.delegated.slice(before);
      const branchCaps = delegated.flatMap((d) => d.caps);
      for (const u of frame.usages.slice(usagesBefore)) {
        if (frame.avail) branchCaps.push(...this.capsFor(u, frame.avail).filter((c) => c.write));
        if (this.isCriticalEffect(u.effect)) external = true;
      }
      if (delegated.some((d) => d.external)) external = true;
      writes.push({ branch: bn, caps: branchCaps.filter((c) => c.write) });
    }
    for (let i = 0; i < writes.length; i++) {
      for (let j = i + 1; j < writes.length; j++) {
        const a = writes[i]!;
        const b = writes[j]!;
        for (const ca of a.caps) {
          for (const cb of b.caps) {
            if (writesOverlap(ca, cb)) {
              this.report(
                "E0320",
                `par branches '${a.branch}' and '${b.branch}' can both write ${overlapText(ca, cb)}; write scopes in a par block must be disjoint (C5).`,
                `${path}/branches/${b.branch}`,
                { branches: [a.branch, b.branch], left: showCap(ca), right: showCap(cb) },
              );
            }
          }
        }
      }
    }
    if (s.supervise?.name === "restart_all" && external) {
      this.report("E0710", "restart_all would restart branches that have external effects; children must use their own retry classes (§8.7).", `${path}/supervise`);
    }
    if (s.supervise) this.supervise(s.supervise, `${path}/supervise`, { kind: "par" });
    return out;
  }

  /**
   * Supervision strategies (§8.7). A `par` block takes fail_fast or
   * restart_all; a delegation takes restart(max, backoff), escalate(human)
   * or degrade(to: Fallback). A strategy the runtime does not know is an
   * error, never ignored (E0714). A fallback must do the same job with no
   * more authority: the same skill signature, capabilities inside the
   * original agent's, and the ones the call hands over (E0715).
   */
  private supervise(
    c: { name: string; args?: { name?: string; value: Expr }[] },
    path: string,
    site: { kind: "par" } | { kind: "delegate"; agent: string; skill: string; given: CapVal[] },
  ): void {
    const allowed = site.kind === "par" ? ["fail_fast", "restart_all"] : ["restart", "escalate", "degrade"];
    if (!allowed.includes(c.name)) {
      this.report("E0714", `'${c.name}' is not a supervision strategy for ${site.kind === "par" ? "a par block" : "a delegation"}; use ${allowed.join(", ")} (§8.7).`, path, { strategy: c.name, allowed });
      return;
    }
    const args = c.args ?? [];
    if (c.name === "restart") {
      const max = args.find((a) => a.name === "max")?.value;
      if (max && max.op === "int" && max.value > MAX_RESTARTS) {
        this.report("E0713", `restart(max: ${max.value}) exceeds the limit of ${MAX_RESTARTS} retries (§8.7).`, path);
      }
    }
    if (c.name === "escalate") {
      const ok = args.length >= 1 && args[0]!.name === undefined && args[0]!.value.op === "var" && args[0]!.value.name === "human" && args.slice(1).every((a) => a.name === "role" && a.value.op === "text");
      if (!ok) this.report("E0714", "escalate takes a person: escalate(human) or escalate(human, role: \"…\") (§8.7).", path);
    }
    if (c.name === "degrade" && site.kind === "delegate") {
      const to = args.find((a) => a.name === "to")?.value;
      const name = to?.op === "var" ? to.name : undefined;
      const fallback = name ? this.def(name) : undefined;
      const problems: string[] = [];
      if (!name || !fallback || fallback.kind !== "agent") {
        this.report("E0715", "degrade names its fallback agent: degrade(to: Agent) (§8.7).", path);
        return;
      }
      const original = this.def(site.agent);
      const want = original?.kind === "agent" ? original.skills[site.skill] : undefined;
      const have = Object.hasOwn(fallback.skills, site.skill) ? fallback.skills[site.skill] : undefined;
      if (!have) problems.push(`${name} has no skill ${site.skill}`);
      else if (want && canonicalize({ params: want.params.map((p) => p.type), returns: want.returns } as unknown as Json) !== canonicalize({ params: have.params.map((p) => p.type), returns: have.returns } as unknown as Json)) {
        problems.push(`${name}.${site.skill} has another signature than ${site.agent}.${site.skill}`);
      }
      const fallbackCaps = this.capList(fallback.caps, ptr("defs", name, "caps"));
      const originalCaps = original?.kind === "agent" ? this.capList(original.caps, ptr("defs", site.agent, "caps")) : [];
      for (const fc of fallbackCaps) if (!originalCaps.some((oc) => capCovers(oc, fc))) problems.push(`${name} holds ${showCap(fc)}, which ${site.agent} does not`);
      for (const g of site.given) if (!fallbackCaps.some((fc) => capCovers(fc, g))) problems.push(`${name} does not hold ${showCap(g)}, which this call hands over`);
      if (problems.length) {
        this.report("E0715", `degrade to ${name} would not do the same job with no more authority: ${problems.join("; ")} (§8.7).`, path, { fallback: name, problems });
      }
    }
  }

  // ── expressions ────────────────────────────────────────────────────────

  private expectBool(v: Val, path: string): void {
    this.problem(assignable(v.ty, BOOL, this), path);
  }

  private typeClass(ty: Ty, seen = new Set<string>()): DataClass {
    let best: DataClass = PUBLIC;
    const bump = (c: DataClass): void => {
      if (classRank(c) > classRank(best)) best = c;
    };
    if (ty.k === "named") {
      const d = this.typeDef(ty.name);
      if (d && !seen.has(ty.name)) {
        seen.add(ty.name);
        if (d.class) bump(d.class);
        bump(this.typeClass(fromTypeExpr(d.type, this), seen));
      }
      ty.args.forEach((a) => bump(this.typeClass(a, seen)));
    } else if (ty.k === "record") {
      Object.values(ty.fields).forEach((f) => bump(this.typeClass(f, seen)));
    }
    return best;
  }

  private maxClass(...cs: DataClass[]): DataClass {
    return cs.reduce((a, b) => (classRank(b) > classRank(a) ? b : a), PUBLIC);
  }

  private use(frame: Frame, u: Usage): void {
    frame.usages.push(u);
  }

  private expr(e: Expr, frame: Frame, path: string): Val {
    const v = this.exprInner(e, frame, path);
    return { ty: v.ty, cls: this.maxClass(v.cls, this.typeClass(v.ty)) };
  }

  private exprInner(e: Expr, frame: Frame, path: string): Val {
    const lit = (ty: Ty): Val => ({ ty, cls: PUBLIC });
    switch (e.op) {
      case "int":
        return lit(named("Int"));
      case "dec":
        return lit(named("Dec"));
      case "text":
        return lit(TEXT);
      case "bool":
        return lit(BOOL);
      case "money":
        return lit(named("Money"));
      case "duration":
        return lit(named("Duration"));
      case "list":
      case "set": {
        const items = e.items.map((x, i) => this.expr(x, frame, `${path}/items/${i}`));
        return { ty: named(e.op === "list" ? "List" : "Set", items[0]?.ty ?? UNKNOWN), cls: this.maxClass(...items.map((x) => x.cls)) };
      }
      case "template": {
        const parts = e.parts.map((p, i) => ("expr" in p ? this.expr(p.expr, frame, `${path}/parts/${i}/expr`).cls : PUBLIC));
        return { ty: TEXT, cls: this.maxClass(...parts) };
      }
      case "prompt":
        return this.prompt(e, frame, path);
      case "var": {
        const v = this.lookup(e.name, frame.scope);
        if (v) return v;
        const d = this.def(e.name);
        if (d?.kind === "const") return this.constVal(e.name);
        if (d?.kind === "capability") return lit(named("Capability"));
        return lit(UNKNOWN);
      }
      case "field":
        return this.field(e, frame, path);
      case "call":
        return this.call(e, frame, path);
      case "unary": {
        const v = this.expr(e.of, frame, `${path}/of`);
        const lvl = epistemic(v.ty).level;
        if (e.uop === "not") return { ty: withLevel(BOOL, lvl === "verified" ? "plain" : lvl), cls: v.cls };
        return v;
      }
      case "binary": {
        const l = this.expr(e.left, frame, `${path}/left`);
        const r = this.expr(e.right, frame, `${path}/right`);
        const lvl = joinLevel(epistemic(l.ty).level, epistemic(r.ty).level);
        const cls = this.maxClass(l.cls, r.cls);
        const arith = e.bop === "+" || e.bop === "-" || e.bop === "*" || e.bop === "/";
        return { ty: withLevel(arith ? epistemic(l.ty).inner : BOOL, lvl), cls };
      }
      case "range":
        this.expr(e.from, frame, `${path}/from`);
        this.expr(e.to, frame, `${path}/to`);
        return lit(UNKNOWN);
      case "record":
        return this.record(e, frame, path);
      case "infer":
        return this.infer(e, frame, path);
      case "delegate":
        return this.delegate(e, frame, path);
      case "spawn": {
        this.report("E0711", "Dynamic spawn is not available in 0.1; use delegate, par, or a bounded map (§9.1, V05).", path);
        e.args.forEach((a, i) => this.expr(a.value, frame, `${path}/args/${i}/value`));
        return lit(UNKNOWN);
      }
      case "await":
        this.expr(e.of, frame, `${path}/of`);
        return lit(UNKNOWN);
      case "verify":
        return this.verify(e, frame, path);
      case "effect":
        return this.effectCall(e, frame, path);
      case "escalate":
        this.expr(e.to, frame, `${path}/to`);
        return lit(UNKNOWN);
      case "pause":
        if (e.then) this.expr(e.then, frame, `${path}/then`);
        return lit(UNKNOWN);
      case "switch":
        return this.switchExpr(e, frame, path);
      case "try": {
        const v = this.expr(e.of, frame, `${path}/of`);
        const ep = epistemic(v.ty);
        const inner = ep.inner.k === "named" && ep.inner.name === "Result" ? (ep.inner.args[0] ?? UNKNOWN) : UNKNOWN;
        return { ty: withLevel(inner, ep.level === "verified" ? "plain" : ep.level), cls: v.cls };
      }
      case "block":
        return this.body(e.body, frame, `${path}/body`);
    }
  }

  private prompt(e: Extract<Expr, { op: "prompt" }>, frame: Frame, path: string): Val {
    let cls: DataClass = PUBLIC;
    e.parts.forEach((p, i) => {
      if (!("expr" in p)) return;
      const pp = `${path}/parts/${i}/expr`;
      const isQuote = p.expr.op === "call" && calleePath(p.expr.callee) === "quote";
      const v = this.expr(p.expr, frame, pp);
      cls = this.maxClass(cls, v.cls);
      const lvl = epistemic(v.ty).level;
      if (!isQuote && (lvl === "untrusted" || lvl === "inferred")) {
        this.report(
          "E0215",
          `${lvl === "untrusted" ? "Untrusted content" : "Model output"} cannot appear in the instruction part of a prompt; pass it as data with quote(…) (R5, §5.4).`,
          pp,
          { level: lvl },
        );
      }
    });
    return { ty: named("Prompt"), cls };
  }

  private field(e: Extract<Expr, { op: "field" }>, frame: Frame, path: string): Val {
    // Module members (fs.read, human.ask) are not values with fields.
    if (calleePath(e) && this.isModuleRoot(e, frame)) return { ty: UNKNOWN, cls: PUBLIC };
    const base = this.expr(e.of, frame, `${path}/of`);
    const ep = epistemic(base.ty);
    const fields = fieldsOf(ep.inner, this);
    if (!fields) return { ty: withLevel(UNKNOWN, ep.level === "verified" ? "plain" : ep.level), cls: base.cls };
    const f = fields[e.name];
    if (!f) {
      this.report("E0202", `${show(ep.inner)} has no field '${e.name}'.`, path, { type: show(ep.inner), fields: Object.keys(fields) });
      return { ty: UNKNOWN, cls: base.cls };
    }
    return { ty: withLevel(f, ep.level === "verified" ? "plain" : ep.level), cls: base.cls };
  }

  private isModuleRoot(e: Expr, frame: Frame): boolean {
    let cur = e;
    while (cur.op === "field") cur = cur.of;
    if (cur.op !== "var") return false;
    if (this.lookup(cur.name, frame.scope)) return false;
    const d = this.def(cur.name);
    return !d && (this.program.uses ?? []).some((u) => u.names?.includes(cur.name as string) || u.module.split(".").pop() === cur.name);
  }

  private call(e: Extract<Expr, { op: "call" }>, frame: Frame, path: string): Val {
    const p = calleePath(e.callee);
    const args = e.args.map((a, i) => this.expr(a.value, frame, `${path}/args/${i}/value`));
    const cls = this.maxClass(...args.map((a) => a.cls));
    const d = p && !p.includes(".") && !this.lookup(p, frame.scope) ? this.def(p) : undefined;

    if (d?.kind === "fn") {
      if (args.length !== d.params.length) {
        this.report("E0201", `${p} takes ${d.params.length} argument(s) but got ${args.length}.`, path);
      }
      d.params.forEach((param, i) => {
        const a = args[i];
        if (a) this.problem(assignable(a.ty, this.ty(param.type), this), `${path}/args/${i}/value`);
      });
      for (const u of this.fnUsages(p!)) this.use(frame, { ...u, path, ...(u.effect === "Model" ? { cls: this.maxClass(cls, u.cls ?? PUBLIC) } : {}) });
      return { ty: this.ty(d.returns), cls };
    }
    if (p === "quote") return { ty: TEXT, cls };
    if (p === "len") return { ty: named("Int"), cls };
    if (p === "peek") {
      this.report("W0207", "peek(…) reads model output as a plain value; use it only for read-only, effect-free inspection (R7).", path);
      const ep = epistemic(args[0]?.ty ?? UNKNOWN);
      return { ty: ep.inner, cls };
    }
    if (p && DECISION_POLICIES.has(p) && args[0]) {
      const ep = epistemic(args[0].ty);
      const dec = ep.inner.k === "named" && ep.inner.name === "Decision" ? (ep.inner.args[0] ?? UNKNOWN) : UNKNOWN;
      return { ty: named("DecisionOutcome", dec), cls };
    }
    if (p && STD_FNS[p] && this.isModuleRoot(e.callee, frame)) {
      const f = STD_FNS[p]!;
      for (const eff of f.effects) this.use(frame, { effect: eff, path });
      if (p === "human.approve") {
        frame.approved = true;
        // An approval may wait at most `deadline`; past it the approval is not given (§8.8, R15).
        const i = e.args.findIndex((a) => a.name === "deadline");
        if (i >= 0) this.problem(assignable(args[i]!.ty, named("Duration"), this), `${path}/args/${i}/value`);
      }
      return { ty: this.ty(f.returns), cls };
    }
    if (e.callee.op === "field" && e.callee.name === "narrow") {
      this.evalCap(e, path, frame);
      return { ty: named("Capability"), cls };
    }
    return { ty: UNKNOWN, cls };
  }

  private record(e: Extract<Expr, { op: "record" }>, frame: Frame, path: string): Val {
    if (PROTECTED_TYPES.has(e.type)) {
      this.report("E0213", `${e.type} cannot be constructed by a program; only the runtime produces it (§5.2, S08).`, `${path}/type`);
    }
    const target = named(e.type);
    const fields = fieldsOf(target, this);
    let level: Level = "plain";
    let cls: DataClass = PUBLIC;
    for (const [fname, fe] of Object.entries(e.fields)) {
      const v = this.expr(fe, frame, `${path}/fields/${fname}`);
      cls = this.maxClass(cls, v.cls);
      const ep = epistemic(v.ty);
      level = joinLevel(level, ep.level);
      if (fields) {
        const ft = fields[fname];
        if (!ft) this.report("E0202", `${e.type} has no field '${fname}'.`, `${path}/fields/${fname}`, { fields: Object.keys(fields) });
        // R6: the record carries its parts' taint, so compare the parts at the field's own level.
        else this.problem(assignable(withLevel(ep.inner, epistemic(ft).level), ft, this), `${path}/fields/${fname}`);
      }
    }
    if (fields) {
      const missing = Object.keys(fields).filter((f) => !(f in e.fields));
      if (missing.length) this.report("E0203", `${e.type} is missing field(s) ${missing.join(", ")}.`, path, { missing });
    }
    return { ty: withLevel(target, level), cls };
  }

  private infer(e: Extract<Expr, { op: "infer" }>, frame: Frame, path: string): Val {
    const from = this.expr(e.from, frame, `${path}/from`);
    if (e.using) this.expr(e.using, frame, `${path}/using`);
    let target = this.ty(e.type);
    const prot = mentions(target, PROTECTED_TYPES);
    if (prot) this.report("E0213", `A model cannot produce ${prot}; infer only yields Inferred values (§5.2, S08).`, `${path}/type`, { type: prot });
    if (target.k === "named" && target.name === "Choice") {
      const opt = target.args[0] ?? UNKNOWN;
      this.choiceOptions(opt, `${path}/type`);
      target = named("Decision", opt);
    }
    this.use(frame, { effect: "Model", cls: from.cls, path });
    return { ty: named("Inferred", target), cls: from.cls };
  }

  private choiceOptions(opt: Ty, path: string): void {
    const tags = this.tagsOf(opt);
    if (!tags) return;
    if (tags.length > MAX_CHOICE_OPTIONS) {
      this.report("E0233", `A Choice may have at most ${MAX_CHOICE_OPTIONS} options; ${show(opt)} has ${tags.length}.`, path);
    }
    if (!tags.some((t) => OUT_OF_SCOPE_OPTIONS.has(t))) {
      this.report("W0232", `${show(opt)} has no out-of-scope option (Other, Irrelevant, OutOfScope); the model will force every input into a listed option (D8).`, path);
    }
  }

  /** Variant names of a local union or enum type. */
  private tagsOf(ty: Ty): string[] | undefined {
    const u = unalias(ty, this);
    if (u.k !== "named") return undefined;
    const d = this.typeDef(u.name);
    if (!d) return undefined;
    let te = d.type;
    while ("refine" in te) te = te.refine;
    if ("union" in te) return te.union.map((v) => v.tag);
    if ("enum" in te) return te.enum;
    return undefined;
  }

  private delegate(e: Extract<Expr, { op: "delegate" }>, frame: Frame, path: string): Val {
    const args = e.args.map((a, i) => this.expr(a.value, frame, `${path}/args/${i}/value`));
    const cls = this.maxClass(...args.map((a) => a.cls));
    const agent = this.def(e.agent);
    if (!agent || agent.kind !== "agent") return { ty: UNKNOWN, cls };
    const skill: Skill | undefined = Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill] : undefined;
    if (!skill) return { ty: UNKNOWN, cls };
    const who = `${e.agent}.${e.skill}`;
    if (args.length !== skill.params.length) {
      this.report("E0201", `${who} takes ${skill.params.length} argument(s) but got ${args.length}.`, path);
    }
    skill.params.forEach((param, i) => {
      const a = args[i];
      if (a) this.problem(assignable(a.ty, this.ty(param.type), this), `${path}/args/${i}/value`);
    });

    // C2 (§7.2, §9.1): without `with caps` the delegate gets A.caps ∩ avail(ctx).
    // `with caps K` narrows the capability kinds K names; every K must lie
    // inside both what the context holds and what the agent holds.
    const agentCaps = this.capList(agent.caps, ptr("defs", e.agent, "caps"));
    const inContext = (c: CapVal): boolean => !frame.avail || frame.avail.some((a) => capCovers(a, c));
    let effective = agentCaps.filter(inContext);
    const given: CapVal[] = [];
    if (e.caps) {
      e.caps.forEach((c, i) => {
        const cp = `${path}/caps/${i}`;
        const v = this.evalCap(c, cp, frame);
        if (!v) return;
        given.push(v);
        if (!inContext(v)) {
          this.report("E0701", `${showCap(v)} is not available in ${frame.def}, so it cannot be delegated (C2).`, cp, {
            capability: showCap(v),
            available: (frame.avail ?? []).map(showCap),
          });
        }
        if (!agent.remote && !agentCaps.some((a) => capCovers(a, v))) {
          this.report("E0701", `${e.agent} does not hold ${showCap(v)}; 'with caps' can only narrow what the agent already holds (C2).`, cp, {
            capability: showCap(v),
            agent: agentCaps.map(showCap),
          });
        }
      });
      const narrowed = new Set(given.map((g) => g.ctor));
      effective = [...effective.filter((c) => !narrowed.has(c.ctor)), ...given];
    }

    // C1 at the delegation site: the authority handed over must cover what the skill uses.
    if (!agent.remote) {
      skill.effects.forEach((x) => {
        if (UNGATED_EFFECTS.has(x.effect) || this.isCriticalEffect(x.effect)) return;
        const need = this.requiredCap(x.effect);
        const scope = this.effectScope(x);
        if (!effective.some((c) => (need ? c.ctor === need : capAuthorizes(c, x.effect, scope)))) {
          this.report("E0301", `${who} uses ${x.effect}, but this delegation grants no capability for it (${frame.def} lacks it or 'with caps' left it out).`, path, {
            required: x.effect,
            granted: effective.map(showCap),
          });
        }
      });
    }

    // §5.5: data sent to the agent's model may not exceed what its model capability allows.
    const models = effective.filter((c) => c.ctor === "model.infer");
    if (models.length && skill.effects.some((x) => x.effect === "Model")) {
      const best = Math.max(...models.map((c) => classRank(c.maxClass ?? "internal")));
      if (classRank(cls) > best) {
        this.report("E0220", `${who} receives ${cls} data, but its model capability allows at most ${DATA_CLASSES[best]} (§5.5).`, path, {
          data_class: cls,
          allowed: DATA_CLASSES[best],
        });
      }
    }

    // A delegation's timeout is a Duration (§8.7, §9.1); the runtime enforces it.
    if (e.timeout) this.problem(assignable(this.expr(e.timeout, frame, `${path}/timeout`).ty, named("Duration"), this), `${path}/timeout`);
    if (e.supervise) this.supervise(e.supervise, `${path}/supervise`, { kind: "delegate", agent: e.agent, skill: e.skill, given });
    const remote = !!agent.remote;
    frame.delegated.push({ caps: effective, path, external: remote });
    this.use(frame, { effect: "Delegate", path });
    let ret = this.ty(skill.returns);
    if (remote && agent.remote!.trust !== "trusted") ret = named("Untrusted", ret);
    // Model output inherits the highest class of what went in (§5.5).
    return { ty: ret, cls };
  }

  private verify(e: Extract<Expr, { op: "verify" }>, frame: Frame, path: string): Val {
    const v = this.expr(e.value, frame, `${path}/value`);
    const args = e.args.map((a, i) => this.expr(a.value, frame, `${path}/args/${i}/value`));
    const c = this.def(e.contract);
    if (c && c.kind === "contract") {
      if (args.length !== c.params.length) {
        this.report("E0201", `Contract ${e.contract} takes ${c.params.length} argument(s) but got ${args.length}.`, path);
      }
      c.params.forEach((param, i) => {
        const a = args[i];
        // The subject of a contract may be unverified; that is what verify is for.
        if (a) this.problem(assignable(withLevel(epistemic(a.ty).inner, "plain"), this.ty(param.type), this), `${path}/args/${i}/value`);
      });
    }
    if (e.on_unmet) {
      this.expr(e.on_unmet.then, this.child(frame, new Map([[e.on_unmet.bind, { ty: named("List", TEXT), cls: PUBLIC }]])), `${path}/on_unmet/then`);
    }
    return { ty: withLevel(epistemic(v.ty).inner, "verified", e.contract), cls: v.cls };
  }

  private effectCall(e: Extract<Expr, { op: "effect" }>, frame: Frame, path: string): Val {
    const args = e.args.map((a, i) => this.expr(a.value, frame, `${path}/args/${i}/value`));
    const cls = this.maxClass(...args.map((a) => a.cls));
    const local = this.def(e.name);
    const decl = local?.kind === "effect" ? local : undefined;
    const std = decl ? undefined : STD_EFFECTS[e.name];
    const params = decl ? decl.params.map((p) => this.ty(p.type)) : std ? std.params.map((p) => this.ty(p)) : undefined;
    const critical = decl ? !!(decl.critical || decl.irreversible) : !!std?.critical;
    const irreversible = decl ? !!decl.irreversible : !!std?.irreversible;

    if (params) {
      if (args.length !== params.length) {
        this.report("E0201", `Effect ${e.name} takes ${params.length} argument(s) but got ${args.length}.`, path);
      }
      params.forEach((t, i) => {
        const a = args[i];
        if (a) this.problem(assignable(a.ty, t, this), `${path}/args/${i}/value`);
      });
    }
    if (critical) {
      if (frame.where === "fn" || frame.where === "skill" || frame.where === "contract") {
        this.report("E0408", `The critical effect ${e.name} runs inside a ${frame.where}. External writes happen only in a workflow, through prepare → authorize → commit (§8.8, S07).`, path);
      }
      if (!e.idempotent_by) {
        this.report("E0403", `Critical effect ${e.name} needs 'idempotent_by' at the call site (§8.4).`, path, {
          repair_hint: "add `idempotent_by <business key>`",
        });
      }
    }
    if (irreversible && !frame.approved && !args.some((a) => this.approvedByHuman(a.ty))) {
      this.report("E0405", `Irreversible effect ${e.name} runs without a prior human.approve or a value verified by a contract that requires one (§6.3).`, path);
    }
    if (e.idempotent_by) this.expr(e.idempotent_by, frame, `${path}/idempotent_by`);
    this.use(frame, { effect: e.name, path });
    const ret = decl ? this.ty(decl.returns) : std ? this.ty(std.returns) : UNKNOWN;
    return { ty: ret, cls };
  }

  private approvedByHuman(ty: Ty): boolean {
    const ep = epistemic(ty);
    if (ep.level !== "verified" || !ep.contract) return false;
    const c = this.def(ep.contract);
    if (!c || c.kind !== "contract") return false;
    const hasHuman = (v: Verifier): boolean =>
      "all" in v ? v.all.some(hasHuman) : "call" in v && v.call.op === "call" && calleePath(v.call.callee) === "human.approve";
    return Object.values(c.accept).some((cr) => hasHuman(cr.by));
  }

  private switchExpr(e: Extract<Expr, { op: "switch" }>, frame: Frame, path: string): Val {
    const subj = this.expr(e.on, frame, `${path}/on`);
    const ep = epistemic(subj.ty);
    const catchAll = e.cases.some((c) => c.pattern.p === "wild" || c.pattern.p === "bind");
    let armType = (_tag: string): Ty[] => [];

    if (ep.inner.k === "named" && ep.inner.name === "Decision") {
      this.report("E0231", "Switch on a Decision only after a decision policy (threshold, top_margin, abstain_if) turns it into Confident(…) | Uncertain (D2).", `${path}/on`);
    } else if (ep.level === "inferred" || ep.level === "untrusted") {
      this.report("E0210", `Model output of type ${show(subj.ty)} cannot steer control flow unverified; verify it or use a decision policy (R1, D1).`, `${path}/on`);
    } else if (ep.inner.k === "named" && ep.inner.name === "DecisionOutcome") {
      const opt = ep.inner.args[0] ?? UNKNOWN;
      armType = (tag) => (tag === "Confident" ? [opt] : []);
      if (!e.cases.some((c) => c.pattern.p === "tag" && c.pattern.tag === "Uncertain") && !catchAll) {
        this.report("E0230", "A switch on a decision outcome must handle Uncertain (D2).", path, { missing: ["Uncertain"] });
      }
      const confident = e.cases.filter((c) => c.pattern.p === "tag" && c.pattern.tag === "Confident");
      const whole = confident.some((c) => c.pattern.p === "tag" && (!c.pattern.args?.length || c.pattern.args[0]!.p !== "tag"));
      const tags = this.tagsOf(opt);
      if (!catchAll && !whole && tags) {
        const covered = new Set(confident.map((c) => (c.pattern.p === "tag" && c.pattern.args?.[0]?.p === "tag" ? c.pattern.args[0].tag : "")));
        const missing = tags.filter((t) => !covered.has(t)).map((t) => `Confident(${t})`);
        if (missing.length) this.report("E0230", `Switch does not handle ${missing.join(", ")}.`, path, { missing });
      }
    } else {
      const tags = this.tagsOf(ep.inner);
      if (tags && !catchAll) {
        const covered = new Set(e.cases.map((c) => (c.pattern.p === "tag" ? c.pattern.tag : "")));
        const missing = tags.filter((t) => !covered.has(t));
        if (missing.length) this.report("E0230", `Switch does not handle ${missing.join(", ")}.`, path, { missing });
      }
      armType = (tag) => this.variantFields(ep.inner, tag);
    }

    let result: Val | undefined;
    e.cases.forEach((c, i) => {
      const binds = new Map<string, Val>();
      bindPattern(c.pattern, subj.ty, armType, binds, subj.cls);
      const v = this.expr(c.then, this.child(frame, binds), `${path}/cases/${i}/then`);
      result = result ?? v;
    });
    return result ?? { ty: UNKNOWN, cls: subj.cls };
  }

  private variantFields(ty: Ty, tag: string): Ty[] {
    const u = unalias(ty, this);
    if (u.k !== "named") return [];
    const d = this.typeDef(u.name);
    if (!d) return [];
    let te = d.type;
    while ("refine" in te) te = te.refine;
    if (!("union" in te)) return [];
    const v = te.union.find((x) => x.tag === tag);
    return (v?.fields ?? []).map((f) => this.ty(f.type));
  }

  // ── budgets (§8.6) ─────────────────────────────────────────────────────

  private checkBudget(name: string, d: WorkflowDef, base: string): void {
    const limit = d.budget;
    if (!limit) return;
    const cost = this.costOf(d.body, `${base}/body`);
    const facts: Record<string, unknown> = {};
    if (limit.spend) {
      const currencies = Object.keys(cost.spend);
      const other = currencies.filter((c) => c !== limit.spend!.currency);
      if (other.length) {
        this.report("E0504", `${name}'s budget is in ${limit.spend.currency} but delegates spend ${other.join(", ")}; currencies are never converted implicitly (§5.3).`, `${base}/budget/spend`, { currencies });
      }
      const total = cost.spend[limit.spend.currency] ?? 0;
      if (total > limit.spend.micros) {
        facts["spend"] = { limit: microsText(limit.spend.micros, limit.spend.currency), declared_by_children: microsText(total, limit.spend.currency) };
      }
    }
    if (limit.tokens !== undefined && cost.tokens > limit.tokens) facts["tokens"] = { limit: limit.tokens, declared_by_children: cost.tokens };
    if (limit.time && cost.time > limit.time.ms) facts["time_ms"] = { limit: limit.time.ms, declared_by_children: cost.time };
    if (Object.keys(facts).length) {
      this.report("E0501", `The budgets ${name} hands out exceed its own budget (${Object.keys(facts).join(", ")}).`, `${base}/budget`, { ...facts, breakdown: cost.parts });
    }
  }

  /**
   * Upper bound of a block's spend: sequential statements add up, `par`
   * branches add money and tokens but take the longest time, `if` takes the
   * larger branch, and loops multiply by max_iter. Inside a called function,
   * costs are reported at the call site (`at`).
   */
  private costOf(stmts: Stmt[], base: string, inFns: ReadonlySet<string> = new Set()): Cost {
    const total = zeroCost();
    const at = (p: string): string => (inFns.size ? base : p);
    const ec = (e: Expr, p: string): Cost => this.exprCost(e, at(p), inFns);
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
          addSeq(total, alternative([this.costOf(s.then, at(`${path}/then`), inFns), this.costOf(s.else ?? [], at(`${path}/else`), inFns)]));
          break;
        case "loop": {
          const once = this.costOf(s.body, at(`${path}/body`), inFns);
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
  private exprCost(e: Expr, path: string, inFns: ReadonlySet<string> = new Set()): Cost {
    const c = zeroCost();
    // Costs are reported at the enclosing statement (or switch arm).
    const sub = (x: Expr): Cost => this.exprCost(x, path, inFns);
    if (e.op === "switch") {
      // Only one arm runs.
      addSeq(c, sub(e.on));
      addSeq(c, alternative(e.cases.map((k, i) => this.exprCost(k.then, inFns.size ? path : `${path}/cases/${i}/then`, inFns))));
      return c;
    }
    if (e.op === "block") return this.costOf(e.body, inFns.size ? path : `${path}/body`, inFns);
    for (const k of children(e)) addSeq(c, sub(k));
    if (e.op === "delegate") {
      const agent = this.def(e.agent);
      if (agent?.kind !== "agent") return c;
      const skill = Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill] : undefined;
      const b = e.budget ?? skill?.budget ?? agent.budget;
      // Every attempt reserves again: restart(max: n) runs up to n + 1 times, and degrade(to: F) may run F after it.
      const sup = e.supervise;
      const maxArg = sup?.name === "restart" ? sup.args?.find((a) => a.name === "max")?.value : undefined;
      const attempts = sup?.name === "restart" ? (maxArg?.op === "int" ? maxArg.value : 1) + 1 : 1;
      if (b) addSeq(c, attempts > 1 ? scale(budgetCost(b, `${e.agent}.${e.skill}`, path), attempts) : budgetCost(b, `${e.agent}.${e.skill}`, path));
      const to = sup?.name === "degrade" ? sup.args?.find((a) => a.name === "to")?.value : undefined;
      const fb = to?.op === "var" ? this.def(to.name) : undefined;
      if (fb?.kind === "agent") {
        const fbSkill = Object.hasOwn(fb.skills, e.skill) ? fb.skills[e.skill] : undefined;
        const fbBudget = e.budget ?? fbSkill?.budget ?? fb.budget;
        if (fbBudget) addSeq(c, budgetCost(fbBudget, `${to!.op === "var" ? to.name : ""}.${e.skill}`, path));
      }
    } else if (e.op === "call" && e.callee.op === "var") {
      const name = e.callee.name;
      const f = this.def(name);
      if (f?.kind !== "fn") return c;
      // A function's own budget bounds everything it runs; without one, count its body.
      if (f.budget) addSeq(c, budgetCost(f.budget, name, path));
      else if (!inFns.has(name) && !this.recursive.has(name)) addSeq(c, this.costOf(f.body, path, new Set([...inFns, name])));
    }
    return c;
  }

  private countNodes(stmts: Stmt[], seen: Set<string>): number {
    let n = 0;
    for (const s of stmts) {
      n += 1;
      if (s.op === "loop") n += this.countNodes(s.body, seen) * (s.max_iter ?? 1);
      else if (s.op === "if") n += this.countNodes(s.then, seen) + this.countNodes(s.else ?? [], seen);
      walkStmtExprs(s, (x) => {
        if (x.op === "delegate" || x.op === "effect" || x.op === "infer" || x.op === "verify") n += 1;
        if (x.op === "call" && x.callee.op === "var") {
          const f = this.def(x.callee.name);
          if (f?.kind === "fn" && !seen.has(x.callee.name) && !this.recursive.has(x.callee.name)) {
            n += this.countNodes(f.body, new Set([...seen, x.callee.name]));
          }
        }
      });
    }
    return n;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────

interface Cost {
  spend: Record<string, number>;
  tokens: number;
  time: number;
  parts: Array<{ from: string; at: string; budget: Record<string, unknown> }>;
}

function zeroCost(): Cost {
  return { spend: {}, tokens: 0, time: 0, parts: [] };
}

function budgetCost(b: Budget, from: string, at: string): Cost {
  const c = zeroCost();
  if (b.spend) c.spend[b.spend.currency] = b.spend.micros;
  c.tokens = b.tokens ?? 0;
  c.time = b.time?.ms ?? 0;
  const shown: Record<string, unknown> = {};
  if (b.spend) shown["spend"] = microsText(b.spend.micros, b.spend.currency);
  if (b.tokens !== undefined) shown["tokens"] = b.tokens;
  if (b.time) shown["time_ms"] = b.time.ms;
  c.parts.push({ from, at, budget: shown });
  return c;
}

function addSeq(into: Cost, c: Cost): void {
  for (const [k, v] of Object.entries(c.spend)) into.spend[k] = (into.spend[k] ?? 0) + v;
  into.tokens += c.tokens;
  into.time += c.time;
  into.parts.push(...c.parts);
}

/** Parallel branches: money and tokens add up; wall-clock time is the longest branch. */
function parallel(cs: Cost[]): Cost {
  const out = zeroCost();
  for (const c of cs) {
    for (const [k, v] of Object.entries(c.spend)) out.spend[k] = (out.spend[k] ?? 0) + v;
    out.tokens += c.tokens;
    out.time = Math.max(out.time, c.time);
    out.parts.push(...c.parts);
  }
  return out;
}

/** Alternatives (if/else): the upper bound is the larger branch in each dimension. */
function alternative(cs: Cost[]): Cost {
  const out = zeroCost();
  for (const c of cs) {
    for (const [k, v] of Object.entries(c.spend)) out.spend[k] = Math.max(out.spend[k] ?? 0, v);
    out.tokens = Math.max(out.tokens, c.tokens);
    out.time = Math.max(out.time, c.time);
    out.parts.push(...c.parts);
  }
  return out;
}

function scale(c: Cost, n: number): Cost {
  const out = zeroCost();
  for (const [k, v] of Object.entries(c.spend)) out.spend[k] = v * n;
  out.tokens = c.tokens * n;
  out.time = c.time * n;
  out.parts = c.parts.map((p) => ({ ...p, from: `${p.from} ×${n}` }));
  return out;
}

function microsText(micros: number, currency: string): string {
  const whole = Math.floor(micros / 1_000_000);
  const frac = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""} ${currency}`;
}

function overlapText(a: CapVal, b: CapVal): string {
  const sa = a.scope ? a.scope.join(", ") : "an unknown scope";
  const sb = b.scope ? b.scope.join(", ") : "an unknown scope";
  return sa === sb ? sa : `${sa} / ${sb}`;
}

function patternVars(p: Pattern): string[] {
  if (p.p === "bind") return [p.name];
  if (p.p === "tag") return (p.args ?? []).flatMap(patternVars);
  return [];
}

function bindPattern(p: Pattern, subject: Ty, armType: (tag: string) => Ty[], into: Map<string, Val>, cls: DataClass): void {
  if (p.p === "bind") into.set(p.name, { ty: subject, cls });
  else if (p.p === "tag") {
    const fields = armType(p.tag);
    (p.args ?? []).forEach((a, i) => bindPattern(a, fields[i] ?? UNKNOWN, () => [], into, cls));
  }
}

/** Visits every expression in a statement list, including nested blocks. */
export function walkExprs(stmts: Stmt[], f: (e: Expr) => void): void {
  for (const s of stmts) walkStmtExprs(s, f, true);
}

function walkStmtExprs(s: Stmt, f: (e: Expr) => void, deep = false): void {
  const ex = (e: Expr | undefined): void => {
    if (e) walkExpr(e, f);
  };
  switch (s.op) {
    case "let":
    case "expr":
      ex(s.value);
      break;
    case "return":
      ex(s.value);
      break;
    case "par":
      Object.values(s.branches).forEach(ex);
      break;
    case "if":
      ex(s.cond);
      if (deep) {
        walkExprs(s.then, f);
        if (s.else) walkExprs(s.else, f);
      }
      break;
    case "loop":
      ex(s.until);
      if (deep) walkExprs(s.body, f);
      break;
    case "on_error":
      ex(s.then);
      break;
    case "run":
      ex(s.target);
      break;
  }
}

export function walkExpr(e: Expr, f: (e: Expr) => void): void {
  f(e);
  if (e.op === "block") walkExprs(e.body, f);
  for (const k of children(e)) walkExpr(k, f);
}

/** Direct sub-expressions; a block's statements are not included. */
function children(e: Expr): Expr[] {
  switch (e.op) {
    case "list":
    case "set":
      return e.items;
    case "template":
    case "prompt":
      return e.parts.flatMap((p) => ("expr" in p ? [p.expr] : []));
    case "field":
    case "unary":
    case "try":
    case "await":
      return [e.of];
    case "call":
      return [e.callee, ...e.args.map((a) => a.value)];
    case "binary":
      return [e.left, e.right];
    case "range":
      return [e.from, e.to];
    case "record":
      return Object.values(e.fields);
    case "infer":
      return e.using ? [e.from, e.using] : [e.from];
    case "delegate":
      return [...e.args.map((a) => a.value), ...(e.timeout ? [e.timeout] : [])];
    case "spawn":
      return e.args.map((a) => a.value);
    case "verify":
      return [e.value, ...e.args.map((a) => a.value), ...(e.on_unmet ? [e.on_unmet.then] : [])];
    case "effect":
      return [...e.args.map((a) => a.value), ...(e.idempotent_by ? [e.idempotent_by] : [])];
    case "escalate":
      return [e.to];
    case "pause":
      return e.then ? [e.then] : [];
    case "switch":
      return [e.on, ...e.cases.map((c) => c.then)];
    default:
      return [];
  }
}
