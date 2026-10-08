// Fault injection for Gate 2 (Doc 4 §25: "failure moments are reproducible").
// A test arms a named point; when execution reaches it, the worker "dies"
// with a Crash, exactly as if the process had stopped there.
//
//   after_dispatch   dispatch recorded and budget reserved, adapter not called
//   before_record    adapter returned, result not journaled
//   after_record     result journaled
//   after_commit     authorization consumed and outbox written, adapter not called
//   after_execute    adapter returned, action result not recorded

import { Crash } from "./signals.js";

export type FaultPoint = "after_dispatch" | "before_record" | "after_record" | "after_commit" | "after_execute";

export interface FaultInfo {
  id: string;
  kind: string;
}

export class Faults {
  private readonly armed: Array<{ point: FaultPoint; when: (i: FaultInfo) => boolean }> = [];

  /** Crash once at `point`, optionally only for commands matching `when`. */
  arm(point: FaultPoint, when: (i: FaultInfo) => boolean = () => true): this {
    this.armed.push({ point, when });
    return this;
  }

  check(point: FaultPoint, info: FaultInfo): void {
    const i = this.armed.findIndex((a) => a.point === point && a.when(info));
    if (i < 0) return;
    this.armed.splice(i, 1);
    throw new Crash(`${point} ${info.id}`);
  }
}
