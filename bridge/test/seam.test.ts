// The command line and the MCP server are programs beside the bridge's entry point, not part of it: they reach the
// compiler only through ./index.js, so that when the entry point calls another compiler they follow. Every import is
// read from the parsed source (a comment or a string that mentions a package is not an import).

import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const src = join(dirname(dirname(fileURLToPath(import.meta.url))), "src");
// cli-library.ts and libraries.ts are the command line's library commands and their reading of files: part of it, and held as it is.
const FILES = ["cli.ts", "cli-library.ts", "libraries.ts", "mcp.ts", "util.ts"];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
/**
 * What a file may name: Node's built-ins, each other, the bridge's entry point, and the class of the compiler's
 * failures (wasm/errors.ts, which imports nothing: held below), by which the command line exits 2 when the compiler
 * fails.
 */
const SIBLINGS = new Set(["./index.js", "./cli.js", "./cli-library.js", "./libraries.js", "./mcp.js", "./util.js", "./wasm/errors.js"]);
/** The one hand-off that is not an import of the compiler: the runtime's command line, loaded when a control command is run. */
const RUNTIME = "@mandate/runtime/cli";

interface Found {
  specifier: string;
  how: string;
  line: number;
}

/** Every module a file names: static imports and re-exports, `import("…")`, `require("…")`, `import x = require("…")`. */
export function importsOf(file: string, text: string): Found[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: Found[] = [];
  const at = (n: ts.Node): number => source.getLineAndCharacterOfPosition(n.getStart(source)).line + 1;
  // Strings bound to a name, for `const specifier = "…"; import(specifier)`.
  const bound = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) bound.set(node.name.text, node.initializer.text);
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, how: ts.isImportDeclaration(node) ? "import" : "export from", line: at(node) });
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, how: "import =", line: at(node) });
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, how: "import type", line: at(node) });
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const how = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()";
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteralLike(arg)) found.push({ specifier: arg.text, how, line: at(node) });
      else if (arg && ts.isIdentifier(arg) && bound.has(arg.text)) found.push({ specifier: bound.get(arg.text)!, how: `${how} of ${arg.text}`, line: at(node) });
      else found.push({ specifier: "<computed>", how, line: at(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** What a file's imports break: the ones that are not a built-in, a sibling, or (cli.ts only) the runtime hand-off. */
export function breaches(file: string, found: Found[]): string[] {
  return found
    .filter((f) => !BUILTINS.has(f.specifier) && !SIBLINGS.has(f.specifier) && !(file === "cli.ts" && f.how.startsWith("import()") && f.specifier === RUNTIME))
    .map((f) => `${file}:${f.line}: ${f.how} ${f.specifier}`);
}

describe("the seam between the command line, the MCP server and the compiler", () => {
  it("has the files it is about", () => {
    for (const f of FILES) expect(existsSync(join(src, f)), f).toBe(true);
  });

  it("is the bridge's entry point: cli.ts, its library commands, mcp.ts and util.ts import only Node built-ins, each other and ./index.js", () => {
    const breached = FILES.flatMap((f) => breaches(f, importsOf(f, readFileSync(join(src, f), "utf8"))));
    expect(breached, `reach the compiler through ./index.js:\n${breached.join("\n")}`).toEqual([]);
  });

  it("lets them name the class of the compiler's failures, from a file that imports nothing", () => {
    expect(importsOf("wasm/errors.ts", readFileSync(join(src, "wasm", "errors.ts"), "utf8"))).toEqual([]);
  });

  it("takes the compiler only from ./index.js: cli.ts and mcp.ts do import it", () => {
    for (const f of ["cli.ts", "mcp.ts"]) expect(importsOf(f, readFileSync(join(src, f), "utf8")).map((i) => i.specifier), f).toContain("./index.js");
    expect(importsOf("cli.ts", readFileSync(join(src, "cli.ts"), "utf8")).map((i) => i.specifier)).toContain("./mcp.js");
  });

  it("hands the control commands to the runtime by a dynamic import, and imports it no other way", () => {
    const found = importsOf("cli.ts", readFileSync(join(src, "cli.ts"), "utf8"));
    expect(found.filter((f) => f.specifier === RUNTIME).map((f) => f.how)).toEqual(["import() of specifier"]);
  });

  describe("the check itself", () => {
    const run = (text: string, file = "cli.ts"): string[] => breaches(file, importsOf(file, text));

    it("refuses the compiler's package and a path into compiler/, by any kind of import", () => {
      expect(run('import { check } from "@mandate/compiler";')).toHaveLength(1);
      expect(run('export * from "@mandate/compiler";')).toHaveLength(1);
      expect(run('export { check } from "../../compiler/src/check.js";')).toHaveLength(1);
      expect(run('import type { Lock } from "../../compiler/src/lock.js";')).toHaveLength(1);
      expect(run('const x: import("@mandate/compiler").Lock = 1;')).toHaveLength(1);
      expect(run('const m = await import("@mandate/compiler");')).toHaveLength(1);
      expect(run('const m = require("@mandate/compiler");')).toHaveLength(1);
      expect(run('import m = require("@mandate/compiler");')).toHaveLength(1);
      expect(run('import x from "./authority.js";')).toHaveLength(1);
      expect(run('const s = "x"; await import(s + "y");')).toHaveLength(1);
      expect(run('const s = "@mandate/compiler"; await import(s);')).toHaveLength(1);
    });

    it("refuses the runtime's hand-off anywhere but cli.ts, and any other way than a dynamic import", () => {
      expect(run('const s = "@mandate/runtime/cli"; await import(s);')).toEqual([]);
      expect(run('const s = "@mandate/runtime/cli"; await import(s);', "mcp.ts")).toHaveLength(1);
      expect(run('import { main } from "@mandate/runtime/cli";')).toHaveLength(1);
    });

    it("allows built-ins, siblings and the entry point, and ignores a comment or a string that names the package", () => {
      expect(run('import { readFileSync } from "node:fs";\nimport { join } from "path";\nimport { check } from "./index.js";\nimport { serveStdio } from "./mcp.js";')).toEqual([]);
      expect(run('// import { check } from "@mandate/compiler";\nconst s = "from \\"@mandate/compiler\\"";\n/* require("../../compiler/src/check.js") */')).toEqual([]);
    });
  });
});
