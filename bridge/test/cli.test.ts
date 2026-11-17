// The `mandate` command line (bridge/src/cli.ts) and the compiler's own (`mandate-ts`, compiler/src/cli.ts) give the
// same thing: stdout, stderr and the exit status, byte for byte, over the repository's fixtures. Both run as child
// processes from JavaScript built into a temporary directory (tree.ts), so no dist/ is needed.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTree, repoRoot, type Tree } from "./tree.js";

const R = (p: string): string => join(repoRoot, p).replaceAll("\\", "/");
const work = mkdtempSync(join(tmpdir(), "mdt-bridge-cli-"));
let tree: Tree;

beforeAll(() => {
  tree = buildTree();
  writeFileSync(join(work, "not-json.json"), "{ this is not json");
  writeFileSync(join(work, "empty-patch.json"), JSON.stringify({ base: "sha256:0000", ops: [] }));
  writeFileSync(join(work, "wrong-patch.json"), JSON.stringify({ ops: "none" }));
  writeFileSync(join(work, "denials.json"), JSON.stringify({ format: "made-up", denials: [] }));
  writeFileSync(join(work, "broken.mdt"), "mandate @ 0.5\n\nthis is not a program\n");
}, 60_000);

afterAll(() => {
  tree?.remove();
  rmSync(work, { recursive: true, force: true });
});

interface Run {
  code: number | null;
  out: string;
  err: string;
}

function run(script: string, args: string[], cwd: string): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on("data", (c: Buffer) => out.push(c));
    child.stderr.on("data", (c: Buffer) => err.push(c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }));
  });
}

/** Every file under `dir` with its bytes, for the commands that write a directory. */
function files(dir: string): Record<string, string> {
  const found: Record<string, string> = {};
  const walk = (d: string, rel: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p, rel + name + "/");
      else found[rel + name] = readFileSync(p, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir, "");
  return found;
}

const DOMAIN = R("fixtures/envelope/domain.mdt");
const MIGRATE = R("fixtures/envelope/migrate-all.mdt");
const FIXBUG = R("fixtures/fixbug/fixbug.mdt");
const FIXBUG_IR = R("fixtures/fixbug/fixbug.ir.json");
const FIXBUG_LOCK = R("fixtures/fixbug/mandate.lock.json");
const TARGET = R("fixtures/fixbug-target/fixbug.mdt");
const TARGET_LOCK = R("fixtures/fixbug-target/mandate.lock.json");
const ACME = R("fixtures/system/acme.system.mdt");
const AUDIENCE = R("fixtures/system/audience.mdt");
const INCIDENT = R("fixtures/system/incident.mdt");
const REACH = R("fixtures/boundary/reach.mdt");
const REACH_LOCK = R("fixtures/boundary/reach.lock.json");
const FETCH = R("fixtures/boundary/fetch.mdt");
const SYNTAX = ["capabilities", "decision", "effects", "function", "remote", "supervision", "types"].map((n) => R(`compiler/test/fixtures/syntax/${n}.mdt`));
const w = (name: string): string => join(work, name).replaceAll("\\", "/");

/** The arguments of a case, by the command they exercise. */
const CASES: Record<string, string[][]> = {
  check: [
    [MIGRATE, "--module", DOMAIN],
    [MIGRATE, "--module", DOMAIN, "--json"],
    [MIGRATE],
    [MIGRATE, "--json"],
    [FIXBUG],
    [FIXBUG, "--json"],
    [FIXBUG, "--lock", FIXBUG_LOCK],
    [FIXBUG, "--lock", TARGET_LOCK],
    [FIXBUG, "--lock", w("not-json.json")],
    [FIXBUG, "--lock", w("missing.json")],
    [FIXBUG_IR],
    [AUDIENCE, "--module", ACME],
    [AUDIENCE, "--module", ACME, "--json"],
    [AUDIENCE],
    [INCIDENT, "--module", ACME],
    [REACH, "--lock", REACH_LOCK],
    [REACH],
    [FETCH],
    [w("broken.mdt")],
    [w("broken.mdt"), "--json"],
    [w("missing.mdt")],
    [FIXBUG, "--module", w("broken.mdt")],
    [FIXBUG, "--module", w("missing.mdt"), "--json"],
    [FIXBUG, "--denials", w("denials.json")],
    [FIXBUG, "--denials", w("not-json.json")],
    [FIXBUG, "--lock"],
    [],
    ...SYNTAX.map((f) => [f]),
    ...SYNTAX.slice(0, 3).map((f) => [f, "--json"]),
  ],
  ir: [[FIXBUG], [FIXBUG, "--canonical"], [FIXBUG_IR], [FIXBUG_IR, "--canonical"], [MIGRATE], [w("broken.mdt")], [w("broken.mdt"), "--json"], [w("missing.mdt")], [], ...SYNTAX.slice(0, 3).map((f) => [f])],
  fmt: [[FIXBUG], [FIXBUG_IR], [TARGET], [MIGRATE], [AUDIENCE], [w("broken.mdt")], [w("missing.mdt")], [], ...SYNTAX.slice(0, 3).map((f) => [f])],
  hash: [[FIXBUG], [FIXBUG_IR], [TARGET], [MIGRATE], [AUDIENCE], [w("broken.mdt")], [w("broken.mdt"), "--json"], [w("missing.mdt")], []],
  patch: [
    [FIXBUG, w("empty-patch.json")],
    [FIXBUG, w("empty-patch.json"), "--json"],
    [FIXBUG, w("wrong-patch.json")],
    [FIXBUG, w("not-json.json")],
    [FIXBUG, w("missing.json")],
    [FIXBUG],
    [AUDIENCE, w("empty-patch.json"), "--module", ACME],
    [w("broken.mdt"), w("empty-patch.json")],
    [],
  ],
  sandbox: [
    [FIXBUG],
    [FIXBUG, "--lock", FIXBUG_LOCK],
    [FIXBUG, "--agent", "Implementer"],
    [FIXBUG, "--agent", "NoSuchAgent"],
    [MIGRATE, "--module", DOMAIN],
    [REACH, "--lock", REACH_LOCK],
    [REACH, "--lock", REACH_LOCK, "--json"],
    [AUDIENCE, "--module", ACME],
    [w("broken.mdt")],
    [w("broken.mdt"), "--json"],
    [],
  ],
  view: [
    ...["md", "html", "json"].map((f) => [FIXBUG, "--format", f]),
    ...["md", "html", "json"].map((f) => [MIGRATE, "--module", DOMAIN, "--format", f]),
    [FIXBUG, "--format", "yaml"],
    [FIXBUG, "--format"],
    [AUDIENCE, "--module", ACME],
    [AUDIENCE, "--module", ACME, "--format", "json"],
    [REACH, "--lock", REACH_LOCK],
    [FIXBUG, "--lock", FIXBUG_LOCK],
    ...["md", "html", "json"].map((f) => [MIGRATE, "--module", DOMAIN, "--card", "--format", f]),
    [MIGRATE, "--module", DOMAIN, "--card", "--workflow", "MigrateAll"],
    [MIGRATE, "--module", DOMAIN, "--card", "--workflow", "NoSuchWorkflow"],
    [FIXBUG, "--card"],
    [REACH, "--lock", REACH_LOCK, "--card"],
    [FIXBUG, "--card", "--against", TARGET],
    ...["md", "html", "json"].map((f) => [FIXBUG, "--against", TARGET, "--format", f]),
    [TARGET, "--against", FIXBUG, "--against-lock", FIXBUG_LOCK],
    [FIXBUG, "--against", FIXBUG],
    [FIXBUG, "--against", w("broken.mdt")],
    [FIXBUG, "--against", w("missing.mdt")],
    [w("broken.mdt")],
    [],
  ],
  explain: [["E0130"], ["MDT-E0130"], ["E0320", "--json"], ["W0311"], ["E9999"], ["MDT-E9999", "--json"], []],
  target: [
    ["acs", FIXBUG, "--out", "acs-a"],
    ["acs", FIXBUG, "--out", "acs-b", "--json"],
    ["acs", FIXBUG, "--out", "acs-c", "--lock", FIXBUG_LOCK],
    ["acs", MIGRATE, "--module", DOMAIN, "--out", "acs-d"],
    ["acs", REACH, "--lock", REACH_LOCK, "--out", "acs-e"],
    ["acs", FIXBUG],
    ["acs", w("broken.mdt")],
    ["acs"],
    ["other", FIXBUG],
    [],
  ],
  other: [[], ["frobnicate"], ["--json"], ["--module"], ["check", "--module"], ["help"], ["--help"]],
};

/** The same message with the one place a path differs between the two trees (the runtime's address, in the hand-off's failure). */
const comparable = (s: string, dir: string): string => s.replaceAll(dir.replaceAll("\\", "/"), "<tree>").replaceAll(dir, "<tree>");

/**
 * The bridge's usage text as it was before the libraries of 0.6: the compiler's own command line is frozen at 0.5,
 * and has neither `add`, `upgrade` and `publish` nor `--libraries` and `--config`. Nothing else is taken out: every
 * other line of the two usage texts is compared as it is (cli-library.test.ts holds the lines of 0.6).
 */
const LINES_06 = [
  "  add <library>[@<range>] [--lock <lock.json>] [--libraries <dir>] [--config <file>] [--json]\n",
  "  upgrade <library>[@<range>] [--lock <lock.json>] [--libraries <dir>] [--config <file>] [--accept-governance] [--json]\n",
  "  publish <source dir> [--libraries <dir>] [--config <file>] [--json]\n",
  // The control commands of 0.6, which the runtime answers: the compiler's own command line hands on none.
  "  connector pin <program> [--lock FILE] [--module FILE]… [--libraries DIR] [--config FILE]\n",
  "  review <run> --revision N --key FILE [--member NAME] [--waive I,J] [--decline K]\n",
  // The driver loop of 0.7, which the runtime answers too.
  "  tick [--follow] [--interval 10s] [--no-notify]\n",
];
function before06(s: string): string {
  if (!s.startsWith("usage: mandate <command> [options]\n")) return s;
  let out = s;
  for (const line of LINES_06) out = out.replace(line, "");
  return out
    .split("\n")
    .map((line) => (/^  (check|view|sandbox|target acs|approve-envelope|test) </.test(line) ? line.replace(/ \[--libraries <dir>\]( \[--config <file>\])?$/, "") : line))
    .join("\n");
}

/** The exit status of every invocation compared, by command. */
const seen: Record<string, Array<number | null>> = {};

describe("the mandate command line equals the compiler's own", () => {
  for (const [command, cases] of Object.entries(CASES)) {
    it(`${command}: ${cases.length} invocations give the same stdout, stderr and exit status`, async () => {
      const runs: Array<number | null> = (seen[command] = []);
      // Four at a time keeps the number of live processes small.
      for (let i = 0; i < cases.length; i += 4) {
        await Promise.all(
          cases.slice(i, i + 4).map(async (rest, j) => {
            const args = command === "other" || command === "control" ? rest : [command, ...rest];
            const id = `${i + j}`;
            const a = join(work, `ts-${command}-${id}`);
            const b = join(work, `br-${command}-${id}`);
            mkdirSync(a, { recursive: true });
            mkdirSync(b, { recursive: true });
            const [ts, br] = await Promise.all([run(tree.compilerCli, args, a), run(tree.bridgeCli, args, b)]);
            const label = `mandate ${args.join(" ").replaceAll(repoRoot.replaceAll("\\", "/"), "")}`;
            expect({ label, code: br.code }).toEqual({ label, code: ts.code });
            expect({ label, out: before06(comparable(br.out, tree.dir)) }).toEqual({ label, out: comparable(ts.out, tree.dir) });
            expect({ label, err: before06(comparable(br.err, tree.dir)) }).toEqual({ label, err: comparable(ts.err, tree.dir) });
            expect({ label, written: files(b) }).toEqual({ label, written: files(a) });
            runs.push(ts.code);
          }),
        );
      }
      expect(runs).toHaveLength(cases.length);
    }, 120_000);
  }

  it("covers programs that check and programs that do not, and every exit status the command line has", () => {
    const all = Object.values(seen).flat();
    expect([...new Set(all)].sort()).toEqual([0, 1, 2]);
    for (const command of ["check", "view", "sandbox", "patch"]) expect(new Set(seen[command]).size, command).toBeGreaterThan(1);
  });

  it("keeps the control list on one line, as runtime/test/cli.test.ts reads it", () => {
    const text = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(text).toMatch(/^const CONTROL = new Set\(\[[^\]]*\]\);$/m);
    // The compiler's own, frozen at 0.5, and after it the control commands of 0.6, `connector` (pin) and `review`, and
    // of 0.7, `tick`.
    expect(text.match(/^const CONTROL = new Set\((\[[^\]]*\])\);$/m)![1]).toBe(
      readFileSync(new URL("../../compiler/src/cli.ts", import.meta.url), "utf8").match(/^const CONTROL = new Set\((\[[^\]]*\])\);$/m)![1]!.replace(/\]$/, ', "connector", "review", "tick"]'),
    );
  });

  // Language 0.6, which the compiler's own command line does not read: `mandate view` gives the views the modules it
  // has, so that a workflow that applies a pattern of one of them is shown as its expansion (its commit, its review,
  // and its cost, 60 delegations of the map's bound at 0.30 USD).
  it("gives the views of a program of 0.6 its modules", async () => {
    const modules = ["fixtures/library/acme.connectors/types.mdt", "fixtures/library/acme.connectors/connectors.mdt", "fixtures/library/batch.patterns.mdt"].flatMap((m) => ["--module", R(m)]);
    const dir = join(work, "view-0.6");
    mkdirSync(dir, { recursive: true });
    const r = await run(tree.bridgeCli, ["view", R("fixtures/library/batch.mdt"), ...modules, "--format", "json"], dir);
    expect(r.code, r.err).toBe(0);
    const v = JSON.parse(r.out) as {
      authority: { rows: Array<{ who: string; effects: string[] }> };
      architecture: { workflows: Array<{ nodes: Array<{ label: string }> }> };
      cost: { workflows: Array<{ rows: Array<{ times: number }>; total: string }> };
    };
    expect(v.authority.rows.find((x) => x.who === "MatchInvoices")?.effects.map((e) => e.split(" (")[0])).toEqual(["erp.post_draft_invoice"]);
    expect(v.architecture.workflows[0]!.nodes.map((n) => n.label)).toContain("person: review");
    expect(v.cost.workflows[0]!.rows[0]!.times).toBe(60);
    expect(v.cost.workflows[0]!.total).toBe("18 USD · 3600000 tokens · 240 steps");
  }, 60_000);

  it("hands the control commands over by the same dynamic import of the runtime's command line, which the bridge does not depend on", () => {
    const text = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    expect(text).toContain('const specifier: string = "@mandate/runtime/cli";');
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) expect(Object.keys(pkg[field] ?? {})).not.toContain("@mandate/runtime");
  });
});

