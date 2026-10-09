// The control CLI (Doc 4 §16.1; BACKLOG K19): a person runs a program and
// answers it from a terminal, until the views of P2-14 exist.
//
//   mandate run <program> --workflow W --input <json> [--run-id ID] [--limit spend=20USD,tokens=2M]
//   mandate status <run> [--json]
//   mandate approve <run> --revision N --by NAME
//   mandate decline <run> --revision N --by NAME
//   mandate answer <run> --revision N --by NAME <text>
//   mandate cancel <run>
//   mandate raise-limits <run> --revision N --by NAME --limit spend=30USD
//   mandate replay <run>
//   mandate artifact <run> <blob:sha256:…>
//   mandate test <program> [--json]                       run the program's tests (§6.4); needs no configuration
//
// Every command reads `mandate.runtime.json` (or --config). A decision names
// the revision the person saw in `status`: if the run has moved since, it is
// refused (`stale_revision`) and nothing is recorded. What a person approves
// is what `status` showed them: the decision is bound to its digest.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, kindOf, parseStrictJson, type Lock, type Program } from "@mandate/compiler";
import type { Cost } from "./adapters.js";
import { adaptersFor, connect, readConfig, runtimeOptions, type RuntimeConfig } from "./control.js";
import { openDb, type Db } from "./db.js";
import type { RunRow } from "./journal.js";
import { buildPackage, Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { runTests } from "./testing.js";
import { isObj, show, type Obj, type Value } from "./values.js";

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
}

const VALUED = new Set(["--config", "--workflow", "--input", "--run-id", "--limit", "--revision", "--by", "--lock", "--message-id"]);

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) positional.push(a);
    else if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Usage(`${a} needs a value`);
      flags[a] = v;
    } else flags[a] = true;
  }
  return { positional, flags };
}

class Usage extends Error {}

const USAGE = `usage:
  mandate run <program> --workflow W --input <json|file> [--run-id ID] [--limit spend=20USD,tokens=2M] [--lock FILE]
  mandate status <run> [--json]
  mandate approve <run> --revision N --by NAME
  mandate decline <run> --revision N --by NAME
  mandate answer <run> --revision N --by NAME <text>
  mandate cancel <run>
  mandate raise-limits <run> --revision N --by NAME --limit spend=30USD
  mandate replay <run>
  mandate artifact <run> <blob:sha256:…>
  mandate test <program> [--json] [--lock FILE]
options: --config FILE (default ./mandate.runtime.json), --json, --message-id ID`;

export const CONTROL_COMMANDS = new Set(["run", "status", "approve", "decline", "answer", "cancel", "raise-limits", "replay", "artifact", "test"]);

/** Runs one control command; returns the exit status. */
export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let db: Db | undefined;
  try {
    const [cmd, ...rest] = argv;
    const a = parse(rest);
    const configFile = typeof a.flags["--config"] === "string" ? a.flags["--config"] : "mandate.runtime.json";
    if (!cmd || !CONTROL_COMMANDS.has(cmd)) throw new Usage(`unknown command ${cmd ?? ""}`);
    if (cmd === "test") return await test(a, out);
    if (!existsSync(configFile)) throw new Usage(`no runtime configuration at ${configFile} (see spec/runtime.md, "Control CLI")`);
    const config = readConfig(configFile);
    db = await connect(config);
    const json = a.flags["--json"] === true;
    const runId = a.positional[0];

    if (cmd === "run") {
      const file = a.positional[0] ?? fail("run needs a program file");
      const workflow = str(a, "--workflow");
      const { program, lock } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined);
      const rt = new Runtime(db, adaptersFor(config, program, lock, env), undefined, undefined, runtimeOptions(config, db));
      const run = await rt.startRun({
        pkg: buildPackage(program, lock),
        workflow,
        input: input(str(a, "--input")),
        ...(typeof a.flags["--run-id"] === "string" ? { runId: a.flags["--run-id"] } : {}),
        ...(typeof a.flags["--limit"] === "string" ? { limits: limits(a.flags["--limit"]) } : {}),
      });
      out(await report(rt, run, json, config));
      return 0;
    }

    if (!runId) throw new Usage(`${cmd} needs a run id`);
    const rt = await runtimeFor(db, config, runId, env);
    const msg = { sender: typeof a.flags["--by"] === "string" ? a.flags["--by"] : "cli", messageId: typeof a.flags["--message-id"] === "string" ? a.flags["--message-id"] : randomUUID() };
    let run: RunRow;
    switch (cmd) {
      case "status":
        run = await rt.getRun(runId);
        break;
      case "approve":
      case "decline": {
        const [rev, by] = [revision(a), str(a, "--by")];
        const w = waitOf(await rt.getRun(runId));
        if (w.kind !== "decision") throw new Violation("no_wait", `Run ${runId} is not waiting for a decision.`);
        const digest = String(w.request["subject_digest"] ?? w.request["action_digest"] ?? "");
        run = await rt.decideAction(runId, msg, { commandId: w.command, revision: rev, digest, approve: cmd === "approve", by });
        break;
      }
      case "answer": {
        const [rev, text] = [revision(a), a.positional.slice(1).join(" ")];
        str(a, "--by");
        if (!text) throw new Usage("answer needs the text of the answer");
        const w = waitOf(await rt.getRun(runId));
        if (w.kind !== "input") throw new Violation("no_wait", `Run ${runId} is not waiting for an answer.`);
        run = await rt.submitInput(runId, msg, { commandId: w.command, revision: rev, value: text });
        break;
      }
      case "cancel":
        run = await rt.cancelRun(runId);
        break;
      case "raise-limits":
        run = await rt.raiseLimits(runId, msg, { revision: revision(a), limits: limits(str(a, "--limit")), by: str(a, "--by") });
        break;
      case "artifact": {
        const ref = a.positional[1] ?? fail("artifact needs a reference, blob:sha256:…");
        const got = await rt.artifact(runId, ref);
        out(new TextDecoder().decode(got.bytes));
        return 0;
      }
      case "replay": {
        const r = await rt.replayRun(runId);
        out(json ? JSON.stringify(r, null, 2) + "\n" : `replay: ${r.status}${"value" in r ? `\n${show(r.value)}` : ""}${"stoppedAt" in r ? ` at ${r.stoppedAt}` : ""}${"missing" in r ? ` (missing ${r.missing})` : ""}\n`);
        return 0;
      }
      default:
        throw new Usage(`unknown command ${cmd}`);
    }
    out(await report(rt, run, json, config));
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`mandate: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof Violation) {
      process.stderr.write(`mandate: ${e.code}: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    await db?.close();
  }
}

/** Runs a program's tests against their handlers, on an in-process database of their own; exit 1 if any fails. */
async function test(a: Args, out: (s: string) => void): Promise<number> {
  const file = a.positional[0] ?? fail("test needs a program file");
  const { program, lock } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined);
  const db = await openDb();
  try {
    const results = await runTests(program, { db, dir: dirname(file), lock });
    if (a.flags["--json"] === true) out(JSON.stringify(results, null, 2) + "\n");
    else {
      for (const r of results) out(`${r.ok ? "ok  " : "FAIL"} ${r.test}: ${r.workflow} expected ${r.expected}, ${r.ok ? "got it" : `got ${r.state}${r.detail !== undefined ? ` (${show(r.detail).slice(0, 300)})` : ""}`}\n`);
      if (!results.length) out("no tests\n");
    }
    return results.every((r) => r.ok) ? 0 : 1;
  } finally {
    await db.close();
  }
}

function fail(message: string): never {
  throw new Usage(message);
}

function str(a: Args, flag: string): string {
  const v = a.flags[flag];
  if (typeof v !== "string") throw new Usage(`${flag} is required`);
  return v;
}

function revision(a: Args): number {
  const n = Number(str(a, "--revision"));
  if (!Number.isInteger(n)) throw new Usage("--revision takes the revision number `status` showed");
  return n;
}

/** `spend=20USD,tokens=2M,steps=40`. */
function limits(text: string): Cost {
  const c: Cost = {};
  for (const part of text.split(",")) {
    const [k, v] = part.split("=");
    const m = v?.match(/^([0-9]+(?:\.[0-9]+)?)([kM]?)([A-Z]{3})?$/);
    if (!k || !m) throw new Usage(`cannot read the limit ${part}; write e.g. spend=20USD or tokens=2M`);
    const n = Number(m[1]) * (m[2] === "M" ? 1_000_000 : m[2] === "k" ? 1000 : 1);
    if (k === "spend") c.spend = { micros: Math.round(n * 1_000_000), currency: m[3] ?? "USD" };
    else if (k === "tokens") c.tokens = n;
    else if (k === "steps") c.steps = n;
    else throw new Usage(`unknown limit ${k}; use spend, tokens or steps`);
  }
  return c;
}

function input(text: string): Obj {
  const raw = existsSync(text) ? readFileSync(text, "utf8") : text;
  const parsed = parseStrictJson(raw);
  if (!parsed.ok || !isObj(parsed.value.value as Value)) throw new Usage("--input takes a JSON object, inline or in a file");
  return parsed.value.value as Obj;
}

/** The program, checked, and its lock: --lock, or mandate.lock.json next to it. */
function load(file: string, lockFile: string | undefined): { program: Program; lock: Lock } {
  const lockPath = lockFile ?? join(dirname(file), "mandate.lock.json");
  let lock: Lock | undefined;
  if (existsSync(lockPath)) {
    const parsed = parseStrictJson(readFileSync(lockPath, "utf8"));
    if (!parsed.ok) throw new Violation("malformed_lock", `${lockPath}: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
    lock = parsed.value.value as unknown as Lock;
  }
  const r = check(readFileSync(file, "utf8"), kindOf(file), lock ? { lock } : {});
  if (!r.ok) throw new Violation("load_verification_failed", r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join("\n"));
  const { lock: _format, ...pinned } = lock ?? { modules: {} };
  return { program: r.program!, lock: pinned };
}

async function runtimeFor(db: Db, config: RuntimeConfig, runId: string, env: NodeJS.ProcessEnv): Promise<Runtime> {
  const [row] = await db.query<{ program: Program; lock: Lock }>("select p.program, p.lock from runs r join packages p on p.package_hash = r.package_hash where r.run_id = $1", [runId]);
  if (!row) throw new Violation("unknown_run", `No run ${runId}.`);
  return new Runtime(db, adaptersFor(config, row.program, row.lock, env), undefined, undefined, runtimeOptions(config, db));
}

function waitOf(run: RunRow): { kind: string; command: string; request: Obj } {
  const w = run.waiting;
  if (run.state !== "waiting" || !isObj(w)) throw new Violation("no_wait", `Run ${run.run_id} is ${run.state}, not waiting.`);
  const kind = w["kind"] === "budget_exceeded" ? "input" : String(w["kind"]);
  return { kind, command: String(w["command"]), request: isObj(w["request"] ?? null) ? (w["request"] as Obj) : {} };
}

/** What a person needs to see to decide: the run, what it waits for, the budget, the evidence and the actions. */
async function report(rt: Runtime, run: RunRow, json: boolean, config: RuntimeConfig): Promise<string> {
  const budget = await rt.budgetReport(run.run_id);
  const evidence = await rt.evidence(run.run_id);
  const signed = new Map((await rt.verifyEvidence(run.run_id)).map((e) => [e.evidence_id, e.valid]));
  const actions = await rt.journal.actions(run.run_id);
  if (json) return JSON.stringify({ run, budget, evidence: evidence.map((e) => ({ ...e, signature_valid: signed.get(e.evidence_id) ?? false })), actions }, null, 2) + "\n";
  const lines = [`run ${run.run_id}  ${run.workflow}  ${run.state}  revision ${run.revision}`];
  if (run.state === "waiting" && isObj(run.waiting)) {
    const w = run.waiting;
    const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
    if (w["kind"] === "decision" && "criterion" in req) {
      lines.push(`waiting for: ${req["role"] ?? "a person"} to approve ${req["contract"]}.${req["criterion"]}`);
      lines.push(`  subject digest ${req["subject_digest"]}${typeof req["deadline"] === "number" ? `, deadline ${new Date(req["deadline"]).toISOString()}` : ""}`);
      lines.push(...subjectLines(req["subject"] ?? null));
      if (config.verifier) lines.push(`  the change in ${config.verifier.workdir}: git -C ${config.verifier.workdir} diff ${config.verifier.base}`);
      lines.push(`  approve: mandate approve ${run.run_id} --revision ${run.revision} --by <you>`, `  decline: mandate decline ${run.run_id} --revision ${run.revision} --by <you>`);
    } else if (w["kind"] === "timer") {
      lines.push(`waiting for: a timer until ${typeof req["until"] === "number" ? new Date(req["until"]).toISOString() : "?"} (${String(req["reason"] ?? "")}); the scheduler resumes the run then`);
    } else if (w["kind"] === "decision") {
      lines.push(`waiting for: approval of action ${req["effect"] ?? ""} (digest ${req["action_digest"]})`);
      lines.push(`  approve: mandate approve ${run.run_id} --revision ${run.revision} --by <you>`);
    } else {
      const q = req["question"] ?? req["escalation"] ?? (w["kind"] === "budget_exceeded" ? "Budget exceeded." : null);
      lines.push(`waiting for: an answer${q !== null ? `: ${show(q as Value)}` : ""}`);
      if (w["kind"] === "budget_exceeded") lines.push(`  raise:  mandate raise-limits ${run.run_id} --revision ${run.revision} --by <you> --limit spend=<amount>USD`);
      lines.push(`  answer: mandate answer ${run.run_id} --revision ${run.revision} --by <you> <text>`);
    }
  }
  if (run.state === "attention_required") lines.push(`attention: ${show(run.attention ?? null)}`);
  if (run.state === "failed") lines.push(`error: ${show(run.error ?? null)}`);
  if (run.state === "succeeded") lines.push(`result: ${show(run.result ?? null)}`);
  for (const d of budget.dimensions) {
    const money = d.dimension.startsWith("spend:");
    const f = (n: number) => (money ? `${(n / 1_000_000).toFixed(4)} ${d.dimension.slice(6)}` : String(n));
    lines.push(`budget ${d.dimension}: limit ${f(d.limit)}, settled ${f(d.settled)}, reserved ${f(d.reserved)}, available ${f(d.available)}`);
  }
  for (const e of evidence) lines.push(`evidence ${e.contract}.${e.criterion}: ${e.passed ? "met" : "not met"} (${e.method}; ${signed.get(e.evidence_id) ? "signed" : "SIGNATURE INVALID"})`);
  for (const x of actions) lines.push(`action ${x.effect}: ${x.state}${x.receipt ? ` ${show(x.receipt)}` : ""}`);
  return lines.join("\n") + "\n";
}

function subjectLines(subject: Value): string[] {
  const parts = Array.isArray(subject) ? subject : [subject];
  const out: string[] = [];
  for (const p of parts) {
    if (!isObj(p)) continue;
    for (const k of ["issue", "patch", "tests", "review"]) {
      const v = p[k];
      if (v !== undefined) out.push(`  ${k}: ${show(v).slice(0, 600)}`);
    }
  }
  return out;
}
