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
};
