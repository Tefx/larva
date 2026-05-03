from __future__ import annotations

from larva.shell.mcp_contract import LARVA_MCP_TOOLS


def test_stdio_tool_inventory_source_has_cutover_names() -> None:
    # The stdio server registers exactly LARVA_MCP_TOOLS at startup; this pins the
    # transport-facing inventory without opening a subprocess in every focused run.
    tool_names = {tool["name"] for tool in LARVA_MCP_TOOLS}
    assert {"larva_variant_list", "larva_variant_activate", "larva_variant_delete"} <= tool_names
    assert {"larva_assemble", "larva_component_list", "larva_component_show"}.isdisjoint(tool_names)
