"""Compatibility wrapper for CLI failure envelope helper."""

from __future__ import annotations

from typing import Literal, TypedDict

from larva.shell.cli_runtime import _operation_failure as _operation_failure_result

CliExitCode = Literal[0, 1, 2]


class JsonErrorEnvelope(TypedDict):
    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


class CliFailure(TypedDict, total=False):
    exit_code: CliExitCode
    stderr: str
    error: JsonErrorEnvelope


# @invar:allow shell_result: callers expect direct failure payload for Failure(...) construction
def _operation_failure(operation: str, error: JsonErrorEnvelope, *, as_json: bool) -> CliFailure:
    return _operation_failure_result(operation, error, as_json=as_json).unwrap()
