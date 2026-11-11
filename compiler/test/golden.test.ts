// What the compiler says about every program written before 0.4 is pinned
// here, by digest: a 0.1 to 0.3 program reads, checks, hashes, prints and
// shows exactly as it did. A later version adds to the language; it does not
// change what an earlier program means.
//
// The digests are in golden/outputs.json. A change to one of them is a change
// to an earlier version's behavior and needs a reason in the commit that
// makes it. To write the file again: MANDATE_UPDATE_GOLDEN=1 npm test.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { check, kindOf, load, loadModules } from "../src/check.js";
import { canonicalize } from "../src/json/jcs.js";
import { parseStrictJson, type Json } from "../src/json/strict-json.js";
import type { Lock } from "../src/lock.js";
import type { Modules } from "../src/modules.js";
import { printProgram } from "../src/print/printer.js";
import { sandboxRequirements } from "../src/target/sandbox.js";
import { toHtml, toMarkdown } from "../src/views/doc.js";
import { architecture, authority, cost, programDoc, semanticDiff } from "../src/views/views.js";
import { readRepo, repoRoot, syntaxFixtures } from "./helpers.js";

const GOLDEN = `${repoRoot}compiler/test/golden/outputs.json`;

/** Every program in the repository written in 0.1 to 0.3. */
const PROGRAMS = [
  "fixtures/fixbug/fixbug.mdt",
  "fixtures/fixbug/fixbug.ir.json",
  "fixtures/fixbug-target/fixbug.mdt",
  "fixtures/system/acme.system.mdt",
  "fixtures/system/audience.mdt",
  "fixtures/system/incident.mdt",
  "fixtures/system/land.mdt",
  "fixtures/system/loosen-ci.mdt",
  "fixtures/system/onboard.mdt",
  "fixtures/system/repos.mdt",
  ...syntaxFixtures(),
];

/** The system models the task programs import, as `--module` gives them. */
const MODULE_FILES = ["fixtures/system/acme.system.mdt", "fixtures/system/repos.mdt"];

function modules(): Modules {
  const { modules, problems } = loadModules(MODULE_FILES.map((file) => ({ file, text: readRepo(file), kind: kindOf(file) })));
  expect(problems).toEqual([]);
  return modules;
}

function lockOf(file: string): Lock | undefined {
  const path = `${dirname(repoRoot + file)}/mandate.lock.json`;
  if (!existsSync(path)) return undefined;
  const parsed = parseStrictJson(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error(`${path} is not strict JSON`);
  return parsed.value.value as unknown as Lock;
}

const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

/** What each command of the CLI prints for one program, by name. */
function outputs(file: string, mods: Modules): Record<string, string> {
  const text = readRepo(file);
  const kind = kindOf(file);
  const out: Record<string, string> = {};
  const lock = lockOf(file);

  const checkOutput = (r: ReturnType<typeof check>): string => json({ ok: r.ok, ...(r.hashes ? { hashes: r.hashes } : {}), diagnostics: r.diagnostics });
  const plain = check(text, kind);
  out["check"] = checkOutput(plain);
  const linked = check(text, kind, { modules: mods });
  out["check --module"] = checkOutput(linked);
  if (lock) out["check --lock"] = checkOutput(check(text, kind, { modules: mods, lock }));

  const loaded = load(text, kind);
  out["load"] = json(loaded.diagnostics);
  if (loaded.program) {
    out["ir --canonical"] = canonicalize(loaded.program as unknown as Json);
    out["fmt"] = printProgram(loaded.program);
  }
  if (plain.hashes) out["hash"] = json(plain.hashes);

  const checked = lock ? check(text, kind, { modules: mods, lock }) : linked;
  if (checked.ok && checked.program) {
    const p = checked.program;
    out["view --format json"] = json({ architecture: architecture(p), authority: authority(p), cost: cost(p, lock) });
    const doc = programDoc(p, lock, mods);
    out["view --format md"] = toMarkdown(doc);
    out["view --format html"] = toHtml(doc);
    out["view --against itself"] = json(semanticDiff(p, p));
    out["sandbox"] = json({ program: checked.hashes!.program, requirements: sandboxRequirements(p, mods) });
  }
  return out;
}

function digests(): Record<string, Record<string, string>> {
  const mods = modules();
  const all: Record<string, Record<string, string>> = {};
  for (const file of PROGRAMS) {
    const row: Record<string, string> = {};
    for (const [name, text] of Object.entries(outputs(file, mods))) row[name] = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    all[file] = row;
  }
  return all;
}

describe("programs of 0.1 to 0.3", () => {
  const now = digests();

  if (process.env["MANDATE_UPDATE_GOLDEN"] === "1") {
    writeFileSync(GOLDEN, json(now));
  }
  const pinned = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Record<string, string>>;

  it("pins every program in the repository", () => {
    expect(Object.keys(pinned).sort()).toEqual([...PROGRAMS].sort());
  });

  for (const file of PROGRAMS) {
    it(`${file} gives the outputs it gave`, () => {
      expect(now[file]).toEqual(pinned[file]);
    });
  }

  it("checks, hashes and shows something for each of them", () => {
    // A pin of nothing would pass for ever: every program loads, and every one that checks has its views.
    for (const file of PROGRAMS) {
      const names = Object.keys(now[file]!);
      expect(names, file).toEqual(expect.arrayContaining(["check", "check --module", "load", "ir --canonical", "fmt"]));
    }
    const shown = PROGRAMS.filter((f) => "view --format json" in now[f]!);
    expect(shown.length).toBeGreaterThanOrEqual(PROGRAMS.length - 1);
  });
});
