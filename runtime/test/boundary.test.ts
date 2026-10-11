// Boundary evidence (design doc 9 §4; BACKLOG item 33, B5), against real git
// working copies: each component's own tests pinned to the base commit, the
// interface specs diffed against what the plan declared, the system run end
// to end on an internal network (a fake docker here; the probe refuses a
// host that leaks), and CI that counts only attested or re-run.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemFacts, VerifyRequest } from "../src/adapters.js";
import { BoundaryVerifier, type CiRun, type Docker } from "../src/boundary.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost } from "../src/sim.js";
import type { Value } from "../src/values.js";

const tmp = mkdtempSync(join(tmpdir(), "mandate-boundary-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.email=t@mandate", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8" });
function repo(name: string, files: Record<string, string>): { root: string; base: string } {
  const root = join(tmp, name);
  for (const [f, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), c);
  }
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD").trim() };
}
const write = (root: string, f: string, c: string): void => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), c);
};

const META = { issuer: "http://auth:9000", token_endpoint: "http://auth:9000/token", scopes_supported: ["shipments:read", "tickets:write"] };
let mcp: { root: string; base: string };
let auth: { root: string; base: string };
let sys: SystemFacts;

/** `npm test` here: passes when the test's expected value equals src/value.ts, read from the real copy it runs in. */
function host(): SimSandboxHost {
  const h = new SimSandboxHost();
  h.programs["npm"] = (req) => {
    const value = readFileSync(join(req.cwd!, "src/value.ts"), "utf8").trim();
    const expected = readFileSync(join(req.cwd!, "test/value.test.ts"), "utf8").trim();
    return value === expected ? { stdout: "pass 1\n", stderr: "", exitCode: 0, timedOut: false } : { stdout: "", stderr: `expected ${expected}, got ${value}\n`, exitCode: 1, timedOut: false };
  };
  return h;
}

const sandbox = (h: SimSandboxHost) => new MxcAdapter({ host: h, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });
const req = (method: string, args: Value[], named: Record<string, Value> = {}): VerifyRequest => ({ method, args, named, contract: "BoundaryAccepted", criterion: method, system: sys });

beforeAll(() => {
  mcp = repo("acme-mcp", { "src/value.ts": "1\n", "test/value.test.ts": "1\n" });
  auth = repo("acme-auth", { "docs/oauth-metadata.json": JSON.stringify(META) });
  sys = {
    components: {
      mcp: { repo: "acme/mcp", root: mcp.root, base: mcp.base, lang: "ts", build: [], test: [{ command: "npm", args: ["test"] }], provides: ["CustomerTools"], consumes: ["TokenIssuance"] },
      auth: { repo: "acme/auth", root: auth.root, base: auth.base, lang: "ts", build: [], test: [{ command: "npm", args: ["test"] }], provides: ["TokenIssuance"], consumes: [] },
    },
    interfaces: { TokenIssuance: { protocol: "oauth", spec: "docs/oauth-metadata.json", provider: "auth" } },
  };
});

describe("test.suite_each", () => {
  it("runs each component's own tests with its test files as they were at the base commit (G06)", async () => {
    const h = host();
    const v = new BoundaryVerifier({ pinned: { mcp: ["test/**"] } }, sandbox(h));
    // An agent changes the value and rewrites the test to expect the new one: the pinned test still expects 1.
    write(mcp.root, "src/value.ts", "2\n");
    write(mcp.root, "test/value.test.ts", "2\n");
    const r = await v.check(req("test.suite_each", [["mcp"]]));
    expect(r.passed).toBe(false);
    expect((r.detail as { runs: Array<Record<string, unknown>> }).runs[0]).toMatchObject({ component: "mcp", passed: false, changed_in_working_copy: ["test/value.test.ts"] });
    // The evidence names every component's files under its component.
    expect(Object.keys(r.subject!.files)).toEqual(expect.arrayContaining(["mcp/src/value.ts", "mcp/test/value.test.ts", "auth/docs/oauth-metadata.json"]));
    // The tests ran in a sandbox that may read the copy and run npm test, nothing else.
    expect(h.created[0]!.policy.process.allowedCommands).toEqual([{ command: "npm", argsPrefix: [["test"]] }]);
    expect(h.created[0]!.policy.filesystem.readWrite).toEqual([]);

    write(mcp.root, "src/value.ts", "1\n");
    const ok = await v.check(req("test.suite_each", [["mcp"]]));
    expect(ok.passed).toBe(true);
    write(mcp.root, "test/value.test.ts", "1\n");
  });

  it("by default runs the component's tests as the change left them, and names the test files it changed", async () => {
    const v = new BoundaryVerifier({}, sandbox(host()));
    write(mcp.root, "src/value.ts", "2\n");
    write(mcp.root, "test/value.test.ts", "2\n");
    const r = await v.check(req("test.suite_each", [["mcp"]]));
    expect(r.passed).toBe(true);
    expect((r.detail as { runs: Array<Record<string, unknown>> }).runs[0]).toMatchObject({ component: "mcp", passed: true, tests_changed: ["test/value.test.ts"] });
    write(mcp.root, "src/value.ts", "1\n");
    write(mcp.root, "test/value.test.ts", "1\n");
  });

  it("G14: does not follow a link an agent left in a component's working copy when it pins its tests (Doc 11 §7)", async () => {
    const linked = repo("acme-linked", { "src/value.ts": "1\n", "test/value.test.ts": "1\n" });
    const victim = join(tmp, "victim");
    write(victim, "value.test.ts", "victim\n");
    // The agent replaced the test directory with a link out of its working copy.
    rmSync(join(linked.root, "test"), { recursive: true, force: true });
    symlinkSync(victim, join(linked.root, "test"), process.platform === "win32" ? "junction" : "dir");
    const facts: SystemFacts = { components: { linked: { ...sys.components["mcp"]!, repo: "acme/linked", root: linked.root, base: linked.base } }, interfaces: {} };
    const v = new BoundaryVerifier({ pinned: { linked: ["test/**"] } }, sandbox(host()));
    const r = await v.check({ ...req("test.suite_each", [["linked"]]), system: facts });
    // The copy holds real files only: the pinned test is written into it from the base commit, and runs.
    expect(r.passed, JSON.stringify(r.detail)).toBe(true);
    expect(readFileSync(join(victim, "value.test.ts"), "utf8")).toBe("victim\n");
  });

  it("links a component's dependencies into the test copy, but not its build output: the copy builds its own", async () => {
    const built = repo("acme-built", { "src/value.ts": "1\n", "test/value.test.ts": "1\n" });
    write(built.root, "node_modules/dep/index.js", "1\n");
    write(built.root, "target/classes/Old.class", "stale\n");
    const seen: Array<{ deps: boolean; target: boolean }> = [];
    const h = host();
    const npm = h.programs["npm"]!;
    h.programs["npm"] = (r, ...rest) => {
      seen.push({ deps: existsSync(join(r.cwd!, "node_modules/dep/index.js")), target: existsSync(join(r.cwd!, "target")) });
      return npm(r, ...rest);
    };
    const facts: SystemFacts = { components: { built: { ...sys.components["mcp"]!, repo: "acme/built", root: built.root, base: built.base } }, interfaces: {} };
    const r = await new BoundaryVerifier({}, sandbox(h)).check({ ...req("test.suite_each", [["built"]]), system: facts });
    expect(r.passed, JSON.stringify(r.detail)).toBe(true);
    // A linked build directory was read-only in a container sandbox: Maven could not write target/classes (Gate 5, KH-04).
    expect(seen).toEqual([{ deps: true, target: false }]);
    expect(h.created[0]!.policy.filesystem.readOnly.some((p) => p.endsWith(join("acme-built", "node_modules")))).toBe(true);
    expect(h.created[0]!.policy.filesystem.readOnly.some((p) => p.endsWith("target"))).toBe(false);
    // Build output is not part of the change.
    expect(Object.keys(r.subject!.files).some((f) => f.startsWith("built/target/"))).toBe(false);
  });

  it("refuses a component without test commands or outside the system", async () => {
    const v = new BoundaryVerifier({}, sandbox(host()));
    expect((await v.check(req("test.suite_each", [["ledger"]]))).passed).toBe(false);
  });
});

describe("test.contract", () => {
  it("measures each interface against what was declared: understating a change is unmet", async () => {
    const v = new BoundaryVerifier({}, sandbox(host()));
    write(auth.root, "docs/oauth-metadata.json", JSON.stringify({ ...META, scopes_supported: [...META.scopes_supported, "deliveries:write"] }));
    expect((await v.check(req("test.contract", [{ TokenIssuance: "additive" }]))).passed).toBe(true);
    const undeclared = await v.check(req("test.contract", [{}]));
    expect(undeclared.passed).toBe(false);
    expect((undeclared.detail as { interfaces: unknown[] }).interfaces).toEqual([
      { interface: "TokenIssuance", provider: "auth", protocol: "oauth", declared: "none", measured: "additive", problem: "change_undeclared", changes: ['+ scopes_supported gains "deliveries:write"'] },
    ]);
    write(auth.root, "docs/oauth-metadata.json", JSON.stringify({ ...META, scopes_supported: ["shipments:read"] }));
    const broken = await v.check(req("test.contract", [{ TokenIssuance: "additive" }]));
    expect(broken.passed).toBe(false);
    expect(JSON.stringify(broken.detail)).toContain("breaking_change_undeclared");
    write(auth.root, "docs/oauth-metadata.json", JSON.stringify(META));
    expect((await v.check(req("test.contract", [{}]))).passed).toBe(true);
  });
});

/** A docker that answers each command from a script, and records them. */
function fakeDocker(o: { probe?: string; config?: object; up?: number }): Docker & { calls: string[][]; override?: Record<string, unknown> } {
  const d: Docker & { calls: string[][]; override?: Record<string, unknown> } = {
    calls: [],
    async run(args) {
      d.calls.push(args);
      if (args[0] === "network") return { exitCode: 0, stdout: "", stderr: "" };
      if (args[0] === "run") return { exitCode: 0, stdout: o.probe ?? "PROBED\n", stderr: "" };
      const overridePath = args[args.lastIndexOf("-f") + 1]!;
      if (existsSync(overridePath)) d.override = JSON.parse(readFileSync(overridePath, "utf8")) as Record<string, unknown>;
      if (args.includes("config")) return { exitCode: 0, stdout: JSON.stringify(o.config ?? { services: { mcp: {}, e2e: {} }, networks: { default: { internal: true } } }), stderr: "" };
      if (args.includes("run") && args.includes("--rm")) return { exitCode: o.up ?? 0, stdout: "e2e | 4 scenarios passed\n", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  };
  return d;
}

const INTEGRATION = { dir: tmp, files: ["base.yml", "staging.yml"], service: "e2e" };

describe("test.integration", () => {
  it("builds each component from its working copy and runs the end-to-end service on internal networks only", async () => {
    const docker = fakeDocker({});
    const v = new BoundaryVerifier({ integration: INTEGRATION }, sandbox(host()), docker);
    const r = await v.check(req("test.integration", ["staging", ["mcp"]]));
    expect(r.passed).toBe(true);
    const project = docker.calls.find((c) => c.includes("build"))![2]!;
    expect(docker.override).toEqual({ services: { auth: { image: `${project}-auth`, build: { context: auth.root.replace(/\\/g, "/") } }, mcp: { image: `${project}-mcp`, build: { context: mcp.root.replace(/\\/g, "/") } } }, networks: { default: { internal: true } } });
    expect(docker.calls.find((c) => c[0] === "compose" && c.includes("--rm"))!.slice(-3)).toEqual(["run", "--rm", "e2e"]);
    expect(docker.calls.at(-1)).toContain("down");
  });

  it("builds a component under the service it names, and none for a component that is no service", async () => {
    const docker = fakeDocker({});
    const v = new BoundaryVerifier({ integration: { ...INTEGRATION, services: { auth: null, mcp: "gateway" } } }, sandbox(host()), docker);
    expect((await v.check(req("test.integration", ["staging", ["mcp"]]))).passed).toBe(true);
    const project = docker.calls.find((c) => c.includes("build"))![2]!;
    expect(docker.override).toEqual({ services: { gateway: { image: `${project}-gateway`, build: { context: mcp.root.replace(/\\/g, "/") } } }, networks: { default: { internal: true } } });
  });

  it("fails when the end-to-end service fails", async () => {
    const v = new BoundaryVerifier({ integration: INTEGRATION }, sandbox(host()), fakeDocker({ up: 1 }));
    expect((await v.check(req("test.integration", ["staging", ["mcp"]]))).passed).toBe(false);
  });

  it("is refused by name, and nothing runs, on a host whose internal network reaches out (K43, INV-11)", async () => {
    const docker = fakeDocker({ probe: "REACHED\nPROBED\n" });
    const r = await new BoundaryVerifier({ integration: INTEGRATION }, sandbox(host()), docker).check(req("test.integration", ["staging", ["mcp"]]));
    expect(r).toMatchObject({ passed: false, detail: { refused: "integration_isolation", reason: "an internal network on this host can still reach the outside" } });
    expect(docker.calls.some((c) => c.includes("build"))).toBe(false);
  });

  it("is refused when the environment publishes a port or keeps a network that is not internal", async () => {
    for (const config of [{ services: { core: { ports: [{ published: "8080" }] } }, networks: { default: { internal: true } } }, { services: {}, networks: { default: { internal: true }, outside: { internal: false } } }]) {
      const docker = fakeDocker({ config });
      const r = await new BoundaryVerifier({ integration: INTEGRATION }, sandbox(host()), docker).check(req("test.integration", ["staging", ["mcp"]]));
      expect(r).toMatchObject({ passed: false, detail: { refused: "integration_isolation" } });
      expect(docker.calls.some((c) => c.includes("build"))).toBe(false);
    }
  });
});

describe("test.ci", () => {
  const source = (run: CiRun | undefined) => ({ run: async () => run });

  it("counts an attested CI result", async () => {
    const v = new BoundaryVerifier({ ci: { source: source({ id: "1", conclusion: "success", attestation: { verified: true, detail: "sigstore bundle verified for the workflow" } }) } }, sandbox(host()));
    const r = await v.check(req("test.ci", [{ mcp: mcp.base }]));
    expect(r.passed).toBe(true);
    expect(JSON.stringify(r.detail)).toContain("attested_ci");
  });

  it("does not count an unattested result in attested mode; in rerun mode re-runs the tests at that commit itself", async () => {
    const ci = source({ id: "2", conclusion: "success" });
    const attested = await new BoundaryVerifier({ ci: { mode: "attested", source: ci } }, sandbox(host())).check(req("test.ci", [{ mcp: mcp.base }]));
    expect(attested.passed).toBe(false);
    expect(JSON.stringify(attested.detail)).toContain("ci_unattested");
    const h = host();
    const rerun = await new BoundaryVerifier({ ci: { source: ci } }, sandbox(h)).check(req("test.ci", [{ mcp: mcp.base }]));
    expect(rerun.passed).toBe(true);
    expect(JSON.stringify(rerun.detail)).toContain("verifier_rerun");
    expect(h.executions).toHaveLength(1);
    expect((await new BoundaryVerifier({ ci: { source: ci } }, sandbox(host())).check(req("test.ci", [{ mcp: "0".repeat(40) }]))).passed).toBe(false);
  });
});
