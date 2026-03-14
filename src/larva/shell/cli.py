"""CLI shell adapter for facade-backed persona commands."""

from __future__ import annotations

import argparse
import sys
from typing import IO, Callable, Sequence, cast

from returns.result import Failure, Result, Success

from larva.app.facade import (
    AssembleRequest,
    ClearedRegistry,
    DeletedPersona,
    LarvaFacade,
)
from larva.core.spec import PersonaSpec
from larva.shell.components import ComponentStore, FilesystemComponentStore
from larva.shell.registry import CLEAR_CONFIRMATION_TOKEN
from larva.shell.cli_helpers import (
    EXIT_CRITICAL,
    EXIT_ERROR,
    EXIT_OK,
    CliCommandResult,
    CliExitCode,
    CliFailure,
    JsonErrorEnvelope,  # noqa: F401  # re-exported from this module for callers/tests
    _CliParseError,
    _build_parser,
    _component_show_invalid_target,
    _critical_error,
    _emit_result,
    _map_component_error,
    _map_facade_error,
    _operation_failure,
    _parse_key_value_pairs,
    _read_spec_json,
    _render_payload_for_text,
    _render_validation_report,
    _write_output_json,
    build_default_facade,
)

PERSONA_COMMAND_SEAM = "larva.app.facade.LarvaFacade"
COMPONENT_COMMAND_SEAM = "larva.shell.components.ComponentStore"


def _dispatch_component(
    args: argparse.Namespace,
    *,
    as_json: bool,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
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

    if command == "delete":
        return delete_command(
            cast("str", args.id),
            as_json=as_json,
            facade=facade,
        )

    if command == "clear":
        return clear_command(
            confirm=cast("str", args.confirm),
            as_json=as_json,
            facade=facade,
        )

    if command == "component":
        return _dispatch_component(args, as_json=as_json, component_store=component_store)

    return Failure(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Unsupported command: {command}\n",
            "error": _critical_error("unsupported command", {"command": command}),
        }
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


# @shell_complexity: command-level envelope mapping requires explicit text/json branches
def delete_command(
    persona_id: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    result = facade.delete(persona_id)
    if isinstance(result, Success):
        payload: DeletedPersona = result.unwrap()
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("delete", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure())
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Delete failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: confirmation validation + envelope mapping requires explicit branches
def clear_command(
    confirm: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    if confirm != CLEAR_CONFIRMATION_TOKEN:
        error_envelope: JsonErrorEnvelope = {
            "code": "INVALID_CONFIRMATION_TOKEN",
            "numeric_code": 112,  # INVALID_CONFIRMATION_TOKEN numeric code
            "message": "clear requires exact confirmation token 'CLEAR REGISTRY'",
            "details": {},
        }
        failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Clear failed: {error_envelope['message']}\n"
        return Failure(failure)

    result = facade.clear(confirm)
    if isinstance(result, Success):
        payload: ClearedRegistry = result.unwrap()
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("clear", payload),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure())
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Clear failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: command-level envelope mapping requires explicit text/json branches
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


# @shell_complexity: target parsing + loader routing requires explicit branches
def component_show_command(
    component_ref: str,
    *,
    as_json: bool,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
    component_type, separator, component_name = component_ref.partition("/")
    if separator == "" or component_type == "" or component_name == "":
        failure = _component_show_invalid_target(component_ref)
        if not as_json:
            error_envelope = failure.get("error", _critical_error("unknown error"))
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
        failure = _component_show_invalid_target(component_ref, component_type=component_type)
        if not as_json:
            error_envelope = failure.get("error", _critical_error("unknown error"))
            failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
        return Failure(failure)

    try:
        load_result = loader(component_name)
    except Exception as error:
        error_envelope, exit_code = _map_component_error(error)
        failure: CliFailure = {"exit_code": exit_code, "error": error_envelope}
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
    failure: CliFailure = {"exit_code": exit_code, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
    return Failure(failure)
