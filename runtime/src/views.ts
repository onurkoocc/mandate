// Human projections of a run (Doc 4 §15, INV-10): what a person needs to see
// to decide, made from the program and the run's journal and nothing else.
//
//   status     the run's state, and if it waits for a person, what for and
//              about what, with the command that answers it at this revision
//   evidence   each criterion's records: method, result, who produced it,
//              whether its signature holds, its outputs (§15.4)
//   cost       the budget table: limits, settled, reserved, per command
//   actions    external actions: state, operation, receipt
//
// plus the program's own views (architecture, authority), under the same
// program hash. Each run view names the revision and the last event it
// shows; `freshness` tells how far the run has moved since (G10), and a
// decision taken on an older revision is refused (stale_revision). Anything
// that came from a model, a tool or a person's answer is shown as untrusted
// plain content (G09).

import { architecture, architectureBlocks, authority, authorityBlocks, programRef, VIEW_FORMAT, type Block, type Cell, type Doc, type ProgramRef, type Program } from "@mandate/compiler";
import type { BudgetReport } from "./journal.js";
import type { Runtime } from "./runtime.js";
import { canonical, isObj, show, type Obj, type Value } from "./values.js";

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
  as_of: AsOf;
  waiting: Value;
  attention: Value;
  result: Value;
  error: Value;
  evidence: Array<{ evidence_id: string; contract: string; criterion: string; method: string; passed: boolean; producer: Value; signature_valid: boolean; artifacts: Value; at: number | null }>;
  budget: BudgetReport;
  actions: Array<{ effect: string; state: string; operation: string; action_digest: string; receipt: Value; artifacts: Value }>;
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
  const [row] = await rt.db.query<{ program: Program }>("select program from packages where package_hash = $1", [run.package_hash]);
  const program = row!.program;
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
    as_of,
    waiting: run.waiting,
    attention: run.attention,
    result: run.result,
    error: run.error,
    evidence,
    budget: await rt.budgetReport(runId),
    actions,
  };
  return { view, program };
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
      ["As of", `revision ${v.as_of.revision}, event ${v.as_of.event}`],
      ["View", `${VIEW_FORMAT}, generated from the program and the run's journal`],
    ],
    blocks: [...statusBlocks(v), ...evidenceBlocks(v), ...costBlocks(v), ...actionBlocks(v), ...architectureBlocks(architecture(program)), ...authorityBlocks(authority(program))],
  };
}
