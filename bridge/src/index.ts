/**
 * The bridge: the one package that reaches the compiler. The runtime imports the compiler only through here, so
 * the compiler behind these names can change without the runtime changing. Today it is the reference compiler.
 *
 * Beside it, the `mandate` command line (cli.ts) and the MCP server (mcp.ts), written over this entry point and
 * nothing else of the compiler, so that they follow it to whichever compiler it calls; they are programs, not names
 * exported from here (their one helper is util.ts).
 *
 * And the run-time authority decisions (authority.ts): the runtime asks them what is granted, narrowed, handed to a
 * map's items and in the way of a sub-program, and decides none of it itself.
 */
export * from "@mandate/compiler";
export * from "./authority.js";
