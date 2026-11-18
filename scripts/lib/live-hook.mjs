// What the live session's shell preloads into every `node bridge/dist/cli.js …` it runs (NODE_OPTIONS=--import=…,
// which `scripts/live-session.mjs up` prints for the shell): two things, and nothing else.
//
//   - The session's clock. `Date` of the process is the wall clock plus the session's offset (the file
//     `clock-offset-ms` of the session directory, which `live-session.mjs advance` moves forward), so that a deadline of
//     a day can pass in a minute: the runtime's own code decides whether it has passed, against the clock it is given.
//     Every command of the session sees the same clock.
//   - With the simulated model (the default), the Matcher. The control CLI builds its adapters from the configuration,
//     which runs an agent only as a loop that needs a model and a sandbox; there is no configuration for a simulated
//     agent, by design. This preload gives the CLI the rehearsal's simulated Matcher in place of the stand-in the
//     configuration leaves (scripts/lib/live-loader.mjs rewrites that one line of runtime/dist/control.js as it is
//     loaded, and refuses if the line is not there). With `--real-model` it does nothing of the kind.
//
// The session directory is the `session` parameter of this module's own URL.

import * as nodeModule from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clockOffsetMs, LIVE, simulatedMatch } from "./live-world.mjs";
import { patched } from "./live-loader.mjs";

const dir = new URL(import.meta.url).searchParams.get("session");
if (!dir) throw new Error("the live session's preload needs ?session=<directory> on its URL (scripts/live-session.mjs up prints the line to use)");
const session = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));

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

if (session.model === "simulated") {
  globalThis.__mandateLiveAgents = { run: async (req) => (req.agent === "Matcher" && req.skill === "match" ? simulatedMatch(LIVE, req.args) : { error: { tag: "SkillFailed", args: [{ kind: "no_such_agent", detail: `the simulated model answers for Matcher.match only, not ${req.agent}.${req.skill}` }] }, cost: {} }) };
  // `registerHooks` (in this thread) where Node has it, `register` (a hooks thread, deprecated in Node 26) where not.
  if (typeof nodeModule.registerHooks === "function") {
    nodeModule.registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        return { ...loaded, source: patched(url, loaded.source) };
      },
    });
  } else nodeModule.register("./live-loader.mjs", import.meta.url);
}
