// `mandate run` with libraries (language 0.6; spec/library.md "The local directory", "At load", "Waiting period and
// revocation"): the command reads the libraries the program's lock pins from the directory of libraries
// (`--libraries`, or `libraries.dir` of the configuration), gives them to the check, and puts them in the package it
// starts. A library that is not the one the lock pins is not run (`library_digest_mismatch`), and a digest the
// configuration revokes is never loaded, at the start or at a resume (`library_revoked`). Every call here is a
// separate CLI call over one PGlite database in a directory, as a person would make it: each is a runtime of its own,
// so a run that waits was stopped, and the next call resumes it from what the package and the run stored.

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { libraryVerify, pinnedLibraries, type LibraryPin, type LibrarySource, type Lock } from "@mandate/bridge";
import { withCompiler } from "@mandate/bridge/mode";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { modulePath } from "../../bridge/src/wasm/module.js";
import { main } from "../src/cli.js";
import { applications } from "../src/package.js";
import { Runtime } from "../src/runtime.js";
import { Crash } from "../src/signals.js";
import { SimAgents } from "../src/sim.js";
import { closeAll, world } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-cli-library-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterAll(closeAll);

/** A library of two modules: plain definitions (a type, and a function over it) and a pattern that asks a person. */
const DESK: LibrarySource = {
  manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.desk", version: "1.0.0", modules: ["desk.mdt", "types.mdt"] }, null, 2) + "\n",
  files: {
    "types.mdt": `mandate @ 0.6

module acme.desk.types @ 1.0

/// A request someone made.
pub type Request = { title: Text }

/// What a request is called.
pub fn title_of(r: Request) -> Text ! {} {
  r.title
}
`,
    "desk.mdt": `mandate @ 0.6

module acme.desk @ 1.0

use std.{human}
use acme.desk.types.{Request, title_of}

/// Asks the one who owns the desk about a request, once, and gives the answer.
pub pattern AskOwner(
  owner: role
) (input: Request) -> Untrusted<Text>
{
  human.ask(title_of(input), role: owner)
}
`,
  },
};

/** A library of one module, with a pattern that hands the work to a skill. */
const FLOWS: LibrarySource = {
  manifest: JSON.stringify({ library: "mandate/library/0.6", name: "acme.flows", version: "1.2.0", modules: ["flows.mdt"] }),
  files: {
    "flows.mdt": `mandate @ 0.6

module acme.flows @ 1.2

/// A note to greet.
pub type Note = { text: Text }

/// The text of a note.
pub fn text_of(n: Note) -> Text ! {} {
  n.text
}

/// Asks once, about the note's text.
pub pattern Once(
  work: skill(Text) -> Inferred<Text>
) (input: Note) -> Inferred<Text>
{
  delegate work(text_of(input))
}
`,
  },
};

/** A program that applies the pattern of acme.desk, and has a workflow of its own over the library's plain definitions. */
const ASK = `mandate @ 0.6

module example.desk @ 0.1

use std.{human, fs}
use acme.desk.{AskOwner}
use acme.desk.types.{Request, title_of}

role keeper "Keeper of the desk"

capability Notes = fs.read("/tmp/notes")

/// Asks the keeper about a request.
workflow Ask = AskOwner(owner: keeper)
  caps   Notes
  budget { time: 5m, steps: 4 }

/// What a request is called: the library's function, and nothing else.
workflow Title(input: Request) -> Text
  caps   Notes
  budget { time: 5m, steps: 4 }
{
  title_of(input)
}
`;

/** A program that applies the pattern of acme.flows to an agent of its own. */
const GREET = `mandate @ 0.6

module example.greet @ 0.1

use std.{model}
use acme.flows.{Once, Note}

capability ModelStd = model.infer(tier: standard, max_class: internal)

agent Greeter {
  role   "Writes one line of greeting."
  caps   ModelStd
  budget { time: 2m, steps: 2 }
  skill greet(name: Text) -> Inferred<Text> ! {Model}
}

/// Greets the one the note names.
workflow Greet = Once(work: Greeter.greet)
  caps   ModelStd
  budget { time: 5m, steps: 4 }
`;

const LIBS = join(dir, "libs");
const PROGRAM = join(dir, "ask.mdt");
const LOCK = join(dir, "ask.lock.json");
const KEYS = join(dir, "decision-keys");
const CONFIG = join(dir, "mandate.runtime.json");
const INPUT = '{"input":{"title":"The spring list"}}';

/** Writes a library into the directory of libraries, in its layout: `<name>/<version>/`. */
function publish(l: LibrarySource, libs = LIBS): string {
  const m = JSON.parse(l.manifest) as { name: string; version: string };
  const at = join(libs, m.name, m.version);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "mandate.library.json"), l.manifest);
  for (const [f, text] of Object.entries(l.files)) writeFileSync(join(at, f), text);
  return at;
}

/** The lock's pin of a library: the Rust compiler's, whatever compiler the test runs with. */
const pinOf = (l: LibrarySource): LibraryPin => libraryVerify(l).pin!;

/** A configuration over the one database, with this `libraries` member (none when undefined). */
function config(name: string, libraries?: Record<string, unknown>): string {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ database: "pglite:db", decisions: { keys: "decision-keys", mode: "signed" }, ...(libraries ? { libraries } : {}) }));
  return file;
}

/** One CLI call under `conf`, as a person would make it; returns its exit status and output. */
async function mandateWith(conf: string, ...args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", conf], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}
const mandate = (...args: string[]) => mandateWith(CONFIG, ...args);
const revisionOf = (out: string): string => out.match(/revision (\d+)/)![1]!;

let key = "";

beforeAll(async () => {
  writeFileSync(PROGRAM, ASK);
  config("mandate.runtime.json", { dir: "libs" });
  // The keeper's key, made as a person makes it; its public half is the runtime's to hold.
  mkdirSync(join(dir, "ada"));
  key = join(dir, "ada", "ada.key");
  const made = await mandate("key", "new", "--out", key);
  expect(made.code, made.err).toBe(0);
  const id = made.out.match(/^key (sha256:[0-9a-f]{64})\n/)![1]!;
  mkdirSync(KEYS);
  copyFileSync(join(dir, "ada", `${id.slice("sha256:".length)}.pem`), join(KEYS, `${id.slice("sha256:".length)}.pem`));
  publish(DESK);
  const lock = { lock: "mandate/lock/0.6", modules: {}, libraries: { "acme.desk": pinOf(DESK) }, members: { ada: { keys: [id] } }, roles: { keeper: ["ada"] } };
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
}, 120_000);

const run = (conf: string, id: string, ...more: string[]) => mandateWith(conf, "run", PROGRAM, "--lock", LOCK, "--workflow", "Ask", "--input", INPUT, "--run-id", id, ...more);

describe("mandate run of a program whose lock pins a library", () => {
  it("starts with the library read from the directory, stops, resumes from what the package carries, and replays", async () => {
    const started = await run(CONFIG, "d1");
    expect(started.code, started.err).toBe(0);
    expect(started.out).toContain("run d1  Ask  waiting");
    // The question is the library's function of the input, asked by the library's pattern.
    expect(started.out).toContain("waiting for: an answer: \"The spring list");
    const revision = revisionOf(started.out);
    const status = await mandate("status", "d1");
    expect(status.code, status.err).toBe(0);
    expect(status.out).toContain("run d1  Ask  waiting");
    // The directory of libraries is gone: every later call is a runtime of its own, and reads the libraries of the
    // run from its package, where the start put them.
    const kept = join(dir, "libs-kept");
    cpSync(LIBS, kept, { recursive: true });
    rmSync(LIBS, { recursive: true });
    try {
      const answered = await mandate("answer", "d1", "--revision", revision, "--key", key, "it", "is", "fine");
      expect(answered.code, answered.err).toBe(0);
      expect(answered.out).toContain("run d1  Ask  succeeded");
      expect(answered.out).toContain("result: \"it is fine\"");
      const replayed = await mandate("replay", "d1");
      expect(replayed.code, replayed.err).toBe(0);
      expect(replayed.out).toContain("complete");
      expect(replayed.out).toContain("it is fine");
      const shown = await mandate("show", "d1", "--format", "json");
      expect(shown.code, shown.err).toBe(0);
      // Without the directory nothing new starts: the lock pins a library the command was not given (E1605).
      const without = await run(CONFIG, "d1-none");
      expect(without.code).toBe(1);
      expect(without.err).toContain("load_verification_failed");
      expect(without.err).toContain("MDT-E1605");
    } finally {
      cpSync(kept, LIBS, { recursive: true });
    }
  });

  it("runs a workflow over the library's plain definitions to its end, with the directory --libraries names", async () => {
    // The configuration names no directory; a relative --libraries is relative to the working directory, so it is given whole.
    const bare = config("bare.json");
    const done = await mandateWith(bare, "run", PROGRAM, "--lock", LOCK, "--workflow", "Title", "--input", INPUT, "--run-id", "d2", "--libraries", LIBS);
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain("run d2  Title  succeeded");
    expect(done.out).toContain("result: \"The spring list");
    expect((await mandateWith(bare, "replay", "d2")).out).toContain("The spring list");
    // With neither, the library is not read: E1605, and no run.
    const none = await mandateWith(bare, "run", PROGRAM, "--lock", LOCK, "--workflow", "Title", "--input", INPUT, "--run-id", "d2-none");
    expect(none.code).toBe(1);
    expect(none.err).toContain("MDT-E1605");
    expect((await mandateWith(bare, "status", "d2-none")).err).toContain("unknown_run");
    // --libraries comes before the configuration's directory.
    const wrong = config("wrong.json", { dir: "nowhere" });
    expect((await mandateWith(wrong, "run", PROGRAM, "--lock", LOCK, "--workflow", "Title", "--input", INPUT, "--run-id", "d2-flag", "--libraries", LIBS)).code).toBe(0);
    expect((await mandateWith(wrong, "run", PROGRAM, "--lock", LOCK, "--workflow", "Title", "--input", INPUT, "--run-id", "d2-conf")).code).toBe(1);
  });

  it("never loads a digest the configuration revokes: not at the start, and not at a resume (library_revoked)", async () => {
    const digest = pinOf(DESK).digest;
    const revoking = config("revoking.json", { dir: "libs", revoked: [digest] });
    const other = config("other.json", { dir: "libs", revoked: [`sha256:${"0".repeat(64)}`] });
    // At the start.
    const refused = await run(revoking, "d3-revoked");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("library_revoked");
    expect(refused.err).toContain(digest);
    expect((await mandate("status", "d3-revoked")).err).toContain("unknown_run");
    // Another digest revoked: it starts, and waits.
    const started = await run(other, "d3");
    expect(started.code, started.err).toBe(0);
    const revision = revisionOf(started.out);
    // The digest is revoked while the run waits. The answer is a signed decision and is recorded; the resume it asks
    // for loads nothing of the package: the run stops for a person, with the violation, and gives no result.
    const held = await mandateWith(revoking, "answer", "d3", "--revision", revision, "--key", key, "fine");
    expect(held.code, held.err).toBe(0);
    expect(held.out).toContain("run d3  Ask  attention_required");
    expect(held.out).toContain("library_revoked");
    expect(held.out).toContain(digest);
    expect(held.out).not.toContain("succeeded");
    expect(held.out).not.toContain("result:");
    const still = await mandateWith(revoking, "status", "d3");
    expect(still.out).toContain("run d3  Ask  attention_required");
    // A run that waits under a configuration that revokes nothing of it is resumed as ever.
    const second = await run(other, "d3-b");
    const answered = await mandateWith(other, "answer", "d3-b", "--revision", revisionOf(second.out), "--key", key, "fine");
    expect(answered.code, answered.err).toBe(0);
    expect(answered.out).toContain("run d3-b  Ask  succeeded");
  });

  it("refuses a library whose file was changed after the lock pinned it (library_digest_mismatch)", async () => {
    const libs = join(dir, "libs-tampered");
    for (const [file, change] of [
      ["types.mdt", (t: string) => t.replace("What a request is called.", "What a request is called, changed.")],
      ["desk.mdt", (t: string) => `${t}\n/// One more.\npub type More = { n: Int }\n`],
      // Its manifest alone, its modules as pinned: another version under the pinned version's directory.
      ["mandate.library.json", (t: string) => t.replace('"1.0.0"', '"1.0.1"')],
    ] as const) {
      rmSync(libs, { recursive: true, force: true });
      const at = publish(DESK, libs);
      // As pinned, it runs.
      if (file === "types.mdt") expect((await run(CONFIG, "d4-ok", "--libraries", libs)).code).toBe(0);
      const before = readFileSync(join(at, file), "utf8");
      writeFileSync(join(at, file), change(before));
      expect(readFileSync(join(at, file), "utf8"), file).not.toBe(before);
      const refused = await run(CONFIG, `d4-${file}`, "--libraries", libs);
      expect(refused.code, file).toBe(1);
      expect(refused.err, file).toContain("library_digest_mismatch");
      expect(refused.err, file).toContain(`the lock pins ${pinOf(DESK).digest}`);
      expect((await mandate("status", `d4-${file}`)).err, file).toContain("unknown_run");
    }
  });

  it("gives test and approve-envelope the libraries too, and names the option in the usage text", async () => {
    const tested = await mandate("test", PROGRAM, "--lock", LOCK);
    expect(tested.code, tested.err).toBe(0);
    expect(tested.out).toBe("no tests\n");
    const bare = config("bare.json");
    expect((await mandateWith(bare, "test", PROGRAM, "--lock", LOCK, "--libraries", LIBS)).code).toBe(0);
    const none = await mandateWith(bare, "test", PROGRAM, "--lock", LOCK);
    expect(none.code).toBe(1);
    expect(none.err).toContain("MDT-E1605");
    // A revoked digest is not loaded by a test either.
    const revoking = config("revoking.json", { dir: "libs", revoked: [pinOf(DESK).digest] });
    expect((await mandateWith(revoking, "test", PROGRAM, "--lock", LOCK)).err).toContain("library_revoked");
    // approve-envelope reads the program as run does: with its libraries it reaches the envelope, which it has none of.
    const envelope = await mandate("approve-envelope", PROGRAM, "--lock", LOCK, "--key", key);
    expect(envelope.code).not.toBe(0);
    expect(envelope.err).not.toContain("MDT-E1605");
    expect(envelope.err).toContain("envelope");
    expect((await mandateWith(bare, "approve-envelope", PROGRAM, "--lock", LOCK, "--key", key)).err).toContain("MDT-E1605");
    const usage = await mandate("frobnicate");
    expect(usage.code).toBe(2);
    for (const line of ["[--module FILE]… [--libraries DIR] [--priority high|normal]", "mandate test <program> [--json] [--lock FILE] [--libraries DIR]", "--libraries DIR is the directory of libraries"]) expect(usage.err).toContain(line);
    for (const option of ["--libraries"]) expect((await mandate("run", PROGRAM, option)).code).toBe(2);
  });
});

describe("a run over simulated agents of a package made from the directory of libraries", () => {
  it("starts, stops, resumes in a runtime of its own and replays: the pattern and the function are the library's", async () => {
    const libs = join(dir, "libs-agents");
    publish(FLOWS, libs);
    const lock = { modules: {}, libraries: { "acme.flows": pinOf(FLOWS) } } as Lock;
    // What the command line reads from the directory, by the lock: the library, file for file.
    const libraries = pinnedLibraries(lock, libs);
    expect(libraries).toEqual([FLOWS]);
    const agents = new SimAgents().on("Greeter.greet", (req) => ({ ok: `hello, ${String((req.args as unknown[])[0])}`, cost: { steps: 1 } }));
    const w = await world(GREET, { agents, decisions: { mode: "signed" }, lock, libraries });
    expect(w.pkg.libraries).toEqual([FLOWS]);
    expect(applications(w.pkg.program)).toEqual(["Greet = Once"]);
    // To its end, and replayed.
    const done = await w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Ada" } }, runId: "a1" });
    expect(done.state, JSON.stringify(done.attention ?? done.error)).toBe("succeeded");
    expect(done.result).toBe("hello, Ada");
    expect(await w.rt.replayRun("a1")).toEqual({ status: "complete", value: "hello, Ada" });
    // Stopped after the agent's work was recorded; a runtime of its own resumes it and replays it.
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Grace" } }, runId: "a2" })).rejects.toBeInstanceOf(Crash);
    rmSync(libs, { recursive: true });
    const again = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts });
    const resumed = await again.resume("a2");
    expect(resumed.state, JSON.stringify(resumed.attention ?? resumed.error)).toBe("succeeded");
    expect(resumed.result).toBe("hello, Grace");
    expect(await again.replayRun("a2")).toEqual({ status: "complete", value: "hello, Grace" });
    // The directory's library, revoked: a runtime that is told so resumes nothing of it.
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(w.rt.startRun({ pkg: w.pkg, workflow: "Greet", input: { input: { text: "Lin" } }, runId: "a3" })).rejects.toBeInstanceOf(Crash);
    const revoking = new Runtime(w.db, w.adapters, undefined, undefined, { decisions: { mode: "signed" }, artifacts: w.rt.artifacts, libraries: { revoked: [pinOf(FLOWS).digest] } });
    const stopped = await revoking.resume("a3");
    expect(stopped.state).toBe("attention_required");
    expect(stopped.attention).toMatchObject({ violation: "library_revoked" });
    expect(stopped.result).toBeNull();
  });
});
