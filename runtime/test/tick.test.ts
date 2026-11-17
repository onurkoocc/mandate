// The driver loop (spec/attention.md "The driver loop"): one pass ticks every run that waits, each under its own
// package, and then sends the notifications of 0.7 runs. In a 0.7 run `tick` acts on every open wait whose deadline
// has passed, not only on the one `runs.waiting` names, and drives a run whose wait was decided and not driven on; a
// run of 0.1 to 0.6 is ticked as it always was, and is never notified. A tick acts under the run's lock and is
// idempotent: two passes racing on one run act once, and a decided run is driven only once it has been still for
// `STALE_DRIVE_MS`. A runtime is built only for a run with something due. The clock is simulated, and the channels are
// files.

import { join } from "node:path";
import { rmSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db.js";
import { payloadOf } from "../src/decisions.js";
import { notifyPass } from "../src/notify.js";
import { driveLoop, MAX_INTERVAL_MS, STALE_DRIVE_MS, tickPass, type PassOptions, type PassReport } from "../src/tick.js";
import type { Obj } from "../src/values.js";
import { closeAll } from "./helpers.js";
import { answer, approveCard, BATCH, BOTH, brief, count, DAY, fileChannels, HOUR, lines, msg, nworld, OWNED, REVIEW, REVIEW_AT, scratch, sign, type NWorld } from "./notify-world.js";

const dirs: string[] = [];
afterAll(async () => {
  await closeAll();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function dir(): string {
  const d = scratch();
  dirs.push(d);
  return d;
}

/** A pass over the world's runs by its clock, its one runtime ticking each, with these notifications (none: `--no-notify`). */
function pass(w: NWorld, notify?: PassOptions["notify"]) {
  const now = () => w.clock.now();
  return tickPass(w.db, { runtimeFor: async () => ({ rt: w.rt }), now, ...(notify ? { notify: { now, ...notify } } : {}) });
}

const types = async (w: NWorld, runId: string, type: string): Promise<Obj[]> => (await w.rt.journal.events(runId)).filter((e) => e.type === type).map((e) => e.data as Obj);
const requestOf = (r: { waiting: unknown }): Obj => ((r.waiting as Obj)["request"] ?? {}) as Obj;

describe("a pass of the driver loop over a 0.7 run", () => {
  it("escalates a review past its deadline and tells both roles in order; past the escalated deadline the review expires", async () => {
    const w = await nworld(REVIEW, "0.7");
    const d = dir();
    const config = fileChannels(d, { accountant: false, finance_lead: true }, "https://mandate.acme.example/runs/{run}?role={role}&at={command}");
    const started = await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "r1" });
    expect(started.state).toBe("waiting");
    // Within the deadline a pass moves nothing, and tells the accountant what is asked of them.
    const first = await pass(w, { config });
    expect(first).toMatchObject({ waiting: 1, moved: 0, failed: 0, notify: { sent: 2, dead: 0 } });
    expect(lines(join(d, "accountant.jsonl")).map(brief)).toEqual([`review_requested accountant ${REVIEW_AT}`]);
    expect(lines(join(d, "finance_lead.jsonl"))).toEqual([]);
    // A day later the pass escalates it, once, and tells the finance lead.
    w.clock.advance(DAY);
    const second = await pass(w, { config });
    expect(second).toMatchObject({ waiting: 1, moved: 1, notify: { sent: 2 } });
    expect(await types(w, "r1", "review_escalated")).toEqual([{ command: REVIEW_AT, from: "accountant", to: "finance_lead", deadline: w.clock.now() + DAY }]);
    expect(requestOf(await w.rt.getRun("r1"))).toMatchObject({ role: "finance_lead" });
    const lead = lines(join(d, "finance_lead.jsonl"));
    expect(lead.map(brief)).toEqual([`review_escalated finance_lead ${REVIEW_AT}`]);
    expect(lead[0]).toMatchObject({ kind: "decision", class: "S0", deadline: w.clock.now() + DAY, link: `https://mandate.acme.example/runs/r1?role=finance_lead&at=${encodeURIComponent(REVIEW_AT)}` });
    // A pass before the escalated deadline does nothing more.
    w.clock.advance(DAY - 1);
    expect(await pass(w, { config })).toMatchObject({ moved: 0, notify: { sent: 0 } });
    // Past it the review expires, the run ends, and the finance lead, who asked for outcomes, is told.
    w.clock.advance(1);
    expect(await pass(w, { config })).toMatchObject({ moved: 1, notify: { sent: 2 } });
    const done = await w.rt.getRun("r1");
    expect(done.state).toBe("succeeded");
    expect(await types(w, "r1", "review_expired")).toEqual([{ command: REVIEW_AT, role: "finance_lead", declined: [1, 2] }]);
    expect(lines(join(d, "finance_lead.jsonl")).map(brief)).toEqual([`review_escalated finance_lead ${REVIEW_AT}`, "run_succeeded finance_lead"]);
    // The channel both roles share has all of it, in the run's order.
    const all = lines(join(d, "all.jsonl"));
    expect(all.map(brief)).toEqual([`review_requested accountant ${REVIEW_AT}`, `review_escalated finance_lead ${REVIEW_AT}`, "run_succeeded finance_lead"]);
    expect(all.map((n) => n["seq"] as number)).toEqual([...all.map((n) => n["seq"] as number)].sort((a, b) => a - b));
    // The cursors stand at the run's last event.
    const last = Number((await w.db.query<{ n: unknown }>("select max(seq) as n from events where run_id = 'r1'"))[0]!.n);
    expect((await w.db.query<{ channel: string; seq: unknown }>("select channel, seq from notify_cursors where run_id = 'r1' order by channel")).map((c) => [c.channel, Number(c.seq)])).toEqual([
      ["accountant", last],
      ["all", last],
      ["finance_lead", last],
    ]);
  });

  it("expires every open wait past its deadline, not only the one runs.waiting names; a 0.6 run expires that one alone", async () => {
    for (const language of ["0.7", "0.6"] as const) {
      const w = await nworld(BOTH, language);
      const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Both", input: { n: { text: "x" } }, runId: `b${language}` });
      expect(r.state).toBe("waiting");
      expect(await count(w, "select count(*) as n from commands where run_id = $1 and state = 'waiting'", [r.run_id])).toBe(2);
      w.clock.advance(2 * HOUR);
      await pass(w);
      const expired = (await types(w, r.run_id, "wait_expired")).map((e) => e["command"]);
      if (language === "0.7") {
        // One pass: both waits expired, each once, and the run went on to its end: neither approval came, so it failed.
        expect(expired).toHaveLength(2);
        expect(new Set(expired).size).toBe(2);
        const ended = await w.rt.getRun(r.run_id);
        expect([ended.state, ended.error]).toEqual(["failed", { $tag: "Rejected", $args: [{ unmet: ["first"], contract: "FirstOk" }] }]);
        expect((await w.rt.journal.events(r.run_id)).map((e) => e.type).slice(-6)).toEqual(["run_waiting", "wait_expired", "wait_expired", "lease_acquired", "run_running", "run_failed"]);
      } else {
        // As before 0.7: the wait runs.waiting names, and the run waits on the other one until the next tick.
        expect(expired).toHaveLength(1);
        expect((await w.rt.getRun(r.run_id)).state).toBe("waiting");
        await pass(w);
        expect(await types(w, r.run_id, "wait_expired")).toHaveLength(2);
      }
    }
  });

  it("tells how a run that the tick pass itself ends ended: it began after the channel was in use, and its questions expired", async () => {
    const w = await nworld(BOTH, "0.7");
    const d = dir();
    const config = fileChannels(d, { accountant: true, finance_lead: false });
    // The channels are in use before the run begins.
    await pass(w, { config });
    await w.rt.startRun({ pkg: w.pkg, workflow: "Both", input: { n: { text: "x" } }, runId: "ends" });
    w.clock.advance(2 * HOUR);
    // Its two questions expired in the pass: they are no longer asked, and only the outcome is told, on the role's
    // own channel and on the one all roles share.
    expect(await pass(w, { config })).toMatchObject({ moved: 1, notify: { sent: 2 } });
    expect((await w.rt.getRun("ends")).state).toBe("failed");
    expect(lines(join(d, "all.jsonl")).map((n) => `${String(n["event"])} ${String(n["role"])}`)).toEqual(["run_failed accountant"]);
  });

  it("drives a run whose decision was given and not driven on; a 0.6 run's decision waits for its deadline, as before", async () => {
    for (const language of ["0.7", "0.6"] as const) {
      const w = await nworld(BOTH, language);
      const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Both", input: { n: { text: "x" } }, runId: `d${language}` });
      const waited = String((r.waiting as Obj)["command"]);
      // The drive after the decision fails before it takes the run (a crash, a compiler that is not there).
      const resume = w.rt.resume.bind(w.rt);
      let failing = true;
      w.rt.resume = async (runId: string) => {
        if (failing) {
          failing = false;
          throw new Error("the drive did not run");
        }
        return resume(runId);
      };
      const who = (await w.rt.shown(r.run_id, "wait")).role === "accountant" ? w.who.ana : w.who.ben;
      await expect(w.rt.decideAction(r.run_id, msg(), { signed: await sign(w, r.run_id, who, "approve") })).rejects.toThrow("the drive did not run");
      const stuck = await w.rt.getRun(r.run_id);
      expect(stuck.state).toBe("waiting");
      expect((stuck.waiting as Obj)["command"]).toBe(waited);
      // Within the grace period the decider's own drive may be on its way: a pass takes nothing from it.
      w.clock.advance(STALE_DRIVE_MS - 1);
      expect(await pass(w)).toMatchObject({ due: 0, moved: 0 });
      expect((await w.rt.getRun(r.run_id)).revision).toBe(stuck.revision);
      w.clock.advance(1);
      const report = await pass(w);
      const after = await w.rt.getRun(r.run_id);
      if (language === "0.7") {
        // Still for 30 s: driven on, it now waits on the other approval, and nothing expired.
        expect(report.moved).toBe(1);
        expect(after.state).toBe("waiting");
        expect((after.waiting as Obj)["command"]).not.toBe(waited);
      } else {
        expect(report.moved).toBe(0);
        expect(after.revision).toBe(stuck.revision);
      }
      expect(await types(w, r.run_id, "wait_expired")).toEqual([]);
    }
  });

  it("tells the owner role of a wait that asks no role, and the owner and the outcome roles of how it ended", async () => {
    const w = await nworld(OWNED, "0.7");
    await approveCard(w);
    const d = dir();
    const config = fileChannels(d, { platform_lead: false, reviewer: false });
    const r = await w.rt.startRun({ pkg: w.pkg, workflow: "Ship", input: { title: "v1" }, runId: "o1" });
    expect(r.state).toBe("waiting");
    await pass(w, { config });
    // The first question asks no role: it goes to the envelope's owner, the platform lead.
    expect(lines(join(d, "platform_lead.jsonl")).map(brief)).toEqual([`wait_opened platform_lead ${String((r.waiting as Obj)["command"])}`]);
    await answer(w, "o1", w.who.pat, "because");
    const asked = await w.rt.getRun("o1");
    await pass(w, { config });
    expect(lines(join(d, "reviewer.jsonl")).map(brief)).toEqual([`wait_opened reviewer ${String((asked.waiting as Obj)["command"])}`]);
    await answer(w, "o1", w.who.rex, "yes");
    await pass(w, { config });
    // The reviewer did not ask for outcomes; the owner is told of them whatever its configuration says.
    expect(lines(join(d, "platform_lead.jsonl")).map(brief).at(-1)).toBe("run_succeeded platform_lead");
    expect(lines(join(d, "reviewer.jsonl")).map((n) => n["event"])).toEqual(["wait_opened"]);
    // A role that asked for outcomes is told too; the shared channel tells it once, naming the owner.
    const both = lines(join(d, "all.jsonl"));
    expect(both.filter((n) => n["event"] === "run_succeeded").map((n) => n["role"])).toEqual(["platform_lead"]);
  });

  it("acts once when two passes race on one run: one escalation, one expiry, one end, each notification at least once with one id", async () => {
    const w = await nworld(REVIEW, "0.7");
    const d = dir();
    const config = fileChannels(d, { accountant: true, finance_lead: true });
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "race" });
    // The channels meet the run while the accountant is asked.
    await pass(w, { config });
    const calls = w.agents.count("Matcher.match");
    w.clock.advance(DAY);
    await Promise.all([pass(w, { config }), pass(w, { config })]);
    expect(await types(w, "race", "review_escalated")).toHaveLength(1);
    w.clock.advance(DAY);
    const leases = (await types(w, "race", "lease_acquired")).length;
    await Promise.all([pass(w, { config }), pass(w, { config }), pass(w, { config })]);
    // The tick that expired the review drives the run; one that comes right after it sees a run that just moved, and
    // takes no lease from that drive.
    expect((await types(w, "race", "lease_acquired")).length).toBe(leases + 1);
    expect(await types(w, "race", "review_expired")).toHaveLength(1);
    expect(await types(w, "race", "wait_expired")).toHaveLength(1);
    expect(await types(w, "race", "run_succeeded")).toHaveLength(1);
    expect((await w.rt.getRun("race")).state).toBe("succeeded");
    // Nothing the run had done was done again.
    expect(w.agents.count("Matcher.match")).toBe(calls);
    // Each notification reached each channel at least once, the repeats with the same id, the first of each in order.
    for (const channel of ["accountant", "finance_lead", "all"]) {
      const got = lines(join(d, `${channel}.jsonl`));
      const firsts = got.filter((n, i) => got.findIndex((m) => m["id"] === n["id"]) === i);
      // A repeat is the same notification; only where the run stood when each pump made it may differ.
      const but = (n: Obj): Obj => ({ ...n, as_of: null });
      for (const n of got) expect(but(firsts.find((f) => f["id"] === n["id"])!)).toEqual(but(n));
      expect(firsts.map((n) => n["seq"] as number)).toEqual([...firsts.map((n) => n["seq"] as number)].sort((a, b) => a - b));
    }
    expect(new Set(lines(join(d, "all.jsonl")).map((n) => n["event"]))).toEqual(new Set(["review_requested", "review_escalated", "run_succeeded"]));
  });
});

describe("a pass over a 0.6 run", () => {
  it("ticks it as before and never notifies it: no line, no cursor", async () => {
    const w = await nworld(REVIEW, "0.6");
    const d = dir();
    const config = fileChannels(d, { accountant: true, finance_lead: true });
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "six" });
    w.clock.advance(DAY);
    expect(await pass(w, { config })).toMatchObject({ moved: 1, notify: { sent: 0 } });
    expect(await types(w, "six", "review_escalated")).toEqual([{ command: REVIEW_AT, from: "accountant", to: "finance_lead", deadline: w.clock.now() + DAY }]);
    w.clock.advance(DAY);
    await pass(w, { config });
    expect((await w.rt.getRun("six")).state).toBe("succeeded");
    for (const f of ["accountant", "finance_lead", "all"]) expect(lines(join(d, `${f}.jsonl`))).toEqual([]);
    expect(await count(w, "select count(*) as n from notify_cursors")).toBe(0);
    expect(await notifyPass(w.db, { config })).toEqual({ sent: 0, failed: 0, dead: 0, pending: 0, failures: [] });
  });

  it("drives at once a 0.6 review that was decided and not driven on, as tick always did", async () => {
    const w = await nworld(REVIEW, "0.6");
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "six-decided" });
    const resume = w.rt.resume.bind(w.rt);
    let failing = true;
    w.rt.resume = async (runId: string) => {
      if (failing) {
        failing = false;
        throw new Error("the drive did not run");
      }
      return resume(runId);
    };
    const lists = { waive: [1], decline: [2] };
    await expect(w.rt.decideReview("six-decided", msg(), { ...lists, signed: await sign(w, "six-decided", w.who.ana, "review", payloadOf.review(lists)) })).rejects.toThrow("the drive did not run");
    expect((await w.rt.getRun("six-decided")).state).toBe("waiting");
    // No grace for a run of 0.6: the very next pass drives it.
    expect(await pass(w)).toMatchObject({ due: 1, moved: 1 });
    expect((await w.rt.getRun("six-decided")).state).toBe("succeeded");
  });

  it("with --no-notify (no notification options), ticks and sends nothing", async () => {
    const w = await nworld(REVIEW, "0.7");
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "quiet" });
    w.clock.advance(DAY);
    const r = await pass(w);
    expect(r).toEqual({ waiting: 1, due: 1, moved: 1, failed: 0 });
    expect(await count(w, "select count(*) as n from notify_cursors")).toBe(0);
  });

  it("builds no runtime for a run with nothing due", async () => {
    const w = await nworld(REVIEW, "0.7");
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "early" });
    w.clock.advance(DAY);
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "late" });
    const built: string[] = [];
    const closed: string[] = [];
    const r = await tickPass(w.db, { runtimeFor: async (runId) => (built.push(runId), { rt: w.rt, close: async () => void closed.push(runId) }), now: () => w.clock.now() });
    expect(r).toEqual({ waiting: 2, due: 1, moved: 1, failed: 0 });
    expect(built).toEqual(["early"]);
    // What was built for the run is closed once it is ticked (the CLI closes its gateways and its checker's worker).
    expect(closed).toEqual(["early"]);
  });

  it("with follow, makes a pass every interval until stopped, and goes on after a pass that failed as a whole", async () => {
    const w = await nworld(REVIEW, "0.7");
    let fail = 1;
    const flaky: Db = {
      query: (async (sql: string, p?: unknown[]) => {
        if (fail > 0 && sql.startsWith("select run_id from runs where state = 'waiting'")) {
          fail--;
          throw new Error("the database went away");
        }
        return w.db.query(sql, p);
      }) as Db["query"],
      tx: (fn) => w.db.tx(fn),
      close: () => w.db.close(),
    };
    const stop = new AbortController();
    const reports: PassReport[] = [];
    const errors: string[] = [];
    const going = driveLoop(flaky, {
      runtimeFor: async () => ({ rt: w.rt }),
      follow: true,
      intervalMs: 5,
      signal: stop.signal,
      onPass: (r) => {
        reports.push(r);
        if (reports.length === 3) stop.abort();
      },
      onPassError: (e) => errors.push((e as Error).message),
    });
    const { passes, last } = await going;
    expect(errors).toEqual(["the database went away"]);
    expect(reports).toHaveLength(3);
    expect(passes).toBe(4);
    expect(last).toEqual({ waiting: 0, due: 0, moved: 0, failed: 0 });
    // Without follow, one pass; and an interval Node would cut to 1 ms is refused.
    expect((await driveLoop(w.db, { runtimeFor: async () => ({ rt: w.rt }) })).passes).toBe(1);
    await expect(driveLoop(w.db, { runtimeFor: async () => ({ rt: w.rt }), follow: true, intervalMs: MAX_INTERVAL_MS + 1 })).rejects.toThrow(RangeError);
  });

  it("reports a notification pass that fails as a whole, after the runs were ticked", async () => {
    const w = await nworld(REVIEW, "0.7");
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "n1" });
    w.clock.advance(DAY);
    const errors: string[] = [];
    // A configuration the reader would refuse, given by hand: its webhook is not https.
    const config = { channels: { hook: { webhook: { url: "http://hooks.acme.example/in", host: "hooks.acme.example", credential: "c", header: "authorization", template: "Bearer {secret}", format: "mandate" as const } } }, roles: { accountant: { channels: ["hook"], outcomes: false } }, link: null };
    const r = await tickPass(w.db, { runtimeFor: async () => ({ rt: w.rt }), now: () => w.clock.now(), notify: { config }, onNotifyError: (e) => errors.push((e as Error).message) });
    expect(r).toEqual({ waiting: 1, due: 1, moved: 1, failed: 1 });
    expect(errors).toEqual([expect.stringMatching(/^bad_notification_channel: /)]);
    expect(await count(w, "select count(*) as n from notify_cursors")).toBe(0);
  });

  it("reports a run whose tick fails and goes on with the next", async () => {
    const w = await nworld(REVIEW, "0.7");
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "a" });
    await w.rt.startRun({ pkg: w.pkg, workflow: "ReviewAll", input: { items: BATCH }, runId: "b" });
    w.clock.advance(DAY);
    const errors: string[] = [];
    const tick = w.rt.tick.bind(w.rt);
    const r = await tickPass(w.db, {
      runtimeFor: async (runId) => ({ rt: { tick: (id: string) => (runId === "a" ? Promise.reject(new Error("unfit_host: made up")) : tick(id)) } }),
      onError: (run, e) => errors.push(`${run}: ${(e as Error).message}`),
      now: () => w.clock.now(),
    });
    expect(r).toEqual({ waiting: 2, due: 2, moved: 1, failed: 1 });
    expect(errors).toEqual(["a: unfit_host: made up"]);
    expect(await types(w, "a", "review_escalated")).toEqual([]);
    expect(await types(w, "b", "review_escalated")).toHaveLength(1);
  });
});
