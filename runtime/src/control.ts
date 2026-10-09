// What the control CLI runs against (BACKLOG K19): one configuration file,
// `mandate.runtime.json`, that names the database and the adapters, and the
// secrets, which come only from the environment. Without an adapter in the
// configuration, the runtime refuses to call it: a run that needs it stops
// for a person instead of running against something simulated.
//
//   {
//     "database": "pglite:.mandate/db" | "postgresql://…",
//     "artifacts": ".mandate/artifacts",                         // default
//     "evidence": { "key": ".mandate/evidence.key", "trusted": ["keys/old.pem"] },   // default key; created if missing
//     "rateLimits": { "model": { "capacity": 50, "perSecond": 1, "queue": 100 } },     // shared token buckets (§8.6)

//     "model":    { "provider": "anthropic" },                  // CLAUDE_API_KEY, CLAUDE_WORKSPACE_ID
//     "sandbox":  { "host": "mxc", "baseline": ["/usr/local"], "mode": "enforcement" | "learning" },
//                 on Windows: { "host": "mxc", "toolchain": ["C:\\Program Files\\nodejs"], "isolation": "process" }
//     "github":   { "repo": "owner/name", "base": "main", "workdir": "/work/repo" },   // MANDATE_GITHUB_TOKEN
//                 with "repos": ["owner/a", "owner/b"], also git.merge for change sets into those repositories (B4)
//     "verifier": { "workdir": "/work/repo", "base": "seed", "suites": { "unit": "test/**/*.test.ts" }, "command": ["node", "--test"],
//                   "process": { "key": ".mandate/verifier.key", "trusted": ["keys/verifier.pub"] } }   // optional: a verifier process of its own
//     "workspace": { "components": { "mcp": { "url": "https://github.com/onurkoocc/kervan-mcp.git", "ref": "main" } } }
//     "broker":    { "prod_sim/core": { "url_env": "MANDATE_PROD_SIM_CORE_URL" }, "prod_sim/mcp": { "logs": "data/prod_sim/logs" } }
//                 // the read broker (B6): a read-only database login (from the environment) or a logs directory per environment/component
//     "samples":   "samples.json"          // sample rows for design runs, by "<environment>.<read>"
//     "boundary": { "integration": { "dir": "../kervan-system/compose", "files": ["base.yml", "staging.yml", "integration.yml"], "service": "e2e" },
//                   "ci": { "mode": "rerun", "workflow": "ci" }, "pinned": { "mcp": ["test/**"] }, "extraRead": { "core": ["/root/.m2"] } }
//                 // boundary evidence (B5): test.suite_each, test.contract, test.integration, test.ci
//                 // where each component of a system model comes from (B3); checked out at its root
//   }

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson, type Lock, type Program } from "@mandate/compiler";
import type { Adapters, ToolAdapter, VerifierAdapter } from "./adapters.js";
import { AnthropicModel } from "./anthropic.js";
import { ArtifactStore, DirBlobs } from "./artifacts.js";
import { EvidenceSigner, TrustedKeys } from "./evidence.js";
import type { BucketConfig } from "./ratelimit.js";
import type { RuntimeOptions } from "./runtime.js";
import { openDb, type Db } from "./db.js";
import { GitHubPullRequests } from "./github.js";
import { GitHubMerges } from "./github-merge.js";
import { BoundaryVerifier, GitHubCi, realDocker, type IntegrationConfig } from "./boundary.js";
import { DeclaredReads, SampleReads } from "./broker.js";
import type { Value } from "./values.js";
import { MxcHost } from "./mxc.js";
import { WindowsMxcHost } from "./mxc-windows.js";
import { MxcAdapter } from "./sandbox.js";
import { wallClock } from "./sim.js";
import { Violation } from "./signals.js";
import { SandboxVerifier, type VerifierConfig } from "./verifier.js";
import { GitWorkspace, type ComponentSource } from "./workspace.js";
import { ProcessVerifier } from "./verifier-service.js";

export interface RuntimeConfig {
  database: string;
  /** The artifact store's directory (§16.1). Default `.mandate/artifacts` next to the configuration. */
  artifacts: string;
  /**
   * The control plane's ed25519 evidence key (§10.3), created on first use;
   * default `.mandate/evidence.key`. `trusted` names other public keys
   * (PEM files) whose evidence counts, e.g. a key that was rotated out.
   */
  evidence: { key: string; trusted?: string[] };
  /** Token buckets every run on this database draws from (§8.6): `model`, `model:<tier>`, `tool`. */
  rateLimits?: Record<string, BucketConfig>;
  model?: { provider: "anthropic" };
  sandbox?: { host: "mxc"; baseline?: string[]; path?: string[]; toolchain?: string[]; isolation?: "process" | "session"; mode?: "enforcement" | "learning" };
  github?: { repo?: string; base?: string; workdir?: string; repos?: string[] };
  verifier?: VerifierConfig & {
    /**
     * Run the verifier as a process of its own, with its own ed25519 key
     * (P2-11): `key` is where it keeps it (default `.mandate/verifier.key`,
     * created on first use); `trusted` names the public keys (PEM) whose
     * attestations count, by default the key's own `.pub` file.
     */
    process?: { key: string; trusted?: string[] };
  };
  /** The read broker's sources, by `<environment>/<component>` (design doc 9 §5.1, B6). */
  broker?: Record<string, { url_env?: string; logs?: string }>;
  /** A JSON file of sample rows for design runs, by `<environment>.<read>`. */
  samples?: string;
  /** Boundary evidence across components (design doc 9 §4, B5). */
  boundary?: { integration?: IntegrationConfig; ci?: { mode?: "attested" | "rerun"; workflow?: string }; pinned?: Record<string, string[]>; extraRead?: Record<string, string[]>; timeoutMs?: number };
  /** Where each component of a system model is cloned from, and the ref a run starts from (design doc 9 §12, B3). */
  workspace?: { components: Record<string, ComponentSource> };
  /** The configuration file itself, so a verifier process can read it too. */
  file?: string;
}

const KEYS: Record<string, string[]> = {
  "": ["database", "artifacts", "evidence", "rateLimits", "model", "sandbox", "github", "verifier", "workspace", "boundary", "broker", "samples"],
  boundary: ["integration", "ci", "pinned", "extraRead", "timeoutMs"],
  "boundary.integration": ["dir", "files", "service", "services", "env", "timeoutMs", "probeImage"],
  "boundary.ci": ["mode", "workflow"],
  workspace: ["components"],
  evidence: ["key", "trusted"],
  model: ["provider"],
  sandbox: ["host", "baseline", "path", "toolchain", "isolation", "mode"],
  github: ["repo", "base", "workdir", "repos"],
  verifier: ["workdir", "base", "suites", "command", "timeoutMs", "process"],
  "verifier.process": ["key", "trusted"],
};

/** Reads `mandate.runtime.json` strictly: unknown fields are refused. Relative paths are relative to the file. */
export function readConfig(file: string): RuntimeConfig {
  const parsed = parseStrictJson(readFileSync(file, "utf8"));
  if (!parsed.ok) throw new Violation("bad_config", `${file}: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  const c = parsed.value.value as unknown as Record<string, Record<string, unknown>>;
  for (const [section, allowed] of Object.entries(KEYS)) {
    const obj = section ? (section.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], c) as Record<string, unknown> | undefined) : c;
    if (obj === undefined) continue;
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) throw new Violation("bad_config", `${file}: unknown field ${section ? `${section}.` : ""}${k}`);
  }
  if (typeof c["database"] !== "string") throw new Violation("bad_config", `${file}: "database" is required`);
  const here = dirname(resolve(file));
  const at = (p: string): string => resolve(here, p);
  const config = c as unknown as RuntimeConfig;
  if (config.database.startsWith("pglite:")) config.database = `pglite:${at(config.database.slice("pglite:".length))}`;
  if (c["artifacts"] !== undefined && typeof c["artifacts"] !== "string") throw new Violation("bad_config", `${file}: "artifacts" is a directory`);
  config.artifacts = at(config.artifacts ?? ".mandate/artifacts");
  const ev = (c["evidence"] ?? {}) as { key?: unknown; trusted?: unknown };
  if (ev.key !== undefined && typeof ev.key !== "string") throw new Violation("bad_config", `${file}: "evidence.key" is a file`);
  if (ev.trusted !== undefined && (!Array.isArray(ev.trusted) || !ev.trusted.every((t) => typeof t === "string"))) throw new Violation("bad_config", `${file}: "evidence.trusted" is a list of files`);
  config.evidence = { key: at((ev.key as string | undefined) ?? ".mandate/evidence.key"), ...(ev.trusted ? { trusted: (ev.trusted as string[]).map(at) } : {}) };
  for (const [k, b] of Object.entries((c["rateLimits"] ?? {}) as Record<string, Record<string, unknown>>)) {
    const keys = Object.keys(b ?? {});
    if (!/^(model|model:[a-z0-9_]+|tool)$/.test(k) || keys.some((x) => !["capacity", "perSecond", "queue", "reserve"].includes(x)) || typeof b["capacity"] !== "number" || typeof b["perSecond"] !== "number") {
      throw new Violation("bad_config", `${file}: rateLimits.${k} must be a bucket model, model:<tier> or tool with capacity, perSecond and an optional queue`);
    }
  }
  if (config.github?.workdir) config.github.workdir = at(config.github.workdir);
  if (config.github && (!!config.github.repo !== !!config.github.workdir || (config.github.repos !== undefined && (!Array.isArray(config.github.repos) || !config.github.repos.every((r) => typeof r === "string"))))) {
    throw new Violation("bad_config", `${file}: "github" takes "repo" with "workdir" (git.open_pr), and "repos", a list of owner/name (git.merge)`);
  }
  if (config.boundary?.integration) config.boundary.integration.dir = at(config.boundary.integration.dir);
  for (const [k, s] of Object.entries(config.broker ?? {})) {
    if (!/^[A-Za-z_]\w*\/[A-Za-z_]\w*$/.test(k) || !s || typeof s !== "object" || Object.keys(s).some((x) => x !== "url_env" && x !== "logs")) throw new Violation("bad_config", `${file}: broker.${k} must be "<environment>/<component>": { "url_env" | "logs" }`);
    if (s.logs) s.logs = at(s.logs);
  }
  if (config.samples !== undefined) config.samples = at(config.samples);
  if (config.workspace) {
    const comps = (config.workspace as { components?: unknown }).components;
    if (!comps || typeof comps !== "object" || Array.isArray(comps)) throw new Violation("bad_config", `${file}: "workspace.components" maps component names to { "url", "ref" }`);
    for (const [name, src] of Object.entries(comps as Record<string, Record<string, unknown>>)) {
      if (!src || typeof src["url"] !== "string" || Object.keys(src).some((k) => k !== "url" && k !== "ref") || (src["ref"] !== undefined && typeof src["ref"] !== "string")) {
        throw new Violation("bad_config", `${file}: workspace.components.${name} must be { "url": …, "ref": … }`);
      }
      // A local source is relative to the configuration, like every other path in it.
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(src["url"]) && !src["url"].startsWith("git@")) src["url"] = at(src["url"]);
    }
  }
  if (config.verifier) config.verifier.workdir = at(config.verifier.workdir);
  if (config.verifier?.process) {
    const vp = config.verifier.process as { key?: unknown; trusted?: unknown };
    if (vp.key !== undefined && typeof vp.key !== "string") throw new Violation("bad_config", `${file}: "verifier.process.key" is a file`);
    if (vp.trusted !== undefined && (!Array.isArray(vp.trusted) || !vp.trusted.every((t) => typeof t === "string"))) throw new Violation("bad_config", `${file}: "verifier.process.trusted" is a list of files`);
    config.verifier.process = { key: at((vp.key as string | undefined) ?? ".mandate/verifier.key"), ...(vp.trusted ? { trusted: (vp.trusted as string[]).map(at) } : {}) };
  }
  config.file = resolve(file);
  return config;
}

export function connect(config: RuntimeConfig): Promise<Db> {
  return openDb(config.database);
}

/** Where rotated-out evidence keys' public halves are kept: `trusted-keys/` next to the key. */
export function trustedKeysDir(config: RuntimeConfig): string {
  return join(dirname(config.evidence.key), "trusted-keys");
}

/** The runtime's own stores: artifacts over the configured directory, and the evidence key. */
export function runtimeOptions(config: RuntimeConfig, db: Db): RuntimeOptions {
  return {
    artifacts: new ArtifactStore(db, new DirBlobs(config.artifacts)),
    signer: EvidenceSigner.loadOrCreate(config.evidence.key),
    // Keys rotated out (`mandate rotate-key`) and keys the configuration names: their evidence still counts.
    trustedKeys: [...EvidenceSigner.trustedIn(trustedKeysDir(config)), ...(config.evidence.trusted ?? []).map((f) => readFileSync(f, "utf8"))],
    ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
    ...(config.verifier?.process ? { trustedVerifiers: verifierKeys(config) } : {}),
  };
}

/** The verifier process's entry point, next to this module. */
export const VERIFIER_MAIN = fileURLToPath(new URL("./verifier-main.js", import.meta.url));

/**
 * The verifier keys whose attestations count. Without `trusted`, the key's
 * own `.pub` file; the verifier process creates its key and that file the
 * first time (the runtime never reads the private key).
 */
export function verifierKeys(config: RuntimeConfig, main: string[] = [process.execPath, VERIFIER_MAIN]): TrustedKeys {
  const vp = config.verifier?.process;
  if (!vp) return new TrustedKeys();
  const files = vp.trusted ?? [`${vp.key}.pub`];
  if (!vp.trusted && !existsSync(files[0]!)) execFileSync(main[0]!, [...main.slice(1), "--init-key", vp.key], { stdio: ["ignore", "ignore", "inherit"] });
  return new TrustedKeys(files.map((f) => readFileSync(f, "utf8")));
}

/** A verifier in this process, from the configuration: the verifier process runs this one. */
export function localVerifier(config: RuntimeConfig, program: Program, lock: Lock, env: NodeJS.ProcessEnv = process.env): VerifierAdapter {
  const sandbox = sandboxFor(config);
  if (!config.verifier || !sandbox) return { check: async () => missing("verifier") };
  return new SandboxVerifier(config.verifier, sandbox, modelFor(config, program, lock, env));
}

function modelFor(config: RuntimeConfig, program: Program, lock: Lock, env: NodeJS.ProcessEnv): AnthropicModel | undefined {
  if (!config.model) return undefined;
  const apiKey = env["CLAUDE_API_KEY"] ?? env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Violation("no_credentials", "model.provider is anthropic, but neither CLAUDE_API_KEY nor ANTHROPIC_API_KEY is set.");
  const workspaceId = env["CLAUDE_WORKSPACE_ID"] ?? env["anthropic-workspace-id"];
  return new AnthropicModel({ lock, program, apiKey, ...(workspaceId ? { workspaceId } : {}) });
}

// Linux: Bubblewrap; Windows: the AppContainer process container (P2-27). Each refuses by name what it cannot enforce.
function sandboxFor(config: RuntimeConfig): MxcAdapter | undefined {
  const s = config.sandbox;
  if (!s) return undefined;
  const host =
    process.platform === "win32"
      ? new WindowsMxcHost({ ...(s.toolchain ? { toolchain: s.toolchain } : {}), ...(s.isolation ? { backend: s.isolation } : {}) })
      : new MxcHost({ ...(s.baseline ? { baseline: s.baseline } : {}), ...(s.path ? { path: s.path } : {}) });
  return new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true, ...(s.isolation ? { isolation: s.isolation } : {}), ...(s.mode ? { mode: s.mode } : {}) });
}

/** The read broker; database URLs (with their read-only logins) come from the environment only (K7). */
function brokerFor(config: RuntimeConfig, env: NodeJS.ProcessEnv): DeclaredReads {
  const sources: Record<string, { url?: string; logs?: string }> = {};
  for (const [k, s] of Object.entries(config.broker ?? {})) {
    const url = s.url_env ? env[s.url_env] : undefined;
    if (s.url_env && !url) throw new Violation("no_credentials", `broker.${k} reads ${s.url_env}, which is not set.`);
    sources[k] = { ...(url ? { url } : {}), ...(s.logs ? { logs: s.logs } : {}) };
  }
  return new DeclaredReads(sources);
}

function boundaryVerifier(config: RuntimeConfig, sandbox: MxcAdapter, env: NodeJS.ProcessEnv, inner: VerifierAdapter | undefined): BoundaryVerifier {
  const b = config.boundary!;
  const token = env["MANDATE_GITHUB_TOKEN"];
  const ci = b.ci && token ? { ci: { ...(b.ci.mode ? { mode: b.ci.mode } : {}), source: new GitHubCi({ token, ...(b.ci.workflow ? { workflow: b.ci.workflow } : {}) }) } } : {};
  if (b.ci && !token) throw new Violation("no_credentials", "boundary.ci reads GitHub Actions, but MANDATE_GITHUB_TOKEN is not set.");
  return new BoundaryVerifier({ ...(b.integration ? { integration: b.integration } : {}), ...(b.pinned ? { pinned: b.pinned } : {}), ...(b.extraRead ? { extraRead: b.extraRead } : {}), ...(b.timeoutMs ? { timeoutMs: b.timeoutMs } : {}), ...ci }, sandbox, realDocker, inner);
}

/** A stand-in for an adapter the configuration leaves out: calling it stops the run for a person. */
function missing(what: string): never {
  throw new Violation("no_adapter", `The runtime configuration has no ${what}.`);
}

/**
 * The adapters for a package. The model adapter needs the program and its
 * lock; secrets are read from the environment here and nowhere else (K7, K18).
 */
export function adaptersFor(config: RuntimeConfig, program: Program, lock: Lock, env: NodeJS.ProcessEnv = process.env): Adapters {
  const model = modelFor(config, program, lock, env);
  const tools: Record<string, ToolAdapter> = {};
  if (config.github) {
    const token = env["MANDATE_GITHUB_TOKEN"];
    if (!token) throw new Violation("no_credentials", "github is configured, but MANDATE_GITHUB_TOKEN is not set.");
    const base = config.github.base ? { base: config.github.base } : {};
    if (config.github.repo && config.github.workdir) tools["git.open_pr"] = new GitHubPullRequests({ token, repo: config.github.repo, workdir: config.github.workdir, ...base });
    if (config.github.repos?.length) tools["git.merge"] = new GitHubMerges({ token, repos: config.github.repos, ...base });
  }
  const sandbox = sandboxFor(config);
  const own = config.verifier?.process
    ? new ProcessVerifier({ command: [process.execPath, VERIFIER_MAIN, "--config", config.file!], trusted: verifierKeys(config), package: { program, lock }, env })
    : config.verifier && sandbox
      ? new SandboxVerifier(config.verifier, sandbox, model)
      : undefined;
  // Boundary checks need the run's working copies, so they run in this process; other checks go to the verifier above.
  const boundary = config.boundary && sandbox ? boundaryVerifier(config, sandbox, env, own) : undefined;
  return {
    agents: { run: async () => missing("agent adapter: agents run as agent loops, which need model and sandbox") },
    ...(model && sandbox ? { loop: { chat: model, sandbox } } : {}),
    model: model ?? { infer: async () => missing("model"), upperBound: () => missing("model") },
    // A verifier process of its own signs each check with its own key; otherwise the checks run here.
    verifier: boundary ?? own ?? { check: async () => missing("verifier") },
    reads: { call: async () => missing("reader") },
    tools,
    ...(config.workspace ? { workspace: new GitWorkspace(config.workspace.components) } : {}),
    ...(config.broker ? { broker: brokerFor(config, env) } : {}),
    ...(config.samples ? { samples: new SampleReads(JSON.parse(readFileSync(config.samples, "utf8")) as Record<string, Value[]>) } : {}),
    clock: wallClock,
    random: Math.random,
  };
}
