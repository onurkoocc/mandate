// Human projections of a run (Doc 4 §15, INV-10): what a person needs to see
// to decide, made from the program and the run's journal and nothing else.
//
//   status     the run's state, and if it waits for a person, what for and
//              about what, with the command that answers it at this revision
//   evidence   each criterion's records: method, result, who produced it,
//              whether its signature holds, its outputs (§15.4)
//   cost       the budget table: limits, settled, reserved, per command
//   actions    external actions: state, operation, receipt
//   change sets  per set (design doc 9 §8.2): the approved plan, the change per
//              component with declared and measured interface changes, the
//              criterion × component evidence matrix, the order and why, what
//              was real and what simulated, and what it changes in authority
//
// plus the program's own views (architecture, authority), under the same
// program hash. Each run view names the revision and the last event it
// shows; `freshness` tells how far the run has moved since (G10), and a
// decision taken on an older revision is refused (stale_revision). Anything
// that came from a model, a tool or a person's answer is shown as untrusted
// plain content (G09).

import { architecture, architectureBlocks, authority, authorityBlocks, check, hashProgram, linkedProgram, programRef, semanticDiff, VIEW_FORMAT, type Block, type Cell, type Doc, type Json, type Modules, type ProgramRef, type Program } from "@mandate/compiler";
import type { BudgetReport, ChangesetRow, EvidenceRow } from "./journal.js";
import type { Runtime } from "./runtime.js";
import { covers, type ChangeKind } from "./specdiff.js";
import { canonical, digest, isObj, show, type Obj, type Value } from "./values.js";

export interface AsOf {
  revision: number;
  /** The run's last event this view includes. */
  event: number;
}

export interface RunView {
  format: typeof VIEW_FORMAT;
  kind: "run";
  program: ProgramRef;
  package: string;
  run: { id: string; workflow: string; tenant: string; state: string };
  /** What the run started from (B3): the manifest's hash R, its mode (B6), and each component at its base commit. */
  manifest: { hash: string | null; mode: string; components: Array<{ name: string; repo: string; base: string }> };
  /** The modules the program imports, such as its system model, by program hash (INV-10). */
  modules: Array<{ module: string; hash: string }>;
  as_of: AsOf;
  waiting: Value;
  attention: Value;
  result: Value;
  error: Value;
  evidence: Array<{ evidence_id: string; contract: string; criterion: string; method: string; passed: boolean; producer: Value; signature_valid: boolean; artifacts: Value; at: number | null }>;
  budget: BudgetReport;
  actions: Array<{ effect: string; state: string; operation: string; action_digest: string; receipt: Value; artifacts: Value }>;
  changesets: ChangesetView[];
}

type Cellval = "passed" | "failed" | "unknown";

/** One change set as a person decides on it (design doc 9 §8.2). */
export interface ChangesetView {
  node: string;
  set_digest: string;
  /** `prepared`, `committed`, `partial`, `failed`, `would_apply` (read_only) or `simulated` (design). */
  state: string;
  /** What of it is real: the run's mode and what happened to each member. */
  reality: string;
  plan: { value: Value; digest: string; evidence: string[]; approved_by: Array<{ criterion: string; by: string | null; role: string | null }> };
  components: Array<{
    component: string;
    effect: string;
    approver: string;
    /** The member's action: `confirmed`, `prepared`, …, or `simulated`. */
    action: string;
    files: string[];
    /** Each interface the component provides that the set or the plan names, or whose spec a check measured. */
    interfaces: Array<{ interface: string; declared: string | null; measured: string | null }>;
    /** Why the change is not the plan's, if it is not. */
    unplanned: string[];
  }>;
  /** Rows: criteria of the members' evidence; columns: components. */
  matrix: Array<{ contract: string; criterion: string; method: string; cells: Record<string, { result: Cellval; evidence_id: string | null }> }>;
  order: Array<{ component: string; because: string[] }>;
  /** What the set changes in Mandate's own terms: programs, the system model, the lock. Empty when it changes none. */
  authority: Array<{ component: string; file: string; changes: string[] }>;
}

/** How far a run has moved since a view of it was made (G10). */
export interface Freshness {
  as_of: AsOf;
  now: AsOf;
  behind_events: number;
  stale: boolean;
}

export async function runView(rt: Runtime, runId: string): Promise<{ view: RunView; program: Program }> {
  // The view's position first: everything below is at least this new, and a later decision names this revision.
  const run = await rt.getRun(runId);
  const as_of = { revision: run.revision, event: await lastEvent(rt, runId) };
  const [row] = await rt.db.query<{ program: Program; modules: Modules | null }>("select program, modules from packages where package_hash = $1", [run.package_hash]);
  const program = row!.program;
  const modules = row!.modules ?? {};
  const signed = new Map((await rt.verifyEvidence(runId)).map((e) => [e.evidence_id, e.valid]));
  const evidence = (await rt.evidence(runId)).map((e) => {
    const rec = isObj(e.record) ? e.record : {};
    return {
      evidence_id: e.evidence_id,
      contract: e.contract,
      criterion: e.criterion,
      method: e.method,
      passed: e.passed,
      producer: rec["producer"] ?? null,
      signature_valid: signed.get(e.evidence_id) ?? false,
      artifacts: rec["artifacts"] ?? [],
      at: typeof rec["at"] === "number" ? rec["at"] : null,
    };
  });
  const actions = (await rt.journal.actions(runId)).map((a) => ({ effect: a.effect, state: a.state, operation: a.operation_key, action_digest: a.action_digest, receipt: a.receipt ?? null, artifacts: a.artifacts ?? null }));
  const view: RunView = {
    format: VIEW_FORMAT,
    kind: "run",
    program: programRef(program),
    package: run.package_hash,
    run: { id: run.run_id, workflow: run.workflow, tenant: run.tenant, state: run.state },
    manifest: {
      hash: run.manifest_hash,
      mode: isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? run.manifest["mode"] : "live",
      components: Object.entries(isObj(run.manifest) && isObj(run.manifest["components"] ?? null) ? (run.manifest["components"] as Obj) : {}).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, c]) => ({ name, repo: String((c as Obj)["repo"]), base: String((c as Obj)["base"]) })),
    },
    modules: Object.entries(modules).sort(([a], [b]) => (a < b ? -1 : 1)).map(([module, p]) => ({ module, hash: hashProgram(p as unknown as Json).program })),
    as_of,
    waiting: run.waiting,
    attention: run.attention,
    result: run.result,
    error: run.error,
    evidence,
    budget: await rt.budgetReport(runId),
    actions,
    changesets: await changesetViews(rt, runId, program, modules),
  };
  return { view, program };
}

/** Each change set of a run, from its journal (doc 9 §8.2). */
async function changesetViews(rt: Runtime, runId: string, program: Program, modules: Modules): Promise<ChangesetView[]> {
  const sets = await rt.journal.changesets(runId);
  if (!sets.length) return [];
  const defs = linkedProgram(program, modules).defs;
  const evidence = new Map((await rt.evidence(runId)).map((e) => [e.evidence_id, e]));
  const actions = new Map((await rt.journal.actions(runId)).map((a) => [a.operation_key, a]));
  const out: ChangesetView[] = [];
  for (const s of sets) out.push(await changesetView(rt, runId, s, defs, program, modules, evidence, actions));
  return out;
}

async function changesetView(
  rt: Runtime,
  runId: string,
  s: ChangesetRow,
  defs: Program["defs"],
  program: Program,
  modules: Modules,
  evidence: Map<string, EvidenceRow>,
  actions: Map<string, { state: string; artifacts: Value; effect: string }>,
): Promise<ChangesetView> {
  const sum = isObj(s.summary) ? s.summary : {};
  const plan = isObj(sum["plan"] ?? null) ? (sum["plan"] as Obj) : {};
  const planChanges = isObj(plan["changes"] ?? null) ? (plan["changes"] as Obj) : {};
  const setChanges = isObj(sum["changes"] ?? null) ? (sum["changes"] as Obj) : {};
  const planComponents = Array.isArray(plan["components"]) ? plan["components"].filter((c): c is string => typeof c === "string") : undefined;
  const members = (Array.isArray(s.members) ? s.members : []).filter(isObj) as Obj[];
  const names = members.map((m) => String(m["component"]));
  const providerOf = (iface: string): string | undefined => Object.entries(defs).find(([, d]) => d.kind === "component" && d.provides?.includes(iface))?.[0];
  const ids = (v: Value | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  const planEvidence = ids(sum["plan_evidence"]).map((id) => evidence.get(id)).filter((e): e is EvidenceRow => !!e);
  const approvedBy = planEvidence.filter((e) => e.method === "human.approve").map((e) => {
    const d = isObj(e.detail) ? e.detail : {};
    return { criterion: `${e.contract}.${e.criterion}`, by: typeof d["by"] === "string" ? d["by"] : null, role: typeof d["role"] === "string" ? d["role"] : null };
  });

  // The evidence matrix: each member's evidence, one row per criterion, a cell per component.
  const rows = new Map<string, ChangesetView["matrix"][number]>();
  for (const m of members) {
    const c = String(m["component"]);
    for (const e of ids(m["evidence"]).map((id) => evidence.get(id)).filter((e): e is EvidenceRow => !!e)) {
      const key = `${e.contract}.${e.criterion}`;
      const row = rows.get(key) ?? { contract: e.contract, criterion: e.criterion, method: e.method, cells: {} };
      row.cells[c] = { result: cellFor(e, c, providerOf), evidence_id: e.evidence_id };
      rows.set(key, row);
    }
  }
  for (const row of rows.values()) for (const c of names) row.cells[c] ??= { result: "unknown", evidence_id: null };

  const components: ChangesetView["components"] = [];
  for (const m of members) {
    const c = String(m["component"]);
    const action = typeof m["operation"] === "string" ? actions.get(m["operation"]) : undefined;
    const files = action && isObj(action.artifacts ?? null) ? Object.keys(action.artifacts as Obj).sort() : [];
    const mine = ids(m["evidence"]).map((id) => evidence.get(id)).filter((e): e is EvidenceRow => !!e);
    const measured = new Map<string, string>();
    const unplanned: string[] = [];
    for (const e of mine) {
      const d = isObj(e.detail) ? e.detail : {};
      if (e.method === "test.contract" && Array.isArray(d["interfaces"])) {
        for (const r of d["interfaces"].filter(isObj) as Obj[]) if (r["provider"] === c && typeof r["measured"] === "string") measured.set(String(r["interface"]), r["measured"]);
      }
      if (e.method === "test.planned" && Array.isArray(d["unplanned"])) {
        for (const u of d["unplanned"].filter(isObj) as Obj[]) if (u["component"] === c || (typeof u["interface"] === "string" && providerOf(u["interface"]) === c)) unplanned.push(String(u["detail"] ?? u["problem"]));
      }
    }
    if (planComponents && !planComponents.includes(c)) unplanned.push(`the plan's components do not include ${c}`);
    const declared = (iface: string): string | null => (typeof setChanges[iface] === "string" ? String(setChanges[iface]) : typeof planChanges[iface] === "string" ? String(planChanges[iface]) : null);
    const ifaces = new Set([...Object.keys(setChanges), ...Object.keys(planChanges)].filter((i) => providerOf(i) === c));
    for (const i of measured.keys()) ifaces.add(i);
    components.push({
      component: c,
      effect: String(m["effect"]),
      approver: String(m["approver"] ?? ""),
      action: s.state === "simulated" ? "simulated" : (action?.state ?? "not prepared"),
      files,
      interfaces: [...ifaces].sort().map((i) => ({ interface: i, declared: declared(i), measured: measured.get(i) ?? null })),
      unplanned,
    });
  }

  // The order and why: who provides what a later member consumes (doc 9 §3.3).
  const order = names.map((c, i) => {
    const d = defs[c];
    const because: string[] = [];
    for (const p of names.slice(0, i)) {
      const pd = defs[p];
      if (d?.kind !== "component" || pd?.kind !== "component") continue;
      for (const iface of d.consumes ?? []) {
        if (!pd.provides?.includes(iface)) continue;
        const kind = typeof setChanges[iface] === "string" ? ` and this set changes it (${String(setChanges[iface])})` : "";
        because.push(`after ${p}: ${c} consumes ${iface}, which ${p} provides${kind}`);
      }
    }
    if (!because.length) because.push(i === 0 ? "first: it consumes nothing another member provides" : "nothing it consumes comes from an earlier member; the program chose its place");
    return { component: c, because };
  });

  // Authority: a member that lands a Mandate program, a system model or the lock changes what Mandate allows.
  const authority: ChangesetView["authority"] = [];
  for (const m of members) {
    const action = typeof m["operation"] === "string" ? actions.get(m["operation"]) : undefined;
    const frozen = action && isObj(action.artifacts ?? null) ? (action.artifacts as Obj) : {};
    for (const [file, a] of Object.entries(frozen).sort(([x], [y]) => (x < y ? -1 : 1))) {
      if (file.endsWith("mandate.lock.json")) {
        authority.push({ component: String(m["component"]), file, changes: ["the lock: models, prices or module pins"] });
        continue;
      }
      if (!file.endsWith(".mdt") || !isObj(a)) continue;
      const text = new TextDecoder().decode((await rt.artifact(runId, String(a["ref"]))).bytes);
      const r = check(text, "mdt", { modules });
      if (!r.program) {
        authority.push({ component: String(m["component"]), file, changes: [`does not check: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code).join(", ")}`] });
        continue;
      }
      const name = r.program.module;
      const before = name ? (modules[name] ?? (program.module === name ? program : undefined)) : undefined;
      if (!before) {
        authority.push({ component: String(m["component"]), file, changes: [`a new Mandate module${name ? ` ${name}` : ""}: this run's package has no earlier version of it`] });
        continue;
      }
      const diff = semanticDiff(before, r.program);
      authority.push({ component: String(m["component"]), file, changes: diff.governance.length ? diff.governance.map((g) => g.text) : [`${name}: no governance change (${diff.behavior.length} behavior changes)`] });
    }
  }

  const mode = s.state === "simulated" ? "design" : s.state === "would_apply" ? "read_only" : "live";
  const reality =
    mode === "design"
      ? "Design run: every member simulated; nothing was prepared, authorized or sent."
      : mode === "read_only"
        ? "Read-only run: every member prepared and frozen; nothing was authorized or committed."
        : `Live run: ${components.map((c) => `${c.component} ${c.action}`).join(", ")}.`;
  return {
    node: s.command_id,
    set_digest: s.set_digest,
    state: s.state,
    reality,
    plan: { value: sum["plan"] ?? null, digest: String(sum["plan_digest"] ?? ""), evidence: ids(sum["plan_evidence"]), approved_by: approvedBy },
    components,
    matrix: [...rows.values()].sort((a, b) => (`${a.contract}.${a.criterion}` < `${b.contract}.${b.criterion}` ? -1 : 1)),
    order,
    authority,
  };
}

/** One component's result in a check: its own part where the check reports per component, else the check's. */
function cellFor(e: EvidenceRow, c: string, providerOf: (iface: string) => string | undefined): Cellval {
  const d = isObj(e.detail) ? e.detail : {};
  const list = (k: string): Obj[] => (Array.isArray(d[k]) ? (d[k] as Value[]).filter(isObj) as Obj[] : []);
  if (e.method === "test.suite_each" && Array.isArray(d["runs"])) {
    const r = list("runs").find((x) => x["component"] === c);
    return r ? (r["passed"] === true ? "passed" : "failed") : "unknown";
  }
  if (e.method === "test.contract" && list("interfaces").length) {
    const rs = list("interfaces").filter((x) => x["provider"] === c);
    return rs.every((x) => !x["problem"] && !x["error"]) ? "passed" : "failed";
  }
  if (e.method === "test.planned" && Array.isArray(d["components"])) {
    return list("unplanned").some((u) => u["component"] === c || (typeof u["interface"] === "string" && providerOf(u["interface"]) === c)) ? "failed" : "passed";
  }
  return e.passed ? "passed" : "failed";
}

async function lastEvent(rt: Runtime, runId: string): Promise<number> {
  const [r] = await rt.db.query<{ n: unknown }>("select coalesce(max(seq), 0) as n from events where run_id = $1", [runId]);
  return Number(r?.n ?? 0);
}

/** Whether a view made at `asOf` still shows the run as it is (G10). */
export async function freshness(rt: Runtime, runId: string, asOf: AsOf): Promise<Freshness> {
  const run = await rt.getRun(runId);
  const now = { revision: run.revision, event: await lastEvent(rt, runId) };
  const behind = now.event - asOf.event;
  return { as_of: asOf, now, behind_events: behind, stale: behind > 0 || now.revision !== asOf.revision };
}

const untrusted = (v: Value): Cell => ({ text: typeof v === "string" ? v : canonical(v), untrusted: true });
const mono = (s: string): Cell => ({ text: s, mono: true });

function money(dim: string, n: number): string {
  return dim.startsWith("spend:") ? `${(n / 1_000_000).toFixed(4)} ${dim.slice(6)}` : String(n);
}

function statusBlocks(v: RunView): Block[] {
  const out: Block[] = [{ h: "Status" }, { p: `Run ${v.run.id} of ${v.run.workflow} is ${v.run.state} at revision ${v.as_of.revision} (event ${v.as_of.event}).` }];
  const w = isObj(v.waiting) ? v.waiting : undefined;
  if (v.run.state === "waiting" && w) {
    const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
    if (w["kind"] === "decision" && "criterion" in req) {
      out.push({ p: `Waiting for ${String(req["role"] ?? "a person")} to approve ${String(req["contract"])}.${String(req["criterion"])}. The decision applies only to this subject:` });
      out.push({ table: { head: ["Subject digest", "Deadline"], rows: [[mono(String(req["subject_digest"])), typeof req["deadline"] === "number" ? new Date(req["deadline"]).toISOString() : "—"]] } });
      out.push({ code: JSON.stringify(req["subject"] ?? null, null, 2), untrusted: true });
      out.push({ note: `Approve or decline at revision ${v.as_of.revision}: mandate approve ${v.run.id} --revision ${v.as_of.revision} --by <you>. A decision on an older revision is refused.` });
    } else if (w["kind"] === "decision") {
      out.push({ p: `Waiting for ${String(req["role"] ?? "a person")} to authorize ${String(req["effect"] ?? "an action")}, exactly these parameters:` });
      out.push({ table: { head: ["Action digest"], rows: [[mono(String(req["action_digest"]))]] } });
      out.push({ code: JSON.stringify(req["params"] ?? null, null, 2), untrusted: true });
    } else if (w["kind"] === "timer") {
      out.push({ p: `Waiting until ${typeof req["until"] === "number" ? new Date(req["until"]).toISOString() : "?"} (${String(req["reason"] ?? "a timer")}); the scheduler resumes it then.` });
    } else {
      out.push({ p: w["kind"] === "budget_exceeded" ? "Waiting for a person after the budget ran out. The question, as the program asks it:" : "Waiting for an answer. The question, as the program asks it:" });
      out.push({ code: show((req["question"] ?? req["escalation"] ?? null) as Value), untrusted: true });
    }
  }
  if (v.run.state === "attention_required") out.push({ p: "Needs attention:" }, { code: JSON.stringify(v.attention, null, 2), untrusted: true });
  if (v.run.state === "failed") out.push({ p: "Failed with:" }, { code: JSON.stringify(v.error, null, 2), untrusted: true });
  if (v.run.state === "succeeded") out.push({ p: "Result:" }, { code: JSON.stringify(v.result, null, 2), untrusted: true });
  return out;
}

function evidenceBlocks(v: RunView): Block[] {
  if (!v.evidence.length) return [{ h: "Evidence" }, { p: "No criterion has been checked yet." }];
  return [
    { h: "Evidence" },
    {
      table: {
        head: ["Criterion", "Method", "Result", "Produced by", "Signature", "Outputs", "Evidence"],
        rows: v.evidence.map((e) => [
          `${e.contract}.${e.criterion}`,
          e.method,
          e.passed ? "met" : "not met",
          untrusted(e.producer),
          e.signature_valid ? "valid" : "INVALID",
          Array.isArray(e.artifacts) && e.artifacts.length ? mono(e.artifacts.map((a) => (isObj(a) ? `${String(a["kind"])}${a["phase"] ? `/${String(a["phase"])}` : ""} ${String(a["ref"])}` : "")).join("; ")) : "—",
          mono(e.evidence_id),
        ]),
      },
    },
  ];
}

function costBlocks(v: RunView): Block[] {
  return [
    { h: "Cost" },
    { table: { head: ["Dimension", "Limit", "Settled", "Reserved", "Available"], rows: v.budget.dimensions.map((d) => [d.dimension, money(d.dimension, d.limit), money(d.dimension, d.settled), money(d.dimension, d.reserved), money(d.dimension, d.available)]) } },
    {
      table: {
        head: ["Command", "Label", "State", "Reserved", "Cost"],
        rows: v.budget.commands.map((c) => [mono(c.command), c.label ?? c.kind, c.state, Object.entries(c.reserved).map(([d, n]) => `${d.startsWith("spend:") ? money(d, n) : `${n} ${d}`}${c.open.includes(d) ? " (open)" : ""}`).join(", ") || "—", c.cost === null ? "—" : c.cost === "unknown" ? "unknown" : canonical(c.cost as unknown as Value)]),
      },
    },
  ];
}

const RESULT: Record<Cellval, string> = { passed: "passed", failed: "FAILED", unknown: "unknown" };

function changesetBlocks(v: RunView): Block[] {
  const out: Block[] = [];
  for (const s of v.changesets) {
    const names = s.components.map((c) => c.component);
    const approved = s.plan.approved_by.map((a) => `${a.by ?? "?"}${a.role ? ` (${a.role})` : ""}`).join(", ");
    out.push({ h: `Change set at ${s.node}` });
    out.push({ p: `${s.reality} Set digest ${s.set_digest}, state ${s.state}.` });
    out.push({ p: `The plan (digest ${s.plan.digest})${approved ? `, approved by ${approved}` : ", with no person's approval in its evidence"}:` });
    out.push({ code: JSON.stringify(s.plan.value, null, 2), untrusted: true });
    out.push({
      table: {
        head: ["Component", "Files", "Interfaces: declared → measured", "Plan", "Action"],
        rows: s.components.map((c) => [
          c.component,
          c.files.length ? mono(`${c.files.length}: ${c.files.join(", ")}`) : "—",
          c.interfaces.length ? c.interfaces.map((i) => `${i.interface}: ${i.declared ?? "none"} → ${i.measured ?? "not measured"}${i.measured && !covers((i.declared ?? "none") as ChangeKind, i.measured as ChangeKind) ? " (understated)" : ""}`).join("; ") : "—",
          c.unplanned.length ? `UNPLANNED: ${c.unplanned.join("; ")}` : "in the plan",
          c.action,
        ]),
      },
    });
    if (s.matrix.length) {
      out.push({ table: { head: ["Criterion", "Method", ...names], rows: s.matrix.map((r) => [`${r.contract}.${r.criterion}`, r.method, ...names.map((n) => (r.cells[n]!.evidence_id ? mono(`${RESULT[r.cells[n]!.result]} ${r.cells[n]!.evidence_id!.slice(0, 19)}`) : RESULT[r.cells[n]!.result]))]) } });
    } else out.push({ p: "No member carries evidence." });
    out.push({ table: { head: ["#", "Component", "Why here"], rows: s.order.map((o, i) => [String(i + 1), o.component, o.because.join("; ")]) } });
    if (s.authority.length) out.push({ table: { head: ["Component", "File", "What it changes in authority"], rows: s.authority.map((a) => [a.component, mono(a.file), a.changes.join("; ")]) } });
    else out.push({ p: "No member changes a Mandate program, the system model or the lock: the set changes no capability, budget or environment tier." });
  }
  return out;
}

function actionBlocks(v: RunView): Block[] {
  if (!v.actions.length) return [{ h: "External actions" }, { p: "None." }];
  return [{ h: "External actions" }, { table: { head: ["Effect", "State", "Operation", "Receipt"], rows: v.actions.map((a) => [a.effect, a.state, mono(a.operation), a.receipt === null ? "—" : untrusted(a.receipt)]) } }];
}

/** A run's views as one document: its status, evidence, cost and actions, and its program's views, under one hash. */
export function runDoc(v: RunView, program: Program): Doc {
  return {
    title: `Run ${v.run.id}: ${v.run.workflow}`,
    meta: [
      ["Program", v.program.hash],
      ["Package", v.package],
      ["Run", `${v.run.id} (tenant ${v.run.tenant})`],
      ...(v.manifest.hash ? [["Started from", v.manifest.hash] as [string, string]] : []),
      ["Mode", v.manifest.mode === "live" ? "live" : v.manifest.mode === "read_only" ? "read_only: real reads, effects prepared and never committed" : "design: sample reads, effects simulated"],
      ...v.manifest.components.map((c) => [`Component ${c.name}`, `${c.repo} @ ${c.base}`] as [string, string]),
      ...v.modules.map((m) => [`Module ${m.module}`, m.hash] as [string, string]),
      ["As of", `revision ${v.as_of.revision}, event ${v.as_of.event}`],
      ["View", `${VIEW_FORMAT}, generated from the program and the run's journal`],
    ],
    blocks: [...statusBlocks(v), ...changesetBlocks(v), ...evidenceBlocks(v), ...costBlocks(v), ...actionBlocks(v), ...architectureBlocks(architecture(program)), ...authorityBlocks(authority(program))],
  };
}

/** One external action of a shadow comparison: the same node in two runs. */
export interface ShadowRow {
  node: string;
  effect: string;
  /** `same`: the same action would be taken; `differs`: other parameters or files; `only_a` / `only_b`. */
  state: "same" | "differs" | "only_a" | "only_b";
  a?: { state: string; fingerprint: string };
  b?: { state: string; fingerprint: string };
}

/**
 * The shadow comparison (Doc 4 §8.3, V19; design doc 9 §5.2): what two runs
 * of the same workflow prepared, node by node, compared by what the action
 * would do (effect, parameters, frozen files, business key), not by run.
 * A `read_only` run commits nothing; the comparison says what it would have
 * changed compared with the other.
 */
export async function shadowDiff(rt: Runtime, a: string, b: string): Promise<{ a: { run: string; mode: string; committed: number }; b: { run: string; mode: string; committed: number }; rows: ShadowRow[] }> {
  const side = async (runId: string) => {
    const run = await rt.getRun(runId);
    const actions = await rt.journal.actions(runId);
    const byNode = new Map(actions.map((x) => [x.command_id, x]));
    const committed = actions.filter((x) => ["dispatched", "confirmed", "unknown_outcome", "rejected"].includes(x.state)).length;
    return { run: runId, mode: isObj(run.manifest) && typeof run.manifest["mode"] === "string" ? run.manifest["mode"] : "live", committed, byNode };
  };
  const fp = (x: { effect: string; params: Value; artifacts: Value }): string => digest("request", { effect: x.effect, params: x.params, artifacts: isObj(x.artifacts ?? null) ? Object.fromEntries(Object.entries(x.artifacts as Obj).map(([p, f]) => [p, isObj(f) ? f["digest"] ?? null : null])) : null });
  const A = await side(a);
  const B = await side(b);
  const rows: ShadowRow[] = [];
  for (const node of [...new Set([...A.byNode.keys(), ...B.byNode.keys()])].sort()) {
    const x = A.byNode.get(node);
    const y = B.byNode.get(node);
    const fx = x ? fp(x) : undefined;
    const fy = y ? fp(y) : undefined;
    rows.push({
      node,
      effect: (x ?? y)!.effect,
      state: !x ? "only_b" : !y ? "only_a" : fx === fy ? "same" : "differs",
      ...(x ? { a: { state: x.state, fingerprint: fx! } } : {}),
      ...(y ? { b: { state: y.state, fingerprint: fy! } } : {}),
    });
  }
  return { a: { run: A.run, mode: A.mode, committed: A.committed }, b: { run: B.run, mode: B.mode, committed: B.committed }, rows };
}
