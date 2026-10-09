// The real sandbox host: MXC's SDK (`@microsoft/mxc-sdk/v1`) on Linux with
// the Bubblewrap backend (Doc 4 §11.3, §16.1; BACKLOG P1-8, K7, K16).
//
// - Probe: the SDK's platform check. A host where Bubblewrap cannot run (no
//   bwrap, user namespaces off) enforces nothing, so MxcAdapter refuses every
//   agent by name (G05). Windows backends are a later item (P2-27).
// - Create: records the policy; Bubblewrap needs no long-lived container.
// - Execute: one `bwrap` process per tool call, under the policy:
//     filesystem  the deny-by-default system baseline read-only, plus the
//                 policy's read-only and read-write paths and nothing else
//     network     egress and ingress denied: `--unshare-net`, no network at all
//     timeout     the policy's, per process
//   The command allow-list is not something Bubblewrap can enforce inside the
//   sandbox, so the host enforces it before it starts a process: a process is
//   either one of the runtime's own tool helpers (cat, ls, grep, the
//   write_file script) on a path inside the policy's paths, or an allowed
//   command whose arguments start with an allowed prefix. Anything else is
//   refused without starting.
// - Destroy: forgets the policy.
//
// Bubblewrap has no learning mode, so a requirement for one is refused by
// name (W0311 feedback needs the Windows backend).

import { randomUUID } from "node:crypto";
import type { Enforceable, ExecRequest, ExecResult, MxcPolicy, SandboxHost } from "./sandbox.js";
import { inside, WRITE_SCRIPT } from "./tools.js";

/** The part of `@microsoft/mxc-sdk/v1` the host uses; tests pass a fake. */
export interface MxcSdk {
  getPlatformSupport(): { isSupported: boolean; reason?: string; availableMethods: string[]; unavailableReasons?: Record<string, string> };
  spawn(request: MxcContainerRequest): Promise<MxcSpawned>;
}

export interface MxcContainerRequest {
  command: string;
  filesystem: { readonlyPaths: string[]; readwritePaths: string[] };
  network: { egress: { default: "deny" }; ingress: { default: "deny"; hostLoopback: "deny" } };
  containment: { type: "bubblewrap" };
  timeoutMs?: number;
  workingDirectory?: string;
}

export interface MxcSpawned {
  readonly standardInput: NodeJS.WritableStream | null;
  readonly standardOutput: NodeJS.ReadableStream | null;
  readonly standardError: NodeJS.ReadableStream | null;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  dispose(): void;
}

export interface MxcHostOptions {
  /** Default: `@microsoft/mxc-sdk/v1`, loaded on first use. */
  sdk?: MxcSdk;
  /** Extra read-only paths every sandbox sees, e.g. a toolchain under /usr/local or /opt. Shown in the policy. */
  baseline?: string[];
  /** Longest output kept per stream; the rest is cut. Default 1 MiB. */
  maxOutput?: number;
}

const NOTHING: Enforceable = { backends: [], modes: [], filesystem: false, network: "none", exec: "none", timeout: false, ui: false };

/** Helpers the runtime's own tools start; the filesystem policy confines them. */
const HELPERS = new Set(["cat", "ls", "grep"]);

export class MxcHost implements SandboxHost {
  private sdk: MxcSdk | undefined;
  private readonly policies = new Map<string, MxcPolicy>();
  /** Why the last probe found nothing enforceable, for the operator. */
  unavailable: string | undefined;

  constructor(private readonly o: MxcHostOptions = {}) {
    this.sdk = o.sdk;
  }

  private async load(): Promise<MxcSdk | undefined> {
    if (this.sdk) return this.sdk;
    try {
      this.sdk = (await import("@microsoft/mxc-sdk/v1")) as unknown as MxcSdk;
    } catch (e) {
      this.unavailable = `@microsoft/mxc-sdk could not be loaded: ${(e as Error).message}`;
    }
    return this.sdk;
  }

  async probe(): Promise<Enforceable> {
    const sdk = await this.load();
    if (!sdk) return NOTHING;
    const p = sdk.getPlatformSupport();
    if (!p.isSupported || !p.availableMethods.includes("bubblewrap")) {
      this.unavailable = p.unavailableReasons?.["bubblewrap"] ?? p.reason ?? `bubblewrap is not among ${p.availableMethods.join(", ") || "no backends"}`;
      return NOTHING;
    }
    this.unavailable = undefined;
    return { backends: ["process"], modes: ["enforcement"], filesystem: true, network: "deny_all", exec: "args_prefix", timeout: true, ui: true };
  }

  async create(policy: MxcPolicy): Promise<string> {
    // MxcAdapter only plans what the probe said it can enforce; a policy that asks for more is a bug, not a fallback.
    if (policy.network.allowOutbound || policy.network.allowedHosts.length) throw new Error("MxcHost: Bubblewrap here enforces no outbound network at all; this policy allows some.");
    if (policy.mode !== "enforcement") throw new Error(`MxcHost: Bubblewrap has no ${policy.mode} mode.`);
    const handle = `mxc-${randomUUID()}`;
    this.policies.set(handle, policy);
    return handle;
  }

  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    const policy = this.policies.get(handle);
    if (!policy) return refused(`no sandbox ${handle}`);
    const why = this.disallowed(policy, req.argv);
    if (why) return refused(why);
    const sdk = await this.load();
    if (!sdk) return refused(this.unavailable ?? "MXC is not available");
    const timeoutMs = req.timeoutMs ?? (policy.timeoutSeconds !== null ? policy.timeoutSeconds * 1000 : undefined);
    const request: MxcContainerRequest = {
      command: req.argv.map(shellQuote).join(" "),
      filesystem: { readonlyPaths: [...(this.o.baseline ?? []), ...policy.filesystem.readOnly], readwritePaths: [...policy.filesystem.readWrite] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      containment: { type: "bubblewrap" },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(req.cwd ? { workingDirectory: req.cwd } : {}),
    };
    let proc: MxcSpawned;
    try {
      proc = await sdk.spawn(request);
    } catch (e) {
      return refused(`MXC refused to start the process: ${(e as Error).message}`);
    }
    try {
      const out = collect(proc.standardOutput, this.o.maxOutput ?? 1 << 20);
      const err = collect(proc.standardError, this.o.maxOutput ?? 1 << 20);
      proc.standardInput?.end(req.stdin ?? "");
      const [status, stdout, stderr] = await Promise.all([proc.wait(), out, err]);
      return { stdout, stderr, exitCode: status.exitCode, timedOut: status.timedOut };
    } finally {
      proc.dispose();
    }
  }

  async destroy(handle: string): Promise<"destroyed"> {
    this.policies.delete(handle);
    return "destroyed";
  }

  /** Why the host will not start `argv` under `policy`, or undefined when it may. */
  private disallowed(policy: MxcPolicy, argv: string[]): string | undefined {
    const [cmd, ...args] = argv;
    if (!cmd) return "empty command";
    const { readOnly, readWrite } = policy.filesystem;
    const target = args[args.length - 1] ?? "";
    if (HELPERS.has(cmd)) return inside(target, [...readOnly, ...readWrite]) ? undefined : `${target} is outside this sandbox's paths`;
    if (cmd === "sh" && args.length === 4 && args[0] === "-c" && args[1] === WRITE_SCRIPT) return inside(target, readWrite) ? undefined : `${target} is outside this sandbox's write paths`;
    const allowed = policy.process.allowedCommands.filter((c) => c.command === cmd);
    if (!allowed.length) return `${cmd} is not an allowed command in this sandbox`;
    if (!allowed.some((c) => !c.argsPrefix || c.argsPrefix.some((p) => p.every((x, i) => args[i] === x)))) return `${argv.join(" ")} does not start with an allowed argument prefix`;
    return undefined;
  }
}

/** POSIX single-quoting: Bubblewrap runs the command line through `sh -c`. */
export function shellQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
}

function refused(stderr: string): ExecResult {
  return { stdout: "", stderr: `${stderr}\n`, exitCode: 126, timedOut: false };
}

async function collect(stream: NodeJS.ReadableStream | null, max: number): Promise<string> {
  if (!stream) return "";
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (size < max) chunks.push(b.subarray(0, max - size));
    size += b.length;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return size > max ? `${text}\n[… ${size - max} more bytes cut]` : text;
}
