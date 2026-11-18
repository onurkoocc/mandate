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
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { assertLocalOnly, durationMs, fill, isLoopbackAddress, LIVE, lockFrom, placeholders, simulatedMatch, startWorld } from "../../scripts/lib/live-world.mjs";
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
      const said = await world.ready;
      // What `up` prints for the shell is what the guide has the person paste: the session's directory and the preload.
      const options = /export NODE_OPTIONS='(--import=[^']+)'/.exec(said)?.[1];
      expect(options, said).toBeTruthy();
      expect(said).toContain(dir.replaceAll("\\", "/"));
      expect(said).not.toMatch(/PRIVATE KEY/);
      const S = dir.replaceAll("\\", "/");
      const C = `${S}/mandate.runtime.json`;
      const env = baseEnv({ NODE_OPTIONS: options! });
      const mandate = (args: string[], input?: string[]): Promise<Said> => run([CLI, ...args, ...(args.includes("--config") ? [] : ["--config", C])], { env, ...(input ? { input } : {}) });
      const kit = (args: string[]): Promise<Said> => run([KIT, ...args], { env });
      const ok = (s: Said, what: string): Said => {
        expect(s.code, `${what}\n${s.out}\n${s.err}`).toBe(0);
        return s;
      };
      const ana = `${S}/people/ana/ana.key`;
      const ben = `${S}/people/ben/ben.key`;
      const lock = `${S}/invoices.lock.json`;
      const answers = ["1", "waive 2 decline 5", "y"];
      const run3 = (id: string, mode: string): Promise<Said> => mandate(["run", PROGRAM, "--workflow", "MatchInvoices", "--input", "{}", "--run-id", id, "--lock", lock, "--mode", mode]);
      const drafts = async (): Promise<string[]> => {
        const said = ok(await kit(["drafts", "--session", S]), "drafts");
        return [...said.out.matchAll(/^D-(\S+)/gm)].map((m) => m[1]!);
      };

      expect(ok(await kit(["status", "--session", S]), "status").out).toMatch(/model\s+simulated/);
      expect(ok(await kit(["orders", "--session", S]), "orders").out).toContain(`${LIVE.orderNo(0)}`);
      expect(ok(await kit(["inbox", "--session", S]), "inbox").out).toContain(`${LIVE.invoiceNo(7)}`);

      // Step 3: two people, the lock from its template, the tool digests through the real proxy.
      for (const key of [ana, ben]) ok(await mandate(["key", "new", "--out", key]), "key new");
      ok(await kit(["lock", "--session", S, "--accountant", `ana=${ana}`, "--finance-lead", `ben=${ben}`]), "lock");
      const pinned = ok(await mandate(["connector", "pin", PROGRAM, "--lock", lock]), "connector pin");
      expect(pinned.out.match(/-> sha256:/g)).toHaveLength(5);
      const made = JSON.parse(readFileSync(lock, "utf8")) as { connectors: Record<string, { tools: Record<string, string> }>; members: Record<string, unknown>; roles: Record<string, string[]> };
      expect(Object.keys(made.connectors["acme.connectors.erp"]!.tools).sort()).toEqual(["delete_draft_invoice", "find_draft_invoice", "list_open_orders", "post_draft_invoice"]);
      expect(Object.keys(made.members).sort()).toEqual(["ana", "ben"]);
      expect(made.roles).toMatchObject({ accountant: ["ana"], finance_lead: ["ben"] });

      // Step 4 and 5: the card, and no run before the accountant approves it.
      expect(ok(await mandate(["view", PROGRAM, "--card", "--workflow", "MatchInvoices", "--lock", lock]), "card").out).toContain("When it asks whom");
      const before = await run3("u0", "design");
      expect(before.code, before.err).toBe(1);
      expect(before.err).toContain("unapproved_envelope");
      const byBen = await mandate(["approve-envelope", PROGRAM, "--key", ben, "--lock", lock]);
      expect(byBen.code, byBen.err).toBe(1);
      expect(byBen.err).toContain("not_in_role");
      ok(await mandate(["approve-envelope", PROGRAM, "--key", ana, "--lock", lock]), "approve-envelope");

      // Step 6: the design run, with the simulated Matcher, asks ana about the two items that may be waived.
      const d1 = ok(await run3("d1", "design"), "design run");
      expect(d1.out).toContain("run d1  MatchInvoices  waiting");
      const waits = ok(await mandate(["waits", "--member", "ana"]), "waits").out;
      for (const i of LIVE.TOTALS) expect(waits).toContain(LIVE.invoiceNo(i));
      expect(waits, "the invoice of another vendor is declined without asking").not.toContain(LIVE.invoiceNo(LIVE.VENDOR[0]!));
      expect(ok(await mandate(["decide", "--key", ana], answers), "decide d1").out).toContain("run d1 is now succeeded");
      expect(await drafts(), "a design run writes nothing").toEqual([]);

      // Step 7 and 8: a promotion is the owner's; read_only writes nothing; the shadow diff shows the six posts.
      const promotedByBen = await mandate(["promote", "d1", "--to", "read_only", "--key", ben, "--yes"]);
      expect(promotedByBen.code).toBe(1);
      expect(promotedByBen.err).toContain("not_in_role");
      ok(await mandate(["promote", "d1", "--to", "read_only", "--key", ana, "--yes"]), "promote read_only");
      expect(ok(await run3("r1", "read_only"), "read_only run").out).toContain("waiting");
      expect(ok(await mandate(["decide", "--key", ana], answers), "decide r1").out).toContain("run r1 is now succeeded");
      expect(await drafts(), "a read_only run writes nothing").toEqual([]);
      const diff = ok(await mandate(["shadow-diff", "d1", "r1"]), "shadow-diff").out;
      expect(diff.match(/erp\.post_draft_invoice\tonly_b/g)).toHaveLength(LIVE.PASSED.length + 1);
      const toLive = ok(await mandate(["promote", "r1", "--to", "live", "--key", ana, "--yes"]), "promote live");
      expect(toLive.out).toContain(`erp.post_draft_invoice: ${LIVE.PASSED.length + 1} would apply`);

      // Step 9: the live run, its notifications and pages, the decision, the drafts in the fake ERP.
      expect(ok(await run3("l1", "live"), "live run").out).toContain("run l1  MatchInvoices  waiting");
      expect(ok(await mandate(["tick"]), "tick").out).toMatch(/notifications: [1-9]\d* sent/);
      expect(ok(await mandate(["waits", "--member", "ana"]), "waits l1").out).toContain("run l1  MatchInvoices");
      ok(await mandate(["watch", "--member", "ana", "--out", `${S}/pages`]), "watch pages");
      expect(readFileSync(join(dir, "pages", "l1.accountant.html"), "utf8")).toContain(LIVE.invoiceNo(LIVE.TOTALS[0]!));
      expect(ok(await mandate(["decide", "--key", ana], answers), "decide l1").out).toContain("run l1 is now succeeded");
      const expected = [...LIVE.PASSED, LIVE.TOTALS[0]!].map((i) => LIVE.invoiceNo(i)).sort();
      expect((await drafts()).sort()).toEqual(expected);
      // The accountant is shown events of classes S0 to S2 and no other.
      const events = parseJson(ok(await mandate(["watch", "l1", "--role", "accountant", "--jsonl"]), "watch role").out) as Array<{ class: string }>;
      expect(events.length).toBeGreaterThan(5);
      expect(new Set(events.map((e) => e.class))).toEqual(new Set(["S0", "S1", "S2"].filter((c) => events.some((e) => e.class === c))));
      const sink = readFileSync(join(dir, "notifications.jsonl"), "utf8");
      expect(parseJson(sink).map((n) => (n as { event: string }).event)).toContain("review_requested");

      // Step 10: a deadline is moved, not waited for. The first passes: the question goes to ben. The second: declined.
      ok(await run3("l2", "live"), "second live run");
      expect(ok(await kit(["advance", "25h", "--session", S]), "advance").out).toContain("+ 25.00 h");
      expect(ok(await mandate(["tick"]), "tick escalates").out).toContain("run l2: waiting -> waiting");
      expect(ok(await mandate(["waits", "--member", "ben"]), "waits ben").out).toContain("run l2  MatchInvoices");
      expect(ok(await kit(["advance", "25h", "--session", S]), "advance again").out).toContain("+ 50.00 h");
      expect(ok(await mandate(["tick"]), "tick expires").out).toContain("run l2: waiting -> succeeded");
      expect(ok(await mandate(["status", "l2"]), "status l2").out).toMatch(/"by":null/);
      expect((await drafts()).sort(), "a run does not post an invoice twice").toEqual(expected);

      // What the fakes saw: every request came through the proxy with its credential, and none was refused.
      const seen = world.output();
      expect(seen).toMatch(/mailbox\s+list_invoices/);
      expect(seen).toMatch(/ERP\s+post_draft_invoice \(posted a draft\)/);
      expect(seen).not.toContain("refused a request");

      // Nothing secret was printed or written: the private keys are in the session directory and nowhere else.
      const inKey = (f: string): string[] => readFileSync(f, "utf8").split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"));
      const body = [...inKey(ana), ...inKey(ben)];
      expect(body.length).toBeGreaterThan(0);
      for (const line of body) for (const text of [...printed, seen]) expect(text).not.toContain(line);
      const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []));
      for (const f of files(dir)) {
        // The persons' keys are theirs (people/), and the runtime's own evidence key is its state (.mandate/): both stay in the directory.
        if (relative(dir, f).startsWith("people") || relative(dir, f).startsWith(".mandate") || statSync(f).size > 5_000_000) continue;
        expect(readFileSync(f, "latin1"), f).not.toMatch(/PRIVATE KEY|Bearer [0-9a-f]{20,}|(?<![0-9a-f:])[0-9a-f]{48}(?![0-9a-f])/);
      }
      expect(relative(repo, dir).startsWith(".."), "the session lives outside the repository").toBe(true);

      // The world's control port answers the kit's own commands only: a request without their header (a page in a
      // browser cannot send it) is refused, and cannot stop the world.
      const { control } = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as { control: number };
      expect((await fetch(`http://127.0.0.1:${control}/stop`, { method: "POST" })).status).toBe(403);
      expect(ok(await kit(["status", "--session", S]), "status").out).toMatch(/world +running/);

      // Step 11: stop and clean up.
      expect(ok(await kit(["down", "--session", S]), "down").out).toContain("down");
      expect((await world.exit).code).toBe(0);
      expect(ok(await kit(["status", "--session", S]), "status after down").out).toContain("not running");
      expect(ok(await kit(["clean", "--session", S]), "clean").out).toContain("removed");
      expect(existsSync(dir)).toBe(false);
    },
    280_000,
  );
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
