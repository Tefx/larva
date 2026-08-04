"""Integration tests for ``larva mcp`` stdio transport.

Verifies the full MCP server runtime end-to-end: spawn ``larva mcp`` as a
subprocess, connect via the MCP SDK's stdio client, and exercise tool calls
through the real protocol.

These tests require the ``mcp`` optional dependency.
"""

from __future__ import annotations

import email
import importlib.metadata
import subprocess
import sys
import zipfile
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

ROOT = Path(__file__).resolve().parents[2]
PYPROJECT = ROOT / "pyproject.toml"

LARVA_MCP_CMD = StdioServerParameters(
    command=sys.executable,
    args=["-c", "from larva.shell.cli import main; main(['mcp'])"],
)


@pytest.fixture()
def _require_mcp() -> None:
    """Skip if mcp package is not available."""
    pytest.importorskip("mcp")


def _mcp_requirements_from_wheel(wheel: Path) -> list[str]:
    """Return MCP Requires-Dist entries from one built wheel."""
    with zipfile.ZipFile(wheel) as archive:
        metadata_name = next(
            name for name in archive.namelist() if name.endswith(".dist-info/METADATA")
        )
        message = email.message_from_bytes(archive.read(metadata_name))
    return [
        requirement
        for requirement in message.get_all("Requires-Dist", [])
        if requirement.lower().startswith("mcp")
    ]


def test_mcp_dependency_excludes_incompatible_major() -> None:
    """Project metadata must keep the FastMCP 1.x import compatible."""
    import tomllib

    project = tomllib.loads(PYPROJECT.read_text(encoding="utf-8"))["project"]
    requirements = [
        requirement
        for requirement in project["dependencies"]
        if requirement.lower().startswith("mcp")
    ]
    assert requirements == ["mcp>=1.20,<2"]


def test_built_wheel_metadata_excludes_mcp_2(tmp_path: Path) -> None:
    """Release artifact must carry the MCP upper bound, not only source config."""
    completed = subprocess.run(
        ["uv", "build", "--wheel", "--out-dir", str(tmp_path)],
        cwd=ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert completed.returncode == 0, completed.stderr
    wheels = list(tmp_path.glob("larva-*.whl"))
    assert len(wheels) == 1
    assert _mcp_requirements_from_wheel(wheels[0]) == ["mcp<2,>=1.20"]


def test_runtime_uses_supported_mcp_major() -> None:
    """The checked environment must exercise the supported SDK major."""
    assert int(importlib.metadata.version("mcp").split(".", 1)[0]) == 1


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
                    assert "larva_validate" in tool_names
                    assert "larva_assemble" not in tool_names
                    assert "larva_variant_list" in tool_names
                    assert "larva_list" in tool_names

        anyio.run(_run)

    def test_validate_tool_call(self) -> None:
        """Call larva_validate with a minimal valid spec."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool(
                        "larva_validate",
                        arguments={
                            "spec": {
                                "id": "test-persona",
                                "description": "Test persona",
                                "prompt": "You are a careful tester.",
                                "model": "claude-sonnet-4-5-20250514",
                                "capabilities": {"shell": "read_only"},
                                "spec_version": "0.1.0",
                            }
                        },
                    )
                    assert len(result.content) > 0
                    text = result.content[0].text
                    assert "valid" in text.lower() or "true" in text.lower()

        anyio.run(_run)

    def test_list_tool_call(self) -> None:
        """Call larva_list — returns empty or populated registry."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("larva_list", arguments={})
                    assert len(result.content) > 0

        anyio.run(_run)

    def test_component_list_tool_call(self) -> None:
        """Component list is removed; variant_list is callable."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("larva_variant_list", arguments={"id": "missing"})
                    assert len(result.content) > 0

        anyio.run(_run)

    def test_error_envelope_on_invalid_call(self) -> None:
        """Call larva_resolve with missing id returns error envelope."""

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.call_tool("larva_resolve", arguments={})
                    assert len(result.content) > 0
                    text = result.content[0].text
                    # Should contain error info (missing required param)
                    assert (
                        "error" in text.lower()
                        or "required" in text.lower()
                        or "MISSING_PARAM" in text
                    )

        anyio.run(_run)


# ---------------------------------------------------------------------------
# Surface Cutover: implemented cutover assertions
#
# These guard implemented surface contracts: assembly/component tools stay
# removed and variant tools stay registered.
#
# Source authority: design/registry-local-variants-and-assembly-removal.md
# Source authority: docs/reference/INTERFACES.md :: MCP Surface
# Source authority: opifex/conformance/case_matrix/larva/larva.mcp_server_naming.yaml
# ---------------------------------------------------------------------------


@pytest.mark.usefixtures("_require_mcp")
class TestMCPStdioSurfaceCutover:
    """MCP stdio integration must expose variant tools, not assembly/component."""


    def test_variant_list_tool_exists_over_stdio(self) -> None:
        """larva_variant_list MUST be exposed over MCP stdio transport after cutover.

        Source: INTERFACES.md line 51; case_matrix larva.mcp_server_naming.yaml.
        """

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert "larva_variant_list" in tool_names, (
                        f"larva_variant_list not found over stdio. "
                        f"Available: {sorted(tool_names)}"
                    )

        anyio.run(_run)

    def test_variant_activate_tool_exists_over_stdio(self) -> None:
        """larva_variant_activate MUST be exposed over MCP stdio transport after cutover.

        Source: INTERFACES.md line 52.
        """

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert "larva_variant_activate" in tool_names, (
                        f"larva_variant_activate not found over stdio. "
                        f"Available: {sorted(tool_names)}"
                    )

        anyio.run(_run)

    def test_variant_delete_tool_exists_over_stdio(self) -> None:
        """larva_variant_delete MUST be exposed over MCP stdio transport after cutover.

        Source: INTERFACES.md line 53.
        """

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert "larva_variant_delete" in tool_names, (
                        f"larva_variant_delete not found over stdio. "
                        f"Available: {sorted(tool_names)}"
                    )

        anyio.run(_run)

    def test_assemble_tool_removed_over_stdio(self) -> None:
        """larva_assemble MUST NOT be exposed over MCP stdio transport after cutover.

        Source: INTERFACES.md line 57; design doc lines 125-129.
        """

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert "larva_assemble" not in tool_names, (
                        "larva_assemble still exposed over stdio. "
                        "Assembly removed per INTERFACES.md."
                    )

        anyio.run(_run)

    def test_component_list_tool_removed_over_stdio(self) -> None:
        """larva_component_list MUST NOT be exposed over MCP stdio transport after cutover.

        Source: INTERFACES.md line 58.
        """

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert "larva_component_list" not in tool_names, (
                        "larva_component_list still exposed over stdio. "
                        "Component subsystem removed per INTERFACES.md."
                    )

        anyio.run(_run)

    def test_component_show_tool_removed_over_stdio(self) -> None:
        """larva_component_show MUST NOT be exposed over MCP stdio transport after cutover.

        Source: INTERFACES.md line 59.
        """

        async def _run() -> None:
            async with stdio_client(LARVA_MCP_CMD) as (read, write):
                async with ClientSession(read, write) as session:
                    await session.initialize()
                    result = await session.list_tools()
                    tool_names = {t.name for t in result.tools}
                    assert "larva_component_show" not in tool_names, (
                        "larva_component_show still exposed over stdio. "
                        "Component subsystem removed per INTERFACES.md."
                    )

        anyio.run(_run)
