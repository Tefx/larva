"""Shared MCP handler validation and Result helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, TypeVar

from returns.result import Failure, Result, Success

from larva.shell.shared import request_validation

if TYPE_CHECKING:
    from larva.app.facade import LarvaError


MalformedParamsBuilder = Callable[[str, str, dict[str, object]], "LarvaError"]
ParamTypeSpec = tuple[str, type[object], str]
_SuccessT = TypeVar("_SuccessT")


# @shell_complexity: shared MCP boundary validator centralizes repeated
# tool-specific malformed-param checks to remove duplicate adapter skeletons.
def validate_mcp_params(
    *,
    tool_name: str,
    params: object,
    malformed_error: MalformedParamsBuilder,
    allowed_keys: set[str],
    required_keys: tuple[str, ...] = (),
    typed_keys: tuple[ParamTypeSpec, ...] = (),
    list_string_keys: tuple[str, ...] = (),
) -> Result[dict[str, Any], "LarvaError"]:
    """Validate MCP params with shared request-validation semantics."""
    params_result = request_validation.require_params_object(params)
    if isinstance(params_result, Failure):
        issue = params_result.failure()
        return Failure(malformed_error(tool_name, issue.reason, issue.details))
    checked_params = params_result.unwrap()

    unknown_result = request_validation.reject_unknown_params(checked_params, allowed_keys)
    if isinstance(unknown_result, Failure):
        issue = unknown_result.failure()
        return Failure(malformed_error(tool_name, issue.reason, issue.details))

    for key in required_keys:
        required_result = request_validation.require_param(checked_params, key)
        if isinstance(required_result, Failure):
            issue = required_result.failure()
            return Failure(malformed_error(tool_name, issue.reason, issue.details))

    for key, expected_type, expected_label in typed_keys:
        if key not in checked_params:
            continue
        type_result = request_validation.require_type(
            checked_params, key, expected_type, expected_label
        )
        if isinstance(type_result, Failure):
            issue = type_result.failure()
            return Failure(malformed_error(tool_name, issue.reason, issue.details))

    for key in list_string_keys:
        list_result = request_validation.require_list_of_strings(checked_params, key)
        if isinstance(list_result, Failure):
            issue = list_result.failure()
            return Failure(malformed_error(tool_name, issue.reason, issue.details))

    return Success(checked_params)


def unwrap_result(result: Result[_SuccessT, "LarvaError"]) -> _SuccessT | "LarvaError":
    """Project ``Result`` into the MCP success-or-error surface."""
    if isinstance(result, Success):
        return result.unwrap()
    return result.failure()


__all__ = ["MalformedParamsBuilder", "ParamTypeSpec", "unwrap_result", "validate_mcp_params"]
