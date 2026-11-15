// What can go wrong when the bridge asks the Rust compiler: each a kind of its own, so that no caller can take one
// for an answer. A door that refuses its input (`bad_input`) is not one of them: it stands for the TypeScript
// function throwing, and rust.ts throws what the TypeScript throws.
//
// A message says what happened in the bridge's own words and names the door. It never holds what the module wrote
// on its standard error (a panic's message carries the source paths of the machine that built the module), and it
// quotes nothing of the request: a request carries programs, documents and run-time values, and a message of the
// bridge reaches a model (a sub-program's `check_failed`), a log and a person.

/** The kinds of failure, each with what it means. */
export const FAILURE_KINDS = {
  module_missing: "there is no module at the path the bridge looks at",
  module_invalid: "the file is not a WebAssembly module",
  module_refused: "the module asks for an import the host does not serve, lacks an export it needs, or may grow its memory past the ceiling",
  doors_mismatch: "the module's table of doors lacks a door the bridge calls, or gives it other parameters",
  trap: "the module trapped",
  out_of_memory: "the module ran out of memory: it reached its ceiling of 256 MiB",
  stack_exhausted: "the module exhausted its stack",
  output_too_large: "the module wrote more than 64 MiB of answer",
  exit_status: "the module exited with a status other than 0",
  bad_answer: "the module's answer is not one JSON answer",
  refused: "the module refused the request (too large, malformed, or for a door it does not have)",
  unrepresentable: "the input cannot be written as a request: it holds a value the module's strict reader refuses",
  host_error: "the host failed while it ran the module",
} as const;

export type FailureKind = keyof typeof FAILURE_KINDS;

/** A failure of the Rust compiler or of the host that runs it. Never an answer. */
export class CompilerFailure extends Error {
  override readonly name = "CompilerFailure";

  constructor(
    readonly kind: FailureKind,
    /** The door the bridge asked, when it had got that far. */
    readonly door: string | undefined,
    detail: string,
    /** For `refused`: the kind the module's answer gave (`too_large`, `bad_request`, `unknown_door`). */
    readonly answerKind?: string,
  ) {
    super(`the Rust compiler failed${door ? ` on ${door}` : ""} (${kind}): ${detail}`);
    this.shown = kind === "module_missing" || kind === "module_invalid" ? `the Rust compiler failed${door ? ` on ${door}` : ""} (${kind})` : this.message;
  }

  /**
   * What may be shown to a model (a sub-program's `check_failed`): the message, without where the module is on this
   * machine, which only a missing or unreadable module's message names.
   */
  readonly shown: string;
}

/** A door's refusal of its input (`bad_input`): what the TypeScript function throws on. rust.ts turns it into that. */
export class DoorRefusal extends Error {
  override readonly name = "DoorRefusal";

  constructor(
    readonly door: string,
    /** The module's message, in the TypeScript's words where the Rust gives them. */
    readonly detail: string,
  ) {
    super(detail);
  }
}
