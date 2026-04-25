"""Assembly error helpers."""

from __future__ import annotations

from typing import Any, cast

from deal import post, pre

from larva.core._structured_error import _build_structured_exception


class AssemblyError(Exception):
    code: str
    message: str
    details: dict[str, Any]


@pre(
    lambda code, message, details=None: (
        isinstance(code, str)
        and len(code) > 0
        and isinstance(message, str)
        and len(message) > 0
        and (details is None or isinstance(details, dict))
    )
)
@post(
    lambda result: (
        isinstance(result, AssemblyError)
        and isinstance(result.code, str)
        and len(result.code) > 0
        and isinstance(result.message, str)
        and len(result.message) > 0
        and isinstance(result.details, dict)
    )
)
def assembly_error(
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> AssemblyError:
    """Build a structured assembly error.

    >>> error = assembly_error("COMPONENT_CONFLICT", "conflict")
    >>> (error.code, error.message, error.details)
    ('COMPONENT_CONFLICT', 'conflict', {})
    """
    return cast("AssemblyError", _build_structured_exception(AssemblyError, code, message, details))
