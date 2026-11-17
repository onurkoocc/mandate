// The language the acceptance and review suites of 0.6 run their programs under, and the one place that relabels them.
//
// Every rule of 0.6 holds in 0.7 (spec/attention.md "Version gating"): a package of 0.7 that uses nothing 0.7 adds runs
// as the same package of 0.6 runs. The superset test shows it by running the suites of 0.6 again, with the same
// assertions, on the same programs labelled 0.7 (test/superset-0.7/): each file there names the language with
// `runUnder` and then imports the suite, whose programs and the modules a package carries pass through `relabel` (text)
// or `relabelIr` (IR). Run as itself, a suite runs under 0.6, and `relabel` gives back what it is given.
//
// What is relabelled: a program's header `mandate @ 0.6`, and the `language` of a program's IR; never a library's
// module (a library is published at its version, and the lock pins its digest: a 0.7 program reads a library of 0.6,
// as it reads `std.patterns` 1.0.0) nor a lock, which a 0.7 program reads in every older format.
//
// What a later slice changes in what a relabelled 0.6 package needs is changed here, and nowhere else: `lockUnder`
// is the lock a suite gives a relabelled package, today the lock it was given. After RL5 a 0.7 lock may need a
// `role_classes` for a role that is shown confidential data (E1909), and after RL6 a 0.7 program without a pin of
// `std.patterns` resolves 2.0.0, so a lock that pins none may need to pin 1.0.0.

import type { Lock, Program } from "@mandate/bridge";

/** The language of the suites' own programs. */
export const WRITTEN = "mandate/0.6";

let under = WRITTEN;

/** Runs the suite imported next under `language`: its programs are relabelled to it. A file of test/superset-0.7/ calls it first. */
export function runUnder(language: string): void {
  under = language;
}

/** The language the suite's programs are relabelled to: 0.6, unless a file of test/superset-0.7/ said otherwise. */
export function language(): string {
  return under;
}

/** Whether the suite runs under another language than it is written in. */
export function relabelled(): boolean {
  return under !== WRITTEN;
}

/** The number of the language under test, as a header writes it: `0.7` for `mandate/0.7`. */
export function version(): string {
  return under.slice("mandate/".length);
}

/** The header of a program under test: `mandate @ 0.7`. */
export function header(): string {
  return `mandate @ ${version()}`;
}

const WRITTEN_HEADER = /^mandate @ 0\.6[ \t]*$/m;

/**
 * A program's text of 0.6, as the language under test writes it: its header relabelled, and nothing else. A text that
 * is not of 0.6 (a program of an earlier language the suite holds beside it) is given back as it is.
 */
export function relabel(text: string): string {
  return relabelled() ? text.replace(WRITTEN_HEADER, header()) : text;
}

/** A program (IR) of 0.6, as the language under test labels it; one of another language is given back as it is. */
export function relabelIr<P extends Pick<Program, "language">>(p: P): P {
  return relabelled() && String(p.language) === WRITTEN ? { ...p, language: under as Program["language"] } : p;
}

/** The lock a suite gives a relabelled package: the one it was given (see above for what later slices change here). */
export function lockUnder<L extends Lock | undefined>(lock: L): L {
  return lock;
}

/**
 * Holds what reaches a world (helpers.ts) in a run under another language: a program's text still of 0.6 there is a
 * source the suite forgot to relabel, and the run would show nothing of the language under test.
 */
export function heldUnder(text: string): void {
  if (relabelled() && WRITTEN_HEADER.test(text)) throw new Error(`A program of ${WRITTEN} reached a world in a run under ${under}: give it through relabel() (test/relabel.ts).`);
}
