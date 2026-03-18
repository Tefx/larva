"""Component operations and API exceptions for larva Python API.

Per ADR-002, this module provides thin delegation to component loading:
- Toolsets return both `capabilities` (canonical) and `tools` (deprecated/mirrored)
- Constraints may contain deprecated `side_effect_policy` retained for transition
"""

from __future__ import annotations

from typing import cast

from returns.result import Failure

from larva.app.facade import LarvaError
from larva.shell.components import FilesystemComponentStore


class LarvaApiError(Exception):
    """Exception raised when facade operations fail.

    This provides failure passthrough from facade to python_api callers
    without Python-API-specific mutation.
    """

    def __init__(self, error: LarvaError) -> None:
        self.error = error
        super().__init__(error["message"])


_component_store: FilesystemComponentStore | None = None


# @invar:allow shell_result: lazy initialization is internal helper returning store instance
# @shell_orchestration: creating FilesystemComponentStore instance is deferred I/O initialization
# @shell_complexity: simple lazy singleton pattern for deferred filesystem access
def _get_component_store() -> FilesystemComponentStore:
    """Lazily initialize and return the default component store instance."""
    global _component_store
    if _component_store is None:
        _component_store = FilesystemComponentStore()
    return _component_store


# @invar:allow shell_result: internal helper builds LarvaError payload for passthrough exceptions
def _component_error_payload(
    *,
    message: str,
    component_type: str,
    component_name: str,
) -> LarvaError:
    """Create a standardized COMPONENT_NOT_FOUND LarvaError payload."""
    return {
        "code": "COMPONENT_NOT_FOUND",
        "numeric_code": 105,
        "message": message,
        "details": {
            "component_type": component_type,
            "component_name": component_name,
        },
    }


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to component store filesystem I/O
def component_list() -> dict[str, list[str]]:
    """List all available components by type.

    This is a thin delegation to `FilesystemComponentStore.list_components`.
    """
    result = _get_component_store().list_components()
    if isinstance(result, Failure):
        error = result.failure()
        raise LarvaApiError(
            _component_error_payload(
                message=str(error),
                component_type=str(getattr(error, "component_type", "")),
                component_name=str(getattr(error, "component_name", "")),
            )
        )
    return cast("dict[str, list[str]]", result.unwrap())


# @invar:allow shell_result: Python API unwraps Result via exception passthrough
# @shell_orchestration: thin delegation to component store filesystem I/O
# @shell_complexity: dispatch branches mirror the fixed component type surface and preserve explicit error payloads.
def component_show(type: str, name: str) -> dict[str, object]:
    """Show details of a specific component."""
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
        raise LarvaApiError(
            _component_error_payload(
                message=f"Invalid component type: {type}",
                component_type=type,
                component_name=name,
            )
        )

    if isinstance(result, Failure):
        error = result.failure()
        raise LarvaApiError(
            _component_error_payload(
                message=str(error),
                component_type=str(getattr(error, "component_type", type)),
                component_name=str(getattr(error, "component_name", name)),
            )
        )

    return cast("dict[str, object]", result.unwrap())
