// Human projections of a program (Doc 4 §15; INV-10). People review a
// program through these views, not through its text: what runs in what
// order, who may do what, what it may cost, and, between two versions, what
// changed in authority and in behavior.
//
// A view is computed from the IR alone and names the program hash it shows,
// so a view and the program it claims to show cannot drift apart. Views are
// read-only. The runtime adds the views of a run (state, evidence, cost) from
// its journal, under the same hash.
//
//   architecture   the workflow as a graph: delegations with their grants,
//                  parallel branches, verification, external effects, people
//   authority      per agent, workflow and delegation: paths, hosts, model
//                  tiers, commands, repositories, money, critical effects
//   cost           what each workflow hands out: budgets per delegation and
//                  the static upper bound, with the lock's per-call bound
//   diff           governance changes (authority widened, budgets raised,
//                  criteria removed or changed, irreversible effects), behavior
//                  changes, and what stayed the same (§15.3)

import { calleePath, capFromCall, capCovers, showCap, within, type CapVal } from "../check/caps.js";
import { hashProgram } from "../hash.js";
import type { AgentDef, Budget, ContractDef, EffectDef, Expr, Program, Stmt, Verifier, WorkflowDef } from "../ir/types.js";
import { canonicalize } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import { perCallBound, type Lock } from "../lock.js";
import { STD_EFFECTS, STD_FNS } from "../std/std.js";
import type { Block, Cell, Doc } from "./doc.js";

export const VIEW_FORMAT = "mandate/view/0.1";

export interface ProgramRef {
  module: string;
  version: string;
  language: string;
  hash: string;
}

export function programRef(p: Program): ProgramRef {
  return { module: p.module, version: p.version, language: p.language, hash: hashProgram(p as unknown as Json).program };
}

// ── capabilities ──────────────────────────────────────────────────────────

/** A capability expression's value: a named capability, a constructor call, or `c.narrow(…)` with literal scopes. */
export function capOf(program: Program, e: Expr): CapVal | undefined {
  if (e.op === "var") {
    const d = program.defs[e.name];
    if (d?.kind !== "capability") return undefined;
    const v = capOf(program, d.value);
    return v ? { ...v, name: e.name } : undefined;
  }
  if (e.op === "call" && e.callee.op === "field" && e.callee.name === "narrow") {
    const base = capOf(program, e.callee.of);
    if (!base) return undefined;
    const scope = e.args.flatMap((a) => (a.value.op === "text" ? [a.value.value] : []));
    const { scope: _wide, ...rest } = base;
    return scope.length === e.args.length ? { ...rest, scope, name: `${base.name ?? base.ctor}.narrow` } : rest;
  }
  return capFromCall(e);
}

/** What a delegation is granted at run time: the agent's capabilities inside the workflow's, `with caps` replacing its kinds (C2). */
export function grantOf(program: Program, wf: WorkflowDef, agent: AgentDef, withCaps: Expr[] = []): CapVal[] {
  const avail = wf.caps.map((c) => capOf(program, c)).filter((c): c is CapVal => !!c);
  let out = agent.caps.map((c) => capOf(program, c)).filter((c): c is CapVal => !!c).filter((c) => avail.some((a) => capCovers(a, c)));
  if (withCaps.length) {
    const given = withCaps.map((c) => capOf(program, c)).filter((c): c is CapVal => !!c);
    const kinds = new Set(given.map((g) => g.ctor));
    out = [...out.filter((c) => !kinds.has(c.ctor)), ...given];
  }
  return out;
}

export interface Authority {
  read: string[];
  write: string[];
  network: string[];
  model: string[];
  exec: string[];
  repos: string[];
  money: string[];
  /** Capabilities whose scope is not statically known. */
  unbounded: string[];
}

export function authorityOf(caps: CapVal[]): Authority {
  const a: Authority = { read: [], write: [], network: [], model: [], exec: [], repos: [], money: [], unbounded: [] };
  for (const c of caps) {
    const scope = c.scope ?? [];
    if (c.scope === undefined && ["fs.read", "fs.write", "net.https", "exec", "git.pr"].includes(c.ctor)) a.unbounded.push(showCap(c));
    if (c.ctor === "fs.read") a.read.push(...scope);
    else if (c.ctor === "fs.write") a.write.push(...scope);
    else if (c.ctor === "net.https") a.network.push(...scope);
    else if (c.ctor === "model.infer") a.model.push(`${c.tier ?? "any tier"} (up to ${c.maxClass ?? "internal"})`);
    else if (c.ctor === "exec") a.exec.push(...scope.map((cmd) => (c.argsPrefix?.length ? c.argsPrefix.map((p) => [cmd, ...p].join(" ")).join("; ") : `${cmd} …`)));
    else if (c.ctor === "git.pr") a.repos.push(...scope);
    else if (c.ctor === "money.spend") a.money.push(showCap(c));
  }
  for (const k of Object.keys(a) as Array<keyof Authority>) a[k] = [...new Set(a[k])].sort();
  return a;
}

// ── shared walks ──────────────────────────────────────────────────────────

/** A delegation's budget: the call's, else the skill's, else the agent's (what the runtime reserves). */
export function delegateBudget(program: Program, e: Extract<Expr, { op: "delegate" }>, agentName = e.agent): { budget?: Budget; from: "call" | "skill" | "agent" | "none" } {
  const agent = program.defs[agentName];
  if (agent?.kind !== "agent") return { from: "none" };
  const skill = Object.hasOwn(agent.skills, e.skill) ? agent.skills[e.skill] : undefined;
  if (e.budget) return { budget: e.budget, from: "call" };
  if (skill?.budget) return { budget: skill.budget, from: "skill" };
  if (agent.budget) return { budget: agent.budget, from: "agent" };
  return { from: "none" };
}

function children(e: Expr): Expr[] {
  switch (e.op) {
    case "list":
    case "set":
      return e.items;
    case "template":
    case "prompt":
      return e.parts.flatMap((p) => ("expr" in p ? [p.expr] : []));
    case "field":
      return [e.of];
    case "call":
      return [e.callee, ...e.args.map((a) => a.value)];
    case "unary":
      return [e.of];
    case "binary":
      return [e.left, e.right];
    case "range":
      return [e.from, e.to];
    case "record":
      return Object.values(e.fields);
    case "infer":
      return [e.from, ...(e.using ? [e.using] : [])];
    case "delegate":
      return e.args.map((a) => a.value);
    case "verify":
      return [e.value, ...e.args.map((a) => a.value)];
    case "effect":
      return e.args.map((a) => a.value);
    case "escalate":
      return [e.to];
    case "pause":
      return e.then ? [e.then] : [];
    case "switch":
      return [e.on, ...e.cases.map((c) => c.then)];
    case "try":
    case "await":
      return [e.of];
    default:
      return [];
  }
}

function effectInfo(program: Program, name: string): { critical: boolean; irreversible: boolean } {
  const d = program.defs[name];
  if (d?.kind === "effect") return { critical: !!(d.critical || d.irreversible), irreversible: !!d.irreversible };
  const s = STD_EFFECTS[name];
  return { critical: !!s?.critical, irreversible: !!s?.irreversible };
}

function show(b: Budget | undefined): string {
  if (!b) return "—";
  const parts: string[] = [];
  if (b.spend) parts.push(`${b.spend.micros / 1_000_000} ${b.spend.currency}`);
  if (b.tokens !== undefined) parts.push(`${b.tokens} tokens`);
  if (b.steps !== undefined) parts.push(`${b.steps} steps`);
  if (b.time) parts.push(duration(b.time.ms));
  return parts.join(" · ") || "—";
}

function duration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

function shortCaps(caps: CapVal[]): string {
  const a = authorityOf(caps);
  const parts = [
    ...a.read.map((p) => `read ${p}`),
    ...a.write.map((p) => `write ${p}`),
    ...a.network.map((h) => `net ${h}`),
    ...a.exec.map((x) => `run ${x}`),
    ...a.model.map((m) => `model ${m}`),
    ...a.repos.map((r) => `PR ${r}`),
  ];
  return parts.join(" · ");
}

function supervision(e: Extract<Expr, { op: "delegate" }>): string | undefined {
  const s = e.supervise;
  if (!s) return undefined;
  const args = (s.args ?? []).map((a) => `${a.name ? `${a.name}: ` : ""}${a.value.op === "int" ? a.value.value : a.value.op === "duration" ? duration(a.value.ms) : a.value.op === "var" ? a.value.name : a.value.op === "text" ? JSON.stringify(a.value.value) : "…"}`);
  return `${s.name}(${args.join(", ")})`;
}

// ── architecture ──────────────────────────────────────────────────────────

export interface ArchNode {
  id: string;
  kind: "delegate" | "verify" | "effect" | "human" | "infer" | "read";
  label: string;
  detail: string[];
}

export interface ArchEdge {
  from: string;
  to: string;
  label?: string;
}

export interface WorkflowArchitecture {
  workflow: string;
  budget: string;
  nodes: ArchNode[];
  edges: ArchEdge[];
  mermaid: string;
}

export interface ArchitectureView {
  format: typeof VIEW_FORMAT;
  kind: "architecture";
  program: ProgramRef;
  workflows: WorkflowArchitecture[];
}

class Graph {
  readonly nodes: ArchNode[] = [];
  readonly edges: ArchEdge[] = [];

  constructor(
    private readonly program: Program,
    private readonly wf: WorkflowDef,
  ) {}

  private add(kind: ArchNode["kind"], label: string, detail: string[], from: string[], edgeLabel?: string): string {
    const id = `n${this.nodes.length + 1}`;
    this.nodes.push({ id, kind, label, detail });
    for (const f of from) this.edges.push({ from: f, to: id, ...(edgeLabel ? { label: edgeLabel } : {}) });
    return id;
  }

  block(stmts: Stmt[], prev: string[]): string[] {
    for (const s of stmts) prev = this.stmt(s, prev);
    return prev;
  }

  private stmt(s: Stmt, prev: string[]): string[] {
    switch (s.op) {
      case "let":
      case "expr":
        return this.expr(s.value, prev);
      case "return":
        return s.value ? this.expr(s.value, prev) : prev;
      case "par": {
        const ends = Object.keys(s.branches)
          .sort()
          .flatMap((bn) => this.expr(s.branches[bn]!, prev));
        return ends.length ? ends : prev;
      }
      case "if": {
        const c = this.expr(s.cond, prev);
        return [...new Set([...this.block(s.then, c), ...this.block(s.else ?? [], c)])];
      }
      case "loop":
        return this.block(s.body, prev);
      default:
        return prev;
    }
  }

  private expr(e: Expr, prev: string[]): string[] {
    for (const c of e.op === "verify" ? [e.value, ...e.args.map((a) => a.value)] : children(e)) prev = this.expr(c, prev);
    switch (e.op) {
      case "delegate": {
        const agent = this.program.defs[e.agent];
        const grant = agent?.kind === "agent" ? grantOf(this.program, this.wf, agent, e.caps ?? []) : [];
        const detail = [shortCaps(grant), e.isolated ? "isolated" : "", supervision(e) ?? "", e.timeout?.op === "duration" ? `timeout ${duration(e.timeout.ms)}` : ""].filter(Boolean);
        return [this.add("delegate", `${e.agent}.${e.skill}`, detail, prev)];
      }
      case "verify": {
        const v = this.add("verify", `verify ${e.contract}`, criteria(this.program, e.contract), prev);
        if (e.on_unmet) this.expr(e.on_unmet.then, [v]);
        // An escalation on unmet criteria waits for a person; the next steps follow the met path (§15.1).
        const unmet = this.nodes.filter((n) => n.kind === "human" && this.edges.some((x) => x.from === v && x.to === n.id));
        for (const x of this.edges) if (x.from === v && unmet.some((n) => n.id === x.to)) x.label = "open criteria";
        return [v];
      }
      case "effect": {
        const info = effectInfo(this.program, e.name);
        const detail = [info.irreversible ? "irreversible" : info.critical ? "critical" : "", e.idempotent_by ? "idempotent" : "", e.compensate ? `compensation offered: ${e.compensate}` : ""].filter(Boolean);
        return [this.add("effect", e.name, detail, prev)];
      }
      case "infer":
        return [this.add("infer", `infer ${"ref" in e.type ? e.type.ref : "value"}`, [], prev)];
      case "escalate":
        return [this.add("human", "person: escalation", [], prev)];
      case "pause":
        return [this.add("human", "person: pause", [], prev)];
      case "call": {
        const p = calleePath(e.callee);
        if (p === "human.ask") return [this.add("human", "person: question", [], prev)];
        if (p && STD_FNS[p] && p !== "human.approve") return [this.add("read", p, [], prev)];
        return prev;
      }
      default:
        return prev;
    }
  }
}

function criteria(program: Program, contract: string): string[] {
  const c = program.defs[contract];
  if (c?.kind !== "contract") return [];
  return [...Object.entries(c.accept), ...Object.entries(c.invariant ?? {})].map(([n, k]) => `${n}: ${methodOf(k.by)}`);
}

export function methodOf(v: Verifier): string {
  if ("all" in v) return v.all.map(methodOf).join(" and ");
  if ("static" in v) return "static";
  return v.call.op === "call" ? (calleePath(v.call.callee) ?? "call") : "call";
}

function mermaidText(s: string): string {
  return s.replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;");
}

function mermaid(wf: string, budget: string, nodes: ArchNode[], edges: ArchEdge[]): string {
  const shape = (n: ArchNode): string => {
    const label = [n.label, ...n.detail].map(mermaidText).join("<br/>");
    const text = `"${label}"`;
    switch (n.kind) {
      case "verify":
        return `${n.id}{{${text}}}`;
      case "effect":
        return `${n.id}[(${text})]`;
      case "human":
        return `${n.id}[/${text}/]`;
      case "infer":
        return `${n.id}([${text}])`;
      default:
        return `${n.id}[${text}]`;
    }
  };
  const lines = ["flowchart LR", `  subgraph ${mermaidText(wf)}["workflow ${mermaidText(wf)} · budget ${mermaidText(budget)}"]`];
  for (const n of nodes) lines.push(`    ${shape(n)}`);
  lines.push("  end");
  for (const e of edges) lines.push(`  ${e.from} -->${e.label ? `|${mermaidText(e.label)}|` : ""} ${e.to}`);
  return lines.join("\n");
}

export function architecture(program: Program): ArchitectureView {
  const workflows: WorkflowArchitecture[] = [];
  for (const [name, d] of Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (d.kind !== "workflow") continue;
    const g = new Graph(program, d);
    g.block(d.body, []);
    const budget = show(d.budget);
    workflows.push({ workflow: name, budget, nodes: g.nodes, edges: g.edges, mermaid: mermaid(name, budget, g.nodes, g.edges) });
  }
  return { format: VIEW_FORMAT, kind: "architecture", program: programRef(program), workflows };
}

// ── authority ─────────────────────────────────────────────────────────────

export interface AuthorityRow extends Authority {
  who: string;
  kind: "agent" | "workflow" | "delegation";
  /** For a workflow: the external effects its body commits, and how each is authorized by default. */
  effects: string[];
}

export interface AuthorityView {
  format: typeof VIEW_FORMAT;
  kind: "authority";
  program: ProgramRef;
  rows: AuthorityRow[];
}

function workflowEffects(program: Program, body: Stmt[]): string[] {
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const n = v as { op?: unknown; name?: unknown };
      if (n.op === "effect" && typeof n.name === "string") {
        const info = effectInfo(program, n.name);
        out.add(`${n.name} (${info.irreversible ? "irreversible; a person authorizes" : info.critical ? "critical; policy authorizes" : "not critical"})`);
      }
      Object.values(v).forEach(visit);
    }
  };
  visit(body);
  return [...out].sort();
}

export function authority(program: Program): AuthorityView {
  const rows: AuthorityRow[] = [];
  const defs = Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1));
  for (const [name, d] of defs) {
    if (d.kind === "agent") rows.push({ who: d.remote ? `${name} (remote)` : name, kind: "agent", effects: [], ...authorityOf(d.caps.map((c) => capOf(program, c)).filter((c): c is CapVal => !!c)) });
  }
  for (const [name, d] of defs) {
    if (d.kind !== "workflow") continue;
    rows.push({ who: name, kind: "workflow", effects: workflowEffects(program, d.body), ...authorityOf(d.caps.map((c) => capOf(program, c)).filter((c): c is CapVal => !!c)) });
    const visit = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === "object") {
        const e = v as Expr;
        if (e.op === "delegate") {
          const agent = program.defs[e.agent];
          if (agent?.kind === "agent") rows.push({ who: `${name} → ${e.agent}.${e.skill}${e.caps?.length ? " (with caps)" : ""}`, kind: "delegation", effects: [], ...authorityOf(grantOf(program, d, agent, e.caps ?? [])) });
        }
        Object.values(v).forEach(visit);
      }
    };
    visit(d.body);
  }
  return { format: VIEW_FORMAT, kind: "authority", program: programRef(program), rows };
}

// ── cost ──────────────────────────────────────────────────────────────────

export interface CostRow {
  call: string;
  /** How many times it may run: par branches once each, loops max_iter times, a restart's attempts, a fallback once. */
  times: number;
  budget: string;
  from: "call" | "skill" | "agent" | "none";
  /** With a lock: the per-call upper bound of a model turn, and steps × that bound (W0504). */
  per_call?: string;
  steps_bound?: string;
}

export interface WorkflowCost {
  workflow: string;
  limit: string;
  rows: CostRow[];
  /** The static upper bound of what the workflow hands out: sequences and par add up, if takes the larger branch. */
  total: string;
}

export interface CostView {
  format: typeof VIEW_FORMAT;
  kind: "cost";
  program: ProgramRef;
  workflows: WorkflowCost[];
}

interface Sum {
  spend: Record<string, number>;
  tokens: number;
  steps: number;
}

const zero = (): Sum => ({ spend: {}, tokens: 0, steps: 0 });
function add(a: Sum, b: Sum, times = 1): Sum {
  for (const [c, v] of Object.entries(b.spend)) a.spend[c] = (a.spend[c] ?? 0) + v * times;
  a.tokens += b.tokens * times;
  a.steps += b.steps * times;
  return a;
}
function max(a: Sum, b: Sum): Sum {
  const out = zero();
  for (const c of new Set([...Object.keys(a.spend), ...Object.keys(b.spend)])) out.spend[c] = Math.max(a.spend[c] ?? 0, b.spend[c] ?? 0);
  out.tokens = Math.max(a.tokens, b.tokens);
  out.steps = Math.max(a.steps, b.steps);
  return out;
}
function sumOf(b: Budget | undefined): Sum {
  const s = zero();
  if (b?.spend) s.spend[b.spend.currency] = b.spend.micros;
  s.tokens = b?.tokens ?? 0;
  s.steps = b?.steps ?? 0;
  return s;
}
function showSum(s: Sum): string {
  const parts = [...Object.entries(s.spend).map(([c, v]) => `${v / 1_000_000} ${c}`), ...(s.tokens ? [`${s.tokens} tokens`] : []), ...(s.steps ? [`${s.steps} steps`] : [])];
  return parts.join(" · ") || "—";
}

export function cost(program: Program, lock?: Lock): CostView {
  const workflows: WorkflowCost[] = [];
  for (const [name, d] of Object.entries(program.defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (d.kind !== "workflow") continue;
    const rows: CostRow[] = [];
    const row = (e: Extract<Expr, { op: "delegate" }>, agentName: string, times: number): Sum => {
      const { budget, from } = delegateBudget(program, e, agentName);
      const agent = program.defs[agentName];
      const tier = agent?.kind === "agent" ? grantOf(program, d, agent, e.caps ?? []).find((c) => c.ctor === "model.infer")?.tier : undefined;
      const bound = lock && tier ? perCallBound(lock, tier) : undefined;
      const r: CostRow = { call: `${agentName}.${e.skill}`, times, budget: show(budget), from };
      if (bound) {
        r.per_call = `${bound.spend.micros / 1_000_000} ${bound.spend.currency} · ${bound.tokens} tokens`;
        if (budget?.steps !== undefined) r.steps_bound = `${(budget.steps * bound.spend.micros) / 1_000_000} ${bound.spend.currency} · ${budget.steps * bound.tokens} tokens`;
      }
      rows.push(r);
      return add(zero(), sumOf(budget), times);
    };
    const exprCost = (e: Expr, times: number): Sum => {
      const total = zero();
      if (e.op === "switch") {
        add(total, exprCost(e.on, times));
        return add(total, e.cases.map((c) => exprCost(c.then, times)).reduce(max, zero()));
      }
      if (e.op === "block") return blockCost(e.body, times);
      for (const c of children(e)) add(total, exprCost(c, times));
      if (e.op === "delegate") {
        const sup = e.supervise;
        const maxArg = sup?.name === "restart" ? sup.args?.find((a) => a.name === "max")?.value : undefined;
        const attempts = sup?.name === "restart" ? (maxArg?.op === "int" ? maxArg.value : 1) + 1 : 1;
        add(total, row(e, e.agent, times * attempts));
        const to = sup?.name === "degrade" ? sup.args?.find((a) => a.name === "to")?.value : undefined;
        if (to?.op === "var") add(total, row(e, to.name, times));
      }
      return total;
    };
    const blockCost = (stmts: Stmt[], times: number): Sum => {
      const total = zero();
      for (const s of stmts) {
        if (s.op === "let" || s.op === "expr") add(total, exprCost(s.value, times));
        else if (s.op === "return" && s.value) add(total, exprCost(s.value, times));
        else if (s.op === "par") for (const bn of Object.keys(s.branches).sort()) add(total, exprCost(s.branches[bn]!, times));
        else if (s.op === "if") add(total, max(blockCost(s.then, times), blockCost(s.else ?? [], times)));
        else if (s.op === "loop") add(total, blockCost(s.body, times * (s.max_iter ?? 1)));
      }
      return total;
    };
    const total = blockCost(d.body, 1);
    workflows.push({ workflow: name, limit: show(d.budget), rows, total: showSum(total) });
  }
  return { format: VIEW_FORMAT, kind: "cost", program: programRef(program), workflows };
}

// ── semantic diff (§15.3) ─────────────────────────────────────────────────

export interface Change {
  path: string;
  text: string;
}

export interface DiffView {
  format: typeof VIEW_FORMAT;
  kind: "diff";
  from: ProgramRef;
  to: ProgramRef;
  /** Changes a person must approve (§13.2): authority widened, budgets raised, criteria removed or changed, irreversible effects. */
  governance: Change[];
  behavior: Change[];
  unchanged: string[];
}

const j = (v: unknown): string => canonicalize(v as Json);

function scopeDiff(before: CapVal | undefined, after: CapVal | undefined): { added: string[]; removed: string[]; other: string[] } {
  const label = (c: CapVal): string => ({ "fs.read": "read path", "fs.write": "write path", "net.https": "network host", exec: "command", "git.pr": "repository" })[c.ctor] ?? "scope";
  if (!after) return { added: [], removed: before ? [`${showCap(before)}`] : [], other: [] };
  if (!before || before.ctor !== after.ctor) return { added: [`${showCap(after)}`], removed: before ? [showCap(before)] : [], other: [] };
  // A new path inside an old one widens nothing; an old path still inside a new one was not taken away.
  const covered = (x: string, by: string[]): boolean => by.some((y) => (after.ctor.startsWith("fs.") ? within(x, y) : x === y));
  const b = before.scope ?? [];
  const a = after.scope ?? [];
  const added = a.filter((x) => !covered(x, b)).map((x) => `${label(after)} ${JSON.stringify(x)}`);
  const removed = b.filter((x) => !a.includes(x)).map((x) => `${label(after)} ${JSON.stringify(x)}`);
  if (before.scope !== undefined && after.scope === undefined) added.push(`${label(after)}s without a static scope (unbounded)`);
  const other: string[] = [];
  if (before.tier !== after.tier) other.push(`model tier ${before.tier ?? "any"} → ${after.tier ?? "any"}`);
  if ((before.maxClass ?? "internal") !== (after.maxClass ?? "internal")) other.push(`data class up to ${before.maxClass ?? "internal"} → ${after.maxClass ?? "internal"}`);
  if (j(before.argsPrefix ?? null) !== j(after.argsPrefix ?? null)) other.push(`argument prefixes ${j(before.argsPrefix ?? "any")} → ${j(after.argsPrefix ?? "any")}`);
  return { added, removed, other };
}

function budgetChanges(name: string, before: Budget | undefined, after: Budget | undefined): { up: string[]; down: string[] } {
  const up: string[] = [];
  const down: string[] = [];
  const cmp = (field: string, x: number | undefined, y: number | undefined, fmt: (n: number) => string): void => {
    if (x === undefined && y === undefined) return;
    if (x !== undefined && y === undefined) up.push(`${name}.budget.${field}: ${fmt(x)} → no limit`);
    else if (x === undefined && y !== undefined) down.push(`${name}.budget.${field}: no limit → ${fmt(y)}`);
    else if (y! > x!) up.push(`${name}.budget.${field}: ${fmt(x!)} → ${fmt(y!)}`);
    else if (y! < x!) down.push(`${name}.budget.${field}: ${fmt(x!)} → ${fmt(y!)}`);
  };
  const cur = after?.spend?.currency ?? before?.spend?.currency ?? "";
  cmp("spend", before?.spend?.micros, after?.spend?.micros, (n) => `${n / 1_000_000} ${cur}`);
  cmp("tokens", before?.tokens, after?.tokens, String);
  cmp("steps", before?.steps, after?.steps, String);
  cmp("time", before?.time?.ms, after?.time?.ms, duration);
  return { up, down };
}

function steps(program: Program, wf: WorkflowDef): string[] {
  const g = new Graph(program, wf);
  g.block(wf.body, []);
  // A contract's criteria are compared as the contract; a step here is what runs, with its grant and supervision.
  return g.nodes.map((n) => `${n.kind === "delegate" ? "delegate " : n.kind === "effect" ? "effect " : ""}${n.label}${n.kind !== "verify" && n.detail.length ? ` [${n.detail.join(", ")}]` : ""}`);
}

export function semanticDiff(before: Program, after: Program): DiffView {
  const governance: Change[] = [];
  const behavior: Change[] = [];
  const names = [...new Set([...Object.keys(before.defs), ...Object.keys(after.defs)])].sort();
  for (const name of names) {
    const b = Object.hasOwn(before.defs, name) ? before.defs[name] : undefined;
    const a = Object.hasOwn(after.defs, name) ? after.defs[name] : undefined;
    const path = `/defs/${name}`;
    if (b && a && j(b) === j(a)) continue;
    if (!a) {
      (b?.kind === "contract" ? governance : behavior).push({ path, text: `- ${b!.kind} ${name} removed` });
      continue;
    }
    if (!b) {
      if (a.kind === "capability") governance.push({ path, text: `+ capability ${showCap(capOf(after, { op: "var", name }) ?? { ctor: "?", effect: "?", write: false, name })}` });
      else if (a.kind === "agent" && a.remote) governance.push({ path, text: `+ remote agent ${name}` });
      else if (a.kind === "effect" && a.irreversible) governance.push({ path, text: `+ irreversible effect ${name}` });
      else behavior.push({ path, text: `+ ${a.kind} ${name}` });
      continue;
    }
    if (a.kind !== b.kind) {
      governance.push({ path, text: `~ ${name}: ${b.kind} → ${a.kind}` });
      continue;
    }
    switch (a.kind) {
      case "capability": {
        const d = scopeDiff(capOf(before, { op: "var", name }), capOf(after, { op: "var", name }));
        for (const x of d.added) governance.push({ path, text: `+ ${name}: ${x}` });
        for (const x of d.other) governance.push({ path, text: `~ ${name}: ${x}` });
        for (const x of d.removed) behavior.push({ path, text: `- ${name}: ${x} (narrowed)` });
        break;
      }
      case "agent":
      case "workflow": {
        const bd = b as AgentDef | WorkflowDef;
        const had = new Set(bd.caps.map(j));
        const has = new Set(a.caps.map(j));
        a.caps.forEach((c, i) => {
          if (!had.has(j(c))) governance.push({ path: `${path}/caps/${i}`, text: `+ ${name}: ${showCap(capOf(after, c) ?? { ctor: "?", effect: "?", write: false })}` });
        });
        bd.caps.forEach((c) => {
          if (!has.has(j(c))) behavior.push({ path: `${path}/caps`, text: `- ${name}: ${showCap(capOf(before, c) ?? { ctor: "?", effect: "?", write: false })} (narrowed)` });
        });
        const bc = budgetChanges(name, bd.budget, a.budget);
        bc.up.forEach((t) => governance.push({ path: `${path}/budget`, text: `~ ${t}` }));
        bc.down.forEach((t) => behavior.push({ path: `${path}/budget`, text: `~ ${t}` }));
        if (a.kind === "agent") {
          const ba = bd as AgentDef;
          for (const sn of [...new Set([...Object.keys(ba.skills), ...Object.keys(a.skills)])].sort()) {
            const bs = ba.skills[sn];
            const as = a.skills[sn];
            if (!as) behavior.push({ path: `${path}/skills/${sn}`, text: `- skill ${name}.${sn}` });
            else if (!bs) behavior.push({ path: `${path}/skills/${sn}`, text: `+ skill ${name}.${sn}` });
            else {
              const sb = budgetChanges(`${name}.${sn}`, bs.budget, as.budget);
              sb.up.forEach((t) => governance.push({ path: `${path}/skills/${sn}/budget`, text: `~ ${t}` }));
              sb.down.forEach((t) => behavior.push({ path: `${path}/skills/${sn}/budget`, text: `~ ${t}` }));
              if (j({ p: bs.params, r: bs.returns, e: bs.effects, b: bs.body ?? null }) !== j({ p: as.params, r: as.returns, e: as.effects, b: as.body ?? null })) behavior.push({ path: `${path}/skills/${sn}`, text: `~ skill ${name}.${sn} changed` });
            }
          }
          if (j([ba.loop ?? null, ba.progress ?? null, ba.role ?? null, ba.model ?? null]) !== j([a.loop ?? null, a.progress ?? null, a.role ?? null, a.model ?? null])) behavior.push({ path, text: `~ ${name}: role, loop strategy or progress thresholds changed` });
          if (j(ba.remote ?? null) !== j(a.remote ?? null)) governance.push({ path: `${path}/remote`, text: `~ ${name}: remote binding changed` });
        } else {
          const bw = bd as WorkflowDef;
          const before_ = steps(before, bw);
          const after_ = steps(after, a);
          for (const s of after_.filter((x) => !before_.includes(x))) behavior.push({ path: `${path}/body`, text: `+ step: ${s}` });
          for (const s of before_.filter((x) => !after_.includes(x))) behavior.push({ path: `${path}/body`, text: `- step: ${s}` });
          if (!before_.some((x) => !after_.includes(x)) && !after_.some((x) => !before_.includes(x)) && j(bw.body) !== j(a.body)) behavior.push({ path: `${path}/body`, text: `~ ${name}: the body changed, with the same steps` });
          if (j(bw.ensures ?? null) !== j(a.ensures ?? null)) behavior.push({ path: `${path}/ensures`, text: `~ ${name}: ensures changed` });
          if (j(bw.on ?? null) !== j(a.on ?? null)) behavior.push({ path: `${path}/on`, text: `~ ${name}: event handlers changed` });
        }
        break;
      }
      case "contract": {
        const bc = b as ContractDef;
        for (const group of ["accept", "invariant"] as const) {
          const was = bc[group] ?? {};
          const now = a[group] ?? {};
          for (const k of Object.keys(was).sort()) {
            if (!(k in now)) governance.push({ path: `${path}/${group}/${k}`, text: `- ${name}.${k} (${methodOf(was[k]!.by)}) removed` });
            else if (j(was[k]!.by) !== j(now[k]!.by)) governance.push({ path: `${path}/${group}/${k}`, text: `~ ${name}.${k}: ${methodOf(was[k]!.by)} → ${methodOf(now[k]!.by)}` });
          }
          for (const k of Object.keys(now).sort()) if (!(k in was)) behavior.push({ path: `${path}/${group}/${k}`, text: `+ ${name}.${k} by ${methodOf(now[k]!.by)}` });
        }
        if (j(bc.require ?? null) !== j(a.require ?? null)) governance.push({ path: `${path}/require`, text: `~ ${name}: require changed` });
        break;
      }
      case "effect": {
        const be = b as EffectDef;
        if (a.irreversible && !be.irreversible) governance.push({ path, text: `~ effect ${name} became irreversible` });
        else if (j(be) !== j(a)) behavior.push({ path, text: `~ effect ${name} changed` });
        break;
      }
      default:
        behavior.push({ path, text: `~ ${a.kind} ${name} changed` });
    }
  }
  const critical = (p: Program): string[] =>
    Object.values(p.defs)
      .filter((d): d is WorkflowDef => d.kind === "workflow")
      .flatMap((w) => workflowEffects(p, w.body))
      .sort();
  const unchanged: string[] = [];
  const cb = critical(before);
  const ca = critical(after);
  if (j(cb) === j(ca)) unchanged.push(cb.length ? `external effects unchanged: ${cb.join(", ")}` : "no external effects, before or after");
  const contracts = (p: Program) => Object.entries(p.defs).filter(([, d]) => d.kind === "contract");
  if (j(contracts(before)) === j(contracts(after))) unchanged.push("contracts and their criteria unchanged");
  if (!governance.some((g) => g.text.startsWith("+") || g.text.includes("tier") || g.text.includes("data class"))) unchanged.push("no authority added");
  if (!governance.some((g) => g.text.includes(".budget."))) unchanged.push("no budget raised");
  return { format: VIEW_FORMAT, kind: "diff", from: programRef(before), to: programRef(after), governance, behavior, unchanged };
}

// ── documents ─────────────────────────────────────────────────────────────

const list = (xs: string[]): string => xs.join(", ") || "—";

export function architectureBlocks(v: ArchitectureView): Block[] {
  const out: Block[] = [{ h: "Architecture" }];
  for (const w of v.workflows) {
    out.push({ p: `Workflow ${w.workflow}, budget ${w.budget}.` });
    out.push({ code: w.mermaid, lang: "mermaid" });
    out.push({
      table: {
        head: ["Step", "Kind", "Detail", "After"],
        rows: w.nodes.map((n) => [n.label, n.kind, n.detail.join(" · ") || "—", list(w.edges.filter((e) => e.to === n.id).map((e) => `${w.nodes.find((x) => x.id === e.from)?.label ?? e.from}${e.label ? ` (${e.label})` : ""}`))]),
      },
    });
  }
  return out;
}

export function authorityBlocks(v: AuthorityView): Block[] {
  return [
    { h: "Authority" },
    {
      table: {
        head: ["Who", "Kind", "Read", "Write", "Network", "Model", "Run", "Pull requests", "Money", "External effects", "Unbounded"],
        rows: v.rows.map((r) => [r.who, r.kind, list(r.read), list(r.write), list(r.network), list(r.model), list(r.exec), list(r.repos), list(r.money), list(r.effects), list(r.unbounded)] as Cell[]),
      },
    },
  ];
}

export function costBlocks(v: CostView): Block[] {
  const out: Block[] = [{ h: "Cost (static upper bound)" }];
  for (const w of v.workflows) {
    out.push({ p: `Workflow ${w.workflow}: limit ${w.limit}; handed out at most ${w.total}.` });
    out.push({ table: { head: ["Delegation", "Times", "Budget", "From", "Per-call bound", "Steps × bound"], rows: w.rows.map((r) => [r.call, String(r.times), r.budget, r.from, r.per_call ?? "—", r.steps_bound ?? "—"]) } });
  }
  return out;
}

export function diffBlocks(v: DiffView): Block[] {
  const lines = (cs: Change[]): Cell[] => (cs.length ? cs.map((c) => ({ text: c.text, mono: true })) : ["none"]);
  return [
    { h: "What changed" },
    { p: `From ${v.from.hash} to ${v.to.hash}.` },
    { h: "Governance changes (a person must approve)" },
    { list: lines(v.governance) },
    { h: "Behavior changes" },
    { list: lines(v.behavior) },
    { h: "Unchanged" },
    { list: v.unchanged.length ? v.unchanged : ["—"] },
  ];
}

/** The program's views as one document, headed by the hash they show. */
export function programDoc(program: Program, lock?: Lock): Doc {
  const ref = programRef(program);
  return {
    title: `${ref.module} ${ref.version}`,
    meta: [
      ["Program", ref.hash],
      ["Language", ref.language],
      ["View", `${VIEW_FORMAT}, generated from the program alone`],
    ],
    blocks: [...architectureBlocks(architecture(program)), ...authorityBlocks(authority(program)), ...costBlocks(cost(program, lock))],
  };
}

export function diffDoc(before: Program, after: Program): Doc {
  const v = semanticDiff(before, after);
  return {
    title: `${v.to.module}: ${v.from.version} → ${v.to.version}`,
    meta: [
      ["From", v.from.hash],
      ["To", v.to.hash],
      ["View", `${VIEW_FORMAT}, generated from the two programs`],
    ],
    blocks: diffBlocks(v),
  };
}
