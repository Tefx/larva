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
from larva.shell.components import ComponentStore, ComponentStoreError, ensure_component_payload

if TYPE_CHECKING:
    from larva.app.facade import LarvaError

ComponentPayload: TypeAlias = dict[str, object]
_ComponentLoader: TypeAlias = Callable[[str], Result[ComponentPayload, ComponentStoreError]]


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
        component_type: Canonical plural component kind.
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

    loader_map = {
        "prompts": cast("_ComponentLoader", component_store.load_prompt),
        "toolsets": cast("_ComponentLoader", component_store.load_toolset),
        "constraints": cast("_ComponentLoader", component_store.load_constraint),
        "models": cast("_ComponentLoader", component_store.load_model),
    }
    load_result = loader_map[normalized_type](component_name)
    if isinstance(load_result, Failure):
        return Failure(
            project_component_store_error(
                operation=operation,
                error=load_result.failure(),
                default_component_type=normalized_type,
                default_component_name=component_name,
            )
        )

    payload_result = ensure_component_payload(normalized_type, component_name, load_result.unwrap())
    if isinstance(payload_result, Failure):
        return Failure(
            project_component_store_error(
                operation=operation,
                error=payload_result.failure(),
                default_component_type=normalized_type,
                default_component_name=component_name,
            )
        )

    payload = dict(cast("ComponentPayload", payload_result.unwrap()))
    return Success(payload)


def query_component_list(
    component_store: ComponentStore,
    *,
    operation: str,
) -> Result[dict[str, list[str]], LarvaError]:
    """List all components using shared error projection.

    Args:
        component_store: Shell component store implementation.
        operation: Transport-local operation name for projected error details.

    Returns:
        Success with the component inventory dict mapping type to name list.
        Failure with the canonical projected LarvaError.
    """
    result = component_store.list_components()
    if isinstance(result, Failure):
        return Failure(
            project_component_store_error(
                operation=operation,
                error=result.failure(),
            )
        )
    return Success(result.unwrap())


__all__ = ["ComponentPayload", "query_component", "query_component_list"]
