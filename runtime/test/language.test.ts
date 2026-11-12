// The language versions this runtime runs (§3.5; spec/envelope.md). The
// compiler reads 0.4, but what 0.4 asks of a run is not in this runtime yet,
// so a package that holds 0.4 code is refused at load, whether the program or
// a module it was packaged with is 0.4. A 0.3 package still loads.

import { readFileSync } from "node:fs";
import { check, hashProgram, loadModules, type Json, type Modules, type Program } from "@mandate/compiler";
import { describe, expect, it } from "vitest";
import { buildPackage, RUNTIME_LANGUAGES, verifyPackage, type Package } from "../src/runtime.js";
import { Violation } from "../src/signals.js";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const DOMAIN = read("fixtures/envelope/domain.mdt");

/** The migration's domain module, declared `version`. */
function domain(version: "0.3" | "0.4"): Modules {
  const text = DOMAIN.replace("mandate @ 0.4", `mandate @ ${version}`);
  expect(text.includes(`mandate @ ${version}`)).toBe(true);
  const { modules, problems } = loadModules([{ file: "domain.mdt", text, kind: "mdt" }]);
  expect(problems).toEqual([]);
  return modules;
}

/** A 0.3 program that uses the domain module's types. */
const REPORT = `mandate @ 0.3

module company.report @ 0.1

use company.domain.{Repo}

fn name_of(r: Repo) -> Text {
  r.name
}
`;

function checked(src: string, modules: Modules): Program {
  const r = check(src, "mdt", { modules });
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

/** What verifyPackage threw, or undefined when it accepted the package. */
function refusal(pkg: Package): unknown {
  try {
    verifyPackage(pkg);
    return undefined;
  } catch (e) {
    return e;
  }
}

const pinned = (modules: Modules) => ({ modules: Object.fromEntries(Object.entries(modules).map(([name, m]) => [name, hashProgram(m as unknown as Json).program])) });

describe("the language versions the runtime runs", () => {
  it("are 0.1 to 0.3", () => {
    expect(RUNTIME_LANGUAGES).toEqual(["mandate/0.1", "mandate/0.2", "mandate/0.3"]);
  });

  it("refuse a package whose program is 0.4 (unsupported_language)", () => {
    const modules = domain("0.4");
    const program = checked(read("fixtures/envelope/migrate-all.mdt"), modules);
    expect(program.language).toBe("mandate/0.4");
    const e = refusal(buildPackage(program, pinned(modules), modules));
    expect(e).toBeInstanceOf(Violation);
    expect(e).toMatchObject({ code: "unsupported_language" });
    expect((e as Violation).message).toContain("mandate/0.4");
  });

  it("refuse a 0.3 program packaged with a 0.4 module (unsupported_language)", () => {
    const modules = domain("0.4");
    const program = checked(REPORT, modules);
    expect(program.language).toBe("mandate/0.3");
    const e = refusal(buildPackage(program, pinned(modules), modules));
    expect(e).toBeInstanceOf(Violation);
    expect(e).toMatchObject({ code: "unsupported_language" });
  });

  it("accept the same 0.3 program packaged with the module declared 0.3", () => {
    const modules = domain("0.3");
    const program = checked(REPORT, modules);
    expect(refusal(buildPackage(program, pinned(modules), modules))).toBeUndefined();
  });
});
