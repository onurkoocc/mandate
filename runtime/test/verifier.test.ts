// The Gate 3 verifier (P1-10, K20): test suites and red-then-green in a
// sandbox of their own, and a model review that is reserved and settled like
// any model call. A test-only host runs the processes directly, so these
// tests use real git and node; the MXC tests check the isolation itself.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("runs the named suites in a read-only sandbox of their own", async () => {
    const host = new DirectHost();
    const v = new SandboxVerifier(config, new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {} }));
    const r = await v.check({ method: "test.suite", args: [["unit", "integration"]], named: {}, contract: "FixAccepted", criterion: "suite_green" });
    expect(r.passed, JSON.stringify(r.detail)).toBe(true);
    expect(host.runs.map((x) => x.argv)).toEqual([
      ["node", "--test", "test/**/*.test.mjs"],
      ["node", "--test", "acceptance/**/*.test.mjs"],
    ]);
    // Each run has its own sandbox, which may read the working copy and write nothing.
    expect(host.policies).toHaveLength(2);
    expect(host.policies[0]!.filesystem.readOnly).toHaveLength(1);
    expect(host.policies[0]).toMatchObject({ filesystem: { readWrite: [] }, network: { allowOutbound: false }, process: { allowedCommands: [{ command: "node", argsPrefix: [["--test"]] }] } });
    expect((await v.check({ method: "test.suite", args: [["e2e"]], named: {}, contract: "C", criterion: "c" })).passed).toBe(false);
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
