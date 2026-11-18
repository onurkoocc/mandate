// A failure of the compiler is never read as a program that checks: the command line exits 2 and says what failed,
// and the MCP server answers with an error, not with a result. Each with a module that traps (wasm-bytes.ts) and,
// for the command line, with no module at all.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveStdio } from "../src/mcp.js";
import { withCompiler } from "../src/mode.js";
import { buildTree, repoRoot, type Tree } from "./tree.js";
import { MODULES } from "./wasm-bytes.js";

const work = mkdtempSync(join(tmpdir(), "mdt-bridge-refusal-"));
const TRAP = join(work, "trap.wasm");
const FIXBUG = join(repoRoot, "fixtures", "fixbug", "fixbug.mdt");
let tree: Tree;

beforeAll(() => {
  tree = buildTree();
  writeFileSync(TRAP, MODULES.trap());
}, 60_000);

afterAll(() => {
  tree?.remove();
  rmSync(work, { recursive: true, force: true });
});

/** The command line with the test's environment and `env` over it; a variable given as `undefined` is not set. */
function run(args: string[], env: Record<string, string | undefined>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const merged: Record<string, string | undefined> = { ...process.env, ...env };
    for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
    const child = spawn(process.execPath, [tree.bridgeCli, ...args], { cwd: work, env: merged as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }));
  });
}

describe("the command line, when the compiler fails", () => {
  it("exits 2 and says the module trapped, and prints no result", async () => {
    for (const args of [["check", FIXBUG], ["check", FIXBUG, "--json"], ["hash", FIXBUG], ["view", FIXBUG], ["explain", "E0130"]]) {
      const r = await run(args, { MANDATE_WASM: TRAP });
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(r.err).toContain("the Rust compiler failed");
      expect(r.err).toContain("(trap)");
      expect(r.out).toBe("");
    }
  }, 60_000);

  it("exits 2 and says how to build the module when there is none", async () => {
    const r = await run(["check", FIXBUG], { MANDATE_WASM: join(work, "missing.wasm") });
    expect(r.code).toBe(2);
    expect(r.err).toContain("(module_missing)");
    expect(r.err).toContain("npm run build:wasm");
    expect(r.out).toBe("");
  }, 30_000);
});

describe("the MCP server, when the compiler fails", () => {
  /** The answers of the server to `messages`, one a line. */
  async function serve(messages: unknown[]): Promise<Array<Record<string, unknown>>> {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (c: Buffer) => lines.push(...c.toString("utf8").split("\n").filter(Boolean)));
    const done = serveStdio(input, output);
    for (const m of messages) input.write(JSON.stringify(m) + "\n");
    input.end();
    await done;
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }
  const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
  const call = (id: number, name: string, args: Record<string, unknown>): unknown => ({ jsonrpc: "2.0", id, method: "tools/call", params: { ...meta, name, arguments: args } });

  it("answers each tool call with an error that says the compiler failed, never with a result", async () => {
    const answers = await withCompiler(
      () =>
        serve([
          call(1, "mandate.check", { source: "mandate @ 0.5\nmodule m @ 0.1\n" }),
          call(2, "mandate.explain", { code: "E0130" }),
          call(3, "mandate.project", { source: "mandate @ 0.5\nmodule m @ 0.1\n", view: "architecture" }),
        ]),
      { module: MODULES.trap() },
    );
    expect(answers).toHaveLength(3);
    for (const a of answers) {
      expect(a["result"]).toBeUndefined();
      expect((a["error"] as { code: number }).code).toBe(-32603);
      expect((a["error"] as { message: string }).message).toContain("the Rust compiler failed");
    }
  });
});
