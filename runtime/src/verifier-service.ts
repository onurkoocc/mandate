// The verifier as a process of its own (Doc 4 §10.3; BACKLOG P2-11). The
// runtime starts it and talks to it over stdio, one JSON-RPC 2.0 message per
// line:
//
//   open        { program, lock }        the package the checks belong to
//   key         {}                       → { key_id, public_key }
//   upperBound  { request }              → Cost | null
//   check       { request, binding }     → { result: CheckResult, attestation: { key_id, signature } }
//
// `binding` is the run and the part of the criterion the check is for
// (CheckBinding); it travels beside the request, so the request and its
// digest, the check's identity in the journal, stay as they are. The
// service signs each check's statement (attestation.ts), which names the
// binding, with its own key, which only it reads. `ProcessVerifier`, on the
// runtime's side, recomputes the statement from the request, the binding it
// sent and the result it got, and accepts the result only when the
// signature verifies against a pinned verifier key. Otherwise the check is
// not met (`unattested_check`): a result the verifier did not sign for this
// check never passes.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Lock, Program } from "@mandate/bridge";
import type { CheckBinding, CheckResult, Cost, VerifierAdapter, VerifyRequest } from "./adapters.js";
import { statementOf, type Attestation } from "./attestation.js";
import { childEnv } from "./env.js";
import type { EvidenceSigner, Signature, TrustedKeys } from "./evidence.js";
import { isObj, type Value } from "./values.js";

export interface VerifierPackage {
  program: Program;
  lock: Lock;
}

/** Serves one verifier over a pair of streams until the input ends. */
export function serveVerifier(make: (pkg: VerifierPackage) => VerifierAdapter, signer: EvidenceSigner, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  let verifier: VerifierAdapter | undefined;
  const reply = (id: Value, body: { result: Value } | { error: { code: number; message: string } }): void => {
    output.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
  };
  const handle = async (msg: Record<string, Value>): Promise<Value> => {
    const params = isObj(msg["params"] ?? null) ? (msg["params"] as Record<string, Value>) : {};
    switch (msg["method"]) {
      case "open":
        verifier = make(params as unknown as VerifierPackage);
        return null;
      case "key":
        return { key_id: signer.keyId, public_key: signer.publicKeyPem() };
      case "upperBound": {
        if (!verifier) throw new Error("no package is open");
        return ((await verifier.upperBound?.(params["request"] as unknown as VerifyRequest)) ?? null) as Value;
      }
      case "check": {
        if (!verifier) throw new Error("no package is open");
        const req = params["request"] as unknown as VerifyRequest;
        const b = params["binding"];
        if (b !== undefined && !(isObj(b) && typeof b["run"] === "string" && typeof b["part"] === "string")) throw new Error("a check's binding names its run and part");
        const binding = b === undefined ? undefined : { run: b["run"] as string, part: b["part"] as string };
        const result = await verifier.check(req, binding);
        const statement = statementOf(req, result, binding);
        return { result: result as unknown as Value, attestation: signer.signStatement(statement.format, statement as unknown as Value) as unknown as Value };
      }
      default:
        throw new Error(`unknown method ${String(msg["method"])}`);
    }
  };
  return new Promise((resolve) => {
    const lines = createInterface({ input });
    // Requests are answered in the order they arrive; a check runs to its end before the next starts.
    let queue = Promise.resolve();
    lines.on("line", (line) => {
      if (!line.trim()) return;
      queue = queue.then(async () => {
        let msg: Record<string, Value>;
        try {
          msg = JSON.parse(line) as Record<string, Value>;
        } catch {
          return reply(null, { error: { code: -32700, message: "parse error" } });
        }
        try {
          reply(msg["id"] ?? null, { result: await handle(msg) });
        } catch (e) {
          reply(msg["id"] ?? null, { error: { code: -32000, message: (e as Error).message } });
        }
      });
    });
    lines.on("close", () => void queue.then(() => resolve()));
  });
}

export interface ProcessVerifierOptions {
  /** How to start the verifier process: the program and its arguments. */
  command: string[];
  /** The verifier keys whose attestations count. */
  trusted: TrustedKeys;
  package: VerifierPackage;
  /** The process's whole environment (env.ts `verifierEnv`); without it, only what any program needs (`childEnv`). */
  env?: NodeJS.ProcessEnv | ChildEnvSource;
}

/**
 * An environment made when the process starts, such as one that carries a gateway session's address and placeholder
 * (gateway.ts). `stale` says when the process is to be started again, with a new one, before the next request that
 * finds it idle; `release` is called when the process it was made for is let go.
 */
export interface ChildEnvSource {
  make(): Promise<{ env: NodeJS.ProcessEnv; stale?: () => boolean; release?: () => void }>;
}

function isSource(e: NodeJS.ProcessEnv | ChildEnvSource | undefined): e is ChildEnvSource {
  return typeof (e as ChildEnvSource | undefined)?.make === "function";
}

/** The runtime's side: a VerifierAdapter whose checks run in another process and come back signed. */
export class ProcessVerifier implements VerifierAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: Value): void; reject(e: Error): void }>();
  /** A process being started from an environment source, and what the source made for the current process. */
  private starting: Promise<ChildProcessWithoutNullStreams> | undefined;
  private made: { stale?: () => boolean; release?: () => void } | undefined;

  constructor(private readonly o: ProcessVerifierOptions) {}

  async upperBound(req: VerifyRequest): Promise<Cost | undefined> {
    return ((await this.call("upperBound", { request: req as unknown as Value })) ?? undefined) as Cost | undefined;
  }

  /**
   * With a binding (the interpreter always sends one), the result counts only under a 0.2 attestation that names
   * exactly that run and part, and the request's contract, criterion and method: the statement is computed here
   * from what was sent, and the signature must verify over it. A 0.1 attestation, or one made for another
   * binding, is not met. Without a binding, a 0.1 attestation is expected, as before.
   */
  async check(req: VerifyRequest, binding?: CheckBinding): Promise<CheckResult> {
    const r = (await this.call("check", { request: req as unknown as Value, ...(binding ? { binding: { run: binding.run, part: binding.part } } : {}) })) as { result?: CheckResult; attestation?: Signature };
    const result = r.result;
    const sig = r.attestation;
    const statement = result ? statementOf(req, result, binding) : undefined;
    if (!result || !sig || !statement || !this.o.trusted.verifyStatement(statement.format, statement as unknown as Value, sig)) {
      // Not signed by a verifier this runtime trusts: whatever it says, the criterion is not met.
      return { passed: false, detail: { reason: "unattested_check", key_id: sig?.key_id ?? null }, producer: { kind: "verifier", process: "separate", attestation: null } };
    }
    const attestation: Attestation = { statement, key_id: sig.key_id, signature: sig.signature };
    const producer = isObj(result.producer ?? null) ? (result.producer as Record<string, Value>) : {};
    return { ...result, producer: { ...producer, process: "separate", attestation: attestation as unknown as Value } };
  }

  /** The verifier's public key, as it reports it. Trust comes from the pinned keys, never from this answer. */
  async key(): Promise<{ key_id: string; public_key: string }> {
    return (await this.call("key", {})) as { key_id: string; public_key: string };
  }

  close(): void {
    this.child?.stdin.end();
    this.child = undefined;
    this.letGo();
  }

  /** Lets go of what the environment source made for the process that ended. */
  private letGo(): void {
    const made = this.made;
    this.made = undefined;
    made?.release?.();
  }

  /** The process to send to, from an environment source: started again, with a new environment, when idle and stale. */
  private async fromSource(src: ChildEnvSource): Promise<ChildProcessWithoutNullStreams> {
    if (this.child && !(this.pending.size === 0 && this.made?.stale?.())) return this.child;
    if (this.child) this.close();
    this.starting ??= src
      .make()
      .then((m) => {
        this.made = m;
        return this.start(m.env);
      })
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private start(env: NodeJS.ProcessEnv = childEnv()): ChildProcessWithoutNullStreams {
    const [cmd, ...args] = this.o.command;
    // Only what the caller gives, or what any program needs: never the runtime's whole environment (env.ts).
    const child = spawn(cmd!, args, { stdio: ["pipe", "pipe", "pipe"], env });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let msg: { id?: number; result?: Value; error?: { message: string } };
      try {
        msg = JSON.parse(line) as typeof msg;
      } catch {
        return;
      }
      const p = msg.id !== undefined ? this.pending.get(msg.id) : undefined;
      if (!p) return;
      this.pending.delete(msg.id!);
      if (msg.error) p.reject(new Error(`verifier: ${msg.error.message}`));
      else p.resolve(msg.result ?? null);
      this.idle();
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr = (stderr + String(c)).slice(-4000)));
    child.on("exit", (code) => {
      if (this.child === child) {
        this.child = undefined;
        this.letGo();
      }
      for (const [, p] of this.pending) p.reject(new Error(`the verifier process exited (${code}): ${stderr.trim()}`));
      this.pending.clear();
    });
    this.child = child;
    this.send(child, "open", this.o.package as unknown as Value, 0);
    return child;
  }

  private async call(method: string, params: Value): Promise<Value> {
    const env = this.o.env;
    const child = isSource(env) ? await this.fromSource(env) : (this.child ?? this.start(env));
    const id = this.next++;
    const answer = new Promise<Value>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.send(child, method, params, id);
    return answer;
  }

  private send(child: ChildProcessWithoutNullStreams, method: string, params: Value, id: number): void {
    // The process keeps the runtime alive only while it owes an answer.
    child.ref();
    for (const s of [child.stdin, child.stdout, child.stderr] as unknown as Array<{ ref?(): void }>) s.ref?.();
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  }

  private idle(): void {
    if (this.pending.size || !this.child) return;
    this.child.unref();
    for (const s of [this.child.stdin, this.child.stdout, this.child.stderr] as unknown as Array<{ unref?(): void }>) s.unref?.();
  }
}
