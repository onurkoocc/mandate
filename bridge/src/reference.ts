// The bridge's third entry point, `@mandate/bridge/reference`: the reference compiler's functions (the TypeScript
// compiler, frozen at language 0.5) and the bridge's own run-time authority decisions in TypeScript (authority.ts),
// for WRITING TEST DATA ONLY: the scripts that write the vectors the Rust crates are tested against, and the
// journal cases, whose expected values are what the reference gives.
//
// Nothing that runs a program may use it. The bridge's own entry (index.ts, and the command line and the MCP server
// over it) answers with the Rust compiler's module and no other; the runtime may not import this entry, and nothing
// in runtime/src or bridge/src outside this file may (runtime/test/seam.test.ts, bridge/test/seam.test.ts).

export * from "./ts.js";
