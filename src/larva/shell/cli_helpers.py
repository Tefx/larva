"""Shared helper contracts for ``larva.shell.cli``."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import IO, Literal, NoReturn, TypedDict, cast

from returns.result import Failure, Result, Success

from larva.app import facade as facade_module
from larva.app.facade import LarvaError, LarvaFacade, PersonaSummary
from larva.core import assemble as assemble_module, normalize as normalize_module
from larva.core import spec as spec_module, validate as validate_module
from larva.core.spec import PersonaSpec
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


class _CliParseError(Exception):
    pass


class _CliParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise _CliParseError(message)


# @invar:allow shell_result: canonical transport envelope mapping at shell boundary
# @shell_orchestration: canonical transport envelope mapping at shell boundary
def _map_facade_error(error: LarvaError) -> JsonErrorEnvelope:
    return {
        "code": error["code"],
        "numeric_code": error["numeric_code"],
        "message": error["message"],
        "details": dict(error["details"]),
    }


# @invar:allow shell_result: shell owns numeric-code envelope construction
# @shell_orchestration: shell owns numeric-code envelope construction
def _critical_error(message: str, details: dict[str, object] | None = None) -> JsonErrorEnvelope:
    return {
        "code": "INTERNAL",
        "numeric_code": facade_module.ERROR_NUMERIC_CODES["INTERNAL"],
        "message": message,
        "details": details or {},
    }


# @invar:allow shell_result: CLI serializer for transport output
# @shell_orchestration: CLI serializer for transport output
def _json_line(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"


# @invar:allow shell_result: text projection for CLI validate command
# @shell_orchestration: text projection for CLI validate command
def _render_validation_report(report: ValidationReport) -> str:
    if report["valid"]:
        warnings = report.get("warnings", [])
        if not warnings:
            return "valid\n"
        return "valid\n" + "\n".join(f"warning: {warning}" for warning in warnings) + "\n"
    errors = report.get("errors", [])
    if not errors:
        return "invalid\n"
    return f"invalid: {errors[0].get('message', 'validation failed')}\n"


# @invar:allow shell_result: text projection for CLI list command
# @shell_orchestration: text projection for CLI list command
def _render_list_summaries(summaries: list[PersonaSummary]) -> str:
    if not summaries:
        return "\n"
    return (
        "\n".join(f"{item['id']}\t{item['model']}\t{item['spec_digest']}" for item in summaries)
        + "\n"
    )


# @invar:allow shell_result: text projection dispatcher for CLI output
# @shell_orchestration: text projection dispatcher for CLI output
def _render_payload_for_text(command: CommandName, payload: object) -> str:
    if command == "validate":
        return _render_validation_report(cast("ValidationReport", payload))
    if command == "list":
        return _render_list_summaries(cast("list[PersonaSummary]", payload))
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


# @invar:allow shell_result: component store errors mapped to CLI envelope
# @shell_orchestration: component store errors mapped to CLI envelope
def _map_component_error(error: object) -> tuple[JsonErrorEnvelope, CliExitCode]:
    if isinstance(error, ComponentStoreError):
        details: dict[str, object] = {}
        component_type = getattr(error, "component_type", None)
        component_name = getattr(error, "component_name", None)
        if component_type is not None:
            details["component_type"] = component_type
        if component_name is not None:
            details["component_name"] = component_name
        return (
            {
                "code": "COMPONENT_NOT_FOUND",
                "numeric_code": facade_module.ERROR_NUMERIC_CODES["COMPONENT_NOT_FOUND"],
                "message": str(error),
                "details": details,
            },
            EXIT_ERROR,
        )

    return (
        _critical_error(
            "component operation failed",
            {"error_type": type(error).__name__, "message": str(error)},
        ),
        EXIT_CRITICAL,
    )


def _parse_key_value_pairs(
    raw_values: list[str], *, flag: str
) -> Result[dict[str, object], JsonErrorEnvelope]:
    parsed: dict[str, object] = {}
    for raw in raw_values:
        if "=" not in raw:
            return Failure(
                _critical_error(f"invalid {flag} value: expected key=value", {"value": raw})
            )
        key, value = raw.split("=", 1)
        if key == "":
            return Failure(
                _critical_error(f"invalid {flag} value: key must be non-empty", {"value": raw})
            )
        parsed[key] = value
    return Success(parsed)


def _read_spec_json(path: str) -> Result[PersonaSpec, JsonErrorEnvelope]:
    path_obj = Path(path)
    try:
        with open(path_obj, encoding="utf-8") as spec_file:
            loaded = json.load(spec_file)
    except FileNotFoundError:
        return Failure(_critical_error("spec file not found", {"path": str(path_obj)}))
    except json.JSONDecodeError as error:
        return Failure(
            _critical_error(
                "spec file is not valid JSON",
                {"path": str(path_obj), "line": error.lineno, "column": error.colno},
            )
        )
    except OSError as error:
        return Failure(
            _critical_error(
                "failed to read spec file", {"path": str(path_obj), "error": str(error)}
            )
        )

    if not isinstance(loaded, dict):
        return Failure(
            _critical_error("spec file root must be a JSON object", {"path": str(path_obj)})
        )
    return Success(cast("PersonaSpec", loaded))


def _write_output_json(path: str, payload: object) -> Result[None, JsonErrorEnvelope]:
    path_obj = Path(path)
    try:
        with open(path_obj, "w", encoding="utf-8") as output_file:
            json.dump(payload, output_file, indent=2, sort_keys=True, ensure_ascii=True)
            output_file.write("\n")
    except OSError as error:
        return Failure(
            _critical_error(
                "failed to write output file", {"path": str(path_obj), "error": str(error)}
            )
        )
    return Success(None)


# @invar:allow shell_result: argparse wiring defines shell command boundary
# @shell_orchestration: argparse wiring defines shell command boundary
def _build_parser() -> _CliParser:
    parser = _CliParser(prog="larva", add_help=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate")
    validate_parser.add_argument("spec")
    validate_parser.add_argument("--json", action="store_true", dest="as_json")

    assemble_parser = subparsers.add_parser("assemble")
    assemble_parser.add_argument("--id", required=True)
    assemble_parser.add_argument("--prompt", dest="prompts", action="append", default=[])
    assemble_parser.add_argument("--toolset", dest="toolsets", action="append", default=[])
    assemble_parser.add_argument("--constraints", dest="constraints", action="append", default=[])
    assemble_parser.add_argument("--model")
    assemble_parser.add_argument("--override", dest="overrides", action="append", default=[])
    assemble_parser.add_argument("--var", dest="variables", action="append", default=[])
    assemble_parser.add_argument("-o", "--output")
    assemble_parser.add_argument("--json", action="store_true", dest="as_json")

    register_parser = subparsers.add_parser("register")
    register_parser.add_argument("spec")
    register_parser.add_argument("--json", action="store_true", dest="as_json")

    resolve_parser = subparsers.add_parser("resolve")
    resolve_parser.add_argument("id")
    resolve_parser.add_argument("--override", dest="overrides", action="append", default=[])
    resolve_parser.add_argument("--json", action="store_true", dest="as_json")

    list_parser = subparsers.add_parser("list")
    list_parser.add_argument("--json", action="store_true", dest="as_json")

    component_parser = subparsers.add_parser("component")
    component_subparsers = component_parser.add_subparsers(dest="component_command", required=True)

    component_list_parser = component_subparsers.add_parser("list")
    component_list_parser.add_argument("--json", action="store_true", dest="as_json")

    component_show_parser = component_subparsers.add_parser("show")
    component_show_parser.add_argument("ref")
    component_show_parser.add_argument("--json", action="store_true", dest="as_json")

    delete_parser = subparsers.add_parser("delete")
    delete_parser.add_argument("id")
    delete_parser.add_argument("--json", action="store_true", dest="as_json")

    clear_parser = subparsers.add_parser("clear")
    clear_parser.add_argument("--confirm", required=True)
    clear_parser.add_argument("--json", action="store_true", dest="as_json")

    clone_parser = subparsers.add_parser("clone")
    clone_parser.add_argument("source_id")
    clone_parser.add_argument("new_id")
    clone_parser.add_argument("--json", action="store_true", dest="as_json")

    export_parser = subparsers.add_parser("export")
    export_parser.add_argument("ids", nargs="*", default=[])
    export_parser.add_argument("--all", action="store_true", dest="export_all")
    export_parser.add_argument("--json", action="store_true", dest="as_json")

    return parser


# @invar:allow shell_result: CLI emitter writes shell transport streams
def _emit_result(
    result: Result[CliCommandResult, CliFailure], *, as_json: bool, stdout: IO[str], stderr: IO[str]
) -> CliExitCode:
    if isinstance(result, Success):
        command_result = result.unwrap()
        if as_json:
            stdout.write(_json_line(command_result.get("json", {"data": None})))
        else:
            stdout.write(command_result.get("stdout", ""))
        return command_result.get("exit_code", EXIT_OK)

    failure = result.failure()
    if as_json:
        stdout.write(_json_line({"error": failure.get("error", _critical_error("unknown error"))}))
    else:
        stderr.write(failure.get("stderr", ""))
    return failure.get("exit_code", EXIT_ERROR)


# @invar:allow shell_result: operation envelope couples text/json shell outputs
# @shell_orchestration: operation envelope couples text/json shell outputs
def _operation_failure(operation: str, error: JsonErrorEnvelope, *, as_json: bool) -> CliFailure:
    failure: CliFailure = {"exit_code": EXIT_CRITICAL, "error": error}
    if not as_json:
        failure["stderr"] = f"{operation} failed: {error['message']}\n"
    return failure


# @invar:allow shell_result: canonical invalid-target envelope for component show
# @shell_orchestration: canonical invalid-target envelope for component show
def _component_show_invalid_target(
    component_ref: str,
    *,
    component_type: str | None = None,
) -> CliFailure:
    details: dict[str, object] = {"component_ref": component_ref}
    if component_type is not None:
        details["component_type"] = component_type
    error_envelope: JsonErrorEnvelope = {
        "code": "COMPONENT_NOT_FOUND",
        "numeric_code": facade_module.ERROR_NUMERIC_CODES["COMPONENT_NOT_FOUND"],
        "message": f"invalid component target: {component_ref}",
        "details": details,
    }
    return {"exit_code": EXIT_ERROR, "error": error_envelope}


# @invar:allow shell_result: shell default wiring binds app facade to concrete stores
# @shell_orchestration: shell default wiring binds app facade to concrete stores
def build_default_facade() -> LarvaFacade:
    return facade_module.DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=FilesystemComponentStore(),
        registry=FileSystemRegistryStore(),
    )
