// Language 0.6 in the bridge (src/library.ts): `atLeast` over every version the bridge reads, the Rust-only door
// `library_verify`, and what the `check` door gives a program of 0.6 that applies a pattern of a library: its
// expanded program.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as compiler from "../../compiler/src/index.js";
import { atLeast, check, checkSubprogram, hashProgram, LANGUAGE_06, libraryVerify, load, LOCK_FORMAT_06, skeleton, type LibrarySource, type Program06, type Shape06, type SubprogramCheck06 } from "../src/index.js";
import { modulePath } from "../src/wasm/module.js";

const needs = existsSync(modulePath()) ? describe : describe.skip;

/** A library of one module: a type and a pattern that names it. */
const FLOWS: LibrarySource = {
  manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.flows", version: "1.0.0", modules: ["flows.mdt"] }),
  files: {
    "flows.mdt": `mandate @ 0.6

module acme.flows @ 1.0

/// A note to greet.
pub type Note = { text: Text }

/// Asks once, about the note's text.
pub pattern Once(
  work: skill(Text) -> Inferred<Text>
) (input: Note) -> Inferred<Text>
{
  delegate work(input.text)
}
`,
  },
};

const APPLIES = `mandate @ 0.6

module example.greet @ 0.1

use std.{model}
use acme.flows.{Once, Note}

capability ModelStd = model.infer(tier: standard, max_class: internal)

agent Greeter {
  role   "Writes one line of greeting."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill greet(name: Text) -> Inferred<Text> ! {Model}
}

workflow Greet = Once(work: Greeter.greet)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`;

describe("atLeast", () => {
  it("is the reference compiler's for 0.1 to 0.5, and reads 0.6 as the newest", () => {
    for (const v of compiler.LANGUAGE_VERSIONS) for (const since of compiler.LANGUAGE_VERSIONS) expect(atLeast(v, since), `${v} ${since}`).toBe(compiler.atLeast(v, since));
    for (const since of compiler.LANGUAGE_VERSIONS) {
      expect(atLeast(LANGUAGE_06, since)).toBe(true);
      expect(atLeast(since, LANGUAGE_06)).toBe(false);
      // What the reference compiler says of 0.6, which it does not know: older than any.
      expect(compiler.atLeast(LANGUAGE_06 as never, since)).toBe(false);
    }
    expect(atLeast(LANGUAGE_06, LANGUAGE_06)).toBe(true);
    expect(atLeast("mandate/0.7" as never, "mandate/0.1")).toBe(false);
  });
});

needs("library_verify and the check of 0.6 on the Rust compiler", () => {
  it("gives a library's digest and its pin", () => {
    const rust = libraryVerify(FLOWS);
    expect(rust).toMatchObject({ ok: true, name: "acme.flows", version: "1.0.0" });
    expect(rust.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rust.pin).toEqual({ version: "1.0.0", digest: rust.digest, modules: { "acme.flows": expect.stringMatching(/^sha256:/) } });
    // Another text is another digest.
    const changed = { ...FLOWS, files: { "flows.mdt": FLOWS.files["flows.mdt"]!.replace("A note to greet.", "A note.") } };
    expect(libraryVerify(changed).digest).not.toBe(rust.digest);
  });

  it("gives no digest for a library that does not read, and a door's refusal of its input as an Error", () => {
    const bad = libraryVerify({ manifest: "{", files: {} });
    expect(bad.ok).toBe(false);
    expect(bad.digest).toBeUndefined();
    expect(() => libraryVerify({ manifest: 1 } as never)).toThrow(Error);
  });

  it("checks a program that applies a pattern of a library it is given, against the lock's pin, and gives the expansion", () => {
    const pin = libraryVerify(FLOWS).pin!;
    const r = check(APPLIES, "mdt", { libraries: [FLOWS] });
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    // The program as written holds the application; the expansion holds the pattern's body, and no `apply`.
    expect(r.program!.defs["Greet"]).toHaveProperty("apply");
    const greet = r.expanded!.defs["Greet"]!;
    expect(greet).not.toHaveProperty("apply");
    expect(greet).toMatchObject({ kind: "workflow", params: [{ name: "input", type: { ref: "Note" } }] });
    // With a lock whose pin is another digest, the program does not check (E1605).
    const wrong = check(APPLIES, "mdt", { lock: { lock: LOCK_FORMAT_06, modules: {}, libraries: { "acme.flows": { ...pin, digest: `sha256:${"0".repeat(64)}` } } } as never, libraries: [FLOWS] });
    expect(wrong.ok).toBe(false);
    expect(wrong.diagnostics.map((d) => d.code)).toContain("MDT-E1605");
    expect(wrong.expanded).toBeUndefined();
  });

  it("gives the running program, linked through the library's reach, only when it is asked for and only of 0.6", () => {
    // Not asked for: the result is as it was.
    expect(check(APPLIES, "mdt", { libraries: [FLOWS] })).not.toHaveProperty("linked");
    const r = check(APPLIES, "mdt", { libraries: [FLOWS], linked: true });
    expect(r.ok).toBe(true);
    const linked = r.linked!;
    // The expansion's workflow, and with it what the program names of the library: its type and its pattern.
    expect(linked.defs["Greet"]).toEqual(r.expanded!.defs["Greet"]);
    expect(linked.defs["Note"]).toMatchObject({ kind: "type" });
    expect(linked.defs["Once"]).toMatchObject({ kind: "pattern" });
    expect(r.expanded!.defs).not.toHaveProperty("Note");
    expect(Object.keys(linked).sort()).toEqual(Object.keys(r.expanded!).sort());
    // The same answer twice, byte for byte.
    expect(JSON.stringify(check(APPLIES, "mdt", { libraries: [FLOWS], linked: true }).linked)).toBe(JSON.stringify(linked));
    // A program that does not check has none, and neither has one of an older language, asked for or not.
    expect(check(APPLIES, "mdt", { linked: true })).not.toHaveProperty("linked");
    const older = APPLIES.replace("mandate @ 0.6", "mandate @ 0.5").replace("use acme.flows.{Once, Note}\n", "").replace("workflow Greet = Once(work: Greeter.greet)", "workflow Greet(name: Text) -> Inferred<Text>");
    const o = check(`${older}{\n  delegate Greeter.greet(name)\n}\n`, "mdt", { linked: true } as never);
    expect(o.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(o).not.toHaveProperty("linked");
  });

  it("answers a program of 0.5 as the reference compiler does whatever `linked` holds", () => {
    const older = `${APPLIES.replace("mandate @ 0.6", "mandate @ 0.5").replace("use acme.flows.{Once, Note}\n", "").replace("workflow Greet = Once(work: Greeter.greet)", "workflow Greet(name: Text) -> Inferred<Text>")}{\n  delegate Greeter.greet(name)\n}\n`;
    const plain = compiler.check(older, "mdt", {});
    expect(plain.ok).toBe(true);
    // A member the reference does not read changes nothing of the answer.
    for (const linked of [true, false, "yes", 1, [], {}]) {
      const r = check(older, "mdt", { linked } as never);
      expect(r, JSON.stringify(linked)).toEqual(plain);
      expect(r).not.toHaveProperty("linked");
    }
    // For a program of 0.6 the member is a boolean.
    expect(() => check(APPLIES, "mdt", { libraries: [FLOWS], linked: "yes" } as never)).toThrow(Error);
  });
});


needs("check_subprogram of a parent whose envelope has `shapes` (B12)", () => {
  const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
  const parent = (): Program06 => check(read("fixtures/library/migrate-all.mdt"), "mdt", {}).program! as Program06;
  /** What a lead's patch is: the definitions of a file of migrate-all.plans/, each added. */
  const ops = (file: string): never => {
    const r = load(read(`fixtures/library/migrate-all.plans/${file}`), "mdt");
    return Object.entries(r.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d })) as never;
  };
  const room = { left: { tokens: 80_000_000, steps: 2000, agents: 200, "spend:USD": 120_000_000 }, writes: [] } as never;
  const submit = (p: Program06, file: string, number: number): SubprogramCheck06 =>
    checkSubprogram({ parent: p, modules: {}, workflow: "MigrateAll", number, base: hashProgram(skeleton(p.module, number, p.language as never) as never).program, ops: ops(file), lead: "internal", room } as never) as SubprogramCheck06;

  it("names the shape an admitted sub-program applies, beside its running program, as the typed result's `shape`", () => {
    const p = parent();
    const fan = submit(p, "fan-out.mdt", 1);
    expect(fan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(fan.ok).toBe(true);
    const shape: Shape06 | undefined = fan.shape;
    expect(shape).toEqual({ pattern: "FanOutMerge", module: "std.patterns" });
    expect(fan.running_hash).toMatch(/^sha256:/);
    expect(submit(p, "maker-checker.mdt", 3).shape).toEqual({ pattern: "MakerChecker", module: "std.patterns" });
  });

  it("refuses a sub-program written out (E1710) and names no shape for it", () => {
    const r = submit(parent(), "written-out.mdt", 2);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toEqual(["MDT-E1710"]);
    expect(r).not.toHaveProperty("shape");
  });

  it("gives no `shape` for a parent whose envelope has none: the result is what it was", () => {
    const p = parent();
    const wf = p.defs["MigrateAll"] as unknown as { envelope: Record<string, unknown> };
    const { shapes: _shapes, ...bare } = wf.envelope;
    const plain = { ...p, defs: { ...p.defs, MigrateAll: { ...wf, envelope: bare } } } as unknown as Program06;
    const r = submit(plain, "fan-out.mdt", 1);
    expect(r.ok).toBe(true);
    expect(r).not.toHaveProperty("shape");
    expect(Object.keys(r)).toEqual(["ok", "diagnostics", "program", "hash", "workflow", "running", "running_hash"]);
  });
});
