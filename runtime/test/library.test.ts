// A package of 0.6 at load and at run time (spec/library.md "At load", "Hashes, and what the runtime stores",
// "Runtime"): the libraries it carries are held to the lock (`library_digest_mismatch`) and to the configuration's
// revoked digests (`library_revoked`, at load and at resume); what 0.6 has that this runtime does not run yet is
// refused by name (`unsupported_language`, NOT_RUN_YET_06); a program that applies a pattern runs the expansion its
// run stored at its start, on every resume and replay, whatever the compiler would expand now, and a stored
// expansion that is missing or another is not run (`expansion_mismatch`).
//
// Only the Rust compiler reads 0.6, so every test that needs a program of 0.6 checked is skipped in `ts` mode; the
// refusal of a 0.6 package by a runtime in `ts` mode is shown with the Rust compiler's module building the package.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { canonicalize, check, hashProgram, libraryVerify, linkedProgram, load, type Json, type LibraryPin, type LibrarySource, type Lock, type Program } from "@mandate/bridge";
import { compilerMode, withCompiler } from "@mandate/bridge/mode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modulePath } from "../../bridge/src/wasm/module.js";
import { MODULES } from "../../bridge/test/wasm-bytes.js";
import { MemoryBlobs } from "../src/artifacts.js";
import { readConfig } from "../src/control.js";
import { applications, checkAmended, NOT_RUN_YET_06, subprogramNotRunYet } from "../src/package.js";
import { buildPackage, EXPANDED_MEDIA_TYPE, Runtime, verifyPackage, type Package } from "../src/runtime.js";
import { Crash, Violation } from "../src/signals.js";
import { SimAgents } from "../src/sim.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { BUDGET, CAPS, finish, MODULE, planned, program as planProgram, refusals, run } from "./planning.js";
import { baseOf, type WorkerChecker } from "../src/plan.js";
import { toolUse } from "../src/sim.js";

afterAll(closeAll);

const rust = compilerMode() !== "ts";
/** The tests that need a program of 0.6 checked: the Rust compiler's alone (23 of them, skipped by name in `ts` mode). */
const needs06 = rust ? describe : describe.skip;
const hasModule = existsSync(modulePath());

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

/** A library of one module: a type, and a pattern that names it in its signature. */
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

const AGENT = `capability ModelStd = model.infer(tier: standard, max_class: internal)

agent Greeter {
  role   "Writes one line of greeting."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill greet(name: Text) -> Inferred<Text> ! {Model}
}
`;

/** A program that applies a pattern of a library, acme.flows. */
const FROM_LIBRARY = `mandate @ 0.6

module example.greet @ 0.1

use std.{model}
use acme.flows.{Once, Note}

${AGENT}
/// Greets the one the note names.
workflow Greet = Once(work: Greeter.greet)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`;

/** A program that applies a pattern of its own. */
const LOCAL = `mandate @ 0.6

module example.local @ 0.1

use std.{model}

${AGENT}
/// Asks once, and gives the answer.
pattern Ask<In, Out>(
  work: skill(In) -> Inferred<Out>
) (input: In) -> Inferred<Out>
{
  delegate work(input)
}

workflow Greet = Ask<Text, Text>(work: Greeter.greet)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`;

const pinOf = (l: LibrarySource): LibraryPin => libraryVerify(l).pin!;
const lockWith = (...ls: LibrarySource[]): Lock => ({ modules: {}, libraries: Object.fromEntries(ls.map((l) => [JSON.parse(l.manifest).name as string, pinOf(l)])) }) as Lock;

/** The program of a text of 0.6, which must check with the libraries given. */
function checked(text: string, libraries: LibrarySource[] = []): Program {
  const r = check(text, "mdt", libraries.length ? { libraries } : {});
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

/** What verifyPackage threw, or undefined. */
function refusal(pkg: Package, o?: Parameters<typeof verifyPackage>[1]): Violation | undefined {
  try {
    verifyPackage(pkg, o);
    return undefined;
  } catch (e) {
    if (e instanceof Violation) return e;
    throw e;
  }
}

/** A library read from a directory of fixtures/library/: its manifest and the files it lists. */
function fixtureLibrary(dir: string): LibrarySource {
  const manifest = read(`fixtures/library/${dir}/mandate.library.json`);
  const files = Object.fromEntries((JSON.parse(manifest).modules as string[]).map((f) => [f, read(`fixtures/library/${dir}/${f}`)]));
  return { manifest, files };
}

/** A run's world over a program of 0.6: signed decisions (a 0.6 package takes no other), a greeter that answers. */
function world06(src: string, o: { libraries?: LibrarySource[]; lock?: Lock; config?: { revoked?: string[] } } = {}): Promise<World> {
  const agents = new SimAgents().on("Greeter.greet", (req) => ({ ok: `hello, ${String((req.args as unknown[])[0])}`, cost: { steps: 1 } }));
  return world(src, { agents, decisions: { mode: "signed" }, lock: o.lock ?? { modules: {} }, ...(o.libraries ? { libraries: o.libraries } : {}), ...(o.config ? { config: o.config } : {}) });
}

describe("the table of what 0.6 has that this runtime does not run yet", () => {
  it("names each construct once, with the slice that releases it", () => {
    expect(NOT_RUN_YET_06.map((r) => [r.name, r.slice])).toEqual([
      ["connector", "B9"],
      ["tool.call", "B9"],
      ["lock.connectors", "B9"],
      ["batch commit step", "B9"],
      ["human.review", "B10"],
      ["waive by", "B10"],
      ["shapes", "B12"],
      ["a library module that imports another module", "a door that links through a library's reach"],
    ]);
  });
});

describe.runIf(hasModule)("a runtime whose compiler is the TypeScript reference", () => {
  it("refuses a package of 0.6 by name: the reference, frozen at 0.5, verifies nothing of it", () => {
    const pkg = withCompiler("rust", () => buildPackage(checked(read("fixtures/library/minimal.mdt"))));
    const e = withCompiler("ts", () => refusal(pkg));
    expect(e).toMatchObject({ code: "unsupported_language" });
    expect(e!.message).toContain("MANDATE_COMPILER=ts");
  });
});

needs06("a package of 0.6 at load", () => {
  it("is verified with the library its lock pins, and gives the expansion its run runs", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    const v = verifyPackage(buildPackage(program, lockWith(FLOWS), {}, [FLOWS]));
    expect(applications(program)).toEqual(["Greet = Once"]);
    expect(v.expanded).toBeDefined();
    expect(v.running).toBe(v.expanded);
    expect(applications(v.expanded!)).toEqual([]);
    expect(Object.keys(v.modules)).toEqual(["acme.flows"]);
    // The run links the library's type into the program it runs.
    expect(linkedProgram(v.running, v.modules).defs["Note"]).toMatchObject({ kind: "type" });
    // A program that applies no pattern runs as it is.
    const minimal = verifyPackage(buildPackage(checked(read("fixtures/library/minimal.mdt"))));
    expect(minimal.expanded).toBeUndefined();
  });

  it("refuses a library whose module was changed after the lock pinned it (library_digest_mismatch)", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    const tampered: LibrarySource = { ...FLOWS, files: { "flows.mdt": FLOWS.files["flows.mdt"]!.replace("A note to greet.", "A note to greet, changed.") } };
    const e = refusal(buildPackage(program, lockWith(FLOWS), {}, [tampered]));
    expect(e).toMatchObject({ code: "library_digest_mismatch" });
    expect(e!.message).toContain("acme.flows");
  });

  it("refuses a library whose manifest was changed, its modules as pinned (library_digest_mismatch on the digest alone)", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    const republished: LibrarySource = { ...FLOWS, manifest: FLOWS.manifest.replace('"1.0.0"', '"1.0.1"') };
    const e = refusal(buildPackage(program, lockWith(FLOWS), {}, [republished]));
    expect(e).toMatchObject({ code: "library_digest_mismatch" });
    expect(e!.message).toContain(`the lock pins ${pinOf(FLOWS).digest}`);
  });

  it("refuses a lock whose pin gives a module another program hash than the module has (library_digest_mismatch)", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    const pin = pinOf(FLOWS);
    const lock = { modules: {}, libraries: { "acme.flows": { ...pin, modules: { "acme.flows": `sha256:${"1".repeat(64)}` } } } } as Lock;
    const e = refusal(buildPackage(program, lock, {}, [FLOWS]));
    expect(e).toMatchObject({ code: "library_digest_mismatch" });
    expect(e!.message).toContain("Module acme.flows of library acme.flows hashes to");
  });

  it("refuses a definition of std.patterns that is not a pattern applied: the runtime is not given that module to link", () => {
    const std = (JSON.parse(read("fixtures/library/invoices.lock.json")) as { libraries: Record<string, LibraryPin> }).libraries["std.patterns"]!;
    const lock = { modules: {}, libraries: { "std.patterns": std } } as Lock;
    const text = `mandate @ 0.6\n\nmodule example.batch @ 0.1\n\nuse std.patterns.{Batch}\n\nfn none(b: Batch<Int, Int>) -> Int {\n  1\n}\n`;
    const e = refusal(buildPackage(checked(text), lock));
    expect(e).toMatchObject({ code: "unsupported_language" });
    expect(e!.message).toContain("std.patterns.Batch");
  });

  it("refuses a package that does not carry a library its lock pins, or carries one it does not pin (library_digest_mismatch)", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    expect(refusal(buildPackage(program, lockWith(FLOWS), {}, []))).toMatchObject({ code: "library_digest_mismatch" });
    // A program that imports nothing of it, with a lock that pins nothing.
    const minimal = checked(read("fixtures/library/minimal.mdt"));
    expect(refusal(buildPackage(minimal, { modules: {}, libraries: {} } as Lock, {}, [FLOWS]))).toMatchObject({ code: "library_digest_mismatch", message: expect.stringContaining("does not pin") });
  });

  it("refuses a package whose library digest the configuration revokes (library_revoked), whatever else holds", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    const pin = pinOf(FLOWS);
    const pkg = buildPackage(program, lockWith(FLOWS), {}, [FLOWS]);
    expect(refusal(pkg, { libraries: { revoked: [`sha256:${"0".repeat(64)}`] } })).toBeUndefined();
    const e = refusal(pkg, { libraries: { revoked: [pin.digest] } });
    expect(e).toMatchObject({ code: "library_revoked" });
    expect(e!.message).toContain(pin.digest);
    // Revoked comes first: a tampered library with a revoked pin is refused as revoked.
    const tampered: LibrarySource = { ...FLOWS, files: { "flows.mdt": `${FLOWS.files["flows.mdt"]!}\n` } };
    expect(refusal(buildPackage(program, lockWith(FLOWS), {}, [tampered]), { libraries: { revoked: [pin.digest] } })).toMatchObject({ code: "library_revoked" });
  });

  /** The refusal of a 0.6 package built from `program` (IR, checked or not), and the names it gives. */
  const refused = (pkg: Package): string => {
    const e = refusal(pkg);
    expect(e, "the package is refused").toMatchObject({ code: "unsupported_language" });
    return e!.message;
  };

  it("refuses connectors and tool.call by name (B9), and the library of connectors, whose module imports another", () => {
    const connectors = fixtureLibrary("acme.connectors");
    const program = load(read("fixtures/library/drafts.mdt"), "mdt").program!;
    const { lock: _format, connectors: _bound, ...lock } = JSON.parse(read("fixtures/library/invoices.lock.json")) as Lock & { lock?: string };
    const message = refused(buildPackage(program, lock as Lock, {}, [connectors]));
    expect(message).toContain("connector (B9)");
    expect(message).toContain("tool.call (B9)");
    expect(message).toContain("a library module that imports another module");
    expect(message).not.toContain("lock.connectors");
  });

  it("refuses a lock that binds connectors by name (lock.connectors, B9), the program aside", () => {
    const lock = { modules: {}, connectors: { "example.library.minimal.store": { credential: "made-up", url: "https://store.example/mcp", tools: {} } } } as unknown as Lock;
    expect(refused(buildPackage(checked(read("fixtures/library/minimal.mdt")), lock))).toMatch(/uses lock\.connectors \(B9\) of mandate\/0\.6/);
    // An empty binding binds nothing, and is no refusal.
    expect(refusal(buildPackage(checked(read("fixtures/library/minimal.mdt")), { modules: {}, connectors: {} } as unknown as Lock))).toBeUndefined();
  });

  it("refuses a batch commit step by name (a critical effect in a map body, B9), though the program checks", () => {
    const text = read("conformance/E1708b/program.mdt")
      .replace(/\/\/\/ The ERP[\s\S]*?\n}\n\n/, "")
      .replace("capability ErpDraft = tool.call(erp, post_draft)\n", "")
      .replace("caps   ErpDraft, Files", "caps   Files")
      .replace(/  let posted = map d in drafts max 20 \{[\s\S]*?\n  \}\n/, "")
      .replace("use std.{fs, human, tool}", "use std.{fs, human}");
    const message = refused(buildPackage(checked(text)));
    expect(message).toMatch(/uses batch commit step \(B9\) of/);
  });

  const HEAD = `mandate @ 0.6

module example.unrun @ 0.1

use std.{model, human}

role reviewer "Reviewer"
role lead     "Lead"

type Item = { key: Text, n: Int }

capability ModelStd = model.infer(tier: standard, max_class: internal)

agent Worker {
  role   "Works on one item."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill work(i: Item) -> Inferred<Item> ! {Model}
}
`;

  it("refuses waive by by name (B10), though the program checks", () => {
    const text = `${HEAD}
contract Fine(i: Item, o: Item) {
  accept same "The key is kept"
    by static o.key == i.key
    waive by reviewer
}

workflow W(i: Item) -> Item
  caps   ModelStd
  budget { time: 30m, steps: 20 }
{
  let out = delegate Worker.work(i)
  verify out against Fine(i, out)
}
`;
    expect(refused(buildPackage(checked(text)))).toMatch(/uses waive by \(B10\) of/);
  });

  it("refuses human.review by name (B10), though the program checks", () => {
    const text = `${HEAD}
contract Fine(i: Item, o: Item) {
  accept same "The key is kept"
    by static o.key == i.key
    waive by reviewer, lead
}

workflow W(items: List<Item>) -> Int
  caps   ModelStd
  budget { time: 30m, steps: 20 }
{
  let checked = map it in items max 3 {
    let out = delegate Worker.work(it)
    verify out against Fine(it, out)
  }
  let reviewed = human.review(checked, role: reviewer, deadline: 1d, escalate_to: lead)
  1
}
`;
    const message = refused(buildPackage(checked(text)));
    expect(message).toContain("human.review (B10)");
  });

  it("refuses shapes in an envelope by name (B12)", () => {
    const text = `${HEAD}
workflow W(i: Item) -> Inferred<Item>
  envelope {
    owner  reviewer
    caps   ModelStd
    budget { time: 30m, steps: 20, agents: 2 }
  }
{
  delegate Worker.work(i)
}
`;
    const program = checked(text);
    const shaped = { ...program, defs: { ...program.defs, W: { ...program.defs["W"]!, envelope: { ...(program.defs["W"] as { envelope: object }).envelope, shapes: ["FanOutMerge"] } } } } as unknown as Program;
    expect(refused(buildPackage(shaped))).toMatch(/uses shapes \(B12\) of/);
  });

  it("refuses a library whose module imports another module (no door links through a library's reach)", () => {
    const two: LibrarySource = {
      manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.two", version: "1.0.0", modules: ["a.mdt", "b.mdt"] }),
      files: {
        "a.mdt": `mandate @ 0.6\n\nmodule acme.two @ 1.0\n\nuse acme.two.types.{Note}\n\n/// A note's text.\npub fn text_of(n: Note) -> Text ! {} {\n  n.text\n}\n`,
        "b.mdt": `mandate @ 0.6\n\nmodule acme.two.types @ 1.0\n\n/// A note.\npub type Note = { text: Text }\n`,
      },
    };
    const program = checked(`mandate @ 0.6\n\nmodule example.two @ 0.1\n\nuse acme.two.{text_of}\n\nfn one() -> Int {\n  1\n}\n`, [two]);
    expect(refused(buildPackage(program, lockWith(two), {}, [two]))).toContain("a library module that imports another module");
  });

  it("refuses an amendment of a program that applies a pattern, and a sub-program that applies one, by name", () => {
    const program = checked(LOCAL);
    const amended = checkAmended({ parent: program, modules: {}, workflow: "Greet", envelope: {}, lock: { modules: {} } });
    expect(amended.ok).toBe(false);
    expect(amended.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_language", message: expect.stringContaining("Greet = Ask") })]);
    // A sub-program as its check gives it, with the application as written, is not run.
    const sub = { language: "mandate/0.6", module: "example.local.sub1", version: "0.1", defs: { Sub: program.defs["Greet"] } } as unknown as Program;
    expect(subprogramNotRunYet(sub, program, {})).toEqual(["a pattern applied in a sub-program"]);
    const plain = { ...sub, defs: { Sub: { kind: "workflow", params: [], returns: { ref: "Int" }, body: [{ op: "expr", value: { op: "int", value: 1 } }] } } } as unknown as Program;
    expect(subprogramNotRunYet(plain, program, {})).toEqual([]);
  });
});

needs06("the stored expansion", () => {
  /** The stored expansion of a run: its artifact, and the program it holds. */
  async function stored(w: World, runId: string): Promise<{ digest: string; program: Program }> {
    const run = await w.rt.getRun(runId);
    const [a, ...more] = (await w.rt.artifacts.list({ tenant: run.tenant, runId })).filter((x) => x.media_type === EXPANDED_MEDIA_TYPE);
    expect(more).toEqual([]);
    return { digest: a!.digest, program: JSON.parse(await w.rt.artifacts.text({ tenant: run.tenant, runId }, a!.ref)) as Program };
  }

  it("is stored when a run of a local pattern starts, its hash in the run's manifest, and the run goes to its end", async () => {
    const w = await world06(LOCAL);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "x1" });
    expect(run.state).toBe("succeeded");
    expect(run.result).toBe("hello, Ada");
    const s = await stored(w, "x1");
    expect((run.manifest as { expanded?: string }).expanded).toBe(hashProgram(s.program as unknown as Json).program);
    expect(applications(s.program)).toEqual([]);
    expect(await w.rt.replayRun("x1")).toEqual({ status: "complete", value: "hello, Ada" });
  });

  it("a run of a library's pattern resumes after a stop and replays from what it stored, whatever the compiler expands now", async () => {
    const w = await world06(FROM_LIBRARY, { libraries: [FLOWS], lock: lockWith(FLOWS) });
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "x2" })).rejects.toBeInstanceOf(Crash);
    const before = await stored(w, "x2");
    // A compiler whose check now gives another expansion of the same package: it calls another skill.
    const real = check(canonicalize(w.pkg.program as unknown as Json), "json", { libraries: [FLOWS] });
    const other = JSON.parse(JSON.stringify(before.program).replaceAll('"skill":"greet"', '"skill":"shout"')) as Program;
    const answer = JSON.stringify({ ok: true, output: { program: real.program, spans: {}, diagnostics: [], ok: true, hashes: real.hashes, expanded: other } });
    const doors = { check: MODULES.answering(answer) };
    // It does give another expansion: a start now would run that one.
    expect(withCompiler(compilerMode(), () => verifyPackage(w.pkg).expanded, { doors })).toEqual(other);
    // A runtime of its own (nothing of the run in its memory) resumes and replays the run from the stored expansion.
    const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
    const resumed = await withCompiler(compilerMode(), () => again.resume("x2"), { doors });
    expect(resumed.attention, JSON.stringify(resumed.attention)).toBeNull();
    expect(resumed.state).toBe("succeeded");
    expect(resumed.result).toBe("hello, Ada");
    expect(w.agents.count("Greeter.shout")).toBe(0);
    expect(await withCompiler(compilerMode(), () => again.replayRun("x2"), { doors })).toEqual({ status: "complete", value: "hello, Ada" });
    expect((await stored(w, "x2")).digest).toBe(before.digest);
  });

  it("a stored expansion that was changed is not run: the resume stops for a person, the replay runs nothing (expansion_mismatch)", async () => {
    const w = await world06(LOCAL);
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "x3" })).rejects.toBeInstanceOf(Crash);
    const s = await stored(w, "x3");
    const changed = JSON.stringify(s.program).replaceAll('"skill":"greet"', '"skill":"shout"');
    (w.rt.artifacts.blobs as MemoryBlobs).tamper(s.digest, new TextEncoder().encode(changed));
    const calls = w.agents.count();
    const run = await w.rt.resume("x3");
    expect(run.state).toBe("attention_required");
    expect(run.attention).toMatchObject({ violation: "expansion_mismatch" });
    expect(w.agents.count()).toBe(calls);
    expect(await w.rt.replayRun("x3")).toMatchObject({ status: "attention_required", reason: { violation: "expansion_mismatch" } });
  });

  it("a stored expansion that reads, and is another program than the manifest names, is not run either", async () => {
    const w = await world06(LOCAL);
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "x3b" })).rejects.toBeInstanceOf(Crash);
    const s = await stored(w, "x3b");
    // Its bytes are whole (the artifact store finds nothing wrong with them); only its hash is not the manifest's.
    const other = JSON.parse(JSON.stringify(s.program).replaceAll('"skill":"greet"', '"skill":"shout"')) as Program;
    await w.db.query("delete from artifacts where run_id = $1", ["x3b"]);
    await w.rt.artifacts.put({ tenant: "default", runId: "x3b" }, JSON.stringify(other), EXPANDED_MEDIA_TYPE);
    const run = await w.rt.resume("x3b");
    expect(run.attention).toMatchObject({ violation: "expansion_mismatch" });
    expect(String((run.attention as { message: string }).message)).toContain("no expansion stored with the run hashes to it");
    expect(w.agents.count("Greeter.shout")).toBe(0);
  });

  it("a run whose manifest names an expansion that is not stored is not run either", async () => {
    const w = await world06(LOCAL);
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "x4" })).rejects.toBeInstanceOf(Crash);
    await w.db.query("delete from artifacts where run_id = $1", ["x4"]);
    const run = await w.rt.resume("x4");
    expect(run.attention).toMatchObject({ violation: "expansion_mismatch" });
    expect(String((run.attention as { message: string }).message)).toContain("none is stored");
  });

  it("a revoked library digest refuses a start, and stops a run at its next resume (library_revoked)", async () => {
    const pin = pinOf(FLOWS);
    const refusedStart = await world06(FROM_LIBRARY, { libraries: [FLOWS], lock: lockWith(FLOWS), config: { revoked: [pin.digest] } });
    await expect(refusedStart.rt.startRun({ pkg: refusedStart.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "x5" })).rejects.toMatchObject({ code: "library_revoked" });
    const w = await world06(FROM_LIBRARY, { libraries: [FLOWS], lock: lockWith(FLOWS) });
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "x6" })).rejects.toBeInstanceOf(Crash);
    const revoking = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts, libraries: { revoked: [pin.digest] } });
    const run = await revoking.resume("x6");
    expect(run.state).toBe("attention_required");
    expect(run.attention).toMatchObject({ violation: "library_revoked" });
  });

  it("the run views are given the expansion: the program the run runs", async () => {
    const w = await world06(LOCAL);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "x7" });
    const p = await w.rt.runProgram("x7");
    expect(p.source).toEqual(w.pkg.program);
    expect(applications(p.program)).toEqual([]);
    expect(p.program).toEqual((await stored(w, "x7")).program);
  });
});

describe("the runtime's configuration of libraries", () => {
  const dir = mkdtempSync(join(tmpdir(), "mdt-libraries-config-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const config = (libraries: unknown): string => {
    const file = join(dir, `c${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify({ database: "pglite:db", libraries }));
    return file;
  };

  it("reads dir, wait_days and revoked, and refuses anything else", () => {
    const digest = `sha256:${"ab".repeat(32)}`;
    const c = readConfig(config({ dir: "libs", wait_days: 7, revoked: [digest] }));
    expect(c.libraries).toEqual({ dir: join(dir, "libs"), wait_days: 7, revoked: [digest] });
    for (const bad of [{ other: 1 }, { wait_days: -1 }, { wait_days: 1.5 }, { revoked: ["sha256:short"] }, { revoked: "x" }, { dir: "" }, []]) {
      expect(() => readConfig(config(bad)), JSON.stringify(bad)).toThrow(Violation);
    }
  });
});

needs06("a lead's sub-program in a run of 0.6", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(() => checker.close());

  it("that applies a pattern is refused at its check by name (check_failed), and nothing of it runs", async () => {
    // The plan's program of planning.ts in 0.6, with a pattern of its own a sub-program may apply.
    const src = planProgram()
      .replace("mandate @ 0.4", "mandate @ 0.6")
      .replace("workflow W(items", "/// Asks once, about one item.\npattern Ask(\n  work: skill(Item) -> Inferred<Text>\n) () -> Inferred<Text>\n{\n  delegate work(Item { name: \"a\" })\n}\n\nworkflow W(items");
    const sub = load(`mandate @ 0.6\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\nworkflow Fix = Ask(work: Worker.fix)\n  caps   ${CAPS}\n  budget ${BUDGET}\n`, "mdt");
    expect(sub.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const opsOf = Object.entries(sub.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d }));
    const w = await planned(checker, [[toolUse("c1", "check_program", { base: baseOf(MODULE, 1, "mandate/0.6" as never), ops: opsOf as never })], finish()], { src });
    const r = await run(w, "sp1");
    expect(r.state, JSON.stringify(r.attention ?? r.error)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ ok: false });
    expect(refusals(w.told[0])).toEqual([["check_failed", null, { reason: "not_run_yet", constructs: ["a pattern applied in a sub-program"] }]]);
  });
});
