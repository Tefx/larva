"""Component Result adapters and API exceptions for larva Python API."""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.core.component_error_projection import project_component_store_error
from larva.shell.components import FilesystemComponentStore
from larva.shell.shared.component_queries import query_component

if TYPE_CHECKING:
    from larva.app.facade import LarvaError


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


def _component_show_result(component_type: str, name: str) -> Result[dict[str, object], LarvaError]:
    """Return one component as Result with LarvaError failures.

    Canonical-only policy: strips mirrored legacy fields before returning.
    - toolsets: removes deprecated 'tools' field (canonical 'capabilities' retained)
    - constraints: removes deprecated 'side_effect_policy' field
    """
    result = query_component(
        _component_store,
        component_type=component_type,
        component_name=name,
        operation="python_api.component_show",
    )
    if isinstance(result, Failure):
        return Failure(result.failure())

    data = cast("dict[str, object]", result.unwrap())

    # Strip mirrored legacy fields per canonical cutover policy
    if component_type in ("toolset", "toolsets"):
        data = {k: v for k, v in data.items() if k != "tools"}
    elif component_type in ("constraint", "constraints"):
        data = {k: v for k, v in data.items() if k != "side_effect_policy"}

    return Success(data)
