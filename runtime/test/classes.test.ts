// The class table (spec/boundary.md "Views by role and the audit view"; INV-17): every event type the runtime can
// write has a class, read from the runtime's own sources here, so a new event type cannot reach a projection
// unclassified; and whatever the table does not name is S4, which no role sees.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASSES, commandClass, EVENT_CLASSES, eventClass, SECTION_CLASSES, sectionClass, shows, stepClass } from "../src/classes.js";
import { STATE_EVENTS } from "../src/journal-chain.js";
import { MASKED, NOTHING, PROJECTIONS, WITHHELD } from "../src/projection.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") ? [{ file: path.slice(SRC.length).replaceAll("\\", "/"), text: readFileSync(path, "utf8") }] : [];
  });
}

const literals = (s: string): string[] => [...s.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);

/** The string literals of the type `name` stands for in `file`: a union written out, `Exclude<T, …>`, or an exported type alias. */
function typeLiterals(type: string, text: string): string[] {
  const t = type.trim();
  const exclude = /^Exclude<(\w+),\s*(.+)>$/.exec(t);
  if (exclude) return typeLiterals(exclude[1]!, text).filter((x) => !literals(exclude[2]!).includes(x));
  if (/^\w+$/.test(t)) {
    const alias = new RegExp(`export type ${t} = ([^;]+);`).exec(text);
    if (!alias) throw new Error(`no type ${t}`);
    return literals(alias[1]!);
  }
  const union = literals(t);
  if (!union.length) throw new Error(`cannot read the type ${t}`);
  return union;
}

/** The type of parameter (or field) `name` in the signature of the method that contains `at`. */
function paramType(text: string, at: number, name: string): string {
  const starts = [...text.slice(0, at).matchAll(/\n {2}(?:private |static )*(?:async )?\w+\(/g)];
  const start = starts.at(-1)!.index!;
  const signature = text.slice(start, text.indexOf(" {\n", start));
  const m = new RegExp(`\\b${name}\\??:\\s*(Exclude<\\w+,\\s*[^>]+>|(?:"\\w+"\\s*\\|?\\s*)+|\\w+)`).exec(signature);
  if (!m) throw new Error(`no parameter ${name} in ${signature}`);
  return m[1]!;
}

/**
 * Every event type the runtime's sources can write. Every event is written by `Journal.event(tx, run, type, data)`:
 * its type is a literal, a choice between literals, a literal and a value of a typed parameter (`run_${state}`), or a
 * typed parameter. Each is read back to its literals; anything else fails the test.
 */
function writtenTypes(): { types: Set<string>; sites: number } {
  const types = new Set<string>();
  let sites = 0;
  for (const { file, text } of sources(SRC)) {
    const calls = [...text.matchAll(/\.event\(\s*tx\s*,\s*[\w.]+\s*,\s*((?:"[^"]*"|`[^`]*`|[^,"`])+?)\s*,/g)];
    expect(calls.length, `every event(tx, …) call in ${file} is read`).toBe([...text.matchAll(/\.event\(\s*tx\b/g)].length);
    for (const c of calls) {
      sites++;
      const arg = c[1]!.trim();
      const template = /^`([a-z_]+)\$\{(\w+)\}`$/.exec(arg);
      if (template) for (const s of typeLiterals(paramType(text, c.index!, template[2]!), text)) types.add(template[1]! + s);
      else if (/^\w+$/.test(arg)) for (const s of typeLiterals(paramType(text, c.index!, arg), text)) types.add(s);
      // A choice between two literals: what comes after its condition.
      else if (literals(arg.slice(arg.indexOf("?") + 1)).length) for (const s of literals(arg.slice(arg.indexOf("?") + 1))) types.add(s);
      else throw new Error(`${file}: cannot read the event type ${arg}`);
    }
  }
  return { types, sites };
}

describe("the class table", () => {
  it("has a class for every event type the runtime can write, and for no other", () => {
    const { types, sites } = writtenTypes();
    expect(sites).toBeGreaterThan(30);
    // Every state the run can take is written as run_<state>, and the chain anchors each of them.
    for (const s of STATE_EVENTS) expect(types).toContain(s);
    for (const t of ["violation", "cancel_requested", "lease_revoked", "wait_opened", "program_submitted", "action_confirmed", "changeset_partial"]) expect(types).toContain(t);
    const missing = [...types].filter((t) => !Object.hasOwn(EVENT_CLASSES, t)).sort();
    expect(missing, "event types the runtime writes with no class").toEqual([]);
    const stale = Object.keys(EVENT_CLASSES).filter((t) => !types.has(t)).sort();
    expect(stale, "classes of event types the runtime does not write").toEqual([]);
  });

  it("is the table spec/boundary.md gives", () => {
    const spec = readFileSync(fileURLToPath(new URL("../../spec/boundary.md", import.meta.url)), "utf8");
    const table = spec.slice(spec.indexOf("| Class | Event types |"), spec.indexOf("An event's class says"));
    const written = Object.fromEntries([...table.matchAll(/^\| (S\d) \| (.+) \|$/gm)].flatMap((m) => [...m[2]!.matchAll(/`([a-z_]+)`/g)].map((t) => [t[1]!, m[1]!])));
    expect(written).toEqual(EVENT_CLASSES);
  });

  it("writes events in one place only", () => {
    const inserts = sources(SRC).flatMap(({ file, text }) => [...text.matchAll(/insert into events\b/g)].map(() => file));
    expect(inserts).toEqual(["journal.ts"]);
  });

  it("puts each event, section and command in one of the five classes, and anything it does not name in S4", () => {
    expect(CLASSES).toEqual(["S0", "S1", "S2", "S3", "S4"]);
    for (const c of [...Object.values(EVENT_CLASSES), ...Object.values(SECTION_CLASSES)]) expect(CLASSES).toContain(c);
    expect(eventClass("violation")).toBe("S1");
    expect(eventClass("wait_opened")).toBe("S0");
    expect(eventClass("an_event_of_a_later_release")).toBe("S4");
    expect(eventClass("toString")).toBe("S4");
    expect(sectionClass("a_section_of_a_later_release")).toBe("S4");
    expect(sectionClass("constructor")).toBe("S4");
    expect([stepClass("turn"), stepClass("tool"), stepClass("session"), stepClass("input"), stepClass("delegate")]).toEqual(["S4", "S4", "S4", "S0", "S2"]);
    expect([commandClass("turn"), commandClass("decision"), commandClass("delegate")]).toEqual(["S4", "S0", "S3"]);
  });

  it("shows a role S1 and S2, and S0 only where it was asked of that role; the audit view every class", () => {
    const role = { role: "approver" };
    expect(CLASSES.map((c) => shows(role, c, "approver"))).toEqual([true, true, true, false, false]);
    expect(CLASSES.map((c) => shows(role, c, "reviewer"))).toEqual([false, true, true, false, false]);
    expect(shows(role, "S0", null)).toBe(false);
    expect(shows(role, "S0")).toBe(false);
    expect(CLASSES.map((c) => shows({ audit: true }, c))).toEqual([true, true, true, true, true]);
  });
});

// ── the allow-list of WatchRun (0.7; spec/boundary.md "What `WatchRun` gives a role of each event") ──────────────

/** The arguments of the call whose `(` is at `open`, as written, split at its top-level commas. */
function callArgs(text: string, open: number): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let quote: string | null = null;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += text[++i]!;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      cur += ch;
      continue;
    }
    if ("([{".includes(ch)) depth++;
    if (")]}".includes(ch)) {
      if (depth === 0) return [...out, cur.trim()];
      depth--;
    }
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  throw new Error("a call that does not close");
}

/** The object literals at the top level of `expr` (`c ? { a } : {}` has two). */
function literalsIn(expr: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < expr.length; i++) {
    if (expr[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (expr[i] === "}" && --depth === 0) out.push(expr.slice(start, i + 1));
  }
  return out;
}

/**
 * The keys an event's data has where it is written, read from its expression: an object literal's keys, with what its
 * spreads add (a conditional's literals, a value this reads too). `resolve` reads what a name or a call stands for;
 * what it cannot read is a key `?<expression>`, which fails the test until the expression is read and decided.
 */
function dataKeys(expr: string, resolve: (name: string) => string | undefined): string[] {
  let e = expr
    .trim()
    .replace(/\s+as\s+(?:unknown\s+as\s+)?\w+$/, "")
    .trim();
  if (e.startsWith("(") && e.endsWith(")")) e = e.slice(1, -1).trim();
  if (!e.startsWith("{")) {
    const found = resolve(e);
    return found === undefined ? [`?${e}`] : dataKeys(found, resolve);
  }
  return callArgs(e, 0)
    .filter(Boolean)
    .flatMap((m) => {
      if (m.startsWith("...")) {
        const inner = m.slice(3).trim();
        const lits = literalsIn(inner);
        return lits.length ? lits.flatMap((l) => dataKeys(l, resolve)) : dataKeys(inner, resolve);
      }
      const k = /^"?([A-Za-z_$][\w$]*)"?\s*(?::|$)/.exec(m);
      return k ? [k[1]!] : [`?${m}`];
    });
}

/** The members of an interface or an inline object type, `{ a: T; b?: U }`, as an object literal of those keys. */
function typeAsLiteral(body: string): string {
  // Its own members only: without its comments, and with each nested object type as one name.
  let flat = body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  while (/\{[^{}]*\}/.test(flat)) flat = flat.replace(/\{[^{}]*\}/g, "T");
  return `{ ${[...flat.matchAll(/(?:^|[;\n])\s*(\w+)\??:/g)].map((m) => m[1]).join(", ")} }`;
}

/** What a name an event's data is written from stands for, where the runtime builds it: read from the sources. */
function resolver(file: string, text: string, at: number, all: Array<{ file: string; text: string }>): (name: string) => string | undefined {
  const src = (f: string): string => all.find((s) => s.file === f)!.text;
  const firstLiteral = (re: RegExp, where: string): string | undefined => {
    const m = re.exec(where);
    return m ? literalsIn(where.slice(m.index + m[0].length - 1))[0] : undefined;
  };
  // What a signed decision adds to the data it is recorded in (runtime.ts `Decider`).
  const signed = (): string => typeAsLiteral(/signed: \{([^}]*)\}/.exec(src("runtime.ts"))![1]!);
  return (name) => {
    // A function's result: the literal it returns.
    const call = /^(\w+)\(/.exec(name);
    if (call) return firstLiteral(new RegExp(`function ${call[1]}\\([^)]*\\)[^{]*\\{[\\s\\S]*?return \\{`), text);
    if (name === "who.signed") return signed();
    if (!/^\w+$/.test(name)) return undefined;
    const before = text.slice(0, at);
    // A parameter of the method the call is in, typed inline or by an interface of the sources.
    const method = before.slice(before.lastIndexOf("\n  async "));
    const sig = /^\n {2}async \w+\(([\s\S]*?)\): Promise/.exec(method);
    const param = sig ? new RegExp(`\\b${name}\\??: (\\{[^}]*\\}|\\w+)`).exec(sig[1]!) : null;
    // `Partial<Pick<T, "a" | "b">>`: those members.
    const picked = sig ? new RegExp(`\\b${name}\\??: Partial<Pick<\\w+, ([^>]+)>>`).exec(sig[1]!) : null;
    if (picked) return `{ ${literals(picked[1]!).join(", ")} }`;
    if (param && param[1]!.startsWith("{")) return typeAsLiteral(param[1]!.slice(1, -1));
    if (param && param[1] !== "Value") {
      const decl = all.map((s) => new RegExp(`export interface ${param[1]} \\{([\\s\\S]*?)\\n\\}`).exec(s.text)).find(Boolean);
      if (decl) return typeAsLiteral(decl[1]!);
    }
    // A value built where the method is called, and written there once: a review's (interp.ts), an amendment's (plan.ts).
    if (file === "journal.ts" && name === "requested") {
      if (/^\n {2}async openReview\(/.test(method)) return firstLiteral(/const requested: Obj = \{/, src("interp.ts"));
      if (/^\n {2}async openAmendment\(/.test(method)) {
        const m = /\{ plan: h\.plan, step,[^}]*\}/.exec(src("plan.ts"));
        return m?.[0];
      }
      return undefined;
    }
    // A name the method builds itself: `const x = c ? { … } : …`, or `let x: Decider["signed"]` given a signed decision's fields.
    const own = before.slice([...before.matchAll(/\n {2}(?:private |static )*(?:async )?\w+\(/g)].at(-1)?.index ?? 0);
    if (new RegExp(`let ${name}: Decider\\["signed"\\]`).test(own)) return signed();
    return firstLiteral(new RegExp(`const ${name}(?::[^=]+)? = [^{;]*\\{`), own);
  };
}

/** Each place the runtime writes an event: the types it can write there, and the keys of the data it writes. */
function writeSites(): Array<{ file: string; types: string[]; keys: string[] }> {
  const all = sources(SRC);
  return all.flatMap(({ file, text }) =>
    [...text.matchAll(/\.event\(\s*tx\b/g)].map((m) => {
      const [, , type, data] = callArgs(text, m.index! + m[0].indexOf("("));
      const t = type!.trim();
      const template = /^`([a-z_]+)\$\{(\w+)\}`$/.exec(t);
      const choice = literals(t.slice(t.indexOf("?") + 1));
      const types = template
        ? typeLiterals(paramType(text, m.index!, template[2]!), text).map((s) => template[1]! + s)
        : /^\w+$/.test(t)
          ? typeLiterals(paramType(text, m.index!, t), text)
          : choice;
      return { file, types, keys: dataKeys(data!, resolver(file, text, m.index!, all)) };
    }),
  );
}

describe("the allow-list of WatchRun", () => {
  it("has an entry for every event type with a class, and for no other: a new event type is given to no role until it is decided", () => {
    expect(Object.keys(PROJECTIONS).sort()).toEqual(Object.keys(EVENT_CLASSES).sort());
    for (const t of Object.keys(WITHHELD)) expect(PROJECTIONS[t], t).not.toBe(NOTHING);
    // An S3 or S4 event gives a role nothing: no role sees it at all (`shows`), and its entry says so too.
    for (const [t, c] of Object.entries(EVENT_CLASSES)) if (c === "S3" || c === "S4") expect(PROJECTIONS[t], t).toBe(NOTHING);
    for (const [t, f] of Object.entries(MASKED)) expect(PROJECTIONS[t], t).toContain(f);
  });

  it("decides every field the runtime writes in an event that gives a role anything: given, or left out", () => {
    const sites = writeSites();
    expect(sites.length).toBe(writtenTypes().sites);
    const written = new Map<string, Set<string>>();
    for (const s of sites) {
      expect(s.types.length, `the types written at a site of ${s.file}`).toBeGreaterThan(0);
      for (const t of s.types) {
        if (PROJECTIONS[t] === NOTHING) continue;
        expect(
          s.keys.filter((k) => k.startsWith("?")),
          `the data of ${t} in ${s.file}, which this test cannot read: read it, and decide its fields`,
        ).toEqual([]);
        const set = written.get(t) ?? new Set<string>();
        for (const k of s.keys) set.add(k);
        written.set(t, set);
      }
    }
    for (const [t, entry] of Object.entries(PROJECTIONS)) {
      if (entry === NOTHING) continue;
      const decided = new Set([...entry, ...(WITHHELD[t] ?? [])]);
      const keys = [...(written.get(t) ?? [])];
      expect(keys.filter((k) => !decided.has(k)).sort(), `fields of ${t} the runtime writes that PROJECTIONS does not give and WITHHELD does not leave out`).toEqual([]);
      expect([...decided].filter((k) => !keys.includes(k)).sort(), `fields of ${t} decided that the runtime does not write`).toEqual([]);
      for (const k of WITHHELD[t] ?? []) expect(entry, `${t}.${k} is both given and left out`).not.toContain(k);
    }
  });

  it("fails on a field that is not decided, and on data it cannot read", () => {
    const resolve = (): undefined => undefined;
    expect(dataKeys(`{ command: id, ok, ...(meta !== undefined ? { meta } : {}), ...who.signed }`, resolve)).toEqual(["command", "ok", "meta", "?who.signed"]);
    expect(dataKeys(`data as unknown as Value`, resolve)).toEqual(["?data"]);
  });

  it("is the table spec/boundary.md gives", () => {
    const spec = readFileSync(fileURLToPath(new URL("../../spec/boundary.md", import.meta.url)), "utf8");
    const start = spec.indexOf("| Event type | Fields a role is given | Fields left out |");
    const table = spec.slice(start, spec.indexOf("\n\n", start));
    const rows = [...table.matchAll(/^\| `([a-z_]+)` \| (.*) \| (.*) \|$/gm)];
    const names = (cell: string): string[] => [...cell.matchAll(/`([a-z_]+)`/g)].map((m) => m[1]!);
    expect(Object.fromEntries(rows.map((r) => [r[1]!, r[2] === "nothing" ? NOTHING : names(r[2]!)]))).toEqual(PROJECTIONS);
    expect(Object.fromEntries(rows.filter((r) => names(r[3]!).length).map((r) => [r[1]!, names(r[3]!)]))).toEqual(WITHHELD);
    expect(Object.fromEntries(rows.flatMap((r) => [...r[2]!.matchAll(/`([a-z_]+)` \(masked\)/g)].map((m) => [r[1]!, m[1]!])))).toEqual(MASKED);
  });
});
