"""Export-specific MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, cast

from returns.result import Failure, Success

if TYPE_CHECKING:
    from returns.result import Result

    from larva.app.facade import LarvaError
    from larva.core.spec import PersonaSpec


class _ExportFacade(Protocol):
    def export_all(self) -> "Result[list[PersonaSpec], LarvaError]": ...

    def export_ids(self, ids: list[str]) -> "Result[list[PersonaSpec], LarvaError]": ...


class ExportHandlerDeps(Protocol):
    @property
    def _facade(self) -> _ExportFacade: ...

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

    def _require_type(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
        expected_type: type[object],
        expected_label: str,
    ) -> "LarvaError | None": ...

    def _require_list_of_strings(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> "LarvaError | None": ...

    def _malformed_params_error(
        self,
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> "LarvaError": ...


def handle_export(
    handlers: ExportHandlerDeps,
    params: object,
) -> "Result[list[PersonaSpec], LarvaError]":
    """Handle ``larva.export`` with ``all`` xor ``ids`` validation."""
    return _handle_export_impl(handlers, params)


def _handle_export_impl(
    handlers: ExportHandlerDeps,
    params: object,
) -> "Result[list[PersonaSpec], LarvaError]":
    validated_params = handlers._require_params_object("larva_export", params)
    if isinstance(validated_params, Failure):
        return Failure(validated_params.failure())
    checked_params = validated_params.unwrap()
    if error := handlers._reject_unknown_params("larva_export", checked_params, {"all", "ids"}):
        return Failure(error)

    export_target = _validate_export_target(handlers, checked_params)
    if isinstance(export_target, Failure):
        return Failure(export_target.failure())
    use_all, ids = export_target.unwrap()
    if use_all:
        return handlers._facade.export_all()
    return handlers._facade.export_ids(ids)


def _validate_export_target(
    handlers: ExportHandlerDeps,
    checked_params: dict[str, Any],
) -> "Result[tuple[bool, list[str]], LarvaError]":
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
        if error := handlers._require_type("larva_export", checked_params, "all", bool, "boolean"):
            return Failure(error)
        return Success((True, []))

    if error := handlers._require_list_of_strings("larva_export", checked_params, "ids"):
        return Failure(error)
    return Success((False, cast("list[str]", checked_params["ids"])))
