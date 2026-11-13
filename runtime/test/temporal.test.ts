// Temporal as the scheduler (step 3b, Doc 4 §16.1). The same runs as the
// other tests, but driven by a Temporal workflow: activities resume the run
// against PostgreSQL, control calls wake it with a signal, and a durable
// timer expires a decision's deadline.
//
// The local Temporal dev server is downloaded by the SDK, or taken from
// TEMPORAL_CLI_PATH.

import { randomUUID } from "node:crypto";
import { check, load, type WorkflowDef } from "@mandate/compiler";
import { WorkflowFailedError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime as TemporalRuntime, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import type { HostProbe, HostTool, ToolReading } from "../src/fitness.js";
import type { ProgramChecker, WorkerChecker } from "../src/plan.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimSandboxHost, SimTool, toolUse, wallClock } from "../src/sim.js";
import { createWorker, TemporalDriver, UNFIT_ATTEMPTS, workflowId, workflowsPath, type RunOptions } from "../src/temporal/index.js";
import { isObj, type Value } from "../src/values.js";
import { FakeHost, FIT, HOST } from "./fake-host.js";
import { closeAll, LOCK, planChecker, world, type World, UNSIGNED } from "./helpers.js";
import { commenting, finish, leadChat, program, programAt, submit } from "./planning.js";
import { BUG, FIXBUG, fixbugAgents, RESULTS, USD, waitOf } from "./fixbug.js";
import { ASK, FIX, ISSUE, NOTIFY } from "./programs.js";

let env: TestWorkflowEnvironment;
let bundle: WorkflowBundleWithSourceMap;
let checker: WorkerChecker;

beforeAll(async () => {
  checker = await planChecker();
  TemporalRuntime.install({ logger: new DefaultLogger("WARN") });
  const path = process.env["TEMPORAL_CLI_PATH"];
  env = await TestWorkflowEnvironment.createLocal(path ? { server: { executable: { type: "existing-path", path } } } : {});
  bundle = await bundleWorkflowCode({ workflowsPath: workflowsPath(), logger: new DefaultLogger("WARN") });
}, 180_000);

afterAll(async () => {
  await env?.teardown();
  await checker?.close();
  await closeAll();
});

interface Scheduled extends World {
  control: Runtime;
  driver: TemporalDriver;
  /**
   * Runs the test body while a worker serves the run's task queue: the worker's runtime (`rt`), or with `host` a
   * worker of its own on that host. A worker serves once, so each call starts a new one.
   */
  serve<T>(body: () => Promise<T>, host?: HostProbe): Promise<T>;
}

async function scheduled(src: string, o: Parameters<typeof world>[1] & { runOptions?: RunOptions; controlHost?: HostProbe; workerHost?: HostProbe } = {}): Promise<Scheduled> {
  const w = await world(src, o);
  const taskQueue = `mandate-${randomUUID()}`;
  // The earlier programs take a decision on the caller's word; a 0.4 program gives the keys it takes signed ones with.
  const decisions = o.decisions ?? UNSIGNED.decisions;
  // The worker's runtime keeps timers durable; control calls share its key, so either can check the evidence.
  const plan = o.plan ? { plan: o.plan } : {};
  // Each process reads its own host's tools.
  const host = (probe: HostProbe | undefined) => (probe ? { hostProbe: probe } : {});
  const workerRuntime = (probe: HostProbe | undefined) => new Runtime(w.db, w.adapters, w.faults, undefined, { decisions, durableTimers: true, signer: w.rt.signer, artifacts: w.rt.artifacts, ...plan, ...host(probe) });
  const runtime = workerRuntime(o.workerHost);
  const driver = new TemporalDriver(env.client, taskQueue, o.runOptions);
  const control = new Runtime(w.db, w.adapters, w.faults, driver, { decisions, signer: w.rt.signer, artifacts: w.rt.artifacts, ...plan, ...host(o.controlHost) });
  const serve = async <T>(body: () => Promise<T>, probe?: HostProbe): Promise<T> => {
    const worker = await createWorker({ connection: env.nativeConnection, taskQueue, runtime: probe ? workerRuntime(probe) : runtime, workflowBundle: bundle });
    return worker.runUntil(body());
  };
  return { ...w, rt: runtime, driver, control, serve };
}

/** A 0.4 workflow that maps a list, with no envelope and no role: it asks no person, so it needs no member's key. */
const EACH = `mandate @ 0.4

module test.each @ 0.1

use std.{model}

capability ModelStd = model.infer(tier: standard)

agent Worker {
  caps   ModelStd
  budget { tokens: 1k, steps: 5 }
  skill say(t: Text) -> Inferred<Text> ! {Model}
}

workflow Each(items: List<Text>) -> List<Outcome<Inferred<Text>>>
  caps    ModelStd
  budget  { tokens: 10k, steps: 40 }
{
  map x in items max 4 par 2 {
    delegate Worker.say(x)
  }
}
`;

async function stateOf(s: Scheduled, runId: string, state: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if ((await s.control.getRun(runId)).state === state) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`run ${runId} never reached ${state}`);
}

describe("Temporal schedules runs", () => {
  it("drives a run to its result; StartRun only starts the workflow", async () => {
    const s = await scheduled(FIX);
    const started = await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "t1" });
    expect(started.state).toBe("accepted");
    const done = await s.serve(() => s.driver.result("t1"));
    expect(done).toEqual({ runId: "t1", state: "succeeded", wakeInMs: null });
    expect(s.agents.count()).toBe(1);
    // Starting the same run again does not start a second workflow.
    await s.driver.start("t1");
  });

  it("a worker that dies is replaced by Temporal's retry, and the journal prevents a second call (R01)", async () => {
    const s = await scheduled(FIX);
    s.faults.arm("after_record", (i) => i.kind === "delegate");
    await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "t2" });
    const done = await s.serve(() => s.driver.result("t2"));
    expect(done.state).toBe("succeeded");
    expect(s.agents.count()).toBe(1);
    const leases = (await s.control.journal.events("t2")).filter((e) => e.type === "lease_acquired");
    expect(leases).toHaveLength(2);
  });

  it("a crash after commit does not send the action twice (R02)", async () => {
    const tool = new SimTool("git.comment");
    const s = await scheduled(NOTIFY, { tools: [tool] });
    s.faults.arm("after_commit");
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t3" });
    expect((await s.serve(() => s.driver.result("t3"))).state).toBe("succeeded");
    expect(tool.appliedCount()).toBe(1);
  });

  it("an input wakes the waiting run", async () => {
    const s = await scheduled(ASK);
    await s.control.startRun({ pkg: s.pkg, workflow: "Ask", input: ISSUE, runId: "t4" });
    const done = await s.serve(async () => {
      await stateOf(s, "t4", "waiting");
      const run = await s.control.getRun("t4");
      const cmd = isObj(run.waiting) ? String(run.waiting["command"]) : "";
      await s.control.submitInput("t4", { sender: "alice", messageId: "m1" }, { commandId: cmd, revision: run.revision, value: "yes" });
      return s.driver.result("t4");
    });
    expect(done.state).toBe("succeeded");
    expect((await s.control.getRun("t4")).result).toBe("yes");
  });

  it("an approval wakes the run and the action is sent once", async () => {
    const tool = new SimTool("git.comment");
    const s = await scheduled(NOTIFY, { tools: [tool] });
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t5", authorize: { "git.comment": { by: "human", role: "owner" } } });
    const done = await s.serve(async () => {
      await stateOf(s, "t5", "waiting");
      const run = await s.control.getRun("t5");
      const w = run.waiting;
      const req = isObj(w) && isObj(w["request"]) ? w["request"] : {};
      await s.control.decideAction("t5", { sender: "alice", messageId: "m1" }, { commandId: String(isObj(w) ? w["command"] : ""), revision: run.revision, digest: String(req["action_digest"]), approve: true, by: "alice" });
      return s.driver.result("t5");
    });
    expect(done.state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it("a durable timer expires an approval deadline and nothing is sent (R15)", async () => {
    const tool = new SimTool("git.comment");
    const s = await scheduled(NOTIFY, { tools: [tool], clock: wallClock });
    const t0 = Date.now();
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t6", authorize: { "git.comment": { by: "human", role: "owner", deadlineMs: 1_500 } } });
    const done = await s.serve(() => s.driver.result("t6"));
    expect(done.state).toBe("failed");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
    expect((await s.control.getRun("t6")).error).toEqual({ $tag: "Rejected", $args: ["approval_expired"] });
    expect(tool.executions).toHaveLength(0);
  });

  it("a durable timer expires the code owner's approval: the criterion is unmet and no PR is prepared (R15)", async () => {
    const pr = new SimTool("git.open_pr");
    const src = FIXBUG.replace('by human.approve(role: "code_owner")', 'by human.approve(role: "code_owner", deadline: 1500ms)');
    const s = await scheduled(src, { tools: [pr], agents: fixbugAgents(), clock: wallClock });
    const t0 = Date.now();
    await s.control.startRun({ pkg: s.pkg, workflow: "FixBug", input: BUG, runId: "t10" });
    const done = await s.serve(async () => {
      let run = await s.control.getRun("t10");
      for (let i = 0; i < 400 && !(isObj(run.waiting) && String(run.waiting["command"]).endsWith("/on_unmet/then")); i++) {
        await new Promise((r) => setTimeout(r, 50));
        run = await s.control.getRun("t10");
      }
      // Nobody approved; the timer expired the approval and the run escalated.
      expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
      expect(waitOf(run.waiting).request).toEqual({ escalation: 'Open acceptance criteria: ["owner_approved"]' });
      await s.control.cancelRun("t10");
      return s.driver.result("t10");
    });
    expect(done.state).toBe("cancelled");
    expect((await s.control.evidence("t10")).find((e) => e.criterion === "owner_approved")).toMatchObject({ passed: false, detail: { expired: true } });
    expect(pr.prepares).toHaveLength(0);
  });

  it("waits out a restart's backoff on a durable timer, not in an activity (§8.7, P2-16)", async () => {
    const agents = new SimAgents().on("Worker.fix", (_req, n) => (n === 1 ? { error: { tag: "Timeout" }, cost: { steps: 1 } } : { ok: "fixed", cost: { steps: 1 } }));
    const s = await scheduled(FIX.replace("delegate Worker.fix(issue)", "delegate Worker.fix(issue) supervise restart(max: 1, backoff: 1s)"), { agents, clock: wallClock });
    const t0 = Date.now();
    await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "t11" });
    const done = await s.serve(() => s.driver.result("t11"));
    expect(done.state).toBe("succeeded");
    expect(Date.now() - t0).toBeGreaterThanOrEqual(500);
    expect(agents.calls.map((c) => c.attempt)).toEqual([0, 1]);
    // The run waited on a timer: the worker gave the lease up, and the timer's expiry resumed it with a new one.
    const events = await s.control.journal.events("t11");
    expect(events.some((e) => e.type === "run_waiting" && isObj(e.data) && isObj(e.data["waiting"]) && e.data["waiting"]["kind"] === "timer")).toBe(true);
    expect(events.filter((e) => e.type === "lease_acquired")).toHaveLength(2);
  });

  it("continues as new after many waits, losing nothing (§16.1, P2-16)", async () => {
    const s = await scheduled(ASK, { runOptions: { waitsPerHistory: 2 } });
    await s.control.startRun({ pkg: s.pkg, workflow: "Ask", input: ISSUE, runId: "t12" });
    const handle = env.client.workflow.getHandle(workflowId("t12"));
    const first = (await handle.describe()).runId;
    const done = await s.serve(async () => {
      await stateOf(s, "t12", "waiting");
      // Wakes that change nothing still cost history: three of them start a new execution.
      for (let i = 0; i < 3; i++) {
        await s.driver.wake("t12");
        await new Promise((r) => setTimeout(r, 300));
      }
      for (let i = 0; i < 100 && (await handle.describe()).runId === first; i++) await new Promise((r) => setTimeout(r, 50));
      const run = await s.control.getRun("t12");
      await s.control.submitInput("t12", { sender: "alice", messageId: "m1" }, { commandId: waitOf(run.waiting).command, revision: run.revision, value: "yes" });
      return s.driver.result("t12");
    });
    expect(done.state).toBe("succeeded");
    expect((await handle.describe()).runId).not.toBe(first);
    expect((await s.control.getRun("t12")).result).toBe("yes");
  });

  it("cancelling a waiting run ends its workflow", async () => {
    const s = await scheduled(ASK);
    await s.control.startRun({ pkg: s.pkg, workflow: "Ask", input: ISSUE, runId: "t7" });
    const done = await s.serve(async () => {
      await stateOf(s, "t7", "waiting");
      expect((await s.control.cancelRun("t7")).state).toBe("cancelled");
      return s.driver.result("t7");
    });
    expect(done.state).toBe("cancelled");
  });

  it("an unknown outcome parks the run until reconciliation wakes it (R04)", async () => {
    const tool = new SimTool("git.comment", "reconcilable").then("lose_response");
    const agents = new SimAgents();
    const s = await scheduled(NOTIFY, { tools: [tool], agents });
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "t8" });
    const done = await s.serve(async () => {
      await stateOf(s, "t8", "attention_required");
      const [action] = await s.control.journal.actions("t8");
      await s.control.reconcileAction("t8", action!.operation_key);
      return s.driver.result("t8");
    });
    expect(done.state).toBe("succeeded");
    expect(tool.executions).toHaveLength(1);
  });

  it("runs a map: a worker that dies between items is replaced, no item is sent twice, and the outcomes are in input order (R11, R01)", async () => {
    const agents = new SimAgents().on("Worker.say", (req) => (req.args[0] === "b" ? { error: { tag: "SkillFailed", args: ["no luck"] }, cost: { steps: 1 } } : { ok: `said ${String(req.args[0])}`, cost: { steps: 1 } }));
    const s = await scheduled(EACH, { agents, decisions: { keys: new TrustedKeys([]) } });
    // The worker dies once, after the first result it records.
    s.faults.arm("after_record", (i) => i.kind === "delegate");
    await s.control.startRun({ pkg: s.pkg, workflow: "Each", input: { items: ["a", "b", "c"] }, runId: "t10" });
    const done = await s.serve(() => s.driver.result("t10"));
    expect(done.state).toBe("succeeded");
    const ok = (t: string) => ({ $tag: "Ok", $args: [`said ${t}`] });
    expect((await s.control.getRun("t10")).result).toEqual([ok("a"), { $tag: "Failed", $args: [{ $tag: "SkillFailed", $args: ["no luck"] }] }, ok("c")]);
    expect(s.agents.count()).toBe(3);
    const events = await s.control.journal.events("t10");
    expect(events.filter((e) => e.type === "lease_acquired")).toHaveLength(2);
    // The resumed run does not start the map a second time.
    expect(events.filter((e) => e.type === "map_started").map((e) => e.data)).toEqual([{ map: "/defs/Each/body/0/value", items: 3, par: 2 }]);
  });

  it("runs a plan: a worker that dies inside a sub-program is replaced, the sub-program is admitted and checked once, and the release manager's signed decision wakes the run (N05, R01)", async () => {
    const alice = EvidenceSigner.generate();
    const bob = EvidenceSigner.generate();
    const lock = { modules: {}, members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } }, roles: { platform_lead: ["alice"], release_manager: ["bob"] } };
    const tool = new SimTool("git.comment", "reconcilable");
    let checks = 0;
    const counted: ProgramChecker = { check: (input, ms) => (checks++, checker.check(input, ms)) };
    const s = await scheduled(program({ approve: "git.comment by release_manager" }), { lock, tools: [tool], decisions: { keys: new TrustedKeys([alice.publicKey, bob.publicKey]) }, plan: { checker: counted } });
    const { chat, told } = leadChat([submit(1, commenting("a", "fixed")), finish("planned")]);
    s.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    await s.control.approveEnvelope(s.pkg, signDecision(alice, shownPackage(s.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(s.adapters.clock.now()) }));
    // The worker dies once, after it recorded the result of the sub-program's delegation.
    s.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.startsWith(programAt(1)));
    await s.control.startRun({ pkg: s.pkg, workflow: "W", input: { items: [{ name: "a" }] }, runId: "t11" });
    const done = await s.serve(async () => {
      await stateOf(s, "t11", "waiting");
      // The sub-program is in flight and its comment waits for the release manager: nothing was sent.
      expect(tool.executions).toHaveLength(0);
      const signed = signDecision(bob, await s.control.shown("t11", "wait"), { kind: "approve", member: "bob", at: new Date(s.adapters.clock.now()) });
      await s.control.decideAction("t11", { sender: "bob", messageId: "m1" }, { signed });
      return s.driver.result("t11");
    });
    expect(done.state).toBe("succeeded");
    expect((await s.control.getRun("t11")).result).toBe("planned");
    expect(tool.executions).toHaveLength(1);
    expect(told).toMatchObject([{ admitted: true, number: 1, result: "fixed a" }]);
    // The worker that took over found the admission in the journal: one check, one admission, one worker's turn.
    expect(checks).toBe(1);
    const events = await s.control.journal.events("t11");
    expect(events.filter((e) => e.type === "program_admitted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "program_submitted")).toHaveLength(1);
    expect(events.filter((e) => e.type === "lease_acquired").length).toBeGreaterThanOrEqual(3);
    expect(chat.calls.filter((c) => c.agent === "Worker")).toHaveLength(1);
    expect((await s.control.journal.budget("t11"))["agents"]).toEqual({ limit: 12, settled: 2, reserved: 0 });
  });

  it("amends an envelope: the lead's request rests the run, the owner's signed decision wakes it, and it goes on under the new package (N04)", async () => {
    const alice = EvidenceSigner.generate();
    const lock = { modules: {}, members: { alice: { keys: [alice.keyId] } }, roles: { platform_lead: ["alice"], release_manager: ["alice"] } };
    const wider = program({ budget: "{ tokens: 400k, steps: 400, agents: 12 }" });
    const s = await scheduled(program(), { lock, decisions: { keys: new TrustedKeys([alice.publicKey]) }, plan: { checker } });
    const envelope = (load(wider, "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Value;
    const { chat, told } = leadChat([[toolUse("a1", "request_amendment", { envelope, reason: "the rest needs more" })], finish("amended")]);
    s.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    await s.control.approveEnvelope(s.pkg, signDecision(alice, shownPackage(s.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(s.adapters.clock.now()) }));
    await s.control.startRun({ pkg: s.pkg, workflow: "W", input: { items: [] }, runId: "t12" });
    const to = buildPackage(check(wider, "mdt").program!, lock).hash;
    const done = await s.serve(async () => {
      await stateOf(s, "t12", "waiting");
      const shown = await s.control.shown("t12", "wait");
      expect(shown).toMatchObject({ package: s.pkg.hash, subject: to, role: "platform_lead" });
      await s.control.decideAmendment("t12", { sender: "alice", messageId: "m1" }, signDecision(alice, shown, { kind: "amend", member: "alice", at: new Date(s.adapters.clock.now()) }));
      return s.driver.result("t12");
    });
    expect(done.state).toBe("succeeded");
    const run = await s.control.getRun("t12");
    expect([run.result, run.package_hash]).toEqual(["amended", to]);
    expect(told).toMatchObject([{ amended: true, package: to }]);
    // The lead was asked twice in all: the worker that went on found its first turn in the journal.
    expect(chat.calls.filter((c) => c.agent === "Lead")).toHaveLength(2);
    expect((await s.control.journal.budget("t12"))["tokens"]).toMatchObject({ limit: 400_000 });
  });

  it("a durable timer ends an amendment nobody answered, and the envelope stays (N04, R15)", async () => {
    const alice = EvidenceSigner.generate();
    const lock = { modules: {}, members: { alice: { keys: [alice.keyId] } }, roles: { platform_lead: ["alice"], release_manager: ["alice"] } };
    const timed = (tokens: string): string => program({ budget: `{ tokens: ${tokens}, steps: 400, agents: 12, time: 1500ms }` });
    const s = await scheduled(timed("200k"), { lock, decisions: { keys: new TrustedKeys([alice.publicKey]) }, plan: { checker }, clock: wallClock });
    const envelope = (load(timed("400k"), "mdt").program!.defs["W"] as WorkflowDef).envelope as unknown as Value;
    const { chat, told } = leadChat([[toolUse("a1", "request_amendment", { envelope, reason: "the rest needs more" })], finish("nobody answered")]);
    s.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    await s.control.approveEnvelope(s.pkg, signDecision(alice, shownPackage(s.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date() }));
    const t0 = Date.now();
    await s.control.startRun({ pkg: s.pkg, workflow: "W", input: { items: [] }, runId: "t13" });
    await s.serve(() => s.driver.result("t13"));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_500);
    expect(told).toMatchObject([{ amended: false, declined: { reason: "approval_expired", by: null } }]);
    const run = await s.control.getRun("t13");
    expect([run.state, run.result]).toEqual(["succeeded", "nobody answered"]);
    expect(run.package_hash).toBe(s.pkg.hash);
    expect((await s.control.journal.events("t13")).filter((e) => e.type === "package_amended")).toEqual([]);
  });

  it("runs FixBug end to end: the code owner's approval wakes it, and a crash after commit opens one PR", async () => {
    const pr = new SimTool("git.open_pr");
    const s = await scheduled(FIXBUG, { tools: [pr], agents: fixbugAgents() });
    s.faults.arm("after_commit");
    await s.control.startRun({ pkg: s.pkg, workflow: "FixBug", input: BUG, runId: "t9" });
    const done = await s.serve(async () => {
      await stateOf(s, "t9", "waiting");
      const run = await s.control.getRun("t9");
      const wait = waitOf(run.waiting);
      expect(wait.request).toMatchObject({ contract: "FixAccepted", criterion: "owner_approved", role: "code_owner" });
      expect(pr.prepares).toHaveLength(0);
      await s.control.decideAction("t9", { sender: "carol", messageId: "m1" }, { commandId: wait.command, revision: run.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
      return s.driver.result("t9");
    });
    expect(done.state).toBe("succeeded");
    expect(pr.appliedCount()).toBe(1);
    expect(Object.keys(RESULTS).map((k) => s.agents.count(k))).toEqual([1, 1, 1, 1, 1]);
    expect((await s.control.evidence("t9")).every((e) => e.passed)).toBe(true);
    expect((await s.control.budgetReport("t9")).dimensions).toEqual([{ dimension: "spend:USD", limit: 50 * USD, settled: 11 * USD, reserved: 0, available: 39 * USD }]);
    // Started, woken by the approval, and resumed by Temporal's retry after the crash.
    const leases = (await s.control.journal.events("t9")).filter((e) => e.type === "lease_acquired");
    expect(leases).toHaveLength(3);
  });
});

describe("under Temporal the host that is checked is the worker's (spec/boundary.md \"Host fitness\")", () => {
  const ATTEMPTS = UNFIT_ATTEMPTS;
  const lock = { ...LOCK, host: HOST };
  const BELOW = { ...FIT, bwrap: { output: "bubblewrap 0.9.0\n", path: "/usr/bin/bwrap", setuid: false } };
  const REFUSAL = "unfit_host: This host does not meet the package's lock: bwrap: 0.9.0 found, the lock asks 0.11.0 or later, not setuid. Nothing of the package runs here (spec/boundary.md).";
  /** How many times a host was checked: each check reads `bwrap`, then `node`. */
  const checks = (h: FakeHost): number => h.asked.filter((t) => t === "bwrap").length;
  /** What the run is in PostgreSQL: its row, its events and its commands. */
  const recorded = async (s: Scheduled, runId: string) => ({
    run: await s.control.getRun(runId),
    events: await s.control.journal.events(runId),
    commands: await s.db.query("select command_id, state, error from commands where run_id = $1 order by command_id", [runId]),
  });
  /** How the run's workflow ends within `ms`: its result, its failure, or neither. */
  const ending = async (s: Scheduled, runId: string, ms: number): Promise<{ result: unknown } | { failure: unknown } | { pending: number }> => {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ pending: number }>((r) => (timer = setTimeout(() => r({ pending: ms }), ms)));
    try {
      return await Promise.race([s.driver.result(runId).then((result) => ({ result }), (failure: unknown) => ({ failure })), late]);
    } finally {
      clearTimeout(timer);
    }
  };
  /** The workflow failed with `unfit_host` and the refusal the worker's host gave. */
  const failedUnfit = (end: Awaited<ReturnType<typeof ending>>): void => {
    expect(end).toHaveProperty("failure");
    const failure = (end as { failure: unknown }).failure;
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect((failure as WorkflowFailedError).cause).toMatchObject({ type: "unfit_host", message: REFUSAL, nonRetryable: true });
  };

  it(`an unfit worker is tried ${ATTEMPTS} times, then the workflow fails with unfit_host, and the run is as it was`, async () => {
    const workerHost = new FakeHost(BELOW);
    const s = await scheduled(FIX, { lock, controlHost: new FakeHost(FIT), workerHost });
    await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "h2" });
    const before = await recorded(s, "h2");
    const end = await s.serve(() => ending(s, "h2", 12_000));
    expect(checks(workerHost)).toBe(ATTEMPTS);
    failedUnfit(end);
    // No lease, no state, no event: the run waits, accepted, for a fit worker.
    expect(await recorded(s, "h2")).toEqual(before);
    expect(before.run.state).toBe("accepted");
    expect(s.agents.count()).toBe(0);
  });

  it("after that failure a wake changes nothing, and starting the run's workflow again lets a fit worker drive it to its end", async () => {
    const s = await scheduled(FIX, { lock, controlHost: new FakeHost(FIT), workerHost: new FakeHost(BELOW) });
    await s.control.startRun({ pkg: s.pkg, workflow: "Fix", input: ISSUE, runId: "h3" });
    failedUnfit(await s.serve(() => ending(s, "h3", 12_000)));
    const handle = env.client.workflow.getHandle(workflowId("h3"));
    const failed = await handle.describe();
    // What every control call does after it records its decision: the closed workflow is not there to be woken.
    await s.driver.wake("h3");
    expect((await handle.describe()).runId).toBe(failed.runId);
    expect((await s.control.getRun("h3")).state).toBe("accepted");
    // A fit worker serves the queue now. The run's workflow is started again, as StartRun started it, and drives the run.
    const fit = new FakeHost(FIT);
    const done = await s.serve(async () => {
      await s.driver.start("h3");
      return s.driver.result("h3");
    }, fit);
    expect(done).toEqual({ runId: "h3", state: "succeeded", wakeInMs: null });
    expect((await handle.describe()).runId).not.toBe(failed.runId);
    expect(checks(fit)).toBe(1);
    expect(s.agents.count()).toBe(1);
  });

  it(`an unfit worker that would expire a decision is tried ${ATTEMPTS} times too and writes nothing; a fit worker expires it (R15)`, async () => {
    const tool = new SimTool("git.comment");
    // The worker's host is fit for the resume that opens the wait, and falls short from then on.
    const workerHost = new (class extends FakeHost {
      override async read(tool: HostTool): Promise<ToolReading> {
        const r = await super.read(tool);
        if (tool === "node") this.readings = BELOW;
        return r;
      }
    })(FIT);
    const s = await scheduled(NOTIFY, { lock, tools: [tool], clock: wallClock, controlHost: new FakeHost(FIT), workerHost });
    await s.control.startRun({ pkg: s.pkg, workflow: "Notify", input: ISSUE, runId: "h4", authorize: { "git.comment": { by: "human", role: "owner", deadlineMs: 1_000 } } });
    let before: Awaited<ReturnType<typeof recorded>> | undefined;
    const end = await s.serve(async () => {
      await stateOf(s, "h4", "waiting");
      // The next thing the workflow does is expire the wait, on the unfit host.
      before = await recorded(s, "h4");
      return ending(s, "h4", 12_000);
    });
    expect(checks(workerHost)).toBe(1 + ATTEMPTS);
    failedUnfit(end);
    // The decision did not expire on the unfit host: no wait_expired, the command still waits, the run as it was.
    expect(await recorded(s, "h4")).toEqual(before);
    expect(before?.commands).toContainEqual(expect.objectContaining({ state: "waiting" }));
    const done = await s.serve(async () => {
      await s.driver.start("h4");
      return s.driver.result("h4");
    }, new FakeHost(FIT));
    expect(done.state).toBe("failed");
    expect((await s.control.getRun("h4")).error).toEqual({ $tag: "Rejected", $args: ["approval_expired"] });
    expect((await s.control.journal.events("h4")).filter((e) => e.type === "wait_expired")).toHaveLength(1);
    expect(tool.executions).toHaveLength(0);
  });
});
