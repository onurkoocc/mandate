// The terminal escaping of 0.6 output: what a person's terminal prints of text a model, a person or a server wrote.
// It lives here, and cli.ts re-exports it, so that the commands of 0.7 that print a run (person.ts) use the same one
// function and no other.

import { canonical, isObj, show, tagOf, unwrap, type Value } from "./values.js";

/**
 * Untrusted text as a terminal shows it (0.6 output): every code point that is not printed as itself is written as
 * JSON writes an escape, `\uXXXX` (each UTF-16 unit of it): controls (C0, DEL, C1), format characters (bidirectional
 * overrides and isolates, zero-width characters, the byte order mark), line and paragraph separators, private-use,
 * unassigned and lone surrogate code points. So no text a model or a person wrote can move the cursor, reorder or
 * hide the lines a reviewer reads. Within a JSON text the result is still the same JSON value.
 */
export function terminalText(s: string): string {
  return s.replace(UNPRINTED, escaped);
}

/** What a terminal does not print as itself: controls, format characters, separators, private-use, unassigned, lone surrogates. */
const UNPRINTED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/gu;
const escaped = (ch: string): string => Array.from({ length: ch.length }, (_, k) => `\\u${ch.charCodeAt(k).toString(16).toUpperCase().padStart(4, "0")}`).join("");

/**
 * A document (Markdown, HTML) as `terminalText` would write each fragment of it: the line feeds and tabs that lay it
 * out stay, and every other code point a terminal does not print as itself is written `\uXXXX`. A renderer writes
 * none of those itself, so what is escaped is what a fragment of the run brought.
 */
export function terminalDocument(s: string): string {
  return s.replace(UNPRINTED, (ch) => (ch === "\n" || ch === "\t" ? ch : escaped(ch)));
}

/**
 * A value as a status line of a 0.6 run shows it: as `show` writes it, with each text quoted as JSON writes it, so
 * a reader sees where one ends, and with every code point a terminal does not print as itself escaped
 * (`terminalText`), so no text a model, a person or a server wrote can move the cursor or clear the lines around it.
 */
export function shownSafe(v: Value): string {
  return terminalText(shownQuoted(v));
}

/** A value as `shownSafe` writes it before the escaping: for a document, whose renderer and `terminalDocument` escape it. */
export function shownQuoted(x: Value): string {
  const t = tagOf(x);
  if (t) return t.args.length ? `${t.tag}(${t.args.map(shownQuoted).join(", ")})` : t.tag;
  if (isObj(x) && "$money" in x) return show(x);
  if (isObj(x) && "$verified" in x) return shownQuoted(unwrap(x));
  return typeof x === "string" ? JSON.stringify(x) : canonical(x);
}
