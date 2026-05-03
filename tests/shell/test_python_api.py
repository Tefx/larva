"""Python API tests for the variant-only public surface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from returns.result import Success

from larva.core.spec import PersonaSpec
from larva.shell import python_api
from tests.shell.fixture_taxonomy import canonical_persona_spec


@dataclass
class RecordingFacade:
    def validate(self, spec: PersonaSpec) -> dict[str, object]:
        return {"valid": True, "errors": [], "warnings": []}

    def register(self, spec: PersonaSpec, variant: str | None = None):
        return Success({"id": spec["id"], "registered": True})

    def resolve(
        self,
        persona_id: str,
        overrides: dict[str, Any] | None = None,
        variant: str | None = None,
    ):
        spec = canonical_persona_spec(persona_id=persona_id)
        if variant is not None:
            spec["description"] = variant
        return Success(spec)


def test_python_api_has_no_assembly_or_component_exports() -> None:
    assert not hasattr(python_api, "assemble")
    assert not hasattr(python_api, "component_list")
    assert not hasattr(python_api, "component_show")


def test_python_api_resolve_forwards_variant(monkeypatch) -> None:
    monkeypatch.setattr(python_api, "_get_facade", lambda: RecordingFacade())

    result = python_api.resolve("persona", variant="tacit")

    assert result["description"] == "tacit"
