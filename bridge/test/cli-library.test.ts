// Libraries on the `mandate` command line (bridge/src/cli-library.ts, libraries.ts): `add`, `upgrade` and `publish`,
// `--libraries` and `--config`, and the checking commands with the libraries a lock pins. The native command line
// (crates/mandate-cli) set the forms, and its tests (tests/cli.rs) the texts expected here: the same arguments give
// the same standard output, the same exit status and the same files, paths written with the platform's separator.
//
// The library commands run in this process over a temporary directory, with a clock of their own (the waiting period
// is a matter of days); the checking commands, and the library commands once more, run as the command line itself, a
// child process built into a temporary directory (tree.ts).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { libraryCommand, Stop, type LibraryArgs } from "../src/cli-library.js";
import { authoritySignature, canonicalize, librariesConfigProblems, libraryAdd, libraryPublish, libraryUpgrade, libraryVerify, type Json, type LibrarySource } from "../src/index.js";
import { beside, Files, isLibraryName, isModulePath, joinPath, libraryIn, lockPins, parseVersion, pinnedIn, rangeHolds, readManifest, versionsIn } from "../src/libraries.js";
import { modulePath } from "../src/wasm/module.js";
import { buildTree, repoRoot, type Tree } from "./tree.js";

// The tests here start the executable many times each: the default five seconds is too little on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

const OPS = "fixtures/library/upgrade/acme.ops";
const VERSIONS = ["1.0.0", "1.0.1", "1.1.0", "1.2.0", "2.0.0"];
const repo = (rel: string): string => readFileSync(join(repoRoot, rel), "utf8");
/** A path the command line made by joining, as it writes it on this platform. */
const P = (path: string): string => path.replaceAll("/", sep);
const seconds = (time: string): number => Date.parse(time) / 1000;
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** The digest of the library in a directory of the repository. */
function digestOf(dir: string): string {
  return libraryVerify(libraryIn(new Files(repoRoot), dir)!).digest!;
}

/** A working directory of its own, with a clock: what a library command is run over. */
class World {
  readonly dir = mkdtempSync(join(tmpdir(), "mdt-cli-library-"));
  now = seconds("2026-11-15T00:00:00Z");
  out = "";
  err = "";

  constructor() {
    dirs.push(this.dir);
  }

  /** `mandate <args>` in the working directory; the two streams are emptied first. */
  mandate(...argv: string[]): number {
    this.out = "";
    this.err = "";
    const [cmd, ...rest] = argv;
    const a: LibraryArgs = { positional: [], json: false };
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i]!;
      if (x === "--lock") a.lock = rest[++i]!;
      else if (x === "--libraries") a.libraries = rest[++i]!;
      else if (x === "--config") a.config = rest[++i]!;
      else if (x === "--json") a.json = true;
      else if (x === "--accept-governance") a.acceptGovernance = true;
      else a.positional.push(x);
    }
    const io = { fs: new Files(this.dir), now: () => this.now, out: (s: string) => void (this.out += s), err: (s: string) => void (this.err += s) };
    return libraryCommand(cmd as "add", a, io, () => {
      this.err += "usage: mandate <command> [options]\n";
      return new Stop(2);
    });
  }

  put(rel: string, text: string): void {
    mkdirSync(dirname(join(this.dir, rel)), { recursive: true });
    writeFileSync(join(this.dir, rel), text);
  }

  text(rel: string): string | undefined {
    return existsSync(join(this.dir, rel)) ? readFileSync(join(this.dir, rel), "utf8") : undefined;
  }

  remove(rel: string): void {
    rmSync(join(this.dir, rel), { recursive: true, force: true });
  }

  /** Every file under the working directory, with its text. */
  files(): Record<string, string> {
    const found: Record<string, string> = {};
    const walk = (d: string, rel: string): void => {
      for (const name of readdirSync(d).sort()) {
        if (statSync(join(d, name)).isDirectory()) walk(join(d, name), `${rel}${name}/`);
        else found[rel + name] = readFileSync(join(d, name), "utf8");
      }
    };
    walk(this.dir, "");
    return found;
  }

  /** The version the lock pins acme.ops at. */
  pinned(lock = "mandate.lock.json"): string | undefined {
    const text = this.text(lock);
    return text === undefined ? undefined : (JSON.parse(text) as { libraries?: Record<string, { version: string }> }).libraries?.["acme.ops"]?.version;
  }
}

/** The operator's directory `libs` with these versions of acme.ops, each as the repository holds it (published, with its index). */
function opsWorld(versions: string[] = VERSIONS): World {
  const w = new World();
  for (const v of versions) cpSync(join(repoRoot, OPS, v), join(w.dir, "libs", "acme.ops", v), { recursive: true });
  return w;
}

/** The version `v` of acme.ops as the source directory `src`. */
function opsSource(w: World, v: string): void {
  for (const f of ["mandate.library.json", "ops.mdt"]) w.put(`src/${f}`, repo(`${OPS}/${v}/${f}`));
}

/** The lock that pins acme.ops 1.0.0 (the one of conformance/L02). */
const opsLock = (w: World): void => w.put("mandate.lock.json", repo("conformance/L02/mandate.lock.json"));

describe("mandate add", () => {
  it("pins the highest version within the range and writes the lock", () => {
    const w = opsWorld();
    expect(w.mandate("add", "acme.ops@^1.0", "--libraries", "libs"), w.err).toBe(0);
    const digest = digestOf(`${OPS}/1.2.0`);
    expect(w.out.startsWith(`acme.ops 1.2.0 ${digest}\nauthority signature:\n{\n`), w.out).toBe(true);
    expect(w.out).toContain('"acme.ops.Inventory": {');
    expect(w.out.endsWith("}\nwrote mandate.lock.json\n"), w.out).toBe(true);
    expect(w.err).toBe("");
    expect(w.pinned()).toBe("1.2.0");
    expect(w.text("mandate.lock.json")!.endsWith("}\n")).toBe(true);
    // The signature it prints is the door's, as JSON.stringify writes it.
    const sig = authoritySignature(libraryIn(new Files(repoRoot), `${OPS}/1.2.0`)!);
    expect(w.out).toBe(`acme.ops 1.2.0 ${digest}\nauthority signature:\n${JSON.stringify(sig, null, 2)}\nwrote mandate.lock.json\n`);
    // Any version: the highest of all. The lock --lock names, in its place.
    mkdirSync(join(w.dir, "d"));
    expect(w.mandate("add", "acme.ops", "--libraries", "libs", "--lock", "d/l.json")).toBe(0);
    expect(w.pinned("d/l.json")).toBe("2.0.0");
    expect(w.out.endsWith("wrote d/l.json\n")).toBe(true);
  });

  it("writes, for an exact version into a new lock, the lock of the fixture (conformance/L02)", () => {
    const w = opsWorld();
    expect(w.mandate("add", "acme.ops@1.0.0", "--libraries", "libs")).toBe(0);
    expect(canonicalize(JSON.parse(w.text("mandate.lock.json")!) as Json)).toBe(canonicalize(JSON.parse(repo("conformance/L02/mandate.lock.json")) as Json));
  });

  it("writes no lock when nothing is within the range, or the directory does not hold the library (E1606)", () => {
    const w = opsWorld();
    expect(w.mandate("add", "acme.ops@^3", "--libraries", "libs")).toBe(1);
    expect(w.err.startsWith("mandate.lock.json: error MDT-E1606: "), w.err).toBe(true);
    expect(w.out).toBe("");
    expect(w.text("mandate.lock.json")).toBeUndefined();
    expect(w.mandate("add", "acme.other", "--libraries", "libs")).toBe(1);
    expect(w.err).toContain(" error MDT-E1606: ");
    expect(w.text("mandate.lock.json")).toBeUndefined();
  });

  it("prints with --json exactly what the door gives, and the lock it gives is the lock it wrote", () => {
    const w = opsWorld();
    expect(w.mandate("add", "acme.ops@^1.0", "--libraries", "libs", "--json")).toBe(0);
    expect(w.err).toBe("");
    const answer = JSON.parse(w.out) as { version: string; lock: Json };
    expect(Object.keys(answer)).toEqual(["ok", "diagnostics", "resolution", "version", "digest", "signature", "lock"]);
    expect(answer.version).toBe("1.2.0");
    expect(w.text("mandate.lock.json")).toBe(JSON.stringify(answer.lock, null, 2) + "\n");
    // The door, asked with what the command read: the same text.
    const fs = new Files(w.dir);
    const door = libraryAdd({ library: "acme.ops", range: "^1.0", lock: { lock: "mandate/lock/0.6", modules: {} } as never, versions: versionsIn(fs, "libs", "acme.ops"), libraries: [], now: "2026-11-15T00:00:00Z" });
    expect(w.out).toBe(JSON.stringify(door, null, 2) + "\n");
    expect(w.mandate("add", "acme.ops@^3", "--libraries", "libs", "--json")).toBe(1);
    expect(JSON.parse(w.out)).toMatchObject({ ok: false, lock: null });
    expect(w.err).toBe("");
  });

  it("pins the built-in library with no directory; any other needs one, and what is no library's name is not looked for", () => {
    const w = new World();
    expect(w.mandate("add", "std.patterns"), w.err).toBe(0);
    const std = (JSON.parse(repo("fixtures/library/invoices.lock.json")) as { libraries: Record<string, { digest: string }> }).libraries["std.patterns"]!;
    expect(w.out.startsWith(`std.patterns 1.0.0 ${std.digest}\n`), w.out).toBe(true);
    expect(JSON.parse(w.text("mandate.lock.json")!)).toMatchObject({ lock: "mandate/lock/0.6", libraries: { "std.patterns": std } });
    expect(w.mandate("add", "acme.ops")).toBe(2);
    expect(w.err).toBe("mandate: no directory of libraries: name it with --libraries <dir>, or as libraries.dir of the configuration (--config <file>, or mandate.runtime.json)\n");
    for (const name of ["../acme", "Acme", "acme/ops", "", "..", "acme..ops", "/abs", "acme\\ops", "acme\0", "nul", "acme.con"]) {
      expect(w.mandate("add", name, "--libraries", "libs"), name).toBe(2);
      expect(w.err).toBe(`mandate: ${name} is not the name of a library\n`);
      expect(w.mandate("upgrade", `${name}@1.0.0`, "--libraries", "libs"), name).toBe(2);
    }
    expect(w.mandate("add")).toBe(2);
    expect(w.err.startsWith("usage: mandate")).toBe(true);
  });
});

describe("the waiting period and the revocation list, from the configuration's libraries member", () => {
  it("a version within its waiting period is not resolved", () => {
    const w = opsWorld();
    w.now = seconds("2026-11-13T12:00:00Z");
    w.put("mandate.runtime.json", '{"database":"pglite:db","libraries":{"dir":"libs","wait_days":2}}');
    // 1.2.0, published on the 12th, waits; 1.1.0 is taken.
    expect(w.mandate("add", "acme.ops@^1.0"), w.err).toBe(0);
    expect(w.pinned()).toBe("1.1.0");
    // Exactly 1.2.0: E1608 naming the day, and the lock is not written.
    const before = w.text("mandate.lock.json");
    expect(w.mandate("add", "acme.ops@1.2.0")).toBe(1);
    expect(w.err.startsWith("mandate.lock.json: error MDT-E1608: "), w.err).toBe(true);
    expect(w.err).toContain("2026-11-14");
    expect(w.out).toBe("");
    expect(w.text("mandate.lock.json")).toBe(before);
    // Without the configuration nothing waits; --config names another, and --libraries the directory.
    w.put("conf/other.json", '{"libraries":{"dir":"../libs"}}');
    w.remove("mandate.lock.json");
    expect(w.mandate("add", "acme.ops@^1.0", "--config", "conf/other.json", "--libraries", "libs")).toBe(0);
    expect(w.pinned()).toBe("1.2.0");
    // The directory of a configuration is relative to the configuration.
    w.remove("mandate.lock.json");
    expect(w.mandate("add", "acme.ops@^1.0", "--config", "conf/other.json"), w.err).toBe(0);
    expect(w.pinned()).toBe("1.2.0");
  });

  it("an upgrade waits as an add does", () => {
    const w = opsWorld();
    w.now = seconds("2026-11-13T12:00:00Z");
    w.put("mandate.runtime.json", '{"libraries":{"dir":"libs","wait_days":30}}');
    opsLock(w);
    expect(w.mandate("upgrade", "acme.ops@1.0.1")).toBe(1);
    expect(w.err).toContain(" error MDT-E1608: ");
    expect(w.pinned()).toBe("1.0.0");
  });

  it("a revoked digest is not resolved", () => {
    const w = opsWorld();
    const revoked = digestOf(`${OPS}/1.2.0`);
    w.put("mandate.runtime.json", JSON.stringify({ libraries: { dir: "libs", revoked: [revoked] } }));
    expect(w.mandate("add", "acme.ops@^1.0"), w.err).toBe(0);
    expect(w.pinned()).toBe("1.1.0");
    w.remove("mandate.lock.json");
    expect(w.mandate("add", "acme.ops@1.2.0")).toBe(1);
    expect(w.err.startsWith("mandate.lock.json: error MDT-E1608: "), w.err).toBe(true);
    expect(w.err).toContain(revoked);
    expect(w.text("mandate.lock.json")).toBeUndefined();
  });

  it("a configuration or a lock that cannot be read stops the command", () => {
    const w = opsWorld();
    expect(w.mandate("add", "acme.ops", "--config", "none.json")).toBe(2);
    expect(w.err.startsWith("mandate: cannot read none.json: "), w.err).toBe(true);
    w.put("c.json", "{ not json");
    expect(w.mandate("add", "acme.ops", "--config", "c.json")).toBe(1);
    expect(w.err.startsWith("c.json:1:"), w.err).toBe(true);
    expect(w.mandate("add", "acme.ops", "--config", "c.json", "--json")).toBe(1);
    expect(JSON.parse(w.out)).toMatchObject({ ok: false });
    w.put("c.json", "[]");
    expect(w.mandate("add", "acme.ops", "--config", "c.json")).toBe(2);
    expect(w.err).toBe("mandate: c.json is not a configuration: it is not an object\n");
    // A member the reader does not know is refused, not read as nothing.
    w.put("c.json", '{"libraries":{"dir":"libs","wait_day":7}}');
    expect(w.mandate("add", "acme.ops", "--config", "c.json")).toBe(2);
    expect(w.err.startsWith("mandate: c.json: its member libraries is not { dir, wait_days?, revoked? }: "), w.err).toBe(true);
    expect(w.err.trimEnd().endsWith(": ")).toBe(false);
    for (const bad of ['{"wait_days":1}', '{"dir":"libs","wait_days":-1}', '{"dir":"libs","revoked":["sha256:xyz"]}', '"libs"', "null"]) {
      w.put("c.json", `{"libraries":${bad}}`);
      expect(w.mandate("publish", "libs", "--config", "c.json"), bad).toBe(2);
    }
    expect(w.text("mandate.lock.json")).toBeUndefined();
    // A lock that is not a lock.
    w.put("mandate.lock.json", "[]");
    expect(w.mandate("add", "acme.ops", "--libraries", "libs")).toBe(2);
    expect(w.err).toBe("mandate: mandate.lock.json is not a lock: it is not an object\n");
    w.put("mandate.lock.json", "{ not json");
    expect(w.mandate("add", "acme.ops", "--libraries", "libs")).toBe(1);
    expect(w.err.startsWith("mandate.lock.json:1:"), w.err).toBe(true);
    expect(w.text("mandate.lock.json")).toBe("{ not json");
  });

  it("the compiler's reader says which values are a libraries member", () => {
    expect(librariesConfigProblems({ dir: "libs" })).toEqual([]);
    expect(librariesConfigProblems({ dir: "libs", wait_days: 7, revoked: [`sha256:${"0".repeat(64)}`] })).toEqual([]);
    for (const bad of [{}, { dir: "" }, { dir: "libs", wait_day: 7 }, { dir: "libs", wait_days: 1.5 }, { dir: "libs", revoked: ["x"] }, [], "libs", 1]) expect(librariesConfigProblems(bad).length, JSON.stringify(bad)).toBeGreaterThan(0);
  });
});

describe("mandate upgrade", () => {
  it("shows a change that widens the authority signature as a governance change, and writes the lock only with --accept-governance", () => {
    const w = opsWorld();
    opsLock(w);
    const before = w.text("mandate.lock.json");
    const upgrade = ["upgrade", "acme.ops@1.1.0", "--libraries", "libs"];
    expect(w.mandate(...upgrade)).toBe(1);
    expect(w.err).toBe("");
    expect(w.out.startsWith(`acme.ops 1.0.0 -> 1.1.0 ${digestOf(`${OPS}/1.1.0`)}\n`), w.out).toBe(true);
    expect(w.out).toContain("\ngovernance change: widened at acme.ops.Inventory: ~ acme.ops.Inventory.budget.time");
    expect(w.out).toContain("\ngovernance change: budget_increased at acme.ops");
    expect(w.out).toContain("\nauthority signature:\n{\n");
    expect(w.out).toMatch(/\}\nnot written: [1-9][0-9]* governance change\(s\); mandate\.lock\.json is written only with --accept-governance\n$/);
    expect(w.text("mandate.lock.json"), "the lock was written").toBe(before);
    // As JSON: what the door gives, its lock null; still nothing written.
    expect(w.mandate(...upgrade, "--json")).toBe(1);
    const answer = JSON.parse(w.out) as { ok: boolean; lock: unknown; governance: unknown[] };
    expect(answer.ok).toBe(true);
    expect(answer.lock).toBeNull();
    expect(answer.governance.length).toBeGreaterThan(0);
    expect(w.text("mandate.lock.json")).toBe(before);
    // A raised class of a connector is held the same.
    expect(w.mandate("upgrade", "acme.ops@1.2.0", "--libraries", "libs")).toBe(1);
    expect(w.out).toContain("governance change: widened at acme.ops.store: ~ connector acme.ops.store.class: internal → confidential\n");
    expect(w.text("mandate.lock.json")).toBe(before);
    // Accepted: the same changes shown, and the lock written.
    expect(w.mandate(...upgrade, "--accept-governance"), w.err).toBe(0);
    expect(w.out).toContain("\ngovernance change: widened at acme.ops.Inventory: ");
    expect(w.out.endsWith("wrote mandate.lock.json\n"), w.out).toBe(true);
    expect(w.pinned()).toBe("1.1.0");
  });

  it("the count it prints is the count of the governance changes it showed", () => {
    const w = opsWorld();
    opsLock(w);
    expect(w.mandate("upgrade", "acme.ops@1.1.0", "--libraries", "libs")).toBe(1);
    const shown = w.out.split("\n").filter((l) => l.startsWith("governance change: ")).length;
    expect(w.out).toContain(`\nnot written: ${shown} governance change(s); `);
  });

  it("writes the lock of an upgrade without a governance change", () => {
    const w = opsWorld();
    opsLock(w);
    // A doc line changed: a behavior change at most.
    expect(w.mandate("upgrade", "acme.ops@1.0.1", "--libraries", "libs"), w.err).toBe(0);
    expect(w.out.startsWith("acme.ops 1.0.0 -> 1.0.1 sha256:"), w.out).toBe(true);
    expect(w.out).not.toContain("governance change");
    expect(w.out.endsWith("wrote mandate.lock.json\n"), w.out).toBe(true);
    expect(w.pinned()).toBe("1.0.1");
  });

  it("refuses a library the lock does not pin (E1605), and a pinned version the directory does not hold as pinned (E1601)", () => {
    const w = opsWorld();
    expect(w.mandate("upgrade", "acme.ops", "--libraries", "libs")).toBe(1);
    expect(w.err.startsWith("mandate.lock.json: error MDT-E1605: "), w.err).toBe(true);
    expect(w.text("mandate.lock.json")).toBeUndefined();
    const v = opsWorld(["1.0.1", "1.1.0"]);
    opsLock(v);
    expect(v.mandate("upgrade", "acme.ops@1.0.1", "--libraries", "libs")).toBe(1);
    expect(v.err).toContain(" error MDT-E1601: ");
    expect(v.pinned()).toBe("1.0.0");
  });

  it("the door alone holds the gate: without accept_governance its lock is null, with it the lock pins the version", () => {
    const fs = new Files(repoRoot);
    const request = { library: "acme.ops", range: "1.1.0", lock: JSON.parse(repo("conformance/L02/mandate.lock.json")) as never, versions: versionsIn(fs, "fixtures/library/upgrade", "acme.ops"), pinned: libraryIn(fs, `${OPS}/1.0.0`)!, now: "2026-11-15T00:00:00Z" };
    expect(libraryUpgrade(request)).toMatchObject({ ok: true, lock: null });
    expect(libraryUpgrade({ ...request, accept_governance: true }).lock).toMatchObject({ libraries: { "acme.ops": { version: "1.1.0" } } });
  });
});

describe("mandate publish", () => {
  it("copies the library and writes its index last", () => {
    const w = opsWorld(["1.0.0"]);
    opsSource(w, "1.0.1");
    expect(w.mandate("publish", "src", "--libraries", "libs"), w.err).toBe(0);
    expect(w.out).toBe(`published acme.ops 1.0.1 ${digestOf(`${OPS}/1.0.1`)} to ${P("libs/acme.ops/1.0.1")}\n`);
    expect(w.err).toBe("");
    for (const f of ["mandate.library.json", "ops.mdt"]) expect(w.text(`libs/acme.ops/1.0.1/${f}`), f).toBe(w.text(`src/${f}`));
    expect(w.text("libs/acme.ops/1.0.1/index.json")).toBe('{ "published_at": "2026-11-15T00:00:00Z" }\n');
    // What was published is what `add` resolves.
    expect(w.mandate("add", "acme.ops@^1.0", "--libraries", "libs"), w.err).toBe(0);
    expect(w.pinned()).toBe("1.0.1");
    // A version already published: E1607.
    expect(w.mandate("publish", "src", "--libraries", "libs")).toBe(1);
    expect(w.err.startsWith(`${P("src/mandate.library.json")}: error MDT-E1607: `), w.err).toBe(true);
    // A source that is not a library, and no directory to publish into.
    expect(w.mandate("publish", "nowhere", "--libraries", "libs")).toBe(2);
    expect(w.err.startsWith(`mandate: cannot read ${P("nowhere/mandate.library.json")}: `), w.err).toBe(true);
    expect(w.mandate("publish", "src")).toBe(2);
    expect(w.err.startsWith("mandate: no directory of libraries: "), w.err).toBe(true);
    expect(w.mandate("publish")).toBe(2);
  });

  it("writes the index after every other file: a publication that stops before its end leaves a directory that was never published", () => {
    const w = opsWorld(["1.0.0"]);
    opsSource(w, "1.0.1");
    const written: string[] = [];
    const fs = new (class extends Files {
      override write(file: string, text: string): void {
        written.push(file);
        super.write(file, text);
      }
    })(w.dir);
    const io = { fs, now: () => w.now, out: () => undefined, err: () => undefined };
    expect(libraryCommand("publish", { positional: ["src"], libraries: "libs", json: false }, io, () => new Stop(2))).toBe(0);
    expect(written).toEqual(["mandate.library.json", "ops.mdt", "index.json"].map((f) => P(`libs/acme.ops/1.0.1/${f}`)));
  });

  it("takes the directory from the configuration, and prints with --json what the door gives", () => {
    const w = opsWorld(["1.0.0"]);
    opsSource(w, "2.0.0");
    w.put("etc/mandate.runtime.json", '{"libraries":{"dir":"../libs"}}');
    expect(w.mandate("publish", "src", "--config", "etc/mandate.runtime.json", "--json"), w.err).toBe(0);
    const fs = new Files(w.dir);
    const door = libraryPublish({ source: libraryIn(fs, "src")!, published: versionsIn(fs, "libs", "acme.ops").filter((v) => v.version !== "2.0.0"), libraries: [], now: "2026-11-15T00:00:00Z" });
    expect(w.out).toBe(JSON.stringify(door, null, 2) + "\n");
    expect(JSON.parse(w.out)).toMatchObject({ ok: true, version: "2.0.0" });
    expect(w.text("libs/acme.ops/2.0.0/index.json")).toBeDefined();
  });

  it("refuses with E1607 a version that widens and is not a major one, and writes nothing", () => {
    for (const [version, what] of [["1.1.0", "budget_increased"], ["1.2.0", "widened"]] as const) {
      const w = opsWorld(["1.0.0"]);
      opsSource(w, version);
      const before = w.files();
      expect(w.mandate("publish", "src", "--libraries", "libs"), version).toBe(1);
      expect(w.err.startsWith(`${P("src/mandate.library.json")}: error MDT-E1607: `), `${version}: ${w.err}`).toBe(true);
      expect(w.out, version).toContain(`against 1.0.0: governance change: ${what} at `);
      expect(w.out, version).not.toContain("published");
      expect(w.files(), `${version}: something was written`).toEqual(before);
      expect(existsSync(join(w.dir, "libs", "acme.ops", version)), `${version}: a directory was made`).toBe(false);
      // As JSON: the door's answer, with no files to copy.
      expect(w.mandate("publish", "src", "--libraries", "libs", "--json")).toBe(1);
      const answer = JSON.parse(w.out) as Record<string, unknown>;
      expect(answer["ok"]).toBe(false);
      expect(answer).not.toHaveProperty("files");
      expect(w.files()).toEqual(before);
    }
    // The same change as a major version is published.
    const w = opsWorld(["1.0.0"]);
    opsSource(w, "2.0.0");
    expect(w.mandate("publish", "src", "--libraries", "libs"), w.err).toBe(0);
    expect(w.text("libs/acme.ops/2.0.0/index.json")).toBeDefined();
  });

  it("resolves a required library to the highest published version within its range", () => {
    const w = opsWorld();
    // Unpublished: a directory of a higher version without its index is not taken.
    w.put("libs/acme.ops/1.9.0/mandate.library.json", repo(`${OPS}/1.2.0/mandate.library.json`).replace('"1.2.0"', '"1.9.0"'));
    w.put("libs/acme.ops/1.9.0/ops.mdt", repo(`${OPS}/1.2.0/ops.mdt`));
    w.put("src/mandate.library.json", JSON.stringify({ library: "mandate/library/0.6", name: "acme.uses", version: "1.0.0", modules: ["uses.mdt"], requires: { "acme.ops": "^1.0" } }));
    w.put("src/uses.mdt", "mandate @ 0.6\n\nmodule acme.uses @ 1.0\n\nuse acme.ops.{Item}\n\n/// A list of items.\npub type Items = { items: List<Item> }\n");
    const fs = new Files(w.dir);
    const expected = libraryPublish({ source: libraryIn(fs, "src")!, published: [], libraries: [libraryIn(fs, "libs/acme.ops/1.2.0")!], now: "2026-11-15T00:00:00Z" });
    expect(w.mandate("publish", "src", "--libraries", "libs", "--json")).toBe(expected.ok ? 0 : 1);
    expect(w.out).toBe(JSON.stringify(expected, null, 2) + "\n");
    // With another version handed in, the door's answer is another: the choice is what was shown.
    const other = libraryPublish({ source: libraryIn(fs, "src")!, published: [], libraries: [libraryIn(fs, "libs/acme.ops/2.0.0")!], now: "2026-11-15T00:00:00Z" });
    expect(JSON.stringify(other)).not.toBe(JSON.stringify(expected));
  });
});

describe("a path taken from a lock or a manifest stays inside the directory it is read under", () => {
  /** A library that reads, put where a path that leaves the directory would lead. */
  function outside(w: World, rel: string): void {
    for (const f of ["mandate.library.json", "ops.mdt"]) w.put(`${rel}/${f}`, repo(`${OPS}/1.0.0/${f}`));
  }
  const pin = (version: string) => ({ version, digest: `sha256:${"a".repeat(64)}`, modules: { "acme.ops": `sha256:${"b".repeat(64)}` } });

  it("a lock's library name or version that is not one is no path: nothing is read by it", () => {
    const w = opsWorld(["1.0.0"]);
    outside(w, "evil/1.0.0");
    outside(w, "libs/acme.ops/evil");
    const fs = new Files(w.dir);
    expect(pinnedIn(fs, { libraries: { "acme.ops": pin("1.0.0") } }, "libs")).toHaveLength(1);
    for (const name of ["../evil", "..", "acme.ops/../../evil", "/evil", `${w.dir}/evil`.replaceAll("\\", "/"), "..\\evil", "evil\0", "Evil", "con"]) {
      expect(lockPins({ libraries: { [name]: pin("1.0.0") } }), name).toEqual({});
      expect(pinnedIn(fs, { libraries: { [name]: pin("1.0.0") } }, "libs"), name).toEqual([]);
    }
    for (const version of ["../../../evil/1.0.0", "evil", "..", "1.0.0/..", "1.0", "1.0.0-rc1", "01.0.0", "1.0.0\0", "/1.0.0", "1.0.0\\..\\evil"]) {
      expect(lockPins({ libraries: { "acme.ops": pin(version) } }), version).toEqual({});
      expect(pinnedIn(fs, { libraries: { "acme.ops": pin(version) } }, "libs"), version).toEqual([]);
    }
    // One pin that is not a pin, and the lock pins nothing here: the compiler reports the lock (E0140).
    expect(pinnedIn(fs, { libraries: { "acme.ops": pin("1.0.0"), "../evil": pin("1.0.0") } }, "libs")).toEqual([]);
    expect(lockPins({ libraries: { "acme.ops": { ...pin("1.0.0"), more: 1 } } })).toEqual({});
    expect(lockPins({ libraries: { "acme.ops": { ...pin("1.0.0"), modules: { "acmex.y": `sha256:${"b".repeat(64)}` } } } })).toEqual({});
    expect(lockPins({ libraries: [] })).toEqual({});
    expect(lockPins({})).toEqual({});
    expect(versionsIn(fs, "libs", "../evil")).toEqual([]);
    expect(versionsIn(fs, "libs", "acme.ops").map((v) => v.version)).toEqual(["1.0.0", "evil"]);
  });

  it("a manifest's module file that is no module path is not read, wherever it leads", () => {
    const w = new World();
    w.put("secret.mdt", "outside\n");
    w.put("lib/ok.mdt", "inside\n");
    const fs = new Files(w.dir);
    const abs = join(w.dir, "secret.mdt");
    for (const path of ["../secret.mdt", "sub/../../secret.mdt", abs, abs.replaceAll("\\", "/"), "/secret.mdt", "..\\secret.mdt", "ok.mdt\0", "./ok.mdt", "ok.mdt:stream", "nul.mdt", "mandate.library.json", "INDEX.json", "ok.txt", ".hidden.mdt", "a//ok.mdt"]) {
      expect(isModulePath(path), path).toBe(false);
      w.put("lib/mandate.library.json", JSON.stringify({ name: "acme.x", modules: ["ok.mdt", path] }));
      expect(readManifest(w.text("lib/mandate.library.json")!).modules, path).toEqual([]);
      expect(libraryIn(fs, "lib")!.files, path).toEqual({});
    }
    w.put("lib/sub/deep.mdt", "deep\n");
    w.put("lib/mandate.library.json", JSON.stringify({ name: "acme.x", modules: ["ok.mdt", "sub/deep.mdt", "missing.mdt"] }));
    expect(libraryIn(fs, "lib")!.files).toEqual({ "ok.mdt": "inside\n", "sub/deep.mdt": "deep\n" });
    for (const path of ["ok.mdt", "sub/deep.mdt", "a-b_c.1.json", "A/B/c.mdt"]) expect(isModulePath(path), path).toBe(true);
  });

  it("add, upgrade and publish read and write nothing outside: the lock or the manifest is refused instead", () => {
    const w = opsWorld(["1.0.0"]);
    outside(w, "evil/1.0.0");
    // A lock that pins a library under a name or a version that leads out: no path is made of it, whatever the door
    // then answers of the lock (the door of `add` does not read the other pins of a lock it is handed no library for).
    for (const libraries of [{ "../evil": pin("1.0.0") }, { "acme.other": pin("../../evil/1.0.0") }, { "acme.other": pin("1.0.0"), "..": pin("1.0.0") }]) {
      w.put("mandate.lock.json", JSON.stringify({ lock: "mandate/lock/0.6", modules: {}, libraries }));
      for (const cmd of ["add", "upgrade"] as const) {
        const touched: string[] = [];
        const fs = new (class extends Files {
          override read(file: string): string {
            touched.push(file);
            return super.read(file);
          }
          override directories(dir: string): string[] {
            touched.push(dir);
            return super.directories(dir);
          }
        })(w.dir);
        const io = { fs, now: () => w.now, out: () => undefined, err: () => undefined };
        libraryCommand(cmd, { positional: ["acme.ops@1.0.0"], libraries: "libs", json: false }, io, () => new Stop(2));
        expect(touched.length, cmd).toBeGreaterThan(0);
        expect(touched.filter((p) => p.includes("evil") || p.includes("..") || p.includes("acme.other")), cmd).toEqual([]);
      }
    }
    w.remove("mandate.lock.json");
    // A source whose manifest lists a file outside it: E1601, nothing read from there, nothing written.
    w.put("secret.mdt", repo(`${OPS}/1.0.1/ops.mdt`));
    w.put("src/mandate.library.json", repo(`${OPS}/1.0.1/mandate.library.json`).replace('"ops.mdt"', '"../secret.mdt"'));
    const before = w.files();
    expect(w.mandate("publish", "src", "--libraries", "libs")).toBe(1);
    expect(w.err.startsWith(`${P("src/mandate.library.json")}: error MDT-E1601: `), w.err).toBe(true);
    expect(w.files()).toEqual(before);
    // A source whose manifest names the library with a path: the same.
    w.put("src/mandate.library.json", repo(`${OPS}/1.0.1/mandate.library.json`).replace('"acme.ops"', '"../evil"'));
    w.put("src/ops.mdt", repo(`${OPS}/1.0.1/ops.mdt`));
    const again = w.files();
    expect(w.mandate("publish", "src", "--libraries", "libs")).toBe(1);
    expect(w.err).toContain(" error MDT-E1601: ");
    expect(w.files()).toEqual(again);
  });

  it("names, versions and ranges are read as the compiler reads them", () => {
    for (const name of ["acme", "acme.ops", "_a.b_1", "std.patterns"]) expect(isLibraryName(name), name).toBe(true);
    for (const name of ["", "Acme", "acme.", ".acme", "acme..ops", "1acme", "acme-ops", "acme/ops", "acme.nul", "a".repeat(129), 1, null]) expect(isLibraryName(name), String(name)).toBe(false);
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("999999999.0.0")).toEqual([999999999, 0, 0]);
    for (const v of ["1.2", "1.2.3.4", "01.2.3", "1.2.3-rc", "1..3", "+1.2.3", " 1.2.3", "1000000000.0.0", ""]) expect(parseVersion(v), v).toBeUndefined();
    // The table of spec/library.md "Versions" and of crates/mandate-lib/src/version.rs.
    const holds = (range: string, version: string): boolean => rangeHolds(range, parseVersion(version)!);
    for (const [range, inside, outsideOf] of [
      ["^1.0", ["1.0.0", "1.9.9"], ["0.9.9", "2.0.0"]],
      ["^1.2.3", ["1.2.3", "1.3.0"], ["1.2.2", "2.0.0"]],
      ["^0.3", ["0.3.0", "0.3.9"], ["0.2.9", "0.4.0", "1.3.0"]],
      ["^0.0.3", ["0.0.3"], ["0.0.2", "0.0.4", "0.1.3"]],
      ["^0", ["0.0.0", "0.9.9"], ["1.0.0"]],
      ["^0.0", ["0.0.0", "0.0.9"], ["0.1.0"]],
      ["^0.0.0", ["0.0.0"], ["0.0.1"]],
      ["^2", ["2.0.0", "2.5.1"], ["1.9.9", "3.0.0"]],
      ["1.2.3", ["1.2.3"], ["1.2.4", "1.2.2"]],
    ] as const) {
      for (const v of inside) expect(holds(range, v), `${range} ${v}`).toBe(true);
      for (const v of outsideOf) expect(holds(range, v), `${range} ${v}`).toBe(false);
    }
    for (const bad of ["", "^", "^1.", "^1.2.3.4", "~1.0", ">=1.0.0", "^01", "1.0"]) expect(holds(bad, "1.0.0"), bad).toBe(false);
    expect(joinPath("libs", "acme.ops")).toBe(`libs${sep}acme.ops`);
    expect(joinPath("libs/", "acme.ops")).toBe("libs/acme.ops");
    expect(joinPath("", "x")).toBe("x");
    expect(beside("c.json", "libs")).toBe("libs");
    expect(beside("etc/c.json", "../libs")).toBe(`etc${sep}../libs`);
  });
});

describe("the doors of the library commands", () => {
  const source: LibrarySource = { manifest: repo(`${OPS}/1.0.0/mandate.library.json`), files: { "ops.mdt": repo(`${OPS}/1.0.0/ops.mdt`) } };
  const request = { library: "acme.ops", lock: { modules: {} } as never, versions: [{ version: "1.0.0", library: source, index: repo(`${OPS}/1.0.0/index.json`) }], now: "2026-11-15T00:00:00Z" };

  it("each is the Rust's alone: it gives what its door gives, and a door's refusal of its input is an Error", () => {
    expect(libraryAdd(request)).toMatchObject({ ok: true, version: "1.0.0" });
    // The others answer, each by its own door, where the reference compiler (frozen at 0.5) has no answer.
    const calls: Array<() => unknown> = [() => libraryUpgrade({ ...request, pinned: source }), () => libraryPublish({ source, published: [], now: request.now }), () => authoritySignature(source), () => librariesConfigProblems({ dir: "" })];
    for (const call of calls) expect(call).not.toThrow();
    expect(authoritySignature({ manifest: "{", files: {} })).toBeNull();
    // What a door refuses of its input is an Error with the door's message, as for every door.
    expect(() => libraryAdd({ ...request, now: "yesterday" })).toThrow(/`now` is "yesterday"/);
  });
});

// ── the command line itself ─────────────────────────────────────────────

interface Run {
  code: number | null;
  out: string;
  err: string;
}

describe("the mandate executable with libraries", () => {
  let tree: Tree;
  const work = mkdtempSync(join(tmpdir(), "mdt-cli-library-exe-"));
  dirs.push(work);
  const INVOICES = "fixtures/library/invoices.mdt";
  const INVOICES_LOCK = "fixtures/library/invoices.lock.json";

  beforeAll(() => {
    tree = buildTree();
    // The repository's fixtures under the same paths, and the acceptance library in the layout of the operator's directory.
    cpSync(join(repoRoot, "fixtures", "library"), join(work, "fixtures", "library"), { recursive: true });
    for (const v of VERSIONS) cpSync(join(repoRoot, OPS, v), join(work, "libs", "acme.ops", v), { recursive: true });
    for (const f of ["mandate.library.json", "connectors.mdt", "types.mdt"]) cpSync(join(repoRoot, "fixtures/library/acme.connectors", f), join(work, "libs", "acme.connectors", "2.3.0", f));
    writeFileSync(join(work, "libs", "acme.connectors", "2.3.0", "index.json"), '{ "published_at": "2026-11-01T09:00:00Z" }\n');
  }, 120_000);

  afterAll(() => tree?.remove());

  function mandate(...args: string[]): Promise<Run> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [tree.bridgeCli, ...args], { cwd: work, stdio: ["ignore", "pipe", "pipe"] });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on("data", (c: Buffer) => out.push(c));
      child.stderr.on("data", (c: Buffer) => err.push(c));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out: Buffer.concat(out).toString("utf8"), err: Buffer.concat(err).toString("utf8") }));
    });
  }
  const put = (rel: string, text: string): void => writeFileSync(join(work, rel), text);
  const remove = (rel: string): void => rmSync(join(work, rel), { recursive: true, force: true });

  it("checks a program with the libraries its lock pins, from --libraries or the configuration's directory", async () => {
    const check = ["check", INVOICES, "--lock", INVOICES_LOCK, "--libraries", "libs"];
    const ok = await mandate(...check);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toMatch(/^ok sha256:[0-9a-f]{64}\n$/);
    // The directory from the configuration, relative to it.
    put("mandate.runtime.json", '{"libraries":{"dir":"libs"}}');
    expect((await mandate("check", INVOICES, "--lock", INVOICES_LOCK)).out).toBe(ok.out);
    remove("mandate.runtime.json");
    mkdirSync(join(work, "etc"), { recursive: true });
    put("etc/c.json", '{"libraries":{"dir":"../libs"}}');
    expect((await mandate("check", INVOICES, "--lock", INVOICES_LOCK, "--config", "etc/c.json")).out).toBe(ok.out);
    // Without the directory the pinned library was not handed in: E1605.
    const without = await mandate("check", INVOICES, "--lock", INVOICES_LOCK);
    expect(without.code).toBe(1);
    expect(without.err).toContain(" error MDT-E1605: ");
    expect(without.out).toBe("");
    // A library that is not what the lock pins: E1605.
    const types = "libs/acme.connectors/2.3.0/types.mdt";
    const text = readFileSync(join(work, types), "utf8");
    put(types, `${text}\n/// Another line.\npub type Extra = { id: Text }\n`);
    const changed = await mandate(...check);
    put(types, text);
    expect(changed.code).toBe(1);
    expect(changed.err).toContain(" error MDT-E1605: ");
    // An option without its value is a usage error.
    for (const option of ["--libraries", "--config"]) {
      const r = await mandate("check", INVOICES, option);
      expect(r.code, option).toBe(2);
      expect(r.err.startsWith("usage: mandate <command> [options]\n"), option).toBe(true);
    }
    // A configuration that is not one stops the check, as it stops a library command.
    put("etc/c.json", '{"libraries":{"dir":"../libs","wait_day":1}}');
    const bad = await mandate("check", INVOICES, "--lock", INVOICES_LOCK, "--config", "etc/c.json");
    expect(bad.code).toBe(2);
    expect(bad.err.startsWith("mandate: etc/c.json: its member libraries is not { dir, wait_days?, revoked? }: "), bad.err).toBe(true);
    expect(bad.out).toBe("");
  });

  it("shows the views, the card, the diff, the sandbox requirements and the ACS target with the modules of the libraries", async () => {
    const lib = ["--lock", INVOICES_LOCK, "--libraries", "libs"];
    for (const format of ["md", "html", "json"]) {
      // The program is checked with its libraries before its card is asked for. In 0.6 a workflow without an envelope
      // has a card too (its caps and budget stand in for the envelope's), given the modules of the libraries.
      const card = await mandate("view", INVOICES, ...lib, "--card", "--format", format);
      expect(card.code, `${format}: ${card.err}`).toBe(0);
      expect(card.err).toBe("");
      expect(card.out, format).toContain("MatchInvoices");
      if (format === "md") expect(card.out).toContain("Spend bound of map it: 60 × 0.30 USD = 18 USD ≤ 20 USD.");
      const view = await mandate("view", INVOICES, ...lib, "--format", format);
      expect(view.code, `${format}: ${view.err}`).toBe(0);
      expect(view.out, format).toContain("MatchInvoices");
    }
    const diff = await mandate("view", INVOICES, ...lib, "--against", INVOICES, "--against-lock", INVOICES_LOCK, "--format", "json");
    expect(diff.code, diff.err).toBe(0);
    expect((JSON.parse(diff.out) as { governance: unknown[] }).governance).toEqual([]);
    const sandbox = await mandate("sandbox", INVOICES, ...lib);
    expect(sandbox.code, sandbox.err).toBe(0);
    expect(JSON.parse(sandbox.out)).toHaveProperty("requirements");
    const target = await mandate("target", "acs", INVOICES, ...lib, "--out", "o");
    expect(target.code, target.err).toBe(0);
    expect(existsSync(join(work, "o", "profile.json"))).toBe(true);
    // Without the libraries none of them is shown: the check comes first.
    for (const cmd of [["view", INVOICES, "--lock", INVOICES_LOCK], ["sandbox", INVOICES, "--lock", INVOICES_LOCK], ["target", "acs", INVOICES, "--lock", INVOICES_LOCK, "--out", "o2"]]) {
      const r = await mandate(...cmd);
      expect(r.code, cmd.join(" ")).toBe(1);
      expect(r.err, cmd.join(" ")).toContain(" error MDT-E1605: ");
      expect(r.out).toBe("");
    }
    expect(existsSync(join(work, "o2"))).toBe(false);
  });

  it("refuses with E1608 a check whose lock pins a digest the configuration revokes", async () => {
    const digest = digestOf("fixtures/library/acme.connectors");
    put("mandate.runtime.json", JSON.stringify({ libraries: { dir: "libs", revoked: [digest] } }));
    for (const cmd of [["check", INVOICES, "--lock", INVOICES_LOCK], ["view", INVOICES, "--lock", INVOICES_LOCK], ["view", INVOICES, "--lock", INVOICES_LOCK, "--card"], ["sandbox", INVOICES, "--lock", INVOICES_LOCK], ["target", "acs", INVOICES, "--lock", INVOICES_LOCK, "--out", "o3"]]) {
      const r = await mandate(...cmd);
      expect(r.code, cmd.join(" ")).toBe(1);
      expect(r.err, cmd.join(" ")).toContain(" error MDT-E1608: ");
      expect(r.err).toContain(digest);
      expect(r.out).toBe("");
    }
    // Another digest revoked: it checks.
    put("mandate.runtime.json", JSON.stringify({ libraries: { dir: "libs", revoked: [`sha256:${"0".repeat(64)}`] } }));
    const ok = await mandate("check", INVOICES, "--lock", INVOICES_LOCK);
    remove("mandate.runtime.json");
    expect(ok.code, ok.err).toBe(0);
  });

  it("runs add, upgrade and publish as the commands in this process do, and prints their usage", async () => {
    // Every version of the fixture was published before today, so the process's own clock resolves as the test's does.
    const added = await mandate("add", "acme.ops@1.0.0", "--libraries", "libs", "--lock", "exe.lock.json");
    expect(added.code, added.err).toBe(0);
    const w = opsWorld();
    expect(w.mandate("add", "acme.ops@1.0.0", "--libraries", "libs", "--lock", "exe.lock.json")).toBe(0);
    expect(added.out).toBe(w.out);
    expect(readFileSync(join(work, "exe.lock.json"), "utf8")).toBe(w.text("exe.lock.json"));
    const held = await mandate("upgrade", "acme.ops@1.1.0", "--lock", "exe.lock.json", "--libraries", "libs");
    expect(w.mandate("upgrade", "acme.ops@1.1.0", "--lock", "exe.lock.json", "--libraries", "libs")).toBe(1);
    expect(held).toEqual({ code: 1, out: w.out, err: "" });
    expect(readFileSync(join(work, "exe.lock.json"), "utf8")).toBe(w.text("exe.lock.json"));
    const accepted = await mandate("upgrade", "acme.ops@1.1.0", "--accept-governance", "--lock", "exe.lock.json", "--libraries", "libs", "--json");
    expect(accepted.code, accepted.err).toBe(0);
    expect((JSON.parse(readFileSync(join(work, "exe.lock.json"), "utf8")) as { libraries: Record<string, { version: string }> }).libraries["acme.ops"]!.version).toBe("1.1.0");
    const refused = await mandate("publish", "fixtures/library/upgrade/acme.ops/1.1.0", "--libraries", "pub");
    expect(refused.code).toBe(0);
    expect(refused.out).toMatch(new RegExp(`^published acme\\.ops 1\\.1\\.0 sha256:[0-9a-f]{64} to ${P("pub/acme.ops/1.1.0").replaceAll("\\", "\\\\").replaceAll(".", "\\.")}\n$`));
    expect(readFileSync(join(work, "pub", "acme.ops", "1.1.0", "index.json"), "utf8")).toMatch(/^\{ "published_at": "\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ" \}\n$/);
    const again = await mandate("publish", "fixtures/library/upgrade/acme.ops/1.1.0", "--libraries", "pub");
    expect(again.code).toBe(1);
    expect(again.err).toContain(" error MDT-E1607: ");
    const usage = await mandate("add");
    expect(usage.code).toBe(2);
    for (const line of [
      "  add <library>[@<range>] [--lock <lock.json>] [--libraries <dir>] [--config <file>] [--json]",
      "  upgrade <library>[@<range>] [--lock <lock.json>] [--libraries <dir>] [--config <file>] [--accept-governance] [--json]",
      "  publish <source dir> [--libraries <dir>] [--config <file>] [--json]",
      "  check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]… [--libraries <dir>] [--config <file>]",
    ]) expect(usage.err).toContain(`\n${line}\n`);
  });

  // What each command prints of a program of 0.6 is what vectors/golden/0.6.json pins for it: the digest of the
  // standard output is the digest pinned, as the native command line's test holds its own (tests/cli.rs).
  it("prints for every program of 0.6 what the golden file pins, the document with the program's modules among it", async () => {
    const golden = JSON.parse(repo("vectors/golden/0.6.json")) as Record<string, Record<string, string>>;
    const sha = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
    const connectors = ["fixtures/library/acme.connectors/types.mdt", "fixtures/library/acme.connectors/connectors.mdt"];
    const modulesOf: Record<string, string[]> = {
      "fixtures/library/summarize.mdt": ["fixtures/library/shared.mdt"],
      "fixtures/library/drafts.mdt": connectors,
      "fixtures/library/review.mdt": connectors,
      "fixtures/library/invoices.mdt": [],
      // The shaped migration imports nothing but std and std.patterns (crates/mandate-testkit/tests/outputs).
      "fixtures/library/migrate-all.mdt": [],
      "fixtures/library/batch.mdt": [...connectors, "fixtures/library/batch.patterns.mdt"],
    };
    const commands: Array<[name: string, locked: boolean, withModules: boolean, args: string[]]> = [
      ["check", false, false, ["check", "FILE", "--json"]],
      ["check --module", false, true, ["check", "FILE", "--json"]],
      ["check --lock", true, true, ["check", "FILE", "--json"]],
      ["ir --canonical", false, false, ["ir", "FILE", "--canonical"]],
      ["fmt", false, false, ["fmt", "FILE"]],
      ["hash", false, false, ["hash", "FILE"]],
      ["view --format json", true, true, ["view", "FILE", "--format", "json"]],
      ["view --format md", true, true, ["view", "FILE"]],
      ["view --format html", true, true, ["view", "FILE", "--format", "html"]],
      ["sandbox", true, true, ["sandbox", "FILE"]],
      ["view --card --format json", true, true, ["view", "FILE", "--card", "--format", "json"]],
      ["view --card --format md", true, true, ["view", "FILE", "--card"]],
      ["view --card --format html", true, true, ["view", "FILE", "--card", "--format", "html"]],
    ];
    const problems: string[] = [];
    let compared = 0;
    await Promise.all(
      Object.entries(golden).map(async ([program, pinned]) => {
        const lock = [program.replace(/\.[^./]+$/, ".lock.json"), join(dirname(program), "mandate.lock.json").replaceAll("\\", "/")].find((p) => existsSync(join(repoRoot, p)));
        for (const [name, locked, withModules, args] of commands) {
          if (pinned[name] === undefined) continue;
          if (name === "check --module" && program === "fixtures/library/invoices.mdt") continue;
          if (name === "check --lock" && !lock) continue;
          const argv = args.map((a) => (a === "FILE" ? program : a));
          if (withModules) for (const m of modulesOf[program] ?? ["fixtures/system/acme.system.mdt", "fixtures/system/repos.mdt"]) argv.push("--module", join(repoRoot, m));
          if (locked && lock) {
            if (!lock.endsWith("/mandate.lock.json")) argv.push("--lock", lock);
            if (program === "fixtures/library/invoices.mdt") argv.push("--libraries", "libs");
          }
          const r = await mandate(...argv);
          compared++;
          if (sha(r.out) !== pinned[name]) problems.push(`${name} @ ${program}: not the pinned output (exit ${r.code}); it begins\n${r.out.slice(0, 300)}\n${r.err.slice(0, 300)}`);
        }
      }),
    );
    expect(problems.join("\n")).toBe("");
    expect(compared).toBeGreaterThanOrEqual(60);
  }, 240_000);
});
