// The runtime's verifier (Doc 4 §10; BACKLOG P1-10, K20, P2-11). The runtime
// checks a contract's test criteria itself, in the control plane: the agents
// never run the checks that judge their work. Every test runs in a sandbox
// of its own, a new read-only MXC sandbox over a copy of the working copy,
// apart from every agent's.
//
//   test.suite([names])            each named suite passes. A suite is pinned
//                                  by default: its files are taken from the
//                                  base commit, before any agent ran, so an
//                                  agent that edits or adds tests cannot change
//                                  what the suite checks (G06)
//   test.red_then_green(patch, tests)
//                                  the regression tests fail with the patched
//                                  files as they were at the base commit, and
//                                  pass with them as the agents left them
//   review(model: tier, isolated)  a model reviews the diff in a fresh
//                                  context: met when it finds nothing
//                                  blocking. Never enough alone (E0603)
//
// Each check reports what it ran against (the working copy's files by
// digest), who produced it, and its outputs (test logs, the review), which
// the runtime keeps as artifacts and signs into the evidence record (§10.3).
// git is called in the runtime process, on the working copy.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globRegExp, requirementFor, type CapVal, type TypeExpr } from "@mandate/compiler";
import type { CheckLog, CheckResult, CheckSubject, Cost, InferRequest, ModelAdapter, VerifierAdapter, VerifyRequest } from "./adapters.js";
import { sha256Of } from "./artifacts.js";
import { inside, outside, PathRefused, realEntries, removeWithin, writeWithin } from "./paths.js";
import { MxcAdapter } from "./sandbox.js";
import { isObj, type Value } from "./values.js";

/** A test suite: the test files' glob relative to the working copy, and whether it is pinned to the base commit (default). */
export type SuiteConfig = string | { files: string; pinned?: boolean };

export interface VerifierConfig {
  /** The working copy the agents changed. */
  workdir: string;
  /** The commit the run started from, e.g. the tag `seed` (K17). Pinned suites are read from it. */
  base: string;
  /** Test suite name → its files. */
  suites: Record<string, SuiteConfig>;
  /** How tests run: the command and its fixed leading arguments. Default `node --test`. */
  command?: string[];
  timeoutMs?: number;
}

export const VERIFIER_HANDLER = "mandate-sandbox-verifier@0.2";

const REVIEW_TYPE: TypeExpr = { record: { blocking: { ref: "Bool" }, findings: { ref: "List", args: [{ ref: "Text" }] } } };

interface TestRun {
  exitCode: number;
  timedOut: boolean;
  output: string;
}

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
    return { producer: this.producer(), ...r, subject };
  }

  private producer(): Value {
    return { kind: "runtime", handler: VERIFIER_HANDLER, sandbox: `mxc:${this.sandbox.o.isolation ?? "process"}`, adapter: MxcAdapter.ID };
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

  // ── test.suite ────────────────────────────────────────────────────────

  private async suite(names: Value | undefined): Promise<Omit<CheckResult, "subject">> {
    const list = Array.isArray(names) ? names.map(String) : [];
    const unknown = list.filter((n) => !Object.hasOwn(this.o.suites, n));
    if (!list.length || unknown.length) return { passed: false, detail: { unknown_suites: unknown, known: Object.keys(this.o.suites) } };
    const runs: Value[] = [];
    const logs: CheckLog[] = [];
    let passed = true;
    for (const n of list) {
      const cfg = this.o.suites[n]!;
      const glob = typeof cfg === "string" ? cfg : cfg.files;
      const pinned = typeof cfg === "string" || cfg.pinned !== false;
      const r = pinned ? await this.pinnedSuite(n, glob) : { ...(await this.runTests(this.o.workdir, [glob], `suite ${n}`)), pinned: undefined, modified: undefined };
      const ok = r.exitCode === 0 && !r.timedOut;
      runs.push({
        suite: n,
        exit_code: r.exitCode,
        timed_out: r.timedOut,
        output: tail(r.output),
        ...(r.pinned ? { pinned: r.pinned } : {}),
        // Files of a pinned suite that the agents changed: shown, never run (G06).
        ...(r.modified?.length ? { changed_in_working_copy: r.modified } : {}),
      });
      logs.push({ kind: "test_log", phase: n, result: ok ? "pass" : "fail", content: r.output });
      passed &&= ok;
    }
    return { passed, detail: { runs }, logs };
  }

  /**
   * A pinned suite runs its files as they were at the base commit, over a
   * copy of the working copy: an agent that weakened, deleted or added a
   * test file changes nothing about what runs.
   */
  private async pinnedSuite(name: string, glob: string): Promise<TestRun & { pinned?: Record<string, string>; modified?: string[] }> {
    const listed = this.git(["ls-tree", "-r", "--name-only", this.o.base]);
    if (listed === undefined) return { exitCode: 125, timedOut: false, output: `suite ${name} is pinned to ${this.o.base}, which this working copy does not have` };
    const re = globRegExp(glob);
    const files = listed.split("\n").filter((f) => f && re.test(f)).sort();
    if (!files.length) return { exitCode: 125, timedOut: false, output: `suite ${name} has no files matching ${glob} at ${this.o.base}` };
    const copy = this.copy("mandate-suite-");
    try {
      const pinned: Record<string, string> = {};
      const modified: string[] = [];
      for (const f of files) {
        const content = this.gitBytes(["show", `${this.o.base}:${f}`])!;
        pinned[f] = sha256Of(content);
        const here = join(this.o.workdir, f);
        if (!existsSync(here) || sha256Of(readFileSync(here)) !== pinned[f]) modified.push(f);
        // A copy links its dependencies: a pinned file is written only through real directories.
        writeWithin(copy.dir, f, content);
      }
      const r = await this.runTests(copy.dir, files, `suite ${name}`, copy.extraRead);
      return { ...r, pinned, modified };
    } catch (e) {
      if (e instanceof PathRefused) return { exitCode: 125, timedOut: false, output: `suite ${name} cannot be pinned: ${e.message}` };
      throw e;
    } finally {
      copy.remove();
    }
  }

  // ── test.red_then_green ───────────────────────────────────────────────

  private async redThenGreen(patch: Value, tests: Value): Promise<Omit<CheckResult, "subject">> {
    const named = filesOf(patch);
    const testFiles = filesOf(tests);
    if (!testFiles.length) return { passed: false, detail: { reason: "the tests name no files" } };
    if (!named.length) return { passed: false, detail: { reason: "the patch names no files" } };
    // The files are what the agents said (Inferred): one outside the working copy is refused, not followed (Doc 11 §7).
    const escaping = [...outside(this.o.workdir, named), ...outside(this.o.workdir, testFiles)];
    if (escaping.length) return { passed: false, detail: { reason: "files outside the working copy", files: escaping } };
    const patched = named.map((f) => inside(this.o.workdir, f)!);
    // Red: the patched files as they were at the base commit, the new tests as written.
    const red = this.copy("mandate-red-");
    try {
      for (const f of patched) {
        const before = this.gitBytes(["show", `${this.o.base}:${f}`]);
        try {
          if (before === undefined) removeWithin(red.dir, f);
          else writeWithin(red.dir, f, before);
        } catch (e) {
          if (e instanceof PathRefused) return { passed: false, detail: { reason: e.message, files: [f] } };
          throw e;
        }
      }
      const r = await this.runTests(red.dir, testFiles, "red", red.extraRead);
      const g = await this.runTests(this.o.workdir, testFiles, "green");
      const passed = r.exitCode !== 0 && !r.timedOut && g.exitCode === 0 && !g.timedOut;
      return {
        passed,
        detail: { red: { exit_code: r.exitCode, output: tail(r.output) }, green: { exit_code: g.exitCode, output: tail(g.output) }, tests: testFiles, patched },
        logs: [
          { kind: "test_log", phase: "before", result: r.exitCode === 0 ? "pass" : "fail", content: r.output },
          { kind: "test_log", phase: "after", result: g.exitCode === 0 ? "pass" : "fail", content: g.output },
        ],
      };
    } finally {
      red.remove();
    }
  }

  // ── review ────────────────────────────────────────────────────────────

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

  private async review(req: VerifyRequest): Promise<Omit<CheckResult, "subject">> {
    if (!this.model) return { passed: false, detail: { reason: "no model is configured for review" } };
    const ask = this.reviewRequest(req);
    const out = await this.model.infer(ask);
    const cost = out.cost === "unknown" ? undefined : out.cost;
    // A judge is known by its model snapshot and its prompt (§10.2).
    const producer = { kind: "runtime", handler: VERIFIER_HANDLER, judge: { model: out.meta ?? null, prompt: sha256Of(String(ask.input)) } };
    const logs: CheckLog[] = [{ kind: "diff", content: String(ask.input) }];
    if (!("ok" in out)) return { passed: false, detail: { error: out.error as unknown as Value }, producer, logs, ...(cost ? { cost } : {}) };
    const v = isObj(out.ok) ? out.ok : {};
    logs.push({ kind: "review", result: v["blocking"] === false ? "pass" : "fail", content: JSON.stringify(out.ok, null, 2), mediaType: "application/json" });
    return { passed: v["blocking"] === false, detail: { blocking: v["blocking"] ?? null, findings: v["findings"] ?? [], model: out.meta ?? null }, producer, logs, ...(cost ? { cost } : {}) };
  }

  // ── sandboxes and copies ──────────────────────────────────────────────

  /**
   * A copy of the working copy without .git, to change and test. node_modules
   * is linked, not copied, and the sandbox may read it where it is. Links the
   * working copy holds are left out: a copy holds real files only.
   */
  private copy(prefix: string): { dir: string; extraRead: string[]; remove(): void } {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cpSync(this.o.workdir, dir, { recursive: true, filter: realEntries(this.o.workdir, /[\\/](\.git|node_modules)$/) });
    const modules = join(this.o.workdir, "node_modules");
    const extraRead: string[] = [];
    if (existsSync(modules)) {
      symlinkSync(modules, join(dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
      extraRead.push(modules);
    }
    return { dir, extraRead, remove: () => rmSync(dir, { recursive: true, force: true }) };
  }

  /** Runs tests in a new read-only sandbox over `dir`: it may read `dir` and run the test command, nothing else. */
  private async runTests(dir: string, patterns: string[], label: string, extraRead: string[] = []): Promise<TestRun> {
    const [command, ...prefix] = this.o.command ?? ["node", "--test"];
    const caps: CapVal[] = [
      { ctor: "fs.read", effect: "Fs.Read", write: false, scope: [dir, ...extraRead] } as CapVal,
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
    const b = this.gitBytes(args);
    return b === undefined ? undefined : b.toString("utf8");
  }

  private gitBytes(args: string[]): Buffer | undefined {
    if (!existsSync(join(this.o.workdir, ".git"))) return undefined;
    try {
      return execFileSync("git", ["-C", this.o.workdir, ...args], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
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
