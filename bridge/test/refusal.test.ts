// A failure of the compiler is never read as a program that checks: the command line exits 2 and says what failed,
// and the MCP server answers with an error, not with a result. Each with a module that traps (wasm-bytes.ts) and,
// for the command line, with no module at all.

import { spawn, spawnSync } from "node:child_process";
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

function run(args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tree.bridgeCli, ...args], { cwd: work, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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
      const r = await run(args, { MANDATE_COMPILER: "rust", MANDATE_WASM: TRAP });
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(r.err).toContain("the Rust compiler failed");
      expect(r.err).toContain("(trap)");
      expect(r.out).toBe("");
    }
  }, 60_000);

  it("exits 2 and says how to build the module when there is none", async () => {
    const r = await run(["check", FIXBUG], { MANDATE_COMPILER: "both", MANDATE_WASM: join(work, "missing.wasm") });
    expect(r.code).toBe(2);
    expect(r.err).toContain("(module_missing)");
    expect(r.err).toContain("npm run build:wasm");
    expect(r.out).toBe("");
  }, 30_000);

  it("refuses a MANDATE_COMPILER it does not know, rather than guess", async () => {
    const r = await run(["check", FIXBUG], { MANDATE_COMPILER: "rsut" });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('MANDATE_COMPILER is "rsut": it is ts, rust or both');
    expect(r.out).toBe("");
  }, 30_000);

  it("is unchanged in the default mode, whatever MANDATE_WASM names", async () => {
    const r = await run(["check", FIXBUG], { MANDATE_COMPILER: "", MANDATE_WASM: TRAP });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ok sha256:/);
  }, 30_000);
});

describe("a child process whose code catches a divergence of `both`", () => {
  it("still fails, with exit status 70 and the divergence on its standard error", () => {
    const wrong = join(work, "wrong-program-ref.wasm");
    writeFileSync(wrong, MODULES.answering('{"ok":true,"output":{"module":"x","version":"0.1.0","hash":"sha256:wrong"}}'));
    const script = join(tree.dir, "swallow.mjs");
    writeFileSync(
      script,
      `import { readFileSync } from "node:fs";
import { check } from "./compiler/src/index.js";
import { programRef } from "./bridge/src/index.js";
import { withCompiler } from "./bridge/src/mode.js";
const p = check(readFileSync(process.argv[2], "utf8"), "mdt").program;
try {
  withCompiler("both", () => programRef(p), { doors: { program_ref: readFileSync(process.argv[3]) } });
} catch {
  // A caller that swallows it.
}
process.stdout.write("swallowed\\n");
`,
    );
    const r = spawnSync(process.execPath, [script, FIXBUG, wrong], { encoding: "utf8", env: { ...process.env, MANDATE_COMPILER: "" } });
    expect(r.stdout).toBe("swallowed\n");
    expect(r.status).toBe(70);
    expect(r.stderr).toContain("answered differently, which nothing took");
    expect(r.stderr).toContain("sha256:wrong");
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
      "rust",
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
