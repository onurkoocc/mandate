// The egress proxy's configuration (spec/egress.md "Configuration"): where its
// admin channel listens, the loopback address its sessions listen on, and the
// credentials it holds, each bound to the hosts it may be sent to. It is read
// strictly, as the runtime's own configuration is: an unknown field is an
// error, not a field ignored. The secrets themselves are not in the file; each
// credential names the environment variable that holds it, read once, at start.

import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseStrictJson } from "@mandate/compiler";
import { Violation } from "../signals.js";

/** The admin protocol's version, which `hello` answers with. */
export const EGRESS_FORMAT = "mandate/egress/0.1";

export interface EgressCredential {
  /** The environment variable of the proxy's own process that holds the secret. */
  env: string;
  /** The only hosts this credential may be sent to. */
  hosts: string[];
  /** The request header it is sent in, lower case. */
  header: string;
  /** The header's value, with `{secret}` once where the secret goes: `Bearer {secret}`. */
  template: string;
}

export interface EgressConfig {
  /** A Unix socket path, or a Windows named pipe `\\.\pipe\…`. */
  admin: string;
  /** A loopback IP address; every session listens on its own port of it. */
  listen: string;
  credentials: Record<string, EgressCredential>;
  /** Whether a name may resolve to a private, loopback, link-local or metadata address. Off by default. */
  allow_private: boolean;
  /** Extra trust roots (PEM) for upstream certificates, as a path; the system's roots are trusted as well. */
  ca?: string;
}

const KEYS = ["admin", "listen", "credentials", "allow_private", "ca"];
const CREDENTIAL_KEYS = ["env", "hosts", "header", "template"];

/** A credential's name: what a session binds and what `hello` lists. */
export const CREDENTIAL_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Headers the proxy itself sets or removes; a credential is never sent in one. */
const RESERVED_HEADERS = new Set(["host", "content-length", "transfer-encoding", "connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "upgrade", "expect", "accept-encoding", "http2-settings"]);
/** The shortest secret the proxy holds: a shorter one would be scrubbed out of ordinary text in every response. */
export const MIN_SECRET_BYTES = 8;
export const MAX_SECRET_BYTES = 8192;

/**
 * A host name as a destination, a credential or a request names it: labels of lower case letters, digits and
 * hyphens, not starting or ending with a hyphen, at most 63 characters each and 253 in all (RFC 1123); or an IP
 * address. An underscore, which DNS allows in names that are not host names, is refused.
 */
export function validHost(h: unknown): h is string {
  if (typeof h !== "string" || h.length === 0 || h.length > 253) return false;
  if (isIP(h)) return h === h.toLowerCase();
  return h.split(".").every((l) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** Whether `a` is an address on the loopback interface. */
export function isLoopback(a: string): boolean {
  if (isIP(a) === 4) return a.split(".")[0] === "127";
  return a === "::1";
}

/** Reads `mandate.egress.json` strictly. A relative `admin` socket or `ca` path is relative to the file. */
export function readEgressConfig(file: string): EgressConfig {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new Violation("bad_egress_config", `${file}: ${(e as Error).message}`);
  }
  const parsed = parseStrictJson(text);
  if (!parsed.ok) throw new Violation("bad_egress_config", `${file}: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return egressConfig(parsed.value.value, file, dirname(resolve(file)));
}

/** Checks a configuration value as `readEgressConfig` does; `where` names it in errors, `base` resolves relative paths. */
export function egressConfig(value: unknown, where: string, base: string): EgressConfig {
  const bad = (m: string): never => {
    throw new Violation("bad_egress_config", `${where}: ${m}`);
  };
  if (!isRecord(value)) bad("the configuration is a JSON object");
  const c = value as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!KEYS.includes(k)) bad(`unknown field ${k}`);
  if (typeof c["admin"] !== "string" || c["admin"].length === 0) bad(`"admin" is required: a Unix socket path, or a named pipe \\\\.\\pipe\\… on Windows`);
  const admin = isPipe(c["admin"] as string) || isAbsolute(c["admin"] as string) ? (c["admin"] as string) : resolve(base, c["admin"] as string);
  const listen = c["listen"] ?? "127.0.0.1";
  if (typeof listen !== "string" || !isIP(listen) || !isLoopback(listen)) bad(`"listen" is a loopback IP address, such as 127.0.0.1 or ::1`);
  if (c["allow_private"] !== undefined && typeof c["allow_private"] !== "boolean") bad(`"allow_private" is true or false`);
  if (c["ca"] !== undefined && (typeof c["ca"] !== "string" || c["ca"].length === 0)) bad(`"ca" is the path of a PEM file of trust roots`);
  const credentials: Record<string, EgressCredential> = {};
  const raw = c["credentials"] ?? {};
  if (!isRecord(raw)) bad(`"credentials" maps names to { "env", "hosts", "header", "template" }`);
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    const at = `credentials.${name}`;
    if (!CREDENTIAL_NAME.test(name)) bad(`${at}: a credential's name is lower case letters, digits, "_" and "-", starting with a letter`);
    if (!isRecord(v)) bad(`${at} is { "env", "hosts", "header", "template" }`);
    const cr = v as Record<string, unknown>;
    for (const k of Object.keys(cr)) if (!CREDENTIAL_KEYS.includes(k)) bad(`unknown field ${at}.${k}`);
    if (typeof cr["env"] !== "string" || !ENV_NAME.test(cr["env"])) bad(`${at}.env is the name of an environment variable`);
    const hosts = cr["hosts"];
    if (!Array.isArray(hosts) || hosts.length === 0 || !hosts.every(validHost)) bad(`${at}.hosts is a non-empty list of host names in lower case, without a port`);
    if (new Set(hosts as string[]).size !== (hosts as string[]).length) bad(`${at}.hosts lists a host twice`);
    const header = cr["header"];
    if (typeof header !== "string" || !TOKEN.test(header) || header !== header.toLowerCase()) bad(`${at}.header is a header name in lower case`);
    if (RESERVED_HEADERS.has(header as string)) bad(`${at}.header cannot be ${header as string}: the proxy sets or removes that header itself`);
    const template = cr["template"];
    if (typeof template !== "string" || template.split("{secret}").length !== 2) bad(`${at}.template has {secret} exactly once, as in "Bearer {secret}"`);
    if (!/^[\x20-\x7e]*$/.test(template as string) || (template as string) !== (template as string).trim()) bad(`${at}.template is printable ASCII without leading or trailing spaces`);
    credentials[name] = { env: cr["env"] as string, hosts: hosts as string[], header: header as string, template: template as string };
  }
  return {
    admin,
    listen: listen as string,
    credentials,
    allow_private: (c["allow_private"] as boolean | undefined) ?? false,
    ...(c["ca"] !== undefined ? { ca: isAbsolute(c["ca"] as string) ? (c["ca"] as string) : resolve(base, c["ca"] as string) } : {}),
  };
}

/**
 * Each credential's secret, read from the environment variable its configuration names. A missing or empty
 * variable stops the proxy before it listens (`egress_secret_missing`), as does a value that could not be sent
 * as a header or scrubbed from a response (`egress_secret_invalid`). The error names the variable, never its value.
 */
export function readSecrets(config: EgressConfig, env: NodeJS.ProcessEnv): Map<string, Buffer> {
  const secrets = new Map<string, Buffer>();
  for (const [name, c] of Object.entries(config.credentials)) {
    const v = env[c.env];
    if (v === undefined || v === "") throw new Violation("egress_secret_missing", `credential ${name}: the environment variable ${c.env} is not set`);
    const bytes = Buffer.from(v, "utf8");
    if (!/^[\x21-\x7e]+$/.test(v)) throw new Violation("egress_secret_invalid", `credential ${name}: the value of ${c.env} is not printable ASCII without spaces`);
    if (bytes.length < MIN_SECRET_BYTES || bytes.length > MAX_SECRET_BYTES) throw new Violation("egress_secret_invalid", `credential ${name}: the value of ${c.env} is not between ${MIN_SECRET_BYTES} and ${MAX_SECRET_BYTES} bytes long`);
    secrets.set(name, bytes);
  }
  return secrets;
}

export function isPipe(p: string): boolean {
  return /^\\\\[.?]\\pipe\\/i.test(p);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
