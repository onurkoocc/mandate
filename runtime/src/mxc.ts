// The real sandbox host: MXC's SDK (`@microsoft/mxc-sdk/v1`) on Linux with
// the Bubblewrap backend (Doc 4 §11.3, §16.1; BACKLOG P1-8, K7, K16).
//
// - Probe: the SDK's platform check. A host where Bubblewrap cannot run (no
//   bwrap, user namespaces off) enforces nothing, so MxcAdapter refuses every
//   agent by name (G05). Windows backends are a later item (P2-27). A
//   Bubblewrap backend that does not report the capability to mask paths
//   (`filesystemDeniedPaths`) holds neither the path lists nor the network.
// - Create: records the policy; Bubblewrap needs no long-lived container.
// - Execute: one `bwrap` process per tool call, under the policy:
//     filesystem  the deny-by-default system baseline read-only, plus the
//                 policy's read-only and read-write paths and nothing else;
//                 the host's runtime directories (`/run`, `/var/run`) are
//                 masked in every sandbox, whatever else is visible
//     network     egress and ingress denied: `--unshare-net`, no network at all
//     timeout     the policy's, per process
//   The runtime directories hold the host's service sockets (the resolver,
//   the system bus, a container engine). A unix socket is a file, not a
//   network route, so the network policy does not reach it: a sandbox that
//   could open one could ask that service to act for it, e.g. resolve a name
//   upstream. So no sandbox sees them. A policy path at or under one is
//   refused by name (the probe reports them as `hidden`), never dropped; a
//   granted path that resolves into one through a symlink is refused before
//   a process starts. A backend that cannot mask paths enforces nothing.
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
import { realpathSync } from "node:fs";
import { hiddenUnder, makeWritable, type Enforceable, type ExecRequest, type ExecResult, type MxcPolicy, type SandboxHost } from "./sandbox.js";
import { inside, WRITE_SCRIPT } from "./tools.js";

/** The part of `@microsoft/mxc-sdk/v1` the host uses; tests pass a fake. */
export interface MxcSdk {
  getPlatformSupport(): { isSupported: boolean; reason?: string; availableMethods: string[]; unavailableReasons?: Record<string, string> };
  /** The native backends and their optional capabilities. An SDK without it cannot say that it masks paths. */
  getAvailableBackends?(): Array<{ backend: string; capabilities: string[]; warnings?: string[] }>;
  spawn(request: MxcContainerRequest): Promise<MxcSpawned>;
}

export interface MxcContainerRequest {
  command: string;
  /** `deniedPaths` are masked inside the sandbox, below any grant (MXC capability `filesystemDeniedPaths`). */
  filesystem: { readonlyPaths: string[]; readwritePaths: string[]; deniedPaths: string[] };
  network: { egress: { default: "deny" }; ingress: { default: "deny"; hostLoopback: "deny" } };
  containment: { type: "bubblewrap" };
  timeoutMs?: number;
  workingDirectory?: string;
  environment?: Record<string, string>;
}

export interface MxcSpawned {
  readonly standardInput: NodeJS.WritableStream | null;
  readonly standardOutput: NodeJS.ReadableStream | null;
  readonly standardError: NodeJS.ReadableStream | null;
  wait(): Promise<{ exitCode: number; timedOut: boolean }>;
  kill(): void;
  dispose(): void;
}

export interface MxcHostOptions {
  /** Default: `@microsoft/mxc-sdk/v1`, loaded on first use. */
  sdk?: MxcSdk;
  /** Extra read-only paths every sandbox sees, e.g. a toolchain under /usr/local or /opt. Shown in the policy. */
  baseline?: string[];
  /** Directories put before MXC's default PATH, e.g. a toolchain's bin under `baseline`. */
  path?: string[];
  /** Longest output kept per stream; the rest is cut. Default 1 MiB. */
  maxOutput?: number;
}

const MXC_SDK = "@microsoft/mxc-sdk/v1";

/** MXC's default PATH for a Bubblewrap process (schema 0.9). */
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

const NOTHING: Enforceable = { backends: [], modes: [], filesystem: false, network: "none", exec: "none", timeout: false, ui: false };

/**
 * The host's runtime directories, where its services keep their unix
 * sockets: masked in every sandbox, and no policy path may lie at or under
 * one. `/var/run` is a link to `/run` on current distributions; it is listed
 * so that a host where it is a directory of its own is covered too.
 */
export const HOST_RUNTIME_DIRS: readonly string[] = ["/run", "/var/run"];

/** Helpers the runtime's own tools start; the filesystem policy confines them. */
const HELPERS = new Set(["cat", "ls", "grep"]);

export class MxcHost implements SandboxHost {
  private sdk: MxcSdk | undefined;
  private readonly policies = new Map<string, MxcPolicy>();
  /** The processes running in each sandbox, so Stop can kill them. */
  private readonly running = new Map<string, Set<MxcSpawned>>();
  private readonly stopped = new Set<string>();
  /** Why the last probe found nothing enforceable, for the operator. */
  unavailable: string | undefined;
  /** Why the backend cannot mask paths (null: it can), asked once. */
  private masking: string | null | undefined;

  constructor(private readonly o: MxcHostOptions = {}) {
    this.sdk = o.sdk;
  }

  private async load(): Promise<MxcSdk | undefined> {
    if (this.sdk) return this.sdk;
    try {
      // An optional dependency (Node 24 and later): resolved at run time, typed by MxcSdk above.
      const specifier: string = MXC_SDK;
      this.sdk = (await import(specifier)) as MxcSdk;
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
    const enforcing: Enforceable = { backends: ["process"], modes: ["enforcement"], filesystem: true, network: "deny_all", exec: "args_prefix", timeout: true, ui: true, hidden: [...HOST_RUNTIME_DIRS] };
    // Without masking, a sandbox would see the host's service sockets: neither its path lists nor its network could be held.
    this.masking ??= cannotMask(sdk) ?? null;
    const shown = (this.o.baseline ?? []).find((b) => exposedBy(b));
    const why = this.masking ?? (shown && `the baseline path ${shown} leads to ${exposedBy(shown)}, which no sandbox may see`);
    if (why) {
      this.unavailable = why;
      return { ...enforcing, filesystem: false, network: "none" };
    }
    this.unavailable = undefined;
    return enforcing;
  }

  async create(policy: MxcPolicy): Promise<string> {
    // MxcAdapter only plans what the probe said it can enforce; a policy that asks for more is a bug, not a fallback.
    if (policy.network.allowOutbound || policy.network.allowedHosts.length) throw new Error("MxcHost: Bubblewrap here enforces no outbound network at all; this policy allows some.");
    if (policy.mode !== "enforcement") throw new Error(`MxcHost: Bubblewrap has no ${policy.mode} mode.`);
    for (const p of [...policy.filesystem.readOnly, ...policy.filesystem.readWrite]) {
      const root = hiddenUnder(p, HOST_RUNTIME_DIRS);
      if (root) throw new Error(`MxcHost: ${p} is under ${root}, which no sandbox sees; this policy grants it.`);
    }
    makeWritable(policy);
    const handle = `mxc-${randomUUID()}`;
    this.policies.set(handle, policy);
    return handle;
  }

  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    const policy = this.policies.get(handle);
    if (!policy) return refused(`no sandbox ${handle}`);
    if (this.stopped.has(handle)) return refused(`sandbox ${handle} was stopped`);
    const why = disallowed(policy, req.argv);
    if (why) return refused(why);
    const sdk = await this.load();
    if (!sdk) return refused(this.unavailable ?? "MXC is not available");
    const readonlyPaths = [...(this.o.baseline ?? []), ...policy.filesystem.readOnly];
    const readwritePaths = [...policy.filesystem.readWrite];
    // A granted path checked by name at planning can still lead into a runtime directory through a link.
    for (const p of [...readonlyPaths, ...readwritePaths]) {
      const root = exposedBy(p);
      if (root) return refused(`${p} leads to ${root}, which no sandbox sees`);
    }
    const timeoutMs = req.timeoutMs ?? (policy.timeoutSeconds !== null ? policy.timeoutSeconds * 1000 : undefined);
    const request: MxcContainerRequest = {
      command: req.argv.map(shellQuote).join(" "),
      filesystem: { readonlyPaths, readwritePaths, deniedPaths: [...HOST_RUNTIME_DIRS] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      containment: { type: "bubblewrap" },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(req.cwd ? { workingDirectory: req.cwd } : {}),
      // Only PATH: nothing of the runtime's own environment reaches the process.
      ...(this.o.path?.length ? { environment: { PATH: [...this.o.path, DEFAULT_PATH].join(":") } } : {}),
    };
    let proc: MxcSpawned;
    try {
      proc = await sdk.spawn(request);
    } catch (e) {
      return refused(`MXC refused to start the process: ${(e as Error).message}`);
    }
    const running = this.running.get(handle) ?? new Set<MxcSpawned>();
    this.running.set(handle, running.add(proc));
    try {
      const out = collect(proc.standardOutput, this.o.maxOutput ?? 1 << 20);
      const err = collect(proc.standardError, this.o.maxOutput ?? 1 << 20);
      proc.standardInput?.end(req.stdin ?? "");
      const [status, stdout, stderr] = await Promise.all([proc.wait(), out, err]);
      return { stdout, stderr, exitCode: status.exitCode, timedOut: status.timedOut, ...(this.stopped.has(handle) ? { stopped: true } : {}) };
    } finally {
      running.delete(proc);
      proc.dispose();
    }
  }

  /** Kills every process running in the sandbox (Bubblewrap's whole process tree goes with it) and starts no more. */
  async stop(handle: string): Promise<"stopped"> {
    this.stopped.add(handle);
    for (const proc of this.running.get(handle) ?? []) proc.kill();
    return "stopped";
  }

  async destroy(handle: string): Promise<"destroyed"> {
    await this.stop(handle);
    this.stopped.delete(handle);
    this.running.delete(handle);
    this.policies.delete(handle);
    return "destroyed";
  }

}

/**
 * Why a host will not start `argv` under `policy`, or undefined when it may.
 * A sandbox backend that cannot limit which programs run (Bubblewrap, an
 * AppContainer) enforces the command allow-list here, before any process
 * starts: a process is one of the runtime's own tool helpers (cat, ls, grep,
 * the write_file script) on a path inside the policy's paths, or an allowed
 * command whose arguments start with an allowed prefix.
 */
export function disallowed(policy: MxcPolicy, argv: string[]): string | undefined {
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

/** Why this SDK cannot be shown to mask paths in a Bubblewrap sandbox, or undefined when it can. */
function cannotMask(sdk: MxcSdk): string | undefined {
  const no = "so a sandbox would see the host's runtime directories and the service sockets in them";
  if (!sdk.getAvailableBackends) return `this MXC SDK does not report what its backends can enforce, ${no}`;
  let bwrap: ReturnType<NonNullable<MxcSdk["getAvailableBackends"]>>[number] | undefined;
  try {
    bwrap = sdk.getAvailableBackends().find((b) => b.backend === "bubblewrap");
  } catch (e) {
    return `MXC's backend discovery failed (${(e as Error).message}), ${no}`;
  }
  if (bwrap?.capabilities.includes("filesystemDeniedPaths")) return undefined;
  const warnings = bwrap?.warnings?.length ? ` (${bwrap.warnings.join("; ")})` : "";
  return `Bubblewrap here cannot mask paths${warnings}, ${no}`;
}

/**
 * The runtime directory a granted path would show, or undefined: the path is
 * one or lies under one, by its name or by where its links lead; or it is
 * another name for a directory that holds one, where the mask (which covers
 * the runtime directory's own path) does not reach.
 */
export function exposedBy(p: string): string | undefined {
  const named = hiddenUnder(p, HOST_RUNTIME_DIRS);
  if (named) return named;
  const real = realpath(p);
  if (real === undefined) return undefined;
  for (const dir of HOST_RUNTIME_DIRS) {
    const realDir = realpath(dir);
    if (realDir === undefined) continue;
    if (inside(real, [realDir]) || (real !== p && inside(realDir, [real]))) return dir;
  }
  return undefined;
}

function realpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
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
