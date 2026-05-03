"""Shared default facade assembly for shell adapters."""

from __future__ import annotations

from larva.app.facade import DefaultLarvaFacade, LarvaFacade
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.shell.registry import FileSystemRegistryStore


# @invar:allow shell_result: shared adapter factory returns concrete facade for local wrappers
# @shell_orchestration: centralizes shell dependency assembly shared by adapter-local wrappers
def build_default_facade() -> LarvaFacade:
    """Construct the canonical default shell facade."""
    return DefaultLarvaFacade(
        spec=spec_module,
        validate=validate_module,
        normalize=normalize_module,
        registry=FileSystemRegistryStore(),
    )
