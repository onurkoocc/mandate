// A program's tests with effect handlers (P2-17, Doc 4 §6.4): FixBug's own
// tests run against recorded answers, an in-memory working copy, a fake git,
// an automatic code owner and a fixed clock. A handler the runner does not
// know fails the test by name.

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { check, type Program } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { runTests } from "../src/testing.js";
import { closeAll, LOCK, world } from "./helpers.js";

afterAll(closeAll);

const FIXBUG_FILE = fileURLToPath(new URL("../../fixtures/fixbug/fixbug.mdt", import.meta.url));

function program(src: string): Program {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.program!;
}

describe("a program's tests (§6.4)", () => {
  it("runs FixBug's tests against their handlers", async () => {
    const w = await world(readFileSync(FIXBUG_FILE, "utf8"));
    const results = await runTests(program(readFileSync(FIXBUG_FILE, "utf8")), { db: w.db, dir: dirname(FIXBUG_FILE), lock: LOCK });
    expect(results.map((r) => [r.test, r.expected, r.state, r.ok])).toEqual([
      ["FixBug happy path", "ok", "succeeded", true],
      ["FixBug with a failing suite asks a person", "waiting", "waiting", true],
    ]);
    // The pull request carries the recorded patch from the in-memory working copy, at the fixed time.
    const happy = results[0]!;
    expect(happy.detail).toMatchObject({ system: "git.open_pr" });
    const [run] = await w.db.query<{ run_id: string; created_at: string }>("select run_id, created_at from runs where run_id = 'test:FixBug happy path:0'");
    expect(Number(run!.created_at)).toBe(Date.parse("2026-10-07T21:00:00Z"));
  });

  it("fails a test by name when a handler is unknown, a fixture is missing, or the run ends elsewhere", async () => {
    const w = await world(readFileSync(FIXBUG_FILE, "utf8"));
    const src = `module t @ 0.1
use std.{fs, human}
capability Notes = fs.read("/notes")
workflow Ask(n: Int) -> Untrusted<Text> caps Notes { human.ask("why?") }
test "unknown handler" {
  with handlers { Net = record_traffic() }
  run Ask(1) expect ok
}
test "no fixture" {
  run Ask(fixtures.nothing_here) expect ok
}
test "answered" {
  with handlers { Human = answer("because") }
  run Ask(1) expect ok
}
test "unanswered" {
  run Ask(1) expect ok
}
`;
    const results = await runTests(program(src), { db: w.db, dir: dirname(FIXBUG_FILE) });
    const by = Object.fromEntries(results.map((r) => [r.test, r]));
    expect(by["unknown handler"]).toMatchObject({ ok: false, state: "error", detail: expect.stringContaining("unsupported handler Net = record_traffic(…)") });
    expect(by["no fixture"]).toMatchObject({ ok: false, state: "error", detail: expect.stringContaining("fixtures.nothing_here") });
    expect(by["answered"]).toMatchObject({ ok: true, state: "succeeded", detail: "because" });
    expect(by["unanswered"]).toMatchObject({ ok: false, state: "waiting" });
  });

  it("never lets a test read outside its program's directory", async () => {
    const w = await world(readFileSync(FIXBUG_FILE, "utf8"));
    const src = `module t @ 0.1
use std.{fs}
capability R = fs.read("/repo")
workflow Read() -> Untrusted<Text> caps R { fs.read_text("/repo/a") }
test "escape" {
  with handlers { Fs = memfs("../../..") }
  run Read() expect ok
}
`;
    const [r] = await runTests(program(src), { db: w.db, dir: dirname(FIXBUG_FILE) });
    expect(r).toMatchObject({ ok: false, state: "error", detail: expect.stringContaining("outside the program's directory") });
  });
});
