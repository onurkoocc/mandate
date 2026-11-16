// An upgrade of a library end to end (spec/library.md "`mandate add`, `upgrade` and `publish`", "The authority
// signature"; the roadmap's criterion: the upgrade diff catches an authority widening). The library is acme.ops of
// fixtures/library/upgrade/, whose 1.1.0 raises the budget of its workflow Inventory, whose 1.2.0 raises the class of
// its connector store, and whose 2.0.0 is the change of 1.1.0 as a major version. The library commands are the Node
// command line's own (bridge/src/cli-library.ts, run in this process over a temporary directory, as
// bridge/test/cli-library.test.ts runs them); the program that uses the library runs on the runtime, in design mode,
// its connector answering from a sample.
//
// What the commands print and write is held by bridge/test/cli-library.test.ts: "mandate upgrade" > "shows a change
// that widens the authority signature as a governance change, and writes the lock only with --accept-governance"
// (the workflow's budget and the connector's class, the lock's bytes unchanged, exit 1), and "mandate publish" >
// "refuses with E1607 a version that widens and is not a major one, and writes nothing" (and the major version
// published). Here those commands are steps, and what is held is what a run of the program does across them: it
// keeps running under the old lock after the widening release is published, and it does not start under a lock that
// names the new release without the upgrade having been accepted.
//
// The Rust compiler alone reads a program of 0.6: with MANDATE_COMPILER=ts these tests are skipped by name.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, libraryVerify, pinnedLibraries, type LibrarySource, type Lock } from "@mandate/bridge";
import { compilerMode } from "@mandate/bridge/mode";
import { afterAll, describe, expect, it } from "vitest";
import { libraryCommand, Stop, type LibraryArgs } from "../../bridge/src/cli-library.js";
import { Files } from "../../bridge/src/libraries.js";
import type { RunRow } from "../src/journal.js";
import { buildPackage, type Package } from "../src/runtime.js";
import { Crash, Violation } from "../src/signals.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

const rust = compilerMode() !== "ts";
const needs06 = rust ? describe : describe.skip;

const OPS = new URL("../../fixtures/library/upgrade/acme.ops/", import.meta.url);
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A program that uses the library's type, connector and capability in a workflow of its own. */
const STOCK = `mandate @ 0.6

module example.stock @ 0.1

use std.{tool}
use acme.ops.{Item, store, StoreRead}

/// Lists the items of the store.
workflow Stock() -> Untrusted<List<Item>>
  caps   StoreRead
  budget { time: 30m }
{
  store.list_items()
}
`;

const ITEMS = [{ id: "a", size: 1 }];
/** The binding of the library's connector: a design run asks no server, so its digests are never compared. */
const STORE = { "acme.ops.store": { credential: "store", url: "https://store.acme.example/mcp", tools: { list_items: `sha256:${"0".repeat(64)}`, find_item: `sha256:${"0".repeat(64)}`, put_item: `sha256:${"0".repeat(64)}` } } };

/** A working directory whose directory of libraries `libs` holds acme.ops 1.0.0, published; the clock is past every date. */
class Desk {
  readonly dir = mkdtempSync(join(tmpdir(), "mdt-upgrade-"));
  out = "";
  err = "";
  constructor() {
    dirs.push(this.dir);
    cpSync(new URL("1.0.0", OPS), join(this.dir, "libs", "acme.ops", "1.0.0"), { recursive: true });
  }

  /** `mandate <args>` of the Node command line, over the working directory. */
  mandate(...argv: string[]): number {
    this.out = "";
    this.err = "";
    const [cmd, ...rest] = argv;
    const a: LibraryArgs = { positional: [], json: false };
    for (let i = 0; i < rest.length; i++) {
      const x = rest[i]!;
      if (x === "--libraries") a.libraries = rest[++i]!;
      else if (x === "--json") a.json = true;
      else if (x === "--accept-governance") a.acceptGovernance = true;
      else a.positional.push(x);
    }
    const io = { fs: new Files(this.dir), now: () => Date.parse("2026-11-16T00:00:00Z") / 1000, out: (s: string) => void (this.out += s), err: (s: string) => void (this.err += s) };
    return libraryCommand(cmd as "add", a, io, () => new Stop(2));
  }

  /** The source directory of version `v` as the fixture holds it, without its index: what is published from. */
  source(v: string): string {
    const at = join(this.dir, `src-${v}`);
    cpSync(new URL(v, OPS), at, { recursive: true });
    rmSync(join(at, "index.json"));
    return `src-${v}`;
  }

  lockText(): string {
    return readFileSync(join(this.dir, "mandate.lock.json"), "utf8");
  }

  /** The lock the commands wrote, with the connector's binding and the 0.5 format's empty modules. */
  lock(text = this.lockText()): Lock {
    const { lock: _format, ...l } = JSON.parse(text) as Lock & { lock?: string };
    return { ...l, connectors: STORE } as Lock;
  }

  libraries(lock: Lock): LibrarySource[] {
    return pinnedLibraries(lock, join(this.dir, "libs"));
  }

  /** Every file under the directory of libraries, with its text. */
  published(): Record<string, string> {
    const found: Record<string, string> = {};
    const walk = (d: string, rel: string): void => {
      for (const name of readdirSync(d).sort()) {
        if (statSync(join(d, name)).isDirectory()) walk(join(d, name), `${rel}${name}/`);
        else found[rel + name] = readFileSync(join(d, name), "utf8");
      }
    };
    walk(join(this.dir, "libs"), "");
    return found;
  }
}

/** The program on a runtime, under `lock`, with the libraries it pins from the desk's directory; the store answers from a sample. */
async function stockWorld(desk: Desk, lock: Lock): Promise<World> {
  const w = await world(STOCK, { lock, libraries: desk.libraries(lock), decisions: { mode: "signed" } });
  w.adapters.samples = { tool: (name: string) => (name === "acme.ops.store.list_items" ? { result: ITEMS } : undefined) } as never;
  return w;
}

/** A lock as its file holds it, with its format: what a check is handed. */
const asFile = (l: Lock): Lock => ({ lock: "mandate/lock/0.6", ...l }) as Lock;

const run = (w: World, runId: string, pkg: Package = w.pkg): Promise<RunRow> => w.rt.startRun({ pkg, workflow: "Stock", input: {}, runId, mode: "design" });

/** What a start threw, as a violation. */
async function refusal(p: Promise<unknown>): Promise<Violation> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Violation) return e;
    throw e;
  }
  throw new Error("the run started");
}

needs06("a program across an upgrade of its library that widens a workflow's authority", () => {
  it("keeps running under its old lock once the widening release is published, starts under no lock that names it unaccepted, and runs under the accepted one", async () => {
    const desk = new Desk();
    expect(desk.mandate("add", "acme.ops@1.0.0", "--libraries", "libs"), desk.err).toBe(0);
    const old = desk.lock();
    const oldText = desk.lockText();
    const w = await stockWorld(desk, old);
    // A run under the old lock stops before its end; it resumes after the new release is published.
    w.faults.arm("after_record", (i) => i.kind === "read");
    await expect(run(w, "before")).rejects.toBeInstanceOf(Crash);

    // The widening as a minor version is refused (E1607) and writes nothing; as a major version it is published.
    const before = desk.published();
    expect(desk.mandate("publish", desk.source("1.1.0"), "--libraries", "libs")).toBe(1);
    expect(desk.err).toContain(" error MDT-E1607: ");
    expect(desk.published()).toEqual(before);
    // So is 1.2.0, which raises the class of the connector store.
    expect(desk.mandate("publish", desk.source("1.2.0"), "--libraries", "libs")).toBe(1);
    expect(desk.out).toContain("against 1.0.0: governance change: widened at acme.ops.store: ~ connector acme.ops.store.class: internal → confidential\n");
    expect(desk.err).toContain(" error MDT-E1607: ");
    expect(desk.published()).toEqual(before);
    expect(desk.mandate("publish", desk.source("2.0.0"), "--libraries", "libs"), desk.err).toBe(0);
    expect(existsSync(join(desk.dir, "libs", "acme.ops", "2.0.0", "index.json"))).toBe(true);

    // An upgrade without acceptance shows the widening and leaves the lock's bytes as they were; as JSON, it gives no lock.
    expect(desk.mandate("upgrade", "acme.ops@2.0.0", "--libraries", "libs")).toBe(1);
    expect(desk.out).toContain("governance change: widened at acme.ops.Inventory: ~ acme.ops.Inventory.budget.time: 10m → 1h\n");
    expect(desk.lockText()).toBe(oldText);
    expect(desk.mandate("upgrade", "acme.ops@2.0.0", "--libraries", "libs", "--json")).toBe(1);
    expect(JSON.parse(desk.out)).toMatchObject({ ok: true, lock: null });
    expect(desk.lockText()).toBe(oldText);

    // The old lock still pins 1.0.0, whose digest the directory's copy still has: the program checks, and runs.
    const [pinned] = desk.libraries(old);
    expect(libraryVerify(pinned!)).toMatchObject({ ok: true, version: "1.0.0", digest: old.libraries!["acme.ops"]!.digest });
    expect(check(STOCK, "mdt", { libraries: desk.libraries(old), lock: asFile(old) }).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const after = await run(w, "after");
    expect([after.state, after.result]).toEqual(["succeeded", ITEMS]);
    const resumed = await w.rt.resume("before");
    expect([resumed.state, resumed.result]).toEqual(["succeeded", ITEMS]);
    expect(await w.rt.replayRun("before")).toEqual({ status: "complete", value: ITEMS });

    // A lock that names the new release without the upgrade's acceptance (the pin's version moved by hand, its digest
    // the one accepted before): the check refuses it (E1605), and a run of the package under it does not start
    // (library_digest_mismatch); nothing is recorded.
    const unaccepted = { ...old, libraries: { "acme.ops": { ...old.libraries!["acme.ops"]!, version: "2.0.0" } } } as Lock;
    expect(check(STOCK, "mdt", { libraries: desk.libraries(unaccepted), lock: asFile(unaccepted) }).diagnostics.filter((d) => d.severity === "error").map((d) => d.code)).toContain("MDT-E1605");
    const refused = await refusal(run(w, "unaccepted", buildPackage(w.pkg.program, unaccepted, {}, desk.libraries(unaccepted))));
    expect(refused.code).toBe("library_digest_mismatch");
    expect(refused.message).toContain(`the lock pins ${old.libraries!["acme.ops"]!.digest}`);
    expect(await w.db.query("select 1 from runs where run_id = 'unaccepted'")).toEqual([]);

    // Accepted, the upgrade writes the lock that pins 2.0.0, and the program runs under it.
    expect(desk.mandate("upgrade", "acme.ops@2.0.0", "--libraries", "libs", "--accept-governance"), desk.err).toBe(0);
    expect(desk.out.endsWith("wrote mandate.lock.json\n")).toBe(true);
    const accepted = desk.lock();
    expect(accepted.libraries!["acme.ops"]!.version).toBe("2.0.0");
    expect(accepted.libraries!["acme.ops"]!.digest).not.toBe(old.libraries!["acme.ops"]!.digest);
    const w2 = await stockWorld(desk, accepted);
    const upgraded = await run(w2, "upgraded");
    expect([upgraded.state, upgraded.result]).toEqual(["succeeded", ITEMS]);
  });
});
