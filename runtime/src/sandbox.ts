// Sandboxes for agents (Doc 4 §7.3, §11.3, §16.1). The compiler states what
// an agent's sandbox must enforce (a SandboxRequirement); a pinned, versioned
// adapter turns it into one platform's policy. Before it does, it probes the
// host for what the host can really enforce. A requirement the host cannot
// enforce refuses the agent's start with `unsupported_sandbox_profile`
// (MDT-E0902). It never runs the agent with less isolation, and never falls
// back to a permissive mode (INV-11, G05).
//
// The MXC policy below follows the representative fields of §11.3. Mapping
// them to a real MXC schema version is the host's job (`SandboxHost`).

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ISOLATION_LEVELS, type IsolationLevel, type SandboxRequirement } from "@mandate/compiler";
import type { AgentAdapter, DelegateRequest, Outcome } from "./adapters.js";
import { CREDENTIAL_NAME, validHost } from "./egress/config.js";
import { inside } from "./tools.js";

export type SandboxMode = "enforcement" | "learning" | "permissive";

/** What the host can enforce, as `Probe` reports it (§16.1). */
export interface Enforceable {
  /** Isolation backends available on this host, e.g. `process`, `session`. They are not equivalent guarantees. */
  backends: string[];
  modes: SandboxMode[];
  /** Read-only and read-write path lists; everything else denied. */
  filesystem: boolean;
  /** `deny_all` blocks every outbound connection; `host_allow_list` also allows listed hosts. */
  network: "none" | "deny_all" | "host_allow_list";
  /** `command_allow_list` limits which executables start; `args_prefix` also limits their arguments. */
  exec: "none" | "command_allow_list" | "args_prefix";
  timeout: boolean;
  /** Desktop and clipboard access can be turned off. */
  ui: boolean;
  /**
   * Host paths no sandbox sees, whatever its policy grants: the host's
   * runtime directories, where its services keep their sockets. A policy
   * path at or under one is refused by name, not dropped.
   */
  hidden?: string[];
  /**
   * The isolation level a sandbox of this host gives (spec/boundary.md "Isolation level and host fitness"),
   * `process` when the host does not say. A host reports what it gives, never more.
   */
  level?: IsolationLevel;
  /**
   * Whether a sandbox of this host may share the machine with other tenants' work, `shared` when the host does not
   * say. Only a host that can promise that nothing else runs beside a sandbox reports `exclusive`.
   */
  co_tenancy?: "shared" | "exclusive";
  /**
   * Set when the host's sandboxes reach their hosts through an egress proxy (spec/boundary.md "Sandbox egress"),
   * which holds each request to its host's methods and puts a credential in by its name: the names of the credentials
   * the proxy holds. A host without it enforces no method limit and puts in no credential.
   */
  egress?: { credentials: string[] };
}

/** Whose a sandbox is: the run, its tenant and the command it runs for. Its egress session is opened for them, so revoking the run or the tenant cuts it. */
export interface SandboxOwner {
  run: string;
  tenant: string;
  command: string;
}

/** One request the egress proxy denied a sandbox, as the proxy reports it (spec/egress.md "Denials"). */
export interface EgressDenial {
  id: number;
  host: string | null;
  method: string | null;
  why: string;
  path_digest: string | null;
  at: string;
}

/** One process run inside a sandbox (§16.1 `Execute`): an argument vector, never a shell line. */
export interface ExecRequest {
  argv: string[];
  stdin?: string;
  cwd?: string;
  timeoutMs?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  /** The sandbox was stopped while the process ran (§16.1 Stop). */
  stopped?: boolean;
  /**
   * What the egress proxy denied the sandbox while the process ran (spec/boundary.md "Sandbox egress"): the first
   * `EGRESS_DENIALS_KEPT` denials, oldest first, and how many more there were. Absent when it denied nothing.
   */
  egress_denials?: { denials: EgressDenial[]; more: number };
}

/** The most denials one process's result lists; the rest are counted. */
export const EGRESS_DENIALS_KEPT = 100;

/**
 * Why the egress proxy denied a request, when the reason is that its session ended (revoked by a cancel or a halt, or
 * expired), not that the request reached outside the grant. Such a denial is recorded with the process's result and
 * is not a violation.
 */
export const SESSION_ENDED: ReadonlySet<string> = new Set(["session_revoked", "session_expired"]);

/** The platform side of the adapter contract: MXC's SDK, or a simulation in tests. */
export interface SandboxHost {
  probe(): Promise<Enforceable>;
  /**
   * Creates a sandbox for `policy`. `owner` says whose it is; a host whose sandboxes reach hosts through an egress
   * proxy opens the sandbox's session for it. A host that will not create it for a reason it names throws
   * `SandboxRefused`.
   */
  create(policy: MxcPolicy, owner?: SandboxOwner): Promise<string>;
  /** Runs one process under the sandbox's policy. What the policy denies fails inside the process. */
  execute(handle: string, req: ExecRequest): Promise<ExecResult>;
  /**
   * What the sandbox recorded (§16.1 `Collect`): in learning mode, the
   * accesses its policy denied, for the compiler's W0311. Optional; a host
   * without learning mode records nothing.
   */
  collect?(handle: string): Promise<{ denials: SandboxDenial[] }>;
  /**
   * Stops every process running in the sandbox, and starts no more (§16.1
   * `Stop`): when its run is cancelled, a long test run does not go on to
   * its own timeout. `stopped`: nothing runs in it any more. `uncertain`:
   * the host cannot kill what runs; it still ends at its timeout. Optional;
   * a host without Stop leaves running processes to their timeout.
   */
  stop?(handle: string): Promise<"stopped" | "uncertain">;
  destroy(handle: string): Promise<"destroyed" | "retained_for_investigation">;
}

/** One access a sandbox's policy denied, recorded in learning mode. */
export interface SandboxDenial {
  resource: string;
  /** e.g. `read`, `write`, `execute`. */
  access: string;
  /** e.g. `file`, `other`. */
  kind: string;
}

/** A sandbox policy in the representative MXC shape of §11.3. */
export interface MxcPolicy {
  $generator: string;
  $source: string;
  version: string;
  isolation: string;
  filesystem: { readOnly: string[]; readWrite: string[] };
  /**
   * Through an egress proxy (`Enforceable.egress`), `methods` lists each host that only some methods are allowed for,
   * and `credentials` the credential each host's requests carry, by name. Either is present only when it is not empty,
   * so a policy that limits no method and carries no credential is the policy of a 0.1 requirement.
   */
  network: { allowOutbound: boolean; allowedHosts: string[]; methods?: Record<string, string[]>; credentials?: Record<string, string> };
  process: { allowedCommands: Array<{ command: string; argsPrefix?: string[][] }> };
  ui: { allowDesktop: false; allowClipboard: false };
  timeoutSeconds: number | null;
  mode: Exclude<SandboxMode, "permissive">;
}

export interface MxcOptions {
  host: SandboxHost;
  /** The MXC schema version the host is pinned to. */
  schemaVersion: string;
  /**
   * Model tier → the hosts its endpoint needs. A tier without an entry cannot
   * be sandboxed. Unused with `modelsInControlPlane`.
   */
  modelEndpoints: Record<string, string[]>;
  /**
   * The agent's model calls are made by the runtime, outside the sandbox
   * (BACKLOG K7), so a model capability needs no network from the sandbox.
   */
  modelsInControlPlane?: boolean;
  /** Default `process`. A host without it is refused; another backend is never chosen silently. */
  isolation?: string;
  /** Default `enforcement`. `learning` also blocks and reports what it blocked (W0311). Never `permissive`. */
  mode?: Exclude<SandboxMode, "permissive">;
  /** Used when the requirement has no timeout of its own. */
  defaultTimeoutMs?: number;
}

export type Planned = { policy: MxcPolicy } | { unsupported: string[] };

export class MxcAdapter {
  static readonly ID = "mandate-mxc@0.1";

  constructor(readonly o: MxcOptions) {}

  /** Probes the host, then translates the requirement, or lists what the host cannot enforce. */
  async plan(req: SandboxRequirement): Promise<Planned> {
    const can = await this.o.host.probe();
    const isolation = this.o.isolation ?? "process";
    const mode = this.o.mode ?? "enforcement";
    const timeoutMs = req.limits.timeout_ms ?? this.o.defaultTimeoutMs ?? null;
    const unsupported: string[] = [];
    const modelHosts: string[] = [];
    for (const m of this.o.modelsInControlPlane ? [] : req.models) {
      const hosts = m.tier === null ? undefined : this.o.modelEndpoints[m.tier];
      if (!hosts) unsupported.push(`no endpoint is configured for model tier ${m.tier ?? "(none)"}`);
      else modelHosts.push(...hosts);
    }
    const hosts = [...new Set([...req.network.hosts, ...modelHosts])].sort();
    for (const u of req.unbounded) unsupported.push(`capability without a static scope: ${u}`);
    for (const p of [...req.filesystem.read, ...req.filesystem.write]) {
      const root = hiddenUnder(p, can.hidden ?? []);
      if (root) unsupported.push(`a path under ${root}, which this host keeps out of every sandbox: ${p}`);
    }
    if (!can.backends.includes(isolation)) unsupported.push(`isolation backend ${isolation}`);
    if ((mode as SandboxMode) === "permissive" || !can.modes.includes(mode)) unsupported.push(`mode ${mode}`);
    if (!can.filesystem) unsupported.push("filesystem path lists");
    if (can.network === "none") unsupported.push("blocking outbound network");
    else if (hosts.length && can.network !== "host_allow_list") unsupported.push("an outbound host allow-list");
    // Through an egress proxy, each host is one destination of the sandbox's session, by its name in lower case.
    const egress = can.egress && can.network === "host_allow_list" ? can.egress : undefined;
    const reached = egress ? destinations(req, hosts) : undefined;
    if (reached) unsupported.push(...reached.unsupported);
    if (can.exec === "none") unsupported.push("a command allow-list");
    else if (req.exec.some((x) => x.args_prefix) && can.exec !== "args_prefix") unsupported.push("argument-prefix limits on commands");
    if (timeoutMs !== null && !can.timeout) unsupported.push("a timeout");
    if (!can.ui) unsupported.push("turning off desktop and clipboard access");
    // What a 0.2 requirement asks beyond 0.1 (spec/boundary.md). Method limits and credentials are enforced only by a
    // host that reaches its hosts through an egress proxy, and a credential only when that proxy holds it: elsewhere
    // they are refused by name, never dropped. The isolation level and sharing are held against what the host
    // reports: a level below `min`, or a host that may share where sharing is forbidden, is refused by name, and a
    // weaker level is never chosen silently. A 0.1 requirement has none of these fields.
    const limited = Object.keys(req.network.methods ?? {});
    if (limited.length && !egress) unsupported.push(`method limits on outbound hosts: ${limited.join(", ")}`);
    if (req.isolation) {
      const level = can.level ?? "process";
      const need = rank(req.isolation.min);
      if (need < 0 || rank(level) < need) unsupported.push(`isolation ${req.isolation.min} (this host gives ${level})`);
      if (req.isolation.co_tenancy === "forbidden" && (can.co_tenancy ?? "shared") !== "exclusive") unsupported.push("co_tenancy forbidden (this host may share)");
    }
    const bound = Object.entries(req.egress?.credentials ?? {});
    if (bound.length && !egress) unsupported.push(`credentials for outbound hosts: ${bound.map(([h]) => h).join(", ")}`);
    if (egress) {
      // The proxy's configuration is the root of the secrets: a binding to a credential it does not hold is refused,
      // and so is one whose name is not a name a lock may bind, which no conforming proxy holds and no variable carries.
      for (const [h, name] of bound) if (!CREDENTIAL_NAME.test(name) || !egress.credentials.includes(name)) unsupported.push(`credential ${name} for ${h}`);
      unsupported.push(...sharedVariables(bound.map(([, name]) => name)));
    }
    if (unsupported.length) return { unsupported };
    return {
      policy: {
        $generator: `${MxcAdapter.ID} (MXC SDK v1)`,
        $source: `${req.subject.agent}@${req.subject.def}`,
        version: this.o.schemaVersion,
        isolation,
        filesystem: { readOnly: req.filesystem.read, readWrite: req.filesystem.write },
        network: reached ? reached.network : { allowOutbound: hosts.length > 0, allowedHosts: hosts },
        process: { allowedCommands: req.exec.map((x) => (x.args_prefix ? { command: x.command, argsPrefix: x.args_prefix } : { command: x.command })) },
        ui: { allowDesktop: false, allowClipboard: false },
        timeoutSeconds: timeoutMs === null ? null : Math.ceil(timeoutMs / 1000),
        mode,
      },
    };
  }
}

/**
 * The policy's network for a sandbox that reaches `hosts` through an egress proxy, and what keeps it from being one.
 * The proxy takes a host name in lower case without a port (spec/egress.md "Host names"), so each host is read in
 * lower case, and one that is not a host name or an IP address then is refused by name. Hosts that are one name in
 * lower case are one destination: the union of their methods, any method once one of them allows any, and their
 * credential, which two different ones cannot share.
 */
function destinations(req: SandboxRequirement, hosts: string[]): { network: MxcPolicy["network"]; unsupported: string[] } {
  const unsupported: string[] = [];
  const dest = new Map<string, { methods: Set<string> | null; credential: string | undefined }>();
  for (const h of hosts) {
    const name = h.toLowerCase();
    if (!validHost(name)) {
      unsupported.push(`an outbound host that is not a host name the egress proxy takes: ${h}`);
      continue;
    }
    const methods = own(req.network.methods, h);
    const credential = own(req.egress?.credentials, h);
    const prev = dest.get(name);
    if (prev?.credential !== undefined && credential !== undefined && prev.credential !== credential) unsupported.push(`credentials ${prev.credential} and ${credential} for one host: ${name}`);
    const merged = !prev ? (methods ? new Set(methods) : null) : prev.methods === null || !methods ? null : new Set([...prev.methods, ...methods]);
    dest.set(name, { methods: merged, credential: prev?.credential ?? credential });
  }
  const allowedHosts = [...dest.keys()].sort();
  const methods: Record<string, string[]> = {};
  const credentials: Record<string, string> = {};
  for (const h of allowedHosts) {
    const d = dest.get(h)!;
    if (d.methods) methods[h] = [...d.methods].sort();
    if (d.credential !== undefined) credentials[h] = d.credential;
  }
  return {
    network: { allowOutbound: allowedHosts.length > 0, allowedHosts, ...(Object.keys(methods).length ? { methods } : {}), ...(Object.keys(credentials).length ? { credentials } : {}) },
    unsupported,
  };
}

/**
 * The environment variable a sandbox's process finds a credential's placeholder in: `MANDATE_EGRESS_PLACEHOLDER_`
 * and the credential's name in upper case, with `-` as `_` (spec/boundary.md "Sandbox egress").
 */
export function placeholderVariable(credential: string): string {
  return `MANDATE_EGRESS_PLACEHOLDER_${credential.toUpperCase().replaceAll("-", "_")}`;
}

/** Two credentials of one sandbox whose placeholders would be in one variable, refused by name: one would hide the other. */
function sharedVariables(names: string[]): string[] {
  const by = new Map<string, Set<string>>();
  for (const n of names) by.set(placeholderVariable(n), (by.get(placeholderVariable(n)) ?? new Set()).add(n));
  return [...by].filter(([, ns]) => ns.size > 1).map(([v, ns]) => `credentials ${[...ns].sort().join(" and ")} for one sandbox, whose placeholders would both be ${v}`);
}

/** `o[k]` when `k` is a key of `o` itself: a host may be named `constructor`. */
function own<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o !== undefined && Object.hasOwn(o, k) ? o[k] : undefined;
}

/** A sandbox a host would not create, and why: what it cannot enforce, as `unsupported_sandbox_profile` lists it (E0902). */
export class SandboxRefused extends Error {
  constructor(readonly unsupported: string[]) {
    super(`the sandbox cannot be enforced: ${unsupported.join("; ")}`);
  }
}

/** A level's place, weakest first; -1 for a name this runtime does not know, which no host gives and no floor is. */
function rank(level: string): number {
  return ISOLATION_LEVELS.indexOf(level as IsolationLevel);
}

/** The first of `hidden` that `p` is or lies under, compared by path segment. */
export function hiddenUnder(p: string, hidden: readonly string[]): string | undefined {
  return hidden.find((h) => inside(p, [h]));
}

/**
 * A writable path the policy grants that does not exist yet (a component's
 * `test` directory before its first test) is created before the sandbox
 * starts, when its parent exists: it lies inside the grant, so creating it
 * adds no authority. A host
 * cannot bind a path that is not there, and would otherwise refuse every
 * command. Real hosts call this; simulated ones touch no disk.
 */
export function makeWritable(policy: MxcPolicy): void {
  // Only beside what exists (a component's `test` next to its `src`): a path whose parent is missing is not made up.
  for (const p of policy.filesystem.readWrite) if (!existsSync(p) && existsSync(dirname(p))) mkdirSync(p);
}

/** A sandbox the agent runs in. */
export interface Sandbox {
  handle: string;
  policy: MxcPolicy;
}

/**
 * Runs each local agent inside a sandbox built from its delegation's
 * requirement: plan, create, run, destroy. When the host cannot enforce the
 * requirement, the agent is never started and the delegate fails with
 * `PolicyDenied(unsupported_sandbox_profile)`, a fault the workflow can
 * handle or escalate; nothing is spent. A delegate without a requirement (a
 * remote agent) is passed through.
 */
export class SandboxedAgents implements AgentAdapter {
  /** Every sandbox created, in order; `destroyed` is false while it runs, or if the host kept it for investigation. */
  readonly sandboxes: Array<{ commandId: string; agent: string; policy: MxcPolicy; destroyed: boolean }> = [];

  constructor(
    private readonly adapter: MxcAdapter,
    private readonly inner: (req: DelegateRequest, sandbox: Sandbox | undefined) => Promise<Outcome>,
  ) {}

  async run(req: DelegateRequest): Promise<Outcome> {
    if (!req.sandbox) return this.inner(req, undefined);
    const planned = await this.adapter.plan(req.sandbox);
    const refused = (unsupported: string[]): Outcome => ({
      error: { tag: "PolicyDenied", args: [{ reason: "unsupported_sandbox_profile", code: "MDT-E0902", agent: req.agent, adapter: MxcAdapter.ID, unsupported }] },
      cost: {},
    });
    if ("unsupported" in planned) return refused(planned.unsupported);
    const host = this.adapter.o.host;
    let handle: string;
    try {
      handle = await host.create(planned.policy);
    } catch (e) {
      if (e instanceof SandboxRefused) return refused(e.unsupported);
      throw e;
    }
    const entry = { commandId: req.commandId, agent: req.agent, policy: planned.policy, destroyed: false };
    this.sandboxes.push(entry);
    try {
      return await this.inner(req, { handle, policy: planned.policy });
    } finally {
      entry.destroyed = (await host.destroy(handle)) === "destroyed";
    }
  }
}
