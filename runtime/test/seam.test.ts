import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The runtime reaches the compiler only through the bridge (@mandate/bridge). The name is built here so that this
// file does not itself name the package.
const COMPILER = ["@mandate", "compiler"].join("/");
const runtimeDir = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP_DIRS = new Set(["node_modules", "dist", ".build"]);

function* files(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* files(join(dir, e.name));
    } else yield join(dir, e.name);
  }
}

describe("the seam between the runtime and the compiler", () => {
  it("is the bridge: no file of the runtime names the compiler package", () => {
    const found: string[] = [];
    for (const file of files(runtimeDir)) {
      if (file === fileURLToPath(import.meta.url)) continue;
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (line.includes(COMPILER)) found.push(`${relative(runtimeDir, file).replaceAll("\\", "/")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, `import the compiler through @mandate/bridge, not ${COMPILER}:\n${found.join("\n")}`).toEqual([]);
  });

  it("does not list the compiler as a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), `runtime/package.json ${field} names ${COMPILER}`).not.toContain(COMPILER);
    }
  });
});
