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

import json
from typing import Annotated, Any

from mcp.server.fastmcp import FastMCP
from pydantic import WithJsonSchema

from larva.shell.mcp_contract import LARVA_MCP_TOOLS, MCPToolDefinition


def _annotation_for_schema(schema: dict[str, object]) -> object:
    """Build a Python annotation that preserves the declared MCP JSON schema."""
    schema_type = schema.get("type")
    python_type: object
    if schema_type == "string":
        python_type = str
    elif schema_type == "integer":
        python_type = int
    elif schema_type == "number":
        python_type = float
    elif schema_type == "boolean":
        python_type = bool
    elif schema_type == "array":
        python_type = list[object]
    elif schema_type == "object":
        python_type = dict[str, object]
    else:
        python_type = object
    return Annotated[python_type, WithJsonSchema(schema)]


def _schema_type_matches(value: object, schema_type: object) -> bool:
    if schema_type == "string":
        return isinstance(value, str)
    if schema_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if schema_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "array":
        return isinstance(value, list)
    if schema_type == "object":
        return isinstance(value, dict)
    return True


def _validate_schema_value(value: object, schema: dict[str, object], path: str) -> str | None:
    schema_type = schema.get("type")
    if not _schema_type_matches(value, schema_type):
        return f"{path} must match schema type {schema_type}"
    if schema_type != "object":
        if schema_type == "array" and isinstance(value, list):
            item_schema = schema.get("items")
            if isinstance(item_schema, dict):
                for index, item in enumerate(value):
                    if error := _validate_schema_value(item, item_schema, f"{path}[{index}]"):
                        return error
        return None
    if not isinstance(value, dict):
        return f"{path} must be an object"
    properties = schema.get("properties", {})
    required = schema.get("required", [])
    if isinstance(required, list):
        for field in required:
            if isinstance(field, str) and field not in value:
                return f"{path}.{field} is required"
    if schema.get("additionalProperties") is False and isinstance(properties, dict):
        for key in value:
            if key not in properties:
                return f"{path}.{key} is not permitted"
    if not isinstance(properties, dict):
        return None
    for key, sub_schema in properties.items():
        if key in value and isinstance(sub_schema, dict):
            if error := _validate_schema_value(value[key], sub_schema, f"{path}.{key}"):
                return error
    return None


# @invar:allow shell_result: pure string transform helper for MCP registration
def _tool_name_to_handler_attr(tool_name: str) -> str:
    """Map MCP tool name to MCPHandlers method name.

    >>> _tool_name_to_handler_attr("larva_validate")
    'handle_validate'
    >>> _tool_name_to_handler_attr("larva_component_list")
    'handle_component_list'
    """
    # Strip 'larva_' prefix and prepend 'handle_'
    suffix = tool_name.removeprefix("larva_")
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
    if handlers is None:
        from larva.shell.components import FilesystemComponentStore
        from larva.shell.mcp import MCPHandlers
        from larva.shell.shared.facade_factory import build_default_facade

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
    source += "    schema_error = _validate_schema(kwargs, _schema, 'params')\n"
    source += "    if schema_error is not None:\n"
    source += "        raise ValueError(schema_error)\n"
    source += "    result = _method(kwargs)\n"
    source += "    if _is_err(result):\n"
    source += "        return _json_dumps(result)\n"
    source += "    return result\n"

    # Execute in a namespace that captures the handler method
    namespace: dict[str, Any] = {
        "_method": method,
        "_is_err": _is_error_envelope,
        "_json_dumps": json.dumps,
        "_schema": schema,
        "_validate_schema": _validate_schema_value,
    }
    exec(source, namespace)  # noqa: S102

    fn = namespace[fn_name]
    fn.__doc__ = description
    annotations = {name: _annotation_for_schema(schema["properties"][name]) for name in param_names}
    fn.__annotations__ = annotations
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
