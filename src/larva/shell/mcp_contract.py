"""Shared MCP shell contract definitions.

This module holds schema/type constants used by ``larva.shell.mcp`` so the
runtime-facing handler module can stay focused on boundary logic.

Ownership rule:
- this module is a transport projection, not a contract owner
- ``ValidationIssue`` / ``ValidationReport`` shapes and canonical admission
  wording derive from ``larva.core.validate``
- MCP tool descriptions may adapt those semantics for operator clarity, but
  must not widen or redefine required / optional / forbidden PersonaSpec fields
  or invent alternate canonical rejection reasons
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, TypedDict, cast

from larva.app import facade as facade_module
from larva.core import validate as validate_contract

LARVA_ERROR_CODES = MappingProxyType(facade_module.ERROR_NUMERIC_CODES)


ValidationIssue = validate_contract.ValidationIssue
ValidationReport = validate_contract.ValidationReport

_CAPABILITIES_REQUIRED_CLAUSE = validate_contract.CANONICAL_CAPABILITIES_REQUIRED_CLAUSE
_TOOLS_REJECTED_CLAUSE = validate_contract.CANONICAL_TOOLS_REJECTED_CLAUSE

_PERSONA_SPEC_FIELD_TYPES: dict[str, dict[str, object]] = {
    "id": {"type": "string"},
    "description": {"type": "string"},
    "prompt": {"type": "string"},
    "model": {"type": "string"},
    "capabilities": {"type": "object"},
    "spec_version": {"type": "string"},
    "model_params": {"type": "object"},
    "can_spawn": {},
    "compaction_prompt": {"type": "string"},
    "spec_digest": {"type": "string"},
    "variables": {"type": "object"},
}
_PERSONA_SPEC_ALLOWED_FIELDS = (
    validate_contract.CANONICAL_REQUIRED_FIELDS + validate_contract.CANONICAL_OPTIONAL_FIELDS
)
_PERSONA_SPEC_INPUT_SCHEMA = cast(
    "dict[str, Any]",
    {
        "type": "object",
        "properties": {
            field: _PERSONA_SPEC_FIELD_TYPES[field] for field in _PERSONA_SPEC_ALLOWED_FIELDS
        },
        "required": list(validate_contract.CANONICAL_REQUIRED_FIELDS),
        "additionalProperties": False,
        "description": (
            "Canonical PersonaSpec object. Unknown top-level fields and forbidden legacy "
            "fields are rejected at the MCP admission boundary."
        ),
    },
)


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
            f"Use the capabilities field; {_TOOLS_REJECTED_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "description": (
                        "PersonaSpec JSON to validate. "
                        f"Use capabilities field; {_TOOLS_REJECTED_CLAUSE}."
                    ),
                    **_PERSONA_SPEC_INPUT_SCHEMA,
                }
            },
            "required": ["spec"],
        },
    },
    {
        "name": "larva_assemble",
        "description": (
            "Assemble a PersonaSpec from named components (prompts, toolsets, constraints, model). "
            f"{_CAPABILITIES_REQUIRED_CLAUSE}; {_TOOLS_REJECTED_CLAUSE}."
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
                        "Field overrides (wins over components). "
                        f"{_CAPABILITIES_REQUIRED_CLAUSE} and {_TOOLS_REJECTED_CLAUSE}."
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
            f"{_CAPABILITIES_REQUIRED_CLAUSE}; {_TOOLS_REJECTED_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id in registry"},
                "overrides": {
                    "type": "object",
                    "description": (
                        "Field overrides applied to the resolved spec. Canonical admission "
                        f"requires capabilities and {_TOOLS_REJECTED_CLAUSE}."
                    ),
                },
            },
            "required": ["id"],
        },
    },
    {
        "name": "larva_register",
        "description": (
            "Register a PersonaSpec in the global registry. "
            f"{_CAPABILITIES_REQUIRED_CLAUSE} and {_TOOLS_REJECTED_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "description": (
                        "PersonaSpec JSON (must pass validation). "
                        f"{_CAPABILITIES_REQUIRED_CLAUSE} and {_TOOLS_REJECTED_CLAUSE}."
                    ),
                    **_PERSONA_SPEC_INPUT_SCHEMA,
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
            f"Patches may update canonical capabilities field; {_CAPABILITIES_REQUIRED_CLAUSE}; "
            f"{_TOOLS_REJECTED_CLAUSE}."
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
                        "JSON merge patches to apply to the persona. "
                        f"{_CAPABILITIES_REQUIRED_CLAUSE} and {_TOOLS_REJECTED_CLAUSE}."
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
            f"Patches may update canonical capabilities field; {_CAPABILITIES_REQUIRED_CLAUSE}; "
            f"{_TOOLS_REJECTED_CLAUSE}."
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
                        f"requires capabilities and {_TOOLS_REJECTED_CLAUSE}."
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
