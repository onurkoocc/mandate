// The world of the self-review session (fixtures/self-review/README.md): Mandate reviews its own repository. These
// are the pieces that scripts/self-review.mjs and its test take: the fixed list of components, the snapshot of them
// (committed content only, so nothing untracked such as an .env can be in it), the local report connector that
// lists the components and appends accepted findings to a report in the session directory, the simulated Reviewer,
// the lock and the configuration filled from their templates, and `startReviewWorld`, which brings the whole of it up
// behind the egress proxy the runtime requires.
//
// It reuses the live kit's pieces (scripts/lib/live-world.mjs): the MCP server, the loopback guard, the templates'
// filling and the work-tree check. Its session directories have a marker of their own, so that neither kit takes the
// other's directory for its own. Nothing here is a secret: the one secret the report connector checks (what the
// egress proxy puts in the header of each of its requests) is made at run time, held in this process, and never
// written or printed. The git processes the kit starts get this process's environment without the model's key. Only Node's own modules are imported; the egress proxy is handed in (`deps`).

import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { assertLocalOnly, fill, hostsIn, insideGitWorkTree, listen, mcpServer, realPathOf } from "./live-world.mjs";

// ── what is reviewed ────────────────────────────────────────────────────

/**
 * The components the Reviewer reviews, one agent run each: small, so that one run can read the whole of one within
 * the model's input limit (the lock's max_input_tokens). Each is a task id, a title, what to look at, and the
 * repository paths of its files, all tracked by git.
 */
export const COMPONENTS = [
  {
    task: "egress-addresses",
    title: "Egress proxy: public addresses and its configuration",
    focus: "Which addresses the egress proxy treats as public, and how a credential is bound to its hosts and header. Look for an address or a host that is let through when it should not be, and for a configuration that is accepted when it should be refused.",
    paths: ["runtime/src/egress/addresses.ts", "runtime/src/egress/config.ts"],
  },
  {
    task: "agent-tools",
    title: "Agent tools: from a tool call to a sandboxed command",
    focus: "How an agent's read, list, grep and write calls become commands, how their paths are checked against the grant, and what the sandbox helper does with them. Look for a path that escapes the grant, and for output the agent is shown that it should not be.",
    paths: ["runtime/src/tools.ts", "runtime/src/sandbox-helper.ts"],
  },
  {
    task: "child-env",
    title: "Child processes: their environment and paths",
    focus: "What a verifier or another child process inherits of the runtime's environment, and how the runtime's paths are made. Look for a secret that can reach a child, and for a path that is not what its comment says.",
    paths: ["runtime/src/env.ts", "runtime/src/paths.ts"],
  },
  {
    task: "live-kit-preload",
    title: "The live kit: its preload and the line it patches",
    focus: "What the live acceptance kit preloads into the mandate command, when it is meant to be inert, and the one line of the runtime it rewrites as it loads. Look for a process it touches that it says it leaves alone, and for a way the patch could apply to a file it should not.",
    paths: ["scripts/lib/live-hook.mjs", "scripts/lib/live-loader.mjs"],
  },
];

/**
 * What the simulated Reviewer answers for each component: `grounded`, a finding that meets every criterion;
 * `unsure`, one that meets every criterion but `confident` (its confidence is medium), which the maintainer may
 * waive; `off_the_end`, one whose line is past the end of its file, which nobody may waive.
 */
export const SIMULATED = { "egress-addresses": "grounded", "agent-tools": "unsure", "child-env": "off_the_end", "live-kit-preload": "grounded" };

/** The path the program grants the Reviewer to read: the one `fs.read("…")` of fixtures/self-review/self-review.mdt. */
export function snapshotGrant(program) {
  const all = [...program.matchAll(/fs\.read\("([^"]+)"\)/g)].map((m) => m[1]);
  if (all.length !== 1) throw new Error(`the program grants ${all.length} paths to read; the kit expects exactly one, the snapshot's`);
  const p = all[0];
  if (!/^\/[a-z0-9-]+(\/[a-z0-9-]+)*$/.test(p)) throw new Error(`the program's snapshot path ${p} is not a plain absolute path of lowercase names`);
  return p;
}

// ── the snapshot ────────────────────────────────────────────────────────

/** The file that says a directory is a snapshot the kit made, with the session's id. */
export const SNAPSHOT_MARKER = ".mandate-self-review-snapshot";

const lineCount = (text) => (text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));

/** The variables that may hold the model's key in terminal A (`up --real-model`): no child process gets them. */
export const MODEL_KEY_VARIABLES = ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "CLAUDE_WORKSPACE_ID"];

/** The environment of a child process the kit starts (git): this process's, without the model's key. */
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of MODEL_KEY_VARIABLES) delete out[k];
  return out;
}

const git = (repo, args, o = {}) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: childEnv(), stdio: ["ignore", "pipe", "pipe"], ...o });

/** The commit `rev` of the repository at `repo`, in full. */
export function commitOf(repo, rev = "HEAD") {
  return git(repo, ["rev-parse", "--verify", `${rev}^{commit}`]).trim();
}

/**
 * Writes the snapshot of the components into `target`: each file as the commit `commit` holds it (`git show`), so
 * that only committed content is in it and nothing untracked or ignored (an .env, a key, a build) can be. `target`
 * must be new, empty, or a snapshot this kit made for the same session; it is never inside a git work tree. Gives
 * the components as the report connector lists them: each file by its path from the snapshot's root, with its lines.
 */
export function writeSnapshot(repo, target, commit, sessionId, components = COMPONENTS) {
  const real = realPathOf(target);
  const inGit = insideGitWorkTree(real);
  if (inGit) throw new Error(`${target} is inside a git work tree (${inGit}): the snapshot is made outside any repository`);
  if (existsSync(target)) {
    if (!statSync(target).isDirectory()) throw new Error(`${target} is not a directory`);
    const had = readSnapshotMarker(target);
    if (had && had.session !== sessionId) throw new Error(`${target} is the snapshot of another self-review session (${had.session.slice(0, 8)}…): \`clean\` that session first`);
    if (!had && readdirSync(target).length > 0) throw new Error(`${target} is not empty and is not a snapshot of this kit (no ${SNAPSHOT_MARKER}): the kit writes only into a new or an empty directory, or its own`);
    for (const name of readdirSync(target)) if (name !== SNAPSHOT_MARKER) rmSync(join(target, name), { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, SNAPSHOT_MARKER), JSON.stringify({ format: "mandate/self-review-snapshot/0.1", session: sessionId, commit }) + "\n");
  return components.map((c) => ({
    task: c.task,
    title: c.title,
    focus: c.focus,
    files: c.paths.map((p) => {
      if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.split("/").some((s) => s === ".." || s === "" || s.startsWith(".env"))) throw new Error(`${p} is not a path the snapshot takes`);
      const text = git(repo, ["show", `${commit}:${p}`], { maxBuffer: 4_000_000 });
      const file = join(target, ...p.split("/"));
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      return { path: p, lines: lineCount(text) };
    }),
  }));
}

/** The marker of the snapshot `dir`, or undefined. */
export function readSnapshotMarker(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, SNAPSHOT_MARKER), "utf8"));
    return m && m.format === "mandate/self-review-snapshot/0.1" && /^[0-9a-f]{32}$/.test(m.session) ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Removes the snapshot `dir` if, and only if, it is this session's: its marker names `sessionId`. Gives whether it did. */
export function removeSnapshot(dir, sessionId) {
  const m = existsSync(dir) ? readSnapshotMarker(dir) : undefined;
  if (!m || m.session !== sessionId) return false;
  if (insideGitWorkTree(realPathOf(dir))) return false;
  rmSync(dir, { recursive: true, force: true });
  // The directory above it goes too when the kit made it and nothing else is in it.
  const up = dirname(dir);
  try {
    if (readdirSync(up).length === 0) rmdirSync(up);
  } catch {
    // not ours to worry about
  }
  return true;
}

// ── the report connector ────────────────────────────────────────────────

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const fileSchema = obj({ path: { type: "string" }, lines: { type: "integer" } }, ["path", "lines"]);
const componentSchema = obj({ task: { type: "string" }, title: { type: "string" }, focus: { type: "string" }, files: { type: "array", items: fileSchema } }, ["task", "title", "focus", "files"]);
const TEXT = { type: "string" };
const findingSchema = obj({ task: TEXT, file: fileSchema, line: { type: "integer" }, title: TEXT, what: TEXT, evidence: TEXT, severity: TEXT, confidence: TEXT }, ["task", "file", "line", "title", "what", "evidence", "severity", "confidence"]);
const entrySchema = obj({ entry_id: TEXT }, ["entry_id"]);

/** A finding's identity in the report: the component, the file and the line. A second finding there is the same entry. */
export const findingKey = (f) => `${f.task}|${f.file.path}|${f.line}`;

/** Text of the model's, as a line of the report: no line breaks, no markup that would end a block. */
const flat = (s) => String(s).replace(/[\r\n]+/g, " ").replace(/`{3,}/g, "'''").slice(0, 2000);
const block = (s) => String(s).replace(/`{3,}/g, "'''").slice(0, 4000);

/**
 * The state and the tools of the local report connector, as local.review declares it: `list_components` and
 * `find_entry` read; `append_finding` writes. It appends an accepted finding to `report.md` (for people) and
 * `report.jsonl` (for the kit) in the session directory, and nowhere else. It is idempotent twice over: by the
 * operation key (a retry is the same entry) and by the finding (its component, file and line: the same finding sent
 * by another run, under another key, is the entry it already is, and nothing is appended). Every call is counted.
 *
 * @param {{ dir: string, components: object[], commit: string }} o
 */
export function reportState(o) {
  const md = join(o.dir, "report.md");
  const jsonl = join(o.dir, "report.jsonl");
  /** @type {Array<{ entry_id: string, key: string, finding_key: string, finding: object, at: string, calls: number }>} */
  const entries = existsSync(jsonl) ? readFileSync(jsonl, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l)) : [];
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const byFinding = new Map(entries.map((e) => [e.finding_key, e]));
  const counts = { appended: 0, retried: 0, same_finding: 0 };
  if (!existsSync(md)) writeFileSync(md, `# Self-review report\n\nMandate reviewed its own repository: commit ${o.commit}, ${o.components.length} components. Each entry below is a finding the program accepted, appended by the report connector once.\n`);
  const tools = [
    { name: "list_components", title: "List components", description: "Lists the components of the snapshot to review.", inputSchema: obj({}, []), outputSchema: obj({ result: { type: "array", items: componentSchema } }, ["result"]), annotations: { readOnlyHint: true },
      run: () => ({ structured: { result: o.components }, text: `${o.components.length} components` }) },
    { name: "find_entry", title: "Find an entry", description: "Finds the entry an operation key appended.", inputSchema: obj({ key: TEXT }, ["key"]), outputSchema: obj({ result: { anyOf: [entrySchema, { type: "null" }] } }, ["result"]), annotations: { readOnlyHint: true },
      run: (a) => {
        const e = typeof a["key"] === "string" ? byKey.get(a["key"]) : undefined;
        return { structured: { result: e ? { entry_id: e.entry_id } : null }, text: e ? "found" : "none" };
      } },
    { name: "append_finding", title: "Append a finding", description: "Appends an accepted finding to the report.", inputSchema: obj({ f: findingSchema, key: TEXT }, ["f", "key"]), outputSchema: entrySchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      run: (a) => {
        const f = a["f"];
        if (!isObj(f) || typeof f["task"] !== "string" || !isObj(f["file"]) || typeof f["file"]["path"] !== "string" || !Number.isInteger(f["line"]) || typeof a["key"] !== "string") return { error: "a finding and a key are required." };
        const retry = byKey.get(a["key"]);
        if (retry) {
          retry.calls++;
          counts.retried++;
          return { structured: { entry_id: retry.entry_id }, text: `the key was sent again: nothing appended (${retry.entry_id})` };
        }
        const fk = findingKey(f);
        const same = byFinding.get(fk);
        if (same) {
          byKey.set(a["key"], same);
          counts.same_finding++;
          return { structured: { entry_id: same.entry_id }, text: `the same finding is already in the report: nothing appended (${same.entry_id})` };
        }
        const e = { entry_id: `R-${entries.length + 1}`, key: a["key"], finding_key: fk, finding: f, at: new Date().toISOString(), calls: 1 };
        entries.push(e);
        byKey.set(e.key, e);
        byFinding.set(fk, e);
        counts.appended++;
        appendFileSync(jsonl, JSON.stringify(e) + "\n");
        appendFileSync(
          md,
          [
            "",
            `## ${e.entry_id}  ${flat(f["title"])}`,
            "",
            `- component: ${flat(f["task"])}`,
            `- where: \`${flat(f["file"]["path"])}\` line ${f["line"]}`,
            `- severity: ${flat(f["severity"])}, confidence: ${flat(f["confidence"])}`,
            `- operation key (start): ${a["key"].slice(0, 18)}`,
            "",
            flat(f["what"]),
            "",
            "```text",
            block(f["evidence"]),
            "```",
            "",
          ].join("\n"),
        );
        return { structured: { entry_id: e.entry_id }, text: `appended ${e.entry_id} (${f["task"]}, ${f["file"]["path"]}:${f["line"]})` };
      } },
  ];
  return { entries, counts, tools, files: { md, jsonl } };
}

// ── the simulated Reviewer ──────────────────────────────────────────────

/** The component among the delegation's arguments (a value with a task and files), however the runtime wraps it. */
function componentIn(v) {
  if (Array.isArray(v)) {
    for (const x of v) {
      const c = componentIn(x);
      if (c) return c;
    }
    return undefined;
  }
  if (!isObj(v)) return undefined;
  if (typeof v["task"] === "string" && Array.isArray(v["files"])) return v;
  for (const x of Object.values(v)) {
    const c = componentIn(x);
    if (c) return c;
  }
  return undefined;
}

/**
 * The simulated Reviewer: what a model that read the component would report, as SIMULATED says for its task. It
 * quotes the snapshot's own line, so that its evidence is real. `args` is the delegation's arguments.
 */
export function simulatedReview(args, snapshot) {
  const c = componentIn(args);
  const kind = c ? SIMULATED[c.task] : undefined;
  if (!c || !kind) return { error: { tag: "SkillFailed", args: [{ kind: "unknown_component", detail: "the simulated Reviewer knows only the kit's components" }] }, cost: {} };
  const file = c.files[0];
  const line = Math.min(3, file.lines);
  let quoted = "";
  try {
    quoted = readFileSync(join(snapshot, ...file.path.split("/")), "utf8").split("\n")[line - 1] ?? "";
  } catch {
    quoted = "";
  }
  const finding = {
    task: c.task,
    file,
    line: kind === "off_the_end" ? file.lines + 40 : line,
    title: `(simulated) A finding of the simulated Reviewer for ${c.task}`,
    what: "The simulated Reviewer read no code: this entry stands in for a model's finding so that the session can be run without a key.",
    evidence: `${file.path}:${line}: ${quoted.trim() || "(an empty line)"} -- quoted by the simulated Reviewer`,
    severity: "low",
    confidence: kind === "unsure" ? "medium" : "high",
  };
  return { ok: finding, cost: { steps: 2 } };
}

// ── the templates ───────────────────────────────────────────────────────

/** The lock of the session from fixtures/self-review/self-review.lock.template.json: the maintainer, their key, and the two roles they hold. */
export function reviewLockFrom(template, maintainer) {
  return fill(template, { "maintainer-member": maintainer.member, "maintainer-key": maintainer.keyId });
}

/** The egress proxy's configuration for the session: no secret in it (each credential names the variable of this process that holds it). */
export function reviewEgressConfig(admin, real) {
  return {
    admin,
    // The report connector's name resolves to loopback (the kit's own resolver says so, and answers for no other name).
    allow_private: true,
    credentials: {
      self_review: { env: "MANDATE_SELF_REVIEW_SECRET", hosts: ["review.self.example"], header: "authorization", template: "Bearer {secret}" },
      ...(real ? { anthropic: { env: real.env, hosts: ["api.anthropic.com"], header: "x-api-key", template: "{secret}" } } : {}),
    },
  };
}

/** The runtime configuration of the session from its template; with `real`, the model, its gateway and the sandbox the Reviewer reads in. */
export function reviewRuntimeConfig(template, o) {
  const config = fill(template, { database: o.database, "egress-admin": o.admin });
  if (!o.real) return config;
  const sandbox = process.platform === "win32" ? { host: "mxc", toolchain: [join(process.execPath, "..")], isolation: "process" } : { host: "mxc", mode: "enforcement" };
  return { ...config, model: { provider: "anthropic" }, sandbox, egress: { ...config.egress, gateways: { model: "anthropic" } } };
}

// ── the world ───────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Brings the world up in `dir`: the session's directories and files, the snapshot (in `snapshot`), the report
 * connector, and the egress proxy in front of it (and in front of the model's API, with `real`). The proxy's dialer
 * connects the connector's name to the loopback server, the model's host to the real API when `real` is given, and
 * refuses every other host. Gives the world, with `stop()`.
 *
 * @param {{ dir: string, repo: string, snapshot: string, commit: string, database?: string, real?: { env: string }, log?: (line: string) => void }} o
 * @param {{ serveEgress: Function, defaultDialer?: Function, isPublicAddress?: (a: string) => boolean }} deps
 */
export async function startReviewWorld(o, deps) {
  const { dir, repo } = o;
  const read = (p) => readFileSync(join(repo, p), "utf8");
  const lockTemplate = read("fixtures/self-review/self-review.lock.template.json");
  const libraryDir = join(repo, "fixtures", "self-review", "library", "local.review");
  for (const host of [...hostsIn(lockTemplate), ...hostsIn(readFileSync(join(libraryDir, "connectors.mdt"), "utf8"))]) assertLocalOnly("a connector's host", host);
  if (o.database !== undefined && !/^(pglite:|postgres(ql)?:\/\/)/.test(o.database)) throw new Error("the database is a PostgreSQL URL (postgresql://…) or pglite:<directory>");

  checkReviewSessionDir(dir);
  const sessionId = markReviewSessionDir(dir);
  for (const d of ["people", "decision-keys", "libraries", "pages"]) mkdirSync(join(dir, d), { recursive: true });
  const version = JSON.parse(readFileSync(join(libraryDir, "mandate.library.json"), "utf8")).version;
  cpSync(libraryDir, join(dir, "libraries", "local.review", version), { recursive: true });
  // The snapshot is outside the session directory (which holds the keys and the store), and the Reviewer reads it only.
  if (o.real && realPathOf(o.snapshot).startsWith(realPathOf(dir) + sep)) throw new Error("the snapshot the real Reviewer reads must be outside the session directory, which holds the keys and the store");
  const components = writeSnapshot(repo, o.snapshot, o.commit, sessionId);

  const id = randomBytes(4).toString("hex");
  const admin = process.platform === "win32" ? `\\\\.\\pipe\\mandate-self-review-${id}` : join(dir, "egress.sock");
  const secret = randomBytes(24).toString("hex");
  const log = o.log ?? (() => {});
  const report = reportState({ dir, components, commit: o.commit });
  const server = await listen(mcpServer({ tools: report.tools, header: "authorization", secret: `Bearer ${secret}`, log: (l) => log(`report   ${l}`) }));

  const database = o.database ?? "pglite:store";
  const config = reviewRuntimeConfig(JSON.parse(read("fixtures/self-review/mandate.runtime.template.json")), { database, admin, ...(o.real ? { real: o.real } : {}) });
  writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify(config, null, 2) + "\n");
  // A design run reads this in place of the connector (it touches nothing): the components the connector would list.
  writeFileSync(join(dir, "samples.json"), JSON.stringify({ "local.review.report.list_components": { result: components } }, null, 2) + "\n");
  writeFileSync(join(dir, "mandate.egress.json"), JSON.stringify(reviewEgressConfig(admin, o.real), null, 2) + "\n");

  const real = o.real && deps.defaultDialer ? deps.defaultDialer() : undefined;
  const resolveHost = async (host) => {
    if (host === "review.self.example") return [{ address: "127.0.0.1", family: 4 }];
    if (real && host === "api.anthropic.com") {
      const { lookup } = await import("node:dns/promises");
      return (await lookup(host, { all: true, order: "verbatim" })).filter((a) => deps.isPublicAddress(a.address));
    }
    throw new Error(`the self-review kit's proxy does not resolve ${host}`);
  };
  const dial = async (r) => {
    if (r.host === "review.self.example") {
      return new Promise((ok, fail) => {
        const s = connect({ host: "127.0.0.1", port: server.port });
        s.once("connect", () => ok(s));
        s.once("error", fail);
      });
    }
    if (real && r.host === "api.anthropic.com") return real(r);
    throw new Error(`the self-review kit's proxy does not dial ${r.host}`);
  };
  const env = { MANDATE_SELF_REVIEW_SECRET: secret, ...(o.real ? { [o.real.env]: process.env[o.real.env] ?? "" } : {}) };
  const egress = await deps.serveEgress({ config: join(dir, "mandate.egress.json"), env, resolve: resolveHost, dial });

  return {
    dir,
    id: sessionId,
    config: join(dir, "mandate.runtime.json"),
    components,
    report,
    port: server.port,
    admin,
    async stop() {
      await egress.stop();
      server.server.closeAllConnections();
      await new Promise((ok) => server.server.close(() => ok()));
      await sleep(0);
    },
  };
}

/** The directory of a new session, outside the repository: under the operating system's temporary directory. */
export function newReviewSessionDir() {
  return join(tmpdir(), `mandate-self-review-${randomBytes(4).toString("hex")}`);
}

// ── the session directory: what the kit may write into and remove ───────
//
// A marker of this kit's own, so that a session of the live kit (scripts/live-session.mjs, marker
// .mandate-live-session) is never taken for one of this kit's, nor the other way round.

/** The file that says a directory is a self-review session's, with the session's random id (session.json carries the same id). */
export const SESSION_MARKER = ".mandate-self-review-session";
const SESSION_MARKER_FORMAT = "mandate/self-review-session-marker/0.1";

/** The marker of the session directory `dir`, or undefined when there is none or it is not this kit's. */
export function readReviewMarker(dir) {
  try {
    const m = JSON.parse(readFileSync(join(dir, SESSION_MARKER), "utf8"));
    return m && m.format === SESSION_MARKER_FORMAT && /^[0-9a-f]{32}$/.test(m.id) ? m : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the kit may bring a world up in `dir`: not inside a git work tree, and new, empty, or a session of its own. Refuses by saying why. */
export function checkReviewSessionDir(dir) {
  const repository = insideGitWorkTree(realPathOf(dir));
  if (repository) throw new Error(`${dir} is inside a git work tree (${repository}): the session writes a key and a store, and the kit will not put them in a repository`);
  if (!existsSync(dir)) return { resume: false };
  if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  if (readReviewMarker(dir)) return { resume: true };
  if (readdirSync(dir).length > 0) throw new Error(`${dir} is not empty and is not a self-review session's directory (it has no ${SESSION_MARKER}): the kit writes only into a new or an empty directory, or its own`);
  return { resume: false };
}

/** Makes `dir` (if need be) and its marker, once. Gives the session id. */
export function markReviewSessionDir(dir) {
  mkdirSync(dir, { recursive: true });
  const had = readReviewMarker(dir);
  if (had) return had.id;
  const id = randomBytes(16).toString("hex");
  writeFileSync(join(dir, SESSION_MARKER), JSON.stringify({ format: SESSION_MARKER_FORMAT, id, created: new Date().toISOString() }) + "\n");
  return id;
}

/** Whether `dir` is a session directory of this kit's: its marker, and a session.json (if any) of the same id. Throws when not. */
export function assertReviewSessionDir(dir) {
  const m = readReviewMarker(dir);
  if (!m) throw new Error(`${dir} is not a self-review session's directory (no ${SESSION_MARKER} of this kit's)`);
  if (existsSync(join(dir, "session.json"))) {
    let id;
    try {
      id = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).id;
    } catch {
      id = undefined;
    }
    if (id !== m.id) throw new Error(`${dir}: session.json does not belong to the marker's session`);
  }
  return m;
}

/** Every entry of the top of a session directory that the kit makes; `clean` removes these and nothing else. */
export const REVIEW_KNOWN = [SESSION_MARKER, "session.json", "mandate.runtime.json", "mandate.egress.json", "samples.json", "self-review.lock.json", "notifications.jsonl", "egress.sock", "report.md", "report.jsonl", "snapshot", "people", "decision-keys", "libraries", "pages", "store", ".mandate"];

/**
 * Removes what the kit made: the snapshot when it is this session's, and in the session directory only the entries
 * it knows (REVIEW_KNOWN), by name. When nothing else is left, the directory goes too. Refuses a directory without the
 * kit's marker, or inside a git work tree.
 */
export function cleanReviewSession(dir) {
  const m = assertReviewSessionDir(dir);
  const repository = insideGitWorkTree(realPathOf(dir));
  if (repository) throw new Error(`${dir} is inside a git work tree (${repository}): the kit removes nothing there`);
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).snapshot;
  } catch {
    snapshot = undefined;
  }
  const snapshotRemoved = typeof snapshot === "string" ? removeSnapshot(resolve(snapshot), m.id) : false;
  const removed = [];
  for (const name of readdirSync(dir)) {
    if (!REVIEW_KNOWN.includes(name)) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed.push(name);
  }
  const left = readdirSync(dir);
  if (left.length === 0) rmdirSync(dir);
  return { removed, left, dirRemoved: left.length === 0, snapshot, snapshotRemoved };
}
