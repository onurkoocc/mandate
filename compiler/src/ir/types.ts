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

export const LANGUAGE_VERSION = "mandate/0.1";

export interface Program {
  language: typeof LANGUAGE_VERSION;
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
  | ContractDef;

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
  skills: Record<string, Skill>;
}

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
