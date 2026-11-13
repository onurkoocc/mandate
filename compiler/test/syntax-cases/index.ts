// The inputs of vectors/syntax.json, in the order the file lists them. Each
// section is a list of `[name, input]` (or `[name, parts]`); a name starts
// with its section's tag, and no two names are the same.

import { contracts, functions, agents, header, system, tests, types, values, workflows } from "./grammar.js";
import { expressions, operators, statements } from "./expressions.js";
import { duplicates, found, limits, missing, namePositions, recovery, stringPositions } from "./errors.js";
import { names, numbers, positions, reservedWords, strings, trivia } from "./lexical.js";
import { smallest } from "./smallest.js";

export type SyntaxCase = { name: string; input: string } | { name: string; input_parts: Array<[string, number]> };

const SECTIONS: Array<[string, Array<[string, string]> | Array<[string, Array<[string, number]>]>]> = [
  ["position", positions],
  ["trivia", trivia],
  ["number", numbers],
  ["string", strings],
  ["name", names],
  ["reserved word", reservedWords],
  ["smallest", smallest],
  ["header", header],
  ["type", types],
  ["value", values],
  ["function", functions],
  ["agent", agents],
  ["workflow", workflows],
  ["system", system],
  ["contract", contracts],
  ["test", tests],
  ["statement", statements],
  ["expression", expressions],
  ["operator", operators],
  ["name position", namePositions],
  ["string position", stringPositions],
  ["missing", missing],
  ["found", found],
  ["duplicate", duplicates],
  ["after an error", recovery],
  ["limit", limits],
];

export const SYNTAX_CASES: SyntaxCase[] = SECTIONS.flatMap(([tag, list]) =>
  (list as Array<[string, string | Array<[string, number]>]>).map(([name, input]): SyntaxCase =>
    typeof input === "string" ? { name: `${tag}: ${name}`, input } : { name: `${tag}: ${name}`, input_parts: input },
  ),
);

const seen = new Set<string>();
for (const c of SYNTAX_CASES) {
  if (seen.has(c.name)) throw new Error(`two syntax cases are named "${c.name}"`);
  seen.add(c.name);
}
