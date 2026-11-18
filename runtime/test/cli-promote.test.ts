// `mandate promote` (0.7; spec/attention.md "Promotion", spec/runtime.md "Control CLI"; slice B6): the owner of a
// workflow promotes it up the ladder on a run that succeeded, after the card is approved. The command shows the run, and
// for `live` the shadow diff as counts; it asks to confirm unless `--yes`; it signs with the member's key and submits.
// Every call here is a separate CLI call over one PGlite database in a directory, as a person would make it; every key
// is made by `mandate key new` at run time.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-promote-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One workflow with an owner, under a lock that asks for promotion. */
const PROGRAM = `mandate @ 0.7

module cli.ladder @ 0.1

use std.{fs}

role accountant "Accountant"

capability Note = fs.read("/tmp/notes")

workflow Close(title: Text) -> Bool
  owner  accountant
  caps   Note
  budget { steps: 2 }
{
  true
}
`;

const CONFIG = join(dir, "mandate.runtime.json");
const KEYS = join(dir, "decision-keys");
const FILE = join(dir, "close.mdt");
const LOCK = join(dir, "mandate.lock.json");
writeFileSync(FILE, PROGRAM);
writeFileSync(CONFIG, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));

/** One CLI call, as a person would make it, who answers a question with `said`; returns its exit status and output. */
async function mandate(args: string[], said = ""): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  let asked = 0;
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", CONFIG], (s) => (out += s), {}, async () => (asked++, said));
    return { code, out, err: asked > 1 ? `${err}\nasked ${asked} times` : err };
  } finally {
    process.stderr.write = write;
  }
}

interface Person {
  key: string;
  id: string;
  pem: string;
}

async function person(name: string): Promise<Person> {
  const home = join(dir, "people", name);
  mkdirSync(home, { recursive: true });
  const key = join(home, `${name}.key`);
  const made = await mandate(["key", "new", "--out", key]);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  return { key, id, pem: join(home, `${id.slice("sha256:".length)}.pem`) };
}

const run = (id: string, mode: string) => mandate(["run", FILE, "--workflow", "Close", "--input", '{"title":"Q3"}', "--run-id", id, "--mode", mode]);

describe("mandate promote", () => {
  it("promotes a workflow one rung at a time, by its owner alone, once confirmed, and every later run of the rung starts", async () => {
    // Ana is the accountant, who owns Close; Ben is a member with no role.
    const [ana, ben] = [await person("ana"), await person("ben")];
    mkdirSync(KEYS);
    for (const p of [ana, ben]) copyFileSync(p.pem, join(KEYS, `${p.id.slice("sha256:".length)}.pem`));
    writeFileSync(LOCK, JSON.stringify({ lock: "mandate/lock/0.7", modules: {}, members: { ana: { keys: [ana.id] }, ben: { keys: [ben.id] } }, roles: { accountant: ["ana"] }, promotion: "required" }));

    // The card first, in every mode.
    const early = await run("d0", "design");
    expect(early.code).toBe(1);
    expect(early.err).toContain("unapproved_envelope");
    const approved = await mandate(["approve-envelope", FILE, "--key", ana.key]);
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toContain("approved by ana as accountant");
    expect((await run("d1", "design")).code).toBe(0);

    // Then the ladder: read_only starts under no promotion yet.
    const unpromoted = await run("r0", "read_only");
    expect(unpromoted.code).toBe(1);
    expect(unpromoted.err).toContain("unpromoted");
    expect(unpromoted.err).toContain("mandate promote <run> --to read_only --key FILE");

    // A promotion is signed: without a key, or without a rung, it is a usage error.
    const unsigned = await mandate(["promote", "d1", "--to", "read_only"]);
    expect(unsigned.code).toBe(2);
    expect(unsigned.err).toContain("--key FILE is required");
    const sideways = await mandate(["promote", "d1", "--to", "sideways", "--key", ana.key]);
    expect(sideways.code).toBe(2);
    expect(sideways.err).toContain("--to is read_only or live");
    // A rung is not skipped, and nobody but the owner role promotes.
    const skipped = await mandate(["promote", "d1", "--to", "live", "--key", ana.key, "--yes"]);
    expect(skipped.code).toBe(1);
    expect(skipped.err).toContain("bad_promotion");
    const other = await mandate(["promote", "d1", "--to", "read_only", "--key", ben.key, "--yes"]);
    expect(other.code).toBe(1);
    expect(other.err).toContain("invalid_decision: not_in_role");

    // It shows what it promotes and asks; anything but yes promotes nothing.
    const declined = await mandate(["promote", "d1", "--to", "read_only", "--key", ana.key], "n");
    expect(declined.code).toBe(1);
    expect(declined.out).toContain("run       d1\nworkflow  Close\nmode      design, succeeded\n");
    expect(declined.out).toContain("owner     accountant\npromote   design -> read_only\n");
    expect(declined.out).toContain("a promotion to read_only lets every later run of Close of this package run read_only\n");
    expect(declined.out).toContain("promote Close to read_only? [y/N] not promoted\n");
    expect((await run("r0", "read_only")).err).toContain("unpromoted");

    const promoted = await mandate(["promote", "d1", "--to", "read_only", "--key", ana.key], "yes");
    expect(promoted.code, promoted.err).toBe(0);
    const decision = promoted.out.match(/decision  (sha256:[0-9a-f]{64})$/m)![1]!;
    expect(promoted.out).toContain("promoted by ana as accountant\n");
    expect(promoted.out).toMatch(/permits {3}every later run of Close of package sha256:[0-9a-f]{64} in mode read_only\n$/);

    for (const id of ["r1", "r2"]) {
      const r = await run(id, "read_only");
      expect(r.code, r.err).toBe(0);
    }
    const status = JSON.parse((await mandate(["status", "r1", "--json"])).out) as { run: { manifest: { promotion: unknown } } };
    expect(status.run.manifest.promotion).toEqual({ decision, from: { run: "d1", mode: "design" }, to: "read_only" });
    expect((await run("l0", "live")).err).toContain("unpromoted");

    // To live, on the read_only run: the shadow diff against the design run it started under, as counts.
    const live = await mandate(["promote", "r1", "--to", "live", "--key", ana.key, "--yes"]);
    expect(live.code, live.err).toBe(0);
    expect(live.out).toContain("promote   read_only -> live\nshadow diff against design run d1:\n  no action would apply\n");
    expect(live.out).not.toContain("[y/N]");
    expect((await run("l1", "live")).code).toBe(0);

    // The promotion is a decision like any: printed, and checked without the runtime.
    const toLive = live.out.match(/^decision  (sha256:[0-9a-f]{64})$/m)![1]!;
    const shown = await mandate(["decision", "l1", toLive]);
    expect(shown.code, shown.err).toBe(0);
    const file = join(dir, "promotion.json");
    writeFileSync(file, shown.out);
    const verified = await mandate(["verify-decision", file, "--key", ana.pem, "--lock", LOCK]);
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toContain(`valid: decision ${toLive}`);
    expect(verified.out).toContain("promote by ana as accountant");
  });

  it("prints a run's id as text a terminal does not act on", async () => {
    const id = "d\u001b[2Jx";
    expect((await run(id, "design")).code).toBe(0);
    const r = await mandate(["promote", id, "--to", "read_only", "--key", join(dir, "people", "ana", "ana.key")], "n");
    expect(r.code).toBe(1);
    expect(r.out).not.toContain("\u001b");
    expect(r.out).toContain("run       d\\u001B[2Jx\n");
  });
});
