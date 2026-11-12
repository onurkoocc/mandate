// The environment of the processes the runtime starts (env.ts). The runtime
// reads its secrets from its own environment; a process it starts gets only
// what a program needs to run, and what its caller names. `docker` is
// observed for real: a stand-in that prints its environment is put first on
// the search path (a copy of node, which a preload makes print and exit).

import { copyFileSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { realDocker } from "../src/boundary.js";
import { childEnv } from "../src/env.js";

describe("childEnv", () => {
  it("keeps what a program needs and what the caller names, and drops the rest", () => {
    const from = { PATH: "/usr/bin", HOME: "/home/a", TZ: "UTC", MANDATE_GITHUB_TOKEN: "t", CLAUDE_API_KEY: "k", DOCKER_HOST: "unix:///d.sock" };
    expect(childEnv({}, from, false)).toEqual({ PATH: "/usr/bin", HOME: "/home/a", TZ: "UTC" });
    expect(childEnv({ pass: ["DOCKER_HOST"], set: { MANDATE_ENV: "staging" } }, from, false)).toEqual({ PATH: "/usr/bin", HOME: "/home/a", TZ: "UTC", DOCKER_HOST: "unix:///d.sock", MANDATE_ENV: "staging" });
  });

  it("matches names as Windows does, without regard to case, and keeps their casing", () => {
    const from = { Path: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows", Mandate_GitHub_Token: "t" };
    expect(childEnv({}, from, true)).toEqual({ Path: "C:\\Windows\\System32", SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows" });
    // A name the caller sets replaces the one stored under another casing; it is not there twice.
    expect(childEnv({ set: { PATH: "C:\\tools" } }, from, true)).toEqual({ PATH: "C:\\tools", SYSTEMROOT: "C:\\Windows", windir: "C:\\Windows" });
    // Elsewhere names are case-sensitive: `Path` is not PATH.
    expect(childEnv({}, { Path: "/x", PATH: "/usr/bin" }, false)).toEqual({ PATH: "/usr/bin" });
  });
});

describe("docker's environment", () => {
  const saved: Record<string, string | undefined> = {};
  const set = (k: string, v: string): void => {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  };
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      delete saved[k];
    }
  });

  /** A directory with a `docker` that prints its environment as JSON and exits, and the preload that makes it do so. */
  function standIn(): { dir: string; preload: string } {
    const dir = mkdtempSync(join(tmpdir(), "mandate-docker-"));
    made.push(dir);
    const preload = join(dir, "print-env.cjs");
    writeFileSync(preload, "process.stdout.write(JSON.stringify(process.env)); process.exit(0);\n");
    if (process.platform === "win32") {
      // Windows starts only an .exe by name without a shell: a hard link to node where it can, else a copy.
      try {
        linkSync(process.execPath, join(dir, "docker.exe"));
      } catch {
        copyFileSync(process.execPath, join(dir, "docker.exe"));
      }
    } else symlinkSync(process.execPath, join(dir, "docker"));
    return { dir, preload };
  }

  it("gets what a program needs, the Docker client's settings and what the caller gives; none of the runtime's secrets", async () => {
    const { dir, preload } = standIn();
    set("PATH", `${dir}${delimiter}${process.env["PATH"] ?? ""}`);
    set("MANDATE_CANARY_KEY", "sk-canary");
    set("MANDATE_GITHUB_TOKEN", "ghp_not_a_token");
    set("CLAUDE_API_KEY", "sk-ant-not-a-key");
    set("DOCKER_HOST", "unix:///run/not-docker.sock");
    // NODE_OPTIONS is the caller's to give, like a compose file's variables: here it makes the stand-in print.
    const r = await realDocker.run(["version"], { env: { NODE_OPTIONS: `--require "${preload.replace(/\\/g, "/")}"`, MANDATE_ENV: "staging" } });
    expect(r.exitCode, r.stderr).toBe(0);
    const env = JSON.parse(r.stdout) as Record<string, string>;
    const names = Object.keys(env).map((k) => k.toUpperCase());
    expect(names).toContain("PATH");
    expect(env["DOCKER_HOST"]).toBe("unix:///run/not-docker.sock");
    expect(env["MANDATE_ENV"]).toBe("staging");
    for (const secret of ["MANDATE_CANARY_KEY", "MANDATE_GITHUB_TOKEN", "CLAUDE_API_KEY"]) expect(names).not.toContain(secret);
  });
});
