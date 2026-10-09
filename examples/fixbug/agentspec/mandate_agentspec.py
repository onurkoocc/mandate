"""Mandate extension components for Open Agent Spec (Gate 0, design doc 4 §21.2).

Agent Spec 26.3.1 has no field for most Mandate concepts. This module writes each of
them as a plugin component, following the spec's plugin rules ("Ecosystem of plugins"):
a plugin component names its ``component_type``, and a plugin subtype of a built-in
component keeps the parent's attributes unchanged and only adds new ones.

Two shapes are used, and the difference is the point of Gate 0:

- A **subtype** of a built-in component (``MandateFlow`` < ``Flow``, ``MandateAgent`` <
  ``Agent``, ``MandateAgentNode`` < ``AgentNode``, ``MandateEffectNode`` < ``ToolNode``).
  A runtime that loads this plugin but has no Mandate execution logic dispatches on the
  parent class and runs it as the parent. The added attributes are ignored, silently.
- A **new** component with no executable parent (``MandateCapability``,
  ``MandateContract``, ``MandateVerifyNode``). A runtime without Mandate execution logic
  refuses it.

Agent Spec has no expression language, so expressions (static criteria, business keys)
are carried as Mandate IR expression nodes, unchanged.
"""

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

from pyagentspec.agent import Agent
from pyagentspec.component import Component
from pyagentspec.flows.flow import Flow
from pyagentspec.flows.node import Node
from pyagentspec.flows.nodes import AgentNode, ToolNode
from pyagentspec.property import Property
from pyagentspec.serialization.pydanticdeserializationplugin import (
    PydanticComponentDeserializationPlugin,
)
from pyagentspec.serialization.pydanticserializationplugin import (
    PydanticComponentSerializationPlugin,
)

PLUGIN_NAME = "MandateAgentSpecExtension"
PLUGIN_VERSION = "0.1.0"

# A Mandate IR expression node (spec/ir.md), carried verbatim.
Expr = Dict[str, Any]


class MandateMoney(BaseModel):
    """Money: integer micro-units and an ISO 4217 code (spec/core.md §2)."""

    model_config = ConfigDict(extra="forbid")
    micros: int
    currency: str


class MandateBudget(BaseModel):
    """``{ tokens?, spend?, time?, steps? }`` (spec/core.md §2, §5.3)."""

    model_config = ConfigDict(extra="forbid")
    tokens: Optional[int] = None
    spend: Optional[MandateMoney] = None
    time_ms: Optional[int] = None
    steps: Optional[int] = None


class MandateCapability(Component):
    """A named authority value, e.g. ``fs.write("/work/repo/src")`` (spec/core.md §4)."""

    constructor: Literal["fs.read", "fs.write", "net.https", "model.infer", "exec", "git.pr", "money.spend"]
    args: Dict[str, Any] = Field(default_factory=dict)


class MandateCriterion(BaseModel):
    """One ``accept`` line of a contract: a description and its method (spec/core.md §6)."""

    model_config = ConfigDict(extra="forbid")
    name: str
    description: str
    method: Expr


class MandateContract(Component):
    """Acceptance criteria over typed parameters (spec/core.md §6)."""

    parameters: List[Property] = Field(default_factory=list)
    requires: List[Expr] = Field(default_factory=list)
    criteria: List[MandateCriterion] = Field(default_factory=list)


class MandateAgent(Agent):
    """An agent's authority, budget and declared effects (spec/core.md §4, §5).

    The skill's signature is the Agent's inputs and outputs; ``epistemic`` says how its
    result is known (``Inferred`` for every skill result).
    """

    capabilities: List[MandateCapability] = Field(default_factory=list)
    budget: Optional[MandateBudget] = None
    effects: List[str] = Field(default_factory=list)
    epistemic: Literal["Inferred"] = "Inferred"


class MandateAgentNode(AgentNode):
    """``delegate A.s(args) [with caps K] [budget b] [isolated] [supervise …]``."""

    with_caps: Optional[List[MandateCapability]] = None
    budget: Optional[MandateBudget] = None
    isolated: bool = False
    supervise: Optional[Dict[str, Any]] = None


class MandateVerifyNode(Node):
    """``verify x against C(args) [on unmet(c) => e]``: branches ``met`` and ``unmet``.

    On ``met`` the output is ``Verified<T, C>``, carrying the ids of its evidence. The
    evidence comes from the verifiers, never from an agent.
    """

    contract: MandateContract
    args: List[Expr] = Field(default_factory=list)
    value: Expr

    def _get_inferred_branches(self) -> List[str]:
        return ["met", "unmet"]


class MandateEffectNode(ToolNode):
    """A critical external effect: prepare → authorize → commit (spec/core.md §3, §7.2)."""

    effect: str
    critical: bool = True
    irreversible: bool = False
    idempotent_by: Expr
    retry_class: Literal["read_only", "idempotent", "reconcilable", "non_retryable"]
    compensate: Optional[str] = None


class MandateFlow(Flow):
    """A workflow: its capabilities, budget and event handlers (spec/core.md §5)."""

    capabilities: List[MandateCapability] = Field(default_factory=list)
    budget: Optional[MandateBudget] = None
    on_budget_exceeded: Optional[Flow] = None


COMPONENTS: Dict[str, type] = {
    cls.__name__: cls
    for cls in (
        MandateCapability,
        MandateContract,
        MandateAgent,
        MandateAgentNode,
        MandateVerifyNode,
        MandateEffectNode,
        MandateFlow,
    )
}


class _SerializationPlugin(PydanticComponentSerializationPlugin):
    @property
    def plugin_name(self) -> str:
        return PLUGIN_NAME

    @property
    def plugin_version(self) -> str:
        return PLUGIN_VERSION


class _DeserializationPlugin(PydanticComponentDeserializationPlugin):
    @property
    def plugin_name(self) -> str:
        return PLUGIN_NAME

    @property
    def plugin_version(self) -> str:
        return PLUGIN_VERSION


def serialization_plugins() -> list:
    return [_SerializationPlugin(COMPONENTS)]


def deserialization_plugins() -> list:
    return [_DeserializationPlugin(COMPONENTS)]


def json_schema(core_only: bool = False) -> Dict[str, Any]:
    """The Agent Spec 26.3.1 JSON Schema for a ``Flow``, with these components in it.

    pyagentspec writes ``component_plugin_name`` and ``component_plugin_version`` on
    plugin components, as the spec's plugin example does, but the schema it generates
    does not allow them; they are added here for the Mandate components. Nor does it allow
    ``agentspec_version`` on a plugin component at the root, which is added too.
    """
    schema = Flow.model_json_schema(only_core_components=core_only)
    defs = schema["$defs"]
    for name, d in defs.items():
        if d.get("properties", {}).get("component_type", {}).get("const") in COMPONENTS:
            d["properties"]["component_plugin_name"] = {"const": PLUGIN_NAME}
            d["properties"]["component_plugin_version"] = {"const": PLUGIN_VERSION}
            if f"Versioned{name.removeprefix('Base')}" in defs:
                d["properties"]["agentspec_version"] = {"$ref": "#/$defs/AgentSpecVersionEnum"}
    return schema


def extension_schema() -> Dict[str, Any]:
    """The definitions this module adds to the Agent Spec schema."""
    defs = json_schema()["$defs"]
    own = {k: v for k, v in defs.items() if k.removeprefix("Base").removeprefix("Versioned").startswith("Mandate")}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": f"{PLUGIN_NAME} {PLUGIN_VERSION}",
        "description": (
            "The Mandate extension components for Open Agent Spec 26.3.1, generated by pyagentspec "
            "from mandate_agentspec.py. Other #/$defs/ references resolve in the Agent Spec 26.3.1 "
            "schema (pyagentspec Component.model_json_schema()); check.py validates against both together."
        ),
        "$defs": dict(sorted(own.items())),
    }
