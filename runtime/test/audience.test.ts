// Acme task class 3 in a run (design doc 9 §12, B5): a change to the token
// audience on acme-mcp's side only. Its own tests pass and no interface
// spec changes, so only the end-to-end check can catch it, and does: the run
// stops before anything lands. With every criterion met the change lands as
// a change set; a file changed after the checks makes the evidence stale
// (G01). Docker is a fake here.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { BoundaryVerifier, type Docker } from "../src/boundary.js";
import { GitHubMerges } from "../src/github-merge.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { runDoc, runView } from "../src/views.js";
import { toMarkdown } from "@mandate/compiler";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimSandboxHost } from "../src/sim.js";
import { isObj, type Obj } from "../src/values.js";
import type { WorkspaceAdapter } from "../src/workspace.js";
import { fakeGitHubs } from "./fake-github.js";
import { closeAll, world } from "./helpers.js";
import { ACME_SOURCE, acmeModules, lockFor } from "./acme.js";

afterAll(closeAll);

const AUDIENCE = readFileSync(new URL("../../fixtures/system/audience.mdt", import.meta.url), "utf8");
const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.email=t@mandate", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8" });

/** acme-mcp's working copy: its expected audience in src/config.ts, and a test that agrees with it. */
function mcpRepo(dir: string): { root: string; base: string } {
  const root = join(dir, "acme-mcp");
  const files: Record<string, string> = {
    "src/config.ts": 'export const audience = process.env.MCP_RESOURCE ?? "http://mcp:3001/mcp";\n',
    "test/config.test.ts": 'expect audience "http://mcp:3001/mcp"\n',
    "docs/mcp-tools.json": JSON.stringify({ tools: [{ name: "get_shipment", inputSchema: { type: "object", properties: { tracking_no: { type: "string" } }, required: ["tracking_no"] } }] }),
  };
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "seed");
  return { root, base: git(root, "rev-parse", "HEAD").trim() };
}

/** `npm test`: the audience in src/config.ts must match what test/config.test.ts expects. */
function npmHost(): SimSandboxHost {
  const h = new SimSandboxHost();
  h.programs["npm"] = (req) => {
    const src = readFileSync(join(req.cwd!, "src/config.ts"), "utf8").match(/\?\? "([^"]+)"/)?.[1];
    const want = readFileSync(join(req.cwd!, "test/config.test.ts"), "utf8").match(/"([^"]+)"/)?.[1];
    return src === want ? { stdout: "pass\n", stderr: "", exitCode: 0, timedOut: false } : { stdout: "", stderr: `audience ${src}, expected ${want}\n`, exitCode: 1, timedOut: false };
  };
  return h;
}

/** The end-to-end check: the token voice gets from auth carries aud http://mcp:3001/mcp; mcp accepts only its own audience. */
function e2eDocker(root: string, during?: () => void): Docker {
  return {
    async run(args) {
      if (args[0] === "network") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "run") return { exitCode: 0, stdout: "PROBED\n", stderr: "" };
      if (args.includes("config")) return { exitCode: 0, stdout: JSON.stringify({ services: { mcp: {}, e2e: {} }, networks: { default: { internal: true } } }), stderr: "" };
      if (args.includes("run") && args.includes("--rm")) {
        during?.();
        const aud = readFileSync(join(root, "src/config.ts"), "utf8").match(/\?\? "([^"]+)"/)?.[1];
        return aud === "http://mcp:3001/mcp" ? { exitCode: 0, stdout: "e2e | status-lookup passed\n", stderr: "" } : { exitCode: 1, stdout: "e2e | status-lookup FAILED: get_shipment answered 401 invalid_token\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
}

async function audienceRun(change: { config: string; test: string; files?: Record<string, string> }, o: { during?: (root: string) => void } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mandate-aud-"));
  const mcp = mcpRepo(dir);
  const modules = acmeModules(ACME_SOURCE.replace('"/work/acme-mcp"', JSON.stringify(mcp.root.replace(/\\/g, "/"))));
  const agents = new SimAgents()
    .on("Planner.plan", () => ({ ok: { summary: "Accept the logical audience acme-mcp", components: ["mcp"], changes: {} }, cost: { steps: 2 } }))
    .on("McpDev.implement", () => {
      // The agent moves mcp's side of the audience agreement, and its test with it.
      writeFileSync(join(mcp.root, "src/config.ts"), change.config);
      writeFileSync(join(mcp.root, "test/config.test.ts"), change.test);
      for (const [f, c] of Object.entries(change.files ?? {})) writeFileSync(join(mcp.root, f), c);
      return { ok: { files: ["src/config.ts", "test/config.test.ts", ...Object.keys(change.files ?? {})], summary: "audience" }, cost: { steps: 4 } };
    });
  const w = await world(AUDIENCE, { modules, lock: lockFor(modules), agents });
  const sandbox = new MxcAdapter({ host: npmHost(), schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });
  w.adapters.verifier = new BoundaryVerifier({ integration: { dir, files: ["base.yml"], service: "e2e" }, pinned: { mcp: [] } }, sandbox, e2eDocker(mcp.root, o.during ? () => o.during!(mcp.root) : undefined));
  const workspace: WorkspaceAdapter = { prepare: async () => ({ mcp: { base: mcp.base } }) };
  w.adapters.workspace = workspace;
  const gh = fakeGitHubs(["acme/mcp"]);
  // The repository on GitHub and the working copy share history: main is the run's base commit.
  const remote = gh.repos["acme/mcp"]!;
  remote.commits.set(mcp.base, { ...remote.commits.get(remote.refs.get("heads/main")!)!, message: "seed" });
  remote.refs.set("heads/main", mcp.base);
  w.adapters.tools["git.merge"] = new GitHubMerges({ token: "t", repos: ["acme/mcp"], fetch: gh.fetch });
  const rt = new Runtime(w.db, w.adapters);
  const program = check(AUDIENCE, "mdt", { modules }).program!;
  let run = await rt.startRun({ pkg: buildPackage(program, lockFor(modules), modules), workflow: "Audience", input: { task: { id: "K-3", request: "Use the logical audience" } } });
  // The architect accepts the plan.
  const wait = run.waiting as Obj;
  run = await rt.decideAction(run.run_id, { sender: "architect", messageId: "plan" }, { commandId: String(wait["command"]), revision: run.revision, digest: String((wait["request"] as Obj)["subject_digest"]), approve: true, by: "architect" });
  return { rt, run, dir, mcp, gh, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("Acme task class 3: an audience change on one side (B5)", () => {
  it("passes mcp's own tests and every contract diff, fails end to end, and lands nothing", async () => {
    const t = await audienceRun({ config: 'export const audience = process.env.MCP_RESOURCE ?? "acme-mcp";\n', test: 'expect audience "acme-mcp"\n' });
    try {
      expect(t.run.state).toBe("waiting");
      expect(isObj(t.run.waiting) && JSON.stringify(t.run.waiting["request"])).toContain("integrated");
      const evidence = Object.fromEntries((await t.rt.evidence(t.run.run_id)).filter((e) => e.contract === "BoundaryAccepted").map((e) => [e.criterion, e.passed]));
      expect(evidence).toEqual({ suites: true, contracts: true, integrated: false, planned: true });
      expect(t.gh.repos["acme/mcp"]!.pulls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it("with every criterion met, lands the change as a change set", async () => {
    const t = await audienceRun({ config: 'export const audience = process.env.MCP_RESOURCE ?? "http://mcp:3001/mcp";\nexport const leeway = 5;\n', test: 'expect audience "http://mcp:3001/mcp"\n' });
    try {
      let run = t.run;
      for (let i = 0; run.state === "waiting"; i++) {
        const w = run.waiting as Obj;
        const r = w["request"] as Obj;
        run = await t.rt.decideAction(run.run_id, { sender: String(r["role"]), messageId: `d${i}` }, { commandId: String(w["command"]), revision: run.revision, digest: String(r["action_digest"]), approve: true, by: String(r["role"]) });
      }
      expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
      const repo = t.gh.repos["acme/mcp"]!;
      expect(repo.pulls[0]!.merged).toBe(true);
      expect(repo.filesOf("main")!.get("src/config.ts")).toContain("leeway");

      // The change set view (doc 9 §8.2): the approved plan, the change, the evidence matrix, the order, what was real.
      const { view, program } = await runView(t.rt, run.run_id);
      const [cs] = view.changesets;
      expect(cs!.plan.approved_by).toEqual([{ criterion: "PlanAccepted.architect", by: "architect", role: "architect" }]);
      expect(cs!.components).toEqual([{ component: "mcp", effect: "git.merge", approver: "support_platform_owner", action: "confirmed", files: ["src/config.ts", "test/config.test.ts"], governance: [], owner: "support_platform_owner", interfaces: [{ interface: "CustomerTools", declared: null, measured: "none" }], unplanned: [] }]);
      expect(cs!.matrix.map((r) => [r.criterion, r.method, r.cells["mcp"]!.result])).toEqual([
        ["contracts", "test.contract", "passed"],
        ["integrated", "test.integration", "passed"],
        ["planned", "test.planned", "passed"],
        ["suites", "test.suite_each", "passed"],
      ]);
      expect(cs!.order).toEqual([{ component: "mcp", because: ["first: it consumes nothing another member provides"] }]);
      expect(cs!.reality).toBe("Live run: mcp confirmed.");
      expect(cs!.authority).toEqual([]);
      expect(view.modules.map((m) => m.module)).toEqual(["acme.system"]);
      const md = toMarkdown(runDoc(view, program));
      expect(md).toContain("## Change set at");
      expect(md).toContain("Module acme.system");
    } finally {
      t.cleanup();
    }
  });

  it("flags an interface change the plan does not name as an unplanned_change, and lands nothing", async () => {
    const tools = JSON.stringify({ tools: [{ name: "get_shipment", inputSchema: { type: "object", properties: { tracking_no: { type: "string" } }, required: ["tracking_no"] } }, { name: "cancel_shipment", inputSchema: { type: "object", properties: { tracking_no: { type: "string" } }, required: ["tracking_no"] } }] });
    const t = await audienceRun({ config: 'export const audience = process.env.MCP_RESOURCE ?? "http://mcp:3001/mcp";\n', test: 'expect audience "http://mcp:3001/mcp"\n', files: { "docs/mcp-tools.json": tools } });
    try {
      const evidence = await t.rt.evidence(t.run.run_id);
      const planned = evidence.find((e) => e.criterion === "planned")!;
      expect(planned.passed).toBe(false);
      expect(JSON.stringify(planned.detail)).toContain("unplanned_change");
      expect(JSON.stringify(planned.detail)).toContain("CustomerTools changed (additive), and the plan does not name it");
      expect(t.gh.repos["acme/mcp"]!.pulls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it("refuses to land a file that changed after a check saw it (G01)", async () => {
    // While the end-to-end check runs, src/config.ts changes: that check's evidence names the old bytes.
    const t = await audienceRun(
      { config: 'export const audience = process.env.MCP_RESOURCE ?? "http://mcp:3001/mcp";\n', test: 'expect audience "http://mcp:3001/mcp"\n' },
      { during: (root) => writeFileSync(join(root, "src/config.ts"), 'export const audience = process.env.MCP_RESOURCE ?? "http://mcp:3001/mcp"; // edited after the check\n') },
    );
    try {
      expect(t.run.state).toBe("attention_required");
      expect((t.run.attention as Obj)["violation"]).toBe("stale_evidence");
      expect(String((t.run.attention as Obj)["message"])).toContain("mcp/src/config.ts");
      expect(t.gh.repos["acme/mcp"]!.pulls).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});
