// The `Path` type (K68, G14). A Path names a file relative to the root of a
// working copy, the same way on every host and executor:
//
//   one or more segments separated by `/`
//   no empty segment: no leading or trailing `/`, no `//`
//   no `.` or `..` segment
//   no `\`, no `:` (a Windows drive or alternate data stream), no NUL
//
// A model's answer that breaks the rule is refused by schema validation
// (runtime/src/schema.ts), and a text literal that breaks it where a Path is
// expected does not check (E0204). The runtime still checks each path where
// it uses one (runtime/src/paths.ts): the type is the first line, not the
// only one.

const CH = "[^/\\\\:\\x00]";
const FIRST = "[^/\\\\:\\x00.]";
// A segment that is not `.` or `..`, written without lookahead so that a
// model provider's structured output accepts it.
const SEGMENT = `(${FIRST}${CH}*|\\.${FIRST}${CH}*|\\.\\.${CH}+)`;

/** The rule as a JSON Schema `pattern` (ECMA 262). */
export const PATH_PATTERN = `^${SEGMENT}(/${SEGMENT})*$`;

const RE = new RegExp(PATH_PATTERN, "u");

/** Why `s` is not a Path, or undefined when it is one. */
export function pathProblem(s: string): string | undefined {
  if (RE.test(s)) return undefined;
  if (s === "") return "it is empty";
  if (s.includes("\0")) return "it contains NUL";
  if (s.includes("\\")) return "it contains `\\`; use `/`";
  if (s.includes(":")) return "it contains `:` (a drive or a stream)";
  if (s.startsWith("/")) return "it is absolute";
  if (s.endsWith("/") || s.includes("//")) return "it has an empty segment";
  return "it has a `.` or `..` segment";
}

export function isPath(s: unknown): s is string {
  return typeof s === "string" && RE.test(s);
}
