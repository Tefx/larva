"""Component Result adapters and API exceptions for larva Python API."""

from __future__ import annotations

from typing import cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaError
from larva.shell.components import FilesystemComponentStore


class LarvaApiError(Exception):
    """Exception raised when facade operations fail."""

    def __init__(self, error: LarvaError) -> None:
        self.error = error
        super().__init__(error["message"])


_component_store: FilesystemComponentStore | None = None


# @invar:allow shell_result: lazy initialization is internal helper returning store instance
# @shell_orchestration: creating FilesystemComponentStore instance is deferred I/O initialization
def _get_component_store() -> FilesystemComponentStore:
    """Lazily initialize and return the default component store instance."""
    global _component_store
    if _component_store is None:
        _component_store = FilesystemComponentStore()
    return _component_store


def _component_list_result() -> Result[dict[str, list[str]], LarvaError]:
    """Return component list as Result with LarvaError failures."""
    result = _get_component_store().list_components()
    if isinstance(result, Failure):
        error = result.failure()
        return Failure(
            {
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": 105,
                "message": str(error),
                "details": {
                    "component_type": str(getattr(error, "component_type", "")),
                    "component_name": str(getattr(error, "component_name", "")),
                },
            }
        )
    return Success(cast("dict[str, list[str]]", result.unwrap()))


def _component_show_result(type: str, name: str) -> Result[dict[str, object], LarvaError]:
    """Return one component as Result with LarvaError failures."""
    store = _get_component_store()

    if type == "prompt":
        result = store.load_prompt(name)
    elif type == "toolset":
        result = store.load_toolset(name)
    elif type == "constraint":
        result = store.load_constraint(name)
    elif type == "model":
        result = store.load_model(name)
    else:
        return Failure(
            {
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": 105,
                "message": f"Invalid component type: {type}",
                "details": {
                    "component_type": type,
                    "component_name": name,
                },
            }
        )

    if isinstance(result, Failure):
        error = result.failure()
        return Failure(
            {
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": 105,
                "message": str(error),
                "details": {
                    "component_type": str(getattr(error, "component_type", type)),
                    "component_name": str(getattr(error, "component_name", name)),
                },
            }
        )

    return Success(cast("dict[str, object]", result.unwrap()))
