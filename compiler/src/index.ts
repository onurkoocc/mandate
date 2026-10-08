// Public API of the Mandate 0.1 reference compiler.
export { check, load, kindOf, type CheckResult, type LoadResult, type SourceKind } from "./check.js";
export { CODES } from "./codes.js";
export { diag, formatDiagnostic, hasErrors, type Diagnostic, type Repair, type Span } from "./diag.js";
export { domainHash, hashProgram, type HashDomain, type ProgramHashes } from "./hash.js";
export * from "./ir/types.js";
export { irSchema, validateIr } from "./ir/validate.js";
export { canonicalize } from "./json/jcs.js";
export { parseStrictJson, type Json } from "./json/strict-json.js";
export { LIMITS } from "./limits.js";
export { parseMdt, RESERVED } from "./parse/parser.js";
export { applyPatch, type GovernanceChange, type PatchOp, type PatchResult } from "./patch/patch.js";
export { printProgram } from "./print/printer.js";
export { resolveNames } from "./resolve/resolve.js";
export { calleePath, capFromCall, type CapVal } from "./check/caps.js";
export { DECISION_POLICIES, STD_EFFECTS, STD_FNS } from "./std/std.js";
