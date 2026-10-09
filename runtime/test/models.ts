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
