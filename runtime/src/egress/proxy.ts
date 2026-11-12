// The reference egress proxy (spec/egress.md): sessions, and the data path
// each session's loopback port serves. The proxy holds the secrets; a client
// holds a per-session placeholder, which the proxy swaps for the secret only
// in the configured header of a request to a host the credential is bound to,
// on its way out over TLS. Everything a session may reach is named when it is
// opened; a request outside that is refused before anything goes upstream,
// and the refusal is recorded for `denials`.
//
// Two kinds of session share the data path. A `forward` session is an
// HTTP/1.1 forward proxy for a sandbox: it takes absolute-form `http://host/…`
// requests, and `CONNECT host:443` to a destination without credential or
// method restriction. A `gateway` session has one destination and takes
// origin-form requests, for a client that takes a base URL instead of a proxy.
//
// How a connection upstream is made, and how a name is resolved, are passed
// in (`Dialer`, `Resolver`), so tests need neither the network nor a key.

import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect, createServer, isIP, type Server, type Socket } from "node:net";
import { pipeline, type Duplex } from "node:stream";
import { checkServerIdentity, connect as tlsConnect, rootCertificates } from "node:tls";
import { isPublicAddress } from "./addresses.js";
import { validHost, type EgressConfig } from "./config.js";
import { BodyDecoder, ChunkedEncoder, headEnd, MAX_HEAD_BYTES, parseHead, Scrubber, type Head, type HeadError } from "./http1.js";

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

/** A name's addresses, in the order to use them. */
export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

export interface DialRequest {
  /** The host the request named: the name the upstream certificate is verified for. */
  host: string;
  /** The address the name resolved to and was checked as: the connection goes there and nowhere else. */
  address: string;
  port: number;
  /** TLS for a request the proxy forwards; plain TCP for a CONNECT tunnel, whose TLS is the client's. */
  tls: boolean;
}

/** Opens a connected stream upstream. The default dials `address` and, with `tls`, verifies the certificate for `host`. */
export type Dialer = (r: DialRequest) => Promise<Duplex>;

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
  resolve?: Resolver;
  dial?: Dialer;
  /** Extra trust roots for the default dialer (the configuration's `ca`, read). */
  ca?: string;
  /** How long a revoked or expired session keeps answering denials before it is closed. */
  lingerMs?: number;
  /**
   * The port upstream connections go to: 443, always, outside tests. A test of the real dialer sets it, because a
   * test cannot listen on 443.
   */
  upstreamPort?: number;
  now?: () => Date;
}

export const SESSION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,32}$/;
const MAX_DESTINATIONS = 256;
const MAX_TTL_MS = 2_147_483_647;
const MAX_DENIALS = 10_000;
const HEAD_TIMEOUT_MS = 30_000;
const IDLE_TIMEOUT_MS = 600_000;
const DIAL_TIMEOUT_MS = 30_000;
const LINGER_MS = 600_000;

/** Headers that are this hop's own (RFC 9110 §7.6.1), and those the proxy sets itself; none is copied upstream. */
const REQUEST_DROPPED = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authorization", "proxy-authenticate", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", "expect", "accept-encoding", "http2-settings"]);
const RESPONSE_DROPPED = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "content-length"]);

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

type Denied = { deny: DenialReason; detail: string; host: string | null; method: string | null; path: string | null };
type Tunnel = { tunnel: true; host: string; port: number; method: string };
type Forward = { forward: true; host: string; method: string; path: string; headers: string[]; framing: Head["body"]; expectContinue: boolean };
type Verdict = Denied | Tunnel | Forward;

export class EgressProxy {
  readonly config: EgressConfig;
  private readonly secrets: Map<string, Buffer>;
  private readonly resolve: Resolver;
  private readonly dial: Dialer;
  private readonly lingerMs: number;
  private readonly upstreamPort: number;
  private readonly now: () => Date;
  private readonly sessions = new Map<string, Session>();
  private nextDenial = 1;
  private closed = false;

  constructor(o: EgressProxyOptions) {
    this.config = o.config;
    this.secrets = o.secrets;
    for (const name of Object.keys(o.config.credentials)) if (!o.secrets.has(name)) throw new EgressError("egress_secret_missing", `credential ${name} has no secret`);
    this.resolve = o.resolve ?? (async (host) => lookup(host, { all: true, order: "verbatim" }));
    this.dial = o.dial ?? defaultDialer(o.ca);
    this.lingerMs = o.lingerMs ?? LINGER_MS;
    this.upstreamPort = o.upstreamPort ?? 443;
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
    return s.kind === "forward" ? { proxy_url: url, placeholders: ph } : { base_url: url, placeholders: ph };
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
    if (r.kind !== "forward" && r.kind !== "gateway") bad(`kind is "forward" or "gateway"`);
    if (!Number.isSafeInteger(r.ttl_ms) || r.ttl_ms < 1 || r.ttl_ms > MAX_TTL_MS) bad(`ttl_ms is a whole number of milliseconds from 1 to ${MAX_TTL_MS}`);
    if (!Array.isArray(r.destinations) || r.destinations.length === 0 || r.destinations.length > MAX_DESTINATIONS) bad(`destinations is a list of 1 to ${MAX_DESTINATIONS}`);
    if (r.kind === "gateway" && r.destinations.length !== 1) bad("a gateway session has exactly one destination");
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

  /** One client connection: one request, read strictly, then the response, then the connection closes. */
  private accept(s: Session, socket: Socket): void {
    if (!this.track(s, socket)) return;
    socket.on("error", () => socket.destroy());
    socket.setTimeout(HEAD_TIMEOUT_MS, () => socket.destroy());
    let buf: Buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      const end = headEnd(buf);
      if (end < 0 && buf.length <= MAX_HEAD_BYTES) return;
      socket.off("data", onData);
      socket.pause();
      const head: Head | HeadError = end < 0 || end > MAX_HEAD_BYTES ? { why: "malformed_request", detail: `the head is longer than ${MAX_HEAD_BYTES} bytes` } : parseHead(buf.subarray(0, end));
      void this.handle(s, socket, head, buf.subarray(end < 0 ? buf.length : end)).catch(() => socket.destroy());
    };
    socket.on("data", onData);
  }

  private async handle(s: Session, socket: Socket, head: Head | HeadError, rest: Buffer): Promise<void> {
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy());
    const v = this.decide(s, head);
    if ("deny" in v) return this.deny(s, socket, v);
    // The name is resolved once, here; every address must be public, and the connection goes to the first.
    let addresses: { address: string; family: number }[];
    try {
      addresses = isIP(v.host) ? [{ address: v.host, family: isIP(v.host) }] : await this.resolve(v.host);
    } catch {
      return this.fail(socket, 502, `the name ${v.host} did not resolve`);
    }
    if (s.state !== "open") return this.deny(s, socket, this.stateDenial(s, v.host, v.method, "tunnel" in v ? null : v.path));
    if (!addresses.length) return this.fail(socket, 502, `the name ${v.host} did not resolve`);
    if (!this.config.allow_private && addresses.some((a) => !isPublicAddress(a.address))) {
      return this.deny(s, socket, { deny: "resolved_private", detail: `${v.host} resolves to an address the proxy does not connect to`, host: v.host, method: v.method, path: "tunnel" in v ? null : v.path });
    }
    const address = addresses[0]!.address;
    let upstream: Duplex;
    try {
      upstream = await withTimeout(this.dial({ host: v.host, address, port: this.upstreamPort, tls: !("tunnel" in v) }), DIAL_TIMEOUT_MS);
    } catch (e) {
      return this.fail(socket, 502, `could not reach ${v.host}: ${(e as { code?: string }).code ?? "connection failed"}`);
    }
    if (!this.track(s, upstream) || s.state !== "open") {
      upstream.destroy();
      if (this.sessions.get(s.id) === s) return this.deny(s, socket, this.stateDenial(s, v.host, v.method, "tunnel" in v ? null : v.path));
      socket.destroy();
      return;
    }
    upstream.on("error", () => upstream.destroy());
    (upstream as Partial<Socket>).setTimeout?.(IDLE_TIMEOUT_MS, () => upstream.destroy());
    if ("tunnel" in v) return this.tunnel(socket, upstream, rest);
    return this.forward(s, socket, upstream, v, rest);
  }

  /** The verdict on a request head: refused, with its reason, or what to send upstream. Nothing here does I/O. */
  private decide(s: Session, head: Head | HeadError): Verdict {
    if ("why" in head) {
      if (s.state !== "open") return this.stateDenial(s, null, head.method ?? null, head.target ?? null);
      return { deny: head.why, detail: head.detail, host: null, method: head.method ?? null, path: head.target ?? null };
    }
    const { method, headers } = head;
    const target = readTarget(s.kind, method, head.target, s.destinations);
    const host = "host" in target && target.host !== undefined ? target.host : null;
    const path = "path" in target && target.path !== undefined ? target.path : null;
    // The placeholder never names a host, so a host that carries one is recorded as none.
    const shown = host !== null && PLACEHOLDER.test(host) ? null : host;
    if (s.state !== "open") return this.stateDenial(s, shown, method, path);
    const deny = (why: DenialReason, detail: string): Verdict => ({ deny: why, detail, host: shown, method, path });
    const conn = headers.filter(([n]) => n === "connection").flatMap(([, v]) => v.toLowerCase().split(",").map((t) => t.trim()));
    if (headers.some(([n]) => n === "upgrade" || n === "http2-settings") || conn.includes("upgrade")) return deny("upgrade_not_allowed", "the proxy does not upgrade a connection");
    if ("error" in target) return deny(target.why, target.error);
    if (headers.filter(([n]) => n === "host").length > 1) return deny("malformed_request", "Host is repeated");
    const expect = headers.filter(([n]) => n === "expect");
    if (expect.length > 1 || (expect.length === 1 && expect[0]![1].toLowerCase() !== "100-continue")) return deny("malformed_request", "Expect other than 100-continue");

    // Where the placeholder may be: once, in the configured header of a request to a destination bound to its
    // credential, as exactly the template with this session's placeholder in the secret's place. Anywhere else, in
    // the request target or any header, it is a denial.
    const dest = s.destinations.get(target.host);
    const credName = method !== "CONNECT" ? (dest?.credential ?? null) : null;
    const cred = credName !== null ? this.config.credentials[credName] : undefined;
    let swap: { index: number; value: string } | undefined;
    if (cred && credName !== null) {
      const at = headers.flatMap(([n], i) => (n === cred.header ? [i] : []));
      const expected = cred.template.replace("{secret}", s.placeholders.get(credName)!);
      if (at.length === 1 && headers[at[0]!]![1] === expected) swap = { index: at[0]!, value: cred.template.replace("{secret}", this.secrets.get(credName)!.toString("latin1")) };
    }
    if (PLACEHOLDER.test(head.target) || headers.some(([n, v], i) => i !== swap?.index && (PLACEHOLDER.test(n) || PLACEHOLDER.test(v)))) return deny("placeholder_misuse", "a placeholder outside the one header it may be sent in");

    if (!dest) return deny("host_not_allowed", `${shown ?? "the host"} is not one of the session's destinations`);
    if (method === "CONNECT") {
      if (s.kind !== "forward") return deny("connect_not_allowed", "a gateway session takes no CONNECT");
      if (dest.credential !== null || dest.methods !== null) return deny("connect_not_allowed", `${dest.host} has a credential or a method restriction, so it is reached as http://${dest.host}/…, not through a tunnel`);
      if (target.port !== 443) return deny("connect_not_allowed", "CONNECT goes to port 443 only");
      return { tunnel: true, host: dest.host, port: 443, method };
    }
    if (target.port !== undefined && target.port !== 80 && target.port !== 443) return deny("port_not_allowed", "the proxy connects to port 443; the URL names another port");
    if (dest.methods !== null && !dest.methods.includes(method)) return deny("method_not_allowed", `${method} is not one of the methods allowed toward ${dest.host}`);

    // What goes upstream: the end-to-end headers, the credential swapped in, and the headers the proxy sets.
    const named = new Set(conn);
    const out: string[] = [];
    headers.forEach(([n, v], i) => {
      if (REQUEST_DROPPED.has(n) || named.has(n)) return;
      out.push(n, i === swap?.index ? swap.value : v);
    });
    out.push("host", isIP(dest.host) === 6 ? `[${dest.host}]` : dest.host, "accept-encoding", "identity", "connection", "close");
    if (head.body.kind === "length") out.push("content-length", String(head.body.length));
    if (head.body.kind === "chunked") out.push("transfer-encoding", "chunked");
    return { forward: true, host: dest.host, method, path: target.path!, headers: out, framing: head.body, expectContinue: expect.length === 1 };
  }

  private stateDenial(s: Session, host: string | null, method: string | null, path: string | null): Denied {
    return s.state === "expired"
      ? { deny: "session_expired", detail: "the session expired", host, method, path }
      : { deny: "session_revoked", detail: "the session was revoked", host, method, path };
  }

  /** Records a denial and answers it: 400 for a request that could not be read, 403 for the rest. Nothing went upstream. */
  private deny(s: Session, socket: Socket, v: Denied): void {
    const d: Denial = {
      id: this.nextDenial++,
      host: v.host,
      method: v.method !== null && METHOD.test(v.method) ? v.method : null,
      why: v.deny,
      path_digest: v.path === null ? null : `sha256:${createHash("sha256").update(v.path, "latin1").digest("hex")}`,
      at: this.now().toISOString(),
    };
    if (this.sessions.get(s.id) === s) {
      if (s.denials.length < MAX_DENIALS) s.denials.push(d);
      else s.dropped++;
    }
    const body = JSON.stringify({ error: "egress_denied", why: v.deny, detail: v.detail }) + "\n";
    const status = v.deny === "malformed_request" ? "400 Bad Request" : "403 Forbidden";
    this.answer(socket, `HTTP/1.1 ${status}\r\ncontent-type: application/json\r\nx-mandate-egress-denied: ${v.deny}\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  }

  /** Answers a request that was allowed but could not be carried out: no upstream, or an upstream that failed. */
  private fail(socket: Socket, status: 502 | 504, detail: string): void {
    const body = JSON.stringify({ error: "egress_upstream", detail }) + "\n";
    this.answer(socket, `HTTP/1.1 ${status} ${status === 502 ? "Bad Gateway" : "Gateway Timeout"}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
  }

  /** Writes a whole response and closes; what the client still sends is read and dropped, so it does not reset the answer away. */
  private answer(socket: Socket, text: string): void {
    if (socket.destroyed) return;
    socket.end(text);
    this.linger(socket);
  }

  /**
   * After the response: what the client still sends is read and dropped, so unread bytes do not reset the answer
   * away, and once the answer is flushed the connection closes when the client closes its side, or two seconds on.
   */
  private linger(socket: Socket): void {
    socket.on("data", () => {});
    socket.resume();
    const close = (): void => void socket.destroy();
    const flushed = (): void => {
      if (socket.readableEnded) return close();
      socket.once("end", close);
      setTimeout(close, 2000).unref();
    };
    if (socket.writableFinished) flushed();
    else socket.once("finish", flushed);
  }

  private tunnel(socket: Socket, upstream: Duplex, rest: Buffer): void {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (rest.length) upstream.write(rest);
    const cut = (): void => {
      socket.destroy();
      upstream.destroy();
    };
    socket.once("close", cut);
    upstream.once("close", cut);
    socket.pipe(upstream);
    upstream.pipe(socket);
    socket.resume();
  }

  private forward(s: Session, socket: Socket, upstream: Duplex, v: Forward, rest: Buffer): void {
    const req = httpRequest({ createConnection: () => upstream, method: v.method, path: v.path, headers: v.headers, setHost: false });
    let answered = false;
    const failed = (detail: string): void => {
      upstream.destroy();
      if (!answered) {
        answered = true;
        this.fail(socket, 502, detail);
      } else socket.destroy();
    };
    req.on("error", () => failed(`the request to ${v.host} failed`));
    socket.once("close", () => {
      req.destroy();
      upstream.destroy();
    });
    req.on("response", (res) => {
      answered = true;
      this.relay(s, socket, res, v.method, upstream);
    });
    // The body, as the client framed it, decoded and sent on; bytes after it are dropped.
    const decoder = new BodyDecoder(v.framing);
    if (v.expectContinue && !decoder.done) socket.write("HTTP/1.1 100 Continue\r\n\r\n");
    const feed = (chunk: Buffer): void => {
      const r = decoder.push(chunk);
      for (const d of r.data) {
        if (!req.write(d)) {
          socket.pause();
          req.once("drain", () => socket.resume());
        }
      }
      if (r.error) {
        // The request was allowed and has gone upstream; a body that breaks its framing aborts it. Not a denial.
        socket.off("data", feed);
        req.destroy();
        upstream.destroy();
        if (!answered) {
          answered = true;
          const body = JSON.stringify({ error: "egress_bad_body", detail: r.error }) + "\n";
          this.answer(socket, `HTTP/1.1 400 Bad Request\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
        }
        return;
      }
      if (r.done) {
        socket.off("data", feed);
        socket.on("data", () => {});
        req.end();
      }
    };
    if (decoder.done) {
      req.end();
      socket.on("data", () => {});
    } else {
      socket.on("data", feed);
      if (rest.length) feed(rest);
    }
    socket.resume();
  }

  /** The upstream response, with every secret's bytes replaced by the placeholder in its head and its body. */
  private relay(s: Session, socket: Socket, res: IncomingMessage, method: string, upstream: Duplex): void {
    const pairs = [...this.secrets].map(([name, secret]) => ({ secret, replacement: Buffer.from(s.placeholders.get(name) ?? "mdt-redacted", "latin1") }));
    const raw = res.rawHeaders;
    const encoding = headerValues(raw, "content-encoding").map((x) => x.toLowerCase());
    const transfer = headerValues(raw, "transfer-encoding").flatMap((x) => x.toLowerCase().split(",").map((t) => t.trim()));
    if (encoding.some((e) => e !== "identity") || transfer.some((t) => t !== "chunked")) {
      res.destroy();
      upstream.destroy();
      return this.fail(socket, 502, "the upstream answered with a content or transfer coding the proxy cannot scrub");
    }
    const named = new Set(headerValues(raw, "connection").flatMap((x) => x.toLowerCase().split(",").map((t) => t.trim())));
    const code = res.statusCode ?? 502;
    const hasBody = method !== "HEAD" && !(code >= 100 && code < 200) && code !== 204 && code !== 304;
    let head = `HTTP/1.1 ${code} ${(res.statusMessage ?? "").replace(/[^\x20-\x7e]/g, "")}\r\n`;
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const n = raw[i]!.toLowerCase();
      if (RESPONSE_DROPPED.has(n) || named.has(n)) continue;
      head += `${raw[i]}: ${raw[i + 1]}\r\n`;
    }
    head += `connection: close\r\n${hasBody ? "transfer-encoding: chunked\r\n" : ""}\r\n`;
    for (const p of pairs) head = head.split(p.secret.toString("latin1")).join(p.replacement.toString("latin1"));
    socket.write(Buffer.from(head, "latin1"));
    if (!hasBody) {
      res.resume();
      res.once("end", () => upstream.destroy());
      socket.end();
      this.linger(socket);
      return;
    }
    pipeline(res, new Scrubber(pairs), new ChunkedEncoder(), socket, (err) => {
      upstream.destroy();
      // A body cut short reaches the client without its last chunk, so the client sees that it was cut.
      if (err) socket.destroy();
      else this.linger(socket);
    });
  }
}

/** How the request target reads for a session: the host and port it names, and the path and query to send on. */
type Target = { host: string; port?: number; path?: string } | { error: string; why: "malformed_request" | "connect_not_allowed"; host?: string; path?: string };

function readTarget(kind: "forward" | "gateway", method: string, target: string, destinations: Map<string, Destination>): Target {
  if (method === "CONNECT") {
    const a = readAuthority(target);
    if (!a || a.port === undefined) return { error: "CONNECT takes host:port", why: "malformed_request" };
    if (kind === "gateway") return { error: "a gateway session takes no CONNECT", why: "connect_not_allowed", host: a.host };
    return a;
  }
  if (kind === "gateway") {
    const only = [...destinations.keys()][0]!;
    if (!target.startsWith("/")) return { error: "a gateway session takes origin-form requests: /path", why: "malformed_request", host: only, path: target };
    return { host: only, path: target };
  }
  const m = target.match(/^http:\/\/([^/?#]*)([/?][^#]*)?$/i);
  if (!m) return { error: "a forward session takes absolute-form http://host/path requests", why: "malformed_request", ...(target.startsWith("/") ? { path: target } : {}) };
  const a = readAuthority(m[1]!);
  const path = m[2] === undefined ? "/" : m[2].startsWith("?") ? `/${m[2]}` : m[2];
  if (!a) return { error: "the URL's authority is not host[:port]", why: "malformed_request", path };
  return { ...a, path };
}

/** `host[:port]` or `[v6][:port]`, with no user information; the host in lower case. */
function readAuthority(text: string): { host: string; port?: number } | undefined {
  const m = text.match(/^(?:\[([0-9A-Fa-f:.]+)\]|([A-Za-z0-9._-]+))(?::([0-9]{1,5}))?$/);
  if (!m) return undefined;
  const host = (m[1] ?? m[2]!).toLowerCase();
  if (m[1] !== undefined ? isIP(host) !== 6 : isIP(host) === 6 || !validHost(host)) return undefined;
  const port = m[3] === undefined ? undefined : Number(m[3]);
  if (port !== undefined && (port < 1 || port > 65535)) return undefined;
  return port === undefined ? { host } : { host, port };
}

function headerValues(raw: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) out.push(raw[i + 1]!);
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((ok, fail) => {
    const t = setTimeout(() => fail(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })), ms);
    p.then(
      (v) => (clearTimeout(t), ok(v)),
      (e: unknown) => (clearTimeout(t), fail(e)),
    );
  });
}

/** Dials the checked address. With TLS it verifies the certificate for the host the request named, against the system's roots and `ca`. */
export function defaultDialer(ca?: string): Dialer {
  return (r) =>
    new Promise<Duplex>((ok, fail) => {
      if (!r.tls) {
        const s = netConnect({ host: r.address, port: r.port });
        s.once("connect", () => (s.off("error", fail), ok(s)));
        s.once("error", fail);
        return;
      }
      const s = tlsConnect({
        host: r.address,
        port: r.port,
        ...(isIP(r.host) ? {} : { servername: r.host }),
        ...(ca !== undefined ? { ca: [...rootCertificates, ca] } : {}),
        rejectUnauthorized: true,
        checkServerIdentity: (_name, cert) => checkServerIdentity(r.host, cert),
        ALPNProtocols: ["http/1.1"],
      });
      s.once("secureConnect", () => (s.off("error", fail), ok(s)));
      s.once("error", fail);
    });
}
