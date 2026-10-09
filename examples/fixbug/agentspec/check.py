"""Check the FixBug Agent Spec files (CI).

1. The committed files are what ``build.py`` writes.
2. Both configurations load with pyagentspec 26.3.1 (the extended one with the Mandate
   plugin) and serialize back to the same text.
3. Both validate against the Agent Spec JSON Schema: the plain file against the core
   components only, the extended file with the Mandate components added.
4. The plain file uses only core components; the extended file needs the plugin.
5. Each Mandate component is classified by what an Agent Spec runtime without Mandate's
   execution logic does with it: ``silent`` when a core parent class can run it and its
   added fields are dropped, ``refused`` when nothing can run it, ``data`` when it is only
   referenced from other components. The classification must match EXPECTED.
"""

import sys
from pathlib import Path
from typing import Dict, List, Optional, Type

import jsonschema
import yaml

from pyagentspec.component import Component
from pyagentspec.serialization import AgentSpecDeserializer

import build
import mandate_agentspec as mx

EXPECTED: Dict[str, str] = {
    "MandateFlow": "silent",
    "MandateAgent": "silent",
    "MandateAgentNode": "silent",
    "MandateEffectNode": "silent",
    "MandateVerifyNode": "refused",
    "MandateCapability": "data",
    "MandateContract": "data",
}

failures: List[str] = []


def check(ok: bool, message: str) -> None:
    print(("ok    " if ok else "FAIL  ") + message)
    if not ok:
        failures.append(message)


def core_parent(cls: Type[Component]) -> Optional[Type[Component]]:
    """The nearest core class an Agent Spec runtime can run in place of ``cls``."""
    for base in cls.__mro__[1:]:
        if isinstance(base, type) and issubclass(base, Component) and base._is_builtin_component() and not base._is_abstract:
            return base
    return None


def classify(cls: Type[Component]) -> str:
    from pyagentspec.flows.node import Node

    if core_parent(cls) is not None:
        return "silent"
    return "refused" if issubclass(cls, Node) else "data"


def component_types(doc) -> List[str]:
    found: List[str] = []
    if isinstance(doc, dict):
        if isinstance(doc.get("component_type"), str):
            found.append(doc["component_type"])
        for v in doc.values():
            found += component_types(v)
    elif isinstance(doc, list):
        for v in doc:
            found += component_types(v)
    return found


def main() -> int:
    # 1. Generated files are current.
    for path, content in build.outputs().items():
        committed = path.read_text(encoding="utf-8") if path.exists() else None
        check(committed == content, f"{path.name} is what build.py writes")

    plugins = mx.deserialization_plugins()
    texts = {p: p.read_text(encoding="utf-8") for p in (build.EXTENDED, build.PLAIN)}
    body = lambda t: t.removeprefix(build.HEADER)

    # 2. Load and round-trip.
    ext = AgentSpecDeserializer(plugins=plugins).from_yaml(body(texts[build.EXTENDED]))
    plain = AgentSpecDeserializer().from_yaml(body(texts[build.PLAIN]))
    check(isinstance(ext, mx.MandateFlow), "the extended file loads as a MandateFlow")
    check(build.dump(ext, True) == body(texts[build.EXTENDED]), "the extended file round-trips")
    check(build.dump(plain, False) == body(texts[build.PLAIN]), "the plain file round-trips")

    # 3. Schema validation.
    docs = {p: yaml.safe_load(t) for p, t in texts.items()}
    for path, schema in ((build.EXTENDED, mx.json_schema()), (build.PLAIN, mx.json_schema(core_only=True))):
        errors = list(jsonschema.Draft202012Validator(schema).iter_errors(docs[path]))
        check(not errors, f"{path.name} validates against the Agent Spec schema")
        for e in errors[:3]:
            print("      ", list(e.absolute_path), e.message[:200])

    # 4. Plain is core-only; the extension needs the plugin.
    plain_types = set(component_types(docs[build.PLAIN]))
    check(all(Component.get_class_from_name(t)._is_builtin_component() for t in plain_types), "the plain file uses only core components")
    try:
        AgentSpecDeserializer().from_yaml(body(texts[build.EXTENDED]))
        check(False, "the extended file is refused without the plugin")
    except ValueError as e:
        check("no plugin to load" in str(e), f"the extended file is refused without the plugin ({e})")

    # 5. What a runtime without Mandate's execution logic does with each component.
    used = set(component_types(docs[build.EXTENDED])) & set(mx.COMPONENTS)
    check(used == set(EXPECTED), "the extended file uses every Mandate component")
    print("\n      component            fate     runs as        fields dropped")
    for name in sorted(EXPECTED):
        cls = mx.COMPONENTS[name]
        parent = core_parent(cls)
        base = next(b for b in cls.__mro__[1:] if b._is_builtin_component() or b is Component)
        dropped = sorted(set(cls.model_fields) - set(base.model_fields))
        print(f"      {name:<20} {classify(cls):<8} {parent.__name__ if parent else '-':<14} {', '.join(dropped)}")
        check(classify(cls) == EXPECTED[name], f"{name} is {EXPECTED[name]}")

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
