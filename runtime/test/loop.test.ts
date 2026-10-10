// Agent loops (Doc 4 §8.2; BACKLOG P1-7, K7–K9) against a scripted model and
// a simulated sandbox: journaled steps charged to the delegation, tools from
// capabilities, the progress checks (V11), schema repair, the steps limit,
// plan_execute (V16), recovery and replay.

import { afterAll, describe, expect, it } from "vitest";
import type { Value } from "../src/values.js";
import { MxcAdapter } from "../src/sandbox.js";
import { FULL_SANDBOX, SimChat, SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import type { TurnRequest } from "../src/adapters.js";
import { closeAll, commandIds, world, type World } from "./helpers.js";

const program = (agentExtra = "", budget = "{ tokens: 100k, spend: 1 USD, steps: 6 }") => `mandate @ 0.2

module loops @ 0.1

use std.{fs, model, exec}

capability RepoRead = fs.read("/work/repo")
capability SrcWrite = fs.write("/work/repo/src")
capability Build    = exec(commands: ["mvn"], args_prefix: [["-q", "test"]])
capability ModelStd = model.infer(tier: standard)

type Patch = { files: List<Path>, diff: Text }

agent Fixer {
  role   "Fixes the bug it is told about, only in src."
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget ${budget}
${agentExtra}
  skill apply(task: Text) -> Inferred<Patch> ! {Fs.Read, Fs.Write, Exec, Model}
}

agent Reader {
  role   "Reads, never writes."
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 4 }
  loop   plan_execute
  skill look(task: Text) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Fix(task: Text) -> Inferred<Patch>
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget { spend: 2 USD }
{
  delegate Fixer.apply(task)
}

workflow Look(task: Text) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { spend: 2 USD }
{
  delegate Reader.look(task)
}
`;

const PATCH = { files: ["src/a.ts"], diff: "-bug\n+fixed" };

interface Loop extends World {
  chat: SimChat;
  host: SimSandboxHost;
}

async function loopWorld(script: (req: TurnRequest, n: number) => SimTurn, o: { agentExtra?: string; budget?: string; host?: SimSandboxHost } = {}): Promise<Loop> {
  const w = await world(program(o.agentExtra, o.budget));
  const host = o.host ?? new SimSandboxHost();
  host.files.set("/work/repo/src/a.ts", "bug");
  host.files.set("/work/repo/src/b.ts", "other");
  host.files.set("/work/repo/README.md", "readme");
  host.programs["mvn"] = () => ({ stdout: "BUILD SUCCESS\n", stderr: "", exitCode: 0, timedOut: false });
  const chat = new SimChat(script);
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  return { ...w, chat, host };
}

const happy = (_req: TurnRequest, n: number): SimTurn =>
  [
    [toolUse("t1", "read_file", { path: "/work/repo/src/a.ts" })],
    [toolUse("t2", "write_file", { path: "src/a.ts", content: "fixed" }), toolUse("t3", "run", { command: "mvn", args: ["-q", "test"] })],
    [toolUse("t4", "finish", { result: PATCH })],
  ][n - 1]!;

/** The SkillFailed a run failed with. */
function skillFailed(error: Value): Record<string, Value> {
  const e = error as { $tag?: string; $args?: Array<Record<string, Value>> };
  expect(e.$tag).toBe("SkillFailed");
  return e.$args![0]!;
}

afterAll(closeAll);

describe("cancelling a run while its agent's process runs (§16.1 Stop)", () => {
  it("stops the sandbox at once rather than wait for the process's timeout, and the run ends cancelled", async () => {
    const w = await loopWorld(happy);
    // The test run hangs, as a test suite stuck on a lock would.
    let started = (): void => {};
    const begun = new Promise<void>((r) => (started = r));
    w.host.programs["mvn"] = (_req, _fs, handle) => {
      started();
      return w.host.untilStopped(handle);
    };
    w.adapters.loop!.stopPollMs = 5;
    const running = w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "fix a.ts" }, runId: "stop1" });
    await begun;
    await w.rt.cancelRun("stop1");
    const run = await running;
    expect(run.state).toBe("cancelled");
    expect(w.host.stopped).toEqual(["sbx-1"]);
    expect(w.host.open()).toEqual([]);
    expect(w.host.executions.at(-1)!.result).toMatchObject({ exitCode: 137, stopped: true });
    const events = await w.rt.journal.events("stop1");
    expect(events.find((e) => e.type === "sandbox_stopped")?.data).toEqual({ delegate: "/defs/Fix/body/0/value", agent: "Fixer", handle: "sbx-1", result: "stopped" });
    // No model turn after the stop: the next step was refused because the run is cancelled (R08).
    expect(w.chat.calls).toHaveLength(2);
  });
});

describe("an agent loop (§8.2, K7, K8)", () => {
  it("reads, writes and runs in its sandbox, finishes with a typed result, and journals every step", async () => {
    const w = await loopWorld(happy);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "fix a.ts" }, runId: "l1" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual(PATCH);
    expect(w.host.files.get("/work/repo/src/a.ts")).toBe("fixed");

    // The tools came from the grant, and the sandbox from the same grant, with no network (K7).
    expect(w.chat.calls[0]!.tools.map((t) => t.name)).toEqual(["read_file", "list_dir", "grep", "write_file", "run", "finish"]);
    // A named result type refers into $defs at the root of the finish tool's schema, where the reference resolves.
    expect(w.chat.calls[0]!.tools.at(-1)!.input_schema).toMatchObject({ properties: { result: { $ref: "#/$defs/Patch" } }, $defs: { Patch: { type: "object" } } });
    expect(w.host.created[0]!.policy).toMatchObject({
      filesystem: { readOnly: ["/work/repo"], readWrite: ["/work/repo/src"] },
      network: { allowOutbound: false, allowedHosts: [] },
      process: { allowedCommands: [{ command: "mvn", argsPrefix: [["-q", "test"]] }] },
    });
    expect(w.host.executions.map((x) => x.req.argv[0])).toEqual(["cat", "sh", "mvn"]);
    expect(w.host.open()).toEqual([]);

    const d = "/defs/Fix/body/0/value";
    expect(await commandIds(w, "l1", "turn")).toEqual([`${d}/step/0`, `${d}/step/1`, `${d}/step/2`]);
    expect(await commandIds(w, "l1", "tool")).toEqual([`${d}/step/0/tool/0`, `${d}/step/1/tool/0`, `${d}/step/1/tool/1`]);

    // Each turn was charged to the delegation's reservation and settled at once; nothing is left reserved.
    const report = await w.rt.budgetReport("l1");
    const turns = report.commands.filter((c) => c.kind === "turn");
    expect(turns.map((t) => t.cost)).toEqual([0, 1, 2].map(() => ({ tokens: 100, steps: 1, spend: { micros: 100, currency: "USD" } })));
    expect(turns.every((t) => Object.keys(t.reserved).length === 0)).toBe(true);
    expect(report.dimensions).toEqual([{ dimension: "spend:USD", limit: 2_000_000, settled: 300, reserved: 0, available: 1_999_700 }]);

    // Replay rebuilds the conversation from the journal and calls neither the model nor the sandbox.
    expect(await w.rt.replayRun("l1")).toEqual({ status: "complete", value: PATCH });
    expect(w.chat.calls).toHaveLength(3);
    expect(w.host.executions).toHaveLength(3);
  });

  it("refuses a call outside its grant without running it, and the model goes on", async () => {
    const w = await loopWorld((_r, n) =>
      n === 1 ? [toolUse("t1", "write_file", { path: "/work/repo/test/x.ts", content: "x" }), toolUse("t2", "run", { command: "rm", args: ["-rf", "/"] })] : [toolUse("t3", "finish", { result: PATCH })],
    );
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l2" });
    expect(run.state).toBe("succeeded");
    expect(w.host.executions).toHaveLength(0);
    const answer = JSON.stringify(w.chat.calls[1]!.messages.at(-1));
    expect(answer).toContain("outside what you may write");
    expect(answer).toContain("rm is not a command you may run");
  });

  it("V11: the same call three times in the window stops the loop with Stuck before running it again", async () => {
    const w = await loopWorld((_r, n) => [toolUse(`t${n}`, "read_file", { path: "/work/repo/src/a.ts" })]);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l3" });
    expect(run.state).toBe("failed");
    expect(skillFailed(run.error!)).toMatchObject({ kind: "Stuck", partial: { written: [] } });
    expect(w.host.executions).toHaveLength(2);
    expect(w.chat.calls).toHaveLength(3);
  });

  it("stops with Stuck after `stall` turns that observed nothing new", async () => {
    const files = ["/work/repo/src/a.ts", "/work/repo/src/b.ts"];
    const w = await loopWorld((_r, n) => [toolUse(`t${n}`, "read_file", { path: files[(n - 1) % 2]! })], { agentExtra: "  progress { window: 8, repeats: 8, stall: 3 }" });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l4" });
    expect(skillFailed(run.error!)).toMatchObject({ kind: "Stuck", detail: "3 turns in a row observed nothing new" });
    expect(w.host.executions).toHaveLength(5);
  });

  it("gives a result that does not fit back to the model to repair, at most twice", async () => {
    const bad = [toolUse("x", "finish", { result: { files: "src/a.ts" } })];
    const repaired = await loopWorld((_r, n) => (n < 3 ? bad : [toolUse("t", "finish", { result: PATCH })]));
    const ok = await repaired.rt.startRun({ pkg: repaired.pkg, workflow: "Fix", input: { task: "t" }, runId: "l5" });
    expect(ok.result).toEqual(PATCH);
    expect(JSON.stringify(repaired.chat.calls[1]!.messages.at(-1))).toContain("does not fit the schema");

    const never = await loopWorld(() => bad);
    const failed = await never.rt.startRun({ pkg: never.pkg, workflow: "Fix", input: { task: "t" }, runId: "l6" });
    expect(skillFailed(failed.error!)).toMatchObject({ kind: "SchemaMismatch" });
    expect(never.chat.calls).toHaveLength(3);
  });

  it("G14: does not take a result whose Path leaves the working copy; the model is asked again", async () => {
    const outside = [toolUse("x", "finish", { result: { files: ["src/a.ts", "../../outside/a.ts"], diff: "-bug\n+fixed" } })];
    const w = await loopWorld((_r, n) => (n === 1 ? outside : [toolUse("t", "finish", { result: PATCH })]));
    // The finish tool's schema tells the model the rule before it answers.
    const finish = w.chat;
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l14" });
    expect(run.result).toEqual(PATCH);
    expect(JSON.stringify(finish.calls[0]!.tools.find((t) => t.name === "finish"))).toContain('"pattern"');
    expect(JSON.stringify(finish.calls[1]!.messages.at(-1))).toContain("/files/1 is not a Path: a path relative to the repository root");
  });

  it("stops with StepLimit when the agent's steps cannot cover another turn, and keeps what it wrote", async () => {
    const w = await loopWorld(
      (_r, n) => [toolUse(`t${n}`, "write_file", { path: `src/f${n}.ts`, content: String(n) })],
      { budget: "{ tokens: 100k, spend: 1 USD, steps: 2 }" },
    );
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l7" });
    expect(skillFailed(run.error!)).toMatchObject({ kind: "StepLimit", partial: { written: ["/work/repo/src/f1.ts", "/work/repo/src/f2.ts"] } });
    expect(w.chat.calls).toHaveLength(2);
    expect((await w.rt.budgetReport("l7")).dimensions[0]).toMatchObject({ settled: 200, reserved: 0 });
  });

  it("never starts a model or a tool when the host cannot enforce the sandbox (G05)", async () => {
    const w = await loopWorld(happy, { host: new SimSandboxHost({ ...FULL_SANDBOX, exec: "none" }) });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l8" });
    expect(run.error).toMatchObject({ $tag: "PolicyDenied", $args: [{ reason: "unsupported_sandbox_profile", unsupported: ["a command allow-list"] }] });
    expect(w.chat.calls).toHaveLength(0);
    expect(w.host.created).toHaveLength(0);
  });

  it("resumes after a crash without sending a recorded step again or charging it twice", async () => {
    const w = await loopWorld(happy);
    w.faults.arm("after_record", (i) => i.id.endsWith("/step/1/tool/0"));
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "l9" })).rejects.toThrow(/after_record/);
    const done = await w.rt.resume("l9");
    expect(done.state).toBe("succeeded");
    expect(w.chat.calls).toHaveLength(3);
    expect(w.host.executions).toHaveLength(3);
    expect((await w.rt.budgetReport("l9")).dimensions[0]).toMatchObject({ settled: 300, reserved: 0 });
  });
});

describe("plan_execute (§8.2)", () => {
  it("V16: a plan with a tool the agent does not have is never run", async () => {
    const plan = [toolUse("p", "submit_plan", { steps: [{ tool: "read_file", input: { path: "/work/repo/README.md" } }, { tool: "write_file", input: { path: "/work/repo/x", content: "x" } }] })];
    const w = await loopWorld(() => plan);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Look", input: { task: "t" }, runId: "p1" });
    expect(skillFailed(run.error!)).toMatchObject({ kind: "InvalidTool" });
    expect(w.host.executions).toHaveLength(0);
    expect(w.chat.calls).toHaveLength(3);
    expect(w.chat.calls[0]!.tools.map((t) => t.name)).toEqual(["submit_plan"]);
    expect(JSON.stringify(w.chat.calls[1]!.messages.at(-1))).toContain("there is no tool \\\"write_file\\\"");
  });

  it("runs a checked plan, shows the results, and takes the result from finish", async () => {
    const w = await loopWorld((_r, n) =>
      n === 1 ? [toolUse("p", "submit_plan", { steps: [{ tool: "read_file", input: { path: "/work/repo/README.md" } }, { tool: "grep", input: { pattern: "bug", path: "/work/repo/src" } }] })] : [toolUse("f", "finish", { result: "a.ts has the bug" })],
    );
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Look", input: { task: "t" }, runId: "p2" });
    expect(run.result).toBe("a.ts has the bug");
    expect(w.host.executions.map((x) => x.req.argv[0])).toEqual(["cat", "grep"]);
    expect(await commandIds(w, "p2", "tool")).toEqual(["/defs/Look/body/0/value/plan/0", "/defs/Look/body/0/value/plan/1"]);
    expect(JSON.stringify(w.chat.calls[1]!.messages.at(-1))).toContain("/work/repo/src/a.ts:1:bug");
    expect(w.chat.calls[1]!.tools.map((t) => t.name)).toEqual(["finish"]);
  });
});

describe("agent loops in par (§8.7 fail_fast, §8.6)", () => {
  const PAR = `mandate @ 0.2

module loops.parallel @ 0.1

use std.{fs, model, human}

capability RepoRead  = fs.read("/work/repo")
capability SrcWrite  = fs.write("/work/repo/src")
capability TestWrite = fs.write("/work/repo/test")
capability ModelStd  = model.infer(tier: standard)

agent Fixer {
  caps   RepoRead, SrcWrite, ModelStd
  budget { spend: 1 USD, steps: 6 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

agent Tester {
  caps   RepoRead, TestWrite, ModelStd
  budget { spend: 1 USD, steps: 6 }
  skill write(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Model}
}

workflow Both(task: Text) -> Inferred<Text>
  caps   RepoRead, SrcWrite, TestWrite, ModelStd
  budget { spend: 3 USD }
{
  par {
    fix  = delegate Fixer.apply(task)
    test = delegate Tester.write(task)
  }
  fix
}

on budget_exceeded in Both => pause and human.ask("Budget exceeded. Continue or cancel?")
`;

  it("a sibling over the budget pauses the run for a person, and after a raise the stopped loop resumes from the journal", async () => {
    const w = await world(PAR);
    const host = new SimSandboxHost();
    host.files.set("/work/repo/src/a.ts", "bug");
    const chat = new SimChat((req, n) => {
      const fixer = req.system.startsWith("You are Fixer,");
      const turn = req.messages.filter((m) => (m as { role?: string }).role === "assistant").length;
      if (fixer) return turn === 0 ? [toolUse(`f${n}`, "read_file", { path: "/work/repo/src/a.ts" })] : [toolUse(`f${n}`, "finish", { result: "fixed" })];
      return [toolUse(`t${n}`, "finish", { result: "tested" })];
    });
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };

    // 1.5 USD covers one agent's 1 USD budget, not both: the second reservation does not fit.
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Both", input: { task: "t" }, runId: "par1", limits: { spend: { micros: 1_500_000, currency: "USD" } } });
    expect(run.state).toBe("waiting");
    expect(run.waiting).toMatchObject({ kind: "budget_exceeded", detail: { $tag: "BudgetExceeded" } });
    const fixer = (await w.rt.journal.command("par1", "/defs/Both/body/0/branches/fix"))!;
    expect(fixer.state).toBe("dispatched");

    const raised = await w.rt.raiseLimits("par1", { sender: "erin", messageId: "r1" }, { revision: run.revision, limits: { spend: { micros: 3_000_000, currency: "USD" } }, by: "erin" });
    const ask = run.waiting as { command: string };
    const done = await w.rt.submitInput("par1", { sender: "erin", messageId: "a1" }, { commandId: ask.command, revision: raised.revision, value: "continue" });
    expect(done.state, JSON.stringify(done.error ?? done.attention)).toBe("succeeded");
    expect(done.result).toBe("fixed");
    // Each recorded step ran once: the Fixer's first turn and read were not sent again after the raise.
    expect(host.executions).toHaveLength(1);
    expect(chat.calls.filter((c) => c.system.startsWith("You are Fixer,"))).toHaveLength(2);
    const report = await w.rt.budgetReport("par1");
    expect(report.dimensions[0]).toMatchObject({ limit: 3_000_000, reserved: 0 });
  });
});
