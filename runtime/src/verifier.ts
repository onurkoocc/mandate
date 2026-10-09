// The verifier for Gate 3 (Doc 4 §10; BACKLOG P1-10, K20). The runtime checks
// a contract's test criteria itself, in a sandbox of its own: a new,
// read-only MXC sandbox over the working copy, apart from every agent's, so
// an agent cannot mark its own work. Evidence is not signed yet (P2-11).
//
//   test.suite([names])            each named suite passes in the working copy
//   test.red_then_green(patch, tests)
//                                  the regression tests fail with the patched
//                                  files as they were at the base commit, and
//                                  pass with them as the agents left them
//   review(model: tier, isolated)  a model reviews the diff in a fresh
//                                  context: met when it finds nothing
//                                  blocking. Never enough alone (E0603)
//
// The verifier runs in the runtime process; git is called there, on the
// working copy, and every test runs in a sandbox.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { requirementFor, type CapVal, type TypeExpr } from "@mandate/compiler";
import type { CheckResult, CheckSubject, Cost, InferRequest, ModelAdapter, VerifierAdapter, VerifyRequest } from "./adapters.js";
import { sha256Of } from "./artifacts.js";
import type { MxcAdapter } from "./sandbox.js";
import { isObj, type Value } from "./values.js";

export interface VerifierConfig {
  /** The working copy the agents changed. */
  workdir: string;
  /** The commit the run started from, e.g. the tag `seed` (K17). */
  base: string;
  /** Test suite name → the test files' glob, relative to the working copy. */
  suites: Record<string, string>;
  /** How tests run: the command and its fixed leading arguments. Default `node --test`. */
  command?: string[];
  timeoutMs?: number;
}

const REVIEW_TYPE: TypeExpr = { record: { blocking: { ref: "Bool" }, findings: { ref: "List", args: [{ ref: "Text" }] } } };

export class SandboxVerifier implements VerifierAdapter {
  constructor(
    private readonly o: VerifierConfig,
    private readonly sandbox: MxcAdapter,
    private readonly model?: ModelAdapter,
  ) {}

  async upperBound(req: VerifyRequest): Promise<Cost | undefined> {
    if (req.method !== "review" || !this.model) return undefined;
    return this.model.upperBound(this.reviewRequest(req));
  }

  async check(req: VerifyRequest): Promise<CheckResult> {
    // What this check is about: the working copy, file by file, as it is now. The evidence is bound to it (G01).
    const subject = this.snapshot();
    const r = await this.run(req);
    return { ...r, subject };
  }

  private async run(req: VerifyRequest): Promise<Omit<CheckResult, "subject">> {
    switch (req.method) {
      case "test.suite":
        return this.suite(req.args[0]);
      case "test.red_then_green":
        return this.redThenGreen(req.args[0] ?? null, req.args[1] ?? null);
      case "review":
        return this.review(req);
    }
    return { passed: false, detail: { unsupported: `the verifier has no method ${req.method}` } };
  }

  /** Every file of the working copy (but .git and node_modules) by path relative to it, with its content digest. */
  snapshot(): CheckSubject {
    const files: Record<string, string> = {};
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.name === ".git" || e.name === "node_modules") continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else if (e.isFile()) files[r] = sha256Of(readFileSync(join(dir, e.name)));
      }
    };
    walk(this.o.workdir, "");
    return { files };
  }

  private async suite(names: Value | undefined): Promise<{ passed: boolean; detail: Value }> {
    const list = Array.isArray(names) ? names.map(String) : [];
    const unknown = list.filter((n) => !this.o.suites[n]);
    if (!list.length || unknown.length) return { passed: false, detail: { unknown_suites: unknown, known: Object.keys(this.o.suites) } };
    const runs: Value[] = [];
    let passed = true;
    for (const n of list) {
      const r = await this.runTests(this.o.workdir, [this.o.suites[n]!], `suite ${n}`);
      runs.push({ suite: n, exit_code: r.exitCode, timed_out: r.timedOut, output: tail(r.output) });
      passed &&= r.exitCode === 0 && !r.timedOut;
    }
    return { passed, detail: { runs } };
  }

  private async redThenGreen(patch: Value, tests: Value): Promise<{ passed: boolean; detail: Value }> {
    const patched = filesOf(patch);
    const testFiles = filesOf(tests);
    if (!testFiles.length) return { passed: false, detail: { reason: "the tests name no files" } };
    if (!patched.length) return { passed: false, detail: { reason: "the patch names no files" } };
    // Red: the patched files as they were at the base commit, the new tests as written.
    const red = mkdtempSync(join(tmpdir(), "mandate-red-"));
    try {
      cpSync(this.o.workdir, red, { recursive: true, filter: (src) => !/[\\/](\.git|node_modules)$/.test(src) });
      for (const f of patched) {
        const before = this.git(["show", `${this.o.base}:${f}`]);
        if (before === undefined) rmSync(join(red, f), { force: true });
        else {
          mkdirSync(dirname(join(red, f)), { recursive: true });
          writeFileSync(join(red, f), before);
        }
      }
      const r = await this.runTests(red, testFiles, "red");
      const g = await this.runTests(this.o.workdir, testFiles, "green");
      const passed = r.exitCode !== 0 && !r.timedOut && g.exitCode === 0 && !g.timedOut;
      return { passed, detail: { red: { exit_code: r.exitCode, output: tail(r.output) }, green: { exit_code: g.exitCode, output: tail(g.output) }, tests: testFiles, patched } };
    } finally {
      rmSync(red, { recursive: true, force: true });
    }
  }

  private reviewRequest(req: VerifyRequest): InferRequest {
    const tier = typeof req.named["model"] === "string" ? req.named["model"] : undefined;
    const diff = this.git(["diff", this.o.base, "--", "."]) ?? "";
    const input = [
      "Review this change for problems that should block merging it: a wrong fix, a broken behavior, a missing case, a test that does not test the bug.",
      "Report blocking: true only for such problems, and list each finding.",
      `<diff>\n${diff}\n</diff>`,
    ].join("\n");
    return { type: REVIEW_TYPE, input, ...(tier ? { tier } : {}), commandId: `${req.contract}.${req.criterion}/review` };
  }

  private async review(req: VerifyRequest): Promise<{ passed: boolean; detail: Value; cost?: Cost }> {
    if (!this.model) return { passed: false, detail: { reason: "no model is configured for review" } };
    const out = await this.model.infer(this.reviewRequest(req));
    const cost = out.cost === "unknown" ? undefined : out.cost;
    if (!("ok" in out)) return { passed: false, detail: { error: out.error as unknown as Value }, ...(cost ? { cost } : {}) };
    const v = isObj(out.ok) ? out.ok : {};
    return { passed: v["blocking"] === false, detail: { blocking: v["blocking"] ?? null, findings: v["findings"] ?? [], model: out.meta ?? null }, ...(cost ? { cost } : {}) };
  }

  /** Runs tests in a new read-only sandbox over `dir`: it may read `dir` and run the test command, nothing else. */
  private async runTests(dir: string, patterns: string[], label: string): Promise<{ exitCode: number; timedOut: boolean; output: string }> {
    const [command, ...prefix] = this.o.command ?? ["node", "--test"];
    const caps: CapVal[] = [
      { ctor: "fs.read", effect: "Fs.Read", write: false, scope: [dir] } as CapVal,
      { ctor: "exec", effect: "Exec", write: false, scope: [command!], argsPrefix: [prefix] } as CapVal,
    ];
    const req = requirementFor({ agent: "verifier", def: label }, caps, this.o.timeoutMs ?? 300_000);
    const planned = await this.sandbox.plan(req);
    if ("unsupported" in planned) return { exitCode: 126, timedOut: false, output: `the verifier's sandbox was refused: ${planned.unsupported.join("; ")}` };
    const host = this.sandbox.o.host;
    const handle = await host.create(planned.policy);
    try {
      const r = await host.execute(handle, { argv: [command!, ...prefix, ...patterns], cwd: dir });
      return { exitCode: r.exitCode, timedOut: r.timedOut, output: `${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}` };
    } finally {
      await host.destroy(handle);
    }
  }

  /** git in the working copy; undefined when the object does not exist. */
  private git(args: string[]): string | undefined {
    if (!existsSync(join(this.o.workdir, ".git"))) return undefined;
    try {
      return execFileSync("git", ["-C", this.o.workdir, ...args], { encoding: "utf8", maxBuffer: 16 << 20, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return undefined;
    }
  }
}

function filesOf(v: Value): string[] {
  const files = isObj(v) ? v["files"] : undefined;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string") : [];
}

function tail(text: string, max = 4000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}
