// Diagnostic codes implemented so far, with a one-line explanation each
// (`mandate explain`). Families follow Doc 4 Appendix B; codes inside E01xx
// that the design document leaves open are assigned here and listed in
// spec/diagnostics.md.

export const CODES: Record<string, { title: string; explain: string }> = {
  "MDT-E0101": {
    title: "Syntax error",
    explain: "The .mdt text could not be read: an invalid token, a missing delimiter, or a reserved keyword used as a name.",
  },
  "MDT-E0102": {
    title: "Duplicate JSON key",
    explain: "An IR object repeats a key. JSON parsers disagree on which copy wins, so the IR rejects the input before schema validation (S01).",
  },
  "MDT-E0103": {
    title: "Unsupported language version",
    explain: "The `language` field is missing or names a version this compiler does not read. Versions are never loaded on a best-effort basis; migrate explicitly (S02, §3.5).",
  },
  "MDT-E0104": {
    title: "IR schema violation",
    explain: "The IR does not match the closed schema in spec/ir.schema.json: an unknown field, a missing field, or a value of the wrong shape (S02).",
  },
  "MDT-E0105": {
    title: "Resource limit exceeded",
    explain: "The program exceeds a 0.1 reference-profile limit: 1 MiB of source, JSON depth 64, or 64 definitions (§3.4).",
  },
  "MDT-E0106": {
    title: "Number not representable",
    explain: "IR numbers are integers within ±(2^53−1). Fractions and exponents are rejected rather than rounded; write decimals as strings and money as integer micro-units (S11).",
  },
  "MDT-E0107": {
    title: "Invalid Unicode",
    explain: "A string holds a lone UTF-16 surrogate, which has no canonical encoding. Text is never normalized silently (S11).",
  },
  "MDT-E0108": {
    title: "Malformed JSON",
    explain: "The input is not well-formed JSON.",
  },
  "MDT-E0120": {
    title: "Unresolved name",
    explain: "A reference names no type, capability, agent, skill, contract, effect or variable in scope (S03). When one close match exists, the diagnostic carries a repair patch.",
  },
  "MDT-E0121": {
    title: "Duplicate name",
    explain: "Two definitions, parameters, fields, skills, criteria or branches in the same scope share a name.",
  },
  "MDT-E0130": {
    title: "Stale base",
    explain: "An IR patch was written against a program hash that is no longer current. Re-read the program and rebase the patch (S12).",
  },
  "MDT-E0131": {
    title: "Patch cannot be applied",
    explain: "An IR patch operation is unsupported or its path does not exist in the program.",
  },
};
