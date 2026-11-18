// The superset test of 0.7 (spec/attention.md "Version gating"): the suite of `human.review` and waivers of 0.6, with
// its assertions as they are, on its programs labelled mandate/0.7 (../relabel.ts).
import { runUnder } from "../relabel.js";

runUnder("mandate/0.7");
await import("../review.test.js");
