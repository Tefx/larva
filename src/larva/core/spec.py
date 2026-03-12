"""Contract-only type definitions for PersonaSpec.

This module defines the canonical in-memory domain types used by validation,
assembly, normalization, registry, and public APIs.

These types express the contract surface only — no validation, normalization,
assembly, registry, or I/O logic is implemented here.

See:
- ARCHITECTURE.md :: Module: larva.core.spec
- INTERFACES.md :: E. PersonaSpec Output Format
"""

from typing import Literal, TypeAlias, TypedDict


# -----------------------------------------------------------------------------
# Canonical Type Aliases
# -----------------------------------------------------------------------------

ToolPosture: TypeAlias = Literal["none", "read_only", "read_write", "destructive"]
"""Posture classification for tool capabilities.

- "none": No tool access
- "read_only": Read-only tool operations
- "read_write": Read and write tool operations
- "destructive": Tools that may cause irreversible side effects
"""

SideEffectPolicy: TypeAlias = Literal["allow", "approval_required", "read_only"]
"""Policy governing side-effectful operations.

- "allow": Side effects permitted without restriction
- "approval_required": Side effects require explicit approval
- "read_only": Only read operations permitted (no side effects)
"""


# -----------------------------------------------------------------------------
# Domain Types
# -----------------------------------------------------------------------------


class PersonaSpec(TypedDict, total=False):
    """Canonical PersonaSpec structure.

    This TypedDict defines the complete shape of a persona specification.
    All fields are optional (total=False) to support partial specifications
    during assembly and validation stages.

    Fields:
        id: Unique identifier for the persona.
        description: Human-readable description of the persona.
        prompt: The system prompt defining persona behavior.
        model: Model identifier to use for this persona.
        tools: Mapping of tool names to their posture classifications.
        model_params: Additional model parameters (temperature, top_p, etc.).
        side_effect_policy: Policy governing side-effectful operations.
        can_spawn: Whether this persona can spawn sub-agents, or list of
            persona IDs it can spawn.
        compaction_prompt: Prompt used for state compaction/compaction.
        spec_version: Version identifier for the spec format (default: "0.1.0").
        spec_digest: SHA-256 digest of canonical spec representation.
    """

    id: str
    description: str
    prompt: str
    model: str
    tools: dict[str, ToolPosture]
    model_params: dict[str, object]
    side_effect_policy: SideEffectPolicy
    can_spawn: bool | list[str]
    compaction_prompt: str
    spec_version: Literal["0.1.0"]
    spec_digest: str


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

__all__ = [
    "PersonaSpec",
    "SideEffectPolicy",
    "ToolPosture",
]
