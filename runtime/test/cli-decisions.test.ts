// The control CLI's signed decisions (language 0.4; spec/envelope.md "Signed
// decisions" and "The CLI"): people make keys with `mandate key new`, the lock
// binds the keys to members and the members to roles, and each answer,
// approval and cancel is a record signed with `--key`. A decision that breaks
// a rule is refused and the run stays at the revision it was at; one that is
// taken can be printed with `mandate decision` and checked by anyone with
// `mandate verify-decision`, without the runtime. Every call here is a
// separate CLI call over one PGlite database in a directory, as a person
// would make it.

import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-decisions-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROGRAM = `mandate @ 0.4

module cli.signed @ 0.1

use std.{fs, human}

role code_owner "Code owner"
role reviewer   "Reviewer"

type Draft = { title: Text }

capability Note = fs.read("/tmp/notes")

contract Approved(d: Draft) {
  accept approved "Two people approved"
    by human.approve(role: code_owner) and human.approve(role: reviewer, distinct_from: code_owner)
}

workflow Ship(d: Draft) -> Untrusted<Text>
  caps Note
{
  let reason = human.ask("Why ship it?", role: reviewer)
  let checked = verify d against Approved(d)
  reason
}
`;

const CONFIG = join(dir, "mandate.runtime.json");
const KEYS = join(dir, "decision-keys");
writeFileSync(join(dir, "ship.mdt"), PROGRAM);
writeFileSync(CONFIG, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));

/** One CLI call under `config`, as a person would make it; returns its exit status and output. */
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

const revisionOf = (out: string): string => out.match(/revision (\d+)/)![1]!;

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

/** The run's revision, as `status --json` says it. */
async function revisionNow(runId: string): Promise<number> {
  const s = await mandate("status", runId, "--json");
  expect(s.code, s.err).toBe(0);
  return (JSON.parse(s.out) as { run: { revision: number } }).run.revision;
}

describe("mandate key new", () => {
  it("makes a private key and its public key named by the key id, and never replaces a key file", async () => {
    const home = join(dir, "first");
    mkdirSync(home);
    const file = join(home, "me.key");
    const made = await mandate("key", "new", "--out", file);
    expect(made.code, made.err).toBe(0);
    const id = made.out.split("\n")[0]!.match(/^key (sha256:[0-9a-f]{64})$/)![1]!;
    expect(readFileSync(file, "utf8")).toContain("PRIVATE KEY");
    const pem = join(home, `${id.slice("sha256:".length)}.pem`);
    expect(readFileSync(pem, "utf8")).toContain("PUBLIC KEY");

    const before = readFileSync(file, "utf8");
    const again = await mandate("key", "new", "--out", file);
    expect(again.code).toBe(1);
    expect(again.err).toContain("key_exists");
    expect(readFileSync(file, "utf8")).toBe(before);
  });
});

describe("signed decisions through the control CLI", () => {
  it("refuses each decision that breaks a rule, takes the right people's, and shows and verifies what it took", async () => {
    // Alice owns the code and also reviews, with a second key whose public half the runtime does not hold.
    // Bob reviews. Carol is a member with no role. Mallory's public key is in the keys directory and the lock
    // lists it under nobody; the stranger's key is in neither.
    const made: Person[] = [];
    for (const name of ["alice", "alice2", "bob", "carol", "mallory", "stranger"]) made.push(await person(name));
    const [alice, alice2, bob, carol, mallory, stranger] = made;
    mkdirSync(KEYS);
    for (const p of [alice!, bob!, carol!, mallory!]) copyFileSync(p.pem, join(KEYS, `${p.id.slice("sha256:".length)}.pem`));
    const lock = {
      lock: "mandate/lock/0.4",
      modules: {},
      members: { alice: { keys: [alice!.id, alice2!.id] }, bob: { keys: [bob!.id] }, carol: { keys: [carol!.id] } },
      roles: { code_owner: ["alice"], reviewer: ["alice", "bob"] },
    };
    writeFileSync(join(dir, "mandate.lock.json"), JSON.stringify(lock));

    const started = await mandate("run", join(dir, "ship.mdt"), "--workflow", "Ship", "--input", '{"d":{"title":"v1"}}', "--run-id", "s1");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("run s1  Ship  waiting");
    expect(started.out).toContain("waiting for: an answer: Why ship it?");
    const r1 = revisionOf(started.out);
    expect(started.out).toContain(`mandate answer s1 --revision ${r1} --key <your key file> <text>`);

    // Refusals of the answer, which a reviewer must give.
    const byName = await mandate("answer", "s1", "--revision", r1, "--by", "bob", "ready");
    expect(byName.code).toBe(1);
    expect(byName.err).toContain("invalid_decision: invalid_signature");
    const notReviewer = await mandate("answer", "s1", "--revision", r1, "--key", carol!.key, "ready");
    expect(notReviewer.code).toBe(1);
    expect(notReviewer.err).toContain("invalid_decision: not_in_role");
    for (const p of [mallory!, stranger!]) {
      const unknown = await mandate("answer", "s1", "--revision", r1, "--key", p.key, "ready");
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain("invalid_decision: unknown_key");
    }
    // Saying whose key it is does not make it theirs: Mallory signs in Bob's name, and Carol in Bob's.
    for (const p of [mallory!, carol!]) {
      const claimed = await mandate("answer", "s1", "--revision", r1, "--key", p.key, "--member", "bob", "ready");
      expect(claimed.code).toBe(1);
      expect(claimed.err).toContain("invalid_decision: unknown_key");
    }
    // Listed in the lock under Alice, but the runtime holds no public half of it.
    const unheld = await mandate("answer", "s1", "--revision", r1, "--key", alice2!.key, "ready");
    expect(unheld.code).toBe(1);
    expect(unheld.err).toContain("invalid_decision: unknown_key");
    const stale = await mandate("answer", "s1", "--revision", String(Number(r1) - 1), "--key", bob!.key, "ready");
    expect(stale.code).toBe(1);
    expect(stale.err).toContain("stale_revision");
    const nobody = await mandate("answer", "s1", "--revision", r1, "ready");
    expect(nobody.code).toBe(2);
    expect(nobody.err).toContain("--key FILE is required");
    expect(await revisionNow("s1")).toBe(Number(r1));

    // Bob answers; then the code owner's approval is asked, which Bob cannot give.
    const answered = await mandate("answer", "s1", "--revision", r1, "--key", bob!.key, "it", "is", "ready");
    expect(answered.code, answered.err).toBe(0);
    expect(answered.out).toContain("waiting for: code_owner to approve Approved.approved");
    const r2 = revisionOf(answered.out);
    expect(answered.out).toContain(`mandate approve s1 --revision ${r2} --key <your key file>`);
    const bobFirst = await mandate("approve", "s1", "--revision", r2, "--key", bob!.key);
    expect(bobFirst.code).toBe(1);
    expect(bobFirst.err).toContain("invalid_decision: not_in_role");
    expect(await revisionNow("s1")).toBe(Number(r2));

    const owner = await mandate("approve", "s1", "--revision", r2, "--key", alice!.key);
    expect(owner.code, owner.err).toBe(0);
    expect(owner.out).toContain("waiting for: reviewer to approve Approved.approved");
    const r3 = revisionOf(owner.out);
    // Alice reviews too, and she already approved as code owner.
    const same = await mandate("approve", "s1", "--revision", r3, "--key", alice!.key);
    expect(same.code).toBe(1);
    expect(same.err).toContain("invalid_decision: same_member");
    expect(await revisionNow("s1")).toBe(Number(r3));
    const done = await mandate("approve", "s1", "--revision", r3, "--key", bob!.key);
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain("run s1  Ship  succeeded");
    expect(done.out).toContain("result: it is ready");

    // What the run took: three signed decisions.
    const status = await mandate("status", "s1");
    const lines = status.out.split("\n").filter((l) => l.startsWith("decision "));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^decision answer by bob as reviewer: signed \(sha256:[0-9a-f]{64}\)$/);
    expect(lines[1]).toMatch(/^decision approve by alice as code_owner: signed \(sha256:[0-9a-f]{64}\)$/);
    expect(lines[2]).toMatch(/^decision approve by bob as reviewer: signed \(sha256:[0-9a-f]{64}\)$/);
    const json = JSON.parse((await mandate("status", "s1", "--json")).out) as { decisions: { decision_id: string; record: { kind: string; member: string }; signature: string; valid: boolean }[] };
    expect(json.decisions.map((d) => [d.record.kind, d.record.member, d.valid])).toEqual([
      ["answer", "bob", true],
      ["approve", "alice", true],
      ["approve", "bob", true],
    ]);
    const digest = lines[1]!.match(/\((sha256:[0-9a-f]{64})\)/)![1]!;
    expect(json.decisions[1]!.decision_id).toBe(digest);

    // Alice's approval as its signed record, checked with her public key and nothing of the runtime's.
    const printed = await mandate("decision", "s1", digest);
    expect(printed.code, printed.err).toBe(0);
    const recordFile = join(dir, "approval.json");
    writeFileSync(recordFile, printed.out);
    const signed = JSON.parse(printed.out) as { record: Record<string, unknown>; signature: string };
    expect(signed.signature).toMatch(/^ed25519:/);
    const valid = await mandate("verify-decision", recordFile, "--key", alice!.pem);
    expect(valid.code, valid.out + valid.err).toBe(0);
    expect(valid.out.split("\n")[0]).toBe(`valid: decision ${digest}`);
    const bound = await mandate("verify-decision", recordFile, "--key", alice!.pem, "--lock", join(dir, "mandate.lock.json"));
    expect(bound.code, bound.out + bound.err).toBe(0);
    const otherKey = await mandate("verify-decision", recordFile, "--key", bob!.pem);
    expect(otherKey.code).toBe(1);
    expect(otherKey.out).toMatch(/^invalid: /);
    const edited = join(dir, "edited.json");
    writeFileSync(edited, JSON.stringify({ ...signed, record: { ...signed.record, kind: "decline" } }));
    const changed = await mandate("verify-decision", edited, "--key", alice!.pem);
    expect(changed.code).toBe(1);
    expect(changed.out).toMatch(/^invalid: /);
    const otherLock = join(dir, "other.lock.json");
    writeFileSync(otherLock, JSON.stringify({ ...lock, roles: { code_owner: ["bob"], reviewer: ["alice", "bob"] } }));
    const unbound = await mandate("verify-decision", recordFile, "--key", alice!.pem, "--lock", otherLock);
    expect(unbound.code).toBe(1);
    expect(unbound.out).toMatch(/^invalid: /);

    // A cancel signed by a member is taken, and says who.
    const second = await mandate("run", join(dir, "ship.mdt"), "--workflow", "Ship", "--input", '{"d":{"title":"v2"}}', "--run-id", "s2");
    expect(second.out).toContain("run s2  Ship  waiting");
    const cancelled = await mandate("cancel", "s2", "--key", carol!.key);
    expect(cancelled.code, cancelled.err).toBe(0);
    expect(cancelled.out).toContain("run s2  Ship  cancelled");
    expect(cancelled.out).toMatch(/decision cancel by carol: signed \(sha256:[0-9a-f]{64}\)/);

    // A keys directory holding Bob's public key under Alice's key id stops every command.
    const badKeys = join(dir, "bad-keys");
    mkdirSync(badKeys);
    copyFileSync(bob!.pem, join(badKeys, `${alice!.id.slice("sha256:".length)}.pem`));
    const badConfig = join(dir, "bad.runtime.json");
    writeFileSync(badConfig, JSON.stringify({ database: "pglite:db", decisions: { keys: "bad-keys" } }));
    const bad = await mandateWith(badConfig, "status", "s1");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("bad_decision_key");
  }, 300_000);

  // The program's lock is the one the test above wrote, so the run gets as far as the mode.
  it("does not run a 0.4 program in unsigned mode", async () => {
    const unsigned = join(dir, "unsigned.runtime.json");
    writeFileSync(unsigned, JSON.stringify({ database: "pglite:db2", decisions: { mode: "unsigned" } }));
    const r = await mandateWith(unsigned, "run", join(dir, "ship.mdt"), "--workflow", "Ship", "--input", '{"d":{"title":"v3"}}', "--run-id", "u1");
    expect(r.code).toBe(1);
    expect(r.err).toContain("signed_decisions_required");
  }, 120_000);

  it.skipIf(process.platform === "win32")("refuses a private key file that others can read", async () => {
    const open = await person("open");
    chmodSync(open.key, 0o644);
    const r = await mandate("status", "s1", "--key", open.key);
    expect(r.code).toBe(1);
    expect(r.err).toContain("key_not_private");
  }, 120_000);
});
