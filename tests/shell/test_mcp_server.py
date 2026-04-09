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
# Import guard
# ---------------------------------------------------------------------------
