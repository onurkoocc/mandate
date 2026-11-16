// The operator's directory of libraries, read from the file system (language 0.6, spec/library.md "The local
// directory"): `<dir>/<name>/<version>/` holds a library's `mandate.library.json`, the module files it lists, and
// the `index.json` that `mandate publish` writes last. The compiler reads no file: a caller reads the directory here
// and hands the texts to its doors (library.ts), which decide everything. This is the bridge's third entry point,
// `@mandate/bridge/libraries`, for the two command lines (cli-library.ts, and the runtime's `run`).
//
// What is read here is chosen by three texts that come from files a person did not write on the command line: a
// library's name and version, from a lock, and the paths of a library's module files, from its manifest. None may
// lead out of the directory it is read under, so each is held, before any file is touched, to the very rule the
// compiler holds it to (crates/mandate-lib: `check_name`, `Version::parse`, `check_module_path`, each an allow-list):
// lower-case dotted names, `MAJOR.MINOR.PATCH`, and relative paths of plain segments ending in `.mdt` or `.json`.
// So no `..`, no absolute path, no `\`, no `:`, no NUL and no device name is ever joined to a directory. A text the
// rule refuses is not read; the compiler, given what was read, then reports the lock or the manifest as it is.
//
// Paths are joined as the native command line joins them (Rust's `Path::join`): the directory, the platform's
// separator, the name, nothing normalized, so that the two command lines print and write the same paths.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { kindOf, libraryVerify, load, type LibrarySource, type Modules, type PublishedVersion } from "./index.js";

/** The manifest's file name in a library's directory. */
export const MANIFEST = "mandate.library.json";
/** The file `mandate publish` writes last into a version's directory. */
export const INDEX = "index.json";
/** The library built into the compiler, which no directory holds and no package carries. */
export const STD_PATTERNS = "std.patterns";

// ── the rules a name, a version and a module path are held to ───────────

const DEVICE_NAMES = new Set(["con", "prn", "aux", "nul", ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap((n) => [`com${n}`, `lpt${n}`])]);
const NAME_SEGMENT = /^[a-z_][a-z0-9_]*$/;
const PATH_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Whether `name` is a library's (or a module's) name: segments of `[a-z_][a-z0-9_]*` joined by `.`, at most 128 bytes, none a Windows device name. */
export function isLibraryName(name: unknown): name is string {
  if (typeof name !== "string" || name === "" || name.length > 128) return false;
  return name.split(".").every((s) => NAME_SEGMENT.test(s) && !DEVICE_NAMES.has(s));
}

/** A version, `MAJOR.MINOR.PATCH`: three decimal numbers without a leading zero, each at most 999 999 999; undefined for any other text. */
export function parseVersion(text: unknown): [number, number, number] | undefined {
  if (typeof text !== "string") return undefined;
  const parts = text.split(".");
  if (parts.length !== 3 || !parts.every(isComponent)) return undefined;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

const isComponent = (s: string): boolean => /^(0|[1-9][0-9]{0,8})$/.test(s);

/** The order of two versions, component by component. */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
  return 0;
}

/**
 * Whether the range `range` (`^MAJOR`, `^MAJOR.MINOR`, `^MAJOR.MINOR.PATCH`, or an exact version) holds `version`,
 * as the compiler reads a range (crates/mandate-lib, `Range::holds`): a caret range holds the versions not below the
 * one it names that agree with it up to its pivot, the first nonzero component among those written, or the last one
 * written when they are all zero. A text that is no range holds nothing.
 */
export function rangeHolds(range: unknown, version: readonly number[]): boolean {
  if (typeof range !== "string") return false;
  if (!range.startsWith("^")) {
    const exact = parseVersion(range);
    return exact !== undefined && compareVersions(exact, version) === 0;
  }
  const written = range.slice(1).split(".");
  if (written.length < 1 || written.length > 3 || !written.every(isComponent)) return false;
  const named = [0, 1, 2].map((i) => (i < written.length ? Number(written[i]) : 0));
  if (compareVersions(version, named) < 0) return false;
  const nonzero = named.slice(0, written.length).findIndex((c) => c !== 0);
  const pivot = nonzero >= 0 ? nonzero : written.length - 1;
  return named.slice(0, pivot + 1).every((c, i) => version[i] === c);
}

/**
 * Whether `path` is the path of a module file as a manifest may list one (crates/mandate-lib, `check_module_path`):
 * printable ASCII, at most 200 bytes, no `\` and no `:`, not absolute, its segments `[A-Za-z0-9_][A-Za-z0-9_.-]*` of
 * at most 64 bytes that are not `.` or `..`, do not end in a dot and are no Windows device name, ending in `.mdt`
 * or `.json`, and not the manifest or the index themselves.
 */
export function isModulePath(path: unknown): path is string {
  if (typeof path !== "string" || path === "" || path.length > 200) return false;
  if (!/^[\x20-\x7e]*$/.test(path) || path.includes("\\") || path.includes(":") || path.startsWith("/")) return false;
  const segments = path.split("/");
  for (const s of segments) {
    if (s === "." || s === ".." || s.length > 64 || !PATH_SEGMENT.test(s) || s.endsWith(".")) return false;
    if (DEVICE_NAMES.has(s.split(".")[0]!.toLowerCase())) return false;
  }
  if (!(path.endsWith(".mdt") || path.endsWith(".json"))) return false;
  return ![MANIFEST, INDEX].includes(segments[0]!.toLowerCase());
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A library as a lock pins it, as far as the directory is read by it. */
export interface Pin {
  version: string;
  digest: string;
}

/**
 * The libraries a lock pins, by name in the order of their names, as the compiler reads the lock's `libraries`
 * (crates/mandate-lib, `read_lock_libraries`): each `{ version, digest, modules }` and nothing else, under a
 * library's name, its version a version, its digest and its modules' hashes digests, each module named as its
 * library or under it. A lock whose `libraries` has any problem pins nothing here: no part of it is taken as a
 * path, and the compiler reports the lock (E0140).
 */
export function lockPins(lock: unknown): Record<string, Pin> {
  const libraries = isObj(lock) ? lock["libraries"] : undefined;
  if (!isObj(libraries)) return {};
  const out: Record<string, Pin> = {};
  for (const name of Object.keys(libraries).sort()) {
    const pin = libraries[name];
    if (!isLibraryName(name) || !isObj(pin) || Object.keys(pin).sort().join() !== "digest,modules,version") return {};
    const { version, digest, modules } = pin;
    if (typeof version !== "string" || !parseVersion(version) || typeof digest !== "string" || !DIGEST.test(digest) || !isObj(modules) || !Object.keys(modules).length) return {};
    for (const [module, hash] of Object.entries(modules)) {
      const belongs = module === name || module.startsWith(`${name}.`);
      if (!isLibraryName(module) || !belongs || typeof hash !== "string" || !DIGEST.test(hash)) return {};
    }
    out[name] = { version, digest };
  }
  return out;
}

/** Whether a lock pins a library at all. */
export function pinsLibraries(lock: unknown): boolean {
  return isObj(lock) && isObj(lock["libraries"]) && Object.keys(lock["libraries"]).length > 0;
}

// ── paths, as the native command line writes them ───────────────────────

/** The path of `name` in the directory `dir`; `name` itself when it is an absolute path. Nothing is normalized. */
export function joinPath(dir: string, name: string): string {
  if (isAbsolute(name) || dir === "") return name;
  return dir.endsWith("/") || dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** The path of `name` beside `file`: in its directory, or `name` alone when `file` is a bare name. */
export function beside(file: string, name: string): string {
  const dir = dirname(file);
  return dir === "" || dir === "." ? name : joinPath(dir, name);
}

// ── the files ───────────────────────────────────────────────────────────

/** The file system a command reads and writes, its relative paths taken from `cwd`. */
export class Files {
  constructor(readonly cwd: string = process.cwd()) {}

  private at(path: string): string {
    return resolve(this.cwd, path);
  }

  /** The text of `file`, decoded as UTF-8 (an ill-formed sequence is U+FFFD). Throws what the file system throws. */
  read(file: string): string {
    return readFileSync(this.at(file), "utf8");
  }

  /** The text of `file`, or undefined when it cannot be read. */
  textOf(file: string): string | undefined {
    try {
      return this.read(file);
    } catch {
      return undefined;
    }
  }

  /** The text of `file`, or undefined when it is not there. Throws when it is there and cannot be read. */
  readIfThere(file: string): string | undefined {
    try {
      return this.read(file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw e;
    }
  }

  /** The names of the directories in `dir`, sorted; none when `dir` cannot be listed. */
  directories(dir: string): string[] {
    let names: string[];
    try {
      names = readdirSync(this.at(dir));
    } catch {
      return [];
    }
    const isDir = (name: string): boolean => {
      try {
        return statSync(this.at(joinPath(dir, name))).isDirectory();
      } catch {
        return false;
      }
    };
    return names.filter(isDir).sort();
  }

  write(file: string, text: string): void {
    writeFileSync(this.at(file), text);
  }

  makeDir(dir: string): void {
    mkdirSync(this.at(dir), { recursive: true });
  }
}

/** A manifest as far as the directory is read by it: its name, its module files and what it requires, each when it is what the compiler would read. */
export interface ManifestRead {
  name?: string;
  /** The module files it lists; none when any of them is no module path (the compiler does not read such a manifest). */
  modules: string[];
  /** Each library it requires, with its range. */
  requires: Record<string, string>;
}

/**
 * What a manifest's text names of the file system. A manifest the compiler does not read (it is not JSON, or lists
 * a path that is no module path) names no file here: it is handed to the compiler alone, which reports it (E1601).
 */
export function readManifest(text: string): ManifestRead {
  let m: unknown;
  try {
    m = JSON.parse(text);
  } catch {
    return { modules: [], requires: {} };
  }
  if (!isObj(m)) return { modules: [], requires: {} };
  const listed = Array.isArray(m["modules"]) ? (m["modules"] as unknown[]) : [];
  const modules = listed.every(isModulePath) ? (listed as string[]) : [];
  const requires = isObj(m["requires"]) ? Object.fromEntries(Object.entries(m["requires"]).filter((e): e is [string, string] => isLibraryName(e[0]) && typeof e[1] === "string")) : {};
  return { ...(isLibraryName(m["name"]) ? { name: m["name"] } : {}), modules, requires };
}

/**
 * The library in the directory `dir`: its manifest, and each module file the manifest lists that is there (one that
 * is missing is left out, so that the compiler says so). Undefined when there is no manifest.
 */
export function libraryIn(fs: Files, dir: string): LibrarySource | undefined {
  const manifest = fs.textOf(joinPath(dir, MANIFEST));
  if (manifest === undefined) return undefined;
  const files: Record<string, string> = {};
  for (const path of readManifest(manifest).modules) {
    const text = fs.textOf(joinPath(dir, path));
    if (text !== undefined) files[path] = text;
  }
  return { manifest, files };
}

/** A library that is not there, as the doors take one: no manifest, no file. */
export const NO_LIBRARY: LibrarySource = { manifest: "", files: {} };

/** Every version directory of `library` in `dir`, by name: one that has a manifest or an `index.json`. None for what is no library's name. */
export function versionsIn(fs: Files, dir: string, library: string): PublishedVersion[] {
  if (!isLibraryName(library)) return [];
  const home = joinPath(dir, library);
  const out: PublishedVersion[] = [];
  for (const version of fs.directories(home)) {
    const at = joinPath(home, version);
    const source = libraryIn(fs, at);
    const index = fs.textOf(joinPath(at, INDEX));
    if (source !== undefined || index !== undefined) out.push({ version, library: source ?? NO_LIBRARY, index: index ?? null });
  }
  return out;
}

/**
 * The libraries `lock` pins, each read from `dir` at the version it is pinned at; but the built-in one, and
 * `except`. One that is not in the directory is left out, so that the compiler says so.
 */
export function pinnedIn(fs: Files, lock: unknown, dir: string, except?: string): LibrarySource[] {
  const out: LibrarySource[] = [];
  for (const [name, pin] of Object.entries(lockPins(lock))) {
    if (name === STD_PATTERNS || name === except) continue;
    const source = libraryIn(fs, joinPath(joinPath(dir, name), pin.version));
    if (source) out.push(source);
  }
  return out;
}

/**
 * The libraries `lock` pins, read from the directory `dir` (relative to the working directory, or absolute): what
 * a caller that builds a package hands the compiler and puts in the package. The bridge's entry point exports it,
 * so that the runtime reads a directory of libraries by the rules the command line reads it by, and by no other.
 */
export function pinnedLibraries(lock: unknown, dir: string): LibrarySource[] {
  return pinnedIn(new Files(), lock, dir);
}

/**
 * The modules of the libraries that read, by the name each declares: what a view of a program is given of its
 * libraries, besides the caller's modules. A library the compiler does not read (`library_verify` names none) gives
 * none.
 */
export function modulesOf(libraries: LibrarySource[]): Modules {
  const out: Modules = {};
  for (const library of libraries) {
    if (libraryVerify(library).name === undefined) continue;
    for (const [path, text] of Object.entries(library.files)) {
      const program = load(text, kindOf(path)).program;
      if (program && !Object.hasOwn(out, program.module)) out[program.module] = program;
    }
  }
  return out;
}
