"""Contract-only patch application surface for PersonaSpec overrides.

This module defines the core patch-application contract used by resolve-time
overrides.

Acceptance notes (contract only, no business logic shipped in this step):
- Protected keys are stripped from incoming patches.
- Dot-notation keys are expanded into nested dictionaries.
- `model_params` and `tools` use deep-merge semantics.
- Other keys overwrite shallowly at the top level.

See:
- INTERFACES.md :: D. Global Registry :: Resolution
- INTERFACES.md :: C. Assembly Rules (`tools`, `model_params` merge semantics)
"""

from typing import Mapping

from deal import post, pre

from larva.core.spec import PersonaSpec

PROTECTED_KEYS: frozenset[str] = frozenset({"id", "spec_digest", "spec_version"})
"""Keys that runtime patches must not override."""

DEEP_MERGE_KEYS: frozenset[str] = frozenset({"model_params", "tools"})
"""Top-level fields that use recursive merge semantics."""

DOT_KEY_SEPARATOR = "."
"""Separator used for dot-notation patch paths."""

_PATCH_CONTRACT_READY = False
"""Contract gate: patch behavior is intentionally not implemented in this step."""


@pre(lambda patches: isinstance(patches, Mapping) and _PATCH_CONTRACT_READY)
@post(lambda result: isinstance(result, dict))
def _strip_protected_keys(patches: Mapping[str, object]) -> dict[str, object]:
    """Return patch mapping with protected keys removed.

    Args:
        patches: Runtime override mapping.

    Returns:
        Patch mapping without protected keys.

    Raises:
        NotImplementedError: Always, until behavior implementation step.
    """
    _ = patches
    raise NotImplementedError("Contract only: _strip_protected_keys is not implemented.")


@pre(lambda patches: isinstance(patches, Mapping) and _PATCH_CONTRACT_READY)
@post(lambda result: isinstance(result, dict))
def _expand_dot_keys(patches: Mapping[str, object]) -> dict[str, object]:
    """Expand dot-notation patch keys into nested dictionaries.

    Args:
        patches: Runtime override mapping with optional dot-notation keys.

    Returns:
        Expanded mapping where `a.b=value` becomes `{\"a\": {\"b\": value}}`.

    Raises:
        NotImplementedError: Always, until behavior implementation step.
    """
    _ = patches
    raise NotImplementedError("Contract only: _expand_dot_keys is not implemented.")


@pre(
    lambda base, patch: (
        isinstance(base, Mapping) and isinstance(patch, Mapping) and _PATCH_CONTRACT_READY
    )
)
@post(lambda result: isinstance(result, dict))
def _deep_merge_dicts(base: Mapping[str, object], patch: Mapping[str, object]) -> dict[str, object]:
    """Deep-merge two dictionaries for merge-qualified top-level fields.

    Args:
        base: Existing mapping.
        patch: Incoming mapping.

    Returns:
        Deep-merged mapping.

    Raises:
        NotImplementedError: Always, until behavior implementation step.
    """
    _ = (base, patch)
    raise NotImplementedError("Contract only: _deep_merge_dicts is not implemented.")


@pre(
    lambda spec, patches: (
        isinstance(spec, Mapping)
        and "id" in spec
        and isinstance(patches, Mapping)
        and _PATCH_CONTRACT_READY
    )
)
@post(lambda result: isinstance(result, dict) and "id" in result)
def apply_patches(spec: Mapping[str, object], patches: Mapping[str, object]) -> PersonaSpec:
    """Apply runtime patches to a PersonaSpec using contract-defined semantics.

    Args:
        spec: Canonical PersonaSpec from registry.
        patches: Runtime override mapping.

    Returns:
        Patched PersonaSpec candidate for validation/normalization.

    Raises:
        NotImplementedError: Always, until behavior implementation step.

    Examples:
        >>> sorted(PROTECTED_KEYS)
        ['id', 'spec_digest', 'spec_version']
        >>> sorted(DEEP_MERGE_KEYS)
        ['model_params', 'tools']
        >>> DOT_KEY_SEPARATOR
        '.'
    """
    _ = (spec, patches)
    raise NotImplementedError(
        "Contract only: apply_patches behavior is specified but not implemented."
    )


__all__ = [
    "DEEP_MERGE_KEYS",
    "DOT_KEY_SEPARATOR",
    "PROTECTED_KEYS",
    "apply_patches",
]
