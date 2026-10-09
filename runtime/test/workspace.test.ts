// The multi-repo workspace (design doc 9 §12; BACKLOG item 31, B3): a run
// that works on components starts from one base commit per component, and
// its manifest hash R covers them; one live run holds a working copy at a
// time; each delegate's sandbox sees only its components. The last part
// runs the two agents in real sandboxes (MANDATE_MXC=1: Bubblewrap on Linux,
// an AppContainer on Windows).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import type { TurnRequest } from "../src/adapters.js";
import { MxcHost } from "../src/mxc.js";
import { WindowsMxcHost } from "../src/mxc-windows.js";
import { buildPackage, Runtime } from "../src/runtime.js";
import { makeWritable, MxcAdapter, type MxcPolicy, type SandboxHost } from "../src/sandbox.js";
import { SimChat, toolUse, type SimTurn } from "../src/sim.js";
import { WRITE_SCRIPT } from "../src/tools.js";
import { runView } from "../src/views.js";
import { GitWorkspace } from "../src/workspace.js";
import { closeAll, world } from "./helpers.js";
import { KERVAN_SOURCE, kervanModules, lockFor, TWO_COMPONENTS } from "./kervan.js";

afterAll(closeAll);

const fwd = (p: string): string => p.replace(/\\/g, "/");

/** Kervan's model with mcp and core checked out under `dir` instead of /work. */
function kervanAt(dir: string): string {
  return KERVAN_SOURCE.replace('"/work/kervan-mcp"', JSON.stringify(fwd(join(dir, "kervan-mcp")))).replace('"/work/kervan-core"', JSON.stringify(fwd(join(dir, "kervan-core"))));
}

/** The two-component program, with a person asked at the end so the run stays live. */
const WAITS = TWO_COMPONENTS.replace('  "done"\n}', '  let answer = human.ask("Done?")\n  "done"\n}').replace("use std.{component, model}", "use std.{component, model, human}");

describe("a run's components and their base commits (B3)", () => {
  it("records each component at its base commit in the manifest, and R changes when a base does", async () => {
    const modules = kervanModules();
    const w = await world(TWO_COMPONENTS, { modules, lock: lockFor(modules) });
    const a = await w.rt.startRun({ pkg: w.pkg, workflow: "Change", input: { task: "t" }, runId: "ws1" });
    expect(a.state).toBe("succeeded");
    expect(w.workspace.prepared).toEqual([[
      { name: "core", repo: "onurkoocc/kervan-core", root: "/work/kervan-core" },
      { name: "mcp", repo: "onurkoocc/kervan-mcp", root: "/work/kervan-mcp" },
    ]]);
    expect((a.manifest as { components: unknown }).components).toEqual({
      core: { repo: "onurkoocc/kervan-core", root: "/work/kervan-core", base: "core-commit-1" },
      mcp: { repo: "onurkoocc/kervan-mcp", root: "/work/kervan-mcp", base: "mcp-commit-1" },
    });
    expect(a.manifest_hash).toMatch(/^sha256:/);

    // The same program and input from another base of mcp is another run of another thing.
    w.workspace.advance("mcp");
    const b = await w.rt.startRun({ pkg: w.pkg, workflow: "Change", input: { task: "t" }, runId: "ws2" });
    expect((b.manifest as { components: { mcp: { base: string } } }).components.mcp.base).toBe("mcp-commit-2");
    expect(b.manifest_hash).not.toBe(a.manifest_hash);

    const { view } = await runView(w.rt, "ws2");
    expect(view.manifest).toEqual({ hash: b.manifest_hash, mode: "live", components: [{ name: "core", repo: "onurkoocc/kervan-core", base: "core-commit-1" }, { name: "mcp", repo: "onurkoocc/kervan-mcp", base: "mcp-commit-2" }] });
    expect(await w.rt.replayRun("ws2")).toEqual({ status: "complete", value: "done" });
  });

  it("gives a working copy to one live run at a time, and frees it when the run ends", async () => {
    const modules = kervanModules();
    const w = await world(WAITS, { modules, lock: lockFor(modules) });
    const first = await w.rt.startRun({ pkg: w.pkg, workflow: "Change", input: { task: "t" }, runId: "busy1" });
    expect(first.state).toBe("waiting");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Change", input: { task: "t" }, runId: "busy2" })).rejects.toThrow(/in use by run busy1/);
    // The refused start touched nothing: the workspace was asked to prepare only once.
    expect(w.workspace.prepared).toHaveLength(1);
    expect((await w.rt.cancelRun("busy1")).state).toBe("cancelled");
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Change", input: { task: "t" }, runId: "busy3" })).state).toBe("waiting");
  });

  it("does not start a program that works on components without a workspace adapter (INV-11)", async () => {
    const modules = kervanModules();
    const w = await world(TWO_COMPONENTS, { modules, lock: lockFor(modules) });
    delete w.adapters.workspace;
    await expect(new Runtime(w.db, w.adapters).startRun({ pkg: w.pkg, workflow: "Change", input: { task: "t" } })).rejects.toThrow(/no workspace adapter/);
  });
});

describe("GitWorkspace", () => {
  const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.email=t@mandate", "-c", "user.name=t", ...a], { cwd, encoding: "utf8" });
  const repo = (dir: string, files: Record<string, string>): string => {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q", "-b", "main");
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "seed");
    return git(dir, "rev-parse", "HEAD").trim();
  };

  it("checks each component out at its source's head, detached; a later prepare moves to the new head and drops leftover work", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mandate-ws-"));
    try {
      const mcpSrc = join(tmp, "src", "mcp");
      const first = repo(mcpSrc, { "src/a.ts": "a\n", ".gitignore": "node_modules\n" });
      const root = join(tmp, "work", "kervan-mcp");
      const ws = new GitWorkspace({ mcp: { url: mcpSrc } });
      expect(await ws.prepare([{ name: "mcp", repo: "onurkoocc/kervan-mcp", root }])).toEqual({ mcp: { base: first } });
      expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a\n");

      // A run left work behind, and installed dependencies.
      writeFileSync(join(root, "src/leftover.ts"), "x");
      mkdirSync(join(root, "node_modules"));
      writeFileSync(join(root, "node_modules/dep.js"), "dep");
      writeFileSync(join(mcpSrc, "src/a.ts"), "a2\n");
      git(mcpSrc, "commit", "-q", "-am", "next");
      const second = git(mcpSrc, "rev-parse", "HEAD").trim();

      expect(await ws.prepare([{ name: "mcp", repo: "onurkoocc/kervan-mcp", root }])).toEqual({ mcp: { base: second } });
      expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("a2\n");
      expect(existsSync(join(root, "src/leftover.ts"))).toBe(false);
      expect(existsSync(join(root, "node_modules/dep.js"))).toBe(true);
      await expect(ws.prepare([{ name: "core", repo: "onurkoocc/kervan-core", root: join(tmp, "work", "kervan-core") }])).rejects.toThrow(/no source for component core/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

const REAL = process.env["MANDATE_MXC"] === "1" && (process.platform === "linux" || process.platform === "win32");

describe("writable paths a sandbox is granted", () => {
  it("creates one that is missing beside what exists, and makes up nothing deeper", () => {
    const root = mkdtempSync(join(tmpdir(), "mandate-writable-"));
    try {
      mkdirSync(join(root, "src"));
      makeWritable({ filesystem: { readOnly: [], readWrite: [fwd(join(root, "src")), fwd(join(root, "test")), fwd(join(root, "x", "y"))] } } as unknown as MxcPolicy);
      expect([existsSync(join(root, "test")), existsSync(join(root, "x"))]).toEqual([true, false]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe.runIf(REAL)("two agents on two components in real sandboxes (B3)", () => {
  it("each writes only its component; the other component's working copy is out of its sandbox", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mandate-b3-"));
    try {
      const modules = kervanModules(kervanAt(tmp));
      const mcpRoot = fwd(join(tmp, "kervan-mcp"));
      const coreRoot = fwd(join(tmp, "kervan-core"));
      for (const r of [mcpRoot, coreRoot]) mkdirSync(join(r, "src"), { recursive: true });
      writeFileSync(join(mcpRoot, "src/tools.ts"), "export const tools = [];\n");
      writeFileSync(join(coreRoot, "src/Api.java"), "class Api {}\n");

      const scripts: Record<string, SimTurn[]> = {
        // Paths are relative to each agent's working copy, its first readable root.
        McpDev: [
          [toolUse("m1", "read_file", { path: "src/tools.ts" })],
          [toolUse("m2", "write_file", { path: "src/tools.ts", content: "export const tools = ['get_shipment'];\n" })],
          // Out of its grant: refused, and it would not reach the sandbox's files either.
          [toolUse("m3", "write_file", { path: "../kervan-core/src/Api.java", content: "broken" })],
          [toolUse("m4", "finish", { result: { files: ["src/tools.ts"] } })],
        ],
        CoreDev: [
          [toolUse("c1", "write_file", { path: "src/Api.java", content: "class Api { int v; }\n" })],
          [toolUse("c2", "finish", { result: { files: ["src/Api.java"] } })],
        ],
      };
      const chat = new SimChat((req: TurnRequest): SimTurn => {
        const agent = Object.keys(scripts).find((a) => req.system.startsWith(`You are ${a},`))!;
        const turn = req.messages.filter((m) => (m as { role?: string }).role === "assistant").length;
        return scripts[agent]![turn]!;
      });
      const host: SandboxHost = process.platform === "win32" ? new WindowsMxcHost() : new MxcHost({ baseline: [dirname(dirname(process.execPath))], path: [dirname(process.execPath)] });
      const sandbox = new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });

      const w = await world(TWO_COMPONENTS, { modules, lock: lockFor(modules) });
      w.adapters.loop = { chat, sandbox };
      const rt = new Runtime(w.db, w.adapters);
      const program = check(TWO_COMPONENTS, "mdt", { modules }).program!;
      const run = await rt.startRun({ pkg: buildPackage(program, lockFor(modules), modules), workflow: "Change", input: { task: "add get_shipment" }, runId: "b3real" });
      expect(run.state, JSON.stringify(run.error ?? run.attention)).toBe("succeeded");

      // What each tool call answered, for a failure's message.
      const results = JSON.stringify(chat.calls.flatMap((c) => c.messages).flatMap((m) => ((m as { content?: unknown }).content as Array<Record<string, unknown>> | undefined) ?? []).filter((b) => b["type"] === "tool_result").map((b) => [b["tool_use_id"], b["content"]]));
      expect(readFileSync(join(mcpRoot, "src/tools.ts"), "utf8"), results).toBe("export const tools = ['get_shipment'];\n");
      expect(readFileSync(join(coreRoot, "src/Api.java"), "utf8")).toBe("class Api { int v; }\n");
      const m3 = chat.calls.flatMap((c) => c.messages).flatMap((m) => ((m as { content?: unknown }).content as Array<Record<string, unknown>> | undefined) ?? []).find((b) => b["tool_use_id"] === "m3");
      expect(String(m3?.["content"])).toMatch(/outside what you may write/);

      // The sandbox itself holds the line, not only the runtime's check: McpDev's policy cannot write core.
      const plan = await sandbox.plan(w.agents.calls.length ? w.agents.calls[0]!.sandbox! : (await import("@mandate/compiler")).sandboxRequirements(program, modules)["McpDev"]!);
      if (!("policy" in plan)) throw new Error(plan.unsupported.join("; "));
      const handle = await host.create(plan.policy);
      try {
        const r = await host.execute(handle, { argv: ["sh", "-c", WRITE_SCRIPT, "sh", `${coreRoot}/src/Api.java`], stdin: "from the mcp sandbox" });
        expect(r.exitCode).not.toBe(0);
      } finally {
        await host.destroy(handle);
      }
      expect(readFileSync(join(coreRoot, "src/Api.java"), "utf8")).toBe("class Api { int v; }\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
