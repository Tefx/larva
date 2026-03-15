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


# @invar:allow shell_result: reads package metadata for CLI --version output
def _get_version() -> str:
    """Read version from package metadata."""
    try:
        from importlib.metadata import version

        return version("larva")
    except Exception:
        return "unknown"


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


# @invar:allow shell_result: type inference helper for CLI --set argument parsing
# @shell_orchestration: pure parsing logic colocated with CLI --set parsing
# @shell_complexity: type inference requires 5 branches for bool/null/int/float/str
def _infer_value_type(value: str) -> object:
    """Infer type from a string value for --set arguments.

    Infers: bool (true/false), null, number (int/float), string (fallback).
    """
    # Boolean inference
    if value.lower() == "true":
        return True
    if value.lower() == "false":
        return False
    # Null inference
    if value.lower() == "null":
        return None
    # Number inference (int first, then float)
    try:
        return int(value)
    except ValueError:
        pass
    try:
        return float(value)
    except ValueError:
        pass
    # Fallback to string
    return value


# @shell_orchestration: nested dict construction for CLI --set dot-key parsing
def _set_nested_value(data: dict[str, object], key: str, value: object) -> None:
    """Set a nested value in a dict using dot notation key.

    E.g., key="a.b.c" sets data["a"]["b"]["c"] = value, creating intermediate dicts.
    """
    parts = key.split(".")
    current: dict[str, object] = data
    for part in parts[:-1]:
        if part not in current:
            current[part] = {}
        val = current[part]
        if not isinstance(val, dict):
            # Overwrite non-dict with dict to allow nested access
            current[part] = {}
        current = cast("dict[str, object]", current[part])
    current[parts[-1]] = value


# @shell_complexity: type inference has 5 branches by design for bool/null/int/float/str
def _parse_set_values(
    raw_values: list[str], *, flag: str
) -> Result[dict[str, object], JsonErrorEnvelope]:
    """Parse --set key=value arguments with type inference and dot-key support.

    Args:
        raw_values: List of "key=value" strings
        flag: Flag name for error messages (e.g., "--set")

    Returns:
        Success with dict containing inferred values with nested structure,
        or Failure with JsonErrorEnvelope on validation errors.

    Type inference rules:
        - "true" / "false" -> bool
        - "null" -> None
        - Integer-parseable -> int
        - Float-parseable -> float
        - Otherwise -> str

    Dot-key handling:
        - "a.b.c=value" -> {"a": {"b": {"c": value}}}
        - Dots in key path create nested dict structure

    Validation errors:
        - Empty key: "key must be non-empty"
        - Missing '=': "expected key=value"
    """
    result: dict[str, object] = {}
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
        # Type inference
        inferred = _infer_value_type(value)
        # Handle dot-keys (nested structure)
        if "." in key:
            _set_nested_value(result, key, inferred)
        else:
            result[key] = inferred
    return Success(result)


def _read_spec_json(path: str) -> Result[PersonaSpec, JsonErrorEnvelope]:
    path_obj = Path(path)
    loaded_result = _load_json_file(path_obj)
    if isinstance(loaded_result, Failure):
        return Failure(loaded_result.failure())
    loaded = loaded_result.unwrap()
    if not isinstance(loaded, dict):
        return Failure(
            _critical_error("spec file root must be a JSON object", {"path": str(path_obj)})
        )
    return Success(cast("PersonaSpec", loaded))


def _load_json_file(path_obj: Path) -> Result[object, JsonErrorEnvelope]:
    try:
        with open(path_obj, encoding="utf-8") as spec_file:
            loaded = json.load(spec_file)
        return Success(loaded)
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
    parser = _CliParser(
        prog="larva",
        description="PersonaSpec toolkit — manage, validate, and assemble LLM agent personas.",
        add_help=True,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "-V",
        "--version",
        action="version",
        version=f"%(prog)s {_get_version()}",
    )
    subparsers = parser.add_subparsers(
        dest="command",
        required=True,
        title="commands",
        metavar="COMMAND",
    )

    # --- validate ---
    validate_parser = subparsers.add_parser(
        "validate",
        help="Validate a persona spec file",
        description="Parse and validate a PersonaSpec YAML/JSON file, reporting errors and warnings.",
    )
    validate_parser.add_argument("spec", metavar="SPEC", help="path to the persona spec file")
    validate_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON"
    )

    # --- assemble ---
    assemble_parser = subparsers.add_parser(
        "assemble",
        help="Assemble a persona from components",
        description="Build a complete persona by composing prompts, toolsets, constraints, and model settings.",
    )
    assemble_parser.add_argument("--id", required=True, help="persona identifier")
    assemble_parser.add_argument(
        "--prompt", dest="prompts", action="append", default=[], metavar="NAME",
        help="include a prompt component (repeatable)",
    )
    assemble_parser.add_argument(
        "--toolset", dest="toolsets", action="append", default=[], metavar="NAME",
        help="include a toolset component (repeatable)",
    )
    assemble_parser.add_argument(
        "--constraints", dest="constraints", action="append", default=[], metavar="NAME",
        help="include a constraint component (repeatable)",
    )
    assemble_parser.add_argument("--model", help="model configuration name")
    assemble_parser.add_argument(
        "--override", dest="overrides", action="append", default=[], metavar="KEY=VALUE",
        help="override a field in the assembled persona (repeatable)",
    )
    assemble_parser.add_argument(
        "--var", dest="variables", action="append", default=[], metavar="KEY=VALUE",
        help="set a template variable (repeatable)",
    )
    assemble_parser.add_argument(
        "-o", "--output", metavar="FILE", help="write assembled persona to FILE instead of stdout",
    )
    assemble_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- register ---
    register_parser = subparsers.add_parser(
        "register",
        help="Register a persona spec in the registry",
        description="Parse a PersonaSpec file and add it to the local registry for later resolution.",
    )
    register_parser.add_argument("spec", metavar="SPEC", help="path to the persona spec file")
    register_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- resolve ---
    resolve_parser = subparsers.add_parser(
        "resolve",
        help="Resolve a registered persona by ID",
        description="Look up a persona from the registry by its ID and return the full spec.",
    )
    resolve_parser.add_argument("id", metavar="ID", help="persona identifier to resolve")
    resolve_parser.add_argument(
        "--override", dest="overrides", action="append", default=[], metavar="KEY=VALUE",
        help="override a field in the resolved spec (repeatable)",
    )
    resolve_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- list ---
    list_parser = subparsers.add_parser(
        "list",
        help="List all registered personas",
        description="Show all personas currently registered in the local registry.",
    )
    list_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- component ---
    component_parser = subparsers.add_parser(
        "component",
        help="Inspect available components",
        description="Browse and inspect reusable persona components (prompts, toolsets, constraints, models).",
    )
    component_subparsers = component_parser.add_subparsers(
        dest="component_command", required=True, title="subcommands", metavar="SUBCOMMAND",
    )

    component_list_parser = component_subparsers.add_parser(
        "list", help="List all available components",
    )
    component_list_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    component_show_parser = component_subparsers.add_parser(
        "show", help="Show details of a specific component",
    )
    component_show_parser.add_argument(
        "ref", metavar="TYPE/NAME", help="component reference (e.g. prompts/base, toolsets/web)",
    )
    component_show_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- delete ---
    delete_parser = subparsers.add_parser(
        "delete",
        help="Delete a persona from the registry",
        description="Remove a single persona from the local registry by its ID.",
    )
    delete_parser.add_argument("id", metavar="ID", help="persona identifier to delete")
    delete_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- clear ---
    clear_parser = subparsers.add_parser(
        "clear",
        help="Clear all personas from the registry",
        description=(
            "Remove ALL personas from the local registry. "
            "Requires --confirm 'CLEAR REGISTRY' as a safety guard."
        ),
    )
    clear_parser.add_argument(
        "--confirm", required=True, metavar="TOKEN",
        help="safety token — must be 'CLEAR REGISTRY'",
    )
    clear_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- clone ---
    clone_parser = subparsers.add_parser(
        "clone",
        help="Clone a persona to a new ID",
        description="Copy an existing registered persona to a new ID in the registry.",
    )
    clone_parser.add_argument("source_id", metavar="SOURCE_ID", help="ID of the persona to clone")
    clone_parser.add_argument("new_id", metavar="NEW_ID", help="ID for the cloned persona")
    clone_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- export ---
    export_parser = subparsers.add_parser(
        "export",
        help="Export personas as spec files",
        description="Export one or more registered personas as PersonaSpec JSON. Use --all to export everything.",
    )
    export_parser.add_argument(
        "ids", nargs="*", default=[], metavar="ID", help="persona IDs to export",
    )
    export_parser.add_argument(
        "--all", action="store_true", dest="export_all", help="export all registered personas",
    )
    export_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- update ---
    update_parser = subparsers.add_parser(
        "update",
        help="Update fields on a registered persona",
        description="Patch one or more fields on a registered persona.",
    )
    update_parser.add_argument("id", metavar="ID", help="persona identifier to update")
    update_parser.add_argument(
        "--set", dest="set_values", action="append", default=[], metavar="KEY=VALUE",
        help="field to set (repeatable, e.g. --set model=gpt-4)",
    )
    update_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- update-batch ---
    update_batch_parser = subparsers.add_parser(
        "update-batch",
        help="Batch-update personas matching a filter",
        description="Update multiple personas at once. Use --where to filter and --set to apply changes.",
    )
    update_batch_parser.add_argument(
        "--where", dest="where_clauses", action="append", default=[], required=True,
        metavar="KEY=VALUE", help="filter condition (repeatable, e.g. --where model=gpt-3.5)",
    )
    update_batch_parser.add_argument(
        "--set", dest="set_values", action="append", default=[], required=True,
        metavar="KEY=VALUE", help="field to set on matched personas (repeatable)",
    )
    update_batch_parser.add_argument(
        "--dry-run", action="store_true", dest="dry_run",
        help="preview which personas would be updated without applying changes",
    )
    update_batch_parser.add_argument(
        "--json", action="store_true", dest="as_json", help="output result as JSON",
    )

    # --- serve ---
    serve_parser = subparsers.add_parser(
        "serve",
        help="Start the web UI server",
        description="Launch a local web interface for browsing and managing personas.",
    )
    serve_parser.add_argument(
        "--port", type=int, default=7400, help="port to listen on (default: 7400)",
    )
    serve_parser.add_argument(
        "--no-open", action="store_true", dest="no_open",
        help="don't auto-open the browser",
    )

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
