// The two doors of the runtime's use of connectors (language 0.7, spec/attention.md "Carry-over from 0.6"), as the
// bridge exports them: `callableConnectors` (door `callable_connectors`) and `toolSchemaDigest` (door
// `tool_schema_digest`). The doors are the Rust compiler's alone: no TypeScript function stands for either. The vectors
// of vectors/tool-digest were written from the runtime's own `schemaDigest`; the runtime's test
// (runtime/test/attention-connectors.test.ts) holds that function and `toolSchemaDigest` to each other.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { callableConnectors, check, loadModules, toolSchemaDigest, type Modules } from "../src/index.js";
import { CompilerFailure } from "../src/wasm/errors.js";
import { modulePath } from "../src/wasm/module.js";
import { repoRoot } from "./tree.js";
import { join } from "node:path";

const needs = existsSync(modulePath()) ? describe : describe.skip;

const repo = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");

const vectors = JSON.parse(repo("vectors/tool-digest/tool-schema-digest.json")) as {
  vectors: Array<{ name: string; tool: string; canonical: string; digest: string }>;
  refused: Array<{ name: string; tool: string; why: string }>;
};

/** The modules of the acme.connectors fixture, which declare the connectors `drafts.mdt` imports. */
function connectorModules(): Modules {
  const files = ["fixtures/library/acme.connectors/types.mdt", "fixtures/library/acme.connectors/connectors.mdt"];
  const r = loadModules(files.map((file) => ({ file, text: repo(file), kind: "mdt" as const })));
  expect(r.problems).toEqual([]);
  return r.modules;
}

needs("toolSchemaDigest: the door tool_schema_digest", () => {
  it("gives the digest of each tool of the vectors, written from the runtime's own function", () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(34);
    for (const v of vectors.vectors) expect(toolSchemaDigest(v.tool), v.name).toBe(v.digest);
  });

  it("refuses each text the vectors say it must refuse: it throws an Error, not a CompilerFailure", () => {
    expect(vectors.refused.length).toBeGreaterThanOrEqual(29);
    for (const r of vectors.refused) {
      let thrown: unknown;
      try {
        toolSchemaDigest(r.tool);
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `${r.name}: ${r.why}`).toBeInstanceOf(Error);
      expect(thrown, r.name).not.toBeInstanceOf(CompilerFailure);
    }
  });

  it("refuses a tool nested deeper than 512 levels, and takes one at the limit", () => {
    const nested = (n: number): string => `{"name":"t","inputSchema":${'{"a":'.repeat(n)}1${"}".repeat(n)}}`;
    expect(toolSchemaDigest(nested(100))).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => toolSchemaDigest(nested(600))).toThrow(/512/);
  });

  it("gives the digest of the object the runtime holds, written by JSON.stringify", () => {
    const tool = { name: "echo", inputSchema: { type: "object", properties: { n: { type: "number", minimum: 1.5 } } } };
    expect(toolSchemaDigest(JSON.stringify(tool))).toBe(toolSchemaDigest(JSON.stringify({ outputSchema: undefined, ...tool })));
    // Members besides the three do not count.
    expect(toolSchemaDigest(JSON.stringify({ ...tool, description: "ignored", title: "ignored" }))).toBe(toolSchemaDigest(JSON.stringify(tool)));
  });
});

needs("callableConnectors: the door callable_connectors", () => {
  it("names the connectors a program can call, by the key of their lock entry, for the program as the package has it", () => {
    const modules = connectorModules();
    const program = check(repo("fixtures/library/drafts.mdt"), "mdt", { modules }).program!;
    const callable = callableConnectors(program, modules);
    expect(callable.length).toBeGreaterThan(0);
    for (const c of callable) expect(c.id).toBe(`acme.connectors.${c.name}`);
    // Each once.
    expect(new Set(callable.map((c) => c.id)).size).toBe(callable.length);
  });

  it("names none for a program with no connector, and takes no modules then", () => {
    const program = check(repo("fixtures/library/minimal.mdt"), "mdt", {}).program!;
    expect(program).toBeDefined();
    expect(callableConnectors(program)).toEqual([]);
    expect(callableConnectors(program, {})).toEqual([]);
  });

  it("refuses a request without a program: it throws an Error, not a CompilerFailure", () => {
    let thrown: unknown;
    try {
      callableConnectors(undefined);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(CompilerFailure);
  });
});
