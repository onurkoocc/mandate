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
//     "decisions": { "keys": ".mandate/decision-keys", "mode": "signed" | "unsigned" }
//                 // the members' public keys, <key id>.pem each (spec/envelope.md "Signed decisions"); default directory and mode.
//                 // "unsigned" takes --by NAME on a decision, as before 0.4; a 0.4 package does not start in it
//     "plan":     { "checkMs": 2000 }      // the longest a lead's sub-program may take to check (spec/envelope.md "Limits"); default
//     "violations": { "limit": 3 }         // violations that stop a run (spec/boundary.md); 3 for a 0.5 package unless set, none before 0.5

//     "model":    { "provider": "anthropic" },                  // CLAUDE_API_KEY, CLAUDE_WORKSPACE_ID
//     "executor": { "managed-agents": { "pollMs": 1000, "maxTurnMs": 3600000 } }
//                 // agents the lock binds to Claude Managed Agents run there (K45, K79); CLAUDE_API_KEY; needs "sandbox"
//     "sandbox":  { "host": "mxc", "baseline": ["/usr/local"], "mode": "enforcement" | "learning" },
//                 on Windows: { "host": "mxc", "toolchain": ["C:\\Program Files\\nodejs"], "isolation": "process" }
//     "github":   { "repo": "owner/name", "base": "main", "workdir": "/work/repo" },   // MANDATE_GITHUB_TOKEN
//                 with "repos": ["owner/a", "owner/b"], also git.merge for change sets into those repositories (B4)
//     "verifier": { "workdir": "/work/repo", "base": "seed", "suites": { "unit": "test/**/*.test.ts" }, "command": ["node", "--test"],
//                   "process": { "key": ".mandate/verifier.key", "trusted": ["keys/verifier.pub"] } }   // optional: a verifier process of its own
//     "workspace": { "components": { "mcp": { "url": "https://github.com/acme/mcp.git", "ref": "main" } } }
//     "broker":    { "prod_sim/core": { "url_env": "MANDATE_PROD_SIM_CORE_URL" }, "prod_sim/mcp": { "logs": "data/prod_sim/logs" } }
//                 // the read broker (B6): a read-only database login (from the environment) or a logs directory per environment/component
//     "samples":   "samples.json"          // sample rows for design runs, by "<environment>.<read>"
//     "boundary": { "integration": { "dir": "../acme-system/compose", "files": ["base.yml", "staging.yml", "integration.yml"], "service": "e2e" },
//                   "ci": { "mode": "rerun", "workflow": "ci" }, "pinned": { "mcp": ["test/**"] }, "extraRead": { "core": ["/root/.m2"] } }
//                 // boundary evidence (B5): test.suite_each, test.contract, test.integration, test.ci
//     "onboard":  { "hosts": { "auth": "auth" }, "extraRead": { "core": ["/root/.m2"] } }
//                 // onboarding evidence (B7): test.system_specs, test.consumes, test.commands
//                 // where each component of a system model comes from (B3); checked out at its root
//     "egress":   { "admin": "/run/mandate/egress.sock", "gateways": { "model": "anthropic", "github": "github" } }
//                 // the egress proxy the operator runs (spec/boundary.md "The egress proxy"), and the credential each
//                 // gateway sends: with a gateway on, its adapters send through the proxy with a placeholder, and
//                 // its secret (CLAUDE_API_KEY, ANTHROPIC_API_KEY; MANDATE_GITHUB_TOKEN) may not be in the environment
//   }

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseStrictJson, type Lock, type Program } from "@mandate/compiler";
import Anthropic from "@anthropic-ai/sdk";
import type { Adapters, Executor, ToolAdapter, VerifierAdapter } from "./adapters.js";
import { managedAgentsExecutor, sdkApi } from "./managed-agents.js";
import { AnthropicModel } from "./anthropic.js";
import { ArtifactStore, DirBlobs } from "./artifacts.js";
import { decisionKeysIn } from "./decisions.js";
import { childEnv, verifierEnv } from "./env.js";
import { EvidenceSigner, TrustedKeys } from "./evidence.js";
import type { BucketConfig } from "./ratelimit.js";
import type { RuntimeOptions } from "./runtime.js";
import { openDb, type Db } from "./db.js";
import { GitHubPullRequests } from "./github.js";
import { GitHubMerges } from "./github-merge.js";
import { BOUNDARY_METHODS, BoundaryVerifier, GitHubCi, realDocker, type IntegrationConfig } from "./boundary.js";
import { ONBOARD_METHODS, OnboardVerifier, type OnboardConfig } from "./onboard.js";
import { DeclaredReads, SampleReads } from "./broker.js";
import type { Value } from "./values.js";
import { MxcHost } from "./mxc.js";
import { WindowsMxcHost } from "./mxc-windows.js";
import { MxcAdapter } from "./sandbox.js";
import { wallClock } from "./sim.js";
import { Violation } from "./signals.js";
import { SandboxVerifier, type VerifierConfig } from "./verifier.js";
import { GitWorkspace, type ComponentSource } from "./workspace.js";
import { ProcessVerifier, type ChildEnvSource } from "./verifier-service.js";
import { CREDENTIAL_NAME, isPipe } from "./egress/config.js";
import { EgressLink, Gateway, GATEWAY_HOSTS, givenGateway, refuseCredentials, type EgressScope, type GatewayName } from "./gateway.js";

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
  /**
   * How decisions are taken (spec/envelope.md "Signed decisions"): `keys` is the directory of the members' public
   * keys, `<key id>.pem` each (default `.mandate/decision-keys`); `mode` is `signed` unless the configuration
   * says `unsigned`, which a package of 0.1 to 0.3 may run in.
   */
  decisions: { keys: string; mode: "signed" | "unsigned" };
  /** How long the check of a lead's sub-program may take, in milliseconds (spec/envelope.md "Limits"); 2000 unless it says. */
  plan?: { checkMs?: number };
  /**
   * How many violations stop a run (spec/boundary.md "Violations and halt"): 3 for a 0.5 package unless it says;
   * an earlier package's run stops only when it says.
   */
  violations?: { limit?: number };
  model?: { provider: "anthropic" };
  /** Executors the lock may bind agents to (K45): Claude Managed Agents. Their agents' tools still run in `sandbox` (K79). */
  executor?: { "managed-agents"?: { pollMs?: number; maxTurnMs?: number } };
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
  /** Checks of a drafted system model against the repositories (design doc 9 §7, B7). */
  onboard?: OnboardConfig;
  /** Where each component of a system model is cloned from, and the ref a run starts from (design doc 9 §12, B3). */
  workspace?: { components: Record<string, ComponentSource> };
  /**
   * The egress proxy (spec/boundary.md "The egress proxy"): `admin` is its admin channel, a Unix socket (relative to
   * the file) or a named pipe; `gateways` names the credential each of the control plane's gateways sends, as the
   * proxy's configuration names it.
   */
  egress?: { admin?: string; gateways?: Partial<Record<GatewayName, string>> };
  /** The configuration file itself, so a verifier process can read it too. */
  file?: string;
}

const KEYS: Record<string, string[]> = {
  "": ["database", "artifacts", "evidence", "rateLimits", "decisions", "plan", "violations", "model", "executor", "sandbox", "github", "verifier", "workspace", "boundary", "broker", "samples", "onboard", "egress"],
  egress: ["admin", "gateways"],
  "egress.gateways": ["model", "github"],
  plan: ["checkMs"],
  violations: ["limit"],
  executor: ["managed-agents"],
  "executor.managed-agents": ["pollMs", "maxTurnMs"],
  boundary: ["integration", "ci", "pinned", "extraRead", "timeoutMs"],
  onboard: ["hosts", "extraRead", "timeoutMs"],
  "boundary.integration": ["dir", "files", "service", "services", "env", "timeoutMs", "probeImage"],
  "boundary.ci": ["mode", "workflow"],
  workspace: ["components"],
  evidence: ["key", "trusted"],
  decisions: ["keys", "mode"],
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
  const dc = (c["decisions"] ?? {}) as { keys?: unknown; mode?: unknown };
  if (dc.keys !== undefined && typeof dc.keys !== "string") throw new Violation("bad_config", `${file}: "decisions.keys" is a directory`);
  if (dc.mode !== undefined && dc.mode !== "signed" && dc.mode !== "unsigned") throw new Violation("bad_config", `${file}: "decisions.mode" is "signed" or "unsigned"`);
  config.decisions = { keys: at((dc.keys as string | undefined) ?? ".mandate/decision-keys"), mode: dc.mode ?? "signed" };
  const checkMs = (c["plan"] as { checkMs?: unknown } | undefined)?.checkMs;
  if (checkMs !== undefined && (!Number.isInteger(checkMs) || (checkMs as number) < 1)) throw new Violation("bad_config", `${file}: "plan.checkMs" is a whole number of milliseconds, at least 1`);
  const limit = (c["violations"] as { limit?: unknown } | undefined)?.limit;
  if (c["violations"] !== undefined && (typeof c["violations"] !== "object" || c["violations"] === null || Array.isArray(c["violations"]))) throw new Violation("bad_config", `${file}: "violations" is { "limit": n }`);
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1)) throw new Violation("bad_config", `${file}: "violations.limit" is a whole number of violations, at least 1`);
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
  if (c["egress"] !== undefined) {
    const eg = c["egress"] as { admin?: unknown; gateways?: unknown };
    if (!eg || typeof eg !== "object" || Array.isArray(eg)) throw new Violation("bad_config", `${file}: "egress" is { "admin", "gateways" }`);
    if (eg.admin !== undefined && (typeof eg.admin !== "string" || eg.admin === "")) throw new Violation("bad_config", `${file}: "egress.admin" is the egress proxy's admin socket or named pipe`);
    if (eg.gateways !== undefined && (!eg.gateways || typeof eg.gateways !== "object" || Array.isArray(eg.gateways))) throw new Violation("bad_config", `${file}: "egress.gateways" is { "model", "github" }`);
    for (const [g, name] of Object.entries((eg.gateways ?? {}) as Record<string, unknown>)) {
      if (typeof name !== "string" || !CREDENTIAL_NAME.test(name)) throw new Violation("bad_config", `${file}: "egress.gateways.${g}" is the name of a credential the egress proxy holds (${CREDENTIAL_NAME.source})`);
    }
    if (typeof eg.admin === "string" && !isPipe(eg.admin)) config.egress!.admin = at(eg.admin);
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

/**
 * The public keys, as PEM text, whose evidence and anchors this runtime trusts besides its own key: the keys rotated
 * out (`mandate rotate-key`) and the files the configuration names. A file may hold a private key; its public half
 * is trusted (`TrustedKeys`).
 */
export function trustedKeyTexts(config: RuntimeConfig): string[] {
  return [...EvidenceSigner.trustedIn(trustedKeysDir(config)), ...(config.evidence.trusted ?? []).map((f) => readFileSync(f, "utf8"))];
}

/** The runtime's own stores: artifacts over the configured directory, and the evidence key. */
export function runtimeOptions(config: RuntimeConfig, db: Db): RuntimeOptions {
  return {
    artifacts: new ArtifactStore(db, new DirBlobs(config.artifacts)),
    signer: EvidenceSigner.loadOrCreate(config.evidence.key),
    // Keys rotated out (`mandate rotate-key`) and keys the configuration names: their evidence still counts.
    trustedKeys: trustedKeyTexts(config),
    ...(config.rateLimits ? { rateLimits: config.rateLimits } : {}),
    ...(config.verifier?.process ? { trustedVerifiers: verifierKeys(config), inProcessMethods: inProcessMethods(config) } : {}),
    // The members' public keys; a file that is not the key its name says stops every command (bad_decision_key).
    decisions: { mode: config.decisions.mode, keys: decisionKeysIn(config.decisions.keys) },
    ...(config.plan?.checkMs !== undefined ? { plan: { checkMs: config.plan.checkMs } } : {}),
    ...(config.violations?.limit !== undefined ? { violations: { limit: config.violations.limit } } : {}),
  };
}

/** Whether the configuration runs boundary checks in this process: they need the run's working copies, and a sandbox. */
function runsBoundary(config: RuntimeConfig): boolean {
  return !!config.boundary && !!config.sandbox;
}

/** Whether the configuration runs onboarding checks in this process. */
function runsOnboard(config: RuntimeConfig): boolean {
  return !!config.onboard;
}

/**
 * The methods this configuration checks in the runtime's process even with a verifier process of its own:
 * `adaptersFor` puts the boundary and onboarding verifiers in front of it, and they answer these themselves.
 * Their evidence carries no verifier attestation; every other check's does.
 */
export function inProcessMethods(config: RuntimeConfig): string[] {
  return [...(runsBoundary(config) ? BOUNDARY_METHODS : []), ...(runsOnboard(config) ? ONBOARD_METHODS : [])];
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
  // Creating a key needs nothing of the runtime's environment (env.ts).
  if (!vp.trusted && !existsSync(files[0]!)) execFileSync(main[0]!, [...main.slice(1), "--init-key", vp.key], { stdio: ["ignore", "ignore", "inherit"], env: childEnv() });
  return new TrustedKeys(files.map((f) => readFileSync(f, "utf8")));
}

/** A verifier in this process, from the configuration: the verifier process runs this one. */
export function localVerifier(config: RuntimeConfig, program: Program, lock: Lock, env: NodeJS.ProcessEnv = process.env): VerifierAdapter {
  const sandbox = sandboxFor(config);
  if (!config.verifier || !sandbox) return { check: async () => missing("verifier") };
  // With the model gateway on, the runtime gave this process a session's address and placeholder, and no key.
  const gateways = config.egress?.gateways ?? {};
  refuseCredentials(gateways, env);
  return new SandboxVerifier(config.verifier, sandbox, modelFor(config, program, lock, env, gateways.model !== undefined ? givenGateway(env) : undefined));
}

/** The Anthropic API's own address, which a gateway's `fetch` sends to its session instead. */
const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * What an adapter holds in place of a secret behind a gateway: no secret, and not the placeholder either, which
 * changes with each session; the gateway's `fetch` puts the current session's placeholder in the header.
 */
export const GATEWAY_STAND_IN = "mandate-egress-gateway";

function modelFor(config: RuntimeConfig, program: Program, lock: Lock, env: NodeJS.ProcessEnv, gateway?: typeof fetch): AnthropicModel | undefined {
  if (!config.model) return undefined;
  if (gateway) {
    const workspaceId = workspaceOf(env);
    return new AnthropicModel({ lock, program, apiKey: GATEWAY_STAND_IN, baseURL: ANTHROPIC_API, fetch: gateway, ...(workspaceId ? { workspaceId } : {}) });
  }
  const { apiKey, workspaceId } = anthropicCredentials(env, "model.provider is anthropic");
  return new AnthropicModel({ lock, program, apiKey, ...(workspaceId ? { workspaceId } : {}) });
}

function workspaceOf(env: NodeJS.ProcessEnv): string | undefined {
  return env["CLAUDE_WORKSPACE_ID"] ?? env["anthropic-workspace-id"];
}

/** The Anthropic API key and workspace, from the environment only (K7). */
export function anthropicCredentials(env: NodeJS.ProcessEnv, why: string): { apiKey: string; workspaceId?: string } {
  const apiKey = env["CLAUDE_API_KEY"] ?? env["ANTHROPIC_API_KEY"];
  if (!apiKey) throw new Violation("no_credentials", `${why}, but neither CLAUDE_API_KEY nor ANTHROPIC_API_KEY is set.`);
  const workspaceId = workspaceOf(env);
  return { apiKey, ...(workspaceId ? { workspaceId } : {}) };
}

/**
 * An SDK client for the Anthropic API, with the workspace header when the key needs one. Through a model gateway,
 * it holds no key: it sends with the gateway's `fetch`.
 */
export function anthropicClient(env: NodeJS.ProcessEnv, why: string, gateway?: typeof fetch): Anthropic {
  if (gateway) {
    const workspaceId = workspaceOf(env);
    return new Anthropic({ apiKey: GATEWAY_STAND_IN, authToken: null, baseURL: ANTHROPIC_API, fetch: gateway, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
  }
  const { apiKey, workspaceId } = anthropicCredentials(env, why);
  return new Anthropic({ apiKey, ...(workspaceId ? { defaultHeaders: { "anthropic-workspace-id": workspaceId } } : {}) });
}

/**
 * The Managed Agents executor for a lock that binds agents to it. A lock
 * that binds agents and a configuration without the executor give none: the
 * run then refuses to start (no_executor), and a bound agent never runs
 * anywhere else.
 */
function executorFor(config: RuntimeConfig, lock: Lock, env: NodeJS.ProcessEnv, gateway?: typeof fetch): Executor | undefined {
  const binding = lock.bindings?.["managed-agents"];
  const c = config.executor?.["managed-agents"];
  if (!binding || !c) return undefined;
  const api = sdkApi(anthropicClient(env, "executor.managed-agents is configured", gateway));
  return managedAgentsExecutor({ binding, lock, api, ...(c.pollMs ? { pollMs: c.pollMs } : {}), ...(c.maxTurnMs ? { maxTurnMs: c.maxTurnMs } : {}) });
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

function boundaryVerifier(config: RuntimeConfig, sandbox: MxcAdapter, env: NodeJS.ProcessEnv, inner: VerifierAdapter | undefined, github?: typeof fetch): BoundaryVerifier {
  const b = config.boundary!;
  const token = github ? GATEWAY_STAND_IN : env["MANDATE_GITHUB_TOKEN"];
  const ci = b.ci && token ? { ci: { ...(b.ci.mode ? { mode: b.ci.mode } : {}), source: new GitHubCi({ token, ...(b.ci.workflow ? { workflow: b.ci.workflow } : {}), ...(github ? { fetch: github } : {}) }) } } : {};
  if (b.ci && !token) throw new Violation("no_credentials", "boundary.ci reads GitHub Actions, but MANDATE_GITHUB_TOKEN is not set.");
  return new BoundaryVerifier({ ...(b.integration ? { integration: b.integration } : {}), ...(b.pinned ? { pinned: b.pinned } : {}), ...(b.extraRead ? { extraRead: b.extraRead } : {}), ...(b.timeoutMs ? { timeoutMs: b.timeoutMs } : {}), ...ci }, sandbox, realDocker, inner);
}

/**
 * The adapters of a command that acts on runs without running a package, `mandate halt`: an operator's emergency
 * stop needs no model, no executor and no secret, so none is read, and none is refused: a halt works from any shell,
 * whatever its environment holds (no `credential_in_environment`). Nothing here calls out except one thing: when the
 * configuration names an egress proxy (`egress.admin`, with or without gateways), `revoke` goes to it over the
 * admin channel, so the sessions of the halted scope are cut. The connection is made by the first `revoke` and only
 * then, never by building the adapters; `egress.close` closes it. No session is opened. An action whose outcome is
 * unknown is left for `mandate reconcile`.
 *
 * `timeoutMs` is how long the proxy may take to accept the connection and to answer `revoke`; a halt does not wait
 * on a proxy that does not answer longer than that, and reports that revoking failed.
 */
export function operatorAdapters(config: RuntimeConfig, o: { timeoutMs?: number } = {}): Adapters {
  const admin = config.egress?.admin;
  const link = admin ? new EgressLink({ admin, timeoutMs: o.timeoutMs ?? OPERATOR_REVOKE_TIMEOUT_MS }) : undefined;
  return {
    agents: { run: async () => missing("agent adapter") },
    model: { infer: async () => missing("model"), upperBound: () => missing("model") },
    verifier: { check: async () => missing("verifier") },
    reads: { call: async () => missing("reader") },
    tools: {},
    clock: wallClock,
    random: Math.random,
    ...(link ? { revoke: (scope) => link.revoke(scope), egress: { ready: async () => undefined, close: () => link.closeAll() } } : {}),
  };
}

/** How long `mandate halt` waits for the egress proxy to accept its connection, and again to answer `revoke`. */
export const OPERATOR_REVOKE_TIMEOUT_MS = 10_000;

/** A stand-in for an adapter the configuration leaves out: calling it stops the run for a person. */
function missing(what: string): never {
  throw new Violation("no_adapter", `The runtime configuration has no ${what}.`);
}

/** The egress proxy behind the control plane's gateways, as the configuration names it. */
interface EgressSetup {
  link: EgressLink;
  gateways: Partial<Record<GatewayName, string>>;
  on: GatewayName[];
  model?: Gateway;
  github?: Gateway;
}

/**
 * The runtime's link to the egress proxy and its gateways; none without `egress.admin`. A gateway asked for without a
 * proxy is `no_egress_proxy`; a gateway's secret in the runtime's environment is `credential_in_environment`.
 * Nothing here reaches the proxy: a session is opened at a gateway's first request.
 */
function egressFor(config: RuntimeConfig, env: NodeJS.ProcessEnv, scope: EgressScope | undefined): EgressSetup | undefined {
  const eg = config.egress;
  if (!eg) return undefined;
  const gateways = eg.gateways ?? {};
  const on = (["model", "github"] as const).filter((g) => gateways[g] !== undefined);
  if (!eg.admin) {
    if (on.length) throw new Violation("no_egress_proxy", `egress.gateways turns on the ${on.join(" and ")} gateway, and egress.admin names no egress proxy.`);
    return undefined;
  }
  refuseCredentials(gateways, env);
  const link = new EgressLink({ admin: eg.admin, ...(scope ? { scope } : {}) });
  return {
    link,
    gateways,
    on,
    ...(gateways.model !== undefined ? { model: new Gateway(link, "model", gateways.model) } : {}),
    ...(gateways.github !== undefined ? { github: new Gateway(link, "github", gateways.github) } : {}),
  };
}

/**
 * The verifier process's environment. With the model gateway on and a model configured, it is made when the process
 * starts: a gateway session of its own, opened for it, whose address and placeholder are all it gets of the model's
 * credential. The process is started again with a new session before a check that finds it idle with its session
 * near its end.
 */
function verifierEnvFor(config: RuntimeConfig, env: NodeJS.ProcessEnv, egress: EgressSetup | undefined): NodeJS.ProcessEnv | ChildEnvSource {
  const credential = egress?.gateways.model;
  if (!config.model || !egress || credential === undefined) return verifierEnv({ model: !!config.model }, env);
  const link = egress.link;
  return {
    make: async () => {
      const s = await link.open("verifier.model", GATEWAY_HOSTS.model, credential);
      return {
        env: verifierEnv({ model: true, gateway: { url: s.base_url, placeholder: s.placeholder } }, env),
        stale: () => s.expiresAt - link.now() <= link.renewMs,
        release: () => void link.close(s.session),
      };
    },
  };
}

/**
 * The adapters for a package. The model adapter needs the program and its
 * lock; secrets are read from the environment here and nowhere else (K7, K18).
 * A verifier process is started with `main` (the program and its arguments)
 * and gets only the variables env.ts `verifierEnv` lets through.
 *
 * With `egress` configured, `scope` names the run (and its tenant) the
 * gateways' sessions are opened for, so that revoking the run or the tenant
 * cuts them; a gateway adapter holds no secret and sends through the proxy.
 */
export function adaptersFor(config: RuntimeConfig, program: Program, lock: Lock, env: NodeJS.ProcessEnv = process.env, main: string[] = [process.execPath, VERIFIER_MAIN], scope?: EgressScope): Adapters {
  const egress = egressFor(config, env, scope);
  const model = modelFor(config, program, lock, env, egress?.model?.fetch);
  const tools: Record<string, ToolAdapter> = {};
  if (config.github) {
    const token = egress?.github ? GATEWAY_STAND_IN : env["MANDATE_GITHUB_TOKEN"];
    if (!token) throw new Violation("no_credentials", "github is configured, but MANDATE_GITHUB_TOKEN is not set.");
    const base = config.github.base ? { base: config.github.base } : {};
    const via = egress?.github ? { fetch: egress.github.fetch } : {};
    if (config.github.repo && config.github.workdir) tools["git.open_pr"] = new GitHubPullRequests({ token, repo: config.github.repo, workdir: config.github.workdir, ...base, ...via });
    if (config.github.repos?.length) tools["git.merge"] = new GitHubMerges({ token, repos: config.github.repos, ...base, ...via });
  }
  const sandbox = sandboxFor(config);
  const executor = executorFor(config, lock, env, egress?.model?.fetch);
  const own = config.verifier?.process
    ? new ProcessVerifier({ command: [...main, "--config", config.file!], trusted: verifierKeys(config, main), package: { program, lock }, env: verifierEnvFor(config, env, egress) })
    : config.verifier && sandbox
      ? new SandboxVerifier(config.verifier, sandbox, model)
      : undefined;
  // Boundary checks need the run's working copies, so they run in this process; other checks go to the verifier above.
  // inProcessMethods says which methods these two answer, from the same conditions.
  const boundary = runsBoundary(config) && sandbox ? boundaryVerifier(config, sandbox, env, own, egress?.github?.fetch) : undefined;
  const onboard = runsOnboard(config) ? new OnboardVerifier(config.onboard!, sandbox, boundary ?? own) : undefined;
  return {
    agents: { run: async () => missing("agent adapter: agents run as agent loops, which need model and sandbox") },
    ...(sandbox && (model || executor)
      ? { loop: { chat: model ?? { turnBound: () => missing("model"), turn: () => missing("model") }, sandbox, ...(executor ? { executor } : {}) } }
      : {}),
    model: model ?? { infer: async () => missing("model"), upperBound: () => missing("model") },
    // A verifier process of its own signs each check with its own key; otherwise the checks run here.
    verifier: onboard ?? boundary ?? own ?? { check: async () => missing("verifier") },
    reads: { call: async () => missing("reader") },
    tools,
    ...(config.workspace ? { workspace: new GitWorkspace(config.workspace.components) } : {}),
    ...(config.broker ? { broker: brokerFor(config, env) } : {}),
    ...(config.samples ? { samples: new SampleReads(JSON.parse(readFileSync(config.samples, "utf8")) as Record<string, Value[]>) } : {}),
    clock: wallClock,
    random: Math.random,
    ...(egress ? egressAdapters(egress) : {}),
  };
}

/** What the runtime does with the proxy itself: check it before a start, revoke through it, and close what it opened. */
function egressAdapters(egress: EgressSetup): Pick<Adapters, "revoke" | "egress"> {
  return {
    revoke: (scope) => egress.link.revoke(scope),
    egress: {
      ready: async () => {
        if (egress.on.length) await egress.link.ready(egress.gateways);
      },
      close: () => egress.link.closeAll(),
    },
  };
}
