// The language versions this runtime runs (§3.5; spec/envelope.md). Of 0.4 it
// runs roles and signed decisions. An envelope, `map`, `plan` and the `agents`
// budget dimension are read by the compiler and not run here yet, and the
// compiler does not check the envelope's own rules yet either, so a package
// that uses one of them is refused at load, by name. A 0.4 package also needs
// every role it names bound to a member in its lock.

import { readFileSync } from "node:fs";
import { check, hashProgram, loadModules, type Json, type Modules, type Program } from "@mandate/compiler";
import { describe, expect, it } from "vitest";
import { buildPackage, isSigned04, notRunYet, RUNTIME_LANGUAGES, verifyPackage, type Lock, type Package } from "../src/runtime.js";
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

/** A 0.4 program that uses nothing of 0.4 but a role. */
const ASK = `mandate @ 0.4

module example.ask @ 0.1

use std.{human, model}

role reviewer "Reviewer"

capability M = model.infer(tier: standard)

agent A {
  caps   M
  budget { steps: 2 }
  skill s(x: Text) -> Inferred<Text> ! {Model}
}

workflow W(xs: List<Text>) -> Text
  caps M
  budget { steps: 20 }
{
  let go = human.ask("Go on?", role: reviewer)
  "done"
}
`;

function checked(src: string, modules: Modules = {}): Program {
  const r = check(src, "mdt", { modules });
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

/** `ASK` with one change, which must still check. */
function changed(from: string, to: string): Program {
  expect(ASK.includes(from), from).toBe(true);
  return checked(ASK.replace(from, to));
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

const KEY = `sha256:${"3f".repeat(32)}`;
/** A lock that binds the reviewer. */
const BOUND: Lock = { modules: {}, members: { bob: { keys: [KEY] } }, roles: { reviewer: ["bob"] } };

describe("the language versions the runtime runs", () => {
  it("are 0.1 to 0.4", () => {
    expect(RUNTIME_LANGUAGES).toEqual(["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4"]);
  });

  it("accept a 0.4 program that names a role, with a lock that binds it", () => {
    const program = checked(ASK);
    expect(program.language).toBe("mandate/0.4");
    expect(notRunYet(program)).toEqual([]);
    expect(refusal(buildPackage(program, BOUND))).toBeUndefined();
  });

  it("refuse the migration example, which has an envelope, a map, a plan and an agents budget (unsupported_language)", () => {
    const modules = domain("0.4");
    const program = checked(read("fixtures/envelope/migrate-all.mdt"), modules);
    expect(notRunYet(program)).toEqual(["agents", "envelope", "map", "plan"]);
    const e = refusal(buildPackage(program, pinned(modules), modules));
    expect(e).toBeInstanceOf(Violation);
    expect(e).toMatchObject({ code: "unsupported_language" });
    expect((e as Violation).message).toContain("agents, envelope, map, plan of mandate/0.4");
  });

  it.each([
    ["an envelope", "  caps M\n  budget { steps: 20 }\n{", "  envelope {\n    owner  reviewer\n    caps   M\n    budget { steps: 20, agents: 3 }\n  }\n{", ["agents", "envelope"]],
    ["a map", `  "done"`, `  let rs = map x in xs max 3 { delegate A.s(x) }\n  "done"`, ["map"]],
    ["a plan", `  "done"`, `  let r = plan A.s("x") within envelope\n  "done"`, ["plan"]],
    ["an agents budget", "budget { steps: 20 }", "budget { steps: 20, agents: 3 }", ["agents"]],
  ])("refuse a 0.4 program with %s, and name it", (_what, from, to, names) => {
    const program = changed(from, to);
    expect(notRunYet(program)).toEqual(names);
    const e = refusal(buildPackage(program, BOUND));
    expect(e).toMatchObject({ code: "unsupported_language" });
    expect((e as Violation).message).toContain(`${names.join(", ")} of mandate/0.4`);
  });

  it("refuse a 0.3 program packaged with a module that has a map", () => {
    const withMap = ASK.replace("module example.ask @ 0.1", "module example.lib @ 0.1").replace(`  "done"`, `  let rs = map x in xs max 3 { delegate A.s(x) }\n  "done"`);
    const { modules, problems } = loadModules([{ file: "lib.mdt", text: withMap, kind: "mdt" }]);
    expect(problems).toEqual([]);
    const program = checked(`mandate @ 0.3\n\nmodule example.user @ 0.1\n\nuse example.lib.{A}\n\nfn one() -> Int {\n  1\n}\n`, modules);
    expect(refusal(buildPackage(program, pinned(modules), modules))).toMatchObject({ code: "unsupported_language" });
  });

  it("accept a 0.3 program packaged with a 0.4 module of types, and with the module declared 0.3", () => {
    for (const version of ["0.4", "0.3"] as const) {
      const modules = domain(version);
      const program = checked(REPORT, modules);
      expect(program.language).toBe("mandate/0.3");
      expect(refusal(buildPackage(program, pinned(modules), modules))).toBeUndefined();
      // A package with any 0.4 code takes signed decisions only.
      expect(isSigned04(program, modules)).toBe(version === "0.4");
    }
  });
});

describe("the roles of a 0.4 package at load (E1502)", () => {
  it("refuse a package whose lock binds no member to a role it names (unbound_role)", () => {
    const program = checked(ASK);
    for (const lock of [{ modules: {} }, { modules: {}, members: { bob: { keys: [KEY] } }, roles: { other: ["bob"] } }] as Lock[]) {
      const e = refusal(buildPackage(program, lock));
      expect(e).toMatchObject({ code: "unbound_role" });
      expect((e as Violation).message).toContain("reviewer");
    }
  });

  it("refuse a lock whose role lists someone who is not a member, or whose key is under two members (malformed_lock)", () => {
    const program = checked(ASK);
    expect(refusal(buildPackage(program, { modules: {}, members: { bob: { keys: [KEY] } }, roles: { reviewer: ["carol"] } }))).toMatchObject({ code: "malformed_lock" });
    expect(refusal(buildPackage(program, { modules: {}, members: { bob: { keys: [KEY] }, eve: { keys: [KEY] } }, roles: { reviewer: ["bob"] } }))).toMatchObject({ code: "malformed_lock" });
  });

  it("leave an earlier program alone: it names roles by any text, and its lock need bind none", () => {
    const program = checked(ASK.replace("mandate @ 0.4", "mandate @ 0.3").replace(`role reviewer "Reviewer"\n`, "").replace("role: reviewer", `role: "reviewer"`));
    expect(program.language).toBe("mandate/0.3");
    expect(refusal(buildPackage(program, { modules: {} }))).toBeUndefined();
  });
});
