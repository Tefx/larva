"""Component Result adapters and API exceptions for larva Python API."""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError
from larva.core.component_error_projection import (
    component_invalid_kind_error,
    component_store_unavailable_error,
    project_component_store_error,
)
from larva.core.component_kind import CANONICAL_COMPONENT_KINDS
from larva.core.component_kind import invalid_component_kind_message, normalize_component_kind
from larva.shell.components import FilesystemComponentStore


class LarvaApiError(Exception):
    """Exception raised when facade operations fail."""

    def __init__(self, error: LarvaError) -> None:
        self.error = error
        super().__init__(error["message"])


_component_store = FilesystemComponentStore()


def _component_list_result() -> Result[dict[str, list[str]], LarvaError]:
    """Return component list as Result with LarvaError failures."""
    result = _component_store.list_components()
    if isinstance(result, Failure):
        error = result.failure()
        return Failure(
            project_component_store_error(operation="python_api.component_list", error=error)
        )
    return Success(cast("dict[str, list[str]]", result.unwrap()))


# @shell_complexity: component loading branches by externally-visible component kind and keeps explicit error mapping at transport boundary.
def _component_show_result(type: str, name: str) -> Result[dict[str, object], LarvaError]:
    """Return one component as Result with LarvaError failures."""
    store = _component_store
    normalized_type = normalize_component_kind(type)

    if normalized_type == "prompts":
        result = store.load_prompt(name)
    elif normalized_type == "toolsets":
        result = store.load_toolset(name)
    elif normalized_type == "constraints":
        result = store.load_constraint(name)
    elif normalized_type == "models":
        result = store.load_model(name)
    else:
        error = component_invalid_kind_error(
            operation="python_api.component_show",
            component_type=type,
            component_name=name,
            valid_types=sorted(CANONICAL_COMPONENT_KINDS),
        )
        error["message"] = invalid_component_kind_message(type)
        return Failure(error)

    if isinstance(result, Failure):
        error = result.failure()
        projected = project_component_store_error(
            operation="python_api.component_show",
            error=error,
            default_component_type=normalized_type,
            default_component_name=name,
        )
        if projected["code"] == "INTERNAL":
            return Failure(
                component_store_unavailable_error(
                    operation="python_api.component_show",
                    component_type=normalized_type,
                    component_name=name,
                    reason=projected["message"],
                )
            )
        return Failure(projected)

    return Success(cast("dict[str, object]", result.unwrap()))
