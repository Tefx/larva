"""CLI shell adapter for facade-backed persona commands."""

from __future__ import annotations

import argparse
from typing import IO, TYPE_CHECKING, Callable, Sequence, cast

from returns.result import Failure, Result, Success

from larva.app.facade import LarvaFacade
from larva.cli_entrypoint import main
from larva.cli_facade import build_default_facade
from larva.shell.components import ComponentStore, FilesystemComponentStore
from larva.shell.cli_helpers import (
    EXIT_CRITICAL,
    EXIT_ERROR,
    EXIT_OK,
    CliExitCode,
    CliCommandResult,
    CliFailure,
    JsonErrorEnvelope,  # noqa: F401  # re-exported from this module for callers/tests
    _CliParseError,
    _critical_error,
    _emit_result,
    _operation_failure,
    _parse_key_value_pairs,
    _parse_set_values,
    _read_spec_json,
)
from larva.shell.cli_parser import build_cli_parser
from larva.shell.cli_commands import (
    assemble_command,
    clear_command,
    clone_command,
    component_list_command,
    component_show_command,
    delete_command,
    export_command,
    list_command,
    register_command,
    resolve_command,
    update_batch_command,
    update_command,
    validate_command,
)

PERSONA_COMMAND_SEAM = "larva.app.facade.LarvaFacade"
COMPONENT_COMMAND_SEAM = "larva.shell.components.ComponentStore"

if TYPE_CHECKING:
    from larva.app.facade import AssembleRequest


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
            ).unwrap(),
        }
    )


def _dispatch_validate(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    loaded_spec = _read_spec_json(cast("str", args.spec))
    if isinstance(loaded_spec, Failure):
        return Failure(
            _operation_failure("Validate", loaded_spec.failure(), as_json=as_json).unwrap()
        )
    return validate_command(loaded_spec.unwrap(), as_json=as_json, facade=facade)


def _build_assemble_request(
    args: argparse.Namespace,
) -> Result[AssembleRequest, JsonErrorEnvelope]:
    from larva.app.facade import AssembleRequest

    overrides = _parse_key_value_pairs(cast("list[str]", args.overrides), flag="--override")
    if isinstance(overrides, Failure):
        return Failure(overrides.failure())
    variables = _parse_key_value_pairs(cast("list[str]", args.variables), flag="--var")
    if isinstance(variables, Failure):
        return Failure(variables.failure())

    request: AssembleRequest = {
        "id": cast("str", args.id),
        "prompts": cast("list[str]", args.prompts),
        "toolsets": cast("list[str]", args.toolsets),
        "constraints": cast("list[str]", args.constraints),
        "overrides": overrides.unwrap(),
        "variables": cast("dict[str, str]", variables.unwrap()),
    }
    description = cast("str | None", args.description)
    if description is not None:
        request["description"] = description
    model = cast("str | None", args.model)
    if model is not None:
        request["model"] = model
    return Success(request)


def _dispatch_assemble(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    request_result = _build_assemble_request(args)
    if isinstance(request_result, Failure):
        return Failure(
            _operation_failure("Assemble", request_result.failure(), as_json=as_json).unwrap()
        )
    return assemble_command(
        request_result.unwrap(),
        as_json=as_json,
        facade=facade,
        output_path=cast("str | None", args.output),
    )


def _dispatch_register(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    loaded_spec = _read_spec_json(cast("str", args.spec))
    if isinstance(loaded_spec, Failure):
        return Failure(
            _operation_failure("Register", loaded_spec.failure(), as_json=as_json).unwrap()
        )
    return register_command(loaded_spec.unwrap(), as_json=as_json, facade=facade)


def _dispatch_resolve(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    overrides = _parse_key_value_pairs(cast("list[str]", args.overrides), flag="--override")
    if isinstance(overrides, Failure):
        return Failure(_operation_failure("Resolve", overrides.failure(), as_json=as_json).unwrap())
    return resolve_command(
        cast("str", args.id),
        overrides=overrides.unwrap(),
        as_json=as_json,
        facade=facade,
    )


def _dispatch_update(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    patches_result = _parse_set_values(cast("list[str]", args.set_values), flag="--set")
    if isinstance(patches_result, Failure):
        return Failure(
            _operation_failure("Update", patches_result.failure(), as_json=as_json).unwrap()
        )
    return update_command(
        cast("str", args.id),
        patches=patches_result.unwrap(),
        as_json=as_json,
        facade=facade,
    )


# @shell_complexity: validation + envelope mapping requires explicit branches
def _dispatch_update_batch(
    args: argparse.Namespace,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    where_clauses = cast("list[str]", args.where_clauses)
    set_values = cast("list[str]", args.set_values)

    # Validate non-empty where clauses
    if not where_clauses:
        error_envelope = _critical_error("update-batch requires at least one --where clause", {})
        return Failure({"exit_code": EXIT_CRITICAL, "error": error_envelope.unwrap()})

    # Validate non-empty set values
    if not set_values:
        error_envelope = _critical_error("update-batch requires at least one --set clause", {})
        return Failure({"exit_code": EXIT_CRITICAL, "error": error_envelope.unwrap()})

    # Parse where clauses
    where_result = _parse_key_value_pairs(where_clauses, flag="--where")
    if isinstance(where_result, Failure):
        return Failure(
            _operation_failure("Update-batch", where_result.failure(), as_json=as_json).unwrap()
        )

    # Parse set values with type inference
    patches_result = _parse_set_values(set_values, flag="--set")
    if isinstance(patches_result, Failure):
        return Failure(
            _operation_failure("Update-batch", patches_result.failure(), as_json=as_json).unwrap()
        )

    return update_batch_command(
        where_clauses=where_result.unwrap(),
        set_clauses=patches_result.unwrap(),
        dry_run=cast("bool", getattr(args, "dry_run", False)),
        as_json=as_json,
        facade=facade,
    )


def _dispatch(
    args: argparse.Namespace,
    *,
    facade: LarvaFacade,
    component_store: ComponentStore,
) -> Result[CliCommandResult, CliFailure]:
    command = cast("str", args.command)
    as_json = cast("bool", getattr(args, "as_json", False))

    command_dispatchers: dict[str, Callable[[], Result[CliCommandResult, CliFailure]]] = {
        "validate": lambda: _dispatch_validate(args, as_json=as_json, facade=facade),
        "assemble": lambda: _dispatch_assemble(args, as_json=as_json, facade=facade),
        "register": lambda: _dispatch_register(args, as_json=as_json, facade=facade),
        "resolve": lambda: _dispatch_resolve(args, as_json=as_json, facade=facade),
        "clone": lambda: clone_command(
            cast("str", args.source_id), cast("str", args.new_id), as_json=as_json, facade=facade
        ),
        "list": lambda: list_command(as_json=as_json, facade=facade),
        "export": lambda: export_command(
            ids=cast("list[str]", args.ids),
            export_all=cast("bool", args.export_all),
            as_json=as_json,
            facade=facade,
        ),
        "delete": lambda: delete_command(cast("str", args.id), as_json=as_json, facade=facade),
        "clear": lambda: clear_command(
            confirm=cast("str", args.confirm), as_json=as_json, facade=facade
        ),
        "update": lambda: _dispatch_update(args, as_json=as_json, facade=facade),
        "update-batch": lambda: _dispatch_update_batch(args, as_json=as_json, facade=facade),
        "component": lambda: _dispatch_component(
            args, as_json=as_json, component_store=component_store
        ),
    }
    dispatch = command_dispatchers.get(command)
    if dispatch is not None:
        return dispatch()

    return Failure(
        {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Unsupported command: {command}\n",
            "error": _critical_error("unsupported command", {"command": command}).unwrap(),
        }
    )


# @invar:allow shell_result: CLI entry handler returns process exit code
# @shell_complexity: CLI entrypoint handles parse failures and long-running server subcommands before normal dispatch.
def run_cli(
    argv: Sequence[str],
    *,
    facade: LarvaFacade,
    stdout: IO[str],
    stderr: IO[str],
    component_store: ComponentStore | None = None,
) -> "CliExitCode":
    from larva.shell.cli_helpers import CliExitCode

    parser = build_cli_parser().unwrap()
    argv_list = list(argv)
    if not argv_list:
        parser.print_help(stdout)
        return EXIT_OK
    active_component_store = (
        component_store if component_store is not None else FilesystemComponentStore()
    )
    try:
        args = parser.parse_args(argv_list)
    except _CliParseError as error:
        parse_failure: CliFailure = {
            "exit_code": EXIT_CRITICAL,
            "stderr": f"Argument parsing failed: {error}\n",
            "error": _critical_error("argument parsing failed", {"message": str(error)}).unwrap(),
        }
        return _emit_result(
            Failure(parse_failure),
            as_json="--json" in argv,
            stdout=stdout,
            stderr=stderr,
        )

    # serve is a special case — starts a long-running server, not a one-shot command
    if getattr(args, "command", None) == "serve":
        from larva.shell.web import main as web_main

        web_main(port=args.port, no_open=args.no_open)
        return 0  # type: ignore[return-value]

    # mcp is a special case — starts a long-running server, not a one-shot command
    if getattr(args, "command", None) == "mcp":
        from larva.shell.mcp_server import run_mcp_stdio

        run_mcp_stdio()
        return 0  # type: ignore[return-value]
    return _emit_result(
        _dispatch(args, facade=facade, component_store=active_component_store),
        as_json=cast("bool", getattr(args, "as_json", False)),
        stdout=stdout,
        stderr=stderr,
    )
