/**
 * The bridge: the one package that reaches the compiler. The runtime imports the compiler only through here, so
 * the compiler behind these names can change without the runtime changing. Today it is the reference compiler.
 */
export * from "@mandate/compiler";
