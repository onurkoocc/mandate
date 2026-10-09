// Kervan's system model for runtime tests (examples/kervan, design doc 9 §10):
// the module, a lock that pins it, and small programs that work on it.

import { readFileSync } from "node:fs";
import { check, hashProgram, type Json, type Lock, type Modules, type Program } from "@mandate/compiler";

export const KERVAN_SOURCE = readFileSync(new URL("../../examples/kervan/kervan-system/system/kervan.system.mdt", import.meta.url), "utf8");

export function kervanModule(src = KERVAN_SOURCE): Program {
  const r = check(src, "mdt");
  if (!r.ok) throw new Error(r.diagnostics.map((d) => `${d.code} ${d.message}`).join("\n"));
  return r.program!;
}

export function kervanModules(src = KERVAN_SOURCE): Modules {
  return { "kervan.system": kervanModule(src) };
}

/** A lock that pins the given modules by hash (S09), plus anything else. */
export function lockFor(modules: Modules, extra: Record<string, string> = {}): Lock {
  return { modules: { ...extra, ...Object.fromEntries(Object.entries(modules).map(([m, p]) => [m, hashProgram(p as unknown as Json).program])) } };
}

/** Two agents changing two components of Kervan in parallel (doc 9 §12, B2/B3). */
export const TWO_COMPONENTS = `mandate @ 0.3
module kervan.tasks.two @ 0.1
use std.{component, model}
use kervan.system.{mcp, core}

capability McpRead  = component.read(mcp)
capability McpSrc   = component.write(mcp, "src", "test")
capability McpTest  = component.exec(mcp, test)
capability CoreRead = component.read(core)
capability CoreSrc  = component.write(core, "src")
capability Model    = model.infer(tier: standard)

type Patch = { files: List<Path> }

agent McpDev {
  caps   McpRead, McpSrc, McpTest, Model
  budget { steps: 10, time: 10m }
  skill change(task: Text) -> Inferred<Patch> ! {Fs.Read, Fs.Write, Exec, Model}
}

agent CoreDev {
  caps   CoreRead, CoreSrc, Model
  budget { steps: 10, time: 10m }
  skill change(task: Text) -> Inferred<Patch> ! {Fs.Read, Fs.Write, Model}
}

workflow Change(task: Text) -> Text
  caps McpRead, McpSrc, McpTest, CoreRead, CoreSrc, Model
{
  par {
    mcp_patch  = delegate McpDev.change(task)
    core_patch = delegate CoreDev.change(task)
  }
  "done"
}
`;
