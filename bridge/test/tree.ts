import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface Tree {
  /** The compiler's command line (`mandate-ts`) and the bridge's (`mandate`), as JavaScript files to run with node. */
  compilerCli: string;
  bridgeCli: string;
  dir: string;
  remove(): void;
}

/**
 * Both command lines as JavaScript without any `dist/` directory: the sources of the compiler and of the bridge
 * are compiled with the TypeScript compiler (a devDependency of the bridge) into a temporary directory that keeps
 * their layout, so that the files each reads from beside itself (the schemas and the specification, which the
 * compiler and the bridge's MCP server find by a path from their own address) are found at the same relative places.
 */
export function buildTree(): Tree {
  const dir = mkdtempSync(join(tmpdir(), "mdt-bridge-"));
  const config = ts.readConfigFile(join(repoRoot, "bridge", "tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, join(repoRoot, "bridge"));
  const program = ts.createProgram({
    rootNames: [join(repoRoot, "bridge", "src", "cli.ts"), join(repoRoot, "compiler", "src", "cli.ts")],
    options: { ...parsed.options, rootDir: repoRoot, outDir: dir, noEmit: false, declaration: false, sourceMap: false, composite: false, incremental: false },
  });
  const emitted = program.emit();
  if (emitted.emitSkipped) throw new Error("the sources did not compile into " + dir);
  // The bridge names the compiler by its package; in the tree it is the compiler's entry point beside it.
  for (const file of walk(join(dir, "bridge"))) {
    if (!file.endsWith(".js")) continue;
    const specifier = relative(dirname(file), join(dir, "compiler", "src", "index.js")).replaceAll("\\", "/");
    writeFileSync(file, readFileSync(file, "utf8").replaceAll('"@mandate/compiler"', JSON.stringify(specifier.startsWith(".") ? specifier : "./" + specifier)));
  }
  for (const pkg of ["bridge", "compiler"]) copyFileSync(join(repoRoot, pkg, "package.json"), join(dir, pkg, "package.json"));
  // The Rust compiler's module and its digest, in the bridge's own place, when build:wasm has put them there.
  for (const f of ["mandate-wasm.wasm", "mandate-wasm.digest.json"]) {
    if (!existsSync(join(repoRoot, "bridge", "wasm", f))) continue;
    mkdirSync(join(dir, "bridge", "wasm"), { recursive: true });
    copyFileSync(join(repoRoot, "bridge", "wasm", f), join(dir, "bridge", "wasm", f));
  }
  mkdirSync(join(dir, "spec"));
  for (const f of ["ir.schema.json", "lock.schema.json", "core.md"]) copyFileSync(join(repoRoot, "spec", f), join(dir, "spec", f));
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "junction");
  return {
    compilerCli: join(dir, "compiler", "src", "cli.js"),
    bridgeCli: join(dir, "bridge", "src", "cli.js"),
    dir,
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}
