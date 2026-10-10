// The ACS target (BACKLOG item 40; Gate 0b, design doc 12; decisions K37,
// K82). Mandate compiles each local agent's per-call rules onto the Agent
// Control Specification (ACS), the decision contract that Microsoft's Agent
// Governance Toolkit (AGT) hosts enforce at each intervention point of an
// agent loop: before a tool call, before a model call, and so on.
//
// What it carries is what one call can be checked against:
//   - the agent's capability scopes: paths it may read and write, commands
//     and their argument prefixes;
//   - its locked models;
//   - its budget, as limits on the host's counters;
//   - the data class of what enters it.
// What one call cannot show stays in the Mandate runtime and is listed by
// name in the profile, never dropped silently (INV-11). That is the workflow,
// the budget split between delegations, narrowing at delegation, disjoint
// writes, evidence, prepare → authorize → commit and the journal. This is the
// same pattern as the Managed Agents bridge (spec/executors.md): Mandate keeps
// the program, the executor enforces calls.
//
// Gate 0b observed that ACS ignores unknown members in its open slots (tool
// entries, policy and binding fields, metadata). So every rule is generated
// Rego, nothing relies on an open field, and every rule fails closed: a
// missing field, counter or label denies. A host must also present the
// package hash as `envelope.agent.version`. A host that does not know it was
// given a Mandate policy is therefore denied everything: it cannot run the
// agent with the rules silently left out.

import { diag, type Diagnostic } from "../diag.js";
import { domainHash, hashProgram } from "../hash.js";
import type { AgentDef, Budget, Program } from "../ir/types.js";
import type { Json } from "../json/strict-json.js";
import type { Lock } from "../lock.js";
import { link, type Modules } from "../modules.js";
import { DATA_CLASSES } from "../std/std.js";
import type { ProfileLevel } from "./managed-agents.js";
import { sandboxRequirements, type SandboxRequirement } from "./sandbox.js";

export const ACS_TARGET_FORMAT = "mandate/acs-target/0.1";
/** The ACS manifest contract the target writes; the engine AGT 5.0 pins (agent-control-spec 0.4.0-alpha.4) reads it. */
export const ACS_VERSION = "0.4.0-alpha.1";

/**
 * How each guarantee holds when an agent's calls are governed by an ACS host
 * alone. Every level that is not `full` relies on the host: ACS trusts the
 * snapshot its host builds and the counters its host keeps (ACS §21).
 */
export const ACS_PROFILE: Record<string, ProfileLevel> = {
  "package.identity": "partial",
  "static.checks": "full",
  "caps.paths_commands": "partial",
  "caps.delegation_narrowing": "none",
  "caps.network": "none",
  "parallel.isolation": "none",
  "model.pinning": "partial",
  "model.max_class": "partial",
  "budget.tokens_spend": "partial",
  "budget.steps": "none",
  "budget.time": "partial",
  "loop.progress": "none",
  "journal.turns": "none",
  "replay.no_adapter": "none",
  "evidence.verifier": "none",
  "effects.prepare_authorize_commit": "none",
  "credentials.control_plane": "none",
  "cancel": "none",
};

/** Why each level is what it is, for the profile the target writes. */
export const ACS_PROFILE_NOTES: Record<string, string> = {
  "package.identity": "every rule requires envelope.agent.version to be the package hash; the host asserts it",
  "static.checks": "the compiler checks the program before it writes the target",
  "caps.paths_commands": "checked at every pre_tool_call, at the agent's declared scope; the host must call it for every tool call",
  "caps.delegation_narrowing": "a manifest is per agent at its declared upper bound; `with caps` narrowing needs the Mandate runtime",
  "caps.network": "ACS does not enforce a sandbox; the sandbox requirement is written beside the manifest for the host's sandbox",
  "parallel.isolation": "disjoint writes across parallel delegations need the Mandate runtime",
  "model.pinning": "pre_model_call checks the model's name against the lock; effort is not in the snapshot",
  "model.max_class": "every label entering at `input` must be at most the agent's max_class; the host propagates labels",
  "budget.tokens_spend": "the host's counters must be under the limits; they are settled after a call, so one call can overshoot",
  "budget.steps": "ACS counts tool calls, not model turns",
  "budget.time": "the host's elapsed_seconds counter",
  "loop.progress": "repeated calls and stalls need state; ACS is stateless",
  "journal.turns": "needs the Mandate runtime",
  "replay.no_adapter": "needs the Mandate runtime",
  "evidence.verifier": "needs the Mandate runtime; an ACS verdict's evidence is opaque",
  "effects.prepare_authorize_commit": "the agent gets no effect tool (any tool outside the grant is denied); committing an effect needs the Mandate runtime",
  "credentials.control_plane": "where credentials live is the host's",
  "cancel": "the host's",
};

export interface AcsAgent {
  /** The ACS manifest (JSON, which is YAML too). */
  manifest: Json;
  /** The Rego module of the agent's policy bundle. */
  rego: string;
  /** The agent's sandbox requirement, for the host's sandbox: ACS does not enforce one. */
  requirement: SandboxRequirement;
}

export interface AcsTarget {
  format: typeof ACS_TARGET_FORMAT;
  acs_version: typeof ACS_VERSION;
  program: string;
  /** What a host presents as `envelope.agent.version`: the package hash with a lock, else the program hash. */
  binding: string;
  agents: Record<string, AcsAgent>;
  profile: Record<string, { level: ProfileLevel; note: string }>;
  diagnostics: Diagnostic[];
}

/**
 * The ACS target of a checked program: one manifest and Rego bundle per local
 * agent. An agent whose rules cannot be written is left out with E0906:
 * a capability without a static scope, or a spend budget in a currency other
 * than USD, the only one ACS counts. W0907 names what the target does not carry.
 */
export function acsTarget(program: Program, modules: Modules = {}, lock?: Lock): AcsTarget {
  const programHash = hashProgram(program as unknown as Json).program;
  const pinned = lock ? (({ lock: _f, ...rest }) => rest)(lock) : undefined;
  const binding = pinned ? domainHash("package", { program: programHash, lock: pinned } as unknown as Json) : programHash;
  const requirements = sandboxRequirements(program, modules);
  const defs = link(program, modules).defs;
  const diagnostics: Diagnostic[] = [];
  const agents: Record<string, AcsAgent> = {};
  const packages = new Set<string>();
  for (const [name, req] of Object.entries(requirements)) {
    const def = defs[name] as AgentDef;
    if (req.unbounded.length) {
      diagnostics.push(diag("E0906", `${name}'s capabilities ${req.unbounded.join(", ")} have no static scope; an ACS rule cannot check a call against them.`, { path: `/defs/${name}/caps` }, { facts: { agent: name, unbounded: req.unbounded } }));
      continue;
    }
    const budget = largest(def);
    if (budget.spend && budget.spend.currency !== "USD") {
      diagnostics.push(diag("E0906", `${name}'s spend budget is in ${budget.spend.currency}; ACS hosts count cost in USD only.`, { path: `/defs/${name}/budget` }, { facts: { agent: name, currency: budget.spend.currency } }));
      continue;
    }
    let pkg = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
    while (packages.has(pkg)) pkg += "_";
    packages.add(pkg);
    const models = [...new Set(req.models.flatMap((m) => (m.tier && lock?.models?.[m.tier] ? [lock.models[m.tier]!.model] : [])))].sort();
    const maxClass = req.models.map((m) => m.max_class).reduce((a, b) => (DATA_CLASSES.indexOf(b) > DATA_CLASSES.indexOf(a) ? b : a), "public");
    agents[name] = {
      manifest: manifest(name, pkg, req, programHash, binding),
      rego: rego(pkg, req, budget, models, maxClass, binding, programHash, !!lock),
      requirement: req,
    };
  }
  const missing = Object.entries(ACS_PROFILE).filter(([, l]) => l === "none").map(([g]) => g);
  if (Object.keys(agents).length) {
    diagnostics.push(
      diag("W0907", `The ACS target does not carry ${missing.join(", ")}: they need the Mandate runtime. A host that governs these agents with ACS alone gives the profile written beside them.`, { path: "" }, { facts: { not_carried: missing } }),
    );
  }
  return {
    format: ACS_TARGET_FORMAT,
    acs_version: ACS_VERSION,
    program: programHash,
    binding,
    agents,
    profile: Object.fromEntries(Object.entries(ACS_PROFILE).map(([g, level]) => [g, { level, note: ACS_PROFILE_NOTES[g]! }])),
    diagnostics,
  };
}

/** The agent's budget as one upper bound: each dimension at its largest over the agent and its skills. */
function largest(a: AgentDef): Budget {
  const all = [a.budget, ...Object.values(a.skills).map((s) => s.budget)].filter((b): b is Budget => !!b);
  const out: Budget = {};
  for (const b of all) {
    if (b.tokens !== undefined) out.tokens = Math.max(out.tokens ?? 0, b.tokens);
    if (b.time) out.time = { ms: Math.max(out.time?.ms ?? 0, b.time.ms) };
    if (b.spend) out.spend = out.spend && out.spend.currency === b.spend.currency ? { micros: Math.max(out.spend.micros, b.spend.micros), currency: b.spend.currency } : (out.spend ?? b.spend);
  }
  return out;
}

const POINTS: Array<[string, string, string]> = [
  ["agent_startup", "$.agent_init", "agent"],
  ["input", "$.input", "input"],
  ["pre_model_call", "$.model", "model_request"],
  ["post_model_call", "$.response", "model_response"],
  ["pre_tool_call", "$.tool_call.args", "tool_args"],
  ["post_tool_call", "$.tool_result", "tool_result"],
  ["output", "$.response", "output"],
  ["agent_shutdown", "$.summary", "summary"],
];

/** The tools of a grant (runtime/src/tools.ts, K8), and `finish`. */
function toolsOf(req: SandboxRequirement): string[] {
  const out: string[] = [];
  if (req.filesystem.read.length || req.filesystem.write.length) out.push("read_file", "list_dir", "grep");
  if (req.filesystem.write.length) out.push("write_file");
  if (req.exec.length) out.push("run");
  out.push("finish");
  return out;
}

function manifest(agent: string, pkg: string, req: SandboxRequirement, program: string, binding: string): Json {
  const intervention_points: Record<string, Json> = {};
  for (const [point, target, kind] of POINTS) {
    intervention_points[point] = {
      policy_target: target,
      policy_target_kind: kind,
      ...(point.endsWith("_tool_call") ? { tool_name_from: "$.tool_call.name" } : {}),
      policy: { id: "mandate" },
    };
  }
  // A tool entry's members are host metadata that ACS does not read (Gate 0b); the rules are all in the Rego.
  const tools = Object.fromEntries(toolsOf(req).map((t) => [t, { security_labels: [`mandate:${t}`] }]));
  return {
    agent_control_specification_version: ACS_VERSION,
    metadata: { mandate: { format: ACS_TARGET_FORMAT, agent, program, binding } },
    policies: { mandate: { type: "rego", bundle: `./${agent}`, query: `data.mandate.${pkg}.verdict` } },
    intervention_points,
    tools,
  } as unknown as Json;
}

const j = (v: unknown): string => JSON.stringify(v);

function rego(pkg: string, req: SandboxRequirement, budget: Budget, models: string[], maxClass: string, binding: string, program: string, locked: boolean): string {
  const commands: Record<string, Array<string[] | null>> = {};
  for (const e of req.exec) commands[e.command] = e.args_prefix ? e.args_prefix : [null];
  const limits: Record<string, number> = {};
  if (budget.tokens !== undefined) limits["token_count"] = budget.tokens;
  if (budget.spend) limits["cost_usd"] = budget.spend.micros / 1_000_000;
  if (budget.time) limits["elapsed_seconds"] = budget.time.ms / 1000;
  const lattice = Object.fromEntries(DATA_CLASSES.map((c, i) => [c, i]));
  const cwd = req.filesystem.read[0] ?? req.filesystem.write[0] ?? "";
  return `package mandate.${pkg}

import rego.v1

# Generated by \`mandate target acs\` (${ACS_TARGET_FORMAT}) from program
# ${program}.
# Do not edit: the policy is a projection of the program, and a changed rule
# is a changed program. Every rule fails closed: a missing field, counter or
# label denies.

binding := ${j(binding)}

cwd := ${j(cwd)}

read_roots := ${j(req.filesystem.read)}

write_roots := ${j(req.filesystem.write)}

# command -> argument prefixes; null allows any arguments.
commands := ${j(commands)}

tools := ${j(toolsOf(req))}

# The host's counters (AGT-SNAPSHOT §1) and their limits from the agent's budget.
limits := ${j(limits)}

models := ${j(models)}

max_class := ${j(maxClass)}

lattice := ${j(lattice)}

deny(reason) := {"decision": "deny", "reason": reason}

allow := {"decision": "allow"}

default verdict := {"decision": "deny", "reason": "mandate_unhandled"}

# The host presents the package hash, so a host that does not know it runs a
# Mandate policy is denied rather than enforcing part of it.
verdict := deny("mandate_binding_mismatch") if {
	not bound
} else := deny("mandate_budget_counter_missing") if {
	counter_missing
} else := deny("mandate_budget_exhausted") if {
	exhausted
} else := point

bound if input.snapshot.envelope.agent.version == binding

# Through a rule: \`not\` over an undefined reference is not a dependable "missing".
counter_present(counter) if is_number(input.snapshot.envelope.budgets[counter])

counter_missing if {
	some counter, _ in limits
	not counter_present(counter)
}

exhausted if {
	some counter, limit in limits
	input.snapshot.envelope.budgets[counter] >= limit
}

default point := {"decision": "deny", "reason": "mandate_unhandled"}

point := allow if input.intervention_point in ["agent_startup", "post_model_call", "post_tool_call", "output", "agent_shutdown"]

point := ingress if input.intervention_point == "input"

point := model_call if input.intervention_point == "pre_model_call"

point := tool_call if input.intervention_point == "pre_tool_call"

# What enters the agent carries its labels, and none may be above max_class.
default ingress := {"decision": "deny", "reason": "mandate_labels_missing"}

ingress := allow if {
	labels := input.snapshot.input.ifc.source_labels
	is_array(labels)
	count(labels) > 0
	every label in labels {
		lattice[label] <= lattice[max_class]
	}
} else := deny("mandate_data_class") if {
	count(input.snapshot.input.ifc.source_labels) > 0
}

${
  locked
    ? `default model_call := {"decision": "deny", "reason": "mandate_model_not_locked"}

model_call := allow if input.snapshot.model.name in models`
    : `# Without a lock no model is pinned (profile: model.pinning).
model_call := allow`
}

default tool_call := {"decision": "deny", "reason": "mandate_outside_grant"}

tool_call := allow if {
	tool_name in tools
	tool_ok
}

tool_name := input.snapshot.tool_call.name

tool_args := input.policy_target.value

tool_ok if tool_name == "finish"

tool_ok if {
	tool_name in ["read_file", "list_dir"]
	readable(tool_args.path)
}

tool_ok if {
	tool_name == "grep"
	is_string(tool_args.pattern)
	readable(tool_args.path)
}

tool_ok if {
	tool_name == "write_file"
	is_string(tool_args.content)
	writable(tool_args.path)
}

tool_ok if {
	tool_name == "run"
	command_ok(tool_args.command, tool_args.args)
}

resolved(p) := p if startswith(p, "/")

resolved(p) := concat("/", [cwd, p]) if not startswith(p, "/")

# A path is taken as written: no ".", "..", or empty segment.
bad_segment(segments) if {
	some s in segments
	s in [".", ".."]
}

bad_segment(segments) if {
	some i, s in segments
	i > 0
	s == ""
}

clean(p) if not bad_segment(split(p, "/"))

inside(p, root) if p == root

inside(p, root) if {
	root == "/"
	startswith(p, "/")
}

inside(p, root) if startswith(p, concat("", [root, "/"]))

readable(p) if {
	is_string(p)
	r := resolved(p)
	clean(r)
	some root in array.concat(read_roots, write_roots)
	inside(r, root)
}

writable(p) if {
	is_string(p)
	r := resolved(p)
	clean(r)
	some root in write_roots
	inside(r, root)
}

command_ok(command, args) if {
	is_string(command)
	is_array(args)
	every a in args {
		is_string(a)
	}
	some prefix in commands[command]
	prefix_ok(prefix, args)
}

prefix_ok(prefix, _) if prefix == null

prefix_ok(prefix, args) if {
	is_array(prefix)
	count(args) >= count(prefix)
	every i, x in prefix {
		args[i] == x
	}
}
`;
}
