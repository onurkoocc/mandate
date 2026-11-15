// Small presentational helpers the compiler's entry point does not export, so that the command line and the MCP server
// (cli.ts, mcp.ts) stay over the bridge's entry point alone. util.test.ts holds each equal to the compiler's, but
// viewModules, which is the bridge's own: what of its caller's modules a view is given.

import { LANGUAGE_VERSIONS, type Modules, type Program } from "./index.js";

/** Escapes one JSON Pointer reference token (RFC 6901 §4). */
export function ptrToken(s: string | number): string {
  return String(s).replace(/~/g, "~0").replace(/\//g, "~1");
}

/**
 * The modules a view or a diff of `programs` is given (architecture, authority, cost, semanticDiff, diffDoc): the
 * modules the caller has, when one of the programs is of a language only the Rust compiler reads (0.6, whose
 * workflows may apply a pattern of one of them, shown as its expansion); none for programs of 0.1 to 0.5, so that
 * their requests stay as the TypeScript functions take them.
 */
export function viewModules(modules: Modules | undefined, ...programs: Program[]): Modules | undefined {
  const known: readonly string[] = LANGUAGE_VERSIONS;
  return programs.some((p) => !known.includes(p.language)) ? modules : undefined;
}
