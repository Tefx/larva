"""Thin delegation Python API module for larva.

This module defines the public Python interface for larva use-cases:
- validate(spec)
- assemble(...)
- register(spec)
- resolve(id, overrides=None)
- update(persona_id, patches)
- clone(source_id, new_id)
- export_all()
- export_ids(ids)
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

from typing import Any, cast

from returns.result import Failure, Result

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
    BatchUpdateResult,
    ClearedRegistry,
    DefaultLarvaFacade,
    DeletedPersona,
    LarvaError,
    PersonaSummary,
    RegisteredPersona,
)
from larva.shell.python_api_components import (
    LarvaApiError,
    component_list,
    component_show,
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
def update(persona_id: str, patches: dict[str, Any]) -> PersonaSpec:
    """Update a registered persona by id with patches.

    This is a thin delegation to `larva.app.facade.LarvaFacade.update`.
    The facade orchestrates: registry lookup → apply patches → revalidate → renormalize → save.

    Args:
        persona_id: Unique identifier of the persona to update.
        patches: Dictionary of patches to apply to the persona spec.
            Supports RFC 6902 JSON Patch operations via core.patch.apply_patches.

    Returns:
        Updated, validated, and normalized PersonaSpec.

    Contract:
        - Delegates to app.facade for orchestration
        - Looks up via shell.registry
        - Applies patches via core.patch.apply_patches
        - Revalidates via core.validate (after patch)
        - Renormalizes via core.normalize (after patch)
        - Saves via shell.registry

    Example:
        spec = update("my-persona", {"model": "claude-opus-4-20250514"})
        assert spec["model"] == "claude-opus-4-20250514"
    """
    return cast("PersonaSpec", _unwrap_result(_get_facade().update(persona_id, patches)))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def update_batch(
    where: dict[str, Any],
    patches: dict[str, Any],
    dry_run: bool = False,
) -> BatchUpdateResult:
    """Update multiple personas matching where clauses.

    This is a thin delegation to `larva.app.facade.LarvaFacade.update_batch`.
    The facade orchestrates: registry list → filter by where → apply patches → revalidate → save.

    Args:
        where: Dictionary of dotted-key filter clauses. All clauses must match (AND).
            Keys like "model" match top-level fields; "prompts.0" matches nested paths.
        patches: Dictionary of patches to apply to matched personas.
            Supports RFC 6902 JSON Patch operations via core.patch.apply_patches.
        dry_run: If True, return matched personas without applying updates.

    Returns:
        BatchUpdateResult with:
            - items: list of {id, updated} per matched persona
            - matched: count of personas matching where clauses
            - updated: count of successfully updated personas (0 if dry_run)

    Contract:
        - Delegates to app.facade for orchestration
        - Lists via shell.registry
        - Filters by where clauses (AND semantics)
        - For each match: applies patches → validates → normalizes → saves (unless dry_run)
        - Stops on first validation/save error

    Example:
        result = update_batch(
            where={"model": "claude-3"},
            patches={"model": "claude-opus-4-20250514"}
        )
        assert result["matched"] > 0

        # Dry-run to preview without applying
        preview = update_batch(
            where={"model": "claude-3"},
            patches={"model": "claude-opus-4-20250514"},
            dry_run=True
        )
        assert preview["updated"] == 0
    """
    return cast(
        "BatchUpdateResult", _unwrap_result(_get_facade().update_batch(where, patches, dry_run))
    )


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


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def delete(persona_id: str) -> DeletedPersona:
    """Delete a registered persona by id.

    This is a thin delegation to `larva.app.facade.LarvaFacade.delete`.
    The facade orchestrates: registry delete.

    Args:
        persona_id: Unique identifier of the persona to delete.

    Returns:
        DeletedPersona with id and deleted status.

    Contract:
        - Delegates to app.facade for orchestration
        - Deletes via shell.registry

    Example:
        result = delete("old-persona")
        assert result["deleted"] is True
    """
    return cast("DeletedPersona", _unwrap_result(_get_facade().delete(persona_id)))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def clear(*, confirm: str) -> int:
    """Clear all registered personas from the registry.

    This is a thin delegation to `larva.app.facade.LarvaFacade.clear`.
    The facade orchestrates: registry clear with confirmation.

    Args:
        confirm: Confirmation token required for safety (must be "CLEAR REGISTRY").

    Returns:
        Number of personas that were removed.

    Contract:
        - Delegates to app.facade for orchestration
        - Clears via shell.registry
        - Wrong confirm token raises LarvaApiError

    Example:
        count = clear(confirm="CLEAR REGISTRY")
        assert count >= 0
    """
    result = _get_facade().clear(confirm=confirm)
    unwrapped = _unwrap_result(result)
    return cast("ClearedRegistry", unwrapped)["count"]


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def clone(source_id: str, new_id: str) -> PersonaSpec:
    """Clone a registered persona to a new id.

    This is a thin delegation to `larva.app.facade.LarvaFacade.clone`.
    The facade orchestrates: registry lookup → copy with new id → revalidate → save.

    Args:
        source_id: Unique identifier of the source persona to clone.
        new_id: Unique identifier for the new cloned persona.

    Returns:
        Cloned PersonaSpec with id set to new_id and spec_digest recalculated.

    Contract:
        - Delegates to app.facade for orchestration
        - Looks up source via shell.registry
        - Copies all fields except id
        - Validates via core.validate
        - Saves to registry via shell.registry
        - If new_id already exists, overwrites (consistent with register)

    Example:
        new_spec = clone("code-reviewer", "code-reviewer-v2")
        assert new_spec["id"] == "code-reviewer-v2"
    """
    return cast("PersonaSpec", _unwrap_result(_get_facade().clone(source_id, new_id)))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def export_all() -> list[PersonaSpec]:
    """Export all persona specs from the registry.

    This is a thin delegation to `larva.app.facade.LarvaFacade.export_all`.
    The facade orchestrates: registry list → iterate → collect specs.

    Returns:
        List of all PersonaSpec objects stored in the registry.

    Contract:
        - Delegates to app.facade for orchestration
        - Lists via shell.registry
        - Each spec is canonical registry data (already normalized/validated)

    Example:
        specs = export_all()
        assert len(specs) >= 0
    """
    return cast("list[PersonaSpec]", _unwrap_result(_get_facade().export_all()))


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to facade which performs I/O via core/registry
def export_ids(ids: list[str]) -> list[PersonaSpec]:
    """Export specific persona specs by id from the registry.

    This is a thin delegation to `larva.app.facade.LarvaFacade.export_ids`.
    The facade orchestrates: iterate ids → registry get → collect specs.

    Args:
        ids: List of persona ids to export.

    Returns:
        List of PersonaSpec objects in the same order as input ids.

    Raises:
        LarvaApiError: If any persona id is not found, with code PERSONA_NOT_FOUND (100).

    Contract:
        - Delegates to app.facade for orchestration
        - Gets via shell.registry for each id
        - Each spec is canonical registry data (already normalized/validated)
        - Empty ids returns empty list immediately

    Example:
        specs = export_ids(["persona-1", "persona-2"])
        assert len(specs) == 2
    """
    return cast("list[PersonaSpec]", _unwrap_result(_get_facade().export_ids(ids)))


# -----------------------------------------------------------------------------
# Public API Exports
# -----------------------------------------------------------------------------

__all__ = [
    "validate",
    "assemble",
    "register",
    "resolve",
    "update",
    "update_batch",
    "list",
    # Component operations
    "component_list",
    "component_show",
    # Registry operations
    "delete",
    "clear",
    "clone",
    "export_all",
    "export_ids",
    # Re-export types for type checking
    "PersonaSpec",
    "ValidationReport",
    "AssembleRequest",
    "RegisteredPersona",
    "PersonaSummary",
    "LarvaError",
    "DeletedPersona",
    "ClearedRegistry",
    "BatchUpdateResult",
    # Exception for failure passthrough
    "LarvaApiError",
]
