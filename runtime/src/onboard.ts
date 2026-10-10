// Onboarding and drift (design doc 9 §7; BACKLOG item 35, B7). Taking an
// existing system into Mandate means describing it, not rewriting it. The
// scanner reads each repository and drafts what it can see:
//
//   language and commands   from package.json, pom.xml, pyproject.toml / requirements.txt
//   provided interfaces     spec files by convention: docs/openapi.json, docs/mcp-tools.json,
//                           docs/oauth-metadata.json, a Flyway migration directory
//   consumed interfaces     evidence in the code: another component's host in a URL or in a
//                           host setting's default, outside tests, with file and line
//   owners                  CODEOWNERS
//
// What it finds is a draft, never the system's truth (INV-04): an onboarding
// program has it checked (specs exist and parse, consumption is backed by
// code) and accepted by a person before it becomes the model. The same scan,
// run against an accepted model later, finds drift: what the repositories do
// that the model does not say, and what the model says that they no longer do.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { check, requirementFor, type CapVal, type Command, type Def, type Program } from "@mandate/compiler";
import type { CheckLog, CheckResult, SystemFacts, VerifierAdapter, VerifyRequest } from "./adapters.js";
import { checkout, git, LINKED, snapshot, tail } from "./boundary.js";
import type { MxcAdapter } from "./sandbox.js";
import type { Value } from "./values.js";

export interface Evidence {
  file: string;
  line: number;
  text: string;
}

export interface RepoFacts {
  component: string;
  root: string;
  lang: string;
  build: Command[];
  test: Command[];
  /** Spec files the repository holds, by convention. */
  specs: Array<{ protocol: "openapi" | "mcp_tools" | "oauth" | "db_schema"; spec: string }>;
  /** Other components the code refers to, with where. */
  refers: Array<{ component: string; protocol: "openapi" | "mcp_tools" | "oauth" | "unknown"; evidence: Evidence }>;
  /** The owners CODEOWNERS names for the whole repository. */
  owners: string[];
}

const SPEC_FILES: Array<{ protocol: RepoFacts["specs"][number]["protocol"]; spec: string }> = [
  { protocol: "oauth", spec: "docs/oauth-metadata.json" },
  { protocol: "mcp_tools", spec: "docs/mcp-tools.json" },
  { protocol: "openapi", spec: "docs/openapi.json" },
  { protocol: "db_schema", spec: "src/main/resources/db/migration" },
];

const SOURCE = /\.(ts|js|mjs|java|py|kt|go|ya?ml|properties)$/;
const SKIPPED = new Set(["node_modules", ".git", "dist", "target", ".venv", "__pycache__", "data", "test", "tests", "docs", ".github"]);

/** Reads a repository: what it builds and tests with, what it provides, whom it calls. `hosts` maps a network name to a component. */
export function scan(component: string, root: string, hosts: Record<string, string>): RepoFacts {
  const facts: RepoFacts = { component, root, lang: "unknown", build: [], test: [], specs: [], refers: [], owners: [] };
  const pkg = readJson(join(root, "package.json")) as { scripts?: Record<string, string> } | undefined;
  if (pkg) {
    facts.lang = existsSync(join(root, "tsconfig.json")) ? "ts" : "js";
    if (pkg.scripts?.["build"]) facts.build.push({ command: "npm", args: ["ci", "--ignore-scripts"] }, { command: "npm", args: ["run", "build"] });
    if (pkg.scripts?.["test"]) facts.test.push({ command: "npm", args: ["test"] });
  } else if (existsSync(join(root, "pom.xml"))) {
    facts.lang = "java";
    facts.build.push({ command: "mvn", args: ["-B", "-q", "-o", "-DskipTests", "package"] });
    facts.test.push({ command: "mvn", args: ["-B", "-q", "-o", "test"] });
  } else if (existsSync(join(root, "pyproject.toml")) || existsSync(join(root, "requirements.txt"))) {
    facts.lang = "py";
    facts.test.push({ command: "python", args: ["-m", "pytest", "-q"] });
  }
  for (const s of SPEC_FILES) {
    const p = join(root, s.spec);
    if (existsSync(p) && (s.protocol === "db_schema" ? statSync(p).isDirectory() : statSync(p).isFile())) facts.specs.push(s);
  }
  for (const f of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const text = existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : "";
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === "*" && parts.length > 1) facts.owners = parts.slice(1);
    }
  }
  const self = Object.entries(hosts).filter(([, c]) => c === component).map(([h]) => h);
  for (const file of sources(root)) {
    readFileSync(file, "utf8").split("\n").forEach((text, i) => {
      for (const [host, target] of Object.entries(hosts)) {
        if (target === component || self.includes(host)) continue;
        // A URL to the host, or the host as a quoted default of a host or URL setting.
        const url = new RegExp(`https?://${escape(host)}(:\\d+)?([/"'\`\\s]|$)`).exec(text);
        const setting = !url && new RegExp(`(HOST|URL|ISSUER|ENDPOINT)[A-Z_]*[^\\n]*["'\`]${escape(host)}["'\`]`).test(text);
        if (!url && !setting) continue;
        const path = url ? text.slice(url.index + url[0].length - 1) : "";
        const protocol = /jwks|token|issuer/i.test(text) ? "oauth" : /\/mcp\b/.test(path) || /MCP_/.test(text) ? "mcp_tools" : url ? "openapi" : "unknown";
        facts.refers.push({ component: target, protocol, evidence: { file: relative(root, file).replace(/\\/g, "/"), line: i + 1, text: text.trim().slice(0, 160) } });
      }
    });
  }
  return facts;
}

const NAMES: Record<string, string> = { openapi: "Api", mcp_tools: "Tools", oauth: "Tokens", db_schema: "Schema" };

/** The interface a scanned repository provides for a spec: named after the component and its protocol. */
function interfaceName(component: string, protocol: string): string {
  return component.replace(/(^|[-_])(\w)/g, (_m, _s, c: string) => c.toUpperCase()) + NAMES[protocol]!;
}

/**
 * A draft system model from scanned repositories, as a 0.3 module. Interface
 * names are made up (a person renames them); owners come from CODEOWNERS or
 * are left `unassigned`. Each consumed interface is backed by evidence.
 */
export function draft(facts: RepoFacts[], o: { module: string; version?: string; repos: Record<string, string>; roots: Record<string, string> }): Program {
  const defs: Record<string, Def> = {};
  const provided = new Map<string, Array<{ name: string; protocol: string }>>();
  for (const f of facts) {
    const mine = f.specs.map((s) => ({ name: interfaceName(f.component, s.protocol), protocol: s.protocol }));
    provided.set(f.component, mine);
    for (const s of f.specs) defs[interfaceName(f.component, s.protocol)] = { kind: "interface", protocol: s.protocol, spec: s.spec };
  }
  for (const f of facts) {
    const consumes = new Set<string>();
    for (const r of f.refers) {
      const theirs = (provided.get(r.component) ?? []).filter((i) => i.protocol !== "db_schema");
      const match = theirs.find((i) => i.protocol === r.protocol) ?? (theirs.length === 1 ? theirs[0] : undefined);
      if (match) consumes.add(match.name);
    }
    const mine = provided.get(f.component) ?? [];
    defs[f.component] = {
      kind: "component",
      repo: o.repos[f.component] ?? `unknown/${f.component}`,
      root: o.roots[f.component] ?? `/work/${f.component}`,
      lang: f.lang === "unknown" ? "other" : f.lang,
      owner: f.owners[0]?.replace(/^@/, "") ?? "unassigned",
      ...(f.build.length ? { build: f.build } : {}),
      ...(f.test.length ? { test: f.test } : {}),
      ...(mine.length ? { provides: mine.map((i) => i.name).sort() } : {}),
      ...(consumes.size ? { consumes: [...consumes].sort() } : {}),
    };
  }
  return { language: "mandate/0.3", module: o.module, version: o.version ?? "0.1", defs };
}

export interface DriftFinding {
  kind: "missing_repository" | "lang_differs" | "spec_missing" | "spec_unreadable" | "unmodelled_interface" | "undeclared_dependency" | "unsupported_consumes" | "commands_differ";
  /** `drift`: the model and the repositories disagree; `warning`: the model claims what the code does not show (best effort, doc 9 §7). */
  severity: "drift" | "warning";
  component: string;
  detail: string;
  evidence?: Evidence[];
}

/**
 * Where an accepted system model and the repositories disagree (doc 9 §7
 * step 5). `defs` are the model's definitions; `facts` the scan of each
 * component's working copy, by component.
 */
export function drift(defs: Record<string, Def>, facts: Record<string, RepoFacts>): DriftFinding[] {
  const out: DriftFinding[] = [];
  const components = Object.entries(defs).filter((x): x is [string, Extract<Def, { kind: "component" }>] => x[1].kind === "component").sort(([a], [b]) => (a < b ? -1 : 1));
  const interfaces = Object.entries(defs).filter((x): x is [string, Extract<Def, { kind: "interface" }>] => x[1].kind === "interface");
  const providerOf = (i: string): string | undefined => components.find(([, c]) => c.provides?.includes(i))?.[0];
  for (const [name, c] of components) {
    const f = facts[name];
    if (!f) {
      out.push({ kind: "missing_repository", severity: "drift", component: name, detail: `no working copy of ${name} (${c.repo}) was scanned` });
      continue;
    }
    if (f.lang !== c.lang && !(f.lang === "js" && c.lang === "ts")) out.push({ kind: "lang_differs", severity: "drift", component: name, detail: `the model says ${c.lang}, the repository is ${f.lang}` });
    const cmds = (x: Command[] | undefined) => JSON.stringify((x ?? []).map((k) => [k.command, ...k.args].join(" ")));
    if (f.test.length && cmds(c.test) !== cmds(f.test)) out.push({ kind: "commands_differ", severity: "warning", component: name, detail: `the model tests with ${cmds(c.test)}, the repository's convention is ${cmds(f.test)}` });
    for (const i of c.provides ?? []) {
      const d = interfaces.find(([n]) => n === i)?.[1];
      if (!d) continue;
      const p = join(f.root, d.spec);
      if (!existsSync(p)) out.push({ kind: "spec_missing", severity: "drift", component: name, detail: `${i}'s spec ${d.spec} is not in ${name}'s repository` });
      else if (d.protocol !== "db_schema" && readJson(p) === undefined) out.push({ kind: "spec_unreadable", severity: "drift", component: name, detail: `${i}'s spec ${d.spec} does not parse` });
    }
    for (const s of f.specs) {
      if (!interfaces.some(([n, d]) => d.spec === s.spec && providerOf(n) === name)) out.push({ kind: "unmodelled_interface", severity: "drift", component: name, detail: `${name} holds a ${s.protocol} spec, ${s.spec}, that no interface of the model names` });
    }
    // What the code calls that the model does not say.
    const consumedFrom = new Set((c.consumes ?? []).map(providerOf).filter((p): p is string => !!p));
    const byTarget = new Map<string, Evidence[]>();
    for (const r of f.refers) byTarget.set(r.component, [...(byTarget.get(r.component) ?? []), r.evidence]);
    for (const [target, ev] of [...byTarget.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (!consumedFrom.has(target)) out.push({ kind: "undeclared_dependency", severity: "drift", component: name, detail: `${name} refers to ${target} in its code, and the model has ${name} consume nothing ${target} provides`, evidence: ev });
    }
    // What the model says that the code does not show.
    for (const i of c.consumes ?? []) {
      const p = providerOf(i);
      if (p && !byTarget.has(p)) out.push({ kind: "unsupported_consumes", severity: "warning", component: name, detail: `the model has ${name} consume ${i} from ${p}, and ${name}'s code does not refer to ${p}` });
    }
  }
  return out;
}

function sources(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (e.isDirectory()) {
        if (!SKIPPED.has(e.name) && !e.name.startsWith(".")) walk(join(dir, e.name));
      } else if (e.isFile() && SOURCE.test(e.name) && !/\.(test|spec)\.|^test_|Test\.java$|Dockerfile/.test(e.name)) out.push(join(dir, e.name));
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── The onboarding verifier (doc 9 §7 step 3) ─────────────────────────────

export const ONBOARD_HANDLER = "mandate-onboard-verifier@0.3";

// Types are allowed: an environment's reads return records the model defines.
const SYSTEM_KINDS = new Set(["component", "interface", "environment", "type"]);

export interface OnboardConfig {
  /** Network name → component, for finding calls in the code; by default each component is reached by its own name. */
  hosts?: Record<string, string>;
  /**
   * Read-only paths a component's commands may also read, per component: a
   * toolchain, a dependency cache. Sandboxes have no network (K7): a build
   * that fetches its dependencies runs only from a cache made readable here,
   * and a command that cannot run fails the criterion.
   */
  extraRead?: Record<string, string[]>;
  timeoutMs?: number;
}

type Repo = SystemFacts["components"][string];

/**
 * Checks a drafted system model against the repositories it describes. The
 * draft is a module in the working copy of the component `at` names (the
 * repository that will hold the model), so the evidence binds to its bytes
 * and the change that lands it is the one checked (G01).
 *
 *   test.system_specs(path, at: c)  the draft checks clean, defines only system kinds,
 *                                   describes every other repository of the run (same
 *                                   name, same repository), and each interface's spec is
 *                                   in its provider's repository at the base commit and
 *                                   parses
 *   test.consumes(path, at: c)      every call the code makes to another component is a
 *                                   `consumes` of the model; a `consumes` the code does not
 *                                   show is a warning (best effort)
 *   test.commands(path, at: c)      every component's build and test commands run in a
 *                                   sandbox over its base commit
 */
export class OnboardVerifier implements VerifierAdapter {
  static readonly METHODS = ["test.system_specs", "test.consumes", "test.commands"];

  constructor(
    private readonly o: OnboardConfig,
    private readonly sandbox?: MxcAdapter,
    /** Checks this verifier does not know. */
    private readonly inner?: VerifierAdapter,
  ) {}

  async upperBound(req: VerifyRequest) {
    return this.inner?.upperBound?.(req);
  }

  async check(req: VerifyRequest): Promise<CheckResult> {
    if (!OnboardVerifier.METHODS.includes(req.method)) return this.inner ? this.inner.check(req) : { passed: false, detail: { unsupported: `the verifier has no method ${req.method}` } };
    const producer: Value = { kind: "runtime", handler: ONBOARD_HANDLER, ...(this.sandbox ? { sandbox: `mxc:${this.sandbox.o.isolation ?? "process"}` } : {}) };
    const sys = req.system;
    if (!sys) return { passed: false, detail: { reason: `${req.method} needs the run's repositories (design doc 9 §7)` }, producer };
    const at = req.named["at"];
    const path = req.args[0];
    const holder = typeof at === "string" ? sys.components[at] : undefined;
    if (typeof at !== "string" || !holder) return { passed: false, detail: { reason: `${req.method} needs at: the component whose working copy holds the draft` }, producer };
    if (typeof path !== "string") return { passed: false, detail: { reason: `${req.method} needs the draft's path` }, producer };
    const subject = snapshot(sys);
    const file = join(holder.root, path);
    if (!existsSync(file)) return { passed: false, detail: { draft: path, reason: `no draft at ${path} in ${at}'s working copy` }, producer, subject };
    const checked = check(readFileSync(file, "utf8"), "mdt");
    const errors = checked.diagnostics.filter((d) => d.severity === "error");
    if (errors.length || !checked.program) return { passed: false, detail: { draft: path, diagnostics: errors.map((d) => `${d.code}: ${d.message}`) }, producer, subject };
    const defs = checked.program.defs;
    const others = Object.entries(sys.components).filter(([n]) => n !== at).sort(([a], [b]) => (a < b ? -1 : 1));
    const r = req.method === "test.system_specs" ? this.specs(defs, others) : req.method === "test.consumes" ? this.consumes(defs, others) : await this.commands(defs, others);
    return { producer, subject, ...r, detail: { draft: path, ...(r.detail as Record<string, Value>) } };
  }

  private specs(defs: Record<string, Def>, others: Array<[string, Repo]>): Omit<CheckResult, "subject"> {
    const problems: Value[] = [];
    for (const [n, d] of Object.entries(defs)) if (!SYSTEM_KINDS.has(d.kind)) problems.push({ definition: n, problem: "not_system_model", detail: `${n} is a ${d.kind}; a system model defines components, interfaces, environments and the types their reads return` });
    for (const [n, c] of others) {
      const d = defs[n];
      if (d?.kind !== "component") problems.push({ component: n, problem: "not_described", detail: `the draft does not describe ${n} (${c.repo})` });
      else if (d.repo !== c.repo) problems.push({ component: n, problem: "repo_differs", detail: `the draft puts ${n} in ${d.repo}; the run's ${n} is ${c.repo}` });
    }
    for (const [n, d] of Object.entries(defs)) if (d.kind === "component" && !others.some(([o]) => o === n)) problems.push({ component: n, problem: "not_in_workspace", detail: `${n} is not a repository of this run` });
    const interfaces: Value[] = [];
    for (const [n, d] of Object.entries(defs).sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (d.kind !== "interface") continue;
      const provider = Object.entries(defs).find(([, c]) => c.kind === "component" && c.provides?.includes(n))?.[0];
      const c = provider ? others.find(([o]) => o === provider)?.[1] : undefined;
      let problem: string | undefined;
      if (!c?.base) problem = "no_base";
      else if (d.protocol === "db_schema") problem = git(c.root, ["ls-tree", "-r", "--name-only", c.base, "--", d.spec])?.toString("utf8").trim() ? undefined : "spec_missing";
      else {
        const content = git(c.root, ["show", `${c.base}:${d.spec}`]);
        problem = content === undefined ? "spec_missing" : parses(content.toString("utf8")) ? undefined : "spec_unreadable";
      }
      interfaces.push({ interface: n, provider: provider ?? null, spec: d.spec, ...(c?.base ? { base: c.base } : {}), ...(problem ? { problem } : {}) });
      if (problem) problems.push({ interface: n, problem });
    }
    return { passed: problems.length === 0, detail: { interfaces, ...(problems.length ? { problems } : {}) } };
  }

  private consumes(defs: Record<string, Def>, others: Array<[string, Repo]>): Omit<CheckResult, "subject"> {
    const components = Object.keys(defs).filter((n) => defs[n]!.kind === "component");
    const hosts = this.o.hosts ?? Object.fromEntries(components.map((n) => [n, n]));
    const facts: Record<string, RepoFacts> = {};
    const unread: Value[] = [];
    for (const [n, c] of others) {
      if (!components.includes(n)) continue;
      const tree = c.base ? checkout(c.root, c.base) : undefined;
      if (!tree) {
        unread.push({ component: n, problem: "no_base" });
        continue;
      }
      try {
        facts[n] = { ...scan(n, tree.dir, hosts), root: c.root };
      } finally {
        tree.remove();
      }
    }
    // Only what was read is compared: a component not in the run is test.system_specs' finding.
    const found = drift(defs, facts).filter((f) => f.kind === "undeclared_dependency" || f.kind === "unsupported_consumes");
    const undeclared = found.filter((f) => f.kind === "undeclared_dependency").map(finding);
    const unsupported = found.filter((f) => f.kind === "unsupported_consumes").map(finding);
    return { passed: undeclared.length === 0 && unread.length === 0, detail: { undeclared, ...(unsupported.length ? { warnings: unsupported } : {}), ...(unread.length ? { unread } : {}) } };
  }

  private async commands(defs: Record<string, Def>, others: Array<[string, Repo]>): Promise<Omit<CheckResult, "subject">> {
    if (!this.sandbox) return { passed: false, detail: { reason: "test.commands needs a sandbox; this verifier has none" } };
    const runs: Value[] = [];
    const logs: CheckLog[] = [];
    let passed = true;
    for (const [n, c] of others) {
      const d = defs[n];
      if (d?.kind !== "component") continue;
      const cmds = [...(d.build ?? []), ...(d.test ?? [])];
      const tree = cmds.length && c.base ? checkout(c.root, c.base) : undefined;
      if (!tree) {
        runs.push({ component: n, problem: cmds.length ? "no_base" : "no_commands" });
        passed = false;
        continue;
      }
      try {
        // Dependency directories are linked into the tree and stay read-only: a build cannot write through them.
        const linked = LINKED.map((l) => join(c.root, l)).filter((p) => existsSync(p));
        const exitCodes: number[] = [];
        let output = "";
        for (const cmd of cmds) {
          const caps: CapVal[] = [
            { ctor: "fs.write", effect: "Fs.Write", write: true, scope: [tree.dir] } as CapVal,
            { ctor: "fs.read", effect: "Fs.Read", write: false, scope: [tree.dir, ...linked, ...(this.o.extraRead?.[n] ?? [])] } as CapVal,
            { ctor: "exec", effect: "Exec", write: false, scope: [cmd.command], argsPrefix: [cmd.args] } as CapVal,
          ];
          const planned = await this.sandbox.plan(requirementFor({ agent: "verifier", def: `commands ${n}` }, caps, this.o.timeoutMs ?? 600_000));
          if ("unsupported" in planned) {
            exitCodes.push(126);
            output += `the verifier's sandbox was refused: ${planned.unsupported.join("; ")}\n`;
            break;
          }
          const host = this.sandbox.o.host;
          const handle = await host.create(planned.policy);
          try {
            const r = await host.execute(handle, { argv: [cmd.command, ...cmd.args], cwd: tree.dir });
            exitCodes.push(r.timedOut ? 124 : r.exitCode);
            output += `$ ${[cmd.command, ...cmd.args].join(" ")}\n${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}\n`;
            if (r.exitCode !== 0 || r.timedOut) break;
          } finally {
            await host.destroy(handle);
          }
        }
        const ok = exitCodes.length === cmds.length && exitCodes.every((x) => x === 0);
        runs.push({ component: n, base: c.base, passed: ok, exit_codes: exitCodes, output: tail(output) });
        logs.push({ kind: "test_log", phase: n, result: ok ? "pass" : "fail", content: output });
        passed &&= ok;
      } finally {
        tree.remove();
      }
    }
    return { passed, detail: { runs }, logs };
  }
}

function finding(f: DriftFinding): Value {
  return { component: f.component, detail: f.detail, ...(f.evidence ? { evidence: f.evidence.map((e) => ({ file: e.file, line: e.line, text: e.text })) } : {}) };
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}
