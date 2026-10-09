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

import type { SandboxRequirement } from "@mandate/compiler";
import type { AgentAdapter, DelegateRequest, Outcome } from "./adapters.js";

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
}

/** The platform side of the adapter contract: MXC's SDK, or a simulation in tests. */
export interface SandboxHost {
  probe(): Promise<Enforceable>;
  create(policy: MxcPolicy): Promise<string>;
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
  network: { allowOutbound: boolean; allowedHosts: string[] };
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
    if (!can.backends.includes(isolation)) unsupported.push(`isolation backend ${isolation}`);
    if ((mode as SandboxMode) === "permissive" || !can.modes.includes(mode)) unsupported.push(`mode ${mode}`);
    if (!can.filesystem) unsupported.push("filesystem path lists");
    if (can.network === "none") unsupported.push("blocking outbound network");
    else if (hosts.length && can.network !== "host_allow_list") unsupported.push("an outbound host allow-list");
    if (can.exec === "none") unsupported.push("a command allow-list");
    else if (req.exec.some((x) => x.args_prefix) && can.exec !== "args_prefix") unsupported.push("argument-prefix limits on commands");
    if (timeoutMs !== null && !can.timeout) unsupported.push("a timeout");
    if (!can.ui) unsupported.push("turning off desktop and clipboard access");
    if (unsupported.length) return { unsupported };
    return {
      policy: {
        $generator: `${MxcAdapter.ID} (MXC SDK v1)`,
        $source: `${req.subject.agent}@${req.subject.def}`,
        version: this.o.schemaVersion,
        isolation,
        filesystem: { readOnly: req.filesystem.read, readWrite: req.filesystem.write },
        network: { allowOutbound: hosts.length > 0, allowedHosts: hosts },
        process: { allowedCommands: req.exec.map((x) => (x.args_prefix ? { command: x.command, argsPrefix: x.args_prefix } : { command: x.command })) },
        ui: { allowDesktop: false, allowClipboard: false },
        timeoutSeconds: timeoutMs === null ? null : Math.ceil(timeoutMs / 1000),
        mode,
      },
    };
  }
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
    if ("unsupported" in planned) {
      return {
        error: { tag: "PolicyDenied", args: [{ reason: "unsupported_sandbox_profile", code: "MDT-E0902", agent: req.agent, adapter: MxcAdapter.ID, unsupported: planned.unsupported }] },
        cost: {},
      };
    }
    const host = this.adapter.o.host;
    const handle = await host.create(planned.policy);
    const entry = { commandId: req.commandId, agent: req.agent, policy: planned.policy, destroyed: false };
    this.sandboxes.push(entry);
    try {
      return await this.inner(req, { handle, policy: planned.policy });
    } finally {
      entry.destroyed = (await host.destroy(handle)) === "destroyed";
    }
  }
}
