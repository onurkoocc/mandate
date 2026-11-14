/**
 * The bridge: the one package that reaches the compiler. The runtime imports the compiler only through here, so
 * the compiler behind these names can change without the runtime changing. Today it is the reference compiler.
 *
 * Beside it, the run-time authority decisions (authority.ts): the runtime asks them what is granted, narrowed,
 * handed to a map's items and in the way of a sub-program, and decides none of it itself.
 */
export * from "@mandate/compiler";
export * from "./authority.js";
