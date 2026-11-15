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

// The names below are exported here and so are not taken from the reference compiler's `export *`.
export * from "@mandate/compiler";
export type { AuthorityContext, GrantDelegation, GrantInput, GrantOutput, InFlightOverlapInput, InFlightOverlapOutput, ItemScopes, MapScopesInput, MapScopesOutput, NarrowInput, NarrowOutput, Refusal } from "./authority.js";

export let load = ts.load;
export let check = ts.check;
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
export let checkSubprogram = ts.checkSubprogram;
export let checkAmendment = ts.checkAmendment;
export let semanticDiff = ts.semanticDiff;
export let governanceChanges = ts.governanceChanges;
export let envelopeChanges = ts.envelopeChanges;
export let grant = ts.grant;
export let narrow = ts.narrow;
export let mapScopes = ts.mapScopes;
export let inFlightOverlap = ts.inFlightOverlap;
export let architecture = ts.architecture;
export let architectureBlocks = ts.architectureBlocks;
export let authority = ts.authority;
export let authorityBlocks = ts.authorityBlocks;
export let cost = ts.cost;
export let programDoc = ts.programDoc;
export let diffDoc = ts.diffDoc;
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
