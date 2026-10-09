// A Kervan change set for tests (design doc 9 §3; BACKLOG item 32, B4).

import { readFileSync } from "node:fs";

export const LAND = readFileSync(new URL("../../examples/kervan/programs/land.mdt", import.meta.url), "utf8");
