// A host whose tools the tests decide (spec/boundary.md "Host fitness"), so
// that a lock's `host` can be met or fallen short of without a `bwrap`.

import type { HostProbe, HostTool, ToolReading } from "../src/fitness.js";

/** A host whose tools read as `readings` says; it records what it was asked. */
export class FakeHost implements HostProbe {
  readonly asked: HostTool[] = [];
  constructor(public readings: Partial<Record<HostTool, ToolReading>>) {}
  async read(tool: HostTool): Promise<ToolReading> {
    this.asked.push(tool);
    const r = this.readings[tool];
    if (!r) throw new Error(`no reading for ${tool}`);
    return r;
  }
}

/** The readings of a host that meets `HOST`. */
export const FIT: Partial<Record<HostTool, ToolReading>> = { node: { output: "22.23.4" }, bwrap: { output: "bubblewrap 0.11.0\n", path: "/usr/bin/bwrap", setuid: false } };

/** A lock's least versions that a `FIT` host just meets. */
export const HOST = { node: "22.23.4", bwrap: "0.11.0" };
