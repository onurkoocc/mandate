// Agents run in sandboxes built from their delegation's grant (Doc 4 §7.3,
// §7.5, §11.3, §16.1). A host that cannot enforce a requirement refuses to
// start the agent; it never runs it with less isolation (INV-11, G05).

import { check, sandboxRequirements, type SandboxRequirement } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { MxcAdapter, SandboxedAgents, type Enforceable, type MxcOptions } from "../src/sandbox.js";
import { FULL_SANDBOX, SimAgents, SimSandboxHost, SimTool } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";
import { BUG, FIXBUG, fixbugAgents, waitOf } from "./fixbug.js";

afterAll(closeAll);

const MODELS = { standard: ["api.anthropic.com"] };

function sandboxed(o: { can?: Enforceable; adapter?: Partial<MxcOptions>; agents?: SimAgents } = {}) {
  const host = new SimSandboxHost(o.can);
  const inner = o.agents ?? fixbugAgents();
  const agents = new SandboxedAgents(new MxcAdapter({ host, schemaVersion: "1.0", modelEndpoints: MODELS, ...o.adapter }), (req) => inner.run(req));
  return { host, inner, agents };
}

async function fixbug(o: Parameters<typeof sandboxed>[0] = {}) {
  const s = sandboxed(o);
  const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents: s.agents as unknown as SimAgents });
  return { ...w, ...s };
}

describe("agents run in sandboxes built from their grant", () => {
  it("FixBug runs its five agents in five sandboxes, each destroyed afterwards", async () => {
    const w = await fixbug();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "sb1" });
    expect(waitOf(run.waiting).request).toMatchObject({ criterion: "owner_approved" });

    const byAgent = Object.fromEntries(w.agents.sandboxes.map((s) => [s.agent, s.policy]));
    expect(Object.keys(byAgent).sort()).toEqual(["Explorer", "Implementer", "Planner", "Reviewer", "TestWriter"]);
    expect(w.host.open()).toEqual([]);
    // §20: the two parallel agents write disjoint trees.
    expect(byAgent["Implementer"]!.filesystem).toEqual({ readOnly: ["/work/repo"], readWrite: ["/work/repo/src"] });
    expect(byAgent["TestWriter"]!.filesystem).toEqual({ readOnly: ["/work/repo"], readWrite: ["/work/repo/test"] });
    expect(byAgent["Implementer"]!.process).toEqual({ allowedCommands: [{ command: "mvn", argsPrefix: [["-q", "test"], ["-q", "verify"]] }] });
    // §11.3: Explorer reads the repo, reaches only its model's endpoint, and stops after 15 minutes.
    expect(byAgent["Explorer"]).toEqual({
      $generator: "mandate-mxc@0.1 (MXC SDK v1)",
      $source: `Explorer@${check(FIXBUG, "mdt").hashes!.defs["Explorer"]}`,
      version: "1.0",
      isolation: "process",
      filesystem: { readOnly: ["/work/repo"], readWrite: [] },
      network: { allowOutbound: true, allowedHosts: ["api.anthropic.com"] },
      process: { allowedCommands: [] },
      ui: { allowDesktop: false, allowClipboard: false },
      timeoutSeconds: 900,
      mode: "enforcement",
    });
    // Without `with caps`, each delegation's requirement is the agent's static one.
    const program = check(FIXBUG, "mdt").program!;
    const statics = sandboxRequirements(program);
    for (const call of w.inner.calls) expect(call.sandbox).toEqual(statics[call.agent]);
  });

  it("a host that cannot limit command arguments never starts the agents that need it (G05)", async () => {
    const w = await fixbug({ can: { ...FULL_SANDBOX, exec: "command_allow_list" } });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "sb2" });
    expect(run.state).toBe("failed");
    expect(run.error).toMatchObject({
      $tag: "PolicyDenied",
      $args: [{ reason: "unsupported_sandbox_profile", code: "MDT-E0902", adapter: "mandate-mxc@0.1", unsupported: ["argument-prefix limits on commands"] }],
    });
    // Explorer and Planner ran sandboxed; Implementer and TestWriter were never started.
    expect(w.inner.count("Implementer.apply") + w.inner.count("TestWriter.regression")).toBe(0);
    expect(w.agents.sandboxes.map((s) => s.agent)).toEqual(["Explorer", "Planner"]);
    // Nothing was spent on the refusal, and no reservation is left open.
    const report = await w.rt.budgetReport("sb2");
    expect(report.dimensions[0]).toMatchObject({ settled: 3_000_000, reserved: 0 });
  });

  it("another backend is never chosen in place of the one asked for", async () => {
    const { agents, inner } = sandboxed({ can: { ...FULL_SANDBOX, backends: ["session"] } });
    const out = await agents.run(delegation(requirement()));
    expect(out).toMatchObject({ error: { tag: "PolicyDenied", args: [{ unsupported: ["isolation backend process"] }] } });
    expect(inner.count()).toBe(0);
  });

  it("permissive mode is refused even on a host that offers it; learning mode is allowed", async () => {
    const permissive = sandboxed({ adapter: { mode: "permissive" as "learning" } });
    expect(await permissive.agents.run(delegation(requirement()))).toMatchObject({ error: { args: [{ unsupported: ["mode permissive"] }] } });
    const learning = sandboxed({ adapter: { mode: "learning" } });
    expect(await learning.agents.run(delegation(requirement()))).toMatchObject({ ok: expect.anything() });
    expect(learning.host.created[0]!.policy.mode).toBe("learning");
  });

  it("each missing guarantee is named: model endpoint, host allow-list, timeout, unbounded scope", async () => {
    const adapter = new MxcAdapter({ host: new SimSandboxHost({ ...FULL_SANDBOX, network: "deny_all", timeout: false }), schemaVersion: "1.0", modelEndpoints: {} });
    const planned = await adapter.plan(requirement({ network: { hosts: ["ci.example.com"] }, unbounded: ["Repo = fs.read"] }));
    expect(planned).toEqual({
      unsupported: ["no endpoint is configured for model tier standard", "capability without a static scope: Repo = fs.read", "an outbound host allow-list", "a timeout"],
    });
  });

  it("an agent with no hosts and no model gets no outbound network at all", async () => {
    const adapter = new MxcAdapter({ host: new SimSandboxHost({ ...FULL_SANDBOX, network: "deny_all" }), schemaVersion: "1.0", modelEndpoints: {}, defaultTimeoutMs: 60_000 });
    const planned = await adapter.plan(requirement({ models: [], limits: { timeout_ms: null } }));
    expect(planned).toMatchObject({ policy: { network: { allowOutbound: false, allowedHosts: [] }, timeoutSeconds: 60 } });
  });

  it("`with caps` narrows the sandbox to the delegation's grant (§7.5)", async () => {
    const src = `module test.narrow @ 0.1
use std.{fs, model}
use company.domain.{Issue}

capability RepoWrite = fs.write("/work/repo")
capability ModelStd  = model.infer(tier: standard)

agent Writer {
  caps   RepoWrite, ModelStd
  budget { steps: 5, time: 1m }
  skill edit(issue: Issue) -> Inferred<Text> ! {Fs.Write, Model}
}

workflow Edit(issue: Issue) -> Inferred<Text>
  caps    RepoWrite, ModelStd
  budget  { steps: 10 }
{
  delegate Writer.edit(issue) with caps RepoWrite.narrow("/work/repo/src")
}
`;
    const s = sandboxed({ agents: new SimAgents() });
    const w = await world(src, { agents: s.agents as unknown as SimAgents });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Edit", input: BUG, runId: "sb3" });
    expect(run.state).toBe("succeeded");
    expect(s.host.created.map((c) => c.policy.filesystem)).toEqual([{ readOnly: [], readWrite: ["/work/repo/src"] }]);
    expect(s.host.created[0]!.policy.timeoutSeconds).toBe(60);
  });
});

/** A small requirement, as the compiler would write it. */
function requirement(o: Partial<SandboxRequirement> = {}): SandboxRequirement {
  return {
    format: "mandate/sandbox-requirement/0.1",
    subject: { agent: "A", def: "sha256:00" },
    filesystem: { read: ["/work/repo"], write: [] },
    exec: [],
    network: { hosts: [] },
    models: [{ tier: "standard", max_class: "internal" }],
    ui: { desktop: false, clipboard: false },
    limits: { timeout_ms: 60_000 },
    unbounded: [],
    ...o,
  };
}

function delegation(sandbox: SandboxRequirement) {
  return { agent: "A", skill: "s", args: [], caps: [], isolated: false, attempt: 0, commandId: "/defs/W/body/0/value", sandbox };
}
