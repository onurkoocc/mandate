// What the live session's shell preloads (NODE_OPTIONS=--import=…, which `scripts/live-session.mjs up` prints for the
// shell) into the `mandate` command of this repository, and into nothing else: two things.
//
//   - The session's clock. `Date` of the process is the wall clock plus the session's offset (the file
//     `clock-offset-ms` of the session directory, which `live-session.mjs advance` moves forward), so that a deadline of
//     a day can pass in a minute: the runtime's own code decides whether it has passed, against the clock it is given.
//   - With the simulated model (the default), the Matcher. The control CLI builds its adapters from the configuration,
//     which runs an agent only as a loop that needs a model and a sandbox; there is no configuration for a simulated
//     agent, by design. This preload gives the CLI the rehearsal's simulated Matcher in place of the stand-in the
//     configuration leaves (the module hook rewrites that one line of THIS repository's runtime/dist/control.js as it
//     is loaded, and refuses if the line is not there). With `--real-model` it does nothing of the kind.
//
// It is inert everywhere else, so that a terminal that still has NODE_OPTIONS set does no harm: a process that is not
// `bridge/dist/cli.js` of this repository (npm, another script, an MCP client, an authoring agent) is left alone, and so
// is `mandate mcp`, the authoring agent's server, which must never run on a shifted clock. When the session's marker is
// gone (the session was cleaned) it does nothing and says so on one line of stderr.
//
// The session directory is the `session` parameter of this module's own URL.

import { readFileSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patched } from "./live-loader.mjs";
import { assertSessionDir, clockOffsetMs, LIVE, simulatedMatch } from "./live-world.mjs";

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
const repo = real(fileURLToPath(new URL("../../", import.meta.url)));
const ownCli = real(join(repo, "bridge", "dist", "cli.js"));
const ownControl = real(join(repo, "runtime", "dist", "control.js"));
const dir = new URL(import.meta.url).searchParams.get("session");
const isMandate = typeof process.argv[1] === "string" && real(process.argv[1]) === ownCli && process.argv[2] !== "mcp";

if (isMandate) {
  let session;
  try {
    if (!dir) throw new Error("no ?session=<directory> on the preload's URL");
    assertSessionDir(dir);
    session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  } catch (e) {
    process.stderr.write(`live-session preload: not applied, the session is gone or is not one (${e instanceof Error ? e.message : String(e)}); unset NODE_OPTIONS in this terminal\n`);
  }
  if (session) {
    // A `Date` that is ahead of the wall clock by the session's offset, re-read at most every 250 ms of real time.
    const RealDate = Date;
    const realNow = RealDate.now.bind(RealDate);
    let offset = clockOffsetMs(dir);
    let readAt = realNow();
    const now = () => {
      const t = realNow();
      if (t - readAt > 250) {
        offset = clockOffsetMs(dir);
        readAt = t;
      }
      return t + offset;
    };
    class SessionDate extends RealDate {
      // A date made by Node itself (a file's time, a database's) is a date of this class as far as `instanceof` goes.
      static [Symbol.hasInstance](x) {
        return x instanceof RealDate;
      }
      constructor(...args) {
        if (args.length === 0) super(now());
        else super(...args);
      }
      static now() {
        return now();
      }
    }
    globalThis.Date = SessionDate;
    globalThis.__mandateLiveRealNow = realNow;

    if (session.model === "simulated") {
      globalThis.__mandateLiveAgents = { run: async (req) => (req.agent === "Matcher" && req.skill === "match" ? simulatedMatch(LIVE, req.args) : { error: { tag: "SkillFailed", args: [{ kind: "no_such_agent", detail: `the simulated model answers for Matcher.match only, not ${req.agent}.${req.skill}` }] }, cost: {} }) };
      nodeModule.registerHooks({
        load(url, context, nextLoad) {
          const loaded = nextLoad(url, context);
          return url.startsWith("file:") && real(fileURLToPath(url)) === ownControl ? { ...loaded, source: patched(url, loaded.source) } : loaded;
        },
      });
    }
  }
}
