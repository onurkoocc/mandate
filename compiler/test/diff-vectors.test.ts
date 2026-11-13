// Writes the diff vectors in vectors/diff/ (vectors/README.md, "diff/"): for pairs of programs, and of locks, what the
// views that compare two things give, for the Rust port of those views to match member for member and character for
// character. Nothing here is product behaviour.
//
// The committed files must be what this test generates; it fails when one differs, is missing or is left over.
// To write them again: MANDATE_UPDATE_VECTORS=1 npm test.
// MANDATE_VECTORS_REPORT=1 also prints the coverage table.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { describe, expect, it } from "vitest";
import { check, kindOf, load, loadModules, type SourceKind } from "../src/check.js";
import { BUDGET_DIMENSIONS, type Program } from "../src/ir/types.js";
import { canonicalize } from "../src/json/jcs.js";
import { isWellFormed, parseStrictJson, type Json } from "../src/json/strict-json.js";
import type { Lock } from "../src/lock.js";
import type { Modules } from "../src/modules.js";
import { CAP_CTORS, DATA_CLASSES } from "../src/std/std.js";
import { toHtml, toMarkdown } from "../src/views/doc.js";
import { diffDoc, envelopeChanges, governanceChanges, lockDiff, lockLimitsDiff, semanticDiff, type Change } from "../src/views/views.js";
import { amendmentInput, caseDirs, caseFile, readCase, runCompileCase, type Case } from "./cases-runner.js";
import { WRITTEN_PAIRS } from "./diff-pairs.js";
import { MODULE_FILES, MODULE_FILES_OF, PROGRAMS } from "./golden-outputs.js";
import { lockFileOf, readRepo, repoRoot } from "./helpers.js";

const DIR = "vectors/diff/";
/** A file stays well under the 1 MiB the Rust reader accepts, and the test below says 900 KB. */
const PART_LIMIT = 700_000;
/** The vectors stay under about this much in all. */
const TOTAL_LIMIT = 1_500_000;

/** JSON as the vector files hold it (see vectors.test.ts): two-space indents, a list of integers on one line, ASCII only. */
function vectorText(value: unknown): string {
  const text = JSON.stringify(value, null, 2)
    .replace(/\[\n(?:\s*-?\d+,\n)*\s*-?\d+\n\s*\]/g, (a) => `[${a.slice(1, -1).trim().split(/,\s*/).join(", ")}]`)
    .replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return text + "\n";
}

/** Whether the value holds a number the Rust reader refuses (not an integer, or beyond 2^53). */
function hasOtherNumber(v: unknown): boolean {
  if (typeof v === "number") return !Number.isSafeInteger(v);
  if (Array.isArray(v)) return v.some(hasOtherNumber);
  if (v && typeof v === "object") return Object.values(v).some(hasOtherNumber);
  return false;
}

/** A value as plain JSON (what `JSON.stringify` keeps, in the compiler's member order). */
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const byUtf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const slash = (p: string): string => p.replace(/\\/g, "/");

// ---------------------------------------------------------------------------------------------------------
// The cases

type Source = "conformance_patch" | "conformance_amendment" | "repository" | "lock" | "written";
type Side = { file: string; kind: SourceKind } | { text: string; kind: SourceKind } | { file: string; kind: SourceKind; patch_of: string } | { file: string; kind: SourceKind; amend_of: string };
type LockRef = { file: string } | { text: string };

interface Pair {
  name: string;
  source: Source;
  note: string;
  before: Side;
  after: Side;
  /** Repository files; the programs are checked with the modules they make. */
  modules: string[];
  lockRefs: { before: LockRef | null; after: LockRef | null };
  programs: { before: Program; after: Program };
  modulesOf: Modules;
  locks: { before?: Lock; after?: Lock } | undefined;
}

interface DiffCase {
  name: string;
  source: Source;
  note: string;
  before: Side;
  after: Side;
  modules: string[];
  locks: { before: LockRef | null; after: LockRef | null };
  results: Record<string, unknown>;
  texts: Record<string, string>;
  markdown: string;
  html_sha256: string;
  html_length: number;
  html?: string;
}

const modulesFrom = (files: string[]): Modules => {
  const { modules, problems } = loadModules(files.map((file) => ({ file, text: readRepo(file), kind: kindOf(file) })));
  expect(problems).toEqual([]);
  return modules;
};

function checked(text: string, kind: SourceKind, modules: Modules, what: string): Program {
  const r = check(text, kind, { modules });
  if (!r.ok || !r.program) throw new Error(`${what} does not check: ${r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.at.path ?? ""}`).join(", ")}`);
  return r.program;
}

const lockOfRef = (ref: LockRef | null): Lock | undefined => {
  if (ref === null) return undefined;
  const text = "file" in ref ? readRepo(ref.file) : ref.text;
  const parsed = parseStrictJson(text);
  if (!parsed.ok) throw new Error("a lock is not strict JSON");
  return parsed.value.value as unknown as Lock;
};

function build(p: Omit<Pair, "programs" | "modulesOf" | "locks"> & { programs?: Pair["programs"]; modulesOf?: Modules }): Pair {
  const mods = p.modulesOf ?? modulesFrom(p.modules);
  const sideText = (s: Side): { text: string; kind: SourceKind } => ("text" in s ? { text: s.text, kind: s.kind } : { text: readRepo(s.file), kind: s.kind });
  const programs = p.programs ?? { before: checked(sideText(p.before).text, p.before.kind, mods, `${p.name}: before`), after: checked(sideText(p.after).text, p.after.kind, mods, `${p.name}: after`) };
  const before = lockOfRef(p.lockRefs.before);
  const after = lockOfRef(p.lockRefs.after);
  const locks = before || after ? { ...(before ? { before } : {}), ...(after ? { after } : {}) } : undefined;
  return { ...p, programs, modulesOf: mods, locks };
}

const fileSide = (file: string): Side => ({ file, kind: kindOf(file) });
const noLocks = { before: null, after: null };

/** Conformance cases that patch a program (the patched program checks) and that amend an envelope. */
function conformancePairs(): { patches: Pair[]; amendments: Pair[]; left: string[] } {
  const patches: Pair[] = [];
  const amendments: Pair[] = [];
  const left: string[] = [];
  for (const name of caseDirs()) {
    const c: Case = readCase(name);
    if (c.kind !== "compile") continue;
    const dir = `${repoRoot}conformance/${name}`;
    const repoPath = (file: string): string => slash(relative(repoRoot, caseFile(dir, file)));
    const mods = (c.modules ?? []).map(repoPath);
    if (c.patch === undefined && c.amendment === undefined) continue;
    const input: { file: string; kind: SourceKind } | { text: string; kind: SourceKind } = "file" in c.input ? { file: repoPath(c.input.file), kind: c.input.kind } : { text: c.input.text, kind: c.input.kind };
    const modulesOf = modulesFrom(mods);
    const text = "file" in input ? readRepo(input.file) : input.text;
    if (c.amendment !== undefined) {
      const parent = check(text, input.kind, { modules: modulesOf }).program!;
      const amended = { ...parent, defs: { ...parent.defs, [c.amendment.workflow]: { ...parent.defs[c.amendment.workflow]!, envelope: amendmentInput(c.amendment, parent, modulesOf).envelope } } };
      const after = check(JSON.stringify(amended), "json", { modules: modulesOf });
      if (!after.ok || !after.program) {
        left.push(name);
        continue;
      }
      amendments.push(build({ name, source: "conformance_amendment", note: `The envelope of ${c.amendment.workflow} amended as conformance/${name}/case.json says (the case's own front door is check_amendment).`, before: { ...input }, after: { ...("file" in input ? { file: input.file } : { text: input.text }), kind: input.kind, amend_of: name } as Side, modules: mods, lockRefs: noLocks, programs: { before: parent, after: after.program }, modulesOf }));
      continue;
    }
    const r = runCompileCase(name, c) as { ok: boolean; program?: Program };
    // The base is the program as it loads: a patch may be what makes it check.
    const base = load(text, input.kind);
    if (!r.ok || !r.program || !base.program || base.diagnostics.some((d) => d.severity === "error")) {
      left.push(name);
      continue;
    }
    patches.push(build({ name, source: "conformance_patch", note: `conformance/${name}/case.json patches the program of its input${c.base !== undefined ? " against a base hash (front door apply_ops)" : " (front door check_patched)"}; the patched program is the after.`, before: { ...input }, after: { ...("file" in input ? { file: input.file } : { text: input.text }), kind: input.kind, patch_of: name } as Side, modules: mods, lockRefs: noLocks, programs: { before: base.program, after: r.program }, modulesOf }));
  }
  return { patches, amendments, left };
}

/** Pairs of programs of the repository that are versions of one another, or variants. */
function repositoryPairs(): Pair[] {
  const out: Pair[] = [];
  const lockRef = (file: string): LockRef | null => {
    const l = lockFileOf(file);
    return l ? { file: l } : null;
  };
  const pair = (name: string, note: string, before: string, after: string, modules: string[]): void => {
    out.push(build({ name, source: "repository", note, before: fileSide(before), after: fileSide(after), modules, lockRefs: { before: lockRef(before), after: lockRef(after) } }));
  };
  const FIXBUG = "fixtures/fixbug/fixbug.mdt";
  const TARGET = "fixtures/fixbug-target/fixbug.mdt";
  pair("fixbug-to-fixbug-target", "The bug-fixing workflow of the first fixtures and its version for the end-to-end target.", FIXBUG, TARGET, []);
  pair("fixbug-target-to-fixbug", "The same two programs, the other way round.", TARGET, FIXBUG, []);
  pair("fixbug-text-to-ir", "One program written as text and as IR JSON: nothing changes.", FIXBUG, "fixtures/fixbug/fixbug.ir.json", []);
  pair("land-to-loosen-ci", "A change set over three components, and the variant of it that loosens a component's CI (the system model is given to the checker).", "fixtures/system/land.mdt", "fixtures/system/loosen-ci.mdt", MODULE_FILES);
  pair("loosen-ci-to-land", "The same two programs, the other way round.", "fixtures/system/loosen-ci.mdt", "fixtures/system/land.mdt", MODULE_FILES);
  return out;
}

/** Locks of the repository: each against itself, and against the other locks of the same program. */
function lockPairs(): Pair[] {
  // The program each lock goes with, and the modules it is checked with: from the golden programs and from the conformance cases.
  const groups = new Map<string, { program: string; modules: string[]; locks: Set<string> }>();
  const add = (program: string, modules: string[], lock: string): void => {
    const key = `${program}\n${modules.join("\n")}`;
    if (!groups.has(key)) groups.set(key, { program, modules, locks: new Set() });
    groups.get(key)!.locks.add(lock);
  };
  for (const program of PROGRAMS) {
    const l = lockFileOf(program);
    if (l) add(program.endsWith(".ir.json") ? "fixtures/fixbug/fixbug.mdt" : program, MODULE_FILES_OF[program] ?? [], l);
  }
  for (const name of caseDirs()) {
    const c = readCase(name);
    if (c.kind !== "compile" || typeof c.lock !== "string" || !("file" in c.input)) continue;
    const dir = `${repoRoot}conformance/${name}`;
    const repoPath = (file: string): string => slash(relative(repoRoot, caseFile(dir, file)));
    add(repoPath(c.input.file), (c.modules ?? []).map(repoPath), repoPath(c.lock));
  }
  const out: Pair[] = [];
  for (const g of [...groups.values()].sort((a, b) => byUtf16(a.program, b.program) || byUtf16(a.modules.join(), b.modules.join()))) {
    // The fixtures' own locks first, so that a lock another case holds twice is named by the fixture's path.
    const locks = [...g.locks].sort((a, b) => Number(b.startsWith("fixtures/")) - Number(a.startsWith("fixtures/")) || byUtf16(a, b));
    const content = (l: string): string => canonicalize(JSON.parse(readRepo(l)) as Json);
    const distinct: string[] = [];
    for (const l of locks) if (!distinct.some((d) => content(d) === content(l))) distinct.push(l);
    const make = (b: string, a: string): void => {
      out.push(build({ name: `${b} -> ${a}`, source: "lock", note: `The locks of ${g.program}${g.modules.length ? " (with its modules)" : ""}: the program is both sides; the locks are what differs.`, before: fileSide(g.program), after: fileSide(g.program), modules: g.modules, lockRefs: { before: { file: b }, after: { file: a } } }));
    };
    for (const l of locks) make(l, l);
    // Against the program's own lock (the fixture's, where it has one), the other locks of the same program, both ways.
    const own = distinct.find((l) => l.startsWith("fixtures/")) ?? distinct[0]!;
    for (const other of distinct) if (other !== own) (make(own, other), make(other, own));
  }
  return out;
}

function writtenPairs(): Pair[] {
  return WRITTEN_PAIRS.map((w) =>
    build({
      name: w.name,
      source: "written",
      note: w.note,
      before: { text: w.before, kind: "mdt" },
      after: { text: w.after, kind: "mdt" },
      modules: w.modules ?? [],
      lockRefs: { before: w.locks?.before ? { text: w.locks.before } : null, after: w.locks?.after ? { text: w.locks.after } : null },
    }),
  );
}

// ---------------------------------------------------------------------------------------------------------
// What the comparing views give

function envelopeResults(p: Pair): Array<{ workflow: string; changes: Change[] }> {
  const workflows = (g: Program): string[] => Object.entries(g.defs).filter(([, d]) => d.kind === "workflow").map(([n]) => n);
  const both = workflows(p.programs.before).filter((n) => workflows(p.programs.after).includes(n)).sort(byUtf16);
  return both.map((workflow) => ({ workflow, changes: envelopeChanges(p.programs.before, p.programs.after, workflow, p.modulesOf) }));
}

function diffCase(p: Pair): DiffCase {
  const { before, after } = p.programs;
  const values: Record<string, unknown> = {
    diff: plain(semanticDiff(before, after, p.locks)),
    governance_changes: plain(governanceChanges(before, after, p.modulesOf)),
    envelope_changes: plain(envelopeResults(p)),
    ...(p.locks ? { lock_diff: plain(lockDiff(p.locks.before, p.locks.after)), lock_limits_diff: plain(lockLimitsDiff(p.locks.before, p.locks.after)) } : {}),
  };
  const doc = diffDoc(before, after, p.locks);
  const html = toHtml(doc);
  const results: Record<string, unknown> = {};
  const texts: Record<string, string> = {};
  for (const [slot, v] of Object.entries(values)) {
    if (hasOtherNumber(v)) texts[slot] = JSON.stringify(v, null, 2) + "\n";
    else results[slot] = v;
  }
  return {
    name: p.name,
    source: p.source,
    note: p.note,
    before: p.before,
    after: p.after,
    modules: p.modules,
    locks: p.lockRefs,
    results,
    texts,
    markdown: toMarkdown(doc),
    html_sha256: sha256(html),
    html_length: html.length,
    html,
  };
}

/**
 * The HTML of a case is stored whole for the cases of conformance cases and of repository programs, and for these
 * written pairs, which between them show every kind of block, every escape and a lock; for every other case only its
 * length and its sha256 are stored (the page around a table is the same in all of them).
 */
const HTML_WHOLE_SOURCES: Source[] = ["conformance_patch", "conformance_amendment", "repository"];
const HTML_WHOLE_WRITTEN = [
  "spares-added",
  "spares-removed",
  "kind-changed",
  "cap-host-and-methods-widened",
  "agent-budget-raised",
  "contract-criterion-removed",
  "envelope-all-at-once",
  "envelope-added",
  "system-component-fields-changed",
  "linked-capabilities-widened",
  "lock-member-added",
  "lock-limits-all-at-once",
  "lock-absent-before",
  "special-characters",
];

function stored(cases: DiffCase[]): DiffCase[] {
  return cases.map((c) => {
    if (HTML_WHOLE_SOURCES.includes(c.source) || (c.source === "written" && HTML_WHOLE_WRITTEN.includes(c.name))) return c;
    const { html: _html, ...rest } = c;
    return rest;
  });
}

// ---------------------------------------------------------------------------------------------------------
// The kinds of change the code can report, and the cases that show each

type Section = "G" | "B" | "E" | "K" | "U";
interface Row {
  id: string;
  /** G: the diff's governance changes; B: its behavior changes; E: the envelope changes; K: the kinds of the governance changes; U: the diff's unchanged lines. */
  section: Section;
  test: (c: { text: string; path: string }) => boolean;
  /** For a kind that only the whole case shows (a new workflow's capability is the same line as an agent's): every section of one case. */
  whole?: (c: Record<Section, Array<{ text: string; path: string }>>) => boolean;
  /** A kind the code has a branch for and that no input reaches (see vectors/README.md); the test says so if one does. */
  unreachable?: string;
}

const re = (r: RegExp) => (c: { text: string }): boolean => r.test(c.text);

function defKinds(): string[] {
  const src = readFileSync(`${repoRoot}compiler/src/ir/types.ts`, "utf8");
  const union = /export type Def =([\s\S]*?);/.exec(src)![1]!;
  return [...union.matchAll(/\|\s*(\w+)Def\b/g)].map((m) => m[1]!.toLowerCase());
}

function governanceKinds(): string[] {
  const src = readFileSync(`${repoRoot}compiler/src/views/views.ts`, "utf8");
  const union = /export type GovernanceChangeKind =([\s\S]*?);/.exec(src)![1]!;
  return [...union.matchAll(/\|\s*"([a-z_]+)"/g)].map((m) => m[1]!);
}

const SYSTEM_KINDS_LIST = ["component", "interface", "environment"];
const COMPONENT_FIELDS = ["repo", "root", "lang", "owner", "build", "test", "provides", "consumes", "governance"];

function rows(): Row[] {
  const out: Row[] = [];
  const row = (id: string, section: Section, test: Row["test"], unreachable?: string): void => void out.push({ id, section, test, ...(unreachable ? { unreachable } : {}) });
  // A definition of each kind comes, goes or changes.
  for (const k of defKinds()) {
    const system = SYSTEM_KINDS_LIST.includes(k);
    row(`def.${k}.added`, k === "capability" || system ? "G" : "B", k === "capability" ? re(/^\+ capability /) : system ? re(new RegExp(`^\\+ ${k} \\S+ \\(system model\\)$`)) : re(new RegExp(`^\\+ ${k} \\S+$`)));
    row(`def.${k}.removed`, k === "contract" || system ? "G" : "B", re(new RegExp(`^- ${k} \\S+ removed$`)));
  }
  for (const k of ["type", "const", "extern", "role"]) row(`def.${k}.changed`, "B", re(new RegExp(`^~ ${k} \\S+ changed$`)));
  row("def.kind_changed", "G", re(/^~ \S+: [a-z]+ → [a-z]+$/));
  row("def.agent.remote_added", "G", re(/^\+ remote agent \S+$/));
  row("def.effect.irreversible_added", "G", re(/^\+ irreversible effect \S+$/));
  row("def.effect.became_irreversible", "G", re(/^~ effect \S+ became irreversible$/));
  row("def.effect.changed", "B", re(/^~ effect \S+ changed$/));
  row("def.fn.changed", "B", re(/^~ fn \S+ changed$/));
  // A capability definition changes.
  row("cap.read_path_added", "G", re(/^\+ \S+: read path "/));
  row("cap.write_path_added", "G", re(/^\+ \S+: write path "/));
  row("cap.network_host_added", "G", re(/^\+ \S+: network host "/));
  row("cap.repository_added", "G", re(/^\+ \S+: repository "/));
  row("cap.other_scope_added", "G", re(/^\+ \S+: scope "/));
  row("cap.command_added", "G", re(/^\+ \S+: command "/), "an exec capability is paired with its other version by its commands, so a command is never added to one that was there; a changed list is a removed capability and an added one");
  row("cap.unbounded", "G", re(/s without a static scope \(unbounded\)$/), "a scope that was static and is not needs a capability argument the checker cannot read as constant, and the checker refuses one");
  row("cap.whole_added", "G", (c) => /^\+ \S+: \S+ = [a-z.]+\(/.test(c.text) && c.path.split("/").length === 3);
  row("cap.removed_narrowed", "B", (c) => /^- \S+: .*\(narrowed\)$/.test(c.text) && c.path.split("/").length === 3);
  row("cap.model_tier", "G", re(/^~ \S+: model tier \S+ → \S+$/));
  row("cap.data_class", "G", re(/^~ \S+: data class up to \S+ → \S+$/));
  row("cap.argument_prefixes", "G", re(/^~ \S+: argument prefixes /));
  row("cap.methods_widened", "G", re(/^~ \S+: methods .* → .*$/));
  row("cap.methods_narrowed", "B", re(/^- \S+: methods .* \(narrowed\)$/));
  row("cap.changed_unreadable", "G", re(/^~ capability \S+ changed$/));
  row("cap.defined_added_with_scope", "G", re(/^\+ capability \S+ = /));
  // What an agent and a workflow hold.
  row("agent_workflow.cap_added", "G", (c) => /^\+ \S+: /.test(c.text) && /^\/defs\/[^/]+\/caps\/\d+$/.test(c.path));
  row("agent_workflow.cap_narrowed", "B", (c) => /\(narrowed\)$/.test(c.text) && /^\/defs\/[^/]+\/caps$/.test(c.path));
  // A new workflow's capabilities are the same lines as an agent's; only the case shows the workflow is new.
  const whole = (id: string, test: NonNullable<Row["whole"]>, each: Row["test"] = () => false): void => void out.push({ id, section: "G", test: each, whole: test });
  whole("workflow.added.cap", (c) => c.B.some((b) => /^\+ workflow \S+$/.test(b.text) && c.G.some((g) => g.path.startsWith(`${b.path}/`) && /\/caps\/\d+$/.test(g.path))), (c) => /^\+ \S+: /.test(c.text) && /^\/defs\/[^/]+\/envelope\/caps\/\d+$/.test(c.path));
  whole("budget.fn_raised", (c) => c.B.some((b) => /^~ fn \S+ changed$/.test(b.text) && c.G.some((g) => g.path === `${b.path}/budget`)), (c) => /^~ \S+\.budget\.\w+: /.test(c.text) && /^\/defs\/[^/]+\/budget$/.test(c.path));
  whole("budget.agent_or_workflow_raised", (c) => c.G.some((g) => /^\/defs\/[^/]+\/budget$/.test(g.path) && !c.B.some((b) => b.path === g.path.replace(/\/budget$/, "") && /^~ fn /.test(b.text))), () => false);
  row("workflow.added.envelope", "G", re(/^\+ \S+: envelope$/));
  // Budgets: each dimension, up, down, to no limit, from no limit; and a currency.
  for (const dim of BUDGET_DIMENSIONS) {
    const m = (c: { text: string }): RegExpExecArray | null => new RegExp(`^~ (\\S+)\\.budget\\.${dim}: (.*) → (.*)$`).exec(c.text);
    const plainBudget = (c: { text: string }): RegExpExecArray | null => (m(c) && !/\.envelope\./.test(c.text) ? m(c) : null);
    row(`budget.${dim}.raised`, "G", (c) => {
      const r = plainBudget(c);
      return !!r && r[2] !== "no limit" && r[3] !== "no limit" && !(dim === "spend" && r[2]!.split(" ")[1] !== r[3]!.split(" ")[1]);
    });
    row(`budget.${dim}.lowered`, "B", (c) => !!plainBudget(c) && plainBudget(c)![2] !== "no limit" && plainBudget(c)![3] !== "no limit");
    row(`budget.${dim}.limit_removed`, "G", (c) => !!plainBudget(c) && plainBudget(c)![3] === "no limit");
    row(`budget.${dim}.limit_added`, "B", (c) => !!plainBudget(c) && plainBudget(c)![2] === "no limit");
  }
  row("budget.spend.currency_changed", "G", (c) => {
    const r = /^~ \S+\.budget\.spend: \S+ (\S+) → \S+ (\S+)$/.exec(c.text);
    return !!r && r[1] !== r[2];
  });
  row("budget.skill_raised", "G", re(/^~ \w+\.\w+\.budget\.\w+: \d/));
  row("budget.skill_lowered", "B", re(/^~ \w+\.\w+\.budget\.\w+: \d/));
  // Agents and their skills.
  row("skill.removed", "B", re(/^- skill \S+$/));
  row("skill.added", "B", re(/^\+ skill \S+$/));
  row("skill.changed", "B", re(/^~ skill \S+ changed$/));
  row("agent.role_loop_progress_or_model_changed", "B", re(/: role, loop strategy or progress thresholds changed$/));
  row("agent.remote_binding_changed", "G", re(/^~ \S+: remote binding changed$/));
  // Workflows.
  row("workflow.step_added", "B", re(/^\+ step: /));
  row("workflow.step_removed", "B", re(/^- step: /));
  row("workflow.body_changed_same_steps", "B", re(/: the body changed, with the same steps$/));
  row("workflow.envelope_added", "G", re(/^~ \S+: envelope added$/));
  row("workflow.envelope_removed", "G", re(/^~ \S+: envelope removed$/));
  row("workflow.envelope_changed", "G", re(/^~ \S+: envelope changed$/));
  row("workflow.ensures_changed", "B", re(/: ensures changed$/));
  row("workflow.handlers_changed", "B", re(/: event handlers changed$/));
  // Contracts.
  row("contract.accept_removed", "G", (c) => /^- \S+\.\S+ \(\S+\) removed$/.test(c.text) && c.path.includes("/accept/"));
  row("contract.invariant_removed", "G", (c) => /^- \S+\.\S+ \(\S+\) removed$/.test(c.text) && c.path.includes("/invariant/"));
  row("contract.criterion_method_changed", "G", re(/^~ \S+\.\S+: [a-z_.]+ → [a-z_.]+$/));
  row("contract.accept_added", "B", (c) => /^\+ \S+\.\S+ by \S+$/.test(c.text) && c.path.includes("/accept/"));
  row("contract.invariant_added", "B", (c) => /^\+ \S+\.\S+ by \S+$/.test(c.text) && c.path.includes("/invariant/"));
  row("contract.require_changed", "G", re(/^~ \S+: require changed$/));
  // The system model, field by field.
  for (const f of COMPONENT_FIELDS) row(`system.component.${f}`, "G", re(new RegExp(`^~ component \\S+\\.${f}: `)));
  row("system.interface.protocol", "G", re(/^~ interface \S+\.protocol: /));
  row("system.interface.spec", "G", re(/^~ interface \S+\.spec: /));
  row("system.environment.class", "G", re(/^~ environment \S+\.class: /));
  row("system.environment.reads", "G", re(/^~ environment \S+\.reads\.\S+: /));
  row("system.environment.authorize", "G", re(/^~ environment \S+\.authorize\.\S+: /));
  // The people two locks bind.
  row("lock.member_added", "G", re(/^\+ member \S+ \(\d+ keys?\)$/));
  row("lock.member_added_one_key", "G", re(/^\+ member \S+ \(1 key\)$/));
  row("lock.member_removed", "G", re(/^- member \S+$/));
  row("lock.key_added", "G", re(/^\+ key \S+ for \S+$/));
  row("lock.key_removed", "G", re(/^- key \S+ for \S+$/));
  row("lock.role_holder_added", "G", re(/^\+ \S+ holds role \S+$/));
  row("lock.role_holder_removed", "G", re(/^- \S+ no longer holds role \S+$/));
  // What two locks ask of the host and of the sandboxes.
  row("lock.host_lowered_version", "G", re(/^~ host\.\S+: [\d.]+ → [\d.]+ \(lowered\)$/));
  row("lock.host_raised_version", "B", re(/^~ host\.\S+: [\d.]+ → [\d.]+ \(raised\)$/));
  row("lock.host_minimum_removed", "G", re(/^~ host\.\S+: [\d.]+ → no minimum \(lowered\)$/));
  row("lock.host_minimum_added", "B", re(/^~ host\.\S+: no minimum → [\d.]+ \(raised\)$/));
  for (const cls of DATA_CLASSES) {
    row(`lock.floor.${cls}.lowered`, "G", re(new RegExp(`^~ isolation\\.floor\\.${cls} in effect: .* \\(lowered\\)$`)));
    row(`lock.floor.${cls}.raised`, "B", re(new RegExp(`^~ isolation\\.floor\\.${cls} in effect: .* \\(raised\\)$`)));
    row(`lock.co_tenancy.${cls}.relaxed`, "G", re(new RegExp(`^~ isolation\\.co_tenancy\\.${cls} in effect: .* \\(relaxed\\)$`)));
    row(`lock.co_tenancy.${cls}.tightened`, "B", re(new RegExp(`^~ isolation\\.co_tenancy\\.${cls} in effect: .* \\(tightened\\)$`)));
  }
  row("lock.untrusted_network.lowered", "G", re(/^~ isolation\.untrusted_network: .* \(lowered\)$/));
  row("lock.untrusted_network.raised", "B", re(/^~ isolation\.untrusted_network: .* \(raised\)$/));
  row("lock.egress.added", "G", re(/^\+ egress: /));
  row("lock.egress.changed", "G", re(/^~ egress: /));
  row("lock.egress.removed", "B", re(/^- egress: .* no more$/));
  // The one changed envelope, line by line.
  row("envelope.owner", "E", re(/^~ \S+\.envelope\.owner: /));
  row("envelope.cap_added", "E", re(/^\+ \S+\.envelope: /));
  row("envelope.cap_removed", "E", re(/^- \S+\.envelope: /));
  for (const dim of BUDGET_DIMENSIONS) {
    row(`envelope.budget.${dim}.raised`, "E", (c) => {
      const r = new RegExp(`^~ \\S+\\.envelope\\.budget\\.${dim}: (.*) → (.*)$`).exec(c.text);
      return !!r && !/ no limit/.test(c.text) && parseFloat(r[2]!) > parseFloat(r[1]!);
    });
    row(`envelope.budget.${dim}.lowered`, "E", (c) => {
      const r = new RegExp(`^~ \\S+\\.envelope\\.budget\\.${dim}: (.*) → (.*)$`).exec(c.text);
      return !!r && parseFloat(r[2]!) < parseFloat(r[1]!);
    });
  }
  for (const dim of BUDGET_DIMENSIONS) {
    const never = dim === "agents" ? "an envelope must give its agents budget (E1701), so it cannot lose or gain that limit" : undefined;
    row(`envelope.budget.${dim}.limit_removed`, "E", re(new RegExp(`^~ \\S+\\.envelope\\.budget\\.${dim}: .* → no limit$`)), never);
    row(`envelope.budget.${dim}.limit_added`, "E", re(new RegExp(`^~ \\S+\\.envelope\\.budget\\.${dim}: no limit → `)), never);
  }
  row("envelope.budget.currency_changed", "E", (c) => {
    const r = /^~ \S+\.envelope\.budget\.spend: \S+ (\S+) → \S+ (\S+)$/.exec(c.text);
    return !!r && r[1] !== r[2];
  });
  row("envelope.spawn.max_concurrent_changed", "E", re(/^~ \S+\.envelope\.spawn\.max_concurrent: \d+ → \d+$/));
  row("envelope.spawn.max_concurrent_unbounded", "E", re(/^~ \S+\.envelope\.spawn\.max_concurrent: \d+ → no bound$/));
  row("envelope.spawn.max_concurrent_bounded", "E", re(/^~ \S+\.envelope\.spawn\.max_concurrent: no bound → \d+$/));
  row("envelope.spawn.max_class", "E", re(/^~ \S+\.envelope\.spawn\.max_class: /));
  row("envelope.approve_added", "E", re(/^\+ \S+\.envelope\.approve: /));
  row("envelope.approve_removed", "E", re(/^- \S+\.envelope\.approve: /));
  row("envelope.approve_changed", "E", re(/^~ \S+\.envelope\.approve: .* → /));
  // The kinds a governance change is given.
  for (const k of governanceKinds()) row(`kind.${k}`, "K", (c) => c.text === k);
  // The lines under "Unchanged".
  row("unchanged.external_effects_same", "U", re(/^external effects unchanged: /));
  row("unchanged.no_external_effects", "U", re(/^no external effects, before or after$/));
  row("unchanged.contracts", "U", re(/^contracts and their criteria unchanged$/));
  row("unchanged.no_authority_added", "U", re(/^no authority added$/));
  row("unchanged.no_budget_raised", "U", re(/^no budget raised$/));
  return out;
}

/** The changes of one case, by section. */
function changesOf(c: DiffCase): Record<Section, Array<{ text: string; path: string }>> {
  const value = (slot: string): unknown => (slot in c.results ? c.results[slot] : JSON.parse(c.texts[slot]!));
  const diff = value("diff") as { governance: Change[]; behavior: Change[]; unchanged: string[] };
  const env = (value("envelope_changes") as Array<{ changes: Change[] }>).flatMap((e) => e.changes);
  const governance = value("governance_changes") as Array<{ kind: string; path: string; text: string }>;
  const kinds = governance.map((k) => ({ text: k.kind, path: "" }));
  // The governance changes of the program (with the system model given, as a patch sees them) are the diff's governance changes and, where a model is given, more.
  return { G: [...diff.governance, ...governance.map(({ path, text }) => ({ path, text }))], B: diff.behavior, E: env, K: kinds, U: diff.unchanged.map((text) => ({ text, path: "" })) };
}

interface Coverage {
  id: string;
  section: Section;
  cases: number;
  first: string | null;
  unreachable: string | null;
}

function coverage(cases: DiffCase[]): { table: Coverage[]; unclassified: string[] } {
  const all = rows();
  const perCase = cases.map((c) => ({ c, changes: changesOf(c) }));
  const table = all.map((r): Coverage => {
    const hits = perCase.filter(({ changes }) => (r.whole ? r.whole(changes) : changes[r.section].some(r.test)));
    return { id: r.id, section: r.section, cases: hits.length, first: hits[0]?.c.name ?? null, unreachable: r.unreachable ?? null };
  });
  // Every change of the stored outputs belongs to some row of its section: a new form of change that no row names is found here.
  const unclassified = new Set<string>();
  for (const { c, changes } of perCase) {
    for (const s of ["G", "B", "E", "U"] as const) {
      for (const ch of changes[s]) if (!all.some((r) => r.section === s && r.test(ch))) unclassified.add(`${s} ${ch.text} (${c.name})`);
    }
  }
  return { table, unclassified: [...unclassified].sort(byUtf16) };
}

// ---------------------------------------------------------------------------------------------------------
// The files

function summary(cases: DiffCase[], left: string[]): unknown {
  const bySource: Record<string, number> = {};
  for (const c of cases) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  const { table } = coverage(cases);
  return {
    format: "mandate/vectors/diff/summary/0.1",
    cases: cases.length,
    by_source: Object.fromEntries(Object.entries(bySource).sort(([a], [b]) => byUtf16(a, b))),
    cases_with_other_numbers: cases.filter((c) => Object.keys(c.texts).length > 0).map((c) => c.name),
    conformance_cases_left_out: left,
    coverage: table.map((t) => ({ kind: t.id, section: t.section, cases: t.cases, first_case: t.first, ...(t.unreachable ? { unreachable: t.unreachable } : {}) })),
  };
}

function parts(items: DiffCase[]): Map<string, string> {
  const groups: DiffCase[][] = [[]];
  let size = 0;
  for (const item of items) {
    const n = vectorText(item).length;
    if (size + n > PART_LIMIT) {
      groups.push([]);
      size = 0;
    }
    groups[groups.length - 1]!.push(item);
    size += n;
  }
  return new Map(groups.map((g, i) => [`${DIR}cases-${i + 1}.json`, vectorText({ format: "mandate/vectors/diff/cases/0.1", part: i + 1, parts: groups.length, cases: g })]));
}

const committed = (): string[] => (existsSync(repoRoot + DIR) ? readdirSync(repoRoot + DIR).map((f) => DIR + f).sort() : []);

describe("diff vectors for other implementations", () => {
  const conf = conformancePairs();
  const pairs: Pair[] = [...conf.patches, ...conf.amendments, ...repositoryPairs(), ...lockPairs(), ...writtenPairs()];
  const all: DiffCase[] = pairs.map(diffCase);
  const cases = stored(all);
  const now = new Map<string, string>([...parts(cases), [`${DIR}summary.json`, vectorText(summary(all, conf.left))]]);

  if (process.env["MANDATE_UPDATE_VECTORS"] === "1") {
    mkdirSync(repoRoot + DIR, { recursive: true });
    for (const file of committed()) if (!now.has(file)) rmSync(repoRoot + file);
    for (const [file, content] of now) writeFileSync(repoRoot + file, content);
  }

  if (process.env["MANDATE_VECTORS_REPORT"] === "1") {
    const { table } = coverage(all);
    console.log(table.map((t) => `${t.section} ${t.id.padEnd(46)} ${String(t.cases).padStart(3)}  ${t.first ?? (t.unreachable ? "(unreachable)" : "-")}`).join("\n"));
    const bySource: Record<string, number> = {};
    for (const c of all) bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    console.log(JSON.stringify(bySource), [...now].map(([f, t]) => `${f} ${Buffer.byteLength(t)}`).join("\n"));
  }

  it("vectors/diff/ holds exactly the files the generator writes", () => {
    expect(committed()).toEqual([...now.keys()].sort());
  });

  for (const [file, content] of now) {
    it(`${file} is what this compiler gives`, () => {
      expect(existsSync(repoRoot + file), `${file} is missing; MANDATE_UPDATE_VECTORS=1 npm test writes it`).toBe(true);
      expect(readFileSync(repoRoot + file, "utf8")).toBe(content);
    });
  }

  it("every file is ASCII strict JSON within the Rust reader's limits: under 900 KB, nesting up to 64, integers only, no lone surrogate, no duplicate key; and the files hold about 1.5 MB or less", () => {
    const stringsOf = (v: unknown, out: string[] = []): string[] => {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => stringsOf(x, out));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.push(k), stringsOf(x, out));
      return out;
    };
    const depthOf = (v: unknown): number => (v && typeof v === "object" ? 1 + Math.max(0, ...Object.values(v).map(depthOf)) : 0);
    const numbersOf = (v: unknown, out: number[] = []): number[] => {
      if (typeof v === "number") out.push(v);
      else if (Array.isArray(v)) v.forEach((x) => numbersOf(x, out));
      else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersOf(x, out));
      return out;
    };
    let total = 0;
    for (const [file, content] of now) {
      total += Buffer.byteLength(content);
      expect(/^[\x20-\x7e\n]*$/.test(content), `${file} is not ASCII`).toBe(true);
      expect(content.includes("\r"), `${file} has a carriage return`).toBe(false);
      expect(Buffer.byteLength(content), `${file} is over the limit`).toBeLessThan(900_000);
      expect(parseStrictJson(content).ok, file).toBe(true);
      const value = JSON.parse(content) as unknown;
      expect(depthOf(value), `${file}: nesting`).toBeLessThanOrEqual(64);
      for (const n of numbersOf(value)) expect(Number.isSafeInteger(n), `${file}: ${n}`).toBe(true);
      for (const s of stringsOf(value)) expect(isWellFormed(s), `${file}: a lone surrogate`).toBe(true);
    }
    expect(total, "the vectors are over about 1.5 MB").toBeLessThan(TOTAL_LIMIT);
  });

  describe("the pairs", () => {
    it("has one case for each pair, with names that are unique", () => {
      expect(new Set(all.map((c) => c.name)).size).toBe(all.length);
      expect(cases.length).toBe(all.length);
    });

    it("counts the pairs by source", () => {
      const by: Record<string, number> = {};
      for (const c of all) by[c.source] = (by[c.source] ?? 0) + 1;
      expect(by).toEqual({ conformance_amendment: 5, conformance_patch: 7, lock: 19, repository: 5, written: WRITTEN_PAIRS.length });
      // The 40 cases that patch a program (36 check_patched, 4 apply_ops), less the 7 whose patched program checks, are left out:
      // they are the ones that fail on purpose.
      expect(conf.patches.length + conf.left.length).toBe(40);
      expect(conf.patches.map((p) => p.name)).toEqual(["E1801d", "E1801e", "E1804a", "S12b", "V02b", "V03c", "V04b"]);
      expect(conf.amendments.map((p) => p.name)).toEqual(["E1709", "E1709a", "E1709b", "E1709c", "N04"]);
    });

    it("takes the pairs of conformance cases by name, and their inputs exist", () => {
      for (const c of all.filter((x) => x.source.startsWith("conformance"))) {
        for (const s of [c.before, c.after]) if ("file" in s) expect(existsSync(repoRoot + s.file), `${c.name}: ${s.file}`).toBe(true);
        for (const m of c.modules) expect(existsSync(repoRoot + m), `${c.name}: ${m}`).toBe(true);
      }
    });

    it("keeps the result of a pair of a program with itself empty of changes of the program, and a lock against itself empty", () => {
      for (const c of all.filter((x) => x.source === "lock")) {
        const [b, a] = c.name.split(" -> ");
        if (b === a) {
          const ch = changesOf(c);
          expect(ch.G, c.name).toEqual([]);
          expect(ch.B, c.name).toEqual([]);
        }
      }
    });

    it("does not put a credential-shaped value in a written pair", () => {
      for (const w of WRITTEN_PAIRS) {
        const t = [w.before, w.after, w.locks?.before ?? "", w.locks?.after ?? ""].join("\n");
        expect(/sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{12,}|xox[bp]-|-----BEGIN/.test(t), w.name).toBe(false);
      }
    });
  });

  describe("the results", () => {
    it("holds the results of every pair, and the lock views where a lock is given", () => {
      for (const c of all) {
        const slots = [...Object.keys(c.results), ...Object.keys(c.texts)].sort();
        const locked = c.locks.before !== null || c.locks.after !== null;
        expect(slots, c.name).toEqual((locked ? ["diff", "envelope_changes", "governance_changes", "lock_diff", "lock_limits_diff"] : ["diff", "envelope_changes", "governance_changes"]).sort());
      }
    });

    it("renders the Markdown and the HTML from the same document, and the digest of the HTML is its text's", () => {
      for (const c of all) {
        const p = pairs.find((x) => x.name === c.name)!;
        const html = toHtml(diffDoc(p.programs.before, p.programs.after, p.locks));
        expect(c.html_length, c.name).toBe(html.length);
        expect(c.html_sha256, c.name).toBe(sha256(html));
        expect(c.markdown, c.name).toBe(toMarkdown(diffDoc(p.programs.before, p.programs.after, p.locks)));
        const onDisk = cases.find((x) => x.name === c.name)!;
        if (onDisk.html !== undefined) expect(onDisk.html, c.name).toBe(html);
      }
    });

    it("stores the HTML whole for the cases the rule names, and only its digest and length for the others", () => {
      for (const c of cases) {
        const whole = HTML_WHOLE_SOURCES.includes(c.source) || (c.source === "written" && HTML_WHOLE_WRITTEN.includes(c.name));
        expect(c.html !== undefined, c.name).toBe(whole);
      }
      for (const n of HTML_WHOLE_WRITTEN) expect(cases.some((c) => c.name === n), n).toBe(true);
    });

    it("gives the same results when it runs again (no clock, no locale, no directory order)", () => {
      const again = [...conformancePairs().patches, ...conformancePairs().amendments, ...repositoryPairs(), ...lockPairs(), ...writtenPairs()].map(diffCase);
      expect(vectorText(again)).toBe(vectorText(all));
    });

    it("holds, for each result that has a number JSON readers refuse, its exact text", () => {
      for (const c of all) for (const [slot, t] of Object.entries(c.texts)) expect(hasOtherNumber(JSON.parse(t)) && !(slot in c.results), `${c.name} ${slot}`).toBe(true);
    });
  });

  describe("the kinds of change", () => {
    const { table, unclassified } = coverage(all);

    it("shows every kind of change the code can report in at least one case, except those it has no input for", () => {
      const missing = table.filter((t) => t.cases === 0 && !t.unreachable).map((t) => `${t.section} ${t.id}`);
      expect(missing).toEqual([]);
    });

    it("says which kinds no input reaches, and finds none of them in the outputs", () => {
      const unreachable = table.filter((t) => t.unreachable);
      expect(unreachable.map((t) => t.id)).toEqual(["cap.command_added", "cap.unbounded", "envelope.budget.agents.limit_removed", "envelope.budget.agents.limit_added"]);
      for (const t of unreachable) expect(t.cases, `${t.id} is reached now: remove its reason`).toBe(0);
    });

    it("names the kinds from the code's own lists: the definition kinds, the budget dimensions, the data classes and the governance change kinds", () => {
      expect(defKinds()).toEqual(["type", "capability", "const", "fn", "extern", "effect", "agent", "workflow", "contract", "component", "interface", "environment", "role"]);
      expect(governanceKinds()).toEqual(["capability_added", "budget_increased", "criterion_removed", "criterion_changed", "require_changed", "irreversible_added", "system_model_changed", "envelope_changed", "remote_agent_added", "remote_binding_changed", "kind_changed"]);
      expect([...BUDGET_DIMENSIONS]).toEqual(["tokens", "steps", "time", "spend", "agents"]);
      expect(DATA_CLASSES).toEqual(["public", "internal", "confidential", "restricted"]);
    });

    it("changes a capability of every constructor of the standard library, in some case", () => {
      const reached = new Set<string>();
      for (const p of pairs) {
        const c = all.find((x) => x.name === p.name)!;
        const lines = [...changesOf(c).G, ...changesOf(c).B, ...(c.results["governance_changes"] ? (c.results["governance_changes"] as Change[]) : [])].map((x) => x.text);
        const source = [p.before, p.after].map((s) => ("text" in s ? s.text : readRepo(s.file))).join("\n");
        for (const ctor of Object.keys(CAP_CTORS)) {
          const names = [...source.matchAll(new RegExp(`capability (\\w+)\\s*=\\s*${ctor.replace(".", "\\.")}\\(`, "g"))].map((m) => m[1]!);
          if (names.some((n) => lines.some((l) => l.includes(` ${n}:`) || l.includes(`capability ${n} `) || l.includes(`capability ${n}`)))) reached.add(ctor);
        }
      }
      expect([...reached].sort()).toEqual(Object.keys(CAP_CTORS).sort());
    });

    it("leaves no change of the stored outputs outside the kinds the table names", () => {
      expect(unclassified).toEqual([]);
    });
  });
});
