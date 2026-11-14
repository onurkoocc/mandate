// The pairs written for the diff vectors (diff-vectors.test.ts; vectors/README.md, "diff/"): small programs, each
// with the changed version of it, for the kinds of change the repository's own programs do not show. Nothing here is
// product behaviour. A pair stores both texts in full; the edits below only make them easier to read and to keep.

export interface WrittenPair {
  name: string;
  note: string;
  before: string;
  after: string;
  /** Repository files the pair's programs are checked with, as `--module` gives them. */
  modules?: string[];
  /** The text of a lock file for the program before and the program after. */
  locks?: { before?: string; after?: string };
}

/** `text` with each `from` replaced by `to`; each `from` must occur exactly once. */
function edit(text: string, edits: Array<[from: string, to: string]>): string {
  let out = text;
  for (const [from, to] of edits) {
    const parts = out.split(from);
    if (parts.length !== 2) throw new Error(`diff-pairs: "${from.slice(0, 50)}" occurs ${parts.length - 1} times`);
    out = parts.join(to);
  }
  return out;
}

const pairs: WrittenPair[] = [];

/** One pair, and with `reverse` the pair the other way round. */
function add(name: string, note: string, before: string, edits: Array<[string, string]>, opts: { reverse?: string; modules?: string[]; locks?: WrittenPair["locks"] } = {}): void {
  const after = edit(before, edits);
  pairs.push({ name, note, before, after, ...(opts.modules ? { modules: opts.modules } : {}), ...(opts.locks ? { locks: opts.locks } : {}) });
  if (opts.reverse !== undefined) pairs.push({ name: opts.reverse, note: `${note} (the other way round)`, before: after, after: before, ...(opts.modules ? { modules: opts.modules } : {}) });
}

// ---------------------------------------------------------------------------------------------------------
// A program of agents, a workflow, a contract and the smaller definitions

const HEADER = `mandate @ 0.5

module t7.base @ 0.1

use std.{fs, net, model, exec, git, human, money}
`;

/** Definitions nothing else uses, so that a pair can add or remove them. */
const SPARES = `
role spare_role2 "Another spare role"

capability SpareCap = fs.read("/work/spare")

type SpareType = { n: Int }

let spare_const = 3

fn spare_fn(t: Text) -> Text
  budget { tokens: 1k }
{
  t
}

effect spare.send(n: Note) -> Note
  requires caps git.pr(repo)
  critical
  idempotency required

extern ts "tools/spare.ts"::spare_tool(x: Text) -> Text
  ! {}

contract SpareDone(n: Note) {
  accept filled "The note has text" by static len(n.text) >= 1
}

agent SpareAgent {
  role   "Does nothing."
  caps   RepoRead
  budget { steps: 3 }
  skill idle(n: Note) -> Inferred<Note> ! {Fs.Read}
}

agent remote SpareRemote = a2a("https://spare.partner.example/.well-known/agent-card.json")
  version  "1.0"
  trust    untrusted
  caps     net.https(hosts: ["spare.partner.example"])
  skills {
    quote(n: Note) -> Note
  }

workflow SpareFlow(n: Note) -> Inferred<Note>
  caps   RepoRead, Brain
  budget { spend: 1 USD }
{
  delegate Worker.do_it(n)
}
`;

const IRREVERSIBLE = `
effect spare.wipe(n: Note) -> Note
  requires caps git.pr(repo)
  critical
  irreversible
  idempotency required
`;

const CORE = `
capability RepoRead = fs.read("/work/repo")
capability SrcWrite = fs.write("/work/repo/src")
capability Api      = net.https(hosts: ["api.example.com"], methods: [GET])
capability Npm      = exec(commands: ["npm"], args_prefix: [["ci"]])
capability Brain    = model.infer(tier: standard)
capability Pr       = git.pr("acme/app")
capability Cash     = money.spend(max: 20 USD, per: workflow_run)

type Note = { text: Text }

contract Done(n: Note) {
  require len(n.text) >= 1
  accept filled "The note has text" by static len(n.text) >= 1
  accept approved "The owner approved" by human.approve(role: spare_role)
  invariant short "The note stays short" by static len(n.text) <= 100
}

effect keep.send(n: Note) -> Note
  requires caps git.pr(repo)
  critical
  idempotency required

agent Worker {
  role   "Does the work."
  model  standard
  caps   RepoRead, Brain
  budget { tokens: 400k, time: 20m, spend: 0.5 USD, steps: 12 }
  skill do_it(n: Note) -> Inferred<Note> ! {Fs.Read, Model}
    budget { steps: 5 }
  skill extra(n: Note) -> Inferred<Note> ! {Fs.Read, Model}
}

agent remote Partner = a2a("https://partner.example/.well-known/agent-card.json")
  version  "1.0"
  trust    untrusted
  caps     net.https(hosts: ["partner.example"])
  skills {
    quote(n: Note) -> Note
  }

workflow Run(n: Note) -> Inferred<Note>
  caps   RepoRead, Brain
  budget { spend: 5 USD, time: 1h }
{
  let a = delegate Worker.do_it(n)
  a
}
`;

// The contract names the spare role, so the role belongs to the core and not to the spares.
const base = HEADER + `\nrole spare_role "A spare role"\n` + CORE;
const baseSpares = HEADER + `\nrole spare_role "A spare role"\n` + SPARES + CORE;

pairs.push({ name: "spares-added", note: "Definitions nothing else uses are added: a capability, a type, a constant, a function, a reversible effect, an extern, a contract, a local agent, a remote agent and a workflow with capabilities.", before: base, after: baseSpares });
pairs.push({ name: "spares-removed", note: "The same definitions are taken away.", before: baseSpares, after: base });
pairs.push({ name: "irreversible-effect-added", note: "An irreversible effect is added.", before: base, after: base + IRREVERSIBLE });
pairs.push({ name: "irreversible-effect-removed", note: "An irreversible effect is taken away.", before: base + IRREVERSIBLE, after: base });

// ── a definition becomes another kind, or changes without a rule of its own ──────────────────────────────

const WITH_SPARE_TYPE = base + `\ntype Spare = { a: Int }\n`;
add("kind-changed", "A type is replaced by a constant of the same name.", WITH_SPARE_TYPE, [[`type Spare = { a: Int }`, `let Spare = 1`]], { reverse: "kind-changed-back" });
add("type-changed", "A type gains a field.", WITH_SPARE_TYPE, [[`type Spare = { a: Int }`, `type Spare = { a: Int, b: Int }`]]);
add("const-changed", "A constant has another value.", base + `\nlet limit = 3\n`, [[`let limit = 3`, `let limit = 4`]]);
add("role-changed", "A role is described otherwise.", base, [[`role spare_role "A spare role"`, `role spare_role "A spare role, described otherwise"`]]);
add("extern-changed", "An extern takes another parameter.", base + `\nextern ts "tools/x.ts"::run_x(x: Text) -> Text\n  ! {}\n`, [[`run_x(x: Text)`, `run_x(x: Text, y: Text)`]]);
add("effect-changed", "An effect returns another type.", base, [[`effect keep.send(n: Note) -> Note`, `effect keep.send(n: Note) -> Text`]]);
add("effect-became-irreversible", "A reversible effect becomes irreversible.", base, [[`effect keep.send(n: Note) -> Note\n  requires caps git.pr(repo)\n  critical\n  idempotency required`, `effect keep.send(n: Note) -> Note\n  requires caps git.pr(repo)\n  critical\n  irreversible\n  idempotency required`]], { reverse: "effect-no-longer-irreversible" });

// ── capabilities ──────────────────────────────────────────────────────────────────────────────────────────

add("cap-read-path-added", "A read capability gains a path outside the old one.", base, [[`capability RepoRead = fs.read("/work/repo")`, `capability RepoRead = fs.read("/work/repo", "/work/other")`]], { reverse: "cap-read-path-removed" });
add("cap-read-path-widened", "A read capability moves to a path that holds the old one.", base, [[`capability RepoRead = fs.read("/work/repo")`, `capability RepoRead = fs.read("/work")`]]);
add("cap-read-path-narrowed", "A read capability moves to a path inside the old one.", base, [[`capability RepoRead = fs.read("/work/repo")`, `capability RepoRead = fs.read("/work/repo/docs")`]]);
add("cap-write-path-added", "A write capability gains a path.", base, [[`capability SrcWrite = fs.write("/work/repo/src")`, `capability SrcWrite = fs.write("/work/repo/src", "/work/repo/test")`]], { reverse: "cap-write-path-removed" });
add("cap-host-and-methods-widened", "A network capability gains a host and a method.", base, [[`net.https(hosts: ["api.example.com"], methods: [GET])`, `net.https(hosts: ["api.example.com", "cdn.example.com"], methods: [GET, POST])`]], { reverse: "cap-host-and-methods-narrowed" });
add("cap-methods-named-none", "A network capability that named its methods names none: any method is allowed.", base, [[`net.https(hosts: ["api.example.com"], methods: [GET])`, `net.https(hosts: ["api.example.com"])`]], { reverse: "cap-methods-named" });
add("cap-methods-replaced", "A network capability allows another method in place of the old one.", base, [[`methods: [GET])`, `methods: [POST])`]]);
add("cap-exec-args-prefix-added", "An exec capability allows a second argument prefix.", base, [[`args_prefix: [["ci"]]`, `args_prefix: [["ci"], ["test"]]`]], { reverse: "cap-exec-args-prefix-removed" });
add("cap-exec-command-added", "An exec capability names a second command, which is another capability by its commands.", base, [[`exec(commands: ["npm"], args_prefix: [["ci"]])`, `exec(commands: ["npm", "node"], args_prefix: [["ci"]])`]]);
add("cap-model-tier-changed", "A model capability moves to another tier.", base, [[`capability Brain    = model.infer(tier: standard)`, `capability Brain    = model.infer(tier: economy)`]]);
add("cap-model-class-changed", "A model capability may now receive data of a higher class.", base, [[`capability Brain    = model.infer(tier: standard)`, `capability Brain    = model.infer(tier: standard, max_class: confidential)`]], { reverse: "cap-model-class-lowered" });
add("cap-repo-added", "A pull-request capability names a second repository.", base, [[`git.pr("acme/app")`, `git.pr("acme/app", "acme/web")`]], { reverse: "cap-repo-removed" });
add("cap-spend-raised", "A spend capability allows more. The scopes show nothing, so the diff says that the capability changed.", base, [[`money.spend(max: 20 USD, per: workflow_run)`, `money.spend(max: 30 USD, per: workflow_run)`]]);
add("cap-constructor-changed", "A capability that read now writes.", base + `\ncapability Moves = fs.read("/work/m")\n`, [[`capability Moves = fs.read("/work/m")`, `capability Moves = fs.write("/work/m")`]]);

// ── agents ────────────────────────────────────────────────────────────────────────────────────────────────

add("agent-cap-added", "An agent holds one more capability.", base, [[`  caps   RepoRead, Brain\n  budget { tokens: 400k`, `  caps   RepoRead, SrcWrite, Brain\n  budget { tokens: 400k`]], { reverse: "agent-cap-removed" });
add("agent-budget-raised", "An agent's tokens, time, spend and steps are all raised.", base, [[`budget { tokens: 400k, time: 20m, spend: 0.5 USD, steps: 12 }`, `budget { tokens: 800k, time: 40m, spend: 1.25 USD, steps: 24 }`]], { reverse: "agent-budget-lowered" });
add("agent-budget-limit-removed", "An agent's time limit and spend limit are taken away: no limit is more than any.", base, [[`budget { tokens: 400k, time: 20m, spend: 0.5 USD, steps: 12 }`, `budget { tokens: 400k, steps: 12 }`]], { reverse: "agent-budget-limit-added" });
add("agent-budget-currency-changed", "An agent's spend limit moves to another currency: the amounts cannot be compared.", base, [[`spend: 0.5 USD, steps: 12 }`, `spend: 0.5 EUR, steps: 12 }`]]);
add("agent-skill-budget-raised", "A skill's budget is raised.", base, [[`    budget { steps: 5 }`, `    budget { steps: 9 }`]], { reverse: "agent-skill-budget-lowered" });
add("agent-skill-changed", "A skill returns another type.", base, [[`skill extra(n: Note) -> Inferred<Note>`, `skill extra(n: Note) -> Inferred<Text>`]]);
add("agent-skill-removed", "An agent loses a skill.", base, [[`  skill extra(n: Note) -> Inferred<Note> ! {Fs.Read, Model}
`, ``]], { reverse: "agent-skill-added" });
add("agent-model-changed", "An agent names another model tier.", base, [[`  model  standard\n`, `  model  economy\n`]]);
add("agent-role-changed", "An agent's role text changes.", base, [[`role   "Does the work."`, `role   "Does the work, and says so."`]]);
add("agent-loop-changed", "An agent's loop strategy changes.", base, [[`  model  standard\n`, `  model  standard\n  loop   plan_execute\n`]]);
add("agent-progress-changed", "An agent's progress thresholds change.", base, [[`  model  standard\n`, `  model  standard\n  progress { window: 6, repeats: 2, stall: 4 }\n`]]);
add("remote-binding-changed", "A remote agent is bound at another version.", base, [[`version  "1.0"\n  trust    untrusted\n  caps     net.https(hosts: ["partner.example"])`, `version  "1.1"\n  trust    untrusted\n  caps     net.https(hosts: ["partner.example"])`]]);
add("remote-cap-added", "A remote agent may reach another host.", base, [[`net.https(hosts: ["partner.example"])`, `net.https(hosts: ["partner.example", "more.partner.example"])`]]);

// ── workflows ─────────────────────────────────────────────────────────────────────────────────────────────

add("workflow-cap-added", "A workflow holds one more capability.", base, [[`  caps   RepoRead, Brain\n  budget { spend: 5 USD, time: 1h }`, `  caps   RepoRead, SrcWrite, Brain\n  budget { spend: 5 USD, time: 1h }`]], { reverse: "workflow-cap-removed" });
add("workflow-budget-raised", "A workflow's spend and time are raised.", base, [[`budget { spend: 5 USD, time: 1h }`, `budget { spend: 8 USD, time: 2h }`]], { reverse: "workflow-budget-lowered" });
add("workflow-budget-steps-added", "A workflow's budget gains a step limit and a token limit.", base, [[`budget { spend: 5 USD, time: 1h }`, `budget { spend: 5 USD, time: 1h, steps: 30, tokens: 2000k }`]], { reverse: "workflow-budget-steps-removed" });
add("workflow-budget-agents-raised", "A workflow limits the delegations it may start, and then limits fewer.", base, [[`budget { spend: 5 USD, time: 1h }`, `budget { spend: 5 USD, time: 1h, agents: 10 }`]], { reverse: "workflow-budget-agents-removed" });
add("workflow-budget-agents-doubled", "A workflow that limited its delegations limits twice as many.", edit(base, [[`budget { spend: 5 USD, time: 1h }`, `budget { spend: 5 USD, time: 1h, agents: 10 }`]]), [[`agents: 10 }`, `agents: 20 }`]], { reverse: "workflow-budget-agents-halved" });
add("workflow-step-added", "A workflow delegates once more, to another skill.", base, [[`  let a = delegate Worker.do_it(n)\n  a`, `  let a = delegate Worker.do_it(n)\n  let b = delegate Worker.extra(n)\n  a`]], { reverse: "workflow-step-removed" });
add("workflow-step-repeated", "A workflow delegates a second time to the same skill: the steps are the same, and only the body differs.", base, [[`  let a = delegate Worker.do_it(n)\n  a`, `  let a = delegate Worker.do_it(n)\n  let b = delegate Worker.do_it(n)\n  a`]]);
add("workflow-body-changed", "A workflow's body changes without changing a step.", base, [[`  let a = delegate Worker.do_it(n)\n  a`, `  let a = delegate Worker.do_it(n)\n  let c = len(n.text)\n  a`]]);
add("workflow-ensures-changed", "A workflow gains a postcondition.", base, [[`  budget { spend: 5 USD, time: 1h }\n{`, `  budget { spend: 5 USD, time: 1h }\n  ensures true\n{`]], { reverse: "workflow-ensures-removed" });
add("workflow-handler-added", "A workflow gains an event handler.", base, [[`\nworkflow Run(`, `\non budget_exceeded in Run => pause and human.ask("Continue?")\n\nworkflow Run(`]], { reverse: "workflow-handler-removed" });

// ── functions and contracts ───────────────────────────────────────────────────────────────────────────────

const WITH_FN = base + `\nfn shorten(t: Text) -> Text\n  budget { tokens: 1k }\n{\n  t\n}\n`;
add("contract-criterion-removed", "An accept criterion is taken away.", base, [[`  accept filled "The note has text" by static len(n.text) >= 1\n  accept approved`, `  accept approved`]], { reverse: "contract-criterion-added" });
add("contract-invariant-removed", "An invariant is taken away.", base, [[`  invariant short "The note stays short" by static len(n.text) <= 100\n`, ``]], { reverse: "contract-invariant-added" });
add("contract-criterion-method-changed", "A criterion is checked by another method.", base, [[`accept approved "The owner approved" by human.approve(role: spare_role)`, `accept approved "The owner approved" by static len(n.text) >= 2`]]);
add("contract-require-changed", "A contract requires more of what it is given.", base, [[`  require len(n.text) >= 1\n`, `  require len(n.text) >= 2\n`]]);
add("fn-budget-raised", "A function's budget is raised.", WITH_FN, [[`budget { tokens: 1k }`, `budget { tokens: 2k }`]], { reverse: "fn-budget-lowered" });
add("fn-body-changed", "A function's parameter has another name.", WITH_FN, [[`fn shorten(t: Text) -> Text\n  budget { tokens: 1k }\n{\n  t\n}`, `fn shorten(s: Text) -> Text\n  budget { tokens: 1k }\n{\n  s\n}`]]);

// ---------------------------------------------------------------------------------------------------------
// A workflow with an envelope (0.4; spec/envelope.md)

const ENVELOPE_HEADER = `mandate @ 0.5

module t7.envelope @ 0.1

use std.{fs, exec, model, git}

role boss     "The owner of the envelope"
role approver "Approves a merge"
role other    "Another role"

capability RepoRead = fs.read("/work/repos")
capability SrcWrite = fs.write("/work/repos")
capability Build    = exec(commands: ["npm"], args_prefix: [["ci"], ["test"]])
capability ModelStd = model.infer(tier: standard)
capability Merge    = git.pr("acme/app", "acme/web")

type Note = { text: Text }

agent Worker {
  role   "Does the work."
  caps   RepoRead, ModelStd
  budget { tokens: 400k, steps: 12 }
  skill go(n: Note) -> Inferred<Note> ! {Fs.Read, Model}
}
`;

const ENVELOPE = `
workflow Ship(n: Note) -> Inferred<Note>
  envelope {
    owner   boss
    caps    RepoRead, ModelStd, Merge
    budget  { tokens: 1000k, time: 2h, spend: 20 USD, steps: 100, agents: 10 }
    spawn   { max_concurrent: 4, max_class: internal }
    approve git.merge by approver
  }
{
  delegate Worker.go(n)
}
`;

const env = ENVELOPE_HEADER + ENVELOPE;
const E = (from: string, to: string): Array<[string, string]> => [[from, to]];

add("envelope-owner-changed", "The envelope's owner is another role.", env, E(`owner   boss`, `owner   other`));
add("envelope-cap-added", "The envelope holds one more capability.", env, E(`caps    RepoRead, ModelStd, Merge`, `caps    RepoRead, SrcWrite, ModelStd, Merge`), { reverse: "envelope-cap-removed" });
add("envelope-budget-raised", "Every dimension of the envelope's budget is raised.", env, E(`budget  { tokens: 1000k, time: 2h, spend: 20 USD, steps: 100, agents: 10 }`, `budget  { tokens: 2000k, time: 4h, spend: 35.5 USD, steps: 200, agents: 20 }`), { reverse: "envelope-budget-lowered" });
add("envelope-budget-limits-removed", "The envelope no longer limits tokens, steps and spend; only time and the delegations stay limited.", env, E(`budget  { tokens: 1000k, time: 2h, spend: 20 USD, steps: 100, agents: 10 }`, `budget  { time: 2h, agents: 10 }`), { reverse: "envelope-budget-limits-added" });
add("envelope-budget-time-removed", "The envelope no longer limits time.", env, E(`budget  { tokens: 1000k, time: 2h, spend: 20 USD, steps: 100, agents: 10 }`, `budget  { tokens: 1000k, spend: 20 USD, steps: 100, agents: 10 }`), { reverse: "envelope-budget-time-added" });
add("envelope-budget-currency-changed", "The envelope's spend is in another currency.", env, E(`spend: 20 USD`, `spend: 20 EUR`));
add("envelope-spawn-concurrency-changed", "More delegations may run at once.", env, E(`max_concurrent: 4`, `max_concurrent: 8`), { reverse: "envelope-spawn-concurrency-lowered" });
add("envelope-spawn-concurrency-unbounded", "The envelope no longer bounds delegations in flight.", env, E(`spawn   { max_concurrent: 4, max_class: internal }`, `spawn   { max_class: internal }`), { reverse: "envelope-spawn-concurrency-bounded" });
add("envelope-spawn-class-changed", "Delegations may receive data of a higher class.", env, E(`max_class: internal`, `max_class: confidential`), { reverse: "envelope-spawn-class-lowered" });
add("envelope-spawn-removed", "The envelope names no spawn bounds: the class is internal and the delegations are not bounded.", env, E(`    spawn   { max_concurrent: 4, max_class: internal }\n`, ``));
add("envelope-approve-changed", "Another role approves a merge.", env, E(`approve git.merge by approver`, `approve git.merge by other`));
add("envelope-approve-added", "A second effect needs a role's approval.", env, E(`    approve git.merge by approver\n`, `    approve git.merge by approver\n    approve git.revert by other\n`), { reverse: "envelope-approve-removed" });
add("envelope-all-at-once", "The owner, a capability, the budget, the spawn bounds and the approvals change together.", env, [
  [`owner   boss`, `owner   other`],
  [`caps    RepoRead, ModelStd, Merge`, `caps    RepoRead, Build, ModelStd, Merge`],
  [`budget  { tokens: 1000k, time: 2h, spend: 20 USD, steps: 100, agents: 10 }`, `budget  { tokens: 500k, time: 4h, spend: 20 USD, steps: 100, agents: 25 }`],
  [`spawn   { max_concurrent: 4, max_class: internal }`, `spawn   { max_concurrent: 2, max_class: restricted }`],
  [`approve git.merge by approver`, `approve git.revert by approver`],
]);
add("envelope-unchanged-workflow-edited", "The envelope stays as it was; the workflow's body gains a step.", env, E(`  delegate Worker.go(n)\n}`, `  let first = delegate Worker.go(n)\n  delegate Worker.go(n)\n}`));

const NO_ENVELOPE = `
workflow Ship(n: Note) -> Inferred<Note>
  caps   RepoRead, ModelStd, Merge
  budget { spend: 20 USD, time: 2h }
{
  delegate Worker.go(n)
}
`;
pairs.push({ name: "envelope-added", note: "A workflow with capabilities and a budget of its own gets an envelope in their place: the envelope came whole, and envelopeChanges has no line for it.", before: ENVELOPE_HEADER + NO_ENVELOPE, after: env });
pairs.push({ name: "envelope-removed", note: "A workflow's envelope is replaced by capabilities and a budget of its own.", before: env, after: ENVELOPE_HEADER + NO_ENVELOPE });
const SIDE = `
workflow Side(n: Note) -> Inferred<Note>
  envelope {
    owner   boss
    caps    RepoRead, ModelStd
    budget  { spend: 5 USD, steps: 30, tokens: 800k, time: 1h, agents: 2 }
  }
{
  delegate Worker.go(n)
}
`;
pairs.push({ name: "envelope-workflow-added", note: "A second workflow with an envelope is added: every capability it holds is authority added, and its envelope is shown as added.", before: env, after: env + SIDE });
pairs.push({ name: "envelope-workflow-removed", note: "A workflow with an envelope is taken away.", before: env + SIDE, after: env });

// ---------------------------------------------------------------------------------------------------------
// The system model (design doc 9): components, interfaces, environments

const SYSTEM = `mandate @ 0.5

module t7.system @ 0.1

role web_owner       "Owns the web component"
role svc_owner       "Owns the service component"
role frontend_owner  "Owns the front end"
role release_manager "Releases to an environment"

interface Orders {
  protocol openapi
  spec     "docs/orders.json"
}

interface Events {
  protocol event
  spec     "docs/events.json"
}

interface Billing {
  protocol db_schema
  spec     "db/migrations"
}

component web {
  repo     "t7/web"
  root     "/work/web"
  lang     ts
  owner    role "web_owner"
  build    exec("npm", ["ci"])
  test     exec("npm", ["test"])
  provides Orders
  consumes Events
  governance "deploy/**"
}

component svc {
  repo     "t7/svc"
  root     "/work/svc"
  lang     java
  owner    role "svc_owner"
  test     exec("mvn", ["test"])
  provides Events, Billing
}

type Row = { id: Text, status: Text }

environment dev {
  class internal
  read orders from svc
    sql "select id, status from orders where id = :id"
    params (id: Text)
    returns Row
    max_rows 1
  authorize deploy by policy
}
`;

add("system-component-fields-changed", "A component's repository, root, language, owner, build, test, provides, consumes and governance patterns all change.", SYSTEM, [
  [`repo     "t7/web"`, `repo     "t7/web-app"`],
  [`root     "/work/web"`, `root     "/work/web-app"`],
  [`lang     ts`, `lang     py`],
  [`owner    role "web_owner"`, `owner    role "frontend_owner"`],
  [`build    exec("npm", ["ci"])`, `build    exec("npm", ["ci"]), exec("npm", ["run", "build"])`],
  [`test     exec("npm", ["test"])`, `test     exec("python", ["-m", "pytest"])`],
  [`provides Orders
  consumes Events
  governance "deploy/**"`, `provides Orders, Billing
  consumes Events
  governance "ops/**", "deploy/**"`],
  [`provides Events, Billing\n}\n\ntype Row`, `provides Events\n  consumes Orders\n}\n\ntype Row`],
]);
add("system-component-governance-removed", "A component loses its own governance-class file patterns, and gains a build.", SYSTEM, [[`  governance "deploy/**"\n`, ``], [`  test     exec("mvn", ["test"])\n`, `  build    exec("mvn", ["package"])\n  test     exec("mvn", ["test"])\n`]], { reverse: "system-component-governance-added" });
add("system-interface-changed", "An interface moves to another protocol and another spec file.", SYSTEM, [[`interface Orders {\n  protocol openapi\n  spec     "docs/orders.json"`, `interface Orders {\n  protocol mcp_tools\n  spec     "docs/orders-tools.json"`]]);
add("system-environment-changed", "An environment holds another class, another read and another authorization.", SYSTEM, [
  [`  class internal\n`, `  class confidential\n`],
  [`    max_rows 1\n  authorize deploy by policy\n`, `    max_rows 5\n  authorize deploy by human(role: "release_manager")\n  authorize migrate by policy\n`],
]);
add("system-environment-read-added", "An environment gains a declared read.", SYSTEM, [[`    max_rows 1\n  authorize deploy by policy\n`, `    max_rows 1\n  read open_orders from svc\n    sql "select id, status from orders where status = :status"\n    params (status: Text)\n    returns Row\n    max_rows 50\n  authorize deploy by policy\n`]], { reverse: "system-environment-read-removed" });
add("system-parts-removed", "A component, an interface and an environment are taken away, and added in the other direction.", SYSTEM, [
  [`interface Events {\n  protocol event\n  spec     "docs/events.json"\n}\n\n`, ``],
  [`interface Billing {\n  protocol db_schema\n  spec     "db/migrations"\n}\n\n`, ``],
  [`  consumes Events\n`, ``],
  [`component svc {\n  repo     "t7/svc"\n  root     "/work/svc"\n  lang     java\n  owner    role "svc_owner"\n  test     exec("mvn", ["test"])\n  provides Events, Billing\n}\n\n`, ``],
  [`environment dev {\n  class internal\n  read orders from svc\n    sql "select id, status from orders where id = :id"\n    params (id: Text)\n    returns Row\n    max_rows 1\n  authorize deploy by policy\n}\n`, ``],
], { reverse: "system-parts-added" });

// ---------------------------------------------------------------------------------------------------------
// Capabilities over a system model, which open only when the model is given

const LINKED = `mandate @ 0.5

module t7.linked @ 0.1

use std.{component, data, env}
use acme.system.{auth, core, mcp, prod_sim, staging}

capability Repos = component.repo(core)
capability Reads = data.read(prod_sim, mcp_errors)
capability Dep   = env.deploy(staging)
capability Mig   = env.migrate(staging)
capability Src   = component.write(core, "src")
capability Run   = component.exec(core, test)

workflow Work(task: Text) -> Text
  caps   Repos, Reads, Dep, Mig, Src, Run
  budget { spend: 1 USD }
{
  task
}
`;
const ACME = ["fixtures/system/acme.system.mdt"];
add("linked-capabilities-widened", "Capabilities over components and environments name more components, reads, environments, paths and commands. The diff of two programs sees them as written; the governance changes of a patch, with the system model given, see what they stand for.", LINKED, [
  [`component.repo(core)`, `component.repo(core, auth)`],
  [`data.read(prod_sim, mcp_errors)`, `data.read(prod_sim, mcp_errors, core_warnings)`],
  [`env.deploy(staging)`, `env.deploy(staging, prod_sim)`],
  [`env.migrate(staging)`, `env.migrate(staging, prod_sim)`],
  [`component.write(core, "src")`, `component.write(core, "src", "test")`],
  [`component.exec(core, test)`, `component.exec(core, build)`],
], { modules: ACME, reverse: "linked-capabilities-narrowed" });

// ---------------------------------------------------------------------------------------------------------
// Locks: the people they bind, and what they ask of the host and of the sandboxes

const LOCKED = `mandate @ 0.5

module t7.locked @ 0.1

type Note = { text: Text }
`;

type LockObject = Record<string, unknown>;

const key = (digit: string): string => `sha256:${digit.repeat(64)}`;

/** A lock of format 0.5 with every part the diff reads; each pair changes it a little. */
function lock(over: LockObject = {}, drop: string[] = []): LockObject {
  const full: LockObject = {
    lock: "mandate/lock/0.5",
    modules: {},
    models: { standard: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium", max_input_tokens: 8000, max_output_tokens: 2000 } },
    tariffs: { "claude-sonnet-5-5": { currency: "USD", as_of: "2026-10-09", micros_per_mtok: { input: 2000000, output: 10000000, cache_read: 200000, cache_write: 2500000 } } },
    members: { alice: { keys: [key("1")] } },
    roles: { lead: ["alice"] },
    host: { node: "22.23.4", bwrap: "0.11.0" },
    isolation: { floor: { confidential: "user_kernel", restricted: "microvm" }, untrusted_network: "process", co_tenancy: { restricted: "forbidden" } },
    egress: { Reader: { "api.example.com": "MADE_UP" } },
    ...over,
  };
  for (const d of drop) delete full[d];
  return full;
}

const lockText = (l: LockObject | undefined): string | undefined => (l ? JSON.stringify(l, null, 2) + "\n" : undefined);

function lockPair(name: string, note: string, before: LockObject | undefined, after: LockObject | undefined, reverse?: string): void {
  const locks = (b: LockObject | undefined, a: LockObject | undefined): WrittenPair["locks"] => ({ ...(b ? { before: lockText(b)! } : {}), ...(a ? { after: lockText(a)! } : {}) });
  pairs.push({ name, note, before: LOCKED, after: LOCKED, locks: locks(before, after) });
  if (reverse !== undefined) pairs.push({ name: reverse, note: `${note} (the other way round)`, before: LOCKED, after: LOCKED, locks: locks(after, before) });
}

lockPair("lock-member-added", "A lock binds a second person, with two keys.", lock(), lock({ members: { alice: { keys: [key("1")] }, bob: { keys: [key("2"), key("3")] } } }), "lock-member-removed");
lockPair("lock-member-keys-changed", "A member gains a key and loses another.", lock({ members: { alice: { keys: [key("1"), key("4")] } } }), lock({ members: { alice: { keys: [key("4"), key("5")] } } }));
lockPair("lock-member-key-single", "A person joins with one key (the line says key, not keys).", lock(), lock({ members: { alice: { keys: [key("1")] }, carol: { keys: [key("6")] } } }));
lockPair("lock-role-holder-added", "A role gains a holder, and another role appears.", lock(), lock({ members: { alice: { keys: [key("1")] }, bob: { keys: [key("2")] } }, roles: { lead: ["alice", "bob"], approver: ["bob"] } }), "lock-role-holder-removed");
lockPair("lock-absent-before", "The old version had no lock: everything the new lock binds is new.", undefined, lock(), "lock-absent-after");
lockPair("lock-host-lowered", "The least host versions are lowered.", lock(), lock({ host: { node: "20.1", bwrap: "0.9.0" } }), "lock-host-raised");
lockPair("lock-host-removed", "The least version of one tool is taken away.", lock(), lock({ host: { node: "22.23.4" } }), "lock-host-added");
lockPair("lock-host-same-versions", "Versions written with a different number of segments are the same version.", lock({ host: { node: "22.23", bwrap: "0.11.0" } }), lock({ host: { node: "22.23.0", bwrap: "0.11" } }));
lockPair("lock-isolation-floor-lowered", "The floor for restricted data is lowered.", lock(), lock({ isolation: { floor: { confidential: "user_kernel", restricted: "user_kernel" }, untrusted_network: "process", co_tenancy: { restricted: "forbidden" } } }), "lock-isolation-floor-raised");
lockPair("lock-isolation-floor-public", "A floor is set for every class, public data included: each class in effect is raised.", lock(), lock({ isolation: { floor: { public: "microvm", confidential: "user_kernel", restricted: "microvm" }, untrusted_network: "process", co_tenancy: { restricted: "forbidden" } } }), "lock-isolation-floor-public-removed");
lockPair("lock-isolation-no-isolation", "The lock names no isolation at all.", lock(), lock({}, ["isolation"]), "lock-isolation-added");
lockPair("lock-isolation-network-floor", "The floor for a sandbox that reaches an untrusted network is raised, and lowered the other way.", lock(), lock({ isolation: { floor: { confidential: "user_kernel", restricted: "microvm" }, untrusted_network: "dedicated_host", co_tenancy: { restricted: "forbidden" } } }), "lock-isolation-network-floor-lowered");
lockPair("lock-isolation-co-tenancy", "Sandboxes with restricted data may now share their host.", lock(), lock({ isolation: { floor: { confidential: "user_kernel", restricted: "microvm" }, untrusted_network: "process", co_tenancy: { restricted: "allowed" } } }), "lock-isolation-co-tenancy-forbidden");
lockPair("lock-isolation-co-tenancy-public", "Sandboxes may not share their host for any class: each class in effect is tightened.", lock(), lock({ isolation: { floor: { confidential: "user_kernel", restricted: "microvm" }, untrusted_network: "process", co_tenancy: { public: "forbidden", restricted: "forbidden" } } }), "lock-isolation-co-tenancy-public-relaxed");
lockPair("lock-egress-credential-added", "A host's requests carry a credential by name, and another agent's too.", lock(), lock({ egress: { Reader: { "api.example.com": "MADE_UP", "uploads.example.com": "MADE_UP_TOO" }, Writer: { "api.example.com": "MADE_UP" } } }), "lock-egress-credential-removed");
lockPair("lock-egress-credential-changed", "A host's requests carry another credential.", lock(), lock({ egress: { Reader: { "api.example.com": "MADE_UP_INSTEAD" } } }));
lockPair("lock-limits-all-at-once", "Governance and behavior changes of the limits in one diff: a floor lowered, a host raised, a credential added and one removed.", lock({ egress: { Reader: { "a.example.com": "MADE_UP", "b.example.com": "MADE_UP_TOO" } } }), lock({ host: { node: "24.0.0", bwrap: "0.11.0" }, isolation: { floor: { confidential: "user_kernel", restricted: "user_kernel" }, untrusted_network: "microvm", co_tenancy: { restricted: "allowed" } }, egress: { Reader: { "a.example.com": "MADE_UP", "c.example.com": "MADE_UP" } } }));
lockPair(
  "lock-models-and-tariffs-not-compared",
  "The model, its effort, its limits, its tariff and the module pins change; the diff reports none of it.",
  lock(),
  lock({
    modules: { "company.domain": key("7") },
    models: { standard: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", max_input_tokens: 128000, max_output_tokens: 12000 } },
    tariffs: { "claude-opus-5-5": { currency: "USD", as_of: "2026-11-01", micros_per_mtok: { input: 4000000, output: 20000000, cache_read: 200000, cache_write: 5000000 } } },
  }),
);

// Names with characters that a pointer, Markdown and HTML each treat as their own. The program's module has an underscore.
const SPECIAL = LOCKED.replace("t7.locked", "t7.special_chars");
pairs.push({
  name: "special-characters",
  note: "A person, a role, an agent and a host are named with characters that mean something to a JSON Pointer (a slash, a tilde), to Markdown (a pipe, an asterisk, an underscore, a backtick) and to HTML (angle brackets, an ampersand, quotes).",
  before: SPECIAL,
  after: SPECIAL,
  locks: {
    before: lockText(lock())!,
    after: lockText(
      lock({
        members: { alice: { keys: [key("1")] }, "ops/dev~x": { keys: [key("8")] } },
        roles: { lead: ["alice"], "tilde~role": ["ops/dev~x"] },
        egress: { Reader: { "api.example.com": "MADE_UP" }, "A|B": { "*h_1.example.com": "MADE_UP<b>&\"'`", "a`b.example.com": "MADE_UP" } },
      }),
    )!,
  },
});

export const WRITTEN_PAIRS: WrittenPair[] = pairs;

