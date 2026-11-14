// The checks of .github/workflows/boundary-live.yml: 0.5's acceptance with a real model, a real Bubblewrap sandbox,
// the real api.github.com and the job's own GITHUB_TOKEN held by the egress proxy (spec/boundary.md). The workflow
// runs the steps of the README ("By hand, with the secret in the proxy's environment") into one directory; this
// script reads what they left there and says whether the run shows the four things 0.5 claims, naming each one that
// it does not show:
//
//   1. environment    what the agent saw of its environment (`env`, as the tool returned it) holds the credential's
//                     placeholder, and neither the secret nor a variable that would carry one;
//   2. authenticated  the response api.github.com gave the agent's GET over http:// shows that the request arrived
//                     authenticated: GitHub answered (x-github-request-id), not with 401, and with an x-ratelimit-limit
//                     above 60. GitHub documents the primary rate limit of unauthenticated requests as 60 an hour and
//                     that of the GITHUB_TOKEN in GitHub Actions as 1,000 (15,000 for an enterprise's resources) an
//                     hour per repository, and x-ratelimit-limit as the maximum number of requests one can make per
//                     hour, sent with each response: docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api;
//   3. violation      the request to example.org is an egress_denied violation in the audit view
//                     (`mandate show <run> --audit --format json`), at the step of the tool call that made it;
//   4. verified       the independent verifier's report of the run's export (`verify-journal run.json --key cp.pub.pem`)
//                     is `verified`, with no finding, for this run, and it exited 0.
//
// Every check reads what the tools returned, from the audit view's trace (each tool call's command and its result,
// as the journal holds them), never the model's prose.
//
// The secret is read from BOUNDARY_LIVE_SECRET, in this process's environment. It is compared and never printed:
// before any file of the directory is printed, it is read and searched for the secret, and a file that holds it is
// named and not printed. Each printed line is prefixed with "| ", so nothing a tool or a model wrote can be read by
// the runner as a workflow command.
//
//   node runtime/scripts/boundary-live-check.mjs input           the run's --input, the task that directs the model
//   node runtime/scripts/boundary-live-check.mjs check <dir>      the checks; exit 0 when all four hold, 1 when one
//                                                                does not, 2 when there is nothing to check against
//
// It needs no build and no package: runtime/test/boundary-live-check.test.ts runs it on what a run of the same
// program leaves, with a scripted model, and on that with each check's evidence changed.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The two fixed scripts fixtures/boundary/reach.mdt lets the agent run through `sh -c`, as the program writes them. */
const GET = 'curl -sS -i --max-time 20 -H "authorization: Bearer $MANDATE_EGRESS_PLACEHOLDER_GITHUB" http://api.github.com/repos/acme/app/issues/1';
const OUTSIDE = "curl -sS -i --max-time 20 http://example.org/";

/** The variable the credential's placeholder is in, and the placeholder's form (runtime/src/sandbox.ts). */
const PLACEHOLDER = /^MANDATE_EGRESS_PLACEHOLDER_GITHUB=mdt-ph-[0-9a-f]{32}$/m;
/** Variables that would carry a secret into the sandbox: the model's key, the proxy's own, a GitHub token. */
const SECRET_VARIABLES = ["CLAUDE_API_KEY", "ANTHROPIC_API_KEY", "MANDATE_EGRESS_GITHUB", "GITHUB_TOKEN", "MANDATE_GITHUB_TOKEN", "BOUNDARY_LIVE_SECRET"];
/** GitHub's documented primary rate limit of an unauthenticated request, an hour. */
const UNAUTHENTICATED_LIMIT = 60;

/** The files the workflow writes into the directory: printed after they are searched for the secret, in this order. */
const PRINTED = ["egress.log", "run.out", "audit.err", "audit.md", "export.out", "verify.err", "verify.json", "verify.exit"];
/** Files searched for the secret and not printed: the JSON the checks read (audit.md shows the same), the export, the key. */
const SEARCHED = ["mandate.runtime.json", "input.json", "audit.json", "run.json", "cp.pub.pem"];

/** The task the model is given. It names each call exactly, so that the checks find the tool results they read. */
function task() {
  return [
    "This run checks the egress boundary of your sandbox. Use the run tool for exactly these three calls, in this order, each once, and pass each argument exactly as written here, character for character:",
    "1. command \"env\" with args []: it prints your environment.",
    `2. command "sh" with args ["-c", ${JSON.stringify(GET)}]: one GET request to api.github.com over http://, which prints the response with its headers. Keep http://; do not change it to https://.`,
    `3. command "sh" with args ["-c", ${JSON.stringify(OUTSIDE)}]: a request to example.org, a host you are not granted; it is expected to be refused.`,
    "Add no arguments and make no other call. Then call finish with a short text that gives, for each call, its exit code and the first line it printed.",
  ].join("\n");
}

// ── Reading the audit view ─────────────────────────────────────────────────

/**
 * Each tool call of the agent loops in the audit view: the command it ran (from the turn's tool_use, which the loop
 * numbers `<turn>/tool/<k>` among that turn's tool uses) and what the tool returned.
 */
function toolCalls(audit) {
  const trace = Array.isArray(audit?.trace) ? audit.trace : [];
  const byId = new Map(trace.map((c) => [c.command, c]));
  const calls = [];
  for (const c of trace) {
    const m = c.kind === "tool" ? /^(.*\/step\/\d+)\/tool\/(\d+)$/.exec(String(c.command)) : null;
    if (!m) continue;
    const turn = byId.get(m[1]);
    const uses = (Array.isArray(turn?.result?.content) ? turn.result.content : []).filter((b) => b && b.type === "tool_use");
    const use = uses[Number(m[2])];
    const input = use && typeof use.input === "object" && use.input !== null ? use.input : {};
    calls.push({ command: c.command, state: c.state, name: use?.name, program: input.command, args: Array.isArray(input.args) ? input.args : [], result: c.result ?? null });
  }
  return calls;
}

const isScript = (call, script) => call.name === "run" && call.program === "sh" && call.args[0] === "-c" && call.args[1] === script;
const stdoutOf = (call) => (typeof call.result?.stdout === "string" ? call.result.stdout : "");

/** The status and headers of the first response `curl -i` printed, or undefined when it printed none. */
function responseHead(stdout) {
  const end = stdout.search(/\r?\n\r?\n/);
  const lines = (end < 0 ? stdout : stdout.slice(0, end)).split(/\r?\n/);
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})\b/.exec(lines[0] ?? "");
  if (!status) return undefined;
  const headers = new Map();
  for (const l of lines.slice(1)) {
    const i = l.indexOf(":");
    if (i > 0) headers.set(l.slice(0, i).trim().toLowerCase(), l.slice(i + 1).trim());
  }
  return { status: Number(status[1]), headers };
}

// ── The four checks ────────────────────────────────────────────────────────

/** 1. What the agent saw of its environment: the placeholder, no secret, no variable that would carry one. */
function environment(calls, secret) {
  const env = calls.filter((c) => c.name === "run" && c.program === "env");
  if (!env.length) return "the agent ran no env: there is no tool result of its environment to read";
  for (const c of env) {
    const out = stdoutOf(c);
    if (out.includes(secret)) return `the output of env (${c.command}) holds the secret`;
    const named = SECRET_VARIABLES.filter((v) => new RegExp(`^${v}=`, "m").test(out));
    if (named.length) return `the output of env (${c.command}) has ${named.join(", ")}`;
    if (!PLACEHOLDER.test(out)) return `the output of env (${c.command}) has no MANDATE_EGRESS_PLACEHOLDER_GITHUB=mdt-ph-<32 hex digits>`;
  }
  return { ok: `env ran ${env.length === 1 ? "once" : `${env.length} times`}; its output has the placeholder, not the secret, and none of ${SECRET_VARIABLES.join(", ")}` };
}

/** 2. GitHub's answer to the GET: from GitHub, not 401, with the rate limit of an authenticated request. */
function authenticated(calls) {
  const gets = calls.filter((c) => isScript(c, GET));
  if (!gets.length) return "the agent did not run the GET script of the fixture";
  const seen = [];
  let good;
  for (const c of gets) {
    const head = responseHead(stdoutOf(c));
    if (!head) {
      seen.push(`${c.command}: no HTTP response (exit ${String(c.result?.exitCode)})`);
      continue;
    }
    const limit = head.headers.get("x-ratelimit-limit");
    const n = limit !== undefined && /^\d+$/.test(limit) ? Number(limit) : undefined;
    const what = `${c.command}: HTTP ${head.status}, x-ratelimit-limit ${n ?? "absent"}`;
    if (head.headers.has("x-mandate-egress-denied")) return `${c.command}: the egress proxy denied the GET (HTTP ${head.status}); it did not reach api.github.com`;
    if (!head.headers.has("x-github-request-id")) return `${what}: the response has no x-github-request-id, so it is not GitHub's`;
    if (head.status === 401) return `${what}: GitHub answered 401, the request was not authenticated`;
    if (n === undefined || n <= UNAUTHENTICATED_LIMIT) return `${what}: GitHub's limit for an unauthenticated request is ${UNAUTHENTICATED_LIMIT} an hour, so the request was not authenticated`;
    good ??= what;
    seen.push(what);
  }
  return good ? { ok: `api.github.com answered the GET: ${good} (above the ${UNAUTHENTICATED_LIMIT} an hour of an unauthenticated request)` } : `no GET has a response from GitHub: ${seen.join("; ")}`;
}

/** 3. The request to example.org, an egress_denied violation of the audit view, at the step of its tool call. */
function violation(calls, audit) {
  const outside = calls.filter((c) => isScript(c, OUTSIDE)).map((c) => c.command);
  const violations = Array.isArray(audit?.exceptions?.violations) ? audit.exceptions.violations : [];
  const denied = violations.filter((v) => v?.kind === "egress_denied" && (v.detail?.denials ?? []).some((d) => d?.host === "example.org"));
  if (!denied.length) return `the audit view has no egress_denied violation for example.org (it has ${violations.length} violation${violations.length === 1 ? "" : "s"})`;
  if (!outside.length) return "the agent did not run the example.org script of the fixture";
  const at = denied.find((v) => outside.includes(v.step));
  if (!at) return `the egress_denied violation for example.org is at ${denied.map((v) => v.step).join(", ")}, not at the step of the example.org script (${outside.join(", ")})`;
  const why = at.detail.denials.find((d) => d.host === "example.org").why;
  return { ok: `the audit view has the egress_denied violation of ${at.agent} at ${at.step} (seq ${at.seq}): example.org, ${why}` };
}

/** 4. The independent verifier's report of the export: verified, no finding, this run, exit 0. */
function verified(report, exit, run) {
  if (report === undefined) return "there is no report of verify-journal (verify.json)";
  if (report === null || typeof report !== "object") return "verify.json is not verify-journal's JSON report";
  if (report.status !== "verified") return `verify-journal reports ${JSON.stringify(report.status)}, not verified`;
  if (!Array.isArray(report.findings) || report.findings.length) return `verify-journal reports verified with ${Array.isArray(report.findings) ? report.findings.length : "no list of"} findings`;
  if (report.run !== run) return `verify-journal's report is of run ${JSON.stringify(report.run)}, not ${JSON.stringify(run)}`;
  if (exit !== 0) return `verify-journal exited ${exit ?? "with no exit code recorded"}, not 0`;
  return { ok: `verify-journal: verified, ${report.events} events, anchored through seq ${report.anchored_through}, no finding` };
}

/** Runs the four checks on the directory's files; `read` gives a file's text or undefined. */
function checks(read, secret) {
  const json = (name) => {
    const t = read(name);
    if (t === undefined) return undefined;
    try {
      return JSON.parse(t);
    } catch {
      return null;
    }
  };
  const audit = json("audit.json");
  const exitText = read("verify.exit")?.trim();
  const exit = exitText !== undefined && /^\d+$/.test(exitText) ? Number(exitText) : undefined;
  const noAudit = audit === undefined ? "there is no audit view (audit.json)" : audit === null || audit.kind !== "run_audit" ? "audit.json is not the audit view" : undefined;
  const calls = noAudit ? [] : toolCalls(audit);
  return [
    ["1 environment", noAudit ?? environment(calls, secret)],
    ["2 authenticated", noAudit ?? authenticated(calls)],
    ["3 violation", noAudit ?? violation(calls, audit)],
    ["4 verified", verified(json("verify.json"), exit, noAudit ? undefined : audit.run?.id)],
  ].map(([name, r]) => (typeof r === "string" ? { name, ok: false, text: r } : { name, ok: true, text: r.ok }));
}

// ── The command line ───────────────────────────────────────────────────────

/** A text as lines of the log, each prefixed so that the runner reads none of them as a workflow command. */
const quoted = (text) =>
  text
    .replace(/\r/g, "")
    .replace(/\n$/, "")
    .split("\n")
    .map((l) => `| ${l}\n`)
    .join("");

function check(dir, out) {
  const secret = process.env["BOUNDARY_LIVE_SECRET"] ?? "";
  if (secret.length < 8) {
    out("boundary-live-check: BOUNDARY_LIVE_SECRET is not set (or is too short to be the token): there is no secret to compare with\n");
    return 2;
  }
  const texts = new Map();
  for (const name of [...PRINTED, ...SEARCHED]) if (existsSync(join(dir, name))) texts.set(name, readFileSync(join(dir, name), "utf8"));
  // The secret is searched for in every file before any is printed; a file that holds it is never printed.
  const holding = [...texts].filter(([, t]) => t.includes(secret)).map(([n]) => n);
  for (const name of PRINTED) {
    out(`\n── ${name} ──\n`);
    const t = texts.get(name);
    out(t === undefined ? "(not written)\n" : holding.includes(name) ? "(not printed: it holds the secret)\n" : t === "" ? "(empty)\n" : quoted(t));
  }
  const audit = texts.get("audit.json");
  let state;
  try {
    state = audit === undefined ? undefined : JSON.parse(audit).run?.state;
  } catch {}
  out(`\n── the checks ──\nthe run ended ${typeof state === "string" ? state : "(no audit view to say)"}\n`);
  const results = checks((name) => texts.get(name), secret);
  if (holding.length) results.unshift({ name: "0 no secret in the evidence", ok: false, text: `the secret is in ${holding.join(", ")}` });
  for (const r of results) {
    out(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.text}\n`);
    if (!r.ok && process.env["GITHUB_ACTIONS"] === "true") out(`::error title=boundary-live ${r.name}::${r.text.replace(/[\r\n%]/g, " ")}\n`);
  }
  const failed = results.filter((r) => !r.ok);
  out(failed.length ? `\nnot shown: ${failed.map((r) => r.name).join("; ")}\n` : "\nall four shown\n");
  return failed.length ? 1 : 0;
}

{
  const [what, dir, ...rest] = process.argv.slice(2);
  const out = (s) => process.stdout.write(s);
  if (what === "input" && dir === undefined) out(JSON.stringify({ task: task() }) + "\n");
  else if (what === "check" && dir !== undefined && !rest.length) process.exitCode = check(dir, out);
  else {
    process.stderr.write("usage: boundary-live-check.mjs input | check <dir>\n");
    process.exitCode = 2;
  }
}
