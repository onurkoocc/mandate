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
//   exec        the allow-list is enforced before a process starts: the
//               command and its argument prefix must be the policy's
//   privilege   every capability dropped, no new privileges
//   timeout     the policy's, per process; the container is killed
//
// Each command runs in the image its configuration names, e.g. `npm` in
// node:22-slim; a command without an image is refused.

import { mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import type { Docker } from "./boundary.js";
import { realDocker } from "./boundary.js";
import type { Enforceable, ExecRequest, ExecResult, MxcPolicy, SandboxHost } from "./sandbox.js";

/** Cache directories tools write inside node_modules. */
const NODE_CACHES = [".vite-temp", ".vite", ".cache"];

const NOTHING: Enforceable = { backends: [], modes: [], filesystem: false, network: "none", exec: "none", timeout: false, ui: false };

export class ContainerHost implements SandboxHost {
  private readonly policies = new Map<string, MxcPolicy>();
  private n = 0;

  constructor(
    private readonly o: {
      /** Command → the image it runs in, e.g. { npm: "node:22-slim", mvn: "maven:3.9-eclipse-temurin-21" }. */
      images: Record<string, string>;
      /** Variables every process gets, e.g. { MAVEN_OPTS: "-Dmaven.repo.local=/m/0/.m2" }. Nothing else from the host. */
      env?: Record<string, string>;
      docker?: Docker;
    },
  ) {}

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
    this.policies.set(handle, policy);
    return handle;
  }

  async execute(handle: string, req: ExecRequest): Promise<ExecResult> {
    const policy = this.policies.get(handle);
    if (!policy) return fail(126, `no sandbox ${handle}`);
    const [command, ...args] = req.argv;
    const allowed = policy.process.allowedCommands.filter((c) => c.command === command);
    if (!command || !allowed.length || !allowed.some((c) => !c.argsPrefix || c.argsPrefix.some((p) => p.every((x, i) => args[i] === x)))) {
      return fail(126, `${req.argv.join(" ")} is not allowed in this sandbox`);
    }
    const image = this.o.images[command];
    if (!image) return fail(127, `no image is configured for ${command}`);
    // Every policy path at a path of its own inside the container; the process sees those paths.
    const mounts = [...policy.filesystem.readWrite.map((p) => ({ p: norm(p), rw: true })), ...policy.filesystem.readOnly.map((p) => ({ p: norm(p), rw: false }))];
    const at = new Map(mounts.map((m, i) => [norm(m.p), `/m/${i}`]));
    const inside = (p: string): string => {
      const n = norm(p);
      for (const [host, ctr] of [...at.entries()].sort((a, b) => b[0].length - a[0].length)) {
        if (n === host) return ctr;
        if (n.startsWith(`${host}/`)) return posix.join(ctr, n.slice(host.length + 1));
      }
      return p;
    };
    const cwd = req.cwd ? inside(req.cwd) : (mounts[0] ? `/m/0` : "/tmp");
    const argv = ["run", "--rm", "-i", "--network", "none", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,exec", "-e", "HOME=/tmp"];
    for (const [k, v] of Object.entries(this.o.env ?? {})) argv.push("-e", `${k}=${v}`);
    // --mount, not -v: a Windows path's drive colon is no separator here.
    mounts.forEach((m, i) => {
      argv.push("--mount", `type=bind,source=${m.p},target=/m/${i}${m.rw ? "" : ",readonly"}`);
      // A link inside a mount (a test copy's linked node_modules) does not resolve in the container: its target, if the
      // policy allows it, is mounted in its place, read-only.
      for (const [name, target] of links(m.p)) {
        if (!mounts.some((o) => norm(target) === o.p || norm(target).startsWith(`${o.p}/`))) continue;
        argv.push("--mount", `type=bind,source=${norm(target)},target=/m/${i}/${name},readonly`);
        // Tools cache inside a read-only node_modules (vite's .vite-temp): those directories are a tmpfs, nothing persists.
        if (name === "node_modules") {
          for (const cache of NODE_CACHES) {
            mkdirSync(join(target, cache), { recursive: true });
            argv.push("--tmpfs", `/m/${i}/${name}/${cache}:rw,exec`);
          }
        }
      }
    });
    argv.push("-w", cwd, image, command, ...args.map((a) => (a.startsWith("/") || /^[A-Za-z]:[\\/]/.test(a) ? inside(a) : a)));
    const timeoutMs = req.timeoutMs ?? (policy.timeoutSeconds ? policy.timeoutSeconds * 1000 : undefined);
    const r = await this.docker.run(argv, timeoutMs ? { timeoutMs } : {});
    const timedOut = r.exitCode === 137 && !!timeoutMs;
    return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode, timedOut };
  }

  async destroy(handle: string): Promise<"destroyed"> {
    this.policies.delete(handle);
    return "destroyed";
  }
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

/** A host path in one form: forward slashes, no trailing slash, and a drive path without the leading slash requirements give it. */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").replace(/^\/([A-Za-z]:\/)/, "$1");
}

function fail(exitCode: number, stderr: string): ExecResult {
  return { stdout: "", stderr: `${stderr}\n`, exitCode, timedOut: false };
}
