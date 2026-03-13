"""Thin delegation Python API module for larva.

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

from returns.result import Failure, Result, Success

# Import contract types from core modules
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport

# Import app-layer types and facade
from larva.app.facade import (
    AssembleRequest,
    DefaultLarvaFacade,
    LarvaError,
    PersonaSummary,
    RegisteredPersona,
)

# Import shell modules for facade construction
from larva.shell.components import FilesystemComponentStore
from larva.shell.registry import FileSystemRegistryStore


# -----------------------------------------------------------------------------
# Lazy Facade Initialization
# -----------------------------------------------------------------------------
# The facade is lazily initialized on first use to avoid circular imports
# and to defer I/O until the Python API is actually called.


_facade: DefaultLarvaFacade | None = None


# @invar:allow shell_result: lazy initialization is internal helper returning facade instance
# @shell_orchestration: facade construction is app-level orchestration, not core logic
def _get_facade() -> DefaultLarvaFacade:
    """Lazily initialize and return the default facade instance."""
    global _facade
    if _facade is None:
        _facade = DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=FilesystemComponentStore(),
            registry=FileSystemRegistryStore(),
        )
    return _facade


def _unwrap_result(result: Result[object, LarvaError]) -> object:
    """Unwrap a Result, raising on failure without Python-API-specific mutation."""
    if isinstance(result, Failure):
        error = result.failure()
        # Re-raise as a generic exception for failure passthrough
        # The facade already provides all error details in the LarvaError
        raise LarvaApiError(error)
    return result.unwrap()


# @invar:allow shell_result: internal request builder for thin facade delegation
# @shell_orchestration: preserves python_api thin-adapter request shaping only
def _build_assemble_request(
    id: str,
    prompts: list[str] | None,
    toolsets: list[str] | None,
    constraints: list[str] | None,
    model: str | None,
    overrides: dict[str, Any] | None,
    variables: dict[str, str] | None,
) -> AssembleRequest:
    """Construct AssembleRequest while preserving explicit falsey values."""
    request: dict[str, object] = {"id": id}
    optional_fields: tuple[tuple[str, object | None], ...] = (
        ("prompts", prompts),
        ("toolsets", toolsets),
        ("constraints", constraints),
        ("model", model),
        ("overrides", overrides),
        ("variables", variables),
    )
    for key, value in optional_fields:
        if value is not None:
            request[key] = value
    return cast("AssembleRequest", request)


class LarvaApiError(Exception):
    """Exception raised when facade operations fail.

    This provides failure passthrough from facade to python_api caller
    without Python-API-specific mutation.
    """

    def __init__(self, error: LarvaError) -> None:
        self.error = error
        super().__init__(error["message"])


# -----------------------------------------------------------------------------
# Thin Delegation Implementation
# -----------------------------------------------------------------------------


# @invar:allow shell_result: facade.validate returns ValidationReport directly (not Result)
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
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
    return _get_facade().validate(spec)


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
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
    request = _build_assemble_request(
        id=id,
        prompts=prompts,
        toolsets=toolsets,
        constraints=constraints,
        model=model,
        overrides=overrides,
        variables=variables,
    )
    return cast("PersonaSpec", _unwrap_result(_get_facade().assemble(request)))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
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
    return cast("RegisteredPersona", _unwrap_result(_get_facade().register(spec)))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def resolve(id: str, overrides: dict[str, Any] | None = None) -> PersonaSpec:
    """Resolve a registered persona by id, with optional runtime overrides.

    This is a thin delegation to `larva.app.facade.LarvaFacade.resolve`.
    The facade orchestrates: registry lookup → apply overrides → revalidate → renormalize.

    Args:
        id: Unique identifier of the registered persona.
        overrides: Optional runtime overrides to apply before returning.
            Explicit overrides (including null/falsey values) are forwarded intact.

    Returns:
        Resolved, validated, and normalized PersonaSpec.

    Contract:
        - Delegates to app.facade for orchestration
        - Looks up via shell.registry
        - Applies overrides if provided (preserves null/falsey values)
        - Revalidates via core.validate (after override)
        - Renormalizes via core.normalize (after override)
        - ARCHITECTURE.md: override revalidation is mandatory

    Example:
        spec = resolve("code-reviewer")
        assert spec["id"] == "code-reviewer"
        spec = resolve("code-reviewer", {"model": "claude-opus-4-20250514"})
    """
    return cast("PersonaSpec", _unwrap_result(_get_facade().resolve(id, overrides)))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
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
    return cast("list[PersonaSummary]", _unwrap_result(_get_facade().list()))


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
    # Exception for failure passthrough
    "LarvaApiError",
]
