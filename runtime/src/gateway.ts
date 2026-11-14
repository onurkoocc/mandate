// The control plane's own adapters behind the egress proxy (spec/boundary.md
// "The egress proxy"; spec/egress.md "Gateway sessions"). With a gateway
// configured, an adapter never holds the secret it sends: it sends its
// requests to a gateway session's base URL with the session's placeholder,
// and the proxy, which the operator started in an environment of its own,
// puts the secret in on the way out.
//
// - A gateway is a spec (`GatewaySpec`): its host, methods, credential, and
//   the header and template its placeholder goes in. The model and GitHub
//   gateways are two built-in ones (`GATEWAYS`); a connector's is made from
//   its URL and its lock entry (`connectorGateway`, spec/library.md "Egress").
// - One admin connection per runtime (`EgressLink`), opened at first use. A
//   view, a status or a replay calls no adapter, so it never reaches the
//   proxy.
// - One gateway session per gateway and runtime, for the run the runtime was
//   set up for: `revoke { run }` and `revoke { tenant }` cut it. It is opened
//   at the first request, renewed before it would expire under a request in
//   flight, opened again after the proxy answered `session_expired`, and
//   closed when it is replaced or when the runtime closes.
// - A session the proxy answered `session_revoked` is never replaced: every
//   later request of that gateway is refused here, by name. A port that does
//   not answer is never taken as a reason to open another session either.
// - The verifier's process gets a session of its own, and only its address
//   and placeholder (`GATEWAY_ENV`); it cannot open one.
//
// The same link opens the forward sessions of sandboxes (spec/boundary.md
// "Sandbox egress"), one per sandbox, for the run the sandbox is for; the
// sandbox host (mxc.ts) holds them, and reads what each denied.

import { createHash, randomBytes } from "node:crypto";
import { EgressClient } from "./egress/client.js";
import { CREDENTIAL_NAME, HEADER_TOKEN, RESERVED_HEADERS, validHost } from "./egress/config.js";
import { DENIAL_HEADER, EgressError, type Denial, type Destination } from "./egress/proxy.js";
import { Violation } from "./signals.js";

/**
 * What a gateway session is opened with and its requests are sent with (spec/egress.md "Gateway sessions"): the
 * one host it reaches, the methods it allows toward it (`null`, any), the credential the proxy puts in, and the header
 * and template the request carries the placeholder in. `name` names the gateway in messages and in the session's
 * `command` (`gateway:<name>`).
 */
export interface GatewaySpec {
  readonly name: string;
  readonly host: string;
  readonly methods: readonly string[] | null;
  readonly credential: string;
  /**
   * The header the credential goes in, with `{secret}` in `template` where it goes: what the API expects. The proxy's
   * credential is configured with the same header and template, or the proxy refuses the placeholder
   * (`placeholder_misuse`).
   */
  readonly header: string;
  readonly template: string;
}

/**
 * One of the control plane's own gateways: a spec but for its credential, which the configuration names
 * (`egress.gateways`), with the variables of the runtime's environment that would hold its secret.
 */
export interface BuiltinGateway extends Omit<GatewaySpec, "credential"> {
  readonly secrets: readonly string[];
}

/** The model and GitHub gateways (spec/boundary.md "The control plane's gateways"): any method, toward one host. */
export const GATEWAYS = {
  model: { name: "model", host: "api.anthropic.com", methods: null, header: "x-api-key", template: "{secret}", secrets: ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"] },
  github: { name: "github", host: "api.github.com", methods: null, header: "authorization", template: "Bearer {secret}", secrets: ["MANDATE_GITHUB_TOKEN"] },
} as const satisfies Record<string, BuiltinGateway>;

/** The names of the built-in gateways, as `egress.gateways` turns them on. A gateway of a connector has a spec of its own. */
export type GatewayName = keyof typeof GATEWAYS;

/** A built-in gateway's spec, with the credential the configuration names for it. */
export function gatewaySpec(name: GatewayName, credential: string): GatewaySpec {
  const { secrets: _, ...g } = GATEWAYS[name];
  return { ...g, credential };
}

/** The host each built-in gateway reaches. */
export const GATEWAY_HOSTS: Record<GatewayName, string> = { model: GATEWAYS.model.host, github: GATEWAYS.github.host };

/** The header and template each built-in gateway's requests carry their credential in. */
export const GATEWAY_HEADERS: Record<GatewayName, { header: string; template: string }> = {
  model: { header: GATEWAYS.model.header, template: GATEWAYS.model.template },
  github: { header: GATEWAYS.github.header, template: GATEWAYS.github.template },
};

/** A connector's binding in the lock (spec/library.md "Lock 0.6"): the credential, and its header and template when not the default. */
export interface ConnectorBinding {
  credential: string;
  header?: string;
  template?: string;
}

/** A connector's gateway: its spec, and the URL its MCP requests are sent to, whose path the gateway keeps. */
export interface ConnectorGateway {
  spec: GatewaySpec;
  /** `https://<host><path>`: what the MCP client posts to, through the gateway's `fetch`. */
  endpoint: string;
}

/** The header and template a connector's credential goes in when its lock entry names none. */
export const CONNECTOR_HEADER = { header: "authorization", template: "Bearer {secret}" } as const;

/**
 * The gateway of connector `name` (`<module>.<connector>`) declared with `mcp(url)` and bound by the lock to `binding`
 * (spec/library.md "Egress"): the URL's host, `POST` only, the lock's credential, in the lock's header and template
 * or `authorization: Bearer {secret}`. The URL is one absolute `https://` URL with no user, password, port, query or
 * fragment, whose host is a host name or an IPv4 address; anything else, or a binding the proxy could not hold, is
 * `bad_connector`. The compiler refuses such a program (E1402) and such a lock; this holds the runtime to the same.
 */
export function connectorGateway(name: string, url: string, binding: ConnectorBinding): ConnectorGateway {
  const bad = (m: string): never => {
    throw new Violation("bad_connector", `connector ${name}: ${m}`);
  };
  const raw = /^https:\/\/([^/?#]*)([^?#]*)$/i.exec(url);
  if (!raw) bad("its server is one absolute https:// URL, with no query or fragment");
  const authority = raw![1]!;
  if (authority.includes("@")) bad("its server's URL names no user or password");
  if (/:[0-9]*$/.test(authority) && !/^\[[^\]]*\]$/.test(authority)) bad("its server's URL names no port: a gateway session reaches port 443");
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return bad("its server is one absolute https:// URL");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port || u.search || u.hash) bad("its server is one absolute https:// URL, with no user, password, port, query or fragment");
  // The host is the URL's as written: a URL parser would take `https:///x` as the host `x`, and fold a backslash, a
  // percent-encoding or a Unicode name into another host than the one written.
  if (!validHost(u.hostname) || authority.toLowerCase() !== u.hostname) bad("its server's host is a host name or an IPv4 address, as written");
  if (typeof binding.credential !== "string" || !CREDENTIAL_NAME.test(binding.credential)) bad("its lock entry's credential is a name of letters, digits, _ and -, starting with a letter, at most 64 characters");
  if ((binding.header === undefined) !== (binding.template === undefined)) bad("its lock entry gives a header and a template together, or neither");
  const header = binding.header ?? CONNECTOR_HEADER.header;
  const template = binding.template ?? CONNECTOR_HEADER.template;
  if (typeof header !== "string" || !HEADER_TOKEN.test(header) || header !== header.toLowerCase() || RESERVED_HEADERS.has(header)) bad("its lock entry's header is a header name in lower case that the proxy does not set itself");
  if (typeof template !== "string" || template.split("{secret}").length !== 2 || !/^[\x20-\x7e]*$/.test(template) || template !== template.trim()) bad("its lock entry's template is printable ASCII with {secret} exactly once");
  return { spec: { name, host: u.hostname, methods: ["POST"], credential: binding.credential, header, template }, endpoint: `https://${u.hostname}${u.pathname}` };
}

/**
 * The header a proxy's denial carries its reason in (spec/egress.md "Denials"). A conforming proxy removes an
 * upstream's, so a response that carries it was not sent upstream.
 */
export const DENIED_HEADER = DENIAL_HEADER;

/** How long a gateway session is asked to live, and how long before its end it is replaced rather than used. */
export const GATEWAY_TTL_MS = 3_600_000;
export const GATEWAY_RENEW_MS = 900_000;

/** The variables the verifier's process gets for the model gateway: its session's base URL and placeholder. */
export const GATEWAY_ENV = { url: "MANDATE_EGRESS_MODEL_URL", placeholder: "MANDATE_EGRESS_MODEL_PLACEHOLDER" } as const;

/** The variables of the runtime's environment that hold each gateway's secret; with the gateway on, none may be set. */
export const GATEWAY_SECRETS: Record<GatewayName, readonly string[]> = { model: GATEWAYS.model.secrets, github: GATEWAYS.github.secrets };

/** Who a runtime's gateway sessions are for: what `revoke` selects by. */
export interface EgressScope {
  tenant: string;
  run: string;
}

export type RevokeScope = { run: string } | { tenant: string } | { all: true };

/**
 * `credential_in_environment`: a gateway is on and its secret is in `env` (spec/boundary.md "Where secrets live").
 * The variable is named, never its value. On Windows a name matches in any case, as Windows reads it.
 */
export function refuseCredentials(gateways: Partial<Record<GatewayName, string>>, env: NodeJS.ProcessEnv, windows = process.platform === "win32"): void {
  const fold = (n: string): string => (windows ? n.toUpperCase() : n);
  for (const g of ["model", "github"] as const) {
    if (gateways[g] === undefined) continue;
    for (const name of GATEWAY_SECRETS[g]) {
      const found = Object.keys(env).find((k) => fold(k) === fold(name) && !!env[k]);
      if (found !== undefined) throw new Violation("credential_in_environment", `the ${g} gateway is on, and ${found} is set in the runtime's environment: its secret belongs in the egress proxy's environment only.`);
    }
  }
}

/**
 * What a person can do instead, when the command `credential_in_environment` refused is one with a way round. Only
 * `cancel` has one: it asks an adapter to stop an action whose outcome is unknown, so it cannot run beside the secret;
 * `mandate halt` ends the runs of the run's tenant without any adapter and works from this environment (spec/boundary.md
 * "Where secrets live"). A halt names a tenant, not a run, and says so. Undefined for every other command.
 */
export function credentialAdvice(command: string, run: string, tenant: string): string | undefined {
  if (command !== "cancel") return undefined;
  return `cancel asks an adapter to stop an action whose outcome is unknown, and no adapter runs in a process that holds the secret. Run mandate cancel ${run} from an environment without the secret. From this environment, mandate halt --tenant ${tenant} stops every open run of the tenant, this one among them, without an adapter.`;
}

interface Session {
  session: string;
  base_url: string;
  placeholder: string;
  expiresAt: number;
  inflight: number;
  retired: boolean;
}

/** A sandbox's forward session: the proxy's own address for it, its placeholders by credential, and when it expires. */
export interface ForwardSession {
  session: string;
  proxy_url: string;
  placeholders: Record<string, string>;
  expiresAt: number;
}

/**
 * What a session's `command` says: the command id, which the proxy takes as up to 256 characters; a longer one, as a
 * deep sub-program's can be, is named by its digest.
 */
function sessionCommand(command: string): string {
  return command.length <= 256 ? command : `sha256:${createHash("sha256").update(command).digest("hex")}`;
}

export interface EgressLinkOptions {
  /** The admin channel: a Unix socket or a named pipe. */
  admin: string;
  /** The run the sessions are for; without one, a session cannot be opened. */
  scope?: EgressScope;
  ttlMs?: number;
  renewMs?: number;
  now?: () => number;
  /** How long an admin request may wait for its answer. */
  timeoutMs?: number;
}

/** The runtime's side of the admin channel: one connection, opened at first use and opened again after it was lost. */
export class EgressLink {
  private client: Promise<EgressClient> | undefined;
  private readonly open_ = new Set<string>();
  private closed = false;
  readonly ttlMs: number;
  readonly renewMs: number;
  readonly now: () => number;

  constructor(readonly o: EgressLinkOptions) {
    this.ttlMs = o.ttlMs ?? GATEWAY_TTL_MS;
    this.renewMs = o.renewMs ?? GATEWAY_RENEW_MS;
    this.now = o.now ?? Date.now;
  }

  private unavailable(e: unknown): Violation {
    if (e instanceof Violation) return e;
    return new Violation("egress_unavailable", `the egress proxy at ${this.o.admin}: ${(e as Error).message}`);
  }

  private async connected(): Promise<EgressClient> {
    if (this.closed) throw new Violation("egress_unavailable", `the runtime's link to the egress proxy at ${this.o.admin} is closed`);
    this.client ??= EgressClient.connect(this.o.admin, this.o.timeoutMs !== undefined ? { timeoutMs: this.o.timeoutMs } : {});
    const c = this.client;
    try {
      return await c;
    } catch (e) {
      if (this.client === c) this.client = undefined;
      throw e;
    }
  }

  /** One admin request; a connection that failed is dropped, so the next request connects again. */
  private async call<T>(f: (c: EgressClient) => Promise<T>): Promise<T> {
    const c = await this.connected();
    try {
      return await f(c);
    } catch (e) {
      if ((e as { code?: unknown }).code === "egress_unavailable") {
        c.close();
        this.client = undefined;
      }
      throw e;
    }
  }

  /** The names of the credentials the proxy holds, as it answers `hello`; `egress_unavailable` when it does not answer in the protocol's format. */
  async credentials(): Promise<string[]> {
    try {
      return (await this.call((c) => c.hello())).credentials;
    } catch (e) {
      throw this.unavailable(e);
    }
  }

  /**
   * Whether the proxy can serve these gateways and a package's sandboxes: it answers `hello` in the protocol's format
   * and holds each credential a gateway sends and each one the package's lock binds. Otherwise `egress_unavailable`,
   * naming the proxy and the credential.
   */
  async ready(credentials: Readonly<Record<string, string | undefined>>, bound: ReadonlyArray<{ agent: string; host: string; credential: string }> = []): Promise<void> {
    const held = await this.credentials();
    for (const [g, name] of Object.entries(credentials)) {
      if (name !== undefined && !held.includes(name)) throw new Violation("egress_unavailable", `the egress proxy at ${this.o.admin} holds no credential ${name}, which the ${g} gateway sends`);
    }
    for (const b of bound) {
      if (!held.includes(b.credential)) throw new Violation("egress_unavailable", `the egress proxy at ${this.o.admin} holds no credential ${b.credential}, which the package's lock binds to ${b.agent}'s requests to ${b.host}`);
    }
  }

  /**
   * Opens a forward session for one sandbox (spec/egress.md "Forward sessions"): exactly `destinations`, for the run,
   * tenant and command of `owner`, so that `revoke { run }` and `revoke { tenant }` cut it. A credential the proxy
   * does not hold, or does not bind to the host (`unknown_credential`, `credential_not_allowed`), rejects with the
   * proxy's `EgressError`, for the caller to refuse by name; any other failure is `egress_unavailable`.
   */
  async openForward(owner: EgressScope & { command: string }, destinations: Destination[], ttlMs: number): Promise<ForwardSession> {
    const session = `sbx.${randomBytes(8).toString("hex")}`;
    const at = this.now();
    try {
      const s = await this.call((c) => c.openSession({ session, tenant: owner.tenant, run: owner.run, command: sessionCommand(owner.command), kind: "forward", destinations, ttl_ms: ttlMs }));
      this.open_.add(session);
      return { session, proxy_url: s.proxy_url, placeholders: s.placeholders, expiresAt: at + ttlMs };
    } catch (e) {
      if (e instanceof EgressError && (e.code === "unknown_credential" || e.code === "credential_not_allowed")) throw e;
      throw this.unavailable(e);
    }
  }

  /** A page of what a session denied, after the denial `after`; `egress_unavailable` when the proxy does not say. */
  async denials(session: string, after: number, limit: number): Promise<{ denials: Denial[]; dropped: number }> {
    try {
      return await this.call((c) => c.denials(session, { after, limit }));
    } catch (e) {
      throw new Violation("egress_unavailable", `the egress proxy at ${this.o.admin} did not say what it denied session ${session}: ${(e as Error).message}`);
    }
  }

  /**
   * Opens a gateway session to `spec`'s host, with its methods and credential, for this runtime's run. `label` names
   * the session (`gw.<label>.<random>`) and its command (`gateway:<label>`); a label the session id cannot hold, as a
   * long connector name could be, is named by its digest.
   */
  async open(label: string, spec: GatewaySpec): Promise<Omit<Session, "inflight" | "retired">> {
    const scope = this.o.scope;
    if (!scope) throw new Violation("egress_unavailable", `the ${label} gateway was set up for no run, so it opens no session`);
    const named = /^[A-Za-z0-9._:-]{1,100}$/.test(label) ? label : `h${createHash("sha256").update(label).digest("hex").slice(0, 32)}`;
    const session = `gw.${named}.${randomBytes(8).toString("hex")}`;
    const at = this.now();
    const { host, credential } = spec;
    const methods = spec.methods === null ? null : [...spec.methods];
    try {
      const s = await this.call((c) => c.openSession({ session, tenant: scope.tenant, run: scope.run, command: sessionCommand(`gateway:${label}`), kind: "gateway", destinations: [{ host, methods, credential }], ttl_ms: this.ttlMs }));
      this.open_.add(session);
      const placeholder = s.placeholders[credential];
      if (!placeholder) throw new Error(`the egress proxy gave no placeholder for ${credential}`);
      return { session, base_url: s.base_url, placeholder, expiresAt: at + this.ttlMs };
    } catch (e) {
      throw this.unavailable(e);
    }
  }

  /** Closes a session this link opened; a proxy that cannot be reached is not waited for. */
  async close(session: string): Promise<void> {
    if (!this.open_.delete(session)) return;
    try {
      await this.call((c) => c.closeSession(session));
    } catch {
      // Gone already, or the proxy is: its port stops answering when the proxy closes it.
    }
  }

  /** `revoke` over the admin channel; a failure rejects with an error that names the proxy. */
  async revoke(scope: RevokeScope): Promise<void> {
    try {
      await this.call((c) => c.revoke(scope));
    } catch (e) {
      throw new Violation("egress_unavailable", `the egress proxy at ${this.o.admin} did not revoke ${JSON.stringify(scope)}: ${(e as Error).message}`);
    }
  }

  /** Closes every session this link opened, then the connection. */
  async closeAll(): Promise<void> {
    if (this.closed) return;
    for (const s of [...this.open_]) await this.close(s);
    this.closed = true;
    const c = this.client;
    this.client = undefined;
    if (c) (await c.catch(() => undefined))?.close();
  }
}

/** A request's headers with `name` set to `value`, whatever form the caller gave them in. */
function withHeader(init: RequestInit | undefined, name: string, value: string): Headers {
  const h = new Headers(init?.headers);
  h.set(name, value);
  return h;
}

/**
 * The URL a gateway's `fetch` is called with. A `Request` is refused: its method, headers and body would be lost, since
 * the request sent on is built from `init`, and nothing in the runtime passes one.
 */
function urlOf(input: string | URL | Request): URL {
  if (typeof input !== "string" && !(input instanceof URL)) throw new TypeError("a gateway's fetch takes a URL and its init, not a Request");
  return new URL(typeof input === "string" ? input : input.href);
}

/** Whether an error of `fetch` says the port did not take the connection. */
function refused(e: unknown): boolean {
  const cause = (e as { cause?: { code?: unknown } }).cause;
  return cause?.code === "ECONNREFUSED" || (e as { code?: unknown }).code === "ECONNREFUSED";
}

/** A body that can be sent a second time unchanged. */
function resendable(init: RequestInit | undefined): boolean {
  const b = init?.body;
  return b === undefined || b === null || typeof b === "string" || b instanceof Uint8Array || b instanceof URLSearchParams;
}

/**
 * One gateway: a `fetch` for an adapter whose requests go to `https://<host>/…`. It sends them to the gateway
 * session's base URL, with the session's placeholder in the gateway's header. It is made from a spec, or, for the
 * two built-in gateways, from a name and the credential the configuration names for it.
 */
export class Gateway {
  private current: Session | undefined;
  private opening: Promise<Session> | undefined;
  private refusal: Violation | undefined;
  readonly spec: GatewaySpec;
  readonly name: string;
  readonly credential: string;
  readonly host: string;
  private readonly label: string;
  private readonly send: typeof fetch;

  constructor(link: EgressLink, spec: GatewaySpec, label?: string, send?: typeof fetch);
  constructor(link: EgressLink, name: GatewayName, credential: string, label?: string, send?: typeof fetch);
  constructor(
    private readonly link: EgressLink,
    gateway: GatewaySpec | GatewayName,
    a?: string,
    b?: string | typeof fetch,
    c?: typeof fetch,
  ) {
    if (typeof gateway === "string") {
      this.spec = gatewaySpec(gateway, a!);
      this.label = (b as string | undefined) ?? gateway;
      this.send = c ?? fetch;
    } else {
      this.spec = gateway;
      this.label = a ?? gateway.name;
      this.send = (b as typeof fetch | undefined) ?? fetch;
    }
    this.name = this.spec.name;
    this.credential = this.spec.credential;
    this.host = this.spec.host;
  }

  /** The session to send on: the current one while it has longer than `renewMs` to live, else a new one. */
  async session(): Promise<{ base_url: string; placeholder: string; expiresAt: number }> {
    return this.use();
  }

  private async use(): Promise<Session> {
    if (this.refusal) throw this.refusal;
    const s = this.current;
    if (s && s.expiresAt - this.link.now() > this.link.renewMs) return s;
    this.opening ??= this.link
      .open(this.label, this.spec)
      .then((opened) => {
        const next: Session = { ...opened, inflight: 0, retired: false };
        if (this.current) this.retire(this.current);
        this.current = next;
        return next;
      })
      .finally(() => (this.opening = undefined));
    return this.opening;
  }

  /** A session no longer used for new requests is closed once its requests are done. */
  private retire(s: Session): void {
    s.retired = true;
    if (this.current === s) this.current = undefined;
    if (s.inflight === 0) void this.link.close(s.session);
  }

  /** The adapter's `fetch`. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    if (url.protocol !== "https:" || url.host !== this.host) throw new Error(`the ${this.label} gateway reaches ${this.host} only, not ${url.host}`);
    const { header, template } = this.spec;
    for (let attempt = 0; ; attempt++) {
      const s = await this.use();
      s.inflight++;
      let res: Response;
      try {
        res = await this.send(`${s.base_url}${url.pathname}${url.search}`, { ...init, headers: withHeader(init, header, template.replace("{secret}", s.placeholder)) });
      } catch (e) {
        // A session port that takes no connection was closed, or its proxy stopped: no other session is opened
        // for it, since the reason may be a revocation this runtime has not been told of.
        if (refused(e)) throw new Violation("egress_unavailable", `the ${this.label} gateway's session at ${s.base_url} does not answer: the egress proxy closed it or stopped`);
        throw e;
      } finally {
        s.inflight--;
        if (s.retired && s.inflight === 0) void this.link.close(s.session);
      }
      const why = res.headers.get(DENIED_HEADER);
      // Nothing of a denied request went upstream, so an expired session's request is sent again, once, on a new one.
      if (why === "session_expired" && attempt === 0 && resendable(init)) {
        await res.body?.cancel().catch(() => undefined);
        this.retire(s);
        continue;
      }
      if (why === "session_revoked") this.refusal = new Violation("egress_denied", `session_revoked: the egress proxy revoked the ${this.label} gateway's session ${s.session}; this runtime opens no other for it`);
      return res;
    }
  };
}

/** A gateway the verifier's process was given: the address and placeholder of a session the runtime opened for it. */
export function givenGateway(env: NodeJS.ProcessEnv, send: typeof fetch = fetch): typeof fetch {
  const base = env[GATEWAY_ENV.url];
  const placeholder = env[GATEWAY_ENV.placeholder];
  const { host, header, template } = GATEWAYS.model;
  return async (input, init) => {
    if (!base || !placeholder) throw new Violation("egress_unavailable", `the model gateway is on, and this process was not given its address and placeholder (${GATEWAY_ENV.url}, ${GATEWAY_ENV.placeholder})`);
    const url = urlOf(input);
    if (url.protocol !== "https:" || url.host !== host) throw new Error(`the model gateway reaches ${host} only, not ${url.host}`);
    try {
      return await send(`${base}${url.pathname}${url.search}`, { ...init, headers: withHeader(init, header, template.replace("{secret}", placeholder)) });
    } catch (e) {
      if (refused(e)) throw new Violation("egress_unavailable", `the model gateway's session at ${base} does not answer: the egress proxy closed it or stopped`);
      throw e;
    }
  };
}

/** The proxy's denial reason, when `e` is an error answer that carries one (an SDK's API error, or a fetch Response). */
export function denialOf(headers: unknown): string | undefined {
  const h = headers as { get?: (k: string) => string | null } | Record<string, string> | undefined | null;
  if (!h) return undefined;
  const v = typeof (h as { get?: unknown }).get === "function" ? (h as { get: (k: string) => string | null }).get(DENIED_HEADER) : (h as Record<string, string>)[DENIED_HEADER];
  return v ? String(v) : undefined;
}
