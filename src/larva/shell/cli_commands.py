"""CLI command implementations for persona management.

This module contains the concrete implementations of CLI commands,
decoupled from argument parsing and dispatch logic.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.app.facade import (
    BatchUpdateResult,
    ClearedRegistry,
    DeletedPersona,
    LarvaFacade,
)
from larva.shell.cli_helpers import (
    EXIT_CRITICAL,
    EXIT_ERROR,
    EXIT_OK,
    CliCommandResult,
    CliFailure,
    JsonErrorEnvelope,
    _critical_error,
    _map_facade_error,
    _render_payload_for_text,
    _write_output_json,
    render_validation_report_text,
)
from larva.shell.components import ComponentStore
from larva.shell.registry import CLEAR_CONFIRMATION_TOKEN
from larva.shell.shared.component_queries import query_component

if TYPE_CHECKING:
    from larva.core.spec import PersonaSpec
    from larva.core.validate import ValidationReport
    from larva.app.facade import AssembleRequest
    from larva.shell.cli_helpers import CliExitCode


def _validation_success_result(
    report: "ValidationReport", *, as_json: bool
) -> Result[CliCommandResult, CliFailure]:
    result: CliCommandResult = {
        "exit_code": EXIT_OK,
        "stdout": render_validation_report_text(report).unwrap(),
    }
    if as_json:
        result["json"] = {
            "data": {
                "valid": True,
                "errors": [],
                "warnings": cast("list[str]", report.get("warnings", [])),
            }
        }
    return Success(result)


def _validation_failure_result(
    report: "ValidationReport", *, as_json: bool
) -> Result[CliCommandResult, CliFailure]:
    errors = cast("list[dict[str, object]]", report.get("errors", []))
    message = "validation failed"
    if errors:
        message = cast("str", errors[0].get("message", message))
    error_envelope = _map_facade_error(
        {
            "code": "PERSONA_INVALID",
            "numeric_code": 101,
            "message": message,
            "details": {"report": report},
        }
    ).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Validation failed: {error_envelope['message']}\n"
    return Failure(failure)


def validate_command(
    spec: "PersonaSpec",
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Validate a persona spec."""
    report = facade.validate(spec)
    if report["valid"]:
        return _validation_success_result(report, as_json=as_json)
    return _validation_failure_result(report, as_json=as_json)


# @shell_complexity: shell boundary coordinates optional file output and dual text/json projections.
def _assemble_success_result(
    payload: dict[str, object],
    *,
    as_json: bool,
    output_path: str | None,
) -> Result[CliCommandResult, CliFailure]:
    if output_path is not None:
        write_result = _write_output_json(output_path, payload)
        if isinstance(write_result, Failure):
            return _assemble_failure_result(
                write_result.failure(),
                exit_code=EXIT_ERROR,
                as_json=as_json,
            )

    cli_result: CliCommandResult = {
        "exit_code": EXIT_OK,
        "stdout": ""
        if output_path is not None
        else _render_payload_for_text("assemble", payload).unwrap(),
    }
    if as_json:
        cli_result["json"] = {"data": payload}
    return Success(cli_result)


def _assemble_failure_result(
    error_envelope: JsonErrorEnvelope,
    *,
    exit_code: "CliExitCode",
    as_json: bool,
) -> Result[CliCommandResult, CliFailure]:
    failure: CliFailure = {"exit_code": exit_code, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Assembly failed: {error_envelope['message']}\n"
    return Failure(failure)


def assemble_command(
    request: "AssembleRequest",
    *,
    as_json: bool,
    facade: LarvaFacade,
    output_path: str | None = None,
) -> Result[CliCommandResult, CliFailure]:
    """Assemble a persona from components."""
    result = facade.assemble(request)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        return _assemble_success_result(
            payload,
            as_json=as_json,
            output_path=output_path,
        )

    error_envelope = _map_facade_error(result.failure()).unwrap()
    return _assemble_failure_result(error_envelope, exit_code=EXIT_ERROR, as_json=as_json)


def register_command(
    spec: "PersonaSpec",
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Register a persona spec."""
    result = facade.register(spec)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("register", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
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
    """Resolve a persona by ID."""
    result = facade.resolve(persona_id, overrides=overrides)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("resolve", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Resolve failed: {error_envelope['message']}\n"
    return Failure(failure)


def list_command(*, as_json: bool, facade: LarvaFacade) -> Result[CliCommandResult, CliFailure]:
    """List all registered personas."""
    result = facade.list()
    if isinstance(result, Success):
        payload = list(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("list", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"List failed: {error_envelope['message']}\n"
    return Failure(failure)


def clone_command(
    source_id: str,
    new_id: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Clone a persona to a new ID."""
    result = facade.clone(source_id, new_id)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("clone", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Clone failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: text output renders specs as pretty JSON separated by ---
def export_command(
    ids: list[str],
    *,
    export_all: bool,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Export personas by IDs or all."""
    # Validate mutual exclusion: --all xor ids
    if export_all and ids:
        error_envelope: JsonErrorEnvelope = {
            "code": "ARGUMENT_CONFLICT",
            "numeric_code": 113,
            "message": "Cannot specify both --all and persona ids",
            "details": {},
        }
        failure: CliFailure = {"exit_code": EXIT_CRITICAL, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Export failed: {error_envelope['message']}\n"
        return Failure(failure)

    result = facade.export_all() if export_all else facade.export_ids(ids)
    if isinstance(result, Success):
        specs = list(result.unwrap())

        # Text mode: pretty JSON for each spec, separated by ---
        text_output = ""
        if specs:
            text_parts = [
                json.dumps(spec, indent=2, sort_keys=True, ensure_ascii=True) for spec in specs
            ]
            text_output = "\n---\n".join(text_parts) + "\n"

        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": text_output,
        }
        if as_json:
            cli_result["json"] = {"data": specs}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Export failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: command-level envelope mapping requires explicit text/json branches
def delete_command(
    persona_id: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Delete a persona by ID."""
    result = facade.delete(persona_id)
    if isinstance(result, Success):
        payload: DeletedPersona = result.unwrap()
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("delete", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
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
    """Clear all personas (requires confirmation token)."""
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
            "stdout": _render_payload_for_text("clear", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Clear failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: command-level envelope mapping requires explicit text/json branches
def update_command(
    persona_id: str,
    *,
    patches: dict[str, object],
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Update a persona with patches."""
    result = facade.update(persona_id, patches=patches)
    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("update", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Update failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: batch update requires matched/updated count + per-item result lines
def update_batch_command(
    where_clauses: dict[str, object],
    set_clauses: dict[str, object],
    *,
    dry_run: bool,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Update multiple personas matching where_clauses with set_clauses."""
    result = facade.update_batch(where_clauses, set_clauses, dry_run=dry_run)
    if isinstance(result, Success):
        payload: BatchUpdateResult = result.unwrap()
        # Text output: "Matched: N, Updated: N" + one line per result "  id: updated"
        matched = payload["matched"]
        updated = payload["updated"]
        items = payload["items"]
        text_lines = [f"Matched: {matched}, Updated: {updated}"]
        for item in items:
            text_lines.append(f"  {item['id']}: {item['updated']}")
        text_output = "\n".join(text_lines) + "\n"
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": text_output,
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Update-batch failed: {error_envelope['message']}\n"
    return Failure(failure)


# @shell_complexity: command-level envelope mapping requires explicit text/json branches
def component_list_command(
    *, as_json: bool, component_store: ComponentStore
) -> Result[CliCommandResult, CliFailure]:
    """List available components."""
    from larva.shell.cli_helpers import _map_component_error

    try:
        result = component_store.list_components()
    except Exception as error:
        error_envelope, exit_code = _map_component_error(error).unwrap()
        failure: CliFailure = {"exit_code": exit_code, "error": error_envelope}
        if not as_json:
            failure["stderr"] = f"Component list failed: {error_envelope['message']}\n"
        return Failure(failure)

    if isinstance(result, Success):
        payload = dict(result.unwrap())
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("component list", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)

    error_envelope, exit_code = _map_component_error(result.failure()).unwrap()
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
    """Show a specific component by ref (type/name)."""
    from larva.shell.cli_helpers import (
        _component_show_invalid_target,
        _map_component_error,
        cli_exit_code_for_error,
    )

    component_type, separator, component_name = component_ref.partition("/")
    if separator == "" or component_type == "" or component_name == "":
        failure = _component_show_invalid_target(component_ref).unwrap()
        if not as_json:
            error_envelope = failure.get("error", _critical_error("unknown error").unwrap())
            failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
        return Failure(failure)

    query_result = query_component(
        component_store,
        component_type=component_type,
        component_name=component_name,
        operation="cli.component_show",
    )
    if isinstance(query_result, Failure):
        error_envelope = query_result.failure()
        failure: CliFailure = {
            "exit_code": cli_exit_code_for_error(error_envelope),
            "error": error_envelope,
        }
        if not as_json:
            failure["stderr"] = f"Component show failed: {error_envelope['message']}\n"
        return Failure(failure)

    payload = cast("dict[str, object]", dict(query_result.unwrap()))

    cli_result: CliCommandResult = {
        "exit_code": EXIT_OK,
        "stdout": _render_payload_for_text("component show", payload).unwrap(),
    }
    if as_json:
        cli_result["json"] = {"data": payload}
    return Success(cli_result)


# @shell_complexity: branching is driven by diagnostic outcome (probe results), not business logic
def doctor_registry_command(*, as_json: bool) -> Result[CliCommandResult, CliFailure]:
    """Run read-only diagnostics on the registry.

    Validates registry list/read paths without mutating any data.
    Returns diagnostics about index integrity, spec file accessibility,
    and canonical boundary compliance.
    """
    from larva.shell.registry import (
        INDEX_FILENAME,
        FileSystemRegistryStore,
    )

    diagnostics: list[str] = []
    issues: list[str] = []

    # Probe index read
    fs_store = FileSystemRegistryStore()
    index_result = fs_store._read_index()

    if isinstance(index_result, Failure):
        index_diagnostic = f"  [FAIL] Cannot read registry index: {index_result.failure()}"
        issues.append(index_diagnostic)
        diagnostics.append(index_diagnostic)
    else:
        index = index_result.unwrap()
        index_diagnostic = f"  [OK] Registry index read succeeded ({len(index)} entries)"
        diagnostics.append(index_diagnostic)

        if index:
            # Probe a sample of spec reads
            sample_ids = sorted(index.keys())[:3]
            for persona_id in sample_ids:
                spec_result = fs_store._read_spec(persona_id, index.get(persona_id))
                if isinstance(spec_result, Failure):
                    spec_diagnostic = (
                        f"  [FAIL] Spec read failed for '{persona_id}': {spec_result.failure()}"
                    )
                    issues.append(spec_diagnostic)
                    diagnostics.append(spec_diagnostic)
                else:
                    spec_diagnostic = f"  [OK] Spec read succeeded for '{persona_id}'"
                    diagnostics.append(spec_diagnostic)

            # Check for forbidden field violations in sample
            for persona_id in sample_ids:
                spec_result = fs_store._read_spec(persona_id, index.get(persona_id))
                if isinstance(spec_result, Success):
                    spec = spec_result.unwrap()
                    forbidden = [fld for fld in ("tools", "side_effect_policy") if fld in spec]
                    if forbidden:
                        field_diagnostic = f"  [WARN] Spec '{persona_id}' contains forbidden legacy fields: {forbidden}"
                        diagnostics.append(field_diagnostic)

    # Registry root location
    diagnostics.append(f"  [INFO] Registry root: {fs_store.root}")
    index_path = fs_store.root / INDEX_FILENAME
    diagnostics.append(f"  [INFO] Index path: {index_path}")

    # Command succeeds; exit code reflects diagnostic outcome
    # (no mutations, so no hard-cut failure semantics apply)
    if issues:
        status = "DIAGNOSTIC FAIL"
        stdout_lines = [status, *diagnostics, ""]
        failure: CliFailure = {
            "exit_code": EXIT_ERROR,
            "stderr": "\n".join(stdout_lines),
            "error": {
                "code": "REGISTRY_DIAGNOSTIC_FAILED",
                "numeric_code": 107,
                "message": "registry diagnostic found issues",
                "details": {"issues": issues},
            },
        }
        return Failure(failure)

    status = "DIAGNOSTIC OK"
    stdout_lines = [status, *diagnostics, ""]
    cli_result: CliCommandResult = {
        "exit_code": EXIT_OK,
        "stdout": "\n".join(stdout_lines) + "\n",
    }
    if as_json:
        cli_result["json"] = {"data": {"status": "ok", "diagnostics": diagnostics}}

    return Success(cli_result)
