// A client of the egress proxy's admin channel (spec/egress.md "Admin
// channel"): what the runtime uses to open a session for a sandbox or for its
// own adapters, to close or revoke it, and to read what it denied. It speaks
// to any proxy that implements the contract, not only the reference one.

import { connect, type Socket } from "node:net";
import { EGRESS_FORMAT } from "./config.js";
import { EgressError, type Denial, type OpenedSession, type RevokeScope, type SessionRequest } from "./proxy.js";

/** The most requests the client leaves unanswered on its connection; a proxy holds at least this many pending. */
export const MAX_IN_FLIGHT = 64;

export interface Hello {
  format: string;
  /** The names of the credentials the proxy holds. */
  credentials: string[];
}

export type ForwardSession = { proxy_url: string; placeholders: Record<string, string> };
export type GatewaySession = { base_url: string; placeholders: Record<string, string> };

export interface EgressClientOptions {
  /** How long a request may wait for its answer; past it the request fails as `egress_unavailable`. */
  timeoutMs?: number;
}

export class EgressClient {
  private nextId = 1;
  private buf = "";
  /** Calls waiting for their answers, by their id as JSON: an answer matches the id exactly as it was sent. */
  private readonly pending = new Map<string, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout; settled: boolean }>();
  /** Calls waiting for a slot (`MAX_IN_FLIGHT`). */
  private readonly waiting: (() => void)[] = [];
  private gone: Error | undefined;

  private constructor(
    private readonly socket: Socket,
    private readonly timeoutMs: number,
  ) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => this.read(chunk));
    const lost = (): void => this.lose(new EgressError("egress_unavailable", "the connection to the egress proxy closed"));
    socket.on("error", lost);
    socket.on("close", lost);
  }

  /**
   * Connects to the admin channel at `path`: a Unix socket, or a named pipe on Windows. A proxy that does not take the
   * connection within `timeoutMs` (one whose backlog is full takes none) is `egress_unavailable`, so no caller waits for it.
   */
  static connect(path: string, o: EgressClientOptions = {}): Promise<EgressClient> {
    const timeoutMs = o.timeoutMs ?? 10_000;
    return new Promise((ok, fail) => {
      const socket = connect({ path });
      const timer = setTimeout(() => {
        socket.destroy();
        fail(new EgressError("egress_unavailable", `the egress proxy at ${path} did not take the connection within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.removeAllListeners("error");
        ok(new EgressClient(socket, timeoutMs));
      });
      socket.once("error", (e) => {
        clearTimeout(timer);
        fail(new EgressError("egress_unavailable", `cannot reach the egress proxy at ${path}: ${e.message}`));
      });
    });
  }

  /** The proxy's protocol version and credential names; a proxy of another version is refused (`egress_unavailable`). */
  async hello(): Promise<Hello> {
    const h = (await this.call("hello", {})) as Hello;
    if (h.format !== EGRESS_FORMAT) throw new EgressError("egress_unavailable", `the egress proxy speaks ${String(h.format)}, not ${EGRESS_FORMAT}`);
    return h;
  }

  openSession(r: SessionRequest & { kind: "forward" }): Promise<ForwardSession>;
  openSession(r: SessionRequest & { kind: "gateway" }): Promise<GatewaySession>;
  openSession(r: SessionRequest): Promise<OpenedSession>;
  async openSession(r: SessionRequest): Promise<OpenedSession> {
    return (await this.call("open_session", { ...r })) as OpenedSession;
  }

  async closeSession(session: string): Promise<void> {
    await this.call("close_session", { session });
  }

  /** Revokes the sessions in scope; returns their ids. */
  async revoke(scope: RevokeScope): Promise<string[]> {
    return ((await this.call("revoke", { ...scope })) as { revoked: string[] }).revoked;
  }

  /** A session's denials after the id `after`, oldest first; `dropped` counts those the proxy did not keep. */
  async denials(session: string, o: { after?: number; limit?: number } = {}): Promise<{ denials: Denial[]; dropped: number }> {
    return (await this.call("denials", { session, ...o })) as { denials: Denial[]; dropped: number };
  }

  close(): void {
    this.socket.destroy();
  }

  /**
   * Sends one request. At most `MAX_IN_FLIGHT` are unanswered at once, the most a proxy holds pending on one
   * connection; a call past that waits here for a slot. A call that timed out keeps its slot until the proxy answers
   * it, since the proxy still counts it.
   */
  private async call(op: string, fields: Record<string, unknown>): Promise<unknown> {
    while (this.pending.size >= MAX_IN_FLIGHT && !this.gone) await new Promise<void>((ok) => this.waiting.push(ok));
    if (this.gone) throw this.gone;
    const id = this.nextId++;
    const key = JSON.stringify(id);
    return new Promise((ok, fail) => {
      const entry = {
        ok,
        fail,
        settled: false,
        timer: setTimeout(() => {
          entry.settled = true;
          fail(new EgressError("egress_unavailable", `the egress proxy did not answer ${op} within ${this.timeoutMs} ms`));
        }, this.timeoutMs),
      };
      this.pending.set(key, entry);
      this.socket.write(JSON.stringify({ id, op, ...fields }) + "\n");
    });
  }

  private read(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const nl = this.buf.indexOf("\n");
      if (nl < 0) return;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return this.lose(new EgressError("egress_unavailable", "the egress proxy answered with a line that is not JSON"));
      }
      const key = typeof msg.id === "number" || typeof msg.id === "string" ? JSON.stringify(msg.id) : undefined;
      const p = key !== undefined ? this.pending.get(key) : undefined;
      if (!p) continue;
      this.pending.delete(key!);
      this.waiting.shift()?.();
      clearTimeout(p.timer);
      if (p.settled) continue;
      if (msg.ok === true) p.ok(msg.result);
      else p.fail(new EgressError(String(msg.error?.code ?? "egress_error"), String(msg.error?.message ?? "the egress proxy refused the request")));
    }
  }

  private lose(e: Error): void {
    if (this.gone) return;
    this.gone = e;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      if (!p.settled) p.fail(e);
    }
    this.pending.clear();
    for (const w of this.waiting.splice(0)) w();
    this.socket.destroy();
  }
}
