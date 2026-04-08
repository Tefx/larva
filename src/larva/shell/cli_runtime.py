"""Runtime transport helpers for ``larva.shell.cli``."""

from __future__ import annotations

import json
from typing import IO, Literal, TypedDict, cast

from returns.result import Result, Success

from larva.app import facade as facade_module
from larva.app.facade import LarvaError, LarvaFacade, PersonaSummary
from larva.core.component_error_projection import (
    component_invalid_kind_error,
    project_component_store_error,
)
from larva.core.component_kind import invalid_component_kind_message
from larva.core import assemble as assemble_module, normalize as normalize_module
from larva.core import spec as spec_module, validate as validate_module
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStoreError, FilesystemComponentStore
from larva.shell.registry import FileSystemRegistryStore

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


def _render_validation_report(report: ValidationReport) -> Result[str, object]:
    if report["valid"]:
        warnings = report.get("warnings", [])
        if not warnings:
            return Success("valid\n")
        return Success("valid\n" + "\n".join(f"warning: {warning}" for warning in warnings) + "\n")
    errors = report.get("errors", [])
    if not errors:
        return Success("invalid\n")
    return Success(f"invalid: {errors[0].get('message', 'validation failed')}\n")


def _render_list_summaries(summaries: list[PersonaSummary]) -> Result[str, object]:
    if not summaries:
        return Success("\n")
    return Success(
        "\n".join(f"{item['id']}\t{item['model']}\t{item['spec_digest']}" for item in summaries)
        + "\n"
    )


def _render_payload_for_text(command: CommandName, payload: object) -> Result[str, object]:
    if command == "validate":
        return _render_validation_report(cast("ValidationReport", payload))
    if command == "list":
        return _render_list_summaries(cast("list[PersonaSummary]", payload))
    return Success(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True) + "\n")


def _map_component_error(error: object) -> Result[tuple[JsonErrorEnvelope, CliExitCode], object]:
    if isinstance(error, ComponentStoreError):
        envelope = project_component_store_error(operation="cli.component", error=error)
        exit_code = EXIT_ERROR if envelope["code"] != "INTERNAL" else EXIT_CRITICAL
        return Success(
            (
                envelope,
                exit_code,
            )
        )

    return Success(
        (
            _critical_error(
                "component operation failed",
                {"error_type": type(error).__name__, "message": str(error)},
            ).unwrap(),
            EXIT_CRITICAL,
        )
    )


# @shell_complexity: CLI --set parsing intentionally preserves explicit bool/null/int/float/string coercion order for user-facing semantics.
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
        pass
    try:
        return Success(float(value))
    except ValueError:
        pass
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
        return command_result.get("exit_code", EXIT_OK)

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


def _component_show_invalid_target(
    component_ref: str,
    *,
    component_type: str | None = None,
) -> Result[CliFailure, object]:
    resolved_type = component_type if component_type is not None else ""
    error_envelope = component_invalid_kind_error(
        operation="cli.component_show",
        component_type=resolved_type,
        component_name=None,
        valid_types=["prompts", "toolsets", "constraints", "models"],
    )
    if component_type is not None:
        error_envelope["message"] = invalid_component_kind_message(component_type)
    error_envelope["details"]["component_ref"] = component_ref
    return Success({"exit_code": EXIT_ERROR, "error": error_envelope})


def _build_default_facade() -> Result[LarvaFacade, object]:
    return Success(
        facade_module.DefaultLarvaFacade(
            spec=spec_module,
            assemble=assemble_module,
            validate=validate_module,
            normalize=normalize_module,
            components=FilesystemComponentStore(),
            registry=FileSystemRegistryStore(),
        )
    )
