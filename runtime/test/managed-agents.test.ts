// The Claude Managed Agents executor (BACKLOG item 39; design doc 10, Form A;
// K45–K47, K79, K80) against a fake of the service: deploy writes the binding
// into the lock, ValidateBinding refuses a binding that no longer holds, and
// a bound agent's loop runs its turns in a session per delegation while every
// tool runs in the runtime's own sandbox (the bridge). Replay calls neither
// the service nor the sandbox.

import { check, type Lock, type ManagedAgentsBinding, type Program } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { DEFAULT_HARNESS_TOKENS, deployManagedAgents, inlineRefs, managedAgentsExecutor, ManagedAgentsChat } from "../src/managed-agents.js";
import { buildPackage } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimChat, SimSandboxHost, toolUse } from "../src/sim.js";
import type { Value } from "../src/values.js";
import { FakeManagedAgents, type FakeTurn } from "./fake-managed-agents.js";
import { closeAll, commandIds, world, type World } from "./helpers.js";

const SRC = (maxClass = "") => `mandate @ 0.3

module bridge @ 0.1

use std.{fs, model, exec}

capability RepoRead = fs.read("/work/repo")
capability SrcWrite = fs.write("/work/repo/src")
capability Build    = exec(commands: ["mvn"], args_prefix: [["-q", "test"]])
capability ModelStd = model.infer(tier: standard${maxClass})

type Patch = { files: List<Path>, diff: Text }

agent Fixer {
  role   "Fixes the bug it is told about, only in src."
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget { tokens: 2M, spend: 20 USD, steps: 6 }
  skill apply(task: Text) -> Inferred<Patch> ! {Fs.Read, Fs.Write, Exec, Model}
}

workflow Fix(task: Text) -> Inferred<Patch>
  caps   RepoRead, SrcWrite, Build, ModelStd
  budget { spend: 30 USD }
{
  delegate Fixer.apply(task)
}
`;

const MODEL_LOCK: Lock = {
  modules: {},
  models: { standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", max_input_tokens: 100_000, max_output_tokens: 128_000 } },
  tariffs: { "claude-opus-5-5": { currency: "USD", as_of: "2026-10-10", micros_per_mtok: { input: 4_000_000, output: 20_000_000, cache_read: 200_000, cache_write: 5_000_000 } } },
};

const PATCH = { files: ["src/a.ts"], diff: "-bug\n+fixed" };

const happy = (_m: Value[], n: number): FakeTurn =>
  [
    [{ type: "text", text: "Reading the file." }, toolUse("x", "read_file", { path: "/work/repo/src/a.ts" })],
    [toolUse("x", "write_file", { path: "src/a.ts", content: "fixed" }), toolUse("y", "grep", { pattern: "fixed", path: "/work/repo/src" })],
    [toolUse("x", "finish", { result: PATCH })],
  ][n - 1]!;

function program(src = SRC()): Program {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.program!;
}

interface Bridge extends World {
  fake: FakeManagedAgents;
  host: SimSandboxHost;
  local: SimChat;
  binding: ManagedAgentsBinding;
  lock: Lock;
}

async function bridgeWorld(script: (m: Value[], n: number) => FakeTurn = happy, o: { executor?: boolean; mutate?: (fake: FakeManagedAgents, b: ManagedAgentsBinding) => void } = {}): Promise<Bridge> {
  const fake = new FakeManagedAgents(script);
  const binding = await deployManagedAgents({ program: program(), lock: MODEL_LOCK, api: fake, now: () => 0 });
  const lock: Lock = { ...MODEL_LOCK, bindings: { "managed-agents": binding } };
  o.mutate?.(fake, binding);
  const w = await world(SRC(), { lock });
  const host = new SimSandboxHost();
  host.files.set("/work/repo/src/a.ts", "bug");
  host.programs["mvn"] = () => ({ stdout: "BUILD SUCCESS\n", stderr: "", exitCode: 0, timedOut: false });
  const local = new SimChat(() => {
    throw new Error("a bound agent never talks to the local model");
  });
  w.adapters.loop = {
    chat: local,
    sandbox: new MxcAdapter({ host, schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }),
    ...(o.executor === false ? {} : { executor: managedAgentsExecutor({ binding, lock, api: fake, pollMs: 1, title: "test" }) }),
  };
  return { ...w, fake, host, local, binding, lock };
}

afterAll(closeAll);

describe("mandate deploy --target managed-agents (K45)", () => {
  it("deploys one agent per Mandate agent with the lock's model and effort and no tools of its own, and an environment with no network", async () => {
    const fake = new FakeManagedAgents(happy);
    const b = await deployManagedAgents({ program: program(), lock: MODEL_LOCK, api: fake, now: () => 0 });
    expect(b).toMatchObject({ format: "mandate/binding/managed-agents/0.1", beta: "managed-agents-2026-04-01", tools: "bridge", session_fee: { currency: "USD", micros_per_hour: 80_000 }, harness_tokens: DEFAULT_HARNESS_TOKENS });
    expect(b.agents["Fixer"]).toMatchObject({ version: 1, tier: "standard", model: "claude-opus-5-5", effort: "high", max_output_tokens: 128_000 });
    const [agent] = fake.agents.get(b.agents["Fixer"]!.id)!;
    expect(agent).toMatchObject({ model: { id: "claude-opus-5-5", effort: "high" }, tools: [], mcp_servers: [], skills: [], multiagent: null });
    expect(fake.environments.get(b.environment.id)!.config).toMatchObject({ type: "cloud", networking: { type: "limited", allowed_hosts: [], allow_package_managers: false, allow_mcp_servers: false } });
    // With the binding in it, the lock still checks clean against the program.
    const lock = { lock: "mandate/lock/0.3" as const, ...MODEL_LOCK, bindings: { "managed-agents": b } };
    expect(check(SRC(), "mdt", { lock }).diagnostics).toEqual([]);

    // Deploying again updates the same agent: its id stays, its version moves on.
    const again = await deployManagedAgents({ program: program(), lock, api: fake });
    expect(again.agents["Fixer"]).toMatchObject({ id: b.agents["Fixer"]!.id, version: 2 });
    expect(again.environment.id).toBe(b.environment.id);
  });

  it("refuses before creating anything when the lock's output limit is below the model's ceiling (E0904, K80)", async () => {
    const fake = new FakeManagedAgents(happy);
    const low: Lock = { ...MODEL_LOCK, models: { standard: { ...MODEL_LOCK.models!["standard"]!, max_output_tokens: 32_000 } } };
    await expect(deployManagedAgents({ program: program(), lock: low, api: fake })).rejects.toThrow(/MDT-E0904/);
    expect(fake.calls.filter((c) => c.endsWith(".create"))).toEqual([]);
  });

  it("refuses an agent that may send confidential data to its model (E0905, K46)", async () => {
    const fake = new FakeManagedAgents(happy);
    const src = SRC(", max_class: confidential");
    await expect(deployManagedAgents({ program: program(src), lock: MODEL_LOCK, api: fake })).rejects.toThrow(/MDT-E0905/);
    expect(fake.calls.filter((c) => c.endsWith(".create"))).toEqual([]);
  });
});

describe("a bound agent's loop through the bridge (K79)", () => {
  it("runs each turn in the delegation's session and each tool in the runtime's sandbox, journals both, and replays without the service", async () => {
    const w = await bridgeWorld();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "fix a.ts" }, runId: "ma1" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toEqual(PATCH);
    expect(w.host.files.get("/work/repo/src/a.ts")).toBe("fixed");
    expect(w.local.calls).toHaveLength(0);

    // One session, pinned to the deployed version, with the delegation's prompt and tools as custom tools.
    expect(w.fake.sessions.size).toBe(1);
    const [s] = [...w.fake.sessions.values()];
    const agent = s!.body["agent"] as Record<string, unknown>;
    expect(agent).toMatchObject({ type: "agent_with_overrides", id: w.binding.agents["Fixer"]!.id, version: 1 });
    expect(agent["system"]).toContain("You are Fixer");
    // `grep` is a built-in tool's name on the service, so it travels as mandate_grep; the loop sees grep.
    expect((agent["tools"] as Array<{ name: string; type: string }>).map((t) => `${t.type}:${t.name}`)).toEqual(["custom:read_file", "custom:list_dir", "custom:mandate_grep", "custom:write_file", "custom:run", "custom:finish"]);
    // The service takes no $ref in a tool schema (seen live): the result type is written out in place.
    const finish = (agent["tools"] as Array<{ name: string; input_schema: unknown }>).find((t) => t.name === "finish")!;
    expect(JSON.stringify(finish.input_schema)).not.toContain("$ref");
    expect(finish.input_schema).toMatchObject({ properties: { result: { type: "object", properties: { files: { type: "array" }, diff: { type: "string" } } } } });
    expect(s!.body["budget"]).toEqual({ type: "limit", max_list_cost: { amount: "2000", currency: "USD" } });
    expect(s!.archived).toBe(true);
    expect(w.host.executions.map((x) => x.req.argv[0])).toEqual(["cat", "sh", "grep"]);

    const d = "/defs/Fix/body/0/value";
    expect(await commandIds(w, "ma1", "session")).toEqual([`${d}/session`, `${d}/session/close`]);
    expect(await commandIds(w, "ma1", "turn")).toEqual([`${d}/step/0`, `${d}/step/1`, `${d}/step/2`]);
    expect(await commandIds(w, "ma1", "tool")).toEqual([`${d}/step/0/tool/0`, `${d}/step/1/tool/0`, `${d}/step/1/tool/1`]);

    // A turn is priced from the session's model usage at the lock's tariff, plus two seconds of running time.
    const report = await w.rt.budgetReport("ma1");
    const turns = report.commands.filter((c) => c.kind === "turn");
    const perTurn = Math.ceil((1000 * 4_000_000 + 200 * 20_000_000) / 1_000_000) + Math.ceil((2000 * 80_000) / 3_600_000);
    expect(turns.map((t) => t.cost)).toEqual([0, 1, 2].map(() => ({ tokens: 1200, steps: 1, spend: { micros: perTurn, currency: "USD" } })));
    expect(turns.every((t) => Object.keys(t.reserved).length === 0)).toBe(true);

    const calls = w.fake.calls.length;
    expect(await w.rt.replayRun("ma1")).toEqual({ status: "complete", value: PATCH });
    expect(w.fake.calls).toHaveLength(calls);
    expect(w.host.executions).toHaveLength(3);
  });

  it("keeps the loop's own checks: the same call three times stops it with Stuck, and the session is closed", async () => {
    const w = await bridgeWorld(() => [toolUse("x", "read_file", { path: "/work/repo/src/a.ts" })]);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "ma2" });
    expect(run.state).toBe("failed");
    expect(run.error).toMatchObject({ $tag: "SkillFailed", $args: [{ kind: "Stuck" }] });
    expect(w.host.executions).toHaveLength(2);
    expect([...w.fake.sessions.values()][0]!.archived).toBe(true);
  });

  it("refuses a call outside the grant without running it, as a local loop does", async () => {
    const w = await bridgeWorld((_m, n) => (n === 1 ? [toolUse("x", "write_file", { path: "/work/repo/test/x.ts", content: "x" })] : [toolUse("x", "finish", { result: PATCH })]));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "ma3" });
    expect(run.state).toBe("succeeded");
    expect(w.host.executions).toHaveLength(0);
    const answered = w.fake.sent.flatMap((s) => s.events).find((e) => e["type"] === "user.custom_tool_result")!;
    expect(answered).toMatchObject({ is_error: true });
    expect(JSON.stringify(answered["content"])).toContain("outside what you may write");
  });

  it("a session at its spend cap ends the skill with StepLimit", async () => {
    const w = await bridgeWorld((_m, n) => (n === 1 ? [toolUse("x", "read_file", { path: "/work/repo/src/a.ts" })] : "budget_reached"));
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "ma4" });
    expect(run.error).toMatchObject({ $tag: "SkillFailed", $args: [{ kind: "StepLimit" }] });
  });

  it("cancelling the run interrupts the session's running turn, and no step follows (R08)", async () => {
    const w = await bridgeWorld((_m, n) => (n === 1 ? [toolUse("x", "read_file", { path: "/work/repo/src/a.ts" })] : "hang"));
    const running = w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "ma5" });
    const s = (): { turns: number } | undefined => [...w.fake.sessions.values()][0];
    while ((s()?.turns ?? 0) < 2) await new Promise((r) => setTimeout(r, 2));
    await w.rt.cancelRun("ma5");
    const run = await running;
    expect(run.state).toBe("cancelled");
    expect(w.fake.sent.flatMap((x) => x.events).map((e) => e["type"])).toContain("user.interrupt");
    expect(s()!.turns).toBe(2);
  });
});

describe("ValidateBinding (§16.1, design doc 10 §3.1)", () => {
  it("does not start a run whose deployed agent changed since the binding was written", async () => {
    const w = await bridgeWorld(happy, { mutate: (fake, b) => fake.tamper(b.agents["Fixer"]!.id, 1, { tools: [{ type: "agent_toolset_20260401" }] }) });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "mv1" })).rejects.toThrow(/unsupported_binding|not configured as deployed/);
    expect(w.fake.sessions.size).toBe(0);
  });

  it("does not start a run whose environment changed (environments are not versioned)", async () => {
    const w = await bridgeWorld(happy, { mutate: (fake, b) => (fake.environments.get(b.environment.id)!.config = { type: "cloud", networking: { type: "unrestricted" } }) });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "mv2" })).rejects.toThrow(/environment .* is not configured as deployed/);
  });

  it("never runs a bound agent elsewhere: a runtime without the executor does not start the run (INV-11)", async () => {
    const w = await bridgeWorld(happy, { executor: false });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "mv3" })).rejects.toThrow(/no Managed Agents executor/);
    expect(w.local.calls).toHaveLength(0);
  });

  it("refuses at load a package whose binding no longer fits its lock (E0903)", async () => {
    const w = await bridgeWorld();
    const lock: Lock = { ...w.lock, models: { standard: { ...w.lock.models!["standard"]!, effort: "max" } } };
    const pkg = buildPackage(w.pkg.program, lock);
    await expect(w.rt.startRun({ pkg, workflow: "Fix", input: { task: "t" }, runId: "mv4" })).rejects.toThrow(/MDT-E0903/);
  });
});

describe("tool schemas on the service", () => {
  it("writes references into $defs out in place, and refuses a recursive type by name", () => {
    const tree = { type: "object", properties: { result: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { kids: { type: "array", items: { $ref: "#/$defs/Node" } } } } } };
    expect(() => inlineRefs(tree as unknown as Value)).toThrow(/Node is recursive/);
    const flat = { type: "object", properties: { a: { $ref: "#/$defs/A" }, b: { $ref: "#/$defs/A" } }, $defs: { A: { type: "string", minLength: 1 } } };
    expect(inlineRefs(flat as unknown as Value)).toEqual({ type: "object", properties: { a: { type: "string", minLength: 1 }, b: { type: "string", minLength: 1 } } });
  });
});

describe("a turn re-run after a crash", () => {
  it("finds its message already in the session and waits for the answer instead of sending it twice", async () => {
    const fake = new FakeManagedAgents(happy);
    const binding = await deployManagedAgents({ program: program(), lock: MODEL_LOCK, api: fake });
    const lock: Lock = { ...MODEL_LOCK, bindings: { "managed-agents": binding } };
    const chat = new ManagedAgentsChat({ binding, lock, api: fake, pollMs: 1 }, "Fixer");
    const opened = await chat.open({ agent: "Fixer", skill: "apply", tier: "standard", system: "s", tools: [{ name: "read_file", description: "d", input_schema: { type: "object" } }], commandId: "c" });
    const session = (opened as { ok: Value }).ok;
    const req: TurnRequest = { tier: "standard", system: "s", tools: [], messages: [{ role: "user", content: [{ type: "text", text: "go" }] }], commandId: "c/step/0", session };
    const first = await chat.turn(req);
    const again = await chat.turn(req);
    expect(again).toEqual(first);
    expect(fake.sent.flatMap((s) => s.events).filter((e) => e["type"] === "user.message")).toHaveLength(1);
  });
});
