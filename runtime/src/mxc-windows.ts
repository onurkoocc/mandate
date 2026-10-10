// The Windows sandbox host: MXC's SDK (`@microsoft/mxc-sdk/v1`) with the
// AppContainer process container (Doc 4 §11.3, §16.1; BACKLOG P2-27, K16).
//
// - Probe: the SDK's platform check, and the Windows build. Process isolation
//   needs build 26100.9278 or later, session isolation 26100.9550 (§7.3); an
//   older build enforces nothing, and every agent is refused by name (G05).
//   Session isolation cannot deny outbound network (MXC requires egress to be
//   allowed for it), so a requirement for no network, which every agent has,
//   is refused on it by name; it is never run with the network open (INV-11).
// - Execute: one process per tool call, in a process container (AppContainer)
//   under the policy:
//     filesystem  the policy's read-only and read-write paths; the toolchain
//                 (node.exe's directory) and the runtime's tool helper read-only;
//                 a fresh scratch directory for the process's temporary files
//     network     egress and ingress denied, host loopback too
//     UI          an isolated desktop of its own: no clipboard, no input
//                 injection, no access to the user's desktop
//     environment only what Windows needs to start a process, and PATH; nothing
//                 of the runtime's own environment, so no key reaches it (K7)
//     timeout     the policy's
//   The command allow-list is enforced before a process starts, as on Linux.
// - Tools: an AppContainer has no cat, ls, grep or sh, so the runtime's file
//   tools run as `node sandbox-helper <op>` with the same results. A write's
//   content is staged in a read-only file the helper copies, because the SDK
//   can only stream stdin on newer Node versions.
// - Learning mode (`mode: "learning"`, W0311): accesses the policy denies stay
//   denied and are recorded (MXC captureDenials); `collect` hands them over.
//
// Windows' Node needs two adjustments inside the container, set through
// NODE_OPTIONS: module paths are not resolved through realpath (realpath reads
// every parent directory, which the policy does not grant), and `node --test`
// runs test files in-process (the container cannot start a child process).

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { disallowed } from "./mxc.js";
import { helperFile } from "./sandbox-helper.js";
import { makeWritable, type Enforceable, type ExecRequest, type ExecResult, type MxcPolicy, type SandboxDenial, type SandboxHost } from "./sandbox.js";
import { WRITE_SCRIPT } from "./tools.js";

/** The part of `@microsoft/mxc-sdk/v1` the Windows host uses; tests pass a fake. */
export interface WindowsMxcSdk {
  getPlatformSupport(): { isSupported: boolean; reason?: string; availableMethods: string[]; isolationTier?: string };
  getAvailableBackends?(): Array<{ backend: string; capabilities: string[] }>;
  run(request: WindowsContainerRequest): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean; outputMetadata?: { captureDenials?: { outputPath: string; totalDenials: number } } }>;
}

export interface WindowsContainerRequest {
  command: string;
  filesystem: { readonlyPaths: string[]; readwritePaths: string[] };
  network: { egress: { default: "deny" }; ingress: { default: "deny"; hostLoopback: "deny" } };
  ui: { disable: false; clipboard: "none"; allowInputInjection: false };
  containment: {
    type: "processcontainer";
    config: {
      ui: { isolation: "container"; desktopSystemControl: false; systemSettings: "none"; ime: false };
      captureDenials?: { mode: "block"; outputPath: string };
    };
  };
  environment: Record<string, string>;
  inheritDefaultEnvironment: false;
  timeoutMs?: number;
  workingDirectory?: string;
}

export interface WindowsMxcHostOptions {
  sdk?: WindowsMxcSdk;
  /** `process` (AppContainer, default) or `session` (refused for agents: it cannot block the network). */
  backend?: "process" | "session";
  /** Directories of programs the sandbox may run, read-only and on PATH. Default: node.exe's directory. */
  toolchain?: string[];
  /** Command name → executable. Default: looked up in the toolchain and System32. */
  commands?: Record<string, string>;
  /** The Windows build, for tests. Default: this machine's. */
  build?: { build: number; ubr: number };
  /** Set in NODE_OPTIONS inside the sandbox. */
  nodeOptions?: string;
  /** Longest output kept per stream; the rest is cut. Default 1 MiB. */
  maxOutput?: number;
}

const MXC_SDK = "@microsoft/mxc-sdk/v1";

/** Build thresholds (§7.3; Doc 1 §9.2): 24H2's first builds with each backend. */
export const MIN_BUILD = { process: { build: 26100, ubr: 9278 }, session: { build: 26100, ubr: 9550 } } as const;

const NOTHING: Enforceable = { backends: [], modes: [], filesystem: false, network: "none", exec: "none", timeout: false, ui: false };

const DEFAULT_NODE_OPTIONS = "--preserve-symlinks --preserve-symlinks-main --test-isolation=none";

/** This machine's Windows build and update revision. */
export function windowsBuild(): { build: number; ubr: number } {
  const build = Number(release().split(".")[2] ?? 0);
  let ubr = 0;
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "/v", "UBR"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    ubr = parseInt(out.match(/UBR\s+REG_DWORD\s+(0x[0-9a-f]+)/i)?.[1] ?? "0", 16);
  } catch {
    // Unknown: the threshold check then refuses builds that need a revision.
  }
  return { build, ubr };
}

function atLeast(have: { build: number; ubr: number }, need: { build: number; ubr: number }): boolean {
  return have.build > need.build || (have.build === need.build && have.ubr >= need.ubr);
}

/** Windows command-line quoting (CommandLineToArgvW rules). */
export function winQuote(arg: string): string {
  if (arg && !/[\s"]/.test(arg)) return arg;
  let out = '"';
  let slashes = 0;
  for (const ch of arg) {
    if (ch === "\\") slashes++;
    else if (ch === '"') {
      out += "\\".repeat(slashes * 2 + 1) + '"';
      slashes = 0;
    } else {
      out += "\\".repeat(slashes) + ch;
      slashes = 0;
    }
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

const win = (p: string): string => p.replace(/\//g, "\\");

interface Open {
  policy: MxcPolicy;
  scratch: string;
  denials: SandboxDenial[];
  /** Processes `run` has not returned from yet. */
  running: number;
  stopped: boolean;
}

export class WindowsMxcHost implements SandboxHost {
  private sdk: WindowsMxcSdk | undefined;
  private readonly open = new Map<string, Open>();
  private readonly toolchain: string[];
  private readonly helper = helperFile();
  /** Why the last probe found nothing enforceable, for the operator. */
  unavailable: string | undefined;

  constructor(private readonly o: WindowsMxcHostOptions = {}) {
    this.sdk = o.sdk;
    this.toolchain = o.toolchain ?? [dirname(process.execPath)];
  }

  private async load(): Promise<WindowsMxcSdk | undefined> {
    if (this.sdk) return this.sdk;
    try {
      const specifier: string = MXC_SDK;
      this.sdk = (await import(specifier)) as WindowsMxcSdk;
    } catch (e) {
      this.unavailable = `@microsoft/mxc-sdk could not be loaded: ${(e as Error).message}`;
    }
    return this.sdk;
  }

  async probe(): Promise<Enforceable> {
    const sdk = await this.load();
    if (!sdk) return NOTHING;
    const backend = this.o.backend ?? "process";
    const method = backend === "process" ? "processcontainer" : "isolation_session";
    const p = sdk.getPlatformSupport();
    if (!p.isSupported || !p.availableMethods.includes(method)) {
      this.unavailable = p.reason || `${method} is not among ${p.availableMethods.join(", ") || "no backends"}`;
      return NOTHING;
    }
    const build = this.o.build ?? windowsBuild();
    const need = MIN_BUILD[backend];
    if (!atLeast(build, need)) {
      this.unavailable = `Windows build ${build.build}.${build.ubr} is older than ${need.build}.${need.ubr}, the first with ${method} isolation`;
      return NOTHING;
    }
    this.unavailable = undefined;
    const learning = (sdk.getAvailableBackends?.() ?? []).some((b) => b.backend === method && b.capabilities.includes("captureDenials"));
    return {
      backends: [backend],
      modes: ["enforcement", ...(learning ? (["learning"] as const) : [])],
      filesystem: true,
      // Session isolation requires egress to be allowed: it cannot keep an agent off the network.
      network: backend === "process" ? "deny_all" : "none",
      exec: "args_prefix",
      timeout: true,
      ui: true,
    };
  }

  async create(policy: MxcPolicy): Promise<string> {
    // MxcAdapter only plans what the probe said it can enforce; a policy that asks for more is a bug, not a fallback.
    if (policy.network.allowOutbound || policy.network.allowedHosts.length) throw new Error("WindowsMxcHost: this host blocks all outbound network; this policy allows some.");
    if (policy.isolation !== "process") throw new Error(`WindowsMxcHost: ${policy.isolation} isolation cannot run an agent: it cannot block the network.`);
    makeWritable(policy);
    const handle = `wxc-${randomUUID()}`;
    this.open.set(handle, { policy, scratch: mkdtempSync(join(tmpdir(), "mandate-wxc-")), denials: [], running: 0, stopped: false });
    return handle;
  }

  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    const sbx = this.open.get(handle);
    if (!sbx) return refused(`no sandbox ${handle}`);
    if (sbx.stopped) return refused(`sandbox ${handle} was stopped`);
    const why = disallowed(sbx.policy, req.argv);
    if (why) return refused(why);
    const sdk = await this.load();
    if (!sdk) return refused(this.unavailable ?? "MXC is not available");
    const node = this.resolve("node");
    if (!node) return refused("node.exe is not in this sandbox's toolchain");
    const [cmd, ...args] = req.argv;
    let staged: string | undefined;
    let argv: string[];
    try {
      if (cmd === "cat") argv = [node, this.helper, "cat", win(args[args.length - 1]!)];
      else if (cmd === "ls") argv = [node, this.helper, "ls", win(args[args.length - 1]!)];
      else if (cmd === "grep") argv = [node, this.helper, "grep", args[args.length - 2]!, win(args[args.length - 1]!), ...args.filter((a) => a.startsWith("--exclude-dir=")).map((a) => a.slice("--exclude-dir=".length))];
      else if (cmd === "sh" && args[1] === WRITE_SCRIPT) {
        staged = mkdtempSync(join(tmpdir(), "mandate-stage-"));
        writeFileSync(join(staged, "content"), req.stdin ?? "");
        argv = [node, this.helper, "write", join(staged, "content"), win(args[args.length - 1]!)];
      } else {
        const exe = this.resolve(cmd!);
        if (!exe) return refused(`${cmd} is not in this sandbox's toolchain`);
        argv = [exe, ...args];
      }
      const learning = sbx.policy.mode === "learning";
      const report = join(sbx.scratch, `denials-${randomUUID()}.json`);
      const timeoutMs = req.timeoutMs ?? (sbx.policy.timeoutSeconds !== null ? sbx.policy.timeoutSeconds * 1000 : undefined);
      const request: WindowsContainerRequest = {
        command: argv.map(winQuote).join(" "),
        filesystem: {
          readonlyPaths: [...this.toolchain, dirname(this.helper), ...(staged ? [staged] : []), ...sbx.policy.filesystem.readOnly.map(win)],
          readwritePaths: [sbx.scratch, ...sbx.policy.filesystem.readWrite.map(win)],
        },
        network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
        ui: { disable: false, clipboard: "none", allowInputInjection: false },
        containment: {
          type: "processcontainer",
          config: {
            ui: { isolation: "container", desktopSystemControl: false, systemSettings: "none", ime: false },
            ...(learning ? { captureDenials: { mode: "block" as const, outputPath: report } } : {}),
          },
        },
        environment: this.environment(sbx.scratch),
        inheritDefaultEnvironment: false,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(req.cwd ? { workingDirectory: win(req.cwd) } : {}),
      };
      let r;
      sbx.running++;
      try {
        r = await sdk.run(request);
      } catch (e) {
        return refused(`MXC refused to start the process: ${(e as Error).message}`);
      } finally {
        sbx.running--;
      }
      const reported = r.outputMetadata?.captureDenials?.outputPath;
      if (learning && reported && existsSync(reported)) sbx.denials.push(...denialsIn(readFileSync(reported, "utf8"), this.toolchain));
      const max = this.o.maxOutput ?? 1 << 20;
      return { stdout: cut(r.stdout, max), stderr: cut(r.stderr, max), exitCode: r.exitCode, timedOut: r.timedOut, ...(sbx.stopped ? { stopped: true } : {}) };
    } finally {
      if (staged) rmSync(staged, { recursive: true, force: true });
    }
  }

  async collect(handle: string): Promise<{ denials: SandboxDenial[] }> {
    const sbx = this.open.get(handle);
    const seen = new Set<string>();
    return { denials: (sbx?.denials ?? []).filter((d) => !seen.has(`${d.access} ${d.resource}`) && !!seen.add(`${d.access} ${d.resource}`)) };
  }

  /**
   * Starts no more processes in the sandbox (§16.1 Stop). The SDK's `run`
   * cannot be killed, so while one runs the answer is `uncertain`: it ends
   * at its timeout, which every agent's policy sets.
   */
  async stop(handle: string): Promise<"stopped" | "uncertain"> {
    const sbx = this.open.get(handle);
    if (!sbx) return "stopped";
    sbx.stopped = true;
    return sbx.running ? "uncertain" : "stopped";
  }

  async destroy(handle: string): Promise<"destroyed"> {
    const sbx = this.open.get(handle);
    if (sbx) rmSync(sbx.scratch, { recursive: true, force: true });
    this.open.delete(handle);
    return "destroyed";
  }

  /** What Windows needs to start a process, PATH over the toolchain, and NODE_OPTIONS; nothing else. */
  private environment(scratch: string): Record<string, string> {
    const root = process.env["SystemRoot"] ?? "C:\\Windows";
    return {
      SystemRoot: root,
      windir: root,
      SystemDrive: root.slice(0, 2),
      ComSpec: join(root, "System32", "cmd.exe"),
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      PATH: [...this.toolchain, join(root, "System32")].join(delimiter),
      LOCALAPPDATA: scratch,
      TEMP: scratch,
      TMP: scratch,
      NODE_OPTIONS: this.o.nodeOptions ?? DEFAULT_NODE_OPTIONS,
    };
  }

  /** A command name as an executable in the toolchain or System32. */
  private resolve(cmd: string): string | undefined {
    const named = this.o.commands?.[cmd];
    if (named) return named;
    const root = process.env["SystemRoot"] ?? "C:\\Windows";
    for (const dir of [...this.toolchain, join(root, "System32")]) {
      for (const ext of [".exe", ".cmd", ".bat", ""]) {
        const p = join(dir, `${cmd}${ext}`);
        if (existsSync(p)) return p;
      }
    }
    return undefined;
  }
}

/**
 * The file accesses an MXC denial report lists, without the ones of starting
 * the toolchain itself (which the container's base policy governs).
 */
export function denialsIn(report: string, toolchain: string[] = []): SandboxDenial[] {
  let parsed: { denials?: Array<{ resource?: string; resourceType?: string; accessType?: string }> };
  try {
    parsed = JSON.parse(report) as typeof parsed;
  } catch {
    return [];
  }
  const root = (process.env["SystemRoot"] ?? "C:\\Windows").toLowerCase();
  const own = toolchain.map((t) => t.toLowerCase());
  return (parsed.denials ?? [])
    .filter((d) => d.resourceType === "file" && typeof d.resource === "string")
    .filter((d) => {
      const r = d.resource!.toLowerCase();
      return !r.startsWith(root) && !own.some((t) => r.startsWith(t));
    })
    .map((d) => ({ resource: d.resource!, access: d.accessType ?? "unknown", kind: d.resourceType! }));
}

function refused(stderr: string): ExecResult {
  return { stdout: "", stderr: `${stderr}\n`, exitCode: 126, timedOut: false };
}

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[… ${text.length - max} more characters cut]` : text;
}
