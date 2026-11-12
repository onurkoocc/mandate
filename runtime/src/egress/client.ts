// A client of the egress proxy's admin channel (spec/egress.md "Admin
// channel"): what the runtime uses to open a session for a sandbox or for its
// own adapters, to close or revoke it, and to read what it denied. It speaks
// to any proxy that implements the contract, not only the reference one.

import { connect, type Socket } from "node:net";
import { EGRESS_FORMAT } from "./config.js";
import { EgressError, type Denial, type OpenedSession, type RevokeScope, type SessionRequest } from "./proxy.js";

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
  private readonly pending = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void; timer: NodeJS.Timeout }>();
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

  /** Connects to the admin channel at `path`: a Unix socket, or a named pipe on Windows. */
  static connect(path: string, o: EgressClientOptions = {}): Promise<EgressClient> {
    return new Promise((ok, fail) => {
      const socket = connect({ path });
      socket.once("connect", () => {
        socket.removeAllListeners("error");
        ok(new EgressClient(socket, o.timeoutMs ?? 10_000));
      });
      socket.once("error", (e) => fail(new EgressError("egress_unavailable", `cannot reach the egress proxy at ${path}: ${e.message}`)));
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

  private call(op: string, fields: Record<string, unknown>): Promise<unknown> {
    if (this.gone) return Promise.reject(this.gone);
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        fail(new EgressError("egress_unavailable", `the egress proxy did not answer ${op} within ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.pending.set(id, { ok, fail, timer });
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
      const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.ok === true) p.ok(msg.result);
      else p.fail(new EgressError(String(msg.error?.code ?? "egress_error"), String(msg.error?.message ?? "the egress proxy refused the request")));
    }
  }

  private lose(e: Error): void {
    if (this.gone) return;
    this.gone = e;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.fail(e);
    }
    this.pending.clear();
    this.socket.destroy();
  }
}
