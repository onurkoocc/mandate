// The container sandbox host (design doc 9 §4; K61): an agent's tools and a
// component's toolchain in a container with no network.
//
// The first part runs everywhere, against a fake Docker: what the host asks
// Docker for, what it refuses without starting a process, one container per
// image for the sandbox's life, and Stop.
//
// The second part runs only with MANDATE_CONTAINER=1 and a Linux Docker
// engine. It checks the blocking itself: an agent's tools read, list, search
// and write inside the granted paths; a write outside them is refused before
// anything runs, a read-only path cannot be written from inside, no host can
// be reached, and a hung process is killed at its timeout (G05, G07).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Docker } from "../src/boundary.js";
import { ContainerHost } from "../src/container.js";
import type { MxcPolicy } from "../src/sandbox.js";
import { WRITE_SCRIPT } from "../src/tools.js";

function policy(o: { read?: string[]; write?: string[]; exec?: Array<{ command: string; argsPrefix?: string[][] }>; timeoutSeconds?: number } = {}): MxcPolicy {
  return {
    $generator: "test",
    $source: "test",
    version: "0.9.0",
    isolation: "container",
    filesystem: { readOnly: o.read ?? [], readWrite: o.write ?? [] },
    network: { allowOutbound: false, allowedHosts: [] },
    process: { allowedCommands: o.exec ?? [] },
    ui: { allowDesktop: false, allowClipboard: false },
    timeoutSeconds: o.timeoutSeconds ?? null,
    mode: "enforcement",
  };
}

class FakeDocker implements Docker {
  readonly calls: Array<{ args: string[]; input?: string }> = [];
  async run(args: string[], o: { input?: string } = {}) {
    this.calls.push({ args, ...(o.input !== undefined ? { input: o.input } : {}) });
    if (args[0] === "run") return { exitCode: 0, stdout: "id\n", stderr: "" };
    return { exitCode: 0, stdout: "ok\n", stderr: "" };
  }
}

describe("ContainerHost against a fake Docker", () => {
  const root = mkdtempSync(join(tmpdir(), "mandate-ctr-"));
  const src = join(root, "src").replace(/\\/g, "/");
  mkdirSync(src, { recursive: true });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("runs the tool helpers inside the granted paths, in one container kept for the sandbox's life", async () => {
    const docker = new FakeDocker();
    const host = new ContainerHost({ images: { npm: "node:22-slim" }, docker });
    const h = await host.create(policy({ read: [root.replace(/\\/g, "/")], write: [src] }));
    expect((await host.execute(h, { argv: ["cat", "--", `${src}/a.ts`] })).exitCode).toBe(0);
    expect((await host.execute(h, { argv: ["ls", "-1Ap", "--", src] })).exitCode).toBe(0);
    const w = await host.execute(h, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", `${src}/b.ts`], stdin: "export {};\n" });
    expect(w.exitCode).toBe(0);
    const starts = docker.calls.filter((c) => c.args[0] === "run");
    expect(starts).toHaveLength(1);
    const start = starts[0]!.args;
    expect(start).toEqual(expect.arrayContaining(["--network", "none", "--cap-drop", "ALL", "--read-only", "--entrypoint", "sleep", "debian:bookworm-slim", "infinity"]));
    // The write path is mounted writable, the read path read-only.
    expect(start.some((a) => a.includes(`source=${src},target=/m/0`) && !a.includes("readonly"))).toBe(true);
    expect(start.some((a) => a.endsWith("readonly") && a.includes("target=/m/1"))).toBe(true);
    const write = docker.calls.find((c) => c.args.includes(WRITE_SCRIPT))!;
    expect(write.input).toBe("export {};\n");
    expect(write.args.slice(-1)[0]).toBe("/m/0/b.ts");
  });

  it("refuses a write outside the write paths and a command not granted, before Docker is asked", async () => {
    const docker = new FakeDocker();
    const host = new ContainerHost({ images: { npm: "node:22-slim", git: "alpine/git" }, docker });
    const h = await host.create(policy({ read: [root.replace(/\\/g, "/")], write: [src], exec: [{ command: "npm", argsPrefix: [["test"]] }] }));
    expect((await host.execute(h, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", `${root.replace(/\\/g, "/")}/x.ts`], stdin: "" })).exitCode).toBe(126);
    expect((await host.execute(h, { argv: ["git", "push"] })).exitCode).toBe(126);
    expect((await host.execute(h, { argv: ["npm", "install", "left-pad"] })).exitCode).toBe(126);
    expect((await host.execute(h, { argv: ["cat", "--", "/etc/passwd"] })).exitCode).toBe(126);
    expect(docker.calls).toEqual([]);
  });

  it("mounts a link's target read-only in its place only inside the policy or a configured link target", async () => {
    const deps = mkdtempSync(join(tmpdir(), "mandate-deps-"));
    const repo = join(root, "linked");
    mkdirSync(repo, { recursive: true });
    symlinkSync(deps, join(repo, "node_modules"), "junction");
    const at = repo.replace(/\\/g, "/");
    const without = new FakeDocker();
    const a = new ContainerHost({ images: { npm: "node:22-slim" }, docker: without });
    await a.execute(await a.create(policy({ write: [at], exec: [{ command: "npm", argsPrefix: [["test"]] }] })), { argv: ["npm", "test"], cwd: at });
    expect(without.calls[0]!.args.some((x) => x.includes("/node_modules,readonly"))).toBe(false);
    const withDeps = new FakeDocker();
    const b = new ContainerHost({ images: { npm: "node:22-slim" }, linkTargets: [deps], docker: withDeps });
    await b.execute(await b.create(policy({ write: [at], exec: [{ command: "npm", argsPrefix: [["test"]] }] })), { argv: ["npm", "test"], cwd: at });
    expect(withDeps.calls[0]!.args.some((x) => x.endsWith("target=/m/0/node_modules,readonly"))).toBe(true);
    rmSync(deps, { recursive: true, force: true });
  });

  it("kills a process at its timeout inside the container, and Stop removes the containers", async () => {
    const docker = new FakeDocker();
    const host = new ContainerHost({ images: { npm: "node:22-slim" }, imageFor: (c, cwd) => (c === "npm" && cwd?.endsWith("/src") ? "app-test:1" : undefined), docker });
    const h = await host.create(policy({ write: [src], exec: [{ command: "npm", argsPrefix: [["test"]] }], timeoutSeconds: 5 }));
    await host.execute(h, { argv: ["npm", "test"], cwd: src });
    const exec = docker.calls.find((c) => c.args[0] === "exec")!.args;
    expect(exec.slice(exec.indexOf("timeout"), exec.indexOf("timeout") + 5)).toEqual(["timeout", "-s", "KILL", "5", "npm"]);
    expect(docker.calls.find((c) => c.args[0] === "run")!.args).toContain("app-test:1");
    expect(await host.stop(h)).toBe("stopped");
    expect(docker.calls.some((c) => c.args[0] === "rm" && c.args[1] === "-f")).toBe(true);
    const after = await host.execute(h, { argv: ["npm", "test"], cwd: src });
    expect(after).toMatchObject({ exitCode: 126, stopped: true });
  });
});

describe.runIf(process.env["MANDATE_CONTAINER"] === "1")("ContainerHost on a real Docker engine", () => {
  const root = mkdtempSync(join(tmpdir(), "mandate-ctr-live-"));
  const repo = join(root, "repo").replace(/\\/g, "/");
  const src = `${repo}/src`;
  mkdirSync(src, { recursive: true });
  writeFileSync(join(repo, "README.md"), "kept\n");
  writeFileSync(join(src, "a.ts"), "export const a = 1;\n");
  const host = new ContainerHost({ images: { node: "node:22-slim" } });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("an agent's tools work inside the grant, and nothing else does", async () => {
    expect((await host.probe()).network).toBe("deny_all");
    const h = await host.create(policy({ read: [repo], write: [src], exec: [{ command: "node", argsPrefix: [["-e"]] }], timeoutSeconds: 20 }));
    try {
      expect((await host.execute(h, { argv: ["cat", "--", `${src}/a.ts`] })).stdout).toContain("export const a");
      expect((await host.execute(h, { argv: ["grep", "-rnI", "--", "const a", repo] })).stdout).toContain("a.ts:1");
      expect((await host.execute(h, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", `${src}/deep/b.ts`], stdin: "export const b = 2;\n" })).exitCode).toBe(0);
      expect(readFileSync(join(src, "deep", "b.ts"), "utf8")).toBe("export const b = 2;\n");
      // The read-only part of the grant cannot be written from inside, even by an allowed command.
      const ro = await host.execute(h, { argv: ["node", "-e", `require("fs").writeFileSync("${repo}/README.md", "changed")`], cwd: repo });
      expect(ro.exitCode).not.toBe(0);
      expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("kept\n");
      // No network.
      const net = await host.execute(h, { argv: ["node", "-e", "require('dns').lookup('example.com',(e)=>{console.log(e?'NO':'YES')})"], cwd: repo });
      expect(net.stdout).toContain("NO");
      // A grant whose first path is a file still runs tools: the working directory is a directory of the grant.
      const h2 = await host.create(policy({ read: [repo], write: [`${repo}/README.md`] }));
      try {
        expect((await host.execute(h2, { argv: ["ls", "-1Ap", "--", src] })).exitCode).toBe(0);
      } finally {
        await host.destroy(h2);
      }
      // A hung process is killed at its timeout.
      const hung = await host.execute(h, { argv: ["node", "-e", "setInterval(()=>{},1000)"], cwd: repo, timeoutMs: 3000 });
      expect(hung.timedOut).toBe(true);
    } finally {
      await host.destroy(h);
    }
  }, 300_000);
});
