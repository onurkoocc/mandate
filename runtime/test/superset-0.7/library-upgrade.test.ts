// The superset test of 0.7 (spec/attention.md "Version gating"): the suite of an upgrade of a library of 0.6, with its
// assertions as they are, on its program labelled mandate/0.7 (../relabel.ts); the library stays of 0.6.
import { runUnder } from "../relabel.js";

runUnder("mandate/0.7");
await import("../library-upgrade.test.js");
