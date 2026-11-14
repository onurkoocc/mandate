#!/usr/bin/env node
// Writes crates/*/tests/json_doors/expected.json: what the TypeScript compiler
// gives for each call of the inputs.json beside it, through the JSON doors
// that doors.json beside it lists, so that the Rust doors
// (crates/mandate-check/src/json_doors/, and the views crate's when it has
// them) are held to the TypeScript call for call. The Rust test of each crate
// (crates/mandate-check/tests/json_doors.rs) gives the same inputs to its doors
// and compares the output text.
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist
//                                                and bridge/dist)
//   node scripts/json-doors-vectors.mjs
//
// doors.json is `{ format: "mandate/doors/0.1", doors: [{ name, ts, params,
// note? }] }`: a door's name, the function of compiler/src/index.ts it stands
// for (null for a door that has none of its own: its meaning is computed here
// from TypeScript functions, `OWN` below), and the members of its input, the
// function's parameters in order. A function the compiler does not export is
// looked for in the bridge (bridge/src/index.ts, built to bridge/dist), which
// exports the compiler's names and, besides them, the run-time authority
// decisions of bridge/src/authority.ts (`grant`, `narrow`, `mapScopes`,
// `inFlightOverlap`); a name neither exports is an error. inputs.json is
// `{ calls: [{ name, door, input }] }`; the function is called with
// `params.map((p) => input[p])`,
// except that a parameter whose TypeScript type is a Set or a Map (listed in
// `COLLECTIONS` below; the door takes the array or the object the contract
// writes it as) is given as one.
//
// An input may name repository files instead of holding their text, to keep
// the file small. An object `{ "$text": path }` is the file's text, `{ "$json":
// path }` the file read as JSON, `{ "$ir": path }` the IR of a golden program
// (`ir` of vectors/programs/<path with / as .>.json, see vectors/README.md),
// `{ "$lock": path }` its lock as a package carries it and `{ "$hash": path }`
// its program hash. A path may end in `#<JSON Pointer>`, for the value there.
// Such an object may also have `"$set": [[pointer, value], ...]`: each value
// put at its pointer, in order, in a copy (the last token of a pointer names
// a member of an object or an index of an array that is there).
//
// An answer is `{ name, door, sha256, output? }`: the digest of the output
// text, and the text itself when it is at most 2048 characters, or `{ name,
// door, error: "bad_input", throws }` when the TypeScript function throws
// (the door then answers bad_input; the message is kept to read). The output
// text is `doorJson(result)` below, the contract's serialiser. Running it
// again writes the same bytes.
//
// What is written is the TypeScript's answer, which stays at language 0.5.
// The Rust compiler also reads 0.6, so its `tables` door gives
// `LANGUAGE_VERSIONS` with "mandate/0.6" at the end and `LANGUAGE_VERSION`
// "mandate/0.6", and an E0103 lists 0.6 too; the Rust test compares them
// without that one entry, and counts the calls it does that for
// (`mandate_testkit::rust_only`; vectors/README.md, "The versions only the
// Rust compiler reads"). Nothing here changes for it.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const compiler = await import(new URL("compiler/dist/index.js", root).href);
const bridge = await import(new URL("bridge/dist/index.js", root).href);

/** The TypeScript function named `ts`: the compiler's, or, when the compiler exports none, the bridge's. */
const tsFunction = (ts) => (typeof compiler[ts] === "function" ? compiler[ts] : typeof bridge[ts] === "function" ? bridge[ts] : undefined);

// ---------------------------------------------------------------------------
// The contract's serialiser: the output of a door, as text.
//
// What `JSON.stringify(value)` gives, with the rules of the door contract for
// what JSON cannot carry:
//   - a Map is an object with its entries in insertion order (its keys written
//     with String(key)), whatever the keys look like (JSON.stringify of
//     Object.fromEntries would put keys that look like array indices first);
//   - a Set is an array in insertion order;
//   - a member whose value is undefined (or a function or a symbol) is left
//     out of an object, and is null in an array, as JSON.stringify does;
//   - a return value of undefined is null.
// Numbers are written as JSON.stringify writes them (NaN and the infinities as
// null), strings as JSON.stringify escapes them, and an object's toJSON is
// called first, as JSON.stringify calls it. The Node side of the bridge
// compares the TypeScript's results with the Rust doors' through this
// function.
export function doorJson(value) {
  return write(value, "") ?? "null";
}

function write(value, key) {
  let v = value;
  if (v !== null && (typeof v === "object" || typeof v === "bigint") && typeof v.toJSON === "function") v = v.toJSON(key);
  if (v === null) return "null";
  switch (typeof v) {
    case "undefined":
    case "function":
    case "symbol":
      return undefined;
    case "boolean":
    case "number":
    case "string":
      return JSON.stringify(v);
    case "bigint":
      throw new TypeError("Do not know how to serialize a BigInt");
    default:
      break;
  }
  if (v instanceof Number || v instanceof String || v instanceof Boolean) return JSON.stringify(v);
  if (v instanceof Map) {
    const parts = [];
    for (const [k, x] of v) {
      const text = write(x, String(k));
      if (text !== undefined) parts.push(`${JSON.stringify(String(k))}:${text}`);
    }
    return `{${parts.join(",")}}`;
  }
  if (v instanceof Set) v = [...v];
  if (Array.isArray(v)) return `[${v.map((x, i) => write(x, String(i)) ?? "null").join(",")}]`;
  const parts = [];
  for (const k of Object.keys(v)) {
    const text = write(v[k], k);
    if (text !== undefined) parts.push(`${JSON.stringify(k)}:${text}`);
  }
  return `{${parts.join(",")}}`;
}
// ---------------------------------------------------------------------------

/**
 * The doors that have no TypeScript function of their own (`ts: null` in
 * doors.json), by name: what each answers, from the TypeScript's functions and
 * constants, as its note in doors.json says.
 */
const OWN = {
  glob_match: ({ glob, text }) => compiler.globRegExp(glob).test(text),
  explain: ({ code: raw }) => {
    const code = raw.startsWith("MDT-") ? raw : `MDT-${raw}`;
    const entry = Object.hasOwn(compiler.CODES, code) ? compiler.CODES[code] : undefined;
    return entry ? { code, ...entry } : undefined;
  },
  codes: () => compiler.CODES,
  // Every exported value that is not a function, in the order of the exports.
  tables: () => Object.fromEntries(Object.entries(compiler).filter(([, v]) => typeof v !== "function")),
};

/**
 * The parameters whose TypeScript type is a Set or a Map, by door: the door
 * takes the array or the object the contract writes it as, and the function
 * is given it back as a Set (in the array's order) or a Map (in the object's).
 */
const COLLECTIONS = {
  caps_of: { within: "Set" },
  role_lock_checks: { spans: "Map" },
  binding_checks: { spans: "Map" },
};

/** The argument `p` of a door's function, from its input. */
function argument(door, input, p) {
  const v = input[p];
  const type = COLLECTIONS[door]?.[p];
  if (v === undefined || v === null || !type) return v;
  return type === "Set" ? new Set(v) : new Map(Object.entries(v));
}

const read = (path) => readFileSync(new URL(path, root), "utf8");
const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/** The tokens of JSON Pointer `pointer`. */
const tokensOf = (pointer) => (pointer === "" ? [] : pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~")));

/** The value at `tokens` in `value`, each a member or an index that is there. */
function walk(value, tokens, pointer) {
  let v = value;
  for (const token of tokens) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, token)) throw new Error(`nothing at ${pointer}`);
    v = v[token];
  }
  return v;
}

/** The value at JSON Pointer `pointer` in `value`. */
const at = (value, pointer) => walk(value, tokensOf(pointer), pointer);

/** `v` put at `pointer` in `value`, in place: its last token names a member or an index that is there. */
function put(value, pointer, v) {
  const tokens = tokensOf(pointer);
  const last = tokens.pop();
  const parent = walk(value, tokens, pointer);
  if (last === undefined || parent === null || typeof parent !== "object" || !Object.hasOwn(parent, last)) throw new Error(`nothing at ${pointer}`);
  parent[last] = v;
}

/** The golden program file of `source`, such as fixtures/system/land.mdt. */
const golden = (source) => JSON.parse(read(`vectors/programs/${source.replace(/\//g, ".")}.json`));

const REFS = {
  $text: (path) => read(path),
  $json: (path) => JSON.parse(read(path)),
  $ir: (path) => golden(path).ir,
  $lock: (path) => golden(path).lock,
  $hash: (path) => golden(path).hashes.program,
};

/** An input with every reference to a file replaced by what it names. */
function resolve(v) {
  if (Array.isArray(v)) return v.map(resolve);
  if (v === null || typeof v !== "object") return v;
  const refs = Object.keys(v).filter((k) => Object.hasOwn(REFS, k));
  if (refs.length === 1) {
    const { [refs[0]]: target, $set, ...rest } = v;
    if (Object.keys(rest).length) throw new Error(`a reference has other members: ${JSON.stringify(v)}`);
    const [path, pointer] = target.includes("#") ? [target.slice(0, target.indexOf("#")), target.slice(target.indexOf("#") + 1)] : [target, ""];
    const out = structuredClone(at(REFS[refs[0]](path), pointer));
    for (const [p, x] of $set ?? []) put(out, p, resolve(x));
    return out;
  }
  if (refs.length > 1) throw new Error(`more than one reference: ${JSON.stringify(v)}`);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]));
}

const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const crates = new URL("crates/", root);
for (const crate of readdirSync(crates).sort()) {
  const dir = new URL(`${crate}/tests/json_doors/`, crates);
  if (!existsSync(new URL("doors.json", dir))) continue;
  const doors = JSON.parse(readFileSync(new URL("doors.json", dir), "utf8"));
  if (doors.format !== "mandate/doors/0.1") throw new Error(`${crate}: doors.json has format ${doors.format}`);
  const byName = new Map(doors.doors.map((d) => [d.name, d]));
  const inputs = JSON.parse(readFileSync(new URL("inputs.json", dir), "utf8"));
  const names = new Set();
  const out = [];
  for (const call of inputs.calls) {
    if (names.has(call.name)) throw new Error(`${crate}: two calls are named ${call.name}`);
    names.add(call.name);
    const door = byName.get(call.door);
    if (!door) throw new Error(`${crate}: ${call.name}: no door ${call.door}`);
    const input = resolve(call.input);
    let f;
    if (door.ts === null) {
      if (!Object.hasOwn(OWN, door.name)) throw new Error(`${crate}: the door ${door.name} has no TypeScript function and no meaning here`);
      f = () => OWN[door.name](input);
    } else {
      const fn = tsFunction(door.ts);
      if (!fn) throw new Error(`${crate}: neither the compiler nor the bridge exports a function ${door.ts}`);
      f = () => fn(...door.params.map((p) => argument(door.name, input, p)));
    }
    let result;
    try {
      result = f();
    } catch (e) {
      out.push({ name: call.name, door: call.door, error: "bad_input", throws: e instanceof Error ? `${e.name}: ${e.message}` : String(e) });
      continue;
    }
    const text = doorJson(result);
    out.push({ name: call.name, door: call.door, sha256: sha256(text), ...(text.length <= 2048 ? { output: text } : {}) });
  }
  // One answer a line, to keep a difference readable.
  const lines = out.map((e) => `    ${JSON.stringify(e)}`);
  writeFileSync(
    new URL("expected.json", dir),
    ascii(`{\n  "format": "mandate/doors-expected/0.1",\n  "generator": "scripts/json-doors-vectors.mjs",\n  "calls": [\n${lines.join(",\n")}\n  ]\n}\n`),
  );
  console.log(`${crate}: ${out.length} calls, ${byName.size} doors`);
}
