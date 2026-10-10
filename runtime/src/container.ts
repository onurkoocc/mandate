// A container sandbox host (design doc 9 §4; BACKLOG item 33). The same
// SandboxHost contract as MXC (§16.1), for a component's own toolchain: a
// Java component's tests need a JDK and Maven, a Python one's an
// interpreter, which an MXC sandbox on a developer's machine may not have.
// It is probed and planned like MXC, so a requirement it cannot enforce is
// refused by name (INV-11).
//
//   filesystem  only the policy's paths, each mounted at a path of its own;
//               read-only unless the policy makes it writable; the image's
//               root file system read-only, /tmp a tmpfs
//   network     none (`--network none`)
//   exec        the allow-list is enforced before a process starts: one of
//               the runtime's tool helpers (cat, ls, grep, the write_file
//               script) on a path inside the policy, or an allowed command
//               whose arguments start with an allowed prefix (`disallowed`,
//               shared with MXC)
//   privilege   every capability dropped, no new privileges
//   timeout     the policy's, per process; killed inside the container
//   stop        every container of the sandbox is removed, with what runs
//
// A sandbox keeps one container per image for its lifetime, started on first
// use, and runs each process in it with `docker exec`: an agent's many small
// tool calls do not each pay for a container start. Each command runs in the
// image its configuration names, e.g. `npm` in node:22-slim; the tool
// helpers run in the image of the command that shares their working copy, or
// in `helperImage`. A command without an image is refused.

import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import type { Docker } from "./boundary.js";
import { realDocker } from "./boundary.js";
import { disallowed } from "./mxc.js";
import type { Enforceable, ExecRequest, ExecResult, MxcPolicy, SandboxHost } from "./sandbox.js";

/** Cache directories tools write inside node_modules. */
const NODE_CACHES = [".vite-temp", ".vite", ".cache"];

const HELPER_COMMANDS = new Set(["cat", "ls", "grep", "sh"]);

const NOTHING: Enforceable = { backends: [], modes: [], filesystem: false, network: "none", exec: "none", timeout: false, ui: false };

export interface ContainerHostOptions {
  /** Command → the image it runs in, e.g. { npm: "node:22-slim", mvn: "maven:3.9-eclipse-temurin-21" }. */
  images: Record<string, string>;
  /**
   * The image for one command in one working directory, before `images`: a
   * component's own test image (its dependencies installed) where two
   * components share a command name. Undefined falls back to `images`.
   */
  imageFor?: (command: string, cwd: string | undefined) => string | undefined;
  /** The image the tool helpers run in when no command image shares their path: GNU grep and coreutils. Default debian:bookworm-slim. */
  helperImage?: string;
  /** Variables every process gets, e.g. { MAVEN_OPTS: "-Dmaven.repo.local=/m/0/.m2" }. Nothing else from the host. */
  env?: Record<string, string>;
  /**
   * Directories under a mounted path that a build writes and nobody keeps,
   * e.g. ["target"]: each becomes a tmpfs, so a read-only working copy can
   * still be built and tested. Nothing written there persists.
   */
  scratch?: string[];
  /**
   * Directories outside every policy that a link at the top of a mounted path
   * may point to, e.g. a dependency cache the host prepared: the target is
   * mounted read-only in the link's place. Like the verifier's `extraRead`, it
   * is part of the toolchain, never a path an agent can write.
   */
  linkTargets?: string[];
  docker?: Docker;
}

interface Sandbox {
  policy: MxcPolicy;
  mounts: Array<{ p: string; host: string; rw: boolean }>;
  /** Image → its running container. */
  containers: Map<string, Promise<string>>;
  stopped: boolean;
}

export class ContainerHost implements SandboxHost {
  private readonly sandboxes = new Map<string, Sandbox>();
  private n = 0;
  private readonly prefix = `mandate-${process.pid}-${Date.now().toString(36)}`;

  constructor(private readonly o: ContainerHostOptions) {}

  private get docker(): Docker {
    return this.o.docker ?? realDocker;
  }

  async probe(): Promise<Enforceable> {
    const r = await this.docker.run(["info", "--format", "{{.OSType}}"]);
    if (r.exitCode !== 0 || !r.stdout.includes("linux")) return NOTHING;
    return { backends: ["container"], modes: ["enforcement"], filesystem: true, network: "deny_all", exec: "args_prefix", timeout: true, ui: true };
  }

  async create(policy: MxcPolicy): Promise<string> {
    const handle = `ctr-${++this.n}`;
    const mounts = [...policy.filesystem.readWrite.map((p) => ({ p: norm(p), rw: true })), ...policy.filesystem.readOnly.map((p) => ({ p: norm(p), rw: false }))]
      .filter((m, i, all) => all.findIndex((o) => o.p === m.p) === i)
      .map((m) => ({ ...m, host: hostPath(m.p) }));
    this.sandboxes.set(handle, { policy, mounts, containers: new Map(), stopped: false });
    return handle;
  }

  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    const sb = this.sandboxes.get(handle);
    if (!sb) return fail(126, `no sandbox ${handle}`);
    if (sb.stopped) return { ...fail(126, "the sandbox was stopped"), stopped: true };
    const [command, ...args] = req.argv;
    if (!command) return fail(126, "empty command");
    const why = disallowed(sb.policy, req.argv);
    if (why) return fail(126, why);
    const image = this.imageOf(command, req, sb);
    if (!image) return fail(127, `no image is configured for ${command}`);
    let container: string;
    try {
      container = await this.containerFor(handle, sb, image);
    } catch (e) {
      return fail(125, `the sandbox could not start: ${(e as Error).message}`);
    }
    const inside = (p: string): string => {
      const n = norm(p);
      for (const [i, m] of [...sb.mounts.entries()].sort((a, b) => b[1].p.length - a[1].p.length)) {
        if (n === m.p) return `/m/${i}`;
        if (n.startsWith(`${m.p}/`)) return posix.join(`/m/${i}`, n.slice(m.p.length + 1));
      }
      return p;
    };
    const cwd = req.cwd ? inside(req.cwd) : sb.mounts.length ? "/m/0" : "/tmp";
    const timeoutMs = req.timeoutMs ?? (sb.policy.timeoutSeconds ? sb.policy.timeoutSeconds * 1000 : undefined);
    const argv = ["exec", "-i", "-w", cwd];
    for (const [k, v] of Object.entries(this.o.env ?? {})) argv.push("-e", `${k}=${v}`);
    argv.push(container);
    // The timeout kills the process inside the container, where it runs; killing the docker client would not.
    if (timeoutMs) argv.push("timeout", "-s", "KILL", String(Math.max(1, Math.ceil(timeoutMs / 1000))));
    argv.push(command, ...args.map((a) => (isAbsolute(a) ? inside(a) : a)));
    const r = await this.docker.run(argv, { ...(timeoutMs ? { timeoutMs: timeoutMs + 30_000 } : {}), ...(req.stdin !== undefined ? { input: req.stdin } : {}) });
    if (sb.stopped) return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut: false, stopped: true };
    const timedOut = r.exitCode === 137 && !!timeoutMs;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut };
  }

  async stop(handle: string): Promise<"stopped" | "uncertain"> {
    const sb = this.sandboxes.get(handle);
    if (!sb) return "stopped";
    sb.stopped = true;
    return (await this.remove(sb)) ? "stopped" : "uncertain";
  }

  async destroy(handle: string): Promise<"destroyed"> {
    const sb = this.sandboxes.get(handle);
    if (sb) await this.remove(sb);
    this.sandboxes.delete(handle);
    return "destroyed";
  }

  private imageOf(command: string, req: ExecRequest, sb: Sandbox): string | undefined {
    if (!HELPER_COMMANDS.has(command) || this.o.images[command]) {
      return this.o.imageFor?.(command, req.cwd) ?? this.o.images[command];
    }
    // A helper runs where the sandbox already has a container, so a read after a test sees the same file system.
    const [first] = sb.containers.keys();
    return first ?? this.o.helperImage ?? "debian:bookworm-slim";
  }

  private containerFor(handle: string, sb: Sandbox, image: string): Promise<string> {
    let c = sb.containers.get(image);
    if (!c) {
      c = this.start(handle, sb, image, sb.containers.size);
      sb.containers.set(image, c);
    }
    return c;
  }

  private async start(handle: string, sb: Sandbox, image: string, k: number): Promise<string> {
    const name = `${this.prefix}-${handle}-${k}`;
    const argv = ["run", "-d", "--name", name, "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,exec", "-e", "HOME=/tmp"];
    for (const [k2, v] of Object.entries(this.o.env ?? {})) argv.push("-e", `${k2}=${v}`);
    // --mount, not -v: a Windows path's drive colon is no separator here.
    sb.mounts.forEach((m, i) => {
      argv.push("--mount", `type=bind,source=${m.host},target=/m/${i}${m.rw ? "" : ",readonly"}`);
      // A link inside a mount (a test copy's linked node_modules) does not resolve in the container: its target, if the
      // policy allows it, is mounted in its place, read-only.
      for (const [entry, target] of links(m.host)) {
        const under = (dir: string) => norm(target) === norm(dir) || norm(target).startsWith(`${norm(dir)}/`);
        if (!sb.mounts.some((o) => under(o.host)) && !(this.o.linkTargets ?? []).some((d) => under(hostPath(d)))) continue;
        argv.push("--mount", `type=bind,source=${norm(target)},target=/m/${i}/${entry},readonly`);
        if (entry === "node_modules") argv.push(...caches(target, `/m/${i}/${entry}`));
      }
      // Tools cache inside a read-only node_modules (vite's .vite-temp): those directories are a tmpfs, nothing persists.
      if (!m.rw && isDir(join(m.host, "node_modules")) && !links(m.host).some(([e]) => e === "node_modules")) argv.push(...caches(join(m.host, "node_modules"), `/m/${i}/node_modules`));
      for (const dir of this.o.scratch ?? []) {
        if (!isDir(m.host) || !looksLikeRoot(m.host)) continue;
        mkdirSync(join(m.host, dir), { recursive: true });
        argv.push("--tmpfs", `/m/${i}/${dir}:rw,exec`);
      }
    });
    argv.push("--entrypoint", "sleep", image, "infinity");
    const r = await this.docker.run(argv, { timeoutMs: 300_000 });
    if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `docker run exited ${r.exitCode}`);
    return name;
  }

  private async remove(sb: Sandbox): Promise<boolean> {
    const names = await Promise.all([...sb.containers.values()].map((c) => c.catch(() => undefined)));
    sb.containers.clear();
    const live = names.filter((x): x is string => !!x);
    if (!live.length) return true;
    const r = await this.docker.run(["rm", "-f", ...live], { timeoutMs: 120_000 });
    return r.exitCode === 0;
  }
}

function caches(hostDir: string, at: string): string[] {
  const out: string[] = [];
  for (const cache of NODE_CACHES) {
    mkdirSync(join(hostDir, cache), { recursive: true });
    out.push("--tmpfs", `${at}/${cache}:rw,exec`);
  }
  return out;
}

/** The top-level entries of `dir` that are links, with their real targets. */
function links(dir: string): Array<[string, string]> {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isSymbolicLink())
      .map((e) => [e.name, realpathSync(join(dir, e.name))] as [string, string]);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** A working copy's root, where build output directories belong: it holds a build file. */
function looksLikeRoot(p: string): boolean {
  return ["pom.xml", "package.json", "pyproject.toml", "build.gradle"].some((f) => {
    try {
      return statSync(join(p, f)).isFile();
    } catch {
      return false;
    }
  });
}

function isAbsolute(a: string): boolean {
  return a.startsWith("/") || /^[A-Za-z]:[\\/]/.test(a);
}

/** A host path in one form: forward slashes, no trailing slash, and a drive path without the leading slash requirements give it. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/([A-Za-z]:\/)/, "$1");
}

/**
 * Where a policy path is on the host, for a bind mount. A policy path is
 * POSIX (`/work/kervan-mcp`); on Windows it resolves against the current
 * drive, as Node resolves it everywhere else in the runtime, and through a
 * substituted drive to the directory behind it.
 */
function hostPath(p: string): string {
  if (process.platform !== "win32") return p;
  const abs = resolve(p);
  try {
    return norm(realpathSync.native(abs));
  } catch {
    return norm(abs);
  }
}

function fail(exitCode: number, stderr: string): ExecResult {
  return { stdout: "", stderr: `${stderr}\n`, exitCode, timedOut: false };
}
