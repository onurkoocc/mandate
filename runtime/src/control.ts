// What the control CLI runs against (BACKLOG K19): one configuration file,
// `mandate.runtime.json`, that names the database and the adapters, and the
// secrets, which come only from the environment. Without an adapter in the
// configuration, the runtime refuses to call it: a run that needs it stops
// for a person instead of running against something simulated.
//
//   {
//     "database": "pglite:.mandate/db" | "postgresql://…",
//     "model":    { "provider": "anthropic" },                  // CLAUDE_API_KEY, CLAUDE_WORKSPACE_ID
//     "sandbox":  { "host": "mxc", "baseline": ["/usr/local"] },
//     "github":   { "repo": "owner/name", "base": "main", "workdir": "/work/repo" },   // MANDATE_GITHUB_TOKEN
//     "verifier": { "workdir": "/work/repo", "base": "seed", "suites": { "unit": "test/**/*.test.ts" }, "command": ["node", "--test"] }
//   }

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseStrictJson, type Lock, type Program } from "@mandate/compiler";
import type { Adapters, ToolAdapter } from "./adapters.js";
import { AnthropicModel } from "./anthropic.js";
import { openDb, type Db } from "./db.js";
import { GitHubPullRequests } from "./github.js";
import { MxcHost } from "./mxc.js";
import { MxcAdapter } from "./sandbox.js";
import { wallClock } from "./sim.js";
import { Violation } from "./signals.js";
import { SandboxVerifier, type VerifierConfig } from "./verifier.js";

export interface RuntimeConfig {
  database: string;
  model?: { provider: "anthropic" };
  sandbox?: { host: "mxc"; baseline?: string[] };
  github?: { repo: string; base?: string; workdir: string };
  verifier?: VerifierConfig;
}

const KEYS: Record<string, string[]> = {
  "": ["database", "model", "sandbox", "github", "verifier"],
  model: ["provider"],
  sandbox: ["host", "baseline"],
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
  if (config.github) config.github.workdir = at(config.github.workdir);
  if (config.verifier) config.verifier.workdir = at(config.verifier.workdir);
  return config;
}

export function connect(config: RuntimeConfig): Promise<Db> {
  return openDb(config.database);
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
  const sandbox = config.sandbox ? new MxcAdapter({ host: new MxcHost({ ...(config.sandbox.baseline ? { baseline: config.sandbox.baseline } : {}) }), schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true }) : undefined;
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
