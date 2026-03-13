"""Contract-only Python API module for larva.

This module defines the public Python interface for larva use-cases:
- validate(spec)
- assemble(...)
- register(spec)
- resolve(id, overrides=None)
- list()

Responsibility (from ARCHITECTURE.md):
- Expose a small in-process Python API aligned with public larva use-cases
- Thin delegation to `larva.app.facade`

Non-Responsibility (from ARCHITECTURE.md):
- No separate flow logic from facade
- No transport-specific behavior

Contract (from ARCHITECTURE.md, Decision 3):
- This module begins as a thin export over `app.facade`
- A thicker implementation is only justified if Python surface later needs
  behavior not shared with CLI and MCP

See:
- ARCHITECTURE.md :: Module: larva.shell.python_api
- ARCHITECTURE.md :: Decision 3: Python API is a thin facade export
- README.md :: Python Library interface
"""

from __future__ import annotations

from typing import Any, TypedDict, cast

# Note: Actual Result type from returns library - imported here to make contract explicit
# from returns.result import Result  # Deferred: no I/O in contract-only module

# Import contract types from core modules
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport

# Import app-layer types (these are contract-only TypedDicts)
from larva.app.facade import AssembleRequest, LarvaError, PersonaSummary, RegisteredPersona


# -----------------------------------------------------------------------------
# Public API Contracts
# -----------------------------------------------------------------------------
# These are thin signatures that delegate to app.facade.LarvaFacade.
# Actual implementation is deferred until needed.


# @invar:allow shell_result: contract-only stub; delegation deferred to implementation
# @invar:allow dead_param: contract-only stub; parameters documented for API contract
# @shell_orchestration: contract-only stub; I/O via facade delegation at runtime
def validate(spec: PersonaSpec) -> ValidationReport:
    """Validate a PersonaSpec candidate.

    This is a thin delegation to `larva.app.facade.LarvaFacade.validate`.
    The facade orchestrates: validation via `core.validate`.

    Args:
        spec: A PersonaSpec candidate to validate.

    Returns:
        ValidationReport with valid=True/False, errors, and warnings.

    Contract:
        - Delegates to app.facade for orchestration
        - core.validate applies deterministic validation rules

    Example:
        result = validate({"id": "test", "spec_version": "0.1.0"})
        assert result["valid"] is True
    """
    # Contract-only stub: actual delegation deferred to implementation
    # Implementation pattern: facade.validate(spec)
    raise NotImplementedError("python_api contract-only: delegation deferred to implementation")


# @invar:allow shell_result: contract-only stub; delegation deferred to implementation
# @invar:allow dead_param: contract-only stub; parameters documented for API contract
# @shell_orchestration: contract-only stub; I/O via facade delegation at runtime
def assemble(
    id: str,
    prompts: list[str] | None = None,
    toolsets: list[str] | None = None,
    constraints: list[str] | None = None,
    model: str | None = None,
    overrides: dict[str, Any] | None = None,
    variables: dict[str, str] | None = None,
) -> PersonaSpec:
    """Assemble a PersonaSpec from component references.

    This is a thin delegation to `larva.app.facade.LarvaFacade.assemble`.
    The facade orchestrates: component loading → assembly → validation → normalization.

    Args:
        id: Unique identifier for the assembled persona.
        prompts: List of prompt component names to combine.
        toolsets: List of toolset component names to combine.
        constraints: List of constraint component names to combine.
        model: Model component name or model identifier.
        overrides: Runtime overrides for persona fields.
        variables: Variable values for prompt template substitution.

    Returns:
        Normalized PersonaSpec from assembly pipeline.

    Contract:
        - Delegates to app.facade for orchestration
        - Loads components via shell.components
        - Assembles via core.assemble
        - Validates via core.validate
        - Normalizes via core.normalize

    Example:
        spec = assemble("code-reviewer", prompts=["code-reviewer"])
        assert spec["spec_version"] == "0.1.0"
    """
    # Contract-only stub: actual delegation deferred to implementation
    # Implementation pattern:
    #   request: AssembleRequest = {...}
    #   return facade.assemble(request).unwrap()
    raise NotImplementedError("python_api contract-only: delegation deferred to implementation")


# @invar:allow shell_result: contract-only stub; delegation deferred to implementation
# @invar:allow dead_param: contract-only stub; parameters documented for API contract
# @shell_orchestration: contract-only stub; I/O via facade delegation at runtime
def register(spec: PersonaSpec) -> RegisteredPersona:
    """Register a canonical PersonaSpec in the global registry.

    This is a thin delegation to `larva.app.facade.LarvaFacade.register`.
    The facade orchestrates: validation → normalization → registry save.

    Args:
        spec: A validated, normalized PersonaSpec to register.

    Returns:
        RegisteredPersona with id and registered status.

    Contract:
        - Delegates to app.facade for orchestration
        - Validates spec via core.validate
        - Normalizes via core.normalize
        - Saves via shell.registry

    Example:
        result = register({"id": "code-reviewer", "spec_version": "0.1.0"})
        assert result["registered"] is True
    """
    # Contract-only stub: actual delegation deferred to implementation
    # Implementation pattern: facade.register(spec).unwrap()
    raise NotImplementedError("python_api contract-only: delegation deferred to implementation")


# @invar:allow shell_result: contract-only stub; delegation deferred to implementation
# @invar:allow dead_param: contract-only stub; parameters documented for API contract
# @shell_orchestration: contract-only stub; I/O via facade delegation at runtime
def resolve(id: str, overrides: dict[str, Any] | None = None) -> PersonaSpec:
    """Resolve a registered persona by id, with optional runtime overrides.

    This is a thin delegation to `larva.app.facade.LarvaFacade.resolve`.
    The facade orchestrates: registry lookup → apply overrides → revalidate → renormalize.

    Args:
        id: Unique identifier of the registered persona.
        overrides: Optional runtime overrides to apply before returning.

    Returns:
        Resolved, validated, and normalized PersonaSpec.

    Contract:
        - Delegates to app.facade for orchestration
        - Looks up via shell.registry
        - Applies overrides if provided
        - Revalidates via core.validate (after override)
        - Renormalizes via core.normalize (after override)
        - ARCHITECTURE.md: override revalidation is mandatory

    Example:
        spec = resolve("code-reviewer")
        assert spec["id"] == "code-reviewer"
        spec = resolve("code-reviewer", {"model": "claude-opus-4-20250514"})
    """
    # Contract-only stub: actual delegation deferred to implementation
    # Implementation pattern: facade.resolve(id, overrides).unwrap()
    raise NotImplementedError("python_api contract-only: delegation deferred to implementation")


# @invar:allow shell_result: contract-only stub; delegation deferred to implementation
# @invar:allow dead_param: contract-only stub; parameters documented for API contract
# @shell_orchestration: contract-only stub; I/O via facade delegation at runtime
def list() -> list[PersonaSummary]:
    """List all registered personas.

    This is a thin delegation to `larva.app.facade.LarvaFacade.list`.
    The facade orchestrates: registry list → extract summaries.

    Returns:
        List of PersonaSummary with id, spec_digest, and model.

    Contract:
        - Delegates to app.facade for orchestration
        - Lists via shell.registry
        - Extracts summary fields (id, spec_digest, model)

    Example:
        personas = list()
        assert len(personas) >= 0
    """
    # Contract-only stub: actual delegation deferred to implementation
    # Implementation pattern: facade.list().unwrap()
    raise NotImplementedError("python_api contract-only: delegation deferred to implementation")


# -----------------------------------------------------------------------------
# Public API Exports
# -----------------------------------------------------------------------------

__all__ = [
    "validate",
    "assemble",
    "register",
    "resolve",
    "list",
    # Re-export types for type checking
    "PersonaSpec",
    "ValidationReport",
    "AssembleRequest",
    "RegisteredPersona",
    "PersonaSummary",
    "LarvaError",
]
