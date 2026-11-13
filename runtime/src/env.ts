// The environment of the processes the runtime starts. The runtime reads its
// secrets from its own environment (K7): the model's key, the GitHub token,
// the read broker's database logins. A process it starts gets none of that
// by default: only what a program needs to run at all on Linux and on
// Windows, and the variables its caller names. The verifier process and
// `docker` are started this way; a sandboxed process gets less still
// (mxc.ts, mxc-windows.ts).

import { GATEWAY_ENV } from "./gateway.js";

/** What any program needs to start and find its way, by group. */
const BASE: readonly string[] = [
  // The search path, and on Windows the extensions a command name is tried with.
  "PATH",
  "PATHEXT",
  // Windows: the system directory (DLLs, System32), the system drive, and the shell that runs `.cmd` files.
  "SystemRoot",
  "windir",
  "SystemDrive",
  "ComSpec",
  // Windows: where programs are installed and keep shared data, e.g. Docker's CLI plugins.
  "ProgramFiles",
  "ProgramData",
  // Temporary files.
  "TMPDIR",
  "TEMP",
  "TMP",
  // The user's home and profile, where configuration is read from (git's, Docker's): Linux, then Windows.
  "HOME",
  "USER",
  "LOGNAME",
  "USERPROFILE",
  "USERNAME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  // Language, character set and time zone.
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
];

/** The sandbox SDK's own settings (@microsoft/mxc-sdk): where its binaries are, and its diagnostics. */
export const SANDBOX_ENV: readonly string[] = ["MXC_BIN_DIR", "MXC_FFI_DIR", "MXC_DIAG_CONSOLE"];

/**
 * What a model-backed check needs (control.ts `anthropicCredentials`): the API key and workspace, the API's
 * address when it is not the default, and the proxy and certificates the way to it may need.
 */
export const MODEL_ENV: readonly string[] = [
  "CLAUDE_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_WORKSPACE_ID",
  "anthropic-workspace-id",
  "ANTHROPIC_BASE_URL",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
];

/** The Docker client's settings: which engine, its context, configuration and TLS, and a rootless engine's socket. */
export const DOCKER_ENV: readonly string[] = ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY", "XDG_RUNTIME_DIR"];

/**
 * The verifier process's environment (verifier-main.ts): what a program needs, the sandbox SDK's settings, and,
 * when the configuration has a model and so the verifier runs model-backed checks (a review), what those need.
 * Never the GitHub token or the read broker's database logins: the verifier reads neither.
 */
export function verifierEnv(o: { model: boolean; gateway?: { url: string; placeholder: string } }, from: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const model = o.model;
  // With the model gateway on (gateway.ts), what a model-backed check needs is the address and placeholder of a
  // gateway session opened for this process, and the workspace, which is no secret: never a key, nor a proxy of the way out.
  if (model && o.gateway) return childEnv({ pass: [...SANDBOX_ENV, ...GATEWAY_MODEL_ENV], set: { [GATEWAY_ENV.url]: o.gateway.url, [GATEWAY_ENV.placeholder]: o.gateway.placeholder } }, from);
  return childEnv({ pass: [...SANDBOX_ENV, ...(model ? MODEL_ENV : [])] }, from);
}

/** What a model-backed check takes from the runtime's environment when the model gateway is on: the workspace only. */
export const GATEWAY_MODEL_ENV: readonly string[] = ["CLAUDE_WORKSPACE_ID", "anthropic-workspace-id"];

/**
 * The environment for a process the runtime starts: from `from` (the runtime's own), the base variables and the
 * ones `pass` names, and then what `set` gives. On Windows names are matched without regard to case, as Windows
 * does, and kept with the casing they are stored under (`Path`).
 */
export function childEnv(o: { pass?: readonly string[]; set?: Record<string, string> } = {}, from: NodeJS.ProcessEnv = process.env, windows = process.platform === "win32"): Record<string, string> {
  const fold = (name: string): string => (windows ? name.toUpperCase() : name);
  const wanted = new Set([...BASE, ...(o.pass ?? [])].map(fold));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(from)) if (value !== undefined && wanted.has(fold(name))) out[name] = value;
  for (const [name, value] of Object.entries(o.set ?? {})) {
    for (const k of Object.keys(out)) if (fold(k) === fold(name)) delete out[k];
    out[name] = value;
  }
  return out;
}
