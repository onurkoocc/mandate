// Domain-separated SHA-256 hashes over JCS bytes (Doc 4 §3.4).
//
//   P = SHA256("mandate/program/<v>\n" || JCS(program))
//   D = SHA256("mandate/def/<v>\n"     || JCS(definition))
//
// <v> is the program's language version (0.1 or 0.2), so two versions can
// never read the same bytes with different meaning (§3.5): a definition that
// means something else in 0.2 hashes differently there. The runtime's own
// domains (package, run, action, operation, request) use the 0.1 hash
// profile. Hashes are identities, not authentication.

import { createHash } from "node:crypto";
import { canonicalize } from "./json/jcs.js";
import type { Json } from "./json/strict-json.js";

export type HashDomain = "program" | "def" | "package" | "run" | "action" | "operation" | "request" | "binding";

export function domainHash(domain: HashDomain, value: Json, version = "0.1"): string {
  const h = createHash("sha256");
  h.update(`mandate/${domain}/${version}\n`, "utf8");
  h.update(canonicalize(value), "utf8");
  return "sha256:" + h.digest("hex");
}

export interface ProgramHashes {
  program: string;
  defs: Record<string, string>;
}

export function hashProgram(program: Json): ProgramHashes {
  const defs: Record<string, string> = {};
  let version = "0.1";
  if (program && typeof program === "object" && !Array.isArray(program)) {
    const lang = program["language"];
    if (typeof lang === "string" && lang.startsWith("mandate/")) version = lang.slice("mandate/".length);
    const d = program["defs"];
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const name of Object.keys(d).sort()) defs[name] = domainHash("def", d[name] as Json, version);
    }
  }
  return { program: domainHash("program", program, version), defs };
}
