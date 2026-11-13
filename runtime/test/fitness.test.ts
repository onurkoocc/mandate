// Host fitness (spec/boundary.md "Isolation level and host fitness", G19). A
// lock's `host` names the least versions of the host's tools; a run starts,
// and resumes, only on a host that meets them, and is refused `unfit_host`
// before its lease otherwise. The tools are read through a probe the tests
// replace, so that none of this needs a `bwrap`; the probe of the real host
// is tried on Linux with stand-ins for `bwrap`.

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { check, type Lock } from "@mandate/compiler";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { hostShortfalls, meets, parseVersion, systemProbe, versionIn, type HostProbe, type HostTool, type ToolReading } from "../src/fitness.js";
import { buildPackage, verifyPackage } from "../src/runtime.js";
import { closeAll, LOCK, world } from "./helpers.js";
import { ASK, ISSUE } from "./programs.js";

afterAll(closeAll);

/** A host whose tools read as `readings` says; it records what it was asked. */
class FakeHost implements HostProbe {
  readonly asked: HostTool[] = [];
  constructor(public readings: Partial<Record<HostTool, ToolReading>>) {}
  async read(tool: HostTool): Promise<ToolReading> {
    this.asked.push(tool);
    const r = this.readings[tool];
    if (!r) throw new Error(`no reading for ${tool}`);
    return r;
  }
}

const FIT: Partial<Record<HostTool, ToolReading>> = { node: { output: "22.23.4" }, bwrap: { output: "bubblewrap 0.11.0\n", path: "/usr/bin/bwrap", setuid: false } };
const HOST = { node: "22.23.4", bwrap: "0.11.0" };

describe("a version", () => {
  const v = (s: string) => parseVersion(s)!;
  const meet = (found: string, least: string) => meets(v(found), v(least));

  it("is compared by its numbers, a missing component reading as 0", () => {
    expect(meet("22.23.4", "22.23.4")).toBe(true);
    expect(meet("22.23", "22.23.0")).toBe(true);
    expect(meet("22.23.0", "22.23")).toBe(true);
    expect(meet("22.23.3", "22.23.4")).toBe(false);
    // Not as text: 22.100 is above 22.23, 0.10 above 0.9.
    expect(meet("22.100.0", "22.23.4")).toBe(true);
    expect(meet("0.10.0", "0.9.1")).toBe(true);
    expect(meet("0.9.1", "0.10")).toBe(false);
    expect(meet("1", "0.99.99")).toBe(true);
    expect(meet("0.11.0.1", "0.11.0")).toBe(true);
  });

  it("with a suffix reads as just below its numbers: it meets only a lower least version", () => {
    expect(meet("0.11.0-rc1", "0.11.0")).toBe(false);
    expect(meet("0.11.0+deb1", "0.11")).toBe(false);
    expect(meet("0.11.0~beta", "0.10.9")).toBe(true);
    expect(meet("26.0.0-nightly20261101", "25")).toBe(true);
    expect(parseVersion("0.11.0-rc1")).toEqual({ numbers: [0, 11, 0], suffixed: true });
  });

  it("is not read from what cannot be compared", () => {
    for (const s of ["", "v0.11.0", "0.09.0", "0.11.", ".11", "0.11.0 beta", "1.2.3.4.5", "abc", "0.11.0-", "1e3", " 0.11.0", "1234567890"]) expect(parseVersion(s), s).toBeUndefined();
  });

  it("is found in what each tool prints: Node's whole version, Bubblewrap's after its name", () => {
    expect(versionIn("node", "22.23.4")).toBe("22.23.4");
    expect(versionIn("bwrap", "bubblewrap 0.9.0\n")).toBe("0.9.0");
    expect(versionIn("bwrap", "bubblewrap 0.9.0")).toBe("0.9.0");
    for (const s of ["0.9.0\n", "bwrap 0.9.0\n", "bubblewrap 0.9.0\nmore\n", "bubblewrap  0.9.0\n", "bubblewrap\n"]) expect(versionIn("bwrap", s), s).toBeUndefined();
  });
});

describe("what a host falls short of", () => {
  const short = (readings: Partial<Record<HostTool, ToolReading>>, host: Lock["host"] = HOST) => hostShortfalls(host!, new FakeHost({ ...FIT, ...readings }));

  it("is nothing on a host that meets every least version", async () => {
    expect(await short({})).toEqual([]);
    expect(await short({ node: { output: "24.22.1" }, bwrap: { output: "bubblewrap 1.0.0\n", path: "/usr/bin/bwrap", setuid: false } })).toEqual([]);
  });

  it("names the tool, what was found and what the lock asks", async () => {
    expect(await short({ bwrap: { output: "bubblewrap 0.9.0\n", path: "/usr/bin/bwrap" } })).toEqual(["bwrap: 0.9.0 found, the lock asks 0.11.0 or later, not setuid"]);
    expect(await short({ node: { output: "22.11.0" } })).toEqual(["node: 22.11.0 found, the lock asks 22.23.4 or later"]);
    expect(await short({ node: { output: "22.11.0" }, bwrap: { output: "bubblewrap 0.9.0\n" } })).toEqual([
      "bwrap: 0.9.0 found, the lock asks 0.11.0 or later, not setuid",
      "node: 22.11.0 found, the lock asks 22.23.4 or later",
    ]);
  });

  it("is a tool that is missing, cannot be started or read, or prints what is not a version", async () => {
    const asks = "the lock asks 0.11.0 or later, not setuid";
    expect(await short({ bwrap: { missing: true } })).toEqual([`bwrap: not found on the runtime's PATH, ${asks}`]);
    expect(await short({ bwrap: { failed: "gave no version within 5 s" } })).toEqual([`bwrap: gave no version within 5 s, ${asks}`]);
    expect(await short({ bwrap: { failed: "exited with code 1 on --version" } })).toEqual([`bwrap: exited with code 1 on --version, ${asks}`]);
    expect(await short({ bwrap: { output: "bubblewrap 0.11.0-rc1\n" } })).toEqual([`bwrap: 0.11.0-rc1 found, ${asks}`]);
    expect(await short({ bwrap: { output: "Usage: bwrap [OPTIONS...]\n" } })).toEqual([`bwrap: printed "Usage: bwrap [OPTIONS...]", which is not a version that can be compared, ${asks}`]);
    expect(await short({ bwrap: { output: `bubblewrap 0.11.0\n${"x".repeat(200)}` } })).toEqual([`bwrap: printed "bubblewrap 0.11.0\\n${"x".repeat(62)}…", which is not a version that can be compared, ${asks}`]);
    const throwing: HostProbe = { read: async () => Promise.reject(new Error("EIO")) };
    expect(await hostShortfalls({ node: "22" }, throwing)).toEqual(["node: could not be read (EIO), the lock asks 22 or later"]);
  });

  it("is a setuid bwrap whatever its version, once the lock names a least bwrap", async () => {
    expect(await short({ bwrap: { output: "bubblewrap 9.0.0\n", path: "/usr/bin/bwrap", setuid: true } })).toEqual(["bwrap: /usr/bin/bwrap is setuid, the lock asks 0.11.0 or later, not setuid"]);
    // A lock that names only node does not look at bwrap at all.
    const host = new FakeHost({ node: { output: "22.23.4" } });
    expect(await hostShortfalls({ node: "22.23.4" }, host)).toEqual([]);
    expect(host.asked).toEqual(["node"]);
  });
});

describe("a run whose lock sets host", () => {
  const lock = (host: Lock["host"]): Lock => ({ ...LOCK, ...(host ? { host } : {}) });
  const counts = async (w: Awaited<ReturnType<typeof world>>) => {
    const [r] = await w.db.query<{ runs: number; events: number; packages: number }>("select (select count(*) from runs)::int as runs, (select count(*) from events)::int as events, (select count(*) from packages)::int as packages");
    return r!;
  };
  const refusal = async (p: Promise<unknown>): Promise<Error> => {
    try {
      await p;
    } catch (e) {
      return e as Error;
    }
    throw new Error("not refused");
  };

  it("starts on a host that meets it, and reads only the tools it names", async () => {
    const host = new FakeHost(FIT);
    const w = await world(ASK, { lock: lock(HOST), hostProbe: host });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-1" });
    expect(run.state).toBe("waiting");
    // Once at the start, once at the resume the start drives.
    expect(host.asked).toEqual(["bwrap", "node", "bwrap", "node"]);
  });

  it("does not start on a host below it: no run, no event, no package stored (unfit_host)", async () => {
    const host = new FakeHost({ ...FIT, bwrap: { output: "bubblewrap 0.9.0\n", path: "/usr/bin/bwrap", setuid: false } });
    const w = await world(ASK, { lock: lock(HOST), hostProbe: host });
    const e = await refusal(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-2" }));
    expect(e).toMatchObject({ code: "unfit_host" });
    expect(e.message).toBe("unfit_host: This host does not meet the package's lock: bwrap: 0.9.0 found, the lock asks 0.11.0 or later, not setuid. Nothing of the package runs here (spec/boundary.md).");
    expect(await counts(w)).toEqual({ runs: 0, events: 0, packages: 0 });
  });

  it("is resumed only on a host that meets it: an unfit host takes no lease and leaves the run as it was", async () => {
    const host = new FakeHost(FIT);
    const w = await world(ASK, { lock: lock(HOST), hostProbe: host });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-3" });
    const before = await counts(w);
    host.readings = { ...FIT, node: { output: "20.0.0" } };
    const e = await refusal(w.rt.resume("fit-3"));
    expect(e).toMatchObject({ code: "unfit_host" });
    expect(e.message).toContain("node: 20.0.0 found, the lock asks 22.23.4 or later");
    const after = await w.rt.getRun("fit-3");
    expect({ state: after.state, fence: after.fence, revision: after.revision }).toEqual({ state: run.state, fence: run.fence, revision: run.revision });
    expect(await counts(w)).toEqual(before);
    // A fit host resumes it where it was.
    host.readings = FIT;
    const resumed = await w.rt.resume("fit-3");
    expect(resumed.state).toBe("waiting");
    expect(resumed.fence).toBe(run.fence + 1);
  });

  it("keeps an answer given on an unfit host, and moves on once a fit host resumes it", async () => {
    const host = new FakeHost(FIT);
    const w = await world(ASK, { lock: lock(HOST), hostProbe: host });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-4" });
    host.readings = { ...FIT, bwrap: { missing: true } };
    const command = (run.waiting as { command: string }).command;
    const e = await refusal(w.rt.submitInput("fit-4", { sender: "dave", messageId: "m1" }, { commandId: command, revision: run.revision, value: "yes" }));
    expect(e).toMatchObject({ code: "unfit_host" });
    expect(e.message).toContain("bwrap: not found on the runtime's PATH");
    expect((await w.rt.getRun("fit-4")).fence).toBe(run.fence);
    host.readings = FIT;
    const done = await w.rt.resume("fit-4");
    expect(done.state).toBe("succeeded");
    expect(done.result).toBe("yes");
  });

  it("that has finished is not checked again: resuming it runs nothing", async () => {
    const host = new FakeHost(FIT);
    const w = await world(ASK, { lock: lock(HOST), hostProbe: host });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-5" });
    await w.rt.submitInput("fit-5", { sender: "dave", messageId: "m1" }, { commandId: (run.waiting as { command: string }).command, revision: run.revision, value: "yes" });
    host.readings = {};
    expect((await w.rt.resume("fit-5")).state).toBe("succeeded");
  });

  it("is a package of any language: the lock of a 0.2 package may set host, and loads", async () => {
    const src = ASK.replace("module test.ops", "mandate @ 0.2\n\nmodule test.ops");
    const program = check(src, "mdt").program!;
    expect(program.language).toBe("mandate/0.2");
    expect(() => verifyPackage(buildPackage(program, lock({ node: "22" })))).not.toThrow();
    const w = await world(src, { lock: lock({ node: "99" }), hostProbe: new FakeHost(FIT) });
    expect(await refusal(w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-6" }))).toMatchObject({ code: "unfit_host" });
  });

  it("is not checked without host: nothing is read and nothing changes", async () => {
    const host = new FakeHost({});
    const w = await world(ASK, { lock: lock(undefined), hostProbe: host });
    expect((await w.rt.startRun({ pkg: w.pkg, workflow: "Ask", input: ISSUE, runId: "fit-7" })).state).toBe("waiting");
    expect(host.asked).toEqual([]);
  });
});

describe("the host's own tools", () => {
  it("give this process's Node version", async () => {
    expect(await systemProbe.read("node")).toEqual({ output: process.versions.node, path: process.execPath });
    expect(await hostShortfalls({ node: process.versions.node }, systemProbe)).toEqual([]);
  });

  describe.runIf(process.platform !== "win32")("and a stand-in for bwrap on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-fit-"));
    const path = process.env["PATH"];
    afterEach(() => {
      process.env["PATH"] = path;
      delete process.env["MANDATE_GITHUB_TOKEN"];
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    /** Puts a `bwrap` that runs `script` first on PATH, in a directory of its own. */
    const stand = (name: string, script: string, mode = 0o755): string => {
      const d = join(dir, name);
      const p = join(d, "bwrap");
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
      writeFileSync(p, `#!/bin/sh\n${script}\n`);
      chmodSync(p, mode);
      process.env["PATH"] = `${d}${delimiter}${path}`;
      return p;
    };

    it("is read with --version, its path and whether it is setuid", async () => {
      const p = stand("plain", '[ "$1" = --version ] && echo "bubblewrap 0.9.0"');
      expect(await systemProbe.read("bwrap")).toEqual({ output: "bubblewrap 0.9.0\n", path: p, setuid: false });
    });

    it("is started with none of the runtime's secrets in its environment", async () => {
      process.env["MANDATE_GITHUB_TOKEN"] = "ghp_not_for_bwrap";
      stand("env", '[ -z "$MANDATE_GITHUB_TOKEN" ] && echo "bubblewrap 1.0.0" || echo "the token reached bwrap"');
      expect(await systemProbe.read("bwrap")).toMatchObject({ output: "bubblewrap 1.0.0\n" });
    });

    it("that does not answer within 5 seconds is unfit", { timeout: 20_000 }, async () => {
      stand("slow", "sleep 30");
      const started = Date.now();
      expect(await systemProbe.read("bwrap")).toEqual({ failed: "gave no version within 5 s" });
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("that fails is unfit, with its exit code", async () => {
      stand("fails", "exit 3");
      expect(await systemProbe.read("bwrap")).toEqual({ failed: "exited with code 3 on --version" });
    });

    it("that is not executable is not the one the sandbox would run: it is passed over", async () => {
      stand("noexec", 'echo "bubblewrap 0.9.0"', 0o644);
      process.env["PATH"] = join(dir, "noexec");
      expect(await systemProbe.read("bwrap")).toEqual({ missing: true });
    });

    it("that is setuid is reported so, and not started", async (ctx) => {
      const p = stand("setuid", 'echo "bubblewrap 9.0.0"', 0o4755);
      if ((statSync(p).mode & 0o4000) === 0) ctx.skip();
      expect(await systemProbe.read("bwrap")).toEqual({ output: "", path: p, setuid: true });
      expect(await hostShortfalls({ bwrap: "0.1" }, systemProbe)).toEqual([`bwrap: ${p} is setuid, the lock asks 0.1 or later, not setuid`]);
    });
  });
});
