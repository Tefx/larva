"""Shared component-query helpers for shell adapters.

This module centralizes transport-neutral component query semantics.
Adapters remain responsible for local envelopes and runtime hooks.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING, TypeAlias, cast

from returns.result import Failure, Result, Success

from larva.core.component_error_projection import (
    component_invalid_kind_error,
    project_component_store_error,
)
from larva.core.component_kind import (
    CANONICAL_COMPONENT_KINDS,
    invalid_component_kind_message,
    normalize_component_kind,
)
from larva.shell.components import ComponentStore, ComponentStoreError

if TYPE_CHECKING:
    from larva.app.facade import LarvaError

ComponentPayload: TypeAlias = dict[str, object]
_ComponentLoader: TypeAlias = Callable[[str], Result[ComponentPayload, ComponentStoreError]]


# @invar:allow shell_result: internal loader table supports query_component Result flow
# @shell_orchestration: shared shell query service selects store loaders for adapters
def _loader_map(component_store: ComponentStore) -> dict[str, _ComponentLoader]:
    """Build the canonical loader map keyed by normalized component kind."""
    return {
        "prompts": cast("_ComponentLoader", component_store.load_prompt),
        "toolsets": cast("_ComponentLoader", component_store.load_toolset),
        "constraints": cast("_ComponentLoader", component_store.load_constraint),
        "models": cast("_ComponentLoader", component_store.load_model),
    }


def query_component(
    component_store: ComponentStore,
    *,
    component_type: str,
    component_name: str,
    operation: str,
) -> Result[ComponentPayload, LarvaError]:
    """Load one component using canonical kind normalization and error projection.

    Args:
        component_store: Shell component store implementation.
        component_type: Canonical or compatibility alias component kind.
        component_name: Requested component name.
        operation: Transport-local operation name for projected error details.

    Returns:
        Success with the loaded component payload.
        Failure with the canonical projected LarvaError.
    """
    normalized_type = normalize_component_kind(component_type)
    if normalized_type is None:
        error = component_invalid_kind_error(
            operation=operation,
            component_type=component_type,
            component_name=component_name,
            valid_types=sorted(CANONICAL_COMPONENT_KINDS),
        )
        error["message"] = invalid_component_kind_message(component_type)
        return Failure(error)

    load_result = _loader_map(component_store)[normalized_type](component_name)
    if isinstance(load_result, Failure):
        return Failure(
            project_component_store_error(
                operation=operation,
                error=load_result.failure(),
                default_component_type=normalized_type,
                default_component_name=component_name,
            )
        )

    return Success(cast("ComponentPayload", load_result.unwrap()))


__all__ = ["ComponentPayload", "query_component"]
