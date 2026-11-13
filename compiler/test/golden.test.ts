// What the compiler says about every program in the repository is pinned
// here, by digest: a 0.1 to 0.3 program reads, checks, hashes, prints and
// shows exactly as it did. A later version adds to the language; it does not
// change what an earlier program means. The programs of 0.4 and 0.5 (the
// MigrateAll example with its domain module, and the three fixtures of
// fixtures/boundary) are pinned beside them, so what the compiler says of
// them changes only with a reason too. A Rust compiler must give these same
// digests (release 0.5).
//
// The digests are in golden/outputs.json. A change to one of them is a change
// to an earlier version's behavior and needs a reason in the commit that
// makes it. To write the file again: MANDATE_UPDATE_GOLDEN=1 npm test.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
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
import { lockFileOf, readRepo, repoRoot, syntaxFixtures } from "./helpers.js";

const GOLDEN = `${repoRoot}compiler/test/golden/outputs.json`;

/** Every program in the repository. */
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
  // 0.4 (spec/envelope.md): the types its MigrateAll example uses, and the example.
  "fixtures/envelope/domain.mdt",
  "fixtures/envelope/migrate-all.mdt",
  // 0.5 (spec/boundary.md): methods, sandbox requirement 0.2 and lock 0.5.
  "fixtures/boundary/fetch.mdt",
  "fixtures/boundary/reach.mdt",
];

/** The system models the task programs import, as `--module` gives them. */
const MODULE_FILES = ["fixtures/system/acme.system.mdt", "fixtures/system/repos.mdt"];

/**
 * The modules a program is given, where they are not MODULE_FILES. MigrateAll imports company.domain, which is
 * not among them. Eight earlier programs (fixbug and seven syntax fixtures) also import from a module called
 * company.domain, which is opaque to them when it is not given. With fixtures/envelope/domain.mdt in the shared
 * list they would find it, and not the names they use (E0120): 50 of their digests change, and those are not to.
 */
const MODULE_FILES_OF: Record<string, string[]> = {
  "fixtures/envelope/migrate-all.mdt": ["fixtures/envelope/domain.mdt"],
};

function modulesOf(files: string[]): Modules {
  const { modules, problems } = loadModules(files.map((file) => ({ file, text: readRepo(file), kind: kindOf(file) })));
  expect(problems).toEqual([]);
  return modules;
}

function lockOf(file: string): Lock | undefined {
  const path = lockFileOf(file);
  if (!path) return undefined;
  const parsed = parseStrictJson(readRepo(path));
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
    out["sandbox"] = json({ program: checked.hashes!.program, requirements: sandboxRequirements(p, mods, lock) });
  }
  return out;
}

function digests(): Record<string, Record<string, string>> {
  const shared = modulesOf(MODULE_FILES);
  const all: Record<string, Record<string, string>> = {};
  for (const file of PROGRAMS) {
    const row: Record<string, string> = {};
    const own = MODULE_FILES_OF[file];
    for (const [name, text] of Object.entries(outputs(file, own ? modulesOf(own) : shared))) row[name] = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    all[file] = row;
  }
  return all;
}

describe("every program in the repository", () => {
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
