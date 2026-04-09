"""Canonical component error projection seam shared across transports.

This module centralizes component error semantics so CLI/Web/MCP/Python API
can wrap transport-specific details without drifting error meaning.
"""

from __future__ import annotations

from typing import TypedDict, cast

from deal import post, pre


COMPONENT_ERROR_NUMERIC_CODES: dict[str, int] = {
    "INVALID_INPUT": 1,
    "INTERNAL": 10,
    "COMPONENT_NOT_FOUND": 105,
}


class ComponentErrorEnvelope(TypedDict):
    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


@pre(
    lambda operation, component_type, component_name, valid_types: (
        "\x00" not in operation
        and "\x00" not in component_type
        and (component_name is None or "\x00" not in component_name)
        and all("\x00" not in valid_type for valid_type in valid_types)
    )
)
@post(lambda result: result["code"] == "INVALID_INPUT")
def component_invalid_kind_error(
    operation: str,
    component_type: str,
    component_name: str | None,
    valid_types: list[str],
) -> ComponentErrorEnvelope:
    """Build canonical invalid-kind envelope.

    >>> err = component_invalid_kind_error(
    ...     operation="mcp.component_show",
    ...     component_type="bad",
    ...     component_name="name",
    ...     valid_types=["prompts", "toolsets"],
    ... )
    >>> (err["code"], err["numeric_code"], err["details"]["reason"])
    ('INVALID_INPUT', 1, 'invalid_kind')
    """
    return {
        "code": "INVALID_INPUT",
        "numeric_code": COMPONENT_ERROR_NUMERIC_CODES["INVALID_INPUT"],
        "message": f"invalid component kind: {component_type}",
        "details": {
            "operation": operation,
            "reason": "invalid_kind",
            "component_type": component_type,
            "component_name": component_name,
            "valid_types": valid_types,
        },
    }


@pre(
    lambda operation, component_type, component_name, message: (
        "\x00" not in operation
        and "\x00" not in message
        and (component_type is None or "\x00" not in component_type)
        and (component_name is None or "\x00" not in component_name)
    )
)
@post(lambda result: result["code"] == "COMPONENT_NOT_FOUND")
def component_not_found_error(
    operation: str,
    component_type: str | None,
    component_name: str | None,
    message: str,
) -> ComponentErrorEnvelope:
    """Build canonical component-not-found envelope.

    >>> err = component_not_found_error("cli.component_show", "prompt", "x", "Prompt not found: x")
    >>> (err["code"], err["numeric_code"], err["details"]["reason"])
    ('COMPONENT_NOT_FOUND', 105, 'not_found')
    """
    return {
        "code": "COMPONENT_NOT_FOUND",
        "numeric_code": COMPONENT_ERROR_NUMERIC_CODES["COMPONENT_NOT_FOUND"],
        "message": message,
        "details": {
            "operation": operation,
            "reason": "not_found",
            "component_type": component_type,
            "component_name": component_name,
        },
    }


@pre(
    lambda operation, component_type, component_name, reason: (
        "\x00" not in operation
        and "\x00" not in reason
        and (component_type is None or "\x00" not in component_type)
        and (component_name is None or "\x00" not in component_name)
    )
)
@post(lambda result: result["code"] == "INTERNAL")
def component_store_unavailable_error(
    operation: str,
    component_type: str | None,
    component_name: str | None,
    reason: str,
) -> ComponentErrorEnvelope:
    """Build canonical component-store-unavailable envelope.

    >>> err = component_store_unavailable_error("web.component_list", None, None, "Component store not available")
    >>> (err["code"], err["numeric_code"], err["details"]["reason"])
    ('INTERNAL', 10, 'store_unavailable')
    """
    return {
        "code": "INTERNAL",
        "numeric_code": COMPONENT_ERROR_NUMERIC_CODES["INTERNAL"],
        "message": reason,
        "details": {
            "operation": operation,
            "reason": "store_unavailable",
            "component_type": component_type,
            "component_name": component_name,
        },
    }


@pre(
    lambda operation, error, default_component_type=None, default_component_name=None: (
        "\x00" not in operation
        and hasattr(error, "args")
        and (default_component_type is None or "\x00" not in default_component_type)
        and (default_component_name is None or "\x00" not in default_component_name)
    )
)
@post(lambda result: result["code"] in {"INTERNAL", "COMPONENT_NOT_FOUND"})
def project_component_store_error(
    operation: str,
    error: Exception,
    default_component_type: str | None = None,
    default_component_name: str | None = None,
) -> ComponentErrorEnvelope:
    """Project ComponentStoreError-like failures to canonical envelopes.

    >>> class _Err(Exception):
    ...     component_type = "prompt"
    ...     component_name = "missing"
    >>> err = project_component_store_error("mcp.component_show", _Err("Prompt not found: missing"))
    >>> err["code"]
    'COMPONENT_NOT_FOUND'
    """
    message = str(error)
    component_type = cast(
        "str | None",
        getattr(error, "component_type", default_component_type),
    )
    component_name = cast(
        "str | None",
        getattr(error, "component_name", default_component_name),
    )
    lowered = message.lower()
    if "components directory not found" in lowered or "not available" in lowered:
        return component_store_unavailable_error(
            operation=operation,
            component_type=component_type,
            component_name=component_name,
            reason=message,
        )
    return component_not_found_error(
        operation=operation,
        component_type=component_type,
        component_name=component_name,
        message=message,
    )


__all__ = [
    "COMPONENT_ERROR_NUMERIC_CODES",
    "ComponentErrorEnvelope",
    "component_invalid_kind_error",
    "component_not_found_error",
    "component_store_unavailable_error",
    "project_component_store_error",
]
