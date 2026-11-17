// The superset test of 0.7 (spec/attention.md "Version gating"): the suite of a package of 0.6 at load and at run time,
// with its assertions as they are, on its programs labelled mandate/0.7 (../relabel.ts); its libraries stay of 0.6.
import { runUnder } from "../relabel.js";

runUnder("mandate/0.7");
await import("../library.test.js");
