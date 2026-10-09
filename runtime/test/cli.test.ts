// The control CLI (K19): a run is started, answered, approved, cancelled and
// replayed from separate CLI calls over a PGlite database in a directory, and
// every decision names the revision the person saw.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROGRAM = `mandate @ 0.2

module cli.demo @ 0.1

use std.{fs, human}

type Draft = { title: Text }

capability Note = fs.read("/tmp/notes")

contract Approved(d: Draft) {
  accept owner_approved "The owner approved" by human.approve(role: "owner")
}

workflow Ship(d: Draft) -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  let reason = human.ask("Why ship it?")
  let checked = verify d against Approved(d)
  reason
}
`;

writeFileSync(join(dir, "ship.mdt"), PROGRAM);
writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db" }));

/** One CLI call, as a person would make it; returns its exit status and output. */
async function mandate(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", join(dir, "mandate.runtime.json")], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

const revisionOf = (out: string): string => out.match(/revision (\d+)/)![1]!;

describe("the control CLI (K19)", () => {
  it("runs a program, takes an answer and an approval at the revision a person saw, and replays it", async () => {
    const started = await mandate("run", join(dir, "ship.mdt"), "--workflow", "Ship", "--input", '{"d":{"title":"v1"}}', "--run-id", "c1");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("run c1  Ship  waiting");
    expect(started.out).toContain("waiting for: an answer: Why ship it?");
    const r1 = revisionOf(started.out);

    // An answer given on another revision is refused, and nothing is recorded.
    const stale = await mandate("answer", "c1", "--revision", String(Number(r1) - 1), "--by", "ann", "it", "is", "ready");
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("stale_revision");
    const answered = await mandate("answer", "c1", "--revision", r1, "--by", "ann", "it", "is", "ready");
    expect(answered.code, answered.err).toBe(0);
    expect(answered.out).toContain("waiting for: owner to approve Approved.owner_approved");
    expect(answered.out).toMatch(/subject digest sha256:[0-9a-f]{64}/);
    expect(answered.out).toContain(`mandate approve c1 --revision ${revisionOf(answered.out)} --by <you>`);

    const status = await mandate("status", "c1", "--json");
    const seen = JSON.parse(status.out) as { run: { revision: number } };
    expect(seen.run.revision).toBe(Number(revisionOf(answered.out)));
    expect((await mandate("approve", "c1", "--revision", String(seen.run.revision - 1), "--by", "bob")).err).toContain("stale_revision");
    const approved = await mandate("approve", "c1", "--revision", String(seen.run.revision), "--by", "bob");
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toContain("succeeded");
    expect(approved.out).toContain("result: it is ready");
    expect(approved.out).toContain("evidence Approved.owner_approved: met (human.approve)");

    const replay = await mandate("replay", "c1");
    expect(replay.out).toBe("replay: complete\nit is ready\n");
  });

  it("cancels a waiting run and refuses a raise above the workflow's own budget", async () => {
    const started = await mandate("run", join(dir, "ship.mdt"), "--workflow", "Ship", "--input", '{"d":{"title":"v2"}}', "--run-id", "c2");
    const raise = await mandate("raise-limits", "c2", "--revision", revisionOf(started.out), "--by", "erin", "--limit", "spend=5USD");
    expect(raise.code).toBe(1);
    expect(raise.err).toContain("above_program_budget");
    const cancelled = await mandate("cancel", "c2");
    expect(cancelled.out).toContain("run c2  Ship  cancelled");
  });

  it("explains how to call it", async () => {
    const r = await mandate("approve", "c1");
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
  });
});
