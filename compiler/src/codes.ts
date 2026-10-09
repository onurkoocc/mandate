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
    explain: "The program exceeds a 0.1 reference-profile limit: 1 MiB of source, JSON depth 64, 64 definitions, or 1000 statically expanded nodes per workflow (§3.4).",
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
  "MDT-E0140": {
    title: "Malformed lock file",
    explain: "mandate.lock.json does not match spec/lock.schema.json, or a model it locks has no tariff. A lock is read strictly, like the IR: unknown fields and fractional prices are errors (spec/lock.md).",
  },
  "MDT-E0141": {
    title: "Model tier not locked",
    explain: "A capability names a model tier that the lock file does not map to a model, an effort and a tariff. The runtime refuses to load such a package (BACKLOG K10, K11).",
  },
  "MDT-E0142": {
    title: "Imported module not locked",
    explain: "A program imports a module that the lock file does not pin, or a loaded module whose program hash differs from the one the lock pins. A run's imported modules, such as its system model, are fixed by hash (S09, INV-02); a changed module is a new lock and a new package.",
  },
  "MDT-E0201": {
    title: "Type mismatch",
    explain: "A value's type does not match what the position expects: a wrong argument count, a different nominal type, or a plain T where Verified<T> is required.",
  },
  "MDT-E0202": {
    title: "Unknown field",
    explain: "A field access or record literal names a field the type does not have.",
  },
  "MDT-E0203": {
    title: "Missing field",
    explain: "A record literal leaves out fields its type requires.",
  },
  "MDT-E0210": {
    title: "Inferred value where T is expected",
    explain: "Model output (Inferred<T>) is used where a plain or verified T is required, for example as a critical effect parameter or to steer control flow. Verify it against a contract first, or use a decision policy (R1, R4, D1).",
  },
  "MDT-E0211": {
    title: "Untrusted value where T is expected",
    explain: "Content from outside the program (files, network, people, remote agents) is used where a trusted T is required. Untrusted<T> must be verified before use (§5.2).",
  },
  "MDT-E0212": {
    title: "Verified against a different contract",
    explain: "A value verified against one contract is used where a value verified against another is required. Verified<T, C> names its contract, and only C satisfies it.",
  },
  "MDT-E0213": {
    title: "Protected type produced by a program",
    explain: "Evidence, Authorization, Receipt and Verified are produced only by the runtime. A model, a host function or a record literal cannot create them (§5.2).",
  },
  "MDT-E0215": {
    title: "Untrusted text in an instruction position",
    explain: "Untrusted or model-produced text appears in the instruction part of a prompt or picks a capability's scope. Pass it as data with quote(…) (R5, §5.4).",
  },
  "MDT-E0220": {
    title: "Data class above what the model may receive",
    explain: "Data of a higher class (§5.5: public < internal < confidential < restricted) is sent to a model capability whose max_class is lower. model.infer allows internal data unless it says otherwise.",
  },
  "MDT-E0230": {
    title: "Non-exhaustive switch",
    explain: "A switch leaves out variants of the type it matches. A switch on a decision outcome must handle Uncertain (D2).",
  },
  "MDT-E0231": {
    title: "Switch on a raw decision",
    explain: "A switch matches a Decision<T> directly. Apply a decision policy (threshold, top_margin, abstain_if) first, so that \"an option was chosen\" and \"there is enough support to choose\" stay separate (D2).",
  },
  "MDT-W0232": {
    title: "Choice without an out-of-scope option",
    explain: "A Choice<T> has no option such as Other, Irrelevant or OutOfScope, so the model must force every input into a listed option (D8).",
  },
  "MDT-E0233": {
    title: "Too many Choice options",
    explain: "A Choice<T> has more than 255 options.",
  },
  "MDT-W0207": {
    title: "peek on model output",
    explain: "peek(…) reads an Inferred value as a plain one. Use it only for read-only inspection, never to steer effects (R7).",
  },
  "MDT-E0301": {
    title: "Capability not in scope",
    explain: "An effect is used where no capability authorizes it: in a workflow's body, by an agent's skill, or by a delegation whose granted capabilities leave it out (C1).",
  },
  "MDT-E0305": {
    title: "Capability widened",
    explain: "narrow(…) asks for a scope that is not inside the capability it narrows. Capabilities can only shrink (C3).",
  },
  "MDT-W0310": {
    title: "Unused capability",
    explain: "A workflow or agent holds a capability that nothing it runs uses. The generated sandbox policy is the upper bound of real use, so unused authority should be removed.",
  },
  "MDT-W0311": {
    title: "Policy and real use disagree",
    explain:
      "In learning mode, an agent's sandbox denied an access its policy does not allow, and recorded it (MXC captureDenials). Either the agent needs it, and its capability must grow (a governance change a person approves), or the agent reached for something it should not. The denial stayed denied; this is feedback, not a grant. `mandate denials <run>` exports a run's report and `mandate check <program> --denials <report>` reports it (§11.3, §12.2).",
  },
  "MDT-E0320": {
    title: "Overlapping writes in par",
    explain: "Two branches of a par block can write the same scope. Write capabilities (fs.write, git.*) must be disjoint across branches; read capabilities may be shared (C5).",
  },
  "MDT-E0401": {
    title: "Undeclared effect",
    explain: "A function or skill uses an effect it does not declare, or a public function does not declare its effects at all (§6.2).",
  },
  "MDT-E0402": {
    title: "Unknown effect",
    explain: "An effect list names an effect that is neither built in, in the standard library, nor declared with `effect`.",
  },
  "MDT-E0403": {
    title: "Missing idempotency",
    explain: "A critical effect is declared without `idempotency required`, or called without `idempotent_by <business key>` (§8.4).",
  },
  "MDT-E0405": {
    title: "Irreversible effect without human approval",
    explain: "An irreversible effect runs with no earlier human.approve and no argument verified by a contract that requires one (§6.3).",
  },
  "MDT-E0408": {
    title: "External write outside a workflow",
    explain: "A critical effect runs inside a function, a skill or a contract. External writes happen only in a workflow, through prepare → authorize → commit (§8.8).",
  },
  "MDT-E0501": {
    title: "Child budgets exceed the parent",
    explain: "The budgets a workflow hands to its delegates add up to more than its own. Money and tokens add up across par branches; wall-clock time takes the longest branch; loops multiply by max_iter. The facts carry the breakdown.",
  },
  "MDT-E0502": {
    title: "Unbounded loop or recursion",
    explain: "A loop has neither max_iter nor until, or functions and workflows call each other in a cycle. Static node and budget bounds need both to be bounded.",
  },
  "MDT-E0503": {
    title: "Agent loop without a step limit",
    explain: "A skill without a body runs as an agent loop, and neither it nor its agent sets `steps` in its budget (§8.2).",
  },
  "MDT-E0504": {
    title: "Budget currency mismatch",
    explain: "A child budget is in a different currency from its parent. Currencies are never converted implicitly (§5.3).",
  },
  "MDT-W0504": {
    title: "Budget below the computed upper bound",
    explain: "An agent loop's declared tokens or spend is less than its steps times the per-call upper bound from the lock file: the locked input and output limits, priced as if nothing hits the cache (§8.6, K12). The skill may run out of budget before it can finish. The facts carry the bound.",
  },
  "MDT-W0601": {
    title: "Static criterion checked at run time",
    explain: "A `static` acceptance criterion cannot be proved at compile time, so it becomes a run-time check (Appendix B: E0601 falls back to a warning).",
  },
  "MDT-E0603": {
    title: "Criterion satisfied only by review",
    explain: "An acceptance criterion is satisfied only by review(…). A second model agreeing is not evidence; pair it with a static check, a test or a human (§10.2).",
  },
  "MDT-E0701": {
    title: "Delegated authority not a subset",
    explain: "`with caps` hands over a capability that the calling context or the agent does not hold. Delegation can only narrow authority (C2).",
  },
  "MDT-E0710": {
    title: "restart_all over external effects",
    explain: "A par block supervised by restart_all contains branches with external effects. Children must use their own retry classes (§8.7).",
  },
  "MDT-E0711": {
    title: "Dynamic spawn",
    explain: "spawn is not available in 0.1. Use delegate, par or a bounded map (§9.1).",
  },
  "MDT-E0712": {
    title: "UnknownOutcome restarted",
    explain: "An UnknownOutcome error is handled with a strategy other than reconcile. Restarting could repeat an external effect (§8.7).",
  },
  "MDT-E0713": {
    title: "Too many restarts",
    explain: "restart(max: n) asks for more than 5 retries.",
  },
  "MDT-E0714": {
    title: "Unknown supervision strategy",
    explain: "A supervise clause names a strategy the runtime does not run, or one that does not fit where it is: a par block takes fail_fast or restart_all; a delegation takes restart(max, backoff), escalate(human) or degrade(to: Agent). An unknown strategy is refused, never ignored (§8.7).",
  },
  "MDT-E0715": {
    title: "Fallback is not equivalent",
    explain: "degrade(to: F) must name an agent that does the same job with no more authority: F has the same skill with the same parameter and result types, holds no capability the original agent lacks, and holds what the call hands over with `with caps` (§8.7).",
  },
  "MDT-E1001": {
    title: "Interface without exactly one provider",
    explain: "Every interface of a system model is provided by exactly one component (`provides`). The provider answers for changes to it, and its spec file is read at the provider's base commit (design doc 9 §2.1).",
  },
  "MDT-E1002": {
    title: "Capability over a component cannot be opened",
    explain: "component.read, component.write, component.exec and component.repo take components of the system model. component.write takes paths inside the component; component.exec runs only the build or test commands the component declares. A capability that stands for several values (one per command) cannot be narrowed as one (design doc 9 §2.2).",
  },
  "MDT-E1003": {
    title: "Component working copies overlap",
    explain: "Two components have the same root, or one root lies inside the other. Each component's working copy is its own, so sandboxes, write scopes and changes are told apart by root (C5 across components).",
  },
  "MDT-E1004": {
    title: "Read does not match its declaration",
    explain: "A declared read runs one SELECT statement (or a log filter) whose values come only from its parameters: every `:name` placeholder is a parameter and every parameter is used, and parameters are scalars. Model output can be a parameter value, never query text (design doc 9 §5.1, K43).",
  },
  "MDT-E1005": {
    title: "Read above its environment's class",
    explain: "A read returns rows of a higher data class than the environment it belongs to declares. An environment's class is the most sensitive data it holds; a program cannot lower a class (§5.5).",
  },
  "MDT-E1101": {
    title: "Change set order breaks the interface graph",
    explain: "A change set declares how interfaces change. For an additive change, the provider lands before every member that consumes the interface, and the provider is a member of the set. When no order can satisfy the graph (a cycle), the change must be split into steps (design doc 9 §3.3).",
  },
  "MDT-E1102": {
    title: "Change set order does not list its members",
    explain: "A change set's `order` names every member exactly once; it is the order in which the members are committed (design doc 9 §3.2).",
  },
  "MDT-E1103": {
    title: "Breaking change in one change set",
    explain: "An interface that changes in a breaking way cannot change in one step: some consumer would break between two merges. Plan it as expand → migrate → contract: add the new form, move every consumer to it, then remove the old one, each its own change set (design doc 9 §3.3).",
  },
  "MDT-E1104": {
    title: "Change set member is not a critical effect",
    explain: "Each member of a change set is the external action that lands one component's change (git.merge, git.open_pr, deploy …), so it is a critical effect, prepared, authorized and committed like one (design doc 9 §3.2).",
  },
  "MDT-E1105": {
    title: "Change set without a verified plan",
    explain: "A change set lands a plan that was accepted before any code was written: its plan argument must be Verified against a contract. The set digest covers the plan, so an approval of the set is an approval of this plan's change (design doc 9 §3.4).",
  },
  "MDT-E1201": {
    title: "Read not as declared",
    explain: "data.read runs a read an environment declares: data.read(env.read, param: value, …, max_class: c). Every parameter is passed once, by name, and nothing else; values are bound as parameters and never become query text (K43). max_class is a data class; fields above it come back masked, typed Masked (design doc 9 §5.1).",
  },
  "MDT-E0902": {
    title: "Sandbox requirement cannot be enforced",
    explain: "The sandbox adapter probed the host and it cannot enforce part of an agent's sandbox requirement: a backend, a path, host or command allow-list, a timeout, or a scope that is not statically known. The run refuses to start the agent (unsupported_sandbox_profile) instead of running it with less isolation (INV-11, G05).",
  },
};
