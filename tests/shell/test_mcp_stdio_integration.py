"""Integration tests for ``larva mcp`` stdio transport.

Verifies the full MCP server runtime end-to-end: spawn ``larva mcp`` as a
subprocess, connect via the MCP SDK's stdio client, and exercise tool calls
through the real protocol.

These tests require the ``mcp`` optional dependency.
"""

from __future__ import annotations

import sys

import anyio
import pytest

from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client


LARVA_MCP_CMD = StdioServerParameters(
    command=sys.executable,
    args=["-c", "from larva.shell.cli import main; main(['mcp'])"],
)


@pytest.fixture()
def _require_mcp() -> None:
    """Skip if mcp package is not available."""
    pytest.importorskip("mcp")


@pytest.mark.usefixtures("_require_mcp")
class TestMCPStdioIntegration:
    """End-to-end tests over real stdio transport."""

    def test_initialize_and_list_tools(self) -> None:
        """Server initializes and exposes all 13 tools."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert len(tool_names) == 13
                    assert "larva.validate" in tool_names
                    assert "larva.assemble" in tool_names
                    assert "larva.list" in tool_names

        anyio.run(_run)

    def test_validate_tool_call(self) -> None:
        """Call larva.validate with a minimal valid spec."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "larva.validate",
                        arguments={
                            "spec": {
                                "id": "test-persona",
                                "version": "1.0.0",
                                "name": "Test",
                                "model": "claude-sonnet-4-5-20250514",
                                "prompts": ["default"],
                            }
                        },
                    )
                    assert len(result.content) > 0
                    text = result.content[0].text
                    assert "valid" in text.lower() or "true" in text.lower()

        anyio.run(_run)

    def test_list_tool_call(self) -> None:
        """Call larva.list — returns empty or populated registry."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("larva.list", arguments={})
                    assert len(result.content) > 0

        anyio.run(_run)

    def test_component_list_tool_call(self) -> None:
        """Call larva.component_list — returns available components."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "larva.component_list", arguments={}
                    )
                    assert len(result.content) > 0

        anyio.run(_run)

    def test_error_envelope_on_invalid_call(self) -> None:
        """Call larva.resolve with missing id returns error envelope."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "larva.resolve", arguments={}
                    )
                    assert len(result.content) > 0
                    text = result.content[0].text
                    # Should contain error info (missing required param)
                    assert "error" in text.lower() or "required" in text.lower() or "MISSING_PARAM" in text

        anyio.run(_run)
