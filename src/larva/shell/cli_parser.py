"""Argparse builder for ``larva`` shell CLI."""

from __future__ import annotations

import argparse
from typing import NoReturn

from returns.result import Result, Success


class _CliParseError(Exception):
    pass


class _CliParser(argparse.ArgumentParser):
    def error(self, message: str) -> NoReturn:
        raise _CliParseError(message)


def _get_version() -> Result[str, object]:
    """Read version from package metadata."""
    try:
        from importlib.metadata import version

        return Success(version("larva"))
    except Exception:
        return Success("unknown")


def _add_json_flag(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--json", action="store_true", dest="as_json", help="output result as JSON")


# @shell_orchestration: helper keeps update-batch parser wiring inside the shell transport layer
def _add_update_batch_arguments(parser: _CliParser) -> None:
    parser.add_argument(
        "--where",
        dest="where_clauses",
        action="append",
        default=[],
        required=True,
        metavar="KEY=VALUE",
        help=(
            "canonical filter condition (repeatable, e.g. --where model=gpt-4o-mini; "
            "legacy roots like tools.* are rejected)"
        ),
    )
    parser.add_argument(
        "--set",
        dest="set_values",
        action="append",
        default=[],
        required=True,
        metavar="KEY=VALUE",
        help="field to set on matched personas (repeatable)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        dest="dry_run",
        help="preview which personas would be updated without applying changes",
    )


# @shell_orchestration: groups argparse command wiring into focused sections
def _add_persona_read_commands(
    subparsers: argparse._SubParsersAction[_CliParser],
) -> None:
    validate_parser = subparsers.add_parser(
        "validate",
        help="Validate a persona spec file",
        description="Parse and validate a PersonaSpec YAML/JSON file, reporting errors and warnings.",
    )
    validate_parser.add_argument("spec", metavar="SPEC", help="path to the persona spec file")
    _add_json_flag(validate_parser)

    register_parser = subparsers.add_parser(
        "register",
        help="Register a persona spec in the registry",
        description="Parse a PersonaSpec file and add it to the local registry for later resolution.",
    )
    register_parser.add_argument("spec", metavar="SPEC", help="path to the persona spec file")
    register_parser.add_argument("--variant", help="registry-local variant name")
    _add_json_flag(register_parser)

    resolve_parser = subparsers.add_parser(
        "resolve",
        help="Resolve a registered persona by ID",
        description="Look up a persona from the registry by its ID and return the full spec.",
    )
    resolve_parser.add_argument("id", metavar="ID", help="persona identifier to resolve")
    resolve_parser.add_argument("--variant", help="registry-local variant name")
    resolve_parser.add_argument(
        "--override",
        dest="overrides",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="override a field in the resolved spec (repeatable)",
    )
    _add_json_flag(resolve_parser)

    list_parser = subparsers.add_parser(
        "list",
        help="List all registered personas",
        description="Show all personas currently registered in the local registry.",
    )
    _add_json_flag(list_parser)


# @shell_orchestration: groups argparse command wiring into focused sections
def _add_variant_commands(
    subparsers: argparse._SubParsersAction[_CliParser],
) -> None:
    variant_parser = subparsers.add_parser(
        "variant",
        help="Manage registry-local persona variants",
        description="List, activate, or delete registry-local variants for a base persona id.",
    )
    variant_subparsers = variant_parser.add_subparsers(
        dest="variant_command",
        required=True,
        title="subcommands",
        metavar="SUBCOMMAND",
    )

    variant_list_parser = variant_subparsers.add_parser("list", help="List variants for a persona")
    variant_list_parser.add_argument("id", metavar="ID", help="base persona id")
    _add_json_flag(variant_list_parser)

    variant_activate_parser = variant_subparsers.add_parser("activate", help="Activate a variant")
    variant_activate_parser.add_argument("id", metavar="ID", help="base persona id")
    variant_activate_parser.add_argument("variant", metavar="VARIANT", help="variant name")
    _add_json_flag(variant_activate_parser)

    variant_delete_parser = variant_subparsers.add_parser("delete", help="Delete an inactive variant")
    variant_delete_parser.add_argument("id", metavar="ID", help="base persona id")
    variant_delete_parser.add_argument("variant", metavar="VARIANT", help="variant name")
    _add_json_flag(variant_delete_parser)


# @shell_orchestration: groups argparse command wiring into focused sections
def _add_registry_commands(subparsers: argparse._SubParsersAction[_CliParser]) -> None:
    delete_parser = subparsers.add_parser(
        "delete",
        help="Delete a persona from the registry",
        description="Remove a single persona from the local registry by its ID.",
    )
    delete_parser.add_argument("id", metavar="ID", help="persona identifier to delete")
    _add_json_flag(delete_parser)

    clear_parser = subparsers.add_parser(
        "clear",
        help="Clear all personas from the registry",
        description=(
            "Remove ALL personas from the local registry. "
            "Requires --confirm 'CLEAR REGISTRY' as a safety guard."
        ),
    )
    clear_parser.add_argument(
        "--confirm",
        required=True,
        metavar="TOKEN",
        help="safety token — must be 'CLEAR REGISTRY'",
    )
    _add_json_flag(clear_parser)

    clone_parser = subparsers.add_parser(
        "clone",
        help="Clone a persona to a new ID",
        description="Copy an existing registered persona to a new ID in the registry.",
    )
    clone_parser.add_argument("source_id", metavar="SOURCE_ID", help="ID of the persona to clone")
    clone_parser.add_argument("new_id", metavar="NEW_ID", help="ID for the cloned persona")
    _add_json_flag(clone_parser)

    export_parser = subparsers.add_parser(
        "export",
        help="Export personas as spec files",
        description="Export one or more registered personas as PersonaSpec JSON. Use --all to export everything.",
    )
    export_parser.add_argument(
        "ids", nargs="*", default=[], metavar="ID", help="persona IDs to export"
    )
    export_parser.add_argument(
        "--all",
        action="store_true",
        dest="export_all",
        help="export all registered personas",
    )
    _add_json_flag(export_parser)

    update_parser = subparsers.add_parser(
        "update",
        help="Update fields on a registered persona",
        description="Patch one or more fields on a registered persona.",
    )
    update_parser.add_argument("id", metavar="ID", help="persona identifier to update")
    update_parser.add_argument("--variant", help="registry-local variant name")
    update_parser.add_argument(
        "--set",
        dest="set_values",
        action="append",
        default=[],
        metavar="KEY=VALUE",
        help="field to set (repeatable, e.g. --set model=gpt-4)",
    )
    _add_json_flag(update_parser)

    update_batch_parser = subparsers.add_parser(
        "update-batch",
        help="Batch-update personas matching a filter",
        description=(
            "Update multiple personas at once. Use --where with canonical PersonaSpec "
            "fields only, and use --set to apply changes."
        ),
    )
    _add_update_batch_arguments(update_batch_parser)
    _add_json_flag(update_batch_parser)


# @shell_orchestration: groups argparse command wiring into focused sections
def _add_server_commands(subparsers: argparse._SubParsersAction[_CliParser]) -> None:
    serve_parser = subparsers.add_parser(
        "serve",
        help="Start the web UI server",
        description="Launch a local web interface for browsing and managing personas.",
    )
    serve_parser.add_argument(
        "--port",
        type=int,
        default=7400,
        help="port to listen on (default: 7400)",
    )
    serve_parser.add_argument(
        "--no-open",
        action="store_true",
        dest="no_open",
        help="don't auto-open the browser",
    )
    subparsers.add_parser(
        "mcp",
        help="Start the MCP server (stdio transport)",
        description="Launch larva as an MCP server communicating over stdio.",
    )

    # doctor command
    doctor_parser = subparsers.add_parser(
        "doctor",
        help="Run diagnostics for larva subsystems",
        description=(
            "Run read-only diagnostics on the persona registry using the same "
            "facade-backed canonical validation path as list/serve."
        ),
    )
    _add_json_flag(doctor_parser)


# @shell_orchestration: parser wiring for the OpenCode pass-through launcher
def _add_opencode_command(subparsers: argparse._SubParsersAction[_CliParser]) -> None:
    opencode_parser = subparsers.add_parser(
        "opencode",
        help="Launch OpenCode with larva personas as agents",
        description=(
            "Build a dynamic OpenCode config from the larva registry, inject the "
            "larva OpenCode plugin, then exec the opencode CLI. Use '--' before "
            "OpenCode arguments when you want an explicit separator."
        ),
    )
    opencode_parser.add_argument(
        "opencode_args",
        nargs=argparse.REMAINDER,
        metavar="OPENCODE_ARG",
        help="arguments forwarded verbatim to opencode",
    )


# @shell_orchestration: parser composition only wires command definitions and flags
def build_cli_parser() -> Result[_CliParser, object]:
    parser = _CliParser(
        prog="larva",
        description="PersonaSpec toolkit — manage, validate, and resolve LLM agent personas.",
        add_help=True,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-V",
        "--version",
        action="version",
        version=f"%(prog)s {_get_version().unwrap()}",
    )
    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
        title="commands",
        metavar="COMMAND",
    )
    _add_persona_read_commands(subparsers)
    _add_variant_commands(subparsers)
    _add_registry_commands(subparsers)
    _add_server_commands(subparsers)
    _add_opencode_command(subparsers)
    return Success(parser)


__all__ = ["_CliParseError", "_CliParser", "build_cli_parser"]
