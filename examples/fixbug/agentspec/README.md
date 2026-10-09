# FixBug in Open Agent Spec (Gate 0)

Design doc 4 §21.2 opens with Gate 0: write the same contract in
[Open Agent Spec](https://github.com/oracle/agent-spec) and find out whether
Mandate needs a representation of its own. This directory holds that
comparison for FixBug (`../fixbug.mdt`), against Agent Spec 26.3.1.

| File | What it is |
|---|---|
| `fixbug.agentspec.yaml` | FixBug in Agent Spec with Mandate's extension components. Everything `fixbug.mdt` says is in it |
| `fixbug.plain.agentspec.yaml` | The same work in plain Agent Spec, without extensions |
| `mandate_agentspec.py` | The extension components, written as Agent Spec plugin components |
| `mandate-ext.schema.json` | Their JSON Schema, as pyagentspec generates it |
| `build.py` | Builds the three files above from pyagentspec objects |
| `check.py` | CI: the files are current, load, round-trip and validate against the Agent Spec schema |
| `probe.py` | CI: what an Agent Spec runtime that does not know the extension does with it |

```sh
pip install -r requirements.txt
python build.py              # after changing build.py or mandate_agentspec.py
python check.py
python probe.py wayflow      # or: python probe.py langgraph
```

## What the extension looks like

Agent Spec's plugin rules let a plugin add new component types, and let a
plugin subtype of a built-in component add attributes to it. The extension
uses both shapes:

| Component | Shape | Carries |
|---|---|---|
| `MandateFlow` | subtype of `Flow` | workflow capabilities, budget, `on budget_exceeded` |
| `MandateAgent` | subtype of `Agent` | capabilities, budget, declared effects, `Inferred` result |
| `MandateAgentNode` | subtype of `AgentNode` | `with caps`, `budget`, `isolated`, `supervise` |
| `MandateEffectNode` | subtype of `ToolNode` | critical effect, business key, retry class, compensation |
| `MandateVerifyNode` | new `Node` | `verify … against C`, branches `met` and `unmet` |
| `MandateCapability` | new component | a capability value and its scope |
| `MandateContract` | new component | parameters, `require`, criteria and their methods |

Agent Spec has no expression language, so static criteria and business keys
are carried as Mandate IR expression nodes.

## What a runtime does with it

`probe.py` loads one small configuration per extension shape into two Agent
Spec runtimes: WayFlow, the reference runtime, and the LangGraph adapter
that ships with pyagentspec. No model is called. The results on 9 October
2026, with pyagentspec and wayflowcore 26.3.1:

| Extension shape | WayFlow | LangGraph |
|---|---|---|
| `metadata` on a core component | runs, ignored | runs, ignored |
| Unknown field on a core component | runs; the deserializer drops the field | runs; the deserializer drops the field |
| JSON Schema keyword on a property (e.g. an epistemic type) | runs, ignored | runs, ignored |
| Subtype of a core component (`MandateAgent`, `MandateAgentNode`, `MandateFlow`, `MandateEffectNode`) | refused | runs as the parent; added fields ignored |
| New component with no core parent (`MandateVerifyNode`, a sibling agent type) | refused | refused |
| Any Mandate component, without the plugin | refused | refused |
| A newer `agentspec_version` | refused | refused |
| `fixbug.agentspec.yaml` | refused | refused |
| `fixbug.plain.agentspec.yaml` | runs | refused: no `ParallelFlowNode` |

Agent Spec has no way for a configuration to say that an extension must be
understood. Whether an extension is refused or ignored depends on its shape
and on the runtime. The comparison and the decision are recorded outside
this repository, in the design documents (doc 6).

Two pyagentspec details came up while writing these files. `check.py` and
`build.py` work around both:

- **Plugin field names.** The schema pyagentspec generates rejects
  `component_plugin_name` and `component_plugin_version`, although its own
  serializer writes them on plugin components.
- **Key order.** `$referenced_components` is written in set order, which
  changes between processes.
