// The reference egress proxy (spec/egress.md): sessions, and the data path
// each session's loopback port serves. The proxy holds the secrets; a client
// holds a per-session placeholder, which the proxy swaps for the secret only
// in the configured header of a request to a host the credential is bound to,
// on its way out over TLS. Everything a session may reach is named when it is
// opened; a request outside that is refused before anything goes upstream,
// and the refusal is recorded for `denials`.
//
// A `forward` session is an HTTP/1.1 forward proxy for a sandbox: it takes
// absolute-form `http://host/…` requests, and `CONNECT host:443` to a
// destination without credential or method restriction.

import { randomBytes } from "node:crypto";
import { createServer, isIP, type Server, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { validHost, type EgressConfig } from "./config.js";

/** Why the data path refused a request. The first six are the contract's; the others name rules it adds. */
export const DENIAL_REASONS = [
  "host_not_allowed",
  "method_not_allowed",
  "placeholder_misuse",
  "connect_not_allowed",
  "resolved_private",
  "session_revoked",
  "session_expired",
  "port_not_allowed",
  "upgrade_not_allowed",
  "malformed_request",
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];

/** What a placeholder looks like: `mdt-ph-` and 128 random bits in hex. Seen anywhere it is not swapped, it is a denial. */
export const PLACEHOLDER = /mdt-ph-[0-9a-f]{32}/;

export interface Destination {
  host: string;
  /** The methods allowed toward it; null allows any. */
  methods: string[] | null;
  /** The credential bound to it, by name; null sends none. */
  credential: string | null;
}

export interface SessionRequest {
  session: string;
  tenant: string;
  run: string;
  command: string;
  kind: "forward" | "gateway";
  destinations: Destination[];
  ttl_ms: number;
}

export type OpenedSession = { proxy_url: string; placeholders: Record<string, string> } | { base_url: string; placeholders: Record<string, string> };

export interface Denial {
  id: number;
  host: string | null;
  method: string | null;
  why: DenialReason;
  /** `sha256:` and the hex SHA-256 of the request's path and query as received; null for CONNECT or when there was none. */
  path_digest: string | null;
  at: string;
}

export type RevokeScope = { session: string } | { run: string } | { tenant: string } | { all: true };

/** An error of the admin protocol: a request the proxy will not carry out. */
export class EgressError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

export interface EgressProxyOptions {
  config: EgressConfig;
  /** Each credential's secret, by name (`readSecrets`). */
  secrets: Map<string, Buffer>;
  /** How long a revoked or expired session keeps answering denials before it is closed. */
  lingerMs?: number;
  now?: () => Date;
}

export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const MAX_DESTINATIONS = 256;
const MAX_TTL_MS = 2_147_483_647;
const LINGER_MS = 600_000;

interface Session {
  id: string;
  tenant: string;
  run: string;
  command: string;
  kind: "forward" | "gateway";
  destinations: Map<string, Destination>;
  /** Credential name → this session's placeholder for it. */
  placeholders: Map<string, string>;
  server: Server;
  port: number;
  state: "open" | "revoked" | "expired";
  /** Every client and upstream stream of the session, destroyed when it is revoked, expires or closes. */
  streams: Set<Duplex>;
  denials: Denial[];
  dropped: number;
  timers: NodeJS.Timeout[];
}

export class EgressProxy {
  readonly config: EgressConfig;
  private readonly secrets: Map<string, Buffer>;
  private readonly lingerMs: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, Session>();
  private closed = false;

  constructor(o: EgressProxyOptions) {
    this.config = o.config;
    this.secrets = o.secrets;
    for (const name of Object.keys(o.config.credentials)) if (!o.secrets.has(name)) throw new EgressError("egress_secret_missing", `credential ${name} has no secret`);
    this.lingerMs = o.lingerMs ?? LINGER_MS;
    this.now = o.now ?? (() => new Date());
  }

  /** The names of the credentials the proxy holds; never their secrets. */
  credentials(): string[] {
    return Object.keys(this.config.credentials).sort();
  }

  /**
   * Opens a session on a port of its own. A credential may be bound only to a host the proxy's own configuration
   * lists for it (`credential_not_allowed`): which secret may go where is the proxy's to say, not the caller's.
   */
  async openSession(r: SessionRequest): Promise<OpenedSession> {
    if (this.closed) throw new EgressError("proxy_closed", "the proxy is stopping");
    const s = this.checkSession(r);
    if (this.sessions.has(s.id)) throw new EgressError("session_exists", `session ${s.id} is already open`);
    const server = createServer({ allowHalfOpen: true }, (socket) => this.accept(session, socket));
    server.maxConnections = 128;
    const placeholders = new Map<string, string>();
    for (const d of s.destinations.values()) if (d.credential !== null && !placeholders.has(d.credential)) placeholders.set(d.credential, `mdt-ph-${randomBytes(16).toString("hex")}`);
    const session: Session = { ...s, placeholders, server, port: 0, state: "open", streams: new Set(), denials: [], dropped: 0, timers: [] };
    this.sessions.set(s.id, session);
    try {
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen({ host: this.config.listen, port: 0, exclusive: true }, () => {
          server.off("error", fail);
          ok();
        });
      });
    } catch (e) {
      this.sessions.delete(s.id);
      throw new EgressError("listen_failed", `could not listen on ${this.config.listen}: ${(e as Error).message}`);
    }
    session.port = (server.address() as { port: number }).port;
    session.timers.push(setTimeout(() => this.end(session, "expired"), r.ttl_ms).unref());
    const url = `http://${isIP(this.config.listen) === 6 ? `[${this.config.listen}]` : this.config.listen}:${session.port}`;
    const ph = Object.fromEntries([...placeholders].sort(([a], [b]) => (a < b ? -1 : 1)));
    return { proxy_url: url, placeholders: ph };
  }

  /** Closes a session: its port stops listening and its streams are cut. Its denials are gone with it. */
  async closeSession(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (!s) throw new EgressError("unknown_session", `no session ${id}`);
    await this.drop(s);
  }

  /** Revokes the sessions in scope at once: their streams are cut and every later request on them is denied. */
  revoke(scope: RevokeScope): string[] {
    const hit = [...this.sessions.values()].filter((s) =>
      "all" in scope ? true : "session" in scope ? s.id === scope.session : "run" in scope ? s.run === scope.run : s.tenant === scope.tenant,
    );
    for (const s of hit) if (s.state === "open") this.end(s, "revoked");
    return hit.map((s) => s.id).sort();
  }

  /** A session's denials with an id above `after`, oldest first, at most `limit`; `dropped` counts those not kept. */
  denials(id: string, after = 0, limit = 100): { denials: Denial[]; dropped: number } {
    const s = this.sessions.get(id);
    if (!s) throw new EgressError("unknown_session", `no session ${id}`);
    return { denials: s.denials.filter((d) => d.id > after).slice(0, limit), dropped: s.dropped };
  }

  /** Closes every session; the proxy opens no more. */
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.sessions.values()].map((s) => this.drop(s)));
  }

  private checkSession(r: SessionRequest): Omit<Session, "placeholders" | "server" | "port" | "state" | "streams" | "denials" | "dropped" | "timers"> {
    const bad = (m: string): never => {
      throw new EgressError("bad_request", m);
    };
    if (typeof r.session !== "string" || !SESSION_ID.test(r.session)) bad("session is 1 to 128 letters, digits and . _ : -");
    for (const k of ["tenant", "run", "command"] as const) if (typeof r[k] !== "string" || r[k].length === 0 || r[k].length > 256 || /[\x00-\x1f\x7f]/.test(r[k])) bad(`${k} is a non-empty string of at most 256 characters`);
    if (r.kind !== "forward") bad(`kind is "forward"`);
    if (!Number.isSafeInteger(r.ttl_ms) || r.ttl_ms < 1 || r.ttl_ms > MAX_TTL_MS) bad(`ttl_ms is a whole number of milliseconds from 1 to ${MAX_TTL_MS}`);
    if (!Array.isArray(r.destinations) || r.destinations.length === 0 || r.destinations.length > MAX_DESTINATIONS) bad(`destinations is a list of 1 to ${MAX_DESTINATIONS}`);
    const destinations = new Map<string, Destination>();
    for (const d of r.destinations) {
      if (typeof d !== "object" || d === null || Array.isArray(d)) bad("a destination is { host, methods, credential }");
      for (const k of Object.keys(d)) if (!["host", "methods", "credential"].includes(k)) bad(`unknown field ${k} in a destination`);
      if (!validHost(d.host)) bad(`destination host ${JSON.stringify(d.host)} is not a host name in lower case or an IP address, without a port`);
      if (destinations.has(d.host)) bad(`destination ${d.host} is listed twice`);
      if (d.methods !== null && (!Array.isArray(d.methods) || d.methods.length === 0 || !d.methods.every((m) => typeof m === "string" && METHOD.test(m)) || new Set(d.methods).size !== d.methods.length)) bad(`the methods of ${d.host} are null or a non-empty list of distinct method names`);
      if (d.credential !== null) {
        if (typeof d.credential !== "string") bad(`the credential of ${d.host} is a name or null`);
        const c = this.config.credentials[d.credential];
        if (!c) throw new EgressError("unknown_credential", `the proxy holds no credential ${d.credential}`);
        if (!c.hosts.includes(d.host)) throw new EgressError("credential_not_allowed", `the proxy's configuration does not bind credential ${d.credential} to ${d.host}`);
      }
      destinations.set(d.host, { host: d.host, methods: d.methods === null ? null : [...d.methods], credential: d.credential });
    }
    return { id: r.session, tenant: r.tenant, run: r.run, command: r.command, kind: r.kind, destinations };
  }

  /** Ends a session's data path: revoked or expired, it keeps its port to answer denials for a while, then closes. */
  private end(s: Session, state: "revoked" | "expired"): void {
    if (s.state !== "open") return;
    s.state = state;
    for (const st of s.streams) st.destroy();
    s.streams.clear();
    s.timers.push(setTimeout(() => void this.drop(s), this.lingerMs).unref());
  }

  private async drop(s: Session): Promise<void> {
    if (this.sessions.get(s.id) !== s) return;
    this.sessions.delete(s.id);
    for (const t of s.timers) clearTimeout(t);
    for (const st of s.streams) st.destroy();
    s.streams.clear();
    await new Promise<void>((ok) => s.server.close(() => ok()));
  }

  private track(s: Session, st: Duplex): boolean {
    if (this.sessions.get(s.id) !== s) {
      st.destroy();
      return false;
    }
    s.streams.add(st);
    st.once("close", () => s.streams.delete(st));
    return true;
  }

  /** The data path is not served yet: a connection to a session's port is closed unread. */
  private accept(s: Session, socket: Socket): void {
    if (this.track(s, socket)) socket.destroy();
  }
}
