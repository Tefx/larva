"""Shared MCP parameter validation helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, TypeVar

from larva.shell.mcp_contract import LARVA_ERROR_CODES
from larva.shell.shared.mcp_handler_helpers import (
    ParamTypeSpec,
    unwrap_result,
    validate_mcp_params,
)

if TYPE_CHECKING:
    from returns.result import Result

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
