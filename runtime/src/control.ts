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
//     "verifier": { "workdir": "/work/repo", "base": "seed", "suites": { "unit": "test/**/*.test.ts" }, "command": ["node", "--test"] }
//   }

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseStrictJson, type Lock, type Program } from "@mandate/compiler";
import type { Adapters, ToolAdapter } from "./adapters.js";
import { AnthropicModel } from "./anthropic.js";
import { ArtifactStore, DirBlobs } from "./artifacts.js";
import { EvidenceSigner } from "./evidence.js";
import type { BucketConfig } from "./ratelimit.js";
import type { RuntimeOptions } from "./runtime.js";
import { openDb, type Db } from "./db.js";
import { GitHubPullRequests } from "./github.js";
import { MxcHost } from "./mxc.js";
import { WindowsMxcHost } from "./mxc-windows.js";
import { MxcAdapter } from "./sandbox.js";
import { wallClock } from "./sim.js";
import { Violation } from "./signals.js";
import { SandboxVerifier, type VerifierConfig } from "./verifier.js";

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
  github?: { repo: string; base?: string; workdir: string };
  verifier?: VerifierConfig;
}

const KEYS: Record<string, string[]> = {
  "": ["database", "artifacts", "evidence", "rateLimits", "model", "sandbox", "github", "verifier"],
  evidence: ["key", "trusted"],
  model: ["provider"],
  sandbox: ["host", "baseline", "path", "toolchain", "isolation", "mode"],
  github: ["repo", "base", "workdir"],
  verifier: ["workdir", "base", "suites", "command", "timeoutMs"],
};

/** Reads `mandate.runtime.json` strictly: unknown fields are refused. Relative paths are relative to the file. */
export function readConfig(file: string): RuntimeConfig {
  const parsed = parseStrictJson(readFileSync(file, "utf8"));
  if (!parsed.ok) throw new Violation("bad_config", `${file}: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  const c = parsed.value.value as unknown as Record<string, Record<string, unknown>>;
  for (const [section, allowed] of Object.entries(KEYS)) {
    const obj = section ? c[section] : c;
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
  if (config.github) config.github.workdir = at(config.github.workdir);
  if (config.verifier) config.verifier.workdir = at(config.verifier.workdir);
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
  };
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
  let model: AnthropicModel | undefined;
  if (config.model) {
    const apiKey = env["CLAUDE_API_KEY"] ?? env["ANTHROPIC_API_KEY"];
    if (!apiKey) throw new Violation("no_credentials", "model.provider is anthropic, but neither CLAUDE_API_KEY nor ANTHROPIC_API_KEY is set.");
    const workspaceId = env["CLAUDE_WORKSPACE_ID"] ?? env["anthropic-workspace-id"];
    model = new AnthropicModel({ lock, program, apiKey, ...(workspaceId ? { workspaceId } : {}) });
  }
  const tools: Record<string, ToolAdapter> = {};
  if (config.github) {
    const token = env["MANDATE_GITHUB_TOKEN"];
    if (!token) throw new Violation("no_credentials", "github is configured, but MANDATE_GITHUB_TOKEN is not set.");
    tools["git.open_pr"] = new GitHubPullRequests({ token, repo: config.github.repo, workdir: config.github.workdir, ...(config.github.base ? { base: config.github.base } : {}) });
  }
  // Linux: Bubblewrap; Windows: the AppContainer process container (P2-27). Each refuses by name what it cannot enforce.
  const s = config.sandbox;
  const host = !s
    ? undefined
    : process.platform === "win32"
      ? new WindowsMxcHost({ ...(s.toolchain ? { toolchain: s.toolchain } : {}), ...(s.isolation ? { backend: s.isolation } : {}) })
      : new MxcHost({ ...(s.baseline ? { baseline: s.baseline } : {}), ...(s.path ? { path: s.path } : {}) });
  const sandbox = host ? new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true, ...(s?.isolation ? { isolation: s.isolation } : {}), ...(s?.mode ? { mode: s.mode } : {}) }) : undefined;
  return {
    agents: { run: async () => missing("agent adapter: agents run as agent loops, which need model and sandbox") },
    ...(model && sandbox ? { loop: { chat: model, sandbox } } : {}),
    model: model ?? { infer: async () => missing("model"), upperBound: () => missing("model") },
    verifier: config.verifier && sandbox ? new SandboxVerifier(config.verifier, sandbox, model) : { check: async () => missing("verifier") },
    reads: { call: async () => missing("reader") },
    tools,
    clock: wallClock,
    random: Math.random,
  };
}
