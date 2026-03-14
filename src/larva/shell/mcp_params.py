"""Shared MCP parameter validation helpers."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

from returns.result import Failure, Result, Success

from larva.shell.mcp_contract import LARVA_ERROR_CODES

if TYPE_CHECKING:
    from larva.app.facade import LarvaError


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
        if not isinstance(params, dict):
            return Failure(
                self._malformed_params_error(
                    tool_name,
                    "params must be an object",
                    {"field": "params", "received_type": type(params).__name__},
                )
            )
        return Success(params)

    def _reject_unknown_params(
        self,
        tool_name: str,
        params: dict[str, Any],
        allowed_keys: set[str],
    ) -> LarvaError | None:
        """Reject unsupported parameters at MCP boundary."""
        unknown_keys = sorted(key for key in params if key not in allowed_keys)
        if unknown_keys:
            return self._malformed_params_error(
                tool_name,
                "unknown parameter(s)",
                {"field": "params", "unknown": unknown_keys},
            )
        return None

    def _require_param(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> LarvaError | None:
        """Require key presence for mandatory parameters."""
        if key not in params:
            return self._malformed_params_error(
                tool_name,
                f"missing required parameter '{key}'",
                {"field": key},
            )
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
        value = params.get(key)
        if not isinstance(value, expected_type):
            return self._malformed_params_error(
                tool_name,
                f"parameter '{key}' must be {expected_label}",
                {
                    "field": key,
                    "expected_type": expected_label,
                    "received_type": type(value).__name__,
                },
            )
        return None

    def _require_list_of_strings(
        self,
        tool_name: str,
        params: dict[str, Any],
        key: str,
    ) -> LarvaError | None:
        """Require optional list[str] parameter shape when present."""
        if key not in params:
            return None

        value = params[key]
        if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
            return self._malformed_params_error(
                tool_name,
                f"parameter '{key}' must be list[string]",
                {
                    "field": key,
                    "expected_type": "list[string]",
                    "received_type": type(value).__name__,
                },
            )
        return None

    @staticmethod
    def _component_store_error(
        tool_name: str,
        reason: str,
        details: dict[str, object],
    ) -> LarvaError:
        """Build a documented MCP error envelope for component store failures."""
        return {
            "code": "COMPONENT_NOT_FOUND",
            "numeric_code": LARVA_ERROR_CODES["COMPONENT_NOT_FOUND"],
            "message": f"Component error for '{tool_name}': {reason}",
            "details": {"tool": tool_name, "reason": reason, **details},
        }
