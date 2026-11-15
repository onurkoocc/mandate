// The one way the facade (rust.ts) reaches the module: `rustCall(door, input)`, on the module of the process (read
// from its file, module.ts), of the worker thread (handed over by the thread that started it, mode.ts), or of a
// block a test runs under another module (mode.ts, `withCompiler`).
//
// The first call on a module asks it for its table of doors (the door `doors`) and checks that every door the
// facade calls is there, standing for the function the facade has it for, with the parameters the facade sends
// (doors.ts). A module that fails that answers no call: every call on it is the same `doors_mismatch`.

import { DOOR_BACKED, OWN_DOORS } from "../doors.js";
import { CompilerFailure } from "./errors.js";
import { WasmHost } from "./host.js";
import { processModule } from "./module.js";

/** Where the facade's calls go instead of the process's module: a worker's module, or a block's. */
interface Placement {
  module?: WebAssembly.Module;
  /** Doors answered by another module than `module`, for a test that makes one door fail. Their table is not checked. */
  doors?: Record<string, WebAssembly.Module>;
}

let placement: Placement = {};

/** Sets where calls go; gives back where they went before. */
export function place(p: Placement): Placement {
  const before = placement;
  placement = p;
  return before;
}

/** Where calls go now. */
export function placed(): Placement {
  return placement;
}

/** The module calls go to now, unless a door is placed elsewhere. */
export function currentModule(): WebAssembly.Module {
  return placement.module ?? processModule();
}

const hosts = new WeakMap<WebAssembly.Module, { host: WasmHost; table?: CompilerFailure | true }>();

function hostOf(module: WebAssembly.Module): { host: WasmHost; table?: CompilerFailure | true } {
  let h = hosts.get(module);
  if (!h) hosts.set(module, (h = { host: new WasmHost(module) }));
  return h;
}

/** The output of `door` for `input`, from the module calls go to now. */
export function rustCall(door: string, input: unknown): unknown {
  const elsewhere = placement.doors?.[door];
  if (elsewhere) return hostOf(elsewhere).host.call(door, input);
  const h = hostOf(currentModule());
  if (h.table === undefined) h.table = tableProblem(h.host) ?? true;
  if (h.table !== true) throw h.table;
  return h.host.call(door, input);
}

/** The host of the module calls go to now: for the tests that count its imports. */
export function currentHost(): WasmHost {
  return hostOf(currentModule()).host;
}

/** What is wrong with the module's table of doors for the facade, if anything. */
function tableProblem(host: WasmHost): CompilerFailure | undefined {
  let table: unknown;
  try {
    table = host.call("doors", {});
  } catch (e) {
    if (e instanceof CompilerFailure) return e;
    return new CompilerFailure("doors_mismatch", "doors", `the module did not give its table of doors (${e instanceof Error ? e.message : String(e)})`);
  }
  const rows = (table as { format?: unknown; doors?: unknown })?.doors;
  if ((table as { format?: unknown })?.format !== "mandate/doors/0.1" || !Array.isArray(rows)) return new CompilerFailure("doors_mismatch", "doors", "the module's table of doors is not of the format mandate/doors/0.1");
  const byName = new Map<string, { ts?: unknown; params?: unknown }>();
  for (const r of rows as Array<{ name?: unknown; ts?: unknown; params?: unknown }>) if (typeof r?.name === "string") byName.set(r.name, r);
  const wrong: string[] = [];
  const want = (door: string, ts: string | null, params: readonly string[]): void => {
    const row = byName.get(door);
    if (!row) return void wrong.push(`${door} is not in it`);
    if (row.ts !== ts) wrong.push(`${door} stands for ${JSON.stringify(row.ts)}, not ${JSON.stringify(ts)}`);
    if (JSON.stringify(row.params) !== JSON.stringify(params)) wrong.push(`${door} takes ${JSON.stringify(row.params)}, and the bridge sends ${JSON.stringify(params)}`);
  };
  for (const [fn, d] of Object.entries(DOOR_BACKED)) want(d.door, fn, d.params);
  for (const [door, params] of Object.entries(OWN_DOORS)) want(door, null, params);
  return wrong.length ? new CompilerFailure("doors_mismatch", undefined, `the module's table of doors is not the one the bridge calls: ${wrong.join("; ")}`) : undefined;
}
