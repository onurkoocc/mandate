// The recording layer of the compiled corpus (vectors/README.md, "corpus/"). vitest.config.ts runs this file before
// every test file, and only in the collecting mode (MANDATE_CORPUS=1, or MANDATE_UPDATE_VECTORS=1). It replaces the
// modules that export a front door (corpus-doors.ts) with the same module whose door functions record each call
// before returning the door's own return value, unchanged: the tests run as they do without the mode. A call that a
// door makes, through another module, of another door is part of the outer call and is not recorded again.
//
// After the file's tests, what it recorded is written to MANDATE_CORPUS_DIR, one JSON file named after the test file;
// corpus.test.ts, which runs after every other file, merges them. Nothing here imports the compiler.

import { mkdirSync, writeFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, vi } from "vitest";
import { doorsOf, inputOf, resultOf, Unrecordable, valueKey, type Door, type DoorModule } from "./corpus-doors.js";

/** One distinct call of this test file: its door, and its input and results as corpus-doors.ts stores them, as text. */
export interface RecordedCall {
  door: Door;
  input: string;
  /** Every distinct result the same input gave (one, unless the door is not deterministic). */
  results: string[];
  /** Set when the call threw: the message. */
  throws?: string;
}

interface State {
  depth: number;
  calls: Map<string, RecordedCall>;
  values: Map<string, string>;
  unrecordable: Map<string, number>;
  made: number;
}

/** The repository root (helpers.js has it too, but imports the compiler, which this file must not). */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

const KEY = "__mandateCorpus";
const state = (): State => ((globalThis as Record<string, unknown>)[KEY] ??= { depth: 0, calls: new Map(), values: new Map(), unrecordable: new Map(), made: 0 }) as State;

function share(value: unknown): string {
  const text = JSON.stringify(value);
  const key = valueKey(text);
  const values = state().values;
  const known = values.get(key);
  if (known !== undefined && known !== text) throw new Error(`corpus: two values have the key ${key}`);
  values.set(key, text);
  return key;
}

function wrap(door: Door, fn: (...args: unknown[]) => unknown): (...args: unknown[]) => unknown {
  return function recorded(this: unknown, ...args: unknown[]): unknown {
    const st = state();
    if (st.depth > 0) return fn.apply(this, args);
    st.made++;
    // Noting a call never changes it: what cannot be noted is counted, and the call goes on as it would.
    const unrecordable = (e: unknown): void => {
      const why = `${door}: ${e instanceof Unrecordable ? e.message : `cannot be noted (${e instanceof Error ? e.message : String(e)})`}`;
      st.unrecordable.set(why, (st.unrecordable.get(why) ?? 0) + 1);
    };
    let input: string | undefined;
    try {
      input = JSON.stringify(inputOf(door, args, share));
    } catch (e) {
      unrecordable(e);
    }
    st.depth++;
    let r: unknown;
    try {
      r = fn.apply(this, args);
    } catch (e) {
      if (input !== undefined) note(st, door, input, undefined, e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      st.depth--;
    }
    if (input !== undefined) {
      try {
        note(st, door, input, JSON.stringify(resultOf(door, r)));
      } catch (e) {
        unrecordable(e);
      }
    }
    return r;
  };
}

function note(st: State, door: Door, input: string, result: string | undefined, throws?: string): void {
  const key = `${door}\n${input}`;
  const call = st.calls.get(key) ?? { door, input, results: [] };
  if (result !== undefined && !call.results.includes(result)) call.results.push(result);
  if (throws !== undefined) call.throws = throws;
  st.calls.set(key, call);
}

/** The module with each of its door functions recording its calls. */
export function wrapModule(module: DoorModule, original: Record<string, unknown>): Record<string, unknown> {
  const out = { ...original };
  for (const [fn, door] of doorsOf(module)) {
    const f = original[fn];
    if (typeof f !== "function") throw new Error(`corpus: ${module} exports no function ${fn}`);
    out[fn] = wrap(door, f as (...args: unknown[]) => unknown);
  }
  return out;
}

vi.mock("../src/check.js", async (original) => (await import("./corpus-record.js")).wrapModule("check", await original()));
vi.mock("../src/patch/patch.js", async (original) => (await import("./corpus-record.js")).wrapModule("patch", await original()));
vi.mock("../src/lock.js", async (original) => (await import("./corpus-record.js")).wrapModule("lock", await original()));
vi.mock("../src/target/acs.js", async (original) => (await import("./corpus-record.js")).wrapModule("acs", await original()));
vi.mock("../src/target/sandbox.js", async (original) => (await import("./corpus-record.js")).wrapModule("sandbox", await original()));

// vitest hands a hook its context first (an object pattern, which it requires) and the file second.
afterAll(({}, suite) => {
  const dir = process.env["MANDATE_CORPUS_DIR"];
  if (!dir) throw new Error("corpus: MANDATE_CORPUS_DIR is not set; vitest.config.ts sets it in the collecting mode");
  const file = relative(repoRoot, (suite as { filepath?: string }).filepath ?? "").replace(/\\/g, "/");
  const st = state();
  mkdirSync(dir, { recursive: true });
  const name = file.replace(/[^A-Za-z0-9.-]/g, "_");
  writeFileSync(`${dir}/${name}.json`, JSON.stringify({ file, made: st.made, calls: [...st.calls.values()], values: Object.fromEntries(st.values), unrecordable: Object.fromEntries(st.unrecordable) }));
});
