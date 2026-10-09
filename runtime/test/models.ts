// Programs and the lock for the model adapter tests, offline and live.

import { readFileSync } from "node:fs";
import type { Lock } from "@mandate/compiler";

const FIXBUG_LOCK = JSON.parse(readFileSync(new URL("../../examples/fixbug/mandate.lock.json", import.meta.url), "utf8")) as Lock;
/** FixBug's lock (examples/fixbug/mandate.lock.json) as a package carries it. */
export const { lock: _format, ...LOCK } = FIXBUG_LOCK;

/** One model call under tier standard: a country's capital. */
export const ASK_CAPITAL = `mandate @ 0.2

module live.probe @ 0.1

use std.{model}

capability ModelStd = model.infer(tier: standard)

type Answer = { capital: Text }

workflow Ask(country: Text) -> Inferred<Answer>
  caps   ModelStd
  budget { spend: 1 USD, tokens: 200k }
{
  infer Answer from quote(country)
}
`;

/** An agent loop that reads a file and reports what it found, under tier standard. */
export const READ_LOOP = `mandate @ 0.2

module live.explorer @ 0.1

use std.{fs, model}

capability RepoRead = fs.read("/work/repo")
capability ModelStd = model.infer(tier: standard)

type Finding = { file: Path, line: Int where line >= 1, claim: Text }

agent Explorer {
  role   "Finds where the bug is, with evidence. Does not change code."
  caps   RepoRead, ModelStd
  budget { tokens: 300k, spend: 1 USD, steps: 6 }
  skill locate(issue: Text) -> Inferred<List<Finding>> ! {Fs.Read, Model}
}

workflow Locate(issue: Text) -> Inferred<List<Finding>>
  caps   RepoRead, ModelStd
  budget { spend: 1 USD }
{
  delegate Explorer.locate(issue)
}
`;
