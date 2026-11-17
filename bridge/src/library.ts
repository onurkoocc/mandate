// Languages 0.6 (spec/library.md) and 0.7 (spec/attention.md) in the bridge: the names, the types and the doors of
// what only the Rust compiler reads. The reference compiler is frozen at 0.5, so its types and constants know nothing
// of 0.6 or 0.7; the bridge keeps them as they are (index.ts takes them as they are, `export *`) and adds here what
// 0.6 and 0.7 have besides:
//
// - the language and lock versions of 0.6 and 0.7, and `atLeast` over every version the bridge reads, both included
//   (the reference compiler's `atLeast` knows nothing after 0.5, and so would read a 0.6 program as older than any);
//   and `isProgram06OrLater`, what a gate of 0.6 asks, which every later language passes too;
// - the shapes 0.6 adds to the IR (spec/ir-0.6.schema.json) and to the lock (spec/lock-0.6.schema.json): `pub`
//   and `doc` on a definition, a pattern and its application, a connector and its tools, a criterion's `waive`,
//   an envelope's `shapes`; the lock's `libraries` and `connectors`;
// - what the `check` door takes and gives besides what the reference's `check` does: the libraries the lock pins,
//   the configuration's `libraries` member, and the expanded program; and, when it is asked (`linked`), the running
//   program, expanded and linked through what each library reaches, which a run runs and stores;
// - what the `check_subprogram` door gives besides: the running program of a sub-program that applies a pattern;
// - the Rust-only doors the runtime and the command line call (doors.ts, RUST_ONLY): `library_verify`, the doors of
//   `mandate add`, `upgrade` and `publish` (`library_add`, `library_upgrade`, `library_publish`), the authority
//   signature, and the reading of the configuration's `libraries` member; and, of 0.7, `callable_connectors` (which
//   connectors a program can call), `tool_schema_digest` (a tool's schema digest) and `attention_facts` (the
//   attention facts of a workflow, which a run of 0.7 stores at its start), which the runtime asks;
// - the shapes 0.7 adds to the IR (spec/ir-0.7.schema.json) and to the lock (spec/lock-0.7.schema.json), as types
//   alone: the `stage` and `report` statements, `asks` in a budget, `owner` on a workflow; the lock's `role_classes`
//   and `promotion`. The compiler gives none of them yet (its slices add them one by one), and the runtime refuses a
//   package that holds one by name (runtime/src/package.ts, NOT_RUN_YET_07) until it runs it.
//
// A program of 0.6 or 0.7 given to the reference compiler is refused by it on its own (E0103); the bridge never gives it one.

import { LANGUAGE_VERSIONS, type Budget, type CheckOptions, type DataClass, type CheckResult, type Criterion, type Def, type Diagnostic, type Envelope, type Expr, type LanguageVersion as ReferenceLanguage, type Lock as ReferenceLock, type Param, type SourceKind, type Stmt, type SubprogramCheck, type SubprogramInput, type TestDef, type TypeExpr, type Use, type WorkflowDef } from "@mandate/compiler";
import { rustCall } from "./wasm/call.js";
import { DoorRefusal } from "./wasm/errors.js";

/** The language version of 0.6, which only the Rust compiler reads. */
export const LANGUAGE_06 = "mandate/0.6";
/** The lock format of 0.6, with `libraries` and `connectors`. */
export const LOCK_FORMAT_06 = "mandate/lock/0.6";
/** The language version of 0.7 (spec/attention.md "Version gating"), which only the Rust compiler reads. */
export const LANGUAGE_07 = "mandate/0.7";
/** The lock format of 0.7 (spec/attention.md "Lock 0.7"), with `role_classes` and `promotion`. */
export const LOCK_FORMAT_07 = "mandate/lock/0.7";
/** The format of a library's manifest, `mandate.library.json`. */
export const LIBRARY_FORMAT = "mandate/library/0.6";
/**
 * Every language version the bridge reads, oldest first: the reference compiler's, then those only the Rust reads.
 * test/facade.test.ts holds it to the Rust's own list (the `tables` door's LANGUAGE_VERSIONS).
 */
export const BRIDGE_LANGUAGE_VERSIONS = [...LANGUAGE_VERSIONS, LANGUAGE_06, LANGUAGE_07] as const;

/** A language version the bridge reads: one of the reference compiler's, 0.6 or 0.7. */
export type LanguageVersion = ReferenceLanguage | typeof LANGUAGE_06 | typeof LANGUAGE_07;

/**
 * Whether `v` is `since` or a later version, over every version the bridge reads (BRIDGE_LANGUAGE_VERSIONS): the
 * reference compiler's `atLeast`, for 0.1 to 0.5 the same answer, and for 0.6 and 0.7 the one that compiler cannot
 * give. A value that is no version is at least none.
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

/**
 * Whether a value is a program (IR) of language 0.6 or of a later one the bridge reads: what a gate of 0.6 asks, since
 * every rule of 0.6 holds in each later language (spec/attention.md "Version gating"). A language the bridge does not
 * read is of none.
 */
export function isProgram06OrLater(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const language = (p as { language?: unknown }).language;
  return typeof language === "string" && atLeast(language as LanguageVersion, LANGUAGE_06);
}

/** Whether a value is a program (IR) of language 0.7 or of a later one the bridge reads. */
export function isProgram07OrLater(p: unknown): boolean {
  if (typeof p !== "object" || p === null) return false;
  const language = (p as { language?: unknown }).language;
  return typeof language === "string" && atLeast(language as LanguageVersion, LANGUAGE_07);
}

// ── the IR of 0.7 (spec/attention.md "The IR"; spec/ir-0.7.schema.json) ─
//
// Types alone: the compiler gives none of these yet. Slices RL2 (`stage`, `report`), RL3 (`asks`) and RL4 (`owner`)
// add them to the compiler, and these mirror the spec's table, not the compiler's output.

/** `stage <name> "<title>"` (spec/attention.md "`stage`"; "The IR", `Stmt` `stage`): a marker with no body. */
export interface StageStmt {
  op: "stage";
  /** A name, unique within its body. */
  name: string;
  /** A constant string of 1 to 80 Unicode scalar values (spec/attention.md "Titles"). */
  title: string;
}

/** One field of a report (spec/attention.md "The IR", `ReportField`): a name and a pure expression of a displayable type. */
export interface ReportField {
  name: string;
  value: Expr;
}

/** `report to <role> "<title>" { … }` (spec/attention.md "`report`"; "The IR", `Stmt` `report`). */
export interface ReportStmt {
  op: "report";
  /** A role definition, or in a pattern one of its role slots. */
  role: string;
  /** A constant string of 1 to 80 Unicode scalar values (spec/attention.md "Titles"). */
  title: string;
  /** 1 to 16 fields, in the order the author wrote them: an array, since the canonical form sorts an object's members. */
  fields: ReportField[];
}

/** A statement of 0.7: one of the reference's, a `stage` or a `report`. */
export type Stmt07 = Stmt | StageStmt | ReportStmt;

/**
 * A budget of 0.7 (spec/attention.md "`asks`"; "The IR", `Budget.asks`): `asks`, an integer of at least 0, the most
 * questions a run may put to people, in a workflow's budget or an envelope's alone (E1908). It is no dimension of the
 * cost algebra (BUDGET_DIMENSIONS).
 */
export type Budget07 = Budget & { asks?: number };

/**
 * A workflow of 0.7 (spec/attention.md "`owner`"; "The IR", `Def(workflow).owner`): `owner`, the role that approves
 * its card and signs its promotions, on a workflow without an envelope (E1910); an envelope's `owner` is 0.4's.
 */
export type WorkflowDef07 = Omit<WorkflowDef06, "budget" | "envelope"> & { owner?: string; budget?: Budget07; envelope?: Envelope07 };

/** An envelope of 0.7: its budget may hold `asks` (spec/attention.md "`asks`"). Its `owner` is 0.4's, as before. */
export type Envelope07 = Omit<Envelope06, "budget"> & { budget?: Budget07 };

// ── the lock of 0.7 (spec/attention.md "Lock 0.7"; spec/lock-0.7.schema.json) ─
//
// Types alone, as the IR's: slice RL5 adds both members to the compiler.

/** The one value of a lock's `promotion`: a run of `read_only` or `live` needs a signed promotion. */
export type Promotion = "required";

/** What a lock of format 0.7 adds to one of 0.6; in a lock of an older format each is E0140. */
export interface Lock07 {
  /** Each role's highest data class it may be shown; a role it does not name may be shown `internal`. Every role it names is one `roles` names (E0140). */
  role_classes?: Record<string, DataClass>;
  /** The promotion ladder: every workflow then has an `owner` or an envelope (E1910). */
  promotion?: Promotion;
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

/** A lock of any format the bridge reads: a lock of 0.6 adds `libraries` and `connectors`, one of 0.7 what Lock07 has. */
export type Lock = ReferenceLock & {
  libraries?: Record<string, LibraryPin>;
  connectors?: Record<string, ConnectorBinding>;
} & Lock07;

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
export type SubprogramCheck06 = SubprogramCheck & { running?: Program06; running_hash?: string; shape?: Shape06 };

/**
 * The shape a lead's sub-program applies (spec/library.md "`shapes`"): the pattern's name and the module that defines
 * it. `check_subprogram` gives it, beside `running` and `running_hash`, for an admitted sub-program whose parent's
 * envelope has `shapes`; the result for a parent without `shapes` has no such member.
 */
export interface Shape06 {
  pattern: string;
  module: string;
}

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

/** The output of a Rust-only door: the reference compiler has no such function. */
function rustOnly(door: string, input: Record<string, unknown>): unknown {
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
  return rustOnly("library_verify", { library, ...(libraries ? { libraries } : {}) }) as LibraryVerified;
}

// ── the doors of `mandate add`, `upgrade` and `publish` ─────────────────

/** One version directory of a library, as a caller read it: the directory's name, its library, and the text of its `index.json` (null when it has none). */
export interface PublishedVersion {
  version: string;
  library: LibrarySource;
  index: string | null;
}

/** A change an upgrade or a publication finds: its kind (`widened`, `requires_changed`, a governance kind, or `behavior`), where, and the change for a person. */
export interface LibraryChange {
  kind: string;
  at: string;
  text: string;
}

/** What `library_add` and `library_upgrade` take: what the caller read of the lock, the directory, the configuration and the clock. */
export interface LibraryRequest {
  library: string;
  /** `^1.0`, an exact version, or none for any version. */
  range?: string;
  /** The lock as read; one that is not there yet is `{ lock: "mandate/lock/0.6", modules: {} }`. */
  lock: Lock;
  /** Every version directory of the library that the operator's directory holds. */
  versions: PublishedVersion[];
  /** The other libraries the lock pins, each at its pinned version. */
  libraries?: LibrarySource[];
  /** The `libraries` member of the configuration: its waiting period and its revoked digests are held here. */
  config?: LibrariesConfig;
  /** The time, `YYYY-MM-DDTHH:MM:SSZ`. */
  now: string;
  /**
   * 0.7: the language of the program the lock is for (`mandate add --program`), as `mandate/0.7`: which embedded
   * versions of `std.patterns` may be pinned, and for 0.7 a lock of format 0.7. None is a program of 0.6.
   */
  language?: string;
}

/**
 * What `library_add` and `library_upgrade` give. `lock` is the lock with the new pin, or null when it is not to be
 * written: a diagnostic is an error, or (an upgrade) the comparison holds a governance change that was not accepted.
 */
export interface LibraryResolved {
  ok: boolean;
  diagnostics: Diagnostic[];
  resolution: Record<string, unknown>;
  version?: string;
  digest?: string;
  signature?: Record<string, unknown>;
  governance?: LibraryChange[];
  behavior?: LibraryChange[];
  widenings?: unknown[];
  before?: Record<string, unknown>;
  lock: Lock | null;
}

/** One version a publication was compared with. */
export interface PublishedAgainst {
  version: string;
  requires_major: boolean;
  widenings: unknown[];
  governance: LibraryChange[];
}

/** What `library_publish` gives: when `ok`, the files to copy into `<dir>/<name>/<version>/` by path, and the text of its `index.json`. */
export interface LibraryPublished {
  ok: boolean;
  diagnostics: Diagnostic[];
  name?: string;
  version?: string;
  digest?: string;
  against: PublishedAgainst[];
  files?: Record<string, string>;
  index?: string | null;
}

/**
 * `library_add`, `mandate add <library>[@<range>]`: the highest version within the range that is published, is not
 * within its waiting period and is not revoked (E1606, E1608), read and checked, with its authority signature and the
 * lock that pins it.
 */
export function libraryAdd(request: LibraryRequest): LibraryResolved {
  return rustOnly("library_add", { ...request }) as LibraryResolved;
}

/**
 * `library_upgrade`, `mandate upgrade <library>[@<range>] [--accept-governance]`: as `libraryAdd`, compared with
 * `pinned`, the library of the version the lock pins. A comparison that holds a governance change gives no lock
 * unless `accept_governance` is true.
 */
export function libraryUpgrade(request: LibraryRequest & { pinned: LibrarySource; accept_governance?: boolean }): LibraryResolved {
  return rustOnly("library_upgrade", { ...request }) as LibraryResolved;
}

/**
 * `library_publish`, `mandate publish <source dir>`: the library to publish, held to every version of it the
 * directory holds (`published`) and to the libraries it requires. A version that widens the authority signature of
 * the one below it, removes one of its criteria or adds a waiver, and is not a major version, is refused (E1607).
 */
export function libraryPublish(request: { source: LibrarySource; published: PublishedVersion[]; libraries?: LibrarySource[]; now: string }): LibraryPublished {
  return rustOnly("library_publish", { ...request }) as LibraryPublished;
}

/** `authority_signature`: the authority signature of a library's `pub` definitions, or null when the library does not read. */
export function authoritySignature(library: LibrarySource, libraries?: LibrarySource[]): Record<string, unknown> | null {
  return rustOnly("authority_signature", { library, ...(libraries ? { libraries } : {}) }) as Record<string, unknown> | null;
}

/** A connector a program can call: `id` is `<module>.<connector>`, the key of its entry in the lock's `connectors`; `name` is its name in the program. */
export interface CallableConnector {
  id: string;
  name: string;
}

/**
 * `callable_connectors` (language 0.7, spec/attention.md "Carry-over from 0.6"): the connectors a program can call,
 * those the check demands a lock entry for (E1407), by the same function. Give it the program as the package has it
 * (the one the check reads) with the modules it imports, never the running program: that holds every definition it
 * imports, which E1407 does not count. A refusal of the door is thrown as an `Error`.
 */
export function callableConnectors(program: unknown, modules?: Record<string, unknown>): CallableConnector[] {
  return rustOnly("callable_connectors", { program, ...(modules ? { modules } : {}) }) as CallableConnector[];
}

/**
 * `tool_schema_digest` (language 0.7, spec/attention.md "Carry-over from 0.6"): the lock's `sha256:<hex>` of the
 * canonical JSON of `{ name, inputSchema, outputSchema }` of an MCP tool, as the runtime's `schemaDigest` gives it.
 * `tool` is the tool as JSON text (`JSON.stringify` of the tool object held), so that a number keeps the form it has
 * in JSON. Text that is not a tool, or that nests deeper than 512 levels, is refused: thrown as an `Error`.
 */
export function toolSchemaDigest(tool: string): string {
  return rustOnly("tool_schema_digest", { tool }) as string;
}

// ── the attention facts (spec/attention.md "The facts") ──────────────────

/** How a value is known (spec/attention.md "Masking and how a value is known"): the level of its type, the weakest wrapper deciding. */
export type Known = "verified" | "plain" | "model" | "external";

/** A stage of a workflow, by the path of its statement in the running program; `index` its place among its body's stages, from 0. */
export interface AttentionStage {
  path: string;
  name: string;
  title: string;
  index: number;
}

/** A field of a report: its name, its type as the compiler shows it, the data class of its value and how it is known. */
export interface AttentionField {
  name: string;
  type: string;
  class: DataClass;
  known: Known;
}

/** A report of a workflow, by the path of its statement in the running program. */
export interface AttentionReport {
  path: string;
  /** The role it is addressed to: in an expansion, the one the application binds. */
  role: string;
  title: string;
  /** The stage of the top-level statement it stands in, or null. */
  stage: string | null;
  /** How many times one run can show it. */
  multiplicity: number | "unbounded";
  /** In the order written. */
  fields: AttentionField[];
}

/**
 * The attention facts of one workflow, `mandate/attention/0.1`. A later slice of the compiler adds members beside
 * these (the question sites, the effect sites, the totals) under the same format; a reader keeps what it is given whole
 * and reads only the members it knows.
 */
export interface AttentionFacts {
  format: "mandate/attention/0.1";
  workflow: string;
  /** The program's hash, as its check gives it. */
  program: string;
  stages: AttentionStage[];
  reports: AttentionReport[];
  [member: string]: unknown;
}

/** What `attention_facts` takes: the input of the door `check` (`text`, `kind`, `opts`), and the workflow's name. */
export interface AttentionFactsInput {
  text: string;
  kind: SourceKind;
  opts?: CheckOptions06 & { claim?: Record<string, unknown> };
  workflow: string;
}

/**
 * `attention_facts` (language 0.7, spec/attention.md "The facts"): the attention facts of a workflow, from the typing
 * of the check that checks the program (given as the door `check` is given it), by the path of each statement in the
 * running program. Null when the program does not check, is older than 0.7, or defines no such workflow. A refusal of
 * the door is thrown as an `Error`.
 */
export function attentionFacts(input: AttentionFactsInput): AttentionFacts | null {
  return rustOnly("attention_facts", { ...input }) as AttentionFacts | null;
}

/** What a door says of a `config` it does not read, before the identifiers of its problems. */
const CONFIG_REFUSED = "`config` is not the libraries member of a configuration: ";

/**
 * Whether the compiler reads `member` as the `libraries` member of a configuration, `{ dir, wait_days?, revoked? }`
 * (a member it does not know is refused, not read as nothing): the identifiers of its problems, none when it reads.
 * The compiler's own reader decides: the member is given to the door `library_add`, which reads it before it
 * resolves anything, in a request that resolves nothing.
 */
export function librariesConfigProblems(member: unknown): string[] {
  // The door reads a `config` of null as none given, where the member null is not an object; and a request holds
  // whole numbers only, where a number that is not one is of the wrong type wherever the member has it.
  if (member === null) return ["wrong_type"];
  const whole = (v: unknown): unknown =>
    typeof v === "number" ? (Number.isSafeInteger(v) ? v : false) : Array.isArray(v) ? v.map(whole) : typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, whole(x)])) : v;
  try {
    rustCall("library_add", { library: "none", lock: {}, versions: [], config: whole(member), now: "2000-01-01T00:00:00Z" });
    return [];
  } catch (e) {
    if (e instanceof DoorRefusal && e.detail.startsWith(CONFIG_REFUSED)) return e.detail.slice(CONFIG_REFUSED.length).split(", ");
    if (e instanceof DoorRefusal) throw new Error(e.detail);
    throw e;
  }
}
