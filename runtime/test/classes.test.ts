// The class table (spec/boundary.md "Views by role and the audit view"; INV-17): every event type the runtime can
// write has a class, read from the runtime's own sources here, so a new event type cannot reach a projection
// unclassified; and whatever the table does not name is S4, which no role sees.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CLASSES, commandClass, EVENT_CLASSES, eventClass, SECTION_CLASSES, sectionClass, shows, stepClass } from "../src/classes.js";
import { STATE_EVENTS } from "../src/journal-chain.js";

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
