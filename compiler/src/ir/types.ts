// Canonical IR for Mandate 0.1 (Doc 4 §3.2).
//
// The IR is the source of truth in 0.1 (§3.3, v0.2 decision): the `.mdt` text
// form is a projection that lowers into these shapes and is printed back from
// them. The JSON Schema in spec/ir.schema.json is the closed, published form of
// the same types; keep the two in step.
//
// Canonical-form rules the producer applies so that two programs that mean the
// same thing hash the same (§3.1):
//   - order-insensitive collections are objects keyed by name (defs, record
//     fields, contract criteria, par branches) or sorted arrays (uses, caps,
//     effects), so JCS fixes their order;
//   - order-sensitive collections stay arrays (params, enum members, union
//     variants, statements, call arguments);
//   - numbers are integers; decimals are strings; money is integer
//     micro-units plus an ISO 4217 code; durations are milliseconds;
//   - optional fields are omitted rather than written as null or false.

/** The newest language version; what new programs are written in. */
export const LANGUAGE_VERSION = "mandate/0.3";
/**
 * Every language version this compiler reads. 0.2 adds the agent loop
 * strategy and its progress thresholds (`loop`, `progress`). 0.3 adds the
 * system model (`component`, `interface`, `environment`) and change sets
 * (design doc 9). An older program reads and hashes exactly as before.
 */
export const LANGUAGE_VERSIONS = ["mandate/0.1", "mandate/0.2", "mandate/0.3"] as const;
export type LanguageVersion = (typeof LANGUAGE_VERSIONS)[number];

export function isLanguageVersion(v: unknown): v is LanguageVersion {
  return (LANGUAGE_VERSIONS as readonly unknown[]).includes(v);
}

export interface Program {
  language: LanguageVersion;
  module: string;
  version: string;
  uses?: Use[];
  defs: Record<string, Def>;
  tests?: Record<string, TestDef>;
}

export interface Use {
  module: string;
  /** Imported member names; absent means the module itself is imported. */
  names?: string[];
}

export type Def =
  | TypeDef
  | CapabilityDef
  | ConstDef
  | FnDef
  | ExternDef
  | EffectDef
  | AgentDef
  | WorkflowDef
  | ContractDef
  | ComponentDef
  | InterfaceDef
  | EnvironmentDef;

/** Definition kinds of the system model (0.3; design doc 9 §2). */
export const SYSTEM_KINDS = ["component", "interface", "environment"] as const;

/** One process a component runs to build or test itself: a command and its fixed arguments. */
export interface Command {
  command: string;
  args: string[];
}

/**
 * A deployable unit of an existing system (doc 9 §2.1): its repository, where
 * its working copy sits in a sandbox, who owns it, how it builds and tests,
 * and the interfaces it provides and consumes.
 */
export interface ComponentDef {
  kind: "component";
  /** The git repository, `owner/name`. */
  repo: string;
  /** Absolute path of the component's working copy wherever it is checked out for a run. */
  root: string;
  /** Its main language, e.g. `ts`, `java`, `py`. */
  lang: string;
  /** The role that owns it; its owner approves its member of a change set. */
  owner: string;
  build?: Command[];
  test?: Command[];
  /** Interface names, sorted. */
  provides?: string[];
  /** Interface names, sorted. */
  consumes?: string[];
}

export const INTERFACE_PROTOCOLS = ["openapi", "mcp_tools", "oauth", "event", "db_schema"] as const;
export type InterfaceProtocol = (typeof INTERFACE_PROTOCOLS)[number];

/**
 * A contract between components (doc 9 §2.1). Its provider is the one
 * component that provides it; its consumers are the components that consume
 * it. `spec` is a path in the provider's repository, read at the run's base
 * commit.
 */
export interface InterfaceDef {
  kind: "interface";
  protocol: InterfaceProtocol;
  spec: string;
}

/** Who must authorize an effect kind in an environment, at least (doc 9 §5.3). */
export type Tier = { by: "policy" } | { by: "human"; role: string };

/**
 * A declared, parameterized read from an environment (doc 9 §5.1, K43). The
 * query text is part of the program; values reach it only as parameters.
 */
export interface ReadSource {
  /** The component whose data it reads. */
  from: string;
  query: { sql: string } | { logs: Expr };
  params: Param[];
  /** The type of one row. */
  returns: TypeExpr;
  max_rows: number;
}

/** An environment such as `staging` or `prod` (doc 9 §2.1, §5). */
export interface EnvironmentDef {
  kind: "environment";
  /** The highest data class the environment holds. */
  class: "public" | "internal" | "confidential" | "restricted";
  reads?: Record<string, ReadSource>;
  /** Effect name → the weakest authorization it accepts in this environment. */
  authorize?: Record<string, Tier>;
}

export interface TypeDef {
  kind: "type";
  generics?: string[];
  type: TypeExpr;
  /** Data class of values of this type (§5.5); `public` when absent. */
  class?: "public" | "internal" | "confidential" | "restricted";
}

export interface CapabilityDef {
  kind: "capability";
  value: Expr;
}

export interface ConstDef {
  kind: "const";
  type?: TypeExpr;
  value: Expr;
}

export interface Param {
  name: string;
  type: TypeExpr;
}

export interface FnDef {
  kind: "fn";
  pub?: true;
  params: Param[];
  returns: TypeExpr;
  effects?: EffectRef[];
  budget?: Budget;
  body: Stmt[];
}

export interface ExternDef {
  kind: "extern";
  lang: "py" | "ts" | "java";
  file: string;
  symbol: string;
  params: Param[];
  returns: TypeExpr;
  effects: EffectRef[];
  idempotent_by?: Expr;
}

export type RetryClass = "read_only" | "idempotent" | "reconcilable" | "non_retryable";

export interface EffectDef {
  kind: "effect";
  params: Param[];
  returns: TypeExpr;
  requires_caps?: Expr[];
  critical?: true;
  irreversible?: true;
  idempotency_required?: true;
  retry_class?: RetryClass;
  compensation?: string;
}

export interface Skill {
  params: Param[];
  returns: TypeExpr;
  effects: EffectRef[];
  budget?: Budget;
  body?: Stmt[];
}

export interface RemoteBinding {
  bind: Expr;
  version?: string;
  require?: Expr[];
  trust?: "trusted" | "untrusted";
}

export interface AgentDef {
  kind: "agent";
  role?: string;
  model?: string;
  remote?: RemoteBinding;
  caps: Expr[];
  budget?: Budget;
  /** 0.2: how a skill without a body runs (§8.2); `react` when absent. */
  loop?: LoopStrategy;
  /** 0.2: when an agent loop counts as stuck (§8.2); defaults in PROGRESS_DEFAULTS. */
  progress?: Progress;
  skills: Record<string, Skill>;
}

export type LoopStrategy = "react" | "plan_execute";

/**
 * Progress thresholds of an agent loop (§8.2, BACKLOG K9). The loop stops with
 * `SkillFailed(Stuck)` when the same tool call with the same arguments comes
 * `repeats` times within the last `window` steps, or after `stall` steps in
 * a row that observed nothing new.
 */
export interface Progress {
  window?: number;
  repeats?: number;
  stall?: number;
}

export const PROGRESS_DEFAULTS: Required<Progress> = { window: 8, repeats: 3, stall: 5 };

export interface OnHandler {
  event: string;
  then: Expr;
}

export interface WorkflowDef {
  kind: "workflow";
  params: Param[];
  returns: TypeExpr;
  caps: Expr[];
  budget?: Budget;
  ensures?: Expr;
  body: Stmt[];
  on?: OnHandler[];
}

export type Verifier = { static: Expr } | { call: Expr } | { all: Verifier[] };

export interface Criterion {
  description: string;
  by: Verifier;
}

export interface ContractDef {
  kind: "contract";
  params: Param[];
  require?: Expr[];
  accept: Record<string, Criterion>;
  invariant?: Record<string, Criterion>;
}

export interface TestDef {
  handlers?: Record<string, Expr>;
  body: Stmt[];
}

export interface Money {
  micros: number;
  currency: string;
}

export interface Budget {
  tokens?: number;
  spend?: Money;
  time?: { ms: number };
  steps?: number;
}

export interface EffectRef {
  effect: string;
  args?: Arg[];
}

export type TypeExpr =
  | { ref: string; args?: TypeExpr[] }
  | { record: Record<string, TypeExpr> }
  | { enum: string[] }
  | { union: Variant[] }
  | { refine: TypeExpr; where: Expr };

export interface Variant {
  tag: string;
  fields?: Param[];
}

export interface Arg {
  name?: string;
  value: Expr;
}

export interface CallSpec {
  name: string;
  args?: Arg[];
}

export type TemplatePart = { text: string } | { expr: Expr };

export type Pattern =
  | { p: "wild" }
  | { p: "bind"; name: string }
  | { p: "tag"; tag: string; args?: Pattern[] };

export type Expr =
  | { op: "int"; value: number }
  | { op: "dec"; value: string }
  | { op: "text"; value: string }
  | { op: "bool"; value: boolean }
  | { op: "money"; micros: number; currency: string }
  | { op: "duration"; ms: number }
  | { op: "list"; items: Expr[] }
  | { op: "set"; items: Expr[] }
  | { op: "template"; parts: TemplatePart[] }
  | { op: "prompt"; parts: TemplatePart[] }
  | { op: "var"; name: string }
  | { op: "field"; of: Expr; name: string }
  | { op: "call"; callee: Expr; args: Arg[] }
  | { op: "unary"; uop: "not" | "neg"; of: Expr }
  | { op: "binary"; bop: BinaryOp; left: Expr; right: Expr }
  | { op: "range"; from: Expr; to: Expr }
  | { op: "record"; type: string; fields: Record<string, Expr> }
  | { op: "infer"; type: TypeExpr; from: Expr; using?: Expr }
  | {
      op: "delegate";
      agent: string;
      skill: string;
      args: Arg[];
      caps?: Expr[];
      budget?: Budget;
      isolated?: true;
      timeout?: Expr;
      supervise?: CallSpec;
    }
  | { op: "spawn"; agent: string; skill: string; args: Arg[] }
  | { op: "await"; of: Expr }
  | { op: "verify"; value: Expr; contract: string; args: Arg[]; on_unmet?: { bind: string; then: Expr } }
  | { op: "effect"; name: string; args: Arg[]; idempotent_by?: Expr; compensate?: string }
  | { op: "escalate"; to: Expr }
  | { op: "pause"; then?: Expr }
  | { op: "switch"; on: Expr; cases: Array<{ pattern: Pattern; then: Expr }> }
  | { op: "try"; of: Expr }
  | { op: "block"; body: Stmt[] };

export type BinaryOp = "and" | "or" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "subseteq" | "+" | "-" | "*" | "/";

export type Stmt =
  | { op: "let"; name: string; type?: TypeExpr; value: Expr }
  | { op: "par"; supervise?: CallSpec; branches: Record<string, Expr> }
  | { op: "if"; cond: Expr; then: Stmt[]; else?: Stmt[] }
  | { op: "loop"; max_iter?: number; until?: Expr; body: Stmt[] }
  | { op: "return"; value?: Expr }
  | { op: "on_error"; pattern: Pattern; then: Expr }
  | { op: "run"; target: Expr; expect: string }
  | { op: "expr"; value: Expr };
