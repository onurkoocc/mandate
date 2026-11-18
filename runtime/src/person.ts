// What a person is shown, and the pages they read (spec/attention.md "The command line"; language 0.7): the text
// `mandate waits` and `mandate decide` print, and the script-free pages `mandate watch --member M --out DIR` writes.
//
// Everything here reads what B4 built and nothing else: `Runtime.listWaits` (a wait's values masked by the cap of the
// role it is listed to, each labelled with its class and how it is known), `runView(…, { role })` (the role's view)
// and `watchRun`. Never `runs.waiting`, a request as the journal holds it, or any other raw read of a run's values:
// the process could, and a role path does not. There is no server, no listener and no authenticated read: a caller
// names its own role or member, and the lock's bindings and, for a decision, its signature are all that bind them, so
// the pages are a convenience for an honest member and only the signed decision is evidence.
//
// Every text of a run, a program or a model that reaches a line is written through the terminal escaping of 0.6
// (`terminalText`, `shownSafe`), and every page through `terminalDocument` after the document builders (`toHtml`)
// have escaped it for HTML. A page is made by the builders and by nothing written here: no script, no handler, no
// external resource.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { toHtml, type Cell, type Doc } from "@mandate/bridge";
import { TERMINAL } from "./journal.js";
import type { NamedShown, UnlabelledValue } from "./mask.js";
import type { Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { shownQuoted, shownSafe, terminalDocument, terminalText } from "./terminal.js";
import { isObj, type Obj, type Value } from "./values.js";
import type { WaitItem } from "./watch.js";
import { roleDoc, runView } from "./views.js";

// ── what a wait is, as a line ───────────────────────────────────────────

/** How a value is known, in words (spec/attention.md "Masking and how a value is known"). */
const KNOWN_TEXT: Readonly<Record<string, string>> = {
  verified: "checked by the runtime",
  plain: "computed by the run or given to it",
  model: "written by a model",
  external: "from outside the program, untrusted",
};

/** What happens when nobody answers, in words; the facts' own word is kept in brackets. */
function noAnswerText(item: WaitItem): string {
  const word = item.on_no_answer;
  const to = item.escalates_to !== null ? `it goes to ${item.escalates_to}` : "it escalates";
  const phrase: Record<string, string> = {
    waits: "nothing: the run keeps waiting",
    unmet: "the criterion is unmet when the deadline passes, and the run goes on from there",
    escalates: to,
    declined: "every open item is declined, by nobody, and the run goes on",
    refused_to_lead: "the amendment is refused and the lead is told",
  };
  return Object.hasOwn(phrase, word) ? `${phrase[word]!} (${word})` : word;
}

const when = (t: number | null): string => (t === null || t <= 0 ? "unknown" : new Date(t).toISOString());

/** The label of a value: its class and how it is known, or that nothing labels it (a run before 0.7). */
export function labelText(s: { class: string | null; known: string | null }): string {
  if (s.class === null || s.known === null) return "not labelled: a run before 0.7";
  return `class ${terminalText(s.class)}; known ${terminalText(s.known)}: ${Object.hasOwn(KNOWN_TEXT, s.known) ? KNOWN_TEXT[s.known]! : "unknown"}`;
}

/** Whether a wait shows a value its role is not shown (a listed subject is masked with them). */
export function hidesFromRole(item: WaitItem): boolean {
  return typeof item.subject !== "string" || item.shown.some((s) => "masked" in s && s.masked === true);
}

/** The subject as a line prints it: the digest, or that it is masked with its class. */
function subjectText(item: WaitItem): string {
  const s = item.subject;
  return typeof s === "string" ? terminalText(s) : `masked (class ${terminalText(String(s.class))}; known ${terminalText(String(s.known))}), it is computed over values this role is not shown`;
}

/** One value a wait shows, as a line: masked, its class and how it is known, never the value; or the value, quoted and escaped, with its label. */
function shownLine(s: NamedShown | UnlabelledValue, role: string | null): string {
  const name = terminalText(s.name);
  if ("masked" in s && s.masked) return `    ${name}: masked; its class is ${terminalText(String(s.class))}, above what ${role === null ? "a member of no role" : terminalText(role)} may be shown; known ${terminalText(String(s.known))}: ${Object.hasOwn(KNOWN_TEXT, s.known) ? KNOWN_TEXT[s.known]! : "unknown"}`;
  return `    ${name}: ${shownSafe((s as { value: Value }).value)}  [${labelText(s)}]`;
}

/**
 * One wait as `mandate waits` and `mandate decide` print it: the run, the kind and whom it asks, since when, the deadline,
 * what happens with no answer, the stage, the command (a name in it a model chose, in a sub-program, is said to be one),
 * the subject, and each value it shows (not with `values` false, for a review that `openItemLines` shows item by item). Every text is escaped; a masked value prints its class and how it is known.
 */
export function waitLines(item: WaitItem, number?: number, values = true): string[] {
  const asked = item.asked_of !== null ? `asked of ${terminalText(item.asked_of)}` : item.role === null ? "asked of nobody in particular, listed to a member of no role" : `asked of nobody in particular, listed to ${terminalText(item.role)}`;
  const chosen = /\/program\/[0-9]+\//.test(item.command) ? " (a name in it was chosen by a model)" : "";
  return [
    `${number !== undefined ? `${number}. ` : ""}run ${terminalText(item.run)}  ${terminalText(item.workflow)}  tenant ${terminalText(item.tenant)}`,
    `  ${terminalText(item.kind)}, ${asked}; ${item.role === null ? "shown as a member of no role (internal)" : `shown as role ${terminalText(item.role)}`}`,
    `  since     ${when(item.since)}`,
    `  deadline  ${item.deadline === null ? "none" : when(item.deadline)}`,
    `  if nobody answers  ${terminalText(noAnswerText(item))}`,
    `  stage     ${item.stage === null ? "none" : terminalText(item.stage)}`,
    `  command   ${terminalText(item.command)}${chosen}`,
    `  revision  ${item.revision}`,
    `  subject   ${subjectText(item)}`,
    ...(values && item.shown.length ? ["  shown:", ...item.shown.map((s) => shownLine(s, item.role))] : []),
  ];
}

/** What `mandate waits` prints: one block per wait, or that nothing waits (an unknown role or member lists nothing, and is no error). */
export function waitsText(who: { role: string } | { member: string }, items: WaitItem[]): string {
  const label = "role" in who ? `role ${terminalText(who.role)}` : `member ${terminalText(who.member)}`;
  if (!items.length) return `nothing waits for ${label} (a role or a member that no package binds lists nothing; that is not an error)\n`;
  const lines = [`${items.length === 1 ? "1 open decision" : `${items.length} open decisions`} for ${label}`];
  items.forEach((item, i) => lines.push("", ...waitLines(item, i + 1)));
  return lines.join("\n") + "\n";
}

/** A line of the list `mandate decide` starts with: number, run, workflow, kind, whom it asks, deadline. */
export function waitListLine(item: WaitItem, number: number): string {
  return `${number}. run ${terminalText(item.run)}  ${terminalText(item.workflow)}  ${terminalText(item.kind)} for ${item.role === null ? "a member of no role" : terminalText(item.role)}  deadline ${item.deadline === null ? "none" : when(item.deadline)}${hidesFromRole(item) ? "  (masked for this role)" : ""}`;
}

// ── a review's open items, as the role's view gives them ────────────────

/** An open item of a review: its index in the map's input, and what it did not meet and who may waive that. */
export interface OpenItem {
  index: number;
  unmet: Array<{ criterion: string; description: string; waive: string[] }>;
}

/**
 * The open items of a review's wait, from the request the role's view gives (`runView(…, { role })`'s `waiting`): the
 * indices and what each failed are the runtime's own members of a request, kept in a role's view; the item's value is
 * not read here (it is in the wait's `shown`, masked for a role whose cap is below it).
 */
export function openItems(request: Obj): OpenItem[] {
  const q = isObj(request["question"] ?? null) ? (request["question"] as Obj) : {};
  const items = Array.isArray(q["items"]) ? q["items"] : [];
  const out: OpenItem[] = [];
  for (const i of items) {
    if (!isObj(i) || typeof i["index"] !== "number") continue;
    const unmet = (Array.isArray(i["unmet"]) ? i["unmet"] : []).filter(isObj) as Obj[];
    out.push({
      index: i["index"],
      unmet: unmet.map((u) => ({ criterion: String(u["criterion"] ?? ""), description: String(u["description"] ?? ""), waive: (Array.isArray(u["waive"]) ? u["waive"] : []).map(String) })),
    });
  }
  return out;
}

/**
 * What the role's view gives of a wait's request besides its values, as lines, for a wait that is not a review: what a
 * decision is about (the contract and criterion a person approves, or the effect an action authorizes, which a program
 * names), the options of a question, and an amendment's workflow, lead and changes. Text is escaped; the values the wait
 * shows are not here, they are in `waitLines`.
 */
export function requestLines(kind: string, request: Obj): string[] {
  const out: string[] = [];
  const word = (v: Value | undefined): string | undefined => (typeof v === "string" && v !== "" ? terminalText(v) : undefined);
  if (kind === "decision") {
    const c = word(request["contract"]);
    const k = word(request["criterion"]);
    const effect = word(request["effect"]);
    if (c !== undefined && k !== undefined) out.push(`  about     approving ${c}.${k}`);
    else if (effect !== undefined) out.push(`  about     authorizing the action ${effect}`);
  } else if (kind === "input") {
    const options = Array.isArray(request["options"]) ? request["options"] : [];
    if (options.length) out.push(`  options   ${options.map((o) => shownSafe(o as Value)).join(", ")}`);
  } else if (kind === "amendment") {
    const w = word(request["workflow"]);
    const lead = word(request["lead"]);
    if (w !== undefined) out.push(`  amends    the envelope of ${w}${lead !== undefined ? `, asked by ${lead}` : ""}`);
    for (const c of Array.isArray(request["changes"]) ? request["changes"] : []) if (isObj(c)) out.push(`  change    ${terminalText(String(c["text"] ?? ""))}`);
  }
  return out;
}

/** An open item of a review as a line block prints it, its value as the wait shows it (masked, or quoted and escaped, labelled). */
export function openItemLines(item: WaitItem, open: OpenItem, position: number): string[] {
  const out = [`  item ${open.index}: unmet ${open.unmet.map((u) => `${terminalText(u.criterion)} ("${terminalText(u.description)}"; waivable by ${u.waive.map(terminalText).join(", ") || "no one"})`).join(", ") || "nothing it names"}`];
  const value = item.shown.find((s) => s.name === `question.items[${position}].value`);
  if (value) out.push(shownLine({ ...value, name: "value" } as NamedShown, item.role));
  return out;
}

// ── the pages ───────────────────────────────────────────────────────────

/**
 * The readable form of a name in a page's file name: lowercase letters, digits, underscore and hyphen only, at most 40
 * long. No dot (the dot separates the parts, so two pairs never make one name), no capital (two names that differ only in
 * case are one file on NTFS and on the default macOS), no leading or trailing dot or space, no separator, no device
 * name (`con`, `nul`, `com1`: no dot is left to follow it), and none that starts like a digest name.
 */
const READABLE = /^[a-z0-9_-]{1,40}$/;

/** Windows' device names, which no readable name may be (with no dot in a readable name, no extension follows one either). */
const DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

/** Whether `s` may stand in a file name as it is. */
export function safeName(s: string): boolean {
  return READABLE.test(s) && !DEVICE.test(s) && !s.startsWith("_h-");
}

/**
 * What names a run or a role in a file name: itself when it is readable (`safeName`), else `_h-` and 16 lowercase
 * hexadecimal digits of its SHA-256. Two different names are two different parts: a readable one is its own, a digest one
 * is a digest of what is not readable, and no readable name starts `_h-`. So nothing run data says steers where a page is
 * written, or makes two runs or two roles share one.
 */
export function partName(s: string): string {
  return safeName(s) ? s : `_h-${createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16)}`;
}

/** The page of a run and a role: `<run>.<role>.html`, each part by `partName`; the parts hold no dot, so the name is made of them in one way only. */
export function pageName(run: string, role: string): string {
  return `${partName(run)}.${partName(role)}.html`;
}

/** `html` with a `<meta http-equiv="refresh">` after the charset, for a page that reloads itself every `seconds`. */
export function withRefresh(html: string, seconds: number): string {
  const charset = '<meta charset="utf-8">';
  if (!html.includes(charset)) throw new Violation("bad_page", "The document builder wrote no charset to put the refresh after.");
  return html.replace(charset, `${charset}<meta http-equiv="refresh" content="${seconds}">`);
}

/** A page's name as `pageName` makes it: two parts of `[a-z0-9_-]` or a digest, and `.html`. */
const PAGE = /^(?:[a-z0-9_-]{1,40}|_h-[0-9a-f]{16})\.(?:[a-z0-9_-]{1,40}|_h-[0-9a-f]{16})\.html$/;

/**
 * A file written to a temporary name in `dir` and renamed, so a reader never sees half a page, and no temporary file
 * remains. `name` is one of this module's page names (`index.html`, or `pageName`'s), checked once more: the file
 * lands in `dir` itself.
 */
export function writeAtomic(dir: string, name: string, content: string): void {
  if (name !== "index.html" && !PAGE.test(name)) throw new Violation("bad_page", `${JSON.stringify(name)} is not a name of a page.`);
  const target = join(dir, name);
  if (resolve(target, "..") !== resolve(dir)) throw new Violation("bad_page", `${JSON.stringify(name)} is not inside ${dir}.`);
  const tmp = join(dir, `.${randomBytes(8).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: "wx" });
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** One run the member holds a role in, as `index.html` lists it. */
export interface MemberRun {
  run: string;
  tenant: string;
  workflow: string;
  state: string;
  revision: number;
  /** The roles of the member in the run's package lock. */
  roles: string[];
  /** What the run was when it was read: its state, revision, last update and last event, so that a page is made again when any changes. */
  fingerprint: string;
}

/** How long a finished run stays on the page, and the most runs one page lists (open question 2). */
export const KEEP_FINISHED_MS = 7 * 86_400_000;
export const MAX_RUNS = 200;

const bound = (lock: unknown): Record<string, unknown> => (isObj((((lock ?? null) as { roles?: unknown } | null)?.roles ?? null) as Value) ? ((lock as { roles: Record<string, unknown> }).roles) : {});
const rolesOf = (lock: unknown, member: string): string[] =>
  Object.entries(bound(lock))
    .filter(([, ms]) => Array.isArray(ms) && ms.includes(member))
    .map(([r]) => r)
    .sort();

/**
 * The runs whose package lock lists `member` under a role, that are not finished or finished within the last 7 days,
 * newest first, at most 200. Only the run's identity, state and counters are read: never `waiting`, `result`, `error` or any value.
 */
export async function memberRuns(rt: Runtime, member: string): Promise<MemberRun[]> {
  const packages = await rt.db.query<{ package_hash: string; lock: unknown }>("select package_hash, lock from packages");
  const held = new Map(packages.map((p) => [p.package_hash, rolesOf(p.lock, member)] as const).filter(([, roles]) => roles.length));
  if (!held.size) return [];
  const hashes = [...held.keys()];
  const finished = [...TERMINAL];
  const rows = await rt.db.query<{ run_id: string; tenant: string; workflow: string; state: string; revision: unknown; updated_at: unknown; package_hash: string; last: unknown }>(
    `select r.run_id, r.tenant, r.workflow, r.state, r.revision, r.updated_at, r.package_hash,
            (select coalesce(max(e.seq), 0) from events e where e.run_id = r.run_id) as last
       from runs r
      where r.package_hash in (${hashes.map((_, i) => `$${i + 1}`).join(", ")})
        and (r.state not in (${finished.map((_, i) => `$${hashes.length + i + 1}`).join(", ")}) or r.updated_at >= $${hashes.length + finished.length + 1})
      order by r.created_at desc, r.run_id
      limit ${MAX_RUNS}`,
    [...hashes, ...finished, rt.adapters.clock.now() - KEEP_FINISHED_MS],
  );
  return rows.map((r) => ({
    run: r.run_id,
    tenant: r.tenant,
    workflow: r.workflow,
    state: r.state,
    revision: Number(r.revision),
    roles: held.get(r.package_hash)!,
    fingerprint: `${r.state}:${Number(r.revision)}:${Number(r.updated_at)}:${Number(r.last)}`,
  }));
}

const text = (t: string, untrusted = false): Cell => (untrusted ? { text: t, untrusted: true } : t);

/** The values a wait shows, as one cell of the index: masked ones by class and how they are known, never their value. */
function valuesCell(item: WaitItem): Cell {
  const parts = item.shown.map((s) => ("masked" in s && s.masked ? `${s.name}: masked (class ${s.class}; known ${s.known})` : `${s.name}: ${shownQuoted((s as { value: Value }).value)} [${labelText(s)}]`));
  return text(parts.join("\n") || "—", true);
}

/**
 * `index.html`: the member's waits, then the member's runs, each as a document of the builders' (`Doc`): every string
 * escaped there, text a model or a person wrote marked as from outside the program. It names the page of each run and role
 * as text; no document the builders write holds a link.
 */
export function indexDoc(member: string, waits: WaitItem[], runs: MemberRun[]): Doc {
  const page = (run: string, role: string): Cell => text(pageName(run, role));
  return {
    title: `What waits for ${member}`,
    meta: [
      ["member", member],
      ["what", "the open decisions of the member's roles, and the runs they hold a role in, each as the role is shown it"],
    ],
    blocks: [
      { note: "Reading is not authenticated: this page shows what a role may be shown, to whoever opens the file. Nothing here is a decision; a decision is signed with mandate decide." },
      { h: "Waiting for a decision" },
      waits.length
        ? {
            table: {
              head: ["Run", "Workflow", "Kind", "Role", "Asked of", "Since", "Deadline", "If nobody answers", "Stage", "Subject", "Shown", "Page"],
              rows: waits.map((w): Cell[] => [
                { text: w.run, mono: true },
                w.workflow,
                w.kind,
                w.role ?? "no role (internal)",
                w.asked_of ?? "nobody in particular",
                when(w.since),
                w.deadline === null ? "none" : when(w.deadline),
                noAnswerText(w),
                w.stage === null ? "none" : text(w.stage, true),
                typeof w.subject === "string" ? { text: w.subject, mono: true } : `masked (class ${w.subject.class}; known ${w.subject.known})`,
                valuesCell(w),
                w.role === null ? "none (a member of no role has no page of the run)" : page(w.run, w.role),
              ]),
            },
          }
        : { p: `Nothing waits for ${member}.` },
      { h: "Runs" },
      runs.length
        ? {
            table: {
              head: ["Run", "Workflow", "State", "Revision", "Pages"],
              rows: runs.map((r): Cell[] => [{ text: r.run, mono: true }, r.workflow, r.state, String(r.revision), text(r.roles.map((role) => pageName(r.run, role)).join(", "))]),
            },
          }
        : { p: `${member} holds a role in no run that is open or finished within 7 days.` },
    ],
  };
}

/** A page as a file holds it: the builders' HTML, then every code point a terminal or a reader would not see as itself written out. */
export function pageHtml(doc: Doc, refresh: number | undefined): string {
  const html = toHtml(doc);
  return terminalDocument(refresh === undefined ? html : withRefresh(html, refresh));
}

/** What a pass of `watch --member` did. */
export interface PassResult {
  /** The files it wrote, by name. */
  written: string[];
  /** The pages it could not make: the file, and why, escaped. */
  problems: string[];
}

/** The state `watch --follow` keeps between passes: what each file held when written, and what each run was when its pages were. */
export interface PagesState {
  content: Map<string, string>;
  runs: Map<string, string>;
}

/**
 * One pass of `mandate watch --member M --out DIR`: `index.html`, and `<run>.<role>.html` for each run and each role the
 * member holds in the run's package lock, each written atomically and only when its content changed since `state`
 * recorded it. A run whose fingerprint (state, revision, last update, last event) is unchanged is not read again. A role
 * the run's program does not name has no view and no page; a run or role whose name is not safe for a file has none and is
 * said so. Reads only through `listWaits` and `runView(…, { role })`.
 */
export async function pass(rt: Runtime, member: string, dir: string, o: { refresh?: number; state: PagesState }): Promise<PassResult> {
  const result: PassResult = { written: [], problems: [] };
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    result.problems.push(`the directory ${terminalText(dir)} cannot be made: ${terminalText(e instanceof Error ? e.message : String(e))}`);
    return result;
  }
  const put = (name: string, content: string): void => {
    if (o.state.content.get(name) === content) return;
    writeAtomic(dir, name, content);
    o.state.content.set(name, content);
    result.written.push(name);
  };
  const waits = await rt.listWaits({ member });
  const runs = await memberRuns(rt, member);
  for (const r of runs) {
    for (const role of r.roles) {
      const name = pageName(r.run, role);
      if (o.state.runs.get(name) === r.fingerprint) continue;
      try {
        const { view, program, modules } = await runView(rt, r.run, { role });
        put(name, pageHtml(roleDoc(view, program, modules), o.refresh));
        o.state.runs.set(name, r.fingerprint);
      } catch (e) {
        // A role the lock binds and the program does not name has no view: not an error, and no page.
        if (e instanceof Violation && e.code === "unknown_role") continue;
        result.problems.push(`no page for run ${terminalText(r.run)} as ${terminalText(role)}: ${terminalText(e instanceof Error ? e.message : String(e))}`);
      }
    }
  }
  put("index.html", pageHtml(indexDoc(member, waits, runs), o.refresh));
  return result;
}
