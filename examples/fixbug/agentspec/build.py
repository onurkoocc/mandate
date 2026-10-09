"""Build FixBug (design doc 4, section 20) as Open Agent Spec 26.3.1 configurations.

Writes three files next to this script:

- ``fixbug.agentspec.yaml``: FixBug in Agent Spec with the Mandate extension components
  of ``mandate_agentspec.py``. Everything Mandate says about FixBug is in this file.
- ``fixbug.plain.agentspec.yaml``: the same work in plain Agent Spec, without extensions.
  It is what Agent Spec expresses on its own.
- ``mandate-ext.schema.json``: the JSON Schema of the extension components.

Run ``python build.py`` after changing this file; ``python check.py`` (CI) fails when the
committed files differ from what this script writes.
"""

import json
import sys
from pathlib import Path
from typing import Any, Dict, List

import yaml

from pyagentspec.agent import Agent
from pyagentspec.flows.edges import ControlFlowEdge
from pyagentspec.flows.flow import Flow
from pyagentspec.flows.nodes import (
    AgentNode,
    BranchingNode,
    EndNode,
    InputMessageNode,
    OutputMessageNode,
    ParallelFlowNode,
    StartNode,
    ToolNode,
)
from pyagentspec.llms import LlmGenerationConfig, OpenAiCompatibleConfig
from pyagentspec.property import Property
from pyagentspec.serialization import AgentSpecSerializer
from pyagentspec.tools import ServerTool

import mandate_agentspec as mx

HERE = Path(__file__).resolve().parent
EXTENDED = HERE / "fixbug.agentspec.yaml"
PLAIN = HERE / "fixbug.plain.agentspec.yaml"
SCHEMA = HERE / "mandate-ext.schema.json"


def prop(title: str, schema: Dict[str, Any], description: str = "") -> Property:
    return Property(json_schema={"title": title, **({"description": description} if description else {}), **schema})


def text_list(**extra: Any) -> Dict[str, Any]:
    return {"type": "array", "items": {"type": "string"}, **extra}


# ── Types ────────────────────────────────────────────────────────────────────
# company.domain is outside the program; these schemas stand in for its types.
ISSUE = {
    "type": "object",
    "properties": {"id": {"type": "string"}, "reproducible": {"type": "boolean"}, "scope": text_list(uniqueItems=True)},
    "required": ["id", "reproducible", "scope"],
}
FINDING = {
    "type": "object",
    "properties": {
        "file": {"type": "string"},
        "line": {"type": "integer", "minimum": 1},
        "claim": {"type": "string"},
        "evidence": {"type": "string"},
    },
    "required": ["file", "line", "claim", "evidence"],
}
FIX_PLAN = {
    "type": "object",
    "properties": {
        "steps": text_list(minItems=1, maxItems=12),
        "touches": text_list(uniqueItems=True),
        "risks": text_list(),
    },
    "required": ["steps", "touches", "risks"],
}
PATCH = {"type": "object", "properties": {"files": text_list(uniqueItems=True), "diff": {"type": "string"}}, "required": ["files", "diff"]}
TEST_SET = {"type": "object", "properties": {"files": text_list(uniqueItems=True), "cases": text_list()}, "required": ["files", "cases"]}
REVIEW = {
    "type": "object",
    "properties": {"counterexamples": text_list(), "blocking": {"type": "boolean"}},
    "required": ["counterexamples", "blocking"],
}
PULL_REQUEST = {"type": "object", "properties": {"number": {"type": "integer"}, "url": {"type": "string"}}, "required": ["number", "url"]}

P_ISSUE = lambda: prop("issue", ISSUE)
P_FINDINGS = lambda: prop("findings", {"type": "array", "items": FINDING})
P_PLAN = lambda: prop("plan", FIX_PLAN)
P_PATCH = lambda: prop("patch", PATCH)
P_TESTS = lambda: prop("tests", TEST_SET)
P_REVIEW = lambda: prop("review", REVIEW)


# ── Model and tools ──────────────────────────────────────────────────────────
# Agent Spec binds a concrete model to each agent; Mandate names a tier
# (model.infer(tier: standard)) and the lock file maps it (BACKLOG K10, K11).
# Agent Spec 26.3.1 has no Anthropic configuration, so the model is reached through
# Anthropic's OpenAI-compatible endpoint; effort is a pass-through generation parameter.
LLM = OpenAiCompatibleConfig(
    id="llm.standard",
    name="standard",
    description="tier: standard (BACKLOG K10)",
    url="https://api.anthropic.com/v1/",
    model_id="claude-opus-5-5",
    default_generation_parameters=LlmGenerationConfig(max_tokens=16000, reasoning_effort="high"),
)


def tool(name: str, description: str, inputs: List[Property], outputs: List[Property]) -> ServerTool:
    return ServerTool(id=f"tool.{name}", name=name, description=description, inputs=inputs, outputs=outputs)


S = {"type": "string"}
READ_FILE = tool("read_file", "Read a file", [prop("path", S)], [prop("content", S)])
LIST_DIR = tool("list_dir", "List a directory", [prop("path", S)], [prop("entries", text_list())])
GREP = tool("grep", "Search files for a pattern", [prop("pattern", S), prop("path", S)], [prop("matches", text_list())])
WRITE_FILE = tool("write_file", "Write a file", [prop("path", S), prop("content", S)], [prop("written", {"type": "boolean"})])
RUN = tool(
    "run",
    "Run a command",
    [prop("command", S), prop("args", text_list())],
    [prop("exit_code", {"type": "integer"}), prop("output", S)],
)
READ_TOOLS = [READ_FILE, LIST_DIR, GREP]
OPEN_PR = tool("git_open_pr", "Open a pull request for the checked draft", [prop("checked", {"type": "object"})], [prop("pull_request", PULL_REQUEST)])
# Plain Agent Spec has nothing like a checked draft; the tool takes the parts as they are.
OPEN_PR_PLAIN = tool("git_open_pr", "Open a pull request", [P_ISSUE(), P_PATCH(), P_TESTS(), P_REVIEW()], [prop("pull_request", PULL_REQUEST)])


# ── Capabilities (fixbug.mdt) ────────────────────────────────────────────────
def cap(name: str, constructor: str, **args: Any) -> mx.MandateCapability:
    return mx.MandateCapability(id=f"cap.{name}", name=name, constructor=constructor, args=args)


REPO_READ = cap("RepoRead", "fs.read", paths=["/work/repo"])
SRC_WRITE = cap("SrcWrite", "fs.write", paths=["/work/repo/src"])
TEST_WRITE = cap("TestWrite", "fs.write", paths=["/work/repo/test"])
BUILD = cap("Build", "exec", commands=["mvn"], args_prefix=[["-q", "test"], ["-q", "verify"]])
MODEL_STD = cap("ModelStd", "model.infer", tier="standard")
PR = cap("PR", "git.pr", repo="company/backend")


def usd(units: float) -> mx.MandateMoney:
    return mx.MandateMoney(micros=int(round(units * 1_000_000)), currency="USD")


# ── Agents ───────────────────────────────────────────────────────────────────
AGENTS = {
    "Explorer": dict(
        role="Finds where the bug is, with evidence. Does not change code.",
        skill="locate",
        inputs=[P_ISSUE],
        output=P_FINDINGS,
        tools=READ_TOOLS,
        caps=[REPO_READ, MODEL_STD],
        budget=mx.MandateBudget(tokens=400_000, time_ms=900_000, spend=usd(3), steps=40),
        effects=["Fs.Read", "Model"],
    ),
    "Planner": dict(
        role="Turns findings into the smallest fix plan, split by behavior.",
        skill="plan",
        inputs=[P_ISSUE, P_FINDINGS],
        output=P_PLAN,
        tools=[],
        caps=[MODEL_STD],
        budget=mx.MandateBudget(tokens=150_000, spend=usd(1.5), steps=10),
        effects=["Model"],
    ),
    "Implementer": dict(
        role="Applies the plan, only in the files it may change.",
        skill="apply",
        inputs=[P_PLAN],
        output=P_PATCH,
        tools=READ_TOOLS + [WRITE_FILE, RUN],
        caps=[REPO_READ, SRC_WRITE, BUILD, MODEL_STD],
        budget=mx.MandateBudget(tokens=800_000, time_ms=2_700_000, spend=usd(8), steps=80),
        effects=["Exec", "Fs.Read", "Fs.Write", "Model"],
    ),
    "TestWriter": dict(
        role="Writes the regression test that catches the bug.",
        skill="regression",
        inputs=[P_ISSUE],
        output=P_TESTS,
        tools=READ_TOOLS + [WRITE_FILE, RUN],
        caps=[REPO_READ, TEST_WRITE, BUILD, MODEL_STD],
        budget=mx.MandateBudget(tokens=300_000, time_ms=1_200_000, spend=usd(3), steps=40),
        effects=["Exec", "Fs.Read", "Fs.Write", "Model"],
    ),
    "Reviewer": dict(
        role="Looks for counterexamples to the diff: concurrency, repeated messages, partial failure, unauthorized users.",
        skill="counterexamples",
        inputs=[P_PATCH, P_TESTS],
        output=P_REVIEW,
        tools=READ_TOOLS,
        caps=[REPO_READ, MODEL_STD],
        budget=mx.MandateBudget(tokens=300_000, spend=usd(3), steps=30),
        effects=["Fs.Read", "Model"],
    ),
}


def agent(name: str, extended: bool) -> Agent:
    a = AGENTS[name]
    inputs = [p() for p in a["inputs"]]
    placeholders = "\n".join(f"{p.title}: {{{{{p.title}}}}}" for p in inputs)
    common = dict(
        id=f"agent.{name}",
        name=name,
        description=f"{a['role']} Skill: {a['skill']}.",
        llm_config=LLM,
        system_prompt=f"{a['role']}\n\n{placeholders}",
        human_in_the_loop=False,
        tools=a["tools"],
        inputs=inputs,
        outputs=[a["output"]()],
    )
    if not extended:
        return Agent(**common)
    return mx.MandateAgent(**common, capabilities=a["caps"], budget=a["budget"], effects=a["effects"])


def delegate(name: str, extended: bool, isolated: bool = False) -> AgentNode:
    skill = AGENTS[name]["skill"]
    common = dict(id=f"node.{skill}", name=f"delegate {name}.{skill}", agent=agent(name, extended))
    if not extended:
        return AgentNode(**common)
    return mx.MandateAgentNode(**common, isolated=isolated)


def edge(a, b, branch: str = None) -> ControlFlowEdge:
    suffix = f".{branch}" if branch else ""
    return ControlFlowEdge(id=f"edge.{a.id}{suffix}->{b.id}", name=f"{a.name}{suffix} -> {b.name}", from_node=a, from_branch=branch, to_node=b)


def chain(*nodes) -> List[ControlFlowEdge]:
    return [edge(a, b) for a, b in zip(nodes, nodes[1:])]


def sub_flow(fid: str, name: str, inputs: List[Property], node: AgentNode, outputs: List[Property]) -> Flow:
    start = StartNode(id=f"{fid}.start", name=f"{name} start", inputs=inputs)
    end = EndNode(id=f"{fid}.end", name=f"{name} end", outputs=outputs)
    return Flow(id=fid, name=name, start_node=start, nodes=[start, node, end], control_flow_connections=chain(start, node, end), outputs=outputs)


# ── The contract (fixbug.mdt, FixAccepted) ───────────────────────────────────
def var(name: str) -> Dict[str, Any]:
    return {"op": "var", "name": name}


def field(of: Dict[str, Any], name: str) -> Dict[str, Any]:
    return {"op": "field", "of": of, "name": name}


def call(callee: Dict[str, Any], *args: Any, **named: Any) -> Dict[str, Any]:
    return {
        "op": "call",
        "callee": callee,
        "args": [{"value": v} for v in args] + [{"name": k, "value": v} for k, v in named.items()],
    }


def text(v: str) -> Dict[str, Any]:
    return {"op": "text", "value": v}


PR_ = var("pr")
FIX_ACCEPTED = mx.MandateContract(
    id="contract.FixAccepted",
    name="FixAccepted",
    parameters=[P_ISSUE(), prop("pr", {"type": "object"})],
    requires=[field(var("issue"), "reproducible")],
    criteria=[
        mx.MandateCriterion(
            name="regression_test",
            description="A regression test fails before the fix and passes after it",
            method={"call": call(field(var("test"), "red_then_green"), field(PR_, "patch"), field(PR_, "tests"))},
        ),
        mx.MandateCriterion(
            name="scope_respected",
            description="The change stays inside the task scope",
            method={"static": {"op": "binary", "bop": "subseteq", "left": field(field(PR_, "patch"), "files"), "right": field(var("issue"), "scope")}},
        ),
        mx.MandateCriterion(
            name="suite_green",
            description="The existing test suite passes",
            method={"call": call(field(var("test"), "suite"), {"op": "list", "items": [text("unit"), text("integration")]})},
        ),
        mx.MandateCriterion(
            name="no_blocking_review",
            description="Independent review found no blocking issue",
            method={
                "all": [
                    {"static": {"op": "unary", "uop": "not", "of": field(field(PR_, "review"), "blocking")}},
                    {"call": call(var("review"), var("isolated"), model=var("standard"))},
                ]
            },
        ),
        mx.MandateCriterion(
            name="owner_approved",
            description="The code owner approved",
            method={"call": call(field(var("human"), "approve"), role=text("code_owner"))},
        ),
    ],
)


# ── The workflow ─────────────────────────────────────────────────────────────
def fixbug(extended: bool) -> Flow:
    start = StartNode(id="node.start", name="start", inputs=[P_ISSUE()])
    explore = delegate("Explorer", extended)
    plan = delegate("Planner", extended)
    par = ParallelFlowNode(
        id="node.par",
        name="par",
        subflows=[
            sub_flow("flow.par.patch", "patch", [P_PLAN()], delegate("Implementer", extended), [P_PATCH()]),
            sub_flow("flow.par.tests", "tests", [P_ISSUE()], delegate("TestWriter", extended), [P_TESTS()]),
        ],
    )
    review = delegate("Reviewer", extended, isolated=True)
    # escalate human("Open acceptance criteria: {c}"): tell the person, then wait for them.
    escalate = OutputMessageNode(id="node.escalate", name="escalate", message="Open acceptance criteria: {{unmet}}")
    wait = InputMessageNode(id="node.wait", name="wait for a person")
    # Every end node must produce the flow's outputs; without a pull request it is "number 0".
    no_pr = prop("pull_request", PULL_REQUEST)
    no_pr.json_schema["default"] = {"number": 0, "url": ""}
    end_unmet = EndNode(id="node.end.unmet", name="end unmet", branch_name="unmet", outputs=[no_pr])
    end = EndNode(id="node.end", name="end", outputs=[prop("pull_request", PULL_REQUEST)])
    pr_out = prop("pull_request", PULL_REQUEST, "The pull request; number 0 when the acceptance criteria were not met")

    if extended:
        verify = mx.MandateVerifyNode(
            id="node.verify",
            name="verify FixAccepted",
            contract=FIX_ACCEPTED,
            value=var("draft"),
            args=[var("issue"), var("draft")],
            inputs=[P_ISSUE(), P_PATCH(), P_TESTS(), P_REVIEW()],
            outputs=[prop("checked", {"type": "object"}), prop("unmet", text_list())],
        )
        open_pr = mx.MandateEffectNode(
            id="node.open_pr",
            name="effect git.open_pr",
            tool=OPEN_PR,
            effect="git.open_pr",
            idempotent_by=field(var("issue"), "id"),
            retry_class="reconcilable",
            compensate="git.close_pr",
        )
        nodes = [start, explore, plan, par, review, verify, open_pr, end, escalate, wait, end_unmet]
        edges = chain(start, explore, plan, par, review, verify)
        edges += [edge(verify, open_pr, "met"), edge(open_pr, end), edge(verify, escalate, "unmet"), edge(escalate, wait), edge(wait, end_unmet)]
        on_exceeded_start = StartNode(id="flow.on_budget_exceeded.start", name="on budget_exceeded start")
        ask = InputMessageNode(id="flow.on_budget_exceeded.ask", name="ask", message="Budget exceeded. Continue or cancel?")
        on_exceeded_end = EndNode(id="flow.on_budget_exceeded.end", name="on budget_exceeded end")
        on_exceeded = Flow(
            id="flow.on_budget_exceeded",
            name="on budget_exceeded",
            start_node=on_exceeded_start,
            nodes=[on_exceeded_start, ask, on_exceeded_end],
            control_flow_connections=chain(on_exceeded_start, ask, on_exceeded_end),
        )
        return mx.MandateFlow(
            id="flow.FixBug",
            name="FixBug",
            description="Multi-agent bugfix workflow (design doc 4, section 20).",
            start_node=start,
            nodes=nodes,
            control_flow_connections=edges,
            outputs=[pr_out],
            capabilities=[BUILD, MODEL_STD, PR, REPO_READ, SRC_WRITE, TEST_WRITE],
            budget=mx.MandateBudget(spend=usd(20), time_ms=10_800_000),
            on_budget_exceeded=on_exceeded,
        )

    # Plain Agent Spec has no contract, so the acceptance check is spelled out as
    # tool calls, a question to a person and branches. Nothing ties the result to
    # evidence, and the agents' outputs reach the tools unchecked.
    check = ToolNode(
        id="node.check",
        name="check acceptance",
        tool=tool(
            "check_acceptance",
            "Run the regression test, the suite and the scope check; return met or unmet",
            [P_ISSUE(), P_PATCH(), P_TESTS(), P_REVIEW()],
            [prop("verdict", {"type": "string", "enum": ["met", "unmet"]}), prop("unmet", text_list())],
        ),
    )
    by_verdict = BranchingNode(id="node.by_verdict", name="by verdict", mapping={"met": "met"}, inputs=[prop("verdict", S)])
    approve = InputMessageNode(id="node.approve", name="owner approval", message="Code owner: approve this pull request? Answer approve or decline.")
    by_answer = BranchingNode(id="node.by_answer", name="by answer", mapping={"approve": "approved"}, inputs=[prop("user_input", S)])
    open_pr = ToolNode(id="node.open_pr", name="git open pr", tool=OPEN_PR_PLAIN)
    nodes = [start, explore, plan, par, review, check, by_verdict, approve, by_answer, open_pr, end, escalate, wait, end_unmet]
    edges = chain(start, explore, plan, par, review, check, by_verdict)
    edges += [
        edge(by_verdict, approve, "met"),
        edge(by_verdict, escalate, BranchingNode.DEFAULT_BRANCH),
        edge(approve, by_answer),
        edge(by_answer, open_pr, "approved"),
        edge(by_answer, escalate, BranchingNode.DEFAULT_BRANCH),
        edge(open_pr, end),
        edge(escalate, wait),
        edge(wait, end_unmet),
    ]
    return Flow(
        id="flow.FixBug",
        name="FixBug",
        description="Multi-agent bugfix workflow (design doc 4, section 20), plain Agent Spec.",
        start_node=start,
        nodes=nodes,
        control_flow_connections=edges,
        outputs=[pr_out],
    )


HEADER = "# Generated by build.py from FixBug (examples/fixbug/fixbug.mdt). Do not edit.\n"


def dump(component, extended: bool) -> str:
    """YAML for ``component``. pyagentspec orders ``$referenced_components`` by set
    iteration, which changes between processes; the keys are sorted here."""
    serializer = AgentSpecSerializer(plugins=mx.serialization_plugins() if extended else None)
    return yaml.safe_dump(_sorted_refs(serializer.to_dict(component)), sort_keys=False, allow_unicode=True)


def _sorted_refs(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _sorted_refs(dict(sorted(v.items())) if k == "$referenced_components" else v) for k, v in value.items()}
    if isinstance(value, list):
        return [_sorted_refs(v) for v in value]
    return value


def render(extended: bool) -> str:
    return HEADER + dump(fixbug(extended), extended)


def render_schema() -> str:
    return json.dumps(mx.extension_schema(), indent=2, ensure_ascii=False) + "\n"


def outputs() -> Dict[Path, str]:
    return {EXTENDED: render(True), PLAIN: render(False), SCHEMA: render_schema()}


def main() -> int:
    for path, content in outputs().items():
        path.write_text(content, encoding="utf-8", newline="\n")
        print(f"wrote {path.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
