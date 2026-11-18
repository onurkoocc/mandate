// Whether two results are the same value, as a caller can tell them apart: the same kind at every place (a Map, a
// Set, an array, a plain object, undefined), the same members in the same order, a member that is there with the
// value undefined told apart from one that is not there, a Map's and a Set's entries in their order. Numbers compare
// with `===` (so 0 and -0 are the same: JSON has no -0, and no caller reads the sign of a zero).

/** Where `a` and `b` first differ, as a JSON Pointer and what each has there; undefined when they are the same. */
export function difference(a: unknown, b: unknown, at = ""): string | undefined {
  if (a === b) return undefined;
  const ka = kind(a);
  const kb = kind(b);
  if (ka !== kb) return `${at || "/"}: ${ka} ${shown(a)} against ${kb} ${shown(b)}`;
  switch (ka) {
    case "number":
      return Number.isNaN(a) && Number.isNaN(b) ? undefined : `${at || "/"}: ${shown(a)} against ${shown(b)}`;
    case "array": {
      const x = a as unknown[];
      const y = b as unknown[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const d = difference(x[i], y[i], `${at}/${i}`);
        if (d) return d;
      }
      return x.length === y.length ? undefined : `${at || "/"}: ${x.length} items against ${y.length}`;
    }
    case "Map":
    case "Set": {
      const x = [...(a as Map<unknown, unknown> | Set<unknown>).entries()];
      const y = [...(b as Map<unknown, unknown> | Set<unknown>).entries()];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i]![0] !== y[i]![0]) return `${at}/${i}: ${ka} key ${shown(x[i]![0])} against ${shown(y[i]![0])}`;
        const d = difference(x[i]![1], y[i]![1], `${at}/${token(String(x[i]![0]))}`);
        if (d) return d;
      }
      return x.length === y.length ? undefined : `${at || "/"}: ${ka} of ${x.length} against ${y.length}`;
    }
    case "object": {
      const x = Object.keys(a as object);
      const y = Object.keys(b as object);
      if (x.join("\u0000") !== y.join("\u0000")) {
        const only = (p: string[], q: string[]): string[] => p.filter((k) => !q.includes(k));
        const ox = only(x, y);
        const oy = only(y, x);
        return `${at || "/"}: members ${ox.length || oy.length ? `${JSON.stringify(ox)} only on the left, ${JSON.stringify(oy)} only on the right` : `in another order: ${JSON.stringify(x)} against ${JSON.stringify(y)}`}`;
      }
      for (const k of x) {
        const d = difference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${at}/${token(k)}`);
        if (d) return d;
      }
      return undefined;
    }
    default:
      return `${at || "/"}: ${shown(a)} against ${shown(b)}`;
  }
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Map) return "Map";
  if (v instanceof Set) return "Set";
  if (typeof v === "object") {
    const p = Object.getPrototypeOf(v);
    return p === Object.prototype || p === null ? "object" : `instance of ${(v as { constructor?: { name?: string } }).constructor?.name ?? "?"}`;
  }
  return typeof v;
}

const token = (k: string): string => k.replaceAll("~", "~0").replaceAll("/", "~1");

function shown(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(v.length > 120 ? `${v.slice(0, 120)}…` : v);
  try {
    const t = JSON.stringify(v, (_k, x: unknown) => (x instanceof Map ? Object.fromEntries(x) : x instanceof Set ? [...x] : x));
    return t === undefined ? String(v) : t.length > 160 ? `${t.slice(0, 160)}…` : t;
  } catch {
    return String(v);
  }
}
