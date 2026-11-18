#!/usr/bin/env node
// The live acceptance session of 0.7 (fixtures/attention/live/README.md; slice B11): one command that brings the
// session's world up, and the few that serve it.
//
//   node scripts/live-session.mjs up [--dir DIR] [--database URL] [--real-model]
//                                                    start the world and keep it up until Ctrl+C: a fake ERP and a fake
//                                                    mailbox (nothing real, loopback only) behind the egress proxy the
//                                                    runtime requires, the runtime's configuration, and the lines to
//                                                    paste into the shell that runs the persons' commands
//   node scripts/live-session.mjs lock --session DIR --accountant NAME=KEYFILE --finance-lead NAME=KEYFILE
//                                                    the lock of the session from the template and the two persons' keys
//   node scripts/live-session.mjs status   --session DIR   what is running, and the session's clock
//   node scripts/live-session.mjs inbox    --session DIR   the invoices in the fake mailbox
//   node scripts/live-session.mjs orders   --session DIR   the open orders in the fake ERP
//   node scripts/live-session.mjs drafts   --session DIR   the draft invoices a live run wrote into the fake ERP
//   node scripts/live-session.mjs advance DURATION --session DIR   move the session's clock forward (90m, 25h, 2d)
//   node scripts/live-session.mjs down     --session DIR   stop the world (the session directory is kept)
//   node scripts/live-session.mjs clean    --session DIR   remove the session directory (the world must be down)
//
// What it needs: the build (`npm ci && npm run build`) and the compiler's module (`npm run build:wasm`), as every
// script of this repository that runs the bridge. No dependency. The session directory is new and outside the
// repository (the operating system's temporary directory unless --dir says another): the persons' keys, the store and
// the notifications are in it and never in git. Private keys are never printed.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { advanceClock, assertLocalOnly, clockOffsetMs, durationMs, listen, LIVE, lockFrom, newSessionDir, startWorld } from "./lib/live-world.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const say = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`live-session: ${message}\n`);
  process.exit(1);
};

/** The built runtime's module `path` (runtime/dist/…). */
async function dist(path) {
  const file = join(repo, "runtime", "dist", path);
  if (!existsSync(file)) fail(`${file} is not there: build first with \`npm ci\` and \`npm run build\` (the README of fixtures/attention/live says how)`);
  return import(pathToFileURL(file).href);
}

/** `--name value` pairs and the words that are not flags. */
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
const [command, ...rest] = words;

function sessionDir() {
  const given = flags["--session"] ?? process.env["MANDATE_LIVE_SESSION"];
  if (typeof given !== "string") fail("which session? name its directory with --session DIR (`up` printed it)");
  const dir = resolve(given);
  if (!existsSync(join(dir, "session.json"))) fail(`${dir} is not a live session's directory (no session.json)`);
  return dir;
}

const sessionOf = (dir) => JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));

/** The running world's answer to a request of the control server, or undefined when nothing answers. */
async function control(dir, path, init) {
  const s = sessionOf(dir);
  if (!s.control) return undefined;
  try {
    const r = await fetch(`http://127.0.0.1:${s.control}${path}`, { ...init, headers: { "x-live-session": "1" }, signal: AbortSignal.timeout(3000) });
    return await r.json();
  } catch {
    return undefined;
  }
}

async function running(dir) {
  return (await control(dir, "/status")) !== undefined;
}

const NOT_RUNNING = "the session's world is not running (start it with `up`, in a terminal of its own)";

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c]).length)));
  say(columns.map((c, i) => c.padEnd(widths[i])).join("  "));
  for (const r of rows) say(columns.map((c, i) => String(r[c]).padEnd(widths[i])).join("  "));
}

const money = (cents) => `${(cents / 100).toFixed(2)}`;

function shellLines(dir, real) {
  const hook = `${pathToFileURL(join(repo, "scripts", "lib", "live-hook.mjs")).href}?session=${encodeURIComponent(dir)}`;
  const home = dir.includes("'") ? fail(`${dir} has a quote in it; use --dir with another path`) : dir.replaceAll("\\", "/");
  return {
    powershell: [`$S = '${home}'`, `$C = "$S/mandate.runtime.json"`, `$env:NODE_OPTIONS = '--import=${hook}'`],
    posix: [`export S='${home}'`, `export C="$S/mandate.runtime.json"`, `export NODE_OPTIONS='--import=${hook}'`],
    note: real ? "NODE_OPTIONS gives every command the session's clock (so `advance` works); with --real-model it gives it nothing else" : "NODE_OPTIONS gives every command the session's clock (so `advance` works) and the simulated Matcher",
  };
}

async function up() {
  const dir = resolve(typeof flags["--dir"] === "string" ? flags["--dir"] : newSessionDir());
  if (existsSync(join(dir, "session.json")) && (await running(dir))) fail(`a world is already running in ${dir}`);
  const real = flags["--real-model"] === true;
  let realKey;
  if (real) {
    realKey = ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY"].find((n) => (process.env[n] ?? "") !== "");
    if (!realKey) fail("--real-model: neither CLAUDE_API_KEY nor ANTHROPIC_API_KEY is set in this terminal (set it here, for this command only: the proxy holds it; the terminal of the persons' commands must not have it)");
    if (process.platform !== "win32" && process.platform !== "linux") fail("--real-model: the runtime's agent loop runs in a sandbox, which it has for Windows and Linux only");
  }
  const database = typeof flags["--database"] === "string" ? flags["--database"] : undefined;
  if (!existsSync(join(repo, "bridge", "wasm", "mandate-wasm.wasm"))) process.stderr.write("live-session: warning: bridge/wasm is not there; the commands will stop with a compiler failure until `npm run build:wasm` (or a copy of that directory) is in place\n");

  const main = await dist("egress/main.js");
  const proxy = await dist("egress/proxy.js");
  const addresses = await dist("egress/addresses.js");
  let world;
  try {
    world = await startWorld({ dir, repo, book: LIVE, ...(database ? { database } : {}), ...(real ? { real: { env: realKey } } : {}), log: (l) => say(`  ${new Date().toISOString().slice(11, 19)} ${l}`) }, { serveEgress: main.serveEgress, defaultDialer: proxy.defaultDialer, isPublicAddress: addresses.isPublicAddress });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }

  const startedAt = new Date().toISOString();
  const stopped = new Promise((ok) => {
    let stopping = false;
    globalThis.__liveStop = async () => {
      if (stopping) return;
      stopping = true;
      await world.stop();
      ok();
    };
  });
  const answers = {
    "/status": () => ({ erp: world.ports.erp, mailbox: world.ports.mailbox, model: real ? "real" : "simulated", drafts: world.erp.drafts.size, orders: world.erp.orders.length, invoices: world.mailbox.invoices.length }),
    "/orders": () => world.erp.orders,
    "/inbox": () => world.mailbox.invoices,
    "/drafts": () => [...world.erp.drafts.values()],
  };
  // The control server answers this script only: a page in a browser cannot send the header, and a name that is not the
  // loopback address (DNS rebinding) is not answered.
  const ctl = await listen((req) => {
    if (req.headers["x-live-session"] !== "1" || !/^127\.0\.0\.1:\d+$/.test(req.headers["host"] ?? "")) return { status: 403, headers: { "content-type": "text/plain" }, body: "forbidden" };
    if (req.method === "POST" && req.url === "/stop") {
      setTimeout(() => void globalThis.__liveStop(), 10);
      return { status: 200, headers: { "content-type": "application/json" }, body: '{"stopping":true}' };
    }
    const answer = req.method === "GET" ? answers[req.url] : undefined;
    return answer ? { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(answer()) } : { status: 404, headers: { "content-type": "text/plain" }, body: "not found" };
  });
  writeFileSync(join(dir, "session.json"), JSON.stringify({ format: "mandate/live-session/0.1", pid: process.pid, control: ctl.port, model: real ? "real" : "simulated", database: database ? "(a PostgreSQL URL, in mandate.runtime.json)" : "pglite:store", started: startedAt }, null, 2) + "\n");
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void globalThis.__liveStop());

  const sh = shellLines(dir, real);
  say(`The world is up. Session directory: ${dir}`);
  say("");
  say("  fake ERP      https://erp.acme.example/mcp   (served on this machine only, behind the egress proxy)");
  say("  fake mailbox  https://mail.acme.example/mcp  (the same)");
  say(`  invoices in the mailbox: ${world.mailbox.invoices.length}, open orders in the ERP: ${world.erp.orders.length}, drafts: 0`);
  say(`  model for the Matcher: ${real ? `REAL (the key from ${realKey} is held by this process only)` : "simulated (no key needed)"}`);
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
  say("Then go on with step 1 of the guide (fixtures/attention/live/README.md). Ctrl+C here stops the world.");
  say("");
  await stopped;
  await new Promise((ok) => ctl.server.close(() => ok()));
  writeFileSync(join(dir, "session.json"), JSON.stringify({ ...sessionOf(dir), pid: null, control: null, stopped: new Date().toISOString() }, null, 2) + "\n");
  say(`The world is down. The session directory is kept: ${dir} (\`clean\` removes it).`);
  process.exit(0);
}

async function lock() {
  const dir = sessionDir();
  const { readDecisionKey } = await dist("decisions.js");
  const person = (flag) => {
    const given = flags[flag];
    const m = typeof given === "string" ? /^([a-z][a-z0-9_-]*)=(.+)$/.exec(given) : null;
    if (!m) fail(`${flag} NAME=KEYFILE: the person's name (letters, digits, - and _) and the private key file \`mandate key new\` wrote`);
    let key;
    try {
      key = readDecisionKey(resolve(m[2]));
    } catch (e) {
      fail(`${m[2]} is not a key made by \`mandate key new\`: ${e instanceof Error ? e.message : e}`);
    }
    return { member: m[1], keyId: key.keyId, pem: key.publicKeyPem(), file: m[2] };
  };
  const accountant = person("--accountant");
  const lead = person("--finance-lead");
  if (accountant.member === lead.member) fail("the accountant and the finance lead are two persons: use two names and two keys");
  if (accountant.keyId === lead.keyId) fail("the two keys are the same key: each person makes their own with `mandate key new`");
  const template = JSON.parse(readFileSync(join(repo, "fixtures", "attention", "live", "invoices.lock.template.json"), "utf8"));
  const made = lockFrom(template, { accountant, finance_lead: lead });
  const out = join(dir, "invoices.lock.json");
  writeFileSync(out, JSON.stringify(made, null, 2) + "\n");
  // The runtime trusts only the public keys in its decisions.keys directory: the persons' public halves are put there.
  for (const p of [accountant, lead]) writeFileSync(join(dir, "decision-keys", `${p.keyId.slice("sha256:".length)}.pem`), p.pem);
  say(`lock written: ${out}`);
  say(`  accountant (owner of the envelope): ${accountant.member}  ${accountant.keyId}`);
  say(`  finance lead (escalation):          ${lead.member}  ${lead.keyId}`);
  say(`  their public keys are trusted in ${join(dir, "decision-keys")}`);
  say("  the connectors' schema digests are not in it yet: the next step, `connector pin`, writes them");
}

async function show(what) {
  const dir = sessionDir();
  const rows = await control(dir, `/${what}`);
  if (rows === undefined) fail(NOT_RUNNING);
  if (what === "orders") {
    say(`${rows.length} open orders in the fake ERP:`);
    table(rows.map((o) => ({ order: o.order_no, vendor: o.vendor_id, total: money(o.total_cents) })), ["order", "vendor", "total"]);
  } else if (what === "inbox") {
    say(`${rows.length} invoices in the fake mailbox:`);
    table(rows.map((i) => ({ invoice: i.invoice_no, vendor: i.vendor_id, total: money(i.total_cents) })), ["invoice", "vendor", "total"]);
  } else {
    say(rows.length === 0 ? "the fake ERP holds no draft invoice" : `${rows.length} draft invoices in the fake ERP:`);
    if (rows.length) table(rows.map((d) => ({ draft: d.draft_id, invoice: d.invoice_no, order: d.order_no })), ["draft", "invoice", "order"]);
  }
}

async function status() {
  const dir = sessionDir();
  const s = sessionOf(dir);
  const now = new Date(Date.now() + clockOffsetMs(dir));
  const up = await control(dir, "/status");
  say(`session   ${dir}`);
  say(`world     ${up ? `running (pid ${s.pid})` : "not running"}`);
  say(`model     ${s.model}`);
  say(`clock     ${now.toISOString()}  (the wall clock + ${(clockOffsetMs(dir) / 3_600_000).toFixed(2)} h)`);
  if (up) say(`ERP       ${up.orders} open orders, ${up.drafts} draft invoices; mailbox ${up.invoices} invoices`);
  say(`lock      ${existsSync(join(dir, "invoices.lock.json")) ? "made" : "not made yet (step 3 of the guide)"}`);
  const sink = join(dir, "notifications.jsonl");
  say(`notified  ${existsSync(sink) ? readFileSync(sink, "utf8").split("\n").filter((l) => l !== "").length : 0} notifications in ${sink}`);
}

function advance() {
  const dir = sessionDir();
  const by = durationMs(rest[0] ?? fail("advance takes a duration, such as 25h or 2d"));
  if (by <= 0) fail("a duration above zero");
  const offset = advanceClock(dir, by);
  say(`the session's clock is now ${new Date(Date.now() + offset).toISOString()} (the wall clock + ${(offset / 3_600_000).toFixed(2)} h)`);
  say("the persons' commands see it from their next call; `mandate tick` makes what is overdue happen");
}

async function down() {
  const dir = sessionDir();
  if (!(await running(dir))) return say("the session's world is not running");
  await control(dir, "/stop", { method: "POST" });
  for (let i = 0; i < 50; i++) {
    if (!(await running(dir))) return say("the world is down");
    await new Promise((r) => setTimeout(r, 200));
  }
  fail("the world did not stop; press Ctrl+C in the terminal where `up` runs");
}

async function clean() {
  const dir = sessionDir();
  if (await running(dir)) fail("the world is still running: `down` first");
  if (!/mandate-live-/.test(dir) && flags["--force"] !== true) fail(`${dir} is not named mandate-live-…; to remove it all the same, add --force`);
  rmSync(dir, { recursive: true, force: true });
  say(`removed ${dir}`);
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
    case "orders":
    case "inbox":
    case "drafts":
      await show(command);
      break;
    case "advance":
      advance();
      break;
    case "down":
      await down();
      break;
    case "clean":
      await clean();
      break;
    default:
      process.stderr.write(`usage: node scripts/live-session.mjs up [--dir DIR] [--database URL] [--real-model]\n       node scripts/live-session.mjs lock --session DIR --accountant NAME=KEYFILE --finance-lead NAME=KEYFILE\n       node scripts/live-session.mjs status|inbox|orders|drafts|down|clean --session DIR\n       node scripts/live-session.mjs advance DURATION --session DIR\n`);
      process.exit(2);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
