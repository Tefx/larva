"""Shared structured exception construction helpers.

This module provides the canonical implementation for structured exception
construction across core modules. Each module that needs a structured exception
defines its own wrapper (e.g., `_normalize_error`, `_patch_error`,
`assembly_error`) that delegates to the shared helper.

See:
- ARCHITECTURE.md :: Module: larva.core
"""

from __future__ import annotations

from typing import Any, Protocol, cast

from deal import post, pre


class _StructuredErrorAttrs(Protocol):
    code: str
    message: str
    details: dict[str, Any]


@pre(
    lambda exc_class, code, message, details=None: (
        isinstance(exc_class, type)
        and issubclass(exc_class, Exception)
        and isinstance(code, str)
        and len(code) > 0
        and isinstance(message, str)
        and len(message) > 0
        and (details is None or isinstance(details, dict))
    )
)
@post(
    lambda result: (
        isinstance(result, Exception)
        and isinstance(getattr(result, "code", None), str)
        and len(getattr(result, "code", "")) > 0
        and isinstance(getattr(result, "message", None), str)
        and len(getattr(result, "message", "")) > 0
        and isinstance(getattr(result, "details", None), dict)
    )
)
def _build_structured_exception(
    exc_class: type[Exception],
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> Exception:
    """Build a structured exception with code, message, and details.

    The returned exception has three attributes:
    - code: a short uppercase identifier for the error category
    - message: a human-readable description of the specific error
    - details: an optional dict with additional structured context

    The exception's ``args[0]`` is set to the string ``f"{code}: {message}"``.

    >>> class SimpleError(Exception):
    ...     code: str
    ...     message: str
    ...     details: dict[str, object]
    ...
    >>> err = _build_structured_exception(
    ...     SimpleError,
    ...     "SAMPLE",
    ...     "a sample message",
    ...     {"key": "value"},
    ... )
    >>> (err.code, err.message, err.details)
    ('SAMPLE', 'a sample message', {'key': 'value'})
    >>> "SAMPLE" in str(err)
    True
    >>> err = _build_structured_exception(SimpleError, "EMPTY", "no details")
    >>> err.details
    {}
    """
    error = exc_class(f"{code}: {message}")
    structured_error = cast("_StructuredErrorAttrs", error)
    structured_error.code = code
    structured_error.message = message
    structured_error.details = {} if details is None else details
    return error
