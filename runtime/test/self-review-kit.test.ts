// The self-review kit (fixtures/self-review/README.md, scripts/self-review.mjs): Mandate reviews its own repository,
// held to what its guide says. The guide runs end to end with the simulated Reviewer, command by command, as separate
// processes: the world (`node scripts/self-review.mjs up`) in one, and every command of the maintainer in a process of
// its own, with the lines `up` prints for the shell (NODE_OPTIONS), through the Node CLI the guide names
// (bridge/dist/cli.js) and the REAL path to the report connector: the runtime's `connect`, its adapters and the egress
// proxy, which puts the connector's credential into each request. No model key is used or present: the children's
// environment has none. The tests need the build (`npm run build`), which CI makes before them.
//
// No secret is made by hand: the maintainer's key is made at run time by `mandate key new`, and the connector's
// credential is random, made by the kit when it starts, and held in memory.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { placeholders } from "../../scripts/lib/live-world.mjs";
import { cleanReviewSession, commitOf, COMPONENTS, findingKey, readSnapshotMarker, reportState, reviewLockFrom, SIMULATED, simulatedReview, snapshotGrant, writeSnapshot, type Component, type Finding } from "../../scripts/lib/self-review-world.mjs";

const repo = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const CLI = join(repo, "bridge", "dist", "cli.js");
const KIT = join(repo, "scripts", "self-review.mjs");
const PROGRAM = "fixtures/self-review/self-review.mdt";
const README = readFileSync(join(repo, "fixtures", "self-review", "README.md"), "utf8");
const MODEL_KEYS = ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_WORKSPACE_ID"];
const TIMEOUT = 150_000;

const scratch = mkdtempSync(join(tmpdir(), "mandate-self-review-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Said {
  code: number | null;
  out: string;
  err: string;
}

/** The environment of the maintainer's terminal: this one, with no model key in it. */
function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_NO_WARNINGS: "1" };
  for (const k of MODEL_KEYS) delete env[k];
  return { ...env, ...extra };
}

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
  void exit.then(() => void printed.push(out, err));
  return { ready, exit, output: () => out, stop: () => void child.kill("SIGTERM") };
}

const lines = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((l) => l !== "");

describe("the self-review kit, as its guide runs it with the simulated Reviewer", () => {
  it(
    "checks, shows the card, is approved, runs design, read_only and live, appends the accepted findings once, and replays",
    async () => {
      const dir = join(scratch, "session");
      const world = up(["--dir", dir], baseEnv());
      try {
        const said = await world.ready;
        const options = /export NODE_OPTIONS='(--import=[^']+)'/.exec(said)?.[1];
        expect(options, said).toBeTruthy();
        expect(said).toContain("simulated (no key needed");
        expect(said).toContain("step 2 of the guide");
        const S = dir.replaceAll("\\", "/");
        const C = `${S}/mandate.runtime.json`;
        const env = baseEnv({ NODE_OPTIONS: options! });
        const mandate = (args: string[], input?: string[]): Promise<Said> => run([CLI, ...args, "--config", C], { env, ...(input ? { input } : {}) });
        const kit = (args: string[]): Promise<Said> => run([KIT, ...args, "--session", S], { env });
        const ok = (s: Said, what: string): Said => {
          expect(s.code, `${what}\n${s.out}\n${s.err}`).toBe(0);
          return s;
        };
        const key = `${S}/people/maintainer/maintainer.key`;
        const lock = `${S}/self-review.lock.json`;
        const answers = ["1", "waive 1", "y"];
        const runAs = (id: string, mode: string, more: string[] = []): Promise<Said> => mandate(["run", PROGRAM, "--workflow", "ReviewRepository", "--input", "{}", "--run-id", id, "--lock", lock, "--mode", mode, ...more]);
        const report = join(dir, "report.md");
        const entries = (): number => (existsSync(join(dir, "report.jsonl")) ? lines(join(dir, "report.jsonl")).length : 0);

        // Step 2 and 3: the world, the components, the maintainer, the lock and the connector's digests.
        expect(ok(await kit(["status"]), "status").out).toMatch(/model\s+simulated/);
        const listed = ok(await kit(["components"]), "components").out;
        for (const c of COMPONENTS) for (const p of c.paths) expect(listed).toContain(p);
        ok(await mandate(["key", "new", "--out", key]), "key new");
        ok(await kit(["lock", "--maintainer", `maintainer=${key}`]), "lock");
        const pinned = ok(await mandate(["connector", "pin", PROGRAM, "--lock", lock]), "connector pin");
        expect(pinned.out.match(/-> sha256:/g)).toHaveLength(3);
        expect(ok(await mandate(["check", PROGRAM, "--lock", lock]), "check").out).toMatch(/^ok sha256:/m);

        // Step 4: the card shows the 20 USD limit and the static bound under it.
        const card = ok(await mandate(["view", PROGRAM, "--card", "--workflow", "ReviewRepository", "--lock", lock]), "card").out;
        expect(card).toContain("4 × 1.20 USD = 4.80 USD ≤ 20 USD");
        expect(card).toMatch(/\| spend \(USD\) \| 20 USD \| 4\.8 USD \|/);
        expect(card).toContain("| Read paths | /mandate-self-review/snapshot |");
        expect(card).toContain("At most 2 questions");

        // Step 5: no run before the maintainer approves the card.
        const before = await runAs("u0", "design");
        expect(before.code, before.err).toBe(1);
        expect(before.err).toContain("unapproved_envelope");
        ok(await mandate(["approve-envelope", PROGRAM, "--key", key, "--lock", lock]), "approve-envelope");

        // Step 6: the design run asks about the one finding that may be waived; the one off the end of its file is declined unasked.
        expect(ok(await runAs("d1", "design"), "design run").out).toContain("run d1  ReviewRepository  waiting");
        const waits = ok(await mandate(["waits", "--member", "maintainer"]), "waits").out;
        const unsure = Object.keys(SIMULATED).find((t) => SIMULATED[t] === "unsure")!;
        const off = Object.keys(SIMULATED).find((t) => SIMULATED[t] === "off_the_end")!;
        expect(waits).toContain(`"task":"${unsure}"`);
        expect(waits, "the finding past the end of its file is not asked about").not.toContain(`"task":"${off}"`);
        expect(ok(await mandate(["decide", "--key", key], answers), "decide d1").out).toContain("run d1 is now succeeded");
        expect(entries(), "a design run appends nothing").toBe(0);

        // Step 7: read_only appends nothing; the shadow diff shows the three appends; promote to live.
        ok(await mandate(["promote", "d1", "--to", "read_only", "--key", key, "--yes"]), "promote read_only");
        expect(ok(await runAs("r1", "read_only"), "read_only run").out).toContain("waiting");
        expect(ok(await mandate(["decide", "--key", key], answers), "decide r1").out).toContain("run r1 is now succeeded");
        expect(entries(), "a read_only run appends nothing").toBe(0);
        expect(ok(await mandate(["shadow-diff", "d1", "r1"]), "shadow-diff").out.match(/report\.append_finding\tonly_b/g)).toHaveLength(3);
        expect(ok(await mandate(["promote", "r1", "--to", "live", "--key", key, "--yes"]), "promote live").out).toContain("report.append_finding: 3 would apply");

        // Step 8: the live run; the decision; three entries in the report, the waived one among them.
        expect(ok(await runAs("l1", "live"), "live run").out).toContain("run l1  ReviewRepository  waiting");
        expect(ok(await mandate(["tick"]), "tick").out).toMatch(/notifications: [1-9]\d* sent/);
        ok(await mandate(["watch", "--member", "maintainer", "--out", `${S}/pages`]), "watch pages");
        expect(readFileSync(join(dir, "pages", "l1.maintainer.html"), "utf8")).toContain(unsure);
        expect(ok(await mandate(["decide", "--key", key], answers), "decide l1").out).toContain("run l1 is now succeeded");
        expect(entries()).toBe(3);
        const md = readFileSync(report, "utf8");
        for (const t of Object.keys(SIMULATED)) {
          if (t === off) expect(md, "the declined finding is not in the report").not.toContain(`component: ${t}`);
          else expect(md).toContain(`component: ${t}`);
        }
        expect(md.match(/^## R-\d+ /gm)).toHaveLength(3);
        const shown = ok(await kit(["report"]), "report").out;
        expect(shown).toContain(`3 entries in the report`);
        expect(shown).toMatch(/R-2\s+agent-tools\s+runtime\/src\/tools\.ts:3\s+low\s+medium/);

        // Step 9: the asks bound.
        expect(ok(await mandate(["status", "l1"]), "status l1").out).toMatch(/budget asks: limit 2/);
        const tooFew = await runAs("x1", "design", ["--limit", "asks=1"]);
        expect(tooFew.code, tooFew.out).toBe(1);
        expect(tooFew.err).toContain("attention_above_asks");

        // Step 10: replay. Design and live replay to the result the run gave; read_only is partial.
        for (const id of ["d1", "l1"]) {
          const status = ok(await mandate(["status", id]), `status ${id}`).out;
          const replayed = ok(await mandate(["replay", id]), `replay ${id}`).out;
          expect(replayed, id).toContain("replay: complete");
          const result = /^result:\s*(.*)$/m.exec(status)?.[1];
          expect(result, `status ${id} prints a result\n${status}`).toBeTruthy();
          expect(replayed, `the replay of ${id} gives the result the run gave`).toContain(result!);
        }
        expect(ok(await mandate(["replay", "r1"]), "replay r1").out).toMatch(/replay: partial/);

        // Step 11: a second live run sends the same findings under new keys; the report appends nothing.
        expect(ok(await runAs("l2", "live"), "second live run").out).toContain("waiting");
        expect(ok(await mandate(["decide", "--key", key], answers), "decide l2").out).toContain("run l2 is now succeeded");
        expect(entries(), "the same findings are not appended twice").toBe(3);
        expect(ok(await kit(["report"]), "report again").out).toContain("3 findings were sent again by a later run and appended nothing");
        expect(README).toContain("appends nothing the second time");

        // What the connector saw: every request through the proxy with its credential, none refused.
        const seen = world.output();
        expect(seen).toMatch(/report\s+list_components \(4 components\)/);
        expect(seen).toMatch(/report\s+append_finding \(appended R-1/);
        expect(seen).toContain("the same finding is already in the report");
        expect(seen).not.toContain("refused a request");

        // The snapshot holds the components' committed files and nothing else.
        const snapshot = join(dir, "snapshot");
        const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : e.isFile() ? [join(d, e.name)] : []));
        const inSnapshot = files(snapshot).map((f) => relative(snapshot, f).replaceAll("\\", "/")).sort();
        expect(inSnapshot).toEqual([".mandate-self-review-snapshot", ...COMPONENTS.flatMap((c) => c.paths)].sort());

        // Nothing secret was printed or written.
        const body = readFileSync(key, "utf8").split("\n").filter((l) => l.length > 20 && !l.startsWith("-----"));
        expect(body.length).toBeGreaterThan(0);
        for (const line of body) for (const text of [...printed, seen]) expect(text).not.toContain(line);
        let scanned = 0;
        for (const f of files(dir)) {
          if (relative(dir, f).startsWith("people") || relative(dir, f).startsWith(".mandate") || statSync(f).size > 5_000_000) continue;
          expect(readFileSync(f, "latin1"), f).not.toMatch(/PRIVATE KEY|Bearer [0-9a-f]{20,}|(?<![0-9a-f:])[0-9a-f]{48}(?![0-9a-f])/);
          scanned++;
        }
        expect(scanned, "the scan read the session's files").toBeGreaterThanOrEqual(10);
        expect(relative(repo, dir).startsWith(".."), "the session lives outside the repository").toBe(true);

        // Step 12: stop and clean up.
        expect(ok(await kit(["down"]), "down").out).toContain("the world is down");
        expect((await world.exit).code).toBe(0);
        const cleaned = ok(await kit(["clean"]), "clean").out;
        expect(cleaned).toContain("removed the snapshot");
        expect(existsSync(dir)).toBe(false);
        const afterClean = await run([CLI, "status", "nothing"], { env });
        expect(afterClean.err.match(/self-review preload: not applied/g), "one line of warning").toHaveLength(1);
      } finally {
        world.stop();
        await Promise.race([world.exit, new Promise((r) => setTimeout(r, 20_000))]);
      }
    },
    280_000,
  );
});

describe("the self-review kit's pieces", () => {
  const components = (): Component[] => COMPONENTS.map((c) => ({ task: c.task, title: c.title, focus: c.focus, files: c.paths.map((p) => ({ path: p, lines: 10 })) }));

  it("takes the snapshot path from the program's one read grant, a path that names no person", () => {
    const program = readFileSync(join(repo, PROGRAM), "utf8");
    expect(snapshotGrant(program)).toBe("/mandate-self-review/snapshot");
    expect(() => snapshotGrant(`${program}\ncapability More = fs.read("/elsewhere")`)).toThrow(/exactly one/);
    expect(() => snapshotGrant('capability S = fs.read("C:/Users/x")')).toThrow(/not a plain absolute path/);
  });

  it("makes the snapshot from the commit only, and refuses a directory that is not its own or is in a work tree", () => {
    const commit = commitOf(repo);
    const target = join(scratch, "snap", "snapshot");
    const made = writeSnapshot(repo, target, commit, "a".repeat(32));
    expect(made.map((c) => c.task)).toEqual(COMPONENTS.map((c) => c.task));
    for (const c of made) for (const f of c.files) expect(f.lines, f.path).toBe(readFileSync(join(target, ...f.path.split("/")), "utf8").split("\n").length - 1);
    expect(readSnapshotMarker(target)).toMatchObject({ session: "a".repeat(32), commit });
    expect(() => writeSnapshot(repo, target, commit, "b".repeat(32)), "another session's snapshot").toThrow(/another self-review session/);
    expect(() => writeSnapshot(repo, join(repo, "x-snapshot"), commit, "a".repeat(32))).toThrow(/inside a git work tree/);
    expect(() => writeSnapshot(repo, join(scratch, "snap2"), commit, "a".repeat(32), [{ task: "t", title: "t", focus: "f", paths: [".env"] }])).toThrow(/not a path the snapshot takes/);
    expect(() => writeSnapshot(repo, join(scratch, "snap3"), commit, "a".repeat(32), [{ task: "t", title: "t", focus: "f", paths: ["runtime/../.env"] }])).toThrow(/not a path the snapshot takes/);
    const full = join(scratch, "full");
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, "x"), "x");
    expect(() => writeSnapshot(repo, full, commit, "a".repeat(32))).toThrow(/not empty and is not a snapshot/);
  });

  it("appends a finding once: a retry of its key, and the same finding under another key, append nothing", () => {
    const dir = join(scratch, "report");
    mkdirSync(dir, { recursive: true });
    const state = reportState({ dir, components: components(), commit: "c0" });
    const append = state.tools.find((t) => t.name === "append_finding")!;
    const f: Finding = { task: "agent-tools", file: { path: "runtime/src/tools.ts", lines: 10 }, line: 3, title: "A title\nwith a break", what: "what", evidence: "evidence ```end``` of block", severity: "low", confidence: "high" };
    expect(append.run({ f, key: "k1" })).toMatchObject({ structured: { entry_id: "R-1" } });
    expect(append.run({ f, key: "k1" })).toMatchObject({ structured: { entry_id: "R-1" } });
    expect(append.run({ f, key: "k2" })).toMatchObject({ structured: { entry_id: "R-1" } });
    expect(append.run({ f: { ...f, line: 4 }, key: "k3" })).toMatchObject({ structured: { entry_id: "R-2" } });
    expect(state.counts).toEqual({ appended: 2, retried: 1, same_finding: 1 });
    expect(lines(join(dir, "report.jsonl"))).toHaveLength(2);
    const md = readFileSync(join(dir, "report.md"), "utf8");
    expect(md).toContain("## R-1  A title with a break");
    expect(md.match(/^```/gm), "the model's text cannot end the evidence block").toHaveLength(4);
    // The report survives a restart of the world: the state is read back from report.jsonl.
    const again = reportState({ dir, components: components(), commit: "c0" });
    expect(again.tools.find((t) => t.name === "append_finding")!.run({ f, key: "k9" })).toMatchObject({ structured: { entry_id: "R-1" } });
    expect(findingKey(f)).toBe("agent-tools|runtime/src/tools.ts|3");
    expect(append.run({ f: { task: "x" }, key: "k4" })).toMatchObject({ error: expect.any(String) });
  });

  it("simulates the Reviewer as SIMULATED says, quoting the snapshot's line", () => {
    const snap = join(scratch, "snap", "snapshot");
    const cs = writeSnapshot(repo, snap, commitOf(repo), "a".repeat(32));
    for (const c of cs) {
      const r = simulatedReview([{ untrusted: c }], snap);
      const f = r.ok!;
      expect(f.task).toBe(c.task);
      expect(f.line > f.file.lines).toBe(SIMULATED[c.task] === "off_the_end");
      expect(f.confidence).toBe(SIMULATED[c.task] === "unsure" ? "medium" : "high");
      expect(f.evidence.length).toBeGreaterThanOrEqual(20);
    }
    expect(simulatedReview([{ task: "nope", files: [] }], snap).error).toBeTruthy();
  });

  it("fills the lock from its template with the maintainer only, and points nothing at a real system", () => {
    const text = readFileSync(join(repo, "fixtures", "self-review", "self-review.lock.template.json"), "utf8");
    expect(placeholders(text).sort()).toEqual(["maintainer-key", "maintainer-member"]);
    const lock = reviewLockFrom(JSON.parse(text), { member: "m", keyId: "sha256:00" }) as { roles: Record<string, string[]>; connectors: Record<string, { url: string }>; models: Record<string, { model: string }> };
    expect(lock.roles).toEqual({ maintainer: ["m"], deputy: ["m"] });
    expect(lock.connectors["local.review.report"]!.url).toBe("https://review.self.example/mcp");
    expect(lock.models["standard"]!.model).toBe("claude-opus-5-5");
  });

  it("cleans only a session directory of its own, with the snapshot it made", () => {
    expect(() => cleanReviewSession(join(scratch, "report"))).toThrow(/not a live session's directory/);
  });
});
