"""What an Agent Spec runtime does with Mandate's extensions (Gate 0, BACKLOG K3).

K3 counts a concept as lost when an Agent Spec runtime that does not know the extension
can ignore it silently. This script loads one small configuration per extension shape
into a real Agent Spec runtime, the LangGraph adapter of pyagentspec 26.3.1, and records
whether the runtime accepts it (``runs``: the extension is ignored) or refuses it.
No model is called; loading builds the LangGraph graph and stops there.

It needs ``pyagentspec[langgraph]==26.3.1`` (requirements-probe.txt). Each case asserts
the behaviour observed on 9 October 2026; a change in Agent Spec that makes a ``runs``
case refuse is a reason to revisit the Gate 0 decision.
"""

import os
import sys
from pathlib import Path
from typing import Callable, Dict, List, Tuple

os.environ.setdefault("OPENAI_API_KEY", "not-used")  # the client is built, never called

import yaml

from pyagentspec.agent import Agent
from pyagentspec.agenticcomponent import AgenticComponent
from pyagentspec.flows.flow import Flow
from pyagentspec.flows.nodes import AgentNode, EndNode, StartNode
from pyagentspec.llms import OpenAiCompatibleConfig
from pyagentspec.property import Property
from pyagentspec.serialization import AgentSpecDeserializer, AgentSpecSerializer
from pyagentspec.serialization.pydanticdeserializationplugin import PydanticComponentDeserializationPlugin
from pyagentspec.serialization.pydanticserializationplugin import PydanticComponentSerializationPlugin
from pyagentspec.tools import ServerTool

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build
import mandate_agentspec as mx

LLM = OpenAiCompatibleConfig(id="llm", name="llm", model_id="model", url="http://127.0.0.1:9")
PLUGINS = mx.deserialization_plugins()
TOOLS = {name: (lambda **kwargs: {}) for name in ("read_file", "list_dir", "grep", "write_file", "run", "git_open_pr", "check_acceptance")}


def to_yaml(component, extended: bool = True) -> str:
    return AgentSpecSerializer(plugins=mx.serialization_plugins() if extended else None).to_yaml(component)


RUNTIME = sys.argv[1] if len(sys.argv) > 1 else "wayflow"
if RUNTIME == "wayflow":
    from wayflowcore.agentspec import AgentSpecLoader
elif RUNTIME == "langgraph":
    from pyagentspec.adapters.langgraph import AgentSpecLoader
else:
    sys.exit(f"usage: probe.py [wayflow|langgraph], not {RUNTIME}")


def load(text: str, plugins=PLUGINS, **kwargs) -> object:
    return AgentSpecLoader(plugins=plugins, tool_registry=TOOLS, **kwargs).load_yaml(text)


def agent(cls=Agent, **extra) -> Agent:
    return cls(id="a", name="a", llm_config=LLM, system_prompt="Find the bug.", **extra)


def one_node_flow(node, cls=Flow, **extra) -> Flow:
    start, end = StartNode(id="s", name="s"), EndNode(id="e", name="e")
    return cls(
        id="f",
        name="f",
        start_node=start,
        nodes=[start, node, end],
        control_flow_connections=build.chain(start, node, end),
        **extra,
    )


def unknown_field() -> object:
    doc = yaml.safe_load(to_yaml(agent(), extended=False))
    doc["capabilities"] = [{"constructor": "fs.read", "args": {"paths": ["/work/repo"]}}]
    loaded = AgentSpecDeserializer().from_dict(doc)
    assert "capabilities" not in to_yaml(loaded, extended=False), "the unknown field was kept"
    return loaded


def future_version() -> object:
    doc = yaml.safe_load(to_yaml(agent(), extended=False))
    doc["agentspec_version"] = "99.1.1"
    return AgentSpecDeserializer().from_dict(doc)


CAPS = [build.REPO_READ, build.MODEL_STD]
BUDGET = mx.MandateBudget(tokens=400_000, steps=40)
EFFECT = mx.MandateEffectNode(
    id="n",
    name="effect git.open_pr",
    tool=build.OPEN_PR,
    effect="git.open_pr",
    idempotent_by=build.field(build.var("issue"), "id"),
    retry_class="reconcilable",
)
VERIFY = mx.MandateVerifyNode(id="n", name="verify", contract=build.FIX_ACCEPTED, value=build.var("draft"))
ALLOW = ["Agent", "OpenAiCompatibleConfig"]
TOOL_SCOPE = ServerTool(id="t", name="read_file", inputs=[Property(json_schema={"title": "path", "type": "string"})])

class SealedAgent(AgenticComponent):
    """An agent type with no core parent to fall back to: the fail-closed shape."""

    llm_config: OpenAiCompatibleConfig
    system_prompt: str
    capabilities: List[mx.MandateCapability] = []


SEALED = {"SealedAgent": SealedAgent}


def sealed() -> object:
    text = AgentSpecSerializer(plugins=[PydanticComponentSerializationPlugin(SEALED)] + mx.serialization_plugins()).to_yaml(
        SealedAgent(id="a", name="a", llm_config=LLM, system_prompt="Find the bug.", capabilities=CAPS)
    )
    return load(text, plugins=[PydanticComponentDeserializationPlugin(SEALED)] + PLUGINS)


R, X = "runs", "refused"
# (concept, extension shape, expected on {langgraph, wayflow}, case)
CASES: List[Tuple[str, str, Dict[str, str], Callable[[], object]]] = [
    ("capabilities on an agent", "metadata", {"langgraph": R, "wayflow": R}, lambda: load(to_yaml(agent(metadata={"mandate": {"caps": ["RepoRead"]}}), False))),
    ("capabilities on an agent", "unknown field on a core component", {"langgraph": R, "wayflow": R}, unknown_field),
    ("epistemic type of a result", "JSON Schema keyword", {"langgraph": R, "wayflow": R}, lambda: load(to_yaml(agent(outputs=[Property(json_schema={"title": "findings", "type": "array", "x-mandate-epistemic": "Inferred"})]), False))),
    ("tool scope (paths)", "none: a tool has no scope", {"langgraph": R, "wayflow": R}, lambda: load(to_yaml(agent(tools=[TOOL_SCOPE]), False))),
    ("capabilities, budget, effects of an agent", "subtype MandateAgent < Agent", {"langgraph": R, "wayflow": X}, lambda: load(to_yaml(agent(mx.MandateAgent, capabilities=CAPS, budget=BUDGET, effects=["Fs.Read", "Model"])))),
    ("with caps, budget, isolated on a delegation", "subtype MandateAgentNode < AgentNode", {"langgraph": R, "wayflow": X}, lambda: load(to_yaml(one_node_flow(mx.MandateAgentNode(id="n", name="n", agent=agent(), isolated=True, with_caps=[build.MODEL_STD], budget=BUDGET))))),
    ("workflow capabilities and budget", "subtype MandateFlow < Flow", {"langgraph": R, "wayflow": X}, lambda: load(to_yaml(one_node_flow(AgentNode(id="n", name="n", agent=agent()), mx.MandateFlow, capabilities=CAPS, budget=BUDGET)))),
    ("critical effect: key, retry class", "subtype MandateEffectNode < ToolNode", {"langgraph": R, "wayflow": X}, lambda: load(to_yaml(one_node_flow(EFFECT)))),
    ("budget of an agent, allow-list of core types", "subtype MandateAgent, allowed_components", {"langgraph": R, "wayflow": X}, lambda: load(to_yaml(agent(mx.MandateAgent, budget=BUDGET)), allowed_components=ALLOW)),
    ("capabilities of an agent, same allow-list", "MandateCapability inside, allowed_components", {"langgraph": X, "wayflow": X}, lambda: load(to_yaml(agent(mx.MandateAgent, capabilities=CAPS)), allowed_components=ALLOW)),
    ("capabilities of an agent", "sibling SealedAgent < AgenticComponent", {"langgraph": X, "wayflow": X}, sealed),
    ("contract and verify", "new node MandateVerifyNode", {"langgraph": X, "wayflow": X}, lambda: load(to_yaml(one_node_flow(VERIFY)))),
    ("any Mandate component", "without the plugin", {"langgraph": X, "wayflow": X}, lambda: load(to_yaml(agent(mx.MandateAgent, capabilities=CAPS)), plugins=[])),
    ("a newer Agent Spec version", "agentspec_version 99.1.1", {"langgraph": X, "wayflow": X}, future_version),
    ("FixBug with extensions", "fixbug.agentspec.yaml", {"langgraph": X, "wayflow": X}, lambda: load(build.EXTENDED.read_text(encoding="utf-8"))),
    ("FixBug, plain", "fixbug.plain.agentspec.yaml", {"langgraph": X, "wayflow": R}, lambda: load(build.PLAIN.read_text(encoding="utf-8"), plugins=[])),
]


def main() -> int:
    failures = 0
    print(f"runtime: {RUNTIME}\n")
    print(f"{'concept':<46} {'extension shape':<48} {'result':<8} detail")
    for concept, shape, expectations, case in CASES:
        expected = expectations[RUNTIME]
        try:
            case()
            got, detail = "runs", ""
        except Exception as e:  # noqa: BLE001 - the refusal itself is the result
            got, detail = "refused", f"{type(e).__name__}: {str(e).splitlines()[0][:90]}"
        mark = "" if got == expected else f"  (expected {expected})"
        failures += got != expected
        print(f"{concept:<46} {shape:<48} {got:<8} {detail}{mark}")
    print(f"\n{failures} unexpected result(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
