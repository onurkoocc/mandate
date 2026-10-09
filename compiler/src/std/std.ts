// What the 0.1 checker knows about the standard library: capability
// constructors, built-in effects (Doc 4 §6.1), the std effects that need a
// capability, and the signatures of the std functions the examples use.
//
// Anything not listed here is still accepted by name resolution, but its type
// is unknown and contributes no effects, so checks that depend on it pass
// rather than guess.

import type { TypeExpr } from "../ir/types.js";

export type DataClass = "public" | "internal" | "confidential" | "restricted";
export const DATA_CLASSES: DataClass[] = ["public", "internal", "confidential", "restricted"];

export function classRank(c: DataClass): number {
  return DATA_CLASSES.indexOf(c);
}

/** Built-in effects (§6.1). `External` effects are named by their declaration, e.g. `git.open_pr`. */
export const BUILTIN_EFFECTS = new Set([
  "Fs.Read", "Fs.Write", "Net", "Model", "Tool", "Exec", "Human", "Delegate", "Spend", "Time", "Random",
]);

/** Effects that need no capability: waiting on a person, reading the clock, drawing a random number. */
export const UNGATED_EFFECTS = new Set(["Human", "Time", "Random", "Delegate"]);

export interface CapCtor {
  /** The effect the capability authorizes. External effects use the namespace, e.g. `git.*`. */
  effect: string;
  /** True for capabilities that change shared state; these must be disjoint across `par` branches (C5). */
  write: boolean;
  /** How the scope is read from the arguments. */
  scope: "positional" | "hosts" | "commands" | "none";
}

export const CAP_CTORS: Record<string, CapCtor> = {
  "fs.read": { effect: "Fs.Read", write: false, scope: "positional" },
  "fs.write": { effect: "Fs.Write", write: true, scope: "positional" },
  "net.https": { effect: "Net", write: false, scope: "hosts" },
  "model.infer": { effect: "Model", write: false, scope: "none" },
  exec: { effect: "Exec", write: false, scope: "commands" },
  "git.pr": { effect: "git.*", write: true, scope: "positional" },
  "money.spend": { effect: "Spend", write: false, scope: "none" },
  // Effects on an environment (design doc 9 §5.3, §9 L4), scoped by environment name.
  "env.deploy": { effect: "deploy", write: true, scope: "positional" },
  "env.migrate": { effect: "migrate", write: true, scope: "positional" },
};

/** Default highest data class a model capability may receive when it does not say (§5.5). */
export const DEFAULT_MODEL_MAX_CLASS: DataClass = "internal";

const t = (ref: string, ...args: TypeExpr[]): TypeExpr => (args.length ? { ref, args } : { ref });
const UNKNOWN: TypeExpr = { ref: "?" };

export interface StdEffect {
  params: TypeExpr[];
  returns: TypeExpr;
  critical?: true;
  irreversible?: true;
  /** Capability constructor that authorizes it. */
  cap: string;
}

/** Std effects called with `effect name(…)`. Critical ones expand to prepare → authorize → commit. */
export const STD_EFFECTS: Record<string, StdEffect> = {
  "git.open_pr": { params: [t("Verified", UNKNOWN)], returns: UNKNOWN, critical: true, cap: "git.pr" },
  "git.close_pr": { params: [UNKNOWN], returns: UNKNOWN, critical: true, cap: "git.pr" },
  "git.comment": { params: [UNKNOWN, t("Text")], returns: UNKNOWN, critical: true, cap: "git.pr" },
  "git.merge": { params: [t("Verified", UNKNOWN)], returns: UNKNOWN, critical: true, irreversible: true, cap: "git.pr" },
  "money.spend": { params: [t("Money")], returns: t("Receipt", UNKNOWN), critical: true, cap: "money.spend" },
  // A release of a component's verified change into an environment, and a schema migration there (doc 9 §9, L4).
  deploy: { params: [t("Verified", UNKNOWN), UNKNOWN], returns: t("Receipt", UNKNOWN), critical: true, irreversible: true, cap: "env.deploy" },
  migrate: { params: [t("Verified", UNKNOWN), UNKNOWN], returns: t("Receipt", UNKNOWN), critical: true, irreversible: true, cap: "env.migrate" },
};

export interface StdFn {
  params?: TypeExpr[];
  returns: TypeExpr;
  effects: string[];
}

/** Std functions by dotted path. Reads from the outside world are Untrusted (§5.2, §8.11). */
export const STD_FNS: Record<string, StdFn> = {
  "fs.read_text": { returns: t("Untrusted", t("Text")), effects: ["Fs.Read"] },
  "fs.list": { returns: t("Untrusted", t("List", t("Path"))), effects: ["Fs.Read"] },
  "fs.write_text": { returns: t("Bool"), effects: ["Fs.Write"] },
  "net.https.get": { returns: t("Untrusted", t("Bytes")), effects: ["Net"] },
  "human.ask": { returns: t("Untrusted", t("Text")), effects: ["Human"] },
  "human.approve": { returns: t("Approval"), effects: ["Human"] },
  "time.now": { returns: t("Time"), effects: ["Time"] },
};

/** std.decision policy functions (§8.10, D2): Inferred<Decision<T>> → DecisionOutcome<T>. */
export const DECISION_POLICIES = new Set(["threshold", "top_margin", "abstain_if"]);

/** Nominal types only the runtime may produce (§5.2; S08, G03). */
export const PROTECTED_TYPES = new Set(["Evidence", "Authorization", "Receipt", "Verified"]);

/** Choice option names that mean "this question does not apply" (D8). */
export const OUT_OF_SCOPE_OPTIONS = new Set(["Other", "Irrelevant", "OutOfScope", "None"]);

export const MAX_RESTARTS = 5;
export const MAX_CHOICE_OPTIONS = 255;
