"""Shared helper contracts for ``larva.shell.cli``."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, TypedDict, cast

from returns.result import Failure, Result, Success

from larva.core.spec import PersonaSpec
from larva.shell.cli_parser import _CliParseError, _CliParser
from larva.shell.cli_entry_compat import _build_parser
from larva.shell.cli_error_compat import _critical_error
from larva.shell.cli_facade_compat import build_default_facade
from larva.shell.cli_failure_compat import _operation_failure

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


from larva.shell.cli_runtime import (  # noqa: E402
    _component_show_invalid_target,
    _emit_result,
    _infer_value_type,
    _map_component_error,
    _map_facade_error,
    _render_payload_for_text,
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
        inferred = _infer_value_type(value).unwrap()
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
