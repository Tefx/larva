"""Batch update MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, cast

from returns.result import Failure, Success

if TYPE_CHECKING:
    from returns.result import Result

    from larva.app.facade import BatchUpdateResult, LarvaError


class _UpdateBatchFacade(Protocol):
    def update_batch(
        self,
        where: dict[str, object],
        patches: dict[str, object],
        dry_run: bool = False,
    ) -> "Result[BatchUpdateResult, LarvaError]": ...


class UpdateBatchHandlerDeps(Protocol):
    @property
    def _facade(self) -> _UpdateBatchFacade: ...

    def _require_params_object(
        self,
        tool_name: str,
        params: object,
    ) -> "Result[dict[str, Any], LarvaError]": ...

    def _reject_unknown_params(
        self,
        tool_name: str,
        params: dict[str, Any],
        allowed_keys: set[str],
    ) -> "LarvaError | None": ...

    def _require_param(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> "LarvaError | None": ...

    def _require_type(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
        expected_type: type[object],
        expected_label: str,
    ) -> "LarvaError | None": ...


def handle_update_batch(
    handlers: UpdateBatchHandlerDeps,
    params: object,
) -> "Result[BatchUpdateResult, LarvaError]":
    """Handle ``larva.update_batch`` with ``where``, ``patches``, ``dry_run`` validation."""
    return _handle_update_batch_impl(handlers, params)


def _handle_update_batch_impl(
    handlers: UpdateBatchHandlerDeps,
    params: object,
) -> "Result[BatchUpdateResult, LarvaError]":
    validated_params = handlers._require_params_object("larva.update_batch", params)
    if isinstance(validated_params, Failure):
        return Failure(validated_params.failure())
    checked_params = validated_params.unwrap()
    if error := handlers._reject_unknown_params(
        "larva.update_batch", checked_params, {"where", "patches", "dry_run"}
    ):
        return Failure(error)
    if error := handlers._require_param("larva.update_batch", checked_params, "where"):
        return Failure(error)
    if error := handlers._require_param("larva.update_batch", checked_params, "patches"):
        return Failure(error)
    if error := handlers._require_type(
        "larva.update_batch", checked_params, "where", dict, "object"
    ):
        return Failure(error)
    if error := handlers._require_type(
        "larva.update_batch", checked_params, "patches", dict, "object"
    ):
        return Failure(error)
    if "dry_run" in checked_params and (
        error := handlers._require_type(
            "larva.update_batch", checked_params, "dry_run", bool, "boolean"
        )
    ):
        return Failure(error)

    where = checked_params["where"]
    patches = checked_params["patches"]
    dry_run = checked_params.get("dry_run", False)

    return handlers._facade.update_batch(where, patches, dry_run)
