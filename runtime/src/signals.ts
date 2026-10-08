// How control leaves the interpreter. Recoverable errors are values a program
// can handle (`Fault`, the DelegateError union of Doc 4 §8.7). Everything else
// stops the current worker: the run waits for a person, needs attention, was
// cancelled, lost its lease, or (in tests) the worker "crashed".

import { show, tag as variant, type Value } from "./values.js";

/** A recoverable error: Timeout, BudgetExceeded, SkillFailed(…), Rejected(…), PolicyDenied(…), UnknownOutcome(…). */
export class Fault extends Error {
  constructor(
    readonly tag: string,
    readonly args: Value[] = [],
  ) {
    super(show(variant(tag, ...args)));
  }
  value(): Value {
    return variant(this.tag, ...this.args);
  }
}

/** The run waits for input or a decision from a person. */
export class Suspend extends Error {
  constructor(readonly waiting: Value) {
    super("waiting");
  }
}

/** An external effect has an unknown outcome; the run cannot end cleanly until it is resolved (INV-12). */
export class Attention extends Error {
  constructor(readonly reason: Value) {
    super("attention required");
  }
}

/** The run was cancelled before this dispatch (R08). */
export class Cancelled extends Error {
  constructor() {
    super("run cancelled");
  }
}

/** Another worker holds a newer lease; this worker's writes are rejected (R06). */
export class StaleFence extends Error {
  constructor(
    readonly mine: number,
    readonly current: number,
  ) {
    super(`stale fence ${mine}; current fence is ${current}`);
  }
}

/** A runtime invariant was violated. These never reach the program as values (§8.7). */
export class Violation extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
  }
}

/** A simulated worker crash at a named point (fault injection for Gate 2). */
export class Crash extends Error {
  constructor(readonly point: string) {
    super(`crash at ${point}`);
  }
}
