// Turns the parser's node→span table into a JSON-Pointer→span table, the same
// shape the strict JSON reader produces, so later phases treat text and JSON
// input alike.

import { ptrToken, type Span } from "../diag.js";

export function sourceMap(root: object, spans: WeakMap<object, Span>): Map<string, Span> {
  const out = new Map<string, Span>();
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    const s = spans.get(node);
    if (s) out.set(path, s);
    if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}/${i}`));
    else for (const [k, v] of Object.entries(node)) walk(v, `${path}/${ptrToken(k)}`);
  };
  walk(root, "");
  return out;
}
