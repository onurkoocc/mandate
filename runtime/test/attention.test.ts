// Language 0.7 at load (spec/attention.md "Version gating", "Refusals"), before any construct of it runs:
//
// - a package of 0.7 that uses nothing 0.7 adds is held to every gate of 0.6, which asks "0.6 or later"; the suites of
//   0.6 run again on their programs labelled 0.7 (test/superset-0.7/, relabel.ts), and a test below holds the sources
//   of the runtime and the bridge to that: no gate compares a language or a lock format with one version;
// - a package of 0.7 that holds what this runtime does not run yet is refused at load, `unsupported_language`, naming
//   each construct and the slice that releases it (NOT_RUN_YET_07), before the compiler is asked anything of it. A
//   slice that implements a construct takes its line out of the table, and out of the list this file pins.
//
// The compiler does not read these constructs yet (slices RL2 to RL5 add them), so each row is shown on values made
// by hand: on `notRunYet07` itself, and on a package whose IR holds the construct, which reaches the refusal because
// it is looked for before the compiler's check. What reaches a package through a library's module, an expansion, a
// sub-program or a program's text cannot be made by hand yet; see the end of this file.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { check, hashProgram, LANGUAGE_07, type Json, type Lock, type Modules, type Program } from "@mandate/bridge";
import { describe, expect, it } from "vitest";
import { isPackage06OrLater, isPackage07OrLater, NOT_RUN_YET_07, notRunYet07, refusal07, subprogramNotRunYet } from "../src/package.js";
import { buildPackage, RUNTIME_LANGUAGES, verifyPackage, type Package } from "../src/runtime.js";
import { Violation } from "../src/signals.js";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** The smallest program of 0.7: nothing of it is new in 0.7 (fixtures/attention/minimal.mdt). */
function minimal(): Program {
  const r = check(read("fixtures/attention/minimal.mdt"), "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  expect(r.program!.language).toBe(LANGUAGE_07);
  return r.program!;
}

type Obj = Record<string, unknown>;

/** `p` with its workflow Greet changed by `f`. */
function withGreet(p: Program, f: (d: Obj) => Obj): Program {
  return { ...p, defs: { ...p.defs, Greet: f(structuredClone(p.defs["Greet"]) as unknown as Obj) as never } };
}

const STAGE = { op: "stage", name: "greet", title: "Greet the one named" };
const REPORT = { op: "report", role: "reviewer", title: "Greeted", fields: [{ name: "n", value: { op: "int", value: 1 } }] };

/** What verifyPackage threw, or undefined. */
function refusal(pkg: Package): Violation | undefined {
  try {
    verifyPackage(pkg);
    return undefined;
  } catch (e) {
    if (e instanceof Violation) return e;
    throw e;
  }
}

/** The constructs a refusal of the 0.7 table names, each with its slice, in the refusal's order. */
const namedIn = (message: string): string[] => /The package uses (.*) of mandate\/0\.7, which this runtime does not run yet \(spec\/attention\.md\)\.$/.exec(message)?.[1]?.split(", ") ?? [`not a refusal by the table: ${message}`];

describe("the table of what 0.7 adds that this runtime does not run yet", () => {
  it("holds a line for each construct, with the slice that releases it: a slice that runs one takes its line out, and this list with it", () => {
    expect(NOT_RUN_YET_07.map((r) => [r.name, r.slice])).toEqual([
      ["asks", "B3"],
      ["lock.role_classes", "B4"],
      ["owner", "B6"],
      ["lock.promotion", "B6"],
    ]);
  });

  it("no longer names a stage or a report, which run (B2, test/stages.test.ts), wherever they stand", () => {
    const p = minimal();
    expect(notRunYet07([p])).toEqual([]);
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, body: [STAGE, ...(d["body"] as unknown[]), REPORT] }))])).toEqual([]);
    const nested = { op: "if", cond: { op: "bool", value: true }, then: [{ op: "let", name: "x", value: { op: "map", body: [REPORT] } }], else: [STAGE] };
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, body: [nested, ...(d["body"] as unknown[])] }))])).toEqual([]);
    expect(notRunYet07([{ ...p, tests: { t: { body: [STAGE] } } } as unknown as Program])).toEqual([]);
  });

  it("finds asks in a workflow's budget and in its envelope's, and nowhere else", () => {
    const p = minimal();
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, budget: { ...(d["budget"] as Obj), asks: 2 } }))])).toEqual(["asks"]);
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, budget: { ...(d["budget"] as Obj), asks: 0 } }))])).toEqual(["asks"]);
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, caps: [], budget: undefined, envelope: { owner: "reviewer", budget: { steps: 4, asks: 1 } } }))])).toEqual(["asks"]);
    // An agent's budget holds no `asks` of 0.7: it is the compiler's to refuse (E1908), not a construct this runtime runs.
    const agent = p.defs["Greeter"] as unknown as Obj;
    expect(notRunYet07([{ ...p, defs: { ...p.defs, Greeter: { ...agent, budget: { ...(agent["budget"] as Obj), asks: 1 } } } } as unknown as Program])).toEqual([]);
  });

  it("finds owner on a workflow, and not an envelope's owner, which is 0.4's", () => {
    const p = minimal();
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, owner: "reviewer" }))])).toEqual(["owner"]);
    expect(notRunYet07([withGreet(p, (d) => ({ ...d, caps: [], budget: undefined, envelope: { owner: "reviewer", budget: { steps: 4 } } }))])).toEqual([]);
  });

  it("finds role_classes and promotion in the lock, and nothing in a lock without them", () => {
    const p = minimal();
    expect(notRunYet07([p], { modules: {} })).toEqual([]);
    expect(notRunYet07([p], { modules: {}, roles: { reviewer: ["ana"] }, role_classes: { reviewer: "confidential" } })).toEqual(["lock.role_classes"]);
    expect(notRunYet07([p], { modules: {}, promotion: "required" })).toEqual(["lock.promotion"]);
  });

  it("names what it finds in the table's order, whatever order it is found in, each once", () => {
    const p = withGreet(minimal(), (d) => ({ ...d, owner: "reviewer", budget: { ...(d["budget"] as Obj), asks: 1 }, body: [REPORT, STAGE, REPORT, STAGE, ...(d["body"] as unknown[])] }));
    const all = notRunYet07([p, p], { modules: {}, promotion: "required", role_classes: {} });
    expect(all).toEqual(["asks", "lock.role_classes", "owner", "lock.promotion"]);
    expect(refusal07(all)).toMatchObject({ code: "unsupported_language" });
    expect(refusal07(all).message).toBe("unsupported_language: The package uses asks (B3), lock.role_classes (B4), owner (B6), lock.promotion (B6) of mandate/0.7, which this runtime does not run yet (spec/attention.md).");
    expect(namedIn(refusal07(all).message)).toEqual(NOT_RUN_YET_07.map((r) => `${r.name} (${r.slice})`));
  });
});

describe("a package of 0.7 at load", () => {
  it("loads when it holds nothing 0.7 adds: it is a package of 0.6 or later, and of 0.7", () => {
    const pkg = buildPackage(minimal());
    expect(RUNTIME_LANGUAGES).toContain(LANGUAGE_07);
    expect([isPackage06OrLater(pkg), isPackage07OrLater(pkg)]).toEqual([true, true]);
    expect(refusal(pkg)).toBeUndefined();
  });

  it("is refused by name for each construct its program holds, before the compiler's check is asked", () => {
    const p = minimal();
    const cases: Array<[Program, string[]]> = [
      [withGreet(p, (d) => ({ ...d, budget: { ...(d["budget"] as Obj), asks: 1 } })), ["asks (B3)"]],
      [withGreet(p, (d) => ({ ...d, owner: "reviewer" })), ["owner (B6)"]],
      [withGreet(p, (d) => ({ ...d, owner: "reviewer", budget: { ...(d["budget"] as Obj), asks: 1 }, body: [STAGE, ...(d["body"] as unknown[]), REPORT] })), ["asks (B3)", "owner (B6)"]],
    ];
    for (const [program, names] of cases) {
      const e = refusal(buildPackage(program));
      expect(e, names.join(", ")).toMatchObject({ code: "unsupported_language" });
      expect(namedIn(e!.message)).toEqual(names);
    }
  });

  it("is refused by name for role_classes and promotion in its lock, before the lock is read by its schema", () => {
    const p = minimal();
    const roles = { members: { ana: { keys: [`sha256:${"6".repeat(64)}`] } }, roles: { reviewer: ["ana"] } };
    expect(namedIn(refusal(buildPackage(p, { modules: {}, ...roles, role_classes: { reviewer: "confidential" } } as Lock))!.message)).toEqual(["lock.role_classes (B4)"]);
    expect(namedIn(refusal(buildPackage(p, { modules: {}, promotion: "required" } as Lock))!.message)).toEqual(["lock.promotion (B6)"]);
    expect(namedIn(refusal(buildPackage(p, { modules: {}, ...roles, promotion: "required", role_classes: { reviewer: "internal" } } as Lock))!.message)).toEqual(["lock.role_classes (B4)", "lock.promotion (B6)"]);
    // A role_classes that names a role `roles` does not, which the schema of 0.7 refuses (E0140), is named the same.
    expect(namedIn(refusal(buildPackage(p, { modules: {}, role_classes: { nobody: "public" } } as Lock))!.message)).toEqual(["lock.role_classes (B4)"]);
  });

  it("is refused by name for what a module it carries holds, before the module's check is asked", () => {
    const p = minimal();
    const module: Program = { language: LANGUAGE_07, module: "example.attention.parts", version: "0.1", defs: { One: { kind: "workflow", params: [], returns: { ref: "Int" }, caps: [], owner: "reviewer", body: [STAGE, { op: "expr", value: { op: "int", value: 1 } }] } } } as unknown as Program;
    const modules: Modules = { [module.module]: module };
    const lock = { modules: { [module.module]: hashProgram(module as unknown as Json).program } } as Lock;
    const e = refusal(buildPackage({ ...p, uses: [...(p.uses ?? []), { module: module.module, names: ["One"] }] } as Program, lock, modules));
    expect(e).toMatchObject({ code: "unsupported_language" });
    expect(namedIn(e!.message)).toEqual(["owner (B6)"]);
  });

  it("a package of 0.6 is not read by the table: a lock of 0.6 with role_classes is refused by its schema, as before (E0140)", () => {
    const six = { ...minimal(), language: "mandate/0.6" } as unknown as Program;
    const pkg = buildPackage(six, { modules: {}, role_classes: { reviewer: "public" } } as Lock);
    expect(isPackage07OrLater(pkg)).toBe(false);
    const e = refusal(pkg);
    expect(e).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("MDT-E0140") });
  });

  it("a lead's sub-program of a 0.7 parent that holds a construct of the table is not run in a sub-program yet", () => {
    const parent = minimal();
    const sub = { language: LANGUAGE_07, module: "example.attention.minimal.plan_1", version: "0.1", defs: { Sub: { kind: "workflow", params: [], returns: { ref: "Int" }, caps: [], budget: { steps: 1, asks: 1 }, body: [STAGE, { op: "expr", value: { op: "int", value: 1 } }] } } } as unknown as Program;
    expect(subprogramNotRunYet(sub, parent, {})).toEqual(["asks"]);
    const plain = { ...sub, defs: { Sub: { kind: "workflow", params: [], returns: { ref: "Int" }, caps: [], body: [{ op: "expr", value: { op: "int", value: 1 } }] } } } as unknown as Program;
    expect(subprogramNotRunYet(plain, parent, {})).toEqual([]);
  });
});

// ── no gate compares a language or a lock format with one version ───────

const repo = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/**
 * The comparisons of a language or a lock format with one version that may stay, each with its reason: a gate of "0.6"
 * asks `isProgram06OrLater` (or `atLeast`), since every later language keeps the rules of 0.6. None today.
 */
const STRICT_ALLOWED: Record<string, string> = {};

/** A string that is a language version or a lock format: `mandate/0.6`, `mandate/lock/0.7`. */
const VERSION_TEXT = /^mandate\/(lock\/)?\d+\.\d+$/;
/** A constant that names one: `LANGUAGE_06`, `LANGUAGE_VERSION` (the newest), `LOCK_FORMAT_07`, `LOCK_FORMAT`. */
const VERSION_NAME = /^(LANGUAGE_VERSION|LANGUAGE_\d+|LOCK_FORMAT(_\d+)?)$/;

/** Each strict comparison of `text` with one version, as `<line>: <text of the comparison>`. */
function strictComparisons(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const nameOf = (e: ts.Expression): string | undefined => (ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : undefined);
  const version = (e: ts.Expression): boolean => {
    while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    if (ts.isStringLiteralLike(e)) return VERSION_TEXT.test(e.text);
    const n = nameOf(e);
    return n !== undefined && VERSION_NAME.test(n);
  };
  const language = (e: ts.Expression): boolean => nameOf(e) === "language";
  const at = (n: ts.Node): string => `${source.getLineAndCharacterOfPosition(n.getStart()).line + 1}: ${n.getText().replace(/\s+/g, " ")}`;
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken].includes(n.operatorToken.kind)) {
      // A version on either side, or a program's language held to anything but another program's language.
      if (version(n.left) || version(n.right) || (language(n.left) !== language(n.right) && !isNothing(n.left) && !isNothing(n.right))) out.push(at(n));
    }
    if (ts.isCaseClause(n) && version(n.expression)) out.push(at(n));
    ts.forEachChild(n, visit);
  };
  /** `undefined` or `null`, or a `typeof` test: what a language is compared with to ask whether there is one. */
  const isNothing = (e: ts.Expression): boolean => e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === "undefined") || ts.isTypeOfExpression(e) || (ts.isStringLiteralLike(e) && ["string", "object", "undefined"].includes(e.text));
  visit(source);
  return out;
}

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) yield* sources(join(dir, e.name));
    else if (e.name.endsWith(".ts")) yield join(dir, e.name);
  }
}

describe("the sources of the runtime and the bridge", () => {
  it("compare no language or lock format with one version: a gate of 0.6 asks 0.6 or later", () => {
    const found: string[] = [];
    for (const dir of ["runtime/src", "bridge/src"]) {
      for (const file of sources(join(repo, dir))) {
        const name = relative(repo, file).replaceAll("\\", "/");
        for (const c of strictComparisons(name, readFileSync(file, "utf8"))) if (!Object.hasOwn(STRICT_ALLOWED, `${name}:${c.slice(c.indexOf(": ") + 2)}`)) found.push(`${name}:${c}`);
      }
    }
    expect(found, "ask isProgram06OrLater, isPackage06OrLater or atLeast, or name the comparison in STRICT_ALLOWED with its reason").toEqual([]);
  });

  it("would find each form of one (the test of the test)", () => {
    const sample = [
      `if (p.language === LANGUAGE_06) a();`,
      `const b = "mandate/lock/0.6" !== lock.lock;`,
      `const c = program["language"] == "mandate/0.7";`,
      `switch (p.language) { case "mandate/0.6": break; case LANGUAGE_07: break; }`,
      `const d = (o as { language?: unknown }).language === v06;`,
      `const e = format === LOCK_FORMAT_07;`,
      `const f = v === compiler.LANGUAGE_VERSION;`,
      // Not one: an order, a list, another program's language, a test that there is one, another format.
      `const g = atLeast(p.language, LANGUAGE_06) && RUNTIME_LANGUAGES.includes(p.language);`,
      `const h = p.language === q.language || p.language === undefined || typeof p.language === "string";`,
      `const i = table.format !== "mandate/doors/0.1";`,
    ].join("\n");
    expect(strictComparisons("sample.ts", sample).map((c) => Number(c.slice(0, c.indexOf(":"))))).toEqual([1, 2, 3, 4, 4, 5, 6, 7]);
  });
});

// What cannot be shown end to end yet, and waits for the compiler's slices: a program's text that writes a stage, a
// report, asks or owner (the parser reads none of them before RL2 to RL4), so neither `mandate run` nor a world of
// helpers.ts can start one; a construct a library's module or an expansion brings (library_verify and the check read
// none before RL2, and std.patterns 2.0.0, whose stages a 0.7 program without a pin resolves, comes with RL6); a
// lead's sub-program that holds one, which the compiler's check_subprogram refuses before the runtime reads it; and
// a lock of 0.7 with role_classes or promotion as `mandate check` reads it (RL4, RL5). `stage` and `report` left the
// table with slice B2, and are run end to end in test/stages.test.ts.
