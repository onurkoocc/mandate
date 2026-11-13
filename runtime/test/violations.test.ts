// Violations (spec/boundary.md "Violations and halt"; G21, INV-28): an agent's tool call refused for an authority
// reason is a `violation` event, written once per step and counted; a run that reaches its limit stops as
// attention_required with `violation_limit`, and a resumed run stops again only at its next new violation.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { readConfig, runtimeOptions, type RuntimeConfig } from "../src/control.js";
import { Runtime, VIOLATION_LIMIT, type RuntimeOptions } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { FULL_SANDBOX, SimChat, SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { closeAll, world, type World } from "./helpers.js";

const program = (version: string) => `mandate @ ${version}

module guarded @ 0.1

use std.{fs, model, exec}

capability RepoRead = fs.read("/work/repo")
capability SrcWrite = fs.write("/work/repo/src")
capability Build    = exec(commands: ["mvn"], args_prefix: [["-q", "test"]])
capability ModelStd = model.infer(tier: standard)

agent Fixer {
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 12 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Exec, Model}
}

agent Reader {
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 6 }
  loop   plan_execute
  skill look(task: Text) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Fix(task: Text) -> Inferred<Text>
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

const D = "/defs/Fix/body/0/value";

interface Guarded extends World {
  chat: SimChat;
  host: SimSandboxHost;
}

/** A run of `version` whose model answers turn n with `script(n)`, on a runtime with `options`. */
async function guarded(version: string, script: (n: number) => SimTurn, options: RuntimeOptions = {}, host = new SimSandboxHost()): Promise<Guarded> {
  // A 0.4 or later package takes signed decisions; these runs ask none.
  const w = await world(program(version), version >= "0.4" ? { decisions: { mode: "signed" } } : {});
  host.files.set("/work/repo/src/a.ts", "bug");
  const chat = new SimChat((_req: TurnRequest, n: number) => script(n));
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  const rt = new Runtime(w.db, w.adapters, w.faults, undefined, { decisions: version >= "0.4" ? { mode: "signed" } : { mode: "unsigned" }, ...options });
  return { ...w, rt, chat, host };
}

const outside = (n: number): Value[] => [toolUse(`t${n}`, "read_file", { path: `/etc/secret-${n}` })];
const finish = (n: number): Value[] => [toolUse(`f${n}`, "finish", { result: "done" })];

async function violations(w: World, runId: string): Promise<Value[]> {
  return (await w.rt.journal.events(runId)).filter((e) => e.type === "violation").map((e) => e.data);
}

afterAll(closeAll);

describe("a violation (spec/boundary.md \"Violations and halt\")", () => {
  it("is written for a tool call refused for an authority reason, with its kind, delegate, agent, step, detail and the run's count", async () => {
    const w = await guarded("0.5", (n) => (n === 1 ? [toolUse("a", "write_file", { path: "/work/repo/README.md", content: "x" }), toolUse("b", "run", { command: "rm", args: ["-rf", "/"] })] : finish(n)));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "v1" });
    expect(run.state).toBe("succeeded");
    expect(await violations(w, "v1")).toEqual([
      { kind: "authority_denied", delegate: D, agent: "Fixer", step: `${D}/step/0/tool/0`, detail: "write_file: /work/repo/README.md is outside what you may write (/work/repo/src)", count: 1 },
      { kind: "authority_denied", delegate: D, agent: "Fixer", step: `${D}/step/0/tool/1`, detail: "run: rm is not a command you may run (mvn)", count: 2 },
    ]);
    // The model is told what it was told before; the journal of a run with violations still verifies.
    expect(JSON.stringify(w.chat.calls[1]!.messages.at(-1))).toContain("outside what you may write");
    expect((await w.rt.verifyJournal("v1")).status).toBe("verified");
    expect(await w.rt.replayRun("v1")).toEqual({ status: "complete", value: "done" });
  });

  it("is written for the packages of every language version, and does not stop an earlier one's run unless a limit is configured", async () => {
    const w = await guarded("0.2", (n) => (n <= 2 ? outside(n) : finish(n)));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "v2" });
    expect(run.state).toBe("succeeded");
    expect((await violations(w, "v2")).map((v) => (v as { count: number }).count)).toEqual([1, 2]);
  });

  it("is not written for malformed input, which is only repaired", async () => {
    const w = await guarded("0.5", (n) => (n === 1 ? [toolUse("a", "read_file", { path: "" })] : finish(n)));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "v3" });
    expect(run.state).toBe("succeeded");
    expect(JSON.stringify(w.chat.calls[1]!.messages.at(-1))).toContain("path must be a non-empty string");
    expect(await violations(w, "v3")).toEqual([]);
  });

  it("is not written for the interpreter's PolicyDenied: that is the program's error, not the agent's attempt", async () => {
    const w = await guarded("0.5", finish, {}, new SimSandboxHost({ ...FULL_SANDBOX, exec: "none" }));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "v4" });
    expect(run.error).toMatchObject({ $tag: "PolicyDenied", $args: [{ reason: "unsupported_sandbox_profile" }] });
    expect(await violations(w, "v4")).toEqual([]);
  });

  it("is written for a step of a submitted plan outside the grant, though the plan never runs", async () => {
    const plan = [toolUse("p", "submit_plan", { steps: [{ tool: "read_file", input: { path: "/work/repo/src/a.ts" } }, { tool: "read_file", input: { path: "/etc/passwd" } }] })];
    const good = [toolUse("p2", "submit_plan", { steps: [{ tool: "read_file", input: { path: "/work/repo/src/a.ts" } }] })];
    const w = await guarded("0.5", (n) => (n === 1 ? plan : n === 2 ? good : finish(n)));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Look", input: { task: "t" }, runId: "v5" });
    expect(run.state).toBe("succeeded");
    // The rejected plan ran nothing; the second ran its one step.
    expect(w.host.executions.map((x) => x.req.argv)).toEqual([["cat", "--", "/work/repo/src/a.ts"]]);
    const L = "/defs/Look/body/0/value";
    expect(await violations(w, "v5")).toEqual([{ kind: "authority_denied", delegate: L, agent: "Reader", step: `${L}/step/0/plan/1`, detail: "read_file: /etc/passwd is outside what you may read (/work/repo)", count: 1 }]);
  });
});

describe("violations.limit in mandate.runtime.json", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-violations-config-"));
  const config = (violations?: unknown): RuntimeConfig => {
    writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db", ...(violations === undefined ? {} : { violations }) }));
    return readConfig(join(dir, "mandate.runtime.json"));
  };

  it("is the runtime's limit when the file says, and none otherwise", async () => {
    const w = await world(program("0.2"));
    expect(runtimeOptions(config({ limit: 5 }), w.db).violations).toEqual({ limit: 5 });
    expect(runtimeOptions(config(), w.db).violations).toBeUndefined();
    expect(runtimeOptions(config({}), w.db).violations).toBeUndefined();
    expect(VIOLATION_LIMIT).toBe(3);
  });

  it("is a whole number, at least 1, and the only field of its section", () => {
    for (const bad of [0, -1, "3", true]) expect(() => config({ limit: bad })).toThrow(/"violations.limit" is a whole number of violations/);
    expect(() => config(3)).toThrow(/"violations" is \{ "limit": n \}/);
    expect(() => config({ limit: 3, window: 2 })).toThrow(/unknown field violations.window/);
  });
});

describe("the violation limit (G21)", () => {
  it("stops a 0.5 package's run at its third violation by default, as attention_required with violation_limit", async () => {
    const w = await guarded("0.5", outside);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "lim1" });
    expect(run.state).toBe("attention_required");
    expect(run.attention).toMatchObject({ violation: "violation_limit" });
    expect((await violations(w, "lim1")).map((v) => (v as { count: number }).count)).toEqual([1, 2, 3]);
    expect(w.chat.calls).toHaveLength(3);
    expect((await w.rt.verifyJournal("lim1")).status).toBe("verified");
  });

  it("applies to an earlier package's run when the configuration sets it", async () => {
    const unset = await guarded("0.2", outside);
    // Without a limit, a third refusal is the loop's third repair: the delegation fails as it did before 0.5.
    const failed = await unset.rt.startRun({ pkg: unset.pkg, workflow: "Fix", input: { task: "t" }, runId: "lim2" });
    expect(failed.state).toBe("failed");
    expect(failed.error).toMatchObject({ $tag: "SkillFailed", $args: [{ kind: "InvalidArguments" }] });
    expect(await violations(unset, "lim2")).toHaveLength(3);

    const set = await guarded("0.2", outside, { violations: { limit: 2 } });
    const stopped = await set.rt.startRun({ pkg: set.pkg, workflow: "Fix", input: { task: "t" }, runId: "lim3" });
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "violation_limit" });
    expect(await violations(set, "lim3")).toHaveLength(2);
  });

  it("takes the configured limit for a 0.5 package too", async () => {
    const w = await guarded("0.5", (n) => (n === 1 ? outside(n) : finish(n)), { violations: { limit: 1 } });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "lim4" });
    expect(run.attention).toMatchObject({ violation: "violation_limit" });
    expect(await violations(w, "lim4")).toHaveLength(1);
  });

  it("INV-28: a resumed run does not write or count a violation again, and goes on when it makes no new one", async () => {
    const w = await guarded("0.5", (n) => (n <= 2 ? outside(n) : finish(n)), { violations: { limit: 2 } });
    const stopped = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "res1" });
    expect(stopped.attention).toMatchObject({ violation: "violation_limit" });
    const resumed = await w.rt.resume("res1");
    expect(resumed.state).toBe("succeeded");
    expect((await violations(w, "res1")).map((v) => (v as { count: number }).count)).toEqual([1, 2]);
    // The two turns were taken from the journal; only the third went to the model.
    expect(w.chat.calls).toHaveLength(3);
    expect(await w.rt.replayRun("res1")).toEqual({ status: "complete", value: "done" });
    expect((await violations(w, "res1")).map((v) => (v as { count: number }).count)).toEqual([1, 2]);
  });

  it("stops a resumed run again at its next new violation", async () => {
    const w = await guarded("0.5", (n) => (n <= 3 ? outside(n) : finish(n)), { violations: { limit: 2 } });
    await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "res2" });
    const again = await w.rt.resume("res2");
    expect(again.state).toBe("attention_required");
    expect(again.attention).toMatchObject({ violation: "violation_limit" });
    expect((await violations(w, "res2")).map((v) => [(v as { step: string }).step, (v as { count: number }).count])).toEqual([
      [`${D}/step/0/tool/0`, 1],
      [`${D}/step/1/tool/0`, 2],
      [`${D}/step/2/tool/0`, 3],
    ]);
  });
});
