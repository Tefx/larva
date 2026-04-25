"""Export-specific MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, cast

from returns.result import Failure, Result, Success

from larva.shell.shared.mcp_handler_helpers import validate_mcp_params

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
    """Handle ``larva_export`` with ``all=true`` xor ``ids`` validation."""
    return _handle_export_impl(handlers, params)


# @shell_complexity: MCP export handler enforces mutually exclusive selector
# validation before facade delegation.
def _handle_export_impl(
    handlers: ExportHandlerDeps,
    params: object,
) -> Result[list[PersonaSpec], LarvaError]:
    # Route params-object / unknown / typed / list-string validation through shared helper
    # Note: XOR (all vs ids) is kept LOCAL as it is a business rule, not structural validation
    validation_result = validate_mcp_params(
        tool_name="larva_export",
        params=params,
        malformed_error=handlers._malformed_params_error,
        allowed_keys={"all", "ids"},
        required_keys=(),  # neither required - XOR handles this
        typed_keys=(("all", bool, "boolean"),),
        list_string_keys=("ids",),
    )
    if isinstance(validation_result, Failure):
        return validation_result

    checked_params = validation_result.unwrap()

    # Local XOR rule: must specify exactly one of all=true or ids
    export_target = _validate_export_target(handlers, checked_params)
    if isinstance(export_target, Failure):
        return Failure(export_target.failure())
    use_all, ids = export_target.unwrap()
    if use_all:
        return handlers._facade.export_all()
    return handlers._facade.export_ids(ids)


# @shell_complexity: export selection keeps explicit all=true/ids conflict and
# missing-selector handling at the transport boundary.
def _validate_export_target(
    handlers: ExportHandlerDeps,
    checked_params: dict[str, Any],
) -> Result[tuple[bool, list[str]], LarvaError]:
    """Validate export selector and return execution target.

    XOR rule is kept LOCAL because it is a business rule (exactly one selector
    must be provided), not a structural validation that validate_mcp_params handles.
    """

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
        # all=True required; all=False is a selector semantics violation (handled by XOR)
        if checked_params["all"] is False:
            return Failure(
                handlers._malformed_params_error(
                    "larva_export",
                    "must specify either 'all' or 'ids'",
                    {"field": "all", "missing": ["ids"]},
                )
            )
        return Success((cast("bool", checked_params["all"]), []))

    # has_ids case - ids already validated as list[string] by validate_mcp_params
    return Success((False, cast("list[str]", checked_params["ids"])))
