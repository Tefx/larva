"""Shared MCP shell contract definitions.

This module holds schema/type constants used by ``larva.shell.mcp`` so the
runtime-facing handler module can stay focused on boundary logic.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Literal, Protocol, TypedDict

from larva.app import facade as facade_module


LARVA_ERROR_CODES = MappingProxyType(facade_module.ERROR_NUMERIC_CODES)


class ValidationIssue(TypedDict):
    """Error detail structure for validation failures."""

    code: str
    message: str
    details: dict[str, Any]


class ValidationReport(TypedDict):
    """Response from larva.validate()."""

    valid: bool
    errors: list[ValidationIssue]
    warnings: list[str]


class MCPToolDefinition(TypedDict):
    """MCP tool metadata for registration."""

    name: str
    description: str
    input_schema: dict[str, Any]


LARVA_MCP_TOOLS: list[MCPToolDefinition] = [
    {
        "name": "larva.validate",
        "description": "Validate a PersonaSpec JSON object against the canonical schema and semantic rules.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": "PersonaSpec JSON to validate",
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva.assemble",
        "description": "Assemble a PersonaSpec from named components (prompts, toolsets, constraints, model).",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id"},
                "prompts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Prompt component names (concatenated in order)",
                },
                "toolsets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Toolset component names",
                },
                "constraints": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Constraint component names",
                },
                "model": {"type": "string", "description": "Model component name"},
                "overrides": {
                    "type": "object",
                    "description": "Field overrides (wins over components)",
                },
                "variables": {
                    "type": "object",
                    "description": "Variable substitution in prompt text",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva.resolve",
        "description": "Resolve a pre-registered persona by id, optionally with runtime overrides.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id in registry"},
                "overrides": {
                    "type": "object",
                    "description": "Field overrides applied to the resolved spec",
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva.register",
        "description": "Register a PersonaSpec in the global registry.",
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": "PersonaSpec JSON (must pass validation)",
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva.list",
        "description": "List all registered personas.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "larva.component_list",
        "description": "List all available components by type (prompts, toolsets, constraints, models).",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "larva.component_show",
        "description": "Show content for a specific component by type and name.",
        "input_schema": {
            "type": "object",
            "properties": {
                "component_type": {
                    "type": "string",
                    "description": "Component type (prompts, toolsets, constraints, or models)",
                },
                "name": {
                    "type": "string",
                    "description": "Component name (without file extension)",
                },
            },
            "required": ["component_type", "name"],
        },
    },
    {
        "name": "larva.delete",
        "description": "Delete a registered persona by id.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id to delete"},
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva.clear",
        "description": "Delete all registered personas. Requires confirm='DELETE ALL PERSONAS'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "confirm": {
                    "type": "string",
                    "description": "Must be exactly 'DELETE ALL PERSONAS' to proceed",
                },
            },
            "required": ["confirm"],
        },
    },
]


MCPTransportMode = Literal["stdio", "sse"]


class MCPServerConfig(TypedDict, total=False):
    """Configuration for MCP server startup."""

    transport: MCPTransportMode
    host: str | None
    port: int | None


class MCPServer(Protocol):
    """Contract for MCP server runtime."""

    def __init__(self, handlers: object, config: MCPServerConfig) -> None: ...

    def run(self) -> None:
        raise NotImplementedError(
            "MCP server runtime startup is not implemented in this contract step"
        )

    def shutdown(self) -> None: ...
