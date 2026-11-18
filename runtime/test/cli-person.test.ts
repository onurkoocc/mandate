// What a person is shown and decides from a terminal (0.7; spec/attention.md "The command line"; slice B5):
// `mandate waits`, `mandate watch` (the pages and a role's events) and `mandate decide`. Every call is a separate CLI
// call over one PGlite database in a directory, as a person would make it; `decide` is driven by the lines a script
// would pipe in. The commands only read B4's projections and submit signed decisions through the paths `approve`,
// `answer`, `review` and `amend` use: what these tests hold them to is that a role is never shown above its cap, that no
// text a model, a person or a run wrote reaches a page or a terminal as markup or as a control, that the pages are
// script-free and stay in their directory, and that a decision made here is the one the other commands would have made.
// The made-up words are no secrets.

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { indexDoc, openItemLines, pageHtml, pageName, partName, requestLines, safeName, waitLines, waitListLine, waitsText } from "../src/person.js";
import { Runtime } from "../src/runtime.js";
import type { WaitItem } from "../src/watch.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-person-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What a model, a person or a run could write into any field: markup, a script, an event handler, a script URL, a terminal control, a bidirectional override. */
const HOSTILE = "<script>alert(1)</script>\"><img src=x onerror=alert(1)> <a href=\"javascript:alert(1)\">x</a>\u001b[2J\u202E\u0085";
/** A value of the confidential class, the marker no capped role may be shown. */
const MARK = "made-up-marker";

const PROGRAM = `mandate @ 0.7

module cli.person @ 0.1

use std.{fs, human}

role reviewer     "Reviewer <b>one</b>"
role accountant   "Accountant"
role finance_lead "Finance lead"

type Secret = Text classified confidential
type Note = { text: Text }
type Item = { key: Text, n: Int }

capability Notes = fs.read("/work/notes")

contract Approved(n: Note) {
  accept ok "The reviewer approved <i>it</i>"
    by human.approve(role: reviewer, deadline: 1h)
}

contract Small(i: Item) {
  accept keyed "The item has a key"
    by static len(i.key) >= 1
  accept small "The item is small"
    by static i.n < 10
    waive by accountant, finance_lead
}

/// Asks the reviewer about a secret.
workflow Ask(name: Text, secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  stage first "Ask <i>about</i> it"
  let a = human.ask("Is {secret} right for {name}?", role: reviewer)
  a
}

workflow Ship(n: Note) -> Text
  caps   Notes
  budget { time: 1h }
{
  let checked = verify n against Approved(n)
  "shipped"
}

workflow Check(items: List<Item>) -> Int
  caps   Notes
  budget { time: 1h }
{
  let checked = map it in items max 5 {
    verify it against Small(it)
  }
  let reviewed = human.review(checked, role: accountant, deadline: 1d)
  len(reviewed.accepted)
}
`;

const CONFIG = join(dir, "mandate.runtime.json");
const UNSIGNED = join(dir, "unsigned.runtime.json");
const KEYS = join(dir, "decision-keys");
writeFileSync(join(dir, "p.mdt"), PROGRAM);
writeFileSync(CONFIG, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" } }));
writeFileSync(UNSIGNED, JSON.stringify({ database: "pglite:db", decisions: { mode: "unsigned" } }));

interface Out {
  code: number;
  out: string;
  err: string;
}

/**
 * One CLI call. `input` is what a script pipes in, a line per prompt; a function in it runs just before its turn comes,
 * so a test can change the world between what `decide` shows and what it signs.
 */
async function mandate(args: string[], input?: Array<string | (() => Promise<void>)>, config = CONFIG): Promise<Out> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  const lines =
    input === undefined
      ? undefined
      : (async function* (): AsyncGenerator<string> {
          for (const l of input) {
            if (typeof l === "function") await l();
            else yield l;
          }
        })();
  try {
    const code = await main([...args, "--config", config], (s) => (out += s), {}, undefined, lines);
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

interface Person {
  key: string;
  id: string;
}

/** A person's key, made by `mandate key new`; its public half is trusted by the runtime. */
async function person(name: string): Promise<Person> {
  const home = join(dir, "people");
  mkdirSync(home, { recursive: true });
  const key = join(home, `${name}.key`);
  const made = await mandate(["key", "new", "--out", key]);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  mkdirSync(KEYS, { recursive: true });
  copyFileSync(join(home, `${id.slice("sha256:".length)}.pem`), join(KEYS, `${id.slice("sha256:".length)}.pem`));
  return { key, id };
}

let ana: Person;
let ben: Person;
let eve: Person;
const LOCK_SHOWN = join(dir, "shown.lock.json");
const LOCK_MASKED = join(dir, "masked.lock.json");
const run = (workflow: string, input: unknown, id: string, lock = LOCK_SHOWN) => mandate(["run", join(dir, "p.mdt"), "--workflow", workflow, "--input", JSON.stringify(input), "--lock", lock, "--run-id", id]);
const ASK = { name: HOSTILE, secret: MARK };
const ITEMS = { items: [{ key: "a", n: 1 }, { key: "b", n: 20 }, { key: "", n: 30 }, { key: "d", n: 40 }, { key: `e${HOSTILE}`, n: 50 }] };

/** The raw characters no output may hold: the controls, the bidirectional override and the next-line, as a terminal would act on them. */
const RAW = ["\u001b", "\u202E", "\u0085", "\u0007", "\r"];
const noRaw = (s: string): void => {
  for (const c of RAW) expect(s).not.toContain(c);
};

beforeAll(async () => {
  // Ana is a reviewer and the finance lead, Ben the accountant, Eve a member of no role.
  [ana, ben, eve] = [await person("ana"), await person("ben"), await person("eve")];
  const base = { lock: "mandate/lock/0.7", modules: {}, members: { ana: { keys: [ana.id] }, ben: { keys: [ben.id] }, eve: { keys: [eve.id] } }, roles: { reviewer: ["ana"], accountant: ["ben"], finance_lead: ["ana"] } };
  // In one lock the reviewer may be shown what is confidential; in the other the reviewer is capped at internal, which is no entry.
  writeFileSync(LOCK_SHOWN, JSON.stringify({ ...base, role_classes: { reviewer: "confidential", accountant: "confidential" } }));
  writeFileSync(LOCK_MASKED, JSON.stringify({ ...base, role_classes: { accountant: "confidential" } }));
  for (const [workflow, input, id, lock] of [
    ["Ask", ASK, "shown1", LOCK_SHOWN],
    ["Ask", ASK, "masked1", LOCK_MASKED],
    ["Ship", { n: { text: HOSTILE } }, "ship1", LOCK_SHOWN],
    ["Check", ITEMS, "r1", LOCK_SHOWN],
    // A run id is any text: a path, a device name, a bidirectional override must never name a file.
    ["Ask", ASK, "../evil", LOCK_SHOWN],
    ["Ask", ASK, "CON", LOCK_SHOWN],
    ["Ask", ASK, "a/b\\c\u202E", LOCK_SHOWN],
  ] as const) {
    const r = await run(workflow, input, id, lock);
    expect(r.code, r.err).toBe(0);
  }
}, 240_000);

/**
 * The columns an SQL string of the new commands selects: the strings of the code that hold a select, each one's select list
 * split at its top-level commas, whitespace collapsed. A column added to a select, or a select added, is one this lists.
 */
function sqlOf(code: string): string[][] {
  const out: string[][] = [];
  for (const m of code.matchAll(/(["`])((?:\\.|(?!\1)[^\\])*?)\1/gs)) {
    const sql = m[2]!.replace(/\s+/g, " ");
    const at = sql.search(/\bselect\b/i);
    if (at < 0) continue;
    const list: string[] = [];
    let depth = 0;
    let start = at + "select".length;
    for (let i = start; i < sql.length; i++) {
      const c = sql[i]!;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && c === ",") (list.push(sql.slice(start, i).trim()), (start = i + 1));
      if (depth === 0 && /^ from /i.test(sql.slice(i, i + 6))) {
        list.push(sql.slice(start, i).trim());
        start = -1;
        break;
      }
    }
    if (start !== -1) list.push(sql.slice(start).trim());
    out.push(list);
  }
  return out;
}

/** What the new commands may select: a lock, and the identity and counters of a run, and the last event number as an integer (a change marker). */
const ALLOWED_COLUMNS = [
  "package_hash",
  "lock",
  "r.run_id",
  "r.tenant",
  "r.workflow",
  "r.state",
  "r.revision",
  "r.updated_at",
  "r.package_hash",
  "(select coalesce(max(e.seq), 0) from events e where e.run_id = r.run_id) as last",
];

describe("mandate waits", () => {
  it("lists a role's open decisions, escaped, each value labelled, and masks what is above the role's cap", { timeout: 120_000 }, async () => {
    const w = await mandate(["waits", "--role", "reviewer"]);
    expect(w.code, w.err).toBe(0);
    noRaw(w.out);
    expect(w.out).toMatch(/^\d+ open decisions for role reviewer\n/);
    // What the reviewer may be shown is shown, escaped, with its class and how it is known.
    expect(w.out).toContain("run shown1  Ask");
    expect(w.out).toContain("[class confidential; known plain: computed by the run or given to it]");
    expect(w.out).toContain("\\u001b[2J\\u202E\\u0085");
    expect(w.out).toContain("  deadline  none");
    expect(w.out).toContain("  if nobody answers  nothing: the run keeps waiting (waits)");
    expect(w.out).toContain("the criterion is unmet when the deadline passes");
    // Above the cap: no value, no digest, only the class and how it is known.
    const masked = w.out.split("\n\n").find((block) => block.includes("run masked1  Ask"))!;
    expect(masked).toContain("subject   masked (class confidential; known plain)");
    expect(masked).toContain("question: masked; its class is confidential, above what reviewer may be shown; known plain");
    expect(masked).not.toContain(MARK);
    expect(masked).not.toContain("script");
    expect(masked).not.toMatch(/sha256:/);
  });

  it("gives the same list as JSON, whose texts are the same values and hold no raw control, with no value or digest for a masked wait", { timeout: 120_000 }, async () => {
    const w = await mandate(["waits", "--member", "ana", "--json"]);
    expect(w.code, w.err).toBe(0);
    noRaw(w.out);
    const items = JSON.parse(w.out) as Array<{ run: string; role: string; kind: string; subject: unknown; shown: Array<Record<string, unknown>> }>;
    // Ana holds reviewer and finance_lead: the Ask and Ship runs asked of the reviewer, hostile ids included.
    expect(items.map((i) => i.run).sort()).toEqual(["../evil", "CON", "a/b\\c\u202E", "masked1", "ship1", "shown1"].sort());
    const shown = items.find((i) => i.run === "shown1")!;
    expect(shown.shown[0]).toEqual({ name: "question", masked: false, value: `Is ${MARK} right for ${HOSTILE}?`, class: "confidential", known: "plain" });
    const masked = items.find((i) => i.run === "masked1")!;
    expect(masked.subject).toEqual({ masked: true, class: "confidential", known: "plain" });
    expect(masked.shown).toEqual([{ name: "question", masked: true, class: "confidential", known: "plain" }]);
    expect(JSON.stringify(masked)).not.toContain(MARK);
    expect(JSON.stringify(masked)).not.toContain("script");
    // Another tenant lists nothing; a role no package binds lists nothing, and neither is an error.
    expect((await mandate(["waits", "--role", "reviewer", "--tenant", "other", "--json"])).out.trim()).toBe("[]");
    const nobody = await mandate(["waits", "--role", "nobody"]);
    expect([nobody.code, nobody.out]).toEqual([0, expect.stringContaining("nothing waits for role nobody")]);
  });

  it("takes exactly one of --role and --member, and no run", { timeout: 120_000 }, async () => {
    for (const args of [[], ["--role", "reviewer", "--member", "ana"], ["r1", "--role", "reviewer"]]) {
      const r = await mandate(["waits", ...args]);
      expect([r.code, r.err], args.join(" ")).toEqual([2, expect.stringContaining("waits")]);
    }
  });

  it("never reads a run's raw state: no report, no status, no waiting column, no event of its own", () => {
    // The listing is B4's `listWaits` and the role's view; `report()` prints the raw `run.waiting` and is the operator's.
    const person = readFileSync(new URL("../src/person.ts", import.meta.url), "utf8");
    const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const mine = cli.slice(cli.indexOf("/** The runtime of a command that only reads"));
    // The code, not what its comments say it never does.
    const code = (text: string): string => text.replace(/\/\*[^]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [name, text] of [["person.ts", code(person)], ["cli.ts after readerRuntime", code(mine)]] as const) {
      expect(text, name).not.toMatch(/\breport\(/);
      // `waiting` of the role's own view (`runView(…, { role })`) is the only one read; a run row's is the raw one.
      expect(text, name).not.toMatch(/\b(run|row|r|runs)\.waiting\b/);
      expect(text, name).not.toMatch(/\bwaiting\b[^\n]*\bfrom\s+runs\b/);
      expect(text, name).not.toMatch(/\bstatusOf\(|\bstatus\(/);
      expect(text, name).not.toMatch(/select\s+\*/i);
      // Every SQL string reads only what the allow-list names (below), and nothing else of any table.
      const found = sqlOf(text);
      expect(found.length, name).toBeGreaterThan(0);
      for (const columns of found) for (const column of columns) expect(ALLOWED_COLUMNS, `${name}: ${column}`).toContain(column);
    }
    // The role view is read with the role named, never the audit audience.
    expect(code(person) + code(mine)).not.toMatch(/audit:\s*true/);
  });
});

describe("mandate watch <run> --role R --jsonl", () => {
  it("prints the role's events as JSON lines, in order, escaped, and a masked value without its content", { timeout: 120_000 }, async () => {
    const shown = await mandate(["watch", "shown1", "--role", "reviewer", "--jsonl"]);
    expect(shown.code, shown.err).toBe(0);
    noRaw(shown.out);
    const events = shown.out.trim().split("\n").map((l) => JSON.parse(l) as { seq: number; type: string; class: string; data?: Record<string, unknown> });
    expect(events.map((e) => e.seq)).toEqual([...events.map((e) => e.seq)].sort((a, b) => a - b));
    expect(events.some((e) => e.type === "wait_opened")).toBe(true);
    expect(events.every((e) => e.class !== "S3" && e.class !== "S4")).toBe(true);
    // The hostile text is the same value, written as JSON writes it.
    expect(JSON.stringify(events)).toContain(JSON.stringify(HOSTILE).slice(1, -1).replace("\u001b", "\\u001b"));
    expect(events.find((e) => e.type === "stage_started")!.data!["title"]).toBe("Ask <i>about</i> it");
    const masked = await mandate(["watch", "masked1", "--role", "reviewer", "--jsonl"]);
    expect(masked.code, masked.err).toBe(0);
    expect(masked.out).not.toContain(MARK);
    expect(masked.out).not.toContain("script");
    expect(JSON.parse(masked.out.trim().split("\n").find((l) => l.includes("wait_opened"))!)).toMatchObject({ data: { request: { question: { masked: true, class: "confidential", known: "plain" } } } });
  });

  it("has no audit audience, no pages, and refuses a role or a run that is not there", { timeout: 120_000 }, async () => {
    const cases: Array<[string[], number, string]> = [
      [["watch", "shown1", "--role", "reviewer", "--jsonl", "--audit"], 2, "no audit audience"],
      [["watch", "shown1", "--jsonl"], 2, "--role R is required"],
      [["watch", "shown1", "--role", "reviewer"], 2, "--jsonl"],
      [["watch", "shown1", "--role", "reviewer", "--jsonl", "--out", join(dir, "x")], 2, "--out is for the pages"],
      [["watch", "shown1", "--role", "reviewer", "--jsonl", "--follow"], 2, "--follow is for the pages"],
      [["watch", "shown1", "--role", "reviewer", "--jsonl", "--member", "ana"], 2, "--member is for the pages"],
      [["watch", "--member", "ana"], 2, "--out DIR is required"],
      [["watch", "--out", join(dir, "x")], 2, "--member M"],
      [["watch", "--member", "ana", "--out", join(dir, "x"), "--jsonl"], 2, "--jsonl is for the events"],
      [["watch", "--member", "ana", "--out", join(dir, "x"), "--role", "reviewer"], 2, "--role is for the events"],
      [["watch", "shown1", "--role", "nobody", "--jsonl"], 1, "unknown_role"],
      [["watch", "no-such-run", "--role", "reviewer", "--jsonl"], 1, "no-such-run"],
    ];
    for (const [args, code, why] of cases) {
      const r = await mandate(args);
      expect([r.code, r.err], args.join(" ")).toEqual([code, expect.stringContaining(why)]);
    }
  });
});

/** The tags a page holds, by name: every `<` of a text is escaped, so each `<` here opens a tag the page's builder wrote. */
function tags(html: string): Array<{ name: string; text: string }> {
  return [...html.matchAll(/<(\/?)([a-zA-Z!][^\s>/]*)([^>]*)>/g)].map((m) => ({ name: `${m[1]}${m[2]!.toLowerCase()}`, text: m[0] }));
}

describe("mandate watch --member M --out DIR", () => {
  const out = join(dir, "pages");

  it("writes script-free pages of the member's runs, each as its role is shown it, in files whose names no run data steers", { timeout: 180_000 }, async () => {
    const first = await mandate(["watch", "--member", "ana", "--out", out]);
    expect(first.code, first.err).toBe(0);
    const files = readdirSync(out).sort();
    // Every file is a name of safe characters, in the directory itself; a run id that is no safe name is a digest of it.
    for (const f of files) expect(f, f).toMatch(/^[A-Za-z0-9._-]+$/);
    const hashed = ["../evil", "CON", "a/b\\c\u202E"].map((id) => pageName(id, "reviewer"));
    expect(new Set(hashed).size).toBe(3);
    for (const h of hashed) expect(h).toMatch(/^_h-[0-9a-f]{16}\.reviewer\.html$/);
    // Ana holds two roles, so each run has a page for each: what that role is shown of it.
    const expected = ["masked1", "ship1", "shown1", "r1", "../evil", "CON", "a/b\\c‮"].flatMap((r) => [pageName(r, "reviewer"), pageName(r, "finance_lead")]);
    expect(files).toEqual(["index.html", ...expected].sort());
    expect(first.out).toMatch(/^watch: wrote 15 files in /);
    expect(first.err).toBe("");
    expect(existsSync(join(dir, "evil.reviewer.html"))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith(".html"))).toEqual([]);
    expect(readFileSync(join(out, hashed[0]!), "utf8")).toContain("Run ../evil");

    for (const f of files) {
      const html = readFileSync(join(out, f), "utf8");
      // Script-free: no script element, no handler attribute, no URL attribute of any kind, no external resource, no script URL in any tag.
      const found = tags(html);
      for (const t of found) {
        expect(t.name, `${f}: ${t.text}`).not.toMatch(/^\/?(script|iframe|object|embed|link|img|a|form|input|base)$/);
        expect(t.text, `${f}: ${t.text}`).not.toMatch(/\son[a-z]+\s*=/i);
        expect(t.text, `${f}: ${t.text}`).not.toMatch(/\s(href|src|action|formaction|srcset|style)\s*=|javascript:|https?:|data:/i);
      }
      expect(html).toContain("Content-Security-Policy");
      expect(html).toContain("default-src 'none'");
      expect(html).not.toMatch(/<script/i);
      // Everything of the hostile text is escaped: the markup is text, the controls are written out.
      expect(html).not.toContain("<script>alert(1)");
      expect(html).not.toContain("<img src=x");
      noRaw(html);
    }
    // The page of a role that may be shown the value shows it, as text; the page of one that may not, does not.
    const shown = readFileSync(join(out, "shown1.reviewer.html"), "utf8");
    expect(shown).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(shown).toContain("\\u001B[2J\\u202E");
    expect(shown).toContain("&lt;i&gt;about&lt;/i&gt;");
    for (const f of ["masked1.reviewer.html"]) {
      const html = readFileSync(join(out, f), "utf8");
      expect(html).not.toContain(MARK);
      expect(html).not.toContain("alert(1)");
      expect(html).toContain("Masked: its class is confidential");
    }
    // The index lists what waits with its deadline, what happens with no answer, and each value as the role is shown it.
    const index = readFileSync(join(out, "index.html"), "utf8");
    expect(index).toContain("Reading is not authenticated");
    expect(index).toContain("<th>Deadline</th><th>If nobody answers</th>");
    expect(index).toContain("question: masked (class confidential; known plain)");
    const row = index.split("<tr>").find((r) => r.includes("masked1.reviewer.html") && r.includes("Ask"))!;
    expect(row).toBeDefined();
    expect(row).not.toContain(MARK);
    expect(row).not.toContain("alert(1)");
    // The index names pages as text, and never as a link.
    expect(index).toContain("shown1.reviewer.html");
    expect(tags(index).filter((t) => /^a$/.test(t.name))).toEqual([]);
  });

  it("writes nothing again while nothing changed, and only the page of a run that moved when one does", { timeout: 180_000 }, async () => {
    // The state of a pass is its own: a second call is a second process of a person, and rewrites what it has not seen, with the same bytes.
    const before = Object.fromEntries(readdirSync(out).map((f) => [f, readFileSync(join(out, f), "utf8")]));
    const again = await mandate(["watch", "--member", "ana", "--out", out]);
    expect(again.code, again.err).toBe(0);
    for (const f of readdirSync(out)) expect(readFileSync(join(out, f), "utf8"), f).toBe(before[f]);
    expect(readdirSync(out).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    // A page carries no moment of its own, so that two passes over the same runs are the same bytes.
    expect(before["shown1.reviewer.html"]).not.toMatch(/generated|written at/i);
  });

  it("reloads itself only when asked to, with a refresh of whole seconds", { timeout: 180_000 }, async () => {
    const plain = readFileSync(join(out, "shown1.reviewer.html"), "utf8");
    expect(plain).not.toMatch(/http-equiv="refresh"/i);
    const refreshed = join(dir, "pages-refresh");
    const r = await mandate(["watch", "--member", "ana", "--out", refreshed, "--refresh", "30"]);
    expect(r.code, r.err).toBe(0);
    for (const f of readdirSync(refreshed)) expect(readFileSync(join(refreshed, f), "utf8"), f).toContain('<meta http-equiv="refresh" content="30">');
    for (const bad of ["0", "-5", "1.5", "abc", "100000", "30s", ""]) {
      const e = await mandate(["watch", "--member", "ana", "--out", join(dir, "pages-bad"), "--refresh", bad]);
      expect([e.code, e.err], bad).toEqual([2, expect.stringContaining("--refresh is a number of seconds")]);
    }
    expect(existsSync(join(dir, "pages-bad"))).toBe(false);
  });

  it("writes only inside the directory it was given; a member of no role gets an index and no run page", { timeout: 180_000 }, async () => {
    const e = join(dir, "pages-eve");
    const r = await mandate(["watch", "--member", "eve", "--out", e]);
    expect(r.code, r.err).toBe(0);
    expect(readdirSync(e)).toEqual(["index.html"]);
    // A file where the directory should be is refused, and nothing is written elsewhere.
    writeFileSync(join(dir, "a-file"), "x");
    const notDir = await mandate(["watch", "--member", "ana", "--out", join(dir, "a-file")]);
    expect([notDir.code, notDir.err]).toEqual([1, expect.stringContaining("cannot be made")]);
    expect(statSync(join(dir, "a-file")).isFile()).toBe(true);
  });

  it("makes a file name of a run and a role that is safe and one of a kind: no path, device name, case, dot or length steers or shares it", () => {
    expect(pageName("shown1", "reviewer")).toBe("shown1.reviewer.html");
    // The name is injective whatever the file system folds: every part is lowercase, dotless, at most 40 long, or a digest.
    const runs = ["../evil", "a/b", "a\\b", "..", ".", "", "CON", "con", "nul", "COM1", "lpt9", "AUX.txt", "x\u202Ey", "x y", "x\u0000y", "é", "a:b", "x\n", "C:\\x","_h-0123456789abcdef", "Run1", "run1", "RUN1", "x.", ".x", "x ", " x", "a.b", "a", "b", "A", "a".repeat(40), "a".repeat(41), "a".repeat(300), "run_2.x", "R.1", "run-1", "x..y"];
    const roles = ["reviewer", "Lead", "lead", "LEAD", "finance_lead"];
    const pages = new Set<string>();
    const folded = new Set<string>();
    for (const run of runs) {
      for (const role of roles) {
        const page = pageName(run, role);
        expect(page, `${JSON.stringify(run)} ${role}`).toMatch(/^(?:[a-z0-9_-]{1,40}|_h-[0-9a-f]{16})\.(?:[a-z0-9_-]{1,40}|_h-[0-9a-f]{16})\.html$/);
        expect(page.length).toBeLessThanOrEqual(86);
        pages.add(page);
        folded.add(page.toLowerCase());
      }
    }
    // All of them are names of their own, also where a file system sees no difference between a capital and its small letter.
    expect(pages.size).toBe(runs.length * roles.length);
    expect(folded.size).toBe(pages.size);
    // The case pairs, the trailing dot, a long name and the device names are each a digest, never the name itself.
    for (const bad of ["Run1", "x.", "a".repeat(41), "CON", "con", "nul", "COM1", "AUX.txt", "../evil", "_h-0123456789abcdef"]) {
      expect(safeName(bad), JSON.stringify(bad)).toBe(false);
      expect(partName(bad), JSON.stringify(bad)).toMatch(/^_h-[0-9a-f]{16}$/);
    }
    expect(partName("Run1")).not.toBe(partName("run1"));
    expect(partName("Lead")).not.toBe(partName("lead"));
    for (const ok of ["a", "run-1", "run_2", "a".repeat(40)]) expect([safeName(ok), partName(ok)]).toEqual([true, ok]);
  });
});

/** The decision a run's `decision` command prints, as a value without what differs between two signings (the moment, the signature, the run). */
async function recordOf(runId: string, kind: string): Promise<Record<string, unknown>> {
  const status = await mandate(["status", runId]);
  const line = status.out.split("\n").find((l) => l.startsWith(`decision ${kind} by `))!;
  expect(line, status.out).toBeDefined();
  const digest = line.match(/\((sha256:[0-9a-f]{64})\)$/)![1]!;
  const printed = await mandate(["decision", runId, digest]);
  expect(printed.code, printed.err).toBe(0);
  const record = JSON.parse(printed.out) as Record<string, unknown>;
  const { at: _at, run: _run, ...rest } = record["record"] as Record<string, unknown>;
  return rest;
}

describe("mandate decide", () => {
  it("is a usage error without a key, with a run, or in unsigned mode, and lists nothing for a key no role holds", { timeout: 180_000 }, async () => {
    expect([(await mandate(["decide"])).code, (await mandate(["decide"])).err]).toEqual([2, expect.stringContaining("--key FILE is required")]);
    const withRun = await mandate(["decide", "shown1", "--key", ana.key]);
    expect([withRun.code, withRun.err]).toEqual([2, expect.stringContaining("decide takes no run")]);
    const unsigned = await mandate(["decide", "--key", ana.key], undefined, UNSIGNED);
    expect([unsigned.code, unsigned.err]).toEqual([2, expect.stringContaining("unsigned mode")]);
    // Eve is a member the lock lists under no role: nothing waits for her.
    const nobody = await mandate(["decide", "--key", eve.key]);
    expect([nobody.code, nobody.out]).toEqual([0, expect.stringContaining("nothing waits for key")]);
    // Ben, the accountant, is asked about the review only.
    const ben1 = await mandate(["decide", "--key", ben.key], []);
    expect(ben1.out).toMatch(/^1 open decision for key /);
    expect(ben1.out).toContain("1. run r1  Check  review for accountant");
    expect([ben1.code, ben1.out]).toEqual([1, expect.stringContaining("the input ended before a wait was chosen; nothing was signed")]);
  });

  it("shows a masked wait as masked, and signs it only on the word yes", { timeout: 180_000 }, async () => {
    const list = await mandate(["waits", "--member", "ana"]);
    expect(list.code).toBe(0);
    const number = (await mandate(["decide", "--key", ana.key], [])).out.split("\n").find((l) => l.includes("run masked1"))!.match(/^(\d+)\./)![1]!;
    // `y` is not enough: it is not the word, and nothing is signed.
    const half = await mandate(["decide", "--key", ana.key], [number, "no", "y"]);
    expect(half.code).toBe(1);
    expect(half.out).toContain("what you are asked to decide is masked for reviewer");
    expect(half.out).toContain("You are deciding on something you are not shown");
    expect(half.out).toContain("Type yes to sign it anyway: y\n");
    expect(half.out).toContain("not confirmed; nothing was signed");
    expect(half.out).not.toContain(MARK);
    expect(half.out).not.toContain("alert(1)");
    expect((await mandate(["status", "masked1"])).out).toContain("waiting");
    noRaw(half.out);
    // `yes` signs it, and the answer is the run's.
    const done = await mandate(["decide", "--key", ana.key], [number, "no", "yes"]);
    expect(done.code, done.out + done.err).toBe(0);
    expect(done.out).toMatch(/signed by ana: answer "no"\nrun masked1 is now succeeded, revision \d+\n$/);
  });

  it("signs an answer as `answer` would, and verifies as theirs", { timeout: 180_000 }, async () => {
    // Two runs alike: one answered here, one by the existing command.
    for (const id of ["a-here", "a-there"]) expect((await run("Ask", ASK, id)).code).toBe(0);
    const list = (await mandate(["decide", "--key", ana.key], [])).out;
    const number = list.split("\n").find((l) => l.includes("run a-here"))!.match(/^(\d+)\./)![1]!;
    const here = await mandate(["decide", "--key", ana.key], [number, "ok to ship", "y"]);
    expect(here.code, here.out + here.err).toBe(0);
    expect(here.out).toContain("About to sign as ana (reviewer): answer \"ok to ship\"");
    expect(here.out).toContain("Your answer: ok to ship\n");
    expect(here.out).toMatch(/run a-here is now succeeded, revision \d+\n$/);
    const status = await mandate(["status", "a-there"]);
    const revision = status.out.match(/revision (\d+)/)![1]!;
    const there = await mandate(["answer", "a-there", "--revision", revision, "--key", ana.key, "ok to ship"]);
    expect(there.code, there.err).toBe(0);
    // The decision made here is of the same kind, by the same member in the same role, with the same payload.
    expect(await recordOf("a-here", "answer")).toEqual(await recordOf("a-there", "answer"));
    // And it verifies against the key like any other.
    const line = (await mandate(["status", "a-here"])).out.split("\n").find((l) => l.startsWith("decision answer by "))!;
    const digest = line.match(/\((sha256:[0-9a-f]{64})\)$/)![1]!;
    const file = join(dir, "decided-here.json");
    writeFileSync(file, (await mandate(["decision", "a-here", digest])).out);
    const verified = await mandate(["verify-decision", file, "--key", join(KEYS, `${ana.id.slice("sha256:".length)}.pem`), "--lock", LOCK_SHOWN]);
    expect(verified.code, verified.out).toBe(0);
  });

  it("signs an approval as `approve` would, and a decline as `decline` would", { timeout: 240_000 }, async () => {
    for (const id of ["s-here", "s-there", "d-here", "d-there"]) expect((await run("Ship", { n: { text: "x" } }, id)).code).toBe(0);
    const pick = async (id: string): Promise<string> => (await mandate(["decide", "--key", ana.key], [])).out.split("\n").find((l) => l.includes(`run ${id} `))!.match(/^(\d+)\./)![1]!;
    const approved = await mandate(["decide", "--key", ana.key], [await pick("s-here"), "approve", "yes"]);
    expect(approved.code, approved.out + approved.err).toBe(0);
    expect(approved.out).toContain("About to sign as ana (reviewer): approve");
    expect(approved.out).toMatch(/run s-here is now succeeded/);
    const rev = async (id: string): Promise<string> => (await mandate(["status", id])).out.match(/revision (\d+)/)![1]!;
    expect((await mandate(["approve", "s-there", "--revision", await rev("s-there"), "--key", ana.key])).code).toBe(0);
    expect(await recordOf("s-here", "approve")).toEqual(await recordOf("s-there", "approve"));
    const declined = await mandate(["decide", "--key", ana.key], [await pick("d-here"), "decline", "y"]);
    expect(declined.code, declined.out + declined.err).toBe(0);
    expect((await mandate(["decline", "d-there", "--revision", await rev("d-there"), "--key", ana.key])).code).toBe(0);
    expect(await recordOf("d-here", "decline")).toEqual(await recordOf("d-there", "decline"));
  });

  it("signs a review's decision as `review` would, in one line or item by item", { timeout: 240_000 }, async () => {
    for (const id of ["v-line", "v-item", "v-there"]) expect((await run("Check", ITEMS, id)).code).toBe(0);
    const benList = async (): Promise<string[]> => (await mandate(["decide", "--key", ben.key], [])).out.split("\n");
    const number = async (id: string): Promise<string> => (await benList()).find((l) => l.includes(`run ${id} `))!.match(/^(\d+)\./)![1]!;
    // The terminal shows each open item, its unmet criterion and who may waive it, the value escaped.
    const line = await mandate(["decide", "--key", ben.key], [await number("v-line"), "waive 3 decline 1,4", "y"]);
    expect(line.code, line.out + line.err).toBe(0);
    noRaw(line.out);
    expect(line.out).toContain('item 1: unmet small ("The item is small"; waivable by accountant, finance_lead)');
    expect(line.out).toContain("\\u001b[2J\\u202E\\u0085");
    expect(line.out).toContain("About to sign as ben (accountant): waive 3, decline 1,4");
    expect(line.out).toMatch(/run v-line is now succeeded/);
    const items = await mandate(["decide", "--key", ben.key], [await number("v-item"), "decline", "waive", "decline", "y"]);
    expect(items.code, items.out + items.err).toBe(0);
    expect(items.out).toContain("About to sign as ben (accountant): waive 3, decline 1,4");
    const status = await mandate(["status", "v-there"]);
    const there = await mandate(["review", "v-there", "--revision", status.out.match(/revision (\d+)/)![1]!, "--key", ben.key, "--waive", "3", "--decline", "1,4"]);
    expect(there.code, there.err).toBe(0);
    // A review's subject is the digest of its items as the run holds them, which differs run from run; all else is the same.
    const { subject: _a, ...here } = await recordOf("v-line", "review");
    const { subject: _b, ...item } = await recordOf("v-item", "review");
    const { subject: _c, ...theirs } = await recordOf("v-there", "review");
    expect(here).toEqual(item);
    expect(here).toEqual(theirs);
  });

  it("refuses by the runtime's own reasons, prints them, and signs nothing it was not asked to", { timeout: 240_000 }, async () => {
    expect((await run("Check", ITEMS, "v-bad")).code).toBe(0);
    const number = async (): Promise<string> => (await mandate(["decide", "--key", ben.key], [])).out.split("\n").find((l) => l.includes("run v-bad "))!.match(/^(\d+)\./)![1]!;
    // An item left out: the runtime says which.
    const left = await mandate(["decide", "--key", ben.key], [await number(), "waive 1,4", "y"]);
    expect([left.code, left.err]).toEqual([1, expect.stringContaining("incomplete_review: It leaves open item 3 undecided")]);
    // An answer that is not understood, the end of the input, and a "no" each sign nothing.
    const notIt = await mandate(["decide", "--key", ben.key], [await number(), "shrug"]);
    expect([notIt.code, notIt.err]).toEqual([2, expect.stringContaining("is not waive or decline")]);
    const oneLine = await mandate(["decide", "--key", ben.key], [await number(), "waive 1 sideways 3"]);
    expect([oneLine.code, oneLine.err]).toEqual([2, expect.stringContaining("is not `waive 0,2 decline 1`")]);
    const bad = await mandate(["decide", "--key", ben.key], ["9"]);
    expect([bad.code, bad.err]).toEqual([2, expect.stringContaining("is not a number from 1 to")]);
    const ended = await mandate(["decide", "--key", ben.key], [await number(), "waive 1,3,4"]);
    expect([ended.code, ended.out]).toEqual([1, expect.stringContaining("the input ended before the confirmation; nothing was signed")]);
    const no = await mandate(["decide", "--key", ben.key], [await number(), "waive 1,3,4", "n"]);
    expect([no.code, no.out]).toEqual([1, expect.stringContaining("not confirmed; nothing was signed")]);
    expect((await mandate(["status", "v-bad"])).out).toContain("waiting for: accountant to review");
  });
});

// ── the review of the first pass: every print site, the signing invariants, the page names, the error path ──────────

/** A text hostile to a terminal and to a page, with a marker naming the source it stands in: markup, an OSC and a CSI sequence, a bidirectional override, a line and a next-line separator, a carriage return. */
const hostileOf = (source: string): string => `${source}<b>\u001b]0;${source}\u0007\u001b[2J‮${source} ${source}\nline\r\u0085`;

/** No raw control, no override, no line break of any kind in `text`, on top of `noRaw`. */
const flat = (text: string): void => {
  noRaw(text);
  for (const c of ["\n", " ", " "]) expect(text).not.toContain(c);
};

describe("every print site", () => {
  const sources = ["run-id", "tenant", "workflow", "command", "kind", "asked-of", "role", "escalates-to", "no-answer", "stage", "subject", "shown-name", "shown-value", "value-class", "value-known", "masked-name", "masked-class", "masked-known"];
  const item = (over: Partial<WaitItem> = {}): WaitItem =>
    ({
      run: hostileOf("run-id"),
      tenant: hostileOf("tenant"),
      workflow: hostileOf("workflow"),
      package: "sha256:p",
      revision: 3,
      command: hostileOf("command"),
      kind: hostileOf("kind"),
      asked_of: hostileOf("asked-of"),
      role: hostileOf("role"),
      since: 1,
      deadline: 2,
      escalates_to: hostileOf("escalates-to"),
      on_no_answer: "escalates",
      stage: hostileOf("stage"),
      subject: hostileOf("subject"),
      shown: [
        { name: hostileOf("shown-name"), value: hostileOf("shown-value"), class: hostileOf("value-class"), known: hostileOf("value-known") },
        { name: hostileOf("masked-name"), masked: true, class: hostileOf("masked-class"), known: hostileOf("masked-known") },
      ],
      ...over,
    }) as unknown as WaitItem;

  it("escapes each text of a wait the commands print, whichever its source", () => {
    const lines = [...waitLines(item(), 1), waitListLine(item(), 1), ...waitLines(item({ on_no_answer: hostileOf("no-answer"), stage: null, asked_of: null }), undefined, false)];
    for (const l of lines) flat(l);
    const text = lines.join("\n");
    for (const s of sources) expect(text, s).toContain(s);
    // The markup a source holds is text there, not a tag.
    for (const s of sources) expect(text).not.toContain(`${s}<b>`.replace("<b>", "<b>\u001b"));
    // The whole list, as `waits` prints it.
    const list = waitsText({ member: hostileOf("member") }, [item()]);
    noRaw(list);
    expect(list).toContain("member");
  });

  it("escapes what a request holds: an amendment's workflow, lead and changes, a decision's contract and criterion, an option, a review item's criterion, description and waivers", () => {
    const h = hostileOf;
    const lines = [
      ...requestLines("amendment", { workflow: h("amend-workflow"), lead: h("amend-lead"), changes: [{ text: h("amend-change") }, { text: h("amend-reason") }] }),
      ...requestLines("decision", { contract: h("contract"), criterion: h("criterion") }),
      ...requestLines("decision", { effect: h("effect") }),
      ...requestLines("input", { options: [h("option-a"), h("option-b")] }),
      ...openItemLines(item(), { index: 2, unmet: [{ criterion: h("item-criterion"), description: h("item-description"), waive: [h("item-waiver"), h("item-waiver-2")] }] }, 0),
    ];
    for (const l of lines) flat(l);
    const text = lines.join("\n");
    for (const s of ["amend-workflow", "amend-lead", "amend-change", "amend-reason", "contract", "criterion", "effect", "option-a", "option-b", "item-criterion", "item-description", "item-waiver", "item-waiver-2"]) expect(text, s).toContain(s);
  });

  it("escapes every text of the page of a member: its index, whatever the source", () => {
    const run = { run: hostileOf("run-id"), tenant: hostileOf("tenant"), workflow: hostileOf("workflow"), state: hostileOf("state"), revision: 1, roles: [hostileOf("role"), hostileOf("role-2")], fingerprint: "f" };
    const html = pageHtml(indexDoc(hostileOf("member"), [item()], [run]), undefined);
    noRaw(html);
    for (const c of [" ", " "]) expect(html).not.toContain(c);
    for (const s of ["run-id", "workflow", "kind", "role", "asked-of", "escalates-to", "stage", "subject", "shown-name", "shown-value", "value-class", "value-known", "masked-name", "masked-class", "masked-known", "member", "state"]) expect(html, s).toContain(s);
    // No source's markup is a tag: the `<b>` after each marker is text.
    expect(html).not.toMatch(/[a-z-]<b>/);
    for (const t of tags(html)) expect(t.name, t.text).not.toMatch(/^\/?(script|iframe|object|embed|link|img|a|form|input|base)$/);
  });
});

// A second program, for what the first one cannot say: two roles whose names differ in case, a `par` that leaves two
// waits open, a run that moves between what is shown and what is signed, and a run id that is a terminal attack.
const PROGRAM2 = `mandate @ 0.7

module cli.person.two @ 0.1

use std.{fs, human}

role reviewer "Reviewer"
role Lead     "Upper lead"
role lead     "Lower lead"

type Secret = Text classified confidential

workflow AskUp(secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  let a = human.ask("Is {secret} right?", role: Lead)
  a
}

workflow AskLow(secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 4 }
{
  let a = human.ask("Is {secret} right?", role: lead)
  a
}

workflow Both(secret: Secret) -> Untrusted<Text>
  caps   []
  budget { time: 5m, steps: 8 }
{
  par {
    a = human.ask("First: is {secret} right?", role: reviewer)
    b = human.ask("Second: is {secret} right?", role: reviewer)
  }
  a
}
`;
const MARK2 = "second-made-up-marker";
const LOCK2 = join(dir, "second.lock.json");
writeFileSync(join(dir, "p2.mdt"), PROGRAM2);

describe("the second program: names, moving runs, two waits, the error path", () => {
  let zed: Person;
  const run2 = (workflow: string, id: string) => mandate(["run", join(dir, "p2.mdt"), "--workflow", workflow, "--input", JSON.stringify({ secret: MARK2 }), "--lock", LOCK2, "--run-id", id]);
  /** The number `decide` gives the wait whose line holds `part`, as it lists them for zed's key. */
  const numbers = async (part: string): Promise<string[]> => (await mandate(["decide", "--key", zed.key], [])).out.split("\n").filter((l) => /^\d+\. run /.test(l) && l.includes(part)).map((l) => l.match(/^(\d+)\./)![1]!);
  const decisionLines = (statusOut: string): string[] => statusOut.split("\n").filter((l) => l.startsWith("decision "));

  beforeAll(async () => {
    zed = await person("zed");
    writeFileSync(LOCK2, JSON.stringify({ lock: "mandate/lock/0.7", modules: {}, members: { zed: { keys: [zed.id] } }, roles: { reviewer: ["zed"], Lead: ["zed"], lead: ["zed"] }, role_classes: { reviewer: "confidential", Lead: "confidential" } }));
  }, 120_000);

  it("gives names that differ in case, a trailing dot, a long id or a device name each a page of its own, as the role is shown it", { timeout: 240_000 }, async () => {
    const ids = ["Run1", "run1", "trail.", "n".repeat(200), "nul", "Aux.txt"];
    for (const id of ids) {
      const r = await run2(id === "run1" ? "AskLow" : "AskUp", id);
      expect(r.code, `${id}: ${r.err}`).toBe(0);
    }
    const pages = join(dir, "pages-zed");
    const r = await mandate(["watch", "--member", "zed", "--out", pages]);
    expect([r.code, r.err]).toEqual([0, ""]);
    const files = readdirSync(pages).sort();
    const roles = ["reviewer", "Lead", "lead"];
    expect(files).toEqual(["index.html", ...ids.flatMap((id) => roles.map((role) => pageName(id, role)))].sort());
    expect(r.out).toMatch(/^watch: wrote 19 files in /);
    // No file system that folds case sees two files of one name, and none sees a name it refuses: every part is lowercase, dotless and short.
    expect(new Set(files.map((f) => f.toLowerCase())).size).toBe(files.length);
    for (const f of files) expect(f, f).toMatch(/^(index|(?:[a-z0-9_-]{1,40}|_h-[0-9a-f]{16})\.(?:[a-z0-9_-]{1,40}|_h-[0-9a-f]{16}))\.html$/);
    const page = (id: string, role: string): string => readFileSync(join(pages, pageName(id, role)), "utf8");
    // Each page is the projection of its own run and role: the upper lead is shown the secret, the lower lead is not.
    for (const id of ["Run1", "run1"]) {
      expect(page(id, "lead"), id).not.toContain(MARK2);
      expect(page(id, "lead")).toContain(`Run ${id}`);
      expect(page(id, "Lead")).toContain(`Run ${id}`);
    }
    expect(page("Run1", "Lead")).toContain(MARK2);
    expect(page("Run1", "Lead")).not.toBe(page("Run1", "lead"));
    expect(page("Run1", "Lead")).not.toContain("Run run1");
    expect(page("run1", "lead")).not.toContain("Run Run1");
    expect(page("Run1", "lead")).not.toContain("Run run1");
    expect(page("trail.", "Lead")).toContain("Run trail.");
    // Nothing remains of a write that was refused.
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("refuses to sign for a revision other than the one it showed, whatever the run is by the time it is signed", { timeout: 240_000 }, async () => {
    // The run id is a terminal attack, which an error path must not carry out either.
    const id = "moved\u001b[31m‮-1";
    expect((await run2("AskUp", id)).code).toBe(0);
    const [n] = await numbers("moved\\u001B[31m\\u202E-1");
    expect(n).toBeDefined();
    // The run moves on, as another process's step would move it, after the person was shown it and before the signature.
    let reader: Runtime | undefined;
    const real = Runtime.prototype.shown;
    const spy = vi.spyOn(Runtime.prototype, "shown").mockImplementation(function (this: Runtime, ...args: Parameters<Runtime["shown"]>) {
      reader = this;
      return real.apply(this, args);
    });
    try {
      const moved = await mandate(["decide", "--key", zed.key], [
        n!,
        "an answer",
        async () => {
          await reader!.db.query("update runs set revision = revision + 1 where run_id = $1", [id]);
        },
        "y",
      ]);
      expect([moved.code, moved.err]).toEqual([1, expect.stringContaining("stale_revision")]);
      expect(moved.err).toContain("The run moved on after the list was shown; nothing was decided");
      // What a refusal prints is escaped as well, the run id in it too.
      noRaw(moved.err);
      expect(moved.err).toContain("moved\\u001B[31m\\u202E-1");
      noRaw(moved.out);
    } finally {
      spy.mockRestore();
    }
    // Nothing was signed, and the run still waits.
    const status = await mandate(["status", id]);
    expect(decisionLines(status.out)).toEqual([]);
    expect(status.out).toContain("waiting for");
  });

  it("signs only the wait it showed: with two open, the one the run does not take first is refused, and nothing is signed for it", { timeout: 240_000 }, async () => {
    expect((await run2("Both", "par1")).code).toBe(0);
    const nums = await numbers("par1");
    expect(nums).toHaveLength(2);
    // The person is shown one wait of the two and answers it, but declines at the confirmation: one of the two is the run's current wait, the other is not.
    const tried = [];
    for (const n of nums) tried.push(await mandate(["decide", "--key", zed.key], [n, "an answer", "n"]));
    const refused = tried.map((t, i) => (t.out.includes("has more than one wait open and takes a decision on") ? i : -1)).filter((i) => i >= 0);
    expect(refused, tried.map((t) => t.out).join("\n---\n")).toHaveLength(1);
    expect(tried[refused[0]!]!.code).toBe(1);
    expect(tried[refused[0]!]!.out).toContain("nothing was signed");
    expect(tried[1 - refused[0]!]!.out).toContain("not confirmed; nothing was signed");
    // Even where the person goes on to confirm it, the refused wait is not signed for: the signature would be on the other one's digest.
    const confirmed = await mandate(["decide", "--key", zed.key], [nums[refused[0]!]!, "an answer for the wrong wait", "y"]);
    expect([confirmed.code, confirmed.out]).toEqual([1, expect.stringContaining("has more than one wait open")]);
    const status = await mandate(["status", "par1"]);
    expect(decisionLines(status.out)).toEqual([]);
    expect(status.out).toContain("waiting for");
  });

  it("checks the key is bound to the member given, before a wait is listed or anything is asked", { timeout: 240_000 }, async () => {
    for (const member of ["ben", "nobody", "zed\u001b[2J‮"]) {
      let asked = 0;
      const r = await mandate(["decide", "--key", zed.key, "--member", member], [async () => void (asked += 1), "1"]);
      expect([r.code, r.err], member).toEqual([1, expect.stringContaining("unknown_key")]);
      expect(r.out, member).not.toContain("Which one?");
      expect(r.out).toBe("");
      expect(asked).toBe(0);
      noRaw(r.err);
    }
    // The member the key is bound to is as it was.
    const own = await mandate(["decide", "--key", zed.key, "--member", "zed"], []);
    expect(own.code, own.err).toBe(1);
    expect(own.out).toContain("open decision");
    expect(own.out).toContain("for member zed");
  });

  it("escapes what the commands print on their error path: a run id, a role, a member, in a usage error and in a refusal", { timeout: 240_000 }, async () => {
    const bad = "ghost\u001b[2J‮\u0085x";
    for (const args of [["watch", bad, "--role", "reviewer", "--jsonl"], ["watch", bad, "--role", "reviewer"], ["watch", "--member", bad, "--out", join(dir, "pages-bad-member")], ["waits", bad], ["decide", bad, "--key", zed.key], ["waits", "--role", "r", "--member", bad]]) {
      const r = await mandate(args);
      if (args[0] !== "watch" || args[1] !== "--member") expect(r.code, args.join(" ")).not.toBe(0);
      noRaw(r.err);
      noRaw(r.out);
    }
    const unknown = await mandate(["watch", bad, "--role", "reviewer", "--jsonl"]);
    expect(unknown.err).toContain("ghost\\u001B[2J\\u202E\\u0085x");
    // The commands of 0.6 print what they printed: the shared handler is not touched for them.
    const old = await mandate(["status", "no-such-run"]);
    expect([old.code, old.err]).toEqual([1, "mandate: unknown_run: No run no-such-run.\n"]);
  });
});
