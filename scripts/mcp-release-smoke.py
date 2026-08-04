#!/usr/bin/env python3
"""Verify a built Larva wheel through a clean ``uvx ... larva mcp`` process."""

from __future__ import annotations

import email
import importlib.metadata
import json
import os
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

import anyio
from mcp import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

EXPECTED_TOOLS = {
    "larva_clear",
    "larva_clone",
    "larva_delete",
    "larva_export",
    "larva_list",
    "larva_register",
    "larva_resolve",
    "larva_update",
    "larva_update_batch",
    "larva_validate",
    "larva_variant_activate",
    "larva_variant_delete",
    "larva_variant_list",
}


def _wheel_mcp_requirement(wheel: Path) -> str:
    with zipfile.ZipFile(wheel) as archive:
        metadata_name = next(name for name in archive.namelist() if name.endswith(".dist-info/METADATA"))
        message = email.message_from_bytes(archive.read(metadata_name))
    requirements = message.get_all("Requires-Dist", [])
    matches = [requirement for requirement in requirements if requirement.lower().startswith("mcp")]
    if len(matches) != 1:
        raise RuntimeError(f"expected one MCP wheel requirement, found {matches!r}")
    requirement = matches[0]
    normalized = requirement.lower().replace(" ", "")
    if ">=1.20" not in normalized or "<2" not in normalized:
        raise RuntimeError(f"wheel does not constrain MCP to the supported major: {requirement}")
    return requirement


def _resolved_versions(wheel: Path, env: dict[str, str]) -> dict[str, str]:
    code = (
        "import importlib.metadata as m, json; "
        "print(json.dumps({'larva': m.version('larva'), 'mcp': m.version('mcp')}))"
    )
    completed = subprocess.run(
        [
            "uv",
            "run",
            "--isolated",
            "--no-project",
            "--with",
            str(wheel),
            "python",
            "-c",
            code,
        ],
        check=True,
        capture_output=True,
        text=True,
        env=env,
        timeout=180,
    )
    return json.loads(completed.stdout)


async def _probe_uvx(wheel: Path, env: dict[str, str]) -> list[str]:
    parameters = StdioServerParameters(
        command="uvx",
        args=["--from", str(wheel), "larva", "mcp"],
        env=env,
    )
    with anyio.fail_after(180):
        async with stdio_client(parameters) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                result = await session.list_tools()
                return sorted(tool.name for tool in result.tools)


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage: python scripts/mcp-release-smoke.py <larva-wheel>", file=sys.stderr)
        return 2
    wheel = Path(args[0]).resolve()
    if not wheel.is_file() or wheel.suffix != ".whl":
        print(f"wheel not found: {wheel}", file=sys.stderr)
        return 2

    requirement = _wheel_mcp_requirement(wheel)
    with tempfile.TemporaryDirectory(prefix="larva-mcp-release-smoke-") as cache:
        env = {**os.environ, "UV_CACHE_DIR": cache}
        versions = _resolved_versions(wheel, env)
        if int(versions["mcp"].split(".", 1)[0]) >= 2:
            raise RuntimeError(f"clean wheel install resolved unsupported MCP {versions['mcp']}")
        tools = anyio.run(_probe_uvx, wheel, env)

    actual_tools = set(tools)
    missing = sorted(EXPECTED_TOOLS.difference(actual_tools))
    unexpected = sorted(actual_tools.difference(EXPECTED_TOOLS))
    if missing or unexpected:
        raise RuntimeError(
            f"unexpected MCP tool surface: missing={missing} unexpected={unexpected}"
        )
    print(
        json.dumps(
            {
                "wheel": wheel.name,
                "wheel_mcp_requirement": requirement,
                "resolved_larva": versions["larva"],
                "resolved_mcp": versions["mcp"],
                "tool_count": len(tools),
                "tools": tools,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
