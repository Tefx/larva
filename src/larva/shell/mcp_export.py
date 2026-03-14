"""Export-specific MCP handler logic.

Extracted from ``larva.shell.mcp`` to keep the main handler module within
repository file-size guardrails while preserving behavior.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol, cast

from returns.result import Failure

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
    validated_params = handlers._require_params_object("larva.export", params)
    if isinstance(validated_params, Failure):
        return Failure(validated_params.failure())
    checked_params = validated_params.unwrap()
    if error := handlers._reject_unknown_params("larva.export", checked_params, {"all", "ids"}):
        return Failure(error)

    has_all = "all" in checked_params
    has_ids = "ids" in checked_params

    if has_all and has_ids:
        return Failure(
            handlers._malformed_params_error(
                "larva.export",
                "cannot specify both 'all' and 'ids'",
                {"field": "params", "conflict": ["all", "ids"]},
            )
        )
    if not has_all and not has_ids:
        return Failure(
            handlers._malformed_params_error(
                "larva.export",
                "must specify either 'all' or 'ids'",
                {"field": "params", "missing": ["all", "ids"]},
            )
        )

    if has_all:
        if error := handlers._require_type("larva.export", checked_params, "all", bool, "boolean"):
            return Failure(error)
        result = handlers._facade.export_all()
    else:
        if error := handlers._require_list_of_strings("larva.export", checked_params, "ids"):
            return Failure(error)
        result = handlers._facade.export_ids(cast("list[str]", checked_params["ids"]))

    return result
