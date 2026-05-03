"""Contract-only type definitions for PersonaSpec.

This module is a **derived typing mirror** of the canonical PersonaSpec
authority owned by opifex. It exists to make larva's in-memory contract
reviewable, not to define an independent schema.

Admission notes:
- canonical required fields are ``id``, ``description``, ``prompt``,
  ``model``, ``capabilities``, and ``spec_version``
- ``tools`` and ``side_effect_policy`` are not canonical PersonaSpec fields at
  the larva admission boundary and must not be widened back into this type
- unknown top-level PersonaSpec fields are outside this contract and must be
  rejected by admission rather than normalized in typing space
- ``contracts/persona_spec.schema.json`` is reference-only while present; it is
  not an independent contract owner and must collapse to opifex authority on
  any drift

These types express the contract surface only — no validation, normalization,
assembly, registry, or I/O logic is implemented here.

Files that must not widen the canonical contract: ``spec.py``, ``validate.py``,
and ``facade.py``.

See:
- ARCHITECTURE.md :: Module: larva.core.spec
- INTERFACES.md :: E. PersonaSpec Output Format
"""

from typing import Literal, NotRequired, Required, TypeAlias, TypedDict

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

# -----------------------------------------------------------------------------
# Domain Types
# -----------------------------------------------------------------------------


class PersonaSpec(TypedDict):
    """Canonical PersonaSpec structure.

    This TypedDict defines the strict canonical admission shape consumed by
    larva production paths. It is intentionally narrower than historical larva
    transition-era shapes.

    Fields:
        id: Unique identifier for the persona.
        description: Human-readable description of the persona.
        prompt: The system prompt defining persona behavior.
        model: Model identifier to use for this persona.
        capabilities: Canonical mapping of capability names to posture
            classifications.
        model_params: Additional model parameters (temperature, top_p, etc.).
        can_spawn: Whether this persona can spawn sub-agents, or list of
            persona IDs it can spawn.
        compaction_prompt: Prompt used for state compaction/compaction.
        spec_version: Version identifier for the spec format (default: "0.1.0").
        spec_digest: SHA-256 digest of canonical spec representation.

    Acceptance notes:
        - Presence of ``tools`` or ``side_effect_policy`` is non-conforming at
          canonical larva admission.
        - Extra top-level fields are non-conforming at canonical larva
          admission.
        - Acceptance through larva production paths must imply conformance to
          the opifex canonical PersonaSpec contract.
    """

    id: Required[str]
    description: Required[str]
    prompt: Required[str]
    model: Required[str]
    capabilities: Required[dict[str, ToolPosture]]
    spec_version: Required[Literal["0.1.0"]]
    model_params: NotRequired[dict[str, object]]
    can_spawn: NotRequired[bool | list[str]]
    compaction_prompt: NotRequired[str]
    spec_digest: NotRequired[str]


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

__all__ = [
    "PersonaSpec",
    "ToolPosture",
]
