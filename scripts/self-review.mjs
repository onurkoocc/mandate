#!/usr/bin/env node
// The self-review session (fixtures/self-review/README.md): Mandate reviews its own repository. One command that
// brings the session's world up, and the few that serve it.
//
//   node scripts/self-review.mjs up [--dir DIR] [--database URL] [--commit REV] [--real-model]
//                                                    start the world and keep it up until Ctrl+C: the snapshot of the
//                                                    components (committed content of REV, HEAD by default), the local
//                                                    report connector (loopback only) behind the egress proxy the runtime
//                                                    requires, the runtime's configuration, and the lines to paste into
//                                                    the shell that runs the maintainer's commands
//   node scripts/self-review.mjs lock --session DIR --maintainer NAME=KEYFILE
//                                                    the lock of the session from the template and the maintainer's key
//   node scripts/self-review.mjs status     --session DIR   what is running, and what the report holds
//   node scripts/self-review.mjs components --session DIR   the components the report connector lists, with their files
//   node scripts/self-review.mjs report     --session DIR   the report: every entry the connector appended
//   node scripts/self-review.mjs down       --session DIR   stop the world (the session directory and the report are kept)
//   node scripts/self-review.mjs clean      --session DIR   remove what the kit made: the session directory's own entries and the snapshot
//
// What it needs: the build (`npm ci && npm run build`) and the compiler's module (`npm run build:wasm`), and git. No
// dependency. The session directory is new (or empty, or this kit's own) and never inside a git work tree. With the
// simulated Reviewer the snapshot is in the session directory; with --real-model it is at the one path the program
// grants the Reviewer (fixtures/self-review/self-review.mdt, `fs.read`), a path that names no person, since the
// Reviewer's tools show it to the model. The kit never reads a file of the repository's working tree to build the
// snapshot: it takes each file from the commit (`git show`), so an untracked or ignored file (an .env) cannot be in it.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertLocalOnly, listen } from "./lib/live-world.mjs";
import { assertReviewSessionDir, checkReviewSessionDir, cleanReviewSession, commitOf, newReviewSessionDir, reviewLockFrom, snapshotGrant, startReviewWorld } from "./lib/self-review-world.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const PROGRAM = join(repo, "fixtures", "self-review", "self-review.mdt");
const say = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`self-review: ${message}\n`);
  process.exit(1);
};

async function dist(path) {
  const file = join(repo, "runtime", "dist", path);
  if (!existsSync(file)) fail(`${file} is not there: build first with \`npm ci\` and \`npm run build\` (fixtures/self-review/README.md says how)`);
  return import(pathToFileURL(file).href);
}

function parse(argv) {
  const flags = {};
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) flags[a] = true;
      else {
        flags[a] = next;
        i++;
      }
    } else words.push(a);
  }
  return { flags, words };
}

const { flags, words } = parse(process.argv.slice(2));
const [command] = words;

function sessionDir() {
  const given = flags["--session"] ?? process.env["MANDATE_SELF_REVIEW_SESSION"];
  if (typeof given !== "string") fail("which session? name its directory with --session DIR (`up` printed it)");
  const dir = resolve(given);
  try {
    assertReviewSessionDir(dir);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  return dir;
}

const sessionOf = (dir) => (existsSync(join(dir, "session.json")) ? JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) : {});

async function control(dir, path, init) {
  const s = sessionOf(dir);
  if (!s.control) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${s.control}${path}`, { ...init, headers: { "x-self-review-session": "1" }, signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch {
    return undefined;
  }
}

const running = async (dir) => (await control(dir, "/status")) !== undefined;
const NOT_RUNNING = "the session's world is not running (start it with `up`, in a terminal of its own)";

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  say(columns.map((c, i) => c.padEnd(widths[i])).join("  "));
  for (const r of rows) say(columns.map((c, i) => String(r[c]).padEnd(widths[i])).join("  "));
}

function shellLines(dir, real) {
  const home = dir.includes("'") ? fail(`${dir} has a quote in it; use --dir with another path`) : dir.replaceAll("\\", "/");
  if (real) return { powershell: [`$S = '${home}'`, `$C = "$S/mandate.runtime.json"`, "Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue"], posix: [`export S='${home}'`, `export C="$S/mandate.runtime.json"`, "unset NODE_OPTIONS"], note: "with --real-model there is no preload: the Reviewer is the real agent loop, in the sandbox, with the model behind the proxy" };
  const hook = `${pathToFileURL(join(repo, "scripts", "lib", "self-review-hook.mjs")).href}?session=${encodeURIComponent(dir)}`;
  return { powershell: [`$S = '${home}'`, `$C = "$S/mandate.runtime.json"`, `$env:NODE_OPTIONS = '--import=${hook}'`], posix: [`export S='${home}'`, `export C="$S/mandate.runtime.json"`, `export NODE_OPTIONS='--import=${hook}'`], note: "NODE_OPTIONS gives the mandate command the simulated Reviewer, and nothing else" };
}

async function up() {
  const dir = resolve(typeof flags["--dir"] === "string" ? flags["--dir"] : newReviewSessionDir());
  try {
    checkReviewSessionDir(dir);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (existsSync(join(dir, "session.json")) && (await running(dir))) fail(`a world is already running in ${dir}`);
  const real = flags["--real-model"] === true;
  let realKey;
  if (real) {
    realKey = ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"].find((n) => (process.env[n] ?? "") !== "");
    if (!realKey) fail("--real-model: neither CLAUDE_API_KEY nor ANTHROPIC_API_KEY is set in this terminal (set it here, for this command only: the proxy holds it; the terminal of the maintainer's commands must not have it)");
    if (process.platform !== "win32" && process.platform !== "linux") fail("--real-model: the Reviewer's agent loop runs in a sandbox, which the runtime has for Windows and Linux only");
  }
  const database = typeof flags["--database"] === "string" ? flags["--database"] : undefined;
  let commit;
  try {
    commit = commitOf(repo, typeof flags["--commit"] === "string" ? flags["--commit"] : "HEAD");
  } catch (e) {
    fail(`the commit to review: ${e instanceof Error ? e.message : String(e)}`);
  }
  const grant = snapshotGrant(readFileSync(PROGRAM, "utf8"));
  // The real Reviewer reads the snapshot at the path the program grants it; the simulated one reads nothing, and the
  // kit keeps its snapshot in the session directory, where `clean` finds it.
  const snapshot = real ? resolve(grant) : join(dir, "snapshot");
  if (!existsSync(join(repo, "bridge", "wasm", "mandate-wasm.wasm"))) process.stderr.write("self-review: warning: bridge/wasm is not there; the commands will stop with a compiler failure until `npm run build:wasm` (or a copy of that directory) is in place\n");

  const main = await dist("egress/main.js");
  const proxy = await dist("egress/proxy.js");
  const addresses = await dist("egress/addresses.js");
  let world;
  try {
    world = await startReviewWorld({ dir, repo, snapshot, commit, ...(database ? { database } : {}), ...(real ? { real: { env: realKey } } : {}), log: (l) => say(`  ${new Date().toISOString().slice(11, 19)} ${l}`) }, { serveEgress: main.serveEgress, defaultDialer: proxy.defaultDialer, isPublicAddress: addresses.isPublicAddress });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const stopped = new Promise((ok) => {
    let stopping = false;
    globalThis.__reviewStop = async () => {
      if (stopping) return;
      stopping = true;
      await world.stop();
      ok();
    };
  });
  const summary = () => ({ entries: world.report.entries.length, ...world.report.counts });
  const answers = {
    "/status": () => ({ model: real ? "real" : "simulated", components: world.components.length, ...summary() }),
    "/components": () => world.components,
    "/report": () => ({ entries: world.report.entries.map((e) => ({ entry_id: e.entry_id, task: e.finding.task, where: `${e.finding.file.path}:${e.finding.line}`, severity: e.finding.severity, confidence: e.finding.confidence, title: e.finding.title, calls: e.calls })), file: world.report.files.md, ...world.report.counts }),
  };
  // The control server answers this script only: a page in a browser cannot send the header, and a name that is not
  // the loopback address (DNS rebinding) is not answered.
  const ctl = await listen((req) => {
    if (req.headers["x-self-review-session"] !== "1" || !/^127\.0\.0\.1:\d+$/.test(req.headers["host"] ?? "")) return { status: 403, headers: { "content-type": "text/plain" }, body: "forbidden" };
    if (req.method === "POST" && req.url === "/stop") {
      setTimeout(() => void globalThis.__reviewStop(), 10);
      return { status: 200, headers: { "content-type": "application/json" }, body: '{"stopping":true}' };
    }
    const answer = req.method === "GET" ? answers[req.url] : undefined;
    return answer ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(answer()) } : { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ format: "mandate/self-review-session/0.1", id: world.id, pid: process.pid, control: ctl.port, model: real ? "real" : "simulated", commit, snapshot, database: database ? "(a PostgreSQL URL, in mandate.runtime.json)" : "pglite:store", started: new Date().toISOString() }, null, 2) + "\n");
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void globalThis.__reviewStop());

  const sh = shellLines(dir, real);
  const files = world.components.reduce((n, c) => n + c.files.length, 0);
  say(`The world is up. Session directory: ${dir}`);
  say("");
  say(`  commit reviewed   ${commit}`);
  say(`  snapshot          ${snapshot}  (${world.components.length} components, ${files} files, committed content only)`);
  say("  report connector  https://review.self.example/mcp  (served on this machine only, behind the egress proxy)");
  say(`  report            ${world.report.files.md}  (${world.report.entries.length} entries)`);
  say(`  model for the Reviewer: ${real ? `REAL (the key from ${realKey} is held by this process only)` : "simulated (no key needed; it reads no code)"}`);
  say(`  store: ${database ? "PostgreSQL, the URL you gave" : join(dir, "store")}`);
  say("");
  say("Leave this terminal as it is: the world lives in it, and each request it receives is shown below.");
  say("In ANOTHER terminal, from the repository's root, paste the lines for your shell:");
  say("");
  say("  PowerShell:");
  for (const l of sh.powershell) say(`    ${l}`);
  say("  POSIX shell (bash, zsh):");
  for (const l of sh.posix) say(`    ${l}`);
  say(`  (${sh.note})`);
  say("");
  say("Then go on with step 2 of the guide (fixtures/self-review/README.md). Ctrl+C here stops the world.");
  say("");
  await stopped;
  await new Promise((ok) => ctl.server.close(() => ok()));
  writeFileSync(join(dir, "session.json"), JSON.stringify({ ...sessionOf(dir), pid: null, control: null, stopped: new Date().toISOString() }, null, 2) + "\n");
  say(`The world is down. The session directory and the report are kept: ${dir} (\`clean\` removes them).`);
  process.exit(0);
}

async function lock() {
  const dir = sessionDir();
  const { readDecisionKey } = await dist("decisions.js");
  const given = flags["--maintainer"];
  const m = typeof given === "string" ? /^([a-z][a-z0-9_-]*)=(.+)$/.exec(given) : null;
  if (!m) fail("--maintainer NAME=KEYFILE: the maintainer's name (letters, digits, - and _) and the private key file `mandate key new` wrote");
  let key;
  try {
    key = readDecisionKey(resolve(m[2]));
  } catch (e) {
    fail(`${m[2]} is not a key made by \`mandate key new\`: ${e instanceof Error ? e.message : e}`);
  }
  const maintainer = { member: m[1], keyId: key.keyId };
  const template = JSON.parse(readFileSync(join(repo, "fixtures", "self-review", "self-review.lock.template.json"), "utf8"));
  const out = join(dir, "self-review.lock.json");
  writeFileSync(out, JSON.stringify(reviewLockFrom(template, maintainer), null, 2) + "\n");
  // The runtime trusts only the public keys in its decisions.keys directory: the maintainer's public half is put there.
  writeFileSync(join(dir, "decision-keys", `${maintainer.keyId.slice("sha256:".length)}.pem`), key.publicKeyPem());
  say(`lock written: ${out}`);
  say(`  maintainer (owner of the envelope, and the deputy it escalates to): ${maintainer.member}  ${maintainer.keyId}`);
  say(`  the public key is trusted in ${join(dir, "decision-keys")}`);
  say("  the connector's schema digests are not in it yet: the next step, `connector pin`, writes them");
}

async function show(what) {
  const dir = sessionDir();
  const got = await control(dir, `/${what}`);
  if (got === undefined) fail(NOT_RUNNING);
  if (what === "components") {
    say(`${got.length} components in the snapshot:`);
    for (const c of got) {
      say(`  ${c.task}: ${c.title}`);
      for (const f of c.files) say(`      ${f.path}  (${f.lines} lines)`);
    }
    return;
  }
  say(got.entries.length === 0 ? "the report holds no entry" : `${got.entries.length} entries in the report (${got.file}):`);
  if (got.entries.length) table(got.entries.map((e) => ({ entry: e.entry_id, component: e.task, where: e.where, severity: e.severity, confidence: e.confidence, sent: e.calls })), ["entry", "component", "where", "severity", "confidence", "sent"]);
  if (got.same_finding) say(`${got.same_finding} findings were sent again by a later run and appended nothing: each was already in the report`);
  if (got.retried) say(`${got.retried} appends were retries of a key already sent and appended nothing`);
}

async function status() {
  const dir = sessionDir();
  const s = sessionOf(dir);
  const up = await control(dir, "/status");
  say(`session   ${dir}`);
  say(`world     ${up ? `running (pid ${s.pid})` : "not running"}`);
  say(`model     ${s.model}`);
  say(`commit    ${s.commit}`);
  say(`snapshot  ${s.snapshot}`);
  if (up) say(`report    ${up.entries} entries; ${up.components} components listed`);
  say(`lock      ${existsSync(join(dir, "self-review.lock.json")) ? "made" : "not made yet (step 3 of the guide)"}`);
  const sink = join(dir, "notifications.jsonl");
  say(`notified  ${existsSync(sink) ? readFileSync(sink, "utf8").split("\n").filter((l) => l !== "").length : 0} notifications in ${sink}`);
}

async function down() {
  const dir = sessionDir();
  if (!(await running(dir))) return say("the session's world is not running");
  await control(dir, "/stop", { method: "POST" });
  for (let i = 0; i < 50; i++) {
    if (!(await running(dir))) {
      say("the world is down");
      say("In terminal B, end the preload: PowerShell: Remove-Item Env:NODE_OPTIONS    POSIX: unset NODE_OPTIONS");
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  fail("the world did not stop; press Ctrl+C in the terminal where `up` runs");
}

async function clean() {
  const dir = sessionDir();
  if (await running(dir)) fail("the world is still running: `down` first");
  let done;
  try {
    done = cleanReviewSession(dir);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
  if (done.snapshot) say(done.snapshotRemoved ? `removed the snapshot ${done.snapshot}` : `the snapshot ${done.snapshot} is not this session's, or is gone: left as it is`);
  if (done.dirRemoved) say(`removed ${dir}`);
  else {
    say(`removed what the kit made in ${dir}: ${done.removed.join(", ")}`);
    say(`left, because the kit did not make it: ${done.left.join(", ")}`);
  }
}

try {
  assertLocalOnly("the control address", "127.0.0.1");
  switch (command) {
    case "up":
      await up();
      break;
    case "lock":
      await lock();
      break;
    case "status":
      await status();
      break;
    case "components":
    case "report":
      await show(command);
      break;
    case "down":
      await down();
      break;
    case "clean":
      await clean();
      break;
    default:
      process.stderr.write("usage: node scripts/self-review.mjs up [--dir DIR] [--database URL] [--commit REV] [--real-model]\n       node scripts/self-review.mjs lock --session DIR --maintainer NAME=KEYFILE\n       node scripts/self-review.mjs status|components|report|down|clean --session DIR\n");
      process.exit(2);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
