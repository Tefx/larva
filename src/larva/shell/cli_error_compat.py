"""Compatibility wrappers for CLI error-envelope helpers."""

from __future__ import annotations

from typing import Literal, TypedDict

from larva.shell.cli_runtime import _critical_error as _critical_error_result


CliExitCode = Literal[0, 1, 2]


class JsonErrorEnvelope(TypedDict):
    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


# @invar:allow shell_result: callers expect direct envelope dict in shell failure construction
def _critical_error(message: str, details: dict[str, object] | None = None) -> JsonErrorEnvelope:
    return _critical_error_result(message, details).unwrap()
