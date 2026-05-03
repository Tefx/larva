"""Unit tests for ``larva.shell.mcp_server`` — FastMCP server runtime.

Tests verify:
- Server creation and tool registration
- Tool name contract compliance with LARVA_MCP_TOOLS
- Tool delegation to MCPHandlers
- Error envelope serialization
- Import guard behavior

Scope: MCP server bridge layer. Does NOT test MCPHandlers behavior
(covered by test_mcp.py) or stdio transport (covered by integration-proof).
"""

from __future__ import annotations

import json
import sys
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from larva.shell.mcp_contract import LARVA_MCP_TOOLS
from larva.shell.mcp_server import (
    _is_error_envelope,
    _tool_name_to_handler_attr,
    create_mcp_server,
)


# ---------------------------------------------------------------------------
# Helper: tool name mapping
# ---------------------------------------------------------------------------


class TestToolNameMapping:
    """Tests for _tool_name_to_handler_attr helper."""

    def test_validate(self) -> None:
        assert _tool_name_to_handler_attr("larva_validate") == "handle_validate"

    def test_component_list(self) -> None:
        assert _tool_name_to_handler_attr("larva_component_list") == "handle_component_list"

    def test_component_show(self) -> None:
        assert _tool_name_to_handler_attr("larva_component_show") == "handle_component_show"

    def test_update_batch(self) -> None:
        assert _tool_name_to_handler_attr("larva_update_batch") == "handle_update_batch"


# ---------------------------------------------------------------------------
# Helper: error envelope detection
# ---------------------------------------------------------------------------


class TestErrorEnvelope:
    """Tests for _is_error_envelope helper."""

    def test_larva_error_detected(self) -> None:
        error = {
            "code": "NOT_FOUND",
            "numeric_code": 100,
            "message": "Persona not found",
            "details": {},
        }
        assert _is_error_envelope(error) is True

    def test_success_dict_not_detected(self) -> None:
        result = {"valid": True, "errors": [], "warnings": []}
        assert _is_error_envelope(result) is False

    def test_non_dict_not_detected(self) -> None:
        assert _is_error_envelope("string") is False
        assert _is_error_envelope(42) is False
        assert _is_error_envelope(None) is False

    def test_partial_error_not_detected(self) -> None:
        # Missing numeric_code
        assert _is_error_envelope({"code": "X", "message": "Y"}) is False


# ---------------------------------------------------------------------------
# Server creation
# ---------------------------------------------------------------------------


class TestCreateMcpServer:
    """Tests for create_mcp_server factory."""

    def test_returns_fastmcp_instance(self) -> None:
        from mcp.server.fastmcp import FastMCP

        server = create_mcp_server()
        assert isinstance(server, FastMCP)

    def test_all_tools_registered(self) -> None:
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert len(registered) == 13

    def test_tool_names_match_contract(self) -> None:
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        expected = {t["name"] for t in LARVA_MCP_TOOLS}
        assert registered == expected

    def test_validate_tool_schema_rejects_missing_required_persona_fields(self) -> None:
        server = create_mcp_server()
        tool = server._tool_manager._tools["larva_validate"]

        with pytest.raises(ValueError, match=r"params\.spec\.description is required"):
            tool.fn(spec={"id": "missing-fields"})

    def test_register_tool_schema_rejects_forbidden_top_level_fields(self) -> None:
        server = create_mcp_server()
        tool = server._tool_manager._tools["larva_register"]
        invalid_spec = {
            "id": "bad",
            "description": "bad",
            "prompt": "bad",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
            "tools": {"shell": "read_only"},
        }

        with pytest.raises(ValueError, match=r"params\.spec\.tools is not permitted"):
            tool.fn(spec=invalid_spec)

    def test_validate_tool_schema_rejects_unknown_top_level_fields(self) -> None:
        server = create_mcp_server()
        tool = server._tool_manager._tools["larva_validate"]
        invalid_spec = {
            "id": "bad",
            "description": "bad",
            "prompt": "bad",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
            "unexpected": True,
        }

        with pytest.raises(ValueError, match=r"params\.spec\.unexpected is not permitted"):
            tool.fn(spec=invalid_spec)

    def test_accepts_custom_handlers(self) -> None:
        """Verify create_mcp_server works with injected handlers."""
        mock_handlers = MagicMock()
        # Set up handler methods for all 13 tools
        for tool_def in LARVA_MCP_TOOLS:
            attr = _tool_name_to_handler_attr(tool_def["name"])
            getattr(mock_handlers, attr).return_value = {"ok": True}

        server = create_mcp_server(handlers=mock_handlers)
        registered = set(server._tool_manager._tools.keys())
        expected = {t["name"] for t in LARVA_MCP_TOOLS}
        assert registered == expected

    def test_default_server_uses_shared_facade_factory(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        facade = object()
        recorded: dict[str, object] = {}

        class RecordingHandlers:
            def __init__(self, facade: object, components: object) -> None:
                recorded["facade"] = facade
                recorded["components"] = components

            def __getattr__(self, name: str) -> Any:
                if name.startswith("handle_"):
                    return lambda params: {"ok": True, "params": params}
                raise AttributeError(name)

        monkeypatch.setattr(
            "larva.shell.shared.facade_factory.build_default_facade",
            lambda: facade,
        )
        monkeypatch.setattr("larva.shell.mcp.MCPHandlers", RecordingHandlers)

        create_mcp_server()

        assert recorded["facade"] is facade
        assert recorded["components"].__class__.__name__ == "FilesystemComponentStore"


# ---------------------------------------------------------------------------
# Tool delegation
# ---------------------------------------------------------------------------


class TestToolDelegation:
    """Tests that registered tools properly delegate to MCPHandlers."""

    @pytest.fixture()
    def mock_handlers(self) -> MagicMock:
        handlers = MagicMock()
        for tool_def in LARVA_MCP_TOOLS:
            attr = _tool_name_to_handler_attr(tool_def["name"])
            getattr(handlers, attr).return_value = {"result": "ok"}
        return handlers

    @pytest.fixture()
    def server(self, mock_handlers: MagicMock) -> Any:
        return create_mcp_server(handlers=mock_handlers)

    def _call_tool(self, server: Any, tool_name: str, **kwargs: Any) -> Any:
        """Call a registered tool function directly."""
        tool = server._tool_manager._tools[tool_name]
        return tool.fn(**kwargs)

    def test_validate_tool_delegates(self, server: Any, mock_handlers: MagicMock) -> None:
        spec = {
            "id": "test",
            "description": "test",
            "prompt": "test",
            "model": "gpt-4o-mini",
            "capabilities": {"shell": "read_only"},
            "spec_version": "0.1.0",
        }
        result = self._call_tool(server, "larva_validate", spec=spec)
        mock_handlers.handle_validate.assert_called_once_with({"spec": spec})
        assert result == {"result": "ok"}

    def test_list_tool_delegates(self, server: Any, mock_handlers: MagicMock) -> None:
        result = self._call_tool(server, "larva_list")
        mock_handlers.handle_list.assert_called_once_with({})
        assert result == {"result": "ok"}

    def test_delete_tool_delegates(self, server: Any, mock_handlers: MagicMock) -> None:
        result = self._call_tool(server, "larva_delete", id="my-persona")
        mock_handlers.handle_delete.assert_called_once_with({"id": "my-persona"})

    def test_clone_tool_delegates(self, server: Any, mock_handlers: MagicMock) -> None:
        result = self._call_tool(server, "larva_clone", source_id="src", new_id="dst")
        mock_handlers.handle_clone.assert_called_once_with({"source_id": "src", "new_id": "dst"})

    def test_success_returns_content_directly(self, server: Any, mock_handlers: MagicMock) -> None:
        """Verify successful results are returned directly (not JSON-encoded)."""
        mock_handlers.handle_list.return_value = [{"id": "p1"}, {"id": "p2"}]
        result = self._call_tool(server, "larva_list")
        assert result == [{"id": "p1"}, {"id": "p2"}]

    def test_error_envelope_returned_as_json_string(
        self, server: Any, mock_handlers: MagicMock
    ) -> None:
        """Verify LarvaError envelopes are serialized to JSON strings."""
        error = {
            "code": "NOT_FOUND",
            "numeric_code": 100,
            "message": "Persona not found",
            "details": {"id": "missing"},
        }
        mock_handlers.handle_resolve.return_value = error
        result = self._call_tool(server, "larva_resolve", id="missing")
        assert isinstance(result, str)
        parsed = json.loads(result)
        assert parsed["code"] == "NOT_FOUND"
        assert parsed["numeric_code"] == 100


# ---------------------------------------------------------------------------
# Surface Cutover: EXPECTED-RED assertions
#
# These assert TARGET-STATE surface contracts that have NOT been cut over yet.
# They MUST fail RED until the implementation phase removes assembly/component
# tools and adds variant tools.
#
# Source authority: design/registry-local-variants-and-assembly-removal.md
# Source authority: docs/reference/INTERFACES.md :: MCP Surface
# Source authority: opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
# ---------------------------------------------------------------------------


class TestMCPServerVariantTools:
    """EXPECTED-RED: MCP server must register variant tools and remove assembly/component tools.

    Source: INTERFACES.md :: MCP Surface (lines 40-59)
    Source: design/registry-local-variants-and-assembly-removal.md :: MCP surface (lines 117-143)
    Source: opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
    """

    def test_variant_list_tool_registered_on_server(self) -> None:
        """larva_variant_list MUST be registered on the MCP server after cutover."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert "larva_variant_list" in registered, (
            f"larva_variant_list not registered. "
            f"Current tools: {sorted(registered)}. "
            f"Expected per INTERFACES.md and case_matrix."
        )

    def test_variant_activate_tool_registered_on_server(self) -> None:
        """larva_variant_activate MUST be registered on the MCP server after cutover."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert "larva_variant_activate" in registered, (
            f"larva_variant_activate not registered. "
            f"Current tools: {sorted(registered)}. "
            f"Expected per INTERFACES.md and case_matrix."
        )

    def test_variant_delete_tool_registered_on_server(self) -> None:
        """larva_variant_delete MUST be registered on the MCP server after cutover."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert "larva_variant_delete" in registered, (
            f"larva_variant_delete not registered. "
            f"Current tools: {sorted(registered)}. "
            f"Expected per INTERFACES.md and case_matrix."
        )

    def test_assemble_tool_removed_from_server(self) -> None:
        """larva_assemble MUST NOT be registered on the MCP server after cutover."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert "larva_assemble" not in registered, (
            f"larva_assemble still registered on MCP server. "
            f"Assembly removed per INTERFACES.md and design doc."
        )

    def test_component_list_tool_removed_from_server(self) -> None:
        """larva_component_list MUST NOT be registered on the MCP server after cutover."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert "larva_component_list" not in registered, (
            f"larva_component_list still registered on MCP server. "
            f"Component subsystem removed per INTERFACES.md and design doc."
        )

    def test_component_show_tool_removed_from_server(self) -> None:
        """larva_component_show MUST NOT be registered on the MCP server after cutover."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        assert "larva_component_show" not in registered, (
            f"larva_component_show still registered on MCP server. "
            f"Component subsystem removed per INTERFACES.md and design doc."
        )

    def test_server_tool_count_matches_cutover_contract(self) -> None:
        """After cutover, server must have 13 tools (16 minus 3 removed plus 3 added)."""
        server = create_mcp_server()
        registered = set(server._tool_manager._tools.keys())
        # Target: validate, register, resolve, list, update, delete, clear,
        # clone, export, update_batch, variant_list, variant_activate, variant_delete = 13
        # Current: 13 tools (including assemble, component_list, component_show,
        #          lacking variant_* = 13)
        # After cutover: still 13 (remove 3, add 3)
        expected_count_after_cutover = 13
        assert len(registered) == expected_count_after_cutover, (
            f"Expected {expected_count_after_cutover} tools after cutover, "
            f"got {len(registered)}: {sorted(registered)}"
        )

    def test_variant_handler_methods_exist(self) -> None:
        """EXPECTED-RED: MCPHandlers must have variant handler methods."""
        from larva.shell.mcp import MCPHandlers

        for method_name in ["handle_variant_list", "handle_variant_activate", "handle_variant_delete"]:
            assert hasattr(MCPHandlers, method_name), (
                f"MCPHandlers missing {method_name}. "
                f"Expected variant handler methods per INTERFACES.md."
            )

    def test_tool_name_mapping_includes_variant_tools(self) -> None:
        """EXPECTED-RED: _tool_name_to_handler_attr must map variant tools."""
        for expected_mapping in [
            ("larva_variant_list", "handle_variant_list"),
            ("larva_variant_activate", "handle_variant_activate"),
            ("larva_variant_delete", "handle_variant_delete"),
        ]:
            tool_name, expected_attr = expected_mapping
            result = _tool_name_to_handler_attr(tool_name)
            assert result == expected_attr, (
                f"_tool_name_to_handler_attr('{tool_name}') = '{result}', "
                f"expected '{expected_attr}'"
            )


# ---------------------------------------------------------------------------
# Import guard
# ---------------------------------------------------------------------------
