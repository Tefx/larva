"""CLI shell adapter for facade-backed persona commands."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import IO, Callable, Literal, NoReturn, Sequence, TypedDict, cast

from returns.result import Failure, Result, Success

from larva.app import facade as facade_module
from larva.app.facade import AssembleRequest, LarvaError, LarvaFacade, PersonaSummary
from larva.core import assemble as assemble_module
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell.components import ComponentStore, ComponentStoreError, FilesystemComponentStore
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
    "list",
    "component list",
    "component show",
]

PERSONA_COMMAND_SEAM = "larva.app.facade.LarvaFacade"
COMPONENT_COMMAND_SEAM = "larva.shell.components.ComponentStore"


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


# @invar:allow shell_result: helper maps facade error typed dict for transport output
def _map_facade_error(error: LarvaError) -> JsonErrorEnvelope:
    return {
        "code": error["code"],
        "numeric_code": error["numeric_code"],
        "message": error["message"],
        "details": dict(error["details"]),
    }


# @invar:allow shell_result: helper builds transport-level critical envelope
def _critical_error(message: str, details: dict[str, object] | None = None) -> JsonErrorEnvelope:
    return {
        "code": "INTERNAL",
        "numeric_code": facade_module.ERROR_NUMERIC_CODES["INTERNAL"],
        "message": message,
        "details": details or {},
    }


# @invar:allow shell_result: serializer helper used by stdout emission
def _json_line(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n"


# @invar:allow shell_result: text formatter helper for validate command
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


# @invar:allow shell_result: text formatter helper for list command
def _render_list_summaries(summaries: list[PersonaSummary]) -> str:
    if not summaries:
        return "\n"
    return (
        "\n".join(f"{item['id']}\t{item['model']}\t{item['spec_digest']}" for item in summaries)
        + "\n"
    )


# @invar:allow shell_result: text formatter helper for success payloads
def _render_payload_for_text(command: CommandName, payload: object) -> str:
    if command == "validate":
        return _render_validation_report(cast("ValidationReport", payload))
    if command == "list":
        return _render_list_summaries(cast("list[PersonaSummary]", payload))
    return json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=True) + "\n"


# @invar:allow shell_result: helper maps ComponentStore failures to transport envelope
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


# @invar:allow shell_result: filesystem output helper returns typed error envelope
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


# @invar:allow shell_result: argparse builder returns parser object
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

    return parser


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


# @invar:allow shell_result: helper builds typed CLI failure envelope
def _operation_failure(operation: str, error: JsonErrorEnvelope, *, as_json: bool) -> CliFailure:
    failure: CliFailure = {"exit_code": EXIT_CRITICAL, "error": error}
    if not as_json:
        failure["stderr"] = f"{operation} failed: {error['message']}\n"
    return failure


def _dispatch(
    args: argparse.Namespace,
    *,
    facade: LarvaFacade,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
    command = cast("str", args.command)
    as_json = cast("bool", getattr(args, "as_json", False))

    if command == "validate":
        loaded_spec = _read_spec_json(cast("str", args.spec))
        if isinstance(loaded_spec, Failure):
            return Failure(_operation_failure("Validate", loaded_spec.failure(), as_json=as_json))
        return validate_command(loaded_spec.unwrap(), as_json=as_json, facade=facade)

    if command == "assemble":
        overrides = _parse_key_value_pairs(cast("list[str]", args.overrides), flag="--override")
        if isinstance(overrides, Failure):
            return Failure(_operation_failure("Assemble", overrides.failure(), as_json=as_json))
        variables = _parse_key_value_pairs(cast("list[str]", args.variables), flag="--var")
        if isinstance(variables, Failure):
            return Failure(_operation_failure("Assemble", variables.failure(), as_json=as_json))

        request: AssembleRequest = {
            "id": cast("str", args.id),
            "prompts": cast("list[str]", args.prompts),
            "toolsets": cast("list[str]", args.toolsets),
            "constraints": cast("list[str]", args.constraints),
            "overrides": overrides.unwrap(),
            "variables": cast("dict[str, str]", variables.unwrap()),
        }
        model = cast("str | None", args.model)
        if model is not None:
            request["model"] = model
        return assemble_command(
            request,
            as_json=as_json,
            facade=facade,
            output_path=cast("str | None", args.output),
        )

    if command == "register":
        loaded_spec = _read_spec_json(cast("str", args.spec))
        if isinstance(loaded_spec, Failure):
            return Failure(_operation_failure("Register", loaded_spec.failure(), as_json=as_json))
        return register_command(loaded_spec.unwrap(), as_json=as_json, facade=facade)

    if command == "resolve":
        overrides = _parse_key_value_pairs(cast("list[str]", args.overrides), flag="--override")
        if isinstance(overrides, Failure):
            return Failure(_operation_failure("Resolve", overrides.failure(), as_json=as_json))
        return resolve_command(
            cast("str", args.id),
            overrides=overrides.unwrap(),
            as_json=as_json,
            facade=facade,
        )

    if command == "list":
        return list_command(as_json=as_json, facade=facade)

    if command == "component":
        component_command = cast("str", getattr(args, "component_command", ""))
        if component_command == "list":
            return component_list_command(as_json=as_json, component_store=component_store)
        if component_command == "show":
            return component_show_command(
                cast("str", args.ref),
                as_json=as_json,
                component_store=component_store,
            )
        return Failure(
            {
                "exit_code": EXIT_CRITICAL,
                "stderr": f"Unsupported component command: {component_command}\n",
                "error": _critical_error(
                    "unsupported component command", {"command": component_command}
                ),
            }
        )

    return Failure(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Unsupported command: {command}\n",
            "error": _critical_error("unsupported command", {"command": command}),
        }
    )


# @invar:allow shell_result: returns concrete facade wiring for transport adapter
def build_default_facade() -> LarvaFacade:
    return facade_module.DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=FilesystemComponentStore(),
        registry=FileSystemRegistryStore(),
    )


# @invar:allow shell_result: CLI entry handler returns process exit code
def run_cli(
    argv: Sequence[str],
    *,
    facade: LarvaFacade,
    stdout: IO[str],
    stderr: IO[str],
    component_store: ComponentStore | None = None,
) -> CliExitCode:
    parser = _build_parser()
    active_component_store = (
        component_store if component_store is not None else FilesystemComponentStore()
    )
    try:
        args = parser.parse_args(list(argv))
    except _CliParseError as error:
        parse_failure: CliFailure = {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Argument parsing failed: {error}\n",
            "error": _critical_error("argument parsing failed", {"message": str(error)}),
        }
        return _emit_result(
            Failure(parse_failure),
            as_json="--json" in argv,
            stdout=stdout,
            stderr=stderr,
        )

    return _emit_result(
        _dispatch(args, facade=facade, component_store=active_component_store),
        as_json=cast("bool", getattr(args, "as_json", False)),
        stdout=stdout,
        stderr=stderr,
    )


# @invar:allow shell_result: process entrypoint returns int exit code
# @invar:allow dead_export: console script entrypoint referenced via pyproject script
def main(argv: Sequence[str] | None = None) -> int:
    active_argv = list(sys.argv[1:] if argv is None else argv)
    return int(
        run_cli(
            active_argv,
            facade=build_default_facade(),
            stdout=sys.stdout,
            stderr=sys.stderr,
            component_store=FilesystemComponentStore(),
        )
    )


def validate_command(
    spec: PersonaSpec,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    report = facade.validate(spec)
    if report["valid"]:
        result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_validation_report(report),
        }
        if as_json:
            result["json"] = {
                "data": {
                    "valid": True,
                    "errors": [],
                    "warnings": report.get("warnings", []),
                }
            }
        return Success(result)

    error_envelope = _map_facade_error(
        {
            "code": "PERSONA_INVALID",
            "numeric_code": 101,
            "message": report["errors"][0]["message"] if report["errors"] else "validation failed",
            "details": {"report": report},
        }
    )
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Validation failed: {error_envelope['message']}\n"
    return Failure(failure)


def assemble_command(
    request: AssembleRequest,
    *,
    as_json: bool,
    facade: LarvaFacade,
    output_path: str | None = None,
) -> Result[CliCommandResult, CliFailure]:
    result = facade.assemble(request)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        if output_path is not None:
            write_result = _write_output_json(output_path, payload)
            if isinstance(write_result, Failure):
                error_envelope = write_result.failure()
                failure: CliFailure = {"exit_code": EXIT_CRITICAL, "error": error_envelope}
                if not as_json:
                    failure["stderr"] = f"Assembly failed: {error_envelope['message']}\n"
                return Failure(failure)
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": ""
            if output_path is not None
            else _render_payload_for_text("assemble", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure())
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Assembly failed: {error_envelope['message']}\n"
    return Failure(failure)


def register_command(
    spec: PersonaSpec,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    result = facade.register(spec)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("register", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure())
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Registration failed: {error_envelope['message']}\n"
    return Failure(failure)


def resolve_command(
    persona_id: str,
    *,
    overrides: dict[str, object] | None = None,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    result = facade.resolve(persona_id, overrides=overrides)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("resolve", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure())
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Resolve failed: {error_envelope['message']}\n"
    return Failure(failure)


def list_command(*, as_json: bool, facade: LarvaFacade) -> Result[CliCommandResult, CliFailure]:
    result = facade.list()
    if isinstance(result, Success):
        payload = list(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("list", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure())
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"List failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: command-level error envelope mapping requires explicit branches
def component_list_command(
    *, as_json: bool, component_store: ComponentStore
) -> Result[CliCommandResult, CliFailure]:
    try:
        result = component_store.list_components()
    except Exception as error:
        error_envelope, exit_code = _map_component_error(error)
        failure: CliFailure = {"exit_code": exit_code, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Component list failed: {error_envelope['message']}\n"
        return Failure(failure)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("component list", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope, exit_code = _map_component_error(result.failure())
    failure: CliFailure = {"exit_code": exit_code, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Component list failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: target parsing + loader routing requires explicit branching
def component_show_command(
    component_ref: str,
    *,
    as_json: bool,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
    component_type, separator, component_name = component_ref.partition("/")
    if separator == "" or component_type == "" or component_name == "":
        error_envelope: JsonErrorEnvelope = {
            "code": "COMPONENT_NOT_FOUND",
            "numeric_code": facade_module.ERROR_NUMERIC_CODES["COMPONENT_NOT_FOUND"],
            "message": f"invalid component target: {component_ref}",
            "details": {"component_ref": component_ref},
        }
        failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
        return Failure(failure)

    loaders: dict[str, Callable[[str], Result[object, object]]] = {
        "prompts": cast("Callable[[str], Result[object, object]]", component_store.load_prompt),
        "toolsets": cast("Callable[[str], Result[object, object]]", component_store.load_toolset),
        "constraints": cast(
            "Callable[[str], Result[object, object]]", component_store.load_constraint
        ),
        "models": cast("Callable[[str], Result[object, object]]", component_store.load_model),
    }
    loader = loaders.get(component_type)
    if loader is None:
        error_envelope = {
            "code": "COMPONENT_NOT_FOUND",
            "numeric_code": facade_module.ERROR_NUMERIC_CODES["COMPONENT_NOT_FOUND"],
            "message": f"invalid component target: {component_ref}",
            "details": {"component_ref": component_ref, "component_type": component_type},
        }
        failure = {"exit_code": EXIT_ERROR, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
        return Failure(failure)

    try:
        load_result = loader(component_name)
    except Exception as error:
        error_envelope, exit_code = _map_component_error(error)
        failure = {"exit_code": exit_code, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
        return Failure(failure)
    if isinstance(load_result, Success):
        payload = cast("dict[str, object]", dict(cast("dict[str, object]", load_result.unwrap())))
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("component show", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope, exit_code = _map_component_error(load_result.failure())
    failure = {"exit_code": exit_code, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
    return Failure(failure)
