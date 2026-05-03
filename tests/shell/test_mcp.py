from __future__ import annotations

from pathlib import Path

from larva.app.facade import DefaultLarvaFacade, ERROR_NUMERIC_CODES
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell.components import FilesystemComponentStore
from larva.shell.mcp import MCPHandlers
from larva.shell.mcp_contract import LARVA_MCP_TOOLS
from larva.shell.registry import FileSystemRegistryStore


def _spec(persona_id: str, *, description: str = "base") -> dict[str, object]:
    return {
        "id": persona_id,
        "description": description,
        "prompt": f"Prompt for {persona_id}",
        "model": "openai/gpt-5.5",
        "capabilities": {},
        "spec_version": "0.1.0",
    }


def _facade(root: Path) -> DefaultLarvaFacade:
    return DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=FilesystemComponentStore(root / "components"),
        registry=FileSystemRegistryStore(root / "registry"),
    )


def test_mcp_tool_list_cutover() -> None:
    names = {tool["name"] for tool in LARVA_MCP_TOOLS}
    assert {"larva_variant_list", "larva_variant_activate", "larva_variant_delete"} <= names
    assert {"larva_assemble", "larva_component_list", "larva_component_show"}.isdisjoint(names)
    for tool in LARVA_MCP_TOOLS:
        assert "." not in tool["name"]


def test_mcp_variant_handlers_are_callable(tmp_path: Path) -> None:
    facade = _facade(tmp_path)
    handlers = MCPHandlers(facade)

    assert handlers.handle_register({"spec": _spec("mcp-persona")}) == {
        "id": "mcp-persona",
        "registered": True,
    }
    assert handlers.handle_register(
        {"spec": _spec("mcp-persona", description="tacit"), "variant": "tacit"}
    ) == {"id": "mcp-persona", "registered": True}

    listed = handlers.handle_variant_list({"id": "mcp-persona"})
    assert listed == {"id": "mcp-persona", "active": "default", "variants": ["default", "tacit"]}

    activated = handlers.handle_variant_activate({"id": "mcp-persona", "variant": "tacit"})
    assert activated == {"id": "mcp-persona", "active": "tacit"}

    resolved = handlers.handle_resolve({"id": "mcp-persona"})
    assert isinstance(resolved, dict)
    assert resolved["description"] == "tacit"
    assert "variant" not in resolved


def test_mcp_rejects_variant_inside_personaspec(tmp_path: Path) -> None:
    handlers = MCPHandlers(_facade(tmp_path))
    bad_spec = {**_spec("bad-persona"), "variant": "tacit"}
    result = handlers.handle_register({"spec": bad_spec})
    assert result["code"] == "PERSONA_INVALID"


def test_variant_error_codes_present() -> None:
    assert ERROR_NUMERIC_CODES["INVALID_VARIANT_NAME"] == 118
    assert ERROR_NUMERIC_CODES["VARIANT_NOT_FOUND"] == 119
    assert ERROR_NUMERIC_CODES["ACTIVE_VARIANT_DELETE_FORBIDDEN"] == 120
    assert ERROR_NUMERIC_CODES["LAST_VARIANT_DELETE_FORBIDDEN"] == 121
    assert ERROR_NUMERIC_CODES["PERSONA_ID_MISMATCH"] == 122
