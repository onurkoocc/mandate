// Evidence at the boundary between components (design doc 9 §4; BACKLOG item
// 33, B5). In a change that spans several repositories, the most valuable
// evidence is that the components work together; each repository's own
// tests are needed but not enough. The runtime checks, never the agents:
//
//   test.suite_each(components)        each component's own tests, as the change left
//                                      them (a behavior change updates its tests), with
//                                      the test files that differ from the base commit
//                                      named; files a configuration pins run as they
//                                      were at the base commit (K22)
//   test.contract(changes)             each interface's spec, at the base commit and
//                                      now, diffed by protocol; a change declared
//                                      additive that is breaking, or a change not
//                                      declared at all, is unmet
//   test.integration(env, components)  the system built from the candidate working
//                                      copies, run end to end on a container network
//                                      with no way out (K43); a host that cannot
//                                      enforce that is refused by name (INV-11)
//   test.ci(commits)                   the components' existing CI on those commits:
//                                      counts only when attested, or when the
//                                      verifier re-runs the tests itself (§4.3)
//   test.planned(plan)                 the change stays inside the approved plan (§3.4):
//                                      every component it touches, every path and every
//                                      interface it changes is one the plan names;
//                                      anything else is an `unplanned_change`
//
// Every check reports what it ran against: the files of every component's
// working copy, keyed `<component>/<path>`, so evidence binds to the bytes a
// change set will land (G01).

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { requirementFor, type CapVal } from "@mandate/compiler";
import type { CheckLog, CheckResult, CheckSubject, SystemFacts, VerifierAdapter, VerifyRequest } from "./adapters.js";
import { sha256Of } from "./artifacts.js";
import { MxcAdapter } from "./sandbox.js";
import { covers, diffMigrations, diffSpec, type ChangeKind } from "./specdiff.js";
import { isObj, plain, type Value } from "./values.js";
import { globRegExp } from "./verifier.js";

export const BOUNDARY_HANDLER = "mandate-boundary-verifier@0.3";

/** Directories linked, not copied, into a test copy, and readable where they are: dependencies. */
export const LINKED = ["node_modules", ".venv", "target"];

export interface IntegrationConfig {
  /** The directory the compose files are in; compose runs from here. */
  dir: string;
  /** Compose files, in order, relative to `dir`, e.g. base.yml, staging.yml, integration.yml. */
  files: string[];
  /** The service whose exit code is the result, e.g. `e2e`. */
  service: string;
  /** Component → the compose service built from its working copy. Default: the component's name. */
  services?: Record<string, string>;
  /** Variables for compose, e.g. { "ACME_ENV": "staging" }. */
  env?: Record<string, string>;
  /** Default 20 minutes. */
  timeoutMs?: number;
  /** The image the isolation probe runs. Default busybox:1.36. */
  probeImage?: string;
}

export interface CiConfig {
  /** `rerun` (default): an unattested CI result is re-run by the verifier. `attested`: only an attested result counts. */
  mode?: "attested" | "rerun";
  /** Reads CI results and attestations; GitHubCi by default. */
  source: CiSource;
}

/** What a CI system says about a commit. */
export interface CiRun {
  id: string;
  conclusion: "success" | "failure" | "cancelled" | "pending" | string;
  url?: string;
  /** Present when the run's result is attested (Actions OIDC, SLSA provenance, Sigstore) and the attestation verified. */
  attestation?: { verified: boolean; detail: string };
}

export interface CiSource {
  run(repo: string, commit: string): Promise<CiRun | undefined>;
}

/** Runs docker; tests pass a fake. */
export interface Docker {
  run(args: string[], o?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/** Where a component's tests usually live, by language: the files `test.suite_each` reports as changed from the base. */
const TESTS_BY_LANG: Record<string, string[]> = {
  ts: ["test/**", "tests/**", "**/*.test.ts", "**/*.spec.ts"],
  js: ["test/**", "tests/**", "**/*.test.js"],
  java: ["src/test/**"],
  py: ["tests/**", "test/**", "**/test_*.py"],
};

export interface BoundaryConfig {
  /**
   * Test files run as they were at the base commit, per component, as globs
   * relative to its root: tests that state what must not change (an
   * interface's acceptance tests). None by default: a component's own tests
   * are part of its change, and the boundary checks are what it cannot touch.
   */
  pinned?: Record<string, string[]>;
  /** Read-only paths a component's tests may also read (a toolchain, a dependency cache), per component. */
  extraRead?: Record<string, string[]>;
  timeoutMs?: number;
  integration?: IntegrationConfig;
  ci?: CiConfig;
}

export class BoundaryVerifier implements VerifierAdapter {
  private isolation: Promise<string | undefined> | undefined;

  constructor(
    private readonly o: BoundaryConfig,
    private readonly sandbox: MxcAdapter,
    private readonly docker: Docker = realDocker,
    /** Checks this verifier does not know (test.suite, review, …). */
    private readonly inner?: VerifierAdapter,
  ) {}

  async upperBound(req: VerifyRequest) {
    return this.inner?.upperBound?.(req);
  }

  async check(req: VerifyRequest): Promise<CheckResult> {
    const sys = req.system;
    const boundary = ["test.suite_each", "test.contract", "test.integration", "test.ci", "test.planned"].includes(req.method);
    if (!boundary) return this.inner ? this.inner.check(req) : { passed: false, detail: { unsupported: `the verifier has no method ${req.method}` } };
    if (!sys) return { passed: false, detail: { reason: `${req.method} needs the run's system model and workspace (design doc 9 §4)` }, producer: this.producer() };
    const subject = snapshot(sys);
    const r = await this.run(req, sys);
    return { producer: this.producer(), ...r, subject };
  }

  private producer(): Value {
    return { kind: "runtime", handler: BOUNDARY_HANDLER, sandbox: `mxc:${this.sandbox.o.isolation ?? "process"}`, adapter: MxcAdapter.ID };
  }

  private run(req: VerifyRequest, sys: SystemFacts): Promise<Omit<CheckResult, "subject">> {
    switch (req.method) {
      case "test.suite_each":
        return this.suiteEach(names(req.args[0]), sys);
      case "test.contract":
        return this.contract(req.args[0] ?? null, sys);
      case "test.integration":
        return this.integration(names(req.args[req.args.length - 1]), sys, req.named["env"] ?? req.args[0] ?? null);
      case "test.planned":
        return Promise.resolve(this.planned(req.args[0] ?? null, sys));
      default:
        return this.ci(req.args[0] ?? null, sys);
    }
  }

  // ── test.suite_each ───────────────────────────────────────────────────

  private async suiteEach(list: string[], sys: SystemFacts): Promise<Omit<CheckResult, "subject">> {
    if (!list.length) return { passed: false, detail: { reason: "test.suite_each names no components" } };
    const runs: Value[] = [];
    const logs: CheckLog[] = [];
    let passed = true;
    for (const name of list) {
      const c = sys.components[name];
      if (!c || !c.test.length) {
        runs.push({ component: name, error: c ? "the component declares no test commands" : "not a component of the system" });
        passed = false;
        continue;
      }
      const r = await this.componentTests(name, sys, c.base);
      runs.push({ component: name, passed: r.passed, exit_codes: r.exitCodes, ...(Object.keys(r.pinned).length ? { pinned: r.pinned } : {}), ...(r.modified.length ? { changed_in_working_copy: r.modified } : {}), ...(r.testsChanged.length ? { tests_changed: r.testsChanged } : {}), output: tail(r.output) });
      logs.push({ kind: "test_log", phase: name, result: r.passed ? "pass" : "fail", content: r.output });
      passed &&= r.passed;
    }
    return { passed, detail: { runs }, logs };
  }

  /**
   * A component's declared test commands, in a read-only sandbox over a copy
   * of its working copy. Files the configuration pins are the base commit's:
   * an agent that weakened, deleted or added one changes nothing about what
   * runs (G06). The test files the change touched are named in the evidence.
   */
  private async componentTests(name: string, sys: SystemFacts, base: string | null, from?: string): Promise<{ passed: boolean; exitCodes: number[]; pinned: Record<string, string>; modified: string[]; testsChanged: string[]; output: string }> {
    const c = sys.components[name]!;
    const copy = copyOf(from ?? c.root, "mandate-each-");
    try {
      const pinned: Record<string, string> = {};
      const modified: string[] = [];
      const testsChanged: string[] = [];
      if (base) {
        const testGlobs = (TESTS_BY_LANG[c.lang] ?? []).map(globRegExp);
        const changed = git(c.root, ["diff", "--name-only", base, "--"])?.toString("utf8").split("\n").filter(Boolean) ?? [];
        const added = git(c.root, ["ls-files", "--others", "--exclude-standard"])?.toString("utf8").split("\n").filter(Boolean) ?? [];
        testsChanged.push(...[...new Set([...changed, ...added])].filter((f) => testGlobs.some((g) => g.test(f))).sort());
        const globs = (this.o.pinned?.[name] ?? []).map(globRegExp);
        const listed = globs.length ? git(c.root, ["ls-tree", "-r", "--name-only", base]) : Buffer.from("");
        if (listed === undefined) return { passed: false, exitCodes: [125], pinned, modified, testsChanged, output: `${name}'s tests are pinned to ${base}, which its working copy does not have` };
        for (const f of listed.toString("utf8").split("\n").filter((f) => f && globs.some((g) => g.test(f)))) {
          const content = git(c.root, ["show", `${base}:${f}`])!;
          pinned[f] = sha256Of(content);
          const here = join(from ?? c.root, f);
          if (!existsSync(here) || sha256Of(readFileSync(here)) !== pinned[f]) modified.push(f);
          mkdirSync(dirname(join(copy.dir, f)), { recursive: true });
          writeFileSync(join(copy.dir, f), content);
        }
      }
      const exitCodes: number[] = [];
      let output = "";
      for (const cmd of c.test) {
        const caps: CapVal[] = [
          { ctor: "fs.read", effect: "Fs.Read", write: false, scope: [copy.dir, ...copy.extraRead, ...(this.o.extraRead?.[name] ?? [])] } as CapVal,
          { ctor: "exec", effect: "Exec", write: false, scope: [cmd.command], argsPrefix: [cmd.args] } as CapVal,
        ];
        const planned = await this.sandbox.plan(requirementFor({ agent: "verifier", def: `test ${name}` }, caps, this.o.timeoutMs ?? 600_000));
        if ("unsupported" in planned) return { passed: false, exitCodes: [126], pinned, modified, testsChanged, output: `the verifier's sandbox was refused: ${planned.unsupported.join("; ")}` };
        const host = this.sandbox.o.host;
        const handle = await host.create(planned.policy);
        try {
          const r = await host.execute(handle, { argv: [cmd.command, ...cmd.args], cwd: copy.dir });
          exitCodes.push(r.timedOut ? 124 : r.exitCode);
          output += `$ ${[cmd.command, ...cmd.args].join(" ")}\n${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}\n`;
          if (r.exitCode !== 0 || r.timedOut) break;
        } finally {
          await host.destroy(handle);
        }
      }
      return { passed: exitCodes.length === c.test.length && exitCodes.every((x) => x === 0), exitCodes, pinned, modified, testsChanged, output };
    } finally {
      copy.remove();
    }
  }

  // ── test.planned ──────────────────────────────────────────────────────

  /**
   * The plan names what may change: `components` (a list), `changes`
   * (interface → kind) and, when it narrows them, `paths` (component →
   * globs relative to its root). A component touched outside the list, a
   * file outside its globs or an interface whose spec changed without being
   * named is an `unplanned_change`; the criterion is unmet (doc 9 §3.4).
   * Components the plan names and the change left alone are reported, not
   * refused.
   */
  private planned(planArg: Value, sys: SystemFacts): Omit<CheckResult, "subject"> {
    // The plan arrives verified: its evidence travels with it, and only its fields matter here.
    const bare = plain(planArg);
    const plan = isObj(bare) ? bare : {};
    const listed = Array.isArray(plan["components"]) ? plan["components"].filter((c): c is string => typeof c === "string") : undefined;
    const changes = isObj(plan["changes"] ?? null) ? (plan["changes"] as Record<string, Value>) : {};
    const paths = isObj(plan["paths"] ?? null) ? (plan["paths"] as Record<string, Value>) : {};
    if (!listed) return { passed: false, detail: { reason: "test.planned needs the plan's components (a list of component names)" } };
    const components: Value[] = [];
    const unplanned: Value[] = [];
    for (const [name, c] of Object.entries(sys.components).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!c.base) continue; // not part of this run's workspace
      const changed = git(c.root, ["diff", "--name-only", c.base, "--"])?.toString("utf8").split("\n").filter(Boolean) ?? [];
      const added = git(c.root, ["ls-files", "--others", "--exclude-standard"])?.toString("utf8").split("\n").filter(Boolean) ?? [];
      const touched = [...new Set([...changed, ...added])].sort();
      const inPlan = listed.includes(name);
      components.push({ component: name, planned: inPlan, files: touched });
      if (touched.length && !inPlan) unplanned.push({ problem: "unplanned_change", component: name, files: touched, detail: `${name} changed, and the plan does not name it` });
      const globs = Array.isArray(paths[name]) ? (paths[name] as Value[]).filter((g): g is string => typeof g === "string").map(globRegExp) : undefined;
      const outside = inPlan && globs ? touched.filter((f) => !globs.some((g) => g.test(f))) : [];
      if (outside.length) unplanned.push({ problem: "unplanned_change", component: name, files: outside, detail: `${name} changed files outside the plan's paths` });
    }
    const interfaces: Value[] = [];
    for (const [iface, i] of Object.entries(sys.interfaces).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const p = i.provider ? sys.components[i.provider] : undefined;
      if (!p?.base) continue;
      let kind: ChangeKind;
      try {
        kind = measure(i.protocol, i.spec, p.root, p.base).kind;
      } catch (e) {
        interfaces.push({ interface: iface, provider: i.provider, error: (e as Error).message });
        unplanned.push({ problem: "unreadable_spec", interface: iface, detail: (e as Error).message });
        continue;
      }
      if (kind === "none") continue;
      const named = iface in changes;
      interfaces.push({ interface: iface, provider: i.provider, measured: kind, planned: named ? String(changes[iface]) : null });
      if (!named) unplanned.push({ problem: "unplanned_change", interface: iface, provider: i.provider, measured: kind, detail: `${iface} changed (${kind}), and the plan does not name it` });
    }
    return { passed: unplanned.length === 0, detail: { components, interfaces, ...(unplanned.length ? { unplanned } : {}) } };
  }

  // ── test.contract ─────────────────────────────────────────────────────

  /**
   * Every interface whose provider the run works on, at the base commit and
   * now. `declared` maps interface → additive | breaking | none, what the plan
   * says; an interface it does not name is declared `none`. Unmet: a change
   * understated (`breaking_change_undeclared`, `change_undeclared`) or a spec
   * that cannot be read.
   */
  private async contract(declaredArg: Value, sys: SystemFacts): Promise<Omit<CheckResult, "subject">> {
    const declared: Record<string, ChangeKind> = {};
    if (isObj(declaredArg)) for (const [k, v] of Object.entries(declaredArg)) declared[k] = v === "additive" || v === "breaking" ? v : "none";
    const results: Value[] = [];
    const logs: CheckLog[] = [];
    let passed = true;
    for (const [iface, i] of Object.entries(sys.interfaces).sort(([a], [b]) => (a < b ? -1 : 1))) {
      const p = i.provider ? sys.components[i.provider] : undefined;
      if (!p || !p.base) continue; // not part of this run's workspace
      const want = declared[iface] ?? "none";
      let measured: { kind: ChangeKind; changes: string[] };
      try {
        measured = measure(i.protocol, i.spec, p.root, p.base);
      } catch (e) {
        results.push({ interface: iface, provider: i.provider, declared: want, error: (e as Error).message });
        passed = false;
        continue;
      }
      const ok = covers(want, measured.kind);
      const problem = ok ? undefined : measured.kind === "breaking" ? "breaking_change_undeclared" : "change_undeclared";
      results.push({ interface: iface, provider: i.provider, protocol: i.protocol, declared: want, measured: measured.kind, ...(problem ? { problem } : {}), changes: measured.changes });
      if (measured.changes.length) logs.push({ kind: "diff", phase: iface, result: ok ? "pass" : "fail", content: measured.changes.join("\n") + "\n" });
      passed &&= ok;
    }
    for (const k of Object.keys(declared)) if (!sys.interfaces[k]) results.push({ interface: k, error: "not an interface of the system" });
    return { passed, detail: { interfaces: results }, logs };
  }

  // ── test.integration ──────────────────────────────────────────────────

  /**
   * The system built from the candidate working copies and run end to end
   * (doc 9 §4.5; K43). Every network of the environment is internal: the
   * services reach each other and nothing else. The host is probed first: if
   * an internal network can still reach out, or compose's configuration
   * publishes a port or names a network that is not internal, the check is
   * refused by name and nothing runs.
   */
  private async integration(list: string[], sys: SystemFacts, env: Value): Promise<Omit<CheckResult, "subject">> {
    const cfg = this.o.integration;
    if (!cfg) return { passed: false, detail: { reason: "no integration environment is configured" } };
    const refused = await (this.isolation ??= this.probe(cfg));
    if (refused) return { passed: false, detail: { refused: "integration_isolation", reason: refused } };
    const project = `mandate-it-${sha256Of(JSON.stringify([list, sys.components, Date.now()])).slice(7, 19)}`;
    const work = mkdtempSync(join(tmpdir(), "mandate-it-"));
    const files = [...cfg.files.map((f) => join(cfg.dir, f)), join(work, "mandate.yml")];
    const compose = (args: string[], timeoutMs?: number) =>
      this.docker.run(["compose", "-p", project, ...files.flatMap((f) => ["-f", f]), ...args], { cwd: cfg.dir, env: { ...(cfg.env ?? {}), ...(typeof env === "string" ? { MANDATE_ENV: env } : {}) }, ...(timeoutMs ? { timeoutMs } : {}) });
    try {
      // Each component's service is built from its working copy as the run left it, under an image name of this project's.
      const services: Record<string, Value> = {};
      for (const [name, c] of Object.entries(sys.components)) {
        if (!c.base) continue;
        const svc = cfg.services?.[name] ?? name;
        services[svc] = { image: `${project}-${svc}`, build: { context: c.root.replace(/\\/g, "/") } };
      }
      writeFileSync(join(work, "mandate.yml"), JSON.stringify({ services, networks: { default: { internal: true } } }, null, 2));
      const config = await compose(["config", "--format", "json"]);
      if (config.exitCode !== 0) return { passed: false, detail: { reason: "compose could not read the environment", output: tail(config.stderr) } };
      const leak = leaks(config.stdout);
      if (leak) return { passed: false, detail: { refused: "integration_isolation", reason: leak } };
      const build = await compose(["build", "--quiet"], cfg.timeoutMs ?? 1_200_000);
      if (build.exitCode !== 0) return { passed: false, detail: { project, reason: "the environment did not build", output: tail(build.stderr) }, logs: [{ kind: "test_log", phase: "build", result: "fail", content: `${build.stdout}\n${build.stderr}` }] };
      // `run` starts what the end-to-end service depends on (healthy services, finished seeds) and returns its exit code.
      const run = await compose(["run", "--rm", cfg.service], cfg.timeoutMs ?? 1_200_000);
      const output = `${run.stdout}${run.stderr ? `\n${run.stderr}` : ""}`;
      return {
        passed: run.exitCode === 0,
        detail: { project, service: cfg.service, exit_code: run.exitCode, components: list, built_from: Object.keys(services).sort(), output: tail(output) },
        logs: [{ kind: "test_log", phase: "integration", result: run.exitCode === 0 ? "pass" : "fail", content: output }],
      };
    } finally {
      await compose(["down", "-v", "--remove-orphans", "--rmi", "local"]).catch(() => undefined);
      rmSync(work, { recursive: true, force: true });
    }
  }

  /** Can an internal network on this host reach out? Refused if it can, or if the probe cannot tell. */
  private async probe(cfg: IntegrationConfig): Promise<string | undefined> {
    const net = `mandate-probe-${Math.random().toString(36).slice(2, 10)}`;
    const made = await this.docker.run(["network", "create", "--internal", net]);
    if (made.exitCode !== 0) return `cannot create an internal container network: ${tail(made.stderr, 300)}`;
    try {
      const image = cfg.probeImage ?? "busybox:1.36";
      // Reaching a public address by IP and by name must both fail on an internal network.
      const out = await this.docker.run(["run", "--rm", "--network", net, image, "sh", "-c", "wget -q -T 3 -O /dev/null http://1.1.1.1/ && echo REACHED; nslookup example.com >/dev/null 2>&1 && echo RESOLVED; echo PROBED"], { timeoutMs: 60_000 });
      if (!out.stdout.includes("PROBED")) return `the isolation probe did not run: ${tail(out.stderr, 300)}`;
      if (out.stdout.includes("REACHED") || out.stdout.includes("RESOLVED")) return "an internal network on this host can still reach the outside";
      return undefined;
    } finally {
      await this.docker.run(["network", "rm", net]);
    }
  }

  // ── test.ci ───────────────────────────────────────────────────────────

  /**
   * The components' existing CI on the given commits (`{ component: sha }`).
   * A CI result is the CI's word, untrusted by default (§4.3, K21): it counts
   * only when attested and the attestation verified; otherwise, in `rerun`
   * mode, the verifier checks out that commit and runs the component's tests
   * itself, and that is the evidence. An unattested result alone is shown
   * and does not meet the criterion.
   */
  private async ci(commitsArg: Value, sys: SystemFacts): Promise<Omit<CheckResult, "subject">> {
    const cfg = this.o.ci;
    if (!cfg) return { passed: false, detail: { reason: "no CI source is configured" } };
    const commits = isObj(commitsArg) ? Object.entries(commitsArg).filter((e): e is [string, string] => typeof e[1] === "string") : [];
    if (!commits.length) return { passed: false, detail: { reason: "test.ci takes { component: commit }" } };
    const results: Value[] = [];
    const logs: CheckLog[] = [];
    let passed = true;
    for (const [name, sha] of commits.sort(([a], [b]) => (a < b ? -1 : 1))) {
      const c = sys.components[name];
      if (!c) {
        results.push({ component: name, error: "not a component of the system" });
        passed = false;
        continue;
      }
      const run = await cfg.source.run(c.repo, sha);
      const shown = run ? { ci_run: run.id, conclusion: run.conclusion, ...(run.url ? { url: run.url } : {}) } : { ci_run: null };
      if (run?.attestation?.verified && run.conclusion === "success") {
        results.push({ component: name, commit: sha, ...shown, met_by: "attested_ci", attestation: run.attestation.detail });
        continue;
      }
      if ((cfg.mode ?? "rerun") === "attested") {
        results.push({ component: name, commit: sha, ...shown, met_by: null, problem: run ? "ci_unattested" : "no_ci_run" });
        passed = false;
        continue;
      }
      // Re-run: the verifier's own run at that commit is the evidence; the CI's answer is shown beside it.
      const tree = checkout(c.root, sha);
      if (!tree) {
        results.push({ component: name, commit: sha, ...shown, met_by: null, problem: "commit_not_found" });
        passed = false;
        continue;
      }
      try {
        const r = await this.componentTests(name, sys, null, tree.dir);
        results.push({ component: name, commit: sha, ...shown, met_by: r.passed ? "verifier_rerun" : null, rerun_exit_codes: r.exitCodes });
        logs.push({ kind: "test_log", phase: `${name}@${sha.slice(0, 12)}`, result: r.passed ? "pass" : "fail", content: r.output });
        passed &&= r.passed;
      } finally {
        tree.remove();
      }
    }
    return { passed, detail: { commits: results }, logs };
  }
}

/** Every component's working copy as it is now, keyed `<component>/<path>` (G01). */
export function snapshot(sys: SystemFacts): CheckSubject {
  const files: Record<string, string> = {};
  for (const [name, c] of Object.entries(sys.components).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!c.base || !existsSync(c.root)) continue;
    const walk = (dir: string, rel: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (e.name === ".git" || LINKED.includes(e.name)) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else if (e.isFile()) files[`${name}/${r}`] = sha256Of(readFileSync(join(dir, e.name)));
      }
    };
    walk(c.root, "");
  }
  return { files };
}

/** An interface's change between `base` and the working copy at `root`. */
export function measure(protocol: string, spec: string, root: string, base: string): { kind: ChangeKind; changes: string[] } {
  if (protocol === "db_schema") {
    const at = (listing: string[] | undefined, read: (f: string) => string | undefined): Record<string, string> =>
      Object.fromEntries((listing ?? []).flatMap((f) => {
        const s = read(f);
        return s === undefined ? [] : [[f, s]];
      }));
    const before = at(git(root, ["ls-tree", "-r", "--name-only", base, "--", spec])?.toString("utf8").split("\n").filter(Boolean), (f) => git(root, ["show", `${base}:${f}`])?.toString("utf8"));
    const nowDir = join(root, spec);
    const now = existsSync(nowDir) ? at(listFiles(nowDir).map((f) => `${spec.replace(/\/$/, "")}/${f}`), (f) => readFileSync(join(root, f), "utf8")) : {};
    if (!Object.keys(before).length && !Object.keys(now).length) throw new Error(`${spec} has no migrations at ${base} or now`);
    return diffMigrations(before, now);
  }
  const was = git(root, ["show", `${base}:${spec}`]);
  const path = join(root, spec);
  const is = existsSync(path) ? readFileSync(path) : undefined;
  if (!was && !is) throw new Error(`${spec} exists neither at ${base} nor in the working copy`);
  if (!was) return { kind: "additive", changes: [`+ ${spec} added`] };
  if (!is) return { kind: "breaking", changes: [`! ${spec} removed`] };
  return diffSpec(protocol, JSON.parse(was.toString("utf8")), JSON.parse(is.toString("utf8")));
}

/** A published port or a network that is not internal, in `docker compose config --format json` output. */
export function leaks(configJson: string): string | undefined {
  let cfg: { services?: Record<string, { ports?: unknown[]; network_mode?: string }>; networks?: Record<string, { internal?: boolean; external?: boolean }> };
  try {
    cfg = JSON.parse(configJson) as typeof cfg;
  } catch {
    return "compose's configuration could not be read";
  }
  for (const [name, s] of Object.entries(cfg.services ?? {})) {
    if (s.ports?.length) return `service ${name} publishes ports`;
    if (s.network_mode && s.network_mode !== "none") return `service ${name} uses network mode ${s.network_mode}`;
  }
  for (const [name, n] of Object.entries(cfg.networks ?? {})) if (n.internal !== true || n.external) return `network ${name} is not internal`;
  return undefined;
}

function names(v: Value | undefined): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (isObj(v ?? null)) return Object.keys(v as Record<string, Value>).sort();
  return typeof v === "string" ? [v] : [];
}

function listFiles(dir: string, rel = ""): string[] {
  return readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(dir, rel ? `${rel}/${e.name}` : e.name) : e.isFile() ? [rel ? `${rel}/${e.name}` : e.name] : []));
}

/** A copy of a working copy without .git; dependency directories are linked and stay readable where they are. */
function copyOf(src: string, prefix: string): { dir: string; extraRead: string[]; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cpSync(src, dir, { recursive: true, filter: (p) => !new RegExp(`[\\\\/](\\.git|${LINKED.map((l) => l.replace(".", "\\.")).join("|")})$`).test(p) });
  const extraRead: string[] = [];
  for (const l of LINKED) {
    const there = join(src, l);
    if (!existsSync(there)) continue;
    symlinkSync(there, join(dir, l), process.platform === "win32" ? "junction" : "dir");
    extraRead.push(there);
  }
  return { dir, extraRead, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The tree of `commit` from the repository at `root`, in a temporary directory; undefined if the commit is not there. */
export function checkout(root: string, commit: string): { dir: string; remove(): void } | undefined {
  if (git(root, ["cat-file", "-e", `${commit}^{commit}`]) === undefined) {
    git(root, ["fetch", "--quiet", "origin", commit]);
    if (git(root, ["cat-file", "-e", `${commit}^{commit}`]) === undefined) return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "mandate-ci-"));
  const archive = git(root, ["archive", "--format=tar", commit]);
  if (!archive) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  execFileSync("tar", ["-x", "-C", dir], { input: archive });
  for (const l of LINKED) if (existsSync(join(root, l))) symlinkSync(join(root, l), join(dir, l), process.platform === "win32" ? "junction" : "dir");
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export function git(root: string, args: string[]): Buffer | undefined {
  if (!existsSync(join(root, ".git"))) return undefined;
  try {
    return execFileSync("git", ["-c", "core.autocrlf=false", "-C", root, ...args], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
}

export function tail(text: string, max = 4000): string {
  return text.length > max ? `…${text.slice(-max)}` : text;
}

/**
 * GitHub Actions as a CI source: the latest completed workflow run for a
 * commit. Verifying an attestation of its result (Actions OIDC, SLSA
 * provenance, Sigstore) is the job of `attest`, when one is configured; a
 * result without a verified attestation is reported unattested.
 */
export class GitHubCi implements CiSource {
  constructor(
    private readonly o: {
      token: string;
      /** Only runs of this workflow (its name or file) count. Default: any. */
      workflow?: string;
      attest?: (repo: string, run: { id: string; url: string }) => Promise<{ verified: boolean; detail: string } | undefined>;
      fetch?: typeof fetch;
      apiUrl?: string;
    },
  ) {}

  async run(repo: string, commit: string): Promise<CiRun | undefined> {
    const res = await (this.o.fetch ?? fetch)(`${this.o.apiUrl ?? "https://api.github.com"}/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(commit)}&per_page=50`, {
      headers: { accept: "application/vnd.github+json", authorization: `Bearer ${this.o.token}`, "x-github-api-version": "2022-11-28" },
    });
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status} for ${repo}'s CI runs`);
    const runs = ((await res.json()) as { workflow_runs?: Array<{ id: number; name?: string; path?: string; status: string; conclusion: string | null; html_url: string; created_at: string }> }).workflow_runs ?? [];
    const run = runs
      .filter((r) => r.status === "completed" && (!this.o.workflow || r.name === this.o.workflow || r.path?.endsWith(this.o.workflow)))
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];
    if (!run) return undefined;
    const attestation = this.o.attest ? await this.o.attest(repo, { id: String(run.id), url: run.html_url }) : undefined;
    return { id: String(run.id), conclusion: run.conclusion ?? "pending", url: run.html_url, ...(attestation ? { attestation } : {}) };
  }
}

/** docker on this host, through its CLI. */
export const realDocker: Docker = {
  run: (args, o = {}) =>
    new Promise((resolve) => {
      import("node:child_process").then(({ execFile }) => {
        execFile("docker", args, { cwd: o.cwd, env: { ...process.env, ...(o.env ?? {}) }, timeout: o.timeoutMs ?? 0, maxBuffer: 64 << 20, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
          resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) });
        });
      });
    }),
};
