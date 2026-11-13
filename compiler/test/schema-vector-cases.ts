// The bases and the mutations the invalid-IR vectors are built from (compiler/test/schema-vectors.test.ts).
//
// A base is one definition (or a few) of a program the golden file pins, wrapped as the smallest program;
// schema validation is structural, so a base only has to pass `validateIr`. A few bases are written here for the
// forms no golden program uses (set, spawn, await, try, block, run, and fields such as `generics`, `pub`).
// A case is a base and edits at pointers; the operators are in schema-vector-support.ts.

import type { Json } from "../src/json/strict-json.js";
import { add, asKind, dup, empty, remove, rename, set, type Edit, type Mut } from "./schema-vector-support.js";

/** A definition of a golden program, by the program's source path and the definition's name. */
export interface GoldenBase {
  id: string;
  source: string;
  defs: string[];
}
/** A base written out. */
export interface ManualBase {
  id: string;
  program: { [k: string]: Json };
}

const syntax = (n: string): string => `compiler/test/fixtures/syntax/${n}.mdt`;

export const GOLDEN_BASES: GoldenBase[] = [
  { id: "split", source: syntax("supervision"), defs: ["Split"] },
  { id: "switch_wf", source: syntax("decision"), defs: ["HandleRequest"] },
  { id: "type_union", source: syntax("decision"), defs: ["RequestKind"] },
  { id: "const_call", source: syntax("decision"), defs: ["triage"] },
  { id: "agent_min", source: syntax("decision"), defs: ["Support"] },
  { id: "fn_infer", source: syntax("function"), defs: ["summarize_log"] },
  { id: "type_enum", source: syntax("types"), defs: ["Severity"] },
  { id: "type_refine", source: syntax("types"), defs: ["FixPlan"] },
  { id: "extern", source: syntax("effects"), defs: ["parse_junit"] },
  { id: "effect", source: syntax("effects"), defs: ["git.open_pr"] },
  { id: "cap_money", source: syntax("capabilities"), defs: ["Spend20"] },
  { id: "plan_type", source: "fixtures/system/land.mdt", defs: ["Plan"] },
  { id: "contract_static", source: "fixtures/system/land.mdt", defs: ["Plan", "PlanAccepted"] },
  { id: "contract_call", source: "fixtures/system/audience.mdt", defs: ["PlanAccepted"] },
  { id: "contract_all", source: "fixtures/fixbug/fixbug.ir.json", defs: ["FixAccepted"] },
  { id: "changeset_wf", source: "fixtures/system/loosen-ci.mdt", defs: ["Speed"] },
  { id: "map_plan_wf", source: "fixtures/envelope/migrate-all.mdt", defs: ["MigrateAll"] },
  { id: "role", source: "fixtures/envelope/migrate-all.mdt", defs: ["platform_lead"] },
  { id: "cap_call", source: "fixtures/boundary/reach.mdt", defs: ["Environ"] },
  { id: "agent_role", source: "fixtures/boundary/fetch.mdt", defs: ["Reader"] },
  { id: "env_small", source: "fixtures/system/acme.system.mdt", defs: ["staging"] },
  { id: "env_full", source: "fixtures/system/acme.system.mdt", defs: ["prod_sim"] },
  { id: "interface", source: "fixtures/system/acme.system.mdt", defs: ["CoreApi"] },
  { id: "component", source: "fixtures/system/acme.system.mdt", defs: ["core"] },
  { id: "workflow_full", source: "fixtures/fixbug-target/fixbug.mdt", defs: ["FixBug"] },
];

export const V = (name: string): Json => ({ op: "var", name });
const TEXT = (value: string): Json => ({ op: "text", value });

export const MANUAL_BASES: ManualBase[] = [
  {
    id: "head",
    program: {
      language: "mandate/0.5",
      module: "vectors.head",
      version: "0.1",
      uses: [{ module: "std.core", names: ["Text", "Int"] }],
      defs: { Plan: { kind: "type", type: { record: { summary: { ref: "Text" } } } } },
      tests: { Check: { handlers: { ask: TEXT("yes") }, body: [{ op: "expr", value: { op: "int", value: 1 } }] } },
    },
  },
  {
    // The forms no golden program uses.
    id: "misc",
    program: {
      language: "mandate/0.5",
      module: "vectors.misc",
      version: "0.1",
      defs: {
        Misc: {
          kind: "const",
          type: { ref: "Any" },
          value: {
            op: "list",
            items: [
              { op: "set", items: [{ op: "int", value: 1 }] },
              { op: "spawn", agent: "Worker", skill: "go", args: [{ value: V("x") }] },
              { op: "await", of: V("job") },
              { op: "try", of: V("job") },
              {
                op: "block",
                body: [
                  { op: "run", target: V("check"), expect: "Passed" },
                  { op: "loop", max_iter: 3, until: { op: "bool", value: true }, body: [] },
                ],
              },
              { op: "delegate", agent: "Worker", skill: "go", args: [], timeout: { op: "duration", ms: 1000 }, budget: { tokens: 10 }, isolated: true },
              { op: "map", bind: "r", over: V("rs"), body: [], budget: { agents: 2 }, supervise: { name: "fail_fast" } },
              { op: "plan", agent: "Lead", skill: "finish", args: [], budget: { steps: 3 } },
            ],
          },
        },
      },
    },
  },
  {
    id: "type_generics",
    program: {
      language: "mandate/0.5",
      module: "vectors.generics",
      version: "0.1",
      defs: { Box: { kind: "type", generics: ["T"], class: "internal", type: { ref: "List", args: [{ ref: "T" }] } } },
    },
  },
  {
    id: "fn_pub",
    program: {
      language: "mandate/0.5",
      module: "vectors.fn",
      version: "0.1",
      defs: { one: { kind: "fn", pub: true, params: [], returns: { ref: "Int" }, effects: [], body: [{ op: "return", value: { op: "int", value: 1 } }] } },
    },
  },
  {
    id: "effect_flags",
    program: {
      language: "mandate/0.5",
      module: "vectors.effect",
      version: "0.1",
      defs: { wipe: { kind: "effect", params: [], returns: { ref: "Unit" }, requires_caps: [V("Admin")], critical: true, irreversible: true, idempotency_required: true, retry_class: "non_retryable" } },
    },
  },
  {
    id: "agent_full",
    program: {
      language: "mandate/0.5",
      module: "vectors.agent",
      version: "0.1",
      defs: {
        Peer: {
          kind: "agent",
          role: "reader",
          model: "standard",
          remote: { bind: V("PeerUrl"), version: "1.0", require: [V("Signed")], trust: "untrusted" },
          caps: [V("Net")],
          budget: { tokens: 1000, steps: 5 },
          loop: "react",
          progress: { window: 4, repeats: 2, stall: 3 },
          skills: { read: { params: [], returns: { ref: "Text" }, effects: [], budget: { steps: 2 }, body: [{ op: "return", value: TEXT("ok") }] } },
        },
      },
    },
  },
  {
    id: "workflow_ensures",
    program: {
      language: "mandate/0.5",
      module: "vectors.workflow",
      version: "0.1",
      defs: { Done: { kind: "workflow", params: [], returns: { ref: "Bool" }, caps: [], body: [], ensures: { op: "bool", value: true } } },
    },
  },
];

// ---------------------------------------------------------------------------------------------------------
// The cases

export interface CaseSpec {
  /** Unique; when left out, the base and the edit say it. */
  name?: string;
  base: string;
  edits: Edit[];
  /** Pretty-printed with two spaces (several lines) or compact (one line). Default: pretty when the base is small. */
  pretty?: boolean;
  /** Applied to the text of the edited document, for what an object cannot hold: members written in another order than a JS object keeps them. */
  after?: (text: string) => string;
}

export const e = (ptr: string, mut: Mut): Edit => ({ ptr, mut });
/** A case with one edit. */
export const one = (base: string, ptr: string, mut: Mut, pretty?: boolean): CaseSpec => ({ base, edits: [e(ptr, mut)], ...(pretty === undefined ? {} : { pretty }) });
/** A case with several edits, which needs a name. */
export const many = (name: string, base: string, edits: Array<[string, Mut]>, pretty?: boolean): CaseSpec => ({ name, base, edits: edits.map(([p, m]) => e(p, m)), ...(pretty === undefined ? {} : { pretty }) });

export const S = asKind("string");
export const N = asKind("number");
export const B = asKind("boolean");
export const NUL = asKind("null");
export const ARR = asKind("array");
export const OBJ = asKind("object");

export const IR_CASES: CaseSpec[] = [
  // --- the program ------------------------------------------------------------------------------------
  one("head", "/module", remove),
  many("head: three members missing, in the order the schema lists them", "head", [["/version", remove], ["/module", remove], ["/defs", remove]]),
  one("head", "", add("extra")),
  one("head", "/module", N, false),
  one("head", "/module", set("1st.module")),
  one("head", "/version", set("v1")),
  one("head", "/uses", OBJ),
  one("head", "/uses/0", S),
  one("head", "/uses/0/module", remove),
  one("head", "/uses/0/names", empty),
  one("head", "/uses/0/names", dup(1)),
  one("head", "/uses/0/names/1", set("not valid")),
  one("head", "/defs", ARR),
  one("head", "/defs", rename("Plan", "bad-name")),
  one("head", "/tests/Check/body", remove),
  one("head", "/tests/Check/handlers", rename("ask", "bad key")),
  one("head", "/tests/Check/handlers/ask", S),
  one("head", "/tests/Check", add("extra")),
  one("head", "", ARR),
  one("head", "", S, false),
  one("head", "", NUL),
  one("head", "", set({}), false),
  one("head", "/language", remove),
  one("head", "/language", set("mandate/0.9")),
  one("head", "/language", N),
  one("head", "/language", NUL),

  // --- a type definition: every form a type has --------------------------------------------------------
  one("plan_type", "/defs/Plan/kind", remove),
  one("plan_type", "/defs/Plan/kind", set("typo")),
  one("plan_type", "/defs/Plan/kind", N),
  one("plan_type", "/defs/Plan", S),
  one("plan_type", "/defs/Plan", add("pub", true)),
  one("plan_type", "/defs/Plan/type", remove),
  one("plan_type", "/defs/Plan/type", S),
  one("plan_type", "/defs/Plan/type/record", ARR),
  one("plan_type", "/defs/Plan/type/record/summary/ref", N),
  one("plan_type", "/defs/Plan/type/record", rename("summary", "9bad")),
  one("type_enum", "/defs/Severity/type/enum", empty),
  one("type_enum", "/defs/Severity/type/enum", dup(2)),
  one("type_enum", "/defs/Severity/type/enum/1", set("Not-Valid")),
  one("type_enum", "/defs/Severity/type/enum/0", N),
  one("type_union", "/defs/RequestKind/type/union", empty),
  one("type_union", "/defs/RequestKind/type/union/0/tag", remove),
  one("type_union", "/defs/RequestKind/type/union/1/tag", B),
  one("type_union", "/defs/RequestKind/type/union/2", add("extra")),
  one("type_refine", "/defs/FixPlan/type/record/steps/where", remove),
  one("type_generics", "/defs/Box/generics", empty),
  one("type_generics", "/defs/Box/generics/0", set("T!")),
  one("type_generics", "/defs/Box/class", set("secret")),
  one("type_generics", "/defs/Box/type/args", empty),

  // --- constants, capabilities, functions ----------------------------------------------------------------
  one("const_call", "/defs/triage/value/callee/name", N),
  one("const_call", "/defs/triage/value/args/0/value", remove),
  one("const_call", "/defs/triage/value/args/0/name", set("bad name")),
  one("const_call", "/defs/triage/value/args", OBJ),
  one("const_call", "/defs/triage/value/op", remove),
  one("cap_call", "/defs/Environ/value/args/0/value/items/0/value", N),
  one("cap_call", "/defs/Environ/value/args/0/value/items", S),
  one("cap_call", "/defs/Environ", add("pub", true)),
  one("cap_money", "/defs/Spend20/value/args/0/value/currency", set("usd")),
  one("cap_money", "/defs/Spend20/value/args/0/value/currency", set("USDX"), true),
  one("cap_money", "/defs/Spend20/value/args/0/value/micros", S),
  one("cap_money", "/defs/Spend20/value/args/0/value/currency", remove),
  one("fn_infer", "/defs/summarize_log/body", S),
  one("fn_infer", "/defs/summarize_log/body/0/op", set("nope")),
  one("fn_infer", "/defs/summarize_log/budget/tokens", set(-1)),
  one("fn_infer", "/defs/summarize_log/budget/tokens", S),
  one("fn_infer", "/defs/summarize_log/budget", add("cost", 5)),
  one("fn_infer", "/defs/summarize_log/effects/0/effect", remove),
  one("fn_infer", "/defs/summarize_log/effects", S),
  one("fn_infer", "/defs/summarize_log/body/0/value/from/parts/0", S),
  one("fn_infer", "/defs/summarize_log/params/0/type", remove),
  one("fn_infer", "/defs/summarize_log/params", OBJ),
  one("fn_pub", "/defs/one/pub", set(false)),
  one("fn_pub", "/defs/one/pub", S),
  one("fn_pub", "/defs/one/body/0/value/value", set("1")),
  one("extern", "/defs/parse_junit/lang", set("rust")),
  one("extern", "/defs/parse_junit/file", N),
  one("extern", "/defs/parse_junit/effects", OBJ),
  one("extern", "/defs/parse_junit/returns", remove),
  one("effect", "/defs/git.open_pr/critical", set(false)),
  one("effect", "/defs/git.open_pr/retry_class", set("never")),
  one("effect", "/defs/git.open_pr/requires_caps", empty),
  one("effect", "/defs/git.open_pr", add("irreversible", false)),
  one("effect_flags", "/defs/wipe/irreversible", N),
  one("effect_flags", "/defs/wipe/retry_class", NUL),

  // --- agents --------------------------------------------------------------------------------------------
  one("agent_min", "/defs/Support/skills", remove),
  one("agent_min", "/defs/Support/skills", rename("handle", "bad-name")),
  one("agent_min", "/defs/Support/skills/handle/returns", remove),
  one("agent_min", "/defs/Support/skills/handle", add("extra")),
  one("agent_min", "/defs/Support", add("loop", "chaos")),
  one("agent_min", "/defs/Support", add("progress", { window: 1 })),
  one("agent_min", "/defs/Support/budget/steps", set(-1)),
  one("agent_min", "/defs/Support/caps/0/name", N),
  one("agent_role", "/defs/Reader/role", N),
  one("agent_role", "/defs/Reader", add("model", "Bad Model")),
  one("agent_full", "/defs/Peer/remote/bind", remove),
  one("agent_full", "/defs/Peer/remote/trust", set("maybe")),
  one("agent_full", "/defs/Peer/remote/require", empty),
  one("agent_full", "/defs/Peer/remote/version", N),
  one("agent_full", "/defs/Peer/remote", add("extra")),
  one("agent_full", "/defs/Peer/loop", set("spin")),
  one("agent_full", "/defs/Peer/progress/window", set(1)),
  one("agent_full", "/defs/Peer/progress/window", set(65)),
  one("agent_full", "/defs/Peer/progress/stall", set(0)),
  one("agent_full", "/defs/Peer/progress", add("extra")),
  one("agent_full", "/defs/Peer/skills/read/body/0/op", set("yield")),

  // --- workflows -----------------------------------------------------------------------------------------
  one("split", "/defs/Split/body/0/branches/patch/op", set("fork")),
  one("split", "/defs/Split/body/0/supervise/name", remove),
  one("split", "/defs/Split/body/0/supervise", add("extra")),
  one("split", "/defs/Split/body/1/pattern/p", set("regex")),
  one("split", "/defs/Split/body/3/value/on_unmet/then", remove),
  one("split", "/defs/Split/body/4/max_iter", set(0)),
  one("split", "/defs/Split/body/4/body/0/cond", remove),
  one("split", "/defs/Split/body/5/value", remove),
  one("split", "/defs/Split/body/0/branches/patch/supervise/args/1/value/ms", set(-5)),
  one("split", "/defs/Split/budget/spend/currency", set("usd")),
  one("split", "/defs/Split/budget/time/ms", remove),
  one("split", "/defs/Split/body/0/branches/patch", add("isolated", false)),
  one("switch_wf", "/defs/HandleRequest/body/1/value/cases/0/pattern/args/0/p", set("nope")),
  one("switch_wf", "/defs/HandleRequest/body/1/value/cases/1/pattern/p", remove),
  one("switch_wf", "/defs/HandleRequest/body/1/value/cases/2/then", remove),
  one("switch_wf", "/defs/HandleRequest/body/1/value/on", N),
  one("switch_wf", "/defs/HandleRequest/body/1/value/cases/0/pattern/args", set([{ p: "wild", name: "x" }])),
  one("map_plan_wf", "/defs/MigrateAll/body/0/value/max", set(0)),
  one("map_plan_wf", "/defs/MigrateAll/body/0/value/bind", set("bad name")),
  one("map_plan_wf", "/defs/MigrateAll/body/0/value/over", remove),
  one("map_plan_wf", "/defs/MigrateAll/body/0/value", add("budget", { agents: -1 })),
  one("map_plan_wf", "/defs/MigrateAll/envelope/owner", N),
  one("map_plan_wf", "/defs/MigrateAll/envelope/budget/agents", set(-3)),
  one("map_plan_wf", "/defs/MigrateAll/envelope/spawn/max_concurrent", set(0)),
  one("map_plan_wf", "/defs/MigrateAll/envelope/spawn/max_class", set("secret")),
  one("map_plan_wf", "/defs/MigrateAll/envelope/spawn", empty),
  one("map_plan_wf", "/defs/MigrateAll/envelope/approve", empty),
  one("map_plan_wf", "/defs/MigrateAll/envelope/approve", rename("git.merge", "9bad")),
  one("changeset_wf", "/defs/Speed/body/2/value/members", empty),
  one("changeset_wf", "/defs/Speed/body/2/value/members", rename("core", "bad name")),
  one("changeset_wf", "/defs/Speed/body/2/value/members/core/effect", remove),
  one("changeset_wf", "/defs/Speed/body/2/value/members/core", add("extra")),
  one("changeset_wf", "/defs/Speed/body/2/value/order", empty),
  one("changeset_wf", "/defs/Speed/body/2/value/approver", N),
  one("changeset_wf", "/defs/Speed/body/2/value/plan", remove),
  one("changeset_wf", "/defs/Speed/body/2/value", add("changes", { core: "huge" })),
  one("workflow_full", "/defs/FixBug/on", empty),
  one("workflow_full", "/defs/FixBug/on/0/event", remove),
  one("workflow_full", "/defs/FixBug/body/3/value/isolated", set(false)),
  one("workflow_full", "/defs/FixBug/returns", remove),
  one("workflow_full", "/defs/FixBug", add("ensures", { op: "bool", value: 5 })),
  one("workflow_ensures", "/defs/Done/ensures/value", S),
  one("workflow_ensures", "/defs/Done/body", NUL),
  one("misc", "/defs/Misc/value/items/0/items", S),
  one("misc", "/defs/Misc/value/items/1/args", remove),
  one("misc", "/defs/Misc/value/items/2/of", remove),
  one("misc", "/defs/Misc/value/items/3", add("extra")),
  one("misc", "/defs/Misc/value/items/4/body/0/expect", set("bad name")),
  one("misc", "/defs/Misc/value/items/4/body/1/max_iter", set(0)),
  one("misc", "/defs/Misc/value/items/5/isolated", set(false)),
  one("misc", "/defs/Misc/value/items/5/timeout", N),
  one("misc", "/defs/Misc/value/items/6/bind", remove),
  one("misc", "/defs/Misc/value/items/7/budget/steps", S),

  // --- contracts, system definitions ---------------------------------------------------------------------
  one("contract_static", "/defs/PlanAccepted/accept/summarized/description", remove),
  one("contract_static", "/defs/PlanAccepted/accept/summarized/by", remove),
  one("contract_static", "/defs/PlanAccepted/accept", rename("summarized", "not valid")),
  one("contract_static", "/defs/PlanAccepted/accept", remove),
  one("contract_call", "/defs/PlanAccepted/accept/architect/by/call", S),
  one("contract_all", "/defs/FixAccepted/accept/no_blocking_review/by/all/1", remove),
  one("contract_all", "/defs/FixAccepted/require", empty),
  one("contract_all", "/defs/FixAccepted/accept/suite_green/by/call/args/0/value/items/1/value", N),
  one("env_small", "/defs/staging/class", set("secret")),
  one("env_small", "/defs/staging/reads/shipment_status/max_rows", set(0)),
  one("env_small", "/defs/staging/reads/shipment_status/max_rows", set(10001)),
  one("env_small", "/defs/staging/reads/shipment_status/query/sql", set("")),
  one("env_small", "/defs/staging/reads/shipment_status/query", add("logs", V("level"))),
  one("env_small", "/defs/staging/authorize/deploy/by", set("robot")),
  one("env_small", "/defs/staging/authorize", rename("deploy", "9x")),
  one("env_full", "/defs/prod_sim/authorize/deploy/role", set("")),
  one("env_full", "/defs/prod_sim/authorize/migrate/role", remove),
  one("env_full", "/defs/prod_sim/reads/mcp_errors/query/logs", N),
  one("env_full", "/defs/prod_sim/authorize/deploy", add("role2", "x")),
  one("interface", "/defs/CoreApi/protocol", set("soap")),
  one("interface", "/defs/CoreApi/spec", set("")),
  one("interface", "/defs/CoreApi/spec", remove),
  one("interface", "/defs/CoreApi/spec", N),
  one("role", "/defs/platform_lead/description", N),
  one("role", "/defs/platform_lead/description", remove),
  one("role", "/defs/platform_lead", add("extra")),
  one("component", "/defs/core/repo", set("no slash")),
  one("component", "/defs/core/root", set("relative/path")),
  one("component", "/defs/core/owner", set("")),
  one("component", "/defs/core/build", empty),
  one("component", "/defs/core/build/0/command", remove),
  one("component", "/defs/core/build/0/args", S),
  one("component", "/defs/core/provides", empty),
  one("component", "/defs/core/provides", dup(0)),
  one("component", "/defs/core/governance", dup(0)),
];

// ---------------------------------------------------------------------------------------------------------
// The behaviour of schemaDiagnostics (src/ir/validate.ts), one named case for each way it is seen. The test checks
// that each of these cases does show the behaviour it is listed for; other cases show them too, and the files say
// which in each case's `shows`.

/** Names that are the same in the cases and in `BEHAVIOUR_CASES`. */
const N_ROOT_HIDDEN = "a member missing at the root is hidden by any other error";
const N_UNKNOWN_HIDDEN = "an unknown member is hidden by an error further down";
const N_FIELD_HIDDEN = "a missing member is hidden by a wrong value further down";
const N_UNKNOWN_KEPT_FN = "an unknown member and a wrong value one level down are both kept (definition)";
const N_UNKNOWN_KEPT_PLAN = "an unknown member and a wrong value one level down are both kept (type)";
const N_UNKNOWN_KEPT_TEST = "an unknown member and a wrong name one level down are both kept (test)";
const N_UNKNOWN_KEPT_READ = "an unknown member and a wrong value one level down are both kept (read)";
const N_DUP_TYPE = "the same message at one path from every branch of a union is given once";
const N_DUP_SET = "the same unknown member from every branch of a union is given once";
const N_DUP_NAME = "an unknown member beside the one a verifier needs is given once";
const N_SAME_THREE = "three required members missing at one path keep the order Ajv gives";
const N_SAME_TAG = "a missing tag and the discriminator error keep the order Ajv gives";
const N_SAME_NAME = "a wrong member name gives its pattern error and then propertyNames, in Ajv's order";
const N_SAME_BOTH = "two required members missing at one path in another order than they are written";
const N_CP_ROOT = "unknown root members U+E000 and U+1F600 (UTF-16 order puts U+1F600 first)";
const N_CP_DEF = "unknown members U+FFFD and U+10000 in a definition (UTF-16 order puts U+10000 first)";
const N_CP_TEST = "unknown members U+E000 and U+10FFFF in a test (UTF-16 order puts U+10FFFF first)";
const N_LOCALE_ROOT = "unknown root members in the order b, B, a, _x, 1x, A";
const N_LOCALE_DEF = "unknown members Zed, alpha, _m, 9z in a definition";
const N_LOCALE_TEST = "unknown members in a test: x2, X1, _y, x10";
const N_ESCAPES = "an unknown member whose name holds a slash and a tilde";

export const BEHAVIOUR_CASES: Record<string, string[]> = {
  drops_shallower: [N_ROOT_HIDDEN, N_UNKNOWN_HIDDEN, N_FIELD_HIDDEN],
  keeps_at_max_depth: [N_UNKNOWN_KEPT_FN, N_UNKNOWN_KEPT_PLAN, N_UNKNOWN_KEPT_TEST, N_UNKNOWN_KEPT_READ],
  additional_depth: [N_UNKNOWN_KEPT_FN, N_UNKNOWN_KEPT_PLAN, N_UNKNOWN_KEPT_TEST, N_UNKNOWN_KEPT_READ],
  removes_duplicates: [N_DUP_TYPE, N_DUP_SET, N_DUP_NAME],
  same_path_order: [N_SAME_THREE, N_SAME_TAG, N_SAME_NAME, N_SAME_BOTH],
  sort_not_code_point: [N_CP_ROOT, N_CP_DEF, N_CP_TEST],
  sort_not_locale: [N_LOCALE_ROOT, N_LOCALE_DEF, N_LOCALE_TEST],
};

IR_CASES.push(
  // drops_shallower
  many(N_ROOT_HIDDEN, "head", [["/module", remove], ["/tests/Check/body", remove]]),
  many(N_UNKNOWN_HIDDEN, "head", [["", add("extra")], ["/defs/Plan/kind", set("typo")]], true),
  many(N_FIELD_HIDDEN, "split", [["/defs/Split/returns", remove], ["/defs/Split/body/4/max_iter", set(0)]]),
  // keeps_at_max_depth, and additional_depth: without the extra level the unknown member would be dropped
  many(N_UNKNOWN_KEPT_FN, "fn_infer", [["/defs/summarize_log", add("zz")], ["/defs/summarize_log/returns", N]]),
  many(N_UNKNOWN_KEPT_PLAN, "plan_type", [["/defs/Plan", add("zz")], ["/defs/Plan/type", S]]),
  many(N_UNKNOWN_KEPT_TEST, "head", [["/tests/Check", add("zz")], ["/tests/Check/handlers", rename("ask", "bad key")]]),
  many(N_UNKNOWN_KEPT_READ, "env_small", [["/defs/staging/reads/shipment_status", add("zz")], ["/defs/staging/reads/shipment_status/max_rows", set(0)]], false),
  // removes_duplicates
  many(N_DUP_TYPE, "plan_type", [["/defs/Plan/type", S]]),
  many(N_DUP_SET, "type_union", [["/defs/RequestKind/type", add("zz")]]),
  many(N_DUP_NAME, "contract_static", [["/defs/PlanAccepted/accept/summarized/by", add("call", V("ok"))]]),
  // same_path_order
  many(N_SAME_THREE, "head", [["/defs", remove], ["/module", remove], ["/version", remove]], false),
  many(N_SAME_TAG, "plan_type", [["/defs/Plan/kind", remove]], false),
  many(N_SAME_NAME, "head", [["/defs", rename("Plan", "has space")]], false),
  many(N_SAME_BOTH, "cap_money", [["/defs/Spend20/value/args/0/value/currency", remove], ["/defs/Spend20/value/args/0/value/micros", remove]]),
  // sort_not_code_point: a name outside the Basic Multilingual Plane sorts before U+E000 by UTF-16 code units
  many(N_CP_ROOT, "head", [["", add("")], ["", add("\u{1F600}")]]),
  many(N_CP_DEF, "plan_type", [["/defs/Plan", add("�")], ["/defs/Plan", add("\u{10000}")]], false),
  many(N_CP_TEST, "head", [["/tests/Check", add("")], ["/tests/Check", add("\u{10FFFF}")]]),
  // sort_not_locale
  many(N_LOCALE_ROOT, "head", [["", add("b")], ["", add("B")], ["", add("a")], ["", add("_x")], ["", add("1x")], ["", add("A")]]),
  many(N_LOCALE_DEF, "plan_type", [["/defs/Plan", add("Zed")], ["/defs/Plan", add("alpha")], ["/defs/Plan", add("_m")], ["/defs/Plan", add("9z")]], false),
  many(N_LOCALE_TEST, "head", [["/tests/Check", add("x2")], ["/tests/Check", add("X1")], ["/tests/Check", add("_y")], ["/tests/Check", add("x10")]]),
  // a pointer token that needs escaping
  many(N_ESCAPES, "head", [["", add("a/b~c")]]),
);

// The order of the raw errors across the members of one object, the items of an array and the values of a map.
export const N_ORDER_PROPERTIES = "properties are checked in the order of the schema, not of the document";
export const N_ORDER_ITEMS = "the items of an array are checked by index";
export const N_ORDER_MAP = "the values of a map are checked in the order of the document";

IR_CASES.push(
  many(N_ORDER_PROPERTIES, "agent_full", [["/defs/Peer/budget", set({ steps: -1, tokens: -1 })]]),
  many(N_ORDER_ITEMS, "head", [["/uses/0/names/0", set("a b")], ["/uses/0/names/1", set("c d")]]),
  many(N_ORDER_MAP, "head", [["/tests/Check/handlers", add("tell", 5)], ["/tests/Check/handlers/ask", S]]),
);

// Ajv reads the document as the JS value the strict reader builds, and a JS object visits the names that are array
// indices ("2", "10") first, in numeric order, and the others in the order they are written. The text of these
// cases is written by hand, since an object cannot hold a name before an index.
export const N_INDEX_UNKNOWN = "unknown root members written as b, 10, 2: array-index names come first";
export const N_INDEX_DEFS = "definition names written as b d, 10, 2: array-index names come first";
export const N_PROTO = "an unknown root member named __proto__ is an ordinary name";

const ROLE = '{"kind":"role","description":"x"}';

IR_CASES.push(
  { name: N_INDEX_UNKNOWN, base: "head", edits: [], pretty: false, after: (t) => `${t.slice(0, -1)},"b":1,"10":1,"2":1}` },
  { name: N_INDEX_DEFS, base: "head", edits: [], pretty: false, after: (t) => t.replace('"defs":{', `"defs":{"b d":${ROLE},"10":${ROLE},"2":${ROLE},`) },
  { name: N_PROTO, base: "head", edits: [], pretty: false, after: (t) => `${t.slice(0, -1)},"__proto__":1}` },
);
