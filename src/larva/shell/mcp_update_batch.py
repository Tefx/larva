"""Batch update MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from returns.result import Failure, Result

from larva.shell.shared.request_validation import (
    reject_unknown_params,
    require_param,
    require_params_object,
    require_type,
)

if TYPE_CHECKING:
    from returns.result import Result

    from larva.app.facade import BatchUpdateResult, LarvaError


class _UpdateBatchFacade(Protocol):
    def update_batch(
        self,
        where: dict[str, object],
        patches: dict[str, object],
        dry_run: bool = False,
    ) -> Result[BatchUpdateResult, LarvaError]: ...


class UpdateBatchHandlerDeps(Protocol):
    @property
    def _facade(self) -> _UpdateBatchFacade: ...

    def _malformed_params_error(
        self,
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> LarvaError: ...


def handle_update_batch(
    handlers: UpdateBatchHandlerDeps,
    params: object,
) -> Result[BatchUpdateResult, LarvaError]:
    """Handle ``larva_update_batch`` with ``where``, ``patches``, ``dry_run`` validation."""
    return _handle_update_batch_impl(handlers, params)


# @shell_complexity: MCP handler performs schema-shaped parameter validation
# before facade delegation.
def _handle_update_batch_impl(
    handlers: UpdateBatchHandlerDeps,
    params: object,
) -> Result[BatchUpdateResult, LarvaError]:
    params_result = require_params_object(params)
    if isinstance(params_result, Failure):
        issue = params_result.failure()
        return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)
    checked_params = params_result.unwrap()

    unknown_result = reject_unknown_params(checked_params, {"where", "patches", "dry_run"})
    if isinstance(unknown_result, Failure):
        issue = unknown_result.failure()
        return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)

    where_required = require_param(checked_params, "where")
    if isinstance(where_required, Failure):
        issue = where_required.failure()
        return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)

    patches_required = require_param(checked_params, "patches")
    if isinstance(patches_required, Failure):
        issue = patches_required.failure()
        return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)

    where_type = require_type(checked_params, "where", dict, "object")
    if isinstance(where_type, Failure):
        issue = where_type.failure()
        return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)

    patches_type = require_type(checked_params, "patches", dict, "object")
    if isinstance(patches_type, Failure):
        issue = patches_type.failure()
        return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)

    if "dry_run" in checked_params:
        dry_run_type = require_type(checked_params, "dry_run", bool, "boolean")
        if isinstance(dry_run_type, Failure):
            issue = dry_run_type.failure()
            return _validation_failure(handlers, "larva_update_batch", issue.reason, issue.details)

    where = checked_params["where"]
    patches = checked_params["patches"]
    dry_run = checked_params.get("dry_run", False)

    return handlers._facade.update_batch(where, patches, dry_run)


def _validation_failure(
    handlers: UpdateBatchHandlerDeps,
    tool_name: str,
    reason: str,
    details: dict[str, object],
) -> Result[BatchUpdateResult, LarvaError]:
    return Failure(handlers._malformed_params_error(tool_name, reason, details))
