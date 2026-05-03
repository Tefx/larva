from __future__ import annotations

from larva.shell.mcp_contract import LARVA_MCP_TOOLS
from larva.shell.mcp_server import _tool_name_to_handler_attr, create_mcp_server


def test_tool_name_mapping_for_variant_tools() -> None:
    assert _tool_name_to_handler_attr("larva_variant_list") == "handle_variant_list"
    assert _tool_name_to_handler_attr("larva_variant_activate") == "handle_variant_activate"
    assert _tool_name_to_handler_attr("larva_variant_delete") == "handle_variant_delete"


def test_mcp_server_registration_matches_cutover_tool_list() -> None:
    server = create_mcp_server()
    registered = {tool.name for tool in server._tool_manager.list_tools()}
    declared = {tool["name"] for tool in LARVA_MCP_TOOLS}
    assert registered == declared
    assert {"larva_variant_list", "larva_variant_activate", "larva_variant_delete"} <= registered
    assert {"larva_assemble", "larva_component_list", "larva_component_show"}.isdisjoint(registered)
