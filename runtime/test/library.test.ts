// A package of 0.6 at load and at run time (spec/library.md "At load", "Hashes, and what the runtime stores",
// "Runtime"): the libraries it carries are held to the lock (`library_digest_mismatch`) and to the configuration's
// revoked digests (`library_revoked`, at load and at resume); what 0.6 has that this runtime does not run yet is
// refused by name (`unsupported_language`, NOT_RUN_YET_06); a program that applies a pattern runs the expansion its
// run stored at its start, on every resume and replay, whatever the compiler would expand now, and a stored
// expansion that is missing or another is not run (`expansion_mismatch`).

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { canonicalize, check, hashProgram, libraryVerify, linkedProgram, load, type Json, type LibraryPin, type LibrarySource, type Lock, type Program } from "@mandate/bridge";
import { withCompiler } from "@mandate/bridge/mode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modulePath } from "../../bridge/src/wasm/module.js";
import { MODULES } from "../../bridge/test/wasm-bytes.js";
import { MemoryBlobs } from "../src/artifacts.js";
import { readConfig } from "../src/control.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { applications, checkAmended, NOT_RUN_YET_06, notRunYet06, subprogramNotRunYet } from "../src/package.js";
import { buildPackage, componentsOf, EXPANDED_MEDIA_TYPE, Runtime, verifyPackage, type Package } from "../src/runtime.js";
import { Crash, Violation } from "../src/signals.js";
import { SimAgents } from "../src/sim.js";
import { closeAll, commandIds, planChecker, world, type World } from "./helpers.js";
import { header, language, lockUnder, relabel, version } from "./relabel.js";
import { BUDGET, CAPS, finish, MODULE, planned, program as planProgram, refusals, run } from "./planning.js";
import { baseOf, RUNNING_PROGRAM_MEDIA_TYPE, type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import { toolUse } from "../src/sim.js";

afterAll(closeAll);


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
const FROM_LIBRARY = relabel(`mandate @ 0.6

module example.greet @ 0.1

use std.{model}
use acme.flows.{Once, Note}

${AGENT}
/// Greets the one the note names.
workflow Greet = Once(work: Greeter.greet)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`);

/** A program that applies a pattern of its own. */
const LOCAL = relabel(`mandate @ 0.6

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
`);

/**
 * A library of two modules, of plain definitions: a function of `acme.two` calls one of `acme.two.types`, which a
 * program that imports the first alone sees only through what the library reaches.
 */
const TWO: LibrarySource = {
  manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.two", version: "1.0.0", modules: ["a.mdt", "b.mdt"] }),
  files: {
    "a.mdt": `mandate @ 0.6\n\nmodule acme.two @ 1.0\n\nuse acme.two.types.{Note, pick}\n\n/// A note's text.\npub fn text_of(n: Note) -> Text ! {} {\n  pick(n)\n}\n`,
    "b.mdt": `mandate @ 0.6\n\nmodule acme.two.types @ 1.0\n\n/// A note.\npub type Note = { text: Text }\n\n/// Nothing names it.\npub type Unused = { n: Int }\n\n/// The text of a note.\npub fn pick(n: Note) -> Text ! {} {\n  n.text\n}\n`,
  },
};

/** A program that imports the library of two modules and applies a pattern of its own, which calls the library's function. */
const TWO_LOCAL = relabel(`mandate @ 0.6

module example.two @ 0.1

use std.{model}
use acme.two.{text_of}
use acme.two.types.{Note}

${AGENT}
/// Asks once, about the note's text.
pattern Ask(
  work: skill(Text) -> Inferred<Text>
) (input: Note) -> Inferred<Text>
{
  delegate work(text_of(input))
}

workflow Greet = Ask(work: Greeter.greet)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`);

/** A program that applies MakerChecker of the built-in std.patterns: its input is a constant written at the application. */
const MAKER = relabel(`mandate @ 0.6

module example.maker @ 0.1

use std.{model, human}
use std.patterns.{MakerChecker}

role editor "Editor"

type Draft = { text: Text }

capability ModelStd = model.infer(tier: standard, max_class: internal)

contract Fine(topic: Text, d: Draft) {
  accept said "The draft says something"
    by static d.text != ""
}

agent Writer {
  role   "Writes a draft on a topic."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill write(topic: Text) -> Inferred<Draft> ! {Model}
}

agent Critic {
  role   "Looks for what is wrong with a draft."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill review(topic: Text, d: Inferred<Draft>) -> Inferred<Draft> ! {Model}
}

/// Writes a draft on tea, and has it checked.
workflow Make = MakerChecker<Text, Draft>(
    input: "tea", make: Writer.write, check: Critic.review, accepted: Fine, owner: editor)
  caps   ModelStd
  budget { time: 10m, steps: 8 }
`);

/** The lock's pin of the built-in std.patterns, as the acceptance lock holds it. */
const STD_PIN = (): LibraryPin => (JSON.parse(read("fixtures/library/invoices.lock.json")) as { libraries: Record<string, LibraryPin> }).libraries["std.patterns"]!;

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

/**
 * Runs `fn` with one more line in the table of what 0.6 has that this runtime does not run yet: `probe`, found where
 * an envelope has `shapes`, as the line `shapes` was found until B12. The table is empty now, and its mechanism stays:
 * these tests show it still refuses by name what a line names.
 */
function withProbeRow<T>(fn: () => T): T {
  const table = NOT_RUN_YET_06 as unknown as Array<(typeof NOT_RUN_YET_06)[number]>;
  table.push({ name: "probe", slice: "T", node: (o, at) => at.key === "envelope" && o["shapes"] !== undefined });
  try {
    return fn();
  } finally {
    table.pop();
  }
}

describe("the table of what 0.6 has that this runtime does not run yet", () => {
  it("holds no line: every construct of 0.6 runs", () => {
    // Connectors, tool.call, a lock's connectors and the batch commit step run (B9; connectors.test.ts); so do
    // human.review and waive by (B10; review.test.ts), and an envelope's shapes (B12; shapes.test.ts).
    expect(NOT_RUN_YET_06.map((r) => [r.name, r.slice])).toEqual([]);
  });
});

describe("a package of 0.6 at load", () => {
  it("is verified with the library its lock pins, and gives the running program its run runs and stores", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    const v = verifyPackage(buildPackage(program, lockWith(FLOWS), {}, [FLOWS]));
    expect(applications(program)).toEqual(["Greet = Once"]);
    expect(v.stored).toBeDefined();
    expect(v.running).toBe(v.stored);
    expect(applications(v.stored!)).toEqual([]);
    expect(Object.keys(v.modules)).toEqual(["acme.flows"]);
    // The running program holds the library's type: it is linked, and is not linked again.
    expect(v.running.defs["Note"]).toMatchObject({ kind: "type" });
    // It is what the compiler's check gives when it is asked (`linked`): the expansion, with other definitions.
    const asked = check(canonicalize(program as unknown as Json), "json", { libraries: [FLOWS], linked: true });
    expect(v.stored).toEqual(asked.linked);
    expect(asked.linked!.defs["Greet"]).toEqual(asked.expanded!.defs["Greet"]);
    expect(check(canonicalize(program as unknown as Json), "json", { libraries: [FLOWS] }).linked).toBeUndefined();
    // A program that applies no pattern, with a lock that pins no library, stores nothing: it runs as it is linked.
    const source = checked(relabel(read("fixtures/library/minimal.mdt")));
    const minimal = verifyPackage(buildPackage(source));
    expect(minimal.stored).toBeUndefined();
    expect(minimal.running).toEqual(linkedProgram(source, {}));
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

  it("links a definition of std.patterns that is not a pattern applied: the compiler's own module, which the package does not carry", () => {
    const lock = { modules: {}, libraries: { "std.patterns": STD_PIN() } } as Lock;
    const text = relabel(`mandate @ 0.6\n\nmodule example.batch @ 0.1\n\nuse std.patterns.{Batch}\n\nfn none(b: Batch<Int, Int>) -> Int {\n  1\n}\n`);
    const program = checked(text);
    const v = verifyPackage(buildPackage(program, lock));
    // The package carries no module of it, and its running program holds the type: the run stores that.
    expect(v.modules).toEqual({});
    expect(v.running.defs["Batch"]).toMatchObject({ kind: "type" });
    expect(v.stored).toBe(v.running);
    expect(linkedProgram(program, {}).defs["Batch"]).toBeUndefined();
    // The lock's pin of it is held to the compiler's own: another digest is not loaded (E1605).
    const wrong = { modules: {}, libraries: { "std.patterns": { ...STD_PIN(), digest: `sha256:${"0".repeat(64)}` } } } as Lock;
    expect(refusal(buildPackage(program, wrong))).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("MDT-E1605") });
    // A lock that does not pin it is not loaded either.
    expect(refusal(buildPackage(program, { modules: {}, libraries: {} } as Lock))).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("MDT-E1605") });
  });

  it("refuses a package that does not carry a library its lock pins, or carries one it does not pin (library_digest_mismatch)", () => {
    const program = checked(FROM_LIBRARY, [FLOWS]);
    expect(refusal(buildPackage(program, lockWith(FLOWS), {}, []))).toMatchObject({ code: "library_digest_mismatch" });
    // A program that imports nothing of it, with a lock that pins nothing.
    const minimal = checked(relabel(read("fixtures/library/minimal.mdt")));
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

  /** The constructs a refusal names, each with its slice: `name (slice)`, in the refusal's order. */
  const namedIn = (message: string): string[] => /The package uses (.*) of mandate\/0\.6, which this runtime does not run yet \(spec\/library\.md\)\.$/.exec(message)?.[1]?.split(", ") ?? [`not a refusal by the table: ${message}`];
  const TABLE = NOT_RUN_YET_06.map((r) => `${r.name} (${r.slice})`);

  it("refuses nothing of connectors and tool.call by name (they run, B9): the program of connectors is verified with the lock that binds them", () => {
    const connectors = fixtureLibrary("acme.connectors");
    const program = load(relabel(read("fixtures/library/drafts.mdt")), "mdt").program!;
    const { lock: _format, ...lock } = lockUnder(JSON.parse(read("fixtures/library/invoices.lock.json")) as Lock & { lock?: string });
    expect(refusal(buildPackage(program, lock as Lock, {}, [connectors]))).toBeUndefined();
  });

  it("loads the acceptance program: neither it nor its running program holds a line of the table (B10 runs its review)", () => {
    const connectors = fixtureLibrary("acme.connectors");
    const lock = JSON.parse(read("fixtures/library/invoices.lock.json")) as Lock & { lock?: string };
    const program = check(relabel(read("fixtures/library/invoices.mdt")), "mdt", { libraries: [connectors], lock });
    expect(program.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const { lock: _format, ...packaged } = lock;
    const pkg = buildPackage(program.program!, packaged as Lock, {}, [connectors]);
    expect(notRunYet06(pkg.program, { lock: packaged as Lock })).toEqual([]);
    expect(refusal(pkg)).toBeUndefined();
    // Its running program, as its check gives it, holds what the pattern of std.patterns brings: its review, and the
    // criterion a person may waive. Nothing of it is a line of the table.
    const running = check(canonicalize(pkg.program as unknown as Json), "json", { libraries: [connectors], lock, linked: true }).linked!;
    expect(applications(running as unknown as Program)).toEqual([]);
    expect(running.defs["Batch"]).toMatchObject({ kind: "type" });
    expect(JSON.stringify(running.defs["MatchInvoices"])).toContain('"name":"review"');
    expect(notRunYet06(running as unknown as Program, { lock: packaged as Lock })).toEqual([]);
    expect(TABLE).toEqual([]);
    expect(namedIn("The package uses probe (T) of mandate/0.6, which this runtime does not run yet (spec/library.md).")).toEqual(["probe (T)"]);
  });

  it("refuses no lock for binding connectors by name (lock.connectors runs, B9): what is wrong with a binding is the check's to say", () => {
    const lock = { modules: {}, connectors: { "example.library.minimal.store": { credential: "made-up", url: "https://store.example/mcp", tools: {} } } } as unknown as Lock;
    const e = refusal(buildPackage(checked(relabel(read("fixtures/library/minimal.mdt"))), lock));
    if (e) expect(e.code).not.toBe("unsupported_language");
    expect(refusal(buildPackage(checked(relabel(read("fixtures/library/minimal.mdt"))), { modules: {}, connectors: {} } as unknown as Lock))).toBeUndefined();
  });

  it("refuses no batch commit step by name (a critical effect in a map body runs, B9)", () => {
    const text = relabel(read("conformance/E1708b/program.mdt"))
      .replace(/\/\/\/ The ERP[\s\S]*?\n}\n\n/, "")
      .replace("capability ErpDraft = tool.call(erp, post_draft)\n", "")
      .replace("caps   ErpDraft, Files", "caps   Files")
      .replace(/  let posted = map d in drafts max 20 \{[\s\S]*?\n  \}\n/, "")
      .replace("use std.{fs, human, tool}", "use std.{fs, human}");
    expect(notRunYet06(checked(text), { lock: { modules: {} } as Lock })).toEqual([]);
    // What is left to refuse it is the check's own: its roles have no members in this lock (E1502).
    expect(refusal(buildPackage(checked(text)))).toMatchObject({ code: "load_verification_failed" });
  });

  const HEAD = relabel(`mandate @ 0.6

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
`);

  it("refuses waive by by no name (it runs, B10): what is left to refuse it is the check's own", () => {
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
    expect(notRunYet06(checked(text), { lock: { modules: {} } as Lock })).toEqual([]);
    // Its roles have no members in this lock (E1502).
    expect(refusal(buildPackage(checked(text)))).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("MDT-E1502") });
  });

  it("refuses human.review by no name (it runs, B10): what is left to refuse it is the check's own", () => {
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
    expect(notRunYet06(checked(text), { lock: { modules: {} } as Lock })).toEqual([]);
    expect(refusal(buildPackage(checked(text)))).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("MDT-E1502") });
  });

  it("loads the migration whose envelope has shapes (B12); a name that is no pattern is the compiler's refusal (E1711), not the table's", () => {
    const lock = JSON.parse(read("fixtures/library/migrate-all.lock.json")) as Lock & { lock?: string };
    const { lock: _format, ...packaged } = lock;
    const program = check(relabel(read("fixtures/library/migrate-all.mdt")), "mdt", { lock });
    expect(program.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const envelope = (program.program!.defs["MigrateAll"] as { envelope: { shapes?: string[] } }).envelope;
    expect(envelope.shapes).toEqual(["FanOutMerge", "MakerChecker"]);
    const pkg = buildPackage(program.program!, packaged as Lock);
    expect(notRunYet06(pkg.program, { lock: packaged as Lock })).toEqual([]);
    expect(refusal(pkg)).toBeUndefined();
    const nope = { ...program.program!, defs: { ...program.program!.defs, MigrateAll: { ...program.program!.defs["MigrateAll"]!, envelope: { ...envelope, shapes: ["Nope"] } } } } as unknown as Program;
    expect(refusal(buildPackage(nope, packaged as Lock))).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("E1711") });
  });

  it("still refuses by name what a line of the table names: the mechanism stays, with the table empty (B12)", () => {
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
    expect(withProbeRow(() => refused(buildPackage(shaped)))).toMatch(/uses probe \(T\) of/);
  });

  it("links a library whose module imports another through what the library reaches, and nothing outside it", () => {
    const program = checked(relabel(`mandate @ 0.6\n\nmodule example.two @ 0.1\n\nuse acme.two.{text_of}\n\nfn one() -> Int {\n  1\n}\n`), [TWO]);
    const v = verifyPackage(buildPackage(program, lockWith(TWO), {}, [TWO]));
    expect(Object.keys(v.modules).sort()).toEqual(["acme.two", "acme.two.types"]);
    // What text_of names of its sibling module (pick, and Note) is in the running program; what nothing names is not.
    expect(Object.keys(v.running.defs).sort()).toEqual(["Note", "one", "pick", "text_of"]);
    expect(v.stored).toBe(v.running);
    // Plain linking, which takes no reach, would leave them out: this is why the run stores its running program.
    expect(Object.keys(linkedProgram(program, v.modules).defs).sort()).toEqual(["one", "text_of"]);
  });

  it("refuses an amendment of a program that applies a pattern, and a sub-program that applies one and was given no running program, by name", () => {
    const program = checked(LOCAL);
    const amended = checkAmended({ parent: program, modules: {}, workflow: "Greet", envelope: {}, lock: { modules: {} } });
    expect(amended.ok).toBe(false);
    expect(amended.diagnostics).toEqual([expect.objectContaining({ code: "unsupported_language", message: expect.stringContaining("Greet = Ask") })]);
    // A sub-program with the application as written, and no running program of it, is not run.
    const sub = { language: language(), module: "example.local.sub1", version: "0.1", defs: { Sub: program.defs["Greet"] } } as unknown as Program;
    expect(subprogramNotRunYet(sub, program, {})).toEqual(["a pattern applied in a sub-program"]);
    // Nor is one whose running program still applies it, or lacks its workflow.
    expect(subprogramNotRunYet(sub, program, {}, sub)).toEqual(["a pattern applied in a sub-program"]);
    expect(subprogramNotRunYet(sub, program, {}, { ...sub, defs: {} })).toEqual(["a pattern applied in a sub-program"]);
    // With its expansion as its running program, it is.
    const expanded = verifyPackage(buildPackage(program)).running;
    const running = { ...sub, defs: { ...expanded.defs, Sub: expanded.defs["Greet"]! } } as unknown as Program;
    expect(subprogramNotRunYet(sub, program, {}, running)).toEqual([]);
    // A running program that holds what the table names is refused by that name.
    const shaped = { ...running, defs: { ...running.defs, Sub: { ...(running.defs["Sub"] as object), envelope: { shapes: ["FanOutMerge"] } } } } as unknown as Program;
    expect(withProbeRow(() => subprogramNotRunYet(sub, program, {}, shaped))).toEqual(["probe"]);
    expect(subprogramNotRunYet(sub, program, {}, shaped)).toEqual([]);
    const plain = { ...sub, defs: { Sub: { kind: "workflow", params: [], returns: { ref: "Int" }, body: [{ op: "expr", value: { op: "int", value: 1 } }] } } } as unknown as Program;
    expect(subprogramNotRunYet(plain, program, {})).toEqual([]);
  });
});

describe("a run of a program that imports a library of two modules and applies a pattern of its own", () => {
  const world2 = (): Promise<World> => world06(TWO_LOCAL, { libraries: [TWO], lock: lockWith(TWO) });

  it("runs to its end: its function calls one of the module its library reaches, which the running program holds", async () => {
    const w = await world2();
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "t1" });
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    expect(run.result).toBe("hello, Ada");
    // The run stored its running program, and its manifest names it by its hash.
    const scope = { tenant: run.tenant, runId: "t1" };
    const [a, ...more] = (await w.rt.artifacts.list(scope)).filter((x) => x.media_type === EXPANDED_MEDIA_TYPE);
    expect(more).toEqual([]);
    const stored = JSON.parse(await w.rt.artifacts.text(scope, a!.ref)) as Program;
    expect((run.manifest as { expanded?: string }).expanded).toBe(hashProgram(stored as unknown as Json).program);
    expect(applications(stored)).toEqual([]);
    expect(stored.defs["pick"]).toMatchObject({ kind: "fn" });
    expect(await w.rt.replayRun("t1")).toEqual({ status: "complete", value: "hello, Ada" });
  });

  it("resumes after a stop, in a runtime of its own, and replays, from what it stored", async () => {
    const w = await world2();
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "t2" })).rejects.toBeInstanceOf(Crash);
    const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
    const resumed = await again.resume("t2");
    expect(resumed.attention, JSON.stringify(resumed.attention)).toBeNull();
    expect(resumed.state).toBe("succeeded");
    expect(resumed.result).toBe("hello, Ada");
    expect(await again.replayRun("t2")).toEqual({ status: "complete", value: "hello, Ada" });
    // The views are given the program's own definitions, expanded, and link the rest themselves.
    const p = await again.runProgram("t2");
    expect(Object.keys(p.program.defs).sort()).toEqual(Object.keys(w.pkg.program.defs).sort());
    expect(applications(p.program)).toEqual([]);
  });

  it("a run of the same program without a pattern, whose lock pins the library, stores its running program too and resumes from it", async () => {
    const src = TWO_LOCAL.replace(/\/\/\/ Asks once[\s\S]*$/, `workflow Greet(input: Note) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  delegate Greeter.greet(text_of(input))\n}\n`);
    expect(src).not.toContain("pattern");
    const w = await world06(src, { libraries: [TWO], lock: lockWith(TWO) });
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "t3" })).rejects.toBeInstanceOf(Crash);
    expect(((await w.rt.getRun("t3")).manifest as { expanded?: string }).expanded).toMatch(/^sha256:/);
    const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
    const resumed = await again.resume("t3");
    expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
    expect(resumed.result).toBe("hello, Ada");
    expect(await again.replayRun("t3")).toEqual({ status: "complete", value: "hello, Ada" });
    // A view of it is given the program as packaged: it applies nothing, so its own definitions are as written.
    const viewed = await again.runProgram("t3");
    expect(viewed.program).toEqual(w.pkg.program);
    expect(viewed.program).toEqual(viewed.source);
  });

  it("starts no workflow the program only imports", async () => {
    const w = await world2();
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "text_of", input: {}, runId: "t4" })).rejects.toMatchObject({ code: "unknown_workflow" });
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Elsewhere", input: {}, runId: "t5" })).rejects.toMatchObject({ code: "unknown_workflow" });
    // A workflow of a library, which the running program holds since the program imports it, is not the program's own.
    const works: LibrarySource = {
      manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.works", version: "1.0.0", modules: ["w.mdt"] }),
      files: {
        "w.mdt": `mandate @ 0.6\n\nmodule acme.works @ 1.0\n\nuse std.{model}\n\n/// The model a helper asks.\npub capability LibModel = model.infer(tier: standard, max_class: internal)\n\n/// Helps.\npub agent Helper {\n  role   "Helps."\n  caps   LibModel\n  budget { time: 2m, steps: 2 }\n  skill help(name: Text) -> Inferred<Text> ! {Model}\n}\n\n/// Helps once.\npub workflow Elsewhere(name: Text) -> Inferred<Text>\n  caps   LibModel\n  budget { time: 5m, steps: 4 }\n{\n  delegate Helper.help(name)\n}\n`,
      },
    };
    const importing = await world06(LOCAL.replace("use std.{model}\n", "use std.{model}\nuse acme.works.{Elsewhere}\n"), { libraries: [works], lock: lockWith(works) });
    expect(verifyPackage(importing.pkg).running.defs["Elsewhere"]).toMatchObject({ kind: "workflow" });
    expect(importing.pkg.program.defs).not.toHaveProperty("Elsewhere");
    await expect(importing.rt.startRun({ pkg: importing.pkg, workflow: "Elsewhere", input: { name: "Ada" }, runId: "t6" })).rejects.toMatchObject({ code: "unknown_workflow" });
    expect(importing.agents.count()).toBe(0);
  });

  it("runs a program that imports a library's workflow written as an application: it is linked as written, and never started", async () => {
    const works: LibrarySource = {
      manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.applied", version: "1.0.0", modules: ["w.mdt"] }),
      files: {
        "w.mdt": `mandate @ 0.6\n\nmodule acme.applied @ 1.0\n\nuse std.{model}\n\n/// The model a helper asks.\npub capability LibModel = model.infer(tier: standard, max_class: internal)\n\n/// Helps.\npub agent Helper {\n  role   "Helps."\n  caps   LibModel\n  budget { time: 2m, steps: 2 }\n  skill help(name: Text) -> Inferred<Text> ! {Model}\n}\n\n/// Asks once.\npub pattern Once(\n  work: skill(Text) -> Inferred<Text>\n) (input: Text) -> Inferred<Text>\n{\n  delegate work(input)\n}\n\n/// Helps once.\npub workflow Elsewhere = Once(work: Helper.help)\n  caps   LibModel\n  budget { time: 5m, steps: 4 }\n`,
      },
    };
    const w = await world06(LOCAL.replace("use std.{model}\n", "use std.{model}\nuse acme.applied.{Elsewhere}\n"), { libraries: [works], lock: lockWith(works) });
    // The compiler accepts it, and its running program holds the library's workflow unexpanded: no fault of the
    // compiler's, and no refusal of the package. The program's own workflow is expanded.
    const v = verifyPackage(w.pkg);
    expect(applications(v.stored!)).toEqual(["Elsewhere = Once"]);
    expect((v.stored!.defs["Greet"] as { apply?: unknown }).apply).toBeUndefined();
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Elsewhere", input: { input: "Ada" }, runId: "t7" })).rejects.toMatchObject({ code: "unknown_workflow" });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "t8" });
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    expect(run.result).toBe("hello, Ada");
    expect(w.agents.count("Helper.help")).toBe(0);
  });

  it("verifies the evidence of a contract only the running program holds: one a library's pattern names", async () => {
    const sure: LibrarySource = {
      manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.sure", version: "1.0.0", modules: ["s.mdt", "rules.mdt"] }),
      files: {
        "rules.mdt": `mandate @ 0.6\n\nmodule acme.sure.rules @ 1.0\n\n/// The answer says something.\npub contract Said(asked: Text, t: Text) {\n  accept said "It says something"\n    by static t != ""\n}\n`,
        "s.mdt": `mandate @ 0.6\n\nmodule acme.sure @ 1.0\n\nuse acme.sure.rules.{Said}\n\n/// Asks once, and holds the answer to Said.\npub pattern Sure(\n  work: skill(Text) -> Inferred<Text>\n) (input: Text) -> Verified<Text, Said>\n{\n  let out = delegate work(input)\n  verify out against Said(input, out)\n}\n`,
      },
    };
    const w = await world06(LOCAL.replace(/\/\/\/ Asks once[\s\S]*$/, "/// Greets, and is sure of it.\nworkflow Greet = Sure(work: Greeter.greet)\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n").replace("use std.{model}\n", "use std.{model}\nuse acme.sure.{Sure}\n"), { libraries: [sure], lock: lockWith(sure) });
    // The program imports the pattern alone: the contract, of another module of the library, is in the running
    // program through what the library reaches, and in no plain linking of the program.
    expect(w.pkg.program.defs).not.toHaveProperty("Said");
    expect(linkedProgram(w.pkg.program, verifyPackage(w.pkg).modules).defs).not.toHaveProperty("Said");
    expect(verifyPackage(w.pkg).stored!.defs["Said"]).toMatchObject({ kind: "contract" });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "t9" });
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    expect(run.result).toMatchObject({ $verified: "hello, Ada", $contract: "Said" });
    const evidence = await w.rt.verifyEvidence("t9");
    // The criterion's record, and (0.6) the record of the verify as a whole, of the contract `*`.
    expect(evidence.map((e) => [e.criterion, e.valid])).toEqual([
      ["*", true],
      ["said", true],
    ]);
    // With a verifier of its own configured, a record holds only as a check of a criterion the program declares: the
    // program read is the run's running program, which has the contract.
    const signer = (w.rt as unknown as { signer: EvidenceSigner }).signer;
    const strict = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts, trustedKeys: [signer.publicKeyPem()],trustedVerifiers: new TrustedKeys([EvidenceSigner.generate().publicKey]) });
    expect((await strict.verifyEvidence("t9")).map((e) => [e.criterion, e.valid])).toEqual([
      ["*", true],
      ["said", true],
    ]);
  });

  it("reads the components and the remote agents of the running program at a start: those a library brings", async () => {
    const sys: LibrarySource = {
      manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.sys", version: "1.0.0", modules: ["sys.mdt"] }),
      files: {
        "sys.mdt": `mandate @ 0.6\n\nmodule acme.sys @ 1.0\n\nuse std.{component, net}\n\nrole keeper "Keeper"\n\n/// The left repository.\npub component left {\n  repo  "acme/left"\n  root  "/work/left"\n  lang  ts\n  owner role "keeper"\n}\n\n/// The left repository, as a capability.\npub capability Repos = component.repo(left)\n\n/// The partner's host.\npub capability Billing = net.https(hosts: ["billing.partner.example"])\n\n/// The partner's agent.\npub agent remote BillingAgent = a2a("https://billing.partner.example/.well-known/agent-card.json")\n  version  "1.0"\n  require  idempotent_messages\n  trust    untrusted\n  caps     Billing\n  skills {\n    quote(order: Text) -> Text\n  }\n`,
      },
    };
    const plain = LOCAL.replace(/\/\/\/ Asks once[\s\S]*$/, "workflow Greet(input: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  delegate Greeter.greet(input)\n}\n");
    // A component the program names only through a capability of the library: plain linking does not see it.
    const lock = (): Lock => ({ ...lockWith(sys), members: { ana: { keys: [`sha256:${"6".repeat(64)}`] } }, roles: { keeper: ["ana"] } }) as unknown as Lock;
    const c = await world06(plain.replace("use std.{model}\n", "use std.{model}\nuse acme.sys.{Repos}\n").replace("  caps   ModelStd\n  budget { time: 5m", "  caps   ModelStd, Repos\n  budget { time: 5m"), { libraries: [sys], lock: lock() });
    expect(componentsOf(c.pkg)).toEqual([]);
    expect(componentsOf(c.pkg, verifyPackage(c.pkg).running)).toEqual([{ name: "left", repo: "acme/left", root: "/work/left" }]);
    // Its run prepares that component's working copy, and its manifest names the base commit.
    const started = await c.rt.startRun({ pkg: c.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "t10" });
    expect(started.state, JSON.stringify(started.attention ?? started.error)).toBe("succeeded");
    expect((started.manifest as { components: object }).components).toEqual({ left: { repo: "acme/left", root: "/work/left", base: expect.any(String) } });
    // A remote agent of the library that requires what its server does not give: the run does not start.
    const r = await world06(plain.replace("use std.{model}\n", "use std.{model}\nuse acme.sys.{BillingAgent}\n"), { libraries: [sys], lock: lock() });
    expect(r.pkg.program.defs).not.toHaveProperty("BillingAgent");
    await expect(r.rt.startRun({ pkg: r.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "t11" })).rejects.toMatchObject({ code: "unsupported_binding" });
  });

  it("a package of 0.6 whose program is of 0.5 is given no running program: its run links its program plainly, and stores none", async () => {
    const older = LOCAL.replace(header(), "mandate @ 0.5").replace(/\/\/\/ Asks once[\s\S]*$/, "workflow Greet(input: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  delegate Greeter.greet(input)\n}\n");
    // Its lock is of the 0.6 format (it has a `libraries` member, which pins none): the package is of 0.6.
    const w = await world(older, { agents: new SimAgents().on("Greeter.greet", (req) => ({ ok: `hello, ${String((req.args as unknown[])[0])}`, cost: { steps: 1 } })), decisions: { mode: "signed" }, lock: { modules: {}, libraries: {} } as unknown as Lock });
    expect(w.pkg.program.language).toBe("mandate/0.5");
    const v = verifyPackage(w.pkg);
    expect(v.stored).toBeUndefined();
    expect(v.running).toEqual(linkedProgram(w.pkg.program, {}));
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "t12" })).rejects.toBeInstanceOf(Crash);
    expect((await w.rt.getRun("t12")).manifest).not.toHaveProperty("expanded");
    expect((await w.rt.artifacts.list({ tenant: "default", runId: "t12" })).filter((x) => x.media_type === EXPANDED_MEDIA_TYPE)).toEqual([]);
    const resumed = await w.rt.resume("t12");
    expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
    expect(resumed.result).toBe("hello, Ada");
  });
});

describe("a run of a program that applies MakerChecker of std.patterns", () => {
  const lock = (): Lock => ({ modules: {}, libraries: { "std.patterns": STD_PIN() }, members: { ana: { keys: [`sha256:${"6".repeat(64)}`] } }, roles: { editor: ["ana"] } }) as unknown as Lock;
  const made = (): Promise<World> => {
    const agents = new SimAgents()
      .on("Writer.write", (req) => ({ ok: { text: `on ${String((req.args as unknown[])[0])}` }, cost: { steps: 1 } }))
      .on("Critic.review", (req) => ({ ok: (req.args as unknown[])[1] as never, cost: { steps: 1 } }));
    return world(MAKER, { agents, decisions: { mode: "signed" }, lock: lock() });
  };
  const VERIFIED = { $verified: { text: "on tea" }, $contract: "Fine" };

  it("runs to its end over simulated agents, and replays: nothing in its expansion is in the table", async () => {
    const w = await made();
    // Its running program holds the expansion and applies nothing; the pattern itself is what its `use` names.
    const v = verifyPackage(w.pkg);
    expect(applications(w.pkg.program)).toEqual(["Make = MakerChecker"]);
    expect(applications(v.stored!)).toEqual([]);
    expect(v.stored!.defs["MakerChecker"]).toMatchObject({ kind: "pattern" });
    expect(notRunYet06(v.stored!, { lock: lock() })).toEqual([]);
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Make", input: {}, runId: "m1" });
    expect(run.state, JSON.stringify(run.attention ?? run.error)).toBe("succeeded");
    // The maker's draft on the constant written at the application, checked, and held to the contract.
    expect(run.result).toMatchObject(VERIFIED);
    expect(w.agents.count("Writer.write")).toBe(1);
    expect(w.agents.count("Critic.review")).toBe(1);
    expect((run.manifest as { expanded?: string }).expanded).toBe(hashProgram(v.stored as unknown as Json).program);
    expect(await w.rt.replayRun("m1")).toMatchObject({ status: "complete", value: VERIFIED });
  });

  it("resumes after a stop, in a runtime of its own, from the running program it stored", async () => {
    const w = await made();
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Make", input: {}, runId: "m2" })).rejects.toBeInstanceOf(Crash);
    const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
    const resumed = await again.resume("m2");
    expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
    expect(resumed.result).toMatchObject(VERIFIED);
    expect(await again.replayRun("m2")).toMatchObject({ status: "complete", value: VERIFIED });
  });
});

describe("the stored expansion", () => {
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
    const real = check(canonicalize(w.pkg.program as unknown as Json), "json", { libraries: [FLOWS], linked: true });
    expect(before.program).toEqual(real.linked);
    const other = JSON.parse(JSON.stringify(before.program).replaceAll('"skill":"greet"', '"skill":"shout"')) as Program;
    const answer = JSON.stringify({ ok: true, output: { program: real.program, spans: {}, diagnostics: [], ok: true, hashes: real.hashes, expanded: real.expanded, linked: other } });
    const doors = { check: MODULES.answering(answer) };
    // It does give another running program: a start now would run that one.
    expect(withCompiler(() => verifyPackage(w.pkg).stored, { doors })).toEqual(other);
    // One that gives none, or one that still applies the pattern, has verified nothing: nothing half expanded runs.
    const answering = (output: object): { check: ReturnType<typeof MODULES.answering> } => ({ check: MODULES.answering(JSON.stringify({ ok: true, output: { program: real.program, spans: {}, diagnostics: [], ok: true, hashes: real.hashes, ...output } })) });
    const failing = (output: object): unknown => {
      try {
        return withCompiler(() => verifyPackage(w.pkg), { doors: answering(output) });
      } catch (e) {
        return e;
      }
    };
    expect(failing({ expanded: real.expanded })).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("gave no running program") });
    expect(failing({ expanded: real.expanded, linked: { ...other, defs: { ...other.defs, Greet: w.pkg.program.defs["Greet"] } } })).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("still applies a pattern (Greet = Once)") });
    expect(failing({ expanded: real.expanded, linked: { ...other, defs: { Note: other.defs["Note"] } } })).toMatchObject({ code: "load_verification_failed", message: expect.stringContaining("lacks the program's") });
    // One whose expansion holds what the table names, which the program as written does not, is refused by that name.
    const shaped = { ...before.program, defs: { ...before.program.defs, Greet: { ...(before.program.defs["Greet"] as object), envelope: { shapes: ["FanOutMerge"] } } } } as unknown as Program;
    expect(notRunYet06(w.pkg.program, { lock: w.pkg.lock })).toEqual([]);
    expect(withProbeRow(() => failing({ expanded: real.expanded, linked: shaped }))).toMatchObject({ code: "unsupported_language", message: expect.stringContaining("uses probe (T) of mandate/0.6") });
    // A runtime of its own (nothing of the run in its memory) resumes and replays the run from the stored expansion.
    const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
    const resumed = await withCompiler(() => again.resume("x2"), { doors });
    expect(resumed.attention, JSON.stringify(resumed.attention)).toBeNull();
    expect(resumed.state).toBe("succeeded");
    expect(resumed.result).toBe("hello, Ada");
    expect(w.agents.count("Greeter.shout")).toBe(0);
    expect(await withCompiler(() => again.replayRun("x2"), { doors })).toEqual({ status: "complete", value: "hello, Ada" });
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

  it("a run of 0.6 stopped by a crash is resumed by another runtime, whatever it holds: a pattern, a library, or neither", async () => {
    const plain = LOCAL.replace(/\/\/\/ Asks once[\s\S]*$/, "workflow Greet(input: Text) -> Inferred<Text>\n  caps   ModelStd\n  budget { time: 5m, steps: 4 }\n{\n  delegate Greeter.greet(input)\n}\n");
    const cases: Array<[string, () => Promise<World>, unknown]> = [
      ["r1", () => world06(LOCAL), { input: "Ada" }],
      ["r2", () => world06(FROM_LIBRARY, { libraries: [FLOWS], lock: lockWith(FLOWS) }), { input: { text: "Ada" } }],
      // Neither a pattern nor a library: nothing is stored, and a resume would link the program again.
      ["r3", () => world06(plain), { input: "Ada" }],
    ];
    for (const [runId, make, input] of cases) {
      const w = await make();
      w.faults.arm("after_record", (i) => i.kind === "delegate");
      await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: input as never, runId })).rejects.toBeInstanceOf(Crash);
      const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
      const resumed = await again.resume(runId);
      expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
      expect(resumed.result).toBe("hello, Ada");
    }
  });

  it("an expansion stored without the definitions its program imports (the form before the running program) is not run", async () => {
    const w = await world06(FROM_LIBRARY, { libraries: [FLOWS], lock: lockWith(FLOWS) });
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "x9" })).rejects.toBeInstanceOf(Crash);
    // What that form stored: the expansion alone, under the same media type, its hash in the manifest.
    const unlinked = check(canonicalize(w.pkg.program as unknown as Json), "json", { libraries: [FLOWS] }).expanded!;
    expect(unlinked.defs).not.toHaveProperty("Note");
    await w.db.query("delete from artifacts where run_id = $1", ["x9"]);
    await w.rt.artifacts.put({ tenant: "default", runId: "x9" }, canonicalize(unlinked as unknown as Json), EXPANDED_MEDIA_TYPE);
    await w.db.query("update runs set manifest = jsonb_set(manifest, '{expanded}', $2::jsonb) where run_id = $1", ["x9", JSON.stringify(hashProgram(unlinked as unknown as Json).program)]);
    const calls = w.agents.count();
    const run = await w.rt.resume("x9");
    expect(run.state).toBe("attention_required");
    expect(run.attention).toMatchObject({ violation: "expansion_mismatch", message: expect.stringContaining("without the definitions its program imports (Note, Once)") });
    expect(w.agents.count()).toBe(calls);
  });

  it("the run views are given the expansion: the program's own definitions as the run runs them", async () => {
    const w = await world06(LOCAL);
    await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: "Ada" }, runId: "x7" });
    const p = await w.rt.runProgram("x7");
    expect(p.source).toEqual(w.pkg.program);
    expect(applications(p.program)).toEqual([]);
    expect(p.program).toEqual(check(canonicalize(w.pkg.program as unknown as Json), "json", {}).expanded);
    // A program that imports a library's definitions: they are the library's, and no definition of the program.
    const l = await world06(FROM_LIBRARY, { libraries: [FLOWS], lock: lockWith(FLOWS) });
    await l.rt.startRun({ pkg: l.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "x8" });
    const q = await l.rt.runProgram("x8");
    expect((await stored(l, "x8")).program.defs["Note"]).toMatchObject({ kind: "type" });
    expect(q.program).toEqual(check(canonicalize(l.pkg.program as unknown as Json), "json", { libraries: [FLOWS] }).expanded);
    expect(Object.keys(q.modules)).toEqual(["acme.flows"]);
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

describe("a lead's sub-program in a run of 0.6", () => {
  let checker: WorkerChecker;
  beforeAll(async () => {
    checker = await planChecker();
  }, 60_000);
  afterAll(() => checker.close());

  // The plan's program of planning.ts in 0.6, with a pattern of its own a sub-program may apply.
  const src = (body = '  delegate work(Item { name: "a" })'): string =>
    planProgram()
      .replace("mandate @ 0.4", header())
      .replace("workflow W(items", `/// Asks once, about one item.\npattern Ask(\n  work: skill(Item) -> Inferred<Text>\n) () -> Inferred<Text>\n{\n${body}\n}\n\nworkflow W(items`);
  const base1 = baseOf(MODULE, 1, language() as never);
  /** The operations of a sub-program whose one workflow applies the parent's pattern. */
  const applying = (): never => {
    const sub = load(`${header()}\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\nworkflow Fix = Ask(work: Worker.fix)\n  caps   ${CAPS}\n  budget ${BUDGET}\n`, "mdt");
    expect(sub.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    return Object.entries(sub.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d })) as never;
  };
  const admissions = async (w: World, runId: string): Promise<Array<{ hash: string; artifact: string; running?: { hash: string; artifact: string } }>> =>
    (await w.rt.journal.events(runId)).filter((e) => e.type === "program_admitted").map((e) => e.data as never);

  it("that applies a pattern of its parent is admitted and runs as the running program its check gave, which is stored with it", async () => {
    const w = await planned(checker, [[toolUse("c1", "check_program", { base: base1, ops: applying() })], [toolUse("s1", "submit_program", { base: base1, ops: applying() })], finish("planned")], { src: src() });
    const r = await run(w, "sp1");
    expect(r.state, JSON.stringify(r.attention ?? r.error)).toBe("succeeded");
    expect(r.result).toBe("planned");
    expect(w.told[0]).toMatchObject({ ok: true });
    expect(refusals(w.told[0])).toEqual([]);
    // It ran: its one delegation, under the command it was admitted as, at the path of the pattern's body in its expansion.
    expect(w.told[1]).toMatchObject({ admitted: true, number: 1, result: "fixed a" });
    expect(await commandIds(w, "sp1", "delegate")).toContain("/defs/W/body/0/value/program/1/defs/Fix/body/0/value");
    // The sub-program is stored as the lead wrote it, under its hash; and what it runs as beside it, under another.
    const [a] = await admissions(w, "sp1");
    const scope = { tenant: "default", runId: "sp1" };
    const written = JSON.parse(await w.rt.artifacts.text(scope, a!.artifact)) as Program;
    expect(applications(written)).toEqual(["Fix = Ask"]);
    expect(hashProgram(written as unknown as Json).program).toBe(a!.hash);
    expect(a!.running).toEqual({ hash: expect.stringMatching(/^sha256:/), artifact: expect.any(String) });
    const running = JSON.parse(await w.rt.artifacts.text(scope, a!.running!.artifact)) as Program;
    expect(hashProgram(running as unknown as Json).program).toBe(a!.running!.hash);
    expect(a!.running!.hash).not.toBe(a!.hash);
    expect((running.defs["Fix"] as { apply?: unknown; body?: unknown[] }).apply).toBeUndefined();
    expect((running.defs["Fix"] as { body?: unknown[] }).body).toHaveLength(1);
    expect(running.defs["Worker"]).toMatchObject({ kind: "agent" });
    expect((await w.rt.artifacts.list(scope)).filter((x) => x.media_type === RUNNING_PROGRAM_MEDIA_TYPE).map((x) => x.ref)).toEqual([a!.running!.artifact]);
    // A replay runs the stored one again, and ends as the run did.
    expect(await w.rt.replayRun("sp1")).toEqual({ status: "complete", value: "planned" });
  });

  it("that applies none is admitted as before: its admission names no running program", async () => {
    const plain = load(`${header()}\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\nworkflow Fix() -> Inferred<Text>\n  caps   ${CAPS}\n  budget ${BUDGET}\n{\n  delegate Worker.fix(Item { name: "a" })\n}\n`, "mdt");
    const opsOf = Object.entries(plain.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d })) as never;
    const w = await planned(checker, [[toolUse("s1", "submit_program", { base: base1, ops: opsOf })], finish("planned")], { src: src() });
    const r = await run(w, "sp2");
    expect(r.state, JSON.stringify(r.attention ?? r.error)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, result: "fixed a" });
    const [a] = await admissions(w, "sp2");
    expect(a).not.toHaveProperty("running");
    expect((await w.rt.artifacts.list({ tenant: "default", runId: "sp2" })).filter((x) => x.media_type === RUNNING_PROGRAM_MEDIA_TYPE)).toEqual([]);
  });

  it("that applies a pattern resumes after a stop from the running program stored at its admission; one that was changed is not run (expansion_mismatch)", async () => {
    const turns = (): Parameters<typeof planned>[1] => [[toolUse("s1", "submit_program", { base: base1, ops: applying() })], finish("planned")];
    const w = await planned(checker, turns(), { src: src() });
    // Stopped once the sub-program's delegation was recorded: it is admitted, and has not ended.
    w.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.includes("/program/1/"));
    await expect(run(w, "sp3")).rejects.toBeInstanceOf(Crash);
    const [a] = await admissions(w, "sp3");
    expect(a!.running).toBeDefined();
    const resumed = await w.rt.resume("sp3");
    expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
    expect(resumed.result).toBe("planned");
    // The same run, once its admission is made to name another hash than what is stored hashes to: a replay runs nothing of it.
    const calls = w.chat.calls.length;
    await w.db.query(`update events set data = jsonb_set(data, '{running,hash}', '"sha256:00"') where run_id = 'sp3' and type = 'program_admitted'`);
    expect(await w.rt.replayRun("sp3")).toMatchObject({ status: "attention_required", reason: { violation: "expansion_mismatch", message: expect.stringContaining("what is stored hashes to") } });
    expect(w.chat.calls).toHaveLength(calls);
    // Another run, whose stored running program is taken away before it resumes: nothing of it runs.
    const v = await planned(checker, turns(), { src: src() });
    v.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.includes("/program/1/"));
    await expect(run(v, "sp4")).rejects.toBeInstanceOf(Crash);
    const [b] = await admissions(v, "sp4");
    await v.db.query("delete from artifacts where run_id = $1 and digest = $2", ["sp4", b!.running!.artifact.replace(/^.*(sha256:[0-9a-f]{64}).*$/, "$1")]);
    const stopped = await v.rt.resume("sp4");
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "expansion_mismatch" });
    expect(String((stopped.attention as { message: string }).message)).toContain("none is stored with the run");
    expect(await v.rt.replayRun("sp4")).toMatchObject({ status: "attention_required", reason: { violation: "expansion_mismatch" } });
    // A third, whose stored running program's bytes are changed: the resume stops for a person, the replay reports it.
    const t = await planned(checker, turns(), { src: src() });
    t.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.includes("/program/1/"));
    await expect(run(t, "sp4b")).rejects.toBeInstanceOf(Crash);
    const [c] = await admissions(t, "sp4b");
    const scope = { tenant: "default", runId: "sp4b" };
    const changed = (await t.rt.artifacts.text(scope, c!.running!.artifact)).replaceAll('"skill":"fix"', '"skill":"break"');
    expect(changed).toContain('"skill":"break"');
    (t.rt.artifacts.blobs as MemoryBlobs).tamper(c!.running!.artifact.replace(/^.*(sha256:[0-9a-f]{64}).*$/, "$1"), new TextEncoder().encode(changed));
    const turnsBefore = t.chat.calls.length;
    const halted = await t.rt.resume("sp4b");
    expect(halted.state).toBe("attention_required");
    expect(halted.attention).toMatchObject({ violation: "expansion_mismatch", message: expect.stringContaining("the bytes stored are not the ones stored then") });
    expect(await t.rt.replayRun("sp4b")).toMatchObject({ status: "attention_required", reason: { violation: "expansion_mismatch" } });
    expect(JSON.stringify(t.chat.calls.slice(turnsBefore))).not.toContain("break");
    // A fourth, whose admission is made to name no running program: its sub-program applies a pattern, and is not run as written.
    const u = await planned(checker, turns(), { src: src() });
    u.faults.arm("after_record", (i) => i.kind === "delegate" && i.id.includes("/program/1/"));
    await expect(run(u, "sp4c")).rejects.toBeInstanceOf(Crash);
    await u.db.query(`update events set data = data - 'running' where run_id = 'sp4c' and type = 'program_admitted'`);
    expect((await admissions(u, "sp4c"))[0]).not.toHaveProperty("running");
    const unexpanded = await u.rt.resume("sp4c");
    expect(unexpanded.state).toBe("attention_required");
    expect(unexpanded.attention).toMatchObject({ violation: "expansion_mismatch", message: expect.stringContaining("Workflow Fix applies a pattern and is not expanded") });
  });

  it("whose running program does not hash to what its check named it by is not admitted (check_failed), and nothing of it runs", async () => {
    const lying: ProgramChecker = {
      check: async (i, ms) => {
        const r = await checker.check(i, ms);
        return "running_hash" in r ? ({ ...r, running_hash: `sha256:${"0".repeat(64)}` } as never) : r;
      },
    };
    const w = await planned(lying, [[toolUse("s1", "submit_program", { base: base1, ops: applying() })], finish("planned")], { src: src() });
    const r = await run(w, "sp5");
    expect(r.state, JSON.stringify(r.attention ?? r.error)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false });
    expect(JSON.stringify(w.told[0])).toContain("does not hash to what the checker named it by");
    expect(await admissions(w, "sp5")).toEqual([]);
    expect((await w.rt.artifacts.list({ tenant: "default", runId: "sp5" })).filter((x) => x.media_type === RUNNING_PROGRAM_MEDIA_TYPE)).toEqual([]);
  });

  const plainOps = (language: string): never => {
    const plain = load(`mandate @ ${language}\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\nworkflow Fix() -> Inferred<Text>\n  caps   ${CAPS}\n  budget ${BUDGET}\n{\n  delegate Worker.fix(Item { name: "a" })\n}\n`, "mdt");
    return Object.entries(plain.program!.defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d })) as never;
  };

  it("that applies no pattern and is given a running program by its check is not admitted (check_failed): it would run in place of what the lead wrote", async () => {
    const lying: ProgramChecker = {
      check: async (i, ms) => {
        const r = await checker.check(i, ms);
        if (!("ok" in r) || !r.ok || !r.program) return r;
        // Another program than the lead wrote, named by its own hash: only that the sub-program applies nothing refuses it.
        const other = JSON.parse(JSON.stringify(r.program).replace('"name":"a"', '"name":"other"')) as Program;
        return { ...r, running: other, running_hash: hashProgram(other as unknown as Json).program } as never;
      },
    };
    const w = await planned(lying, [[toolUse("s1", "submit_program", { base: base1, ops: plainOps(version()) })], finish("planned")], { src: src() });
    const r = await run(w, "sp6");
    expect(r.state, JSON.stringify(r.attention ?? r.error)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: false });
    expect(JSON.stringify(w.told[0])).toContain("a running program for a sub-program that applies no pattern");
    expect(await admissions(w, "sp6")).toEqual([]);
    expect(JSON.stringify(w.chat.calls)).not.toContain("fixed other");
  });

  it("of a parent of 0.4 is checked and admitted as before 0.6: the check's members and the admission's are the old ones", async () => {
    const answers: object[] = [];
    const seeing: ProgramChecker = {
      check: async (i, ms) => {
        const r = await checker.check(i, ms);
        answers.push(r);
        return r;
      },
    };
    const w = await planned(seeing, [[toolUse("s1", "submit_program", { base: baseOf(MODULE, 1), ops: plainOps("0.4") })], finish("planned")]);
    expect(w.pkg.program.language).toBe("mandate/0.4");
    const r = await run(w, "sp7");
    expect(r.state, JSON.stringify(r.attention ?? r.error)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, result: "fixed a" });
    expect(answers.map((a) => Object.keys(a))).toEqual([["ok", "diagnostics", "program", "hash", "workflow"]]);
    const [a] = await admissions(w, "sp7");
    expect(Object.keys(a!).sort()).toEqual(["artifact", "base", "command", "hash", "number", "plan", "reservation", "step", "workflow"]);
    expect((await w.rt.artifacts.list({ tenant: "default", runId: "sp7" })).filter((x) => x.media_type === RUNNING_PROGRAM_MEDIA_TYPE)).toEqual([]);
  });

});
