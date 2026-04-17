"""Export-specific MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, cast

from returns.result import Failure, Success

from larva.shell.shared.request_validation import (
    reject_unknown_params,
    require_list_of_strings,
    require_params_object,
    require_type,
)

if TYPE_CHECKING:
    from returns.result import Result

    from larva.app.facade import LarvaError
    from larva.core.spec import PersonaSpec


class _ExportFacade(Protocol):
    def export_all(self) -> Result[list[PersonaSpec], LarvaError]: ...

    def export_ids(self, ids: list[str]) -> Result[list[PersonaSpec], LarvaError]: ...


class ExportHandlerDeps(Protocol):
    @property
    def _facade(self) -> _ExportFacade: ...

    def _malformed_params_error(
        self,
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> LarvaError: ...


def handle_export(
    handlers: ExportHandlerDeps,
    params: object,
) -> Result[list[PersonaSpec], LarvaError]:
    """Handle ``larva_export`` with ``all`` xor ``ids`` validation."""
    return _handle_export_impl(handlers, params)


# @shell_complexity: MCP export handler enforces mutually exclusive selector
# validation before facade delegation.
def _handle_export_impl(
    handlers: ExportHandlerDeps,
    params: object,
) -> Result[list[PersonaSpec], LarvaError]:
    params_result = require_params_object(params)
    if isinstance(params_result, Failure):
        issue = params_result.failure()
        return _validation_failure(handlers, "larva_export", issue.reason, issue.details)
    checked_params = params_result.unwrap()
    unknown_result = reject_unknown_params(checked_params, {"all", "ids"})
    if isinstance(unknown_result, Failure):
        issue = unknown_result.failure()
        return _validation_failure(handlers, "larva_export", issue.reason, issue.details)

    export_target = _validate_export_target(handlers, checked_params)
    if isinstance(export_target, Failure):
        return Failure(export_target.failure())
    use_all, ids = export_target.unwrap()
    if use_all:
        return handlers._facade.export_all()
    return handlers._facade.export_ids(ids)


# @shell_complexity: export selection keeps explicit all/ids conflict handling
# at the transport boundary.
def _validate_export_target(
    handlers: ExportHandlerDeps,
    checked_params: dict[str, Any],
) -> Result[tuple[bool, list[str]], LarvaError]:
    """Validate export selector and return execution target."""

    has_all = "all" in checked_params
    has_ids = "ids" in checked_params

    if has_all and has_ids:
        return Failure(
            handlers._malformed_params_error(
                "larva_export",
                "cannot specify both 'all' and 'ids'",
                {"field": "params", "conflict": ["all", "ids"]},
            )
        )
    if not has_all and not has_ids:
        return Failure(
            handlers._malformed_params_error(
                "larva_export",
                "must specify either 'all' or 'ids'",
                {"field": "params", "missing": ["all", "ids"]},
            )
        )

    if has_all:
        type_result = require_type(checked_params, "all", bool, "boolean")
        if isinstance(type_result, Failure):
            issue = type_result.failure()
            return _validation_failure(handlers, "larva_export", issue.reason, issue.details)
        return Success((cast("bool", checked_params["all"]), []))

    list_result = require_list_of_strings(checked_params, "ids")
    if isinstance(list_result, Failure):
        issue = list_result.failure()
        return _validation_failure(handlers, "larva_export", issue.reason, issue.details)
    return Success((False, cast("list[str]", checked_params["ids"])))


def _validation_failure(
    handlers: ExportHandlerDeps,
    tool_name: str,
    reason: str,
    details: dict[str, object],
) -> Result[Any, LarvaError]:
    return Failure(handlers._malformed_params_error(tool_name, reason, details))
