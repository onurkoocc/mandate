// Libraries on the command line (language 0.6, spec/library.md "Libraries"): the runtime's configuration as far as
// the libraries go, the libraries a lock pins handed to a check, and `mandate add`, `upgrade` and `publish`.
//
// The compiler decides everything (the doors of library.ts): this module reads the files it is to be given
// (libraries.ts), prints what it answers, and writes what it says to write, the lock or the published version. The
// native command line (crates/mandate-cli, src/libraries.rs) set the forms: the same arguments are answered with the
// same standard output, the same exit status and the same files written.
//
//   mandate add <library>[@<range>] [--lock <lock.json>] [--libraries <dir>] [--config <file>] [--json]
//   mandate upgrade <library>[@<range>] [--accept-governance] [--lock <lock.json>] [--libraries <dir>] [--config <file>] [--json]
//   mandate publish <source dir> [--libraries <dir>] [--config <file>] [--json]
//
// The directory of libraries is the one `--libraries` names, or else `libraries.dir` of the configuration
// (`--config <file>`, or `mandate.runtime.json` of the working directory), relative to the configuration. Of the
// configuration only its `libraries` member is read: `{ dir, wait_days?, revoked? }`.

import { dirname } from "node:path";
import {
  formatDiagnostic,
  hasErrors,
  librariesConfigProblems,
  libraryAdd,
  libraryPublish,
  libraryUpgrade,
  LOCK_FORMAT_06,
  parseStrictJson,
  type Diagnostic,
  type LibrariesConfig,
  type LibraryChange,
  type LibraryResolved,
  type LibrarySource,
  type Lock,
  type Modules,
} from "./index.js";
import { beside, compareVersions, Files, isLibraryName, isModulePath, joinPath, libraryIn, lockPins, INDEX, MANIFEST, modulesOf, NO_LIBRARY, parseVersion, pinnedIn, pinsLibraries, rangeHolds, readManifest, STD_PATTERNS, versionsIn } from "./libraries.js";

/** The lock a command reads when `--lock` names none, in the working directory. */
const LOCK = "mandate.lock.json";
/** The configuration a command reads when `--config` names none and the working directory has it. */
const CONFIG = "mandate.runtime.json";

/** What a command is run with: its files, its clock, and its two streams. */
export interface Io {
  fs: Files;
  /** The time, in seconds since 1970-01-01T00:00:00Z. */
  now(): number;
  out(text: string): void;
  err(text: string): void;
}

/** A command that ended before its end, with its exit status; what it had to say is already written. */
export class Stop {
  constructor(readonly code: number) {}
}

/** The arguments the library commands and options read. */
export interface LibraryArgs {
  positional: string[];
  /** `--lock <file>`. */
  lock?: string;
  /** `--libraries <dir>`. */
  libraries?: string;
  /** `--config <file>`. */
  config?: string;
  json: boolean;
  /** `--accept-governance`. */
  acceptGovernance?: boolean;
}

/** What a check of a program is given of the libraries its lock pins. */
export interface Given {
  /** The libraries, as read from the directory. */
  libraries: LibrarySource[];
  /** The configuration's `libraries` member, whose revoked digests a pin is held to (E1608), when there is one. */
  config?: LibrariesConfig;
}

/** The options of a check with what it is given: `libraries` when there are any, `config` when there is one. */
export function givenOptions(g: Given): { libraries?: LibrarySource[]; config?: LibrariesConfig } {
  return { ...(g.libraries.length ? { libraries: g.libraries } : {}), ...(g.config ? { config: g.config } : {}) };
}

/** `modules` and the modules of the libraries that read: what a view is given. */
export function withModules(g: Given, modules: Modules): Modules {
  return g.libraries.length ? { ...modules, ...modulesOf(g.libraries) } : modules;
}

/** Says `mandate: <message>` on standard error; the stop with `code`. */
function fail(io: Io, code: number, message: string): Stop {
  io.err(`mandate: ${message}\n`);
  return new Stop(code);
}

/** The diagnostics as `{ ok, diagnostics }` on standard output, or one a line on standard error. */
function report(io: Io, diagnostics: Diagnostic[], file: string, asJson: boolean): void {
  if (asJson) io.out(JSON.stringify({ ok: !hasErrors(diagnostics), diagnostics }, null, 2) + "\n");
  else say(io, diagnostics, file);
}

/** Reports `diagnostics` against `file`, one a line on standard error. */
function say(io: Io, diagnostics: Diagnostic[], file: string): void {
  for (const d of diagnostics) io.err(formatDiagnostic(d, file) + "\n");
}

/** The text of `file`; the stop with 2 when it cannot be read. */
function read(io: Io, file: string): string {
  try {
    return io.fs.read(file);
  } catch (e) {
    throw fail(io, 2, `cannot read ${file}: ${(e as Error).message}`);
  }
}

/** The text of `file`, or undefined when it is not there. */
function readIfThere(io: Io, file: string): string | undefined {
  try {
    return io.fs.readIfThere(file);
  } catch (e) {
    throw fail(io, 2, `cannot read ${file}: ${(e as Error).message}`);
  }
}

/** `text` read as strict JSON; its diagnostics reported against `file` and the stop with 1 when it is not. */
function strictJson(io: Io, text: string, file: string, asJson: boolean): unknown {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) {
    report(io, parsed.diagnostics, file, asJson);
    throw new Stop(1);
  }
  return parsed.value.value;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The configuration, as far as the libraries go: the file it was read from, and its `libraries` member when it has one. */
interface Config {
  file: string;
  libraries?: LibrariesConfig;
}

/**
 * The configuration `--config` names, or `mandate.runtime.json` of the working directory when it is there; only its
 * `libraries` member is read (the rest is the runtime's), and by the compiler's own reader: a member it does not know
 * is refused, not read as nothing.
 */
function config(io: Io, a: LibraryArgs): Config | undefined {
  let file = a.config;
  let text: string;
  if (file !== undefined) text = read(io, file);
  else {
    const there = readIfThere(io, CONFIG);
    if (there === undefined) return undefined;
    [file, text] = [CONFIG, there];
  }
  const value = strictJson(io, text, file, a.json);
  if (!isObj(value)) throw fail(io, 2, `${file} is not a configuration: it is not an object`);
  const member = value["libraries"];
  if (member === undefined) return { file };
  const problems = librariesConfigProblems(member);
  if (problems.length) throw fail(io, 2, `${file}: its member libraries is not { dir, wait_days?, revoked? }: ${problems.join(", ")}`);
  return { file, libraries: member as LibrariesConfig };
}

/** The directory of libraries: the one `--libraries` names, or else the configuration's `libraries.dir`, relative to the configuration. */
function librariesDir(a: LibraryArgs, c: Config | undefined): string | undefined {
  if (a.libraries !== undefined) return a.libraries;
  return c?.libraries ? beside(c.file, c.libraries.dir) : undefined;
}

/** The directory of libraries, or the stop that says none is named. */
function neededDir(io: Io, dir: string | undefined): string {
  if (dir !== undefined) return dir;
  throw fail(io, 2, "no directory of libraries: name it with --libraries <dir>, or as libraries.dir of the configuration (--config <file>, or mandate.runtime.json)");
}

/**
 * What a check of a program with `lock` is given: the libraries the lock pins, read from the directory, and the
 * configuration's `libraries`. A lock that pins none reads no configuration and no directory.
 */
export function given(io: Io, a: LibraryArgs, lock: unknown): Given {
  if (!pinsLibraries(lock)) return { libraries: [] };
  const c = config(io, a);
  const dir = librariesDir(a, c);
  return { libraries: dir !== undefined ? pinnedIn(io.fs, lock, dir) : [], ...(c?.libraries ? { config: c.libraries } : {}) };
}

/** The time, as the doors take it: `YYYY-MM-DDTHH:MM:SSZ`. */
function now(io: Io): string {
  const seconds = io.now();
  const at = new Date(seconds * 1000);
  const year = Number.isInteger(seconds) && !Number.isNaN(at.getTime()) ? at.getUTCFullYear() : -1;
  if (year < 1970 || year > 9999) throw fail(io, 2, `the clock gives ${seconds} seconds since 1970, which is not a time`);
  return at.toISOString().slice(0, 19) + "Z";
}

/**
 * The lock `mandate add` and `upgrade` work on, and its file: the one `--lock` names or `mandate.lock.json` of the
 * working directory; a file that is not there is a lock of 0.6 that pins nothing.
 */
function lockToChange(io: Io, a: LibraryArgs): { file: string; lock: Lock } {
  const file = a.lock ?? LOCK;
  const text = readIfThere(io, file);
  const lock = text !== undefined ? strictJson(io, text, file, a.json) : { lock: LOCK_FORMAT_06, modules: {} };
  if (!isObj(lock)) throw fail(io, 2, `${file} is not a lock: it is not an object`);
  return { file, lock: lock as unknown as Lock };
}

/** One line for each governance change and each other change of a comparison, as `mandate patch` writes a governance change. */
function changeLines(governance: LibraryChange[], behavior: LibraryChange[]): string {
  return governance.map((g) => `governance change: ${g.kind} at ${g.at}: ${g.text}\n`).join("") + behavior.map((b) => `behavior change: at ${b.at}: ${b.text}\n`).join("");
}

/**
 * What `add` and `upgrade` print of an outcome that resolved a version: the library with its version and digest (an
 * upgrade names the version it comes from), an upgrade's changes, then the authority signature.
 */
function resolvedText(library: string, from: string | undefined, r: LibraryResolved): string {
  if (r.version === undefined || r.digest === undefined) return "";
  const compared = r.governance !== undefined;
  const head = compared && from !== undefined ? `${library} ${from} -> ${r.version} ${r.digest}\n` : `${library} ${r.version} ${r.digest}\n`;
  return head + (compared ? changeLines(r.governance ?? [], r.behavior ?? []) : "") + "authority signature:\n" + JSON.stringify(r.signature, null, 2) + "\n";
}

/** `mandate add <library>[@<range>]` and, with `upgrading`, `mandate upgrade <library>[@<range>] [--accept-governance]`. */
function add(io: Io, a: LibraryArgs, upgrading: boolean, usage: () => Stop): number {
  const spec = a.positional[0];
  if (spec === undefined) throw usage();
  const at = spec.indexOf("@");
  const [library, range] = at < 0 ? [spec, undefined] : [spec.slice(0, at), spec.slice(at + 1)];
  if (!isLibraryName(library)) throw fail(io, 2, `${library} is not the name of a library`);
  const { file: lockFile, lock } = lockToChange(io, a);
  const c = config(io, a);
  // The built-in library needs no directory: its one version is the compiler's own copy.
  const dir = library === STD_PATTERNS ? librariesDir(a, c) : neededDir(io, librariesDir(a, c));
  const pinnedVersion = lockPins(lock)[library]?.version;
  const versions = dir !== undefined && library !== STD_PATTERNS ? versionsIn(io.fs, dir, library) : [];
  const pinned = dir !== undefined && pinnedVersion !== undefined ? libraryIn(io.fs, joinPath(joinPath(dir, library), pinnedVersion)) : undefined;
  const libraries = dir !== undefined ? pinnedIn(io.fs, lock, dir, library) : [];
  const request = { library, ...(range !== undefined ? { range } : {}), lock, versions, libraries, ...(c?.libraries ? { config: c.libraries } : {}), now: now(io) };
  const outcome = upgrading ? libraryUpgrade({ ...request, pinned: pinned ?? NO_LIBRARY, accept_governance: a.acceptGovernance === true }) : libraryAdd(request);
  if (a.json) io.out(JSON.stringify(outcome, null, 2) + "\n");
  else {
    say(io, outcome.diagnostics, lockFile);
    io.out(resolvedText(library, pinnedVersion, outcome));
  }
  // The lock is written only when the compiler gives one: never with an error, and never over a governance change
  // that was not accepted.
  if (outcome.ok && outcome.lock) {
    write(io, lockFile, JSON.stringify(outcome.lock, null, 2) + "\n");
    if (!a.json) io.out(`wrote ${lockFile}\n`);
    return 0;
  }
  const held = outcome.governance?.length ?? 0;
  if (outcome.ok && held > 0 && !a.json) io.out(`not written: ${held} governance change(s); ${lockFile} is written only with --accept-governance\n`);
  return 1;
}

/** Writes `text` as `file`; the stop with 2 when it cannot be written. */
function write(io: Io, file: string, text: string): void {
  try {
    io.fs.write(file, text);
  } catch (e) {
    throw fail(io, 2, `cannot write ${file}: ${(e as Error).message}`);
  }
}

/** Makes the directory `dir`; the stop with 2 when it cannot be made. */
function makeDir(io: Io, dir: string): void {
  try {
    io.fs.makeDir(dir);
  } catch (e) {
    throw fail(io, 2, `cannot make ${dir}: ${(e as Error).message}`);
  }
}

/** `mandate publish <source dir>`. */
function publish(io: Io, a: LibraryArgs, usage: () => Stop): number {
  const sourceDir = a.positional[0];
  if (sourceDir === undefined) throw usage();
  const manifestFile = joinPath(sourceDir, MANIFEST);
  // A source without a manifest is not a library at all.
  read(io, manifestFile);
  const source = libraryIn(io.fs, sourceDir) ?? NO_LIBRARY;
  const dir = neededDir(io, librariesDir(a, config(io, a)));
  // What the directory holds of it, and of what it requires: of each required library, the highest published
  // version within the range.
  const manifest = readManifest(source.manifest);
  const published = manifest.name !== undefined ? versionsIn(io.fs, dir, manifest.name) : [];
  const libraries: LibrarySource[] = [];
  for (const required of manifest.name !== undefined ? Object.keys(manifest.requires).sort() : []) {
    if (required === STD_PATTERNS) continue;
    let best: { version: [number, number, number]; library: LibrarySource } | undefined;
    for (const p of versionsIn(io.fs, dir, required)) {
      const version = parseVersion(p.version);
      if (p.index === null || !version || !rangeHolds(manifest.requires[required], version)) continue;
      if (!best || compareVersions(version, best.version) > 0) best = { version, library: p.library };
    }
    if (best) libraries.push(best.library);
  }
  const publication = libraryPublish({ source, published, libraries, now: now(io) });
  if (a.json) io.out(JSON.stringify(publication, null, 2) + "\n");
  else {
    say(io, publication.diagnostics, manifestFile);
    io.out(publication.against.flatMap((v) => v.governance.map((g) => `against ${v.version}: governance change: ${g.kind} at ${g.at}: ${g.text}\n`)).join(""));
  }
  // Nothing is written of a publication the compiler refuses (E1607 among them).
  const { name, version, digest, files, index } = publication;
  if (!publication.ok || name === undefined || version === undefined || typeof index !== "string" || !files) return 1;
  // Where it is written is named by the library itself: its name, its version, its module files. Each is held once
  // more to the rule that keeps it inside the directory, whatever the compiler said.
  const outside = [!isLibraryName(name) ? name : undefined, !parseVersion(version) ? version : undefined, ...Object.keys(files).filter((p) => p !== MANIFEST && !isModulePath(p))].filter((x) => x !== undefined);
  if (outside.length) throw fail(io, 2, `not published: ${outside.join(", ")} would not be written inside ${dir}`);
  const target = joinPath(joinPath(dir, name), version);
  makeDir(io, target);
  for (const [path, text] of Object.entries(files)) {
    const file = joinPath(target, path);
    if (path.includes("/")) makeDir(io, dirname(file));
    write(io, file, text);
  }
  // The index last: a directory without it was never published.
  write(io, joinPath(target, INDEX), index);
  if (!a.json) io.out(`published ${name} ${version} ${digest} to ${target}\n`);
  return 0;
}

/**
 * Runs `mandate add`, `upgrade` or `publish` and gives its exit status: 0 when the lock or the version was written,
 * 1 when a diagnostic is an error or nothing was written, 2 on a usage error or a file that cannot be read or
 * written.
 */
export function libraryCommand(cmd: "add" | "upgrade" | "publish", a: LibraryArgs, io: Io, usage: () => Stop): number {
  try {
    return cmd === "publish" ? publish(io, a, usage) : add(io, a, cmd === "upgrade", usage);
  } catch (e) {
    if (e instanceof Stop) return e.code;
    throw e;
  }
}
