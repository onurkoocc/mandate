// Name resolution over canonical IR (Doc 4 §11.1, stage 2; E01xx).
//
// Every reference must name something that exists (S03): type references,
// capabilities in `caps` lists, agents and skills in `delegate`, contracts in
// `verify`, effects in `effect` calls and compensations, and variables.
//
// Members of standard-library and imported modules are not described in 0.1
// step 1, so calls into them are not checked beyond their module name, and a
// bare identifier passed as an argument to such a call (`tier: standard`,
// `methods: [GET, POST]`) is read as a symbol rather than a variable.

import { diag, ptr, ptrToken, type Diagnostic, type Repair, type Span } from "../diag.js";
import { nearestSpan } from "../ir/validate.js";
import { STD_EFFECTS } from "../std/std.js";
import type { Arg, Def, Expr, Param, Pattern, Program, Stmt, TypeExpr, Verifier } from "../ir/types.js";

export const BUILTIN_TYPES = new Set([
  "Bool", "Int", "Dec", "Text", "Bytes", "Path", "Url", "Time", "Duration", "Money", "Id",
  "List", "Set", "Map", "Option", "Result", "Ratio", "Prob",
  "Inferred", "Verified", "Untrusted", "Evidence", "Decision",
  "PreparedAction", "Authorization", "Receipt", "Task", "Prompt", "Budget",
  "EvidenceRef", "ArtifactRef", "CapRef", "OperationKey", "Approval", "Question",
]);

/** Functions available without an import. */
export const BUILTIN_FUNCTIONS = new Set(["quote", "peek", "len", "caps_diff", "review", "eval", "evidence"]);

/** Supervision strategies (§8.7), usable on their own after `on error(…) =>`. */
export const SUPERVISION_STRATEGIES = new Set(["restart", "restart_all", "fail_fast", "degrade", "reconcile"]);

interface Scope {
  names: Set<string>;
  parent?: Scope;
}

type Ctx = {
  scope: Scope;
  /** Inside the arguments of a call into a module this compiler does not describe. */
  symbolic: boolean;
  /** Inside a test body or handler table: test fixtures and handler constructors. */
  test: boolean;
};

/**
 * `linked` is the table of definitions the program sees with its imported
 * modules loaded (modules.ts); without it, imports are opaque names.
 */
export function resolveNames(program: Program, spans?: Map<string, Span>, linked?: Record<string, Def>): Diagnostic[] {
  return new Resolver(program, spans, linked).run();
}

class Resolver {
  private readonly out: Diagnostic[] = [];
  /** The program's own definitions: what it names directly. */
  private readonly defs: Record<string, Def>;
  /** Its own and every linked imported definition: what the names mean. */
  private readonly all: Record<string, Def>;
  /** Names brought in by `use`: module aliases and imported members. */
  private readonly imported = new Set<string>();
  private readonly importedModules = new Set<string>();

  constructor(
    private readonly program: Program,
    private readonly spans?: Map<string, Span>,
    linked?: Record<string, Def>,
  ) {
    this.defs = program.defs;
    this.all = linked ?? program.defs;
    for (const u of program.uses ?? []) {
      if (u.names) {
        for (const n of u.names) {
          this.imported.add(n);
          // `use std.{fs, net}` imports modules; their members are called as fs.read(…).
          if (u.module === "std" || /^[a-z]/.test(n)) this.importedModules.add(n);
        }
      } else {
        const last = u.module.split(".").pop()!;
        this.imported.add(last);
        this.importedModules.add(last);
      }
    }
  }

  run(): Diagnostic[] {
    for (const [name, def] of Object.entries(this.defs)) this.def(name, def, ptr("defs", name));
    for (const [name, t] of Object.entries(this.program.tests ?? {})) {
      const base = ptr("tests", name);
      const ctx: Ctx = { scope: this.root(), symbolic: false, test: true };
      for (const [h, e] of Object.entries(t.handlers ?? {})) this.expr(e, `${base}/handlers/${h}`, { ...ctx, symbolic: true });
      this.block(t.body, `${base}/body`, ctx);
    }
    return this.out;
  }

  private root(): Scope {
    return { names: new Set() };
  }

  private report(path: string, message: string, name: string, expected: string, candidates: string[], replace?: (n: string) => unknown): void {
    const span = nearestSpan(this.spans, path);
    const near = closest(name, candidates);
    const repair: Repair[] = [];
    if (near && replace) {
      repair.push({ id: "r1", summary: `Use '${near}'`, patch: [{ op: "replace", path, value: replace(near) }], risk: "low" });
    }
    this.out.push(
      diag("E0120", message, span ? { path, span } : { path }, {
        facts: { name, expected, ...(near ? { did_you_mean: near } : {}) },
        ...(repair.length ? { repair } : {}),
      }),
    );
  }

  /**
   * Own-property lookup, so names like `constructor` never resolve by
   * accident. A name is the program's own or one it imports; an imported
   * name means the linked definition when its module is loaded.
   */
  private def_(name: string): Def | undefined {
    if (Object.hasOwn(this.defs, name)) return this.defs[name];
    return this.imported.has(name) && Object.hasOwn(this.all, name) ? this.all[name] : undefined;
  }

  private defsOfKind(kind: Def["kind"]): string[] {
    return [...new Set([...Object.keys(this.defs), ...[...this.imported].filter((n) => Object.hasOwn(this.all, n))])].filter((n) => this.def_(n)?.kind === kind);
  }

  // ── definitions ────────────────────────────────────────────────────────

  private def(name: string, d: Def, base: string): void {
    const top: Ctx = { scope: this.root(), symbolic: false, test: false };
    switch (d.kind) {
      case "type": {
        const generics = new Set(d.generics ?? []);
        this.type(d.type, `${base}/type`, generics, top);
        return;
      }
      case "capability":
        this.expr(d.value, `${base}/value`, top);
        return;
      case "const":
        if (d.type) this.type(d.type, `${base}/type`, new Set(), top);
        this.expr(d.value, `${base}/value`, top);
        return;
      case "fn": {
        const ctx = this.withParams(d.params, `${base}/params`, top);
        this.type(d.returns, `${base}/returns`, new Set(), top);
        this.block(d.body, `${base}/body`, ctx);
        return;
      }
      case "extern": {
        const ctx = this.withParams(d.params, `${base}/params`, top);
        this.type(d.returns, `${base}/returns`, new Set(), top);
        if (d.idempotent_by) this.expr(d.idempotent_by, `${base}/idempotent_by`, ctx);
        return;
      }
      case "effect": {
        const ctx = this.withParams(d.params, `${base}/params`, top);
        this.type(d.returns, `${base}/returns`, new Set(), top);
        (d.requires_caps ?? []).forEach((c, i) => this.expr(c, `${base}/requires_caps/${i}`, ctx));
        if (d.compensation) this.effectName(d.compensation, `${base}/compensation`);
        return;
      }
      case "agent": {
        if (d.remote) {
          this.expr(d.remote.bind, `${base}/remote/bind`, { ...top, symbolic: true });
          (d.remote.require ?? []).forEach((r, i) => this.expr(r, `${base}/remote/require/${i}`, { ...top, symbolic: true }));
        }
        this.capList(d.caps, `${base}/caps`, top);
        for (const [sn, s] of Object.entries(d.skills)) {
          const sb = `${base}/skills/${sn}`;
          const ctx = this.withParams(s.params, `${sb}/params`, top);
          this.type(s.returns, `${sb}/returns`, new Set(), top);
          if (s.body) this.block(s.body, `${sb}/body`, ctx);
        }
        return;
      }
      case "workflow": {
        const ctx = this.withParams(d.params, `${base}/params`, top);
        this.type(d.returns, `${base}/returns`, new Set(), top);
        this.capList(d.caps, `${base}/caps`, top);
        if (d.ensures) this.expr(d.ensures, `${base}/ensures`, { ...ctx, scope: { names: new Set(["result"]), parent: ctx.scope } });
        this.block(d.body, `${base}/body`, ctx);
        (d.on ?? []).forEach((h, i) => this.expr(h.then, `${base}/on/${i}/then`, ctx));
        return;
      }
      case "contract": {
        const ctx = this.withParams(d.params, `${base}/params`, top);
        (d.require ?? []).forEach((r, i) => this.expr(r, `${base}/require/${i}`, ctx));
        for (const group of ["accept", "invariant"] as const) {
          for (const [cn, c] of Object.entries(d[group] ?? {})) this.verifier(c.by, `${base}/${group}/${cn}/by`, ctx);
        }
        return;
      }
      case "component":
        for (const field of ["provides", "consumes"] as const) {
          (d[field] ?? []).forEach((n, i) => {
            if (this.def_(n)?.kind !== "interface") this.report(`${base}/${field}/${i}`, `Unknown interface '${n}'.`, n, "interface", this.defsOfKind("interface"), (x) => x);
          });
        }
        return;
      case "interface":
        return;
      case "environment":
        for (const [rn, r] of Object.entries(d.reads ?? {})) {
          const rb = `${base}/reads/${ptrToken(rn)}`;
          if (this.def_(r.from)?.kind !== "component") this.report(`${rb}/from`, `Unknown component '${r.from}'.`, r.from, "component", this.defsOfKind("component"), (x) => x);
          const ctx = this.withParams(r.params, `${rb}/params`, top);
          this.type(r.returns, `${rb}/returns`, new Set(), top);
          // A log filter names the row's fields and the read's parameters, nothing else.
          if ("logs" in r.query) this.expr(r.query.logs, `${rb}/query/logs`, { ...ctx, scope: { names: new Set(this.recordFields(r.returns)), parent: { names: ctx.scope.names } } });
        }
        for (const effect of Object.keys(d.authorize ?? {})) {
          const path = `${base}/authorize/${ptrToken(effect)}`;
          if (!STD_EFFECTS[effect] && this.def_(effect)?.kind !== "effect") this.report(path, `Unknown effect '${effect}'.`, effect, "effect", [...Object.keys(STD_EFFECTS), ...this.defsOfKind("effect")], (x) => x);
        }
        return;
    }
  }

  /** Field names of a record type, through named types and refinements; none for anything else. */
  private recordFields(t: TypeExpr, seen = new Set<string>()): string[] {
    if ("record" in t) return Object.keys(t.record);
    if ("refine" in t) return this.recordFields(t.refine, seen);
    if ("ref" in t && !seen.has(t.ref)) {
      const d = this.def_(t.ref) ?? (Object.hasOwn(this.all, t.ref) ? this.all[t.ref] : undefined);
      if (d?.kind === "type") return this.recordFields(d.type, new Set([...seen, t.ref]));
    }
    return [];
  }

  private withParams(params: Param[], base: string, ctx: Ctx): Ctx {
    const names = new Set<string>();
    params.forEach((p, i) => {
      names.add(p.name);
      this.type(p.type, `${base}/${i}/type`, new Set(), ctx, p.name);
    });
    return { ...ctx, scope: { names, parent: ctx.scope } };
  }

  private capList(caps: Expr[], base: string, ctx: Ctx): void {
    caps.forEach((c, i) => {
      const path = `${base}/${i}`;
      if (c.op === "var") {
        const d = this.def_(c.name);
        if (!d || d.kind !== "capability") {
          this.report(path, `Unknown capability '${c.name}'.`, c.name, "capability", this.defsOfKind("capability"), (n) => ({ op: "var", name: n }));
        }
        return;
      }
      this.expr(c, path, ctx);
    });
  }

  private verifier(v: Verifier, path: string, ctx: Ctx): void {
    if ("all" in v) v.all.forEach((x, i) => this.verifier(x, `${path}/all/${i}`, ctx));
    else if ("static" in v) this.expr(v.static, `${path}/static`, ctx);
    else this.expr(v.call, `${path}/call`, ctx);
  }

  // ── types ──────────────────────────────────────────────────────────────

  private type(t: TypeExpr, path: string, generics: Set<string>, ctx: Ctx, binder?: string): void {
    if ("ref" in t) {
      if (!this.isType(t.ref, generics)) {
        const candidates = [...BUILTIN_TYPES, ...this.defsOfKind("type"), ...this.imported, ...generics];
        this.report(`${path}/ref`, `Unknown type '${t.ref}'.`, t.ref, "type", candidates, (n) => n);
      }
      (t.args ?? []).forEach((a, i) => {
        const ap = `${path}/args/${i}`;
        // Verified<T, C>: C names a contract. Evidence<Profile, Subject>: Profile is a check profile.
        if (t.ref === "Verified" && i === 1 && "ref" in a && !a.args) {
          const d = this.def_(a.ref);
          if (!(d && d.kind === "contract") && !this.imported.has(a.ref)) {
            this.report(`${ap}/ref`, `Unknown contract '${a.ref}' in Verified<…>.`, a.ref, "contract", this.defsOfKind("contract"), (n) => n);
          }
          return;
        }
        if (t.ref === "Evidence" && i === 0 && "ref" in a && !a.args) return;
        this.type(a, ap, generics, ctx);
      });
    } else if ("record" in t) {
      for (const [f, ft] of Object.entries(t.record)) this.type(ft, `${path}/record/${f}`, generics, ctx, f);
    } else if ("union" in t) {
      t.union.forEach((v, i) =>
        (v.fields ?? []).forEach((p, j) => this.type(p.type, `${path}/union/${i}/fields/${j}/type`, generics, ctx, p.name)),
      );
    } else if ("refine" in t) {
      this.type(t.refine, `${path}/refine`, generics, ctx, binder);
      const names = new Set(binder ? [binder] : ["value"]);
      this.expr(t.where, `${path}/where`, { ...ctx, scope: { names, parent: ctx.scope } });
    }
  }

  private isType(name: string, generics: Set<string>): boolean {
    if (generics.has(name) || BUILTIN_TYPES.has(name) || this.imported.has(name)) return true;
    const d = this.def_(name);
    if (d && d.kind === "type") return true;
    // Qualified references into an imported module: company.domain.Issue
    const dot = name.lastIndexOf(".");
    return dot > 0 && this.isModulePath(name.slice(0, dot));
  }

  private isModulePath(qname: string): boolean {
    const first = qname.split(".")[0]!;
    return this.importedModules.has(first) || (this.program.uses ?? []).some((u) => u.module === qname);
  }

  // ── statements and expressions ─────────────────────────────────────────

  private block(body: Stmt[], base: string, ctx: Ctx): void {
    let scope: Scope = { names: new Set(), parent: ctx.scope };
    body.forEach((s, i) => {
      const path = `${base}/${i}`;
      const c: Ctx = { ...ctx, scope };
      switch (s.op) {
        case "let":
          if (s.type) this.type(s.type, `${path}/type`, new Set(), c);
          this.expr(s.value, `${path}/value`, c);
          scope = { names: new Set([s.name]), parent: scope };
          break;
        case "par": {
          const names = new Set<string>();
          for (const [n, e] of Object.entries(s.branches)) {
            // Branches cannot see each other's results.
            this.expr(e, `${path}/branches/${n}`, c);
            names.add(n);
          }
          if (s.supervise) this.args(s.supervise.args ?? [], `${path}/supervise/args`, { ...c, symbolic: true });
          scope = { names, parent: scope };
          break;
        }
        case "if":
          this.expr(s.cond, `${path}/cond`, c);
          this.block(s.then, `${path}/then`, c);
          if (s.else) this.block(s.else, `${path}/else`, c);
          break;
        case "loop":
          if (s.until) this.expr(s.until, `${path}/until`, c);
          this.block(s.body, `${path}/body`, c);
          break;
        case "return":
          if (s.value) this.expr(s.value, `${path}/value`, c);
          break;
        case "on_error": {
          const inner = { ...c, scope: { names: patternBinds(s.pattern), parent: scope } };
          // A bare supervision strategy (`=> reconcile`, `=> restart(max: 2)`) is not a value reference.
          const t = s.then;
          const strategy = t.op === "var" ? t : t.op === "call" && t.callee.op === "var" ? t.callee : undefined;
          if (strategy && SUPERVISION_STRATEGIES.has(strategy.name) && !this.lookup(strategy.name, inner.scope)) {
            if (t.op === "call") this.args(t.args, `${path}/then/args`, { ...inner, symbolic: true });
          } else {
            this.expr(t, `${path}/then`, inner);
          }
          break;
        }
        case "run":
          this.expr(s.target, `${path}/target`, { ...c, symbolic: true });
          break;
        case "expr":
          this.expr(s.value, `${path}/value`, c);
          break;
      }
    });
  }

  private lookup(name: string, scope: Scope | undefined): boolean {
    for (let s = scope; s; s = s.parent) if (s.names.has(name)) return true;
    return Object.hasOwn(this.defs, name) || this.imported.has(name) || BUILTIN_FUNCTIONS.has(name);
  }

  private visible(scope: Scope | undefined): string[] {
    const out: string[] = [];
    for (let s = scope; s; s = s.parent) out.push(...s.names);
    return [...out, ...Object.keys(this.defs), ...this.imported, ...BUILTIN_FUNCTIONS];
  }

  private args(args: Arg[], base: string, ctx: Ctx): void {
    args.forEach((a, i) => this.expr(a.value, `${base}/${i}/value`, ctx));
  }

  /** True when a callee resolves to something this compiler describes. */
  private isLocalCallee(callee: Expr): boolean {
    if (callee.op === "var") {
      const d = this.def_(callee.name);
      return !!d && d.kind !== "const";
    }
    return false;
  }

  private effectName(name: string, path: string): void {
    if (Object.hasOwn(this.defs, name)) {
      if (this.defs[name]!.kind !== "effect") {
        this.report(path, `'${name}' is not an effect.`, name, "effect", this.defsOfKind("effect"));
      }
      return;
    }
    const dot = name.lastIndexOf(".");
    if (dot > 0 && this.isModulePath(name.slice(0, dot))) return;
    this.report(path, `Unknown effect '${name}'.`, name, "effect", this.defsOfKind("effect"), (n) => n);
  }

  private expr(e: Expr, path: string, ctx: Ctx): void {
    switch (e.op) {
      case "int":
      case "dec":
      case "text":
      case "bool":
      case "money":
      case "duration":
        return;
      case "list":
      case "set":
        e.items.forEach((x, i) => this.expr(x, `${path}/items/${i}`, ctx));
        return;
      case "template":
      case "prompt":
        e.parts.forEach((p, i) => {
          if ("expr" in p) this.expr(p.expr, `${path}/parts/${i}/expr`, ctx);
        });
        return;
      case "var":
        if (!this.lookup(e.name, ctx.scope) && !ctx.symbolic) {
          this.report(path, `Unknown name '${e.name}'.`, e.name, "value", this.visible(ctx.scope), (n) => ({ op: "var", name: n }));
        }
        return;
      case "field":
        this.expr(e.of, `${path}/of`, ctx);
        return;
      case "call": {
        this.expr(e.callee, `${path}/callee`, ctx);
        const symbolic = ctx.symbolic || !this.isLocalCallee(e.callee);
        this.args(e.args, `${path}/args`, { ...ctx, symbolic });
        return;
      }
      case "unary":
      case "try":
      case "await":
        this.expr(e.of, `${path}/of`, ctx);
        return;
      case "binary":
        this.expr(e.left, `${path}/left`, ctx);
        this.expr(e.right, `${path}/right`, ctx);
        return;
      case "range":
        this.expr(e.from, `${path}/from`, ctx);
        this.expr(e.to, `${path}/to`, ctx);
        return;
      case "record":
        if (!this.isType(e.type, new Set())) {
          this.report(`${path}/type`, `Unknown type '${e.type}'.`, e.type, "type", [...this.defsOfKind("type"), ...this.imported], (n) => n);
        }
        for (const [f, v] of Object.entries(e.fields)) this.expr(v, `${path}/fields/${f}`, ctx);
        return;
      case "infer":
        this.type(e.type, `${path}/type`, new Set(), ctx);
        this.expr(e.from, `${path}/from`, ctx);
        if (e.using) this.expr(e.using, `${path}/using`, ctx);
        return;
      case "delegate":
      case "spawn": {
        const agent = this.def_(e.agent);
        if (!agent || agent.kind !== "agent") {
          this.report(`${path}/agent`, `Unknown agent '${e.agent}'.`, e.agent, "agent", this.defsOfKind("agent"), (n) => n);
        } else if (!Object.hasOwn(agent.skills, e.skill)) {
          this.report(`${path}/skill`, `Agent '${e.agent}' has no skill '${e.skill}'.`, e.skill, "skill", Object.keys(agent.skills), (n) => n);
        }
        this.args(e.args, `${path}/args`, ctx);
        if (e.op === "delegate") {
          if (e.caps) this.capListExprs(e.caps, `${path}/caps`, ctx);
          if (e.timeout) this.expr(e.timeout, `${path}/timeout`, ctx);
          if (e.supervise) this.args(e.supervise.args ?? [], `${path}/supervise/args`, { ...ctx, symbolic: true });
        }
        return;
      }
      case "verify": {
        this.expr(e.value, `${path}/value`, ctx);
        const c = this.def_(e.contract);
        if (!c || c.kind !== "contract") {
          this.report(`${path}/contract`, `Unknown contract '${e.contract}'.`, e.contract, "contract", this.defsOfKind("contract"), (n) => n);
        }
        this.args(e.args, `${path}/args`, ctx);
        if (e.on_unmet) {
          this.expr(e.on_unmet.then, `${path}/on_unmet/then`, {
            ...ctx,
            scope: { names: new Set([e.on_unmet.bind]), parent: ctx.scope },
          });
        }
        return;
      }
      case "effect":
        this.effectName(e.name, `${path}/name`);
        this.args(e.args, `${path}/args`, ctx);
        if (e.idempotent_by) this.expr(e.idempotent_by, `${path}/idempotent_by`, ctx);
        if (e.compensate) this.effectName(e.compensate, `${path}/compensate`);
        return;
      case "changeset":
        this.expr(e.plan, `${path}/plan`, ctx);
        for (const [m, mem] of Object.entries(e.members)) {
          const mp = `${path}/members/${ptrToken(m)}`;
          if (this.def_(m)?.kind !== "component") this.report(mp, `Unknown component '${m}'.`, m, "component", this.defsOfKind("component"));
          if (!STD_EFFECTS[mem.effect]) this.effectName(mem.effect, `${mp}/effect`);
          this.args(mem.args, `${mp}/args`, ctx);
        }
        for (const i of Object.keys(e.changes ?? {})) {
          if (this.def_(i)?.kind !== "interface") this.report(`${path}/changes/${ptrToken(i)}`, `Unknown interface '${i}'.`, i, "interface", this.defsOfKind("interface"));
        }
        if (e.idempotent_by) this.expr(e.idempotent_by, `${path}/idempotent_by`, ctx);
        return;
      case "escalate":
        this.expr(e.to, `${path}/to`, ctx);
        return;
      case "pause":
        if (e.then) this.expr(e.then, `${path}/then`, ctx);
        return;
      case "switch":
        this.expr(e.on, `${path}/on`, ctx);
        e.cases.forEach((c, i) =>
          this.expr(c.then, `${path}/cases/${i}/then`, { ...ctx, scope: { names: patternBinds(c.pattern), parent: ctx.scope } }),
        );
        return;
      case "block":
        this.block(e.body, `${path}/body`, ctx);
        return;
    }
  }

  /** `with caps K`: names must be capabilities; narrowing calls are checked as expressions. */
  private capListExprs(caps: Expr[], base: string, ctx: Ctx): void {
    caps.forEach((c, i) => {
      const path = `${base}/${i}`;
      const root = rootVar(c);
      if (root && !this.lookup(root.name, ctx.scope)) {
        this.report(`${path}${root.path}`, `Unknown capability '${root.name}'.`, root.name, "capability", this.defsOfKind("capability"), (n) => ({ op: "var", name: n }));
        return;
      }
      if (c.op !== "var") this.expr(c, path, ctx);
    });
  }
}

function rootVar(e: Expr): { name: string; path: string } | undefined {
  let path = "";
  let cur = e;
  for (;;) {
    if (cur.op === "var") return { name: cur.name, path };
    if (cur.op === "field") {
      path += "/of";
      cur = cur.of;
    } else if (cur.op === "call") {
      path += "/callee";
      cur = cur.callee;
    } else return undefined;
  }
}

function patternBinds(p: Pattern): Set<string> {
  const out = new Set<string>();
  const walk = (q: Pattern): void => {
    if (q.p === "bind") out.add(q.name);
    else if (q.p === "tag") (q.args ?? []).forEach(walk);
  };
  walk(p);
  return out;
}

/** The single closest candidate within edit distance 2, if unambiguous. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestD = 3;
  let tie = false;
  for (const c of new Set(candidates)) {
    if (c === name) continue;
    const d = editDistance(name, c);
    if (d < bestD) {
      best = c;
      bestD = d;
      tie = false;
    } else if (d === bestD) {
      tie = true;
    }
  }
  return tie ? undefined : best;
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length]![b.length]!;
}
