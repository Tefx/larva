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
        "name": "larva_validate",
        "description": (
            "Validate a PersonaSpec JSON object against the canonical schema and semantic rules. "
            "Use the capabilities field; tools is rejected at canonical admission."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": (
                        "PersonaSpec JSON to validate. Use capabilities field; "
                        "tools is rejected at canonical admission."
                    ),
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva_assemble",
        "description": (
            "Assemble a PersonaSpec from named components (prompts, toolsets, constraints, model). "
            "Toolsets define capabilities for canonical PersonaSpec assembly."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id"},
                "description": {
                    "type": "string",
                    "description": "Persona description for canonical required field",
                },
                "prompts": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Prompt component names (concatenated in order)",
                },
                "toolsets": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Toolset component names. Toolsets provide capability posture data "
                        "for canonical capabilities output."
                    ),
                },
                "constraints": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Constraint component names",
                },
                "model": {"type": "string", "description": "Model component name"},
                "overrides": {
                    "type": "object",
                    "description": (
                        "Field overrides (wins over components). Canonical admission requires "
                        "capabilities and rejects tools."
                    ),
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
        "name": "larva_resolve",
        "description": (
            "Resolve a pre-registered persona by id, optionally with runtime overrides. "
            "The resolved PersonaSpec uses canonical capabilities field."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id in registry"},
                "overrides": {
                    "type": "object",
                    "description": (
                        "Field overrides applied to the resolved spec. Canonical admission "
                        "requires capabilities and rejects tools."
                    ),
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva_register",
        "description": (
            "Register a PersonaSpec in the global registry. The spec should use capabilities field "
            "and must not include tools at canonical admission."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "type": "object",
                    "description": (
                        "PersonaSpec JSON (must pass validation). Canonical admission requires "
                        "capabilities and rejects tools."
                    ),
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva_list",
        "description": "List all registered personas.",
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "larva_component_list",
        "description": (
            "List all available components by type (prompts, toolsets, constraints, models). "
            "Toolsets define capability posture data for canonical assembly."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
        },
    },
    {
        "name": "larva_component_show",
        "description": (
            "Show content for a specific component by type and name. Toolsets define capability "
            "posture data for canonical assembly."
        ),
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
        "name": "larva_delete",
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
        "name": "larva_clear",
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
    {
        "name": "larva_clone",
        "description": (
            "Clone a registered persona to a new id. The cloned PersonaSpec uses canonical "
            "capabilities field."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "source_id": {
                    "type": "string",
                    "description": "Persona id to clone from",
                },
                "new_id": {
                    "type": "string",
                    "description": "New persona id for the clone",
                },
            },
            "required": ["source_id", "new_id"],
        },
    },
    {
        "name": "larva_export",
        "description": (
            "Export persona specs from the registry. Either 'all' or 'ids' must be provided, "
            "but not both. Exported specs use canonical capabilities field."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "all": {
                    "type": "boolean",
                    "description": "Export all persona specs from the registry",
                },
                "ids": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Export specific persona specs by id",
                },
            },
        },
    },
    {
        "name": "larva_update",
        "description": (
            "Update a registered persona by applying JSON merge patches to selected fields. "
            "Patches may update canonical capabilities field; tools is rejected at admission."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "Persona id to update",
                },
                "patches": {
                    "type": "object",
                    "description": (
                        "JSON merge patches to apply to the persona. Canonical admission requires "
                        "capabilities and rejects tools."
                    ),
                },
            },
            "required": ["id", "patches"],
        },
    },
    {
        "name": "larva_update_batch",
        "description": (
            "Batch-update all personas matching 'where' clauses by applying JSON merge patches. "
            "Patches may update canonical capabilities field; tools is rejected at admission."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "where": {
                    "type": "object",
                    "description": (
                        "WHERE clauses: all personas matching all key=value pairs are updated"
                    ),
                },
                "patches": {
                    "type": "object",
                    "description": (
                        "JSON merge patches to apply to each matched persona. Canonical admission "
                        "requires capabilities and rejects tools."
                    ),
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "If true, return matched ids without applying updates",
                },
            },
            "required": ["where", "patches"],
        },
    },
]


MCPTransportMode = Literal["stdio", "http", "sse"]
"""MCP transport mode.

- ``"stdio"``: Standard I/O transport (default for CLI usage).
- ``"http"``: MCP Streamable HTTP transport (spec 2025-03-26+, recommended for remote).
- ``"sse"``: Legacy Server-Sent Events transport (deprecated, retained for compatibility).
"""


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
