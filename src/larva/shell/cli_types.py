"""Shared CLI transport types and exit-code constants.

This module is the single source of truth for CLI result shapes.
Both ``cli_runtime`` and ``cli_helpers`` import from here to avoid
duplicated type definitions and circular re-exports.
"""

from __future__ import annotations

from typing import Literal, TypedDict

CliExitCode = Literal[0, 1, 2]

EXIT_OK: CliExitCode = 0
EXIT_ERROR: CliExitCode = 1
EXIT_CRITICAL: CliExitCode = 2

CommandName = Literal[
    "validate",
    "assemble",
    "register",
    "resolve",
    "clone",
    "delete",
    "clear",
    "list",
    "export",
    "update",
    "update-batch",
    "component list",
    "component show",
]


class JsonErrorEnvelope(TypedDict):
    code: str
    numeric_code: int
    message: str
    details: dict[str, object]


class CliFailure(TypedDict, total=False):
    exit_code: CliExitCode
    stderr: str
    error: JsonErrorEnvelope


class CliJsonSuccess(TypedDict):
    data: object


class CliCommandResult(TypedDict, total=False):
    exit_code: CliExitCode
    stdout: str
    stderr: str
    json: CliJsonSuccess


__all__ = [
    "CliExitCode",
    "EXIT_OK",
    "EXIT_ERROR",
    "EXIT_CRITICAL",
    "CommandName",
    "JsonErrorEnvelope",
    "CliFailure",
    "CliJsonSuccess",
    "CliCommandResult",
]
