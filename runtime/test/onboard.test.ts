// Onboarding and drift (design doc 9 §7, §12; BACKLOG item 35, B7). Acme's
// model is drafted from its repositories and checked against them: specs at
// the base commit, calls between components in the code, commands in a
// sandbox, and an architect. The fixture model (fixtures/system) leaves out
// one dependency on purpose, auth fetching voice's client metadata; the
// scanner and the onboarding verifier both find it. The repositories are
// generated here: small, but with what the scanner reads.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, printProgram, type Def, type Modules } from "@mandate/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { GitHubMerges } from "../src/github-merge.js";
import { draft, drift, OnboardVerifier, scan, type RepoFacts } from "../src/onboard.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimSandboxHost } from "../src/sim.js";
import type { Obj } from "../src/values.js";
import { runView } from "../src/views.js";
import { ACME_SOURCE, lockFor } from "./acme.js";
import { fakeGitHubs } from "./fake-github.js";
import { closeAll, world } from "./helpers.js";

const fixture = (f: string): string => readFileSync(new URL(`../../fixtures/system/${f}`, import.meta.url), "utf8");
const ONBOARD = fixture("onboard.mdt");
const REPOS = fixture("repos.mdt");
const MODEL_PATH = "system/acme.system.mdt";
/** Each component's directory, as the root fixtures/system/repos.mdt gives it under /work, and its repository. */
const DIRS: Record<string, string> = { auth: "acme-auth", mcp: "acme-mcp", core: "acme-core", search: "acme-search", voice: "acme-voice", evals: "acme-voice-evals", system: "acme-system" };
const REPO_OF: Record<string, string> = { auth: "acme/auth", mcp: "acme/mcp", core: "acme/core", search: "acme/search", voice: "acme/voice", evals: "acme/voice-evals", system: "acme/system" };
const HOSTS = { auth: "auth", mcp: "mcp", core: "core", search: "search", voice: "voice" };
const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.email=t@mandate", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8" });

const NODE = { "package.json": JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }), "tsconfig.json": "{}\n" };
const OPENAPI = JSON.stringify({ openapi: "3.1.0", paths: {} });
/** What each repository holds: its manifest, its specs, and the configuration that names the components it calls. */
const FILES: Record<string, Record<string, string>> = {
  auth: {
    ...NODE,
    "docs/oauth-metadata.json": JSON.stringify({ issuer: "http://localhost:3000" }),
    "src/config.ts": [
      "const env = process.env;",
      'const list = (s: string): string[] => s.split(",");',
      'const allowedResources = list(env.ALLOWED_RESOURCES ?? "http://mcp:3001/mcp");',
      "export const config = {",
      "  allowedResources,",
      '  cimdAllowedHosts: list(env.CIMD_ALLOWED_HOSTS ?? "voice").map((h) => h.toLowerCase()),',
      "};",
      "",
    ].join("\n"),
  },
  mcp: {
    ...NODE,
    "docs/mcp-tools.json": JSON.stringify({ tools: [] }),
    "src/config.ts": [
      'export const authIssuer = process.env.AUTH_ISSUER ?? "http://auth:3000";',
      'export const jwksUrl = process.env.AUTH_JWKS_URL ?? "http://auth:3000/jwks";',
      'export const coreUrl = process.env.CORE_URL ?? "http://core:8080";',
      'export const searchUrl = process.env.SEARCH_URL ?? "http://search:8000";',
      "",
    ].join("\n"),
    // A test may name any host; tests are not the code's calls.
    "test/config.test.ts": 'expect(url).toBe("http://voice:3002");\n',
  },
  core: {
    "pom.xml": "<project/>\n",
    "docs/openapi.json": OPENAPI,
    "src/main/resources/db/migration/V1__init.sql": "create table shipments (id int primary key);\n",
    "src/main/java/acme/core/Api.java": "class Api {}\n",
  },
  search: { "pyproject.toml": '[project]\nname = "acme-search"\n', "docs/openapi.json": OPENAPI, "app/main.py": "app = None\n" },
  voice: {
    ...NODE,
    "docs/openapi.json": OPENAPI,
    "src/config.ts": ['export const tokenUrl = process.env.AUTH_TOKEN_URL ?? "http://auth:3000/token";', 'export const mcpUrl = process.env.MCP_URL ?? "http://mcp:3001/mcp";', ""].join("\n"),
  },
  evals: { "pyproject.toml": '[project]\nname = "acme-evals"\n', "acme_evals/cli.py": 'import os\nVOICE_URL = os.environ.get("VOICE_URL", "http://voice:3002")\n' },
  system: { "README.md": "Acme's system model and environments.\n", "system/.keep": "" },
};

let dir: string;
const roots: Record<string, { root: string; base: string }> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mandate-onboard-"));
  for (const [c, files] of Object.entries(FILES)) {
    const root = join(dir, DIRS[c]!);
    for (const [f, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, f)), { recursive: true });
      writeFileSync(join(root, f), content);
    }
    git(root, "init", "-q", "-b", "main");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "seed");
    roots[c] = { root, base: git(root, "rev-parse", "HEAD").trim() };
  }
}, 120_000);

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await closeAll();
});

/** Each component's working copy, as the hosts the services reach each other by. */
function scanAll(): Record<string, RepoFacts> {
  return Object.fromEntries(Object.entries(roots).filter(([c]) => c !== "system").map(([c, r]) => [c, scan(c, r.root, HOSTS)]));
}

/** The model drafted from the working copies, as onboarding writes it. */
function scannedModel(): string {
  return printProgram(draft(Object.values(scanAll()), { module: "acme.system", repos: REPO_OF, roots: Object.fromEntries(Object.entries(DIRS).map(([c, d]) => [c, `/work/${d}`])) }));
}

describe("the scanner (B7)", () => {
  it("drafts Acme's model from its repositories, and the draft checks clean", () => {
    const facts = scanAll();
    expect(facts["core"]).toMatchObject({ lang: "java", specs: [{ protocol: "openapi" }, { protocol: "db_schema" }] });
    expect(facts["search"]).toMatchObject({ lang: "py", specs: [{ protocol: "openapi" }] });
    const p = draft(Object.values(facts), { module: "acme.system", repos: {}, roots: {} });
    const r = check(printProgram(p), "mdt");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const consumes = (c: string) => (p.defs[c] as Extract<Def, { kind: "component" }>).consumes;
    expect(consumes("mcp")).toEqual(["AuthTokens", "CoreApi", "SearchApi"]);
    expect(consumes("voice")).toEqual(["AuthTokens", "McpTools"]);
    expect(consumes("evals")).toEqual(["VoiceApi"]);
    expect(consumes("core")).toBeUndefined();
  });

  it("finds the fixture model's deliberate drift: auth refers to voice, with where", () => {
    const model = check(ACME_SOURCE, "mdt").program!;
    const found = drift(model.defs, scanAll()).filter((f) => f.severity === "drift");
    const voice = found.find((f) => f.component === "auth" && f.detail.includes("voice"));
    expect(voice).toMatchObject({ kind: "undeclared_dependency", evidence: [{ file: "src/config.ts", line: 6 }] });
    expect(voice!.evidence![0]!.text).toContain("CIMD_ALLOWED_HOSTS");
    // Nothing else in the model disagrees with the repositories but auth's references (to voice, and to mcp's resource).
    expect(found.map((f) => [f.component, f.kind, f.detail.match(/refers to (\w+)/)?.[1]])).toEqual([
      ["auth", "undeclared_dependency", "mcp"],
      ["auth", "undeclared_dependency", "voice"],
    ]);
  });

  it("reports a missing spec and an unmodelled one", () => {
    const model = check(ACME_SOURCE.replace('spec     "docs/oauth-metadata.json"', 'spec     "docs/oauth.json"'), "mdt").program!;
    const kinds = drift(model.defs, scanAll()).filter((f) => f.component === "auth").map((f) => f.kind);
    expect(kinds).toContain("spec_missing");
    expect(kinds).toContain("unmodelled_interface");
  });
});

describe("the onboarding program on Acme (B7)", () => {
  /** A run whose Cartographer writes `model` into acme-system's working copy. */
  async function onboard(model: string, id: string, o: { pinned?: string } = {}) {
    let repos = REPOS;
    for (const [c, d] of Object.entries(DIRS)) repos = repos.replace(`"/work/${d}"`, JSON.stringify(roots[c]!.root.replace(/\\/g, "/")));
    // A run may also carry the model accepted before (drift): what lands is then shown against it.
    const modules: Modules = { "acme.repos": check(repos, "mdt").program!, ...(o.pinned ? { "acme.system": check(o.pinned, "mdt").program! } : {}) };
    const system = roots["system"]!;
    git(system.root, "checkout", "-q", "--", ".");
    const agents = new SimAgents().on("Cartographer.draft", () => {
      writeFileSync(join(system.root, MODEL_PATH), model);
      return { ok: { path: MODEL_PATH, files: [MODEL_PATH], summary: "Acme's components, interfaces and dependencies" }, cost: { steps: 6 } };
    });
    const w = await world(ONBOARD, { modules, lock: lockFor(modules), agents });
    const host = new SimSandboxHost();
    const ran: string[] = [];
    for (const cmd of ["npm", "mvn", "python"]) {
      host.programs[cmd] = (req) => {
        ran.push(req.argv.join(" "));
        return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false };
      };
    }
    w.adapters.verifier = new OnboardVerifier({}, new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true }), w.adapters.verifier);
    w.adapters.workspace = { prepare: async () => Object.fromEntries(Object.entries(roots).map(([c, r]) => [c, { base: r.base }])) };
    const gh = fakeGitHubs(["acme/system"]);
    const remote = gh.repos["acme/system"]!;
    remote.commits.set(system.base, { ...remote.commits.get(remote.refs.get("heads/main")!)!, message: "seed" });
    remote.refs.set("heads/main", system.base);
    w.adapters.tools["git.merge"] = new GitHubMerges({ token: "t", repos: ["acme/system"], fetch: gh.fetch });
    const rt = new Runtime(w.db, w.adapters);
    const program = check(ONBOARD, "mdt", { modules }).program!;
    const run = await rt.startRun({ pkg: buildPackage(program, lockFor(modules), modules), workflow: "Onboard", input: { request: { id, note: "Take Acme into Mandate" } } });
    const evidence = async (runId: string) => Object.fromEntries((await rt.evidence(runId)).filter((e) => e.contract === "ModelAccepted").map((e) => [e.criterion, e]));
    return { rt, run, gh, ran, evidence };
  }

  async function approveAll(t: Awaited<ReturnType<typeof onboard>>) {
    let run = t.run;
    const roles: string[] = [];
    for (let i = 0; run.state === "waiting"; i++) {
      const w = run.waiting as Obj;
      const r = w["request"] as Obj;
      roles.push(String(r["role"]));
      run = await t.rt.decideAction(run.run_id, { sender: String(r["role"]), messageId: `d${i}` }, { commandId: String(w["command"]), revision: run.revision, digest: String(r["subject_digest"] ?? r["action_digest"]), approve: true, by: String(r["role"]) });
    }
    return { run, roles };
  }

  it("refuses the model that leaves out auth → voice: the code shows the call", async () => {
    const t = await onboard(ACME_SOURCE, "ON-1");
    expect(t.run.state).toBe("waiting");
    const ev = await t.evidence(t.run.run_id);
    expect(Object.fromEntries(Object.entries(ev).map(([k, e]) => [k, e.passed]))).toMatchObject({ described: true, consumed: false, runnable: true });
    const detail = JSON.stringify(ev["consumed"]!.detail);
    expect(detail).toContain("auth refers to voice");
    expect(detail).toContain("CIMD_ALLOWED_HOSTS");
    expect(t.gh.repos["acme/system"]!.pulls).toHaveLength(0);
  });

  it("accepts the model drafted from the repositories, and lands it in acme-system", async () => {
    const text = scannedModel();
    const t = await onboard(text, "ON-2");
    const { run, roles } = await approveAll(t);
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    // The architect accepts the model, then acme-system's owner and the set approver land it.
    expect(roles[0]).toBe("architect");
    const ev = await t.evidence(run.run_id);
    expect(Object.values(ev).every((e) => e.passed)).toBe(true);
    // Every component's commands ran, at the base commit.
    expect(t.ran).toContain("mvn -B -q -o test");
    expect(t.ran).toContain("python -m pytest -q");
    const repo = t.gh.repos["acme/system"]!;
    expect(repo.pulls[0]!.merged).toBe(true);
    expect(repo.filesOf("main")!.get(MODEL_PATH)).toBe(text);
    // The change set view says what it changes in authority: a system model the run had none of (B8).
    const { view } = await runView(t.rt, run.run_id);
    expect(view.changesets[0]!.authority).toEqual([{ component: "system", file: MODEL_PATH, changes: ["a new Mandate module acme.system: this run's package has no earlier version of it"] }]);
  });

  it("shows a new model against the accepted one as governance changes (B8)", async () => {
    const t = await onboard(scannedModel(), "ON-5", { pinned: ACME_SOURCE });
    const { run } = await approveAll(t);
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    const { view } = await runView(t.rt, run.run_id);
    const [a] = view.changesets[0]!.authority;
    expect(a!.file).toBe(MODEL_PATH);
    // auth's newly modelled dependencies, among the rest of what the draft names differently.
    expect(a!.changes.some((c) => c.includes("component auth.consumes:") && c.includes("VoiceApi"))).toBe(true);
  });

  it("refuses a draft whose spec is not in its provider's repository", async () => {
    const t = await onboard(ACME_SOURCE.replace('spec     "docs/oauth-metadata.json"', 'spec     "docs/oauth.json"'), "ON-3");
    const ev = await t.evidence(t.run.run_id);
    expect(ev["described"]!.passed).toBe(false);
    expect(JSON.stringify(ev["described"]!.detail)).toContain("spec_missing");
  });

  it("refuses a draft that leaves a repository out", async () => {
    const t = await onboard(ACME_SOURCE.replace(/component evals \{[^}]*\}\n/, ""), "ON-4");
    const ev = await t.evidence(t.run.run_id);
    expect(ev["described"]!.passed).toBe(false);
    expect(JSON.stringify(ev["described"]!.detail)).toContain("not_described");
  });
});

describe("mandate onboard and mandate drift (B7)", () => {
  const components = (): string[] => Object.entries(roots).filter(([c]) => c !== "system").flatMap(([c, r]) => ["--component", `${c}=${r.root}`]);

  it("onboard prints a draft that checks clean, with where each dependency was seen", async () => {
    let text = "";
    expect(await main(["onboard", ...components(), "--name", "acme.system"], (s) => (text += s))).toBe(0);
    expect(text).toContain("auth → voice  src/config.ts:6");
    expect(check(text, "mdt").ok).toBe(true);
  });

  it("drift finds auth → voice in the fixture model and exits 1", async () => {
    let text = "";
    const model = fileURLToPath(new URL("../../fixtures/system/acme.system.mdt", import.meta.url));
    expect(await main(["drift", "--module", model, ...components()], (s) => (text += s))).toBe(1);
    expect(text).toMatch(/drift +auth: auth refers to voice/);
    expect(text).toContain("CIMD_ALLOWED_HOSTS");
  });
});

