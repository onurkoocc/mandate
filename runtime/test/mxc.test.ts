// The real sandbox host (P1-8, K7, K16): MXC with Bubblewrap on Linux.
//
// The first part runs everywhere, against a fake SDK: what the host asks MXC
// for, what it refuses without starting a process, and what a host where
// Bubblewrap cannot run enforces (nothing, so every agent is refused, G05).
//
// The second part runs only on Linux with MANDATE_MXC=1 (CI's `sandbox` job,
// after installing bubblewrap and enabling user namespaces). It checks the
// blocking itself: a write outside the granted paths does not reach the host,
// a read outside them sees nothing, and no host can be reached (G05, G07).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { requirementFor, type SandboxRequirement } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { MxcHost, shellQuote, type MxcContainerRequest, type MxcSdk } from "../src/mxc.js";
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
  readonly stdin: string[] = [];
  constructor(private readonly support: ReturnType<MxcSdk["getPlatformSupport"]> = { isSupported: true, availableMethods: ["bubblewrap", "lxc"] }) {}
  getPlatformSupport() {
    return this.support;
  }
  async spawn(request: MxcContainerRequest) {
    this.spawned.push(request);
    const input = new PassThrough();
    const out = new PassThrough();
    const err = new PassThrough();
    let text = "";
    input.on("data", (c) => (text += String(c)));
    input.on("end", () => {
      this.stdin.push(text);
      out.end("ok\n");
      err.end();
    });
    return { standardInput: input, standardOutput: out, standardError: err, wait: async () => ({ exitCode: 0, timedOut: false }), dispose: () => {} };
  }
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
      filesystem: { readonlyPaths: ["/opt/node", "/work/repo"], readwritePaths: ["/work/repo/src"] },
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

  it("starts the process with none of the runtime's environment, so no key reaches it (K7)", async () => {
    process.env["MANDATE_CANARY_KEY"] = "sk-canary";
    const { handle } = await open();
    const r = await host.execute(handle, { argv: ["env"] });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toContain("sk-canary");
    expect(r.stdout).not.toMatch(/CLAUDE_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN/);
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
