"""Runtime transport helpers for ``larva.shell.cli``."""

from __future__ import annotations

import json
from typing import IO, TYPE_CHECKING, cast

from returns.result import Result, Success

from larva.app import facade as facade_module
from larva.shell.cli_projection import render_validation_report_text
from larva.shell.cli_types import (
    EXIT_CRITICAL,
    EXIT_ERROR,
    EXIT_OK,
    CliCommandResult,
    CliExitCode,
    CliFailure,
    CommandName,
    JsonErrorEnvelope,
)

if TYPE_CHECKING:
    from larva.app.facade_types import LarvaError, PersonaSummary
    from larva.core.validation_contract import ValidationReport


def _map_facade_error(error: LarvaError) -> Result[JsonErrorEnvelope, object]:
    return Success(
        {
            "code": error["code"],
            "numeric_code": error["numeric_code"],
            "message": error["message"],
            "details": dict(error["details"]),
        }
    )


def _critical_error(
    message: str,
    details: dict[str, object] | None = None,
) -> Result[JsonErrorEnvelope, object]:
    return Success(
        {
            "code": "INTERNAL",
            "numeric_code": facade_module.ERROR_NUMERIC_CODES["INTERNAL"],
            "message": message,
            "details": details or {},
        }
    )


def _json_line(payload: object) -> Result[str, object]:
    return Success(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")


def _render_list_summaries(summaries: list[PersonaSummary]) -> Result[str, object]:
    if not summaries:
        return Success("\n")
    return Success(
        "\n".join(f"{item['id']}\t{item['model']}\t{item['spec_digest']}" for item in summaries)
        + "\n"
    )


def _render_payload_for_text(command: CommandName, payload: object) -> Result[str, object]:
    if command == "validate":
        return render_validation_report_text(cast("ValidationReport", payload))
    if command == "list":
        return _render_list_summaries(cast("list[PersonaSummary]", payload))
    return Success(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True) + "\n")


# @invar:allow shell_result: CLI exit-code projection is a pure transport helper
# returning a process code
def cli_exit_code_for_error(error: JsonErrorEnvelope) -> CliExitCode:
    """Return the CLI exit-code projection for a canonical error envelope."""

    return EXIT_CRITICAL if error["code"] == "INTERNAL" else EXIT_ERROR


# @shell_complexity: CLI --set parsing intentionally preserves explicit bool/null/int/float/string
# coercion order for user-facing semantics.
def _infer_value_type(value: str) -> Result[object, object]:
    if value.lower() == "true":
        return Success(True)
    if value.lower() == "false":
        return Success(False)
    if value.lower() == "null":
        return Success(None)
    try:
        return Success(int(value))
    except ValueError:
        ...
    try:
        return Success(float(value))
    except ValueError:
        ...
    return Success(value)


def _emit_result(
    result: Result[CliCommandResult, CliFailure], *, as_json: bool, stdout: IO[str], stderr: IO[str]
) -> CliExitCode:
    if isinstance(result, Success):
        command_result = result.unwrap()
        if as_json:
            stdout.write(_json_line(command_result.get("json", {"data": None})).unwrap())
        else:
            stdout.write(command_result.get("stdout", ""))
        return cast("CliExitCode", command_result.get("exit_code", EXIT_OK))

    failure = result.failure()
    if as_json:
        stdout.write(
            _json_line(
                {"error": failure.get("error", _critical_error("unknown error").unwrap())}
            ).unwrap()
        )
    else:
        stderr.write(failure.get("stderr", ""))
    return failure.get("exit_code", EXIT_ERROR)


def _operation_failure(
    operation: str,
    error: JsonErrorEnvelope,
    *,
    as_json: bool,
) -> Result[CliFailure, object]:
    failure: CliFailure = {"exit_code": EXIT_CRITICAL, "error": error}
    if not as_json:
        failure["stderr"] = f"{operation} failed: {error['message']}\n"
    return Success(failure)
