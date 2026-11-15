// The Rust side of the facade: every door-backed function (doors.ts) with the name and the signature of its
// TypeScript counterpart (ts.ts), answered by the door of the Rust compiler's module (wasm/call.ts).
//
// Its arguments become the door's input, one member a parameter, by the parameter's name: an argument that is
// undefined is left out (the door then takes the parameter's default, as the TypeScript does), a Set is sent as an
// array and a Map as an object, as the door contract writes them. The door's output becomes what the TypeScript
// function returns: a Map where it returns a Map (a span table), a Set where a Set, undefined where it returns
// undefined, members in the order the TypeScript gives them (the door writes them so).
//
// A door that refuses its input (`bad_input`) stands for the TypeScript function throwing on it: the function
// throws an Error with the door's message, which is the TypeScript's where a caller reads it (`checkSubprogram` and
// `checkAmendment` on a workflow with no envelope, whose message a sub-program's `check_failed` carries). Every
// other failure is a CompilerFailure (wasm/errors.ts), never an answer.
//
// What the request cannot carry is a CompilerFailure too (`unrepresentable`), and is never changed to fit, but in
// one place: a document given to `toMarkdown` or `toHtml` can hold text a model wrote, and a lone UTF-16 surrogate
// in it, which a request cannot hold, is sent as U+FFFD (the TypeScript writes it through as it is). That is the
// one difference of the rendering functions, named in compare.ts (`rendering-lone-surrogate`).

import type * as ts from "./ts.js";
import { DOOR_BACKED, type DoorBacked } from "./doors.js";
import { toWellFormed } from "./text.js";
import { rustCall } from "./wasm/call.js";
import { DoorRefusal } from "./wasm/errors.js";

type Output = (out: unknown, args: unknown[]) => unknown;
type Argument = (v: unknown) => unknown;

/** A function of the facade that asks `name`'s door: arguments by parameter, `prepare` per parameter, `output` after. */
function door<F>(name: DoorBacked, o: { prepare?: Record<string, Argument>; output?: Output } = {}): F {
  const { door: d, params } = DOOR_BACKED[name];
  const f = (...args: unknown[]): unknown => {
    const input: Record<string, unknown> = {};
    params.forEach((p, i) => {
      const v = args[i];
      if (v !== undefined) input[p] = o.prepare?.[p] ? o.prepare[p](v) : v;
    });
    let out: unknown;
    try {
      out = rustCall(d, input);
    } catch (e) {
      if (e instanceof DoorRefusal) throw new Error(e.detail);
      throw e;
    }
    return o.output ? o.output(out, args) : out;
  };
  Object.defineProperty(f, "name", { value: name });
  return f as F;
}

/** A Set or another iterable as the array the door takes. */
const asArray: Argument = (v) => (v instanceof Set || (typeof v === "object" && v !== null && !Array.isArray(v) && Symbol.iterator in v) ? [...(v as Iterable<unknown>)] : v);
/** A Map as the object the door takes, its entries in order. */
const asObject: Argument = (v) => (v instanceof Map ? Object.fromEntries(v) : v);
/** An object of the door's output as the Map the TypeScript returns, in the order of its members. */
const asMap = (v: unknown): Map<string, unknown> => new Map(Object.entries((v ?? {}) as Record<string, unknown>));
/** The door's `null` for what the TypeScript returns as undefined. */
const orUndefined: Output = (v) => (v === null ? undefined : v);
/** A result whose `spans` is a span table. */
const withSpans: Output = (v) => {
  const r = v as { spans?: unknown };
  return { ...r, spans: asMap(r.spans) };
};

/** Every string of a document well-formed: a lone surrogate as U+FFFD. Nothing else changes. */
export function wellFormed(v: unknown): unknown {
  if (typeof v === "string") return toWellFormed(v);
  if (Array.isArray(v)) return v.map(wellFormed);
  if (v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [toWellFormed(k), wellFormed(x)]));
  return v;
}

export const load = door<typeof ts.load>("load", { output: withSpans });
export const check = door<typeof ts.check>("check", { output: withSpans });
export const loadModules = door<typeof ts.loadModules>("loadModules");
export const parseStrictJson = door<typeof ts.parseStrictJson>("parseStrictJson", {
  output: (v) => {
    const r = v as { ok: boolean; value?: { value: unknown; spans: unknown } };
    return r.ok && r.value ? { ...r, value: { ...r.value, spans: asMap(r.value.spans) } } : r;
  },
});
export const canonicalize = door<typeof ts.canonicalize>("canonicalize");
export const hashProgram = door<typeof ts.hashProgram>("hashProgram");
export const packageHash = door<typeof ts.packageHash>("packageHash");
export const domainHash = door<typeof ts.domainHash>("domainHash");
export const printProgram = door<typeof ts.printProgram>("printProgram");
export const link = door<typeof ts.link>("link");
export const linkedProgram = door<typeof ts.linkedProgram>("linkedProgram");
export const references = door<typeof ts.references>("references", { output: (v) => new Set(v as string[]) });
export const rolesNamed = door<typeof ts.rolesNamed>("rolesNamed");
export const programRef = door<typeof ts.programRef>("programRef");
export const leadClasses = door<typeof ts.leadClasses>("leadClasses");
export const workflowBounds = door<typeof ts.workflowBounds>("workflowBounds");
export const capsOf = door<typeof ts.capsOf>("capsOf", { prepare: { within: asArray } });
export const showCap = door<typeof ts.showCap>("showCap");
export const governanceFiles = door<typeof ts.governanceFiles>("governanceFiles", { prepare: { files: asArray } });
export const skeleton = door<typeof ts.skeleton>("skeleton");
export const subprogramLinked = door<typeof ts.subprogramLinked>("subprogramLinked");
export const validateLock = door<typeof ts.validateLock>("validateLock");
export const roleLockChecks = door<typeof ts.roleLockChecks>("roleLockChecks", { prepare: { spans: asObject } });
export const sandboxLockChecks = door<typeof ts.sandboxLockChecks>("sandboxLockChecks");
export const bindingChecks = door<typeof ts.bindingChecks>("bindingChecks", { prepare: { spans: asObject } });
export const modelTiers = door<typeof ts.modelTiers>("modelTiers", { output: (v) => new Set(v as string[]) });
export const packagedLock = door<typeof ts.packagedLock>("packagedLock");
export const agentModels = door<typeof ts.agentModels>("agentModels");
export const sandboxRequirements = door<typeof ts.sandboxRequirements>("sandboxRequirements");
export const requirementFor = door<typeof ts.requirementFor>("requirementFor");
export const denialDiagnostics = door<typeof ts.denialDiagnostics>("denialDiagnostics", {
  // A report with no `program`: the TypeScript's E0104 has `report: undefined` in its facts, which the door leaves out.
  output: (v, [, report]) => {
    const ds = v as Array<{ code?: string; facts?: Record<string, unknown> }>;
    const r = report as { program?: unknown } | null | undefined;
    const one = ds.length === 1 ? ds[0] : undefined;
    if (r && typeof r === "object" && r.program === undefined && one?.code === "MDT-E0104" && one.facts && !("report" in one.facts)) one.facts = { report: undefined, ...one.facts };
    return ds;
  },
});
export const applyPatch = door<typeof ts.applyPatch>("applyPatch");
export const checkPatch = door<typeof ts.checkPatch>("checkPatch");
export const checkSubprogram = door<typeof ts.checkSubprogram>("checkSubprogram");
export const checkAmendment = door<typeof ts.checkAmendment>("checkAmendment");
export const semanticDiff = door<typeof ts.semanticDiff>("semanticDiff");
export const governanceChanges = door<typeof ts.governanceChanges>("governanceChanges");
export const envelopeChanges = door<typeof ts.envelopeChanges>("envelopeChanges");
export const grant = door<typeof ts.grant>("grant");
export const narrow = door<typeof ts.narrow>("narrow");
export const mapScopes = door<typeof ts.mapScopes>("mapScopes");
export const inFlightOverlap = door<typeof ts.inFlightOverlap>("inFlightOverlap");
export const architecture = door<typeof ts.architecture>("architecture");
export const architectureBlocks = door<typeof ts.architectureBlocks>("architectureBlocks");
export const authority = door<typeof ts.authority>("authority");
export const authorityBlocks = door<typeof ts.authorityBlocks>("authorityBlocks");
export const cost = door<typeof ts.cost>("cost");
export const programDoc = door<typeof ts.programDoc>("programDoc");
export const diffDoc = door<typeof ts.diffDoc>("diffDoc");
export const envelopeWorkflows = door<typeof ts.envelopeWorkflows>("envelopeWorkflows");
export const card = door<typeof ts.card>("card", { output: orUndefined });
export const cardDoc = door<typeof ts.cardDoc>("cardDoc", { output: orUndefined });
export const acsTarget = door<typeof ts.acsTarget>("acsTarget");
export const toMarkdown = door<typeof ts.toMarkdown>("toMarkdown", { prepare: { doc: wellFormed } });
export const toHtml = door<typeof ts.toHtml>("toHtml", { prepare: { doc: wellFormed } });
