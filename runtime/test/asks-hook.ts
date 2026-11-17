// The hook that holds every test run of a package of 0.7 to its attention bound (spec/attention.md "`asks` at run
// time", "The bound holds"; slice B3). A setup file of the runtime's tests (vitest.config.ts): it runs in every test
// file, the superset suites of 0.6 relabelled 0.7 among them, before the file's own code.
//
// Every run a `Runtime` of the test's process starts is noted (`Runtime.prototype.startRun`), and at the end of each
// test every noted run of 0.7 that is still in its database is checked (`checkRun`):
//
// - every wait it opened for a person carries a site tag of the closed list (asks.ts SITE_KINDS), and the tag names a
//   row of the facts in force where the wait stands: the run's (its manifest's, or its latest amendment's), or the
//   sub-program's it was asked in (stored at its admission): `rowOf`, by the rule for effects under the runtime's
//   configuration; a review's escalation names its review's `only: on_escalation` row;
// - a question refused for `asks` opened no wait;
// - the questions it settled are at most the bound under its configuration: its own program's questions at most the
//   bound of the facts in force (the largest, across amendments), each sub-program's at most its own facts' bound; a
//   lead's amendment requests are counted, one each, and bounded by nothing but the run's `asks`. The questions of the
//   `on budget_exceeded` handler are left out (D7). With an `asks` limit, what the budget's `asks` row settled is what
//   the journal shows was asked, and at most the limit;
// - a part whose facts give no bound (`"unbounded"`, or facts a test stood in without totals, or facts it made
//   unreadable to test `facts_mismatch`) is exempt, and listed.
//
// A run in a process a test starts (the command line's tests) is that process's, and not seen here. What the hook
// covered is noted for the end of the test run (bridge/test/compiler-setup.ts `note`): the runs of 0.7 checked and
// the exempt ones, by test file.

import type { AttentionCount, AttentionFacts } from "@mandate/bridge";
import { afterAll, afterEach, beforeAll, expect, inject } from "vitest";
import { note, REPORT_KEY } from "../../bridge/test/compiler-setup.js";
import { boundUnder, rowOf, SITE_KINDS, type SiteTag } from "../src/asks.js";
import type { readFacts as ReadFacts } from "../src/attention.js";
import type { AuthorizePolicy } from "../src/interp.js";
import type { Runtime, StartOptions } from "../src/runtime.js";
import type { Violation as ViolationClass } from "../src/signals.js";
import type { Obj, Value } from "../src/values.js";

// The runtime's modules are imported once the test file has imported its own, so that a test file that mocks one of
// them (vi.mock) has the module it mocked: a setup file that imported them first would hand it the real ones.
let readFacts: typeof ReadFacts;
let Violation: typeof ViolationClass;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const noted = new Map<Runtime, Set<string>>();
const covered = { runs: 0, waits: 0, exempt: [] as string[] };
/** Runs a test writes events of by hand, which no run of the runtime would write: exempt, with why. */
const planted = new Map<string, string>();

/**
 * Exempts the run `runId` from the hook, for the rest of the test file, with the reason listed at the end: for a test
 * that writes a run's journal by hand (an event no run of its program could write), not for a run the runtime drove.
 */
export function plantedRun(runId: string, why: string): void {
  planted.set(runId, why);
}

/** The mark a patched `startRun` carries, so that a file's Runtime is patched once. */
const PATCHED = Symbol.for("mandate.asks-hook");

beforeAll(async () => {
  ({ readFacts } = await import("../src/attention.js"));
  ({ Violation } = await import("../src/signals.js"));
  const { Runtime } = await import("../src/runtime.js");
  const proto = Runtime.prototype as Runtime & { [PATCHED]?: true };
  if (proto[PATCHED]) return;
  const start = proto.startRun;
  proto.startRun = async function (this: Runtime, o: StartOptions) {
    const mark = (id: string): void => void (noted.get(this) ?? noted.set(this, new Set()).get(this)!).add(id);
    // A start that throws may have created its run (a crash in its first drive): noted by the id it was given, when
    // that id is one a text column holds (one that is not was refused before anything was written).
    if (o.runId !== undefined && (o.runId as unknown as { isWellFormed(): boolean }).isWellFormed() && !o.runId.includes(String.fromCharCode(0))) mark(o.runId);
    const run = await start.call(this, o);
    mark(run.run_id);
    return run;
  };
  proto[PATCHED] = true;
});

afterEach(async () => {
  for (const [rt, runs] of noted) {
    for (const runId of [...runs]) {
      let gone = false;
      try {
        gone = !(await checkRun(rt, runId));
      } catch (e) {
        // A database a test closed, or emptied for its next world, holds no run left to check.
        if (e instanceof Violation && e.code === "unknown_run") gone = true;
        else if (isClosed(e)) gone = true;
        else throw e;
      }
      if (gone) runs.delete(runId);
    }
    if (!runs.size) noted.delete(rt);
  }
});

afterAll(() => {
  if (!covered.runs) return;
  const file = String(expect.getState().testPath ?? "").replaceAll("\\", "/").replace(/^.*\/runtime\/test\//, "");
  note(inject(REPORT_KEY as never), `asks hook: ${file}: ${covered.runs} checks of runs of 0.7, ${covered.waits} waits held to their rows; exempt: ${covered.exempt.length ? [...new Set(covered.exempt)].join("; ") : "none"}`);
});

/** Whether `e` says the database is closed (a test closed its own). */
function isClosed(e: unknown): boolean {
  const m = e instanceof Error ? e.message : String(e);
  return /closed|not open|terminat|ended/i.test(m);
}

/** One part of a run: its own program, or a sub-program, with the facts it is held to and what it asked. */
interface Part {
  what: string;
  facts: AttentionFacts[];
  asked: number;
}

/**
 * Checks one run, as the file's header says. False when the run is not a run of 0.7 the hook can read (it is not
 * noted again); true once it is checked.
 */
async function checkRun(rt: Runtime, runId: string): Promise<boolean> {
  const run = await rt.journal.run(runId);
  if (!isObj(run.manifest) || typeof run.manifest["attention"] !== "string") return false;
  const scope = { tenant: run.tenant, runId };
  const authorize = (isObj(run.policy) ? (run.policy as Obj)["authorize"] : undefined) as Record<string, AuthorizePolicy> | undefined;
  const events = await rt.journal.events(runId);
  const exempt = (why: string): true => {
    covered.exempt.push(`${runId}: ${why}`);
    return true;
  };
  if (planted.has(runId)) return exempt(planted.get(runId)!);
  try {
    return await held(rt, runId, run.manifest["attention"], scope, authorize, events, exempt);
  } catch (e) {
    if (e instanceof Violation && e.code === "facts_mismatch") return exempt("facts it stored are not readable (a test of facts_mismatch)");
    throw e;
  }
}

/** The checks of `checkRun` on a run of 0.7 whose manifest names its facts by `named`. */
async function held(rt: Runtime, runId: string, named: string, scope: { tenant: string; runId: string }, authorize: Record<string, AuthorizePolicy> | undefined, events: Array<{ type: string; data: Value }>, exempt: (why: string) => true): Promise<boolean> {
  const facts = await readFacts(rt.artifacts, scope, named, `run ${runId}`);
  covered.runs++;
  const own: Part = { what: `run ${runId}`, facts: [facts], asked: 0 };
  const programs = new Map<string, Part>();
  let amendments = 0;
  const opened = new Map<string, { tag: SiteTag; part: Part }>();
  const refused = new Set<string>();
  const partOf = (command: string): Part => [...programs.entries()].find(([c]) => command.startsWith(`${c}/`))?.[1] ?? own;
  for (const e of events) {
    const d = (isObj(e.data) ? e.data : {}) as Obj;
    if (e.type === "program_admitted" && typeof d["command"] === "string") {
      const part: Part = { what: `sub-program ${String(d["number"])} of ${String(d["plan"])}`, facts: [], asked: 0 };
      if (typeof d["attention"] === "string") part.facts.push(await readFacts(rt.artifacts, scope, d["attention"], part.what));
      programs.set(d["command"], part);
    } else if (e.type === "package_amended" && typeof d["attention"] === "string") {
      own.facts.push(await readFacts(rt.artifacts, scope, d["attention"], `the amendment of run ${runId}`));
    } else if (e.type === "asks_exhausted") {
      expect(SITE_KINDS, `asks_exhausted of ${runId} names a kind of the closed list`).toContain(d["kind"]);
      refused.add(String(d["command"]));
    } else if (e.type === "wait_opened") {
      const command = String(d["command"]);
      const tag = d["site"] as unknown as SiteTag | undefined;
      expect(tag, `the wait ${command} of run ${runId} (0.7) carries a site tag`).toBeDefined();
      expect(SITE_KINDS, `the wait ${command} of run ${runId} has a tag of the closed list`).toContain(tag!.kind);
      expect(refused.has(command), `the wait ${command} of run ${runId} was refused for asks and opened`).toBe(false);
      const part = tag!.kind === "plan" ? own : partOf(command);
      const held = part.facts.at(-1);
      expect(held, `${part.what}, where the wait ${command} stands, stored its attention facts`).toBeDefined();
      expect(rowOf(held!, tag!, { authorize }), `the wait ${command} of run ${runId} (${tag!.kind} at ${tag!.wait}) has its row in the facts of ${part.what}`).toBeDefined();
      covered.waits++;
      opened.set(command, { tag: tag!, part });
      if (tag!.only === "budget_exceeded") continue;
      if (tag!.kind === "plan") amendments++;
      else part.asked++;
    } else if (e.type === "review_escalated") {
      const review = opened.get(String(d["command"]));
      expect(review, `the escalated review ${String(d["command"])} of run ${runId} opened its wait`).toBeDefined();
      expect(rowOf(review!.part.facts.at(-1)!, review!.tag, { escalation: true, authorize }), `the escalation of ${String(d["command"])} of run ${runId} has its row`).toBeDefined();
      if (review!.tag.only !== "budget_exceeded") review!.part.asked++;
    }
  }
  for (const part of [own, ...programs.values()]) {
    const bounds = part.facts.map((f) => boundUnder(f, authorize));
    if (!bounds.length) {
      if (part.asked) expect.fail(`${part.what} of run ${runId} asked ${part.asked} questions and stored no attention facts`);
      continue;
    }
    if (bounds.some((b) => typeof b !== "number")) {
      exempt(`${part.what}: ${bounds.includes(undefined as unknown as AttentionCount) ? "facts without a total" : "unbounded"}`);
      continue;
    }
    const bound = Math.max(...(bounds as number[]));
    expect(part.asked, `${part.what} of run ${runId} asked at most the bound of its facts under the configuration`).toBeLessThanOrEqual(bound);
  }
  const budget = (await rt.journal.budget(runId))["asks"];
  if (budget) {
    const asked = own.asked + amendments + [...programs.values()].reduce((n, p) => n + p.asked, 0);
    expect(budget.settled, `run ${runId}'s asks row settled what its journal shows was asked`).toBe(asked);
    expect(budget.settled, `run ${runId} settled at most its asks limit`).toBeLessThanOrEqual(budget.limit);
  }
  return true;
}
