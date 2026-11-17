// The attention facts at run time (spec/attention.md "The stored facts", "Events"; language 0.7).
//
// At the start of a run of a 0.7 package the runtime asks the compiler for the attention facts of the workflow it
// starts (the door `attention_facts`, given what the check at load was given) and stores them with the run, an artifact
// of media type ATTENTION_MEDIA_TYPE named by its digest as `attention` in the run's manifest. A resume and a replay read
// that copy and never ask again: a compiler upgraded while a run goes on does not change what the run shows. A copy that
// is missing, or does not hash to what the manifest names, stops the run (`facts_mismatch`). A lead's sub-program whose
// running program holds a stage or a report has its facts stored at its admission in the same way, named by the
// admission.
//
// The facts are kept whole, as the door gives them: a later slice of the compiler adds members (the question sites,
// the totals) under the same format, and they are stored and hashed with the rest. What a run reads of them is a
// report's role, title and fields (`class`, `known`, `type`), and a stage's name, title and index, each by the path of
// its statement in the running program.

import { attentionFacts, canonicalize, checkSubprogram, isProgram07OrLater, type AttentionFacts, type AttentionFactsInput, type AttentionReport, type Json, type Program, type SubprogramCheck06, type SubprogramInput } from "@mandate/bridge";
import { CompilerFailure } from "@mandate/bridge/mode";
import { refOf, sha256Of, type ArtifactScope, type ArtifactStore } from "./artifacts.js";
import { Violation } from "./signals.js";
import { canonical, type Value } from "./values.js";

/** The media type of stored attention facts (spec/attention.md "The stored facts"). */
export const ATTENTION_MEDIA_TYPE = "application/vnd.mandate.attention+json";

/** The format the facts are of. */
export const ATTENTION_FORMAT = "mandate/attention/0.1";

/** A report field's value whose canonical form is longer than this, in bytes, is written `{ "$omitted": { "bytes": n } }`. */
export const MAX_REPORT_VALUE = 64 * 1024;

/** What the door is given of a package, as the check at load was given it: all of its input but the workflow. */
export type FactsSource = Omit<AttentionFactsInput, "workflow">;

/** The facts as a run stores them: their canonical bytes, and the digest of those, which names them. */
export interface StoredFacts {
  facts: AttentionFacts;
  bytes: string;
  digest: string;
}

/** The facts with their bytes and digest, as stored. */
export function stored(facts: AttentionFacts): StoredFacts {
  const bytes = canonical(facts as unknown as Value);
  return { facts, bytes, digest: sha256Of(bytes) };
}

/** The door, as the runtime asks it: a seam a test may stand another in for (`Runtime.attentionFacts`). */
export type FactsDoor = (input: AttentionFactsInput) => AttentionFacts | null;

/**
 * The facts of `workflow` at the start of a run: asked of `door` with what the check at load was given. A door that
 * gives none, gives what is not the facts of that workflow, or refuses, refuses the start (`load_verification_failed`):
 * a run of 0.7 never starts without its facts. A compiler that fails is thrown on, as at load.
 */
export function factsAtStart(door: FactsDoor, source: FactsSource, workflow: string): StoredFacts {
  let facts: AttentionFacts | null;
  try {
    facts = door({ ...source, workflow });
  } catch (e) {
    if (e instanceof CompilerFailure) throw e;
    throw new Violation("load_verification_failed", `The compiler could not give the attention facts of ${workflow}, so it is not started: ${e instanceof Error ? e.message : String(e)}.`);
  }
  const why = factsProblem(facts, workflow);
  if (why) throw new Violation("load_verification_failed", `The compiler gave ${why} for ${workflow}, so it is not started: a run of 0.7 starts with the attention facts of its workflow (spec/attention.md "The stored facts").`);
  return stored(facts!);
}

/** What makes `facts` not the facts of `workflow`, as a message names it, or undefined. */
function factsProblem(facts: AttentionFacts | null, workflow: string): string | undefined {
  if (facts === null || typeof facts !== "object" || Array.isArray(facts)) return "no attention facts";
  if (facts.format !== ATTENTION_FORMAT) return `attention facts of format ${String(facts.format)}, not ${ATTENTION_FORMAT},`;
  if (facts.workflow !== workflow) return `the attention facts of ${String(facts.workflow)}`;
  if (!Array.isArray(facts.stages) || !Array.isArray(facts.reports)) return "attention facts without their stages and reports";
  return undefined;
}

/**
 * The facts stored with a run or a sub-program, by the digest that names them. One that is missing, or whose bytes do
 * not hash to the digest, or do not read as facts, is `facts_mismatch`: what was stored at the start is what the run
 * shows, and nothing is made again (`what` names whose they are, for the message).
 */
export async function readFacts(artifacts: ArtifactStore, scope: ArtifactScope, digest: unknown, what: string): Promise<AttentionFacts> {
  const refused = (why: string): Violation => new Violation("facts_mismatch", `${what} names the attention facts ${String(digest)}, and ${why}: a run shows what the facts stored at its start say, and no others (spec/attention.md "The stored facts").`);
  if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw refused("that is not a digest");
  let got: { bytes: Uint8Array; media_type: string; digest: string };
  try {
    got = await artifacts.get(scope, refOf(digest));
  } catch (e) {
    if (!(e instanceof Violation)) throw e;
    throw refused(e.code === "artifact_not_found" ? "none are stored with it" : "the bytes stored do not hash to it");
  }
  if (got.media_type !== ATTENTION_MEDIA_TYPE) throw refused(`what is stored under it is ${got.media_type}`);
  let facts: AttentionFacts;
  try {
    facts = JSON.parse(new TextDecoder().decode(got.bytes)) as AttentionFacts;
  } catch {
    throw refused("what is stored does not read");
  }
  if (factsProblem(facts, String((facts as { workflow?: unknown } | null)?.workflow)) !== undefined) throw refused("what is stored is not attention facts");
  return facts;
}

/**
 * Whether the workflow `workflow` of a program holds a `stage` or a `report` statement (0.7). A stage stands only at
 * the top of a workflow's body and a report in no function (E1901, E1905), so the workflow's own definition holds
 * every one its run can meet.
 */
export function holdsAttention(program: Program | undefined, workflow: string): boolean {
  let found = false;
  const walk = (v: unknown, depth: number): void => {
    if (found || depth > 512 || typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (o["op"] === "stage" || o["op"] === "report") found = true;
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  if (program && typeof program.defs === "object" && program.defs !== null && Object.hasOwn(program.defs, workflow)) walk(program.defs[workflow], 0);
  return found;
}

/**
 * A lead's sub-program checked as the runtime's checker checks it (plan-worker.ts): `checkSubprogram`, and, for an
 * admitted sub-program of a parent of 0.7 whose workflow runs a stage or a report (through the expansion of a shape),
 * its attention facts (`attention`, null when the door gives none), which its admission stores.
 */
export function checkedSubprogram(input: SubprogramInput, door: FactsDoor = attentionFacts): SubprogramCheck06 & { attention?: AttentionFacts | null } {
  const r = checkSubprogram(input) as SubprogramCheck06;
  if (!r.ok || !r.program || !r.workflow || !isProgram07OrLater(input.parent)) return r;
  if (!holdsAttention((r.running ?? r.program) as Program, r.workflow)) return r;
  return { ...r, attention: subprogramFacts(door, input, r) };
}

/**
 * The facts of a lead's admitted sub-program (0.7), asked of the door as the check of a sub-program checks it: the
 * sub-program opened onto its parent (its `use` of the parent names every definition the parent has), with the
 * parent among the modules, and the claim of its envelope and of its lead. Given only for a sub-program whose
 * running program holds a stage or a report: null when the door gives none, or refuses.
 */
export function subprogramFacts(door: FactsDoor, input: SubprogramInput, checked: SubprogramCheck06): AttentionFacts | null {
  const { parent } = input;
  const sub = checked.program!;
  const view = { ...sub, uses: [...(parent.uses ?? []), { module: parent.module, names: Object.keys(parent.defs).sort() }] };
  const wf = Object.hasOwn(parent.defs, input.workflow) ? parent.defs[input.workflow] : undefined;
  const envelope = wf?.kind === "workflow" ? wf.envelope : undefined;
  try {
    const facts = door({ text: canonicalize(view as unknown as Json), kind: "json", opts: { modules: { ...(input.modules ?? {}), [parent.module]: parent }, claim: { envelope: (envelope ?? null) as unknown as Record<string, unknown>, lead: input.lead } }, workflow: checked.workflow! });
    return factsProblem(facts, checked.workflow!) === undefined ? facts : null;
  } catch (e) {
    if (e instanceof CompilerFailure) throw e;
    return null;
  }
}

/** The facts of a report's node, held to the statement the run runs: its role, title and the names of its fields in order. */
export function reportFacts(facts: AttentionFacts | undefined, node: string, s: { role: string; title: string; fields: Array<{ name: string }> }, where: string): AttentionReport {
  const refused = (why: string): Violation => new Violation("facts_mismatch", `The report at ${where} ${why}: a report is shown with the class, level and type of its fields that the facts stored at the run's start give, and no others (spec/attention.md "The stored facts").`);
  if (!facts) throw refused("is in a run that stored no attention facts");
  const r = facts.reports.find((x) => x.path === node);
  if (!r) throw refused(`has no entry in the stored facts (${node})`);
  if (r.role !== s.role || r.title !== s.title) throw refused(`is to ${s.role}, "${s.title}", and the stored facts say ${String(r.role)}, "${String(r.title)}"`);
  const names = s.fields.map((f) => f.name);
  const known = Array.isArray(r.fields) ? r.fields.map((f) => f?.name) : [];
  if (names.length !== known.length || names.some((n, i) => n !== known[i])) throw refused(`has the fields ${names.join(", ")}, and the stored facts ${known.join(", ")}`);
  return r;
}

/** A stage held to the stored facts at its node: its name, title and index. */
export function stageFacts(facts: AttentionFacts | undefined, node: string, s: { name: string; title: string; index: number }, where: string): void {
  const refused = (why: string): Violation => new Violation("facts_mismatch", `The stage at ${where} ${why} (spec/attention.md "The stored facts").`);
  if (!facts) throw refused("is in a run that stored no attention facts");
  const f = facts.stages.find((x) => x.path === node);
  if (!f) throw refused(`has no entry in the stored facts (${node})`);
  if (f.name !== s.name || f.title !== s.title || f.index !== s.index) throw refused(`is ${s.name} "${s.title}" at ${s.index}, and the stored facts say ${String(f.name)} "${String(f.title)}" at ${String(f.index)}`);
}

/** A report field's value as the event carries it: whole, or `{ "$omitted": { "bytes": n } }` when its canonical form is longer than MAX_REPORT_VALUE. */
export function reportValue(v: Value): Value {
  const bytes = new TextEncoder().encode(canonical(v)).length;
  return bytes > MAX_REPORT_VALUE ? { $omitted: { bytes } } : v;
}
