// What a lead (a model) writes, and what a notification carries of it (spec/attention.md "Notifications"): a wait
// inside a lead's sub-program is told by the command the sub-program was admitted under and a digest of the rest,
// never by the names the lead chose for its definitions; an amendment a lead asks for is told without its reason. The
// lead is scripted, and its sub-program checked by the compiler in a worker, as at run time; the run is of 0.7.

import { join } from "node:path";
import { rmSync } from "node:fs";
import { load, type Program, type WorkflowDef } from "@mandate/bridge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { notifyPass, type NotificationsConfig } from "../src/notify.js";
import { baseOf, type WorkerChecker } from "../src/plan.js";
import { SimTool, toolUse } from "../src/sim.js";
import type { Obj, Value } from "../src/values.js";
import { closeAll, planChecker } from "./helpers.js";
import { lines, scratch } from "./notify-world.js";
import { BUDGET, CAPS, finish, MODULE, msg, planned, program, programAt, run, sign, sub, toolStep } from "./planning.js";

const M = "LEAKMARK";
const dirs: string[] = [];
let checker: WorkerChecker;
beforeAll(async () => {
  checker = await planChecker();
}, 60_000);
afterAll(async () => {
  await checker.close();
  await closeAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The planning program of plan.test.ts, as a program of 0.7. */
const src = (o: Parameters<typeof program>[0] = {}): string => program(o).replace("mandate @ 0.4\n", "mandate @ 0.7\n");

/** The definitions of a sub-program of 0.7, written as text, as the operations a lead sends. */
function ops07(defs: string): Value[] {
  const r = load(`mandate @ 0.7\n\nmodule ${MODULE}.plan_1 @ 0.1\n\nuse ${MODULE}\n\n${defs}\n`, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return Object.entries((r.program as Program).defs).map(([name, d]) => ({ op: "add", path: `/defs/${name}`, value: d as unknown as Value }));
}

/** A file channel for every role of the program, each asking for outcomes. */
function channel(): { config: NotificationsConfig; file: string } {
  const d = scratch();
  dirs.push(d);
  const file = join(d, "n.jsonl");
  const roles = Object.fromEntries(["platform_lead", "release_manager"].map((r) => [r, { channels: ["local"], outcomes: true }]));
  return { config: { channels: { local: { file } }, roles, link: "https://mandate.acme.example/runs/{run}?at={command}" }, file };
}

describe("a notification of what a lead wrote", () => {
  it("tells a wait inside a lead's sub-program by the plan's command and a digest, never by the names the lead chose", async () => {
    const tool = new SimTool("git.comment", "reconcilable");
    const name = `${M}Comment`;
    const body = `  let note = delegate Worker.fix(Item { name: "a" })\n  effect git.comment(Item { name: "a" }, "fixed")\n    idempotent_by "a"\n  note`;
    const submit = [toolUse("s1", "submit_program", { base: baseOf(MODULE, 1, "mandate/0.7" as never), ops: ops07(sub(body, BUDGET, `${CAPS}, Merge`, name)) })];
    const w = await planned(checker, [submit, finish("commented")], { src: src({ approve: "git.comment by release_manager" }), tools: [tool] });
    const { config, file } = channel();
    // The channel is in use before the run begins: everything the run does is told.
    await notifyPass(w.db, { config, now: () => w.clock.now() });
    const stopped = await run(w, "sp");
    // The run waits on the release manager's decision, at a command that holds the name the lead chose.
    const command = `${programAt(1)}/defs/${name}/body/1/value/authorize`;
    expect(stopped.waiting).toMatchObject({ kind: "decision", command, request: { role: "release_manager" } });
    await notifyPass(w.db, { config, now: () => w.clock.now() });
    const done = await w.rt.decideAction("sp", msg(), { signed: await sign(w, "sp", "bob", "approve") });
    expect(done.state).toBe("succeeded");
    await notifyPass(w.db, { config, now: () => w.clock.now() });
    const told = lines(file);
    const asked = told.find((n) => n["event"] === "wait_opened" && n["role"] === "release_manager");
    expect(asked?.["command"]).toMatch(new RegExp(`^${programAt(1).replaceAll("/", "\\/")}\\/digest:[0-9a-f]{32}$`));
    expect(String(asked?.["link"])).toMatch(/^https:\/\/mandate\.acme\.example\/runs\/sp\?at=%2Fdefs%2FW%2Fbody%2F0%2Fvalue%2Fprogram%2F1%2Fdigest%3A[0-9a-f]{32}$/);
    expect(told.map((n) => n["event"])).toContain("run_succeeded");
    expect(JSON.stringify(told)).not.toContain(M);
  });

  it("tells an amendment a lead asked for by its wait, without the lead's reason", async () => {
    const wider = load(src({ budget: "{ tokens: 400k, steps: 400, agents: 12 }" }), "mdt");
    expect(wider.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const envelope = (wider.program!.defs["W"] as WorkflowDef).envelope as unknown as Obj;
    const w = await planned(checker, [[toolUse("a1", "request_amendment", { envelope, reason: `${M}-reason: three more repositories` })], finish("went on")], { src: src() });
    const { config, file } = channel();
    await notifyPass(w.db, { config, now: () => w.clock.now() });
    const r = await run(w, "am");
    expect(r.waiting).toMatchObject({ kind: "amendment", command: `${toolStep(1)}/amendment`, request: { reason: `${M}-reason: three more repositories` } });
    await notifyPass(w.db, { config, now: () => w.clock.now() });
    const told = lines(file);
    expect(told.filter((n) => n["event"] === "amendment_requested").map((n) => [n["role"], n["command"]])).toEqual([["platform_lead", `${toolStep(1)}/amendment`]]);
    // One question, told once: its wait_opened is not told again.
    expect(told.filter((n) => n["command"] === `${toolStep(1)}/amendment`)).toHaveLength(1);
    expect(JSON.stringify(told)).not.toContain(M);
  });
});
