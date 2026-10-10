// How an interface changed between two versions of its spec (design doc 9
// §4.2; BACKLOG item 33, B5). `test.contract` measures the change and
// compares it with what the plan declared: a change declared additive that
// is in fact breaking is `breaking_change_undeclared`.
//
// The rules take the consumer's side. What a consumer receives (a response, a
// tool's output, the server's metadata) may grow but not shrink; what a
// consumer sends (a request, a tool's input) may get looser but not
// stricter. Anything removed, renamed or retyped breaks someone.
//
//   openapi     paths and operations, parameters, request and response bodies
//   mcp_tools   tools, their input and output schemas
//   oauth       authorization server metadata (RFC 8414)
//   event       a JSON Schema of the event
//   db_schema   migration files: a new one is additive unless it drops or
//               renames; a changed or removed one is breaking (doc 9 §14 Q1:
//               a heuristic, stated as such in the evidence)

export type ChangeKind = "none" | "additive" | "breaking";

export interface SpecChange {
  kind: ChangeKind;
  /** What changed, one line each, `+` additive and `!` breaking. */
  changes: string[];
}

const RANK: Record<ChangeKind, number> = { none: 0, additive: 1, breaking: 2 };

export function worst(a: ChangeKind, b: ChangeKind): ChangeKind {
  return RANK[a] >= RANK[b] ? a : b;
}

/** Whether a declared kind covers a measured one: a declaration may overstate, never understate. */
export function covers(declared: ChangeKind, measured: ChangeKind): boolean {
  return RANK[declared] >= RANK[measured];
}

type J = null | boolean | number | string | J[] | { [k: string]: J };

class Collector {
  readonly changes: string[] = [];
  kind: ChangeKind = "none";
  add(text: string): void {
    this.changes.push(`+ ${text}`);
    this.kind = worst(this.kind, "additive");
  }
  breaks(text: string): void {
    this.changes.push(`! ${text}`);
    this.kind = "breaking";
  }
  result(): SpecChange {
    return { kind: this.kind, changes: this.changes };
  }
}

const isObj = (v: J | undefined): v is { [k: string]: J } => typeof v === "object" && v !== null && !Array.isArray(v);
const canon = (v: J | undefined): string => JSON.stringify(sortKeys(v ?? null));

function sortKeys(v: J): J {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k]!)]));
  return v;
}

/** Follows a local `$ref` (`#/components/schemas/X`, `#/$defs/X`) in `doc`. */
function deref(doc: J, s: J | undefined, seen = new Set<string>()): J | undefined {
  if (!isObj(s) || typeof s["$ref"] !== "string") return s;
  const ref = s["$ref"];
  if (!ref.startsWith("#/") || seen.has(ref)) return s;
  let cur: J | undefined = doc;
  for (const part of ref.slice(2).split("/")) cur = isObj(cur) ? cur[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined;
  return cur === undefined ? s : deref(doc, cur, new Set([...seen, ref]));
}

const typesOf = (s: { [k: string]: J }): string[] => (Array.isArray(s["type"]) ? (s["type"] as J[]).map(String) : typeof s["type"] === "string" ? [s["type"]] : []);

/**
 * A JSON Schema compared from one side of the boundary. `out`: the consumer
 * reads it (it may gain, not lose). `in`: the consumer writes it (it may
 * loosen, not tighten).
 */
function schema(c: Collector, at: string, dir: "in" | "out", aDoc: J, a0: J | undefined, bDoc: J, b0: J | undefined): void {
  const a = deref(aDoc, a0);
  const b = deref(bDoc, b0);
  if (canon(a) === canon(b)) return;
  if (!isObj(a) || !isObj(b)) {
    if (a === undefined) c.add(`${at} added`);
    else if (b === undefined) c.breaks(`${at} removed`);
    else c.breaks(`${at} changed`);
    return;
  }
  const ta = typesOf(a);
  const tb = typesOf(b);
  if (ta.length && tb.length && canon(ta) !== canon(tb)) {
    // Widening what may be sent is fine; widening what is received is not (and the reverse).
    const widened = ta.every((t) => tb.includes(t));
    const narrowed = tb.every((t) => ta.includes(t));
    if (dir === "in" && widened) c.add(`${at} accepts ${tb.join("|")}`);
    else if (dir === "out" && narrowed) c.add(`${at} is now ${tb.join("|")}`);
    else c.breaks(`${at} type ${ta.join("|")} → ${tb.join("|")}`);
  }
  if (Array.isArray(a["enum"]) || Array.isArray(b["enum"])) {
    const ea = (a["enum"] as J[] | undefined) ?? [];
    const eb = (b["enum"] as J[] | undefined) ?? [];
    const gone = ea.filter((x) => !eb.some((y) => canon(x) === canon(y)));
    const added = eb.filter((x) => !ea.some((y) => canon(x) === canon(y)));
    // A consumer that sends a value the provider dropped breaks; one that receives a value it never saw may too.
    if (gone.length) (dir === "in" ? c.breaks.bind(c) : c.add.bind(c))(`${at} no longer has ${gone.map((x) => JSON.stringify(x)).join(", ")}`);
    if (added.length) (dir === "out" ? c.breaks.bind(c) : c.add.bind(c))(`${at} gains ${added.map((x) => JSON.stringify(x)).join(", ")}`);
  }
  const pa = isObj(a["properties"]) ? a["properties"] : {};
  const pb = isObj(b["properties"]) ? b["properties"] : {};
  const ra = new Set(Array.isArray(a["required"]) ? (a["required"] as J[]).map(String) : []);
  const rb = new Set(Array.isArray(b["required"]) ? (b["required"] as J[]).map(String) : []);
  for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
    const p = `${at}.${k}`;
    if (!(k in pb)) {
      if (dir === "out") c.breaks(`${p} removed`);
      else if (ra.has(k)) c.add(`${p} no longer required`);
      else if (b["additionalProperties"] === false) c.breaks(`${p} removed; sending it is now refused`);
      else c.add(`${p} removed`);
    } else if (!(k in pa)) {
      if (dir === "in" && rb.has(k)) c.breaks(`${p} added and required`);
      else c.add(`${p} added`);
    } else schema(c, p, dir, aDoc, pa[k], bDoc, pb[k]);
  }
  for (const k of rb) {
    if (ra.has(k) || !(k in pa)) continue;
    if (dir === "in") c.breaks(`${at}.${k} now required`);
    else c.add(`${at}.${k} now always present`);
  }
  for (const k of ra) {
    if (rb.has(k) || !(k in pb)) continue;
    if (dir === "out") c.breaks(`${at}.${k} no longer always present`);
    else c.add(`${at}.${k} no longer required`);
  }
  if ("items" in a || "items" in b) schema(c, `${at}[]`, dir, aDoc, a["items"], bDoc, b["items"]);
  for (const bound of ["maxLength", "maximum", "maxItems"] as const) {
    const x = a[bound];
    const y = b[bound];
    if (typeof x === "number" && typeof y === "number" && x !== y) (dir === "in" && y < x ? c.breaks.bind(c) : c.add.bind(c))(`${at} ${bound} ${x} → ${y}`);
  }
  for (const bound of ["minLength", "minimum", "minItems"] as const) {
    const x = a[bound];
    const y = b[bound];
    if (typeof x === "number" && typeof y === "number" && x !== y) (dir === "in" && y > x ? c.breaks.bind(c) : c.add.bind(c))(`${at} ${bound} ${x} → ${y}`);
  }
  if (a["pattern"] !== b["pattern"] && (a["pattern"] !== undefined || b["pattern"] !== undefined)) (dir === "in" && b["pattern"] !== undefined ? c.breaks.bind(c) : c.add.bind(c))(`${at} pattern changed`);
}

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

export function diffOpenApi(a0: unknown, b0: unknown): SpecChange {
  const a = a0 as J;
  const b = b0 as J;
  const c = new Collector();
  const pa = isObj(a) && isObj(a["paths"]) ? a["paths"] : {};
  const pb = isObj(b) && isObj(b["paths"]) ? b["paths"] : {};
  for (const path of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort()) {
    const oa = pa[path];
    const ob = pb[path];
    if (!isObj(ob)) {
      c.breaks(`${path} removed`);
      continue;
    }
    if (!isObj(oa)) {
      c.add(`${path} added`);
      continue;
    }
    for (const m of METHODS) {
      const x = oa[m];
      const y = ob[m];
      const op = `${m.toUpperCase()} ${path}`;
      if (!isObj(x) && !isObj(y)) continue;
      if (!isObj(y)) c.breaks(`${op} removed`);
      else if (!isObj(x)) c.add(`${op} added`);
      else operation(c, op, a, x, b, y);
    }
  }
  return c.result();
}

function operation(c: Collector, op: string, aDoc: J, a: { [k: string]: J }, bDoc: J, b: { [k: string]: J }): void {
  const params = (o: { [k: string]: J }, doc: J): Map<string, { [k: string]: J }> =>
    new Map(
      (Array.isArray(o["parameters"]) ? o["parameters"] : [])
        .map((p) => deref(doc, p))
        .filter(isObj)
        .map((p) => [`${String(p["in"])}:${String(p["name"])}`, p]),
    );
  const xa = params(a, aDoc);
  const xb = params(b, bDoc);
  for (const [k, p] of xb) {
    const old = xa.get(k);
    if (!old) (p["required"] === true ? c.breaks.bind(c) : c.add.bind(c))(`${op} parameter ${k} added${p["required"] === true ? " and required" : ""}`);
    else {
      if (p["required"] === true && old["required"] !== true) c.breaks(`${op} parameter ${k} now required`);
      schema(c, `${op} parameter ${k}`, "in", aDoc, old["schema"], bDoc, p["schema"]);
    }
  }
  for (const [k] of xa) if (!xb.has(k)) c.breaks(`${op} parameter ${k} removed`);
  const body = (o: { [k: string]: J }, doc: J): J | undefined => {
    const rb = deref(doc, o["requestBody"]);
    const content = isObj(rb) && isObj(rb["content"]) ? rb["content"] : {};
    const json = content["application/json"];
    return isObj(json) ? json["schema"] : undefined;
  };
  schema(c, `${op} request body`, "in", aDoc, body(a, aDoc), bDoc, body(b, bDoc));
  const responses = (o: { [k: string]: J }): { [k: string]: J } => (isObj(o["responses"]) ? o["responses"] : {});
  const ra = responses(a);
  const rb = responses(b);
  for (const status of [...new Set([...Object.keys(ra), ...Object.keys(rb)])].sort()) {
    const sa = deref(aDoc, ra[status]);
    const sb = deref(bDoc, rb[status]);
    if (!isObj(sb)) {
      c.add(`${op} no longer answers ${status}`);
      continue;
    }
    if (!isObj(sa)) {
      // A consumer that does not know the status meets something new.
      c.breaks(`${op} answers ${status}`);
      continue;
    }
    const sch = (r: { [k: string]: J }): J | undefined => {
      const content = isObj(r["content"]) ? r["content"] : {};
      const json = content["application/json"];
      return isObj(json) ? json["schema"] : undefined;
    };
    schema(c, `${op} ${status} body`, "out", aDoc, sch(sa), bDoc, sch(sb));
  }
}

export function diffMcpTools(a0: unknown, b0: unknown): SpecChange {
  const a = a0 as J;
  const b = b0 as J;
  const c = new Collector();
  const tools = (d: J): Map<string, { [k: string]: J }> => new Map((isObj(d) && Array.isArray(d["tools"]) ? d["tools"] : []).filter(isObj).map((t) => [String(t["name"]), t]));
  const ta = tools(a);
  const tb = tools(b);
  for (const [name, t] of tb) {
    const old = ta.get(name);
    if (!old) {
      c.add(`tool ${name} added`);
      continue;
    }
    schema(c, `tool ${name} input`, "in", old, old["inputSchema"], t, t["inputSchema"]);
    schema(c, `tool ${name} output`, "out", old, old["outputSchema"], t, t["outputSchema"]);
  }
  for (const [name] of ta) if (!tb.has(name)) c.breaks(`tool ${name} removed`);
  return c.result();
}

/** RFC 8414 metadata: endpoints and identity must stay; what is supported may grow. */
export function diffOauth(a0: unknown, b0: unknown): SpecChange {
  const a = a0 as J;
  const b = b0 as J;
  const c = new Collector();
  const ma = isObj(a) ? a : {};
  const mb = isObj(b) ? b : {};
  for (const k of [...new Set([...Object.keys(ma), ...Object.keys(mb)])].sort()) {
    const x = ma[k];
    const y = mb[k];
    if (canon(x) === canon(y)) continue;
    if (Array.isArray(x) || Array.isArray(y)) {
      const xs = (Array.isArray(x) ? x : []).map((v) => canon(v));
      const ys = (Array.isArray(y) ? y : []).map((v) => canon(v));
      const gone = xs.filter((v) => !ys.includes(v));
      const added = ys.filter((v) => !xs.includes(v));
      if (gone.length) c.breaks(`${k} no longer has ${gone.join(", ")}`);
      if (added.length) c.add(`${k} gains ${added.join(", ")}`);
    } else if (x === undefined) c.add(`${k} added`);
    else if (y === undefined) c.breaks(`${k} removed`);
    else c.breaks(`${k} ${JSON.stringify(x)} → ${JSON.stringify(y)}`);
  }
  return c.result();
}

export function diffEvent(a0: unknown, b0: unknown): SpecChange {
  const a = a0 as J;
  const b = b0 as J;
  const c = new Collector();
  schema(c, "event", "out", a, a, b, b);
  return c.result();
}

/** Migration files by name: content. */
export function diffMigrations(a: Record<string, string>, b: Record<string, string>): SpecChange {
  const c = new Collector();
  for (const f of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!(f in b)) c.breaks(`migration ${f} removed`);
    else if (!(f in a)) {
      const sql = b[f]!.toLowerCase();
      if (/\bdrop\s+(table|column|view|index|constraint|type|schema)\b|\brename\s+(to|column)\b|\balter\s+column\b[^;]*\btype\b/.test(sql)) c.breaks(`migration ${f} drops, renames or retypes something`);
      else c.add(`migration ${f} added`);
    } else if (a[f] !== b[f]) c.breaks(`migration ${f} changed after it was applied`);
  }
  return c.result();
}

export function diffSpec(protocol: string, a: unknown, b: unknown): SpecChange {
  switch (protocol) {
    case "openapi":
      return diffOpenApi(a, b);
    case "mcp_tools":
      return diffMcpTools(a, b);
    case "oauth":
      return diffOauth(a, b);
    case "event":
      return diffEvent(a, b);
  }
  throw new Error(`no spec diff for protocol ${protocol}`);
}
