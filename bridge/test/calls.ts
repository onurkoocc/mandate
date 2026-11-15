// The recorded calls of the two crates' doors (crates/*/tests/json_doors/inputs.json, with the TypeScript's output
// in expected.json beside them), read as scripts/json-doors-vectors.mjs reads them: a reference to a repository
// file (`$text`, `$json`, `$ir`, `$lock`, `$hash`, perhaps with `#<pointer>` and `$set`) resolved to what it names.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./tree.js";

export interface Door {
  name: string;
  ts: string | null;
  params: string[];
}

export interface Call {
  /** The crate whose door it is. */
  crate: string;
  name: string;
  door: string;
  /** The input as inputs.json writes it, references and all. */
  written: unknown;
  /** The input with every reference resolved. */
  input: Record<string, unknown>;
}

export interface Expected {
  name: string;
  door: string;
  sha256?: string;
  output?: string;
  error?: string;
  throws?: string;
}

export const CRATES = ["mandate-check", "mandate-views"] as const;

const read = (p: string): string => readFileSync(join(repoRoot, p), "utf8");
const dir = (crate: string): string => `crates/${crate}/tests/json_doors`;

export function doorsOf(crate: string): Door[] {
  return (JSON.parse(read(`${dir(crate)}/doors.json`)) as { doors: Door[] }).doors;
}

export function expectedOf(crate: string): Expected[] {
  return (JSON.parse(read(`${dir(crate)}/expected.json`)) as { calls: Expected[] }).calls;
}

export function callsOf(crate: string): Call[] {
  const inputs = JSON.parse(read(`${dir(crate)}/inputs.json`)) as { calls: Array<{ name: string; door: string; input: unknown }> };
  return inputs.calls.map((c) => ({ crate, name: c.name, door: c.door, written: c.input, input: resolve(c.input) as Record<string, unknown> }));
}

/** The parameters whose TypeScript type is a Set or a Map, by door (scripts/json-doors-vectors.mjs, COLLECTIONS). */
const COLLECTIONS: Record<string, Record<string, "Set" | "Map">> = {
  caps_of: { within: "Set" },
  role_lock_checks: { spans: "Map" },
  binding_checks: { spans: "Map" },
};

/** The arguments of the TypeScript function a door stands for, from its input. */
export function argumentsOf(door: Door, input: Record<string, unknown>): unknown[] {
  return door.params.map((p) => {
    const v = input[p];
    const type = COLLECTIONS[door.name]?.[p];
    if (v === undefined || v === null || !type) return v;
    return type === "Set" ? new Set(v as unknown[]) : new Map(Object.entries(v as object));
  });
}

const golden = (source: string): { ir: unknown; lock: unknown; hashes: { program: string } } => JSON.parse(read(`vectors/programs/${source.replace(/\//g, ".")}.json`));

const REFS: Record<string, (path: string) => unknown> = {
  $text: (path) => read(path),
  $json: (path) => JSON.parse(read(path)),
  $ir: (path) => golden(path).ir,
  $lock: (path) => golden(path).lock,
  $hash: (path) => golden(path).hashes.program,
};

const tokensOf = (pointer: string): string[] => (pointer === "" ? [] : pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~")));

function walk(value: unknown, tokens: string[], pointer: string): unknown {
  let v = value;
  for (const t of tokens) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, t)) throw new Error(`nothing at ${pointer}`);
    v = (v as Record<string, unknown>)[t];
  }
  return v;
}

function put(value: unknown, pointer: string, v: unknown): void {
  const tokens = tokensOf(pointer);
  const last = tokens.pop()!;
  const parent = walk(value, tokens, pointer) as Record<string, unknown>;
  if (!Object.hasOwn(parent, last)) throw new Error(`nothing at ${pointer}`);
  parent[last] = v;
}

export function resolve(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(resolve);
  if (v === null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  const refs = Object.keys(o).filter((k) => Object.hasOwn(REFS, k));
  if (refs.length === 1) {
    const { [refs[0]!]: target, $set, ...rest } = o as Record<string, unknown> & { $set?: Array<[string, unknown]> };
    if (Object.keys(rest).length) throw new Error(`a reference has other members: ${JSON.stringify(o)}`);
    const t = target as string;
    const [path, pointer] = t.includes("#") ? [t.slice(0, t.indexOf("#")), t.slice(t.indexOf("#") + 1)] : [t, ""];
    const out = structuredClone(walk(REFS[refs[0]!]!(path), tokensOf(pointer), pointer));
    for (const [p, x] of $set ?? []) put(out, p, resolve(x));
    return out;
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
}
