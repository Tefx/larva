"""Canonical boundary regression tests after assembly/component removal."""

from __future__ import annotations

import larva.core.spec as spec_module
from larva.shell import cli, python_api
from larva.shell.mcp import LARVA_MCP_TOOLS


def test_core_spec_no_longer_exports_assembly_or_component_types() -> None:
    for name in (
        "AssemblyInput",
        "PromptComponent",
        "ToolsetComponent",
        "ConstraintComponent",
        "ModelComponent",
    ):
        assert not hasattr(spec_module, name)
        assert name not in spec_module.__all__


def test_public_shell_surfaces_do_not_reexport_removed_assembly_components() -> None:
    for module in (cli, python_api):
        assert not hasattr(module, "assemble")
        assert not hasattr(module, "assemble_command")
        assert not hasattr(module, "component_list_command")
        assert not hasattr(module, "component_show_command")


def test_mcp_inventory_has_only_variant_not_assembly_component_tools() -> None:
    names = {tool["name"] for tool in LARVA_MCP_TOOLS}
    assert "larva_assemble" not in names
    assert "larva_component_list" not in names
    assert "larva_component_show" not in names
    assert "larva_variant_list" in names
    assert "larva_variant_activate" in names
    assert "larva_variant_delete" in names
