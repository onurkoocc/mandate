// `mandate review` (0.6; spec/library.md "The wait and the decision"): a review of a batch decided from a terminal.
// `mandate status` lists the open items by index with what each failed and who may waive it; one signed decision,
// `--waive` and `--decline`, decides every open item; a decision that breaks a rule is refused by name and the run
// stays at its revision; the decision taken is printed by `mandate decision` and checked by `mandate verify-decision`,
// which with `--waive` and `--decline` also checks that it decided those items. Every call is a separate CLI call over
// one PGlite database in a directory, as a person would make it.

import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, shownSafe, terminalDocument, terminalText } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-review-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PROGRAM = `mandate @ 0.6

module cli.review @ 0.1

use std.{fs, human}

role accountant   "Accountant"
role finance_lead "Finance lead"

type Item = { key: Text, n: Int }

capability Notes = fs.read("/work/notes")

/// An item has a key, and is small unless a person waives that.
contract Small(i: Item) {
  accept keyed "The item has a key"
    by static len(i.key) >= 1
  accept small "The item is small"
    by static i.n < 10
    waive by accountant, finance_lead
}

/// Checks every item, and asks the accountant once about the large ones.
workflow Check(items: List<Item>) -> Int
  caps   Notes
  budget { time: 1h }
{
  let checked = map it in items max 5 {
    verify it against Small(it)
  }
  let reviewed = human.review(checked, role: accountant, deadline: 1d, escalate_to: finance_lead)
  len(reviewed.accepted)
}

/// Gives back the text it is given.
workflow Echo(t: Text) -> Text
  caps   Notes
  budget { time: 1h }
{
  t
}
`;

const CONFIG = join(dir, "mandate.runtime.json");
const KEYS = join(dir, "decision-keys");
writeFileSync(join(dir, "check.mdt"), PROGRAM);
writeFileSync(CONFIG, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));

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

const revisionOf = (out: string): string => out.match(/revision (\d+)/)![1]!;

/** A person's key, made by `mandate key new` in a directory of their own. */
async function person(name: string): Promise<{ key: string; id: string; pem: string }> {
  const home = join(dir, "people", name);
  mkdirSync(home, { recursive: true });
  const key = join(home, `${name}.key`);
  const made = await mandate("key", "new", "--out", key);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  return { key, id, pem: join(home, `${id.slice("sha256:".length)}.pem`) };
}

describe("untrusted text in a terminal", () => {
  it("writes every code point a terminal does not print as itself as a JSON escape, and nothing else", () => {
    const shown = terminalText("a\u202Eb\u0085c\u200Bd\u2028e\u2066f\u007Fg\u0007h\uFEFFi\u{E0001}j\uD800k");
    expect(shown).toBe("a\\u202Eb\\u0085c\\u200Bd\\u2028e\\u2066f\\u007Fg\\u0007h\\uFEFFi\\uDB40\\uDC01j\\uD800k");
    // What a terminal prints as itself stays: accents, other scripts, symbols, a space, an emoji.
    expect(terminalText("é ü 日本 → ✓ 😀")).toBe("é ü 日本 → ✓ 😀");
    // Within a JSON text, the result reads back as the same value.
    const text = JSON.stringify({ key: "x\u202Ey\u2029" });
    expect(JSON.parse(terminalText(text))).toEqual({ key: "x\u202Ey\u2029" });
  });

  it("shows a value with its texts quoted and escaped, inside a variant too; a document keeps its line feeds and tabs", () => {
    // JSON's own quoting already escapes C0 controls (ESC as \u001b, CR as \r); the rest is terminalText's.
    expect(shownSafe("ok\u001b[6A\r\n")).toBe('"ok\\u001b[6A\\r\\n"');
    expect(shownSafe({ $tag: "Rejected", $args: ["no\u202E", { a: "b\u0085" }] })).toBe('Rejected("no\\u202E", {"a":"b\\u0085"})');
    expect(shownSafe(42)).toBe("42");
    expect(terminalDocument("# Title\n\n\tcode \u001b[2J\u202E\r\n")).toBe("# Title\n\n\tcode \\u001B[2J\\u202E\\u000D\n");
  });
});

describe("mandate review", () => {
  it("lists the open items, refuses a decision that breaks a rule, takes one that keeps them, and verifies what it took", async () => {
    const ana = await person("ana");
    const ben = await person("ben");
    mkdirSync(KEYS);
    for (const p of [ana, ben]) copyFileSync(p.pem, join(KEYS, `${p.id.slice("sha256:".length)}.pem`));
    const lock = { lock: "mandate/lock/0.6", modules: {}, members: { ana: { keys: [ana.id] }, ben: { keys: [ben.id] } }, roles: { accountant: ["ana"], finance_lead: ["ben"] } };
    writeFileSync(join(dir, "mandate.lock.json"), JSON.stringify(lock));

    // Item 4's key holds what would move, reorder or hide the lines a reviewer reads in a terminal.
    const items = JSON.stringify({ items: [{ key: "a", n: 1 }, { key: "b", n: 20 }, { key: "", n: 30 }, { key: "d", n: 40 }, { key: "e\u202Ex\u0085\u200B\u2028\u2066", n: 50 }] });
    const started = await mandate("run", join(dir, "check.mdt"), "--workflow", "Check", "--input", items, "--run-id", "r1");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("run r1  Check  waiting");
    expect(started.out).toContain("waiting for: accountant to review 3 items that failed Small only where a person may waive it");
    expect(started.out).toContain('value (model output): {"key":"e\\u202Ex\\u0085\\u200B\\u2028\\u2066","n":50}');
    for (const raw of ["\u202E", "\u0085", "\u200B", "\u2028", "\u2066"]) expect(started.out).not.toContain(raw);
    expect(started.out).toContain("then finance_lead is asked");
    expect(started.out).toContain('item 1: unmet small ("The item is small"; waivable by accountant, finance_lead)');
    expect(started.out).toContain('value (model output): {"key":"b","n":20}');
    expect(started.out).toContain("declined without asking (they failed what no one may waive): 2");
    const r = revisionOf(started.out);
    expect(started.out).toContain(`decide: mandate review r1 --revision ${r} --key <your key file> --waive <indices> --decline <indices> (every open item once: 1,3,4)`);
    // What the reviewer reads with `show` (Markdown, to a terminal) holds the value escaped too; JSON keeps it as it is.
    for (const how of [["--role", "accountant"], []]) {
      const md = await mandate("show", "r1", ...how);
      expect(md.code, md.err).toBe(0);
      expect(md.out).toContain("e\\u202Ex\\u0085\\u200B\\u2028\\u2066");
      for (const raw of ["\u202E", "\u0085", "\u200B", "\u2028", "\u2066"]) expect(md.out).not.toContain(raw);
    }
    const asJson = await mandate("show", "r1", "--role", "accountant", "--format", "json");
    expect(JSON.stringify((JSON.parse(asJson.out) as { waiting: unknown }).waiting)).toContain("e\u202Ex\u0085\u200B\u2028\u2066");

    // Refused by name, each, and the run stays at its revision.
    const notInRole = await mandate("review", "r1", "--revision", r, "--key", ben.key, "--waive", "1,3,4");
    expect([notInRole.code, notInRole.err]).toEqual([1, expect.stringContaining("invalid_decision: not_in_role")]);
    const leftOut = await mandate("review", "r1", "--revision", r, "--key", ana.key, "--waive", "1,4");
    expect([leftOut.code, leftOut.err]).toEqual([1, expect.stringContaining("incomplete_review: It leaves open item 3 undecided")]);
    const declinedAlready = await mandate("review", "r1", "--revision", r, "--key", ana.key, "--waive", "1,2,3,4");
    expect([declinedAlready.code, declinedAlready.err]).toEqual([1, expect.stringContaining("incomplete_review: It names item 2")]);
    const stale = await mandate("review", "r1", "--revision", String(Number(r) - 1), "--key", ana.key, "--waive", "1,3,4");
    expect([stale.code, stale.err]).toEqual([1, expect.stringContaining("stale_revision")]);
    const notIndex = await mandate("review", "r1", "--revision", r, "--key", ana.key, "--waive", "one");
    expect([notIndex.code, notIndex.err]).toEqual([2, expect.stringContaining("--waive takes item indices")]);
    const unsigned = await mandate("review", "r1", "--revision", r, "--waive", "1,3,4");
    expect([unsigned.code, unsigned.err]).toEqual([2, expect.stringContaining("--key FILE is required")]);
    const status = await mandate("status", "r1");
    expect(revisionOf(status.out)).toBe(r);

    // Taken: the waived item is accepted on its waiver, which the status shows as such.
    const done = await mandate("review", "r1", "--revision", r, "--key", ana.key, "--waive", "3", "--decline", "1,4");
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain("run r1  Check  succeeded");
    expect(done.out).toContain("result: 2");
    expect(done.out).toContain("evidence Small.small: waived (waiver; signed)");
    const line = done.out.split("\n").find((l) => l.startsWith("decision review by ana as accountant: signed ("))!;
    expect(line).toBeDefined();
    const digest = line.match(/\((sha256:[0-9a-f]{64})\)$/)![1]!;

    // The decision, as its signed record, checked by anyone with Ana's public key and the items it decided.
    const record = await mandate("decision", "r1", digest);
    expect(record.code, record.err).toBe(0);
    const file = join(dir, "review-decision.json");
    writeFileSync(file, record.out);
    const verified = await mandate("verify-decision", file, "--key", ana.pem, "--waive", "3", "--decline", "1,4", "--lock", join(dir, "mandate.lock.json"));
    expect(verified.code, verified.out).toBe(0);
    expect(verified.out).toContain("review by ana as accountant");
    expect(verified.out).toContain("it waived 3 and declined 1,4");
    const other = await mandate("verify-decision", file, "--key", ana.pem, "--waive", "1,3");
    expect(other.code).toBe(1);
    expect(other.out).toContain("invalid: the review's decision did not waive 1,3 and decline nothing");

    // Every value status shows of a 0.6 run is quoted and escaped: a result, as an action's receipt or a fault would be.
    const echoed = await mandate("run", join(dir, "check.mdt"), "--workflow", "Echo", "--input", '{"t":"ok\\u001b[6A\\u001b[J\\r  item 1: unmet totals"}', "--run-id", "e1");
    expect(echoed.code, echoed.err).toBe(0);
    expect(echoed.out).toContain('result: "ok\\u001b[6A\\u001b[J\\r  item 1: unmet totals"');
    for (const raw of ["\u001b", "\r"]) expect(echoed.out).not.toContain(raw);

    const shown = await mandate("show", "r1");
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toContain("## Review at /defs/Check/body/1/value");
    expect(shown.out).toContain("| Small.small | waiver | waived |");
  });
});
