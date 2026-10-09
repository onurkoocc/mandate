// Onboarding and drift (design doc 9 §7, §12; BACKLOG item 35, B7). Kervan's
// model is drafted from its repositories and checked against them: specs at
// the base commit, calls between components in the code, commands in a
// sandbox, and an architect. The model committed in kervan-system leaves out
// one dependency on purpose, auth fetching voice's client metadata; the
// scanner and the onboarding verifier both find it.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, printProgram, type Def, type Modules } from "@mandate/compiler";
import { main } from "../src/cli.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GitHubMerges } from "../src/github-merge.js";
import { draft, drift, OnboardVerifier, scan, type RepoFacts } from "../src/onboard.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimAgents, SimSandboxHost } from "../src/sim.js";
import type { Obj } from "../src/values.js";
import { fakeGitHubs } from "./fake-github.js";
import { closeAll, world } from "./helpers.js";
import { KERVAN_SOURCE, lockFor } from "./kervan.js";

afterAll(closeAll);

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const KERVAN = join(REPO, "examples/kervan");
const SEEDS: Record<string, string> = { auth: "kervan-auth", mcp: "kervan-mcp", core: "kervan-core", search: "kervan-search", voice: "kervan-voice", evals: "kervan-voice-evals", system: "kervan-system" };
const ONBOARD = readFileSync(join(KERVAN, "programs/onboard.mdt"), "utf8");
const REPOS = readFileSync(join(KERVAN, "programs/repos.mdt"), "utf8");
const MODEL_PATH = "system/kervan.system.mdt";
const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.email=t@mandate", "-c", "user.name=t", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8" });

/** Each component's working copy at the seed, as the hosts in compose reach them. */
function scanSeeds(): Record<string, RepoFacts> {
  const hosts = { auth: "auth", mcp: "mcp", core: "core", search: "search", voice: "voice" };
  return Object.fromEntries(Object.entries(SEEDS).filter(([c]) => c !== "system").map(([c, d]) => [c, scan(c, join(KERVAN, d), hosts)]));
}

describe("the scanner (B7)", () => {
  it("drafts Kervan's model from its repositories, and the draft checks clean", () => {
    const facts = scanSeeds();
    expect(facts["core"]).toMatchObject({ lang: "java", specs: [{ protocol: "openapi" }, { protocol: "db_schema" }] });
    expect(facts["search"]).toMatchObject({ lang: "py", specs: [{ protocol: "openapi" }] });
    const p = draft(Object.values(facts), { module: "kervan.system", repos: {}, roots: {} });
    const r = check(printProgram(p), "mdt");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const consumes = (c: string) => (p.defs[c] as Extract<Def, { kind: "component" }>).consumes;
    expect(consumes("mcp")).toEqual(["AuthTokens", "CoreApi", "SearchApi"]);
    expect(consumes("voice")).toEqual(["AuthTokens", "McpTools"]);
    expect(consumes("evals")).toEqual(["VoiceApi"]);
    expect(consumes("core")).toBeUndefined();
  });

  it("finds the committed model's deliberate drift: auth calls voice, with where", () => {
    const model = check(KERVAN_SOURCE, "mdt").program!;
    const found = drift(model.defs, scanSeeds()).filter((f) => f.severity === "drift");
    const voice = found.find((f) => f.component === "auth" && f.detail.includes("voice"));
    expect(voice).toMatchObject({ kind: "undeclared_dependency", evidence: [{ file: "src/config.ts" }] });
    expect(voice!.evidence![0]!.text).toContain("CIMD_ALLOWED_HOSTS");
    // Nothing else in the model disagrees with the repositories but auth's references.
    expect(found.every((f) => f.component === "auth" && f.kind === "undeclared_dependency")).toBe(true);
  });

  it("reports a missing spec and an unmodelled one", () => {
    const facts = scanSeeds();
    const model = check(KERVAN_SOURCE.replace('spec     "docs/oauth-metadata.json"', 'spec     "docs/oauth.json"'), "mdt").program!;
    const kinds = drift(model.defs, facts).filter((f) => f.component === "auth").map((f) => f.kind);
    expect(kinds).toContain("spec_missing");
    expect(kinds).toContain("unmodelled_interface");
  });
});

describe("the onboarding program on Kervan (B7)", () => {
  let dir: string;
  const roots: Record<string, { root: string; base: string }> = {};

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "mandate-onboard-"));
    for (const [c, seed] of Object.entries(SEEDS)) {
      const root = join(dir, seed);
      for (const f of git(REPO, "ls-files", "-z", `examples/kervan/${seed}`).split("\0").filter(Boolean)) {
        mkdirSync(dirname(join(root, f.slice(`examples/kervan/${seed}/`.length))), { recursive: true });
        cpSync(join(REPO, f), join(root, f.slice(`examples/kervan/${seed}/`.length)));
      }
      git(root, "init", "-q", "-b", "main");
      git(root, "add", "-A");
      git(root, "commit", "-q", "-m", "seed");
      roots[c] = { root, base: git(root, "rev-parse", "HEAD").trim() };
    }
  }, 120_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A run whose Cartographer writes `model` into kervan-system's working copy. */
  async function onboard(model: string, id: string) {
    let repos = REPOS;
    for (const [c, seed] of Object.entries(SEEDS)) repos = repos.replace(`"/work/${seed}"`, JSON.stringify(roots[c]!.root.replace(/\\/g, "/")));
    const modules: Modules = { "kervan.repos": check(repos, "mdt").program! };
    const system = roots["system"]!;
    git(system.root, "checkout", "-q", "--", ".");
    const agents = new SimAgents().on("Cartographer.draft", () => {
      writeFileSync(join(system.root, MODEL_PATH), model);
      return { ok: { path: MODEL_PATH, files: [MODEL_PATH], summary: "Kervan's components, interfaces and dependencies" }, cost: { steps: 6 } };
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
    const gh = fakeGitHubs(["onurkoocc/kervan-system"]);
    const remote = gh.repos["onurkoocc/kervan-system"]!;
    remote.commits.set(system.base, { ...remote.commits.get(remote.refs.get("heads/main")!)!, message: "seed" });
    remote.refs.set("heads/main", system.base);
    w.adapters.tools["git.merge"] = new GitHubMerges({ token: "t", repos: ["onurkoocc/kervan-system"], fetch: gh.fetch });
    const rt = new Runtime(w.db, w.adapters);
    const program = check(ONBOARD, "mdt", { modules }).program!;
    const run = await rt.startRun({ pkg: buildPackage(program, lockFor(modules), modules), workflow: "Onboard", input: { request: { id, note: "Take Kervan into Mandate" } } });
    const evidence = async (runId: string) => Object.fromEntries((await rt.evidence(runId)).filter((e) => e.contract === "ModelAccepted").map((e) => [e.criterion, e]));
    return { rt, run, gh, ran, evidence };
  }

  it("refuses the model that leaves out auth → voice: the code shows the call", async () => {
    const t = await onboard(KERVAN_SOURCE, "ON-1");
    expect(t.run.state).toBe("waiting");
    const ev = await t.evidence(t.run.run_id);
    expect(Object.fromEntries(Object.entries(ev).map(([k, e]) => [k, e.passed]))).toMatchObject({ described: true, consumed: false, runnable: true });
    const detail = JSON.stringify(ev["consumed"]!.detail);
    expect(detail).toContain("auth refers to voice");
    expect(detail).toContain("CIMD_ALLOWED_HOSTS");
    expect(t.gh.repos["onurkoocc/kervan-system"]!.pulls).toHaveLength(0);
  });

  it("accepts the model drafted from the repositories, and lands it in kervan-system", async () => {
    const facts = Object.fromEntries(Object.entries(roots).filter(([c]) => c !== "system").map(([c, r]) => [c, scan(c, r.root, { auth: "auth", mcp: "mcp", core: "core", search: "search", voice: "voice" })]));
    const repos = Object.fromEntries(Object.entries(SEEDS).map(([c, s]) => [c, `onurkoocc/${s}`]));
    const text = printProgram(draft(Object.values(facts), { module: "kervan.system", repos, roots: Object.fromEntries(Object.entries(SEEDS).map(([c, s]) => [c, `/work/${s}`])) }));
    const t = await onboard(text, "ON-2");
    let run = t.run;
    const roles: string[] = [];
    for (let i = 0; run.state === "waiting"; i++) {
      const w = run.waiting as Obj;
      const r = w["request"] as Obj;
      roles.push(String(r["role"]));
      run = await t.rt.decideAction(run.run_id, { sender: String(r["role"]), messageId: `d${i}` }, { commandId: String(w["command"]), revision: run.revision, digest: String(r["subject_digest"] ?? r["action_digest"]), approve: true, by: String(r["role"]) });
    }
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    // The architect accepts the model, then kervan-system's owner and the set approver land it.
    expect(roles[0]).toBe("architect");
    const ev = await t.evidence(run.run_id);
    expect(Object.values(ev).every((e) => e.passed)).toBe(true);
    // Every component's commands ran, at the base commit.
    expect(t.ran).toContain("mvn -B -q -o test");
    expect(t.ran).toContain("python -m pytest -q");
    const repo = t.gh.repos["onurkoocc/kervan-system"]!;
    expect(repo.pulls[0]!.merged).toBe(true);
    expect(repo.filesOf("main")!.get(MODEL_PATH)).toBe(text);
  });

  it("refuses a draft whose spec is not in its provider's repository", async () => {
    const t = await onboard(KERVAN_SOURCE.replace('spec     "docs/oauth-metadata.json"', 'spec     "docs/oauth.json"'), "ON-3");
    const ev = await t.evidence(t.run.run_id);
    expect(ev["described"]!.passed).toBe(false);
    expect(JSON.stringify(ev["described"]!.detail)).toContain("spec_missing");
  });

  it("refuses a draft that leaves a repository out", async () => {
    const t = await onboard(KERVAN_SOURCE.replace(/component evals \{[^}]*\}\n/, ""), "ON-4");
    const ev = await t.evidence(t.run.run_id);
    expect(ev["described"]!.passed).toBe(false);
    expect(JSON.stringify(ev["described"]!.detail)).toContain("not_described");
  });
});

describe("mandate onboard and mandate drift (B7)", () => {
  const components = Object.entries(SEEDS).filter(([c]) => c !== "system").flatMap(([c, d]) => ["--component", `${c}=${join(KERVAN, d)}`]);

  it("onboard prints a draft that checks clean, with where each dependency was seen", async () => {
    let text = "";
    expect(await main(["onboard", ...components, "--name", "kervan.system"], (s) => (text += s))).toBe(0);
    expect(text).toContain("auth → voice  src/config.ts:");
    expect(check(text, "mdt").ok).toBe(true);
  });

  it("drift finds auth → voice in the committed model and exits 1", async () => {
    let text = "";
    expect(await main(["drift", "--module", join(KERVAN, "kervan-system", MODEL_PATH), ...components], (s) => (text += s))).toBe(1);
    expect(text).toMatch(/drift +auth: auth refers to voice/);
    expect(text).toContain("CIMD_ALLOWED_HOSTS");
  });
});
