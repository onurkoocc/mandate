// Small presentational helpers the compiler's entry point does not export, so that the command line and the MCP server
// (cli.ts, mcp.ts) stay over the bridge's entry point alone. util.test.ts holds each equal to the compiler's.

/** Escapes one JSON Pointer reference token (RFC 6901 §4). */
export function ptrToken(s: string | number): string {
  return String(s).replace(/~/g, "~0").replace(/\//g, "~1");
}
