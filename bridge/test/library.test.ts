// Language 0.6 in the bridge (src/library.ts): `atLeast` over every version the bridge reads, the Rust-only door
// `library_verify` in each mode (the Rust's in `rust` and `both`, a named refusal in `ts`), and what the `check`
// door gives a program of 0.6 that applies a pattern of a library: its expanded program.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as compiler from "../../compiler/src/index.js";
import { atLeast, check, LANGUAGE_06, libraryVerify, LOCK_FORMAT_06, NoReference, type LibrarySource } from "../src/index.js";
import { exemptionCounts } from "../src/compare.js";
import { withCompiler } from "../src/mode.js";
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

describe("library_verify in `ts` mode", () => {
  it("has no reference to answer it, and says so by name: it never passes", () => {
    withCompiler("ts", () => {
      expect(() => libraryVerify(FLOWS)).toThrow(NoReference);
      expect(() => libraryVerify(FLOWS)).toThrow(/libraryVerify reads language 0.6.*MANDATE_COMPILER=ts/);
    });
  });
});

needs("library_verify and the check of 0.6 on the Rust compiler", () => {
  it("gives a library's digest and its pin, the same in `rust` and in `both`, where it is counted as 0.6", () => {
    const rust = withCompiler("rust", () => libraryVerify(FLOWS));
    expect(rust).toMatchObject({ ok: true, name: "acme.flows", version: "1.0.0" });
    expect(rust.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(rust.pin).toEqual({ version: "1.0.0", digest: rust.digest, modules: { "acme.flows": expect.stringMatching(/^sha256:/) } });
    const before = exemptionCounts()["language-0.6"]!;
    expect(withCompiler("both", () => libraryVerify(FLOWS))).toEqual(rust);
    expect(exemptionCounts()["language-0.6"]).toBe(before + 1);
    // Another text is another digest.
    const changed = { ...FLOWS, files: { "flows.mdt": FLOWS.files["flows.mdt"]!.replace("A note to greet.", "A note.") } };
    expect(withCompiler("rust", () => libraryVerify(changed)).digest).not.toBe(rust.digest);
  });

  it("gives no digest for a library that does not read, and a door's refusal of its input as an Error", () => {
    const bad = withCompiler("rust", () => libraryVerify({ manifest: "{", files: {} }));
    expect(bad.ok).toBe(false);
    expect(bad.digest).toBeUndefined();
    expect(() => withCompiler("rust", () => libraryVerify({ manifest: 1 } as never))).toThrow(Error);
  });

  it("checks a program that applies a pattern of a library it is given, against the lock's pin, and gives the expansion", () => {
    const pin = withCompiler("rust", () => libraryVerify(FLOWS)).pin!;
    withCompiler("rust", () => {
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
  });
});

