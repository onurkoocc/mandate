// Which file the bridge takes as the Rust compiler: its own (`<bridge>/wasm/`, with the digest build:wasm wrote),
// or the one MANDATE_WASM names by an absolute path, and never one a project or a working directory holds. Each
// layout is made in a temporary directory with the bridge's module code installed under node_modules, and asked from
// a child process, which runs in the layout's working directory with the layout's environment.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { repoRoot } from "./tree.js";
import { MODULES } from "./wasm-bytes.js";

const work = mkdtempSync(join(tmpdir(), "mdt-bridge-provenance-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A module that would load: what a pull request would plant as the compiler. */
const PLANTED = MODULES.answering('{"ok":true,"output":"planted"}');
const sha = (b: Uint8Array): string => `sha256:${createHash("sha256").update(b).digest("hex")}`;

/** The bridge's module code, as JavaScript under `<dir>/node_modules/@mandate/bridge/dist/`; its own module place is `<…>/@mandate/bridge/wasm/`. */
function install(dir: string): string {
  const bridge = join(dir, "node_modules", "@mandate", "bridge");
  for (const f of ["wasm/module.ts", "wasm/host.ts", "wasm/errors.ts", "text.ts"]) {
    const js = ts.transpileModule(readFileSync(join(repoRoot, "bridge", "src", f), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    mkdirSync(join(bridge, "dist", f, ".."), { recursive: true });
    writeFileSync(join(bridge, "dist", f.replace(/\.ts$/, ".js")), js);
  }
  writeFileSync(join(bridge, "package.json"), JSON.stringify({ name: "@mandate/bridge", type: "module" }));
  return bridge;
}

/** A checkout of the repository's shape: Cargo.toml, crates/mandate-wasm and a built module under target/. */
function checkout(dir: string): string {
  mkdirSync(join(dir, "crates", "mandate-wasm"), { recursive: true });
  mkdirSync(join(dir, "target", "wasm32-wasip1", "release"), { recursive: true });
  writeFileSync(join(dir, "Cargo.toml"), "[workspace]\n");
  writeFileSync(join(dir, "target", "wasm32-wasip1", "release", "mandate-wasm.wasm"), PLANTED);
  return join(dir, "target", "wasm32-wasip1", "release", "mandate-wasm.wasm");
}

const ASK = join(work, "ask.mjs");
beforeAll(() => {
  writeFileSync(
    ASK,
    `import { pathToFileURL } from "node:url";
const [bridge] = process.argv.slice(2);
const m = await import(pathToFileURL(bridge + "/dist/wasm/module.js").href);
let place, result;
try { place = m.modulePlace(); } catch (e) { place = { refused: e.kind }; }
try { result = { loaded: m.moduleIdentity(m.processModule()) }; } catch (e) { result = { refused: e.kind, message: e.message }; }
process.stdout.write(JSON.stringify({ place, result }));
`,
  );
});

/** What the bridge installed at `bridge` takes, asked from `cwd` with `wasm` as MANDATE_WASM (none when undefined). */
function ask(bridge: string, cwd: string, wasm?: string): { place: { path?: string; from?: string; refused?: string }; result: { loaded?: { sha256: string; from: string }; refused?: string; message?: string } } {
  const env = { ...process.env };
  delete env["MANDATE_WASM"];
  if (wasm !== undefined) env["MANDATE_WASM"] = wasm;
  const r = spawnSync(process.execPath, [ASK, bridge], { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`the child failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

describe("the module the bridge takes", () => {
  it("is its own, not the one of the project it is installed in", () => {
    const project = join(work, "project");
    const bridge = install(project);
    checkout(project);
    const got = ask(bridge, project);
    expect(got.place).toEqual({ path: join(bridge, "wasm", "mandate-wasm.wasm"), from: "bridge" });
    expect(got.result.refused).toBe("module_missing");
  });

  it("is its own, not the one of the working directory", () => {
    const bridge = install(join(work, "installed"));
    const cwd = join(work, "cwd-checkout");
    checkout(cwd);
    const got = ask(bridge, cwd);
    expect(got.place.path).toBe(join(bridge, "wasm", "mandate-wasm.wasm"));
    expect(got.result.refused).toBe("module_missing");
  });

  it("is its own when there is nothing around it either", () => {
    const plain = join(work, "plain");
    const bridge = install(plain);
    const got = ask(bridge, plain);
    expect(got.place.path).toBe(join(bridge, "wasm", "mandate-wasm.wasm"));
    expect(got.result.refused).toBe("module_missing");
  });

  describe("from its own place, only with the digest build:wasm writes", () => {
    const own = join(work, "own");
    let bridge = "";
    beforeAll(() => {
      bridge = install(own);
      mkdirSync(join(bridge, "wasm"), { recursive: true });
      writeFileSync(join(bridge, "wasm", "mandate-wasm.wasm"), PLANTED);
    });
    const digest = (d: unknown): void => writeFileSync(join(bridge, "wasm", "mandate-wasm.digest.json"), JSON.stringify(d));

    it("is taken when its bytes are the ones the digest names", () => {
      digest({ format: "mandate/wasm-digest/0.1", sha256: sha(PLANTED), bytes: PLANTED.length });
      expect(ask(bridge, own).result.loaded).toEqual({ sha256: sha(PLANTED), bytes: PLANTED.length, from: "bridge" });
    });

    it("is refused when they are not, or when its length is not, or when there is no digest", () => {
      digest({ format: "mandate/wasm-digest/0.1", sha256: sha(MODULES.trap()), bytes: PLANTED.length });
      expect(ask(bridge, own).result).toMatchObject({ refused: "module_invalid", message: expect.stringContaining("not the one its digest names") });
      digest({ format: "mandate/wasm-digest/0.1", sha256: sha(PLANTED), bytes: PLANTED.length + 1 });
      expect(ask(bridge, own).result.refused).toBe("module_invalid");
      rmSync(join(bridge, "wasm", "mandate-wasm.digest.json"));
      expect(ask(bridge, own).result).toMatchObject({ refused: "module_invalid", message: expect.stringContaining("no digest beside it") });
    });
  });

  describe("named by MANDATE_WASM", () => {
    it("is taken from an absolute path, the operator's choice, with no digest", () => {
      const where = join(work, "operator");
      const bridge = install(where);
      const file = checkout(where);
      expect(ask(bridge, where, file).result.loaded).toEqual({ sha256: sha(PLANTED), bytes: PLANTED.length, from: "MANDATE_WASM" });
    });

    it("is refused from a relative path, by its rule", () => {
      const where = join(work, "relative");
      const bridge = install(where);
      checkout(where);
      const got = ask(bridge, where, "target/wasm32-wasip1/release/mandate-wasm.wasm");
      expect(got.place.refused).toBe("module_invalid");
      expect(got.result).toMatchObject({ refused: "module_invalid", message: expect.stringContaining("a relative path: it names a module by an absolute path only") });
    });
  });
});
