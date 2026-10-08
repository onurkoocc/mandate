// Domain-separated SHA-256 hashes over JCS bytes (Doc 4 §3.4).
//
//   P = SHA256("mandate/program/0.1\n" || JCS(program))
//   D = SHA256("mandate/def/0.1\n"     || JCS(definition))
//
// The domain string carries the language version, so two versions can never
// read the same bytes with different meaning (§3.5). Hashes are identities,
// not authentication.

import { createHash } from "node:crypto";
import { canonicalize } from "./json/jcs.js";
import type { Json } from "./json/strict-json.js";

export const LANGUAGE = "mandate/0.1";

export type HashDomain = "program" | "def" | "package" | "run" | "action" | "operation" | "request";

export function domainHash(domain: HashDomain, value: Json): string {
  const h = createHash("sha256");
  h.update(`mandate/${domain}/0.1\n`, "utf8");
  h.update(canonicalize(value), "utf8");
  return "sha256:" + h.digest("hex");
}

export interface ProgramHashes {
  program: string;
  defs: Record<string, string>;
}

export function hashProgram(program: Json): ProgramHashes {
  const defs: Record<string, string> = {};
  if (program && typeof program === "object" && !Array.isArray(program)) {
    const d = program["defs"];
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const name of Object.keys(d).sort()) defs[name] = domainHash("def", d[name] as Json);
    }
  }
  return { program: domainHash("program", program), defs };
}
