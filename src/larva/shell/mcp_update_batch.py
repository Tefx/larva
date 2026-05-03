"""Batch update MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Protocol

from returns.result import Failure, Result

from larva.shell.shared.mcp_handler_helpers import validate_mcp_params

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
    # Route params-object / unknown / required / typed validation through shared helper
    validation_result = validate_mcp_params(
        tool_name="larva_update_batch",
        params=params,
        malformed_error=handlers._malformed_params_error,
        allowed_keys={"where", "patches", "dry_run"},
        required_keys=("where", "patches"),
        typed_keys=(
            ("where", dict, "object"),
            ("patches", dict, "object"),
            ("dry_run", bool, "boolean"),
        ),
    )
    if isinstance(validation_result, Failure):
        return validation_result

    checked_params = validation_result.unwrap()

    where = checked_params["where"]
    patches = checked_params["patches"]
    dry_run = checked_params.get("dry_run", False)

    return handlers._facade.update_batch(where, patches, dry_run)
