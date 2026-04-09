"""Shared MCP parameter validation helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from returns.result import Failure, Result, Success

from larva.shell.mcp_contract import LARVA_ERROR_CODES
from larva.shell.shared import request_validation
from larva.shell.shared.mcp_handler_helpers import (
    ParamTypeSpec,
    unwrap_result,
    validate_mcp_params,
)

if TYPE_CHECKING:
    from larva.app.facade import LarvaError


_SuccessT = TypeVar("_SuccessT")


class MCPParamValidationMixin:
    """Reusable helpers for MCP handler parameter validation."""

    @staticmethod
    def _malformed_params_error(
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> LarvaError:
        """Build a documented MCP error envelope for malformed request params."""
        return {
            "code": "INTERNAL",
            "numeric_code": LARVA_ERROR_CODES["INTERNAL"],
            "message": f"Malformed parameters for '{tool_name}': {reason}",
            "details": {"tool": tool_name, "reason": reason, **details},
        }

    def _require_params_object(
        self,
        tool_name: str,
        params: object,
    ) -> Result[dict[str, Any], LarvaError]:
        """Validate MCP params top-level shape as JSON object."""
        validation_result = request_validation.require_params_object(params)
        if isinstance(validation_result, Failure):
            issue = validation_result.failure()
            return Failure(self._malformed_params_error(tool_name, issue.reason, issue.details))
        return Success(validation_result.unwrap())

    def _reject_unknown_params(
        self,
        tool_name: str,
        params: dict[str, Any],
        allowed_keys: set[str],
    ) -> LarvaError | None:
        """Reject unsupported parameters at MCP boundary."""
        validation_result = request_validation.reject_unknown_params(params, allowed_keys)
        if isinstance(validation_result, Failure):
            issue = validation_result.failure()
            return self._malformed_params_error(tool_name, issue.reason, issue.details)
        return None

    def _require_param(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> LarvaError | None:
        """Require key presence for mandatory parameters."""
        validation_result = request_validation.require_param(params, key)
        if isinstance(validation_result, Failure):
            issue = validation_result.failure()
            return self._malformed_params_error(tool_name, issue.reason, issue.details)
        return None

    def _require_type(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
        expected_type: type[object],
        expected_label: str,
    ) -> LarvaError | None:
        """Require parameter runtime type at MCP boundary."""
        validation_result = request_validation.require_type(
            params,
            key,
            expected_type,
            expected_label,
        )
        if isinstance(validation_result, Failure):
            issue = validation_result.failure()
            return self._malformed_params_error(tool_name, issue.reason, issue.details)
        return None

    def _require_list_of_strings(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> LarvaError | None:
        """Require optional list[str] parameter shape when present."""
        validation_result = request_validation.require_list_of_strings(params, key)
        if isinstance(validation_result, Failure):
            issue = validation_result.failure()
            return self._malformed_params_error(tool_name, issue.reason, issue.details)
        return None

    def _validated_params(
        self,
        tool_name: str,
        params: object,
        *,
        allowed_keys: set[str],
        required_keys: tuple[str, ...] = (),
        typed_keys: tuple[ParamTypeSpec, ...] = (),
        list_string_keys: tuple[str, ...] = (),
    ) -> Result[dict[str, Any], LarvaError]:
        """Validate a full MCP params object with shared helper flow."""
        return validate_mcp_params(
            tool_name=tool_name,
            params=params,
            malformed_error=self._malformed_params_error,
            allowed_keys=allowed_keys,
            required_keys=required_keys,
            typed_keys=typed_keys,
            list_string_keys=list_string_keys,
        )

    @staticmethod
    def _unwrap_result(result: Result[_SuccessT, LarvaError]) -> _SuccessT | LarvaError:
        """Convert facade ``Result`` values into MCP success-or-error output."""
        return unwrap_result(result)
