// The verifier as a process of its own (Doc 4 §10.3; BACKLOG P2-11). The
// runtime starts it and talks to it over stdio, one JSON-RPC 2.0 message per
// line:
//
//   open        { program, lock }        the package the checks belong to
//   key         {}                       → { key_id, public_key }
//   upperBound  { request }              → Cost | null
//   check       { request }              → { result: CheckResult, attestation: { key_id, signature } }
//
// The service signs each check's statement (attestation.ts) with its own
// key, which only it reads. `ProcessVerifier`, on the runtime's side,
// recomputes the statement from the request and the result it got, and
// accepts the result only when the signature verifies against a pinned
// verifier key. Otherwise the check is not met (`unattested_check`): a
// result the verifier did not sign never passes.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Lock, Program } from "@mandate/compiler";
import type { CheckResult, Cost, VerifierAdapter, VerifyRequest } from "./adapters.js";
import { ATTESTATION_FORMAT, statementOf, type Attestation } from "./attestation.js";
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
        const result = await verifier.check(req);
        return { result: result as unknown as Value, attestation: signer.signStatement(ATTESTATION_FORMAT, statementOf(req, result) as unknown as Value) as unknown as Value };
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
  env?: NodeJS.ProcessEnv;
}

/** The runtime's side: a VerifierAdapter whose checks run in another process and come back signed. */
export class ProcessVerifier implements VerifierAdapter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private next = 1;
  private readonly pending = new Map<number, { resolve(v: Value): void; reject(e: Error): void }>();

  constructor(private readonly o: ProcessVerifierOptions) {}

  async upperBound(req: VerifyRequest): Promise<Cost | undefined> {
    return ((await this.call("upperBound", { request: req as unknown as Value })) ?? undefined) as Cost | undefined;
  }

  async check(req: VerifyRequest): Promise<CheckResult> {
    const r = (await this.call("check", { request: req as unknown as Value })) as { result?: CheckResult; attestation?: Signature };
    const result = r.result;
    const sig = r.attestation;
    const statement = result ? statementOf(req, result) : undefined;
    if (!result || !sig || !statement || !this.o.trusted.verifyStatement(ATTESTATION_FORMAT, statement as unknown as Value, sig)) {
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
  }

  private start(): ChildProcessWithoutNullStreams {
    const [cmd, ...args] = this.o.command;
    const child = spawn(cmd!, args, { stdio: ["pipe", "pipe", "pipe"], env: this.o.env ?? process.env });
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
      if (this.child === child) this.child = undefined;
      for (const [, p] of this.pending) p.reject(new Error(`the verifier process exited (${code}): ${stderr.trim()}`));
      this.pending.clear();
    });
    this.child = child;
    this.send(child, "open", this.o.package as unknown as Value, 0);
    return child;
  }

  private call(method: string, params: Value): Promise<Value> {
    const child = this.child ?? this.start();
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
