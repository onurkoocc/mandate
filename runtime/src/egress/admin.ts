// The egress proxy's admin channel (spec/egress.md "Admin channel"): a Unix
// socket, or a named pipe on Windows, that speaks one JSON object per line in
// each direction. A request carries an `id` and an `op`; its response carries
// the same `id` and either `ok: true` and a `result`, or `ok: false` and an
// `error` with a code. Nothing on this channel ever carries a secret: `hello`
// names the credentials, a session gets placeholders.
//
// The socket is created owner-only (mode 0600, under a umask that never lets
// it be anything else, even for a moment). What protects a named pipe on
// Windows is its default security descriptor; the spec says what that is.

import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { connect, createServer, type Server, type Socket } from "node:net";
import { parseStrictJson } from "@mandate/compiler";
import { Violation } from "../signals.js";
import { EGRESS_FORMAT, isPipe } from "./config.js";
import { EgressError, type Destination, type EgressProxy, type RevokeScope, type SessionRequest } from "./proxy.js";

export const MAX_LINE_BYTES = 1024 * 1024;

/** The fields each operation takes, besides `id` and `op`; which are required is checked by the operation. */
const FIELDS: Record<string, string[]> = {
  hello: [],
  open_session: ["session", "tenant", "run", "command", "kind", "destinations", "ttl_ms"],
  close_session: ["session"],
  revoke: ["session", "run", "tenant", "all"],
  denials: ["session", "after", "limit"],
};

export interface AdminServer {
  readonly path: string;
  /** Stops listening, cuts the admin connections and removes the socket file. Sessions are the proxy's to close. */
  close(): Promise<void>;
}

/** Serves the admin channel of `proxy` at `path`. A socket file left by a proxy that is gone is replaced; a live one is not. */
export async function serveAdmin(proxy: EgressProxy, path: string): Promise<AdminServer> {
  const pipe = isPipe(path);
  if (!pipe) await clearStale(path);
  const conns = new Set<Socket>();
  const server: Server = createServer((socket) => {
    conns.add(socket);
    socket.once("close", () => conns.delete(socket));
    serveConnection(proxy, socket);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", (e) => fail(new Violation("egress_admin_unavailable", `cannot listen on ${path}: ${e.message}`)));
    // Bound under a umask of 0177, the socket is never more than owner read and write, not even before the chmod.
    const old = pipe ? undefined : setUmask(0o177);
    try {
      server.listen({ path, exclusive: true }, ok);
    } finally {
      if (old !== undefined) process.umask(old);
    }
  });
  if (!pipe) chmodSync(path, 0o600);
  let closed = false;
  return {
    path,
    async close() {
      if (closed) return;
      closed = true;
      for (const c of conns) c.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
      if (!pipe && existsSync(path)) {
        try {
          unlinkSync(path);
        } catch {
          // Already gone.
        }
      }
    },
  };
}

/** Sets the process's umask and returns the old one; in a worker thread, which cannot, the chmod alone is left. */
function setUmask(mask: number): number | undefined {
  try {
    return process.umask(mask);
  } catch {
    return undefined;
  }
}

/** A socket file nobody listens on is removed; one somebody listens on, or a file that is not a socket, stops the start. */
async function clearStale(path: string): Promise<void> {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return;
  }
  if (!st.isSocket()) throw new Violation("egress_admin_unavailable", `${path} exists and is not a socket`);
  const live = await new Promise<boolean>((ok) => {
    const c = connect({ path });
    c.once("connect", () => (c.destroy(), ok(true)));
    c.once("error", () => ok(false));
  });
  if (live) throw new Violation("egress_admin_unavailable", `another process listens on ${path}`);
  unlinkSync(path);
}

/** Reads requests line by line and answers each in order. */
function serveConnection(proxy: EgressProxy, socket: Socket): void {
  let buf: Buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  socket.on("error", () => socket.destroy());
  socket.on("data", (chunk: Buffer) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const nl = buf.indexOf(0x0a);
      if (nl < 0) break;
      const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
      buf = buf.subarray(nl + 1);
      if (line.trim() === "") continue;
      queue = queue.then(async () => {
        const answer = await respond(proxy, line);
        if (!socket.destroyed) socket.write(JSON.stringify(answer) + "\n");
      });
    }
    if (buf.length > MAX_LINE_BYTES) {
      socket.end(JSON.stringify({ id: null, ok: false, error: { code: "line_too_long", message: `a request line is at most ${MAX_LINE_BYTES} bytes` } }) + "\n");
      socket.destroy();
    }
  });
}

type Answer = { id: string | number | null; ok: true; result: unknown } | { id: string | number | null; ok: false; error: { code: string; message: string } };

/** The answer to one request line. */
export async function respond(proxy: EgressProxy, line: string): Promise<Answer> {
  let id: string | number | null = null;
  try {
    const parsed = Buffer.byteLength(line) <= MAX_LINE_BYTES ? parseStrictJson(line) : undefined;
    if (!parsed?.ok) throw new EgressError("bad_request", "a request is one JSON object on one line");
    const r = parsed.value.value;
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new EgressError("bad_request", "a request is a JSON object");
    const req = r as Record<string, unknown>;
    if ((typeof req["id"] === "string" && req["id"].length <= 128) || Number.isSafeInteger(req["id"])) id = req["id"] as string | number;
    else throw new EgressError("bad_request", "a request has an id: a string of at most 128 characters or a whole number");
    const op = req["op"];
    if (typeof op !== "string" || !(op in FIELDS)) throw new EgressError("unknown_op", `no operation ${JSON.stringify(op)}; there are ${Object.keys(FIELDS).join(", ")}`);
    for (const k of Object.keys(req)) if (k !== "id" && k !== "op" && !FIELDS[op]!.includes(k)) throw new EgressError("bad_request", `${op} takes no field ${k}`);
    return { id, ok: true, result: await perform(proxy, op, req) };
  } catch (e) {
    if (e instanceof EgressError) return { id, ok: false, error: { code: e.code, message: e.message.slice(e.code.length + 2) } };
    return { id, ok: false, error: { code: "internal_error", message: "the proxy could not carry out the request" } };
  }
}

async function perform(proxy: EgressProxy, op: string, req: Record<string, unknown>): Promise<unknown> {
  const session = (): string => {
    if (typeof req["session"] !== "string") throw new EgressError("bad_request", `${op} needs a session`);
    return req["session"];
  };
  switch (op) {
    case "hello":
      return { format: EGRESS_FORMAT, credentials: proxy.credentials() };
    case "open_session": {
      for (const k of FIELDS["open_session"]!) if (!(k in req)) throw new EgressError("bad_request", `open_session needs ${k}`);
      return proxy.openSession({ ...(req as unknown as SessionRequest), destinations: req["destinations"] as Destination[] });
    }
    case "close_session":
      await proxy.closeSession(session());
      return { closed: session() };
    case "revoke": {
      const given = ["session", "run", "tenant", "all"].filter((k) => k in req);
      if (given.length !== 1) throw new EgressError("bad_request", "revoke takes exactly one of session, run, tenant or all");
      const k = given[0]!;
      if (k === "all" ? req["all"] !== true : typeof req[k] !== "string") throw new EgressError("bad_request", k === "all" ? "revoke takes all: true" : `revoke's ${k} is a string`);
      return { revoked: proxy.revoke((k === "all" ? { all: true } : { [k]: req[k] }) as RevokeScope) };
    }
    case "denials": {
      const after = req["after"] ?? 0;
      const limit = req["limit"] ?? 100;
      if (!Number.isSafeInteger(after) || (after as number) < 0) throw new EgressError("bad_request", "after is a denial id, a whole number from 0");
      if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) throw new EgressError("bad_request", "limit is a whole number from 1 to 1000");
      return proxy.denials(session(), after as number, limit as number);
    }
  }
  throw new EgressError("unknown_op", op);
}
