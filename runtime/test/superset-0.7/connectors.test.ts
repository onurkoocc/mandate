// The superset test of 0.7 (spec/attention.md "Version gating"): the suite of connectors at run time of 0.6, with its
// assertions as they are, on its programs labelled mandate/0.7 (../relabel.ts); its library stays of 0.6. What a package
// of 0.7 does differently with connectors (which it binds, and how it digests a tool) is in ../attention-connectors.test.ts.
import { runUnder } from "../relabel.js";

runUnder("mandate/0.7");
await import("../connectors.test.js");
