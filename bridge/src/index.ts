/**
 * The bridge: the one package that reaches the compiler. The runtime imports the compiler only through here, so
 * the compiler behind these names can change without the runtime changing.
 *
 * Behind each door-backed function (doors.ts) stands the Rust compiler's WebAssembly module (rust.ts): a process
 * without it fails by name (CompilerFailure, `module_missing`, mode.ts) and never answers with another compiler.
 * Every other name is the reference compiler's: its types, its helpers and the functions nothing calls (doors.ts,
 * `KEPT`), and its constants, which are the Rust's too (the `tables` door gives the same values, but for the
 * versions only the Rust reads; test/facade.test.ts holds that) - except CODES, which is the Rust's table of codes,
 * so that `mandate explain` and the MCP server explain every code the Rust gives.
 *
 * Beside it, the `mandate` command line (cli.ts) and the MCP server (mcp.ts), written over this entry point and
 * nothing else of the compiler, so that they follow it to whichever compiler it calls; they are programs, not names
 * exported from here (their one helper is util.ts).
 *
 * And the run-time authority decisions (authority.ts): the runtime asks them what is granted, narrowed, handed to a
 * map's items and in the way of a sub-program, and decides none of it itself.
 */
import * as rust from "./rust.js";
import type * as ts from "./ts.js";
import type { Modules } from "@mandate/compiler";
import type { Check06, CheckSubprogram06, Lock } from "./library.js";

// The names below are exported here and so are not taken from the reference compiler's `export *`.
export * from "@mandate/compiler";
export type { AuthorityContext, GrantDelegation, GrantInput, GrantOutput, InFlightOverlapInput, InFlightOverlapOutput, ItemScopes, MapScopesInput, MapScopesOutput, NarrowInput, NarrowOutput, Refusal } from "./authority.js";
// Languages 0.6 and 0.7 (library.ts): their versions, `atLeast` over them, their shapes, their locks, and the
// Rust-only doors. The reference compiler's LanguageVersion and Lock, which know nothing of 0.6, are these in the bridge.
export { atLeast, attentionFacts, authoritySignature, BRIDGE_LANGUAGE_VERSIONS, callableConnectors, isProgram06OrLater, isProgram07OrLater, LANGUAGE_06, LANGUAGE_07, librariesConfigProblems, LIBRARY_FORMAT, libraryAdd, libraryPublish, libraryUpgrade, libraryVerify, LOCK_FORMAT_06, LOCK_FORMAT_07, toolSchemaDigest } from "./library.js";
// The file-system side of the libraries (libraries.ts) gives the entry point one name: the libraries a lock pins.
export { pinnedLibraries } from "./libraries.js";
export type { CallableConnector, LibraryChange, LibraryPublished, LibraryRequest, LibraryResolved, PublishedAgainst, PublishedVersion } from "./library.js";
export type { Apply, Check06, CheckOptions06, CheckResult06, CheckSubprogram06, SubprogramCheck06, SubprogramInput07, ConnectorBinding, ConnectorDef, ConnectorTool, Criterion06, Def06, Documented, Envelope06, LanguageVersion, LibrariesConfig, LibraryPin, LibrarySource, LibraryVerified, Lock, PatternDef, Program06, Shape06, Slot, SlotArg, WorkflowDef06 } from "./library.js";
export type { Budget07, Envelope07, Lock07, Promotion, ReportField, ReportStmt, StageStmt, Stmt07, WorkflowDef07 } from "./library.js";
export type { AttentionCount, AttentionEffect, AttentionFacts, AttentionFactsInput, AttentionField, AttentionPlan, AttentionQuestion, AttentionReport, AttentionSiteKind, AttentionStage, AttentionTotals, Known } from "./library.js";

/**
 * A view or a diff of a program that takes the modules besides, last (doors.ts): the Rust's alone, for a program of
 * language 0.6 whose workflow applies a pattern of one of them. The TypeScript function, frozen at 0.5, is not given
 * them; for a program of 0.1 to 0.5 a caller passes none (util.ts, viewModules).
 */
export type WithModules<F> = F extends (...args: infer A) => infer R ? (...args: [...A, modules?: Modules]) => R : never;

/** `WithModules`, and the lock after the modules: the Rust's alone too (the architecture view names a pattern's library version from it). */
export type WithModulesAndLock<F> = F extends (...args: infer A) => infer R ? (...args: [...A, modules?: Modules, lock?: Lock]) => R : never;

export const load = rust.load;
/** `check`: with the libraries and the configuration of a program of 0.6, and its expanded program, the Rust's alone. */
export const check: Check06 = rust.check;
export const loadModules = rust.loadModules;
export const parseStrictJson = rust.parseStrictJson;
export const canonicalize = rust.canonicalize;
export const hashProgram = rust.hashProgram;
export const packageHash = rust.packageHash;
export const domainHash = rust.domainHash;
export const printProgram = rust.printProgram;
export const link = rust.link;
export const linkedProgram = rust.linkedProgram;
export const references = rust.references;
export const rolesNamed = rust.rolesNamed;
export const programRef = rust.programRef;
export const leadClasses = rust.leadClasses;
export const workflowBounds = rust.workflowBounds;
export const capsOf = rust.capsOf;
export const showCap = rust.showCap;
export const governanceFiles = rust.governanceFiles;
export const skeleton = rust.skeleton;
export const subprogramLinked = rust.subprogramLinked;
export const validateLock = rust.validateLock;
export const roleLockChecks = rust.roleLockChecks;
export const sandboxLockChecks = rust.sandboxLockChecks;
export const bindingChecks = rust.bindingChecks;
export const modelTiers = rust.modelTiers;
export const packagedLock = rust.packagedLock;
export const agentModels = rust.agentModels;
export const sandboxRequirements = rust.sandboxRequirements;
export const requirementFor = rust.requirementFor;
export const denialDiagnostics = rust.denialDiagnostics;
export const applyPatch = rust.applyPatch;
export const checkPatch = rust.checkPatch;
/** `checkSubprogram`: with the running program of a sub-program of 0.6 that applies a pattern, the Rust's alone. */
export const checkSubprogram: CheckSubprogram06 = rust.checkSubprogram;
export const checkAmendment = rust.checkAmendment;
export const semanticDiff: WithModules<typeof ts.semanticDiff> = rust.semanticDiff;
export const governanceChanges = rust.governanceChanges;
export const envelopeChanges = rust.envelopeChanges;
export const grant = rust.grant;
export const narrow = rust.narrow;
export const mapScopes = rust.mapScopes;
export const inFlightOverlap = rust.inFlightOverlap;
export const architecture: WithModulesAndLock<typeof ts.architecture> = rust.architecture;
export const architectureBlocks = rust.architectureBlocks;
export const authority: WithModules<typeof ts.authority> = rust.authority;
export const authorityBlocks = rust.authorityBlocks;
export const cost: WithModules<typeof ts.cost> = rust.cost;
export const programDoc: WithModules<typeof ts.programDoc> = rust.programDoc;
export const diffDoc: WithModules<typeof ts.diffDoc> = rust.diffDoc;
export const envelopeWorkflows = rust.envelopeWorkflows;
export const card = rust.card;
export const cardDoc = rust.cardDoc;
export const acsTarget = rust.acsTarget;
export const toMarkdown = rust.toMarkdown;
export const toHtml = rust.toHtml;
export const CODES = rust.rustCodes();
