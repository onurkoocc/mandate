// The version of std.patterns a lead's sub-program reads (spec/attention.md "Which version", slice RL6): the check of a
// sub-program is given no lock, so the runtime hands it the version the package's own lock pins (`std_patterns`), and
// what runs and what is shown is that version. A parent of 0.7 whose lock pins 1.0.0 admits a sub-program that
// applies MakerChecker of std.patterns and runs it with no stage; with a lock that pins 2.0.0 it runs the pattern's two
// stages. (The one pattern of 2.0.0 with reports, BatchWithExceptions, needs connectors to run; the compiler's tests
// hold its sub-program's facts to its four stages and two reports, and to none with 1.0.0:
// crates/mandate-check/tests/patterns_0_7.rs.)
//
// The same check is handed the cap of every role the lock binds (its `role_classes` entry, else `internal`; slice
// RL5b), to which it holds what the sub-program shows each role, and a question that names no role to the lowest of
// them (E1909): the compiler's tests hold the refusal of a sub-program that shows a role
// more than its class (crates/mandate-check/tests/patterns_0_7.rs, asks_0_7.rs); here, that the runtime hands them.
//
// Only the Rust compiler reads 0.7. Every rule holds on PGlite and on PostgreSQL (helpers.ts, MANDATE_TEST_DATABASE_URL).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { check, load, subprogramLinked, type LibraryPin, type Lock, type Program } from "@mandate/bridge";
import { linkedSubprogram } from "../src/package.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { shownPackage, signDecision } from "../src/decisions.js";
import { EvidenceSigner, TrustedKeys } from "../src/evidence.js";
import { baseOf, type ProgramChecker, type WorkerChecker } from "../src/plan.js";
import { MxcAdapter } from "../src/sandbox.js";
import { SimSandboxHost, toolUse, type SimTurn } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { closeAll, planChecker, world, type World } from "./helpers.js";
import { CAPS, finish, leadChat, MODULE, program, run, state } from "./planning.js";

afterAll(closeAll);

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

/** The pin of std.patterns a lock of the repository holds. */
const pinIn = (lock: string): LibraryPin => (JSON.parse(read(lock)) as { libraries: Record<string, LibraryPin> }).libraries["std.patterns"]!;
const ONE = pinIn("fixtures/library/invoices.lock.json");
const TWO = pinIn("fixtures/attention/batch.lock.json");

/** The plan program of planning.ts in 0.7, importing MakerChecker of std.patterns, which its envelope lists. */
const PARENT = program()
  .replace("mandate @ 0.4", "mandate @ 0.7")
  .replace("use std.{fs, git, model}", "use std.{fs, git, model}\nuse std.patterns.{MakerChecker}")
  .replace(
    "agent Lead {",
    `contract Fine(i: Item, s: Text) {
  accept said "The fix says what it did"
    by static s != ""
}

agent Auditor {
  role   "Looks over one fix. Writes nothing."
  caps   RepoRead, ModelStd
  budget { tokens: 3k, steps: 4 }
  skill audit(i: Item, s: Inferred<Text>) -> Inferred<Text> ! {Fs.Read, Model}
}

agent Lead {`,
  )
  .replace("agents: 12 }", "agents: 12 }\n    shapes  [MakerChecker]");

/** The lead's sub-program: MakerChecker applied to one item. */
const SUB = `workflow Fix = MakerChecker<Item, Text>(
    input: Item { name: "a" }, make: Worker.fix, check: Auditor.audit, accepted: Fine, owner: release_manager)
  caps   ${CAPS}
  budget { tokens: 20k, steps: 40, agents: 4 }`;

const BASE = baseOf(MODULE, 1, "mandate/0.7" as never);

/** The sub-program as the operations a lead sends. */
function ops(): Value[] {
  const r = load(`mandate @ 0.7\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${SUB}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return [{ op: "add", path: "/defs/Fix", value: (r.program as unknown as { defs: Record<string, Value> }).defs["Fix"]! }];
}

let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(() => checker.close());

/**
 * The parent on a runtime where Alice approved its envelope, with its lock pinning std.patterns at `pin` and holding
 * `role_classes` when given; its sub-programs checked by `by`, else the worker.
 */
async function parentWith(pin: LibraryPin, o: { role_classes?: Record<string, string>; by?: ProgramChecker } = {}): Promise<World & { told: Obj[] }> {
  const alice = EvidenceSigner.generate();
  const bob = EvidenceSigner.generate();
  const classes = o.role_classes ? { role_classes: o.role_classes } : {};
  const lock = { modules: {}, libraries: { "std.patterns": pin }, members: { alice: { keys: [alice.keyId] }, bob: { keys: [bob.keyId] } }, roles: { platform_lead: ["alice"], release_manager: ["bob"] }, ...classes } as unknown as Lock;
  const w = await world(PARENT, { lock, decisions: { keys: new TrustedKeys([alice.publicKey, bob.publicKey]) }, plan: { checker: o.by ?? checker } });
  const submitting: SimTurn = [toolUse("s1", "submit_program", { base: BASE, ops: ops() })];
  const { chat, told } = leadChat([submitting, finish("planned")]);
  w.adapters.loop = { chat, sandbox: new MxcAdapter({ host: new SimSandboxHost(), schemaVersion: "0.8.0", modelEndpoints: {}, modelsInControlPlane: true }) };
  await w.rt.approveEnvelope(w.pkg, signDecision(alice, shownPackage(w.pkg.hash, "platform_lead"), { kind: "envelope", member: "alice", at: new Date(w.adapters.clock.now()) }));
  return { ...w, told };
}

/** The run's events of the attention types, in order, each as `[type, data]`. */
async function attentionEvents(w: World, runId: string): Promise<Array<[string, Obj]>> {
  return (await w.rt.journal.events(runId)).filter((e) => ["stage_started", "stage_ended", "report"].includes(e.type)).map((e) => [e.type, e.data as Obj]);
}

describe("a sub-program is linked with the version of std.patterns its parent's lock pins, wherever the runtime links one", () => {
  it("gives the pattern of the pinned version to the sub-program linked into its parent (interp.ts, plan.ts, package.ts)", () => {
    const parent = check(PARENT, "mdt").program!;
    const sub = load(`mandate @ 0.7\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\nworkflow Fix() -> Int\n  caps   ${CAPS}\n  budget { tokens: 20k, steps: 40, agents: 4 }\n{\n  1\n}\n`, "mdt").program!;
    const stagesOf = (lock: Lock | undefined): number => {
      const p = linkedSubprogram(sub, parent, {}, lock).defs["MakerChecker"] as unknown as { body?: Array<{ op?: string }> } | undefined;
      expect(p, "the parent's pattern is linked into its sub-program").toBeDefined();
      return (p!.body ?? []).filter((s) => s.op === "stage").length;
    };
    const pinned = (pin: LibraryPin): Lock => ({ modules: {}, libraries: { "std.patterns": pin } }) as unknown as Lock;
    expect(stagesOf(pinned(ONE))).toBe(0);
    expect(stagesOf(pinned(TWO))).toBe(2);
    // A lock that pins none: the version a program of 0.7 reads without a pin, 2.0.0.
    expect(stagesOf(undefined)).toBe(2);
    // A parent before 0.7 is linked as before, given no pin whatever its lock says.
    const six = { ...parent, language: "mandate/0.6" } as unknown as Program;
    expect(linkedSubprogram(sub, six, {}, pinned(TWO))).toEqual(subprogramLinked(sub, six, {}));
  });
});

describe("a lead's sub-program reads std.patterns at the version its parent's lock pins", () => {
  it("with 1.0.0 pinned, is admitted and runs MakerChecker with no stage and no report", async () => {
    const w = await parentWith(ONE);
    const r = await run(w, "one");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1 });
    expect(await attentionEvents(w, "one")).toEqual([]);
  });

  it("with 2.0.0 pinned, runs the pattern's two stages, as its admission's facts give them", async () => {
    const w = await parentWith(TWO);
    const r = await run(w, "two");
    expect(r.state, state(r)).toBe("succeeded");
    expect(w.told[0]).toMatchObject({ admitted: true, number: 1 });
    const program = { plan: "/defs/W/body/0/value", number: 1 };
    expect((await attentionEvents(w, "two")).map(([type, data]) => [type, data["stage"], data["program"]])).toEqual([
      ["stage_started", "make", program],
      ["stage_ended", "make", program],
      ["stage_started", "check", program],
      ["stage_ended", "check", program],
    ]);
  });
});

describe("a lead's sub-program is checked against its parent's lock's role_classes (E1909)", () => {
  /** The worker, with what each check is asked recorded in `asked`. */
  const recording = (asked: Obj[]): ProgramChecker => ({
    check: (input, ms) => {
      asked.push(input as unknown as Obj);
      return checker.check(input, ms);
    },
  });

  it("hands the check the cap of every role the lock binds, internal where its role_classes name none", async () => {
    const cases: Array<[Record<string, string> | undefined, Record<string, string>]> = [
      [undefined, { platform_lead: "internal", release_manager: "internal" }],
      [{ release_manager: "confidential" }, { platform_lead: "internal", release_manager: "confidential" }],
    ];
    for (const [given, handed] of cases) {
      const asked: Obj[] = [];
      const w = await parentWith(TWO, { ...(given ? { role_classes: given } : {}), by: recording(asked) });
      const r = await run(w, "classes");
      expect(r.state, state(r)).toBe("succeeded");
      expect(w.told[0]).toMatchObject({ admitted: true, number: 1 });
      expect(asked.map((i) => i["role_classes"])).toEqual([handed]);
    }
  });
});
