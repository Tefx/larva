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
_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE = (
    validate_contract.CANONICAL_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE
)

_PERSONA_SPEC_FIELD_TYPES: dict[str, dict[str, object]] = {
    "id": {"type": "string"},
    "description": {"type": "string"},
    "prompt": {"type": "string"},
    "model": {"type": "string"},
    "capabilities": {
        "type": "object",
        "additionalProperties": {
            "type": "string",
            "enum": ["none", "read_only", "read_write", "destructive"],
        },
        "description": (
            "Map of family -> posture. Each key is a stable, provider-agnostic "
            "capability family identifier. Each value is the maximum intended posture "
            "for that family. Empty map is valid but triggers a warning."
        ),
    },
    "spec_version": {
        "type": "string",
        "const": "0.1.0",
        "description": (
            "Schema version envelope (semver). All consumers must reject unknown versions."
        ),
    },
    "model_params": {"type": "object"},
    "can_spawn": {
        "oneOf": [
            {"type": "boolean"},
            {
                "type": "array",
                "items": {"type": "string", "minLength": 1},
                "maxItems": 100,
                "uniqueItems": True,
            },
        ],
        "default": False,
        "description": (
            "Spawn capability boundary. false/omitted = no spawn. true = spawn allowed, "
            "targets are a runtime concern. string[] = spawn restricted to listed canonical "
            "persona ids."
        ),
    },
    "compaction_prompt": {"type": "string"},
    "spec_digest": {
        "type": "string",
        "description": (
            "SHA-256 of canonical JSON (sorted keys, no whitespace, spec_digest excluded "
            "from input). Computed by larva; optional in raw input, always present in larva "
            "output."
        ),
    },
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
            "Canonical PersonaSpec object. Unknown top-level fields are rejected "
            "at the MCP admission boundary."
        ),
    },
)
_PERSONA_OVERRIDE_ALLOWED_FIELDS = (
    "prompt",
    "model",
    "model_params",
    "compaction_prompt",
)
_PERSONA_OVERRIDE_INPUT_SCHEMA = cast(
    "dict[str, Any]",
    {
        "type": "object",
        "properties": {
            field: _PERSONA_SPEC_FIELD_TYPES[field] for field in _PERSONA_OVERRIDE_ALLOWED_FIELDS
        },
        "additionalProperties": False,
        "description": (
            "Implementation-only PersonaSpec fields only. Contract-owned fields, stable "
            "identity, and generated metadata fields are not overrideable."
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
            f"Use the capabilities field; {_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "description": (
                        "PersonaSpec JSON to validate. "
                        f"Use capabilities field; {_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
                    ),
                    **_PERSONA_SPEC_INPUT_SCHEMA,
                }
            },
            "required": ["spec"],
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_resolve",
        "description": (
            "Resolve a pre-registered persona by id, optionally with runtime overrides. "
            f"{_CAPABILITIES_REQUIRED_CLAUSE}; {_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Persona id in registry"},
                "overrides": {
                    "description": (
                        "Implementation-only field overrides applied to the resolved spec: "
                        "prompt, model, model_params, and compaction_prompt. Contract, "
                        "derived, registry metadata, legacy, and unknown fields are rejected."
                    ),
                    **_PERSONA_OVERRIDE_INPUT_SCHEMA,
                },
                "variant": {
                    "type": "string",
                    "description": (
                        "Optional registry-local variant name; never a PersonaSpec field"
                    ),
                },
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_register",
        "description": (
            "Register a PersonaSpec in the local larva registry. "
            f"{_CAPABILITIES_REQUIRED_CLAUSE} and {_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "spec": {
                    "description": (
                        "PersonaSpec JSON (must pass validation). "
                        f"{_CAPABILITIES_REQUIRED_CLAUSE} and "
                        f"{_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
                    ),
                    **_PERSONA_SPEC_INPUT_SCHEMA,
                },
                "variant": {
                    "type": "string",
                    "description": (
                        "Optional registry-local variant name; never a PersonaSpec field"
                    ),
                },
            },
            "required": ["spec"],
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_list",
        "description": "List all registered personas.",
        "input_schema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_variant_list",
        "description": "List registry-local variants for a base persona id.",
        "input_schema": {
            "type": "object",
            "properties": {"id": {"type": "string", "description": "Base persona id"}},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_variant_activate",
        "description": (
            "Set the active registry-local variant without mutating PersonaSpec content."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Base persona id"},
                "variant": {"type": "string", "description": "Variant name to activate"},
            },
            "required": ["id", "variant"],
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_variant_delete",
        "description": "Delete an inactive, non-last registry-local variant.",
        "input_schema": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "Base persona id"},
                "variant": {"type": "string", "description": "Variant name to delete"},
            },
            "required": ["id", "variant"],
            "additionalProperties": False,
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
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_clear",
        "description": "Delete all registered personas. Requires confirm='CLEAR REGISTRY'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "confirm": {
                    "type": "string",
                    "description": "Must be exactly 'CLEAR REGISTRY' to proceed",
                },
            },
            "required": ["confirm"],
            "additionalProperties": False,
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
            "additionalProperties": False,
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
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_update",
        "description": (
            "Update a registered persona by applying JSON merge patches to selected fields. "
            f"Patches may update canonical capabilities field; {_CAPABILITIES_REQUIRED_CLAUSE}; "
            f"{_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
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
                        f"{_CAPABILITIES_REQUIRED_CLAUSE} and "
                        f"{_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
                    ),
                },
                "variant": {
                    "type": "string",
                    "description": (
                        "Optional registry-local variant name; never a PersonaSpec field"
                    ),
                },
            },
            "required": ["id", "patches"],
            "additionalProperties": False,
        },
    },
    {
        "name": "larva_update_batch",
        "description": (
            "Batch-update all personas matching 'where' clauses by applying JSON merge patches. "
            f"Patches may update canonical capabilities field; {_CAPABILITIES_REQUIRED_CLAUSE}; "
            f"{_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "where": {
                    "type": "object",
                    "description": (
                        "WHERE clauses on canonical PersonaSpec fields only; all personas "
                        "matching all key=value pairs are updated. Legacy roots like tools.* "
                        "or side_effect_policy are rejected."
                    ),
                },
                "patches": {
                    "type": "object",
                    "description": (
                        "JSON merge patches to apply to each matched persona. Canonical admission "
                        f"requires capabilities and {_FORBIDDEN_LEGACY_VOCABULARY_CLAUSE}."
                    ),
                },
                "dry_run": {
                    "type": "boolean",
                    "description": "If true, return matched ids without applying updates",
                },
            },
            "required": ["where", "patches"],
            "additionalProperties": False,
        },
    },
]
