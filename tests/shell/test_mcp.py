"""MCP tests for the variant-only public surface."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from returns.result import Success

from larva.shell.mcp import LARVA_ERROR_CODES, LARVA_MCP_TOOLS, MCPHandlers
from tests.shell.fixture_taxonomy import canonical_persona_spec


@dataclass
class RecordingFacade:
    def validate(self, spec: dict[str, object]) -> dict[str, object]:
        return {"valid": True, "errors": [], "warnings": []}

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

    def register(self, spec: dict[str, object], variant: str | None = None):
        return Success({"id": spec["id"], "registered": True})


def _tool_names() -> set[str]:
    return {tool["name"] for tool in LARVA_MCP_TOOLS}


def test_removed_assembly_and_component_tools_are_absent() -> None:
    names = _tool_names()
    assert "larva_assemble" not in names
    assert "larva_component_list" not in names
    assert "larva_component_show" not in names


def test_variant_tools_are_present() -> None:
    names = _tool_names()
    assert {"larva_variant_list", "larva_variant_activate", "larva_variant_delete"} <= names


def test_component_error_codes_are_removed() -> None:
    assert "COMPONENT_NOT_FOUND" not in LARVA_ERROR_CODES
    assert "COMPONENT_CONFLICT" not in LARVA_ERROR_CODES


def test_handlers_constructor_has_no_component_store_argument() -> None:
    annotations = MCPHandlers.__init__.__annotations__
    assert "components" not in annotations


def test_resolve_handler_forwards_variant() -> None:
    handler = MCPHandlers(RecordingFacade())
    result = handler.handle_resolve({"id": "persona", "variant": "tacit"})
    assert result["description"] == "tacit"
