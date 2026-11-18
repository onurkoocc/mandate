// The live kit of 0.7 (fixtures/attention/live/README.md, scripts/live-session.mjs; slice B11), held to what its guide
// says. The scripted variant of the guide runs end to end, command by command, as separate processes: the world
// (`node scripts/live-session.mjs up`) in one, and every command of the persons in a process of its own, with the
// lines `up` prints for the shell (NODE_OPTIONS), through the Node CLI the guide names (bridge/dist/cli.js) and the
// REAL path to the two fakes: the runtime's `connect`, its adapters and the egress proxy, which puts the credentials
// into the requests (the rehearsal of B10 stands its simulators in at the transport and does not reach any of that).
// The deadlines are moved, never waited for. The tests need the build (`npm run build`), which CI makes before them.
//
// No secret is made by hand: the keys are made at run time by `mandate key new`, and the one credential-shaped value
// below is random, made when the test runs, and held in memory.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalOnly, checkSessionDir, cleanSession, durationMs, erpState, fill, isLoopbackAddress, LIVE, lockFrom, markSessionDir, MARKER, placeholders, postsSummary, readMarker, simulatedMatch, startWorld } from "../../scripts/lib/live-world.mjs";
import { ANCHOR, patched } from "../../scripts/lib/live-loader.mjs";
import { serveEgress } from "../src/egress/main.js";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = join(repo, "bridge", "dist", "cli.js");
const KIT = join(repo, "scripts", "live-session.mjs");
const PROGRAM = "fixtures/attention/invoices.mdt";
const README = readFileSync(join(repo, "fixtures", "attention", "live", "README.md"), "utf8");
const MODEL_KEYS = ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_WORKSPACE_ID"];
const TIMEOUT = 150_000;

const scratch = mkdtempSync(join(tmpdir(), "mandate-live-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Said {
  code: number | null;
  out: string;
  err: string;
}

/** The environment of a person's terminal: this one, with no model key in it. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  for (const k of MODEL_KEYS) delete env[k];
  return { ...env, ...extra };
}

/** A command as a child; `input` is what is typed to it, line by line. Everything it printed is kept in `printed`. */
const printed: string[] = [];
function run(args: string[], o: { env?: NodeJS.ProcessEnv; input?: string[] } = {}): Promise<Said> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, args, { cwd: repo, env: o.env ?? baseEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`${args.join(" ")} did not end in ${TIMEOUT / 1000} s\n${out}\n${err}`));
    }, TIMEOUT);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      printed.push(out, err);
      ok({ code, out, err });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(o.input === undefined ? "" : `${o.input.join("\n")}\n`);
  });
}

/** `up` as a child that stays up: resolves when it has printed the lines for the shell. */
function up(args: string[], env: NodeJS.ProcessEnv): { ready: Promise<string>; exit: Promise<Said>; output(): string; stop(): void } {
  const child = spawn(process.execPath, [KIT, "up", ...args], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  const exit = new Promise<Said>((ok) => child.on("close", (code) => ok({ code, out, err })));
  const ready = new Promise<string>((ok, fail) => {
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (out.includes("Ctrl+C here stops the world.")) ok(out);
    });
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    void exit.then((s) => fail(new Error(`up ended (${String(s.code)}) before it was ready\n${s.out}\n${s.err}`)));
    setTimeout(() => fail(new Error(`up was not ready in ${TIMEOUT / 1000} s\n${out}\n${err}`)), TIMEOUT).unref();
  });
  const record = (): void => void printed.push(out, err);
  void exit.then(record);
  return { ready, exit, output: () => out, stop: () => void child.kill("SIGTERM") };
}

const parseJson = (text: string): unknown[] => text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as unknown);
describe("the live kit's scripted variant, as the guide runs it", () => {
  it(
    "builds the world, takes the story from approval to live, and moves the deadlines",
    async () => {
      const dir = join(scratch, "mandate-live-scripted");
      const world = up(["--dir", dir], baseEnv());
      // Whatever fails below, the world this test started is stopped.
      try {
        const said = await world.ready;
        // What `up` prints for the shell is what the guide has the person paste: the session's directory and the preload.
        const options = /export NODE_OPTIONS='(--import=[^']+)'/.exec(said)?.[1];
        expect(options, said).toBeTruthy();
        expect(said).toContain(dir.replaceAll("\\", "/"));
        expect(said).not.toMatch(/PRIVATE KEY/);
        expect(said, "the next step is the second").toContain("step 2 of the guide");
        const S = dir.replaceAll("\\", "/");
        const C = `${S}/mandate.runtime.json`;
        const env = baseEnv({ NODE_OPTIONS: options! });
        const mandate = (args: string[], input?: string[]): Promise<Said> => run([CLI, ...args, ...(args.includes("--config") ? [] : ["--config", C])], { env, ...(input ? { input } : {}) });
        const kit = (args: string[]): Promise<Said> => run([KIT, ...args], { env });
        const plainKit = (args: string[]): Promise<Said> => run([KIT, ...args], { env: baseEnv() });
        const ok = (s: Said, what: string): Said => {
          expect(s.code, `${what}\n${s.out}\n${s.err}`).toBe(0);
          return s;
        };
        const ana = `${S}/people/ana/ana.key`;
        const ben = `${S}/people/ben/ben.key`;
        const lock = `${S}/invoices.lock.json`;
        const answers = ["1", "waive 2 decline 5", "y"];
        const run3 = (id: string, mode: string, more: string[] = []): Promise<Said> => mandate(["run", PROGRAM, "--workflow", "MatchInvoices", "--input", "{}", "--run-id", id, "--lock", lock, "--mode", mode, ...more]);
        const world_ = async (): Promise<{ posts: Array<{ invoice_no: string }>; posted: number; invoices: number; duplicated: number }> => {
          // What the fake ERP holds, as the kit's `drafts` shows it: every post, the distinct invoices, the duplicates.
          const shown = ok(await kit(["drafts", "--session", S]), "drafts").out;
          const { control } = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { control: number };
          const raw = (await (await fetch(`http://127.0.0.1:${control}/drafts`, { headers: { "x-live-session": "1" } })).json()) as { list: Array<{ invoice_no: string }>; posts: number; invoices: number; duplicated: unknown[] };
          expect(shown, "the kit's display says what the world holds").toContain(raw.posts === 0 ? "holds no draft invoice" : `${raw.posts} posts in the fake ERP, of ${raw.invoices} different invoices`);
          return { posts: raw.list, posted: raw.posts, invoices: raw.invoices, duplicated: raw.duplicated.length };
        };
        const classes = (file: string): Set<string> => new Set((parseJson(readFileSync(file, "utf8")) as Array<{ class: string }>).map((n) => n.class));
        // The clock line a command printed, as a number of hours ahead of the real now.
        const aheadHours = (text: string): number => {
          const m = /([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z).*wall clock \+ ([0-9.]+) h/.exec(text)!;
          const printedAt = Date.parse(m[1]!);
          expect(Math.abs(printedAt - (Date.now() + Number(m[2]) * 3_600_000)), `the printed time is the wall clock plus the offset it names: ${text}`).toBeLessThan(120_000);
          return Number(m[2]);
        };

        expect(ok(await kit(["status", "--session", S]), "status").out).toMatch(/model\s+simulated/);
        expect(ok(await kit(["orders", "--session", S]), "orders").out).toContain(`${LIVE.orderNo(0)}`);
        expect(ok(await kit(["inbox", "--session", S]), "inbox").out).toContain(`${LIVE.invoiceNo(7)}`);
        expect((await world_()).posted).toBe(0);

        // Step 3: two people, the lock from its template, the tool digests through the real proxy.
        for (const key of [ana, ben]) ok(await mandate(["key", "new", "--out", key]), "key new");
        ok(await kit(["lock", "--session", S, "--accountant", `ana=${ana}`, "--finance-lead", `ben=${ben}`]), "lock");
        const pinned = ok(await mandate(["connector", "pin", PROGRAM, "--lock", lock]), "connector pin");
        expect(pinned.out.match(/-> sha256:/g)).toHaveLength(5);
        const made = JSON.parse(readFileSync(lock, "utf8")) as { connectors: Record<string, { tools: Record<string, string> }>; members: Record<string, unknown>; roles: Record<string, string[]> };
        expect(Object.keys(made.connectors["acme.connectors.erp"]!.tools).sort()).toEqual(["delete_draft_invoice", "find_draft_invoice", "list_open_orders", "post_draft_invoice"]);
        expect(Object.keys(made.members).sort()).toEqual(["ana", "ben"]);
        expect(made.roles).toMatchObject({ accountant: ["ana"], finance_lead: ["ben"] });

        // Step 4 and 6: the card, and no run before the accountant approves it.
        expect(ok(await mandate(["view", PROGRAM, "--card", "--workflow", "MatchInvoices", "--lock", lock]), "card").out).toContain("When it asks whom");
        const before = await run3("u0", "design");
        expect(before.code, before.err).toBe(1);
        expect(before.err).toContain("unapproved_envelope");
        const byBen = await mandate(["approve-envelope", PROGRAM, "--key", ben, "--lock", lock]);
        expect(byBen.code, byBen.err).toBe(1);
        expect(byBen.err).toContain("not_in_role");
        ok(await mandate(["approve-envelope", PROGRAM, "--key", ana, "--lock", lock]), "approve-envelope");

        // Step 7: the design run, with the simulated Matcher, asks ana about the two items that may be waived.
        const d1 = ok(await run3("d1", "design"), "design run");
        expect(d1.out).toContain("run d1  MatchInvoices  waiting");
        const waits = ok(await mandate(["waits", "--member", "ana"]), "waits").out;
        for (const i of LIVE.TOTALS) expect(waits).toContain(LIVE.invoiceNo(i));
        expect(waits, "the invoice of another vendor is declined without asking").not.toContain(LIVE.invoiceNo(LIVE.VENDOR[0]!));
        expect(ok(await mandate(["decide", "--key", ana], answers), "decide d1").out).toContain("run d1 is now succeeded");
        expect((await world_()).posted, "a design run writes nothing").toBe(0);

        // Step 8 and 9: a promotion is the owner's; read_only writes nothing; the shadow diff shows the six posts.
        const promotedByBen = await mandate(["promote", "d1", "--to", "read_only", "--key", ben, "--yes"]);
        expect(promotedByBen.code).toBe(1);
        expect(promotedByBen.err).toContain("not_in_role");
        ok(await mandate(["promote", "d1", "--to", "read_only", "--key", ana, "--yes"]), "promote read_only");
        expect(ok(await run3("r1", "read_only"), "read_only run").out).toContain("waiting");
        expect(ok(await mandate(["decide", "--key", ana], answers), "decide r1").out).toContain("run r1 is now succeeded");
        expect((await world_()).posted, "a read_only run writes nothing").toBe(0);
        const diff = ok(await mandate(["shadow-diff", "d1", "r1"]), "shadow-diff").out;
        expect(diff.match(/erp\.post_draft_invoice\tonly_b/g)).toHaveLength(LIVE.PASSED.length + 1);
        const toLive = ok(await mandate(["promote", "r1", "--to", "live", "--key", ana, "--yes"]), "promote live");
        expect(toLive.out).toContain(`erp.post_draft_invoice: ${LIVE.PASSED.length + 1} would apply`);

        // Step 10: the live run, its notifications and pages, the decision, the posts in the fake ERP.
        expect(ok(await run3("l1", "live"), "live run").out).toContain("run l1  MatchInvoices  waiting");
        expect(ok(await mandate(["tick"]), "tick").out).toMatch(/notifications: [1-9]\d* sent/);
        expect(ok(await mandate(["waits", "--member", "ana"]), "waits l1").out).toContain("run l1  MatchInvoices");
        ok(await mandate(["watch", "--member", "ana", "--out", `${S}/pages`]), "watch pages");
        expect(readFileSync(join(dir, "pages", "l1.accountant.html"), "utf8")).toContain(LIVE.invoiceNo(LIVE.TOTALS[0]!));
        expect(ok(await mandate(["decide", "--key", ana], answers), "decide l1").out).toContain("run l1 is now succeeded");
        expect(ok(await mandate(["tick"]), "tick after the decision").out).toMatch(/notifications: [1-9]\d* sent/);
        const expected = [...LIVE.PASSED, LIVE.TOTALS[0]!].map((i) => LIVE.invoiceNo(i)).sort();
        const afterL1 = await world_();
        // What the fake ERP was sent: six posts of six invoices, each once, none sent twice by a retry. It is a count
        // of posts, not of invoices: a second post of an invoice would show.
        expect(afterL1.posts.map((p) => p.invoice_no).sort()).toEqual(expected);
        expect([afterL1.posted, afterL1.invoices, afterL1.duplicated]).toEqual([6, 6, 0]);
        // The accountant is shown events of classes S0 to S2 and no other.
        const events = parseJson(ok(await mandate(["watch", "l1", "--role", "accountant", "--jsonl"]), "watch role").out) as Array<{ class: string }>;
        expect(events.length).toBeGreaterThan(5);
        expect(new Set(events.map((e) => e.class))).toEqual(new Set(["S0", "S1", "S2"].filter((c) => events.some((e) => e.class === c))));
        const sinkFile = join(dir, "notifications.jsonl");
        expect(parseJson(readFileSync(sinkFile, "utf8")).map((n) => (n as { event: string }).event)).toEqual(expect.arrayContaining(["review_requested", "run_succeeded"]));
        expect([...classes(sinkFile)].filter((c) => c !== "S0" && c !== "S1"), "notifications carry S0 and S1 only").toEqual([]);

        // Step 11: the asks bound: the card, the count in the run, and the refused start.
        expect(ok(await mandate(["view", PROGRAM, "--card", "--workflow", "MatchInvoices", "--lock", lock]), "card again").out).toContain("At most 2 questions");
        expect(ok(await mandate(["status", "l1"]), "status l1").out).toMatch(/asks/);
        const tooFew = await run3("x1", "design", ["--limit", "asks=1"]);
        expect(tooFew.code, tooFew.out).toBe(1);
        expect(tooFew.err).toContain("attention_above_asks");

        // Step 12: a deadline is moved, not waited for. A read_only run, so that nothing is posted twice. Ana is told
        // of the question first (a tick before the clock moves); the first deadline passes: the question goes to ben;
        // the second: declined by nobody.
        expect(ok(await run3("r2", "read_only"), "read_only run again").out).toContain("waiting");
        expect(ok(await mandate(["tick"]), "tick tells ana").out).toMatch(/notifications: [1-9]\d* sent/);
        const toldAna = parseJson(readFileSync(sinkFile, "utf8")) as Array<{ event: string; run?: string; run_id?: string }>;
        expect(toldAna.some((n) => n.event === "review_requested" && JSON.stringify(n).includes("r2")), "ana was notified of r2's question").toBe(true);
        // The clock the kit prints is the session's clock, once, with the preload and without it.
        expect(aheadHours(ok(await kit(["advance", "25h", "--session", S]), "advance").out)).toBeCloseTo(25, 1);
        expect(aheadHours(ok(await kit(["status", "--session", S]), "status with the preload").out)).toBeCloseTo(25, 1);
        expect(aheadHours(ok(await plainKit(["status", "--session", S]), "status without the preload").out)).toBeCloseTo(25, 1);
        expect(ok(await mandate(["tick"]), "tick escalates").out).toContain("run r2: waiting -> waiting");
        expect(ok(await mandate(["waits", "--member", "ben"]), "waits ben").out).toContain("run r2  MatchInvoices");
        expect(aheadHours(ok(await kit(["advance", "25h", "--session", S]), "advance again").out), "+50 h, not +100 h").toBeCloseTo(50, 1);
        expect(ok(await mandate(["tick"]), "tick expires").out).toContain("run r2: waiting -> succeeded");
        expect(ok(await mandate(["status", "r2"]), "status r2").out).toMatch(/"by":null/);
        expect((await world_()).posted, "a read_only run posts nothing more").toBe(6);
        // Nothing else of the person's terminal is shifted: a Node process that is not the mandate command has the wall clock.
        const other = ok(await run(["-e", "console.log(Date.now())"], { env }), "another program under the preload");
        expect(Math.abs(Number(other.out.trim()) - Date.now()), "the preload leaves other programs' clock alone").toBeLessThan(60_000);
        expect(other.err).toBe("");
        // And the command that advance ran without the preload moves the clock by what it names.
        expect(aheadHours(ok(await plainKit(["advance", "1m", "--session", S]), "advance without the preload").out)).toBeCloseTo(50.02, 2);

        // Step 13: replay. The design run and the live run replay equal; the read_only run is partial, a known limit.
        for (const id of ["d1", "l1"]) {
          const status = ok(await mandate(["status", id]), `status ${id}`).out;
          const replayed = ok(await mandate(["replay", id]), `replay ${id}`).out;
          expect(replayed, id).toContain("replay: complete");
          const result = /^result:\s*(.*)$/m.exec(status)?.[1] ?? /\n(\{.*\})\s*$/.exec(status)?.[1];
          expect(result, `status ${id} prints a result\n${status}`).toBeTruthy();
          expect(replayed, `the replay of ${id} gives the result the run gave`).toContain(result!);
        }
        expect(ok(await mandate(["replay", "r1"]), "replay r1").out).toMatch(/replay: partial/);

        // A second live run of the same invoices posts them again: the operation key belongs to the run. The fake ERP
        // says so (it keeps every post by its key), and the guide says so.
        expect(ok(await run3("l2", "live"), "second live run").out).toContain("run l2  MatchInvoices  waiting");
        expect(ok(await mandate(["decide", "--key", ana], answers), "decide l2").out).toContain("run l2 is now succeeded");
        const twice = await world_();
        expect([twice.posted, twice.invoices, twice.duplicated], "the same six invoices, posted in two runs, are twelve posts").toEqual([12, 6, 6]);
        expect(ok(await kit(["drafts", "--session", S]), "drafts twice").out).toMatch(/6 invoices were posted more than once/);
        expect(README).toContain("A second live run posts the same invoices again");

        // What the fakes saw: every request came through the proxy with its credential, and none was refused.
        const seen = world.output();
        expect(seen).toMatch(/mailbox\s+list_invoices/);
        expect(seen).toMatch(/ERP\s+post_draft_invoice \(posted a draft/);
        expect(seen).toMatch(/posted ANOTHER draft of an invoice already posted/);
        expect(seen).not.toContain("refused a request");

        // Nothing secret was printed or written: the private keys are in the session directory and nowhere else.
        const inKey = (f: string): string[] => readFileSync(f, "utf8").split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"));
        const body = [...inKey(ana), ...inKey(ben)];
        expect(body.length).toBeGreaterThan(0);
        for (const line of body) for (const text of [...printed, seen]) expect(text).not.toContain(line);
        const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []));
        let scanned = 0;
        for (const f of files(dir)) {
          // The persons' keys are theirs (people/), and the runtime's own evidence key is its state (.mandate/): both stay in the directory.
          if (relative(dir, f).startsWith("people") || relative(dir, f).startsWith(".mandate") || statSync(f).size > 5_000_000) continue;
          expect(readFileSync(f, "latin1"), f).not.toMatch(/PRIVATE KEY|Bearer [0-9a-f]{20,}|(?<![0-9a-f:])[0-9a-f]{48}(?![0-9a-f])/);
          scanned++;
        }
        expect(scanned, "the scan read the session's files").toBeGreaterThanOrEqual(10);
        expect(relative(repo, dir).startsWith(".."), "the session lives outside the repository").toBe(true);

        // The world's control port answers the kit's own commands only: a request without their header (a page in a
        // browser cannot send it) is refused, and cannot stop the world.
        const { control } = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { control: number };
        expect((await fetch(`http://127.0.0.1:${control}/stop`, { method: "POST" })).status).toBe(403);
        expect(ok(await kit(["status", "--session", S]), "status").out).toMatch(/world +running/);

        // Step 15: stop, end the clock, clean up. A terminal that still has the preload after `clean` is told so once, and works.
        const down = ok(await kit(["down", "--session", S]), "down").out;
        expect(down).toContain("down");
        expect(down, "down reminds to end the clock").toContain("unset NODE_OPTIONS");
        expect((await world.exit).code).toBe(0);
        expect(ok(await kit(["status", "--session", S]), "status after down").out).toContain("not running");
        expect(ok(await kit(["clean", "--session", S]), "clean").out).toContain("removed");
        expect(existsSync(dir)).toBe(false);
        const afterClean = await run([CLI, "status", "nothing"], { env });
        expect(afterClean.err, "no crash from the preload").not.toContain("ENOENT");
        expect(afterClean.err.match(/live-session preload: not applied/g), "one line of warning").toHaveLength(1);
        expect(afterClean.err).toContain("unset NODE_OPTIONS");
        const fine = ok(await run(["-e", "console.log('still runs')"], { env }), "another program after clean");
        expect([fine.out.trim(), fine.err]).toEqual(["still runs", ""]);
      } finally {
        world.stop();
        await Promise.race([world.exit, new Promise((r) => setTimeout(r, 20_000))]);
      }
    },
    280_000,
  );
});

describe("the posts the fake ERP keeps", () => {
  it("keeps every post by the key it came with: a key sent again is one post, a new key for an invoice is another", () => {
    const erp = erpState(LIVE);
    const post = (erp.tools as Array<{ name: string; run(a: Record<string, unknown>): unknown }>).find((t) => t.name === "post_draft_invoice")!;
    const m = (i: number): Record<string, unknown> => ({ invoice_no: LIVE.invoiceNo(i), order: LIVE.order(i) });
    const send = (i: number, key: string): { structured: { draft_id: string } } => post.run({ m: m(i), key }) as never;
    const first = send(0, "key-run-1");
    expect(send(0, "key-run-1").structured.draft_id, "a retry under the same key is the same post").toBe(first.structured.draft_id);
    expect(erp.posts.size).toBe(1);
    expect(erp.posts.get("key-run-1")!.calls).toBe(2);
    const again = send(0, "key-run-2");
    expect(again.structured.draft_id, "another run's key is another post").not.toBe(first.structured.draft_id);
    send(1, "key-run-1b");
    expect(erp.posts.size).toBe(3);
    expect(postsSummary(erp.posts.values())).toEqual({ posts: 3, invoices: 2, duplicated: [{ invoice_no: LIVE.invoiceNo(0), posts: 2 }], retried: 1 });
  });
});

describe("the session directory: what the kit writes into and removes", () => {
  const fresh = (name: string): string => join(scratch, name);
  /** A directory the kit made a session in, as `up` leaves it: the marker, session.json of the same id, and some of its files. */
  function session(name: string, parent = scratch): string {
    const dir = join(parent, name);
    const id = markSessionDir(dir);
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id }));
    writeFileSync(join(dir, "clock-offset-ms"), "0");
    mkdirSync(join(dir, "people", "ana"), { recursive: true });
    writeFileSync(join(dir, "people", "ana", "ana.key"), "k");
    return dir;
  }

  it("`up` refuses a directory that is not empty and not its own, and any path inside a git work tree", async () => {
    const stray = fresh("mandate-live-stray");
    mkdirSync(stray);
    writeFileSync(join(stray, "mine.txt"), "mine");
    const a = await run([KIT, "up", "--dir", stray], { env: baseEnv() });
    expect(a.code).toBe(1);
    expect(a.err).toMatch(/not empty and is not a live session/);
    expect(readdirSync(stray), "nothing was written into it").toEqual(["mine.txt"]);

    for (const inside of [repo, join(repo, "scratch-live"), "."]) {
      const b = await run([KIT, "up", "--dir", inside], { env: baseEnv() });
      expect(b.code, inside).toBe(1);
      expect(b.err, inside).toMatch(/inside a git work tree/);
    }
    expect(existsSync(join(repo, "scratch-live"))).toBe(false);
    expect(existsSync(join(repo, MARKER))).toBe(false);

    const work = fresh("a-work-tree");
    mkdirSync(join(work, ".git"), { recursive: true });
    const c = await run([KIT, "up", "--dir", join(work, "session")], { env: baseEnv() });
    expect(c.err).toMatch(/inside a git work tree/);
    expect(existsSync(join(work, "session"))).toBe(false);
    // The checks are the same function the world calls: an empty directory and the kit's own are accepted.
    const empty = fresh("mandate-live-empty");
    mkdirSync(empty);
    expect(checkSessionDir(empty)).toEqual({ resume: false });
    expect(checkSessionDir(session("mandate-live-own"))).toEqual({ resume: true });
  }, TIMEOUT);

  it("`clean` removes only a directory with the kit's own marker, outside every repository, and only what the kit made", async () => {
    // No marker: the old guard matched a name anywhere; a parent called mandate-live-… must not do.
    const parent = fresh("mandate-live-parent");
    const project = join(parent, "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "session.json"), "{}");
    writeFileSync(join(project, "work.txt"), "somebody's file");
    const refused = await run([KIT, "clean", "--session", project], { env: baseEnv() });
    expect(refused.code).toBe(1);
    expect(refused.err).toMatch(new RegExp(`not a live session's directory \\(no ${MARKER}`));
    expect(readdirSync(project).sort(), "nothing was removed").toEqual(["session.json", "work.txt"]);

    // A marker whose id is not the session.json's.
    const mismatched = session("mandate-live-mismatch");
    writeFileSync(join(mismatched, "session.json"), JSON.stringify({ id: "0".repeat(32) }));
    const m = await run([KIT, "clean", "--session", mismatched], { env: baseEnv() });
    expect(m.code).toBe(1);
    expect(m.err).toMatch(/does not belong to the marker's session/);
    expect(existsSync(mismatched)).toBe(true);

    // A session directory inside a git work tree (a marker alone is not enough).
    const work = fresh("a-checkout");
    mkdirSync(join(work, ".git"), { recursive: true });
    const inside = session("session", work);
    const w = await run([KIT, "clean", "--session", inside], { env: baseEnv() });
    expect(w.code).toBe(1);
    expect(w.err).toMatch(/inside a git work tree/);
    expect(existsSync(join(inside, "session.json"))).toBe(true);
    expect(() => cleanSession(inside)).toThrow(/inside a git work tree/);

    // Its own, with a foreign file in it: what the kit made goes, the foreign file stays, and it is listed.
    const own = session("mandate-live-own-clean");
    writeFileSync(join(own, "notes.txt"), "the owner's notes");
    const c = await run([KIT, "clean", "--session", own], { env: baseEnv() });
    expect(c.code, c.err).toBe(0);
    expect(c.out).toContain("left, because the kit did not make it: notes.txt");
    expect(readdirSync(own)).toEqual(["notes.txt"]);
    expect(readMarker(own)).toBeUndefined();

    // Its own and nothing else: the directory goes too.
    const alone = session("mandate-live-alone");
    const d = await run([KIT, "clean", "--session", alone], { env: baseEnv() });
    expect(d.code, d.err).toBe(0);
    expect(existsSync(alone)).toBe(false);
  }, TIMEOUT);

  it("the preload does nothing outside the mandate command of this repository, and does not patch another control.js", async () => {
    const dir = session("mandate-live-hook");
    writeFileSync(join(dir, "session.json"), JSON.stringify({ id: readMarker(dir)!.id, model: "simulated" }));
    writeFileSync(join(dir, "clock-offset-ms"), String(50 * 3_600_000));
    const hook = `--import=${pathToFileURL(join(repo, "scripts", "lib", "live-hook.mjs")).href}?session=${encodeURIComponent(dir)}`;
    const env = baseEnv({ NODE_OPTIONS: hook });
    // Another program is left alone: no shifted clock, no warning, and another control.js is loaded as it is.
    const other = join(scratch, "elsewhere", "runtime", "dist");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "control.js"), "export const marker = 'untouched';\n");
    const script = join(scratch, "elsewhere", "probe.mjs");
    writeFileSync(script, "import { marker } from './runtime/dist/control.js';\nconsole.log(JSON.stringify({ marker, now: Date.now() }));\n");
    const probe = await run([script], { env });
    expect(probe.code, probe.err).toBe(0);
    expect(probe.err).toBe("");
    const got = JSON.parse(probe.out) as { marker: string; now: number };
    expect(got.marker).toBe("untouched");
    expect(Math.abs(got.now - Date.now()), "the clock of another program is the wall clock").toBeLessThan(60_000);
    // The mandate command of this repository does get the session's clock.
    const mine = await run([CLI, "status", "nothing", "--config", join(dir, "mandate.runtime.json")], { env });
    expect(mine.err, mine.out).not.toContain("live-session preload");
    // The kit's own commands never run on a shifted clock (a hook set in their environment is no change to them).
    const gone = join(scratch, "mandate-live-hook-gone");
    const lone = await run([CLI, "status", "nothing"], { env: baseEnv({ NODE_OPTIONS: `--import=${pathToFileURL(join(repo, "scripts", "lib", "live-hook.mjs")).href}?session=${encodeURIComponent(gone)}` }) });
    expect(lone.err.match(/live-session preload: not applied/g)).toHaveLength(1);
    expect(lone.err).not.toContain("ENOENT");
  }, TIMEOUT);
});

describe("the real model, and the kit's other refusals", () => {
  it("--real-model needs a key from the environment, and starts nothing without one", async () => {
    const dir = join(scratch, "mandate-live-nokey");
    const said = await run([KIT, "up", "--dir", dir, "--real-model"], { env: baseEnv() });
    expect(said.code).toBe(1);
    expect(said.err).toMatch(/CLAUDE_API_KEY/);
    expect(existsSync(dir), "nothing was made").toBe(false);
  }, TIMEOUT);

  it("--real-model gives the key to the egress proxy alone: it is in no file, and no command of the persons sees it", async () => {
    if (process.platform !== "win32" && process.platform !== "linux") return;
    const dir = join(scratch, "mandate-live-keyed");
    const key = randomBytes(24).toString("hex");
    const world = up(["--dir", dir, "--real-model"], baseEnv({ CLAUDE_API_KEY: key }));
    try {
      const said = await world.ready;
      expect(said).toContain("REAL");
      expect(said).not.toContain(key);
      const config = JSON.parse(readFileSync(join(dir, "mandate.runtime.json"), "utf8")) as Record<string, unknown>;
      expect(config).toMatchObject({ model: { provider: "anthropic" }, egress: { gateways: { model: "anthropic" } } });
      const proxy = JSON.parse(readFileSync(join(dir, "mandate.egress.json"), "utf8")) as { credentials: Record<string, { env: string; hosts: string[] }> };
      expect(proxy.credentials["anthropic"]).toMatchObject({ env: "CLAUDE_API_KEY", hosts: ["api.anthropic.com"] });
      for (const f of readdirSync(dir)) if (statSync(join(dir, f)).isFile()) expect(readFileSync(join(dir, f), "utf8"), f).not.toContain(key);
      // The runtime reads the configuration as it is (strictly: an unknown field is refused).
      const status = await run([CLI, "status", "nothing", "--config", join(dir, "mandate.runtime.json")], { env: baseEnv() });
      expect(status.err, status.out).toContain("unknown_run");
    } finally {
      world.stop();
      await world.exit;
    }
  }, TIMEOUT);

  it("refuses a host that is not this machine, in the lock and in the connectors' declaration", async () => {
    for (const host of ["8.8.8.8", "erp.acme.com", "10.0.0.5", "localhost.evil.net"]) expect(() => assertLocalOnly("a host", host), host).toThrow(/will not be pointed at a real system/);
    for (const host of ["127.0.0.1", "127.8.9.1", "erp.acme.example", "mail.test"]) expect(() => assertLocalOnly("a host", host), host).not.toThrow();
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("0.0.0.0")).toBe(false);
    // A copy of the pieces of the repository the world reads, with the ERP's host made a real name.
    const fake = join(scratch, "repo-with-a-real-host");
    mkdirSync(join(fake, "fixtures", "attention"), { recursive: true });
    cpSync(join(repo, "fixtures", "attention", "live"), join(fake, "fixtures", "attention", "live"), { recursive: true });
    cpSync(join(repo, "fixtures", "library"), join(fake, "fixtures", "library"), { recursive: true });
    const template = join(fake, "fixtures", "attention", "live", "invoices.lock.template.json");
    writeFileSync(template, readFileSync(template, "utf8").replace("erp.acme.example", "erp.acme.com"));
    await expect(startWorld({ dir: join(scratch, "never"), repo: fake, book: LIVE }, { serveEgress: serveEgress as never })).rejects.toThrow(/erp\.acme\.com.*will not be pointed at a real system/);
    expect(existsSync(join(scratch, "never")), "it refused before it made anything").toBe(false);
  });

  it("keeps the simulated Matcher in step with the runtime: the line it replaces is there, and its absence is loud", () => {
    expect(readFileSync(join(repo, "runtime", "src", "control.ts"), "utf8")).toContain(ANCHOR);
    expect(readFileSync(join(repo, "runtime", "dist", "control.js"), "utf8")).toContain(ANCHOR);
    expect(patched("file:///x/runtime/dist/control.js", `a;${ANCHOR};b`)).toContain("globalThis.__mandateLiveAgents");
    expect(() => patched("file:///x/runtime/dist/control.js", "export {}")).toThrow(/no longer fits/);
    expect(patched("file:///x/runtime/dist/other.js", "export {}")).toBe("export {}");
    // It answers for the invoice it is asked about, with the order its number names, and for no other skill.
    const asked = simulatedMatch(LIVE, [{ invoice_no: LIVE.invoiceNo(6), vendor_id: LIVE.vendorOf(6), total_cents: 1 }]);
    expect(asked.ok).toMatchObject({ invoice_no: LIVE.invoiceNo(6), order: LIVE.order(6) });
    expect(simulatedMatch(LIVE, [{ invoice_no: "unknown" }]).error).toBeTruthy();
  });

  it("makes the lock from its template with nothing left to edit, and counts durations", () => {
    const template = readFileSync(join(repo, "fixtures", "attention", "live", "invoices.lock.template.json"), "utf8");
    expect(placeholders(template).sort()).toEqual(["accountant-key", "accountant-member", "finance-lead-key", "finance-lead-member"]);
    const made = lockFrom(JSON.parse(template), { accountant: { member: "ana", keyId: `sha256:${"a".repeat(64)}` }, finance_lead: { member: "ben", keyId: `sha256:${"b".repeat(64)}` } });
    expect(JSON.stringify(made)).not.toMatch(/<[a-z-]+>/);
    expect(() => fill({ a: "<missing>" }, {})).toThrow(/no value for <missing>/);
    expect([durationMs("90m"), durationMs("25h"), durationMs("2d"), durationMs("1500ms")]).toEqual([5_400_000, 90_000_000, 172_800_000, 1500]);
    expect(() => durationMs("soon")).toThrow(/not a duration/);
    expect(template, "no key, token or password is in the template").not.toMatch(/PRIVATE KEY|sk-|password/i);
  });
});

describe("the authoring agent's side of the guide", () => {
  it("`mandate mcp` serves the tools the guide names, and none that signs, approves or promotes", async () => {
    const child = spawn(process.execPath, [CLI, "mcp"], { cwd: repo, env: baseEnv(), stdio: ["pipe", "pipe", "ignore"] });
    try {
      const answer = await new Promise<string>((ok, fail) => {
        let out = "";
        child.stdout.on("data", (c: Buffer) => {
          out += c.toString("utf8");
          if (out.includes("\n")) ok(out);
        });
        setTimeout(() => fail(new Error("no answer from mandate mcp")), 60_000).unref();
        const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } })}\n`);
      });
      const names = ((JSON.parse(answer.split("\n")[0]!) as { result: { tools: Array<{ name: string }> } }).result.tools).map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(["mandate.check", "mandate.apply_patch", "mandate.project"]));
      expect(names.filter((n) => /sign|approve|promote|decide/.test(n))).toEqual([]);
    } finally {
      child.kill("SIGKILL");
    }
  }, 90_000);
});

describe("the guide's commands are the commands there are", () => {
  /** Every command the guide shows: the lines of its fenced blocks and the inline code that begins with `node` or `npm`. */
  function commands(): string[] {
    const lines: string[] = [];
    for (const m of README.matchAll(/```(?:sh|powershell)\n([\s\S]*?)```/g)) for (const l of m[1]!.split("\n")) lines.push(l.trim());
    for (const m of README.matchAll(/`((?:node|npm) [^`]+)`/g)) lines.push(m[1]!.trim());
    return lines.filter((l) => l !== "" && !/^(#|\$S |\$C |\$env:|export |read |unset |Remove-Item)/.test(l)).map((l) => l.split("|").pop()!.trim());
  }

  const kitSource = readFileSync(KIT, "utf8");
  const bridgeUsage = readFileSync(join(repo, "bridge", "src", "cli.ts"), "utf8");
  const runtimeUsage = /const USAGE = `([\s\S]*?)`;/.exec(readFileSync(join(repo, "runtime", "src", "cli.ts"), "utf8"))![1]!;
  const scripts = (JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
  const flagsOf = (text: string): string[] => [...text.matchAll(/--[a-z][a-z-]*/g)].map((m) => m[0]);

  /** The flags the kit's header documents for `sub`, and what its code takes. */
  function kitFlags(sub: string): string[] | undefined {
    const line = kitSource.split("\n").filter((l) => new RegExp(`^//\\s+node scripts/live-session\\.mjs ${sub}\\b`).test(l));
    if (line.length === 0) return undefined;
    return [...line.flatMap(flagsOf), "--force"];
  }

  /** The flags the usage texts of the runtime and the bridge give for `command`. */
  function cliFlags(command: string): string[] | undefined {
    const rows = [...runtimeUsage.split("\n").filter((l) => new RegExp(`^  mandate ${command}\\b`).test(l)), ...bridgeUsage.split("\n").filter((l) => new RegExp(`^\\s+"  ${command}\\b`).test(l))];
    return rows.length === 0 ? undefined : [...rows.flatMap(flagsOf), "--config", "--json"];
  }

  it("finds the commands (a guide with none passes nothing)", () => {
    expect(commands().length).toBeGreaterThan(40);
  });

  it("names, in each command, a command and flags that exist", () => {
    const bad: string[] = [];
    for (const line of commands()) {
      const words = line.match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
      const flags = [...line.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((m) => m[1]!);
      if (words[0] === "npm") {
        const script = words[1] === "run" ? words[2] : words[1];
        if (script !== "ci" && !(script && Object.hasOwn(scripts, script))) bad.push(`${line}: npm has no script ${String(script)}`);
        continue;
      }
      if (words[0] !== "node" || words[1]!.startsWith("-")) continue;
      const target = words[1];
      let allowed: string[] | undefined;
      if (target === "scripts/live-session.mjs") allowed = kitFlags(words[2]!);
      else if (target === "bridge/dist/cli.js") allowed = cliFlags(words[2]!);
      else {
        bad.push(`${line}: runs ${String(target)}, which is not the kit or the Node CLI`);
        continue;
      }
      if (!allowed) {
        bad.push(`${line}: there is no command ${String(words[2])}`);
        continue;
      }
      for (const f of flags) if (!allowed.includes(f)) bad.push(`${line}: ${f} is not a flag of ${String(words[2])}`);
    }
    expect(bad).toEqual([]);
    for (const file of ["bridge/dist/cli.js", "scripts/live-session.mjs", PROGRAM, "fixtures/attention/live/invoices.lock.template.json", "fixtures/attention/live/mandate.runtime.template.json"]) expect(existsSync(join(repo, file)), file).toBe(true);
  });

  it("gives PowerShell and a POSIX shell wherever the two differ", () => {
    // Piped answers are the one place the shells differ; each is given in both, next to the other.
    const blocks = [...README.matchAll(/```(sh|powershell)\n([\s\S]*?)```/g)].map((m) => ({ shell: m[1]!, text: m[2]! }));
    const piped = blocks.filter((b) => /\| node /.test(b.text) || /printf/.test(b.text));
    expect(new Set(piped.map((b) => b.shell))).toEqual(new Set(["sh", "powershell"]));
    expect(blocks.filter((b) => b.shell === "powershell" && /\$env:NODE_OPTIONS/.test(b.text)).length).toBeGreaterThan(0);
    expect(README).toContain("export NODE_OPTIONS");
  });
});
