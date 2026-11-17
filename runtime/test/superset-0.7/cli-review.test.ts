// The superset test of 0.7 (spec/attention.md "Version gating"): the suite of `mandate review` of 0.6, with its
// assertions as they are, on its program labelled mandate/0.7 (../relabel.ts).
import { runUnder } from "../relabel.js";

runUnder("mandate/0.7");
await import("../cli-review.test.js");
