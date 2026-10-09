// A program's tests (Doc 4 §6.4): each `test` block swaps the effect handlers
// for deterministic ones and runs workflows against them.
//
//   test "FixBug happy path" {
//     with handlers {
//       Model  = replay("fixtures/fixbug-01.jsonl"),
//       Fs     = memfs("fixtures/repo-snapshot"),
//       Verify = pass_all(),
//       git    = fake_git(),
//       Human  = auto_approve(role: "code_owner"),
//       Time   = fixed_clock("2026-10-07T21:00:00Z"),
//     }
//     run FixBug(fixtures.issue_42) expect ok
//   }
//
// Handlers:
//
//   Time   = fixed_clock("<ISO time>")     the clock starts there and moves only when the run waits
//   Model  = replay("<file.jsonl>")        recorded answers, one JSON object per line:
//                                          { "for": "Agent.skill" | "infer", "ok": … } or { "for": …, "error": { "tag": …, "args": […] } }
//                                          and an optional "cost"; each key's answers are used in order
//   Fs     = memfs("<directory>")          the working copy: fs.read_text and fs.list read it, checks and
//                                          git effects see its files
//   Verify = pass_all() | results(criterion: Bool, …)
//                                          contract checks; unnamed criteria pass
//   git    = fake_git()                    every git.* effect the program uses, applied in memory
//   Human  = auto_approve(role: r) | auto_decline(role: r) | answer("<text>")
//                                          a person who decides every wait for role r (any role without
//                                          it), or answers every question
//
// Swapping handlers is possible only here: in production the control plane
// picks every handler (INV-03). A handler this runner does not know fails
// the test by name; it is never ignored. An effect with no handler stops the
// run the way an unconfigured adapter does, and the test reports it.
//
// `run W(args) expect e` runs W with the arguments. `fixtures.<name>` is the
// JSON file `fixtures/<name>.json` next to the program. `expect ok` means
// the run succeeded; `expect failed`, `waiting`, `attention_required` and
// `cancelled` name the state it must end in.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { calleePath, type Expr, type Lock, type Program, type Stmt } from "@mandate/compiler";
import type { Adapters, Outcome } from "./adapters.js";
import type { Db } from "./db.js";
import { buildPackage, Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { SimAgents, SimClock, SimModel, SimReads, SimTool, SimVerifier, SimWorkspace, simulate } from "./sim.js";
import { isObj, type Obj, type Value } from "./values.js";

export interface TestResult {
  test: string;
  workflow: string;
  ok: boolean;
  expected: string;
  /** The state the run ended in, or `error` when the test could not run. */
  state: string;
  detail?: Value;
}

export interface TestOptions {
  db: Db;
  /** Where the program lives: handler files and fixtures are relative to it. */
  dir: string;
  lock?: Lock;
}

const STATES: Record<string, string> = { ok: "succeeded", failed: "failed", waiting: "waiting", attention_required: "attention_required", cancelled: "cancelled" };

class TestError extends Error {}

/** Runs every test of a program; one result per `run` statement. */
export async function runTests(program: Program, o: TestOptions): Promise<TestResult[]> {
  const out: TestResult[] = [];
  for (const [name, t] of Object.entries(program.tests ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const runs = t.body.filter((s): s is Extract<Stmt, { op: "run" }> => s.op === "run");
    if (!runs.length) out.push({ test: name, workflow: "", ok: false, expected: "", state: "error", detail: "the test runs nothing" });
    for (const [i, r] of runs.entries()) {
      const workflow = r.target.op === "call" ? (calleePath(r.target.callee) ?? "") : "";
      const expected = STATES[r.expect] ?? r.expect;
      try {
        const handlers = handlersFor(program, t.handlers ?? {}, o.dir);
        const end = await runOne(program, o, handlers, workflow, args(program, workflow, r.target, o.dir), `test:${name}:${i}`);
        out.push({ test: name, workflow, expected: r.expect, ok: end.state === expected, state: end.state, ...(end.detail !== undefined ? { detail: end.detail } : {}) });
      } catch (e) {
        if (!(e instanceof TestError || e instanceof Violation)) throw e;
        out.push({ test: name, workflow, ok: false, expected: r.expect, state: "error", detail: e.message });
      }
    }
  }
  return out;
}

interface Handlers {
  adapters: Adapters;
  clock: SimClock;
  person?: { decide?: { approve: boolean; role?: string }; answer?: string };
}

function handlersFor(program: Program, specs: Record<string, Expr>, dir: string): Handlers {
  const clock = new SimClock(Date.parse("2026-01-01T00:00:00Z"));
  let workspace: SimWorkspace | undefined;
  let replay: Map<string, Outcome[]> | undefined;
  let verify: Record<string, boolean> | undefined;
  let fakeGit = false;
  let person: Handlers["person"];
  // Fs first: other handlers see its files.
  const order = Object.keys(specs).sort((a, b) => (a === "Fs" ? -1 : b === "Fs" ? 1 : a < b ? -1 : 1));
  for (const key of order) {
    const e = specs[key]!;
    const ctor = e.op === "call" ? calleePath(e.callee) : e.op === "var" ? e.name : undefined;
    const pos = e.op === "call" ? e.args.filter((a) => a.name === undefined).map((a) => literal(a.value)) : [];
    const named = e.op === "call" ? Object.fromEntries(e.args.filter((a) => a.name !== undefined).map((a) => [a.name!, literal(a.value)])) : {};
    const at = `${key} = ${ctor ?? "?"}(…)`;
    switch (`${key}:${ctor}`) {
      case "Time:fixed_clock": {
        const t = Date.parse(String(pos[0]));
        if (Number.isNaN(t)) throw new TestError(`${at}: not a time: ${String(pos[0])}`);
        clock.t = t;
        break;
      }
      case "Fs:memfs":
        workspace = memfs(file(dir, String(pos[0]), at));
        break;
      case "Model:replay":
        replay = recorded(file(dir, String(pos[0]), at), at);
        break;
      case "Verify:pass_all":
        verify = {};
        break;
      case "Verify:results":
        verify = Object.fromEntries(Object.entries(named).map(([k, v]) => [k, v === true]));
        break;
      case "git:fake_git":
        fakeGit = true;
        break;
      case "Human:auto_approve":
      case "Human:auto_decline":
        person = { ...person, decide: { approve: ctor === "auto_approve", ...(typeof named["role"] === "string" ? { role: named["role"] } : {}) } };
        break;
      case "Human:answer":
        person = { ...person, answer: String(pos[0] ?? "") };
        break;
      default:
        throw new TestError(`unsupported handler ${at}; this runner knows Time = fixed_clock, Model = replay, Fs = memfs, Verify = pass_all | results, git = fake_git, Human = auto_approve | auto_decline | answer`);
    }
  }
  const tools = fakeGit ? effectsOf(program).filter((n) => n.startsWith("git.")).map((n) => new SimTool(n, "idempotent", workspace)) : [];
  const agents = new SimAgents();
  const model = new SimModel(() => missing("a model"));
  if (replay) {
    const take = (key: string): Outcome => replay!.get(key)?.shift() ?? { error: { tag: "Rejected", args: [`no recorded answer left for ${key}`] }, cost: {} };
    for (const key of replay.keys()) if (key !== "infer") agents.on(key, () => take(key));
    model.respond(() => take("infer"));
  }
  const reads = new SimReads();
  const sim = simulate({ tools, agents, model, ...(verify ? { verifier: new SimVerifier(verify, workspace) } : {}), reads, clock });
  if (workspace) {
    const ws = workspace;
    sim.adapters.reads = {
      call: async (name, a) => {
        const p = String(a[0] ?? "");
        if (name === "fs.read_text") return ws.files.has(p) ? { ok: ws.files.get(p)! } : { error: { tag: "Rejected", args: [`no file ${p}`] } };
        if (name === "fs.list") return { ok: [...ws.files.keys()].filter((f) => f.startsWith(p.endsWith("/") ? p : `${p}/`)).sort() };
        return { error: { tag: "Rejected", args: [`memfs cannot ${name}`] } };
      },
    };
  } else sim.adapters.reads = { call: async (name) => missing(`a handler for ${name} (Fs = memfs(…))`) };
  if (!replay) sim.adapters.agents = { run: async (req) => missing(`a handler for ${req.agent}.${req.skill} (Model = replay(…))`) };
  if (!verify) sim.adapters.verifier = { check: async () => missing("a handler for contract checks (Verify = pass_all())") };
  return { adapters: sim.adapters, clock, ...(person ? { person } : {}) };
}

async function runOne(program: Program, o: TestOptions, h: Handlers, workflow: string, input: Obj, runId: string): Promise<{ state: string; detail?: Value }> {
  const rt = new Runtime(o.db, h.adapters);
  const pkg = buildPackage(program, o.lock ?? { modules: Object.fromEntries((program.uses ?? []).filter((u) => u.module !== "std" && !u.module.startsWith("std.")).map((u) => [u.module, "test"])) });
  let run = await rt.startRun({ pkg, workflow, input, runId });
  // The person the handlers stand for answers each wait, a bounded number of times.
  for (let n = 0; run.state === "waiting" && n < 100; n++) {
    const w = isObj(run.waiting) ? run.waiting : {};
    const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
    const msg = { sender: "test", messageId: `${run.run_id}:${n}` };
    if (w["kind"] === "decision" && h.person?.decide && (!h.person.decide.role || req["role"] === h.person.decide.role)) {
      const digest = String(req["subject_digest"] ?? req["action_digest"] ?? "");
      run = await rt.decideAction(run.run_id, msg, { commandId: String(w["command"]), revision: run.revision, digest, approve: h.person.decide.approve, by: `test:${h.person.decide.approve ? "auto_approve" : "auto_decline"}` });
    } else if (w["kind"] !== "decision" && h.person?.answer !== undefined) {
      run = await rt.submitInput(run.run_id, msg, { commandId: String(w["command"]), revision: run.revision, value: h.person.answer });
    } else break;
  }
  const detail = run.state === "succeeded" ? run.result : run.state === "failed" ? run.error : run.state === "waiting" ? run.waiting : run.attention;
  return { state: run.state, ...(detail !== null ? { detail } : {}) };
}

/** A run's input: the workflow's parameters, by position, from literals and fixtures. */
function args(program: Program, workflow: string, target: Expr, dir: string): Obj {
  const wf = program.defs[workflow];
  if (wf?.kind !== "workflow") throw new TestError(`run names ${workflow || "nothing"}, which is not a workflow`);
  const given = target.op === "call" ? target.args : [];
  if (given.length !== wf.params.length) throw new TestError(`${workflow} takes ${wf.params.length} arguments, the test gives ${given.length}`);
  return Object.fromEntries(
    wf.params.map((p, i) => {
      const a = given[i]!;
      const e = a.value;
      if (e.op === "field" && e.of.op === "var" && e.of.name === "fixtures") {
        const f = file(dir, join("fixtures", `${e.name}.json`), `fixtures.${e.name}`);
        return [p.name, JSON.parse(readFileSync(f, "utf8")) as Value];
      }
      return [p.name, literal(e)];
    }),
  );
}

function literal(e: Expr): Value {
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
      return { $money: e.micros, $currency: e.currency };
    case "list":
    case "set":
      return e.items.map(literal);
    case "record":
      return Object.fromEntries(Object.entries(e.fields).map(([k, v]) => [k, literal(v)]));
    case "var":
      return e.name;
  }
  throw new TestError(`a test argument must be a literal or fixtures.<name>, not ${e.op}`);
}

/** A file next to the program; a test cannot reach outside its directory. */
function file(dir: string, name: string, at: string): string {
  const p = resolve(dir, name);
  const rel = relative(resolve(dir), p);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) throw new TestError(`${at}: ${name} is outside the program's directory`);
  if (!existsSync(p)) throw new TestError(`${at}: ${name} does not exist next to the program`);
  return p;
}

function memfs(root: string): SimWorkspace {
  if (!statSync(root).isDirectory()) throw new TestError(`memfs: ${root} is not a directory`);
  const ws = new SimWorkspace();
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else ws.write(relative(root, p).split(sep).join("/"), readFileSync(p, "utf8"));
    }
  };
  walk(root);
  return ws;
}

function recorded(path: string, at: string): Map<string, Outcome[]> {
  const out = new Map<string, Outcome[]>();
  readFileSync(path, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line, i) => {
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        throw new TestError(`${at}: line ${i + 1} is not JSON`);
      }
      const r = v as { for?: unknown; ok?: Value; error?: { tag: string; args?: Value[] }; cost?: Outcome["cost"] };
      if (typeof r.for !== "string" || (!("ok" in r) && !r.error)) throw new TestError(`${at}: line ${i + 1} needs "for" and "ok" or "error"`);
      const o: Outcome = "ok" in r ? { ok: r.ok ?? null, ...(r.cost ? { cost: r.cost as never } : {}) } : { error: r.error!, ...(r.cost ? { cost: r.cost } : {}) };
      out.set(r.for, [...(out.get(r.for) ?? []), o]);
    });
  return out;
}

/** The external effects a program's workflows use. */
function effectsOf(program: Program): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === "object") {
      const n = v as { op?: unknown; name?: unknown };
      if (n.op === "effect" && typeof n.name === "string") names.add(n.name);
      Object.values(v).forEach(visit);
    }
  };
  visit(program.defs);
  return [...names].sort();
}

function missing(what: string): never {
  throw new Violation("no_handler", `The test has no ${what}.`);
}
