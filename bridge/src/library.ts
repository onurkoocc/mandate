// Language 0.6 in the bridge (spec/library.md): the names, the types and the doors of what only the Rust compiler
// reads. The reference compiler is frozen at 0.5, so its types and constants know nothing of 0.6; the bridge keeps
// them as they are (index.ts takes them as they are, `export *`) and adds here what 0.6 has besides:
//
// - the language and lock versions of 0.6, and `atLeast` over every version the bridge reads, 0.6 included (the
//   reference compiler's `atLeast` knows nothing after 0.5, and so would read a 0.6 program as older than any);
// - the shapes 0.6 adds to the IR (spec/ir-0.6.schema.json) and to the lock (spec/lock-0.6.schema.json): `pub`
//   and `doc` on a definition, a pattern and its application, a connector and its tools, a criterion's `waive`,
//   an envelope's `shapes`; the lock's `libraries` and `connectors`;
// - what the `check` door takes and gives besides what the reference's `check` does: the libraries the lock pins,
//   the configuration's `libraries` member, and the expanded program; and, when it is asked (`linked`), the running
//   program, expanded and linked through what each library reaches, which a run runs and stores;
// - what the `check_subprogram` door gives besides: the running program of a sub-program that applies a pattern;
// - the Rust-only doors the runtime calls (doors.ts, RUST_ONLY): `library_verify`.
//
// In `ts` mode a call of a Rust-only door has no reference to answer it: it throws NoReference, by name, and never
// passes. A program of 0.6 given to the reference compiler is refused by it on its own (E0103).

import { LANGUAGE_VERSIONS, type CheckOptions, type CheckResult, type Criterion, type Def, type Diagnostic, type Envelope, type Expr, type LanguageVersion as ReferenceLanguage, type Lock as ReferenceLock, type Param, type SourceKind, type Stmt, type SubprogramCheck, type SubprogramInput, type TestDef, type TypeExpr, type Use, type WorkflowDef } from "@mandate/compiler";
import { countLanguage06 } from "./compare.js";
import { compilerMode } from "./mode.js";
import { rustCall } from "./wasm/call.js";
import { DoorRefusal } from "./wasm/errors.js";

/** The language version of 0.6, which only the Rust compiler reads. */
export const LANGUAGE_06 = "mandate/0.6";
/** The lock format of 0.6, with `libraries` and `connectors`. */
export const LOCK_FORMAT_06 = "mandate/lock/0.6";
/** The format of a library's manifest, `mandate.library.json`. */
export const LIBRARY_FORMAT = "mandate/library/0.6";
/** Every language version the bridge reads: the reference compiler's, then the one only the Rust reads. */
export const BRIDGE_LANGUAGE_VERSIONS = [...LANGUAGE_VERSIONS, LANGUAGE_06] as const;

/** A language version the bridge reads: one of the reference compiler's, or 0.6. */
export type LanguageVersion = ReferenceLanguage | typeof LANGUAGE_06;

/**
 * Whether `v` is `since` or a later version, over every version the bridge reads (BRIDGE_LANGUAGE_VERSIONS): the
 * reference compiler's `atLeast`, for 0.1 to 0.5 the same answer, and for 0.6 the one that compiler cannot give. A
 * value that is no version is at least none.
 */
export function atLeast(v: LanguageVersion, since: LanguageVersion): boolean {
  const order: readonly string[] = BRIDGE_LANGUAGE_VERSIONS;
  return order.indexOf(v) >= order.indexOf(since);
}

// ── the IR of 0.6 (spec/ir-0.6.schema.json) ─────────────────────────────

/** What 0.6 adds to every definition: `pub`, what another module may name; `doc`, its `///` lines. */
export interface Documented {
  pub?: true;
  doc?: string;
}

/** One slot of a pattern: its name, its kind, and the signature its kind takes. */
export interface Slot {
  name: string;
  kind: string;
  params?: TypeExpr[];
  returns?: TypeExpr;
  type?: TypeExpr;
  read_only?: true;
}

/** The argument of one slot of an application: an expression, or a type written as one. */
export interface SlotArg {
  name: string;
  value?: Expr;
  type?: TypeExpr;
}

/** The application of a pattern, `workflow W = P<…>(…)`: the whole definition of its workflow, besides caps and budget. */
export interface Apply {
  pattern: string;
  types?: TypeExpr[];
  args: SlotArg[];
}

/** A pattern (spec/library.md "Patterns"): a workflow with slots. In its body, `delegate` may name a slot (`slot`). */
export interface PatternDef extends Documented {
  kind: "pattern";
  generics?: string[];
  slots: Slot[];
  params?: Param[];
  returns: TypeExpr;
  body?: Stmt[];
}

/** One tool of a connector: `read_only`, or of a write class with its retry class. */
export interface ConnectorTool {
  params: Param[];
  returns: TypeExpr;
  read_only?: true;
  critical?: true;
  idempotency_key?: string;
  retry_class?: "read_only" | "idempotent" | "reconcilable" | "non_retryable";
  reconcile_by?: string;
  compensation?: string;
}

/** A connector (spec/library.md "Connectors"): an MCP server's tools. A call of one is `<connector>.<tool>(…)`. */
export interface ConnectorDef extends Documented {
  kind: "connector";
  mcp: string;
  version?: string;
  class?: string;
  tools: Record<string, ConnectorTool>;
}

/** A criterion of 0.6: `waive by`, the roles that may waive it. */
export type Criterion06 = Criterion & { waive?: string[] };

/** An envelope of 0.6: `shapes`, the patterns a lead's sub-programs may apply (B12), a sorted set of names. */
export type Envelope06 = Envelope & { shapes?: string[] };

/** A workflow of 0.6: an application of a pattern has `apply`, and no parameters, result or body of its own. */
export type WorkflowDef06 = Documented & Omit<WorkflowDef, "params" | "returns" | "body" | "envelope"> & Partial<Pick<WorkflowDef, "params" | "returns" | "body">> & { apply?: Apply; envelope?: Envelope06 };

/** A definition of 0.6. */
export type Def06 = (Exclude<Def, WorkflowDef> & Documented) | WorkflowDef06 | PatternDef | ConnectorDef;

/** A program of any version the bridge reads, with the definitions of 0.6. */
export interface Program06 {
  language: LanguageVersion;
  module: string;
  version: string;
  uses?: Use[];
  defs: Record<string, Def06>;
  tests?: Record<string, TestDef>;
}

/** Whether a value is a program (IR) of language 0.6. */
export function isProgram06(p: unknown): boolean {
  return typeof p === "object" && p !== null && (p as { language?: unknown }).language === LANGUAGE_06;
}

// ── the lock of 0.6 (spec/lock-0.6.schema.json) ─────────────────────────

/** A library as the lock pins it: the version resolved, its digest, and each of its modules with its program hash. */
export interface LibraryPin {
  version: string;
  digest: string;
  modules: Record<string, string>;
}

/** A connector's binding (`connectors.<module>.<connector>`): the credential, the URL, and each tool's schema digest. */
export interface ConnectorBinding {
  credential: string;
  url: string;
  header?: string;
  template?: string;
  tools: Record<string, string>;
}

/** A lock of any format the bridge reads: a lock of 0.6 adds `libraries` and `connectors`. */
export type Lock = ReferenceLock & {
  libraries?: Record<string, LibraryPin>;
  connectors?: Record<string, ConnectorBinding>;
};

// ── the check door and the library doors ────────────────────────────────

/** A library as the doors take it: the text of its `mandate.library.json`, and each module file it lists, by that path. */
export interface LibrarySource {
  manifest: string;
  files: Record<string, string>;
}

/** The `libraries` member of the runtime's configuration (spec/library.md "The local directory"). */
export interface LibrariesConfig {
  dir: string;
  wait_days?: number;
  revoked?: string[];
}

/**
 * What the `check` door takes besides what the reference's `check` does, in a program of 0.6: the libraries the
 * lock pins (`std.patterns` is the compiler's own and is not handed in), and the configuration's `libraries`, whose
 * revoked digests a pin is held to (E1608). The reference compiler reads neither.
 */
export interface CheckOptions06 extends Omit<CheckOptions, "lock"> {
  lock?: Lock;
  libraries?: LibrarySource[];
  config?: LibrariesConfig;
  /** Asks for the running program (`linked`) of a program of 0.6 that checks. A program of 0.1 to 0.5 is given none. */
  linked?: boolean;
}

/**
 * What the `check` door gives besides: the expanded program, for a program of 0.6 that applies a pattern and checks;
 * and, only when `linked` was asked for and the program is of 0.6 and checks, the running program: the program a run
 * of it runs (its expansion, when it applies a pattern), with the linked definitions as its `defs`: its own, and
 * every definition it sees of the given modules and of its libraries' modules, each linked through what its library
 * reaches, the built-in `std.patterns` among them. They are the very definitions the checks read. It is never
 * linked again, and is named by its own hash (`hashProgram` of it), never by the program's.
 */
export interface CheckResult06 extends CheckResult {
  expanded?: Program06;
  linked?: Program06;
}

/** `check` as the bridge exports it: the reference's, which a call of 0.6 reaches only in the Rust (compare.ts). */
export type Check06 = (text: string, kind: SourceKind, opts?: CheckOptions06) => CheckResult06;

/**
 * What `check_subprogram` gives besides, for a sub-program of 0.6 that applies a pattern and is admitted: `running`,
 * the sub-program as a run runs it (expanded, with its own definitions and all its parent sees as its `defs`, linked
 * through what the parent's libraries reach), and `running_hash`, the hash of that. `program` and `hash` stay the
 * sub-program as the lead wrote it. A sub-program that applies none is given neither.
 */
export type SubprogramCheck06 = SubprogramCheck & { running?: Program06; running_hash?: string };

/** `checkSubprogram` as the bridge exports it: the reference's, which a parent of 0.6 reaches only in the Rust. */
export type CheckSubprogram06 = (i: SubprogramInput) => SubprogramCheck06;

/** What `library_verify` gives: whether the library reads and checks, and its name, version, digest and pin. */
export interface LibraryVerified {
  ok: boolean;
  diagnostics: Diagnostic[];
  name?: string;
  version?: string;
  digest?: string;
  pin?: LibraryPin;
  signature?: Record<string, unknown>;
}

/** A call of a door only the Rust compiler has, in `ts` mode: the reference compiler, frozen at 0.5, has no answer. */
export class NoReference extends Error {
  override readonly name = "NoReference";

  constructor(
    /** The function of the bridge, such as `libraryVerify`. */
    readonly fn: string,
  ) {
    super(`${fn} reads language 0.6, which only the Rust compiler reads: the TypeScript reference compiler (MANDATE_COMPILER=ts) is frozen at 0.5 and has no answer for it`);
  }
}

/** The output of a Rust-only door: never asked of the TypeScript, which has no such function. */
function rustOnly(fn: string, door: string, input: Record<string, unknown>): unknown {
  if (compilerMode() === "ts") throw new NoReference(fn);
  if (compilerMode() === "both") countLanguage06();
  try {
    return rustCall(door, input);
  } catch (e) {
    if (e instanceof DoorRefusal) throw new Error(e.detail);
    throw e;
  }
}

/**
 * `library_verify`: a library read and checked (E1601, E1606), with the libraries it requires beside it, and its
 * digest (spec/library.md "The digest"). A library that does not read has `ok: false` and no digest.
 */
export function libraryVerify(library: LibrarySource, libraries?: LibrarySource[]): LibraryVerified {
  return rustOnly("libraryVerify", "library_verify", { library, ...(libraries ? { libraries } : {}) }) as LibraryVerified;
}
