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
//                  criteria removed or changed, irreversible effects, the
//                  locks' members and roles), behavior changes, and what
//                  stayed the same (§15.3)
//   card           for a workflow with an envelope, what a person reads
//                  before approving it: what it does, what it can touch,
//                  the most it spends, when it asks whom, who approves it,
//                  and the package hash the approval binds to

import { calleePath, capCovers, capsOf, showCap, within, type CapVal } from "../check/caps.js";
import { microsText, staticCost } from "../check/cost.js";
import { roleSites } from "../check/roles.js";
import { readsVar } from "../check/static.js";
import { hashProgram, packageHash } from "../hash.js";
import {
  BUDGET_DIMENSIONS,
  budgetAmount,
  workflowBounds,
  type AgentDef,
  type Budget,
  type BudgetDimension,
  type ComponentDef,
  type ContractDef,
  type Def,
  type EffectDef,
  type Envelope,
  type EnvironmentDef,
  type Expr,
  type FnDef,
  type InterfaceDef,
  type Program,
  type Stmt,
  type TypeExpr,
  type Verifier,
  type WorkflowDef,
} from "../ir/types.js";
import { link, linkedProgram, type Modules } from "../modules.js";
import { ptr, ptrToken } from "../diag.js";
import { canonicalize } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import { own, packagedLock, perCallBound, type Lock } from "../lock.js";
import { DATA_CLASSES, STD_EFFECTS, STD_FNS } from "../std/std.js";
import { coTenancyFor, floorFor, ISOLATION_LEVELS, type IsolationLevel } from "../target/sandbox.js";
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

/** The capabilities a list of capability expressions stands for (component capabilities may stand for several). */
export function capsIn(program: Program, list: Expr[]): CapVal[] {
  return list.flatMap((e) => capsOf(program.defs, e, { language: program.language }));
}

/** `c.narrow(v)` whose scope is a value of the run: where it lies is known only then. */
function chosenAtRunTime(e: Expr): boolean {
  return e.op === "call" && e.callee.op === "field" && e.callee.name === "narrow" && e.args.some((a) => a.value.op !== "text");
}

/**
 * What a list of `with caps` stands for in a view of the program. A narrowing whose scope the run chooses is
 * shown as the capability it narrows: the scope must lie inside that one (`outside_capability`), so it is the
 * most the narrowing can be. Read by itself it has no scope, and a view would call it unbounded.
 */
function widest(program: Program, list: Expr[]): CapVal[] {
  return list.flatMap((e) => capsOf(program.defs, chosenAtRunTime(e) && e.op === "call" && e.callee.op === "field" ? e.callee.of : e, { language: program.language }));
}

/** The kinds of capability in a list of `with caps` whose scope the run chooses. */
function lateKinds(program: Program, list: Expr[]): string[] {
  return widest(program, list.filter(chosenAtRunTime)).map((c) => c.ctor);
}

/** What a map hands the delegations of its body: its `with caps`, and what a map around it hands of other kinds. */
function handedBy(program: Program, outer: CapVal[], map: Extract<Expr, { op: "map" }>): CapVal[] {
  const given = widest(program, map.caps ?? []);
  const kinds = new Set(given.map((g) => g.ctor));
  return [...outer.filter((c) => !kinds.has(c.ctor)), ...given];
}

/**
 * What a delegation is granted at run time: the agent's capabilities inside the workflow's, `with caps`
 * replacing its kinds (C2). `handed` is what a map around the delegation hands it: one of those replaces a
 * kind too, where the agent holds it at least as widely and the delegation names none (spec/envelope.md "map").
 */
export function grantOf(program: Program, wf: WorkflowDef, agent: AgentDef, withCaps: Expr[] = [], handed: CapVal[] = []): CapVal[] {
  const avail = capsIn(program, workflowBounds(wf).caps);
  const held = capsIn(program, agent.caps);
  let out = held.filter((c) => avail.some((a) => capCovers(a, c)));
  const given = widest(program, withCaps);
  const own = new Set(given.map((g) => g.ctor));
  for (const k of handed) if (!own.has(k.ctor) && (agent.remote || held.some((a) => capCovers(a, k)))) given.push(k);
  if (given.length) {
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
    // A host a 0.5 capability allows only some methods of is shown with them.
    else if (c.ctor === "net.https") a.network.push(...scope.map((h) => (c.methods ? `${h} (${c.methods.join(", ")})` : h)));
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
    case "plan":
      return e.args.map((a) => a.value);
    case "map":
      return [e.over];
    case "verify":
      return [e.value, ...e.args.map((a) => a.value)];
    case "effect":
      return e.args.map((a) => a.value);
    case "changeset":
      return [e.plan, ...Object.values(e.members).flatMap((m) => m.args.map((a) => a.value))];
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
  if (b.agents !== undefined) parts.push(`${b.agents} agents`);
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
  kind: "delegate" | "verify" | "effect" | "changeset" | "human" | "infer" | "read" | "map";
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
  /** Inside a map's body: what the map hands each delegation. */
  private handed: CapVal[] = [];

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
        const grant = agent?.kind === "agent" ? grantOf(this.program, this.wf, agent, e.caps ?? [], this.handed) : [];
        const detail = [shortCaps(grant), e.isolated ? "isolated" : "", supervision(e) ?? "", e.timeout?.op === "duration" ? `timeout ${duration(e.timeout.ms)}` : ""].filter(Boolean);
        return [this.add("delegate", `${e.agent}.${e.skill}`, detail, prev)];
      }
      case "map": {
        // One node for the map, then its body once: each item runs the same steps (spec/envelope.md "map").
        const bound = [e.max !== undefined ? `at most ${e.max} items` : "", `${e.par ?? 1} at a time`, e.caps?.length ? "with caps" : "", e.supervise ? e.supervise.name : ""].filter(Boolean);
        const outer = this.handed;
        this.handed = handedBy(this.program, outer, e);
        const ends = this.block(e.body, [this.add("map", `map ${e.bind}`, bound, prev)]);
        this.handed = outer;
        return ends;
      }
      case "plan": {
        const lead = this.program.defs[e.agent];
        const grant = lead?.kind === "agent" ? grantOf(this.program, this.wf, lead) : [];
        return [this.add("delegate", `plan ${e.agent}.${e.skill}`, [shortCaps(grant), "submits sub-programs within the envelope"].filter(Boolean), prev)];
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
      case "changeset": {
        // Who approves what, and in which order the members land (doc 9 §3).
        const owner = (m: string): string => {
          const c = this.program.defs[m];
          return e.members[m]!.approver ?? (c?.kind === "component" ? c.owner : "owner");
        };
        const detail = [
          ...e.order.map((m, i) => `${i + 1}. ${m}: ${e.members[m]?.effect ?? "?"} (approved by ${owner(m)})`),
          ...Object.entries(e.changes ?? {}).map(([i, k]) => `${i}: ${k}`),
          `the set approved by ${e.approver}`,
        ];
        return [this.add("changeset", `change set ${e.order.join(" → ")}`, detail, prev)];
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
      case "changeset":
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
    const budget = show(workflowBounds(d).budget);
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
      if (n.op === "changeset") {
        const cs = v as Extract<Expr, { op: "changeset" }>;
        for (const [m, mem] of Object.entries(cs.members)) out.add(`${mem.effect} on ${m} (change set: its owner and ${cs.approver} authorize)`);
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
    if (d.kind === "agent") rows.push({ who: d.remote ? `${name} (remote)` : name, kind: "agent", effects: [], ...authorityOf(capsIn(program, d.caps)) });
  }
  for (const [name, d] of defs) {
    if (d.kind !== "workflow") continue;
    rows.push({ who: name, kind: "workflow", effects: workflowEffects(program, d.body), ...authorityOf(capsIn(program, workflowBounds(d).caps)) });
    // `late` is the kinds the maps around a step hand with a scope the run chooses.
    const visit = (v: unknown, handed: CapVal[], late: string[]): void => {
      if (Array.isArray(v)) v.forEach((x) => visit(x, handed, late));
      else if (v && typeof v === "object") {
        const e = v as Expr;
        if (e.op === "delegate") {
          const agent = program.defs[e.agent];
          if (agent?.kind === "agent") {
            const grant = grantOf(program, d, agent, e.caps ?? [], handed);
            // A kind the delegation names is its own to narrow. Any other kind comes from the maps around it.
            const own = new Set(widest(program, e.caps ?? []).map((c) => c.ctor));
            const atRun = new Set([...lateKinds(program, e.caps ?? []), ...late.filter((k) => !own.has(k))]);
            // The row then shows the capability that is narrowed: the most the grant can be, not what one run gets.
            const how = !(e.caps?.length || handed.length) ? "" : grant.some((c) => atRun.has(c.ctor)) ? " (with caps, scope chosen at run time)" : " (with caps)";
            rows.push({ who: `${name} → ${e.agent}.${e.skill}${how}`, kind: "delegation", effects: [], ...authorityOf(grant) });
          }
        }
        if (e.op === "map") {
          const kinds = new Set(widest(program, e.caps ?? []).map((c) => c.ctor));
          const inside = [...late.filter((k) => !kinds.has(k)), ...lateKinds(program, e.caps ?? [])];
          for (const [k, x] of Object.entries(e)) visit(x, k === "body" ? handedBy(program, handed, e) : handed, k === "body" ? inside : late);
          return;
        }
        if (e.op === "plan") {
          const lead = program.defs[e.agent];
          if (lead?.kind === "agent") rows.push({ who: `${name} → plan ${e.agent}.${e.skill}`, kind: "delegation", effects: [], ...authorityOf(grantOf(program, d, lead)) });
        }
        Object.values(v).forEach((x) => visit(x, handed, late));
      }
    };
    visit(d.body, [], []);
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
    /** Inside a map's body: what the map hands each delegation. */
    let handed: CapVal[] = [];
    const row = (e: Extract<Expr, { op: "delegate" }>, agentName: string, times: number): Sum => {
      const { budget, from } = delegateBudget(program, e, agentName);
      const agent = program.defs[agentName];
      const tier = agent?.kind === "agent" ? grantOf(program, d, agent, e.caps ?? [], handed).find((c) => c.ctor === "model.infer")?.tier : undefined;
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
      // A map runs its body once per item: `max` items at most, or as many as the envelope has `agents`
      // (spec/envelope.md "map").
      if (e.op === "map") {
        const outer = handed;
        handed = handedBy(program, outer, e);
        add(total, blockCost(e.body, times * (e.max ?? d.envelope?.budget?.agents ?? 1)));
        handed = outer;
        return total;
      }
      if (e.op === "plan") return add(total, row({ op: "delegate", agent: e.agent, skill: e.skill, args: e.args, ...(e.budget ? { budget: e.budget } : {}) }, e.agent, times));
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
    let total = showSum(blockCost(d.body, 1));
    // An envelope bounds the delegations a run starts too: the checker's count, so the view and E0501 agree.
    if (d.envelope) {
      const agents = `${staticCost(program, name)?.agents ?? 0} agents`;
      total = total === "—" ? agents : `${total} · ${agents}`;
    }
    workflows.push({ workflow: name, limit: show(workflowBounds(d).budget), rows, total });
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
  // Methods (0.5): one more method, or none named where some were, widens; fewer narrows.
  const methods = (m: string[] | undefined): string => (m ? m.join(", ") : "any");
  if (j(before.methods ?? null) !== j(after.methods ?? null)) {
    const widened = after.methods === undefined || (before.methods !== undefined && after.methods.some((m) => !before.methods!.includes(m)));
    (widened ? other : removed).push(`methods ${methods(before.methods)} → ${methods(after.methods)}`);
  }
  return { added, removed, other };
}

type SystemDef = ComponentDef | InterfaceDef | EnvironmentDef;

export function isSystem(kind: string): boolean {
  return kind === "component" || kind === "interface" || kind === "environment";
}

/** Field by field, what changed in a component, an interface or an environment. */
function systemChanges(name: string, b: SystemDef, a: SystemDef): string[] {
  const out: string[] = [];
  const field = (label: string, x: unknown, y: unknown): void => {
    if (j(x ?? null) !== j(y ?? null)) out.push(`${a.kind} ${name}.${label}: ${j(x ?? null)} → ${j(y ?? null)}`);
  };
  if (a.kind === "component" && b.kind === "component") {
    for (const f of ["repo", "root", "lang", "owner", "build", "test", "provides", "consumes", "governance"] as const) field(f, b[f], a[f]);
  } else if (a.kind === "interface" && b.kind === "interface") {
    field("protocol", b.protocol, a.protocol);
    field("spec", b.spec, a.spec);
  } else if (a.kind === "environment" && b.kind === "environment") {
    field("class", b.class, a.class);
    for (const r of [...new Set([...Object.keys(b.reads ?? {}), ...Object.keys(a.reads ?? {})])].sort()) field(`reads.${r}`, b.reads?.[r], a.reads?.[r]);
    for (const e of [...new Set([...Object.keys(b.authorize ?? {}), ...Object.keys(a.authorize ?? {})])].sort()) field(`authorize.${e}`, b.authorize?.[e], a.authorize?.[e]);
  }
  return out;
}

/** scopeDiff over what two capability definitions stand for, paired by kind (and by command for exec). */
function scopeDiffs(before: CapVal[], after: CapVal[]): { added: string[]; removed: string[]; other: string[] } {
  const key = (c: CapVal): string => (c.ctor === "exec" ? `exec:${(c.scope ?? []).join(",")}` : c.ctor);
  const out = { added: [] as string[], removed: [] as string[], other: [] as string[] };
  for (const k of [...new Set([...before, ...after].map(key))].sort()) {
    const d = scopeDiff(before.find((c) => key(c) === k), after.find((c) => key(c) === k));
    out.added.push(...d.added);
    out.removed.push(...d.removed);
    out.other.push(...d.other);
  }
  return out;
}

const shownCaps = (p: Program, e: Expr): string => capsIn(p, [e]).map(showCap).join(", ") || j(e);

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
  const was = before?.spend;
  const now = after?.spend;
  const cur = now?.currency ?? was?.currency ?? "";
  for (const dim of SHOWN_DIMENSIONS) {
    // Amounts in two currencies are not comparable: a person approves the change (as apply_patch reports it).
    if (dim === "spend" && was && now && was.currency !== now.currency) up.push(`${name}.budget.spend: ${was.micros / 1_000_000} ${was.currency} → ${now.micros / 1_000_000} ${now.currency}`);
    else cmp(dim, budgetAmount(before, dim), budgetAmount(after, dim), (n) => AMOUNT_TEXT[dim](n, cur));
  }
  return { up, down };
}

/** A budget's dimensions in the order a person reads them: what it costs first. */
const SHOWN_DIMENSIONS: readonly BudgetDimension[] = ["spend", ...BUDGET_DIMENSIONS.filter((d) => d !== "spend")];

/** An amount of each dimension, as a change between two budgets shows it. */
const AMOUNT_TEXT: Record<BudgetDimension, (n: number, currency: string) => string> = {
  tokens: String,
  steps: String,
  time: duration,
  spend: (n, currency) => `${n / 1_000_000} ${currency}`,
  agents: String,
};

function steps(program: Program, wf: WorkflowDef): string[] {
  const g = new Graph(program, wf);
  g.block(wf.body, []);
  // A contract's criteria are compared as the contract; a step here is what runs, with its grant and supervision.
  return g.nodes.map((n) => `${n.kind === "delegate" ? "delegate " : n.kind === "effect" ? "effect " : ""}${n.label}${n.kind !== "verify" && n.detail.length ? ` [${n.detail.join(", ")}]` : ""}`);
}

/**
 * What changed in the people two locks bind: members, their keys and who holds
 * each role. A binding decides who can approve, so each change is a governance
 * change (spec/envelope.md, "The lock: members and roles"; case H05).
 */
export function lockDiff(before: Lock | undefined, after: Lock | undefined): Change[] {
  const out: Change[] = [];
  const at = <T>(r: Record<string, T> | undefined, k: string): T | undefined => (r && Object.hasOwn(r, k) ? r[k] : undefined);
  const names = (x: Record<string, unknown> | undefined, y: Record<string, unknown> | undefined): string[] => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort();
  const bm = before?.members;
  const am = after?.members;
  for (const m of names(bm, am)) {
    const b = at(bm, m);
    const a = at(am, m);
    const path = `/members/${ptrToken(m)}`;
    // An added member's keys come with it, and a removed member's keys go with it: one line each.
    if (!b && a) out.push({ path, text: `+ member ${m} (${a.keys.length} ${a.keys.length === 1 ? "key" : "keys"})` });
    else if (b && !a) out.push({ path, text: `- member ${m}` });
    else if (b && a) {
      for (const k of [...new Set([...b.keys, ...a.keys])].sort()) {
        const now = a.keys.includes(k);
        if (b.keys.includes(k) !== now) out.push({ path: `${path}/keys/${ptrToken(k)}`, text: `${now ? "+" : "-"} key ${k} for ${m}` });
      }
    }
  }
  const br = before?.roles;
  const ar = after?.roles;
  for (const r of names(br, ar)) {
    const b = at(br, r) ?? [];
    const a = at(ar, r) ?? [];
    for (const m of [...new Set([...b, ...a])].sort()) {
      const now = a.includes(m);
      if (b.includes(m) !== now) out.push({ path: `/roles/${ptrToken(r)}/${ptrToken(m)}`, text: now ? `+ ${m} holds role ${r}` : `- ${m} no longer holds role ${r}` });
    }
  }
  return out;
}

/**
 * What changed in what two locks of format 0.5 ask of the runtime's host and of a sandbox (spec/boundary.md
 * "Lock 0.5"). What lets a sandbox do more, or run on less, is a governance change: a credential bound to an
 * agent's requests, added or changed; an isolation floor lowered or taken away; a sandbox that may now share
 * its host; a least host version lowered or taken away. The opposite of each is a behavior change.
 */
export function lockLimitsDiff(before: Lock | undefined, after: Lock | undefined): { governance: Change[]; behavior: Change[] } {
  const governance: Change[] = [];
  const behavior: Change[] = [];
  const names = (x: object | undefined, y: object | undefined): string[] => [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort();
  const at = <T>(r: Partial<Record<string, T>> | undefined, k: string): T | undefined => (r && Object.hasOwn(r, k) ? r[k] : undefined);
  /**
   * One least value: `below` orders values, and none is below all, or is `bottom` when one value means the same
   * as none (a floor of process is no floor). Lowered or taken away is governance; raised or added, behavior.
   */
  const least = (path: string, label: string, b: string | undefined, a: string | undefined, below: (x: string, y: string) => boolean, none: string, bottom?: string): void => {
    const was = b ?? bottom;
    const now = a ?? bottom;
    if (was === now || (was !== undefined && now !== undefined && !below(was, now) && !below(now, was))) return;
    const shown = (v: string | undefined): string => v ?? none;
    const lowered = now === undefined || (was !== undefined && below(now, was));
    (lowered ? governance : behavior).push({ path, text: `~ ${label}: ${shown(b)} → ${shown(a)} (${lowered ? "lowered" : "raised"})` });
  };
  // Versions by number, segment by segment; a missing segment is 0, so 22.23 and 22.23.0 are the same.
  const version = (x: string, y: string): boolean => {
    const xs = x.split(".").map(Number);
    const ys = y.split(".").map(Number);
    for (let i = 0; i < Math.max(xs.length, ys.length); i++) if ((xs[i] ?? 0) !== (ys[i] ?? 0)) return (xs[i] ?? 0) < (ys[i] ?? 0);
    return false;
  };
  for (const tool of names(before?.host, after?.host)) {
    least(`/host/${ptrToken(tool)}`, `host.${tool}`, at(before?.host, tool), at(after?.host, tool), version, "no minimum");
  }
  const level = (x: string, y: string): boolean => ISOLATION_LEVELS.indexOf(x as IsolationLevel) < ISOLATION_LEVELS.indexOf(y as IsolationLevel);
  const bi = before?.isolation;
  const ai = after?.isolation;
  // Floors and sharing are compared as each data class has them in effect: a floor holds for every more sensitive
  // class, so taking one away, or lowering it, may lower what a class that the lock does not name gets.
  for (const cls of DATA_CLASSES) least(`/isolation/floor/${ptrToken(cls)}`, `isolation.floor.${cls} in effect`, floorFor(bi, cls), floorFor(ai, cls), level, "process");
  least("/isolation/untrusted_network", "isolation.untrusted_network", bi?.untrusted_network, ai?.untrusted_network, level, "no floor", "process");
  for (const cls of DATA_CLASSES) {
    const b = coTenancyFor(bi, cls);
    const a = coTenancyFor(ai, cls);
    if (b === a) continue;
    const relaxed = a === "allowed";
    (relaxed ? governance : behavior).push({ path: `/isolation/co_tenancy/${ptrToken(cls)}`, text: `~ isolation.co_tenancy.${cls} in effect: ${b} → ${a} (${relaxed ? "relaxed" : "tightened"})` });
  }
  for (const agent of names(before?.egress, after?.egress)) {
    const b = at(before?.egress, agent);
    const a = at(after?.egress, agent);
    for (const host of names(b, a)) {
      const was = at(b, host);
      const now = at(a, host);
      if (was === now) continue;
      const path = `/egress/${ptrToken(agent)}/${ptrToken(host)}`;
      if (was === undefined) governance.push({ path, text: `+ egress: ${agent}'s requests to ${host} carry credential ${now}` });
      else if (now === undefined) behavior.push({ path, text: `- egress: ${agent}'s requests to ${host} carry credential ${was} no more` });
      else governance.push({ path, text: `~ egress: ${agent}'s requests to ${host} carry credential ${was} → ${now}` });
    }
  }
  return { governance, behavior };
}

/**
 * What changed in a workflow's envelope, line by line: what the one `envelope_changed` of a diff stands for. The
 * owner who decides an amendment is shown these lines beside the hash they sign for (spec/envelope.md
 * "Amendments"). Nothing, when the workflow has no envelope on one side: then the envelope came or went whole.
 */
export function envelopeChanges(before: Program, after: Program, workflow: string, modules: Modules = {}): Change[] {
  const of = (p: Program): Envelope | undefined => {
    const d = Object.hasOwn(p.defs, workflow) ? p.defs[workflow] : undefined;
    return d?.kind === "workflow" ? d.envelope : undefined;
  };
  const b = of(before);
  const a = of(after);
  if (!b || !a) return [];
  const linked = Object.keys(modules).length > 0;
  const lb = linked ? linkedProgram(before, modules) : before;
  const la = linked ? linkedProgram(after, modules) : after;
  const at = `${ptr("defs", workflow)}/envelope`;
  const name = `${workflow}.envelope`;
  const out: Change[] = [];
  if (b.owner !== a.owner) out.push({ path: `${at}/owner`, text: `~ ${name}.owner: ${b.owner ?? "nobody"} → ${a.owner ?? "nobody"}` });
  const had = new Set((b.caps ?? []).map(j));
  const has = new Set((a.caps ?? []).map(j));
  (a.caps ?? []).forEach((c, i) => {
    if (!had.has(j(c))) out.push({ path: `${at}/caps/${i}`, text: `+ ${name}: ${shownCaps(la, c)}` });
  });
  (b.caps ?? []).forEach((c) => {
    if (!has.has(j(c))) out.push({ path: `${at}/caps`, text: `- ${name}: ${shownCaps(lb, c)}` });
  });
  const budget = budgetChanges(name, b.budget, a.budget);
  for (const t of [...budget.up, ...budget.down]) out.push({ path: `${at}/budget`, text: `~ ${t}` });
  const atOnce = (e: Envelope): string => (e.spawn?.max_concurrent === undefined ? "no bound" : String(e.spawn.max_concurrent));
  if (atOnce(b) !== atOnce(a)) out.push({ path: `${at}/spawn/max_concurrent`, text: `~ ${name}.spawn.max_concurrent: ${atOnce(b)} → ${atOnce(a)}` });
  const cls = (e: Envelope): string => e.spawn?.max_class ?? "internal";
  if (cls(b) !== cls(a)) out.push({ path: `${at}/spawn/max_class`, text: `~ ${name}.spawn.max_class: ${cls(b)} → ${cls(a)}` });
  const role = (e: Envelope, effect: string): string | undefined => (e.approve && Object.hasOwn(e.approve, effect) ? e.approve[effect] : undefined);
  for (const effect of [...new Set([...Object.keys(b.approve ?? {}), ...Object.keys(a.approve ?? {})])].sort()) {
    const was = role(b, effect);
    const now = role(a, effect);
    if (was === now) continue;
    const text = was === undefined ? `+ ${name}.approve: ${effect} by ${now}` : now === undefined ? `- ${name}.approve: ${effect} by ${was}` : `~ ${name}.approve: ${effect} by ${was} → ${now}`;
    out.push({ path: `${at}/approve/${ptrToken(effect)}`, text });
  }
  return out;
}

/**
 * What a governance change (§13.2) is, as a machine reads it. The diff shows only each change's text;
 * `mandate.apply_patch` and `mandate patch` report the kind with it (governanceChanges).
 */
export type GovernanceChangeKind =
  /** Authority widened: a capability added or widened, or one more held by an agent or a workflow. */
  | "capability_added"
  | "budget_increased"
  /** A criterion removed, or a whole contract with its criteria. */
  | "criterion_removed"
  /** A criterion checked by another method. */
  | "criterion_changed"
  | "require_changed"
  | "irreversible_added"
  | "system_model_changed"
  | "envelope_changed"
  | "remote_agent_added"
  | "remote_binding_changed"
  /** A definition replaced by one of another kind under the same name. */
  | "kind_changed";

/** A governance change with its kind. */
export interface KindedChange extends Change {
  kind: GovernanceChangeKind;
}

/**
 * The program's own changes from `before` to `after`, each governance change with its kind. Both
 * semanticDiff and governanceChanges read them from here, so a view and a patch classify a change alike.
 * `modules` opens capabilities over imported components; definitions are compared only where the
 * programs themselves hold them.
 */
function classify(before: Program, after: Program, modules: Modules = {}): { governance: KindedChange[]; behavior: Change[] } {
  const governance: KindedChange[] = [];
  const behavior: Change[] = [];
  const linked = Object.keys(modules).length > 0;
  const lb = linked ? linkedProgram(before, modules) : before;
  const la = linked ? linkedProgram(after, modules) : after;
  const names = [...new Set([...Object.keys(before.defs), ...Object.keys(after.defs)])].sort();
  for (const name of names) {
    const b = Object.hasOwn(before.defs, name) ? before.defs[name] : undefined;
    const a = Object.hasOwn(after.defs, name) ? after.defs[name] : undefined;
    const path = `/defs/${name}`;
    if (b && a && j(b) === j(a)) continue;
    if (!a) {
      const text = `- ${b!.kind} ${name} removed`;
      if (b!.kind === "contract") governance.push({ kind: "criterion_removed", path, text });
      else if (isSystem(b!.kind)) governance.push({ kind: "system_model_changed", path, text });
      else behavior.push({ path, text });
      continue;
    }
    if (!b) {
      if (a.kind === "capability") governance.push({ kind: "capability_added", path, text: `+ capability ${shownCaps(la, { op: "var", name })}` });
      else if (isSystem(a.kind)) governance.push({ kind: "system_model_changed", path, text: `+ ${a.kind} ${name} (system model)` });
      else if (a.kind === "agent" && a.remote) governance.push({ kind: "remote_agent_added", path, text: `+ remote agent ${name}` });
      else if (a.kind === "effect" && a.irreversible) governance.push({ kind: "irreversible_added", path, text: `+ irreversible effect ${name}` });
      else {
        behavior.push({ path, text: `+ ${a.kind} ${name}` });
        // A workflow is where authority starts: every capability a new one holds is authority added (G11).
        if (a.kind === "workflow") {
          const bounds = workflowBounds(a);
          bounds.caps.forEach((c, i) => governance.push({ kind: "capability_added", path: `${path}/${bounds.capsAt}/${i}`, text: `+ ${name}: ${shownCaps(la, c)}` }));
          if (a.envelope) governance.push({ kind: "envelope_changed", path: `${path}/envelope`, text: `+ ${name}: envelope` });
        }
      }
      continue;
    }
    if (a.kind !== b.kind) {
      governance.push({ kind: "kind_changed", path, text: `~ ${name}: ${b.kind} → ${a.kind}` });
      continue;
    }
    switch (a.kind) {
      case "capability": {
        const d = scopeDiffs(capsIn(lb, [{ op: "var", name }]), capsIn(la, [{ op: "var", name }]));
        for (const x of d.added) governance.push({ kind: "capability_added", path, text: `+ ${name}: ${x}` });
        for (const x of d.other) governance.push({ kind: "capability_added", path, text: `~ ${name}: ${x}` });
        for (const x of d.removed) behavior.push({ path, text: `- ${name}: ${x} (narrowed)` });
        // What the scopes do not show may still widen: the amount `money.spend` allows, or a capability over a
        // module that is not loaded here. A change this diff cannot read is a person's to see.
        if (!d.added.length && !d.other.length && !d.removed.length) governance.push({ kind: "capability_added", path, text: `~ capability ${name} changed` });
        break;
      }
      case "agent":
      case "workflow": {
        const bd = b as AgentDef | WorkflowDef;
        const had = new Set(bd.caps.map(j));
        const has = new Set(a.caps.map(j));
        a.caps.forEach((c, i) => {
          if (!had.has(j(c))) governance.push({ kind: "capability_added", path: `${path}/caps/${i}`, text: `+ ${name}: ${shownCaps(la, c)}` });
        });
        bd.caps.forEach((c) => {
          if (!has.has(j(c))) behavior.push({ path: `${path}/caps`, text: `- ${name}: ${shownCaps(lb, c)} (narrowed)` });
        });
        const bc = budgetChanges(name, bd.budget, a.budget);
        bc.up.forEach((t) => governance.push({ kind: "budget_increased", path: `${path}/budget`, text: `~ ${t}` }));
        bc.down.forEach((t) => behavior.push({ path: `${path}/budget`, text: `~ ${t}` }));
        if (a.kind === "agent") {
          const ba = bd as AgentDef;
          for (const sn of [...new Set([...Object.keys(ba.skills), ...Object.keys(a.skills)])].sort()) {
            const bs = Object.hasOwn(ba.skills, sn) ? ba.skills[sn] : undefined;
            const as = Object.hasOwn(a.skills, sn) ? a.skills[sn] : undefined;
            if (!as) behavior.push({ path: `${path}/skills/${sn}`, text: `- skill ${name}.${sn}` });
            else if (!bs) behavior.push({ path: `${path}/skills/${sn}`, text: `+ skill ${name}.${sn}` });
            else {
              const sb = budgetChanges(`${name}.${sn}`, bs.budget, as.budget);
              sb.up.forEach((t) => governance.push({ kind: "budget_increased", path: `${path}/skills/${sn}/budget`, text: `~ ${t}` }));
              sb.down.forEach((t) => behavior.push({ path: `${path}/skills/${sn}/budget`, text: `~ ${t}` }));
              if (j({ p: bs.params, r: bs.returns, e: bs.effects, b: bs.body ?? null }) !== j({ p: as.params, r: as.returns, e: as.effects, b: as.body ?? null })) behavior.push({ path: `${path}/skills/${sn}`, text: `~ skill ${name}.${sn} changed` });
            }
          }
          if (j([ba.loop ?? null, ba.progress ?? null, ba.role ?? null, ba.model ?? null]) !== j([a.loop ?? null, a.progress ?? null, a.role ?? null, a.model ?? null])) behavior.push({ path, text: `~ ${name}: role, loop strategy or progress thresholds changed` });
          if (j(ba.remote ?? null) !== j(a.remote ?? null)) governance.push({ kind: "remote_binding_changed", path: `${path}/remote`, text: `~ ${name}: remote binding changed` });
        } else {
          const bw = bd as WorkflowDef;
          const before_ = steps(lb, bw);
          const after_ = steps(la, a);
          for (const s of after_.filter((x) => !before_.includes(x))) behavior.push({ path: `${path}/body`, text: `+ step: ${s}` });
          for (const s of before_.filter((x) => !after_.includes(x))) behavior.push({ path: `${path}/body`, text: `- step: ${s}` });
          if (!before_.some((x) => !after_.includes(x)) && !after_.some((x) => !before_.includes(x)) && j(bw.body) !== j(a.body)) behavior.push({ path: `${path}/body`, text: `~ ${name}: the body changed, with the same steps` });
          // The envelope is what a person approved for the run: any change to it is theirs to see (spec/envelope.md).
          if (j(bw.envelope ?? null) !== j(a.envelope ?? null)) governance.push({ kind: "envelope_changed", path: `${path}/envelope`, text: `~ ${name}: envelope ${!bw.envelope ? "added" : !a.envelope ? "removed" : "changed"}` });
          if (j(bw.ensures ?? null) !== j(a.ensures ?? null)) behavior.push({ path: `${path}/ensures`, text: `~ ${name}: ensures changed` });
          if (j(bw.on ?? null) !== j(a.on ?? null)) behavior.push({ path: `${path}/on`, text: `~ ${name}: event handlers changed` });
        }
        break;
      }
      case "fn": {
        // A function's budget bounds what a call to it may spend, as an agent's does: raising it is a governance change.
        budgetChanges(name, (b as FnDef).budget, a.budget).up.forEach((t) => governance.push({ kind: "budget_increased", path: `${path}/budget`, text: `~ ${t}` }));
        behavior.push({ path, text: `~ fn ${name} changed` });
        break;
      }
      case "contract": {
        const bc = b as ContractDef;
        for (const group of ["accept", "invariant"] as const) {
          const was = bc[group] ?? {};
          const now = a[group] ?? {};
          for (const k of Object.keys(was).sort()) {
            if (!Object.hasOwn(now, k)) governance.push({ kind: "criterion_removed", path: `${path}/${group}/${k}`, text: `- ${name}.${k} (${methodOf(was[k]!.by)}) removed` });
            else if (j(was[k]!.by) !== j(now[k]!.by)) governance.push({ kind: "criterion_changed", path: `${path}/${group}/${k}`, text: `~ ${name}.${k}: ${methodOf(was[k]!.by)} → ${methodOf(now[k]!.by)}` });
          }
          for (const k of Object.keys(now).sort()) if (!Object.hasOwn(was, k)) behavior.push({ path: `${path}/${group}/${k}`, text: `+ ${name}.${k} by ${methodOf(now[k]!.by)}` });
        }
        if (j(bc.require ?? null) !== j(a.require ?? null)) governance.push({ kind: "require_changed", path: `${path}/require`, text: `~ ${name}: require changed` });
        break;
      }
      case "effect": {
        const be = b as EffectDef;
        if (a.irreversible && !be.irreversible) governance.push({ kind: "irreversible_added", path, text: `~ effect ${name} became irreversible` });
        else if (j(be) !== j(a)) behavior.push({ path, text: `~ effect ${name} changed` });
        break;
      }
      case "component":
      case "interface":
      case "environment":
        // The system model is the institution's, not the program's: every change to it is a governance change (doc 9 §1, §5.3).
        for (const t of systemChanges(name, b as SystemDef, a)) governance.push({ kind: "system_model_changed", path, text: `~ ${t}` });
        break;
      default:
        behavior.push({ path, text: `~ ${a.kind} ${name} changed` });
    }
  }
  return { governance, behavior };
}

/**
 * The governance changes from `before` to `after`, each with its kind: the semantic diff's, without the
 * locks' (a patch changes the program, not the lock). `mandate.apply_patch` reports these.
 */
export function governanceChanges(before: Program, after: Program, modules: Modules = {}): KindedChange[] {
  return classify(before, after, modules).governance;
}

/** With `locks`, the people the two locks bind are compared too (lockDiff), and listed as governance changes. */
export function semanticDiff(before: Program, after: Program, locks?: { before?: Lock; after?: Lock }): DiffView {
  const changes = classify(before, after);
  const governance: Change[] = changes.governance.map(({ path, text }) => ({ path, text }));
  const behavior = changes.behavior;
  // After the program's own changes, so a diff without locks, or with the same people in both, reads as it did.
  if (locks) {
    governance.push(...lockDiff(locks.before, locks.after));
    // Then what the locks ask of the host and the sandboxes (0.5); a lock without it adds nothing.
    const limits = lockLimitsDiff(locks.before, locks.after);
    governance.push(...limits.governance);
    behavior.push(...limits.behavior);
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
  if (!governance.some((g) => g.text.startsWith("+") || g.text.includes("tier") || g.text.includes("data class") || g.text.includes(": methods "))) unchanged.push("no authority added");
  if (!governance.some((g) => g.text.includes(".budget."))) unchanged.push("no budget raised");
  return { format: VIEW_FORMAT, kind: "diff", from: programRef(before), to: programRef(after), governance, behavior, unchanged };
}

// ── system (design doc 9 §8.1) ────────────────────────────────────────────

export interface SystemView {
  format: typeof VIEW_FORMAT;
  kind: "system";
  program: ProgramRef;
  /** The modules the system model comes from, by hash; empty when the program defines it itself. */
  modules: Array<{ module: string; hash: string }>;
  /** `governance`: the component's own governance-class patterns, beyond the language's defaults (K70). */
  components: Array<{ name: string; repo: string; root: string; lang: string; owner: string; build: string[]; test: string[]; provides: string[]; consumes: string[]; governance: string[] }>;
  interfaces: Array<{ name: string; protocol: string; spec: string; provider: string | null; consumers: string[] }>;
  environments: Array<{ name: string; class: string; reads: Array<{ name: string; from: string; kind: "sql" | "logs"; params: string; returns: string; max_rows: number }>; authorize: Array<{ effect: string; tier: string }> }>;
  /** The consumption graph: an edge from consumer to provider, labelled with the interface. */
  mermaid: string;
}

const showCommand = (c: { command: string; args: string[] }): string => [c.command, ...c.args].join(" ");

function typeText(t: TypeExpr): string {
  if ("ref" in t) return t.args ? `${t.ref}<${t.args.map(typeText).join(", ")}>` : t.ref;
  if ("record" in t) return `{ ${Object.entries(t.record).map(([k, v]) => `${k}: ${typeText(v)}`).join(", ")} }`;
  if ("refine" in t) return `${typeText(t.refine)} where …`;
  if ("enum" in t) return `enum { ${t.enum.join(", ")} }`;
  return "union";
}

/**
 * The system a program works on: components with their owners, interfaces
 * with provider and consumers, environments with their reads and the
 * weakest authorization each effect accepts there. With `modules`, the
 * imported system model is shown with its module hash.
 */
export function system(program: Program, modules: Modules = {}): SystemView {
  const linked = link(program, modules);
  const defs = Object.entries(linked.defs).sort(([a], [b]) => (a < b ? -1 : 1));
  const comps = defs.filter((x): x is [string, ComponentDef] => x[1].kind === "component");
  const components = comps.map(([name, c]) => ({
    name,
    repo: c.repo,
    root: c.root,
    lang: c.lang,
    owner: c.owner,
    build: (c.build ?? []).map(showCommand),
    test: (c.test ?? []).map(showCommand),
    provides: c.provides ?? [],
    consumes: c.consumes ?? [],
    governance: c.governance ?? [],
  }));
  const interfaces = defs
    .filter((x): x is [string, InterfaceDef] => x[1].kind === "interface")
    .map(([name, i]) => ({
      name,
      protocol: i.protocol,
      spec: i.spec,
      provider: comps.find(([, c]) => c.provides?.includes(name))?.[0] ?? null,
      consumers: comps.filter(([, c]) => c.consumes?.includes(name)).map(([n]) => n),
    }));
  const environments = defs
    .filter((x): x is [string, EnvironmentDef] => x[1].kind === "environment")
    .map(([name, e]) => ({
      name,
      class: e.class,
      reads: Object.entries(e.reads ?? {}).map(([rn, r]) => ({ name: rn, from: r.from, kind: ("sql" in r.query ? "sql" : "logs") as "sql" | "logs", params: r.params.map((p) => `${p.name}: ${typeText(p.type)}`).join(", "), returns: typeText(r.returns), max_rows: r.max_rows })),
      authorize: Object.entries(e.authorize ?? {}).map(([effect, t]) => ({ effect, tier: t.by === "policy" ? "policy" : `a person (${t.role})` })),
    }));
  const id = (n: string): string => `c_${n}`;
  const lines = ["flowchart LR", ...components.map((c) => `  ${id(c.name)}["${mermaidText(`${c.name} (${c.lang})`)}<br/>${mermaidText(c.owner)}"]`)];
  for (const i of interfaces) for (const consumer of i.consumers) if (i.provider) lines.push(`  ${id(consumer)} -->|${mermaidText(i.name)}| ${id(i.provider)}`);
  const used = [...new Set(Object.values(linked.origin))].sort();
  return {
    format: VIEW_FORMAT,
    kind: "system",
    program: programRef(program),
    modules: used.map((m) => ({ module: m, hash: hashProgram(modules[m]! as unknown as Json).program })),
    components,
    interfaces,
    environments,
    mermaid: lines.join("\n"),
  };
}

export function hasSystem(program: Program, modules: Modules = {}): boolean {
  return Object.values(link(program, modules).defs).some((d) => isSystem(d.kind));
}

export function systemBlocks(v: SystemView): Block[] {
  const out: Block[] = [{ h: "System" }];
  if (v.modules.length) out.push({ p: `System model from ${v.modules.map((m) => `${m.module} (${m.hash})`).join(", ")}.` });
  out.push({ code: v.mermaid, lang: "mermaid" });
  out.push({ table: { head: ["Component", "Repository", "Root", "Language", "Owner", "Build", "Test", "Provides", "Consumes"], rows: v.components.map((c) => [c.name, c.repo, c.root, c.lang, c.owner, list(c.build), list(c.test), list(c.provides), list(c.consumes)]) } });
  // K70: what a component's owner must approve whatever else authorizes the action.
  const own = v.components.filter((c) => c.governance.length);
  out.push({ p: `Governance-class files: an action that carries one needs its component owner's approval. The language's own are CI workflows, lockfiles, agent settings, the Mandate lock and CODEOWNERS${own.length ? "; components add:" : "; no component adds any."}` });
  if (own.length) out.push({ table: { head: ["Component", "Owner", "Its own governance-class files"], rows: own.map((c) => [c.name, c.owner, list(c.governance)]) } });
  out.push({ table: { head: ["Interface", "Protocol", "Spec", "Provider", "Consumers"], rows: v.interfaces.map((i) => [i.name, i.protocol, i.spec, i.provider ?? "none", list(i.consumers)]) } });
  for (const e of v.environments) {
    out.push({ p: `Environment ${e.name}: holds data up to ${e.class}.` });
    if (e.reads.length) out.push({ table: { head: ["Read", "From", "Kind", "Parameters", "Row", "Max rows"], rows: e.reads.map((r) => [r.name, r.from, r.kind, r.params || "—", r.returns, String(r.max_rows)]) } });
    if (e.authorize.length) out.push({ table: { head: ["Effect", "Authorized at least by"], rows: e.authorize.map((a) => [a.effect, a.tier]) } });
  }
  return out;
}

// ── the envelope's card (spec/envelope.md "Views") ────────────────────────

/** What a map runs: its bounds, the delegations of its body, and what it hands each item. */
export interface CardMap {
  bind: string;
  over: string;
  /** The most items; null when the map has no `max` and the envelope's `agents` bounds it at run time. */
  max: number | null;
  par: number;
  delegates: string[];
  /** Each capability of its `with caps`: what it is written as, its kinds, a static scope, and whether the item narrows it. */
  handed: Array<{ cap: string; kinds: string[]; scope: string[] | null; by_item: boolean }>;
}

/** A `plan`: its lead and the budget the lead's own delegation reserves. */
export interface CardPlan {
  lead: string;
  budget: string;
  from: "call" | "skill" | "agent" | "none";
  numbers: { spend: { micros: number; currency: string } | null; tokens: number | null; time_ms: number | null; steps: number | null; agents: number | null };
}

/** One dimension of the envelope's budget, beside the static part's upper bound. */
export interface CardBudgetRow {
  dimension: "spend" | "tokens" | "time" | "steps" | "agents";
  /** For spend, the currency; amounts are then in micro-units. */
  currency: string | null;
  unit: "micros" | "tokens" | "ms" | "steps" | "agents";
  /** null when the envelope does not bound this dimension. */
  envelope: number | null;
  static: number;
  /** What sub-programs may claim: the envelope less the static part; null without a limit. */
  left: number | null;
  text: { envelope: string; static: string; left: string };
}

export interface CardMember {
  member: string;
  keys: number;
}

export interface CardWait {
  role: string;
  /** How it waits: human.approve, human.ask, escalate human(…), supervise escalate(…), a change set's approval. */
  kind: string;
  /** The definition it is in: the workflow, a function it calls, a contract it verifies against. */
  def: string;
  in: string;
  path: string;
  members: string[];
}

export interface CardView {
  format: typeof VIEW_FORMAT;
  kind: "card";
  program: ProgramRef;
  workflow: string;
  /** The package hash an approval of this envelope is signed for (hash.ts packageHash). */
  package: string;
  /** What it does. */
  does: { steps: string[]; maps: CardMap[]; plans: CardPlan[] };
  /** What it can touch: the envelope's capabilities, opened. */
  touches: Authority & { caps: string[]; max_class: string; max_concurrent: number | null };
  /** The most it spends, per dimension. */
  spends: CardBudgetRow[];
  /** When it asks whom. */
  asks: { waits: CardWait[]; approvals: Array<{ effect: string; role: string; members: string[] }> };
  /** Who approves it, and who may amend it. */
  approves: { role: string | null; description: string | null; lock: boolean; members: CardMember[]; bound: boolean; text: string };
}

/** The workflows of a program that have an envelope, sorted: the ones that have a card. */
export function envelopeWorkflows(program: Program): string[] {
  return Object.entries(program.defs)
    .filter(([, d]) => d.kind === "workflow" && !!d.envelope)
    .map(([n]) => n)
    .sort();
}

/** An expression as a person reads it in a card: names, fields, literals and calls; anything else is "…". */
function exprText(e: Expr): string {
  switch (e.op) {
    case "var":
      return e.name;
    case "field":
      return `${exprText(e.of)}.${e.name}`;
    case "text":
      return JSON.stringify(e.value);
    case "int":
      return String(e.value);
    case "call":
      return `${exprText(e.callee)}(${e.args.map((a) => `${a.name ? `${a.name}: ` : ""}${exprText(a.value)}`).join(", ")})`;
    default:
      return "…";
  }
}


/** 80000000 as "80,000,000". */
function grouped(n: number): string {
  const s = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-${s}` : s;
}

/** Milliseconds as hours and minutes: "6 h", "3 h 20 min". */
function hoursText(ms: number): string {
  if (ms < 0) return `-${hoursText(-ms)}`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const parts = [h ? `${h} h` : "", m ? `${m} min` : "", s ? `${s} s` : "", rest ? `${rest} ms` : ""].filter(Boolean);
  return parts.join(" ") || "0 min";
}

/** The definitions a workflow reaches: itself, the functions it calls (and theirs), the contracts it verifies against. */
function reachable(defs: Record<string, Def>, start: string): string[] {
  const found = [start];
  const kind = (n: string): string | undefined => (Object.hasOwn(defs, n) ? defs[n]!.kind : undefined);
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as { op?: unknown; callee?: { op?: unknown; name?: unknown }; contract?: unknown };
    const next = o.op === "call" && o.callee?.op === "var" && typeof o.callee.name === "string" && kind(o.callee.name) === "fn" ? o.callee.name : o.op === "verify" && typeof o.contract === "string" && kind(o.contract) === "contract" ? o.contract : undefined;
    if (next !== undefined && !found.includes(next)) {
      found.push(next);
      walk(defs[next]);
    }
    Object.values(v).forEach(walk);
  };
  walk(defs[start]);
  return found;
}

/** How a role site waits for a person, as the card names it. */
const WAIT_KIND: Record<string, string> = {
  "human.approve": "human.approve",
  "human.ask": "human.ask",
  "an escalation": "escalate human(…)",
  "a supervision's escalation": "supervise escalate(…)",
  "a change set's approver": "change set approval",
  "a change set member's approver": "change set member approval",
};

/**
 * The card of a workflow with an envelope: what a person reads before
 * approving it. Computed from the IR and the lock; `modules` are the modules
 * the program imports, so imported functions and capabilities are seen. The
 * package hash is the one the runtime checks at load and an approval is
 * signed for. Undefined for a workflow without an envelope, or no workflow.
 */
export function card(program: Program, workflow: string, opts: { lock?: Lock; modules?: Modules } = {}): CardView | undefined {
  const wf = Object.hasOwn(program.defs, workflow) ? program.defs[workflow] : undefined;
  if (wf?.kind !== "workflow" || !wf.envelope) return undefined;
  const env = wf.envelope;
  const modules = opts.modules ?? {};
  const lock = opts.lock;
  const linkedDefs = link(program, modules).defs;
  const lp = Object.keys(modules).length ? linkedProgram(program, modules) : program;
  const ref = programRef(program);
  const membersOf = (role: string): string[] => [...(own(lock?.roles, role) ?? [])].sort();

  // What it does: the steps the architecture view draws, then each map and plan with its bounds.
  const maps: CardMap[] = [];
  const plans: CardPlan[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== "object") return;
    const e = v as Expr;
    if (e.op === "map") {
      const delegates: string[] = [];
      const inside = (x: unknown): void => {
        if (Array.isArray(x)) return x.forEach(inside);
        if (!x || typeof x !== "object") return;
        const d = x as Expr;
        if (d.op === "delegate" && !delegates.includes(`${d.agent}.${d.skill}`)) delegates.push(`${d.agent}.${d.skill}`);
        Object.values(x).forEach(inside);
      };
      inside(e.body);
      maps.push({
        bind: e.bind,
        over: exprText(e.over),
        max: e.max ?? null,
        par: e.par ?? 1,
        delegates,
        handed: (e.caps ?? []).map((c) => {
          const vals = capsIn(lp, [c]);
          const scopes = vals.flatMap((x) => x.scope ?? []);
          return { cap: exprText(c), kinds: [...new Set(vals.map((x) => x.ctor))], scope: vals.length && vals.every((x) => x.scope) ? scopes : null, by_item: readsVar(c, e.bind) };
        }),
      });
    }
    if (e.op === "plan") {
      const { budget, from } = delegateBudget(lp, { op: "delegate", agent: e.agent, skill: e.skill, args: e.args, ...(e.budget ? { budget: e.budget } : {}) });
      plans.push({
        lead: `${e.agent}.${e.skill}`,
        budget: show(budget),
        from,
        numbers: { spend: budget?.spend ? { ...budget.spend } : null, tokens: budget?.tokens ?? null, time_ms: budget?.time?.ms ?? null, steps: budget?.steps ?? null, agents: budget?.agents ?? null },
      });
    }
    Object.values(v).forEach(visit);
  };
  visit(wf.body);

  // What it can touch: the envelope's capabilities, opened as the authority view opens them.
  const caps = capsIn(lp, env.caps ?? []);
  const touches = { ...authorityOf(caps), caps: caps.map(showCap), max_class: env.spawn?.max_class ?? "internal", max_concurrent: env.spawn?.max_concurrent ?? null };

  // The most it spends: the envelope's budget beside the checker's static upper bound.
  const sc = staticCost(program, workflow, linkedDefs) ?? { spend: {} as Record<string, number>, tokens: 0, time: 0, steps: 0, agents: 0 };
  const b = env.budget;
  const spends: CardBudgetRow[] = [];
  const row = (dimension: CardBudgetRow["dimension"], unit: CardBudgetRow["unit"], currency: string | null, limit: number | undefined, used: number, fmt: (n: number) => string): void => {
    const envelope = limit ?? null;
    const left = envelope === null ? null : envelope - used;
    spends.push({ dimension, currency, unit, envelope, static: used, left, text: { envelope: envelope === null ? "no limit" : fmt(envelope), static: fmt(used), left: left === null ? "no limit" : fmt(left) } });
  };
  const currencies = [...new Set([...(b?.spend ? [b.spend.currency] : []), ...Object.keys(sc.spend).sort()])];
  if (!currencies.length) row("spend", "micros", null, undefined, 0, (n) => String(n));
  for (const c of currencies) row("spend", "micros", c, b?.spend?.currency === c ? b.spend.micros : undefined, sc.spend[c] ?? 0, (n) => microsText(n, c));
  row("tokens", "tokens", null, b?.tokens, sc.tokens, grouped);
  row("time", "ms", null, b?.time?.ms, sc.time, hoursText);
  row("steps", "steps", null, b?.steps, sc.steps, grouped);
  row("agents", "agents", null, b?.agents, sc.agents, grouped);

  // When it asks whom: every place it reaches that waits for a person and names a role, and the envelope's approvals.
  const names = reachable(linkedDefs, workflow);
  const sites = roleSites(Object.fromEntries(names.map((n) => [n, linkedDefs[n]!])));
  const where = (n: string): string => (n === workflow ? "its body" : linkedDefs[n]!.kind === "fn" ? `function ${n}` : `contract ${n}`);
  const waits: CardWait[] = sites
    .filter((s) => !s.distinct && s.role !== undefined && Object.hasOwn(WAIT_KIND, s.where))
    .map((s) => ({ role: s.role!, kind: WAIT_KIND[s.where]!, def: s.def, in: where(s.def), path: s.path, members: membersOf(s.role!) }));
  const approvals = Object.entries(env.approve ?? {})
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([effect, role]) => ({ effect, role, members: membersOf(role) }));

  // Who approves it, and every amendment: the owner role and the members the lock binds to it.
  const owner = env.owner ?? null;
  const roleDef = owner !== null && Object.hasOwn(lp.defs, owner) ? lp.defs[owner] : undefined;
  const members = owner === null ? [] : membersOf(owner).map((m) => ({ member: m, keys: own(lock?.members, m)?.keys.length ?? 0 }));
  const text =
    owner === null
      ? "Nobody can approve it yet: the envelope names no owner role."
      : !lock
        ? `Nobody can approve it yet: there is no lock, so no member holds the role ${owner}.`
        : !members.length
          ? `Nobody can approve it yet: the lock binds no member to the role ${owner}.`
          : `A member of ${owner} approves it, and every amendment: ${members.map((m) => `${m.member} (${m.keys} ${m.keys === 1 ? "key" : "keys"})`).join(", ")}.`;

  return {
    format: VIEW_FORMAT,
    kind: "card",
    program: ref,
    workflow,
    package: packageHash(ref.hash, packagedLock(lock)),
    does: { steps: steps(lp, wf), maps, plans },
    touches,
    spends,
    asks: { waits, approvals },
    approves: { role: owner, description: roleDef?.kind === "role" ? roleDef.description : null, lock: !!lock, members, bound: members.length > 0, text },
  };
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

/**
 * The program's views as one document, headed by the hash they show. With
 * `modules`, capabilities over components open into the imported system
 * model, which is shown too.
 */
export function programDoc(program: Program, lock?: Lock, modules: Modules = {}): Doc {
  const ref = programRef(program);
  const linked = Object.keys(modules).length ? linkedProgram(program, modules) : program;
  // A module that only describes a system (a system model) has no workflows or agents to show.
  const runs = Object.values(program.defs).some((d) => d.kind === "workflow" || d.kind === "agent");
  const views = (p: Program): Block[] => (runs ? [...architectureBlocks(architecture(p)), ...authorityBlocks(authority(p)), ...costBlocks(cost(p, lock))] : []);
  return {
    title: `${ref.module} ${ref.version}`,
    meta: [
      ["Program", ref.hash],
      ["Language", ref.language],
      ["View", `${VIEW_FORMAT}, generated from the program${Object.keys(modules).length ? " and the modules it imports" : " alone"}`],
    ],
    blocks: [...views(linked), ...(hasSystem(program, modules) ? systemBlocks(system(program, modules)) : [])],
  };
}

export function diffDoc(before: Program, after: Program, locks?: { before?: Lock; after?: Lock }): Doc {
  const v = semanticDiff(before, after, locks);
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

export function cardBlocks(v: CardView): Block[] {
  const t = v.touches;
  const members = (ms: string[]): string => (ms.length ? ms.join(", ") : "nobody bound");
  const handed = (m: CardMap): string =>
    list(m.handed.map((h) => `${h.kinds.join(", ") || h.cap} ${h.scope ? `within ${h.scope.join(", ")}` : h.by_item ? `narrowed by each item (${h.cap})` : `of unknown scope (${h.cap})`}`));
  const out: Block[] = [
    { h: "What it does" },
    { list: v.does.steps.length ? v.does.steps : ["no static steps"] },
  ];
  if (v.does.maps.length) {
    out.push({ table: { head: ["Map", "Over", "At most", "At a time", "Delegates", "Each item gets"], rows: v.does.maps.map((m) => [`map ${m.bind}`, m.over, m.max === null ? "no max (the envelope's agents bound it)" : grouped(m.max), String(m.par), list(m.delegates), handed(m)]) } });
  }
  if (v.does.plans.length) {
    out.push({ p: "Each plan's lead writes sub-programs while the run goes on; each one is checked against what is left of the envelope when it is submitted." });
    out.push({ table: { head: ["Plan lead", "Lead's budget", "From"], rows: v.does.plans.map((p) => [p.lead, p.budget, p.from]) } });
  }
  out.push(
    { h: "What it can touch" },
    {
      table: {
        head: ["What", "Scope"],
        rows: [
          ["Read paths", list(t.read)],
          ["Write paths", list(t.write)],
          ["Network hosts", list(t.network)],
          ["Commands", list(t.exec)],
          ["Model tiers", list(t.model)],
          ["Pull requests in", list(t.repos)],
          ["Money", list(t.money)],
          ["Unbounded", list(t.unbounded)],
          ["Highest data class a delegation receives", t.max_class],
          ["Delegations in flight at once", t.max_concurrent === null ? "no limit" : String(t.max_concurrent)],
        ],
      },
    },
    { list: t.caps.map((c) => ({ text: c, mono: true })) },
    { h: "The most it spends" },
    { table: { head: ["Dimension", "Envelope", "Static part (upper bound)", "Left for sub-programs"], rows: v.spends.map((r) => [r.currency ? `${r.dimension} (${r.currency})` : r.dimension, r.text.envelope, r.text.static, r.text.left]) } },
    { h: "When it asks whom" },
  );
  if (v.asks.waits.length) out.push({ table: { head: ["Wait", "Role", "In", "Members"], rows: v.asks.waits.map((w) => [w.kind, w.role, w.in, members(w.members)]) } });
  else out.push({ p: "No step it reaches waits for a person by role." });
  if (v.asks.approvals.length) out.push({ table: { head: ["Effect", "Authorized only by a decision of", "Members"], rows: v.asks.approvals.map((a) => [a.effect, a.role, members(a.members)]) } });
  const a = v.approves;
  out.push(
    { h: "Who approves it, and who may amend it" },
    { p: a.role === null ? a.text : `The role ${a.role}${a.description ? ` (${a.description})` : ""} approves the envelope before any run, and every amendment.` },
  );
  if (a.members.length) out.push({ table: { head: ["Member", "Keys"], rows: a.members.map((m) => [m.member, String(m.keys)]) } });
  else out.push({ note: a.text });
  out.push({ p: `An approval is signed for package ${v.package}: a changed program, lock or imported module is a new package and needs a new approval.` });
  return out;
}

/** The card as a document, headed by the package hash an approval binds to. Undefined as `card` is. */
export function cardDoc(program: Program, workflow: string, opts: { lock?: Lock; modules?: Modules } = {}): Doc | undefined {
  const v = card(program, workflow, opts);
  if (!v) return undefined;
  return {
    title: `${v.program.module} ${v.program.version}: ${v.workflow}`,
    meta: [
      ["Package", v.package],
      ["Program", v.program.hash],
      ["Language", v.program.language],
      ["View", `${VIEW_FORMAT} card, generated from the program${opts.modules && Object.keys(opts.modules).length ? ", the modules it imports" : ""} and ${opts.lock ? "its lock" : "no lock"}`],
    ],
    blocks: cardBlocks(v),
  };
}
