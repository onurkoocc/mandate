// The Windows sandbox host (P2-27, K16): MXC with the AppContainer process
// container.
//
// The first part runs everywhere, against a fake SDK: the build thresholds,
// session isolation refused by name (it cannot block the network), what the
// host asks MXC for, and learning mode's denials.
//
// The second part runs only on Windows with MANDATE_MXC=1. It repeats P1-8's
// blocking tests against a real AppContainer: a write outside the grant does
// not reach the host, a read outside it sees nothing, no host can be reached
// (G07), the runtime's environment and the user's clipboard stay out, and an
// agent loop does its work through the sandbox.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { denialDiagnostics, requirementFor, type SandboxRequirement } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { MxcAdapter, type MxcPolicy } from "../src/sandbox.js";
import { WindowsMxcHost, winQuote, type WindowsContainerRequest, type WindowsMxcSdk } from "../src/mxc-windows.js";
import { SimChat, toolUse } from "../src/sim.js";
import { WRITE_SCRIPT } from "../src/tools.js";
import { closeAll, world } from "./helpers.js";

const fwd = (p: string) => p.replace(/\\/g, "/");

function requirement(o: { read?: string[]; write?: string[]; exec?: Array<{ command: string; args_prefix?: string[][] }>; hosts?: string[] } = {}): SandboxRequirement {
  const caps = [
    ...(o.read?.length ? [{ ctor: "fs.read", effect: "Fs.Read", write: false, scope: o.read }] : []),
    ...(o.write?.length ? [{ ctor: "fs.write", effect: "Fs.Write", write: true, scope: o.write }] : []),
    ...(o.exec ?? []).map((e) => ({ ctor: "exec", effect: "Exec", write: false, scope: [e.command], ...(e.args_prefix ? { argsPrefix: e.args_prefix } : {}) })),
    ...(o.hosts?.length ? [{ ctor: "net.https", effect: "Net", write: false, scope: o.hosts }] : []),
    { ctor: "model.infer", effect: "Model", write: false, tier: "standard", maxClass: "internal" as const },
  ];
  return requirementFor({ agent: "A", def: "sha256:test" }, caps as never, 60_000);
}

class FakeSdk implements WindowsMxcSdk {
  readonly runs: WindowsContainerRequest[] = [];
  report: string | undefined;
  constructor(private readonly methods = ["processcontainer", "isolation_session"]) {}
  getPlatformSupport() {
    return { isSupported: true, availableMethods: this.methods };
  }
  getAvailableBackends() {
    return [{ backend: "processcontainer", capabilities: ["captureDenials"] }];
  }
  async run(request: WindowsContainerRequest) {
    this.runs.push(request);
    const outputPath = request.containment.config.captureDenials?.outputPath;
    if (outputPath && this.report) writeFileSync(outputPath, this.report);
    return { stdout: "ok\n", stderr: "", exitCode: 0, timedOut: false, ...(outputPath ? { outputMetadata: { captureDenials: { outputPath, totalDenials: 1 } } } : {}) };
  }
}

const adapter = (host: WindowsMxcHost, mode?: "learning", isolation?: string) => new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true, ...(mode ? { mode } : {}), ...(isolation ? { isolation } : {}) });

async function sandbox(host: WindowsMxcHost, req: SandboxRequirement, mode?: "learning"): Promise<{ handle: string; policy: MxcPolicy }> {
  const planned = await adapter(host, mode).plan(req);
  if ("unsupported" in planned) throw new Error(`refused: ${planned.unsupported.join("; ")}`);
  return { handle: await host.create(planned.policy), policy: planned.policy };
}

const NEW = { build: 26100, ubr: 9550 };

describe("WindowsMxcHost against a fake SDK", () => {
  it("refuses every agent on a build older than the AppContainer threshold (G05)", async () => {
    const host = new WindowsMxcHost({ sdk: new FakeSdk(), build: { build: 26100, ubr: 9277 } });
    expect(await adapter(host).plan(requirement({ read: ["C:/work/repo"] }))).toMatchObject({ unsupported: expect.arrayContaining(["isolation backend process", "blocking outbound network"]) });
    expect(host.unavailable).toContain("older than 26100.9278");
  });

  it("refuses session isolation by name: it cannot keep an agent off the network (INV-11)", async () => {
    const host = new WindowsMxcHost({ sdk: new FakeSdk(), build: NEW, backend: "session" });
    expect(await adapter(host, undefined, "session").plan(requirement({ read: ["C:/work/repo"] }))).toEqual({ unsupported: ["blocking outbound network"] });
  });

  it("asks MXC for an AppContainer with the policy's paths, no network, an isolated desktop and a clean environment", async () => {
    const sdk = new FakeSdk();
    const host = new WindowsMxcHost({ sdk, build: NEW, toolchain: ["C:\\Program Files\\nodejs"], commands: { node: "C:\\Program Files\\nodejs\\node.exe" } });
    const { handle } = await sandbox(host, requirement({ read: ["C:/work/repo"], write: ["C:/work/repo/src"], exec: [{ command: "node", args_prefix: [["--test"]] }] }));
    process.env["MANDATE_CANARY_KEY"] = "sk-canary";
    expect((await host.execute(handle, { argv: ["node", "--test", "a test.mjs"], cwd: "C:/work/repo" })).exitCode).toBe(0);
    const [r] = sdk.runs;
    expect(r!.command).toBe('"C:\\Program Files\\nodejs\\node.exe" --test "a test.mjs"');
    expect(r!.filesystem.readonlyPaths).toEqual(expect.arrayContaining(["C:\\Program Files\\nodejs", "C:\\work\\repo"]));
    expect(r!.filesystem.readwritePaths).toEqual([expect.stringContaining("mandate-wxc-"), "C:\\work\\repo\\src"]);
    expect(r!.network).toEqual({ egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } });
    expect(r!.ui).toEqual({ disable: false, clipboard: "none", allowInputInjection: false });
    expect(r!.containment).toEqual({ type: "processcontainer", config: { ui: { isolation: "container", desktopSystemControl: false, systemSettings: "none", ime: false } } });
    expect(r!.inheritDefaultEnvironment).toBe(false);
    expect(Object.keys(r!.environment).sort()).toEqual(["ComSpec", "LOCALAPPDATA", "NODE_OPTIONS", "PATH", "PATHEXT", "SystemDrive", "SystemRoot", "TEMP", "TMP", "windir"]);
    expect(JSON.stringify(r!.environment)).not.toContain("sk-canary");
    expect(r!.workingDirectory).toBe("C:\\work\\repo");
    expect(r!.timeoutMs).toBe(60_000);
  });

  it("runs the file tools through its helper, stages a write's content, and refuses what the policy does not allow", async () => {
    const sdk = new FakeSdk();
    const host = new WindowsMxcHost({ sdk, build: NEW, commands: { node: "node.exe" } });
    const { handle } = await sandbox(host, requirement({ read: ["C:/work/repo"], write: ["C:/work/repo/src"] }));
    await host.execute(handle, { argv: ["cat", "--", "C:/work/repo/a.ts"] });
    await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", "C:/work/repo/src/b.ts"], stdin: "fixed" });
    expect(sdk.runs[0]!.command).toMatch(/^node\.exe .*sandbox-helper\.mjs"? cat C:\\work\\repo\\a\.ts$/);
    expect(sdk.runs[1]!.command).toMatch(/sandbox-helper\.mjs"? write .*mandate-stage-.*content"? C:\\work\\repo\\src\\b\.ts$/);
    expect(sdk.runs[1]!.filesystem.readonlyPaths.some((p) => p.includes("mandate-stage-"))).toBe(true);
    const refused = async (argv: string[]) => (await host.execute(handle, { argv })).stderr;
    expect(await refused(["curl", "https://example.com"])).toContain("curl is not an allowed command");
    expect(await refused(["cat", "C:/Windows/win.ini"])).toContain("outside this sandbox's paths");
    expect(await refused(["sh", "-c", WRITE_SCRIPT, "sh", "C:/work/repo/test/x"])).toContain("outside this sandbox's write paths");
    expect(sdk.runs).toHaveLength(2);
    expect(winQuote('a "b" c\\')).toBe('"a \\"b\\" c\\\\"');
  });

  it("records what the policy denied in learning mode, without the toolchain's own start-up (W0311)", async () => {
    const sdk = new FakeSdk();
    sdk.report = JSON.stringify({
      denials: [
        { resource: "C:\\work\\secrets\\.env", resourceType: "file", accessType: "read" },
        { resource: "C:\\Program Files\\nodejs\\node.exe", resourceType: "file", accessType: "read" },
        { resource: "\\REGISTRY\\USER\\S-1-5-21\\Console", resourceType: "other", accessType: "read" },
      ],
    });
    const host = new WindowsMxcHost({ sdk, build: NEW, toolchain: ["C:\\Program Files\\nodejs"], commands: { node: "node.exe" } });
    const { handle, policy } = await sandbox(host, requirement({ read: ["C:/work/repo"] }), "learning");
    expect(policy.mode).toBe("learning");
    await host.execute(handle, { argv: ["cat", "--", "C:/work/repo/a.ts"] });
    expect(sdk.runs[0]!.containment.config.captureDenials).toMatchObject({ mode: "block" });
    expect(await host.collect(handle)).toEqual({ denials: [{ resource: "C:\\work\\secrets\\.env", access: "read", kind: "file" }] });
  });
});

const REAL = process.platform === "win32" && process.env["MANDATE_MXC"] === "1";

describe.runIf(REAL)("WindowsMxcHost with an AppContainer on this host (G05, G07)", () => {
  const root = mkdtempSync(join(tmpdir(), "mandate-wxc-test-"));
  const repo = join(root, "repo");
  const outside = join(root, "outside");
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), "bug\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const host = new WindowsMxcHost();
  const open = () => sandbox(host, requirement({ read: [fwd(repo)], write: [fwd(join(repo, "src"))], exec: [{ command: "node", args_prefix: [["-e"]] }] }));
  const node = (handle: string, code: string) => host.execute(handle, { argv: ["node", "-e", code], cwd: fwd(repo) });

  it("probes the process container as enforceable", async () => {
    const can = await host.probe();
    expect(can, host.unavailable).toMatchObject({ backends: ["process"], filesystem: true, network: "deny_all", exec: "args_prefix", ui: true });
  });

  it("reads, lists, searches and writes inside the granted paths", async () => {
    const { handle } = await open();
    const cat = await host.execute(handle, { argv: ["cat", "--", fwd(join(repo, "src", "a.ts"))] });
    expect(cat.stdout, cat.stderr).toBe("bug\n");
    expect((await host.execute(handle, { argv: ["ls", "-1Ap", "--", fwd(repo)] })).stdout).toBe("src/\ntest/\n");
    expect((await host.execute(handle, { argv: ["grep", "-rnI", "--", "bu.", fwd(join(repo, "src"))] })).stdout).toBe(`${fwd(join(repo, "src", "a.ts"))}:1:bug\n`);
    const w = await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", fwd(join(repo, "src", "deep", "b.ts"))], stdin: "fixed\n" });
    expect(w, w.stderr).toMatchObject({ exitCode: 0 });
    expect(readFileSync(join(repo, "src", "deep", "b.ts"), "utf8")).toBe("fixed\n");
  });

  it("blocks a write outside the granted write paths, even from a program the agent may run", async () => {
    const { handle } = await open();
    const r = await node(handle, `require('fs').writeFileSync(${JSON.stringify(join(outside, "copied"))}, 'x'); require('fs').writeFileSync(${JSON.stringify(join(repo, "test", "x.ts"))}, 'x')`);
    expect(r.exitCode).not.toBe(0);
    expect(existsSync(join(outside, "copied"))).toBe(false);
    expect(existsSync(join(repo, "test", "x.ts"))).toBe(false);
    expect((await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", fwd(join(repo, "test", "y.ts"))], stdin: "x" })).exitCode).toBe(126);
  });

  it("shows nothing outside the granted paths", async () => {
    const { handle } = await open();
    const r = await node(handle, `try { console.log(require('fs').readFileSync(${JSON.stringify(join(outside, "secret.txt"))}, 'utf8')) } catch (e) { console.log('denied', e.code) }`);
    expect(r.stdout).not.toContain("secret");
    expect(r.stdout).toContain("denied");
  });

  it("reaches no host, while the host itself can (G07)", async () => {
    const hostReaches = await fetch("https://example.com").then(
      () => true,
      () => false,
    );
    const { handle } = await open();
    const r = await node(handle, "Promise.all(['https://example.com','http://1.1.1.1'].map((u)=>fetch(u).then(()=>'reached '+u,(e)=>'blocked '+u))).then((x)=>console.log(x.join(';')))");
    expect(r.stdout).toContain("blocked https://example.com");
    expect(r.stdout).toContain("blocked http://1.1.1.1");
    expect(r.stdout).not.toContain("reached");
    expect(hostReaches, "the test host has no network, so blocking proves less").toBe(true);
  });

  it("starts the process with none of the runtime's environment, and keeps the user's clipboard out (K7)", async () => {
    process.env["MANDATE_CANARY_KEY"] = "sk-canary";
    const { handle } = await open();
    const r = await node(handle, "console.log(JSON.stringify(process.env))");
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).not.toContain("sk-canary");
    expect(r.stdout).not.toMatch(/CLAUDE_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|USERPROFILE/);
    // The user's clipboard holds something; a program in the sandbox asks for it.
    execFileSync("powershell.exe", ["-NoProfile", "-Command", "Set-Clipboard -Value 'clipboard-canary'"]);
    const psHost = new WindowsMxcHost({ commands: { powershell: join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") } });
    const ps = await sandbox(psHost, requirement({ read: [fwd(repo)], exec: [{ command: "powershell", args_prefix: [["-NoProfile"]] }] }));
    const clip = await psHost.execute(ps.handle, { argv: ["powershell", "-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::GetText()"] });
    expect(clip.stdout).not.toContain("clipboard-canary");
    expect(`${clip.stdout}${clip.stderr}`).toMatch(/Clipboard operation did not succeed|denied/i);
  });
});

describe.runIf(REAL)("an agent loop in an AppContainer (P2-27)", () => {
  afterAll(closeAll);

  it("does its work through the real sandbox, and what it may not do does not happen", async () => {
    const root = mkdtempSync(join(tmpdir(), "mandate-wxc-loop-"));
    const repo = fwd(join(root, "repo"));
    mkdirSync(join(root, "repo", "src"), { recursive: true });
    mkdirSync(join(root, "repo", "test"), { recursive: true });
    writeFileSync(join(root, "repo", "src", "a.mjs"), "export const bug = true;\n");
    writeFileSync(join(root, "repo", "test", "a.test.mjs"), 'import { test } from "node:test"; import assert from "node:assert/strict"; import { bug } from "../src/a.mjs";\ntest("fixed", () => assert.equal(bug, false));\n');
    const src = `mandate @ 0.2

module sandboxed @ 0.1

use std.{fs, model, exec}

capability RepoRead = fs.read(${JSON.stringify(repo)})
capability SrcWrite = fs.write(${JSON.stringify(`${repo}/src`)})
capability Tests    = exec(commands: ["node"], args_prefix: [["--test"]])
capability ModelStd = model.infer(tier: standard)

agent Fixer {
  caps   RepoRead, SrcWrite, Tests, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 6 }
  skill apply(task: Text) -> Inferred<Text> ! {Fs.Read, Fs.Write, Exec, Model}
}

workflow Fix(task: Text) -> Inferred<Text>
  caps   RepoRead, SrcWrite, Tests, ModelStd
  budget { spend: 2 USD }
{
  delegate Fixer.apply(task)
}
`;
    const w = await world(src);
    const host = new WindowsMxcHost();
    const chat = new SimChat((_r, n) =>
      [
        [toolUse("t1", "read_file", { path: "src/a.mjs" }), toolUse("t2", "list_dir", { path: "." })],
        [toolUse("t3", "write_file", { path: "src/a.mjs", content: "export const bug = false;\n" }), toolUse("t4", "write_file", { path: "test/a.test.mjs", content: "x" })],
        [toolUse("t5", "run", { command: "node", args: ["--test", "test/a.test.mjs"] })],
        [toolUse("t6", "finish", { result: "fixed" })],
      ][n - 1]!,
    );
    w.adapters.loop = { chat, sandbox: new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true }) };
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Fix", input: { task: "t" }, runId: "wx1" });
    expect(run.state, JSON.stringify(run.error)).toBe("succeeded");
    expect(readFileSync(join(root, "repo", "src", "a.mjs"), "utf8")).toBe("export const bug = false;\n");
    expect(readFileSync(join(root, "repo", "test", "a.test.mjs"), "utf8")).toContain("assert.equal(bug, false)");
    const second = JSON.stringify(chat.calls[1]!.messages);
    expect(second).toContain("export const bug = true;");
    expect(second).toContain("src/");
    expect(JSON.stringify(chat.calls[2]!.messages.at(-1))).toContain("outside what you may write");
    expect(JSON.stringify(chat.calls[3]!.messages.at(-1))).toContain("pass 1");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("learning mode, from a run to W0311 (§11.3, §16.1 Collect)", () => {
  afterAll(closeAll);

  it("carries what the sandbox denied from the loop to the run's report, and the compiler turns it into W0311", async () => {
    const src = `mandate @ 0.2

module learning @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("C:/work/repo")
capability ModelStd = model.infer(tier: standard)

agent Reader {
  caps   RepoRead, ModelStd
  budget { tokens: 100k, spend: 1 USD, steps: 6 }
  skill look(task: Text) -> Inferred<Text> ! {Fs.Read, Model}
}

workflow Look(task: Text) -> Inferred<Text>
  caps   RepoRead, ModelStd
  budget { spend: 2 USD }
{
  delegate Reader.look(task)
}
`;
    const w = await world(src);
    const sdk = new FakeSdk();
    sdk.report = JSON.stringify({ denials: [{ resource: "C:\work\secrets\.env", resourceType: "file", accessType: "read" }] });
    const host = new WindowsMxcHost({ sdk, build: NEW, commands: { node: "node.exe" } });
    const chat = new SimChat((_r, n) => (n === 1 ? [toolUse("t1", "read_file", { path: "C:/work/repo/a.ts" })] : [toolUse("t2", "finish", { result: "looked" })]));
    w.adapters.loop = { chat, sandbox: adapter(host, "learning") };
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Look", input: { task: "t" }, runId: "lm1" })).state).toBe("succeeded");
    const report = await w.rt.sandboxDenials("lm1");
    expect(report).toEqual({ format: "mandate/sandbox-denials/0.1", program: w.pkg.programHash, denials: [{ agent: "Reader", resource: "C:\work\secrets\.env", access: "read" }] });
    const diags = denialDiagnostics(w.pkg.program, report);
    expect(diags.map((d) => [d.code, d.at.path])).toEqual([["MDT-W0311", "/defs/Reader/caps"]]);
    expect(diags[0]!.message).toContain("denied read of C:\work\secrets\.env");
    // A report for another program is not applied to this one.
    expect(denialDiagnostics(w.pkg.program, { ...report, program: "sha256:other" }).map((d) => d.code)).toEqual(["MDT-E0104"]);
  });
});

describe.runIf(REAL)("learning mode in a real AppContainer (W0311)", () => {
  it("keeps a denied read denied, and records it; a host that cannot capture denials refuses learning mode by name", async () => {
    const root = mkdtempSync(join(tmpdir(), "mandate-wxc-learn-"));
    mkdirSync(join(root, "repo"));
    writeFileSync(join(root, "secret.txt"), "secret\n");
    const host = new WindowsMxcHost();
    if (!(await host.probe()).modes.includes("learning")) {
      // INV-11: without learning mode, a requirement for it is refused by name, never run as plain enforcement.
      expect(await adapter(host, "learning").plan(requirement({ read: [fwd(join(root, "repo"))] }))).toEqual({ unsupported: ["mode learning"] });
      rmSync(root, { recursive: true, force: true });
      return;
    }
    const { handle } = await sandbox(host, requirement({ read: [fwd(join(root, "repo"))], exec: [{ command: "node", args_prefix: [["-e"]] }] }), "learning");
    const r = await host.execute(handle, { argv: ["node", "-e", `try { require('fs').readFileSync(${JSON.stringify(join(root, "secret.txt"))}); console.log('READ') } catch (e) { console.log('denied', e.code) }`] });
    expect(r.stdout).toContain("denied");
    const { denials } = await host.collect(handle);
    expect(denials).toContainEqual({ resource: join(root, "secret.txt"), access: "read", kind: "file" });
    await host.destroy(handle);
    rmSync(root, { recursive: true, force: true });
  });
});
