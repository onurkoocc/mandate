// Inbound messages and package verification (Doc 4 §3.5, §8.9; R03, S09).

import { check } from "@mandate/compiler";
import { afterAll, describe, expect, it } from "vitest";
import { buildPackage, verifyPackage } from "../src/runtime.js";
import { isObj } from "../src/values.js";
import { closeAll, LOCK, start, world } from "./helpers.js";
import { ASK, FIX } from "./programs.js";

afterAll(closeAll);

describe("R03: inbound messages are deduplicated by key and checked by payload", () => {
  it("a duplicate is ignored; the same key with another payload is refused", async () => {
    const w = await world(ASK);
    const run = await start(w, "Ask", "r3");
    expect(run.state).toBe("waiting");
    const cmd = isObj(run.waiting) ? String(run.waiting["command"]) : "";
    const msg = { sender: "alice", messageId: "m1" };
    const done = await w.rt.submitInput("r3", msg, { commandId: cmd, revision: run.revision, value: "yes" });
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("yes");
    const events = (await w.rt.journal.events("r3")).length;
    expect((await w.rt.submitInput("r3", msg, { commandId: cmd, revision: run.revision, value: "yes" })).revision).toBe(done.revision);
    expect((await w.rt.journal.events("r3")).length).toBe(events);
    await expect(w.rt.submitInput("r3", msg, { commandId: cmd, revision: run.revision, value: "no" })).rejects.toMatchObject({ code: "inbox_payload_mismatch" });
    await expect(w.rt.submitInput("r3", { sender: "alice", messageId: "m2" }, { commandId: cmd, revision: done.revision, value: "no" })).rejects.toMatchObject({ code: "no_wait" });
    expect((await w.rt.getRun("r3")).result).toBe("yes");
  });
});

describe("SubmitInput names the revision the answer was given on (§16.1)", () => {
  it("an answer to an older view of the run is refused and changes nothing", async () => {
    const w = await world(ASK);
    const seen = await start(w, "Ask", "rev");
    const cmd = isObj(seen.waiting) ? String(seen.waiting["command"]) : "";
    const now = await w.rt.resume("rev");
    expect(now.revision).toBeGreaterThan(seen.revision);
    await expect(w.rt.submitInput("rev", { sender: "alice", messageId: "m1" }, { commandId: cmd, revision: seen.revision, value: "yes" })).rejects.toMatchObject({ code: "stale_revision" });
    expect(await w.rt.getRun("rev")).toMatchObject({ state: "waiting", revision: now.revision });
    const done = await w.rt.submitInput("rev", { sender: "alice", messageId: "m2" }, { commandId: cmd, revision: now.revision, value: "yes" });
    expect(done).toMatchObject({ state: "succeeded", result: "yes" });
  });
});

describe("S09: the runtime verifies what it loads", () => {
  const program = () => check(FIX, "mdt").program!;

  it("accepts a package whose hashes, lock and checks hold", () => {
    expect(() => verifyPackage(buildPackage(program(), LOCK))).not.toThrow();
  });

  it("refuses an imported module that is not locked", () => {
    expect(() => verifyPackage(buildPackage(program(), { modules: {} }))).toThrow(expect.objectContaining({ code: "unlocked_module" }));
  });

  it("refuses a program changed after it was packaged", () => {
    const pkg = buildPackage(program(), LOCK);
    const defs = { ...pkg.program.defs };
    delete defs["Worker"];
    expect(() => verifyPackage({ ...pkg, program: { ...pkg.program, defs } })).toThrow(expect.objectContaining({ code: "package_hash_mismatch" }));
    expect(() => verifyPackage({ ...pkg, lock: { modules: { "company.domain": "sha256:other" } } })).toThrow(expect.objectContaining({ code: "package_hash_mismatch" }));
  });

  it("re-runs the compiler's checks on a consistently hashed package", async () => {
    const p = program();
    const defs = { ...p.defs };
    delete defs["ModelStd"];
    const pkg = buildPackage({ ...p, defs }, LOCK);
    expect(() => verifyPackage(pkg)).toThrow(expect.objectContaining({ code: "load_verification_failed" }));
    const w = await world(FIX);
    await expect(w.rt.startRun({ pkg, workflow: "Fix", input: {} })).rejects.toMatchObject({ code: "load_verification_failed" });
  });
});
