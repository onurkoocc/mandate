// `mandate tick [--follow] [--interval 10s] [--no-notify]` (spec/attention.md "The driver loop", "The command line"):
// the driver loop from a terminal, each call a separate CLI call over one PGlite database in a directory. A 0.7 run's
// approval has a deadline of a moment; a pass before it moves nothing and tells the reviewer; a pass after it expires
// the approval and the run fails, and the reviewer, who asked for outcomes, is told. With an egress proxy, a webhook
// that is refused is given up and printed without its secret. The made-up words are no secrets.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { EvidenceSigner } from "../src/evidence.js";
import { WorkerChecker } from "../src/plan.js";
import { world as egressWorld } from "./egress-world.js";
import { lines, under } from "./notify-world.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-tick-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROGRAM = under(
  `mandate @ 0.6

module cli.tick @ 0.1

use std.{fs, human}

role reviewer "Reviewer"

type Note = { text: Text }

capability Notes = fs.read("/work/notes")

contract Approved(n: Note) {
  accept ok "The reviewer approved"
    by human.approve(role: reviewer, deadline: 1h)
}

contract Hurried(n: Note) {
  accept ok "The reviewer approved at once"
    by human.approve(role: reviewer, deadline: 300ms)
}

workflow Ship(n: Note) -> Text
  caps   Notes
  budget { time: 1h }
{
  let checked = verify n against Approved(n)
  "shipped"
}

workflow Rush(n: Note) -> Text
  caps   Notes
  budget { time: 1h }
{
  let checked = verify n against Hurried(n)
  "rushed"
}
`,
  "0.7",
);

const CONFIG = join(dir, "mandate.runtime.json");
const OUT = join(dir, "out", "notifications.jsonl");
const base = { database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } };
const notifications = { channels: { local: { file: "out/notifications.jsonl" } }, roles: { reviewer: { channels: ["local"], outcomes: true } } };
mkdirSync(join(dir, "decision-keys"));
writeFileSync(join(dir, "ship.mdt"), PROGRAM);
writeFileSync(join(dir, "mandate.lock.json"), JSON.stringify({ lock: "mandate/lock/0.7", modules: {}, members: { rex: { keys: [EvidenceSigner.generate().keyId] } }, roles: { reviewer: ["rex"] } }));
writeFileSync(CONFIG, JSON.stringify({ ...base, notifications }));

async function mandateWith(config: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", config], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}
const mandate = (...args: string[]) => mandateWith(CONFIG, ...args);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("mandate tick", () => {
  const start = (workflow: string, runId: string) => mandate("run", join(dir, "ship.mdt"), "--workflow", workflow, "--input", '{"n":{"text":"x"}}', "--lock", join(dir, "mandate.lock.json"), "--run-id", runId);
  const told = () => lines(OUT).map((n) => `${String(n["run"])} ${String(n["event"])} ${String(n["role"])}`);

  // Seven CLI calls, each opening the database: more than the default 30 s under load.
  it("moves nothing within a deadline and tells the role asked; past it the approval expires, the run goes on, and outcomes are told", { timeout: 120_000 }, async () => {
    const run = await start("Ship", "c1");
    expect(run.code, run.err).toBe(0);
    expect(run.out).toMatch(/^run c1 {2}Ship {2}waiting/);
    // Within its deadline of an hour: nothing moves, and the reviewer is told what is asked of them.
    const first = await mandate("tick");
    expect(first.code, first.err).toBe(0);
    expect(first.out).toBe("tick: 1 run waiting, 0 moved; notifications: 1 sent, 0 given up, 0 to try again\n");
    expect(told()).toEqual(["c1 wait_opened reviewer"]);
    // A run whose approval has a deadline of a moment, a pass once it has passed. It began after the channel was in
    // use, so all of it is told, the pass that ended it included: its question and how it ended. The one runtime the
    // pass built, for the run with something due, is closed, its checker's worker with it.
    expect((await start("Rush", "c2")).code).toBe(0);
    await pause(400);
    const closes = vi.spyOn(WorkerChecker.prototype, "close");
    let second: Awaited<ReturnType<typeof mandate>>;
    try {
      second = await mandate("tick");
      expect(closes).toHaveBeenCalledTimes(1);
    } finally {
      closes.mockRestore();
    }
    expect(second.code, second.err).toBe(0);
    expect(second.out).toMatch(/^run c2: waiting -> failed, revision \d+ -> \d+\ntick: 2 runs waiting, 1 moved; notifications: 2 sent, 0 given up, 0 to try again\n$/);
    expect(told()).toEqual(["c1 wait_opened reviewer", "c2 wait_opened reviewer", "c2 run_failed reviewer"]);
    expect((await mandate("status", "c2")).out).toMatch(/^run c2 {2}Rush {2}failed/);
    expect((await mandate("status", "c1")).out).toMatch(/^run c1 {2}Ship {2}waiting/);
    // A pass with nothing to do sends nothing.
    expect((await mandate("tick")).out).toBe("tick: 1 run waiting, 0 moved; notifications: 0 sent, 0 given up, 0 to try again\n");
  });

  it("sends nothing with --no-notify", async () => {
    const r = await mandate("tick", "--no-notify");
    expect(r.code, r.err).toBe(0);
    expect(r.out).toBe("tick: 1 run waiting, 0 moved; notifications: off\n");
  });

  it("with --follow, makes a pass every --interval until SIGINT, and says how many", { timeout: 60_000 }, async () => {
    const going = mandate("tick", "--follow", "--interval", "50ms");
    // Long enough for two passes on a loaded machine, each of which opens nothing for a run with nothing due.
    await pause(4000);
    process.emit("SIGINT");
    const r = await going;
    expect(r.code, r.err).toBe(0);
    // A --follow that made one pass and ended would say so: it made several.
    const passes = Number(/^tick: stopped after (\d+) pass(es)?\n$/.exec(r.out)?.[1]);
    expect(passes, r.out).toBeGreaterThanOrEqual(2);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("refuses an interval without --follow, one that is no duration, one too long for a timer, and a run", async () => {
    expect((await mandate("tick", "--interval", "10s")).code).toBe(2);
    expect((await mandate("tick", "--follow", "--interval", "soon")).code).toBe(2);
    expect((await mandate("tick", "--follow", "--interval", "0s")).code).toBe(2);
    // 600 hours is above 2^31 - 1 ms, which Node would cut to 1 ms.
    const long = await mandate("tick", "--follow", "--interval", "600h");
    expect(long.code).toBe(2);
    expect(long.err).toMatch(/--interval is at most 2147483647 ms/);
    expect((await mandate("tick", "c1")).code).toBe(2);
  });

  it("is refused, as every command that reads the configuration, halt among them, when a section of it cannot be used", async () => {
    // The rule that was: one section that cannot be used refuses every command that reads the file.
    const other = join(dir, "other.runtime.json");
    writeFileSync(other, JSON.stringify({ ...base, violations: { limit: 0 } }));
    expect(await mandateWith(other, "halt", "--list")).toMatchObject({ code: 1, err: expect.stringMatching(/^mandate: bad_config: /) });
    // A notifications section is held to the same rule.
    const bad = join(dir, "halt.runtime.json");
    writeFileSync(bad, JSON.stringify({ ...base, notifications: { channels: { local: {} } } }));
    expect(await mandateWith(bad, "halt", "--list")).toMatchObject({ code: 1, err: expect.stringMatching(/^mandate: bad_notification_channel: .*has no adapter/) });
  });

  it("refuses a configuration whose notifications cannot be used, by name, before anything is done", async () => {
    const bad = join(dir, "bad.runtime.json");
    writeFileSync(bad, JSON.stringify({ ...base, notifications: { channels: { hook: { webhook: { url: "http://hooks.acme.example/in", credential: "acme_hook" } } } } }));
    const r = await mandateWith(bad, "tick");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mandate: bad_notification_channel: .*notifications\.channels\.hook\.webhook\.url is one absolute https:\/\/ URL/);
  });

  it("through the egress proxy: a webhook the receiver refuses is given up, and nothing it prints holds the secret", { timeout: 60_000 }, async () => {
    const secret = "made-up-cli-hook-word";
    const ew = await egressWorld({ credentials: { acme_hook: { hosts: ["hooks.acme.example"], header: "authorization", template: "Bearer {secret}", secret } } });
    try {
      ew.up.handler = (req, res) => {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end(String(req.headers["authorization"]));
      };
      const config = join(dir, "egress.runtime.json");
      writeFileSync(
        config,
        JSON.stringify({ ...base, egress: { admin: ew.config.admin }, notifications: { channels: { hook: { webhook: { url: "https://hooks.acme.example/in", credential: "acme_hook" } } }, roles: { reviewer: { channels: ["hook"], outcomes: true } } } }),
      );
      const r = await mandateWith(config, "tick");
      expect(r.code, r.err).toBe(0);
      // The new channel meets both runs: c1 asks the reviewer still, c2 has ended. One notification, refused for good.
      expect(r.out).toBe("tick: 1 run waiting, 0 moved; notifications: 0 sent, 1 given up, 0 to try again\n");
      expect(r.err.split("\n").filter(Boolean)).toEqual([expect.stringMatching(/^mandate: notification sha256:[0-9a-f]{64} \(run c1, event \d+\) on channel hook given up after 1 attempt: hooks\.acme\.example answered 404$/)]);
      expect(ew.up.seen).toHaveLength(1);
      for (const text of [r.out, r.err]) {
        expect(text).not.toContain(secret);
        expect(text).not.toMatch(/mdt-ph-/);
      }
    } finally {
      await ew.close();
    }
  });
});
