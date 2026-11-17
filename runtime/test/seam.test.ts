import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The runtime reaches the compiler only through the bridge (@mandate/bridge). The name is built here so that this
// file does not itself name the package.
const COMPILER = ["@mandate", "compiler"].join("/");
// The bridge's entry for the reference compiler writes test data only (bridge/src/reference.ts): nothing of the runtime
// reaches it either.
const REFERENCE = ["@mandate", "bridge", "reference"].join("/");
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

  it("does not reach the reference compiler: no file of the runtime names the bridge's reference entry", () => {
    const found: string[] = [];
    for (const file of files(runtimeDir)) {
      if (file === fileURLToPath(import.meta.url)) continue;
      readFileSync(file, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (line.includes(REFERENCE)) found.push(`${relative(runtimeDir, file).replaceAll("\\", "/")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found, `the runtime answers with the bridge, which answers with the Rust compiler; ${REFERENCE} is for test data:\n${found.join("\n")}`).toEqual([]);
  });

  // The run-time authority decisions are the bridge's (grant, narrow, mapScopes, inFlightOverlap): the runtime makes
  // none of them with the compiler's own coverage and overlap predicates, so that one implementation decides them.
  // Every file is parsed (comments and strings are not code), and every way of reaching a name of the bridge is
  // looked at: named imports and re-exports, under any alias; a default or namespace import, `export *` and
  // `require`, which would hide the names taken, are refused outright. A dynamic `import("@mandate/bridge")` is
  // allowed only where the names it takes can be seen, destructured or read at once, because two tests take
  // `hashProgram` and `sandboxRequirements` that way (map.test.ts, workspace.test.ts); any other use of it is refused.
  it("decides no authority itself: no file of the runtime takes the compiler's coverage and overlap predicates", () => {
    const found = authorityUses(runtimeDir, fileURLToPath(import.meta.url));
    expect(found, `ask the bridge's authority decisions instead:\n${found.join("\n")}`).toEqual([]);
  });

  it("does not list the compiler as a dependency", () => {
    const pkg = JSON.parse(readFileSync(join(runtimeDir, "package.json"), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      expect(Object.keys(pkg[field] ?? {}), `runtime/package.json ${field} names ${COMPILER}`).not.toContain(COMPILER);
    }
  });
});

/** The names of the bridge that decide authority, which the runtime leaves to the bridge's four functions. */
const AUTHORITY = new Set(["capCovers", "scopeWithin", "writesOverlap", "within", "pathsOverlap", "grantOf"]);
const BRIDGE = "@mandate/bridge";

/** Every place a file of the runtime under `dir` (but `self`) takes an authority name of the bridge, or could unseen. */
function authorityUses(dir: string, self?: string): string[] {
  const found: string[] = [];
  for (const file of files(dir)) {
    if (file === self || !/\.[cm]?[jt]s$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const at = (node: ts.Node, what: string): void =>
      void found.push(`${relative(dir, file).replaceAll("\\", "/")}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}: ${what}`);
    const bridge = (e: ts.Node | undefined): boolean => !!e && ts.isStringLiteralLike(e) && e.text === BRIDGE;
    const named = (node: ts.Node, name: string, how: string): void => {
      if (AUTHORITY.has(name)) at(node, `${how} ${name}`);
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && bridge(node.moduleSpecifier)) {
        const clause = node.importClause;
        if (clause?.name) at(node, "a default import of the bridge");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) at(node, "a namespace import of the bridge");
        if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) named(el, (el.propertyName ?? el.name).text, "imports");
      } else if (ts.isExportDeclaration(node) && bridge(node.moduleSpecifier)) {
        const clause = node.exportClause;
        if (!clause || ts.isNamespaceExport(clause)) at(node, "a re-export of the whole bridge");
        else for (const el of clause.elements) named(el, (el.propertyName ?? el.name).text, "re-exports");
      } else if (ts.isCallExpression(node) && bridge(node.arguments[0])) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamic(node);
        else if (ts.isIdentifier(node.expression) && node.expression.text === "require") at(node, "a require of the bridge");
      }
      ts.forEachChild(node, visit);
    };
    // `await import(bridge)`, perhaps in parentheses: what is taken from it must be seen where it is taken.
    const dynamic = (call: ts.CallExpression): void => {
      let node: ts.Node = call;
      while (ts.isAwaitExpression(node.parent) || ts.isParenthesizedExpression(node.parent)) node = node.parent;
      const p = node.parent;
      if (ts.isPropertyAccessExpression(p) && p.expression === node && p.name.text !== "then") return named(p, p.name.text, "takes");
      if (ts.isElementAccessExpression(p) && p.expression === node && ts.isStringLiteralLike(p.argumentExpression)) return named(p, p.argumentExpression.text, "takes");
      if (ts.isVariableDeclaration(p) && p.initializer === node && ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) {
          const key = el.propertyName ?? el.name;
          if (el.dotDotDotToken || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key))) at(el, "a dynamic import of the bridge whose names cannot be seen");
          else named(el, key.text, "takes");
        }
        return;
      }
      at(call, "a dynamic import of the bridge whose names cannot be seen");
    };
    visit(source);
  }
  return found;
}
