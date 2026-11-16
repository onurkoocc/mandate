/**
 * The bridge: the one package that reaches the compiler. The runtime imports the compiler only through here, so
 * the compiler behind these names can change without the runtime changing.
 *
 * Behind each door-backed function (doors.ts) stands the compiler that MANDATE_COMPILER names (mode.ts): the Rust
 * compiler's WebAssembly module (`rust`, the default, rust.ts), the reference compiler of TypeScript (`ts`: these
 * names are then its very functions, ts.ts), or both, compared on every call (`both`, compare.ts). Every
 * other name is the reference compiler's in every mode: its types, its helpers and the functions nothing calls
 * (doors.ts, `KEPT`), and its constants, which are the Rust's too (the `tables` door gives the same values, but
 * for the versions only the Rust reads; test/facade.test.ts holds that) — except CODES, which outside `ts` is the
 * Rust's table of codes, so that `mandate explain` and the MCP server explain every code the Rust gives.
 *
 * Beside it, the `mandate` command line (cli.ts) and the MCP server (mcp.ts), written over this entry point and
 * nothing else of the compiler, so that they follow it to whichever compiler it calls; they are programs, not names
 * exported from here (their one helper is util.ts).
 *
 * And the run-time authority decisions (authority.ts): the runtime asks them what is granted, narrowed, handed to a
 * map's items and in the way of a sub-program, and decides none of it itself.
 */
import { CODES as TS_CODES } from "@mandate/compiler";
import { facade, onCompilerMode, rustCodes } from "./mode.js";
import * as ts from "./ts.js";
import type { Modules } from "@mandate/compiler";
import type { Check06, CheckSubprogram06, Lock } from "./library.js";

// The names below are exported here and so are not taken from the reference compiler's `export *`.
export * from "@mandate/compiler";
export type { AuthorityContext, GrantDelegation, GrantInput, GrantOutput, InFlightOverlapInput, InFlightOverlapOutput, ItemScopes, MapScopesInput, MapScopesOutput, NarrowInput, NarrowOutput, Refusal } from "./authority.js";
// Language 0.6 (library.ts): its versions, `atLeast` over them, its shapes, its lock, and the Rust-only doors. The
// reference compiler's LanguageVersion and Lock, which know nothing of 0.6, are these in the bridge.
export { atLeast, authoritySignature, BRIDGE_LANGUAGE_VERSIONS, isProgram06, LANGUAGE_06, librariesConfigProblems, LIBRARY_FORMAT, libraryAdd, libraryPublish, libraryUpgrade, libraryVerify, LOCK_FORMAT_06, NoReference } from "./library.js";
// The file-system side of the libraries (libraries.ts) gives the entry point one name: the libraries a lock pins.
export { pinnedLibraries } from "./libraries.js";
export type { LibraryChange, LibraryPublished, LibraryRequest, LibraryResolved, PublishedAgainst, PublishedVersion } from "./library.js";
export type { Apply, Check06, CheckOptions06, CheckResult06, CheckSubprogram06, SubprogramCheck06, ConnectorBinding, ConnectorDef, ConnectorTool, Criterion06, Def06, Documented, Envelope06, LanguageVersion, LibrariesConfig, LibraryPin, LibrarySource, LibraryVerified, Lock, PatternDef, Program06, Slot, SlotArg, WorkflowDef06 } from "./library.js";

/**
 * A view or a diff of a program that takes the modules besides, last (doors.ts): the Rust's alone, for a program of
 * language 0.6 whose workflow applies a pattern of one of them. The TypeScript function, frozen at 0.5, is not given
 * them; for a program of 0.1 to 0.5 a caller passes none (util.ts, viewModules).
 */
export type WithModules<F> = F extends (...args: infer A) => infer R ? (...args: [...A, modules?: Modules]) => R : never;

/** `WithModules`, and the lock after the modules: the Rust's alone too (the architecture view names a pattern's library version from it). */
export type WithModulesAndLock<F> = F extends (...args: infer A) => infer R ? (...args: [...A, modules?: Modules, lock?: Lock]) => R : never;

export let load = ts.load;
/** `check`: with the libraries and the configuration of a program of 0.6, and its expanded program, the Rust's alone. */
export let check: Check06 = ts.check;
export let loadModules = ts.loadModules;
export let parseStrictJson = ts.parseStrictJson;
export let canonicalize = ts.canonicalize;
export let hashProgram = ts.hashProgram;
export let packageHash = ts.packageHash;
export let domainHash = ts.domainHash;
export let printProgram = ts.printProgram;
export let link = ts.link;
export let linkedProgram = ts.linkedProgram;
export let references = ts.references;
export let rolesNamed = ts.rolesNamed;
export let programRef = ts.programRef;
export let leadClasses = ts.leadClasses;
export let workflowBounds = ts.workflowBounds;
export let capsOf = ts.capsOf;
export let showCap = ts.showCap;
export let governanceFiles = ts.governanceFiles;
export let skeleton = ts.skeleton;
export let subprogramLinked = ts.subprogramLinked;
export let validateLock = ts.validateLock;
export let roleLockChecks = ts.roleLockChecks;
export let sandboxLockChecks = ts.sandboxLockChecks;
export let bindingChecks = ts.bindingChecks;
export let modelTiers = ts.modelTiers;
export let packagedLock = ts.packagedLock;
export let agentModels = ts.agentModels;
export let sandboxRequirements = ts.sandboxRequirements;
export let requirementFor = ts.requirementFor;
export let denialDiagnostics = ts.denialDiagnostics;
export let applyPatch = ts.applyPatch;
export let checkPatch = ts.checkPatch;
/** `checkSubprogram`: with the running program of a sub-program of 0.6 that applies a pattern, the Rust's alone. */
export let checkSubprogram: CheckSubprogram06 = ts.checkSubprogram;
export let checkAmendment = ts.checkAmendment;
export let semanticDiff: WithModules<typeof ts.semanticDiff> = ts.semanticDiff;
export let governanceChanges = ts.governanceChanges;
export let envelopeChanges = ts.envelopeChanges;
export let grant = ts.grant;
export let narrow = ts.narrow;
export let mapScopes = ts.mapScopes;
export let inFlightOverlap = ts.inFlightOverlap;
export let architecture: WithModulesAndLock<typeof ts.architecture> = ts.architecture;
export let architectureBlocks = ts.architectureBlocks;
export let authority: WithModules<typeof ts.authority> = ts.authority;
export let authorityBlocks = ts.authorityBlocks;
export let cost: WithModules<typeof ts.cost> = ts.cost;
export let programDoc: WithModules<typeof ts.programDoc> = ts.programDoc;
export let diffDoc: WithModules<typeof ts.diffDoc> = ts.diffDoc;
export let envelopeWorkflows = ts.envelopeWorkflows;
export let card = ts.card;
export let cardDoc = ts.cardDoc;
export let acsTarget = ts.acsTarget;
export let toMarkdown = ts.toMarkdown;
export let toHtml = ts.toHtml;
export let CODES = TS_CODES;

// Each export is bound to the functions of the mode, now and whenever a block runs under another (mode.ts).
onCompilerMode((m) => {
  const f = m === "ts" ? ts : facade;
  load = f.load;
  check = f.check;
  loadModules = f.loadModules;
  parseStrictJson = f.parseStrictJson;
  canonicalize = f.canonicalize;
  hashProgram = f.hashProgram;
  packageHash = f.packageHash;
  domainHash = f.domainHash;
  printProgram = f.printProgram;
  link = f.link;
  linkedProgram = f.linkedProgram;
  references = f.references;
  rolesNamed = f.rolesNamed;
  programRef = f.programRef;
  leadClasses = f.leadClasses;
  workflowBounds = f.workflowBounds;
  capsOf = f.capsOf;
  showCap = f.showCap;
  governanceFiles = f.governanceFiles;
  skeleton = f.skeleton;
  subprogramLinked = f.subprogramLinked;
  validateLock = f.validateLock;
  roleLockChecks = f.roleLockChecks;
  sandboxLockChecks = f.sandboxLockChecks;
  bindingChecks = f.bindingChecks;
  modelTiers = f.modelTiers;
  packagedLock = f.packagedLock;
  agentModels = f.agentModels;
  sandboxRequirements = f.sandboxRequirements;
  requirementFor = f.requirementFor;
  denialDiagnostics = f.denialDiagnostics;
  applyPatch = f.applyPatch;
  checkPatch = f.checkPatch;
  checkSubprogram = f.checkSubprogram;
  checkAmendment = f.checkAmendment;
  semanticDiff = f.semanticDiff;
  governanceChanges = f.governanceChanges;
  envelopeChanges = f.envelopeChanges;
  grant = f.grant;
  narrow = f.narrow;
  mapScopes = f.mapScopes;
  inFlightOverlap = f.inFlightOverlap;
  architecture = f.architecture;
  architectureBlocks = f.architectureBlocks;
  authority = f.authority;
  authorityBlocks = f.authorityBlocks;
  cost = f.cost;
  programDoc = f.programDoc;
  diffDoc = f.diffDoc;
  envelopeWorkflows = f.envelopeWorkflows;
  card = f.card;
  cardDoc = f.cardDoc;
  acsTarget = f.acsTarget;
  toMarkdown = f.toMarkdown;
  toHtml = f.toHtml;
  CODES = m === "ts" ? TS_CODES : rustCodes();
});
