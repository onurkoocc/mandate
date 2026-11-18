// What the self-review session's shell preloads (NODE_OPTIONS=--import=…, which `scripts/self-review.mjs up` prints
// for the shell) into the `mandate` command of this repository, and into nothing else, with the simulated Reviewer
// (the default): the Reviewer itself. The control CLI builds its adapters from the configuration, which runs an
// agent only as a loop that needs a model and a sandbox; there is no configuration for a simulated agent, by design.
// This preload gives the CLI the simulated Reviewer in place of the stand-in the configuration leaves (the module
// hook of the live kit, scripts/lib/live-loader.mjs, rewrites that one line of THIS repository's
// runtime/dist/control.js as it is loaded, and refuses if the line is not there). With `--real-model`, `up` prints no
// preload at all, and this module is not loaded.
//
// It is inert everywhere else: a process that is not `bridge/dist/cli.js` of this repository is left alone, and so is
// `mandate mcp`. When the session's marker is gone (the session was cleaned) it does nothing and says so on one line of
// stderr. The session directory is the `session` parameter of this module's own URL. It does not move the clock: the
// self-review session waits for no deadline.

import { readFileSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { patched } from "./live-loader.mjs";
import { assertSessionDir } from "./live-world.mjs";
import { simulatedReview } from "./self-review-world.mjs";

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
    process.stderr.write(`self-review preload: not applied, the session is gone or is not one (${e instanceof Error ? e.message : String(e)}); unset NODE_OPTIONS in this terminal\n`);
  }
  if (session && session.model === "simulated") {
    const snapshot = session.snapshot;
    globalThis.__mandateLiveAgents = {
      run: async (req) =>
        req.agent === "Reviewer" && req.skill === "review"
          ? simulatedReview(req.args, snapshot)
          : { error: { tag: "SkillFailed", args: [{ kind: "no_such_agent", detail: `the simulated model answers for Reviewer.review only, not ${req.agent}.${req.skill}` }] }, cost: {} },
    };
    nodeModule.registerHooks({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context);
        return url.startsWith("file:") && real(fileURLToPath(url)) === ownControl ? { ...loaded, source: patched(url, loaded.source) } : loaded;
      },
    });
  }
}
