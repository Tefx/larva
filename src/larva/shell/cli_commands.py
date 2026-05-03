"""CLI command implementations for persona management.

This module contains the concrete implementations of CLI commands,
decoupled from argument parsing and dispatch logic.
"""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, cast

from returns.result import Failure, Result, Success

from larva.shell.cli_doctor import doctor_registry_command as doctor_registry_command
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
    render_validation_report_text,
)
from larva.shell.registry import CLEAR_CONFIRMATION_TOKEN

if TYPE_CHECKING:
    from larva.app.facade_types import (
        BatchUpdateResult,
        ClearedRegistry,
        DeletedPersona,
        DeletedVariant,
        LarvaFacade,
        VariantMetadata,
    )
    from larva.core.spec import PersonaSpec
    from larva.core.validation_contract import ValidationReport


def _validation_success_result(
    report: ValidationReport, *, as_json: bool
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
                "warnings": report.get("warnings", []),
            }
        }
    return Success(result)


def _validation_failure_result(
    report: ValidationReport, *, as_json: bool
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
    spec: PersonaSpec,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Validate a persona spec."""
    report = facade.validate(spec)
    if report["valid"]:
        return _validation_success_result(report, as_json=as_json)
    return _validation_failure_result(report, as_json=as_json)


def register_command(
    spec: PersonaSpec,
    *,
    as_json: bool,
    facade: LarvaFacade,
    variant: str | None = None,
) -> Result[CliCommandResult, CliFailure]:
    """Register a persona spec."""
    result = facade.register(spec) if variant is None else facade.register(spec, variant=variant)
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
    variant: str | None = None,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Resolve a persona by ID."""
    result = (
        facade.resolve(persona_id, overrides=overrides)
        if variant is None
        else facade.resolve(persona_id, overrides=overrides, variant=variant)
    )
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
    mapped_failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        mapped_failure["stderr"] = f"Export failed: {error_envelope['message']}\n"
    return Failure(mapped_failure)


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
    mapped_failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        mapped_failure["stderr"] = f"Clear failed: {error_envelope['message']}\n"
    return Failure(mapped_failure)


# @shell_complexity: command-level envelope mapping requires explicit text/json branches
def update_command(
    persona_id: str,
    *,
    patches: dict[str, object],
    variant: str | None = None,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Update a persona with patches."""
    result = (
        facade.update(persona_id, patches=patches)
        if variant is None
        else facade.update(persona_id, patches=patches, variant=variant)
    )
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


def variant_list_command(
    persona_id: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """List registry-local variants for a base persona id."""
    result = facade.variant_list(persona_id)
    if isinstance(result, Success):
        payload: VariantMetadata = result.unwrap()
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("variant list", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)
    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Variant list failed: {error_envelope['message']}\n"
    return Failure(failure)


def variant_activate_command(
    persona_id: str,
    variant: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Activate a registry-local variant."""
    result = facade.variant_activate(persona_id, variant)
    if isinstance(result, Success):
        payload: ActivatedVariant = result.unwrap()
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("variant activate", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)
    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Variant activate failed: {error_envelope['message']}\n"
    return Failure(failure)


def variant_delete_command(
    persona_id: str,
    variant: str,
    *,
    as_json: bool,
    facade: LarvaFacade,
) -> Result[CliCommandResult, CliFailure]:
    """Delete an inactive, non-last registry-local variant."""
    result = facade.variant_delete(persona_id, variant)
    if isinstance(result, Success):
        payload: DeletedVariant = result.unwrap()
        cli_result: CliCommandResult = {
            "exit_code": EXIT_OK,
            "stdout": _render_payload_for_text("variant delete", payload).unwrap(),
        }
        if as_json:
            cli_result["json"] = {"data": payload}
        return Success(cli_result)
    error_envelope = _map_facade_error(result.failure()).unwrap()
    failure: CliFailure = {"exit_code": EXIT_ERROR, "error": error_envelope}
    if not as_json:
        failure["stderr"] = f"Variant delete failed: {error_envelope['message']}\n"
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
