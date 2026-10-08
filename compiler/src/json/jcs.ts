// RFC 8785 JSON Canonicalization Scheme (JCS) for the IR value domain.
//
// Object members are sorted by the UTF-16 code units of their names, strings
// use the ECMAScript JSON string serialization, and numbers use the
// ECMAScript number-to-string conversion. The IR only admits safe integers
// (see strict-json.ts), so the number case is the integer case. JCS does no
// Unicode normalization, and neither does this function (S10, S11).

import type { Json } from "./strict-json.js";

export function canonicalize(value: Json): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new Error(`Non-canonical IR number: ${value}`);
      }
      return String(value);
    case "string":
      return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalize).join(",") + "]";
  const keys = Object.keys(value).sort(compareUtf16);
  const parts: string[] = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ":" + canonicalize(v));
  }
  return "{" + parts.join(",") + "}";
}

/** Orders strings by UTF-16 code units, as RFC 8785 §3.2.3 requires. */
export function compareUtf16(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
