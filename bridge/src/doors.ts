// Which of the bridge's functions the Rust compiler answers, through which door, and which stay in TypeScript and
// why. Every function bridge/src/index.ts exports is in exactly one of the three lists (test/facade.test.ts): the
// door-backed functions, the Rust-only ones of language 0.6, and those kept in TypeScript.
//
// A door-backed function is answered by the door of its name in `rust` mode, and by both compilers, compared, in
// `both` (index.ts). Its door takes the function's parameters as the members of its input, by these names, which
// the module's own table (the door `doors`) must give when the module is loaded (wasm/call.ts).

/**
 * The door-backed functions: the door each calls, and the members of its input, the function's parameters in order.
 * The views and the diffs of a program (architecture, authority, cost, semanticDiff, diffDoc) take the modules
 * besides, last: the Rust's alone (language 0.6, whose workflow may apply a pattern of a module), which the
 * TypeScript function is not given; a caller passes them only for a program of 0.6 (util.ts, viewModules).
 */
export const DOOR_BACKED = {
  // Reading, checking, hashing and printing.
  load: { door: "load", params: ["text", "kind"] },
  check: { door: "check", params: ["text", "kind", "opts"] },
  loadModules: { door: "load_modules", params: ["sources"] },
  parseStrictJson: { door: "parse_strict_json", params: ["text"] },
  canonicalize: { door: "canonicalize", params: ["value"] },
  hashProgram: { door: "hash_program", params: ["program"] },
  packageHash: { door: "package_hash", params: ["programHash", "lock"] },
  domainHash: { door: "domain_hash", params: ["domain", "value", "version"] },
  printProgram: { door: "print_program", params: ["p"] },
  // What a program is made of.
  link: { door: "link", params: ["program", "modules"] },
  linkedProgram: { door: "linked_program", params: ["program", "modules"] },
  references: { door: "references", params: ["d"] },
  rolesNamed: { door: "roles_named", params: ["defs"] },
  programRef: { door: "program_ref", params: ["p"] },
  leadClasses: { door: "lead_classes", params: ["program", "linked"] },
  workflowBounds: { door: "workflow_bounds", params: ["d"] },
  capsOf: { door: "caps_of", params: ["defs", "e", "opts", "within"] },
  showCap: { door: "show_cap", params: ["c"] },
  governanceFiles: { door: "governance_files", params: ["files", "extra"] },
  skeleton: { door: "skeleton", params: ["parent", "n", "language"] },
  subprogramLinked: { door: "subprogram_linked", params: ["sub", "parent", "modules"] },
  // The lock, the Managed Agents binding, the sandbox.
  validateLock: { door: "validate_lock", params: ["value"] },
  roleLockChecks: { door: "role_lock_checks", params: ["program", "linked", "lock", "spans"] },
  sandboxLockChecks: { door: "sandbox_lock_checks", params: ["program", "lock"] },
  bindingChecks: { door: "binding_checks", params: ["program", "lock", "spans"] },
  modelTiers: { door: "model_tiers", params: ["program"] },
  packagedLock: { door: "packaged_lock", params: ["lock"] },
  agentModels: { door: "agent_models", params: ["program", "agent"] },
  sandboxRequirements: { door: "sandbox_requirements", params: ["program", "modules", "lock"] },
  requirementFor: { door: "requirement_for", params: ["subject", "caps", "timeoutMs", "opts"] },
  denialDiagnostics: { door: "denial_diagnostics", params: ["program", "report"] },
  // Patches, sub-programs, amendments and diffs.
  applyPatch: { door: "apply_patch", params: ["program", "base", "ops", "modules"] },
  checkPatch: { door: "check_patch", params: ["program", "base", "ops", "modules"] },
  checkSubprogram: { door: "check_subprogram", params: ["i"] },
  checkAmendment: { door: "check_amendment", params: ["i"] },
  semanticDiff: { door: "semantic_diff", params: ["before", "after", "locks", "modules"] },
  governanceChanges: { door: "governance_changes", params: ["before", "after", "modules"] },
  envelopeChanges: { door: "envelope_changes", params: ["before", "after", "workflow", "modules"] },
  // The run-time authority decisions (authority.ts).
  grant: { door: "grant", params: ["input"] },
  narrow: { door: "narrow", params: ["input"] },
  mapScopes: { door: "map_scopes", params: ["input"] },
  inFlightOverlap: { door: "in_flight_overlap", params: ["input"] },
  // The views, the documents, the card and the ACS target.
  architecture: { door: "architecture", params: ["program", "modules"] },
  architectureBlocks: { door: "architecture_blocks", params: ["v"] },
  authority: { door: "authority", params: ["program", "modules"] },
  authorityBlocks: { door: "authority_blocks", params: ["v"] },
  cost: { door: "cost", params: ["program", "lock", "modules"] },
  programDoc: { door: "program_doc", params: ["program", "lock", "modules"] },
  diffDoc: { door: "diff_doc", params: ["before", "after", "locks", "modules"] },
  envelopeWorkflows: { door: "envelope_workflows", params: ["program"] },
  card: { door: "card", params: ["program", "workflow", "opts"] },
  cardDoc: { door: "card_doc", params: ["program", "workflow", "opts"] },
  acsTarget: { door: "acs_target", params: ["program", "modules", "lock"] },
  toMarkdown: { door: "to_markdown", params: ["doc"] },
  toHtml: { door: "to_html", params: ["doc"] },
} as const satisfies Record<string, { door: string; params: readonly string[] }>;

export type DoorBacked = keyof typeof DOOR_BACKED;

/**
 * The functions of language 0.6 that only the Rust compiler answers (library.ts): the door each calls, and the
 * members of its input, the function's parameters in order. No TypeScript function stands for one: the reference
 * compiler is frozen at 0.5, so in `ts` mode each throws NoReference, by name, and in `both` it is the Rust's alone
 * (counted under `language-0.6`). Their doors stand for no TypeScript function in the module's table either.
 */
export const RUST_ONLY = {
  libraryVerify: { door: "library_verify", params: ["library", "libraries"] },
} as const satisfies Record<string, { door: string; params: readonly string[] }>;

/**
 * The doors the bridge calls that stand for no function of its own: `codes`, whose table is CODES in `rust` and
 * `both` (index.ts), with its parameters.
 */
export const OWN_DOORS = { codes: [] } as const satisfies Record<string, readonly string[]>;

/** Why a function stays in TypeScript, by kind of reason. */
export type Kept =
  /** Pure: a function of its arguments' syntax or of how a thing is shown, the same for every language version. */
  | { helper: string }
  /** Nothing in runtime/src, bridge/src/cli.ts or bridge/src/mcp.ts calls it (test/facade.test.ts holds that), so no door stands for it. */
  | { uncalled: string };

/** The functions that stay in TypeScript in every mode, with the reason for each. */
export const KEPT: Record<string, Kept> = {
  // Helpers: what they give depends on their arguments alone, read as syntax or shown as text, and no language
  // version changes it, so there is nothing for another compiler to decide.
  kindOf: { helper: "a file's kind from its name: .json is IR, anything else .mdt text" },
  calleePath: { helper: "the dotted name of a call's callee, read off the expression" },
  atLeast: { helper: "whether a language version is at least another, by their order in LANGUAGE_VERSIONS and then mandate/0.6 (library.ts): the reference compiler's answer for 0.1 to 0.5, and the bridge's own for 0.6, which the reference does not know" },
  classRank: { helper: "a data class's place in public < internal < confidential < restricted" },
  budgetAmount: { helper: "the number a budget gives one dimension" },
  formatDiagnostic: { helper: "a diagnostic as one line of text for a person" },
  hasErrors: { helper: "whether any diagnostic is an error" },
  diag: { helper: "builds a diagnostic object from its parts" },
  htmlEscape: { helper: "a text escaped for HTML" },
  mdEscape: { helper: "a text escaped for Markdown" },
  isProgram06: { helper: "whether a value is a program whose language is mandate/0.6 (library.ts), read off its `language` member alone" },
  isLanguageVersion: { helper: "whether a value is one of LANGUAGE_VERSIONS, the TypeScript's list (the constants stay the TypeScript's, see index.ts)" },
  isPath: { helper: "whether a text is a relative, normalized, portable path (PATH_PATTERN)" },
  pathProblem: { helper: "what makes a text not a path, for a message" },
  globRegExp: {
    helper:
      "a governance glob as a RegExp, which JSON cannot carry; the runtime tests it against each path of a workspace, and a door per path would cost a call each. The door glob_match, which answers globRegExp(glob).test(text), is held to it by crates/mandate-check/tests/json_doors",
  },
  // Called by nothing the bridge serves: no door, and the TypeScript reference's own in every mode. A caller that
  // starts to use one fails test/facade.test.ts until it has a door.
  system: { uncalled: "the system view; no door (crates/mandate-views has none)" },
  hasSystem: { uncalled: "whether a program has a system view" },
  systemBlocks: { uncalled: "the blocks of the system view" },
  costBlocks: { uncalled: "the blocks of the cost view: inside programDoc, which has a door" },
  diffBlocks: { uncalled: "the blocks of a diff: inside diffDoc, which has a door" },
  cardBlocks: { uncalled: "the blocks of the card: inside cardDoc, which has a door" },
  authorityOf: { uncalled: "inside the authority view, which has a door" },
  capsIn: { uncalled: "inside the views, which have doors" },
  delegateBudget: { uncalled: "inside the cost view, which has a door" },
  methodOf: { uncalled: "inside the views, which have doors" },
  isSystem: { uncalled: "inside the system view" },
  lockDiff: { uncalled: "inside semanticDiff, which has a door" },
  lockLimitsDiff: { uncalled: "inside semanticDiff, which has a door" },
  narrowings: { uncalled: "a phase of checkAmendment, which has a door" },
  staticCost: { uncalled: "a phase of check, which has a door" },
  roleSites: { uncalled: "a phase of check, which has a door" },
  roleChecks: { uncalled: "a phase of check, which has a door" },
  resolveNames: { uncalled: "a phase of check, which has a door" },
  parseMdt: { uncalled: "a phase of load, which has a door" },
  validateIr: { uncalled: "a phase of load, which has a door" },
  irSchema: { uncalled: "the IR schema as data, read from spec/" },
  lockSchema: { uncalled: "the lock schema as data, read from spec/" },
  lockChecks: { uncalled: "a phase of check with a lock, which has a door" },
  moduleLockChecks: { uncalled: "a phase of check with a lock, which has a door" },
  importedMethods: { uncalled: "a phase of check, which has a door" },
  readMethods: { uncalled: "a phase of check, which has a door" },
  readsMethods: { uncalled: "a phase of check, which has a door" },
  capFromCall: { uncalled: "inside capsOf, which has a door" },
  capsFromCall: { uncalled: "inside capsOf, which has a door" },
  containment: { uncalled: "a phase of checkSubprogram, which has a door" },
  subprogramShape: { uncalled: "a phase of checkSubprogram, which has a door" },
  governanceKind: { uncalled: "inside governanceFiles, which has a door" },
  floorFor: { uncalled: "inside the sandbox requirements, which have doors" },
  coTenancyFor: { uncalled: "inside the sandbox requirements, which have doors" },
  perCallBound: { uncalled: "inside the cost view, which has a door" },
  capCovers: { uncalled: "an authority predicate: the runtime asks the four authority decisions, which have doors, and runtime/test/seam.test.ts forbids it this one" },
  scopeWithin: { uncalled: "an authority predicate, as capCovers" },
  within: { uncalled: "an authority predicate, as capCovers" },
  pathsOverlap: { uncalled: "an authority predicate, as capCovers" },
  writesOverlap: { uncalled: "an authority predicate, as capCovers" },
  grantOf: { uncalled: "an authority predicate, as capCovers" },
  callTool: { uncalled: "the TypeScript compiler's own MCP server; the bridge's is bridge/src/mcp.ts, over the facade" },
  serveStdio: { uncalled: "the TypeScript compiler's own MCP server, as callTool" },
  McpServer: { uncalled: "the TypeScript compiler's own MCP server, as callTool" },
};
