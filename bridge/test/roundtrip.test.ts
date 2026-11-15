// Every door-backed function through rust.ts, on real inputs, gives what its TypeScript counterpart (ts.ts) gives:
// the same value by the facade's own equality (src/same.ts), which tells a Map from an object, a Set from an array,
// a member that is undefined from one that is not there, and members in another order. Or both throw.
//
// The inputs: every recorded call of the two crates' doors (crates/*/tests/json_doors/inputs.json), every recorded
// case of the authority decisions (authority-cases.json), and every program of fixtures/ and of the compile cases of
// conformance/, with what each is read with (its modules, its lock), through each function that takes a program,
// its parts, its lock, its views and its documents.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import * as reference from "../src/ts.js";
import * as rust from "../src/rust.js";
import { compareOutcomes, CompilerDivergence, LANGUAGE_06, takeDivergences, type Outcome } from "../src/compare.js";
import { DOOR_BACKED, type DoorBacked } from "../src/doors.js";
import { CompilerFailure } from "../src/wasm/errors.js";
import { modulePath } from "../src/wasm/module.js";
import { argumentsOf, callsOf, CRATES, doorsOf } from "./calls.js";
import { repoRoot } from "./tree.js";

const there = existsSync(modulePath());
const needs = there ? describe : describe.skip;

type Fn = (...a: unknown[]) => unknown;
const T = reference as unknown as Record<string, Fn>;
const R = rust as unknown as Record<string, Fn>;
const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");

/** How a function went: `answered` counts the calls on which both answered, `threw` those on which both threw. */
const seen: Record<string, { answered: number; threw: number }> = Object.fromEntries(Object.keys(DOOR_BACKED).map((n) => [n, { answered: 0, threw: 0 }]));
const wrong: string[] = [];

/**
 * One call of `fn` on both sides, compared as `both` mode compares (compare.ts: by `difference`, under the named
 * rules of vectors/README.md, and with an input of 0.6 the Rust's alone); what differs is kept in `wrong`, with
 * `label`. Gives the Rust's value.
 */
function both(label: string, fn: DoorBacked, args: unknown[]): unknown {
  const run = (f: Fn): Outcome => {
    try {
      return { value: f(...structuredClone(args)) };
    } catch (e) {
      return { threw: e };
    }
  };
  const b = run(R[fn]!);
  if ("threw" in b && b.threw instanceof CompilerFailure) {
    wrong.push(`${label}: ${fn}: ${b.threw.message}`);
    return undefined;
  }
  if (LANGUAGE_06[fn](args)) {
    sixes++;
    return "value" in b ? b.value : undefined;
  }
  const a = run(T[fn]!);
  try {
    compareOutcomes(fn, args, a, b);
  } catch (e) {
    if (!(e instanceof CompilerDivergence)) throw e;
    wrong.push(`${label}: ${fn}: ${e.where}`);
    return undefined;
  }
  if ("threw" in b) seen[fn]!.threw++;
  else seen[fn]!.answered++;
  return "value" in b ? b.value : undefined;
}
let sixes = 0;

/** A program's source with what it is read with. */
interface Source {
  label: string;
  text: string;
  kind: "mdt" | "json";
  modules: Record<string, unknown>;
  lock?: Record<string, unknown>;
}

/** The programs of fixtures/ (each with the modules of its directory and its lock) and of compiler/test/fixtures/syntax. */
function fixtures(): Source[] {
  const out: Source[] = [];
  const dirs = ["fixtures/boundary", "fixtures/envelope", "fixtures/fixbug", "fixtures/fixbug-target", "fixtures/library", "fixtures/system", "compiler/test/fixtures/syntax"];
  for (const dir of dirs) {
    const files = readdirSync(join(repoRoot, dir)).filter((f) => f.endsWith(".mdt") || f.endsWith(".ir.json"));
    // The modules a program of the directory may import: the others, loaded.
    const { modules } = reference.loadModules(files.map((f) => ({ file: f, text: read(`${dir}/${f}`), kind: f.endsWith(".json") ? ("json" as const) : ("mdt" as const) })));
    for (const f of files) {
      const own = join(dir, `${basename(f).replace(/\.(mdt|ir\.json)$/, "")}.lock.json`);
      const shared = join(dir, "mandate.lock.json");
      const lockFile = existsSync(join(repoRoot, own)) ? own : existsSync(join(repoRoot, shared)) ? shared : undefined;
      const lock = lockFile ? (JSON.parse(read(lockFile)) as Record<string, unknown>) : undefined;
      out.push({ label: `${dir}/${f}`, text: read(`${dir}/${f}`), kind: f.endsWith(".json") ? "json" : "mdt", modules, ...(lock ? { lock } : {}) });
    }
  }
  return out;
}

/** The programs of conformance/'s compile cases, with their modules and lock. */
function cases(): Source[] {
  const out: Source[] = [];
  for (const id of readdirSync(join(repoRoot, "conformance")).sort()) {
    const file = join("conformance", id, "case.json");
    if (!existsSync(join(repoRoot, file))) continue;
    const c = JSON.parse(read(file)) as { kind: string; input?: { file?: string; text?: string; kind: "mdt" | "json" }; modules?: string[]; lock?: string | null };
    if (c.kind !== "compile" || !c.input) continue;
    const dir = dirname(file);
    const text = c.input.text ?? read(join(dir, c.input.file!));
    const { modules } = reference.loadModules((c.modules ?? []).map((m) => ({ file: m, text: read(join(dir, m)), kind: m.endsWith(".json") ? ("json" as const) : ("mdt" as const) })));
    const lock = c.lock ? (JSON.parse(read(join(dir, c.lock))) as Record<string, unknown>) : undefined;
    out.push({ label: `conformance/${id}`, text, kind: c.input.kind, modules, ...(lock ? { lock } : {}) });
  }
  return out;
}

type Program = { language: string; module: string; defs: Record<string, { kind: string; caps?: unknown[]; envelope?: unknown }>; uses?: Array<{ module: string }> };

/** Every function that takes a program, its parts, its lock or what is made of them, on one program. */
function program(s: Source): void {
  const opts = { modules: s.modules, ...(s.lock ? { lock: s.lock } : {}) };
  both(s.label, "load", [s.text, s.kind]);
  const r = both(s.label, "check", [s.text, s.kind, opts]) as { ok: boolean; program?: Program; hashes?: { program: string } } | undefined;
  both(s.label, "check", [s.text, s.kind]);
  if (!r?.ok || !r.program) return;
  const p = r.program;
  const used = Object.fromEntries(Object.entries(s.modules).filter(([m]) => (p.uses ?? []).some((u) => u.module === m)));
  const lock = s.lock;
  for (const fn of ["hashProgram", "printProgram", "canonicalize", "programRef", "leadClasses", "modelTiers", "envelopeWorkflows", "architecture", "authority"] as const) both(s.label, fn, [p]);
  both(s.label, "rolesNamed", [p.defs]);
  const linked = both(s.label, "link", [p, used]) as { defs: Record<string, unknown> } | undefined;
  both(s.label, "linkedProgram", [p, used]);
  both(s.label, "cost", [p, lock]);
  both(s.label, "sandboxRequirements", [p, used, lock]);
  both(s.label, "acsTarget", [p, used, lock]);
  const doc = both(s.label, "programDoc", [p, lock, used]);
  both(s.label, "toMarkdown", [doc]);
  both(s.label, "toHtml", [doc]);
  both(s.label, "architectureBlocks", [reference.architecture(p as never)]);
  both(s.label, "authorityBlocks", [reference.authority(p as never)]);
  both(s.label, "semanticDiff", [p, p, lock ? { before: lock, after: lock } : undefined]);
  const diff = both(s.label, "diffDoc", [p, p]);
  both(s.label, "toMarkdown", [diff]);
  both(s.label, "governanceChanges", [p, p, used]);
  const hash = r.hashes!.program;
  both(s.label, "applyPatch", [p, hash, [], used]);
  both(s.label, "checkPatch", [p, hash, [], used]);
  both(s.label, "checkPatch", [p, "sha256:stale", [], used]);
  both(s.label, "skeleton", [p.module, 1, p.language]);
  both(s.label, "parseStrictJson", [reference.canonicalize(p as never)]);
  both(s.label, "loadModules", [[{ file: s.label, text: s.text, kind: s.kind }]]);
  both(s.label, "denialDiagnostics", [p, { format: "mandate/sandbox-denials/0.1", denials: [] }]);
  both(s.label, "domainHash", ["program", p]);
  if (lock) {
    const packaged = both(s.label, "packagedLock", [lock]);
    both(s.label, "packageHash", [hash, packaged]);
    both(s.label, "validateLock", [lock]);
    both(s.label, "sandboxLockChecks", [p, lock]);
    both(s.label, "bindingChecks", [p, lock]);
    if (linked) both(s.label, "roleLockChecks", [p, reference.link(p as never, used as never), { lock: "mandate/lock/0.5", ...lock }]);
  }
  for (const [name, d] of Object.entries(p.defs)) {
    both(`${s.label} ${name}`, "references", [d]);
    if (d.kind === "workflow") {
      both(`${s.label} ${name}`, "workflowBounds", [d]);
      both(`${s.label} ${name}`, "envelopeChanges", [p, p, name, used]);
      if (d.envelope) {
        both(`${s.label} ${name}`, "card", [p, name, opts]);
        const card = both(`${s.label} ${name}`, "cardDoc", [p, name, { ...(lock ? { lock } : {}), modules: used }]);
        both(`${s.label} ${name}`, "toHtml", [card]);
      }
    }
    if (d.kind === "agent") {
      both(`${s.label} ${name}`, "agentModels", [p, d]);
      for (const c of d.caps ?? []) {
        const caps = both(`${s.label} ${name}`, "capsOf", [linked?.defs ?? p.defs, c, { language: p.language }]) as unknown[] | undefined;
        for (const v of caps ?? []) both(`${s.label} ${name}`, "showCap", [v]);
        if (caps) both(`${s.label} ${name}`, "requirementFor", [{ agent: name, def: "sha256:def" }, caps, 60_000, { language: p.language, ...(lock ? { lock } : {}) }]);
      }
    }
  }
}

needs("every door-backed function through rust.ts gives what the TypeScript gives", () => {
  it("on every recorded call of the doors", () => {
    for (const crate of CRATES) {
      const doors = new Map(doorsOf(crate).map((d) => [d.name, d]));
      for (const c of callsOf(crate)) {
        const d = doors.get(c.door)!;
        if (d.ts) both(c.name, d.ts as DoorBacked, argumentsOf(d, c.input));
      }
    }
  }, 120_000);

  it("on every recorded case of the run-time authority decisions", () => {
    const cases = JSON.parse(read("bridge/test/authority-cases.json")) as Array<{ name: string; fn: DoorBacked; input: unknown }>;
    for (const c of cases) both(c.name, c.fn, [c.input]);
  });

  it("on every program of fixtures/ and of the compile cases of conformance/", () => {
    for (const s of [...fixtures(), ...cases()]) program(s);
    // Two versions of one program: a diff with something in it.
    const before = reference.check(read("fixtures/fixbug/fixbug.mdt"), "mdt").program!;
    const after = reference.check(read("fixtures/fixbug-target/fixbug.mdt"), "mdt").program!;
    for (const fn of ["semanticDiff", "diffDoc", "governanceChanges"] as const) both("fixbug to fixbug-target", fn, [before, after]);
    both("fixbug to fixbug-target", "governanceFiles", [new Set(["CODEOWNERS", "src/a.ts", ".github/workflows/ci.yml", "mandate.lock.json"]), ["docs/**"]]);
  }, 300_000);

  it("and every function was asked, and answered at least once", () => {
    // What `wrong` holds was also kept as a divergence; it is reported here, once.
    takeDivergences();
    expect(wrong, wrong.join("\n")).toEqual([]);
    expect(sixes).toBeGreaterThan(0);
    const never = Object.entries(seen).filter(([, n]) => n.answered === 0).map(([f]) => f);
    expect(never).toEqual([]);
    const total = Object.values(seen).reduce((s, n) => s + n.answered + n.threw, 0);
    expect(total).toBeGreaterThan(5000);
  });
});
