"""Shared request-parameter validation helpers for shell adapters.

This module centralizes transport-neutral parameter checks.
Adapters remain responsible for projecting issues into transport-local
error envelopes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from returns.result import Failure, Result, Success


@dataclass(frozen=True)
class RequestValidationIssue:
    """Normalized validation issue for malformed request parameters."""

    reason: str
    details: dict[str, object]


def require_params_object(
    params: object,
) -> Result[dict[str, Any], RequestValidationIssue]:
    """Require top-level params to be an object."""
    if not isinstance(params, dict):
        return Failure(
            RequestValidationIssue(
                reason="params must be an object",
                details={"field": "params", "received_type": type(params).__name__},
            )
        )
    return Success(params)


def reject_unknown_params(
    params: dict[str, Any],
    allowed_keys: set[str],
) -> Result[None, RequestValidationIssue]:
    """Reject unsupported parameter keys."""
    unknown_keys = sorted(key for key in params if key not in allowed_keys)
    if unknown_keys:
        return Failure(
            RequestValidationIssue(
                reason="unknown parameter(s)",
                details={"field": "params", "unknown": unknown_keys},
            )
        )
    return Success(None)


def require_param(
    params: dict[str, Any],
    key: str,
) -> Result[None, RequestValidationIssue]:
    """Require a parameter key to be present."""
    if key not in params:
        return Failure(
            RequestValidationIssue(
                reason=f"missing required parameter '{key}'",
                details={"field": key},
            )
        )
    return Success(None)


def require_type(
    params: dict[str, Any],
    key: str,
    expected_type: type[object],
    expected_label: str,
) -> Result[None, RequestValidationIssue]:
    """Require a parameter to match the expected runtime type."""
    value = params.get(key)
    if not isinstance(value, expected_type):
        return Failure(
            RequestValidationIssue(
                reason=f"parameter '{key}' must be {expected_label}",
                details={
                    "field": key,
                    "expected_type": expected_label,
                    "received_type": type(value).__name__,
                },
            )
        )
    return Success(None)


def require_list_of_strings(
    params: dict[str, Any],
    key: str,
) -> Result[None, RequestValidationIssue]:
    """Require an optional parameter to be ``list[str]`` when present."""
    if key not in params:
        return Success(None)

    value = params[key]
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return Failure(
            RequestValidationIssue(
                reason=f"parameter '{key}' must be list[string]",
                details={
                    "field": key,
                    "expected_type": "list[string]",
                    "received_type": type(value).__name__,
                },
            )
        )
    return Success(None)
