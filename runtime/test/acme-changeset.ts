// A Acme change set for tests (design doc 9 §3; BACKLOG item 32, B4).

import { readFileSync } from "node:fs";

export const LAND = readFileSync(new URL("../../fixtures/system/land.mdt", import.meta.url), "utf8");
