// Approving an envelope from the control CLI (language 0.4; spec/envelope.md
// "Approving an envelope" and "The CLI", case H03): a run of a workflow with an
// envelope does not start until a member of its owner role has signed for the
// package with `mandate approve-envelope`. The hash they sign is the one the
// card shows. The approval can be printed and checked without the runtime,
// like any decision. Every call here is a separate CLI call over one PGlite
// database in a directory, as a person would make it.

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { card, check, type Lock } from "@mandate/bridge";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-envelope-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** One workflow with an envelope, which asks a reviewer a question, and a test of it. */
const PROGRAM = `mandate @ 0.4

module cli.envelope @ 0.1

use std.{fs, human}

role platform_lead "Platform lead"
role reviewer      "Reviewer"

capability Note = fs.read("/tmp/notes")

workflow Ship(title: Text) -> Untrusted<Text>
  envelope {
    owner  platform_lead
    caps   Note
    budget { steps: 5, agents: 2 }
  }
{
  human.ask("Why ship it?", role: reviewer)
}

test "a reviewer answers" {
  with handlers { Human = answer("because") }
  run Ship("v1") expect ok
}
`;

/** The same, and a second workflow whose envelope the reviewers own. */
const TWO = `${PROGRAM.replace("module cli.envelope @ 0.1", "module cli.two @ 0.1")}
workflow Review(title: Text) -> Untrusted<Text>
  envelope {
    owner  reviewer
    caps   Note
    budget { steps: 5, agents: 1 }
  }
{
  human.ask("Is it good?", role: reviewer)
}
`;

const PLAIN = `mandate @ 0.4

module cli.plain @ 0.1

use std.{fs, human}

role reviewer "Reviewer"

capability Note = fs.read("/tmp/notes")

workflow Ask(title: Text) -> Untrusted<Text>
  caps Note
{
  human.ask("Why?", role: reviewer)
}
`;

const CONFIG = join(dir, "mandate.runtime.json");
const KEYS = join(dir, "decision-keys");
const SHIP = join(dir, "ship.mdt");
const LOCK = join(dir, "mandate.lock.json");
writeFileSync(SHIP, PROGRAM);
writeFileSync(join(dir, "two.mdt"), TWO);
writeFileSync(join(dir, "plain.mdt"), PLAIN);
writeFileSync(CONFIG, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));

/** One CLI call, as a person would make it; returns its exit status and output. */
async function mandate(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", CONFIG], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

interface Person {
  key: string;
  id: string;
  pem: string;
}

/** A person's key, made by `mandate key new` in a directory of their own. */
async function person(name: string): Promise<Person> {
  const home = join(dir, "people", name);
  mkdirSync(home, { recursive: true });
  const key = join(home, `${name}.key`);
  const made = await mandate("key", "new", "--out", key);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  return { key, id, pem: join(home, `${id.slice("sha256:".length)}.pem`) };
}

const RUN = ["run", SHIP, "--workflow", "Ship", "--input", '{"title":"v1"}'];

describe("mandate approve-envelope", () => {
  it("starts no run before the owner approves, refuses anyone else's approval, and starts every run after hers", async () => {
    // Alice is the platform lead, Bob a reviewer, Carol a member with no role.
    const [alice, bob, carol] = [await person("alice"), await person("bob"), await person("carol")];
    mkdirSync(KEYS);
    for (const p of [alice, bob, carol]) copyFileSync(p.pem, join(KEYS, `${p.id.slice("sha256:".length)}.pem`));
    const lock = {
      lock: "mandate/lock/0.4",
      modules: {},
      members: { alice: { keys: [alice.id] }, bob: { keys: [bob.id] }, carol: { keys: [carol.id] } },
      roles: { platform_lead: ["alice"], reviewer: ["bob"] },
    };
    writeFileSync(LOCK, JSON.stringify(lock));

    const early = await mandate(...RUN, "--run-id", "e0");
    expect(early.code).toBe(1);
    expect(early.err).toContain("unapproved_envelope");
    expect(early.err).toContain("mandate approve-envelope");

    for (const p of [bob, carol]) {
      const other = await mandate("approve-envelope", SHIP, "--key", p.key);
      expect(other.code).toBe(1);
      expect(other.err).toContain("invalid_decision: not_in_role");
    }
    // Saying whose key it is does not make it theirs.
    const claimed = await mandate("approve-envelope", SHIP, "--key", carol.key, "--member", "alice");
    expect(claimed.code).toBe(1);
    expect(claimed.err).toContain("invalid_decision: unknown_key");
    const unsigned = await mandate("approve-envelope", SHIP);
    expect(unsigned.code).toBe(2);
    expect(unsigned.err).toContain("--key is required");
    expect((await mandate(...RUN, "--run-id", "e0")).err).toContain("unapproved_envelope");

    const approved = await mandate("approve-envelope", SHIP, "--key", alice.key, "--json");
    expect(approved.code, approved.err).toBe(0);
    const a = JSON.parse(approved.out) as { package: string; decision: string; member: string; role: string; key: string; record: Record<string, unknown>; signature: string };
    expect(a).toMatchObject({ member: "alice", role: "platform_lead", key: alice.id });
    // What she signed names the package and nothing of a run.
    expect(a.record).toEqual({ format: "mandate/decision/0.1", kind: "envelope", package: a.package, subject: a.package, role: "platform_lead", member: "alice", key: alice.id, at: a.record["at"] });
    // It is the hash her card showed.
    const program = check(PROGRAM, "mdt").program!;
    expect(card(program, "Ship", { lock: lock as Lock })!.package).toBe(a.package);

    // Anyone can check the approval with her public key and the lock, without the runtime.
    const file = join(dir, "approval.json");
    writeFileSync(file, JSON.stringify({ record: a.record, signature: a.signature }));
    const verified = await mandate("verify-decision", file, "--key", alice.pem, "--lock", LOCK);
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toContain(`valid: decision ${a.decision}`);
    expect(verified.out).toContain("envelope by alice as platform_lead");

    // In plain text the command says the same.
    const again = await mandate("approve-envelope", SHIP, "--key", alice.key);
    expect(again.code, again.err).toBe(0);
    expect(again.out).toContain(`package  ${a.package}`);
    expect(again.out).toContain("approved by alice as platform_lead");

    // Now runs start, each under the first approval, and a caller may give a run fewer agents than the envelope has.
    const started = await mandate(...RUN, "--run-id", "e1", "--limit", "agents=1");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("run e1  Ship  waiting");
    const status = JSON.parse((await mandate("status", "e1", "--json")).out) as {
      run: { manifest: { envelope_approval: Record<string, unknown> } };
      budget: { dimensions: Array<{ dimension: string; limit: number }> };
      decisions: Array<{ decision_id: string; valid: boolean; record: { kind: string } }>;
    };
    expect(status.run.manifest.envelope_approval).toEqual({ decision: a.decision, member: "alice", role: "platform_lead", key: alice.id });
    expect(status.budget.dimensions.find((d) => d.dimension === "agents")!.limit).toBe(1);
    expect(status.decisions.map((d) => [d.decision_id, d.record.kind, d.valid])).toEqual([[a.decision, "envelope", true]]);
    const shown = await mandate("decision", "e1", a.decision);
    expect(shown.code, shown.err).toBe(0);
    expect(JSON.parse(shown.out)).toEqual({ record: a.record, signature: a.signature });
    expect((await mandate(...RUN, "--run-id", "e2")).code).toBe(0);

    // A changed lock is another package: the approval does not carry over.
    writeFileSync(LOCK, JSON.stringify({ ...lock, roles: { ...lock.roles, reviewer: ["bob", "carol"] } }));
    const moved = await mandate(...RUN, "--run-id", "e3");
    expect(moved.code).toBe(1);
    expect(moved.err).toContain("unapproved_envelope");
    writeFileSync(LOCK, JSON.stringify(lock));

    // With two envelopes owned by two roles, the command asks which one; each owner approves as theirs.
    const which = await mandate("approve-envelope", join(dir, "two.mdt"), "--key", alice.key);
    expect(which.code).toBe(2);
    expect(which.err).toContain("envelopes owned by platform_lead and reviewer");
    expect(which.err).toContain("--workflow: Review, Ship");
    const none = await mandate("approve-envelope", join(dir, "two.mdt"), "--key", alice.key, "--workflow", "Missing");
    expect(none.code).toBe(2);
    const wrong = await mandate("approve-envelope", join(dir, "two.mdt"), "--key", alice.key, "--workflow", "Review");
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("invalid_decision: not_in_role");
    const bobs = await mandate("approve-envelope", join(dir, "two.mdt"), "--key", bob.key, "--workflow", "Review");
    expect(bobs.code, bobs.err).toBe(0);
    expect(bobs.out).toContain("approved by bob as reviewer");
    // Bob's approval is for the reviewers' envelope: the platform lead's still starts no run.
    const ship = await mandate("run", join(dir, "two.mdt"), "--workflow", "Ship", "--input", '{"title":"v1"}', "--run-id", "t1");
    expect(ship.code).toBe(1);
    expect(ship.err).toContain("unapproved_envelope");
    const review = await mandate("run", join(dir, "two.mdt"), "--workflow", "Review", "--input", '{"title":"v1"}', "--run-id", "t2");
    expect(review.code, review.err).toBe(0);

    // A program without an envelope has nothing to approve, and runs without it.
    const plain = await mandate("approve-envelope", join(dir, "plain.mdt"), "--key", alice.key);
    expect(plain.code).toBe(1);
    expect(plain.err).toContain("no_envelope");
    expect((await mandate("run", join(dir, "plain.mdt"), "--workflow", "Ask", "--input", '{"title":"v1"}', "--run-id", "p1")).code).toBe(0);
  });

  it("is made by the test runner's own people for a program's tests", async () => {
    const tested = await mandate("test", SHIP);
    expect(tested.code, tested.out + tested.err).toBe(0);
    expect(tested.out).toContain("a reviewer answers");
    expect(readFileSync(SHIP, "utf8")).toBe(PROGRAM);
  });
});
