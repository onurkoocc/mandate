// Host fitness (spec/boundary.md "Isolation level and host fitness"). A lock
// of format 0.5 may name the least versions of the host's tools (`host`):
// `node`, the runtime's own, and `bwrap`, the one the Linux sandbox runs. A
// run of that package starts, and resumes, only on a host whose tools meet
// them; otherwise it is refused, `unfit_host`, before anything of it runs and
// before its lease is taken.
//
// No floor is built in: a distribution may carry a fix back without raising
// the version, so only the lock says what is too old. A lock without `host`
// checks nothing.
//
// A version is read by its numbers, never as text: one to four decimal
// components without leading zeros, `major[.minor[.patch[.more]]]`, a missing
// component reading as 0, so `22.23` and `22.23.0` are the same. It may end in
// a suffix that starts with `-`, `+` or `~` (a pre-release, a build, a
// distribution's revision). Whether a suffix comes before or after its
// numbers is not something the runtime can know, so it reads as just below
// them: `0.11.0-rc1` meets a least version of `0.10`, not one of `0.11.0`.
// Anything else (no version, text around it, a leading zero) cannot be
// compared, and is unfit rather than guessed at.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { Lock } from "@mandate/bridge";
import { childEnv } from "./env.js";
import { Violation } from "./signals.js";

/** The tools a lock's `host` may name, in the order they are checked and reported. */
export const HOST_TOOLS = ["bwrap", "node"] as const;
export type HostTool = (typeof HOST_TOOLS)[number];

/** How long `bwrap --version` may take. */
export const VERSION_TIMEOUT_MS = 5000;

/** Longest output of `--version` that is read. */
const MAX_OUTPUT = 64 * 1024;

/**
 * What reading one tool gave: what it printed for its version (with the binary's path, and for `bwrap` whether it
 * is setuid), that it is not there, or why it could not be read.
 */
export type ToolReading = { output: string; path?: string; setuid?: boolean } | { missing: true } | { failed: string };

/** How the host's tools are read; tests pass their own, so that no `bwrap` is needed. */
export interface HostProbe {
  read(tool: HostTool): Promise<ToolReading>;
}

/** A version as numbers, and whether a suffix followed them. */
export interface Version {
  numbers: number[];
  suffixed: boolean;
}

const VERSION = /^((?:0|[1-9][0-9]{0,8})(?:\.(?:0|[1-9][0-9]{0,8})){0,3})([-+~][0-9A-Za-z.+~-]+)?$/;

/** Reads a version, or undefined when it is not one that can be compared. */
export function parseVersion(text: string): Version | undefined {
  const m = VERSION.exec(text);
  if (!m) return undefined;
  return { numbers: m[1]!.split(".").map(Number), suffixed: m[2] !== undefined };
}

/** Whether `found` meets the least version `least`: its numbers are at least `least`'s, above them when it has a suffix. */
export function meets(found: Version, least: Version): boolean {
  const n = Math.max(found.numbers.length, least.numbers.length);
  for (let i = 0; i < n; i++) {
    const a = found.numbers[i] ?? 0;
    const b = least.numbers[i] ?? 0;
    if (a !== b) return a > b;
  }
  // The same numbers: only a version without a suffix is surely not below them.
  return !found.suffixed && !least.suffixed;
}

/** The version in what a tool printed: Node's is the whole text, Bubblewrap prints `bubblewrap <version>`. */
export function versionIn(tool: HostTool, output: string): string | undefined {
  if (tool === "node") return output;
  return /^bubblewrap (\S+)\n?$/.exec(output)?.[1];
}

/**
 * What the host falls short of in `host`, the lock's least versions: one line per tool, naming the tool, what was
 * found and what the lock asks. Empty when the host is fit.
 */
export async function hostShortfalls(host: NonNullable<Lock["host"]>, probe: HostProbe): Promise<string[]> {
  const out: string[] = [];
  for (const tool of HOST_TOOLS) {
    const least = host[tool];
    if (least === undefined) continue;
    const asks = `the lock asks ${least} or later${tool === "bwrap" ? ", not setuid" : ""}`;
    const wanted = parseVersion(least);
    let r: ToolReading;
    try {
      r = await probe.read(tool);
    } catch (e) {
      r = { failed: `could not be read (${(e as Error).message})` };
    }
    const found = (): string | undefined => {
      if ("missing" in r) return "not found on the runtime's PATH";
      if ("failed" in r) return r.failed;
      // A setuid bwrap is unfit whatever its version: the sandbox would be set up with the host's root privileges.
      if (tool === "bwrap" && r.setuid) return `${r.path ?? "bwrap"} is setuid`;
      const text = versionIn(tool, r.output);
      const v = text === undefined ? undefined : parseVersion(text);
      if (!v || !wanted) return `printed ${shown(r.output)}, which is not a version that can be compared`;
      return meets(v, wanted) ? undefined : `${text} found`;
    };
    const why = found();
    if (why !== undefined) out.push(`${tool}: ${why}, ${asks}`);
  }
  return out;
}

/** Refuses, `unfit_host`, a host that falls short of the lock's `host`; a lock without it checks nothing. */
export async function checkFitness(lock: Lock, probe: HostProbe): Promise<void> {
  if (!lock.host) return;
  const short = await hostShortfalls(lock.host, probe);
  if (short.length) throw new Violation("unfit_host", `This host does not meet the package's lock: ${short.join("; ")}. Nothing of the package runs here (spec/boundary.md).`);
}

function shown(output: string): string {
  const t = output.trim();
  return JSON.stringify(t.length > 80 ? `${t.slice(0, 80)}…` : t);
}

/**
 * The host's tools as they are: Node's version from this process, and `bwrap` as the sandbox SDK finds it, the first
 * executable `bwrap` on the runtime's PATH. Its setuid bit is read from the file it leads to, and it is asked for
 * `--version` with the filtered environment every process the runtime starts gets (env.ts: none of the runtime's
 * secrets) and a limit of 5 seconds.
 */
export const systemProbe: HostProbe = {
  async read(tool) {
    if (tool === "node") return { output: process.versions.node, path: process.execPath };
    const path = onPath("bwrap");
    if (!path) return { missing: true };
    let setuid: boolean;
    try {
      setuid = (statSync(path).mode & 0o4000) !== 0;
    } catch (e) {
      return { failed: `could not be read (${(e as Error).message})` };
    }
    if (setuid) return { output: "", path, setuid };
    return versionOf(path);
  },
};

/**
 * Runs `<path> --version` and gives what it printed. At the limit the process is killed and the answer is given at
 * once: a process it started that still holds its output open does not hold the run up.
 */
function versionOf(path: string): Promise<ToolReading> {
  return new Promise<ToolReading>((done) => {
    let settled = false;
    const finish = (r: ToolReading): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.destroy();
      done(r);
    };
    const child = spawn(path, ["--version"], { env: childEnv(), stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ failed: `gave no version within ${VERSION_TIMEOUT_MS / 1000} s` });
    }, VERSION_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (b: Buffer) => {
      size += b.length;
      if (size > MAX_OUTPUT) {
        child.kill("SIGKILL");
        return finish({ failed: `printed more than ${MAX_OUTPUT} bytes for --version` });
      }
      chunks.push(b);
    });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ failed: `could not be started (${e.code ?? e.message})` }));
    child.on("close", (code, signal) => {
      if (code === 0) return finish({ output: Buffer.concat(chunks).toString("utf8"), path, setuid: false });
      finish({ failed: code !== null ? `exited with code ${code} on --version` : `was stopped by ${signal ?? "a signal"} on --version` });
    });
  });
}

/** The first executable file named `name` in the runtime's PATH, as `execvp` would find it, or undefined. */
function onPath(name: string): string | undefined {
  for (const dir of (process.env["PATH"] ?? "").split(delimiter)) {
    const p = resolve(dir || ".", name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      return p;
    } catch {
      continue;
    }
  }
  return undefined;
}
