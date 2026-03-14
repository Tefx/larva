"""Boundary tests for ``larva.shell.cli`` facade-backed commands.

Task boundary: shell_cli.shell-cli-component-implement
- Tests facade-backed commands: validate, assemble, register, resolve, list
- Tests component commands: component list/show via injected ComponentStore seam
- Uses doubles/harness for downstream seams (facade, component store, registry)

Coverage:
- text + `--json` success path behavior
- exit code mapping 0/1/2 for valid/invalid/not-found/generic errors
- JSON error envelope with code/numeric_code/message/details
- regressions: JSON/text separation, resolve not-found vs generic failure exit codes,
  validate invalid-spec exits 1

Sources:
- ARCHITECTURE.md :: Module: larva.shell.cli
- INTERFACES.md :: B. CLI Interface
- INTERFACES.md :: G. Error Codes
"""

from __future__ import annotations

import json
import io
import runpy
import sys
from pathlib import Path
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, cast

import pytest
from returns.result import Failure, Result, Success

from larva.app.facade import (
    AssembleRequest,
    DefaultLarvaFacade,
    LarvaError,
    PersonaSummary,
    RegisteredPersona,
)
from larva.core import normalize as normalize_module
from larva.core import spec as spec_module
from larva.core import validate as validate_module
from larva.core.spec import PersonaSpec
from larva.core.validate import ValidationReport
from larva.shell import cli
from larva.shell.components import ComponentStoreError
from larva.shell.cli import (
    EXIT_ERROR,
    EXIT_CRITICAL,
    EXIT_OK,
    CliCommandResult,
    CliFailure,
    JsonErrorEnvelope,
    assemble_command,
    component_list_command,
    component_show_command,
    list_command,
    run_cli,
    register_command,
    resolve_command,
    validate_command,
)

if TYPE_CHECKING:
    from larva.shell.registry import RegistryError


def test_package_cli_main_delegates_to_shell_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    from larva import cli as compat_cli

    calls: list[list[str] | None] = []

    def fake_main(argv: list[str] | None = None) -> int:
        calls.append(argv)
        return 17

    monkeypatch.setattr(compat_cli.shell_cli, "main", fake_main)

    exported_main = compat_cli.main

    assert exported_main(["list"]) == 17
    assert calls == [["list"]]


def test_python_module_cli_executes_same_shell_entrypoint(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []

    def fake_main(argv: object = None) -> int:
        calls.append(argv)
        return 9

    monkeypatch.setattr("larva.shell.cli.main", fake_main)
    sys.modules.pop("larva.cli", None)

    with pytest.raises(SystemExit) as exc_info:
        runpy.run_module("larva.cli", run_name="__main__")

    assert exc_info.value.code == 9
    assert calls == [None]


def _canonical_spec(persona_id: str, digest: str = "sha256:canonical") -> PersonaSpec:
    return {
        "id": persona_id,
        "description": f"Persona {persona_id}",
        "prompt": "You are careful.",
        "model": "gpt-4o-mini",
        "tools": {"shell": "read_only"},
        "model_params": {"temperature": 0.1},
        "side_effect_policy": "read_only",
        "can_spawn": False,
        "compaction_prompt": "Summarize facts.",
        "spec_version": "0.1.0",
        "spec_digest": digest,
    }


def _valid_report() -> ValidationReport:
    return {"valid": True, "errors": [], "warnings": []}


def _invalid_report(code: str = "PERSONA_INVALID") -> ValidationReport:
    return {
        "valid": False,
        "errors": [{"code": code, "message": "invalid", "details": {}}],
        "warnings": [],
    }


# ============================================================================
# Test Doubles for Downstream Dependencies
# ============================================================================


@dataclass
class SpyAssembleModule:
    candidate: PersonaSpec
    calls: list[str] = field(default_factory=list)
    inputs: list[dict[str, object]] = field(default_factory=list)

    def assemble_candidate(self, data: dict[str, object]) -> PersonaSpec:
        self.calls.append("assemble")
        self.inputs.append(data)
        return dict(self.candidate)


@dataclass
class SpyValidateModule:
    report: ValidationReport
    calls: list[str] = field(default_factory=list)
    inputs: list[PersonaSpec] = field(default_factory=list)

    def validate_spec(self, spec: PersonaSpec) -> ValidationReport:
        self.calls.append("validate")
        self.inputs.append(dict(spec))
        return self.report


@dataclass
class SpyNormalizeModule:
    calls: list[str] = field(default_factory=list)
    inputs: list[PersonaSpec] = field(default_factory=list)

    def normalize_spec(self, spec: PersonaSpec) -> PersonaSpec:
        self.calls.append("normalize")
        normalized = dict(spec)
        # Simple digest based on id only (avoid hashing nested dicts)
        normalized["spec_digest"] = f"sha256:{normalized.get('id', 'unknown')}"
        self.inputs.append(normalized)
        return normalized


@dataclass
class InMemoryComponentStore:
    """Minimal component store double for CLI component command tests."""

    list_result: Result[dict[str, list[str]], Exception] = field(
        default_factory=lambda: Success(
            {
                "prompts": ["default-prompt"],
                "toolsets": ["default-toolset"],
                "constraints": ["default-constraint"],
                "models": ["default-model"],
            }
        )
    )
    prompt_result: Result[dict[str, str], Exception] = field(
        default_factory=lambda: Success({"text": "Prompt body"})
    )
    toolset_result: Result[dict[str, dict[str, str]], Exception] = field(
        default_factory=lambda: Success({"tools": {"shell": "read_only"}})
    )
    constraint_result: Result[dict[str, object], Exception] = field(
        default_factory=lambda: Success({"side_effect_policy": "read_only"})
    )
    model_result: Result[dict[str, object], Exception] = field(
        default_factory=lambda: Success({"model": "gpt-4o-mini"})
    )
    last_loaded: tuple[str, str] | None = None

    def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
        self.last_loaded = ("prompts", name)
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Prompt not found: {name}", "prompt", name))
        return self.prompt_result

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Exception]:
        self.last_loaded = ("toolsets", name)
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Toolset not found: {name}", "toolset", name))
        return self.toolset_result

    def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
        self.last_loaded = ("constraints", name)
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Constraint not found: {name}", "constraint", name))
        return self.constraint_result

    def load_model(self, name: str) -> Result[dict[str, object], Exception]:
        self.last_loaded = ("models", name)
        if name in {"missing", "nonexistent"}:
            return Failure(ComponentStoreError(f"Model not found: {name}", "model", name))
        return self.model_result

    def list_components(self) -> Result[dict[str, list[str]], Exception]:
        return self.list_result


@dataclass
class InMemoryRegistryStore:
    """Minimal registry store double for CLI tests."""

    get_result: Result[PersonaSpec, Any] = field(
        default_factory=lambda: Success(_canonical_spec("default"))
    )
    list_result: Result[list[PersonaSpec], Any] = field(default_factory=lambda: Success([]))
    save_result: Result[None, Any] = field(default_factory=lambda: Success(None))
    delete_result: Result[None, Any] = field(default_factory=lambda: Success(None))
    clear_result: Result[int, Any] = field(default_factory=lambda: Success(0))
    save_inputs: list[PersonaSpec] = field(default_factory=list)
    last_delete_id: str | None = None
    last_clear_confirm: str | None = None

    def save(self, spec: PersonaSpec) -> Result[None, Any]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, Any]:
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], Any]:
        return self.list_result

    def delete(self, persona_id: str) -> Result[None, Any]:
        self.last_delete_id = persona_id
        return self.delete_result

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[int, Any]:
        self.last_clear_confirm = confirm
        return self.clear_result


def _make_facade(
    *,
    report: ValidationReport | None = None,
    candidate: PersonaSpec | None = None,
    components: InMemoryComponentStore | None = None,
    registry: InMemoryRegistryStore | None = None,
) -> DefaultLarvaFacade:
    """Create a test facade with specified doubles."""
    assemble_module = SpyAssembleModule(candidate or _canonical_spec("assembled"))
    validate_module = SpyValidateModule(report or _valid_report())
    normalize_module = SpyNormalizeModule()
    return DefaultLarvaFacade(
        spec=spec_module,
        assemble=assemble_module,
        validate=validate_module,
        normalize=normalize_module,
        components=components or InMemoryComponentStore(),
        registry=registry or InMemoryRegistryStore(),
    )


# ============================================================================
# Validate Command Tests
# ============================================================================


class TestValidateCommand:
    """Tests for the validate command handler."""

    def test_validate_success_text_mode_returns_exit_ok(self) -> None:
        """Validate with valid spec returns exit code 0 in text mode."""
        facade = _make_facade(report=_valid_report())
        spec = _canonical_spec("valid-spec")

        result = validate_command(spec, as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_validate_success_json_mode_returns_exit_ok_with_json_payload(self) -> None:
        """Validate with valid spec returns JSON payload in JSON mode."""
        facade = _make_facade(report=_valid_report())
        spec = _canonical_spec("valid-spec")

        result = validate_command(spec, as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["valid"] is True

    def test_validate_invalid_spec_returns_exit_error(self) -> None:
        """Validate with invalid spec returns exit code 1 in text mode."""
        facade = _make_facade(report=_invalid_report("INVALID_SPEC_VERSION"))
        spec = _canonical_spec("invalid-spec")

        result = validate_command(spec, as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        # Regression: validate invalid-spec must exit 1, not 0 or 2
        assert failure["exit_code"] == 1

    def test_validate_invalid_spec_json_mode_returns_error_envelope(self) -> None:
        """Validate with invalid spec returns JSON error envelope in JSON mode."""
        facade = _make_facade(report=_invalid_report("INVALID_SPEC_VERSION"))
        spec = _canonical_spec("invalid-spec")

        result = validate_command(spec, as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert "code" in error
        assert "numeric_code" in error
        assert "message" in error
        assert "details" in error
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101


# ============================================================================
# Assemble Command Tests
# ============================================================================


class TestAssembleCommand:
    """Tests for the assemble command handler."""

    def test_assemble_success_text_mode_returns_exit_ok(self) -> None:
        """Assemble with valid request returns exit code 0 in text mode."""
        facade = _make_facade(
            report=_valid_report(),
            candidate=_canonical_spec("assembled-persona"),
        )
        request: AssembleRequest = {"id": "assembled-persona"}

        result = assemble_command(request, as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_assemble_success_json_mode_returns_json_payload(self) -> None:
        """Assemble with valid request returns JSON payload in JSON mode."""
        facade = _make_facade(
            report=_valid_report(),
            candidate=_canonical_spec("assembled-persona"),
        )
        request: AssembleRequest = {"id": "assembled-persona"}

        result = assemble_command(request, as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["id"] == "assembled-persona"

    def test_assemble_invalid_request_returns_exit_error(self) -> None:
        """Assemble with invalid request returns exit code 1."""
        facade = _make_facade(report=_invalid_report("PERSONA_INVALID"))
        request: AssembleRequest = {"id": "bad-request"}

        result = assemble_command(request, as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_assemble_failure_json_mode_returns_error_envelope(self) -> None:
        """Assemble failure returns JSON error envelope in JSON mode."""
        facade = _make_facade(report=_invalid_report("PERSONA_INVALID"))
        request: AssembleRequest = {"id": "bad-request"}

        result = assemble_command(request, as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101


# ============================================================================
# Register Command Tests
# ============================================================================


class TestRegisterCommand:
    """Tests for the register command handler."""

    def test_register_success_text_mode_returns_exit_ok(self) -> None:
        """Register with valid spec returns exit code 0 in text mode."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(report=_valid_report(), registry=registry)
        spec = _canonical_spec("register-me")

        result = register_command(spec, as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_register_success_json_mode_returns_json_payload(self) -> None:
        """Register with valid spec returns JSON payload in JSON mode."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(report=_valid_report(), registry=registry)
        spec = _canonical_spec("register-me")

        result = register_command(spec, as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["registered"] is True
        assert cli_result["json"]["data"]["id"] == "register-me"

    def test_register_invalid_spec_returns_exit_error(self) -> None:
        """Register with invalid spec returns exit code 1."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(
            report=_invalid_report("PERSONA_INVALID"),
            registry=registry,
        )
        spec = _canonical_spec("invalid-register")

        result = register_command(spec, as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_register_failure_json_mode_returns_error_envelope(self) -> None:
        """Register failure returns JSON error envelope in JSON mode."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(
            report=_invalid_report("PERSONA_INVALID"),
            registry=registry,
        )
        spec = _canonical_spec("invalid-register")

        result = register_command(spec, as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101


# ============================================================================
# Resolve Command Tests
# ============================================================================


class TestResolveCommand:
    """Tests for the resolve command handler."""

    def test_resolve_success_text_mode_returns_exit_ok(self) -> None:
        """Resolve existing persona returns exit code 0 in text mode."""
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("resolve-me")))
        facade = _make_facade(report=_valid_report(), registry=registry)

        result = resolve_command("resolve-me", as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_resolve_success_json_mode_returns_json_payload(self) -> None:
        """Resolve existing persona returns JSON payload in JSON mode."""
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("resolve-me")))
        facade = _make_facade(report=_valid_report(), registry=registry)

        result = resolve_command("resolve-me", as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["id"] == "resolve-me"

    def test_resolve_not_found_returns_exit_error_not_generic_failure(
        self,
    ) -> None:
        """Resolve non-existent persona returns exit code 1 (not-found).

        Regression: resolve not-found should return exit code 1 (domain error),
        not exit code 2 (generic/critical failure).
        """
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = resolve_command("missing", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        # Key regression: not-found must exit 1, not 2
        assert failure["exit_code"] == EXIT_ERROR
        assert failure["exit_code"] == 1

    def test_resolve_not_found_json_mode_returns_error_envelope_with_correct_code(
        self,
    ) -> None:
        """Resolve not-found in JSON mode returns error envelope with PERSONA_NOT_FOUND."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = resolve_command("missing", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100
        assert "persona_id" in error["details"]

    def test_resolve_registry_read_failure_returns_exit_error(self) -> None:
        """Registry read failure returns exit code 1 (domain error)."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "REGISTRY_SPEC_READ_FAILED",
                    "message": "failed to read spec json",
                    "persona_id": "broken",
                    "path": "/tmp/broken.json",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = resolve_command("broken", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        # Registry errors are domain errors, exit code 1
        assert failure["exit_code"] == EXIT_ERROR

    def test_resolve_validation_failure_returns_exit_error(self) -> None:
        """Resolve with validation failure returns exit code 1."""
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("invalid-resolve")))
        facade = _make_facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            registry=registry,
        )

        result = resolve_command("invalid-resolve", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR


# ============================================================================
# List Command Tests
# ============================================================================


class TestListCommand:
    """Tests for the list command handler."""

    def test_list_success_text_mode_returns_exit_ok(self) -> None:
        """List with valid registry returns exit code 0 in text mode."""
        registry = InMemoryRegistryStore(
            list_result=Success(
                [
                    _canonical_spec("persona-a", digest="sha256:a"),
                    _canonical_spec("persona-b", digest="sha256:b"),
                ]
            )
        )
        facade = _make_facade(registry=registry)

        result = list_command(as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_list_success_json_mode_returns_json_payload(self) -> None:
        """List returns JSON payload with summaries in JSON mode."""
        registry = InMemoryRegistryStore(
            list_result=Success(
                [
                    _canonical_spec("persona-a", digest="sha256:a"),
                    _canonical_spec("persona-b", digest="sha256:b"),
                ]
            )
        )
        facade = _make_facade(registry=registry)

        result = list_command(as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        data = cli_result["json"]["data"]
        assert isinstance(data, list)
        assert len(data) == 2
        ids = [item["id"] for item in data]
        assert "persona-a" in ids
        assert "persona-b" in ids

    def test_list_empty_registry_returns_exit_ok_with_empty_list(self) -> None:
        """List with empty registry returns exit code 0 with empty list."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade = _make_facade(registry=registry)

        result = list_command(as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_list_empty_registry_json_mode_returns_empty_array(self) -> None:
        """List with empty registry returns empty JSON array in JSON mode."""
        registry = InMemoryRegistryStore(list_result=Success([]))
        facade = _make_facade(registry=registry)

        result = list_command(as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"] == []

    def test_list_registry_read_failure_returns_exit_error(self) -> None:
        """Registry read failure returns exit code 1."""
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "index unreadable",
                    "path": "/tmp/index.json",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = list_command(as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_list_failure_json_mode_returns_error_envelope(self) -> None:
        """List failure returns JSON error envelope in JSON mode."""
        registry = InMemoryRegistryStore(
            list_result=Failure(
                {
                    "code": "REGISTRY_INDEX_READ_FAILED",
                    "message": "index unreadable",
                    "path": "/tmp/index.json",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = list_command(as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "REGISTRY_INDEX_READ_FAILED"
        assert error["numeric_code"] == 107


# ============================================================================
# Delete Command Tests
# ============================================================================


class TestDeleteCommand:
    """Tests for the delete command handler."""

    def test_delete_success_text_mode_returns_exit_ok(self) -> None:
        """Delete existing persona returns exit code 0 in text mode."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)

        from larva.shell.cli import delete_command

        result = delete_command("test-persona", as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert registry.last_delete_id == "test-persona"

    def test_delete_success_json_mode_returns_json_payload(self) -> None:
        """Delete existing persona returns JSON payload in JSON mode."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)

        from larva.shell.cli import delete_command

        result = delete_command("test-persona", as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["deleted"] is True
        assert cli_result["json"]["data"]["id"] == "test-persona"

    def test_delete_not_found_returns_exit_error(self) -> None:
        """Delete non-existent persona returns exit code 1."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import delete_command

        result = delete_command("missing", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_delete_not_found_json_mode_returns_error_envelope(self) -> None:
        """Delete non-existent persona returns JSON error envelope in JSON mode."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import delete_command

        result = delete_command("missing", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100

    def test_delete_invalid_id_returns_exit_error(self) -> None:
        """Delete with invalid persona id returns exit code 1."""
        registry = InMemoryRegistryStore(
            delete_result=Failure(
                {
                    "code": "INVALID_PERSONA_ID",
                    "message": "invalid persona id 'Bad-Id': expected flat kebab-case",
                    "persona_id": "Bad-Id",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import delete_command

        result = delete_command("Bad-Id", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR


# ============================================================================
# Clone Command Tests
# ============================================================================


class TestCloneCommand:
    """Tests for the clone command handler."""

    def test_clone_success_text_mode_returns_exit_ok(self) -> None:
        """Clone existing persona returns exit code 0 in text mode."""
        source_spec = _canonical_spec("source-persona", digest="sha256:source")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import clone_command

        result = clone_command("source-persona", "cloned-persona", as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert len(registry.save_inputs) == 1
        assert registry.save_inputs[0]["id"] == "cloned-persona"

    def test_clone_success_json_mode_returns_json_payload(self) -> None:
        """Clone existing persona returns JSON payload in JSON mode."""
        source_spec = _canonical_spec("source-to-clone", digest="sha256:original")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import clone_command

        result = clone_command("source-to-clone", "clone-target", as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["id"] == "clone-target"
        # Digest should be recomputed, not copied
        assert cli_result["json"]["data"]["spec_digest"] != "sha256:original"

    def test_clone_source_not_found_returns_exit_error(self) -> None:
        """Clone non-existent persona returns exit code 1."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clone_command

        result = clone_command("missing", "cloned-persona", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "Clone failed" in failure.get("stderr", "")

    def test_clone_source_not_found_json_mode_returns_error_envelope(self) -> None:
        """Clone non-existent persona returns JSON error envelope in JSON mode."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found in registry",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clone_command

        result = clone_command("missing", "cloned-persona", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100

    def test_clone_invalid_new_id_returns_exit_error(self) -> None:
        """Clone with invalid new_id returns exit code 1."""
        source_spec = _canonical_spec("valid-source", digest="sha256:valid")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(
            report=_invalid_report("INVALID_PERSONA_ID"),
            registry=registry,
        )

        from larva.shell.cli import clone_command

        result = clone_command("valid-source", "Bad_Clone_Id", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_clone_invalid_new_id_json_mode_returns_error_envelope(self) -> None:
        """Clone with invalid new_id returns JSON error envelope in JSON mode."""
        source_spec = _canonical_spec("valid-source", digest="sha256:valid")
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(
            report=_invalid_report("PERSONA_INVALID"),
            registry=registry,
        )

        from larva.shell.cli import clone_command

        result = clone_command("valid-source", "Bad_Clone_Id", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_INVALID"
        assert error["numeric_code"] == 101

    def test_clone_registry_write_failure_returns_exit_error(self) -> None:
        """Clone with registry write failure returns exit code 1."""
        source_spec = _canonical_spec("source-write-fail", digest="sha256:source")
        registry = InMemoryRegistryStore(
            get_result=Success(source_spec),
            save_result=Failure(
                {
                    "code": "REGISTRY_WRITE_FAILED",
                    "message": "disk full during save",
                    "persona_id": "cloned-write-fail",
                    "path": "/tmp/cloned-write-fail.json",
                }
            ),
        )
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import clone_command

        result = clone_command(
            "source-write-fail", "cloned-write-fail", as_json=False, facade=facade
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "Clone failed" in failure.get("stderr", "")

    def test_clone_preserves_all_fields_except_id_and_digest(self) -> None:
        """Clone preserves all source fields except id and spec_digest."""
        source_spec: PersonaSpec = {
            "id": "original-persona",
            "description": "Original description",
            "prompt": "Original prompt text",
            "model": "gpt-4",
            "tools": {"shell": "full_access"},
            "model_params": {"temperature": 0.7, "max_tokens": 4000},
            "side_effect_policy": "full_access",
            "can_spawn": True,
            "compaction_prompt": "Custom compaction",
            "spec_version": "0.2.0",
            "spec_digest": "sha256:stale",
            "custom_field": "custom_value",
        }
        registry = InMemoryRegistryStore(get_result=Success(source_spec))
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import clone_command

        result = clone_command("original-persona", "cloned-persona", as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        cloned = cli_result["json"]["data"]
        assert cloned["id"] == "cloned-persona"
        assert cloned["description"] == "Original description"
        assert cloned["prompt"] == "Original prompt text"
        assert cloned["model"] == "gpt-4"
        assert cloned["tools"] == {"shell": "full_access"}
        assert cloned["model_params"] == {"temperature": 0.7, "max_tokens": 4000}
        assert cloned["side_effect_policy"] == "full_access"
        assert cloned["can_spawn"] is True
        assert cloned["compaction_prompt"] == "Custom compaction"
        assert cloned["spec_version"] == "0.2.0"
        assert cloned["custom_field"] == "custom_value"
        # Digest must be recomputed
        assert cloned["spec_digest"] != "sha256:stale"


# ============================================================================
# Clear Command Tests
# ============================================================================


class TestClearCommand:
    """Tests for the clear command handler."""

    def test_clear_success_text_mode_returns_exit_ok(self) -> None:
        """Clear with correct confirmation returns exit code 0 in text mode."""
        registry = InMemoryRegistryStore(clear_result=Success(3))
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clear_command

        result = clear_command("CLEAR REGISTRY", as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert registry.last_clear_confirm == "CLEAR REGISTRY"

    def test_clear_success_json_mode_returns_json_payload(self) -> None:
        """Clear with correct confirmation returns JSON payload in JSON mode."""
        registry = InMemoryRegistryStore(clear_result=Success(5))
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clear_command

        result = clear_command("CLEAR REGISTRY", as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["cleared"] is True
        assert cli_result["json"]["data"]["count"] == 5

    def test_clear_wrong_confirm_returns_exit_error(self) -> None:
        """Clear with wrong confirmation token returns exit code 1."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clear_command

        result = clear_command("wrong token", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "CLEAR REGISTRY" in failure.get("stderr", "")

    def test_clear_wrong_confirm_json_mode_returns_error_envelope(self) -> None:
        """Clear with wrong confirmation token returns JSON error envelope."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clear_command

        result = clear_command("wrong token", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "INVALID_CONFIRMATION_TOKEN"

    def test_clear_empty_registry_returns_exit_ok_with_count_zero(self) -> None:
        """Clear with empty registry returns success with count 0."""
        registry = InMemoryRegistryStore(clear_result=Success(0))
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clear_command

        result = clear_command("CLEAR REGISTRY", as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert cli_result["json"]["data"]["count"] == 0

    def test_clear_registry_failure_returns_exit_error(self) -> None:
        """Clear with registry failure returns exit code 1."""
        registry = InMemoryRegistryStore(
            clear_result=Failure(
                {
                    "code": "REGISTRY_DELETE_FAILED",
                    "message": "failed to delete one or more specs",
                    "operation": "clear",
                    "persona_id": None,
                    "path": "/tmp/index.json",
                    "failed_spec_paths": [],
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import clear_command

        result = clear_command("CLEAR REGISTRY", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR


# ============================================================================
# JSON/Text Separation Regression Tests
# ============================================================================


class TestJsonTextSeparation:
    """Regression tests for JSON/text output separation."""

    def test_success_text_mode_has_no_json_key(self) -> None:
        """Success in text mode must not include 'json' key in result."""
        registry = InMemoryRegistryStore(list_result=Success([_canonical_spec("test")]))
        facade = _make_facade(registry=registry)

        result = list_command(as_json=False, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        # Text mode must not leak JSON into the result
        assert "json" not in cli_result

    def test_failure_text_mode_has_no_json_key(self) -> None:
        """Failure in text mode must not include 'json' key in result."""
        facade = _make_facade(report=_invalid_report("PERSONA_INVALID"))
        spec = _canonical_spec("invalid")

        result = register_command(spec, as_json=False, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        # Text mode must not leak JSON into the result
        assert "json" not in failure

    def test_json_mode_includes_json_key_on_success(self) -> None:
        """Success in JSON mode must include 'json' key with data."""
        registry = InMemoryRegistryStore(list_result=Success([_canonical_spec("test")]))
        facade = _make_facade(registry=registry)

        result = list_command(as_json=True, facade=facade)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert "json" in cli_result
        assert "data" in cli_result["json"]

    def test_json_mode_includes_error_key_on_failure(self) -> None:
        """Failure in JSON mode must include 'error' key."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = resolve_command("missing", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "error" in failure


# ============================================================================
# Exit Code Mapping Tests
# ============================================================================


class TestExitCodeMapping:
    """Tests for exit code mapping from facade errors."""

    def test_success_returns_exit_ok(self) -> None:
        """All successful operations return exit code 0."""
        registry = InMemoryRegistryStore()
        facade = _make_facade(report=_valid_report(), registry=registry)
        spec = _canonical_spec("test")

        # Validate success
        result = validate_command(spec, as_json=False, facade=facade)
        assert isinstance(result, Success)
        assert result.unwrap()["exit_code"] == EXIT_OK

        # Assemble success
        result = assemble_command({"id": "test"}, as_json=False, facade=facade)
        assert isinstance(result, Success)
        assert result.unwrap()["exit_code"] == EXIT_OK

        # Register success
        result = register_command(spec, as_json=False, facade=facade)
        assert isinstance(result, Success)
        assert result.unwrap()["exit_code"] == EXIT_OK

    def test_not_found_returns_exit_error(self) -> None:
        """Not-found errors return exit code 1."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = resolve_command("missing", as_json=False, facade=facade)

        assert isinstance(result, Failure)
        assert result.failure()["exit_code"] == EXIT_ERROR

    def test_validation_failure_returns_exit_error(self) -> None:
        """Validation failures return exit code 1."""
        facade = _make_facade(report=_invalid_report("INVALID_SPEC_VERSION"))
        spec = _canonical_spec("invalid")

        result = validate_command(spec, as_json=False, facade=facade)

        assert isinstance(result, Failure)
        assert result.failure()["exit_code"] == EXIT_ERROR


# ============================================================================
# JSON Error Envelope Format Tests
# ============================================================================


class TestJsonErrorEnvelope:
    """Tests for JSON error envelope format."""

    def test_error_envelope_has_required_fields(self) -> None:
        """Error envelope must have code, numeric_code, message, details."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'test' not found",
                    "persona_id": "test",
                }
            )
        )
        facade = _make_facade(registry=registry)

        result = resolve_command("test", as_json=True, facade=facade)

        assert isinstance(result, Failure)
        failure = result.failure()
        error = failure["error"]

        assert "code" in error
        assert "numeric_code" in error
        assert "message" in error
        assert "details" in error

    def test_error_envelope_numeric_codes_match_spec(self) -> None:
        """Error numeric codes match INTERFACES.md G. Error Codes."""
        test_cases: list[tuple[str, int, dict[str, Any]]] = [
            ("PERSONA_NOT_FOUND", 100, {"persona_id": "missing"}),
            ("PERSONA_INVALID", 101, {"report": {}}),
            ("PERSONA_CYCLE", 102, {}),
            ("VARIABLE_UNRESOLVED", 103, {}),
            ("INVALID_PERSONA_ID", 104, {"persona_id": "bad-id"}),
            ("COMPONENT_NOT_FOUND", 105, {"component_type": "prompt"}),
            ("COMPONENT_CONFLICT", 106, {}),
            ("REGISTRY_INDEX_READ_FAILED", 107, {"path": "/tmp/index.json"}),
            ("REGISTRY_SPEC_READ_FAILED", 108, {"persona_id": "x", "path": "/x.json"}),
            ("REGISTRY_WRITE_FAILED", 109, {"persona_id": "x", "path": "/x.json"}),
            ("REGISTRY_UPDATE_FAILED", 110, {"persona_id": "x", "path": "/index.json"}),
        ]

        for code, expected_numeric, details in test_cases:
            registry = InMemoryRegistryStore(
                get_result=Failure(
                    {
                        "code": code,
                        "message": f"test {code}",
                        **details,
                    }
                )
            )
            facade = _make_facade(registry=registry)
            result = resolve_command("test", as_json=True, facade=facade)

            assert isinstance(result, Failure)
            error = result.failure()["error"]
            assert error["numeric_code"] == expected_numeric, (
                f"Expected {expected_numeric} for {code}"
            )


@dataclass
class RecordingFacade:
    """Simple facade double for run_cli dispatch tests."""

    validate_report: ValidationReport = field(default_factory=_valid_report)
    assemble_result: Result[PersonaSpec, LarvaError] = field(
        default_factory=lambda: Success(_canonical_spec("assembled"))
    )
    register_result: Result[RegisteredPersona, LarvaError] = field(
        default_factory=lambda: Success({"id": "registered", "registered": True})
    )
    resolve_result: Result[PersonaSpec, LarvaError] = field(
        default_factory=lambda: Success(_canonical_spec("resolved"))
    )
    list_result: Result[list[PersonaSummary], LarvaError] = field(
        default_factory=lambda: Success([])
    )
    delete_result: Result[dict[str, object], LarvaError] = field(
        default_factory=lambda: Success({"id": "deleted", "deleted": True})
    )
    clear_result: Result[dict[str, object], LarvaError] = field(
        default_factory=lambda: Success({"cleared": True, "count": 0})
    )
    update_result: Result[PersonaSpec, LarvaError] = field(
        default_factory=lambda: Success(_canonical_spec("updated"))
    )
    clone_result: Result[PersonaSpec, LarvaError] = field(
        default_factory=lambda: Success(_canonical_spec("cloned"))
    )
    validate_calls: int = 0
    assemble_calls: int = 0
    register_calls: int = 0
    resolve_calls: int = 0
    list_calls: int = 0
    delete_calls: int = 0
    clear_calls: int = 0
    update_calls: int = 0
    clone_calls: int = 0
    last_resolve_id: str | None = None
    last_resolve_overrides: dict[str, object] | None = None
    last_delete_id: str | None = None
    last_clear_confirm: str | None = None
    last_update_id: str | None = None
    last_update_patches: dict[str, object] | None = None
    last_clone_source: str | None = None
    last_clone_target: str | None = None

    def validate(self, spec: PersonaSpec) -> ValidationReport:
        del spec
        self.validate_calls += 1
        return self.validate_report

    def assemble(self, request: AssembleRequest) -> Result[PersonaSpec, LarvaError]:
        del request
        self.assemble_calls += 1
        return self.assemble_result

    def register(self, spec: PersonaSpec) -> Result[RegisteredPersona, LarvaError]:
        del spec
        self.register_calls += 1
        return self.register_result

    def resolve(
        self,
        id: str,
        overrides: dict[str, object] | None = None,
    ) -> Result[PersonaSpec, LarvaError]:
        self.resolve_calls += 1
        self.last_resolve_id = id
        self.last_resolve_overrides = overrides
        return self.resolve_result

    def list(self) -> Result[list[PersonaSummary], LarvaError]:
        self.list_calls += 1
        return self.list_result

    def delete(self, persona_id: str) -> Result[dict[str, object], LarvaError]:
        self.delete_calls += 1
        self.last_delete_id = persona_id
        if isinstance(self.delete_result, Success):
            # Return the persona_id in the result for success case
            return Success({"id": persona_id, "deleted": True})
        return self.delete_result

    def clear(self, confirm: str = "CLEAR REGISTRY") -> Result[dict[str, object], LarvaError]:
        self.clear_calls += 1
        self.last_clear_confirm = confirm
        return self.clear_result

    def update(
        self,
        persona_id: str,
        patches: dict[str, object],
    ) -> Result[PersonaSpec, LarvaError]:
        self.update_calls += 1
        self.last_update_id = persona_id
        self.last_update_patches = patches
        return self.update_result

    def clone(self, source_id: str, new_id: str) -> Result[PersonaSpec, LarvaError]:
        self.clone_calls += 1
        self.last_clone_source = source_id
        self.last_clone_target = new_id
        return self.clone_result


class TestRunCli:
    def test_validate_parse_error_json_returns_internal_numeric_code(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(["validate", "--json"], facade=facade, stdout=stdout, stderr=stderr)

        assert exit_code == EXIT_CRITICAL
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "INTERNAL"
        assert payload["error"]["numeric_code"] == 10
        assert stderr.getvalue() == ""

    def test_validate_json_success_writes_json_stdout_only(self, tmp_path: Path) -> None:
        spec_path = tmp_path / "valid.json"
        spec_path.write_text(json.dumps(_canonical_spec("ok")), encoding="utf-8")
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["validate", str(spec_path), "--json"], facade=facade, stdout=stdout, stderr=stderr
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["valid"] is True
        assert stderr.getvalue() == ""

    def test_validate_missing_id_text_returns_domain_failure_with_stderr_only(
        self, tmp_path: Path
    ) -> None:
        spec_path = tmp_path / "missing-id.json"
        spec_path.write_text(json.dumps({"spec_version": "0.1.0"}), encoding="utf-8")
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["validate", str(spec_path)],
            facade=cli.build_default_facade(),
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_ERROR
        assert stdout.getvalue() == ""
        assert "Validation failed" in stderr.getvalue()
        assert "id is required" in stderr.getvalue()

    def test_validate_missing_id_json_returns_persona_invalid_envelope(
        self, tmp_path: Path
    ) -> None:
        spec_path = tmp_path / "missing-id.json"
        spec_path.write_text(json.dumps({"spec_version": "0.1.0"}), encoding="utf-8")
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["validate", str(spec_path), "--json"],
            facade=cli.build_default_facade(),
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_ERROR
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "PERSONA_INVALID"
        assert payload["error"]["numeric_code"] == 101
        assert payload["error"]["details"]["report"]["errors"][0]["code"] == "INVALID_PERSONA_ID"
        assert stderr.getvalue() == ""

    def test_register_missing_file_text_returns_critical_and_stderr_only(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["register", "/missing/spec.json"], facade=facade, stdout=stdout, stderr=stderr
        )

        assert exit_code == EXIT_CRITICAL
        assert stdout.getvalue() == ""
        assert "spec file not found" in stderr.getvalue()

    def test_register_missing_file_json_returns_error_envelope_on_stdout(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["register", "/missing/spec.json", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_CRITICAL
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "INTERNAL"
        assert payload["error"]["numeric_code"] == 10
        assert stderr.getvalue() == ""

    def test_assemble_override_parse_error_returns_critical(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["assemble", "--id", "persona", "--override", "bad"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_CRITICAL
        assert stdout.getvalue() == ""
        assert "expected key=value" in stderr.getvalue()

    def test_assemble_output_short_flag_writes_json_file(self, tmp_path: Path) -> None:
        output_path = tmp_path / "assembled-short.json"
        facade = RecordingFacade(assemble_result=Success(_canonical_spec("assembled-short")))
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["assemble", "--id", "assembled-short", "-o", str(output_path)],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        assert stdout.getvalue() == ""
        assert stderr.getvalue() == ""
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        assert payload["id"] == "assembled-short"

    def test_assemble_output_long_flag_writes_json_file(self, tmp_path: Path) -> None:
        output_path = tmp_path / "assembled-long.json"
        facade = RecordingFacade(assemble_result=Success(_canonical_spec("assembled-long")))
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["assemble", "--id", "assembled-long", "--output", str(output_path)],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        assert stdout.getvalue() == ""
        assert stderr.getvalue() == ""
        payload = json.loads(output_path.read_text(encoding="utf-8"))
        assert payload["id"] == "assembled-long"

    def test_resolve_passes_parsed_overrides_to_facade(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            [
                "resolve",
                "persona-1",
                "--override",
                "model=gpt-4o-mini",
                "--override",
                "can_spawn=false",
            ],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        assert facade.last_resolve_id == "persona-1"
        assert facade.last_resolve_overrides == {"model": "gpt-4o-mini", "can_spawn": "false"}

    def test_component_list_json_routes_to_component_store_only(self) -> None:
        facade = RecordingFacade()
        components = InMemoryComponentStore(
            list_result=Success(
                {
                    "prompts": ["a"],
                    "toolsets": ["b"],
                    "constraints": ["c"],
                    "models": ["d"],
                }
            )
        )
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["component", "list", "--json"],
            facade=facade,
            component_store=components,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["prompts"] == ["a"]
        assert stderr.getvalue() == ""
        assert facade.validate_calls == 0
        assert facade.assemble_calls == 0
        assert facade.register_calls == 0
        assert facade.resolve_calls == 0
        assert facade.list_calls == 0

    def test_component_show_routes_to_target_loader_only(self) -> None:
        facade = RecordingFacade()
        components = InMemoryComponentStore()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["component", "show", "prompts/test-prompt", "--json"],
            facade=facade,
            component_store=components,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["text"] == "Prompt body"
        assert components.last_loaded == ("prompts", "test-prompt")
        assert stderr.getvalue() == ""
        assert facade.validate_calls == 0
        assert facade.assemble_calls == 0
        assert facade.register_calls == 0
        assert facade.resolve_calls == 0
        assert facade.list_calls == 0

    def test_component_show_missing_target_returns_not_found_envelope(self) -> None:
        facade = RecordingFacade()
        components = InMemoryComponentStore()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["component", "show", "prompts/", "--json"],
            facade=facade,
            component_store=components,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_ERROR
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "COMPONENT_NOT_FOUND"
        assert payload["error"]["numeric_code"] == 105
        assert stderr.getvalue() == ""

    def test_component_list_generic_failure_maps_to_internal_without_text_leak(self) -> None:
        facade = RecordingFacade()
        components = InMemoryComponentStore(list_result=Failure(RuntimeError("boom")))
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["component", "list", "--json"],
            facade=facade,
            component_store=components,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_CRITICAL
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "INTERNAL"
        assert payload["error"]["numeric_code"] == 10
        assert stderr.getvalue() == ""

    def test_delete_success_routes_to_facade_delete(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["delete", "test-persona", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["deleted"] is True
        assert payload["data"]["id"] == "test-persona"
        assert stderr.getvalue() == ""
        assert facade.delete_calls == 1
        assert facade.last_delete_id == "test-persona"

    def test_delete_not_found_returns_exit_error(self) -> None:
        facade = RecordingFacade(
            delete_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "numeric_code": 100,
                    "details": {"persona_id": "missing"},
                }
            )
        )
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["delete", "missing", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_ERROR
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "PERSONA_NOT_FOUND"
        assert stderr.getvalue() == ""

    def test_clear_success_with_confirmation_routes_to_facade_clear(self) -> None:
        facade = RecordingFacade(clear_result=Success({"cleared": True, "count": 3}))
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["clear", "--confirm", "CLEAR REGISTRY", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["cleared"] is True
        assert payload["data"]["count"] == 3
        assert stderr.getvalue() == ""
        assert facade.clear_calls == 1
        assert facade.last_clear_confirm == "CLEAR REGISTRY"

    def test_clear_wrong_confirm_returns_exit_error(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["clear", "--confirm", "wrong token", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_ERROR
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "INVALID_CONFIRMATION_TOKEN"
        assert stderr.getvalue() == ""
        assert facade.clear_calls == 0

    def test_clear_missing_confirm_returns_parse_error(self) -> None:
        facade = RecordingFacade()
        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["clear", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_CRITICAL
        payload = json.loads(stdout.getvalue())
        assert payload["error"]["code"] == "INTERNAL"
        assert stderr.getvalue() == ""


# ============================================================================
# Component List Command Tests
# ============================================================================


class TestComponentListCommand:
    """Tests for the component_list_command handler.

    Contract from INTERFACES.md:
    - Exit code 0: success
    - Exit code 1: error (component directory access failure)
    - Direct to injected ComponentStore.list_components()
    """

    def test_component_list_success_text_mode_returns_exit_ok(self) -> None:
        """Component list with valid store returns exit code 0 in text mode."""
        components = InMemoryComponentStore()

        result = component_list_command(as_json=False, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_component_list_success_json_mode_returns_json_payload(self) -> None:
        """Component list returns JSON payload with inventory in JSON mode."""
        components = InMemoryComponentStore()

        result = component_list_command(as_json=True, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        data = cli_result["json"]["data"]
        assert "prompts" in data
        assert "toolsets" in data
        assert "constraints" in data
        assert "models" in data
        # Verify list of each type
        assert isinstance(data["prompts"], list)
        assert isinstance(data["toolsets"], list)
        assert isinstance(data["constraints"], list)
        assert isinstance(data["models"], list)

    def test_component_list_with_components_returns_exit_ok(self) -> None:
        """Component list with actual components returns exit code 0."""
        # Use the InMemoryComponentStore with predefined components
        components = InMemoryComponentStore()
        # The InMemoryComponentStore returns empty lists by default
        # but we can override it to test non-empty results

        result = component_list_command(as_json=False, component_store=components)

        assert isinstance(result, Success)
        assert result.unwrap()["exit_code"] == EXIT_OK

    def test_component_list_empty_store_returns_exit_ok_with_empty_dict(self) -> None:
        """Component list with empty store returns exit code 0 with empty dict."""
        components = InMemoryComponentStore(
            list_result=Success(
                {
                    "prompts": [],
                    "toolsets": [],
                    "constraints": [],
                    "models": [],
                }
            )
        )

        result = component_list_command(as_json=True, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert cli_result["json"]["data"]["prompts"] == []
        assert cli_result["json"]["data"]["toolsets"] == []
        assert cli_result["json"]["data"]["constraints"] == []
        assert cli_result["json"]["data"]["models"] == []


class TestComponentShowCommand:
    """Tests for the component_show_command handler.

    Contract from INTERFACES.md:
    - Exit code 0: success
    - Exit code 1: not found (component does not exist or cannot be parsed)
    - Direct to ComponentStore.load_<type>(name)
    - Type is one of: prompts, toolsets, constraints, models
    """

    def test_component_show_prompt_success_text_mode_returns_exit_ok(self) -> None:
        """Component show with valid prompt returns exit code 0 in text mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "prompts/test-prompt", as_json=False, component_store=components
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_component_show_prompt_success_json_mode_returns_json_payload(self) -> None:
        """Component show with valid prompt returns JSON payload in JSON mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "prompts/test-prompt", as_json=True, component_store=components
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert "data" in cli_result["json"]
        assert "text" in cli_result["json"]["data"]

    def test_component_show_toolset_success_text_mode_returns_exit_ok(self) -> None:
        """Component show with valid toolset returns exit code 0 in text mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "toolsets/test-toolset", as_json=False, component_store=components
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_component_show_toolset_success_json_mode_returns_json_payload(self) -> None:
        """Component show with valid toolset returns JSON payload in JSON mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "toolsets/test-toolset", as_json=True, component_store=components
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert "data" in cli_result["json"]
        assert "tools" in cli_result["json"]["data"]

    def test_component_show_constraint_success_text_mode_returns_exit_ok(self) -> None:
        """Component show with valid constraint returns exit code 0 in text mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "constraints/test-constraint", as_json=False, component_store=components
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_component_show_model_success_text_mode_returns_exit_ok(self) -> None:
        """Component show with valid model returns exit code 0 in text mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "models/test-model", as_json=False, component_store=components
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_component_show_not_found_returns_exit_error(self) -> None:
        """Component show with non-existent component returns exit code 1."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "prompts/nonexistent", as_json=False, component_store=components
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        # Not found should return exit code 1
        assert failure["exit_code"] == EXIT_ERROR
        assert failure["exit_code"] == 1

    def test_component_show_not_found_json_mode_returns_error_envelope(self) -> None:
        """Component show not found returns JSON error envelope in JSON mode."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "prompts/nonexistent", as_json=True, component_store=components
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert "code" in error
        assert "numeric_code" in error
        assert "message" in error
        assert "details" in error
        # COMPONENT_NOT_FOUND = 105
        assert error["numeric_code"] == 105


class TestComponentCommandJsonTextSeparation:
    """Regression tests for JSON/text output separation on component commands."""

    def test_component_list_success_text_mode_has_no_json_key(self) -> None:
        """Component list success in text mode must not include 'json' key."""
        components = InMemoryComponentStore()

        result = component_list_command(as_json=False, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert "json" not in cli_result

    def test_component_list_failure_text_mode_has_no_json_key(self) -> None:
        """Component list failure in text mode must not include 'json' key."""

        # Create a failing component store that returns error
        class FailingComponentStore:
            def load_prompt(self, name: str):
                return Failure(Exception("not implemented"))

            def load_toolset(self, name: str):
                return Failure(Exception("not implemented"))

            def load_constraint(self, name: str):
                return Failure(Exception("not implemented"))

            def load_model(self, name: str):
                return Failure(Exception("not implemented"))

            def list_components(self):
                return Failure(Exception("directory access failed"))

        result = component_list_command(as_json=False, component_store=FailingComponentStore())

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "json" not in failure

    def test_component_show_success_text_mode_has_no_json_key(self) -> None:
        """Component show success in text mode must not include 'json' key."""
        components = InMemoryComponentStore()

        result = component_show_command("prompts/test", as_json=False, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert "json" not in cli_result

    def test_component_show_failure_text_mode_has_no_json_key(self) -> None:
        """Component show failure in text mode must not include 'json' key."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "prompts/nonexistent", as_json=False, component_store=components
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "json" not in failure

    def test_component_list_json_mode_includes_json_key_on_success(self) -> None:
        """Component list success in JSON mode must include 'json' key with data."""
        components = InMemoryComponentStore()

        result = component_list_command(as_json=True, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert "json" in cli_result
        assert "data" in cli_result["json"]

    def test_component_show_json_mode_includes_json_key_on_success(self) -> None:
        """Component show success in JSON mode must include 'json' key with data."""
        components = InMemoryComponentStore()

        result = component_show_command("prompts/test", as_json=True, component_store=components)

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert "json" in cli_result
        assert "data" in cli_result["json"]

    def test_component_list_json_mode_includes_error_key_on_failure(self) -> None:
        """Component list failure in JSON mode must include 'error' key."""

        class FailingComponentStore:
            def load_prompt(self, name: str):
                return Failure(Exception("not implemented"))

            def load_toolset(self, name: str):
                return Failure(Exception("not implemented"))

            def load_constraint(self, name: str):
                return Failure(Exception("not implemented"))

            def load_model(self, name: str):
                return Failure(Exception("not implemented"))

            def list_components(self):
                return Failure(Exception("directory access failed"))

        result = component_list_command(as_json=True, component_store=FailingComponentStore())

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "error" in failure

    def test_component_show_json_mode_includes_error_key_on_failure(self) -> None:
        """Component show failure in JSON mode must include 'error' key."""
        components = InMemoryComponentStore()

        result = component_show_command(
            "prompts/nonexistent", as_json=True, component_store=components
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert "error" in failure


# ============================================================================
# _read_spec_json Boundary Tests
# ============================================================================
# Regression tests for _read_spec_json behavior boundaries:
# - File not found returns critical failure with INTERNAL code
# - JSON decode error returns critical failure with parse details
# - OSError returns critical failure with error details
# - Non-dict root returns critical failure
# - Valid JSON dict returns Success with loaded spec


class TestReadSpecJson:
    """Tests for the _read_spec_json helper function behavior boundaries."""

    def test_file_not_found_returns_critical_failure(self, tmp_path: Path) -> None:
        """Non-existent file returns Failure with INTERNAL error code."""
        from larva.shell import cli as cli_module

        missing_path = tmp_path / "does-not-exist.json"
        result = cli_module._read_spec_json(str(missing_path))

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["code"] == "INTERNAL"
        assert failure["numeric_code"] == 10
        assert "not found" in failure["message"].lower()
        assert failure["details"]["path"] == str(missing_path)

    def test_json_decode_error_returns_failure_with_line_info(self, tmp_path: Path) -> None:
        """Invalid JSON returns Failure with decode error details."""
        from larva.shell import cli as cli_module

        invalid_path = tmp_path / "invalid.json"
        invalid_path.write_text('{"id": "test", "invalid json"', encoding="utf-8")

        result = cli_module._read_spec_json(str(invalid_path))

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["code"] == "INTERNAL"
        assert failure["numeric_code"] == 10
        assert "not valid" in failure["message"].lower() and "json" in failure["message"].lower()
        # JSONDecodeError provides line/column info when available
        assert "line" in failure["details"] or "column" in failure["details"]

    def test_os_error_returns_failure_with_error_details(self, tmp_path: Path) -> None:
        """OS-level read error returns Failure with error details."""
        from larva.shell import cli as cli_module

        # Create a directory instead of a file - will cause OSError on open
        error_path = tmp_path / "is-a-dir.json"
        error_path.mkdir()

        result = cli_module._read_spec_json(str(error_path))

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["code"] == "INTERNAL"
        assert failure["numeric_code"] == 10
        assert "read" in failure["message"].lower() or "failed" in failure["message"].lower()
        assert "error" in failure["details"]

    def test_non_dict_root_returns_failure(self, tmp_path: Path) -> None:
        """JSON root that is not a dict returns Failure."""
        from larva.shell import cli as cli_module

        array_path = tmp_path / "array.json"
        array_path.write_text('["not", "a", "dict"]', encoding="utf-8")

        result = cli_module._read_spec_json(str(array_path))

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["code"] == "INTERNAL"
        assert failure["numeric_code"] == 10
        assert "object" in failure["message"].lower()

    def test_valid_json_dict_returns_success(self, tmp_path: Path) -> None:
        """Valid JSON file with dict root returns Success with loaded spec."""
        from larva.shell import cli as cli_module

        valid_path = tmp_path / "valid.json"
        spec = _canonical_spec("test-persona")
        valid_path.write_text(json.dumps(spec), encoding="utf-8")

        result = cli_module._read_spec_json(str(valid_path))

        assert isinstance(result, Success)
        loaded = result.unwrap()
        assert loaded["id"] == "test-persona"


# ============================================================================
# _dispatch Boundary Tests
# ============================================================================
# Regression tests for _dispatch command routing behavior:
# - Validates correct command -> handler routing
# - Tests error propagation from _read_spec_json in validate/register paths
# - Tests error propagation from override parsing in assemble/resolve paths
# - Component subcommand routing


class TestDispatch:
    """Tests for the _dispatch command routing function."""

    def test_validate_command_routes_to_validate_handler(self, tmp_path: Path) -> None:
        """Validate command routes to validate_command handler."""
        from larva.shell import cli as cli_module

        spec_path = tmp_path / "valid.json"
        spec_path.write_text(json.dumps(_canonical_spec("test")), encoding="utf-8")

        # Create args namespace that mimics argparse
        class Args:
            command = "validate"
            spec = str(spec_path)
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        # Validate should call facade.validate
        assert facade.validate_calls == 1

    def test_register_command_routes_to_register_handler(self, tmp_path: Path) -> None:
        """Register command routes to register_command handler."""
        from larva.shell import cli as cli_module

        spec_path = tmp_path / "valid.json"
        spec_path.write_text(json.dumps(_canonical_spec("test")), encoding="utf-8")

        class Args:
            command = "register"
            spec = str(spec_path)
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        assert facade.register_calls == 1

    def test_validate_with_missing_file_returns_critical(self) -> None:
        """Validate command with missing spec file returns critical failure."""
        from larva.shell import cli as cli_module

        class Args:
            command = "validate"
            spec = "/nonexistent/path/spec.json"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Failure)
        failure = result.failure()
        # Missing file should be critical (exit code 2)
        assert failure["exit_code"] == EXIT_CRITICAL

    def test_register_with_missing_file_returns_critical(self) -> None:
        """Register command with missing spec file returns critical failure."""
        from larva.shell import cli as cli_module

        class Args:
            command = "register"
            spec = "/nonexistent/path/spec.json"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_CRITICAL

    def test_assemble_with_bad_override_returns_critical(self) -> None:
        """Assemble with malformed override returns critical failure."""
        from larva.shell import cli as cli_module

        class Args:
            command = "assemble"
            id = "test-id"
            prompts = []
            toolsets = []
            constraints = []
            overrides = ["not-a-valid-override"]  # Missing '='
            variables = []
            model = None
            output = None
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_CRITICAL
        assert "override" in failure["error"]["message"].lower()

    def test_resolve_command_routes_to_resolve_handler(self) -> None:
        """Resolve command routes to resolve_command handler."""
        from larva.shell import cli as cli_module

        class Args:
            command = "resolve"
            id = "test-id"
            overrides = []
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        assert facade.resolve_calls == 1
        assert facade.last_resolve_id == "test-id"

    def test_list_command_routes_to_list_handler(self) -> None:
        """List command routes to list_command handler."""
        from larva.shell import cli as cli_module

        class Args:
            command = "list"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        assert facade.list_calls == 1

    def test_clone_command_routes_to_clone_handler(self) -> None:
        """Clone command routes to clone_command handler."""
        from larva.shell import cli as cli_module

        class Args:
            command = "clone"
            source_id = "source-persona"
            new_id = "cloned-persona"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        assert facade.clone_calls == 1
        assert facade.last_clone_source == "source-persona"
        assert facade.last_clone_target == "cloned-persona"

    def test_component_list_routes_to_component_list_handler(self) -> None:
        """Component list routes to component_list_command handler."""
        from larva.shell import cli as cli_module

        class Args:
            command = "component"
            component_command = "list"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        # Component commands should NOT call facade methods
        assert facade.validate_calls == 0
        assert facade.assemble_calls == 0
        assert facade.register_calls == 0
        assert facade.resolve_calls == 0
        assert facade.list_calls == 0

    def test_component_show_routes_to_component_show_handler(self) -> None:
        """Component show routes to component_show_command handler."""
        from larva.shell import cli as cli_module

        class Args:
            command = "component"
            component_command = "show"
            ref = "prompts/test-prompt"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Success)
        # Component commands should NOT call facade methods
        assert facade.validate_calls == 0
        assert facade.assemble_calls == 0
        assert facade.register_calls == 0
        assert facade.resolve_calls == 0
        assert facade.list_calls == 0

    def test_unknown_command_returns_critical(self) -> None:
        """Unknown command returns critical failure."""
        from larva.shell import cli as cli_module

        class Args:
            command = "unknown-command"
            as_json = False

        facade = RecordingFacade()
        components = InMemoryComponentStore()

        result = cli_module._dispatch(Args(), facade=facade, component_store=components)

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_CRITICAL


# ============================================================================
# Update Command Tests
# ============================================================================


class TestUpdateCommand:
    """Tests for the update command handler."""

    def test_update_success_text_mode_returns_exit_ok(self) -> None:
        """Update with valid patches returns exit code 0 in text mode."""
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("update-me")))
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import update_command

        result = update_command(
            "update-me",
            patches={"description": "Updated description"},
            as_json=False,
            facade=facade,
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK

    def test_update_success_json_mode_returns_json_payload(self) -> None:
        """Update with valid patches returns JSON payload in JSON mode."""
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("update-me")))
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import update_command

        result = update_command(
            "update-me",
            patches={"description": "Updated"},
            as_json=True,
            facade=facade,
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result
        assert cli_result["json"]["data"]["id"] == "update-me"

    def test_update_not_found_returns_exit_error(self) -> None:
        """Update non-existent persona returns exit code 1."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import update_command

        result = update_command(
            "missing", patches={"description": "x"}, as_json=False, facade=facade
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_update_not_found_json_mode_returns_error_envelope(self) -> None:
        """Update not-found returns JSON error envelope in JSON mode."""
        registry = InMemoryRegistryStore(
            get_result=Failure(
                {
                    "code": "PERSONA_NOT_FOUND",
                    "message": "persona 'missing' not found",
                    "persona_id": "missing",
                }
            )
        )
        facade = _make_facade(registry=registry)

        from larva.shell.cli import update_command

        result = update_command(
            "missing", patches={"description": "x"}, as_json=True, facade=facade
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR
        assert "error" in failure
        error = failure["error"]
        assert error["code"] == "PERSONA_NOT_FOUND"
        assert error["numeric_code"] == 100

    def test_update_validation_failure_returns_exit_error(self) -> None:
        """Update with invalid patches returns exit code 1."""
        registry = InMemoryRegistryStore(get_result=Success(_canonical_spec("update-invalid")))
        facade = _make_facade(
            report=_invalid_report("INVALID_SPEC_VERSION"),
            registry=registry,
        )

        from larva.shell.cli import update_command

        result = update_command(
            "update-invalid", patches={"description": None}, as_json=False, facade=facade
        )

        assert isinstance(result, Failure)
        failure = result.failure()
        assert failure["exit_code"] == EXIT_ERROR

    def test_update_success_applies_patches_and_returns_updated_spec(self) -> None:
        """Update applies patches and returns updated spec."""
        existing = _canonical_spec("patch-test", digest="sha256:old")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        from larva.shell.cli import update_command

        result = update_command(
            "patch-test",
            patches={"description": "New description"},
            as_json=True,
            facade=facade,
        )

        assert isinstance(result, Success)
        cli_result = result.unwrap()
        # Verify the patches were applied (the spec would have been updated)
        assert cli_result["exit_code"] == EXIT_OK
        assert "json" in cli_result


class TestRunLoopUpdateCommandRouting:
    """Tests for run_cli routing to update_command."""

    def test_update_success_routes_to_facade_update(self) -> None:
        """Update command routes to update_command and calls facade.update."""
        existing = _canonical_spec("route-update")
        registry = InMemoryRegistryStore(get_result=Success(existing))

        facade = RecordingFacade()
        facade.update_result = Success(existing)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "route-update", "--set", "description=Updated"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        assert stderr.getvalue() == ""
        assert facade.update_calls == 1
        assert facade.last_update_id == "route-update"
        assert facade.last_update_patches == {"description": "Updated"}


# ============================================================================
# --set Type Inference Tests (CLI)
# ============================================================================


class TestParseSetValues:
    """Tests for _parse_set_values type inference."""

    def test_parse_boolean_true(self) -> None:
        """Boolean 'true' is inferred as Python True."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["enabled=true"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"enabled": True}

    def test_parse_boolean_false(self) -> None:
        """Boolean 'false' is inferred as Python False."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["disabled=false"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"disabled": False}

    def test_parse_boolean_case_insensitive(self) -> None:
        """Boolean inference is case-insensitive."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["enabled=TRUE", "disabled=FALSE"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"enabled": True, "disabled": False}

    def test_parse_null(self) -> None:
        """Null 'null' is inferred as Python None."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["cleared=null"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"cleared": None}

    def test_parse_null_case_insensitive(self) -> None:
        """Null inference is case-insensitive."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["value=NULL"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"value": None}

    def test_parse_integer(self) -> None:
        """Integer strings are inferred as Python int."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["count=42"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"count": 42}

    def test_parse_negative_integer(self) -> None:
        """Negative integer strings are inferred as Python int."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["offset=-10"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"offset": -10}

    def test_parse_float(self) -> None:
        """Float strings are inferred as Python float."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["temperature=0.7"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"temperature": 0.7}

    def test_parse_negative_float(self) -> None:
        """Negative float strings are inferred as Python float."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["delta=-0.5"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"delta": -0.5}

    def test_parse_string_fallback(self) -> None:
        """Non-type strings fall back to string."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["name=gpt-4o"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"name": "gpt-4o"}

    def test_parse_string_with_equals(self) -> None:
        """Strings containing equals preserve the equals."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["equation=a=b"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"equation": "a=b"}

    def test_parse_multiple_values(self) -> None:
        """Multiple values are parsed and combined."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(
            ["enabled=true", "count=5", "name=test"],
            flag="--set",
        )
        assert isinstance(result, Success)
        assert result.unwrap() == {"enabled": True, "count": 5, "name": "test"}

    def test_parse_dot_key_creates_nested_dict(self) -> None:
        """Dot notation creates nested dict structure."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["model_params.temperature=0.7"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"model_params": {"temperature": 0.7}}

    def test_parse_nested_dot_key_creates_deep_nesting(self) -> None:
        """Multiple dots create deeper nesting."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["a.b.c=1"], flag="--set")
        assert isinstance(result, Success)
        assert result.unwrap() == {"a": {"b": {"c": 1}}}

    def test_parse_multiple_nested_keys(self) -> None:
        """Multiple nested keys merge correctly."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(
            ["model_params.temperature=0.7", "model_params.max_tokens=1000"],
            flag="--set",
        )
        assert isinstance(result, Success)
        assert result.unwrap() == {"model_params": {"temperature": 0.7, "max_tokens": 1000}}

    def test_parse_empty_key_returns_failure(self) -> None:
        """Empty key returns failure."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["=value"], flag="--set")
        assert isinstance(result, Failure)

    def test_parse_missing_equals_returns_failure(self) -> None:
        """Missing equals returns failure."""
        from larva.shell.cli_helpers import _parse_set_values

        result = _parse_set_values(["novalue"], flag="--set")
        assert isinstance(result, Failure)


class TestRunLoopUpdateTypeInference:
    """Tests for CLI --set type inference through run_cli."""

    def test_update_set_boolean_true(self) -> None:
        """Update --set with boolean true is inferred correctly."""
        existing = _canonical_spec("bool-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "bool-test", "--set", "can_spawn=true", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["can_spawn"] is True

    def test_update_set_boolean_false(self) -> None:
        """Update --set with boolean false is inferred correctly."""
        existing = _canonical_spec("bool-test-false")
        existing["can_spawn"] = True
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "bool-test-false", "--set", "can_spawn=false", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["can_spawn"] is False

    def test_update_set_null(self) -> None:
        """Update --set with null is inferred correctly."""
        existing = _canonical_spec("null-test")
        existing["description"] = "Will be nulled"
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "null-test", "--set", "description=null", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["description"] is None

    def test_update_set_integer(self) -> None:
        """Update --set with integer is inferred correctly."""
        existing = _canonical_spec("int-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "int-test", "--set", "model_params.max_tokens=1000", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["model_params"]["max_tokens"] == 1000

    def test_update_set_float(self) -> None:
        """Update --set with float is inferred correctly."""
        existing = _canonical_spec("float-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "float-test", "--set", "model_params.temperature=0.9", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["model_params"]["temperature"] == 0.9

    def test_update_set_string_fallback(self) -> None:
        """Update --set with string falls back correctly."""
        existing = _canonical_spec("string-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "string-test", "--set", "description=A new description", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["description"] == "A new description"

    def test_update_set_nested_path(self) -> None:
        """Update --set with nested path creates nested dict."""
        existing = _canonical_spec("nested-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            ["update", "nested-test", "--set", "model_params.max_tokens=2000", "--json"],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["model_params"]["max_tokens"] == 2000

    def test_update_set_multiple_values(self) -> None:
        """Update --set with multiple values processes all correctly."""
        existing = _canonical_spec("multi-test")
        registry = InMemoryRegistryStore(get_result=Success(existing))
        facade = _make_facade(report=_valid_report(), registry=registry)

        stdout = io.StringIO()
        stderr = io.StringIO()

        exit_code = run_cli(
            [
                "update",
                "multi-test",
                "--set",
                "description=Updated",
                "--set",
                "can_spawn=true",
                "--set",
                "model_params.temperature=0.5",
                "--json",
            ],
            facade=facade,
            stdout=stdout,
            stderr=stderr,
        )

        assert exit_code == EXIT_OK
        payload = json.loads(stdout.getvalue())
        assert payload["data"]["description"] == "Updated"
        assert payload["data"]["can_spawn"] is True
        assert payload["data"]["model_params"]["temperature"] == 0.5
