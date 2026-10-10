// The Gate 3 verifier (P1-10, K20): test suites and red-then-green in a
// sandbox of their own, and a model review that is reserved and settled like
// any model call. A test-only host runs the processes directly, so these
// tests use real git and node; the MXC tests check the isolation itself.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { InferRequest, ModelAdapter, Outcome } from "../src/adapters.js";
import { FULL_SANDBOX } from "../src/sim.js";
import { MxcAdapter, type ExecRequest, type ExecResult, type MxcPolicy, type SandboxHost } from "../src/sandbox.js";
import { SandboxVerifier } from "../src/verifier.js";

/** Runs processes on this machine, recording each policy it was given. Test only: no isolation. */
class DirectHost implements SandboxHost {
  readonly policies: MxcPolicy[] = [];
  readonly runs: Array<{ argv: string[]; cwd?: string; policy: MxcPolicy }> = [];
  private readonly open = new Map<string, MxcPolicy>();
  async probe() {
    return FULL_SANDBOX;
  }
  async create(policy: MxcPolicy) {
    this.policies.push(policy);
    const h = `h${this.policies.length}`;
    this.open.set(h, policy);
    return h;
  }
  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    this.runs.push({ argv: req.argv, ...(req.cwd ? { cwd: req.cwd } : {}), policy: this.open.get(handle)! });
    const r = spawnSync(req.argv[0]!, req.argv.slice(1), { cwd: req.cwd, encoding: "utf8" });
    return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? 1, timedOut: false };
  }
  async destroy(handle: string) {
    this.open.delete(handle);
    return "destroyed" as const;
  }
}

const repo = mkdtempSync(join(tmpdir(), "mandate-verify-"));
afterAll(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
mkdirSync(join(repo, "src"), { recursive: true });
mkdirSync(join(repo, "test"), { recursive: true });
mkdirSync(join(repo, "acceptance"), { recursive: true });
writeFileSync(join(repo, "src", "pages.mjs"), "export const pageCount = (t, p) => Math.floor(t / p);\n");
writeFileSync(join(repo, "test", "pages.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { pageCount } from "../src/pages.mjs";\ntest("exact", () => assert.equal(pageCount(10, 5), 2));\n');
writeFileSync(join(repo, "acceptance", "pages.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { pageCount } from "../src/pages.mjs";\ntest("partial", () => assert.equal(pageCount(11, 5), 3));\n');
git("init", "-q", "-b", "main");
git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed");
git("tag", "seed");
// The agents' work: the fix, and a regression test.
writeFileSync(join(repo, "src", "pages.mjs"), "export const pageCount = (t, p) => Math.ceil(t / p);\n");
writeFileSync(join(repo, "test", "partial.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { pageCount } from "../src/pages.mjs";\ntest("partial page", () => assert.equal(pageCount(1, 5), 1));\n');

const config = { workdir: repo, base: "seed", suites: { unit: "test/**/*.test.mjs", integration: "acceptance/**/*.test.mjs" } };

describe("the Gate 3 verifier (K20)", () => {
  it("runs the named suites, as the base commit has them, each in a read-only sandbox of its own", async () => {
    const host = new DirectHost();
    const v = new SandboxVerifier(config, new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {} }));
    const r = await v.check({ method: "test.suite", args: [["unit", "integration"]], named: {}, contract: "FixAccepted", criterion: "suite_green" });
    expect(r.passed, JSON.stringify(r.detail)).toBe(true);
    // A pinned suite runs its files at the base commit: the regression test an agent added is not part of it.
    expect(host.runs.map((x) => x.argv)).toEqual([
      ["node", "--test", "test/pages.test.mjs"],
      ["node", "--test", "acceptance/pages.test.mjs"],
    ]);
    // Each run has its own sandbox over a copy, which it may read and not write.
    expect(host.policies).toHaveLength(2);
    expect(host.runs[0]!.cwd).not.toBe(repo);
    expect(host.policies[0]!.filesystem.readOnly).toHaveLength(1);
    expect(host.policies[0]).toMatchObject({ filesystem: { readWrite: [] }, network: { allowOutbound: false }, process: { allowedCommands: [{ command: "node", argsPrefix: [["--test"]] }] } });
    // What it ran against, who ran it, and its logs.
    expect(r.subject!.files["src/pages.mjs"]).toMatch(/^sha256:/);
    expect(r.producer).toMatchObject({ kind: "runtime", handler: "mandate-sandbox-verifier@0.2", sandbox: "mxc:process" });
    expect(r.logs!.map((l) => [l.kind, l.phase, l.result])).toEqual([
      ["test_log", "unit", "pass"],
      ["test_log", "integration", "pass"],
    ]);
    expect((await v.check({ method: "test.suite", args: [["e2e"]], named: {}, contract: "C", criterion: "c" })).passed).toBe(false);
  });

  it("keeps a pinned acceptance suite out of the agents' reach (G06)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-g06-"));
    try {
      const g = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
      mkdirSync(join(dir, "src"));
      mkdirSync(join(dir, "acceptance"));
      writeFileSync(join(dir, "src", "pages.mjs"), "export const pageCount = (t, p) => Math.floor(t / p);\n");
      writeFileSync(join(dir, "acceptance", "pages.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { pageCount } from "../src/pages.mjs";\ntest("partial", () => assert.equal(pageCount(11, 5), 3));\n');
      g("init", "-q", "-b", "main");
      g("add", "-A");
      g("commit", "-q", "-m", "seed");
      g("tag", "seed");
      // An agent that cannot fix the bug weakens the maintainers' test instead, and adds one that always passes.
      writeFileSync(join(dir, "acceptance", "pages.test.mjs"), 'import { test } from "node:test";\ntest("partial", () => {});\n');
      writeFileSync(join(dir, "acceptance", "extra.test.mjs"), 'import { test } from "node:test";\ntest("fine", () => {});\n');
      const check = (pinned: boolean) =>
        new SandboxVerifier({ workdir: dir, base: "seed", suites: { integration: { files: "acceptance/**/*.test.mjs", pinned } } }, new MxcAdapter({ host: new DirectHost(), schemaVersion: "0.9.0", modelEndpoints: {} })).check({
          method: "test.suite",
          args: [["integration"]],
          named: {},
          contract: "FixAccepted",
          criterion: "suite_green",
        });
      const pinned = await check(true);
      expect(pinned.passed).toBe(false);
      expect(pinned.detail).toMatchObject({ runs: [{ suite: "integration", changed_in_working_copy: ["acceptance/pages.test.mjs"], pinned: { "acceptance/pages.test.mjs": expect.stringMatching(/^sha256:/) } }] });
      // Unpinned, the weakened tests would have been the only authority.
      expect((await check(false)).passed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("meets red-then-green only when the new tests fail at the base and pass with the patch", async () => {
    const host = new DirectHost();
    const v = new SandboxVerifier(config, new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {} }));
    const ok = await v.check({ method: "test.red_then_green", args: [{ files: ["src/pages.mjs"] }, { files: ["test/partial.test.mjs"] }], named: {}, contract: "FixAccepted", criterion: "regression_test" });
    expect(ok.passed, JSON.stringify(ok.detail)).toBe(true);
    expect(ok.detail).toMatchObject({ red: { exit_code: 1 }, green: { exit_code: 0 } });
    // A test that passes before the fix too proves nothing about the bug.
    const always = await v.check({ method: "test.red_then_green", args: [{ files: ["src/pages.mjs"] }, { files: ["test/pages.test.mjs"] }], named: {}, contract: "FixAccepted", criterion: "regression_test" });
    expect(always.passed).toBe(false);
    expect((await v.check({ method: "test.red_then_green", args: [{ files: ["src/pages.mjs"] }, { files: [] }], named: {}, contract: "C", criterion: "c" })).passed).toBe(false);
  });

  it("reviews the diff with a model, reserving and reporting what it costs", async () => {
    const seen: InferRequest[] = [];
    const model: ModelAdapter = {
      upperBound: async () => ({ tokens: 5000, spend: { micros: 9000, currency: "USD" } }),
      infer: async (req): Promise<Outcome> => {
        seen.push(req);
        return { ok: { blocking: false, findings: [] }, cost: { tokens: 1200, spend: { micros: 2000, currency: "USD" } }, meta: { model: "m" } };
      },
    };
    const v = new SandboxVerifier(config, new MxcAdapter({ host: new DirectHost(), schemaVersion: "0.9.0", modelEndpoints: {} }), model);
    const req = { method: "review", args: ["isolated"], named: { model: "standard" }, contract: "FixAccepted", criterion: "no_blocking_review" };
    expect(await v.upperBound(req)).toEqual({ tokens: 5000, spend: { micros: 9000, currency: "USD" } });
    const r = await v.check(req);
    expect(r).toMatchObject({ passed: true, cost: { tokens: 1200 } });
    expect(seen[0]!.tier).toBe("standard");
    expect(String(seen[0]!.input)).toContain("Math.ceil");
  });
});

// The files a patch names are what the agents said (Inferred). The verifier
// works outside every sandbox, so it may neither follow such a path out of
// the working copy nor through a link in its copies (Doc 11 §7).
describe("paths the agents name (Doc 11 §7)", () => {
  const work = mkdtempSync(join(tmpdir(), "mandate-verify-paths-"));
  const victim = mkdtempSync(join(tmpdir(), "mandate-victim-"));
  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  });
  const g = (...args: string[]) => execFileSync("git", ["-C", work, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });
  const link = (target: string, at: string) => symlinkSync(target, at, process.platform === "win32" ? "junction" : "dir");
  const unlink = (at: string) => (process.platform === "win32" ? rmdirSync(at) : unlinkSync(at));
  mkdirSync(join(work, "src"), { recursive: true });
  mkdirSync(join(work, "test"), { recursive: true });
  mkdirSync(join(work, "acceptance"), { recursive: true });
  writeFileSync(join(work, "src", "pages.mjs"), "export const pageCount = (t, p) => Math.floor(t / p);\n");
  writeFileSync(join(work, "acceptance", "pages.test.mjs"), 'import { test } from "node:test";\ntest("ok", () => {});\n');
  g("init", "-q", "-b", "main");
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("tag", "seed");
  writeFileSync(join(work, "src", "pages.mjs"), "export const pageCount = (t, p) => Math.ceil(t / p);\n");
  writeFileSync(join(work, "test", "partial.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { pageCount } from "../src/pages.mjs";\ntest("partial page", () => assert.equal(pageCount(1, 5), 1));\n');
  // Installed dependencies: the verifier's copies link them, and must leave them where they are.
  mkdirSync(join(work, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(work, "node_modules", "dep", "index.js"), "module.exports = 1;\n");
  writeFileSync(join(victim, "keep.txt"), "keep\n");
  writeFileSync(join(victim, "pages.test.mjs"), "victim\n");

  const verifier = (suites: Record<string, string> = {}) => new SandboxVerifier({ workdir: work, base: "seed", suites }, new MxcAdapter({ host: new DirectHost(), schemaVersion: "0.9.0", modelEndpoints: {} }));
  const redThenGreen = (patched: string[], tests = ["test/partial.test.mjs"]) =>
    verifier().check({ method: "test.red_then_green", args: [{ files: patched }, { files: tests }], named: {}, contract: "FixAccepted", criterion: "regression_test" });
  const untouched = () => {
    expect(readFileSync(join(victim, "keep.txt"), "utf8")).toBe("keep\n");
    expect(readFileSync(join(victim, "pages.test.mjs"), "utf8")).toBe("victim\n");
    expect(existsSync(join(work, "node_modules", "dep", "index.js"))).toBe(true);
  };

  it("refuses a patch or tests that name a file outside the working copy, and deletes nothing", async () => {
    const escape = `../${basename(victim)}/keep.txt`;
    for (const [patched, tests] of [
      [["src/pages.mjs", escape], undefined],
      [["src/pages.mjs", join(victim, "keep.txt")], undefined],
      [["src/pages.mjs"], [escape]],
    ] as const) {
      const r = await redThenGreen([...patched], tests ? [...tests] : undefined);
      expect(r.passed).toBe(false);
      expect(r.detail).toMatchObject({ reason: "files outside the working copy" });
    }
    untouched();
  });

  it("does not follow the linked node_modules from a copy", async () => {
    const r = await redThenGreen(["src/pages.mjs", "node_modules/dep/index.js"]);
    expect(r.passed).toBe(false);
    expect(r.detail).toMatchObject({ reason: expect.stringContaining("passes through a link (node_modules)") });
    untouched();
  });

  it("leaves the real node_modules in place when it removes a copy (Doc 11 §7.2)", async () => {
    const r = await redThenGreen(["src/pages.mjs"]);
    expect(r.passed, JSON.stringify(r.detail)).toBe(true);
    untouched();
  });

  it("does not follow a link the agents left in the working copy: its copies hold real files only", async () => {
    // A link out of the working copy, and a pinned suite's directory replaced by one.
    link(victim, join(work, "out"));
    rmSync(join(work, "acceptance"), { recursive: true, force: true });
    link(victim, join(work, "acceptance"));
    try {
      const r = await redThenGreen(["src/pages.mjs", "out/keep.txt"]);
      expect(r.passed, JSON.stringify(r.detail)).toBe(true);
      // The pinned suite runs its files from the base commit, written into a real directory of the copy.
      const s = await verifier({ acceptance: "acceptance/**/*.test.mjs" }).check({ method: "test.suite", args: [["acceptance"]], named: {}, contract: "FixAccepted", criterion: "suite_green" });
      expect(s.passed, JSON.stringify(s.detail)).toBe(true);
      untouched();
    } finally {
      for (const at of ["out", "acceptance"]) unlink(join(work, at));
    }
  });
});
