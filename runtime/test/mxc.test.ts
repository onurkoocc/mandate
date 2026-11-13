// The real sandbox host (P1-8, K7, K16): MXC with Bubblewrap on Linux.
//
// The first part runs everywhere, against a fake SDK: what the host asks MXC
// for, what it refuses without starting a process, and what a host where
// Bubblewrap cannot run enforces (nothing, so every agent is refused, G05).
//
// The second part runs only on Linux with MANDATE_MXC=1 (CI's `sandbox` job,
// after installing bubblewrap and enabling user namespaces). It checks the
// blocking itself: a write outside the granted paths does not reach the host,
// a read outside them sees nothing, no host can be reached, and no unix
// socket of the host can be connected to (G05, G07).

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { requirementFor, type SandboxRequirement } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { HOST_RUNTIME_DIRS, MASK_CHECK, MxcHost, shellQuote, type MxcContainerRequest, type MxcSdk } from "../src/mxc.js";
import { MxcAdapter, type MxcPolicy } from "../src/sandbox.js";
import { SimChat, toolUse } from "../src/sim.js";
import { WRITE_SCRIPT } from "../src/tools.js";
import { closeAll, world } from "./helpers.js";

function requirement(o: { read?: string[]; write?: string[]; exec?: Array<{ command: string; args_prefix?: string[][] }>; hosts?: string[] } = {}): SandboxRequirement {
  const caps = [
    ...(o.read?.length ? [{ ctor: "fs.read", effect: "Fs.Read", write: false, scope: o.read }] : []),
    ...(o.write?.length ? [{ ctor: "fs.write", effect: "Fs.Write", write: true, scope: o.write }] : []),
    ...(o.exec ?? []).map((e) => ({ ctor: "exec", effect: "Exec", write: false, scope: [e.command], ...(e.args_prefix ? { argsPrefix: e.args_prefix } : {}) })),
    ...(o.hosts?.length ? [{ ctor: "net.https", effect: "Net", write: false, scope: o.hosts }] : []),
    { ctor: "model.infer", effect: "Model", write: false, tier: "standard", maxClass: "internal" as const },
  ];
  return requirementFor({ agent: "A", def: "sha256:test" }, caps as never, 30_000);
}

class FakeSdk implements MxcSdk {
  readonly spawned: MxcContainerRequest[] = [];
  /** The probe's mask checks, kept apart from the processes a sandbox runs. */
  readonly checks: MxcContainerRequest[] = [];
  readonly stdin: string[] = [];
  /** A process that runs until it is killed, like a hung test run. */
  hang = false;
  killed = 0;
  /** Like a backend that ignores `deniedPaths`: the host's runtime directory stays in view. */
  ignoresMasks = false;
  constructor(private readonly support: ReturnType<MxcSdk["getPlatformSupport"]> = { isSupported: true, availableMethods: ["bubblewrap", "lxc"] }) {}
  getPlatformSupport() {
    return this.support;
  }
  async spawn(request: MxcContainerRequest) {
    if (request.command === MASK_CHECK) {
      this.checks.push(request);
      // What a sandbox sees in /run: the resolver's directory the baseline shows, unless /run is masked.
      const masked = !this.ignoresMasks && request.filesystem.deniedPaths.includes("/run");
      return finished(masked ? "end\n" : "/run/systemd\nend\n");
    }
    this.spawned.push(request);
    const input = new PassThrough();
    const out = new PassThrough();
    const err = new PassThrough();
    let text = "";
    let exit: (code: number) => void = () => {};
    const exited = new Promise<number>((r) => (exit = r));
    input.on("data", (c) => (text += String(c)));
    input.on("end", () => {
      this.stdin.push(text);
      if (this.hang) return;
      out.end("ok\n");
      err.end();
      exit(0);
    });
    const kill = () => {
      this.killed++;
      out.end();
      err.end();
      exit(137);
    };
    return { standardInput: input, standardOutput: out, standardError: err, wait: async () => ({ exitCode: await exited, timedOut: false }), kill, dispose: () => {} };
  }
}

/** A process that has already printed `stdout` and exited 0. */
function finished(stdout: string) {
  const out = new PassThrough();
  const err = new PassThrough();
  out.end(stdout);
  err.end();
  return { standardInput: new PassThrough(), standardOutput: out, standardError: err, wait: async () => ({ exitCode: 0, timedOut: false }), kill: () => {}, dispose: () => {} };
}

const adapter = (host: MxcHost) => new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });

async function sandbox(host: MxcHost, req: SandboxRequirement): Promise<{ handle: string; policy: MxcPolicy }> {
  const planned = await adapter(host).plan(req);
  if ("unsupported" in planned) throw new Error(`refused: ${planned.unsupported.join("; ")}`);
  return { handle: await host.create(planned.policy), policy: planned.policy };
}

describe("MxcHost against a fake SDK", () => {
  it("asks MXC for Bubblewrap with the policy's paths, no network and the timeout, and quotes the command", async () => {
    const sdk = new FakeSdk();
    const host = new MxcHost({ sdk, baseline: ["/opt/node"] });
    const { handle, policy } = await sandbox(host, requirement({ read: ["/work/repo"], write: ["/work/repo/src"], exec: [{ command: "npm", args_prefix: [["test"]] }] }));
    expect(policy.network).toEqual({ allowOutbound: false, allowedHosts: [] });
    const r = await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", "/work/repo/src/it's.ts"], stdin: "content" });
    expect(r.exitCode).toBe(0);
    expect(sdk.spawned[0]).toEqual({
      command: `sh -c '${WRITE_SCRIPT.replaceAll("'", "'\\''")}' sh '/work/repo/src/it'\\''s.ts'`,
      filesystem: { readonlyPaths: ["/opt/node", "/work/repo"], readwritePaths: ["/work/repo/src"], deniedPaths: ["/run", "/var/run"] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      containment: { type: "bubblewrap" },
      timeoutMs: 30_000,
    });
    expect(sdk.stdin).toEqual(["content"]);
    expect(shellQuote("a b")).toBe("'a b'");
  });

  it("refuses without starting a process what the policy does not allow", async () => {
    const sdk = new FakeSdk();
    const host = new MxcHost({ sdk });
    const { handle } = await sandbox(host, requirement({ read: ["/work/repo"], write: ["/work/repo/src"], exec: [{ command: "npm", args_prefix: [["test"]] }] }));
    const refused = async (argv: string[]) => (await host.execute(handle, { argv })).stderr;
    expect(await refused(["curl", "https://example.com"])).toContain("curl is not an allowed command");
    expect(await refused(["npm", "publish"])).toContain("does not start with an allowed argument prefix");
    expect(await refused(["cat", "/etc/passwd"])).toContain("outside this sandbox's paths");
    expect(await refused(["sh", "-c", WRITE_SCRIPT, "sh", "/work/repo/test/x"])).toContain("outside this sandbox's write paths");
    expect(await refused(["sh", "-c", "curl evil"])).toContain("sh is not an allowed command");
    expect(sdk.spawned).toHaveLength(0);
    expect((await host.execute(handle, { argv: ["npm", "test", "--", "-x"] })).exitCode).toBe(0);
  });

  it("stops a sandbox: kills what runs in it and starts nothing more (§16.1 Stop)", async () => {
    const sdk = new FakeSdk();
    sdk.hang = true;
    const host = new MxcHost({ sdk });
    const { handle } = await sandbox(host, requirement({ read: ["/work/repo"], exec: [{ command: "npm", args_prefix: [["test"]] }] }));
    const running = host.execute(handle, { argv: ["npm", "test"] });
    await new Promise((r) => setTimeout(r, 10));
    expect(await host.stop(handle)).toBe("stopped");
    expect(await running).toMatchObject({ exitCode: 137, stopped: true });
    expect(sdk.killed).toBe(1);
    expect((await host.execute(handle, { argv: ["npm", "test"] })).stderr).toContain("was stopped");
    expect(sdk.spawned).toHaveLength(1);
  });

  it("enforces nothing where Bubblewrap cannot run, so every agent is refused by name (G05, K16)", async () => {
    const host = new MxcHost({ sdk: new FakeSdk({ isSupported: false, reason: "user namespaces are disabled", availableMethods: [] }) });
    const planned = await adapter(host).plan(requirement({ read: ["/work/repo"] }));
    expect(planned).toEqual({ unsupported: ["isolation backend process", "mode enforcement", "filesystem path lists", "blocking outbound network", "a command allow-list", "a timeout", "turning off desktop and clipboard access"] });
    expect(host.unavailable).toBe("user namespaces are disabled");
  });

  it("refuses a requirement for an outbound host: this host blocks every host (G05)", async () => {
    const planned = await adapter(new MxcHost({ sdk: new FakeSdk() })).plan(requirement({ hosts: ["api.github.com"] }));
    expect(planned).toEqual({ unsupported: ["an outbound host allow-list"] });
  });

  it("reports the isolation it gives, process on a shared host, so a requirement that asks more is refused by name", async () => {
    const host = new MxcHost({ sdk: new FakeSdk() });
    expect(await host.probe()).toMatchObject({ level: "process", co_tenancy: "shared" });
    const req = { ...requirement({ read: ["/work/repo"] }), format: "mandate/sandbox-requirement/0.2", isolation: { min: "user_kernel", co_tenancy: "forbidden", data_class: "internal", untrusted_network: false } } as SandboxRequirement;
    expect(await adapter(host).plan(req)).toEqual({ unsupported: ["isolation user_kernel (this host gives process)", "co_tenancy forbidden (this host may share)"] });
  });

  it("keeps the host's runtime directories out of every sandbox: each process's request masks them", async () => {
    const sdk = new FakeSdk();
    const host = new MxcHost({ sdk, baseline: ["/opt/node"] });
    expect(await host.probe()).toMatchObject({ filesystem: true, network: "deny_all", hidden: ["/run", "/var/run"] });
    const { handle } = await sandbox(host, requirement({ read: ["/work/repo"], exec: [{ command: "npm" }] }));
    await host.execute(handle, { argv: ["npm", "test"] });
    await host.execute(handle, { argv: ["cat", "/work/repo/a.ts"] });
    expect(sdk.spawned.map((r) => r.filesystem.deniedPaths)).toEqual([HOST_RUNTIME_DIRS, HOST_RUNTIME_DIRS]);
    // The probe saw the masks hold once, in a sandbox like these, and asks no more.
    expect(sdk.checks).toHaveLength(1);
    expect(sdk.checks[0]!.filesystem).toEqual({ readonlyPaths: ["/opt/node"], readwritePaths: [], deniedPaths: HOST_RUNTIME_DIRS });
  });

  it("refuses by name a policy path at or under a runtime directory, rather than dropping it or showing it", async () => {
    const sdk = new FakeSdk();
    const host = new MxcHost({ sdk });
    const planned = await adapter(host).plan(requirement({ read: ["/run/user/1000/app", "/runner/work"], write: ["/var/run/x", "/run"] }));
    expect(planned).toEqual({
      unsupported: [
        "a path under /run, which this host keeps out of every sandbox: /run/user/1000/app",
        "a path under /run, which this host keeps out of every sandbox: /run",
        "a path under /var/run, which this host keeps out of every sandbox: /var/run/x",
      ],
    });
    // A policy that reaches the host anyway (a bug upstream) is not created.
    const { policy } = await sandbox(host, requirement({ read: ["/work/repo"] }));
    await expect(host.create({ ...policy, filesystem: { readOnly: ["/run/dbus"], readWrite: [] } })).rejects.toThrow("/run/dbus is under /run");
    expect(sdk.spawned).toHaveLength(0);
    // Nor does the operator's baseline open one: such a host enforces neither paths nor network.
    const opened = new MxcHost({ sdk, baseline: ["/run/user/1000/tools"] });
    expect(await adapter(opened).plan(requirement({ read: ["/work/repo"] }))).toEqual({ unsupported: ["filesystem path lists", "blocking outbound network"] });
    expect(opened.unavailable).toBe("the baseline path /run/user/1000/tools leads to /run, which no sandbox may see");
  });

  it("enforces neither paths nor network where the masks do not hold, so every agent is refused by name", async () => {
    const ignores = new FakeSdk();
    ignores.ignoresMasks = true;
    const fails = new FakeSdk();
    fails.spawn = async () => {
      throw new Error("unknown field deniedPaths");
    };
    for (const [sdk, why] of [
      [ignores, "Bubblewrap here does not mask the host's runtime directories (a sandbox still sees /run/systemd)"],
      [fails, "MXC could not start a sandbox that masks paths (unknown field deniedPaths)"],
    ] as const) {
      const host = new MxcHost({ sdk });
      const planned = await adapter(host).plan(requirement({ read: ["/work/repo"] }));
      expect(planned).toEqual({ unsupported: ["filesystem path lists", "blocking outbound network"] });
      expect(host.unavailable).toContain(why);
      expect(host.unavailable).toContain("service sockets");
    }
    expect(ignores.spawned).toHaveLength(0);
  });
});

const REAL = process.platform === "linux" && process.env["MANDATE_MXC"] === "1";

describe.runIf(REAL)("MxcHost with Bubblewrap on this host (G05, G07)", () => {
  const root = mkdtempSync(join(tmpdir(), "mandate-mxc-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "bug\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const host = new MxcHost();
  const open = () => sandbox(host, requirement({ read: [repo], write: [join(repo, "src")], exec: [{ command: "curl" }, { command: "env" }, { command: "sh", args_prefix: [["-c", "echo x > /tmp/escape; cp /tmp/escape " + join(outside, "copied")]] }] }));

  it("probes Bubblewrap as enforceable", async () => {
    const can = await host.probe();
    expect(can, host.unavailable).toMatchObject({ backends: ["process"], filesystem: true, network: "deny_all", exec: "args_prefix" });
  });

  it("reads and writes inside the granted paths", async () => {
    const { handle } = await open();
    expect((await host.execute(handle, { argv: ["cat", join(repo, "src", "a.ts")] })).stdout).toBe("bug\n");
    const w = await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", join(repo, "src", "b.ts")], stdin: "fixed\n" });
    expect(w).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(repo, "src", "b.ts"), "utf8")).toBe("fixed\n");
  });

  it("blocks a write outside the granted write paths, even through a shell the agent could start", async () => {
    const { handle } = await open();
    // Read-only inside the sandbox: the write fails there.
    const ro = await host.execute(handle, { argv: ["sh", "-c", "echo x > /tmp/escape; cp /tmp/escape " + join(outside, "copied")] });
    expect(existsSync(join(outside, "copied"))).toBe(false);
    expect(ro.exitCode).not.toBe(0);
    // A path the host refuses outright never starts a process.
    expect((await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", join(repo, "test", "x.ts")], stdin: "x" })).exitCode).toBe(126);
    expect(existsSync(join(repo, "test", "x.ts"))).toBe(false);
  });

  it("shows nothing outside the granted paths", async () => {
    const { handle } = await open();
    const ls = await host.execute(handle, { argv: ["curl", "-sS", "--max-time", "5", `file://${join(outside, "secret.txt")}`] });
    expect(ls.stdout).not.toContain("secret");
    expect(ls.exitCode).not.toBe(0);
  });

  it("reaches no host, while the host itself can (G07)", async () => {
    let hostReaches = true;
    try {
      execFileSync("curl", ["-sS", "--max-time", "10", "-o", "/dev/null", "https://example.com"]);
    } catch {
      hostReaches = false;
    }
    const { handle } = await open();
    for (const url of ["https://example.com", "http://1.1.1.1"]) {
      const r = await host.execute(handle, { argv: ["curl", "-sS", "--max-time", "5", "-o", "/dev/null", url] });
      expect(r.exitCode, `${url}: ${r.stderr}`).not.toBe(0);
    }
    expect(hostReaches, "the test host has no network, so blocking proves less").toBe(true);
  });

  it("stops a process that would run for a minute, at once (§16.1 Stop)", async () => {
    const { handle } = await sandbox(host, requirement({ read: [repo], exec: [{ command: "sleep" }] }));
    const t0 = Date.now();
    const running = host.execute(handle, { argv: ["sleep", "60"] });
    await new Promise((r) => setTimeout(r, 500));
    expect(await host.stop(handle)).toBe("stopped");
    const r = await running;
    expect(r.stopped).toBe(true);
    expect(r.exitCode).not.toBe(0);
    expect(Date.now() - t0).toBeLessThan(15_000);
  });

  it("starts the process with none of the runtime's environment, so no key reaches it (K7)", async () => {
    process.env["MANDATE_CANARY_KEY"] = "sk-canary";
    const { handle } = await open();
    const r = await host.execute(handle, { argv: ["env"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("sk-canary");
    expect(r.stdout).not.toMatch(/CLAUDE_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN/);
  });
});

/**
 * Connects to each unix socket path given (`@name` is the abstract socket
 * `name`), and to each absolute one again through every visible process's
 * `/proc/<pid>/root`. A given path ending in `io.systemd.Resolve` that connects
 * is asked to resolve a name. Prints one JSON object: path → `reached` or the
 * error's name.
 */
const CONNECT = String.raw`
import json, os, socket, sys
paths = []
for p in sys.argv[1:]:
    paths.append(p)
    if p.startswith("/"):
        paths += ["/proc/%s/root%s" % (pid, p) for pid in os.listdir("/proc") if pid.isdigit()]
out = {}
for p in paths:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(3)
    try:
        s.connect("\0" + p[1:] if p.startswith("@") else p)
        out[p] = "reached"
        if p in sys.argv[1:] and p.endswith("io.systemd.Resolve"):
            s.sendall(json.dumps({"method": "io.systemd.Resolve.ResolveHostname", "parameters": {"name": "example.com", "family": 2}}).encode() + b"\0")
            out[p + " ResolveHostname"] = s.recv(4096).decode("utf8", "replace").strip("\0")[:300]
    except Exception as e:
        out[p] = type(e).__name__
    finally:
        s.close()
print(json.dumps(out))
`;

/** Walks every directory the process can see (but /proc and /sys), bounded in time; prints the unix sockets found. */
const WALK = String.raw`
import json, os, stat, time
t0, walked, found, cut, stack = time.time(), 0, [], False, ["/"]
while stack:
    d = stack.pop()
    try:
        entries = list(os.scandir(d))
    except OSError:
        continue
    for e in entries:
        walked += 1
        try:
            if e.is_dir(follow_symlinks=False):
                if e.path not in ("/proc", "/sys"):
                    stack.append(e.path)
            elif not e.is_file(follow_symlinks=False) and not e.is_symlink() and stat.S_ISSOCK(e.stat(follow_symlinks=False).st_mode):
                found.append(e.path)
        except OSError:
            pass
    if time.time() - t0 > 80:
        cut = True
        break
print(json.dumps({"walked": walked, "sockets": found, "cut": cut, "seconds": round(time.time() - t0, 1), "top": sorted(os.listdir("/"))}))
`;

const RESOLVER = ["/run/systemd/resolve/io.systemd.Resolve", "/var/run/systemd/resolve/io.systemd.Resolve"];

/** A place under the host's runtime directories this test may write, or why there is none. */
function runtimeDir(): { dir: string; remove: () => void } | string {
  for (const d of [process.env["XDG_RUNTIME_DIR"], `/run/user/${process.getuid?.()}`]) {
    try {
      if (!d || !statSync(d).isDirectory()) continue;
      accessSync(d, constants.W_OK);
      const dir = mkdtempSync(join(d, "mandate-decoy-"));
      return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
    } catch {
      /* not this one */
    }
  }
  const dir = `/run/mandate-decoy-${randomUUID()}`;
  try {
    execFileSync("sudo", ["-n", "install", "-d", "-o", String(process.getuid?.()), "-m", "700", dir], { stdio: "ignore" });
    return { dir, remove: () => execFileSync("sudo", ["-n", "rm", "-rf", dir], { stdio: "ignore" }) };
  } catch {
    return "neither $XDG_RUNTIME_DIR nor /run/user/<uid> is writable here, and sudo needs a password";
  }
}

/** A unix socket server on `path` that counts its connections. */
async function decoy(path: string): Promise<{ hits: () => number; close: () => Promise<void> }> {
  let hits = 0;
  const server = createServer((s) => {
    hits++;
    // The host's own check hangs up at once.
    s.on("error", () => {});
    s.end("DECOY\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return { hits: () => hits, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * Runs `argv` in a Bubblewrap sandbox through the SDK directly, as `MxcHost`
 * would but without the masks (nothing granted, no network): the control
 * that shows what the masks block on this host. Returns its stdout.
 */
async function unmasked(argv: string[], timeoutMs = 30_000): Promise<string> {
  const specifier: string = "@microsoft/mxc-sdk/v1";
  const sdk = (await import(specifier)) as MxcSdk;
  const proc = await sdk.spawn({
    command: argv.map(shellQuote).join(" "),
    filesystem: { readonlyPaths: [], readwritePaths: [], deniedPaths: [] },
    network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
    containment: { type: "bubblewrap" },
    timeoutMs,
  });
  try {
    const text = async (s: NodeJS.ReadableStream | null) => {
      let t = "";
      for await (const c of (s ?? []) as AsyncIterable<Buffer | string>) t += String(c);
      return t;
    };
    const out = text(proc.standardOutput);
    const err = text(proc.standardError);
    proc.standardInput?.end();
    const [status, stdout, stderr] = await Promise.all([proc.wait(), out, err]);
    expect(status.exitCode, stderr).toBe(0);
    return stdout;
  } finally {
    proc.dispose();
  }
}

/** Connects from the host itself, so a blocked connection inside proves something. */
function reachFromHost(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(path, () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
  });
}

describe.runIf(REAL)("no service socket of the host reaches a Bubblewrap sandbox (G05, G07)", () => {
  const host = new MxcHost();
  const open = (read: string[] = []) => sandbox(host, requirement({ read, exec: [{ command: "python3" }] }));
  const python = async (handle: string, script: string, args: string[], timeoutMs = 30_000) => {
    const r = await host.execute(handle, { argv: ["python3", "-c", script, ...args], timeoutMs });
    expect(r.exitCode, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  const reached = (out: Record<string, unknown>) => Object.entries(out).filter(([, v]) => v === "reached").map(([k]) => k);

  it("cannot connect to the host's resolver or ask it to resolve a name, while the host can", async () => {
    const onHost = JSON.parse(execFileSync("python3", ["-c", CONNECT, RESOLVER[0]!], { encoding: "utf8" })) as Record<string, unknown>;
    console.log(`[sockets] resolver from the host: ${RESOLVER[0]} ${String(onHost[RESOLVER[0]!])}, ResolveHostname ${String(onHost[`${RESOLVER[0]} ResolveHostname`])}`);
    expect(onHost[RESOLVER[0]!], "the CI host has no systemd-resolved socket, so blocking it proves less").toBe("reached");
    // The control: the same sandbox without the masks reaches it on this host, so the masks are what blocks it.
    const control = JSON.parse(await unmasked(["python3", "-c", CONNECT, RESOLVER[0]!])) as Record<string, unknown>;
    console.log(`[sockets] resolver from a sandbox without the masks: ${JSON.stringify(control)}`);
    expect(control[RESOLVER[0]!]).toBe("reached");
    const { handle } = await open();
    const inside = await python(handle, CONNECT, RESOLVER);
    console.log(`[sockets] resolver from a sandbox: ${JSON.stringify(inside)}`);
    expect(reached(inside)).toEqual([]);
    expect(Object.keys(inside).filter((k) => k.endsWith("ResolveHostname"))).toEqual([]);
  });

  it("finds no unix socket anywhere it can see", { timeout: 240_000 }, async () => {
    const control = JSON.parse(await unmasked(["python3", "-c", WALK], 100_000)) as Record<string, unknown>;
    console.log(`[sockets] walk of a sandbox without the masks: ${JSON.stringify(control)}`);
    expect(control["sockets"]).toContain(RESOLVER[0]);
    const { handle } = await open();
    const walk = await python(handle, WALK, [], 100_000);
    console.log(`[sockets] walk of a sandbox: ${JSON.stringify(walk)}`);
    expect(walk["cut"], "the walk ran out of time").toBe(false);
    expect(walk["walked"] as number).toBeGreaterThan(1000);
    expect(walk["sockets"]).toEqual([]);
  });

  it("cannot connect to a socket listening in the host's runtime directory, and a grant there is refused by name", async (ctx) => {
    const place = runtimeDir();
    if (typeof place === "string") {
      console.log(`[sockets] runtime-directory decoy skipped: ${place}`);
      ctx.skip();
      return;
    }
    const path = join(place.dir, "decoy.sock");
    const d = await decoy(path);
    const link = join(mkdtempSync(join(tmpdir(), "mandate-link-")), "runtime");
    try {
      expect(await reachFromHost(path), "the host cannot reach its own decoy").toBe(true);
      const before = d.hits();
      const { handle } = await open();
      const inside = await python(handle, CONNECT, [path]);
      console.log(`[sockets] decoy at ${path} from a sandbox: ${JSON.stringify(inside)}`);
      expect(reached(inside)).toEqual([]);
      expect(d.hits()).toBe(before);
      if (place.dir.startsWith("/run/")) {
        const planned = await adapter(host).plan(requirement({ read: [place.dir] }));
        expect(planned).toEqual({ unsupported: [`a path under /run, which this host keeps out of every sandbox: ${place.dir}`] });
        // Another name for the same directory passes the check by name, and is refused before a process starts.
        symlinkSync(place.dir, link);
        const viaLink = await sandbox(host, requirement({ read: [link], exec: [{ command: "python3" }] }));
        const r = await host.execute(viaLink.handle, { argv: ["python3", "-c", CONNECT, join(link, "decoy.sock")] });
        console.log(`[sockets] decoy through a link to its directory: exit ${r.exitCode}, ${r.stderr.trim()}`);
        expect(r).toMatchObject({ exitCode: 126, stdout: "" });
        expect(r.stderr).toContain(`${link} leads to /run`);
        expect(d.hits()).toBe(before);
      }
    } finally {
      await d.close();
      place.remove();
      rmSync(dirname(link), { recursive: true, force: true });
    }
  });

  it("cannot connect to an abstract socket of the host: it has a network namespace of its own", async () => {
    const name = `mandate-decoy-${randomUUID()}`;
    const d = await decoy(`\0${name}`);
    try {
      expect(await reachFromHost(`\0${name}`), "the host cannot reach its own abstract decoy").toBe(true);
      const before = d.hits();
      const { handle } = await open();
      const inside = await python(handle, CONNECT, [`@${name}`]);
      console.log(`[sockets] abstract decoy from a sandbox: ${JSON.stringify(inside)}`);
      expect(inside[`@${name}`]).toBe("ConnectionRefusedError");
      expect(d.hits()).toBe(before);
    } finally {
      await d.close();
    }
  });

  it("shows no runtime directory through a grant of the directory that holds one", async () => {
    const { handle } = await open(["/var"]);
    const inside = await python(handle, CONNECT, RESOLVER);
    console.log(`[sockets] resolver from a sandbox that reads /var: ${JSON.stringify(inside)}`);
    expect(reached(inside)).toEqual([]);
  });
});

describe.runIf(REAL)("an agent loop in a Bubblewrap sandbox (P1-8)", () => {
  afterAll(closeAll);

  it("does its work through the real sandbox, and what it may not do does not happen", async () => {
    const root = mkdtempSync(join(tmpdir(), "mandate-loop-"));
    const repo = join(root, "repo");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const bug = true;\n");
    const src = `mandate @ 0.2

module sandboxed @ 0.1

use std.{fs, model, exec}

capability RepoRead = fs.read(${JSON.stringify(repo)})
capability SrcWrite = fs.write(${JSON.stringify(join(repo, "src"))})
capability Lister   = exec(commands: ["ls"], args_prefix: [["-la"]])
capability ModelStd = model.infer(tier: standard)

agent Fixer {
  caps   RepoRead, SrcWrite, Lister, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 6 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Exec, Model}
}

workflow Fix(task: Text) -> Inferred<Text>
  caps   RepoRead, SrcWrite, Lister, ModelStd
  budget { spend: 2 USD }
{
  delegate Fixer.apply(task)
}
`;
    const w = await world(src);
    const host = new MxcHost();
    const chat = new SimChat((_r, n) =>
      [
        [toolUse("t1", "read_file", { path: join(repo, "src", "a.ts") }), toolUse("t2", "run", { command: "ls", args: ["-la", repo] })],
        [toolUse("t3", "write_file", { path: join(repo, "src", "a.ts"), content: "export const bug = false;\n" }), toolUse("t4", "write_file", { path: join(repo, "test", "a.test.ts"), content: "x" })],
        [toolUse("t5", "finish", { result: "fixed" })],
      ][n - 1]!,
    );
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "mx1" });
    expect(run.state, JSON.stringify(run.error)).toBe("succeeded");
    expect(readFileSync(join(repo, "src", "a.ts"), "utf8")).toBe("export const bug = false;\n");
    expect(existsSync(join(repo, "test", "a.test.ts"))).toBe(false);
    const second = JSON.stringify(chat.calls[1]!.messages);
    expect(second).toContain("export const bug = true;");
    expect(second).toContain("a.ts");
    expect(JSON.stringify(chat.calls[2]!.messages.at(-1))).toContain("outside what you may write");
    rmSync(root, { recursive: true, force: true });
  });
});
