// The output texts of every program in the repository, as the golden test pins them (golden.test.ts) and as the
// diagnostic vectors (diagnostic-vectors.test.ts) read them. Nothing here is product behaviour.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect } from "vitest";
import { check, kindOf, load, loadModules } from "../src/check.js";
import { canonicalize } from "../src/json/jcs.js";
import { parseStrictJson, type Json } from "../src/json/strict-json.js";
import type { Lock } from "../src/lock.js";
import type { Modules } from "../src/modules.js";
import { printProgram } from "../src/print/printer.js";
import { sandboxRequirements } from "../src/target/sandbox.js";
import { toHtml, toMarkdown } from "../src/views/doc.js";
import { architecture, authority, card, cardDoc, cost, envelopeWorkflows, programDoc, semanticDiff } from "../src/views/views.js";
import { lockFileOf, readRepo, syntaxFixtures } from "./helpers.js";

/** Every program in the repository. */
export const PROGRAMS = [
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
export const MODULE_FILES = ["fixtures/system/acme.system.mdt", "fixtures/system/repos.mdt"];

/**
 * The modules a program is given, where they are not MODULE_FILES. MigrateAll imports company.domain, which is
 * not among them. Earlier programs (the fixbug fixtures and several syntax fixtures) also import from a module
 * called company.domain, which is opaque to them when it is not given. With fixtures/envelope/domain.mdt in the shared
 * list they would find it, and not the names they use (E0120): 50 of their digests change, and those are not to.
 */
export const MODULE_FILES_OF: Record<string, string[]> = {
  "fixtures/envelope/migrate-all.mdt": ["fixtures/envelope/domain.mdt"],
};

export function modulesOf(files: string[]): Modules {
  const { modules, problems } = loadModules(files.map((file) => ({ file, text: readRepo(file), kind: kindOf(file) })));
  expect(problems).toEqual([]);
  return modules;
}

export function lockOf(file: string): Lock | undefined {
  const path = lockFileOf(file);
  if (!path) return undefined;
  const parsed = parseStrictJson(readRepo(path));
  if (!parsed.ok) throw new Error(`${path} is not strict JSON`);
  return parsed.value.value as unknown as Lock;
}

export const json = (v: unknown): string => JSON.stringify(v, null, 2) + "\n";

/** What each command of the CLI prints for one program, by name. */
export function outputs(file: string, mods: Modules): Record<string, string> {
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
    // `mandate view --card` (cli.ts) is of the one workflow with an envelope, which a program that has one workflow with
    // an envelope has by default; it is given the modules and the lock as the command line gives them.
    const enveloped = envelopeWorkflows(p);
    if (enveloped.length === 1) {
      const name = enveloped[0]!;
      const opts = { modules: mods, ...(lock ? { lock } : {}) };
      out["view --card --format json"] = json(card(p, name, opts));
      out["view --card --format md"] = toMarkdown(cardDoc(p, name, opts)!);
      out["view --card --format html"] = toHtml(cardDoc(p, name, opts)!);
    }
  }
  return out;
}

/** The module files a program is given (repository paths), as `--module` gives them. */
export function moduleFilesOf(file: string): string[] {
  return MODULE_FILES_OF[file] ?? MODULE_FILES;
}

let memo: Record<string, Record<string, string>> | undefined;

/** Every output text of every program, by program path and output name. Computed once. */
export function allOutputs(): Record<string, Record<string, string>> {
  if (memo) return memo;
  const shared = modulesOf(MODULE_FILES);
  const all: Record<string, Record<string, string>> = {};
  for (const file of PROGRAMS) {
    const own = MODULE_FILES_OF[file];
    all[file] = outputs(file, own ? modulesOf(own) : shared);
  }
  memo = all;
  return all;
}

export const sha256Of = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** The digest of every output, as golden/outputs.json pins them. */
export function digests(): Record<string, Record<string, string>> {
  const all: Record<string, Record<string, string>> = {};
  for (const [file, texts] of Object.entries(allOutputs())) {
    const row: Record<string, string> = {};
    for (const [name, text] of Object.entries(texts)) row[name] = sha256Of(text);
    all[file] = row;
  }
  return all;
}

/** The file name of an output: its name with each space replaced by `_` (`check_--module`). */
export const outputFileName = (name: string): string => name.replaceAll(" ", "_");

/**
 * Writes every output text to `<dir>/<program path>/<output file name>`, bytes exactly as hashed (no added newline),
 * creating the directories. Returns the paths written, relative to `dir`, in program and output order.
 */
export function writeOutputs(dir: string, all: Record<string, Record<string, string>> = allOutputs()): string[] {
  const written: string[] = [];
  for (const [file, texts] of Object.entries(all)) {
    for (const [name, text] of Object.entries(texts)) {
      const rel = `${file}/${outputFileName(name)}`;
      const full = `${dir.replace(/[\/]+$/, "")}/${rel}`;
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, text, "utf8");
      written.push(rel);
    }
  }
  return written;
}
