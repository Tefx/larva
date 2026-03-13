"""Boundary tests for ``larva.shell.cli`` facade-backed commands.

Task boundary: shell_cli.shell-cli-tests
- Tests facade-backed commands only: validate, assemble, register, resolve, list
- Excludes component list/show from this step
- Uses doubles/harness for downstream seams (facade, registry)

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
from larva.shell.cli import (
    EXIT_ERROR,
    EXIT_OK,
    CliCommandResult,
    CliFailure,
    JsonErrorEnvelope,
    assemble_command,
    list_command,
    register_command,
    resolve_command,
    validate_command,
)

if TYPE_CHECKING:
    from larva.shell.registry import RegistryError


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
    """Minimal component store double for CLI tests."""

    def load_prompt(self, name: str) -> Result[dict[str, str], Exception]:
        return Success({"text": "Prompt body"})

    def load_toolset(self, name: str) -> Result[dict[str, dict[str, str]], Exception]:
        return Success({"tools": {"shell": "read_only"}})

    def load_constraint(self, name: str) -> Result[dict[str, object], Exception]:
        return Success({"side_effect_policy": "read_only"})

    def load_model(self, name: str) -> Result[dict[str, object], Exception]:
        return Success({"model": "gpt-4o-mini"})

    def list_components(self) -> Result[dict[str, list[str]], Exception]:
        return Success({"prompts": [], "toolsets": [], "constraints": [], "models": []})


@dataclass
class InMemoryRegistryStore:
    """Minimal registry store double for CLI tests."""

    get_result: Result[PersonaSpec, Any] = field(
        default_factory=lambda: Success(_canonical_spec("default"))
    )
    list_result: Result[list[PersonaSpec], Any] = field(default_factory=lambda: Success([]))
    save_result: Result[None, Any] = field(default_factory=lambda: Success(None))
    save_inputs: list[PersonaSpec] = field(default_factory=list)

    def save(self, spec: PersonaSpec) -> Result[None, Any]:
        self.save_inputs.append(dict(spec))
        return self.save_result

    def get(self, persona_id: str) -> Result[PersonaSpec, Any]:
        return self.get_result

    def list(self) -> Result[list[PersonaSpec], Any]:
        return self.list_result


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
