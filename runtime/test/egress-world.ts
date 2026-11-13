// What the egress tests share: a proxy with an injected resolver and dialer,
// an in-process fake upstream the dialer connects to whatever address it is
// given, an admin channel on a socket or pipe of the test's own, and a raw
// HTTP/1.1 client that can send what no well-behaved client would.

import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveAdmin, type AdminServer } from "../src/egress/admin.js";
import { EgressClient } from "../src/egress/client.js";
import { egressConfig, type EgressConfig } from "../src/egress/config.js";
import { EgressProxy, type DialRequest, type Resolver } from "../src/egress/proxy.js";

/** A made-up secret, for tests only. */
export const SECRET = "test-secret-6f1c2a9e44d0b7";
export const OTHER_SECRET = "other-test-secret-91ab33c7";

export interface Seen {
  method: string;
  url: string;
  headers: string[];
  body: string;
}

export interface Upstream {
  server: HttpServer;
  port: number;
  seen: Seen[];
  /** How the upstream answers; by default 200 with "ok". */
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
}

export async function upstream(): Promise<Upstream> {
  const u: Upstream = {
    server: undefined as unknown as HttpServer,
    port: 0,
    seen: [],
    handler: (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    },
  };
  u.server = createHttpServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => {
      const body = Buffer.concat(parts).toString("latin1");
      u.seen.push({ method: req.method!, url: req.url!, headers: req.rawHeaders, body });
      u.handler(req, res, body);
    });
  });
  await new Promise<void>((ok) => u.server.listen(0, "127.0.0.1", ok));
  u.port = (u.server.address() as { port: number }).port;
  return u;
}

export interface World {
  config: EgressConfig;
  proxy: EgressProxy;
  admin: AdminServer;
  client: EgressClient;
  up: Upstream;
  dials: DialRequest[];
  /** The streams the fake dialer gave, in order, including one given after the proxy stopped waiting. */
  dialed: Socket[];
  /** How long the fake dialer waits before it connects. */
  dialDelayMs: number;
  resolved: string[];
  /** host → addresses; a host not in it resolves to a public documentation-free address. */
  dns: Map<string, string[] | (() => string[])>;
  close(): Promise<void>;
}

/** The admin path a test listens on: a socket in a fresh directory, or a pipe of its own on Windows. */
export function adminPath(): { path: string; cleanup(): void } {
  if (process.platform === "win32") return { path: `\\\\.\\pipe\\mandate-egress-test-${randomBytes(6).toString("hex")}`, cleanup() {} };
  const dir = mkdtempSync(join(tmpdir(), "mdt-eg-"));
  return { path: join(dir, "egress.sock"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const CONFIG = {
  credentials: {
    github: { env: "MANDATE_EGRESS_GITHUB", hosts: ["api.github.com", "uploads.github.com"], header: "authorization", template: "Bearer {secret}" },
    model: { env: "MANDATE_EGRESS_MODEL", hosts: ["api.anthropic.com"], header: "x-api-key", template: "{secret}" },
  },
};

export async function world(o: { allow_private?: boolean; lingerMs?: number; dialTimeoutMs?: number } = {}): Promise<World> {
  const up = await upstream();
  const where = adminPath();
  const config = egressConfig({ admin: where.path, ...CONFIG, ...(o.allow_private ? { allow_private: true } : {}) }, "test", tmpdir());
  const dials: DialRequest[] = [];
  const resolved: string[] = [];
  const dns = new Map<string, string[] | (() => string[])>();
  const resolve: Resolver = async (host) => {
    resolved.push(host);
    const a = dns.get(host);
    const list = a === undefined ? ["93.184.215.14"] : typeof a === "function" ? a() : a;
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  const proxy = new EgressProxy({
    config,
    secrets: new Map([
      ["github", Buffer.from(SECRET)],
      ["model", Buffer.from(OTHER_SECRET)],
    ]),
    resolve,
    // Whatever address it is asked for, the fake dialer reaches the in-process upstream, and remembers what it was asked.
    dial: async (r) => {
      dials.push(r);
      if (w.dialDelayMs) await new Promise((ok) => setTimeout(ok, w.dialDelayMs));
      return new Promise((ok, fail) => {
        const s = connect({ host: "127.0.0.1", port: up.port });
        w.dialed.push(s);
        s.once("connect", () => ok(s));
        s.once("error", fail);
      });
    },
    ...(o.lingerMs !== undefined ? { lingerMs: o.lingerMs } : {}),
    ...(o.dialTimeoutMs !== undefined ? { dialTimeoutMs: o.dialTimeoutMs } : {}),
  });
  const admin = await serveAdmin(proxy, where.path);
  const client = await EgressClient.connect(where.path);
  const w: World = {
    config,
    proxy,
    admin,
    client,
    up,
    dials,
    dialed: [],
    dialDelayMs: 0,
    resolved,
    dns,
    async close() {
      client.close();
      await proxy.close();
      await admin.close();
      await new Promise<void>((ok) => up.server.close(() => ok()));
      up.server.closeAllConnections();
      where.cleanup();
    },
  };
  return w;
}

let n = 0;
/** A fresh session id. */
export const sid = (): string => `s${++n}-${randomBytes(3).toString("hex")}`;

export interface Response {
  status: number;
  headers: [string, string][];
  /** The body, chunked framing removed. */
  body: string;
  /** Every byte that came back, as latin1. */
  raw: string;
  header(name: string): string | undefined;
}

/** Sends `text` as it is to `port` and reads everything until the proxy closes the connection. */
export function send(port: number, text: string | Buffer, o: { host?: string; then?: (s: Socket) => void } = {}): Promise<Response> {
  return new Promise((ok, fail) => {
    const s = connect({ host: o.host ?? "127.0.0.1", port });
    const parts: Buffer[] = [];
    s.on("data", (c: Buffer) => parts.push(c));
    s.on("error", fail);
    s.on("close", () => {
      try {
        ok(parseResponse(Buffer.concat(parts).toString("latin1")));
      } catch (e) {
        fail(e as Error);
      }
    });
    s.write(text);
    o.then?.(s);
  });
}

export function parseResponse(raw: string): Response {
  // A 100 Continue the proxy sent first is skipped.
  let rest = raw;
  while (rest.startsWith("HTTP/1.1 100")) rest = rest.slice(rest.indexOf("\r\n\r\n") + 4);
  const end = rest.indexOf("\r\n\r\n");
  if (end < 0) throw new Error(`no response head in ${JSON.stringify(raw.slice(0, 200))}`);
  const [line, ...lines] = rest.slice(0, end).split("\r\n");
  const status = Number(line!.split(" ")[1]);
  const headers = lines.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()] as [string, string]);
  let body = rest.slice(end + 4);
  if (headers.some(([n, v]) => n === "transfer-encoding" && v === "chunked")) body = dechunk(body);
  return { status, headers, body, raw, header: (name) => headers.find(([n]) => n === name)?.[1] };
}

/** A chunked body decoded; one that lacks its last chunk throws, as a cut body should. */
export function dechunk(text: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const nl = text.indexOf("\r\n", at);
    if (nl < 0) throw new Error("the chunked body was cut");
    const size = parseInt(text.slice(at, nl).split(";")[0]!, 16);
    if (size === 0) return out;
    out += text.slice(nl + 2, nl + 2 + size);
    at = nl + 2 + size + 2;
  }
}

/** A request head and body, with CRLF line ends. */
export const http = (lines: string[], body = ""): string => lines.join("\r\n") + "\r\n\r\n" + body;

/** The header values `name` reached the upstream with. */
export function seenHeader(s: Seen, name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i + 1 < s.headers.length; i += 2) if (s.headers[i]!.toLowerCase() === name) out.push(s.headers[i + 1]!);
  return out;
}

export const portOf = (url: string): number => Number(new URL(url).port);
