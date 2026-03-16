"""MCP server runtime for larva.

Bridges ``MCPHandlers`` to a FastMCP server instance, registering all
tools from ``LARVA_MCP_TOOLS`` and delegating to the handler methods.

Usage::

    larva mcp          # starts stdio transport (used by MCP clients)
    pip install larva[mcp]  # required for mcp dependency

Architecture:
    Shell zone module — handles I/O (MCP transport), delegates to
    app-layer facade via MCPHandlers.

Boundary citations:
    - INTERFACES.md :: A. MCP Server Interface
    - ARCHITECTURE.md :: Module: ``larva.shell.mcp``
"""

from __future__ import annotations

import inspect
import json
import sys
from typing import Any

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    FastMCP = None  # type: ignore[assignment, misc]

from larva.shell.mcp_contract import LARVA_MCP_TOOLS, MCPToolDefinition


# @invar:allow shell_result: pure string transform helper for MCP registration
def _tool_name_to_handler_attr(tool_name: str) -> str:
    """Map MCP tool name to MCPHandlers method name.

    >>> _tool_name_to_handler_attr("larva.validate")
    'handle_validate'
    >>> _tool_name_to_handler_attr("larva.component_list")
    'handle_component_list'
    """
    # Strip 'larva.' prefix and prepend 'handle_'
    suffix = tool_name.removeprefix("larva.")
    return f"handle_{suffix}"


# @invar:allow shell_result: predicate helper for MCP error detection
def _is_error_envelope(result: object) -> bool:
    """Check if a result is a LarvaError envelope.

    >>> _is_error_envelope({"code": "NOT_FOUND", "numeric_code": 100, "message": "x", "details": {}})
    True
    >>> _is_error_envelope({"valid": True, "errors": [], "warnings": []})
    False
    """
    return (
        isinstance(result, dict)
        and "code" in result
        and "numeric_code" in result
        and "message" in result
    )


# @invar:allow shell_result: factory returns FastMCP server object, not Result
# @invar:allow dead_export: factory function used by CLI and tests
def create_mcp_server(
    handlers: object | None = None,
) -> FastMCP:
    """Create a FastMCP server with all larva tools registered.

    Args:
        handlers: An ``MCPHandlers`` instance. If None, creates one
            with default facade and component store.

    Returns:
        Configured FastMCP server ready to run.

    Raises:
        ImportError: If ``mcp`` package is not installed.
    """
    if FastMCP is None:
        raise ImportError(
            "MCP dependencies not installed. Run: pip install larva[mcp]"
        )

    if handlers is None:
        from larva.shell.cli_helpers import build_default_facade
        from larva.shell.components import FilesystemComponentStore
        from larva.shell.mcp import MCPHandlers

        facade = build_default_facade()
        component_store = FilesystemComponentStore()
        handlers = MCPHandlers(facade=facade, components=component_store)

    server = FastMCP(name="larva")

    # Register each tool from LARVA_MCP_TOOLS
    for tool_def in LARVA_MCP_TOOLS:
        _register_tool(server, handlers, tool_def)

    return server


# @invar:allow shell_result: helper builds dynamic function for MCP registration
# @shell_orchestration: MCP framework registration wiring, not pure logic
def _build_tool_fn(method: Any, tool_def: MCPToolDefinition) -> Any:
    """Build a tool function with proper signature for FastMCP.

    FastMCP introspects function signatures via pydantic. Each tool function
    must have explicit keyword parameters matching the tool's input schema
    so FastMCP can validate arguments correctly.
    """
    tool_name = tool_def["name"]
    description = tool_def["description"]
    schema = tool_def["input_schema"]
    param_names = list(schema.get("properties", {}).keys())
    required = set(schema.get("required", []))

    # Build function source with correct signature
    # Parameters with defaults use None as sentinel (not required by schema)
    params = []
    for name in param_names:
        if name in required:
            params.append(name)
        else:
            params.append(f"{name}=None")

    param_str = ", ".join(params)
    fn_name = tool_name.replace(".", "_")

    # Build source code for the tool function
    source = f"def {fn_name}({param_str}):\n"
    source += f"    kwargs = {{}}\n"
    for name in param_names:
        if name in required:
            source += f"    kwargs['{name}'] = {name}\n"
        else:
            source += f"    if {name} is not None:\n"
            source += f"        kwargs['{name}'] = {name}\n"
    source += "    result = _method(kwargs)\n"
    source += "    if _is_err(result):\n"
    source += "        return _json_dumps(result)\n"
    source += "    return result\n"

    # Execute in a namespace that captures the handler method
    namespace: dict[str, Any] = {
        "_method": method,
        "_is_err": _is_error_envelope,
        "_json_dumps": json.dumps,
    }
    exec(source, namespace)  # noqa: S102

    fn = namespace[fn_name]
    fn.__doc__ = description
    return fn


# @shell_orchestration: MCP framework registration wiring, not pure logic
def _register_tool(
    server: FastMCP,
    handlers: object,
    tool_def: MCPToolDefinition,
) -> None:
    """Register a single tool on the FastMCP server.

    Creates a function with the correct signature for FastMCP's pydantic
    argument validation, delegating to the corresponding MCPHandlers method.
    """
    tool_name = tool_def["name"]
    handler_attr = _tool_name_to_handler_attr(tool_name)
    handler_method = getattr(handlers, handler_attr)

    fn = _build_tool_fn(handler_method, tool_def)

    # Programmatic registration with explicit name and description
    server.add_tool(
        fn,
        name=tool_name,
        description=tool_def["description"],
    )


# @invar:allow shell_result: MCP stdio entrypoint runs transport loop
# @invar:allow dead_export: CLI entry point called by framework
def run_mcp_stdio() -> None:
    """Start the MCP server with stdio transport.

    This is the entry point for ``larva mcp``. It creates a server
    with default handlers and runs the stdio transport loop.
    """
    server = create_mcp_server()
    server.run(transport="stdio")


__all__ = [
    "create_mcp_server",
    "run_mcp_stdio",
]
