// The real sandbox host: MXC's SDK (`@microsoft/mxc-sdk/v1`) on Linux with
// the Bubblewrap backend (Doc 4 §11.3, §16.1; BACKLOG P1-8, K7, K16).
//
// - Probe: the SDK's platform check. A host where Bubblewrap cannot run (no
//   bwrap, user namespaces off) enforces nothing, so MxcAdapter refuses every
//   agent by name (G05). Windows backends are a later item (P2-27). Then one
//   sandbox with the masks below, to see that they hold: Bubblewrap does not
//   report the capability (`filesystemDeniedPaths`), so it is checked, once
//   per host. Where the runtime directories still show, the host holds
//   neither the path lists nor the network.
// - Create: records the policy; Bubblewrap needs no long-lived container.
// - Execute: one `bwrap` process per tool call, under the policy:
//     filesystem  the deny-by-default system baseline read-only, plus the
//                 policy's read-only and read-write paths and nothing else;
//                 the host's runtime directories (`/run`, `/var/run`) are
//                 masked in every sandbox, whatever else is visible
//     network     egress and ingress denied: `--unshare-net`, no network at all,
//                 or with an egress session, one way out: the session's proxy
//     timeout     the policy's, per process
//   The runtime directories hold the host's service sockets (the resolver,
//   the system bus, a container engine). A unix socket is a file, not a
//   network route, so the network policy does not reach it: a sandbox that
//   could open one could ask that service to act for it, e.g. resolve a name
//   upstream. So no sandbox sees them: MXC mounts an empty directory over
//   each (`deniedPaths`), which also covers what the baseline shows there (the
//   resolver's directory, for /etc/resolv.conf). A path granted under a mask
//   would be mounted over it, so a policy path at or under one is refused by
//   name (the probe reports them as `hidden`), never dropped; a granted path
//   that leads into one through a link is refused before a process starts.
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
//
// Egress (spec/boundary.md "Sandbox egress"). With an egress proxy, a sandbox
// whose policy lists hosts reaches them, and only them, through a forward
// session of its own at the proxy:
// - Probe: the host reports `host_allow_list` only when the SDK says it can
//   hold a Bubblewrap sandbox to its proxy (`bubblewrapNetwork.proxyEnforcement`
//   is `supported`: a private network namespace whose one way out is the proxy
//   port) and the proxy answers `hello`, asked at every probe; it reports the
//   credentials the proxy holds. Otherwise it reports `deny_all`, and a
//   requirement with a host is refused by name, as before.
// - Create: opens the session for exactly the policy's hosts, their methods and
//   their credentials, for the run, tenant and command the sandbox is for.
// - Execute: the process's request names the session's address
//   (`network.runtimeConfig.networkProxy`), and its environment holds the
//   session's placeholders, never a secret. Inside the sandbox the SDK sets the
//   proxy variables, to the address the sandbox sees the proxy at. After the
//   process, what the proxy denied it is read into its result. A session near
//   its end is replaced before a process that could outlive it.
// - Destroy: closes the session.

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { validHost } from "./egress/config.js";
import { EgressError, type Destination } from "./egress/proxy.js";
import type { EgressLink, ForwardSession } from "./gateway.js";
import { EGRESS_DENIALS_KEPT, hiddenUnder, makeWritable, placeholderVariable, SandboxRefused, type EgressDenial, type Enforceable, type ExecRequest, type ExecResult, type MxcPolicy, type SandboxHost, type SandboxOwner } from "./sandbox.js";
import { Violation } from "./signals.js";
import { inside, WRITE_SCRIPT } from "./tools.js";

/** The part of `@microsoft/mxc-sdk/v1` the host uses; tests pass a fake. */
export interface MxcSdk {
  getPlatformSupport(): {
    isSupported: boolean;
    reason?: string;
    availableMethods: string[];
    unavailableReasons?: Record<string, string>;
    /** Whether a Bubblewrap sandbox can be held to its proxy alone on this host, and why not. Absent where Bubblewrap is not available. */
    bubblewrapNetwork?: { proxyEnforcement: string; warnings: string[] };
  };
  spawn(request: MxcContainerRequest): Promise<MxcSpawned>;
}

export interface MxcContainerRequest {
  command: string;
  /** Each of `deniedPaths` is an empty directory inside the sandbox; a grant under one is mounted over it. */
  filesystem: { readonlyPaths: string[]; readwritePaths: string[]; deniedPaths: string[] };
  /**
   * Egress and ingress denied. With `runtimeConfig.networkProxy`, the sandbox has a network of its own whose one way
   * out is that proxy, on the host's loopback.
   */
  network: { egress: { default: "deny" }; ingress: { default: "deny"; hostLoopback: "deny" }; runtimeConfig?: { networkProxy: string } };
  containment: { type: "bubblewrap" };
  timeoutMs?: number;
  workingDirectory?: string;
  environment?: Record<string, string>;
  /** `environment` is laid over the backend's default environment rather than replacing it. */
  inheritDefaultEnvironment?: boolean;
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
  /**
   * The egress proxy (spec/boundary.md "Sandbox egress"). With it, a sandbox whose policy lists hosts reaches them
   * through a forward session of its own; without it, no sandbox reaches any host.
   */
  egress?: EgressLink;
  /** How long a sandbox's session is asked to live: `SANDBOX_SESSION_TTL_MS` unless a test says otherwise. */
  sessionTtlMs?: number;
}

const MXC_SDK = "@microsoft/mxc-sdk/v1";

/**
 * How long a sandbox's egress session is opened for, and how much longer than a process's timeout it must have left
 * when the process starts: a session with less is replaced first. A process without a timeout needs half its life.
 */
export const SANDBOX_SESSION_TTL_MS = 6 * 3_600_000;
export const SANDBOX_SESSION_MARGIN_MS = 60_000;
/** The longest a session may be asked to live (spec/egress.md `ttl_ms`). */
const MAX_TTL_MS = 2_147_483_647;
/** Denials read from the proxy per request: its own limit is 1000. */
const DENIALS_PAGE = 1000;

/** A sandbox's session, as the host holds it. */
interface Egress extends ForwardSession {
  owner: SandboxOwner;
  destinations: Destination[];
  /** The placeholders, by the variable a process finds each in. */
  env: Record<string, string>;
  /** The last denial read, and the proxy's count of denials it did not keep, as last read. */
  after: number;
  dropped: number;
  /** Processes running on it; a session replaced is closed when none is. */
  inflight: number;
  retired: boolean;
}

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

/**
 * A shell line that lists `dirs`: one line per entry in each (dot entries
 * too, and links whose target is missing), one line for each that is not a
 * directory this shell can read and search, then `end`. It runs no program,
 * only the shell's own `for`, `if`, `[` and `echo`, so it cannot fail to
 * look because a program is missing; and a directory it cannot list is a
 * line of its own, never silence. Where the masks hold, each runtime
 * directory is an empty directory MXC made, and the output is `end` alone.
 */
export function maskCheck(dirs: readonly string[]): string {
  const list = `for e in "$d"/* "$d"/.[!.]* "$d"/..?*; do if [ -e "$e" ] || [ -L "$e" ]; then echo "$e"; fi; done`;
  return `for d in ${dirs.map(shellQuote).join(" ")}; do if [ -d "$d" ] && [ -r "$d" ] && [ -x "$d" ]; then ${list}; else echo "$d is not a directory this sandbox can list"; fi; done; echo end`;
}

/** Run by the probe in a sandbox with the masks: `maskCheck` of the runtime directories. */
export const MASK_CHECK = maskCheck(HOST_RUNTIME_DIRS);

/** Helpers the runtime's own tools start; the filesystem policy confines them. */
const HELPERS = new Set(["cat", "ls", "grep"]);

export class MxcHost implements SandboxHost {
  private sdk: MxcSdk | undefined;
  private readonly policies = new Map<string, MxcPolicy>();
  /** The processes running in each sandbox, so Stop can kill them. */
  private readonly running = new Map<string, Set<MxcSpawned>>();
  private readonly stopped = new Set<string>();
  /** Each sandbox's egress session, for a sandbox whose policy lists hosts. */
  private readonly sessions = new Map<string, Egress>();
  /** Why the last probe found nothing enforceable, for the operator. */
  unavailable: string | undefined;
  /** Why the last probe found that sandboxes cannot reach hosts through the egress proxy (undefined: they can), for the operator. */
  egressUnavailable: string | undefined;
  /** Whether the last probe reported that sandboxes reach hosts through the egress proxy. */
  private reaching = false;
  /** Why the masks do not hold on this host (undefined: they do), checked once. */
  private masking: Promise<string | undefined> | undefined;

  constructor(readonly o: MxcHostOptions = {}) {
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
    if (!sdk) return this.reached(NOTHING);
    const p = sdk.getPlatformSupport();
    if (!p.isSupported || !p.availableMethods.includes("bubblewrap")) {
      this.unavailable = p.unavailableReasons?.["bubblewrap"] ?? p.reason ?? `bubblewrap is not among ${p.availableMethods.join(", ") || "no backends"}`;
      return this.reached(NOTHING);
    }
    // A Bubblewrap sandbox is a set of namespaces on the host's own kernel, beside whatever else runs on it: `process`, shared.
    const enforcing: Enforceable = { backends: ["process"], modes: ["enforcement"], filesystem: true, network: "deny_all", exec: "args_prefix", timeout: true, ui: true, hidden: [...HOST_RUNTIME_DIRS], level: "process", co_tenancy: "shared" };
    // Without the masks, a sandbox would see the host's service sockets: neither its path lists nor its network would hold.
    const shown = (this.o.baseline ?? []).find((b) => exposedBy(b));
    const why = shown ? `the baseline path ${shown} leads to ${exposedBy(shown)}, which no sandbox may see` : await (this.masking ??= this.checkMasks(sdk));
    if (why) {
      this.unavailable = why;
      return this.reached({ ...enforcing, filesystem: false, network: "none" });
    }
    this.unavailable = undefined;
    const held = await this.reach(p.bubblewrapNetwork);
    return this.reached(held ? { ...enforcing, network: "host_allow_list", egress: { credentials: held } } : enforcing);
  }

  /** What a probe reports, remembered for `create`: a sandbox reaches hosts only where the last probe said it could. */
  private reached(can: Enforceable): Enforceable {
    this.reaching = can.egress !== undefined;
    return can;
  }

  /**
   * Whether this host's sandboxes can reach hosts through the egress proxy now, and the credentials it holds: only
   * when the SDK says it can hold a Bubblewrap sandbox to its proxy, and the proxy answers `hello`. Asked at every
   * probe, since either can change while the runtime runs. Why not, in `egressUnavailable`.
   */
  private async reach(net: ReturnType<MxcSdk["getPlatformSupport"]>["bubblewrapNetwork"]): Promise<string[] | undefined> {
    const link = this.o.egress;
    if (!link) {
      this.egressUnavailable = "the runtime's configuration names no egress proxy (egress.admin)";
      return undefined;
    }
    if (net?.proxyEnforcement !== "supported") {
      this.egressUnavailable = `MXC cannot hold a Bubblewrap sandbox to its proxy on this host: ${net ? `proxyEnforcement is ${net.proxyEnforcement}${net.warnings.length ? ` (${net.warnings.join("; ")})` : ""}` : "it does not report bubblewrapNetwork"}`;
      return undefined;
    }
    try {
      const held = await link.credentials();
      this.egressUnavailable = undefined;
      return held;
    } catch (e) {
      this.egressUnavailable = (e as Error).message;
      return undefined;
    }
  }

  async create(policy: MxcPolicy, owner?: SandboxOwner): Promise<string> {
    // MxcAdapter only plans what the probe said it can enforce; a policy that asks for more is a bug, not a fallback.
    const outbound = policy.network.allowOutbound || policy.network.allowedHosts.length > 0;
    // Where the last probe did not find the proxy, a host is refused by name, as the adapter refuses it.
    if (outbound && !(this.o.egress && this.reaching)) throw new SandboxRefused(["an outbound host allow-list"]);
    if (outbound && !owner) throw new Error("MxcHost: a sandbox that reaches hosts has an egress session for its run, and this one was created for none.");
    if (policy.mode !== "enforcement") throw new Error(`MxcHost: Bubblewrap has no ${policy.mode} mode.`);
    for (const p of [...policy.filesystem.readOnly, ...policy.filesystem.readWrite]) {
      const root = hiddenUnder(p, HOST_RUNTIME_DIRS);
      if (root) throw new Error(`MxcHost: ${p} is under ${root}, which no sandbox sees; this policy grants it.`);
    }
    makeWritable(policy);
    const handle = `mxc-${randomUUID()}`;
    // The session first: a sandbox whose session the proxy refuses is not created.
    if (outbound) this.sessions.set(handle, await this.open(policy, owner!, this.o.sessionTtlMs ?? SANDBOX_SESSION_TTL_MS));
    this.policies.set(handle, policy);
    return handle;
  }

  /**
   * Opens a sandbox's session: one destination per host of the policy, with its methods and its credential. A
   * credential the proxy does not hold for the host is refused by name (E0902); the proxy's configuration says which
   * secret may go where. A session the proxy listens for on another address than 127.0.0.1 is closed and refused by
   * name: a Bubblewrap sandbox is shown to reach its proxy on the host's 127.0.0.1 only.
   */
  private async open(policy: MxcPolicy, owner: SandboxOwner, ttlMs: number): Promise<Egress> {
    const link = this.o.egress!;
    const destinations: Destination[] = policy.network.allowedHosts.map((host) => {
      if (!validHost(host)) throw new Error(`MxcHost: ${host} is not a host name the egress proxy takes; this policy lists it.`);
      return { host, methods: own(policy.network.methods, host) ?? null, credential: own(policy.network.credentials, host) ?? null };
    });
    let s: ForwardSession;
    try {
      s = await link.openForward(owner, destinations, Math.min(ttlMs, MAX_TTL_MS));
    } catch (e) {
      const bound = destinations.filter((d): d is Destination & { credential: string } => d.credential !== null);
      if (!(e instanceof EgressError) || !bound.length) throw e;
      // The proxy names the credential, and for `credential_not_allowed` the host; each binding it names is refused.
      const named = bound.filter((d) => e.message.includes(d.credential) && (e.code === "unknown_credential" || e.message.includes(d.host)));
      throw new SandboxRefused((named.length ? named : bound).map((d) => `credential ${d.credential} for ${d.host}`));
    }
    const at = new URL(s.proxy_url).hostname;
    const env: Record<string, string> = {};
    for (const d of destinations) if (d.credential !== null) env[placeholderVariable(d.credential)] = s.placeholders[d.credential] ?? "";
    const missing = destinations.find((d) => d.credential !== null && !s.placeholders[d.credential]);
    if (at !== "127.0.0.1" || missing) {
      await link.close(s.session);
      if (missing) throw new Error(`MxcHost: the egress proxy gave no placeholder for ${missing.credential}`);
      throw new SandboxRefused([`an egress proxy whose sessions listen on ${at} (a Bubblewrap sandbox is shown to reach 127.0.0.1 only)`]);
    }
    return { ...s, owner, destinations, env, after: 0, dropped: 0, inflight: 0, retired: false };
  }

  /**
   * The session a process starts on: the sandbox's, while it has more left than the process could run and a margin;
   * else a new one for the same destinations, with new placeholders, and the old one is closed once nothing runs on
   * it. What the old one denied was read after each of its processes.
   */
  private async fresh(handle: string, policy: MxcPolicy, s: Egress, timeoutMs: number | undefined): Promise<Egress> {
    const link = this.o.egress!;
    const need = (timeoutMs ?? (this.o.sessionTtlMs ?? SANDBOX_SESSION_TTL_MS) / 2) + SANDBOX_SESSION_MARGIN_MS;
    if (s.expiresAt - link.now() >= need) return s;
    let next: Egress;
    try {
      next = await this.open(policy, s.owner, Math.max(this.o.sessionTtlMs ?? SANDBOX_SESSION_TTL_MS, need));
    } catch (e) {
      if (e instanceof SandboxRefused) throw new Violation("egress_unavailable", `the egress proxy would not renew sandbox session ${s.session}: ${e.message}`);
      throw e;
    }
    this.sessions.set(handle, next);
    s.retired = true;
    if (s.inflight === 0) await link.close(s.session);
    return next;
  }

  /**
   * What the proxy denied on a session since it was last asked: the first `EGRESS_DENIALS_KEPT`, and how many more,
   * those it did not keep included. A proxy that does not say stops the run (`egress_unavailable`): a denial is not
   * left uncounted.
   */
  private async denied(s: Egress): Promise<ExecResult["egress_denials"]> {
    const link = this.o.egress!;
    const kept: EgressDenial[] = [];
    let more = 0;
    let dropped = s.dropped;
    for (;;) {
      const page = await link.denials(s.session, s.after, DENIALS_PAGE);
      for (const d of page.denials) {
        if (kept.length < EGRESS_DENIALS_KEPT) kept.push({ id: d.id, host: d.host, method: d.method, why: d.why, path_digest: d.path_digest, at: d.at });
        else more++;
        s.after = Math.max(s.after, d.id);
      }
      dropped = page.dropped;
      if (page.denials.length < DENIALS_PAGE) break;
    }
    more += Math.max(0, dropped - s.dropped);
    s.dropped = dropped;
    return kept.length || more ? { denials: kept, more } : undefined;
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
    const held = this.sessions.get(handle);
    const egress = held ? await this.fresh(handle, policy, held, timeoutMs) : undefined;
    const request = this.request(req.argv.map(shellQuote).join(" "), readonlyPaths, readwritePaths, timeoutMs, req.cwd, egress);
    let proc: MxcSpawned;
    try {
      proc = await sdk.spawn(request);
    } catch (e) {
      return refused(`MXC refused to start the process: ${(e as Error).message}`);
    }
    const running = this.running.get(handle) ?? new Set<MxcSpawned>();
    this.running.set(handle, running.add(proc));
    if (egress) egress.inflight++;
    try {
      const r = await drain(proc, req.stdin ?? "", this.o.maxOutput ?? 1 << 20);
      // What the proxy denied the process is part of its result, read once it has ended and before anything else runs on the session.
      const denied = egress ? await this.denied(egress) : undefined;
      return { ...r, ...(this.stopped.has(handle) ? { stopped: true } : {}), ...(denied ? { egress_denials: denied } : {}) };
    } finally {
      running.delete(proc);
      proc.dispose();
      if (egress && --egress.inflight === 0 && egress.retired) await this.o.egress!.close(egress.session);
    }
  }

  /**
   * What MXC gets for one process: every request masks the host's runtime directories. With an egress session, the
   * request names the session's address, and the process's environment holds its placeholders, laid over the
   * backend's default one, where the SDK puts the proxy variables.
   */
  private request(command: string, readonlyPaths: string[], readwritePaths: string[], timeoutMs?: number, cwd?: string, egress?: Egress): MxcContainerRequest {
    // Only PATH, and the placeholders: nothing of the runtime's own environment reaches the process.
    const environment = { ...(this.o.path?.length ? { PATH: [...this.o.path, DEFAULT_PATH].join(":") } : {}), ...egress?.env };
    const given = Object.keys(environment).length > 0;
    return {
      command,
      filesystem: { readonlyPaths, readwritePaths, deniedPaths: [...HOST_RUNTIME_DIRS] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" }, ...(egress ? { runtimeConfig: { networkProxy: egress.proxy_url } } : {}) },
      containment: { type: "bubblewrap" },
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(cwd ? { workingDirectory: cwd } : {}),
      ...(given ? { environment } : {}),
      ...(given && egress ? { inheritDefaultEnvironment: true } : {}),
    };
  }

  /**
   * Starts one sandbox the way `execute` does, with nothing granted, and
   * lists what it sees in the runtime directories (`MASK_CHECK`): nothing
   * but `end`, where the masks hold. Anything else, an entry, a directory
   * it could not list, a missing `end`, a failed exit, means they are not
   * shown to hold. Why not, or undefined.
   */
  private async checkMasks(sdk: MxcSdk): Promise<string | undefined> {
    const no = "so a sandbox would see the host's runtime directories and the service sockets in them";
    let r: Omit<ExecResult, "stopped">;
    try {
      const proc = await sdk.spawn(this.request(MASK_CHECK, [...(this.o.baseline ?? [])], [], 30_000));
      try {
        r = await drain(proc, "", 1 << 16);
      } finally {
        proc.dispose();
      }
    } catch (e) {
      return `MXC could not start a sandbox that masks paths (${(e as Error).message}), ${no}`;
    }
    const seen = r.stdout.split("\n").filter((l) => l && l !== "end");
    if (r.exitCode === 0 && r.stdout.endsWith("end\n") && !seen.length) return undefined;
    const what = seen.length ? `a sandbox with the masks lists ${seen.join("; ")}` : `the check exited ${r.exitCode}${r.timedOut ? " (timed out)" : ""}: ${r.stderr.trim() || r.stdout.trim()}`;
    return `Bubblewrap here is not shown to mask the host's runtime directories (${what}), ${no}`;
  }

  /** Kills every process running in the sandbox (Bubblewrap's whole process tree goes with it) and starts no more. */
  async stop(handle: string): Promise<"stopped"> {
    this.stopped.add(handle);
    for (const proc of this.running.get(handle) ?? []) proc.kill();
    return "stopped";
  }

  /** Stops what runs in the sandbox, closes its egress session, and forgets it. */
  async destroy(handle: string): Promise<"destroyed"> {
    await this.stop(handle);
    const s = this.sessions.get(handle);
    this.sessions.delete(handle);
    if (s) await this.o.egress!.close(s.session);
    this.stopped.delete(handle);
    this.running.delete(handle);
    this.policies.delete(handle);
    return "destroyed";
  }
}

/** `o[k]` when `k` is a key of `o` itself. */
function own<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o !== undefined && Object.hasOwn(o, k) ? o[k] : undefined;
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

/** Feeds `stdin` to a started process and waits for it, with its output (each stream cut at `max`). */
async function drain(proc: MxcSpawned, stdin: string, max: number): Promise<Omit<ExecResult, "stopped">> {
  const out = collect(proc.standardOutput, max);
  const err = collect(proc.standardError, max);
  proc.standardInput?.end(stdin);
  const [status, stdout, stderr] = await Promise.all([proc.wait(), out, err]);
  return { stdout, stderr, exitCode: status.exitCode, timedOut: status.timedOut };
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
